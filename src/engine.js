/**
 * Lifecycle-managed Camoufox engine supervisor.
 *
 * The plugin owns exactly one engine process for the lifetime of the harness
 * process that loaded it: it adopts an already-running engine when one is
 * present, spawns its own when none is, restarts it with bounded backoff after
 * an unexpected death, and tears the whole process tree down on disposal.
 *
 * Nothing here imports a harness package, so module resolution can never be the
 * reason a browser tool fails.
 *
 * @module dsh-camofox/engine
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { configChunkSize } from './addons.js'
import { ensureEngine } from './bootstrap.js'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  clampInt,
  describeError,
  isProcessAlive,
  isRecord,
  killProcessTree,
  LOG_MAX_BYTES,
  now,
  rotateLogFile,
  sleep,
  withDeadline,
} from './util.js'

/**
 * Engine environment variables that describe the harness owner rather than the
 * machine. Everything else the child needs comes from {@link INHERITED_ENV}.
 */
const OWNED_ENV = {
  CAMOFOX_BIND_HOST: '127.0.0.1',
  CAMOFOX_CRASH_REPORT_ENABLED: 'false',
  CAMOFOX_DSH_OWNER: 'dsh-camofox',
}

/**
 * The complete allowlist of host variables forwarded to the engine process.
 *
 * The upstream project treats "never spread `process.env` into a child" as a
 * hard rule; the harness holds credentials, so honouring it keeps an unrelated
 * secret from reaching a long-lived process.
 */
const INHERITED_ENV = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMPUTERNAME',
  'ComSpec',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'PSModulePath',
  'PUBLIC',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]

/**
 * Rolling window the restart count is measured over, and how long the breaker
 * stays open once the limit is reached.
 *
 * A plain counter resets on every successful start, so an engine that dies every
 * few minutes restarts forever; only a rate limit stops that.
 */
const RESTART_WINDOW_MS = 60000
const RESTART_COOLDOWN_MS = 60000

/**
 * Consecutive empty `/health` probes that ask for a replacement.
 *
 * One miss only degrades: a single slow answer is the engine being busy, not
 * being gone, and a request timeout is a per-call deadline rather than evidence
 * about the process. Two misses from the periodic tick — a full interval apart —
 * is evidence about the process, and it is what hands the engine to the
 * restart path.
 */
const DEGRADED_MISS_TRIGGER = 2

/**
 * Report one signal's cancellation onto another controller.
 *
 * An already-aborted source is reported immediately, so a caller that arrives
 * after the fact cannot miss a cancellation that already happened.
 *
 * @param {AbortSignal} source - the signal to follow.
 * @param {() => void} abort - aborts the target controller.
 * @returns {() => void} a function that removes the listener.
 */
