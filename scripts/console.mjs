/**
 * Hermetic suite for the browser console-capture engine plugin.
 *
 * `src/console-capture.js` does not export a capture function — it exports the
 * SOURCE of an engine-side plugin. Asserting on that string cannot tell a
 * correct listener body from a plausible one, so the real work here is done the
 * same way `scripts/addons.mjs` does it: write the generated module into a
 * throwaway engine checkout, import it, and drive `register(app, ctx)` with a
 * fake Express app and a fake plugin context. Everything below therefore
 * exercises the code that actually runs inside the engine process.
 *
 * The fakes are deliberately thin. The plugin only ever calls `page.on(...)`,
 * `ctx.events.on(...)`, `ctx.auth()`, `ctx.log(...)` and `app.get(...)`, so a
 * Node `EventEmitter` is a faithful stand-in for a Playwright `page` and a
 * `Map`-backed object is a faithful stand-in for the engine event bus.
 *
 * What is being guarded, in one line each: the capture is useless if it records
 * the wrong kinds of failure, useless in practice if it also records everything
 * else, and actively harmful in a long-lived engine if its buffers are
 * unbounded.
 *
 * Run with: `node scripts/console.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CONSOLE_PLUGIN_NAME, GENERATED_CONSOLE_MARKER, consolePluginSource } from '../src/console-capture.js'
import { writeEnginePlugin } from '../src/addons.js'
import { registerTools } from '../src/tools.js'

/**
 * A throwaway engine checkout, written the way `src/index.js` writes it.
 *
 * Using the real `writeEnginePlugin` rather than a bare `writeFileSync` means
 * the file under test is byte-for-byte what the engine would load, and the
 * installer path itself stays covered by this suite.
 *
 * @param {{ maxEntries?: number, maxText?: number }} [limits] - bounds to bake in.
 * @returns {{ root: string, pluginPath: string, cleanup: () => void }} the checkout.
 */
