/**
 * Hermetic unit suite for dsh-camofox.
 *
 * `scripts/smoke.mjs` and `scripts/lifecycle.mjs` exercise the plugin against a
 * real browser, real network and a real camofox checkout, so neither can run on
 * a machine that has none of the three. Everything below is the part of the
 * plugin that is pure logic — argument coercion, result shaping, error
 * classification, configuration resolution and process-supervisor bookkeeping —
 * and it runs anywhere `node` runs, with no dependency and no engine.
 *
 * Run with: `node scripts/unit.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { clampInt, configValidator, describeError, isProcessAlive, isRecord, killProcessTree, now, page, sleep, truncate, withDeadline } from '../src/util.js'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { CamofoxEngine, isSessionPid, resolveConfig } from '../src/engine.js'
import { Config } from '../src/index.js'

test('every relative import in the plugin resolves', () => {
  // A renamed or deleted module breaks the LIVE suites at import time, before a
  // single assertion runs, and `node --check` cannot see it. The live tier is
  // the only coverage of the browser operations, so a broken import there is
  // invisible until someone runs it — and `test:live` chains two scripts, so
  // the failure can hide the second one entirely. This walks the import graph
  // statically instead.
  const root = fileURLToPath(new URL('..', import.meta.url))
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(full)
    }
  }
  walk(join(root, 'src'))
  walk(join(root, 'scripts'))
  assert.ok(files.length >= 12, `expected the whole plugin, found only ${files.length} files`)

  const missing = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"](\.[^'"]+)['"]/g)) {
      const target = resolve(fileURLToPath(new URL(match[1], pathToFileURL(file))))
      if (!existsSync(target)) missing.push(`${file.slice(root.length)} -> ${match[1]}`)
    }
  }
  assert.deepEqual(missing, [], `unresolvable relative imports: ${missing.join(', ')}`)
})

test('every source module imports cleanly', async () => {
  // Same class of defect, at module level: a syntax error or a bad named import
  // must fail `npm test`, not the harness.
  for (const name of ['util', 'engine', 'bridge', 'scope', 'tools', 'prompt', 'mirror', 'index']) {
    const loaded = await import(`../src/${name}.js`)
    assert.ok(Object.keys(loaded).length > 0, `src/${name}.js exported nothing`)
  }
})

test('clampInt coerces, falls back and bounds', () => {

  assert.equal(clampInt(5, 0, 1, 10), 5)
  assert.equal(clampInt('7', 0, 1, 10), 7)
  assert.equal(clampInt('nonsense', 3, 1, 10), 3)
  assert.equal(clampInt(undefined, 3, 1, 10), 3)
  assert.equal(clampInt(99, 0, 1, 10), 10)
  assert.equal(clampInt(-99, 0, 1, 10), 1)
  assert.equal(clampInt(2.6, 0, 0, 10), 3)
  assert.equal(clampInt(Number.NaN, 4, 0, 10), 4)
  assert.equal(clampInt(Number.POSITIVE_INFINITY, 4, 0, 10), 4)
})

test('truncate keeps the head and names the cut', () => {
  assert.equal(truncate('short', 100), 'short')
  const cut = truncate('x'.repeat(50), 10, 'document')
  assert.ok(cut.startsWith('x'.repeat(10)))
  assert.match(cut, /truncated document: showing 10 of 50 characters/)
  // A non-positive or non-finite budget means "no budget", not "empty result".
  assert.equal(truncate('body', 0), 'body')
  assert.equal(truncate('body', Number.NaN), 'body')
  assert.equal(truncate(undefined, 10), '')
})

test('page hands back a cursor that actually advances', () => {
  const text = 'y'.repeat(1000)
  const first = page(text, 0, 100)
  assert.match(first, /^characters 0-100 of 1000/)
  assert.match(first, /\[more content: next offset=100\]/)
  const second = page(text, 100, 100)
  assert.match(second, /^characters 100-200 of 1000/)
  assert.notEqual(first, second)
  // Walking the cursor must cover every character exactly once.
  const seen = new Set()
  for (let offset = 0; offset < 1000; offset += 100) seen.add(page(text, offset, 100).slice(0, 22))
  assert.equal(seen.size, 10)
  assert.match(page(text, 1000, 100), /no more content: the document is 1000 characters long/)
  assert.match(page(text, 999, 100), /\[end of content\]/)
})

test('configValidator rejects unknown keys loudly', () => {
  const validate = configValidator({ port: 1, name: 'a', on: true }, { port: 'number', name: 'string', on: 'boolean' })
  assert.deepEqual(validate(undefined).value, { port: 1, name: 'a', on: true })
  assert.deepEqual(validate(null).value, { port: 1, name: 'a', on: true })
  assert.ok(validate({ nope: 1 }).issues?.some((issue) => issue.message.includes('unknown config key "nope"')))
  assert.ok(validate('string').issues)
  assert.ok(validate({ port: 'x' }).issues?.some((issue) => issue.message.includes('finite number')))
  assert.ok(validate({ on: 'yes' }).issues?.some((issue) => issue.message.includes('must be a boolean')))
  assert.ok(validate({ name: 3 }).issues?.some((issue) => issue.message.includes('must be a string')))
  assert.equal(validate({ port: '8080' }).value.port, 8080)
})

test('configValidator keeps every reported issue', () => {
  const validate = configValidator({ a: 1, b: 1 }, { a: 'number', b: 'number' })
  const result = validate({ a: 'x', b: 'y', c: 1, d: 2 })
  assert.equal(result.issues.length, 4)
})

test('isRecord excludes arrays and null', () => {
  assert.equal(isRecord({}), true)
  assert.equal(isRecord([]), false)
  assert.equal(isRecord(null), false)
  assert.equal(isRecord('s'), false)
})

test('describeError never throws on an exotic value', () => {
  assert.equal(describeError(null), 'unknown error')
  assert.equal(describeError('boom'), 'boom')
  assert.equal(describeError(new Error('bad')), 'bad')
  const circular = {}
  circular.self = circular
  assert.equal(typeof describeError(circular), 'string')
})

test('now never goes backwards across a clock step', () => {
  const first = now()
  assert.ok(now() >= first)
  assert.ok(now() >= first)
})

test('withDeadline aborts on timeout and reports it', async () => {
  const deadline = withDeadline([], 20)
  try {
    await sleep(60, deadline.signal)
    assert.equal(deadline.timedOut(), true)
    assert.equal(deadline.signal.aborted, true)
  } finally {
    deadline.dispose()
  }
})

test('withDeadline propagates an upstream abort', async () => {
  const upstream = new AbortController()
  const deadline = withDeadline([upstream.signal], 5000)
  upstream.abort(new Error('cancel'))
  await sleep(5, deadline.signal)
  assert.equal(deadline.signal.aborted, true)
  assert.equal(deadline.timedOut(), false)
  deadline.dispose()
})

test('withDeadline starts aborted when an upstream already is', () => {
  const upstream = new AbortController()
  upstream.abort()
  const deadline = withDeadline([upstream.signal, undefined], 5000)
  assert.equal(deadline.signal.aborted, true)
  deadline.dispose()
})

// ---------------------------------------------------------------------------
// Supervisor and configuration guards.
//
// Each of these is a defect that survived a full audit because it is invisible
// until it happens: a validator that rewrites the caller's object, a 401 branch
// whose guard is a contradiction, a readiness poll that outlives dispose() by
// three minutes, a stale `exit` handler that orphans a live engine. They live
// here rather than in a throwaway probe because a probe is not a guard.
//
// No browser, no camofox checkout, no process spawned; loopback HTTP only.
// ---------------------------------------------------------------------------

test('the config validator never writes into the caller object', () => {
  const validate = configValidator({ engineEnv: {} }, { engineEnv: 'record' })
  const engineEnv = { PORT: 9377 }
  validate({ engineEnv })
  assert.deepEqual(engineEnv, { PORT: 9377 }, 'the caller object was rewritten')
  const input = { engineEnv: { A: 1 } }
  const result = validate(input)
  assert.notEqual(result.value.engineEnv, input.engineEnv, 'the result aliases the caller object')
  assert.equal(input.engineEnv.A, 1, 'the caller object was rewritten')
})

test('a frozen host configuration loads instead of throwing', () => {
  // ESM is strict, so writing into a frozen input throws straight out of the
  // Standard Schema entry point — a plugin load killed by a `TypeError`.
  const validate = configValidator({ engineEnv: {} }, { engineEnv: 'record' })
  const input = Object.freeze({ engineEnv: Object.freeze({ CAMOFOX_LOG_LEVEL: 3 }) })
  const result = validate(input)
  assert.ok(result.value, 'a frozen config failed validation')
  assert.deepEqual(result.value.engineEnv, { CAMOFOX_LOG_LEVEL: '3' })

  const throughSchema = Config['~standard'].validate(input)
  assert.ok(throughSchema.value, 'Config threw or rejected a frozen input')
  assert.deepEqual(throughSchema.value.engineEnv, { CAMOFOX_LOG_LEVEL: '3' })
})

test('null and undefined engineEnv values are omitted, not written as empty', () => {
  const validate = configValidator({ engineEnv: {} }, { engineEnv: 'record' })
  const out = validate({ engineEnv: { A: null, B: undefined, C: 'x' } }).value.engineEnv
  // `spawn` keeps a present-but-empty entry, so an unset variable and an empty
  // one are not interchangeable.
  assert.deepEqual(Object.keys(out), ['C'])
  assert.equal(validate({ engineEnv: { A: null } }).value.engineEnv.A, undefined)
})

test('non-finite numbers are refused as engine environment values', () => {
  const validate = configValidator({ engineEnv: {} }, { engineEnv: 'record' })
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const result = validate({ engineEnv: { N: value } })
    assert.equal(result.issues?.length, 1, `${value} was accepted`)
    assert.match(result.issues[0].message, /finite number/)
  }
  assert.equal(validate({ engineEnv: { N: 1.5 } }).value.engineEnv.N, '1.5')
  assert.equal(validate({ engineEnv: { A: true } }).value.engineEnv.A, 'true')
  assert.equal(validate({ engineEnv: { A: 'x' } }).value.engineEnv.A, 'x')
  assert.equal(validate({ engineEnv: { A: { b: 1 } } }).issues?.length, 1)
})

test('the reserved child variables are refused, and the access key only when it is ours', () => {
  const refuse = (config) => Config['~standard'].validate(config).issues?.[0]?.message ?? null
  for (const key of ['CAMOFOX_BIND_HOST', 'CAMOFOX_CRASH_REPORT_ENABLED', 'CAMOFOX_DSH_OWNER', 'CAMOFOX_DSH_LOG', 'CAMOFOX_PORT']) {
    assert.ok(refuse({ engineEnv: { [key]: 'x' } }), `${key} was not refused`)
    assert.ok(refuse({ allowUnauthenticated: true, engineEnv: { [key]: 'x' } }), `${key} was not refused in open mode`)
  }
  // The plugin hands its own key to the child it spawns, so it is reserved.
  assert.ok(refuse({ engineEnv: { CAMOFOX_ACCESS_KEY: 'k' } }))
  assert.ok(refuse({ engineEnv: { camofox_access_key: 'k' } }), 'the check is case-insensitive')
  // In open mode the key is deliberately NOT exported, so a configured value is
  // the only thing that can put one there.
  assert.equal(refuse({ allowUnauthenticated: true, engineEnv: { CAMOFOX_ACCESS_KEY: 'k' } }), null)
  // A harmless passthrough must stay allowed: refusing it fails the whole LOAD.
  assert.equal(refuse({ engineEnv: { CAMOFOX_LOG_LEVEL: 'debug' } }), null)
})

test('a generated key is distinguishable from a configured one', () => {
  // resolveConfig always fills accessKey in, so the flag has to be carried
  // separately — otherwise the 401 recovery branch is dead by construction,
  // which is exactly how it survived review once already.
  assert.equal(resolveConfig({}).accessKeyConfigured, false)
  assert.equal(resolveConfig({ accessKey: '' }).accessKeyConfigured, false)
  assert.equal(resolveConfig({ accessKey: 'secret' }).accessKeyConfigured, true)
  assert.equal(resolveConfig({ accessKey: 'secret' }).accessKey, 'secret')
  assert.ok(resolveConfig({}).accessKey.length > 0)

  const engine = new CamofoxEngine({ config: resolveConfig({ stateDir: mkdtempSync(join(tmpdir(), 'reg-')), autostart: false }), log: () => {} })
  assert.equal(engine.accessKeyConfigured, false)
  assert.equal(engine.tokenOffered, true)
  assert.equal(engine.unauthenticatedUntil, 0)
})

test('a 401 from an adopted engine is retried once without the token', async () => {
  const seen = []
  const server = createServer((req, res) => {
    const auth = req.headers.authorization
    seen.push({ url: req.url, auth: auth ?? null })
    if (req.url.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    // Exactly an engine somebody else started with a key we cannot learn.
    if (auth) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"unauthorized"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const logs = []
  const engine = new CamofoxEngine({
    config: resolveConfig({ baseUrl: `http://127.0.0.1:${port}`, stateDir: mkdtempSync(join(tmpdir(), 'reg-401-')), autostart: false }),
    log: (message) => logs.push(message),
  })

  try {
    const payload = await engine.request('POST', '/tabs', {})
    assert.deepEqual(payload, { ok: true })
    const calls = seen.filter((entry) => !entry.url.startsWith('/health'))
    assert.equal(calls.length, 2, 'the call was not retried exactly once')
    assert.ok(calls[0].auth, 'the generated token was never offered, so the branch stayed dead')
    assert.equal(calls[1].auth, null, 'the retry still carried the rejected token')
    assert.ok(logs.some((line) => line.includes('rejected our generated access key')))

    // The cooldown is not a latch: it withholds the token, then re-arms.
    const seenCount = seen.length
    await engine.request('POST', '/tabs', {})
    assert.equal(seen.slice(seenCount).some((entry) => entry.auth !== null), false, 'the cooldown did not withhold the token')
    engine.unauthenticatedUntil = Date.now() - 1
    await engine.request('POST', '/tabs', {})
    const afterCooldown = seen.slice(seenCount)
    assert.ok(afterCooldown.some((entry) => entry.auth !== null), 'the token was not re-offered after the cooldown expired')
    assert.equal(afterCooldown.at(-1).auth, null)
  } finally {
    await engine.dispose()
    server.close()
  }
})

test('a 401 caused by a CONFIGURED key is still reported', async () => {
  const server = createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{"error":"unauthorized"}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const engine = new CamofoxEngine({
    config: resolveConfig({ baseUrl: `http://127.0.0.1:${port}`, stateDir: mkdtempSync(join(tmpdir(), 'reg-401b-')), autostart: false, accessKey: 'configured-key' }),
    log: () => {},
  })
  try {
    await assert.rejects(() => engine.request('POST', '/tabs', {}), /rejected our credentials/)
  } finally {
    await engine.dispose()
    server.close()
  }
})

test('an adoption overtaken by dispose reports stopped and leaks nothing', async () => {
  // Slow enough that dispose() wins the race, exactly like the real failure.
  //
  // The fake MUST identify as a camoufox engine: `probe()` refuses anything else,
  // and `#bringUp` only reaches `#markReady` down the adoption branch. With a
  // bare `{"ok":true}` this test walked into the `autostart:false` failure path
  // and the `#markReady` guard it claims to cover was never executed — which is
  // how it stayed green while `#markReady` was mutated.
  const server = createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true,"engine":"camoufox"}')
    }, 900)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const logs = []
  const engine = new CamofoxEngine({
    config: resolveConfig({ baseUrl: `http://127.0.0.1:${port}`, stateDir: mkdtempSync(join(tmpdir(), 'reg-markready-')), autostart: false, healthIntervalMs: 2000 }),
    log: (message) => logs.push(message),
  })
  try {
    const started = engine.ensureReady().catch(() => false)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await engine.dispose()
    assert.equal(await started, false, 'a disposed supervisor reported a ready engine')
    assert.equal(engine.state, 'stopped', 'an in-flight start overwrote the stopped state')
    assert.equal(engine.watcher, null, 'the health interval leaked past dispose')
    assert.equal(logs.some((line) => line.includes('camofox engine ready')), false)
    // The adoption branch really was taken. If it were not, `#bringUp` would
    // have taken the `autostart:false` path and left an error behind — and the
    // assertions above would be passing without ever reaching `#markReady`.
    assert.equal(engine.lastError, null, `the adoption branch was not reached: ${engine.lastError}`)
  } finally {
    if (engine.watcher) clearInterval(engine.watcher)
    engine.watcher = null
    server.close()
  }
})

test('an engine that does not identify as camoufox is never adopted', async () => {
  // Everything that trusts `/health` also trusts `probe()`: the readiness poll,
  // the adoption path, the liveness tick, the post-disposal check. So the
  // identity check lives inside `probe()` — one place, rather than six places
  // where the next call site can forget it.
  const serve = (handler) => {
    const seen = []
    const server = createServer((req, res) => {
      seen.push(req.url)
      handler(req, res)
    })
    return { server, seen }
  }
  const listen = async (server) => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    return server.address().port
  }

  // A stranger on the port: answers /health, is not a camoufox engine.
  const impostor = serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true,"service":"something-else"}')
  })
  const impostorPort = await listen(impostor.server)
  const logs = []
  const impostorEngine = new CamofoxEngine({
    config: resolveConfig({ baseUrl: `http://127.0.0.1:${impostorPort}`, stateDir: mkdtempSync(join(tmpdir(), 'reg-imp-')), autostart: false }),
    log: (message) => logs.push(message),
  })
  try {
    assert.equal(await impostorEngine.probe(1500), null, 'a stranger on the port was accepted as our engine')
    assert.equal(impostorEngine.child, null, 'a stranger was adopted as a child')
    assert.ok(logs.some((line) => String(line).includes('does not identify as a camofox engine')), `the refusal was silent; logs were ${JSON.stringify(logs)}`)
    // And the whole bring-up path must refuse to adopt it.
    const ready = await impostorEngine.ensureReady()
    assert.equal(ready, false, 'ensureReady adopted a stranger answering on the port')
    assert.equal(impostorEngine.owned, false)
  } finally {
    await impostorEngine.dispose()
    impostor.server.close()
  }

  // A genuine engine is still accepted — the check must not be a blanket refusal.
  const genuine = serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true,"engine":"camoufox","browserConnected":true}')
  })
  const genuinePort = await listen(genuine.server)
  const realEngine = new CamofoxEngine({
    config: resolveConfig({ baseUrl: `http://127.0.0.1:${genuinePort}`, stateDir: mkdtempSync(join(tmpdir(), 'reg-real-')), autostart: false }),
    log: () => {},
  })
  try {
    const payload = await realEngine.probe(1500)
    assert.equal(payload?.engine, 'camoufox', 'a genuine engine was refused')
    assert.equal(await realEngine.ensureReady(), true, 'ensureReady did not adopt a genuine engine')
    assert.equal(realEngine.owned, false, 'adoption must not claim ownership')
  } finally {
    await realEngine.dispose()
    genuine.server.close()
  }
})

test('the reuse budget is bounded and never exceeds the start budget', () => {
  const base = { stateDir: mkdtempSync(join(tmpdir(), 'reg-reuse-')) }
  assert.equal(resolveConfig(base).reuseTimeoutMs, 15000)
  assert.equal(resolveConfig({ ...base, reuseTimeoutMs: 1234 }).reuseTimeoutMs, 1234)
  assert.equal(resolveConfig({ ...base, reuseTimeoutMs: 1 }).reuseTimeoutMs, 1000, 'below the floor')
  const both = resolveConfig({ ...base, startTimeoutMs: 5000, reuseTimeoutMs: 30000 })
  assert.equal(Math.min(both.startTimeoutMs, both.reuseTimeoutMs), 5000, 'the reuse budget may not outlive the start budget')
})

test('Config is projectable when the peer routes, and identical when it does not', () => {
  // Which of the two shapes is active depends on whether the harness loader
  // routed the `@deepseek-ai/schemastery` peer, which plain `node` cannot do.
  // The invariant that must hold EITHER way is the validator, because that is
  // what every tool call depends on: a settings row must never be able to change
  // how configuration is validated.
  const validate = Config['~standard'].validate
  assert.equal(typeof validate, 'function', 'Config lost its Standard Schema entry point')

  const native = Config[Symbol.for('schemastery')] === true
  if (native) {
    // The three conditions `isNativeConfigSchema` actually checks in dsh-app-boot.
    assert.equal(typeof Config.type, 'string', 'a native Config needs a string `type`')
    assert.ok(Config.meta && typeof Config.meta === 'object', 'a native Config needs a `meta` object')
  }

  // Behavioural contract, asserted on whichever shape is active.
  assert.equal(validate({}).value.userId, 'dsh', 'defaults are not applied')
  assert.equal(validate({ maxTabs: 5 }).value.maxTabs, 5)
  assert.ok(validate({ nope: 1 }).issues?.length, 'an unknown key is accepted')
  assert.ok(validate({ baseUrl: 'ftp://x' }).issues?.length, 'a non-http baseUrl is accepted')
  assert.ok(validate({ baseUrl: 'not a url' }).issues?.length, 'a junk baseUrl is accepted')
  assert.ok(validate({ engineEnv: { CAMOFOX_PORT: '1' } }).issues?.length, 'a reserved child variable is accepted')
  assert.ok(validate({ engineEnv: { camofox_port: '1' } }).issues?.length, 'the reserved check lost its case-insensitivity')
  assert.equal(validate({ engineEnv: { CAMOFOX_LOG_LEVEL: 'debug' } }).issues, undefined, 'a harmless passthrough is refused, which would fail the plugin load')
  assert.ok(validate({ engineEnv: { CAMOFOX_ACCESS_KEY: 'k' } }).issues?.length, 'the access key is not reserved while the plugin gates the engine')
  assert.equal(validate({ allowUnauthenticated: true, engineEnv: { CAMOFOX_ACCESS_KEY: 'k' } }).issues, undefined, 'the access key is refused in open mode, where the plugin exports none')
})

// ---------------------------------------------------------------------------
// Supervisor guards that need a child process and must not start one.
//
// Every defect below lives in the bookkeeping around `spawn()` — the `exit`
// handler, the log append inside it, the tree kill, the session-pid release, the
// readiness poll, the breaker. None of it can be reached without a real engine,
// which is why `CamofoxEngine.procs` holds the four process-level primitives:
// the defaults are the real helpers (pinned by the first test in this section),
// and here they are replaced by a fake process table so a guard can drive the
// spawn/kill/exit paths on a machine with no browser on it.
//
// Loopback HTTP only; no process is ever started.
// ---------------------------------------------------------------------------

/**
 * A stand-in for a spawned child — exactly the surface the supervisor touches.
 *
 * @param {number} pid - the pid the process table should report.
 * @returns {EventEmitter & Record<string, any>} a fake child process.
 */
