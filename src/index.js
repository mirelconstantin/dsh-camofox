/**
 * Plugin entry: provide the browser service, own the engine process, and expose
 * the prompt guidance that makes the browser visible to every model.
 *
 * @module dsh-camofox
 */

import { GENERATED_MARKER, installAddonPlugin, writeEnginePlugin } from './addons.js'
import { CONSOLE_PLUGIN_NAME, GENERATED_CONSOLE_MARKER, consolePluginSource } from './console-capture.js'
import { LIFECYCLE_PLUGIN_NAME, GENERATED_LIFECYCLE_MARKER, lifecyclePluginSource } from './lifecycle-plugin.js'
import { CamofoxBridge } from './bridge.js'
import { CamofoxEngine, resolveConfig } from './engine.js'
import { browserGuidance } from './prompt.js'
import { resolveScope } from './scope.js'
import { registerTools } from './tools.js'
import { stopAll } from './serve.js'
import { configValidator, describeError } from './util.js'

/** Name of the Cordis service this plugin provides. */
export const SERVICE = 'camofox'

/** Plugin identity. */
export const name = 'dsh-camofox'

/**
 * Services this row reads: the tool registry and the system-prompt assembler.
 *
 * The tools and the prompt used to be separate Loader rows that each declared
 * their own dependencies. Collapsing them into one row makes this list the only
 * place the dependencies can be declared, and a declared service must be declared
 * here: Cordis resolves `ctx.<service>` against the fiber's inject set, so reading
 * an undeclared one throws `cannot get property "<service>" without inject` and
 * fails the whole entry. `camofox` is absent on purpose — this row provides it,
 * and a plugin cannot inject its own service.
 */
export const inject = ['tools', 'systemPrompt']

/** Configuration defaults; the shape below is what `cordis.patch.yml` may set. */
const CONFIG_DEFAULTS = {
  baseUrl: 'http://127.0.0.1:9377',
  repoPath: '',
  bootstrap: true,
  bootstrapTimeoutMs: 1800000,
  entry: 'server.js',
  nodePath: '',
  stateDir: '',
  logFile: '',
  autostart: true,
  startTimeoutMs: 180000,
  reuseTimeoutMs: 15000,
  requestTimeoutMs: 120000,
  shutdownTimeoutMs: 2000,
  healthIntervalMs: 20000,
  restartLimit: 3,
  userId: 'dsh',
  perSessionScope: true,
  scopeIdleMs: 900000,
  accessKey: '',
  allowUnauthenticated: false,
  unauthenticatedCooldownMs: 300000,
  apiKey: '',
  engineEnv: {},
  defaultMaxChars: 20000,
  maxExtractChars: 60000,
  snapshotScreenshotByDefault: false,
  allowEvaluate: true,
  maxTabs: 8,
  maxConcurrentPerUser: 3,
  scrapeConcurrency: 3,
  mirrorAssetLimit: 150,
  tempDir: '',
  addons: [],
  disableDefaultAddons: false,
  captureConsole: true,
  consoleMaxEntries: 200,
  eagerStart: false,
  engineIdleMs: 0,
}

/** Expected primitive type per configuration key. */
const CONFIG_TYPES = {
  baseUrl: 'string',
  repoPath: 'string',
  bootstrap: 'boolean',
  bootstrapTimeoutMs: 'number',
  entry: 'string',
  nodePath: 'string',
  stateDir: 'string',
  logFile: 'string',
  autostart: 'boolean',
  startTimeoutMs: 'number',
  reuseTimeoutMs: 'number',
  requestTimeoutMs: 'number',
  shutdownTimeoutMs: 'number',
  healthIntervalMs: 'number',
  restartLimit: 'number',
  userId: 'string',
  perSessionScope: 'boolean',
  scopeIdleMs: 'number',
  accessKey: 'string',
  allowUnauthenticated: 'boolean',
  unauthenticatedCooldownMs: 'number',
  apiKey: 'string',
  engineEnv: 'record',
  defaultMaxChars: 'number',
  maxExtractChars: 'number',
  snapshotScreenshotByDefault: 'boolean',
  allowEvaluate: 'boolean',
  maxTabs: 'number',
  maxConcurrentPerUser: 'number',
  scrapeConcurrency: 'number',
  mirrorAssetLimit: 'number',
  tempDir: 'string',
  addons: 'string[]',
  disableDefaultAddons: 'boolean',
  captureConsole: 'boolean',
  consoleMaxEntries: 'number',
  eagerStart: 'boolean',
  engineIdleMs: 'number',
}