function consoleCheckout(limits = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-console-'))
  mkdirSync(join(root, 'plugins'), { recursive: true })
  writeFileSync(
    join(root, 'camofox.config.json'),
    `${JSON.stringify({ id: 'dsh-console-test', plugins: {} }, null, 2)}\n`,
    'utf-8',
  )
  const pluginPath = join(root, 'plugins', CONSOLE_PLUGIN_NAME, 'index.js')
  const written = writeEnginePlugin(
    root,
    CONSOLE_PLUGIN_NAME,
    () => consolePluginSource({ maxEntries: limits.maxEntries, maxText: limits.maxText }),
    GENERATED_CONSOLE_MARKER,
  )
  assert.equal(written.installed, true, written.reason)
  return { root, pluginPath, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * A plugin context that records what the generated plugin would do.
 *
 * `auth()` returns a middleware so a test can prove the route was registered
 * BEHIND it: the middleware is a distinct function object from the handler, so
 * its presence in the handler list is not something the handler can fake.
 *
 * @param {Array<{ level: string, msg: string }>} [logs] - collected log lines.
 */
function fakeCtx(logs = []) {
  const listeners = {}
  return {
    logs,
    listeners,
    log: (level, msg) => logs.push({ level, msg }),
    auth: () => { const middleware = (req, res, next) => next(); middleware.__isAuth = true; return middleware },
    events: {
      on(name, fn) { listeners[name] = fn },
      listeners,
    },
    /** Fire a collected engine event, the way the engine does. */
    emit(name, payload) {
      assert.equal(typeof listeners[name], 'function', `no listener registered for ${name}`)
      return listeners[name](payload)
    },
  }
}

/** The slice of the Express app the generated plugin touches. */
function fakeApp() {
  const routes = []
  return {
    routes,
    get(path, ...handlers) {
      assert.equal(typeof handlers[handlers.length - 1], 'function', `${path} has no handler`)
      routes.push({ path, handlers })
      return this
    },
  }
}

/**
 * Mount the generated plugin and return everything a test needs to drive it.
 *
 * @param {{ maxEntries?: number, maxText?: number }} [limits] - bounds to bake in.
 * @returns {Promise<object>} the fixture; `cleanup()` removes the temp checkout.
 */
async function mountGenerated(limits = {}) {
  const repo = consoleCheckout(limits)
  const ctx = fakeCtx()
  const app = fakeApp()
  let register
  try {
    const mod = await import(pathToFileURL(repo.pluginPath).href)
    register = mod.register ?? mod.default
    assert.equal(typeof register, 'function', 'the generated module exports no register')
    await register(app, ctx)
  } catch (error) {
    repo.cleanup()
    throw error
  }
  return {
    ...repo,
    app,
    ctx,
    register,
    /** A fresh tab whose `page` is an EventEmitter. */
    openTab(userId = 'dsh', tabId = 'tab-1') {
      const page = new EventEmitter()
      page.mainFrame = () => page
      const events = []
      for (const call of ['on', 'once']) {
        const original = page[call].bind(page)
        page[call] = (event, fn) => { events.push(event); return original(event, fn) }
      }
      ctx.emit('tab:created', { userId, tabId, page })
      return { page, events }
    },
    /** Call the registered GET route and return the JSON body it produced. */
    async call(userId, query = {}) {
      const route = app.routes.find((r) => r.path === '/dsh-console/:userId')
      assert.ok(route, 'the console route was not registered')
      let body
      const res = { json: (value) => { body = value } }
      route.handlers[route.handlers.length - 1]({ params: { userId }, query }, res)
      return body
    },
  }
}

/**
 * A console message with only the surface the capture plugin calls.
 *
 * @param {{ type?: string, text?: string, args?: any[], location?: object }} spec - the message.
 */
function consoleMessage(spec = {}) {
  return {
    type: () => spec.type ?? 'error',
    text: () => spec.text ?? '',
    args: () => spec.args ?? [],
    location: () => spec.location ?? { url: 'https://example.com/app.js', lineNumber: 10, columnNumber: 4 },
  }
}

/** A JSHandle-like argument whose own toString is what Playwright really gives. */
function handleArg(properties) {
  return {
    toString: () => 'JSHandle@object',
    preview: () => ({ previewProperties: properties.map(({ name, value }) => ({ name, value })) }),
  }
}

/** Every entry the plugin currently holds for a tab. */
async function entriesOf(fixture, userId = 'dsh') {
  const body = await fixture.call(userId)
  return body.tabs.flatMap((tab) => tab.entries)
}

test('the console plugin names itself with the marker it writes', () => {
  // The installer refuses to overwrite a file that does not start with the
  // marker, so a rename on either side turns every activation into a silent
  // "NOT installed" log rather than an error.
  assert.equal(CONSOLE_PLUGIN_NAME, 'dsh-console')
  assert.equal(GENERATED_CONSOLE_MARKER, '// Generated by dsh-camofox. Do not edit; it is rewritten on activation.')
  const source = consolePluginSource({ maxEntries: 200, maxText: 2000 })
  assert.equal(source.split('\n')[0], GENERATED_CONSOLE_MARKER)
})

test('consolePluginSource bakes the caller limits into the emitted numbers', () => {
  // The limits exist only as literals inside the generated text, so a source
  // that forgot to interpolate one would still parse and still run — it would
  // just silently use the fallback for a bound the operator configured.
  const source = consolePluginSource({ maxEntries: 50, maxText: 2000 })
  assert.match(source, /const MAX_ENTRIES = 50\b/, 'maxEntries was not baked in')
  assert.match(source, /const MAX_TEXT = 2000\b/, 'maxText was not baked in')
  // The word "undefined" occurs legitimately further down (render() handles an
  // undefined argument), so what is pinned is that neither BOUND is broken.
  assert.doesNotMatch(source, /const MAX_(?:ENTRIES|TEXT) = (?:NaN|undefined)\b/)
})

test('consolePluginSource survives a missing argument and falls back to its defaults', () => {
  // The bounds are interpolated straight into the generated source, so a caller
  // that omits them must get the defaults rather than a TypeError from the
  // destructuring itself. That hole existed once: the parameter had no default,
  // so the very input the `Number(x) || default` guards were written to survive
  // threw before reaching them.
  const source = consolePluginSource()
  assert.match(source, /const MAX_ENTRIES = 200\b/)
  assert.match(source, /const MAX_TEXT = 2000\b/)
  assert.doesNotMatch(source, /const MAX_(?:ENTRIES|TEXT) = (?:NaN|undefined)\b/)
})

test('consolePluginSource refuses to emit a broken number for junk limits', () => {
  // `Number(maxEntries) || 200` is a real guard, not decoration: every one of
  // these would otherwise be interpolated as the literal `NaN` into the engine
  // plugin, where `entries.length > NaN` is always false and the buffer stops
  // trimming entirely — an unbounded capture with no visible error.
  for (const junk of [{}, { maxEntries: 'x' }, { maxEntries: NaN }, { maxEntries: null }, { maxText: 'y' }, { maxText: undefined }]) {
    const source = consolePluginSource(junk)
    const entries = /const MAX_ENTRIES = ([^\n]+)/.exec(source)
    const text = /const MAX_TEXT = ([^\n]+)/.exec(source)
    assert.ok(entries, 'MAX_ENTRIES is missing from the generated source')
    assert.ok(text, 'MAX_TEXT is missing from the generated source')
    assert.equal(Number.isFinite(Number(entries[1])) && Number(entries[1]) > 0, true, `junk ${JSON.stringify(junk)} emitted MAX_ENTRIES = ${entries[1]}`)
    assert.equal(Number.isFinite(Number(text[1])) && Number(text[1]) > 0, true, `junk ${JSON.stringify(junk)} emitted MAX_TEXT = ${text[1]}`)
  }

  // A valid limit beside an invalid one is still honoured: the fallback is
  // per-field, not a wholesale replacement of the caller's config.
  const mixed = consolePluginSource({ maxEntries: 7, maxText: 'y' })
  assert.match(mixed, /const MAX_ENTRIES = 7\b/)
  assert.match(mixed, /const MAX_TEXT = 2000\b/)
})

test('the generated plugin attaches every page listener the capture depends on', async () => {
  // A missing listener is a whole class of failure that never reaches the
  // console: an uncaught exception in particular never emits `console` at all.
  const fixture = await mountGenerated()
  try {
    const { events } = fixture.openTab()
    for (const name of ['console', 'pageerror', 'requestfailed', 'response', 'framenavigated']) {
      assert.ok(events.includes(name), `the plugin never subscribed to ${name}`)
    }
  } finally {
    fixture.cleanup()
  }
})

test('a console error is captured and a console log is not', async () => {
  // Capturing `log`/`info` is the difference between a report an agent reads and
  // a report buried under a page's per-render chatter. This is deliberate.
  const fixture = await mountGenerated()
  try {
    const { page } = fixture.openTab()
    page.emit('console', consoleMessage({ type: 'error', text: 'TypeError: x is not a function' }))
    page.emit('console', consoleMessage({ type: 'log', text: 'rendering 42' }))
    page.emit('console', consoleMessage({ type: 'info', text: 'mounted' }))

    const entries = await entriesOf(fixture)
    assert.equal(entries.length, 1, JSON.stringify(entries))
    assert.equal(entries[0].kind, 'error')
    assert.equal(entries[0].text, 'TypeError: x is not a function')
    // The source location is what turns "something broke" into "here is where".
    assert.equal(entries[0].location.url, 'https://example.com/app.js')
    assert.equal(entries[0].location.line, 10)
  } finally {
    fixture.cleanup()
  }
})

test('a console message with empty text falls back to its arguments', async () => {
  // Playwright's `text()` is empty for an object argument, and `args()` hands
  // over a JSHandle whose own toString is the literal "JSHandle@object". Without
  // the preview fallback the most informative console.error in a page — one that
  // logs the object that was wrong — would be captured as a useless string.
  const fixture = await mountGenerated()
  try {
    const { page } = fixture.openTab()
    page.emit('console', consoleMessage({
      type: 'error',
      text: '',
      args: ['state was', handleArg([{ name: 'status', value: 'failed' }, { name: 'code', value: 500 }])],
    }))

    const entries = await entriesOf(fixture)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].text, 'state was {status: failed, code: 500}')
    assert.equal(entries[0].text.includes('JSHandle@object'), false, 'the JSHandle placeholder leaked into the report')
  } finally {
    fixture.cleanup()
  }
})