function fakeChild(pid) {
  const child = new EventEmitter()
  child.pid = pid
  child.killed = false
  child.kill = () => {
    child.killed = true
    return true
  }
  child.unref = () => child
  return child
}

/**
 * A supervisor over a fake process table.
 *
 * `mode` is the fake engine's `/health` behaviour: `answer` (a real engine),
 * `error` (something answering that is not usable) or `hang` (a wedged engine
 * that never replies, which costs a probe deadline per attempt).
 *
 * @param {object} [options] - scenario shape.
 * @returns {object} the fixture.
 */
function supervisorFixture({ config = {}, mode = 'answer', baseUrl = 'http://127.0.0.1:9', spawnThrows = false } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'reg-proc-'))
  const entry = join(stateDir, 'entry.js')
  writeFileSync(entry, '// fake engine entry: the supervisor only checks that it exists\n')
  const logs = []
  const health = []
  let serving = mode
  let served = 0
  const server = createServer((req, res) => {
    if (!req.url.startsWith('/health')) return // never answer: a request times out
    health.push(Date.now())
    served += 1
    // `error-once` fails the bring-up probe immediately and is silent forever
    // after, which puts the supervisor into its "wait for a child we already own"
    // branch without spending a probe deadline getting there.
    if (serving === 'hang') return
    if (serving === 'error-once') {
      if (served > 1) return
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":"nope"}')
      return
    }
    if (serving === 'error') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":"nope"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true,"engine":"camoufox"}')
  })
  const engine = new CamofoxEngine({
    config: resolveConfig({
      baseUrl,
      stateDir,
      entry,
      logFile: join(stateDir, 'engine.log'),
      autostart: true,
      startTimeoutMs: 5000,
      reuseTimeoutMs: 1000,
      shutdownTimeoutMs: 500,
      healthIntervalMs: 2000,
      // The floor, so a call that the fake engine never answers costs the test
      // two seconds rather than the production default of two minutes.
      requestTimeoutMs: 2000,
      ...config,
    }),
    log: (message) => logs.push(String(message)),
  })
  const alivePids = new Set()
  const spawned = []
  const killed = []
  engine.procs.spawn = () => {
    const child = fakeChild(5000 + spawned.length)
    spawned.push(child)
    alivePids.add(child.pid)
    // Recorded before the throw: what a guard measures is how many times the
    // spawn path was ENTERED, not how many processes came out of it.
    if (spawnThrows) throw new Error('probe: a spawn was attempted')
    return child
  }
  engine.procs.alive = (pid) => alivePids.has(pid)
  engine.procs.kill = (pid) => {
    killed.push(pid)
    alivePids.delete(pid)
    return true
  }
  engine.procs.rotate = () => false
  return {
    engine,
    logs,
    health,
    spawned,
    killed,
    alivePids,
    stateDir,
    listen: async () => {
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      // The port is only known after listening, so point the engine at it.
      engine.origin = `http://127.0.0.1:${server.address().port}`
      engine.port = server.address().port
      return engine.origin
    },
    serve: (next) => {
      serving = next
    },
    close: () => server.close(),
  }
}