function forwardAbort(source, abort) {
  if (source.aborted === true) {
    abort()
    return () => {}
  }
  source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

/** Machine-derived environment for the engine child. */
function childEnvironment(extra = {}) {
  const env = {}
  for (const key of INHERITED_ENV) {
    const value = process.env[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  if (env.PATH === undefined) env.PATH = join(dirname(process.execPath))
  // When the harness itself runs as Electron-as-node, `process.execPath` is the
  // Electron binary. The engine child is launched with that same binary, so it
  // needs the very flag that makes Electron behave as Node — without it the
  // child opens a window and exits zero immediately.
  if (typeof process.env.ELECTRON_RUN_AS_NODE === 'string' && process.env.ELECTRON_RUN_AS_NODE !== '') {
    env.ELECTRON_RUN_AS_NODE = process.env.ELECTRON_RUN_AS_NODE
  }
  if (process.versions?.electron && env.ELECTRON_RUN_AS_NODE === undefined) {
    env.ELECTRON_RUN_AS_NODE = '1'
  }
  // The owned variables describe the harness owner, not a preference, so they
  // are applied last: a caller-supplied `engineEnv` entry must not be able to
  // widen the bind address, re-enable crash reporting, or forge the owner mark.
  return { ...env, ...extra, ...OWNED_ENV }
}

/**
 * Parse an engine base URL into its origin, port and a normalized path prefix.
 *
 * @param {string} baseUrl - configured engine URL.
 * @returns {{ origin: string, port: number, prefix: string }} parsed parts.
 */
function parseBaseUrl(baseUrl) {
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`camofox baseUrl must be http(s), received "${baseUrl}"`)
  }
  const prefix = parsed.pathname.replace(/\/+$/, '')
  return {
    origin: parsed.origin,
    port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
    prefix,
  }
}

/** Error carrying the HTTP status and decoded engine payload of a failed call. */
export class EngineError extends Error {
  /**
   * @param {string} message - human-readable summary.
   * @param {{ status?: number, code?: string, payload?: any, retryable?: boolean, needsNewTab?: boolean, needsResnapshot?: boolean }} [details] - classification.
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'EngineError'
    this.status = details.status ?? 0
    this.code = details.code ?? 'engine_error'
    this.retryable = details.retryable ?? false
    this.needsNewTab = details.needsNewTab ?? false
    this.needsResnapshot = details.needsResnapshot ?? false
    this.payload = details.payload
  }
}

/**
 * Access key this harness process uses for the engine it starts.
 *
 * @type {string}
 */
let processAccessKeyValue = ''

/**
 * Return this process's engine access key, generating it on first use.
 *
 * The engine leaves every route except `/health` open to anything that can reach
 * its port when `CAMOFOX_ACCESS_KEY` is unset, and the port is loopback: one
 * random key per harness process closes that with no configuration at all. The
 * value is cached because it must be identical everywhere it is used inside one
 * process — a key that changed between the child environment and the request
 * headers would lock us out of our own engine.
 *
 * @returns {string} a 48-character hex token.
 */
function processAccessKey() {
  if (processAccessKeyValue === '') processAccessKeyValue = randomBytes(24).toString('hex')
  return processAccessKeyValue
}

/**
 * Engine process ids started by this harness process.
 *
 * A lock file naming one of these belongs to a live supervisor in this same
 * process, so a second supervisor must adopt that engine rather than treat it
 * as a leftover. Anything else in the lock file came from an earlier run.
 */
const SESSION_PIDS = new Set()

/**
 * Whether a pid in the lock file belongs to a live supervisor in THIS process.
 *
 * Exported read-only so the supervisor's own guards can assert the invariant that
 * matters: a pid must be released the moment this process stops supervising it,
 * because a pid left behind is read by the next run as "owned by a live harness"
 * and adopted — an orphan that outlives everyone.
 *
 * @param {number} pid - process id from a lock or orphan record.
 * @returns {boolean} whether a supervisor in this process claims it.
 */
export function isSessionPid(pid) {
  return SESSION_PIDS.has(pid)
}

/**
 * Does this `/health` document come from a camoufox engine?
 *
 * The engine stamps its own name on every health response
 * (`server.js`: `res.json({ ok: true, engine: 'camoufox', … })`), which is a
 * stronger signal than anything this plugin could infer from a pid or a port.
 *
 * @param {any} payload - the parsed response body.
 * @returns {boolean} whether it identifies a camoufox engine.
 */
function isCamofoxHealth(payload) {
  return isRecord(payload) && payload.engine === 'camoufox'
}

/** Engine lifecycle states surfaced through the status tool. */
export const ENGINE_STATE = /** @type {const} */ ({
  STOPPED: 'stopped',
  STARTING: 'starting',
  READY: 'ready',
  DEGRADED: 'degraded',
  STOPPING: 'stopping',
  FAILED: 'failed',
})

/**
 * Supervise one Camoufox REST engine for one harness process.
 */
export class CamofoxEngine {
  /**
   * @param {object} options - supervisor options.
   * @param {object} options.config - resolved plugin configuration.
   * @param {(message: string, extra?: any) => void} options.log - structured logger.
   */
  constructor({ config, log }) {
    this.config = config
    this.log = typeof log === 'function' ? log : () => {}
    const parsed = parseBaseUrl(config.baseUrl)
    this.origin = parsed.origin
    this.port = parsed.port
    this.prefix = parsed.prefix

    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null
    /** @type {'stopped'|'starting'|'ready'|'degraded'|'stopping'|'failed'} */
    this.state = ENGINE_STATE.STOPPED
    /** @type {Promise<boolean> | null} */
    this.starting = null
    /** @type {string | null} */
    this.lastError = null
    /** @type {{ pid: number, port: number, baseUrl: string, startedAt: number } | null} */
    this.lock = null
    this.owned = false
    /**
     * Deferred signal for a spawn failure reported through the child's `error`
     * event while readiness is still being polled.
     *
     * `spawn()` never rejects — a bad executable only emits `error` — so
     * without this pair a broken `nodePath` is indistinguishable from a slow
     * start and costs the whole readiness budget before it is reported.
     *
     * @type {{ promise: Promise<Error>, fail: (error: Error) => void } | null}
     */
    this.spawnFailure = null
    this.restarts = 0
    this.startedAt = 0
    /** @type {number[]} timestamps of restarts inside the rolling window. */
    this.restartWindow = []
    /** @type {number} epoch ms before which no replacement may be spawned. */
    this.breakerUntil = 0
    this.stopped = false
    this.watcher = null
    this.exited = false
    this.logStream = null
    /** @type {string} bearer token presented to the engine, empty when there is none. */
    this.accessKey = typeof config.accessKey === 'string' ? config.accessKey : ''
    /**
     * Whether the access key came from configuration rather than generation.
     *
     * `resolveConfig` always fills `accessKey` in — with a generated key when the
     * user configured none — so deriving this from the resolved value would make
     * it unconditionally true and would hide the difference between "the
     * operator gave us this key" and "we invented it for this process". A
     * hand-built config without the flag keeps the old reading.
     *
     * @type {boolean}
     */
    this.accessKeyConfigured =
      typeof config.accessKeyConfigured === 'boolean'
        ? config.accessKeyConfigured
        : typeof config.accessKey === 'string' && config.accessKey !== ''
    /** @type {number} epoch ms before which the generated token is presented again. */
    this.unauthenticatedUntil = 0
    /**
     * Whether our own generated token is currently being offered to the engine.
     *
     * Explicit, rather than derived from `owned || accessKeyConfigured`: the two
     * of those say who the engine is, this says whether the token is allowed to
     * be tried right now. Deriving it made the 401 branch unreachable, because
     * it reduced to `(owned || configured) && !owned && !configured`.
     *
     * @type {boolean}
     */
    this.tokenOffered = true
    /**
     * Consecutive `/health` probes that came back empty.
     *
     * DEGRADED used to be terminal: `request()` set it after any request
     * timeout, `#healthTick` ignored every state but READY, and nothing ever
     * moved it back — so one slow call against an engine that then came back
     * left the supervisor probing nothing, rotating no logs, and reporting
     * `degraded` for the rest of the session. Counting the misses is what makes
     * the degradation observable and recoverable.
     *
     * @type {number}
     */
    this.healthMisses = 0
    /**
     * Whether a recovery is already running, so overlapping health ticks cannot
     * each start one.
     *
     * @type {boolean}
     */
    this.recovering = false
    /**
     * Pid of an engine this supervisor gave up on but could not terminate.
     *
     * @type {number | null}
     */
    this.orphanPid = null
    /**
     * Process-level primitives, resolved once per instance.
     *
     * The supervisor is the one part of the plugin that has to be provable on a
     * machine with no browser on it, so every operation that touches the process
     * table — plus the best-effort log rotation — is reached through this record
     * instead of through the imports directly. The defaults ARE the real helpers;
     * the record only makes them replaceable by the guards in `scripts/unit.mjs`,
     * which otherwise would have to start a real engine to reach any of this code.
     *
     * @type {{ spawn: (command: string, args: string[], options: object) => import('node:child_process').ChildProcess, alive: (pid: number) => boolean, kill: (pid: number) => boolean, rotate: (path: string, maxBytes: number) => boolean }}
     */
    this.procs = {
      spawn: (command, args, options) => spawn(command, args, options),
      alive: (pid) => isProcessAlive(pid, spawnSync),
      kill: (pid) => killProcessTree(pid, spawnSync),
      rotate: (path, maxBytes) => rotateLogFile(path, maxBytes),
    }
    /**
     * Aborted by {@link dispose} so every internal wait ends at teardown instead
     * of leaving a ref'd timer to pin the host process open.
     *
     * @type {AbortController}
     */
    this.shutdown = new AbortController()
  }

  /**
   * Whether the generated token should still be presented to the engine.
   *
   * A 401 from an engine started elsewhere is expected — it may have been given a
   * key we cannot learn — so the token is withheld for a cooling-off period and
   * then offered again. Latching it off forever would mean a single transient 401
   * (a proxy, or an engine that restarted under a new key) permanently disabled
   * the credential for the rest of the process; keeping it on forever would mean
   * retrying a rejected credential on every later call. This is the explicit
   * tri-state: offered, withheld for the cooldown, then re-armed when it expires.
   *
   * @returns {boolean} whether to send `Authorization`.
   */
  get #presentToken() {
    const until = this.unauthenticatedUntil
    if (until > 0) {
      if (now() < until) return false
      // The cooldown is over: offer the token again.
      this.tokenOffered = true
      this.unauthenticatedUntil = 0
    }
    return this.tokenOffered
  }

  /**
   * Run a background promise with a handler attached.
   *
   * A fire-and-forget async call that ends in a rejected promise is an uncaught
   * exception under Node's default policy, and in this host an uncaught
   * exception is `process.exit(1)` — the whole harness dies over one log line
   * that failed to reach a closed stderr.
   *
   * @param {Promise<any>} promise - the background work.
   * @param {string} what - short description used in the failure message.
   */
  #detach(promise, what) {
    promise.catch((error) => {
      try {
        this.log(`${what} failed: ${describeError(error)}`)
      } catch {
        /* the logger failed too; there is nothing left to report it to */
      }
    })
  }

  /** Absolute path of the engine lock/state file. */
  get lockPath() {
    return join(this.config.stateDir, 'engine.json')
  }

  /** Absolute path of the engine log file. */
  get logPath() {
    return this.config.logFile
  }

  /**
   * Absolute path of the record naming an engine we could not terminate.
   *
   * Deliberately a separate file from {@link lockPath}. The lock names the
   * engine we are supervising and is overwritten by every spawn; an engine we
   * gave up on is a different process that must keep its own record, and the
   * next spawn would otherwise erase the only trace of it.
   *
   * @returns {string} the orphan record path.
   */
  get orphanPath() {
    return join(this.config.stateDir, 'engine.orphan.json')
  }

  /**
   * Ensure an engine is reachable, spawning one when allowed.
   *
   * Safe to call concurrently: overlapping callers share one start attempt.
   *
   * @param {AbortSignal} [signal] - cancels waiting, never the spawned engine.
   * @returns {Promise<boolean>} whether the engine answered a health probe.
   */
  async ensureReady(signal) {
    if (this.stopped) throw new EngineError('the camofox integration is shutting down', { code: 'shutting_down' })
    if (this.state === ENGINE_STATE.READY && (await this.probe(1500))) return true
    if (this.starting) return this.starting

    this.starting = this.#bringUp(signal).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /**
   * Adopt a live engine or spawn and wait for a fresh one.
   *
   * @param {AbortSignal} [signal] - cancels waiting only.
   * @returns {Promise<boolean>} whether the engine is reachable.
   */
  async #bringUp(signal) {
    this.state = ENGINE_STATE.STARTING

    if (this.#aborted()) return false

    // An engine this supervisor abandoned earlier is reaped before anything else
    // looks at the port. It must never be adopted back (nobody would ever kill it
    // again) and, being wedged, it will not answer the probe below — so waiting
    // for a `/health` that is not coming would leave it holding the port the
    // replacement needs. This costs one file read when there is no record.
    await this.#reapOrphan()
    if (this.#aborted()) return false

    const existing = await this.probe(1200)
    if (existing) {
      // An engine left behind by an earlier, unclean run is ours to clean up:
      // adopting it would mean nobody owns it and it outlives the harness,
      // which is exactly the failure this supervisor exists to prevent. An
      // engine with no lock of ours is somebody's deliberate instance and is
      // adopted instead, and is then never killed by us.
      const stalePid = this.#readStaleLockPid()
      if (stalePid != null) {
        this.log(`found a camofox engine left behind by an earlier run (pid ${stalePid}); stopping it so this harness owns the browser`)
        this.procs.kill(stalePid)
        this.#clearLock()
        await this.#waitForPortFree()
      } else {
        this.owned = false
        // A cooldown earned against a former engine must not follow us onto the
        // one we just adopted, for the same reason the spawn path clears it: an
        // engine we reach has already accepted this key at least once, and
        // withholding the header here would 401 every route for the rest of the
        // window. Adoption is the one bring-up branch that used to skip this, so
        // an engine whose key matched ours but had once rejected it stayed
        // unreachable — and every call then failed inside its own cooldown.
        this.unauthenticatedUntil = 0
        this.tokenOffered = true
        return this.#markReady('adopted an already-running engine')
      }
    }

    // Teardown may have happened during any of the awaits above — a probe, a
    // stale-lock reap, a port wait — and a spawn issued after `dispose()`
    // returned would leave a live engine that no later dispose can reach,
    // because dispose returns immediately once `stopped` is set. So the check
    // is repeated at every point where control could have left this method.
    if (this.#aborted()) return false

    if (!this.config.autostart) {
      this.state = ENGINE_STATE.FAILED
      this.lastError = `no camofox engine answered at ${this.origin} and autostart is disabled`
      this.log(this.lastError)
      return false
    }

    // Without this the breaker only ever suppresses its own restart path: every
    // tool call against a FAILED engine re-enters `ensureReady()` and spawns a
    // replacement anyway, which is exactly the respawn storm the rate limit
    // exists to stop.
    if (this.breakerUntil > now()) {
      this.state = ENGINE_STATE.FAILED
      this.lastError =
        `the camofox engine restarted ${this.restarts} times in the last ${RESTART_WINDOW_MS / 1000}s and is not starting again until ${new Date(this.breakerUntil).toISOString()}. ` +
        `Engine log: ${this.logPath}`
      return false
    }
    this.breakerUntil = 0

    // A child we already own but cannot currently reach is still OUR engine —
    // it is starting, or wedged. Spawning a replacement overwrites `this.child`
    // and loses the pointer to it: the duplicate dies on EADDRINUSE, its exit
    // handler clears `this.child`, and from then on neither `dispose()` nor the
    // exit guard can find the process that is actually running. So wait for the
    // one we have instead of replacing it.
    let reusedChild = false
    if (this.child && this.child.pid && this.procs.alive(this.child.pid)) {
      reusedChild = true
      this.log(`waiting for the camofox engine we already started (pid ${this.child.pid}) instead of spawning a second one`)
    } else if (this.child) {
      this.child = null
    }

    if (this.#aborted()) return false

    // At most one replacement: the loop runs a second time only when the FIRST
    // pass adopted an existing child, and `reusedChild` is consumed below.
    for (;;) {
      // Only reach for a process when there is none to reuse.
      if (this.child == null) {
        try {
          await this.#spawnEngine()
        } catch (error) {
          // A broken install must not take the plugin down with it: the tools stay
          // visible and explain the reason on first use.
          this.state = ENGINE_STATE.FAILED
          this.lastError = describeError(error)
          this.log(this.lastError)
          return false
        }
      }

      // A child that dies instantly has almost always failed to start at all —
      // most often because the binary it was launched with is a desktop shell
      // rather than a Node runtime. Detect that once, and say so plainly,
      // instead of burning the whole readiness budget on a process that is gone.
      const immediate = await this.#detectImmediateExit()
      if (immediate) {
        this.state = ENGINE_STATE.FAILED
        this.lastError = immediate
        this.log(immediate)
        return false
      }

      // A hand-built config (one that never went through resolveConfig) has no
      // reuse budget; falling back to the start budget keeps `Math.min` from
      // producing NaN, which would end the poll before it began.
      const reuseBudgetMs = Number.isFinite(this.config.reuseTimeoutMs) ? this.config.reuseTimeoutMs : this.config.startTimeoutMs
      const budgetMs = reusedChild ? Math.min(this.config.startTimeoutMs, reuseBudgetMs) : this.config.startTimeoutMs
      const { ready, spawnError } = await this.#waitForHealthOrSpawnError(signal, budgetMs)
      this.spawnFailure = null
      if (spawnError) {
        // A spawn error is a setup fault, not a slow start, so report it now and
        // drop the lock: no process exists, and a lock naming one would make the
        // next run hunt for a leftover that was never started.
        this.state = ENGINE_STATE.FAILED
        this.#clearLock()
        const executable = this.config.nodePath || process.execPath
        const code = typeof spawnError.code === 'string' && spawnError.code !== '' ? ` [${spawnError.code}]` : ''
        this.lastError =
          `the camofox engine could not be started with "${executable}"${code}: ${describeError(spawnError)}. ` +
          `Set nodePath in the camofox-runtime configuration to a real node executable if this path is not one. ` +
          `Engine log: ${this.logPath}`
        this.log(this.lastError)
        return false
      }
      if (ready) return this.#markReady(reusedChild ? 'the engine we already started answered' : 'spawned a new engine')

      if (reusedChild) {
        // The child we were waiting for is alive but never bound the port. With
        // no bound of its own the reuse path used to burn the whole
        // `startTimeoutMs` and then stop, so a child that wedged was never
        // replaced at all. It is replaced here — and counted against the restart
        // window, so an engine that wedges repeatedly runs into the breaker
        // instead of looping.
        //
        // This is the path the health tick reaches through `#restart` once an
        // engine has missed two consecutive probes; DEGRADED no longer has to be
        // in `request()`'s `ensureReady()` guard for it to be reachable, because
        // the tick drives it whether or not a tool call ever arrives.
        reusedChild = false
        const pid = this.child?.pid ?? 'unknown'
        this.log(`camofox engine pid ${pid} never answered within ${budgetMs}ms; replacing it`)
        if (!this.#noteRestart()) {
          this.state = ENGINE_STATE.FAILED
          this.lastError =
            `the camofox engine was replaced ${this.restarts} times in the last ${RESTART_WINDOW_MS / 1000}s and is not starting again until ${new Date(this.breakerUntil).toISOString()}. ` +
            `Engine log: ${this.logPath}`
          this.log(this.lastError)
          return false
        }
        const discarded = await this.#discardChild()
        // `#discardChild` reports whether the process is GONE. Dropping that
        // answer and looping is what left a surviving engine in no record at
        // all: `this.child` is already null, the pid is out of the session set,
        // the spawn below overwrites the lock file with the NEW pid, and the
        // `exit` handler bails out at `this.child !== child` while the exit guard
        // only ever looks at `this.child`. So a process that outlived the tree
        // kill is recorded and reported, exactly as `dispose()` does, instead of
        // being spawned over.
        if (!discarded) {
          this.#recordOrphan(pid, 'it survived the tree kill that replaced an engine which never answered')
          this.state = ENGINE_STATE.FAILED
          this.lastError =
            `camofox engine pid ${pid} survived the tree kill and is still running. ` +
            `It was recorded in ${this.orphanPath} so this or a later run reaps it, and no replacement was started over it. ` +
            `Engine log: ${this.logPath}`
          this.log(this.lastError)
        }
        if (this.#aborted()) return false
        if (!discarded) return false
        continue
      }
      break
    }

    if (this.#aborted()) return false

    // The child may still come up after our budget expired; keep supervising it
    // in the background rather than tearing down a healthy engine.
    this.state = ENGINE_STATE.DEGRADED
    this.lastError = `camofox engine did not answer within ${this.config.startTimeoutMs}ms`
    this.log(this.lastError)
    return false
  }

  /**
   * Record the outcome of a start attempt that teardown overtook.
   *
   * `dispose()` reports STOPPED; without this the in-flight start would keep
   * writing STARTING/FAILED over that and leave the status tool describing an
   * engine this process has already let go of.
   *
   * @returns {boolean} true when the attempt must stop, leaving state STOPPED.
   */
  #aborted() {
    if (!this.stopped) return false
    this.state = ENGINE_STATE.STOPPED
    return true
  }

  /**
   * Stop supervising the current child and confirm the process is gone.
   *
   * The pointer is dropped and the pid released from the session set FIRST, so
   * the exit handler — which now ignores events from a child that is no longer
   * the current one — cannot leave a stale claim that a later run would read as
   * "supervised by this harness" and adopt instead of reap.
   *
   * @returns {Promise<boolean>} whether the process is gone.
   */
  async #discardChild() {
    const child = this.child
    this.child = null
    if (!child || !child.pid) return true
    SESSION_PIDS.delete(child.pid)
    this.procs.kill(child.pid)
    return this.#waitForExit(child.pid, this.config.shutdownTimeoutMs)
  }

  /**
   * Record an engine we can no longer supervise and could not terminate.
   *
   * The lock file is not enough for this: it names the engine we are supervising
   * and every spawn overwrites it, so a survivor recorded there would be erased
   * by the very replacement that was supposed to get rid of it. The orphan record
   * is therefore a file of its own, read back by {@link #reapOrphan} on the next
   * bring-up, so the process stays reachable by whoever runs next.
   *
   * @param {number|string} pid - the surviving process id.
   * @param {string} reason - why it was abandoned.
   */
  #recordOrphan(pid, reason) {
    if (!Number.isInteger(pid) || pid <= 0) {
      this.log(`an engine could not be terminated and has no pid to record; it can only be found by port ${this.port}`)
      return
    }
    this.orphanPid = pid
    const record = {
      pid,
      // The supervisor that gave up on it, so a later run can tell "mine" from
      // "somebody else's" exactly as it does for the lock file.
      ownerPid: process.pid,
      port: this.port,
      baseUrl: this.origin,
      recordedAt: now(),
      reason,
      owner: 'dsh-camofox',
    }
    try {
      mkdirSync(this.config.stateDir, { recursive: true })
      writeFileSync(this.orphanPath, JSON.stringify(record, null, 2), 'utf8')
    } catch (error) {
      this.log(`could not write the orphan record for camofox engine pid ${pid}: ${describeError(error)}`)
    }
  }

  /** Read the orphan record, or null when there is none we can use. */
  #readOrphan() {
    try {
      if (!existsSync(this.orphanPath)) return null
      const record = JSON.parse(readFileSync(this.orphanPath, 'utf8'))
      if (!isRecord(record) || record.owner !== 'dsh-camofox') return null
      const pid = Number(record.pid)
      if (!Number.isInteger(pid) || pid <= 0) return null
      return { ...record, pid }
    } catch {
      return null
    }
  }

  /** Forget the orphan record, ignoring filesystem errors. */
  #clearOrphan() {
    this.orphanPid = null
    try {
      rmSync(this.orphanPath, { force: true })
    } catch {
      /* the file is advisory only */
    }
  }

  /**
   * Terminate an engine an earlier attempt left behind.
   *
   * Runs before every bring-up, ahead of the adoption probe on purpose: an
   * engine we ourselves abandoned must never be adopted back, and if it is wedged
   * it will not answer the probe anyway — so waiting for a `/health` that is not
   * coming would leave it holding the port the replacement needs.
   *
   * Never throws and never waits long: a record naming a process that is already
   * gone is simply cleared.
   *
   * @param {number} [budgetMs] - how long to wait for the kill to land.
   * @returns {Promise<boolean>} whether a usable record was found and dealt with.
   */
  async #reapOrphan(budgetMs = this.config.shutdownTimeoutMs) {
    const record = this.#readOrphan()
    if (!record) {
      this.orphanPid = null
      return false
    }
    const pid = record.pid
    if (!this.procs.alive(pid)) {
      this.#clearOrphan()
      return true
    }
    const ownerPid = Number(record.ownerPid)
    // A record naming a supervisor that is still running belongs to another
    // harness: touching its engine would kill a browser somebody else is using.
    if (Number.isInteger(ownerPid) && ownerPid > 0 && ownerPid !== process.pid && this.procs.alive(ownerPid)) {
      this.log(`camofox engine pid ${pid} is recorded as an orphan of a running harness process (pid ${ownerPid}); leaving it alone`)
      return true
    }
    this.log(`reaping camofox engine pid ${pid} left behind by this plugin (${record.reason ?? 'no reason recorded'})`)
    this.procs.kill(pid)
    const gone = await this.#waitForExit(pid, budgetMs)
    if (gone) {
      this.#clearOrphan()
      return true
    }
    this.orphanPid = pid
    this.log(`camofox engine pid ${pid} survived the reap; keeping its record in ${this.orphanPath}`)
    return true
  }

  /**
   * Count one start attempt against the rolling window, opening the breaker when
   * the limit is reached.
   *
   * @returns {boolean} whether another attempt is allowed right now.
   */
  #noteRestart() {
    const windowStart = now() - RESTART_WINDOW_MS
    this.restartWindow = this.restartWindow.filter((stamp) => stamp > windowStart)
    this.restarts = this.restartWindow.length
    if (this.restarts >= this.config.restartLimit) {
      this.breakerUntil = now() + RESTART_COOLDOWN_MS
      return false
    }
    this.restartWindow.push(now())
    this.restarts += 1
    return true
  }

  /**
   * Record a reachable engine and arm the crash watcher.
   *
   * Both call sites sit before the `stopped` guard in `#bringUp`, so teardown
   * can land while adoption or the readiness poll is still in flight. Marking
   * ready at that point would leak an interval nobody will ever clear and report
   * `ready` for an engine this process no longer owns.
   *
   * @param {string} reason - log detail.
   * @returns {boolean} whether the engine was marked ready; false once stopped.
   */
  #markReady(reason) {
    if (this.stopped) return false
    this.state = ENGINE_STATE.READY
    this.lastError = null
    if (this.startedAt === 0) this.startedAt = now()
    if (!this.watcher && typeof setInterval === 'function') {
      this.watcher = setInterval(() => {
        this.#detach(this.#healthTick(), 'camofox health check')
      }, this.config.healthIntervalMs)
      if (typeof this.watcher.unref === 'function') this.watcher.unref()
    }
    this.log(`camofox engine ready (${reason}); baseUrl=${this.origin}`)
    return true
  }

  /**
   * Periodic liveness check that flips state to degraded instead of crashing.
   *
   * DEGRADED is a verdict, not a resting place. The tick keeps probing while it
   * holds, so the supervisor learns which of the two things happened: the engine
   * came back (and the state returns to READY), or it is still silent — in which
   * case the SECOND consecutive miss is what asks for a replacement. One miss is
   * not enough: a request timeout is a per-call deadline, and a merely slow
   * engine must not be torn down because one of its calls overran.
   *
   * Recovery goes through {@link #restart}, never straight to the spawn path, so
   * every attempt is counted against the rolling restart window and the breaker
   * still stops a genuinely broken engine from respawning on every tick. A
   * liveness miss can therefore never become a respawn storm, however long the
   * engine stays silent.
   *
   * @returns {Promise<void>} resolves once this tick has been decided.
   */
  async #healthTick() {
    if (this.stopped) return
    // READY is the only state a tick acts on. STARTING means a start attempt
    // owns the engine right now, FAILED means the breaker or a hard failure
    // already spoke for it, and recovering means a replacement is in flight —
    // in every one of those cases a probe here would race the code that owns
    // the child, and a restart would be a second spawn.
    if (this.state !== ENGINE_STATE.READY && this.state !== ENGINE_STATE.DEGRADED) {
      // Nothing is left to recover from: forget the misses so a later episode is
      // judged on its own evidence rather than on the last one.
      this.recovering = false
      return
    }
    // The cheapest place to notice a log that grew past its budget during a long
    // session. Renaming a file another process holds open succeeds on Windows;
    // where it is ever refused the helper returns false and the next spawn-time
    // rotation still happens. Guarded anyway: a rotation that throws must cost
    // one tick, never the liveness check that shares it — and this runs inside
    // an interval callback in a host where an escaping throw is `process.exit(1)`.
    try {
      this.procs.rotate(this.logPath, LOG_MAX_BYTES)
    } catch (error) {
      this.log(`could not rotate the engine log: ${describeError(error)}`)
    }
    const alive = await this.probe(this.config.healthIntervalMs)
    if (this.stopped) return

    if (alive) {
      this.healthMisses = 0
      this.recovering = false
      if (this.state === ENGINE_STATE.DEGRADED) {
        this.state = ENGINE_STATE.READY
        this.lastError = null
        this.log(`camofox engine at ${this.origin} answered again; no longer degraded`)
      }
      return
    }

    this.healthMisses += 1
    if (this.state === ENGINE_STATE.READY) {
      this.state = ENGINE_STATE.DEGRADED
      this.lastError = `camofox engine at ${this.origin} stopped answering`
      this.log(this.lastError)
      return
    }
    // Already degraded, and this probe missed too: the engine is not merely slow.
    this.log(`camofox engine at ${this.origin} missed ${this.healthMisses} consecutive health checks`)
    if (this.healthMisses < DEGRADED_MISS_TRIGGER || this.recovering) return
    this.recovering = true
    this.healthMisses = 0
    this.#detach(this.#restart(), 'camofox engine recovery')
  }

  /**
   * Run one liveness check immediately instead of waiting for the interval.
   *
   * Same code path as the periodic tick, exposed so the status tool and the
   * supervisor's own guards can force a verdict without sleeping through an
   * interval.
   *
   * @returns {Promise<void>} resolves once the check has been decided.
   */
  async checkHealth() {
    await this.#healthTick()
  }

  /**
   * Spawn the engine child process and capture its output to a log file.
   *
   * @returns {Promise<void>} resolves once the child exists.
   */
  /**
   * Locate the engine entry point, installing the engine when it is absent.
   *
   * Never throws: a failed install is reported through the returned path and the caller's
   * `engine_missing` error, so a machine with no network keeps a plugin that explains
   * itself rather than one that cannot start.
   *
   * @param {string} repo - resolved `repoPath`.
   * @returns {Promise<string>} the entry path; callers check whether it exists.
   */
  async #ensureEnginePresent(repo) {
    if (isAbsolute(this.config.entry)) return this.config.entry
    const configured = join(repo, this.config.entry)
    if (existsSync(configured)) return configured
    if (!this.config.bootstrap) return configured

    // Long on purpose and separate from `startTimeoutMs`: a first run installs ~175
    // packages and fetches a browser binary over the network, which is not the same work
    // as waiting for a process to bind a port.
    const deadline = withDeadline([this.shutdown.signal], this.config.bootstrapTimeoutMs)
    try {
      const result = await ensureEngine({
        repoPath: repo,
        entry: this.config.entry,
        npmPath: this.config.nodePath || process.execPath,
        signal: deadline.signal,
        log: (message) => this.log(message),
        timeoutMs: this.config.bootstrapTimeoutMs,
      })
      if (!result.ok) {
        this.log(`the camofox engine could not be installed: ${result.reason ?? 'npm install did not produce an entry point'}`)
      } else if (result.installed) {
        this.log(`camofox engine installed at ${result.entry}${result.browserReady ? '' : ' (the Camoufox browser binary is still downloading; the first launch will fetch it)'}`)
      }
      return result.entry
    } catch (error) {
      this.log(`the camofox engine could not be installed: ${describeError(error)}`)
      return configured
    } finally {
      deadline.dispose()
    }
  }

  async #spawnEngine() {
    // The last gate before a process exists. Teardown can land between the
    // caller's `stopped` check and here, and a child spawned after `dispose()`
    // returned is unreachable: the exit guard re-reads `this.child`, but a
    // second dispose returns immediately at `if (this.stopped) return`.
    if (this.stopped) throw new EngineError('the camofox integration is shutting down', { code: 'shutting_down' })
    const repo = resolve(this.config.repoPath)
    // An engine this plugin did not install is installed here rather than described. The
    // default location is created on first run, so a new machine reaches a browser with no
    // clone and no npm command; a `repoPath` the operator chose is never created for them,
    // because a typo there is reported as a typo.
    const entry = await this.#ensureEnginePresent(repo)
    if (!existsSync(entry)) {
      this.state = ENGINE_STATE.FAILED
      this.lastError = `no camofox-browser engine at ${entry}. `
        + (this.config.bootstrap
          ? `The automatic install into ${repo} did not produce one; set repoPath to an existing camofox-browser checkout to install it yourself. `
          : `Set repoPath to a camofox-browser checkout, or set bootstrap: true to let the plugin install one into ${repo}. `)
        + 'See the Install section of the plugin\'s README.'
      this.log(this.lastError)
      throw new EngineError(this.lastError, { code: 'engine_missing', retryable: true })
    }

    mkdirSync(dirname(this.logPath), { recursive: true })
    mkdirSync(this.config.stateDir, { recursive: true })
    // No child holds the log at this moment, so the live file is guaranteed
    // whole and a rotation cannot split a line across two generations.
    this.procs.rotate(this.logPath, LOG_MAX_BYTES)
    let logFd
    try {
      logFd = openSync(this.logPath, 'a')
    } catch {
      logFd = undefined
    }

    const env = childEnvironment({
      // Caller-supplied values are a convenience, never an override: the variables
      // that describe the owner are applied last inside childEnvironment().
      ...(this.config.engineEnv ?? {}),
      CAMOFOX_PORT: String(this.port),
      CAMOFOX_DSH_LOG: this.logPath,
      // `allowUnauthenticated` exists for an engine somebody else starts and
      // gates itself, so the key is never handed to a child we spawn.
      ...(this.accessKey && !this.config.allowUnauthenticated ? { CAMOFOX_ACCESS_KEY: this.accessKey } : {}),
      // NUL-separated because an addon path may contain any character a Windows
      // path may contain, and the engine splits on this exact separator.
      ...(this.config.addons.length > 0 ? { CAMOFOX_DSH_ADDONS: this.config.addons.join('\0') } : {}),
      // The generated engine plugin re-chunks the config, and must use the same
      // limit camoufox-js used. One place decides it.
      ...(this.config.addons.length > 0 ? { CAMOFOX_DSH_CONFIG_CHUNK_SIZE: String(configChunkSize(process.platform)) } : {}),
      // The engine turns this into `exclude_addons: ['UBO']` at launch
      // (`server.js:1181`), which is how uBlock Origin is suppressed.
      ...(this.config.disableDefaultAddons ? { CAMOFOX_DISABLE_DEFAULT_ADDONS: '1' } : {}),
    })

    const child = this.procs.spawn(this.config.nodePath || process.execPath, [entry], {
      cwd: repo,
      env,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'inherit'],
      windowsHide: true,
      // Detached on purpose. Measured on this machine: a non-detached child
      // dies the moment its spawning process exits, which would make the engine
      // unusable for the whole supervised lifetime and would also hide the fact
      // that we — not the OS — are responsible for stopping it. Detaching moves
      // that responsibility here, where disposal and the exit guard handle it.
      detached: true,
    })
    // The child must never hold our event loop open: if teardown somehow does
    // not run, the harness still exits instead of hanging on a browser.
    child.unref()
    this.child = child
    this.owned = true
    this.exited = false
    // A cooldown earned against a FOREIGN engine must not follow us onto an
    // engine we just started and handed this very key to: suppressing the header
    // there would 401 every route for the rest of the window — up to five
    // minutes of self-inflicted lockout after a successful start.
    this.unauthenticatedUntil = 0
    this.tokenOffered = true
    if (child.pid) SESSION_PIDS.add(child.pid)

    if (logFd !== undefined) {
      const close = () => {
        try {
          closeSync(logFd)
        } catch {
          /* already closed */
        }
      }
      child.once('close', close)
      child.once('error', close)
    }

    // A failed spawn is reported through `error`, never as a rejection, so readiness
    // gets a deferred to race against instead of waiting out its whole budget on
    // a process that does not exist.
    let failSpawn = () => {}
    const spawnFailure = new Promise((resolve) => {
      failSpawn = resolve
    })
    this.spawnFailure = { promise: spawnFailure, fail: failSpawn }

    child.on('error', (error) => {
      this.log(`camofox engine failed to spawn: ${describeError(error)}`)
      this.lastError = describeError(error)
      this.state = ENGINE_STATE.FAILED
      failSpawn(error)
    })

    child.on('exit', (code, signal) => {
      // An `exit` belongs to the process that raised it. If `this.child` has
      // moved on — a replacement was spawned while this one was still winding
      // down — then clearing the field would orphan the LIVE engine: `dispose()`
      // would take its "no child" branch and kill nothing, and the exit guard
      // would read `null`. Everything below is about the current child only.
      if (this.child !== child) return
      this.exited = true
      const expected = this.stopped
      this.child = null
      if (child.pid) SESSION_PIDS.delete(child.pid)
      try {
        appendFileSync(this.logPath, `\n[dsh-camofox] engine exited code=${code} signal=${signal} expected=${expected}\n`, 'utf8')
      } catch (error) {
        // A throw in an event handler escapes the emitter as an uncaught
        // exception, and the host answers that with `process.exit(1)`: the whole
        // harness dies over a log line. It would also happen before
        // `void this.#restart()`, which silently disables self-healing.
        this.log(`could not append to the engine log: ${describeError(error)}`)
      }
      if (expected) return
      this.state = ENGINE_STATE.DEGRADED
      this.lastError = `camofox engine exited unexpectedly (code=${code}, signal=${signal ?? 'none'})`
      this.log(this.lastError)
      this.#detach(this.#restart(), 'camofox engine restart')
    })

    this.#writeLock()
  }

  /**
   * Restart the engine after an unexpected exit, at most `restartLimit` times per
   * rolling window.
   *
   * The rate limit is what actually bounds respawns: a counter that resets on a
   * successful start lets an engine that dies every few minutes restart forever,
   * and once the limit is reached the breaker stays closed for
   * {@link RESTART_COOLDOWN_MS} so `ensureReady()` cannot re-enter the spawn path
   * on every later tool call.
   *
   * @returns {Promise<void>} resolves once the retry decision is made.
   */
  async #restart() {
    if (this.stopped) return
    if (!this.#noteRestart()) {
      this.state = ENGINE_STATE.FAILED
      this.lastError =
        `the camofox engine restarted ${this.restarts} times in the last ${RESTART_WINDOW_MS / 1000}s and was not started again until ${new Date(this.breakerUntil).toISOString()}. ` +
        `Engine log: ${this.logPath}`
      this.log(this.lastError)
      return
    }
    // Half jitter: without it every restart in a session follows the same
    // exponential curve, which reads as a deterministic fault rather than a
    // random crash. The shutdown signal ends the wait at teardown — the timer is
    // ref'd, so leaving it running would pin the host process open.
    const backoff = Math.min(30000, 500 * 2 ** (this.restarts - 1))
    const delay = Math.max(250, Math.round(backoff * (0.5 + Math.random())))
    this.log(`restart ${this.restarts}/${this.config.restartLimit} in the last ${RESTART_WINDOW_MS / 1000}s in ${delay}ms`)
    await sleep(delay, this.shutdown.signal)
    if (this.stopped) return
    try {
      await this.ensureReady()
    } catch (error) {
      this.log(`camofox engine restart failed: ${describeError(error)}`)
    }
  }

  /**
   * Detect a child that exited before it could possibly have served anything.
   *
   * @returns {Promise<string|null>} an explanation, or null when the child is
   *   still alive and worth waiting for.
   */
  async #detectImmediateExit() {
    // Teardown owns this method's caller: a "this engine failed to start"
    // verdict written after dispose would leave the status tool blaming a
    // process this harness already let go of.
    if (this.stopped) return null
    const child = this.child
    if (!child) return null
    await sleep(1500, this.shutdown.signal)
    if (this.stopped) return null
    if (!this.exited || this.child) return null
    this.child = null
    this.state = ENGINE_STATE.FAILED
    const executable = this.config.nodePath || process.execPath
    // An immediate exit has more than one cause, and blaming the wrong one sends
    // the user to fix the one thing that is already fine. The engine's own stderr
    // is the evidence — a port already in use, a missing dependency, a syntax
    // error in the checkout — and it is printed before anything is guessed.
    const tail = this.#readLogTail()
    const verdict = /EADDRINUSE|address already in use/i.test(tail)
      ? `Port ${this.origin} is already taken by another process, so the engine exited at once. `
        + `Stop whatever is listening there, or point baseUrl at a free port. `
      : `It was launched with "${executable}", which may not act as a Node runtime in this context. `
        + `Set nodePath in the camofox-runtime configuration to a real node executable if it does not. `
    return (
      `the camofox engine process exited immediately without serving anything. ${verdict}` +
      `${tail === '' ? `Engine log: ${this.logPath}` : `Engine log said:\n${tail}`}`
    )
  }

  /**
   * The last few lines of the engine log, for an error the user has to act on.
   *
   * @returns {string} the tail, or an empty string when it cannot be read.
   */
  #readLogTail() {
    try {
      if (!existsSync(this.logPath)) return ''
      const text = readFileSync(this.logPath, 'utf8').trimEnd()
      if (text === '') return ''
      return text.split(/\r?\n/).slice(-12).join('\n')
    } catch {
      return ''
    }
  }

  /**
   * Poll `/health` until the engine answers or the budget expires.
   *
   * @param {AbortSignal} [signal] - cancels waiting only.
   * @param {number} [budgetMs] - readiness budget; defaults to the start budget.
   * @returns {Promise<boolean>} whether the engine answered.
   */
  async #waitForHealth(signal, budgetMs = this.config.startTimeoutMs) {
    const deadline = now() + budgetMs
    let interval = 400
    let reported = false
    while (now() < deadline) {
      // Teardown is part of the contract here. `sleep()` and `withDeadline()`
      // use REF'D timers, so a poll that ignored it would keep the host process
      // alive for the rest of the readiness budget — three minutes by default —
      // long after `dispose()` returned and the plugin looked shut down.
      if (signal?.aborted || this.stopped) return false
      if (await this.probe(2000)) return true
      if (signal?.aborted || this.stopped) return false
      if (!reported && now() > deadline - budgetMs * 0.6) {
        reported = true
        this.log(`camofox engine is still starting; log: ${this.logPath}`)
      }
      await sleep(interval, signal)
      interval = Math.min(2000, interval + 200)
    }
    return false
  }

  /**
   * Race the readiness poll against a spawn failure reported by the child.
   *
   * The loser is aborted: without it a spawn error would leave a health poll
   * running against a process that does not exist until the budget expires,
   * holding the call open long after the answer is known.
   *
   * @param {AbortSignal} [signal] - cancels waiting only, never the child.
   * @param {number} [budgetMs] - readiness budget; defaults to the start budget.
   * @returns {Promise<{ ready: boolean, spawnError?: Error }>} whichever finished first.
   */
  async #waitForHealthOrSpawnError(signal, budgetMs = this.config.startTimeoutMs) {
    // Nothing left to wait for once teardown has run; say so instead of racing.
    if (this.stopped) return { ready: false }
    const spawnFailure = this.spawnFailure
    if (!spawnFailure) return { ready: await this.#waitForHealth(signal, budgetMs) }

    const controller = new AbortController()
    const relay = () => controller.abort(signal?.reason)
    const onShutdown = () => controller.abort(new Error('the camofox integration is shutting down'))
    if (signal?.aborted) relay()
    else signal?.addEventListener('abort', relay, { once: true })
    this.shutdown.signal.addEventListener('abort', onShutdown, { once: true })
    try {
      return await Promise.race([
        this.#waitForHealth(controller.signal, budgetMs).then((ready) => ({ ready })),
        spawnFailure.promise.then((spawnError) => ({ ready: false, spawnError })),
      ])
    } finally {
      controller.abort(new Error('the readiness race is decided'))
      signal?.removeEventListener('abort', relay)
      this.shutdown.signal.removeEventListener('abort', onShutdown)
    }
  }

  /**
   * Ask the engine for its health document.
   *
   * Identity is part of the answer, not just reachability. Every caller of this
   * method treats a truthy result as "our engine is there" — including the
   * adoption path, which then hands a stranger the whole browser API. A pid,
   * port or image check would be guesswork; the engine names itself instead, in
   * its own `/health` payload (`server.js`: `{ ok: true, engine: 'camoufox', … }`).
   * Checking here rather than at each of the six call sites means the guarantee
   * cannot be forgotten at the next one.
   *
   * @param {number} timeoutMs - request deadline.
   * @returns {Promise<any|null>} the health payload, or null when unreachable or not ours.
   */
  async probe(timeoutMs = 1500) {
    const deadline = withDeadline([], timeoutMs)
    try {
      const response = await this.#rawFetch('GET', '/health', undefined, deadline.signal)
      if (!response.ok) return null
      const payload = await response.json()
      if (!isCamofoxHealth(payload)) {
        this.log(`something is listening on ${this.origin} but it does not identify as a camofox engine; refusing to adopt it`)
        return null
      }
      return payload
    } catch {
      return null
    } finally {
      deadline.dispose()
    }
  }

  /** Persist the lock record other harness runs use to find our engine. */
  #writeLock() {
    const record = {
      pid: this.child?.pid ?? 0,
      // The process that supervises it. An orphan is, by definition, supervised
      // by a process that is gone; without this, any second process sharing the
      // state directory would treat a healthy engine as a leftover and kill it.
      ownerPid: process.pid,
      port: this.port,
      baseUrl: this.origin,
      startedAt: now(),
      owner: 'dsh-camofox',
    }
    this.lock = record
    try {
      mkdirSync(this.config.stateDir, { recursive: true })
      writeFileSync(this.lockPath, JSON.stringify(record, null, 2), 'utf8')
    } catch (error) {
      this.log(`could not write the engine lock file: ${describeError(error)}`)
    }
  }

  /**
   * Read the pid of an engine this bundle started during an earlier run.
   *
   * A lock counts as a leftover only when its recorded owner is gone. When the
   * owner is still alive the engine is healthy and supervised, so it is adopted.
   * When the record cannot name a live owner, adopting is also the safe choice:
   * killing an engine somebody else is using is far worse than leaving an
   * orphan that is visible in the task list.
   *
   * @returns {number | null} a live stale pid, or null when there is none.
   */
  #readStaleLockPid() {
    let record
    try {
      if (!existsSync(this.lockPath)) return null
      record = JSON.parse(readFileSync(this.lockPath, 'utf8'))
    } catch {
      return null
    }
    if (!isRecord(record) || record.owner !== 'dsh-camofox') return null
    const pid = Number(record.pid)
    if (!Number.isInteger(pid) || pid <= 0) return null
    // Started by a live supervisor in this process: that engine is healthy and
    // belongs to us, so adopt it rather than tearing it down.
    if (SESSION_PIDS.has(pid)) return null

    const ownerPid = Number(record.ownerPid)
    if (Number.isInteger(ownerPid) && ownerPid > 0 && this.procs.alive(ownerPid)) {
      this.log(`engine pid ${pid} is supervised by a running harness process (pid ${ownerPid}); adopting it`)
      return null
    }
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      this.log(`engine pid ${pid} was left behind by harness process ${ownerPid}, which is no longer running`)
    } else {
      this.log(`engine pid ${pid} has no live owner recorded; leaving it alone`)
      return null
    }

    if (!this.procs.alive(pid)) {
      this.#clearLock()
      return null
    }
    return pid
  }

  /**
   * Wait until the engine stops answering, so a replacement can bind the port.
   *
   * @returns {Promise<boolean>} whether the port went quiet.
   */
  async #waitForPortFree() {
    const deadline = now() + 10000
    while (now() < deadline) {
      if (this.stopped) return true
      if (!(await this.probe(800))) return true
      await sleep(200, this.shutdown.signal)
    }
    return !(await this.probe(800))
  }

  /** Remove the lock record, ignoring filesystem errors. */
  #clearLock() {
    this.lock = null
    try {
      rmSync(this.lockPath, { force: true })
    } catch {
      /* the file is advisory only */
    }
  }

  /**
   * Perform one REST call against the engine with full error classification.
   *
   * @param {'GET'|'POST'|'DELETE'} method - HTTP method.
   * @param {string} path - path below the engine origin.
   * @param {any} [body] - JSON request body.
   * @param {{ signal?: AbortSignal, timeoutMs?: number, query?: Record<string, any>, raw?: boolean }} [options] - call options.
   * @returns {Promise<any>} the decoded payload, or a Buffer when `raw` is set.
   */
  async request(method, path, body, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs
    // DEGRADED is deliberately NOT in this list, and adding it would be the wrong
    // fix. A degraded engine is usually alive and merely slow, so every call
    // would pay a bring-up: up to `reuseTimeoutMs` of waiting for a process that
    // is already running, followed by a replacement attempt — per call, which is
    // the respawn storm the breaker exists to prevent. Recovery is the periodic
    // health check's job: it keeps probing while degraded, returns the state to
    // READY as soon as the engine answers, and asks for exactly one counted
    // replacement when two probes in a row come back empty.
    if (this.state === ENGINE_STATE.STOPPED || this.state === ENGINE_STATE.FAILED || this.state === ENGINE_STATE.STARTING) {
      await this.ensureReady(options.signal)
    }
    const deadline = withDeadline([options.signal], timeoutMs)
    const callStartedAt = now()
    // Armed for the whole call, and deliberately NOT disposed when the headers
    // arrive. `fetch` resolves on headers, so a body that never ends is still an
    // open response — and the only thing that actually tears the connection down
    // at that point is aborting this controller. Both were measured against a
    // server that sends headers and then nothing: cancelling `response.body`
    // leaves the socket open (undici keeps it until the body is drained, and a
    // body that never finishes is never drained), while aborting the request
    // closes it and rejects the pending read.
    const bodyAbort = new AbortController()
    const abortBody = () => bodyAbort.abort()
    // The header deadline is forwarded rather than dropped, so one controller
    // carries every cancellation reason: the caller's signal, the header budget,
    // and — after the headers arrive — the body budget raised below.
    const unlinkDeadline = forwardAbort(deadline.signal, abortBody)
    const unlinkCaller = options.signal
      ? forwardAbort(options.signal, abortBody)
      : () => {}
    let response
    try {
      response = await this.#rawFetch(method, path, body, bodyAbort.signal, options.query)
    } catch (error) {
      const aborted = options.signal?.aborted === true
      const timedOut = deadline.timedOut()
      if (aborted) throw new EngineError('the browser call was canceled', { code: 'canceled' })
      if (timedOut) {
        this.state = this.state === ENGINE_STATE.READY ? ENGINE_STATE.DEGRADED : this.state
        throw new EngineError(`the camofox engine did not answer within ${timeoutMs}ms`, {
          code: 'engine_timeout',
          retryable: true,
        })
      }
      throw new EngineError(`cannot reach the camofox engine at ${this.origin}: ${describeError(error)}`, {
        code: 'engine_unreachable',
        retryable: true,
      })
    } finally {
      deadline.dispose()
    }

    // The body read is what needs the controller still armed, so these listeners
    // outlive the header phase and are released once the whole call is done —
    // below, in the body's own `finally`.
    if (!response.ok) {
      const failure = await EngineError.fromResponse(response)
      // An engine somebody else started may have been given a key we cannot
      // know. A rejection from a CONFIGURED key is a real misconfiguration and
      // is reported as such; one from OUR generated key just means the adoption
      // has to go on without it.
      //
      // Both statuses are covered because they mean the same thing to this
      // engine: `fromResponse` already folds 401 and 403 into a single
      // `unauthorized` error, so testing only 401 left a 403 with no recovery
      // at all — the one answer a gated engine can give when the credential is
      // refused rather than absent.
      if ((failure.status === 401 || failure.status === 403) && this.accessKey && !this.accessKeyConfigured && this.#presentToken) {
        // `tokenOffered` is the gate: inside the cooldown it is false, so
        // exactly one credential-free retry happens and the retry's own
        // rejection propagates instead of recursing.
        this.tokenOffered = false
        this.unauthenticatedUntil = now() + this.config.unauthenticatedCooldownMs
        this.log(`the camofox engine at ${this.origin} rejected our generated access key; retrying without one for ${this.config.unauthenticatedCooldownMs / 1000}s`)
        return await this.request(method, path, body, options)
      }
      throw failure
    }
    // Reading the body needs its own bound, and its own teardown.
    //
    // `fetch` resolves when the response HEADERS arrive, so the deadline above only
    // ever covered the connection and the header exchange — the body that follows
    // can stall forever while that deadline is already disposed, and the caller
    // waits with it. A dead engine that sends headers and then nothing is the
    // ordinary failure this has to survive, because the bridge holds a concurrency
    // slot across the whole read and three stalled reads wedge every tool here.
    //
    // The read is therefore raced against what is left of the call budget, and the
    // request is aborted when it loses. Both were measured, not assumed:
    // cancelling `response.body` leaves the undici socket open, because a
    // connection is only released once its body is drained and a body that never
    // finishes is never drained. Aborting the request closes the socket AND
    // rejects the pending read, which is why the controller below is armed before
    // the fetch and left armed afterwards.
    try {
      if (options.raw) {
        const buffer = await this.#withBodyDeadline(response, bodyAbort, Math.max(1, timeoutMs - (now() - callStartedAt)), options.signal, timeoutMs, () => response.arrayBuffer())
        return Buffer.from(buffer)
      }
      const text = await this.#withBodyDeadline(response, bodyAbort, Math.max(1, timeoutMs - (now() - callStartedAt)), options.signal, timeoutMs, () => response.text())
      if (text === '') return null
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    } finally {
      unlinkDeadline()
      unlinkCaller()
    }
  }

  /**
   * Read a response body under a deadline, and release the socket on a timeout.
   *
   * Two separate obligations, so both are handled here:
   *
   *   - the CALLER must settle. A body that never ends otherwise leaves the
   *     awaiting tool call pending forever, which no outer timeout can rescue,
   *     because the harness tool timeout only checks once `await next()` returns.
   *   - the SOCKET must be released. An abandoned `fetch` keeps its connection
   *     pinned until the peer closes it, so a timeout that only rejects the
   *     promise leaks one socket per call.
   *
   * @param {Response} response - the response whose body is being read.
   * @param {AbortController} bodyAbort - aborts the request, closing the socket.
   * @param {number} budgetMs - milliseconds still available from the call budget.
   * @param {AbortSignal | undefined} signal - the caller's cancellation signal.
   * @param {number} timeoutMs - the call's total budget, for the failure message.
   * @param {() => Promise<any>} read - the body read to bound.
   * @returns {Promise<any>} the body, or the parsed value.
   * @throws {Error} when the read exceeds the budget or the caller canceled.
   */
  async #withBodyDeadline(response, bodyAbort, budgetMs, signal, timeoutMs, read) {
    let timer
    const budget = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new EngineError(
        `the camofox engine sent response headers but no body within ${timeoutMs}ms`,
        { code: 'engine_timeout', retryable: true },
      )), budgetMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    try {
      return await Promise.race([read(), budget])
    } catch (error) {
      // The read lost the race, so the connection is no longer wanted. Aborting
      // the request is what frees the socket; cancelling the body alone is not,
      // because undici keeps a connection until its body is drained. The cancel
      // is still issued as a belt-and-braces close of the response stream, and
      // neither is awaited — a dead engine settles neither.
      bodyAbort.abort()
      void response.body?.cancel().catch(() => {})
      if (signal?.aborted === true) {
        throw new EngineError('the browser call was canceled', { code: 'canceled' })
      }
      // An abort we raised ourselves surfaces as an AbortError; the budget is the
      // real reason, so the caller is told that instead.
      if (error?.name === 'AbortError') {
        throw new EngineError(`the camofox engine sent response headers but no body within ${timeoutMs}ms`, {
          code: 'engine_timeout',
          retryable: true,
        })
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Low-level fetch with engine headers.
   *
   * @param {string} method - HTTP method.
   * @param {string} path - path below the engine origin.
   * @param {any} [body] - JSON body.
   * @param {AbortSignal} signal - request signal covering the header phase.
   * @param {Record<string, any>} [query] - query parameters.
   * @returns {Promise<Response>} the raw response.
   */
  async #rawFetch(method, path, body, signal, query) {
    const url = new URL(`${this.prefix}${path}`, this.origin)
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue
        url.searchParams.set(key, String(value))
      }
    }
    const headers = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    // An adopted engine was started by somebody else with a key we cannot know, so
    // our generated token is only presented to an engine this process owns or a
    // key that was configured explicitly.
    if (this.accessKey && this.#presentToken) {
      headers.authorization = `Bearer ${this.accessKey}`
    }
    if (this.config.apiKey) headers['x-api-key'] = this.config.apiKey
    return fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Stays armed past the headers on purpose, so a stalled body can be torn
      // down instead of waited on. The header budget is forwarded into this same
      // controller by the caller.
      signal,
    })
  }

  /**
   * Snapshot of the supervisor state for the status tool and logs.
   *
   * @returns {object} a JSON-safe status document.
   */
  status() {
    return {
      state: this.state,
      baseUrl: this.origin,
      port: this.port,
      ownedByHarness: this.owned && this.child != null,
      pid: this.child?.pid ?? null,
      // Consecutive empty health probes, and the pid of an engine this session
      // gave up on but could not terminate. Both are the difference between "the
      // engine is slow" and "this supervisor has stopped managing a browser".
      healthMisses: this.healthMisses,
      orphanPid: this.orphanPid,
      restarts: this.restarts,
      restartWindowMs: RESTART_WINDOW_MS,
      restartsPausedUntil: this.breakerUntil > now() ? new Date(this.breakerUntil).toISOString() : null,
      startedAt: this.startedAt || null,
      lastError: this.lastError,
      logFile: this.logPath,
      userId: this.config.userId,
    }
  }

  /**
   * Stop supervising and terminate the engine process tree.
   *
   * Cordis gives a plugin at most five seconds to dispose before the host force
   * exits, so the budget here is deliberately small: a forced tree kill first,
   * then a short confirmation wait.
   *
   * Safe to call more than once; never rejects.
   *
   * @returns {Promise<void>} resolves once the engine is gone.
   */
  async dispose() {
    if (this.stopped) return
    this.stopped = true
    // Ends every internal wait at once. Those waits use ref'd timers, so one
    // still ticking would pin the host process open after the plugin has
    // finished disposing.
    this.shutdown.abort(new Error('the camofox integration is shutting down'))
    if (this.watcher) {
      clearInterval(this.watcher)
      this.watcher = null
    }
    this.state = ENGINE_STATE.STOPPING
    const child = this.child
    if (child && child.pid) {
      const pid = child.pid
      // The exit handler now ignores a child that is no longer the current one, so
      // this release is ours to make: leaving the pid behind would let a later
      // run read it as "supervised by a live harness process" and adopt an orphan.
      SESSION_PIDS.delete(pid)
      const signalled = this.procs.kill(pid)
      // A failed `taskkill` is not proof of death: it exits non-zero for an
      // already-dead pid, for access denied, and for a tree that will not die at
      // all. Only the process table can settle the question, so confirm it either
      // way instead of treating a non-zero exit as "gone".
      if (!signalled) this.log(`the tree kill for camofox engine pid ${pid} was not confirmed; checking the process table instead`)
      let gone = await this.#waitForExit(pid, this.config.shutdownTimeoutMs)
      if (!gone) {
        this.log(`camofox engine pid ${pid} survived the tree kill; sending a direct kill`)
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        gone = await this.#waitForExit(pid, Math.min(1000, this.config.shutdownTimeoutMs))
      }
      this.child = null
      if (!gone) {
        // The lock file is the only record that this browser belongs to a dead
        // supervisor; deleting it would make the next run adopt the orphan
        // instead of reaping it.
        this.state = ENGINE_STATE.FAILED
        this.lastError = `camofox engine pid ${pid} could not be terminated; it is still running and its lock file was kept so the next run reaps it`
        this.log(this.lastError)
        return
      }
      this.state = ENGINE_STATE.STOPPED
      this.#clearLock()
    } else {
      this.state = ENGINE_STATE.STOPPED
      this.#clearLock()
    }

    // An engine this supervisor abandoned earlier is not `this.child` any more,
    // so the branch above could not have reached it. Give it the one thing
    // disposal is still good for — a second attempt — and keep its record if it
    // survives that too, rather than leaving an unrecorded browser behind.
    await this.#reapOrphan(Math.min(1000, this.config.shutdownTimeoutMs))
  }

  /**
   * Wait for a process id to disappear.
   *
   * @param {number} pid - process id.
   * @param {number} timeoutMs - budget.
   * @returns {Promise<boolean>} whether the pid is gone.
   */
  async #waitForExit(pid, timeoutMs) {
    const deadline = now() + timeoutMs
    while (now() < deadline) {
      if (!this.procs.alive(pid)) return true
      await sleep(120)
    }
    return !this.procs.alive(pid)
  }

  /**
   * Install a synchronous last-resort kill for process exits.
   *
   * Cordis disposal already owns the normal shutdown path; this covers the
   * paths where disposal cannot run — an explicit `process.exit()`, an
   * uncaught exception, or a signal. `exit` handlers may only work
   * synchronously, which is exactly what {@link killProcessTree} does.
   *
   * @param {NodeJS.Process} [proc] - process to guard.
   * @returns {() => void} a disposer removing the handlers.
   */
  installExitGuard(proc = process) {
    const kill = () => {
      const pid = this.child?.pid
      // The tree, not the single process: an engine always has children, and
      // killing only the parent would leave a browser nobody supervises.
      if (pid) this.procs.kill(pid)
    }
    const onSignal = () => {
      kill()
    }
    proc.on('exit', kill)
    proc.once('SIGINT', onSignal)
    proc.once('SIGTERM', onSignal)
    proc.once('SIGHUP', onSignal)
    return () => {
      proc.removeListener('exit', kill)
      proc.removeListener('SIGINT', onSignal)
      proc.removeListener('SIGTERM', onSignal)
      proc.removeListener('SIGHUP', onSignal)
    }
  }
}