/**
 * Child variables the plugin owns unconditionally.
 *
 * `OWNED_ENV` is applied last in the child environment, and the port and log
 * path are placed after `engineEnv`, so a user value cannot widen the bind
 * address, re-enable crash reporting, forge the owner mark, move the port or
 * redirect the log. Those are refused loudly anyway, because silently ignoring
 * a value an operator set is its own kind of failure.
 *
 * Everything else under `CAMOFOX_` is left alone: refusing the whole namespace
 * would fail the plugin LOAD — and therefore remove all sixteen tools — over a
 * harmless passthrough like `CAMOFOX_LOG_LEVEL`.
 */
const RESERVED_ENV = new Set([
  'CAMOFOX_BIND_HOST',
  'CAMOFOX_CRASH_REPORT_ENABLED',
  'CAMOFOX_DSH_OWNER',
  'CAMOFOX_DSH_LOG',
  'CAMOFOX_PORT',
])

/**
 * Reserved only while the plugin is the one gating the engine.
 *
 * `allowUnauthenticated` is for an engine somebody else starts and gates itself:
 * `#spawnEngine` deliberately omits `CAMOFOX_ACCESS_KEY` for a child it spawns
 * in that mode, so nothing of ours reaches the engine through the environment
 * and refusing the key there would only reject a value that does work.
 */
const RESERVED_ENV_WHEN_GATED = 'CAMOFOX_ACCESS_KEY'

/** The validation this plugin has always done, in one place. */
const CONFIG_STANDARD_VALIDATE = (value) => {
  const result = configValidator(CONFIG_DEFAULTS, CONFIG_TYPES)(value)
  if (result.issues) return result
  // A base URL is the one setting a typo must not reach a live socket.
  try {
    const parsed = new URL(result.value.baseUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { issues: [{ message: 'baseUrl must use http or https', path: ['baseUrl'] }] }
    }
  } catch {
    return { issues: [{ message: 'baseUrl is not a valid URL', path: ['baseUrl'] }] }
  }
  const engineEnv = result.value.engineEnv
  if (engineEnv && typeof engineEnv === 'object') {
    for (const key of Object.keys(engineEnv)) {
      const upper = key.toUpperCase()
      const reserved = RESERVED_ENV.has(upper) || (upper === RESERVED_ENV_WHEN_GATED && result.value.allowUnauthenticated !== true)
      if (reserved) {
        return {
          issues: [
            { message: `engineEnv may not set "${key}"; it is owned by the plugin and cannot be overridden`, path: ['engineEnv', key] },
          ],
        }
      }
    }
  }
  return result
}

/** The validator alone: the shape DSH falls back to when no native schema is available. */
const STANDARD_SCHEMA_CONFIG = {
  '~standard': { version: 1, vendor: 'dsh-camofox', validate: CONFIG_STANDARD_VALIDATE },
}

/**
 * Schemastery, when the harness can route it.
 *
 * The loader only opens an interception route to a package the importing
 * manifest names in `peerDependencies`, so `@deepseek-ai/schemastery` is declared
 * in `package.json`. That peer is never range-checked against the runtime — the
 * compatibility gate at `dsh-app-boot`'s `evaluatePluginCompatibility` skips any
 * peer that is not `@deepseek-ai/dsh*` — so declaring it cannot block a load.
 *
 * Two details of the package that the obvious code gets wrong:
 * - it has **no named `z` export**; `lib/index.mjs` is `export { Schema as default }`.
 *   `import { z }` yields `undefined` and `z.object` throws.
 * - there is no `z.record`; a string-keyed record is `z.dict(inner)`.
 *
 * The alias is kept because it is the conventional name and the constructors are
 * attached to the `Schema` class itself.
 *
 * @type {any} the Schemastery constructor, or null when it cannot be resolved.
 */
let z = null
try {
  z = (await import('@deepseek-ai/schemastery')).default ?? null
} catch {
  z = null
}