/**
 * Wait for a supervisor field to reach a value.
 *
 * @param {() => any} read - the field reader.
 * @param {any} value - the expected value.
 * @param {number} [timeoutMs] - budget.
 * @returns {Promise<void>} resolves once the field matches.
 */
async function waitFor(read, value, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (read() === value) return
    await sleep(25)
  }
  assert.equal(read(), value, `timed out after ${timeoutMs}ms waiting for ${value}`)
}

/**
 * Stop the periodic liveness interval so a test can drive the same check itself.
 *
 * The tick is reached through exactly the same code either way — the interval
 * only decides WHEN it runs — and leaving it armed would let a background tick
 * decide the verdict a test is trying to make itself.
 *
 * @param {CamofoxEngine} engine - the supervisor.
 */
function stopAutoTick(engine) {
  if (engine.watcher) clearInterval(engine.watcher)
  engine.watcher = null
}

test('the process primitives default to the real helpers', () => {
  // The rest of this section replaces `procs` wholesale, so nothing else would
  // notice if the defaults were quietly neutered: a stub that always returns
  // false makes every guard here pass while the plugin kills nothing.
  const engine = new CamofoxEngine({
    config: resolveConfig({ stateDir: mkdtempSync(join(tmpdir(), 'reg-procs-')), autostart: false }),
    log: () => {},
  })
  assert.equal(engine.procs.alive(process.pid), isProcessAlive(process.pid, spawnSync), 'alive() disagrees for a live pid')
  assert.equal(engine.procs.alive(999999999), isProcessAlive(999999999, spawnSync), 'alive() disagrees for a dead pid')
  assert.equal(engine.procs.alive(0), false)
  // `killProcessTree` refuses a pid it cannot act on, and `isProcessAlive` never
  // raises for one: a seam that did either would kill pid 0.
  for (const pid of [0, -1, 1.5, Number.NaN]) {
    assert.equal(engine.procs.kill(pid), false, `kill(${pid}) should refuse`)
    assert.equal(engine.procs.alive(pid), false, `alive(${pid}) should refuse`)
  }
  // Rotation must really move the file: that is the whole point of the call.
  const dir = mkdtempSync(join(tmpdir(), 'reg-rot-'))
  const logFile = join(dir, 'engine.log')
  writeFileSync(logFile, '0123456789')
  assert.equal(engine.procs.rotate(logFile, 5), true, 'a log over the budget was not rotated')
  assert.ok(existsSync(`${logFile}.1`), 'no generation was written')
  assert.equal(engine.procs.rotate(join(dir, 'missing.log'), 5), false, 'rotating a missing file reported success')
})