/**
 * The instruction sent to the model for each error the engine can report.
 *
 * The engine publishes a closed vocabulary — `browserErrorCode`
 * (`lib/browser-errors.js:119-133`) plus the two status-derived codes in
 * `tabNotFoundResponse` (`server.js:1782`) — and sends it in the body's `code`
 * field alongside `recovery`. Status alone cannot separate them: a crashed page,
 * a destroyed tab and a real browser restart are all `410`, so a client that
 * reads only the status tells the model to "carry on against a browser that is
 * fine".
 *
 * `recovery` is the engine's own instruction and is preferred when present.
 */
const ENGINE_CODE_GUIDANCE = {
  browser_restarted: 'the camoufox browser restarted; open a new tab and continue',
  page_crashed: 'the page crashed; open a new tab and continue',
  tab_destroyed: 'this tab was destroyed; open a new tab and continue',
  // A `tab_timeout` is the engine's own handler budget expiring
  // (`HANDLER_TIMEOUT_MS`, 30s by default, server.js:4057) after which it destroys
  // the tab. The browser is fine and no restart happened; saying so is the
  // difference between a model that retries the action and one that goes looking
  // for a browser that never broke.
  tab_timeout: 'this action took longer than the engine allows, so the engine closed the tab; the browser is still running — open a new tab and try a narrower action',
  tab_unresponsive: 'this tab stopped responding and was destroyed; open a new tab and continue',
  session_expired: 'the browser session expired; the same call will get a fresh session',
  stale_refs: 'element refs are stale; take a fresh snapshot before interacting',
  element_not_actionable: 'the element is not actionable; scroll it into view or use a different element',
  ambiguous_selector: 'that selector matched several elements; narrow it or use a ref',
  invalid_selector: 'that is not a valid CSS selector',
  navigation_race: 'the page navigated while that call was in flight; read the page again',
  concurrency_timeout: 'too many calls were already in flight for this browser; retry',
  browser_launch_timeout: 'the browser took too long to start; retry',
}