test('an uncaught exception is captured with its stack', async () => {
  // `pageerror` is the one event a page's own try/catch cannot suppress and the
  // one most often missed, because it never surfaces as a console message.
  const fixture = await mountGenerated()
  try {
    const { page } = fixture.openTab()
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at render (https://example.com/app.js:10:4)'
    page.emit('pageerror', error)

    const entries = await entriesOf(fixture)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].kind, 'pageerror')
    assert.equal(entries[0].text, error.stack)
  } finally {
    fixture.cleanup()
  }
})

test('only failing HTTP responses are captured', async () => {
  // 200 and 301 are the overwhelming majority of responses in a page load; if
  // they were recorded, the real 404 would be unreachable in the buffer.
  const fixture = await mountGenerated()
  try {
    const { page } = fixture.openTab()
    const respond = (status) => page.emit('response', {
      status: () => status,
      url: () => 'https://example.com/api',
      request: () => ({ method: () => 'GET' }),
    })
    respond(200)
    respond(301)
    respond(404)

    const entries = await entriesOf(fixture)
    assert.equal(entries.length, 1, JSON.stringify(entries))
    assert.equal(entries[0].kind, 'http')
    assert.equal(entries[0].status, 404)
    assert.equal(entries[0].url, 'https://example.com/api')
  } finally {
    fixture.cleanup()
  }
})