test('a degraded engine keeps being probed and recovers, instead of staying degraded forever', async () => {
  // `request()` sets DEGRADED after any request timeout and nothing used to move
  // it back, so one slow call on an engine that then recovered left the
  // supervisor probing nothing and reporting `degraded` for the rest of the
  // session. One miss still degrades; the next probe is what recovers.
  const fixture = supervisorFixture({ mode: 'answer' })
  await fixture.listen()
  const { engine, health, logs, spawned } = fixture
  try {
    assert.equal(await engine.ensureReady(), true, 'the fake engine was not adopted')
    stopAutoTick(engine)
    // A call that overran: the fake engine never answers a non-health route.
    await assert.rejects(() => engine.request('POST', '/tabs', {}), /did not answer within/)
    assert.equal(engine.state, 'degraded', 'the timeout did not degrade the engine')

    // Still silent: the tick must keep probing, and one miss must not be enough
    // to tear a merely slow engine down.
    fixture.serve('error')
    const before = health.length
    await engine.checkHealth()
    assert.ok(health.length > before, 'the health tick stopped probing while degraded')
    assert.equal(engine.state, 'degraded')
    assert.equal(spawned.length, 0, 'one missed probe tore the engine down')

    // It came back.
    fixture.serve('answer')
    await engine.checkHealth()
    assert.equal(engine.state, 'ready', 'the engine answered again but stayed degraded')
    assert.equal(engine.lastError, null, 'the stale error survived a recovered engine')
    assert.ok(logs.some((line) => line.includes('no longer degraded')), `the recovery was silent: ${JSON.stringify(logs)}`)
    assert.equal(engine.restarts, 0, 'recovering must not cost a restart')
  } finally {
    await engine.dispose()
    fixture.close()
  }
})