/**
 * Build a shape the Settings UI can project, without changing how config validates.
 *
 * The native schema exists for **projection only**. Everything the plugin
 * actually enforces — unknown keys, the `baseUrl` protocol check, the reserved
 * `engineEnv` set, and value coercion — stays in `CONFIG_STANDARD_VALIDATE`, and
 * the instance's `~standard` is shadowed to run exactly that. Re-expressing those
 * rules in the schema itself would need a refinement primitive this version does
 * not expose, and a translation of a working validator is a second place for the
 * behaviour to drift.
 *
 * @returns {any} a native Schemastery schema, or the Standard Schema fallback.
 */
function buildConfig() {
  if (!z || typeof z.object !== 'function') return STANDARD_SCHEMA_CONFIG
  try {
    const shape = {}
    for (const [key, type] of Object.entries(CONFIG_TYPES)) {
      let base
      if (type === 'number') base = z.number()
      else if (type === 'boolean') base = z.boolean()
      else if (type === 'record') base = z.dict(z.string())
      else if (type === 'string[]') base = z.array(z.string())
      else base = z.string()
      shape[key] = base.default(CONFIG_DEFAULTS[key])
    }
    const schema = z.object(shape)
    // `isNativeConfigSchema` reads `Symbol.for("schemastery")` off the prototype
    // and a string `type` plus a `meta` object off the instance, all of which a
    // `z.object` already satisfies. Only the validator is replaced.
    Object.defineProperty(schema, '~standard', {
      value: { version: 1, vendor: 'dsh-camofox', validate: CONFIG_STANDARD_VALIDATE },
      configurable: true,
    })
    return schema
  } catch {
    // A settings row is never worth losing the sixteen tools over.
    return STANDARD_SCHEMA_CONFIG
  }
}

/**
 * Plugin configuration.
 *
 * A native Schemastery schema when the harness can route the peer, so the row
 * renders in the Settings UI instead of reporting `unsupported`; the Standard
 * Schema form otherwise. Both validate identically.
 */
export const Config = buildConfig()

/**
 * Create the runtime that owns one Camoufox engine and one browser service.
 *
 * Split from {@link apply} so the tools and prompt sub-modules can attach to a
 * service instance without re-reading configuration.
 *
 * @param {any} ctx - Cordis context.
 * @param {any} rawConfig - validated configuration.
 * @returns {{ engine: CamofoxEngine, bridge: CamofoxBridge, start: () => Promise<boolean>, stop: () => Promise<void> }} the runtime.
 */