test('a self-cancelled request is dropped and a genuine failure is kept', async () => {
  // Every click aborts in-flight requests, so ERR_ABORTED is not a failure at
  // all — recording it buries the one request that actually failed.
  const fixture = await mountGenerated()
  try {
    const { page } = fixture.openTab()
    const fail = (errorText) => page.emit('requestfailed', {
      failure: () => ({ errorText }),
      url: () => 'https://third-party.example/track.js',
      method: () => 'GET',
      resourceType: () => 'script',
    })
    fail('net::ERR_ABORTED')
    fail('net::ERR_CONNECTION_REFUSED')

    const entries = await entriesOf(fixture)
    assert.equal(entries.length, 1, JSON.stringify(entries))
    assert.equal(entries[0].kind, 'requestfailed')
    assert.equal(entries[0].text, 'net::ERR_CONNECTION_REFUSED')
  } finally {
    fixture.cleanup()
  }
})

test('the per-tab buffer drops its oldest entries past the limit', async () => {
  // A page in a render loop produces errors faster than an agent can read them.
  // Without the bound, one bad tab is a memory leak in a long-lived engine.
  const fixture = await mountGenerated({ maxEntries: 5, maxText: 2000 })
  try {
    const { page } = fixture.openTab()
    for (let i = 0; i < 12; i += 1) page.emit('console', consoleMessage({ type: 'error', text: `error ${i}` }))

    const entries = await entriesOf(fixture)
    assert.equal(entries.length, 5, JSON.stringify(entries.map((e) => e.text)))
    // The most recent ones survive: an error report is only useful if it ends
    // with the error that is still happening.
    assert.equal(entries.at(-1).text, 'error 11')
    assert.equal(entries[0].text, 'error 7')
  } finally {
    fixture.cleanup()
  }
})

test('one runaway source cannot evict the first exception that explains it', async () => {
  // An error loop produces thousands of identical exceptions per second. If they
  // went into the shared ring buffer, the first one — the one that names the
  // cause — would be evicted by its own repetitions within a second.
  const fixture = await mountGenerated({ maxEntries: 2000, maxText: 2000 })
  try {
    const { page } = fixture.openTab()
    const first = new Error('root cause')
    first.stack = 'Error: root cause\n    at boot (https://example.com/app.js:1:1)'
    page.emit('pageerror', first)
    for (let i = 0; i < 200; i += 1) {
      const repeat = new Error(`loop ${i}`)
      repeat.stack = `Error: loop ${i}\n    at tick (https://example.com/app.js:2:1)`
      page.emit('pageerror', repeat)
    }

    const entries = await entriesOf(fixture)
    // The cap is 40 in the generated source; the buffer bound is deliberately far
    // higher so it cannot be what stopped the recording.
    assert.equal(entries.length, 40, `captured ${entries.length} entries`)
    assert.equal(entries[0].text, first.stack, 'the first exception was evicted by its own repetitions')
  } finally {
    fixture.cleanup()
  }
})

test('captured text is truncated to the configured limit', async () => {
  // A single minified bundle can throw a megabyte of source text; the report is
  // rendered into a model context and the buffer is bounded, not just trimmed.
  const fixture = await mountGenerated({ maxEntries: 200, maxText: 64 })
  try {
    const { page } = fixture.openTab()
    page.emit('console', consoleMessage({ type: 'error', text: 'E'.repeat(5000) }))

    const entries = await entriesOf(fixture)
    assert.equal(entries.length, 1)
    assert.ok(entries[0].text.length <= 64 + '…[truncated]'.length, `text was ${entries[0].text.length} chars`)
    assert.ok(entries[0].text.endsWith('…[truncated]'), 'truncation is not marked')
    assert.equal(entries[0].text.startsWith('E'.repeat(64)), true)
  } finally {
    fixture.cleanup()
  }
})

test('a destroyed tab drops its entries and leaves other tabs alone', async () => {
  // A closed tab's page is gone; keeping its entries leaks and misattributes.
  const fixture = await mountGenerated()
  try {
    const kept = fixture.openTab('dsh', 'tab-keep')
    const closed = fixture.openTab('dsh', 'tab-close')
    kept.page.emit('console', consoleMessage({ type: 'error', text: 'kept' }))
    closed.page.emit('console', consoleMessage({ type: 'error', text: 'closed' }))
    assert.equal((await entriesOf(fixture)).length, 2)

    fixture.ctx.emit('tab:destroyed', { userId: 'dsh', tabId: 'tab-close' })

    const entries = await entriesOf(fixture)
    assert.equal(entries.length, 1, JSON.stringify(entries))
    assert.equal(entries[0].text, 'kept')
  } finally {
    fixture.cleanup()
  }
})