test('a wedged engine is replaced by a recovery that is counted against the restart window', async () => {
  // An engine that is alive but silent used to be neither replaced nor restarted
  // for the rest of the session. The replacement goes through `#restart`, so it
  // is charged to the rolling window — that is what makes repeated degradation
  // stop instead of looping.
  const fixture = supervisorFixture({ mode: 'answer', spawnThrows: true })
  await fixture.listen()
  const { engine, health, spawned } = fixture
  try {
    assert.equal(await engine.ensureReady(), true)
    stopAutoTick(engine)
    fixture.serve('error')
    await engine.checkHealth()
    assert.equal(engine.state, 'degraded')
    const before = health.length
    // Three ticks at once, which is what an interval that overlaps a slow probe
    // looks like: they must share ONE recovery, not each start their own.
    await Promise.all([engine.checkHealth(), engine.checkHealth(), engine.checkHealth()])
    assert.ok(health.length > before, 'the second probe never happened')

    await waitFor(() => spawned.length, 1)
    await sleep(300)
    assert.equal(engine.restarts, 1, `overlapping health ticks each charged a recovery: ${engine.restarts}`)
    assert.equal(engine.state, 'failed', 'the failed replacement was not reported')

    // And it stays at one: no amount of further degradation respawns again.
    for (let index = 0; index < 4; index += 1) await engine.checkHealth()
    assert.equal(spawned.length, 1, 'the recovery respawned on every tick')
    assert.equal(engine.restarts, 1)
  } finally {
    await engine.dispose()
    fixture.close()
  }
})