function createRuntime(ctx, rawConfig) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : null
  const log = (message) => {
    // A logging call must never be able to fail the caller. Without a Cordis
    // logger this falls through to `process.stderr.write`, which throws
    // EPIPE / ERR_STREAM_DESTROYED once the host has closed the stream; inside
    // an async function that becomes a rejected promise, and under Node's
    // default unhandled-rejection policy an uncaught exception — `process.exit(1)`
    // — takes the entire harness down over one log line.
    try {
      if (logger) logger.info(message)
      else process.stderr.write(`[dsh-camofox] ${message}\n`)
    } catch {
      /* the log sink is gone; there is nothing left to report it to */
    }
  }
  const config = resolveConfig(rawConfig)
  // The engine-side addon plugin has to exist on disk before the engine starts,
  // because the engine reads its plugin directory once during boot. A failure
  // here is reported and then tolerated: the browser still works without the
  // addon, and a missing feature must not cost the model its other tools.
  if (config.addons.length > 0) {
    const result = installAddonPlugin(config.repoPath, config.addons, process.platform)
    if (!result.installed) {
      log(`browser addons are NOT installed: ${result.reason}`)
    } else {
      log(`browser addons installed: ${result.addons.join(', ')}`)
      // Only the folders that passed validation reach the engine, so a refused
      // addon cannot be injected anyway.
      if (result.rejected.length > 0) {
        log(`browser addons refused: ${result.rejected.join('; ')}`)
      }
    }
  }
  // The console-capture plugin is what makes `camofox_console` return anything,
  // and it is installed unconditionally by default: a page-level failure is
  // invisible to every other tool, so without it the browser silently loses the
  // one class of problem an agent cannot otherwise diagnose.
  if (config.captureConsole) {
    const written = writeEnginePlugin(
      config.repoPath,
      CONSOLE_PLUGIN_NAME,
      () => consolePluginSource({ maxEntries: config.consoleMaxEntries, maxText: 2000 }),
      GENERATED_CONSOLE_MARKER,
    )
    if (!written.installed) log(`browser console capture is NOT installed: ${written.reason}`)
  }

  // The lifecycle plugin ensures the engine and any spawned browser processes
  // terminate immediately whenever the parent DeepSeek Harness process terminates.
  const lifecycleWritten = writeEnginePlugin(
    config.repoPath,
    LIFECYCLE_PLUGIN_NAME,
    () => lifecyclePluginSource(),
    GENERATED_LIFECYCLE_MARKER,
  )
  if (!lifecycleWritten.installed) log(`browser lifecycle guard is NOT installed: ${lifecycleWritten.reason}`)

  // A file server from an earlier run is stopped BEFORE anything else looks at the
  // machine. Two reasons: it holds a port nobody asked to keep held, and the
  // whole guarantee this plugin makes about serving is "nothing survives the
  // run that started it" — a run that adopted last run's server breaks it.
  const swept = stopAll(config.stateDir, (pid) => {
    try {
      process.kill(pid)
    } catch {
      /* already gone */
    }
  })
  if (swept.stopped > 0 || swept.failed.length > 0) {
    log(`stopped ${swept.stopped} file server(s) left by an earlier run${swept.failed.length > 0 ? `; ${swept.failed.length} could not be stopped` : ''}`)
  }

  const engine = new CamofoxEngine({ config, log })
  const bridge = new CamofoxBridge(engine)
  return { engine, bridge, log, start: () => engine.ensureReady(), stop: () => engine.dispose() }
}

/**
 * Mount the browser service and start its engine.
 *
 * Startup is awaited by the loader but deliberately bounded: a browser that
 * cannot start within its budget still leaves a working plugin whose tools
 * report the reason, because silently vanishing tools are far harder to
 * diagnose than a tool that explains itself.
 *
 * The body returns nothing on purpose. Cordis reads whatever a plugin returns
 * as an effect — a disposer, an iterable of disposers, a promise, or nothing —
 * so returning the runtime object would fail the load with "Invalid effect".
 *
 * @param {any} ctx - Cordis context.
 * @param {any} rawConfig - validated configuration.
 * @returns {Promise<void>} resolves once startup settled.
 */