test('a destroyed session drops every one of its tabs', async () => {
  // The scope is the privacy boundary: one session's entries must never reach
  // another session's report.
  const fixture = await mountGenerated()
  try {
    const a = fixture.openTab('session-a', 'tab-1')
    const b = fixture.openTab('session-a', 'tab-2')
    const other = fixture.openTab('session-b', 'tab-1')
    a.page.emit('console', consoleMessage({ type: 'error', text: 'a1' }))
    b.page.emit('console', consoleMessage({ type: 'error', text: 'a2' }))
    other.page.emit('console', consoleMessage({ type: 'error', text: 'b1' }))

    fixture.ctx.emit('session:destroyed', { userId: 'session-a' })

    assert.deepEqual((await entriesOf(fixture, 'session-a')).map((e) => e.text), [])
    assert.deepEqual((await entriesOf(fixture, 'session-b')).map((e) => e.text), ['b1'])
  } finally {
    fixture.cleanup()
  }
})

test('the console route is registered behind ctx.auth()', async () => {
  // The report is a list of every failed URL the session touched. Unauthenticated,
  // it would be an open index of what a user was looking at.
  const fixture = await mountGenerated()
  try {
    const route = fixture.app.routes.find((r) => r.path === '/dsh-console/:userId')
    assert.ok(route, 'the console route was not registered')
    assert.equal(route.handlers.length, 2, 'the route is not auth + handler')
    assert.equal(route.handlers[0].__isAuth, true, 'the route is registered without the auth middleware')
  } finally {
    fixture.cleanup()
  }
})

test('the console route reports nothing for a session with no captured data', async () => {
  // A fresh session must produce a well-formed empty report, not a 404 or a
  // crash: this is what the tool renders when a page looks fine.
  const fixture = await mountGenerated()
  try {
    const body = await fixture.call('dsh')
    assert.deepEqual(body.tabs, [])
    assert.equal(body.total, 0)
  } finally {
    fixture.cleanup()
  }
})

test('minSeverity=error drops console warnings and minSeverity=warning keeps them', async () => {
  // `warning` is the default because a console.warn is usually the first sign of
  // a real failure; `error` is what a caller passes when it wants only the
  // unambiguous failures. Getting the mapping backwards would either hide every
  // exception or bury them under warnings.
  const fixture = await mountGenerated()
  try {
    const { page } = fixture.openTab()
    page.emit('console', consoleMessage({ type: 'warning', text: 'deprecated api' }))
    page.emit('console', consoleMessage({ type: 'error', text: 'it broke' }))
    const exception = new Error('uncaught')
    exception.stack = 'Error: uncaught\n    at boot (https://example.com/app.js:1:1)'
    page.emit('pageerror', exception)

    const strict = await fixture.call('dsh', { minSeverity: 'error' })
    assert.deepEqual(strict.tabs.flatMap((t) => t.entries).map((e) => e.text), ['it broke', exception.stack])
    assert.equal(strict.counts.warning, undefined)

    const loose = await fixture.call('dsh', { minSeverity: 'warning' })
    assert.deepEqual(loose.tabs.flatMap((t) => t.entries).map((e) => e.kind), ['warning', 'error', 'pageerror'])
    assert.equal(loose.total, 3)
    assert.equal(loose.counts.warning, 1)
  } finally {
    fixture.cleanup()
  }
})

test('camofox_console declares the arguments its schema promises', async () => {
  // Deliberately light: executing the tool needs the stub engine in
  // `scripts/tools.mjs`, which has no `/dsh-console/...` route. What is checked
  // here is only what can be true without one — a parameter that is documented
  // but not declared is silently ignored by the model, and a missing deadline
  // hangs the call.
  const registry = new Map()
  const ctx = { get: () => undefined, tools: { register: (definition) => registry.set(definition.name, definition) } }
  registerTools(ctx, { config: { allowEvaluate: false } }, { allowEvaluate: false })

  const definition = registry.get('camofox_console')
  assert.ok(definition, 'camofox_console is not registered')
  const properties = definition.parameters.properties
  assert.ok(properties.tabId, 'no tabId')
  assert.ok(properties.minSeverity, 'no minSeverity')
  assert.deepEqual(properties.minSeverity.enum, ['error', 'warning'])
  assert.ok(properties.limit, 'no limit')
  assert.equal(properties.limit.type, 'number')
  assert.ok(Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0, `timeoutMs was ${definition.timeoutMs}`)
})