test('the restart breaker stops the recovery from respawning, and expires on its own', async () => {
  // The recovery reaches `#restart`, which is rate limited: with the limit
  // already spent it must open the breaker and attempt no spawn at all. This is
  // the guard that keeps "replace a wedged engine" from becoming a respawn
  // storm on a machine where the engine can never come back.
  const fixture = supervisorFixture({ mode: 'answer', spawnThrows: true, config: { restartLimit: 0 } })
  await fixture.listen()
  const { engine, spawned } = fixture
  try {
    assert.equal(await engine.ensureReady(), true)
    stopAutoTick(engine)
    fixture.serve('error')
    await engine.checkHealth()
    await engine.checkHealth()
    await waitFor(() => engine.state, 'failed')
    assert.equal(spawned.length, 0, 'a spawn was attempted with the breaker closed')
    assert.match(String(engine.lastError), /not (starting|started) again until/, 'the breaker was not reported')
    assert.ok(engine.status().restartsPausedUntil, 'the status tool cannot see the pause')
  } finally {
    await engine.dispose()
    fixture.close()
  }

  // The same breaker check inside `#bringUp`, which every later tool call walks
  // through: a closed breaker must refuse to spawn, and an expired one must not.
  const blocked = supervisorFixture({ mode: 'answer', spawnThrows: true })
  await blocked.listen()
  try {
    blocked.engine.breakerUntil = Date.now() + 60000
    blocked.serve('error')
    assert.equal(await blocked.engine.ensureReady(), false)
    assert.equal(blocked.spawned.length, 0, 'a spawn was attempted with the breaker closed')
    assert.equal(blocked.engine.state, 'failed')
    assert.match(String(blocked.engine.lastError), /not starting again until/)
  } finally {
    await blocked.engine.dispose()
    blocked.close()
  }
  const expired = supervisorFixture({ mode: 'answer', spawnThrows: true })
  await expired.listen()
  try {
    expired.engine.breakerUntil = Date.now() - 1
    expired.serve('error')
    assert.equal(await expired.engine.ensureReady(), false, 'an expired breaker still blocked the start')
    assert.equal(expired.spawned.length, 1, 'an expired breaker refused a start forever')
  } finally {
    await expired.engine.dispose()
    expired.close()
  }
})

test('an exit from a replaced child does not orphan the live engine', async () => {
  // `exit` belongs to the process that raised it. A replacement spawned while
  // the old one was still winding down would have its pointer cleared by this
  // handler, and from then on `dispose()` would take its "no child" branch and
  // kill nothing at all.
  const fixture = supervisorFixture({ mode: 'error' })
  await fixture.listen()
  const { engine, logs } = fixture
  try {
    // Nothing answers until the supervisor has spawned: the fake comes up only
    // because the spawn hook turns the engine on.
    const realSpawn = engine.procs.spawn
    engine.procs.spawn = (...args) => {
      fixture.serve('answer')
      return realSpawn(...args)
    }
    assert.equal(await engine.ensureReady(), true, `the fake engine never came up: ${engine.lastError}`)
    const first = engine.child
    assert.ok(first, 'no child was spawned')

    // A replacement is now the current child; the old one finally exits.
    const replacement = fakeChild(7777)
    fixture.alivePids.add(replacement.pid)
    engine.child = replacement
    first.emit('exit', 1, null)

    assert.equal(engine.child, replacement, 'the live engine was orphaned by a stale exit')
    assert.equal(engine.state, 'ready', 'a stale exit degraded a healthy engine')
    assert.equal(engine.restarts, 0, 'a stale exit triggered a restart')
    assert.equal(logs.some((line) => line.includes('exited unexpectedly')), false)
  } finally {
    await engine.dispose()
    fixture.close()
  }
})

test('an exit that cannot be logged still restarts the engine', async () => {
  // The A1 defect: a throw inside an event handler escapes the emitter as an
  // uncaught exception, and this host answers that with `process.exit(1)` — the
  // whole harness dies over a log line that would not fit. It also happens
  // before the restart call, so self-healing is silently disabled with it.
  const fixture = supervisorFixture({ mode: 'error' })
  await fixture.listen()
  const { engine, logs } = fixture
  try {
    const realSpawn = engine.procs.spawn
    engine.procs.spawn = (...args) => {
      fixture.serve('answer')
      return realSpawn(...args)
    }
    assert.equal(await engine.ensureReady(), true, `the fake engine never came up: ${engine.lastError}`)
    const child = engine.child

    // The log directory disappears under the handler's feet.
    rmSync(fixture.stateDir, { recursive: true, force: true })
    assert.throws(() => readFileSync(engine.logPath, 'utf8'), 'the log directory is still there; the guard is not testing what it claims')

    assert.doesNotThrow(() => child.emit('exit', 1, null), 'the exit handler threw out of the emitter')
    assert.ok(logs.some((line) => line.includes('could not append to the engine log')), `the failed append was silent: ${JSON.stringify(logs)}`)
    await waitFor(() => engine.restarts, 1)
    assert.equal(engine.restarts, 1, 'a log that could not be written disabled self-healing')
  } finally {
    await engine.dispose()
    fixture.close()
  }
})

test('the exit guard kills the engine tree on exit and on every signal', async () => {
  // The paths where disposal cannot run: an explicit `process.exit()`, an
  // uncaught exception, a signal. Nothing else reaps the engine there.
  const fixture = supervisorFixture({ mode: 'error' })
  const proc = new EventEmitter()
  const { engine, killed } = fixture
  try {
    engine.child = fakeChild(4242)
    const remove = engine.installExitGuard(proc)
    for (const event of ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP']) {
      killed.length = 0
      proc.emit(event)
      assert.deepEqual(killed, [4242], `${event} did not kill the engine tree`)
    }
    // And the disposer really detaches, or a disposed plugin keeps reaping.
    remove()
    killed.length = 0
    proc.emit('exit')
    proc.emit('SIGTERM')
    assert.deepEqual(killed, [], 'the exit guard was still armed after disposal')
    engine.child = null
  } finally {
    await engine.dispose()
    fixture.close()
  }
})