/**
 * Map a non-2xx engine response onto a classified {@link EngineError}.
 *
 * The engine already encodes the most actionable conditions in its status code
 * and payload; preserving them turns "the tool failed" into "open a new tab and
 * try again".
 *
 * @param {Response} response - failed response.
 * @returns {Promise<EngineError>} the classified error.
 */
EngineError.fromResponse = async function fromResponse(response) {
  let text = ''
  try {
    text = await response.text()
  } catch {
    /* body already consumed or aborted */
  }
  let payload
  try {
    payload = text ? JSON.parse(text) : undefined
  } catch {
    payload = undefined
  }
  const code = (isRecord(payload) && typeof payload.code === 'string' && payload.code) || ''
  // The engine's own recovery hint, sent beside `code` (server.js:1542). It is
  // the authority on what the caller should do next.
  const recovery = (isRecord(payload) && typeof payload.recovery === 'string' && payload.recovery) || ''
  const message = (isRecord(payload) && typeof payload.error === 'string' && payload.error) || text || response.statusText || 'engine request failed'
  const short = message.length > 600 ? `${message.slice(0, 600)}…` : message

  // The engine's own `code` is authoritative when it sent one. Every condition it
  // reports arrives as `{ error, code, retryable, recovery }` (server.js:1542,
  // :1612, :1616, :1622), and 410 alone is ambiguous: page_crashed,
  // tab_destroyed, tab_timeout and browser_restarted all use it. Deciding from
  // the status told the model a crashed page was a browser restart.
  if (code && ENGINE_CODE_GUIDANCE[code]) {
    const needsNewTab = /create_new_tab/.test(recovery) || /restarted|crashed|destroyed|responding/.test(code)
    return new EngineError(`${ENGINE_CODE_GUIDANCE[code]} (${short})`, {
      status: response.status,
      code,
      needsNewTab,
      needsResnapshot: /snapshot_then_retry/.test(recovery) || code === 'stale_refs',
      // The engine states whether the call may be repeated, so a page-mutating
      // action is never replayed on its say-so alone.
      retryable: typeof payload?.retryable === 'boolean' ? payload.retryable : needsNewTab,
      payload,
    })
  }

  if (response.status === 410) {
    return new EngineError(`the camoufox browser restarted (${short}); open a new tab and continue`, {
      status: response.status,
      code: 'browser_restarted',
      needsNewTab: true,
      retryable: true,
      payload,
    })
  }
  if (response.status === 404 && /tab/i.test(short)) {
    return new EngineError(`the tab no longer exists (${short}); open a new tab`, {
      status: response.status,
      code: 'tab_not_found',
      needsNewTab: true,
      payload,
    })
  }
  if (response.status === 409) {
    // A navigation race arrives as 409 `navigation_race` (the engine's own tests
    // assert exactly that), and it is the single most common 409 in practice:
    // the page redirected between the caller deciding to read it and the read
    // landing. It is not a conflict to resolve — it is a read to repeat, and
    // saying so is the difference between the model retrying once and the model
    // concluding the page is broken.
    // A click that outlives the engine's handler budget answers 409
    // `page_changed` when the tab survived (server.js:4071-4079). The tab is
    // still there and its refs were refreshed by the engine, so this needs a
    // fresh snapshot and the SAME tab — not a new one.
    if (code === 'page_changed') {
      return new EngineError(`the page changed while that action was in flight (${short}); read the same tab again for current refs, then retry`, {
        status: response.status,
        code,
        needsResnapshot: true,
        needsNewTab: false,
        retryable: typeof payload?.retryable === 'boolean' ? payload.retryable : true,
        payload,
      })
    }

    if (code === 'navigation_race') {
      return new EngineError(`the page navigated while that call was in flight (${short}); read the page again`, {
        status: response.status,
        code,
        needsResnapshot: true,
        needsNewTab: false,
        // The engine classifies it as retryable (`browserErrorRecovery`), and it
        // is: the call did not mutate anything, so repeating it is safe.
        retryable: typeof payload?.retryable === 'boolean' ? payload.retryable : true,
        payload,
      })
    }
    const needsResnapshot = /stale|no refs/i.test(short)
    return new EngineError(
      needsResnapshot
        ? `element refs are stale or missing (${short}); take a fresh snapshot before interacting`
        : `the engine reported a conflict (${short})`,
      { status: response.status, code: needsResnapshot ? 'stale_refs' : 'conflict', needsResnapshot, retryable: needsResnapshot, payload },
    )
  }
  if (response.status === 401 || response.status === 403) {
    return new EngineError(`the camofox engine rejected our credentials (${short})`, {
      status: response.status,
      code: 'unauthorized',
      payload,
    })
  }
  if (response.status === 422) {
    return new EngineError(`the page did not yield the requested data (${short})`, {
      status: response.status,
      code: 'extraction_failed',
      retryable: true,
      payload,
    })
  }
  if (response.status === 503 || response.status === 429) {
    return new EngineError(`the camofox engine is temporarily unavailable (${short})`, {
      status: response.status,
      code: 'engine_busy',
      retryable: true,
      payload,
    })
  }
  if (response.status >= 500) {
    return new EngineError(`the camofox engine failed (${short})`, {
      status: response.status,
      code: 'engine_error',
      retryable: true,
      payload,
    })
  }
  return new EngineError(short, { status: response.status, code: code || 'bad_request', payload })
}