export async function apply(ctx, rawConfig) {
  const runtime = createRuntime(ctx, rawConfig)

  // Reserve the service name before anything can race us for it, and release it
  // on unload so a reload can take it again. No availability predicate is
  // passed on purpose: a temporarily unreachable browser must not dispose the
  // tool and prompt registrations, because a service that comes and goes would
  // take the whole tool surface with it.
  //
  // The two surfaces below are registered INSIDE this effect, not as siblings.
  // A `ctx.effect` body runs when its turn comes, so a sibling effect reads the
  // service store before this one has provided into it: `ctx.get(SERVICE)` returns
  // nothing and the tools refuse to mount. One effect makes the order the
  // registration order, which is the order the surfaces depend on. The two stay
  // independently disposable because each registration returns its own disposer.
  ctx.effect(() => {
    const disposers = [ctx.provide(SERVICE, runtime)]

    // The tools and the prompt section used to be their own Loader rows, so a
    // configuration reload of one would not tear the engine down for the other.
    // That separation is gone, and deliberately: this package declares `dsh.client`,
    // and the client-module scanner reconciles sources BY PACKAGE NAME across the
    // HOST Loader's live rows — one package resolving from more than one row throws
    // there, is rethrown at activation as a ClientPackageCompositionError, and
    // leaves the web shell with no `window.__ModuleLoader__`. That is a whole-GUI-down
    // failure, not a degraded one. So the bundle is ONE row and the two surfaces are
    // effects inside it.
    if (typeof ctx.tools?.register === 'function') {
      disposers.push(registerBrowserTools(ctx, runtime))
    }
    if (typeof ctx.systemPrompt?.section === 'function') {
      disposers.push(registerBrowserPrompt(ctx))
    }

    return () => {
      // Reverse order: the surfaces release before the service they read goes.
      for (const dispose of disposers.reverse()) dispose?.()
    }
  }, 'camofox.service')

  // A synchronous backstop for the paths where Cordis disposal cannot run: an
  // explicit exit, an uncaught exception, or a signal.
  ctx.effect(() => runtime.engine.installExitGuard(), 'camofox.exitGuard')

  // The single teardown ladder. Cordis gives a plugin five seconds to dispose,
  // so this kills the process tree immediately and confirms it in one short wait.
  // File servers go first and unconditionally: a disposed plugin that left a
  // server running would be exactly the invisible leftover this is here to
  // prevent.
  ctx.effect(
    () => async () => {
      const swept = stopAll(runtime.engine.config.stateDir, (pid) => {
        try {
          process.kill(pid)
        } catch {
          /* already gone */
        }
      })
      if (swept.stopped > 0) runtime.log(`stopped ${swept.stopped} file server(s) on unload`)
      await runtime.stop()
    },
    'camofox.engine',
  )

  // A session that leaves the store owns a browser context that nothing else
  // will ever use again, so release it now instead of waiting for the engine's
  // own reapers. `session/disposed` is emitted once per departed session and its
  // listener failures are contained by the framework; the rejection is handled
  // here so a session ending can never take the plugin down with it.
  ctx.effect(
    () =>
      ctx.on('session/disposed', (session) => {
        try {
          const scope = resolveScope({ agent: { id: session?.id } }, runtime.engine.config)
          // A session with no id resolves to the shared namespace; disposing
          // that would drop the profile-wide jar, so skip it.
          if (scope === runtime.engine.config.userId) return
          // The promise is handled: an unhandled rejection here would become an
          // uncaught exception in the host process.
          runtime.bridge
            .disposeScope(scope)
            .catch((error) => runtime.log(`could not release the browser context ${scope}: ${describeError(error)}`))
        } catch (error) {
          runtime.log(`could not release a finished session's browser context: ${describeError(error)}`)
        }
      }),
    'camofox.scopeDispose',
  )

  // If eagerStart is true, start the engine immediately on boot without waiting for it.
  // By default (eagerStart: false), the browser engine is launched lazily on first tool use
  // via request()'s ensureReady(), avoiding any wasted memory when the browser is not in use.
  if (runtime.engine.config.eagerStart) {
    runtime
      .start()
      .then(
        (ready) => {
          if (ready) return
          runtime.log(`browser engine is not ready yet: ${runtime.engine.lastError ?? 'unknown reason'}`)
        },
        (error) => {
          runtime.log(`browser engine failed to start: ${describeError(error)}`)
        },
      )
      // The outcome is already reported by this point; anything a report handler
      // itself could throw must not become an unhandled rejection in the host.
      .catch(() => {})
  }
}

/**
 * Mount the model-facing tools on top of the browser service.
 *
 * @param {any} ctx - Cordis context providing `tools`.
 * @param {{ bridge: CamofoxBridge, engine: CamofoxEngine }} runtime - the mounted browser runtime.
 * @returns {string[]} the registered tool names.
 */
export function registerBrowserTools(ctx, runtime) {
  if (!runtime) throw new Error(`dsh-camofox: the ${SERVICE} runtime is missing`)
  return registerTools(ctx, runtime.bridge, runtime.engine.config)
}

/**
 * Mount the system-prompt guidance that teaches models to use the browser.
 *
 * @param {any} ctx - Cordis context providing `systemPrompt`.
 * @returns {() => void} the section disposer.
 */
export function registerBrowserPrompt(ctx) {
  const order = typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_WEB_FETCH') : 2150
  return ctx.systemPrompt.section({
    name: 'camofox:browser',
    // Just after the plain web-fetch guidance, before the SDK block, so the
    // model reads "there is a browser" alongside "there is a fetcher".
    order: Number.isFinite(order) ? order + 5 : 2155,
    // Literal text: the section mentions tool names and braces that must not be
    // treated as prompt variables.
    interpolate: false,
    text: browserGuidance(),
  })
}

// No default export: the Loader unwraps a default export in preference to the
// namespace, which silently drops `inject`, `name` and `Config` from the plugin.
export { CamofoxEngine, CamofoxBridge, describeError }