test('disposal releases the engine pid from this session', async () => {
  // A pid left in the session set is read by the next run as "supervised by a
  // live harness" and adopted — an orphan that outlives everyone.
  const fixture = supervisorFixture({ mode: 'error' })
  await fixture.listen()
  const { engine } = fixture
  try {
    const realSpawn = engine.procs.spawn
    engine.procs.spawn = (...args) => {
      fixture.serve('answer')
      return realSpawn(...args)
    }
    assert.equal(await engine.ensureReady(), true, `the fake engine never came up: ${engine.lastError}`)
    const pid = engine.child.pid
    assert.equal(isSessionPid(pid), true, 'the spawned pid was never claimed')
    await engine.dispose()
    assert.equal(isSessionPid(pid), false, 'the pid was still claimed after disposal')
    assert.equal(engine.state, 'stopped')
    // Repeated disposal is still a no-op.
    await engine.dispose()
    assert.equal(engine.state, 'stopped')
  } finally {
    fixture.close()
  }
})

test('replacing a wedged engine releases its pid, and a survivor keeps a record', async () => {
  // Two defects, one path. The pid must be released whether or not the kill
  // landed, and when it did not land the process must not vanish from every
  // record at once: `this.child` is dropped, the session set is cleared and the
  // next spawn overwrites the lock file with a different pid.
  const fixture = supervisorFixture({ mode: 'error', config: { reuseTimeoutMs: 1000 } })
  await fixture.listen()
  const { engine } = fixture
  try {
    const realSpawn = engine.procs.spawn
    engine.procs.spawn = (...args) => {
      fixture.serve('answer')
      return realSpawn(...args)
    }
    assert.equal(await engine.ensureReady(), true, `the fake engine never came up: ${engine.lastError}`)
    const wedged = engine.child.pid
    assert.equal(isSessionPid(wedged), true)

    // The engine goes silent but stays alive: a tree kill that does not work.
    fixture.serve('error')
    fixture.alivePids.add(wedged)
    engine.procs.kill = (pid) => {
      fixture.killed.push(pid)
      return true // reported as sent, and confirmed by nobody
    }

    assert.equal(await engine.ensureReady(), false, 'a wedged engine reported ready')
    assert.equal(engine.state, 'failed', 'the survivor was not reported')
    assert.match(String(engine.lastError), /survived the tree kill/, `the survivor was silent: ${engine.lastError}`)
    assert.equal(isSessionPid(wedged), false, 'the abandoned pid is still claimed by this session')
    assert.equal(engine.child, null)
    // No replacement may be started over a process that is still holding the port.
    assert.equal(fixture.spawned.length, 1, `a replacement was spawned over the survivor: ${fixture.spawned.length} spawns`)
    // And the record outlives this process.
    assert.equal(engine.orphanPid, wedged)
    assert.equal(engine.status().orphanPid, wedged, 'the status tool cannot see the survivor')
    assert.ok(existsSync(engine.orphanPath), 'no orphan record was written')
    const record = JSON.parse(readFileSync(engine.orphanPath, 'utf8'))
    assert.equal(record.pid, wedged)
    assert.equal(record.ownerPid, process.pid)
    assert.equal(record.owner, 'dsh-camofox')
    assert.equal(record.port, engine.port)
    assert.ok(String(record.reason).length > 0, 'the record does not say why')
  } finally {
    await engine.dispose()
    fixture.close()
  }
})

test('a survivor recorded after disposal still reports stopped', async () => {
  // `#aborted()` is the only thing keeping an in-flight start from writing its
  // own verdict over the one `dispose()` already published. It has to be
  // observable: the abandoned engine is discovered here AFTER teardown landed,
  // which is exactly when the start attempt writes `failed` — a state describing
  // a process this harness has already let go of.
  const fixture = supervisorFixture({ mode: 'error', config: { reuseTimeoutMs: 1000 } })
  await fixture.listen()
  const { engine } = fixture
  try {
    const realSpawn = engine.procs.spawn
    engine.procs.spawn = (...args) => {
      fixture.serve('answer')
      return realSpawn(...args)
    }
    assert.equal(await engine.ensureReady(), true, `the fake engine never came up: ${engine.lastError}`)
    const wedged = engine.child.pid

    // The engine goes silent, and disposal lands while the tree kill is in
    // flight — the survivor is only discovered after teardown.
    fixture.serve('error')
    fixture.alivePids.add(wedged)
    engine.procs.kill = (pid) => {
      fixture.killed.push(pid)
      void engine.dispose()
      return true
    }

    assert.equal(await engine.ensureReady(), false)
    assert.equal(engine.state, 'stopped', `an in-flight start overwrote the stopped state: ${engine.lastError}`)
    assert.equal(engine.orphanPid, wedged, 'the survivor lost its record')
    assert.ok(existsSync(engine.orphanPath), 'no orphan record was written')
    const record = JSON.parse(readFileSync(engine.orphanPath, 'utf8'))
    assert.equal(record.pid, wedged)
    assert.equal(engine.restarts, 1, 'the abandoned engine was not charged to the restart window')
  } finally {
    await engine.dispose()
    fixture.close()
  }
})

test('an abandoned engine is reaped by the next bring-up, not adopted', async () => {
  // The record is only worth writing if somebody reads it. A wedged engine never
  // answers `/health`, so waiting for the probe that proves it is gone would
  // leave it holding the port the replacement needs.
  const fixture = supervisorFixture({ mode: 'answer' })
  await fixture.listen()
  const { engine } = fixture
  try {
    const survivor = 6161
    fixture.alivePids.add(survivor)
    mkdirSync(fixture.stateDir, { recursive: true })
    writeFileSync(
      engine.orphanPath,
      JSON.stringify({ pid: survivor, ownerPid: process.pid, port: engine.port, baseUrl: engine.origin, recordedAt: Date.now(), reason: 'survived a tree kill', owner: 'dsh-camofox' }, null, 2),
      'utf8',
    )

    assert.equal(await engine.ensureReady(), true)
    assert.deepEqual(fixture.killed, [survivor], 'the recorded survivor was never terminated')
    assert.equal(existsSync(engine.orphanPath), false, 'the orphan record outlived the process it named')
    assert.equal(fixture.alivePids.has(survivor), false)

    // A record naming a process that is already gone is simply cleared.
    fixture.alivePids.add(4242)
    writeFileSync(engine.orphanPath, JSON.stringify({ pid: 4242, ownerPid: 999999, port: 1, owner: 'dsh-camofox' }), 'utf8')
    engine.dispose()
    const second = supervisorFixture({ mode: 'answer' })
    second.engine.orphanPid = null
    const gone = 5252
    writeFileSync(
      second.engine.orphanPath,
      JSON.stringify({ pid: gone, ownerPid: 999999, port: 1, baseUrl: 'http://127.0.0.1:1', recordedAt: 0, reason: 'gone', owner: 'dsh-camofox' }),
      'utf8',
    )
    await second.listen()
    await second.engine.ensureReady()
    assert.equal(second.spawned.length, 0)
    assert.equal(existsSync(second.engine.orphanPath), false, 'a record naming a dead pid was kept')
    assert.equal(second.engine.state, 'ready')
    await second.engine.dispose()
    second.close()
  } finally {
    await engine.dispose()
    fixture.close()
  }
})