/**
 * Build the default configuration from an optional override object.
 *
 * @param {Record<string, any>} [raw] - user configuration.
 * @returns {object} a fully resolved configuration object.
 */
export function resolveConfig(raw = {}) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const stateDir = typeof raw.stateDir === 'string' && raw.stateDir ? resolve(raw.stateDir) : join(home, 'camofox')
  const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : 'http://127.0.0.1:9377'
  // Whether the operator supplied the key, decided BEFORE it is defaulted. This
  // has to be carried separately: `accessKey` is never empty once resolved, so
  // deriving it there made every key look configured and the 401 recovery branch
  // unreachable even when the key was one this process invented.
  const accessKeyConfigured = typeof raw.accessKey === 'string' && raw.accessKey !== ''
  return {
    baseUrl,
    repoPath: typeof raw.repoPath === 'string' && raw.repoPath ? resolve(raw.repoPath) : join(home, 'camofox', 'repo'),
    // Install the engine on first run when the default location is empty, so a new
    // machine reaches a browser without cloning anything. Never applies to a `repoPath`
    // the operator set: a path they chose is one they manage. Set false to require a
    // pre-existing checkout — an air-gapped deployment, or one that supplies the engine
    // from its own mirror.
    bootstrap: raw.bootstrap !== false,
    // Separate from `startTimeoutMs` on purpose: the first run installs ~175 packages and
    // downloads a ~1.06 GB browser binary, which is a different job from waiting for a
    // process to bind a port, and a budget tuned for the second starves the first.
    bootstrapTimeoutMs: clampInt(raw.bootstrapTimeoutMs, 1800000, 30000, 7200000),
    entry: typeof raw.entry === 'string' && raw.entry ? raw.entry : 'server.js',
    nodePath: typeof raw.nodePath === 'string' && raw.nodePath ? raw.nodePath : '',
    stateDir,
    logFile: typeof raw.logFile === 'string' && raw.logFile ? resolve(raw.logFile) : join(stateDir, 'engine.log'),
    autostart: raw.autostart !== false,
    startTimeoutMs: clampInt(raw.startTimeoutMs, 180000, 5000, 1800000),
    // Budget for an engine we already own but cannot reach. It has no fresh
    // process to wait for, so a start that is merely slow gets a much shorter
    // leash than one that was just launched: a wedged child is replaced instead
    // of stalling every later tool call for the full start budget.
    reuseTimeoutMs: clampInt(raw.reuseTimeoutMs, 15000, 1000, 600000),
    requestTimeoutMs: clampInt(raw.requestTimeoutMs, 120000, 2000, 900000),
    // Must match CONFIG_DEFAULTS in index.js and the README: a longer wait than the
    // host's five second disposal ceiling spends the whole budget being killed
    // rather than on the engine.
    shutdownTimeoutMs: clampInt(raw.shutdownTimeoutMs, 2000, 500, 120000),
    healthIntervalMs: clampInt(raw.healthIntervalMs, 20000, 2000, 300000),
    restartLimit: clampInt(raw.restartLimit, 3, 0, 20),
    userId: typeof raw.userId === 'string' && raw.userId ? raw.userId : 'dsh',
    // Namespace prefix for browser identities, not the final value: the engine
    // userId actually sent is `${userId}~<liveSessionId>` (see src/scope.js), so
    // every Session — and every delegated subagent — owns its own cookie jar and
    // its own tab pool. `false` restores the one-jar-per-profile behaviour that
    // predates the scope.
    perSessionScope: raw.perSessionScope !== false,
    // How long a scope the framework never announced as disposed is kept before
    // the bridge releases it. The engine's own reapers still run; this only
    // covers the case where they are disabled or where no announcement arrives.
    scopeIdleMs: clampInt(raw.scopeIdleMs, 900000, 60000, 86400000),
    // An empty string means "generate one": the engine gates every route except
    // `/health` once `CAMOFOX_ACCESS_KEY` is set in its environment, and a key
    // nobody configured is how that gate stayed closed with every route open on
    // loopback.
    accessKey: accessKeyConfigured ? raw.accessKey : processAccessKey(),
    // Derived, not configurable: `true` when the operator supplied the key.
    accessKeyConfigured,
    // Escape hatch for an engine somebody else runs and gates itself; it keeps
    // the generated key out of the child we spawn.
    allowUnauthenticated: raw.allowUnauthenticated === true,
    // How long a rejected generated key is withheld before it is offered again.
    // A deployment whose engine is restarted under a new key every few minutes
    // needs this shorter than the five minutes it used to be hardcoded to: the
    // window is a tax paid by every call made while it runs.
    unauthenticatedCooldownMs: clampInt(raw.unauthenticatedCooldownMs, 300000, 1000, 3600000),
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    engineEnv: isRecord(raw.engineEnv) ? { ...raw.engineEnv } : {},
    // Behaviour knobs surfaced to tools.
    defaultMaxChars: clampInt(raw.defaultMaxChars, 20000, 1000, 200000),
    maxExtractChars: clampInt(raw.maxExtractChars, 60000, 2000, 400000),
    snapshotScreenshotByDefault: raw.snapshotScreenshotByDefault === true,
    allowEvaluate: raw.allowEvaluate !== false,
    maxTabs: clampInt(raw.maxTabs, 8, 1, 10),
    maxConcurrentPerUser: clampInt(raw.maxConcurrentPerUser, 3, 1, 3),
    scrapeConcurrency: clampInt(raw.scrapeConcurrency, 3, 1, 3),
    mirrorAssetLimit: clampInt(raw.mirrorAssetLimit, 150, 0, 5000),
    tempDir: typeof raw.tempDir === 'string' && raw.tempDir ? resolve(raw.tempDir) : join(tmpdir(), 'dsh-camofox'),
    // Extracted addon folders for Camoufox. Camoufox loads directories, not
    // `.xpi` archives, so each entry is resolved here and checked at launch.
    addons: Array.isArray(raw.addons) ? raw.addons.filter(p => typeof p === 'string' && p !== '').map(p => resolve(p)) : [],
    // Whether to drop the default addon set. There is deliberately no
    // per-name exclusion: the engine turns this boolean into a hardcoded
    // `exclude_addons: ['UBO']` at launch (server.js:1181), so a name list would
    // validate, render in Settings, and then do nothing.
    disableDefaultAddons: raw.disableDefaultAddons === true,
    // Deliberately not configurable: whether a page-level failure is captured is
    // the difference between a browser that reports why a page is broken and one
    // that silently shows a healthy-looking page. It costs bounded memory per tab.
    captureConsole: raw.captureConsole !== false,
    consoleMaxEntries: clampInt(raw.consoleMaxEntries, 200, 20, 2000),
  }
}