test('disposal gives an abandoned engine one more kill and keeps its record if it survives', async () => {
  // Disposal cannot reach a survivor — it is not `this.child` any more — but it
  // is still the last code in this process that runs, so it gets one attempt. The
  // record is deleted only once the process is actually gone.
  const fixture = supervisorFixture({ mode: 'answer' })
  await fixture.listen()
  const { engine } = fixture
  const survivor = 7373
  try {
    fixture.alivePids.add(survivor)
    engine.orphanPid = survivor
    mkdirSync(fixture.stateDir, { recursive: true })
    writeFileSync(engine.orphanPath, JSON.stringify({ pid: survivor, ownerPid: process.pid, port: engine.port, reason: 'survived', owner: 'dsh-camofox' }), 'utf8')
    engine.procs.kill = (pid) => {
      fixture.killed.push(pid)
      return true // reported as sent, and honoured by nobody
    }

    await engine.dispose()
    assert.deepEqual(fixture.killed, [survivor], 'disposal did not try to reap the survivor')
    assert.ok(existsSync(engine.orphanPath), 'the record of a live process was deleted')
    assert.equal(engine.orphanPid, survivor)
    assert.equal(engine.state, 'stopped')

    // The second attempt lands: then the record goes, because there is nothing
    // left for the next run to reap.
    fixture.alivePids.delete(survivor)
    const second = supervisorFixture({ mode: 'answer' })
    await second.listen()
    second.engine.procs.alive = (pid) => fixture.alivePids.has(pid)
    second.engine.procs.kill = (pid) => {
      fixture.killed.push(pid)
      fixture.alivePids.delete(pid)
      return true
    }
    writeFileSync(second.engine.orphanPath, JSON.stringify({ pid: survivor, ownerPid: process.pid, port: second.engine.port, reason: 'survived', owner: 'dsh-camofox' }), 'utf8')
    await second.engine.dispose()
    assert.equal(existsSync(second.engine.orphanPath), false, 'a reaped process kept its record')
    second.close()
  } finally {
    fixture.close()
  }
})

test('the readiness poll ends at dispose instead of outliving it by minutes', async () => {
  // `sleep()` and `withDeadline()` use ref'd timers, so a poll that ignored
  // teardown kept the host process alive for the rest of the readiness budget —
  // long after `dispose()` returned and the plugin looked shut down.
  const fixture = supervisorFixture({ mode: 'hang', config: { startTimeoutMs: 12000, reuseTimeoutMs: 12000 } })
  await fixture.listen()
  const { engine, health } = fixture
  try {
    // A live child we already own, so the bring-up WAITS for it instead of
    // spawning. That is the one shape where the poll has no spawn-failure race
    // wired to the shutdown signal, so `this.stopped` is the only thing that can
    // end it — exactly the guard under test.
    engine.child = fakeChild(6162)
    fixture.alivePids.add(6162)
    const started = engine.ensureReady()

    // Probe 1 is the bring-up probe; probe 2 only exists inside the readiness
    // poll, so this waits for the poll itself and not for the start.
    await waitFor(() => health.length, 2)
    await waitFor(() => engine.state, 'starting')

    fixture.alivePids.delete(6162)
    const mark = Date.now()
    await engine.dispose()
    // Every request the fake engine received after that instant: a poll that
    // ignored teardown starts another one as soon as the current probe returns.
    const afterDispose = health.filter((at) => at > mark).length
    await started
    const elapsed = Date.now() - mark

    assert.equal(afterDispose, 0, 'the readiness poll kept probing after disposal')
    assert.ok(elapsed < 5000, `the in-flight start took ${elapsed}ms to notice disposal`)
    assert.equal(engine.state, 'stopped', 'the aborted start did not report stopped')
  } finally {
    await engine.dispose()
    fixture.close()
  }
})

test('an immediate-exit verdict is never written after disposal', async () => {
  // `#detectImmediateExit` sleeps before it judges. A child that really died in
  // that window would leave the status tool blaming a process this harness has
  // already let go of — and the supervisor reporting `failed` while stopped.
  const fixture = supervisorFixture({ mode: 'error-once' })
  await fixture.listen()
  const { engine, logs } = fixture
  try {
    // A live child we already own, so the bring-up waits for it instead of
    // spawning, and it "dies" while that wait is in progress.
    engine.child = fakeChild(6161)
    fixture.alivePids.add(6161)
    const started = engine.ensureReady()

    // Probe 1 is the bring-up probe; once it has been answered the supervisor is
    // inside `#detectImmediateExit`'s wait, and disposal lands during it.
    await waitFor(() => fixture.health.length, 1)
    await sleep(250)
    engine.exited = true
    engine.child = null
    fixture.alivePids.delete(6161)
    await engine.dispose()
    await started

    assert.equal(engine.state, 'stopped', `an exit verdict overwrote the stopped state: ${engine.lastError}`)
    assert.equal(logs.some((line) => line.includes('exited immediately without serving anything')), false)
  } finally {
    await engine.dispose()
    fixture.close()
  }
})

test('a log rotation that throws never costs the liveness check', async () => {
  // Rotation shares the health tick with the probe. It is best-effort by
  // contract, so losing it must cost the rotation and nothing else — and the
  // tick runs from an interval callback, where a throw is an uncaught exception.
  const fixture = supervisorFixture({ mode: 'answer' })
  await fixture.listen()
  const { engine, health, logs } = fixture
  try {
    assert.equal(await engine.ensureReady(), true)
    engine.procs.rotate = () => {
      throw new Error('EPERM: the log is held open')
    }
    const before = health.length
    await engine.checkHealth()
    assert.ok(health.length > before, 'a failed rotation stopped the health probe')
    assert.ok(logs.some((line) => line.includes('could not rotate the engine log')), `the rotation failure was silent: ${JSON.stringify(logs)}`)
    assert.equal(engine.state, 'ready')
  } finally {
    await engine.dispose()
    fixture.close()
  }
})
