/**
 * Hermetic tool-level suite for dsh-camofox.
 *
 * Every one of the eleven tools is mounted on a fake registry and executed
 * against a stub engine: no browser, no network, no camofox checkout. This is
 * the layer that catches the defects a syntax check cannot — a tool body that
 * calls the bridge with the wrong receiver, a result whose paging fields are
 * pushed past the render budget, an error whose identity is lost, a budget that
 * deletes an image attachment.
 *
 * The stub answers the engine's real response shapes, so a change that breaks
 * the contract with `camofox-browser` fails here rather than in a browser.
 *
 * Run with: `node scripts/tools.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerTools, navigationFields, searchProvenance } from '../src/tools.js'
import { CamofoxBridge } from '../src/bridge.js'
import { resolveScope, sanitizeKey } from '../src/scope.js'
import { EngineError, resolveConfig } from '../src/engine.js'

/** Routes the stub answers, keyed by `METHOD /path`. */
const ROUTES = {
  // The engine-wide counters camofox_status reports. `consecutiveFailures: 0`
  // is deliberate: it is the state in which the line must be OMITTED, so a stub
  // that always answered with a number could not catch a regression that
  // printed "engine failures: 0 consecutive" on a perfectly healthy engine.
  'GET /health': {
    ok: true,
    engine: 'camofox',
    browserRunning: true,
    browserConnected: true,
    activeTabs: 3,
    activeSessions: 2,
    consecutiveFailures: 0,
    memory: { rssMb: 185 },
  },
  'GET /tabs': { running: true, tabs: [{ tabId: 'tab-1', url: 'https://example.com/', title: 'Example' }] },
  'POST /tabs': { tabId: 'tab-1', url: 'https://example.com/', title: 'Example' },
  'GET /tabs/tab-1': { tabId: 'tab-1', url: 'https://example.com/', title: 'Example' },
  'GET /tabs/tab-1/snapshot': {
    url: 'https://example.com/',
    snapshot: 'x'.repeat(500),
    refsCount: 3,
    truncated: false,
    totalChars: 500,
  },
  'GET /tabs/tab-1/links': {
    links: [
      { url: 'https://example.com/a', text: 'A' },
      { url: 'https://example.com/b', text: 'B' },
    ],
    pagination: { total: 2, offset: 0, limit: 200, hasMore: false },
  },
  'GET /tabs/tab-1/images': { tabId: 'tab-1', images: [{ src: 'https://example.com/i.png', alt: 'I' }] },
  'GET /tabs/tab-1/stats': {
    tabId: 'tab-1',
    sessionKey: 'default',
    url: 'https://example.com/',
    visitedUrls: Array.from({ length: 400 }, (_value, index) => `https://example.com/p${index}`),
    downloadsCount: 0,
    toolCalls: 4,
    refsCount: 3,
  },
  'GET /tabs/tab-1/screenshot': Buffer.from('89504e470d0a1a0a', 'hex'),
  'POST /tabs/tab-1/click': { ok: true, clicked: 'e1' },
  'POST /tabs/tab-1/type': { ok: true },
  'POST /tabs/tab-1/select': { ok: true },
  'POST /tabs/tab-1/press': { ok: true },
  'POST /tabs/tab-1/scroll': { ok: true },
  'POST /tabs/tab-1/wait': { ok: true },
  'POST /tabs/tab-1/evaluate': (body) => {
    // The mirror harvest script returns { title, html, links, assets }; the
    // selector extractor posts its own IIFE; everything else is a probe.
    const expression = String(body?.expression ?? '')
    if (expression.includes('document.documentElement.outerHTML')) {
      return {
        ok: true,
        result: {
          title: 'Example Domain',
          html: '<html><head><title>Example Domain</title></head><body><p>Example Domain</p><a href="/more">More</a></body></html>',
          links: [{ raw: '/more', url: 'https://example.com/more' }],
          assets: [],
        },
      }
    }
    if (expression.includes('const spec')) {
      return { ok: true, result: { data: { title: 'Example Domain' }, missing: [] } }
    }
    return { ok: true, result: 'evaluated' }
  },
  'POST /tabs/tab-1/viewport': { ok: true },
  'POST /tabs/tab-1/navigate': { ok: true, url: 'https://example.com/' },
  'POST /tabs/tab-1/upload': { ok: true },
  'POST /tabs/tab-1/back': { ok: true },
  'POST /tabs/tab-1/extract': { data: { title: 'Example' } },
  'GET /tabs/tab-1/downloads': { downloads: [{ data: 'ZGF0YQ==' }] },
  'POST /tabs/tab-1/fetch-current-resource': { ok: true },
  'POST /youtube/transcript': { transcript: 'hello '.repeat(400), video_title: 'Talk', total_words: 400 },
  'POST /pressure/cleanup': { closed: [] },
}

/**
 * The engine `userId` the fixture's {@link AGENT} resolves to.
 *
 * The trace routes below are keyed by the SAME scope string the bridge
 * derives, so they are computed with {@link resolveScope} instead of being
 * pasted in. A literal would have to be re-edited every time the scope
 * derivation changed, and until it was it would fail as a 404 that reads like
 * "the engine has no traces" rather than as a broken fixture — a test that
 * passes for the wrong reason is worse than one that fails.
 */
const TRACE_SCOPE = resolveScope({ agent: { id: '1451069a-e43c-4509-90f1-a2f1089f1eb9' } }, { userId: 'dsh' })

// The trace archives the engine keeps per session. `trace-1.zip` is answered
// with real zip magic bytes so a test can tell a downloaded archive from an
// error page: `camofox_trace` writes whatever bytes it was handed to disk and
// reports the count, so a JSON error body would still "succeed" at the tool.
ROUTES[`GET /sessions/${TRACE_SCOPE}/traces`] = {
  traces: [{ filename: 'trace-1.zip', sizeBytes: 1024, createdAt: 1700000000000 }],
}
ROUTES[`GET /sessions/${TRACE_SCOPE}/traces/trace-1.zip`] = Buffer.from('504b0304', 'hex')
ROUTES[`DELETE /sessions/${TRACE_SCOPE}/traces/trace-1.zip`] = { ok: true }

// The console-capture plugin's route, keyed with the same scope the execution
// fixture resolves to, so a scope-derivation change fails loudly instead of
// 404-ing as "the engine captured nothing".
ROUTES[`GET /dsh-console/${TRACE_SCOPE}`] = {
  userId: TRACE_SCOPE,
  total: 2,
  counts: { error: 1, pageerror: 1 },
  tabs: [{
    tabId: 'tab-1',
    url: 'https://example.com/',
    counts: { error: 1, pageerror: 1 },
    entries: [
      { seq: 1, kind: 'error', at: 1, text: 'API_CALL_FAILED: /api/items returned nothing', location: { url: 'https://example.com/', line: 3 } },
      { seq: 2, kind: 'pageerror', at: 2, text: 'TypeError: can\'t access property "boom" of null' },
    ],
  }],
}

/**
 * Build a bridge whose engine answers from {@link ROUTES} and records every call.
 *
 * The engine and the tools share ONE resolved config, exactly as `src/index.js`
 * does in production — `resolveScope` reads `bridge.config`, so a fixture that
 * handed the tools a different object would be testing a shape that cannot occur.
 *
 * The recorded call keeps `options` because the query is where the scope
 * actually reaches the engine: `GET /tabs?userId=…` is what keeps one session
 * out of another's listing, and a stub that dropped the fourth argument could
 * not tell a scoped request from an unscoped one.
 *
 * @param {object} [options] - `config` overrides and a `request` interceptor.
 * @returns {{ bridge: CamofoxBridge, engine: any, config: object, calls: Array<{ method: string, path: string, body: any, options: any }>, routes: Map<string, any> }} the fixture.
 */
function makeBridge(options = {}) {
  const calls = []
  const routes = new Map(Object.entries(ROUTES))
  const config = resolveConfig({ stateDir: mkdtempSync(join(tmpdir(), 'camofox-tools-')), autostart: false, ...options.config })
  const engine = {
    config,
    log() {},
    ensureReady: async () => true,
    origin: 'http://127.0.0.1:9377',
    lastError: null,
    status: () => ({ state: 'ready', baseUrl: 'http://127.0.0.1:9377', logFile: 'engine.log' }),
    async request(method, path, body, callOptions) {
      calls.push({ method, path, body, options: callOptions })
      if (options.request) {
        // Returning undefined means "not my route", so an interceptor handles
        // only what it is about and everything else still reaches the stub.
        const intercepted = await options.request(method, path, body, callOptions)
        if (intercepted !== undefined) return intercepted
      }
      const entry = routes.get(`${method} ${path}`)
      if (entry === undefined) throw new EngineError(`no stub for ${method} ${path}`, { code: 'bad_request', status: 404 })
      return typeof entry === 'function' ? entry(body) : entry
    },
    async probe() {
      // Routed through `request` rather than hardcoded, because the real
      // `probe` IS `GET /health`: a stub that answered from its own literal
      // would make every engine-wide counter unreachable by the tool that
      // reports them, and the `GET /health` route would be decoration.
      const payload = await engine.request('GET', '/health')
      return { ok: true, browserRunning: true, browserConnected: true, ...payload }
    },
  }
  const bridge = new CamofoxBridge(engine)
  bridge.config = config
  return { bridge, calls, routes, engine, config }
}

/**
 * Mount the tools on a fake registry, sharing the engine's own config object.
 *
 * @param {object} [options] - `config` overrides and a `request` interceptor.
 * @returns {{ registry: Map<string, any>, bridge: CamofoxBridge, ctx: any, config: object, calls: any[] }} the fixture.
 */
function mount(options = {}) {
  const { bridge, config, calls } = makeBridge(options)
  const registry = new Map()
  const ctx = {
    get: () => undefined,
    tools: { register: (definition) => registry.set(definition.name, definition) },
  }
  registerTools(ctx, bridge, config)
  return { registry, bridge, ctx, config, calls }
}

/**
 * Open one tab in the session, the way any real flow starts.
 *
 * Every read-family tool resolves its tab from the registry, so a test that
 * omits `tabId` has to have one in the same scope first.
 *
 * @param {object} registry - the mounted tool registry.
 * @param {any} execution - the tool execution to open under.
 * @returns {Promise<string>} the tab id.
 */
async function openTab(registry, execution) {
  const value = await registry.get('camofox_open').execute({ url: 'https://example.com/', readPage: false }, execution)
  return value.tabId
}

/** A live agent handle, so the scope derivation has a session to work with. */
const AGENT = { id: '1451069a-e43c-4509-90f1-a2f1089f1eb9', options: {}, session: {} }

const exec = () => ({ signal: new AbortController().signal, agent: AGENT, callId: 'call-1' })

test('every registered tool has a deadline and a bounded renderer', () => {
  const { registry } = mount()
  const names = [...registry.keys()]
  // The count is asserted, not discovered: adding a tool is a deliberate act
  // that should be visible here, not something the suite silently absorbs.
  assert.equal(names.length, 16)
  for (const [name, definition] of registry) {
    assert.equal(typeof definition.execute, 'function', `${name} has no execute`)
    assert.equal(typeof definition.output?.render, 'function', `${name} has no output.render`)
    assert.ok(Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0, `${name} has no usable timeoutMs`)
    assert.ok((definition.description ?? '').length > 40, `${name} has a stub description`)
  }
})

test('every tool runs against the stub without touching the browser', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'camofox-out-'))
  const { registry } = mount()
  await openTab(registry, exec())
  const calls = [
    ['camofox_open', { url: 'https://example.com/', maxChars: 400 }],
    ['camofox_read', { mode: 'snapshot', maxChars: 400 }],
    ['camofox_read', { mode: 'links' }],
    ['camofox_read', { mode: 'images' }],
    ['camofox_read', { mode: 'stats', maxChars: 4000 }],
    ['camofox_read', { mode: 'text', maxChars: 400 }],
    ['camofox_act', { action: 'click', ref: 'e1' }],
    ['camofox_capture', { savePath: join(scratch, 'shot.png') }],
    ['camofox_eval', { expression: '1+1', savePath: join(scratch, 'eval.txt') }],
    ['camofox_search', { macro: '@google_search', query: 'camoufox' }],
    ['camofox_scrape', { urls: ['https://example.com/'], schema: { properties: { title: { selector: ':title' } } } }],
    ['camofox_mirror', { url: 'https://example.com/', outDir: join(scratch, 'mirror') }],
    ['camofox_tabs', { action: 'list' }],
    ['camofox_status', {}],
    ['camofox_trace', { action: 'list' }],
    ['camofox_transcript', { url: 'https://youtu.be/x', maxChars: 400 }],
  ]
  for (const [name, args] of calls) {
    const definition = registry.get(name)
    const value = await definition.execute(args, exec())
    assert.ok(value && typeof value === 'object', `${name} returned nothing`)
    // The model-facing contract is the rendered content, not the canonical
    // `content` field: `camofox_act` legitimately has no `content` key because
    // the whole value is the result.
    const rendered = definition.output.render(args, value)
    assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name} rendered no content`)
    assert.ok(
      rendered.every((block) => block.type !== 'text' || block.text.length > 0),
      `${name} rendered an empty text block`,
    )
  }
  assert.ok(existsSync(join(scratch, 'shot.png')), 'the screenshot was not written')
  assert.ok(existsSync(join(scratch, 'eval.txt')), 'the eval result was not written')
  rmSync(scratch, { recursive: true, force: true })
})

test('the engine userId a tool sends is this session\'s scope', async () => {
  const { bridge, calls } = makeBridge({ config: { userId: 'dsh-desktop' } })
  const registry = new Map()
  const ctx = { get: () => undefined, tools: { register: (d) => registry.set(d.name, d) } }
  registerTools(ctx, bridge, bridge.config)
  await registry.get('camofox_open').execute({ url: 'https://example.com/', readPage: false }, exec())
  const opened = calls.find((entry) => entry.method === 'POST' && entry.path === '/tabs')
  // Asserted against what the bridge derives, never against a literal: the
  // scope string contains a digest of the session id, and pinning that digest
  // here would break the day the hash changed while proving nothing about
  // isolation. The properties below are what the contract actually is.
  const scope = bridge.for(exec()).scope
  assert.equal(opened.body.userId, scope)
  // The engine requires a sessionKey; it now defaults to the scope, so two
  // sessions can never pick the same tab-group name.
  assert.equal(opened.body.sessionKey, scope)
  // The configured namespace survives: `userId` is the operator's lever for
  // forcing a clean jar, so the session key is appended to it, never replaces
  // it, and two profiles stay separate.
  assert.ok(scope.startsWith('dsh-desktop~'), `the configured namespace was lost: ${scope}`)
  assert.notEqual(scope, 'dsh-desktop', 'the session key was not applied at all')
  // …and the session id stays legible in it, which is the only reason the
  // readable prefix is kept.
  assert.match(scope, /^dsh-desktop~1451069a-e43c-4509-90f1-a2f1089f1eb9-/)
})

test('two session ids that sanitise alike never share one cookie jar', () => {
  // The N17 defect, stated as a property instead of an implementation: every
  // pair below collapses to ONE string under sanitisation (`/`→`-`, `é`→`-`,
  // `:`→`-`, …), so a scope built from the sanitised text alone would hand both
  // sessions the same engine `userId` — the same Playwright context, the same
  // cookies, the same `closeSession`. Only the digest separates them.
  const config = { userId: 'dsh-desktop' }
  const collide = [
    ['sub/agent-01', 'sub-agent-01'],
    ['café-tab-1', 'caf--tab-1'],
    ['a/b/cdefgh', 'a-b-cdefgh'],
    ['session/aaaa', 'session:aaaa'],
    ['agent:7f3a/run1', 'agent-7f3a-run1'],
  ]
  for (const [left, right] of collide) {
    const leftScope = resolveScope({ agent: { id: left } }, config)
    const rightScope = resolveScope({ agent: { id: right } }, config)
    assert.notEqual(leftScope, rightScope, `${JSON.stringify(left)} and ${JSON.stringify(right)} share one scope`)
    assert.ok(leftScope.startsWith('dsh-desktop~') && rightScope.startsWith('dsh-desktop~'), 'a scope lost its namespace')
  }

  // Stable: the same session id always recomputes the same scope, which is what
  // lets a resumed session find the cookies its predecessor left in the engine.
  // The second derivation runs through an independently built bridge — the
  // stand-in for a harness restart, since the string is a pure function of the
  // config and the session id with no clock, counter or randomness in it.
  const first = resolveScope({ agent: { id: 'session-aaaa' } }, config)
  const restarted = makeBridge({ config: { userId: 'dsh-desktop' } }).bridge.for({ agent: { id: 'session-aaaa' } }).scope
  assert.equal(first, restarted, 'a restart changed the scope of the same session')
  assert.equal(resolveScope({ agent: { session: { id: 'session-aaaa' } } }, config), first, 'agent.id and agent.session.id disagree')

  // Distinct sessions stay distinct, and so do distinct profiles.
  assert.notEqual(resolveScope({ agent: { id: 'a' } }, config), resolveScope({ agent: { id: 'b' } }, config))
  assert.notEqual(
    resolveScope({ agent: { id: 'a' } }, { userId: 'one' }),
    resolveScope({ agent: { id: 'a' } }, { userId: 'two' }),
    'two configured profiles shared a scope',
  )
  assert.equal(resolveScope({ agent: { id: 'a' } }, { ...config, perSessionScope: false }), 'dsh-desktop', 'the opt-out was ignored')

  // Transport-safe: the value is spliced into URL path segments and query
  // strings, printed into engine logs and used as a filesystem-safe token, so a
  // hostile session id must not be able to escape any of them.
  const hostile = resolveScope({ agent: { id: 'a/b c?d#e&f=g%h i\\j:k|l<>*"\'' } }, config)
  assert.match(hostile, /^[A-Za-z0-9.~_-]+$/, `the scope carries an unsafe character: ${hostile}`)
  assert.equal(new URLSearchParams({ userId: hostile }).get('userId'), hostile, 'the scope does not survive a query string')
  assert.equal(
    new URL(`http://engine/sessions/${encodeURIComponent(hostile)}`).pathname,
    `/sessions/${encodeURIComponent(hostile)}`,
  )
  // …and bounded, so a long id cannot grow a proxy key or a log line without
  // limit. 48 is the documented ceiling, not an accident of this digest.
  assert.equal(sanitizeKey('x'.repeat(4000)).length, 48)
  assert.ok(sanitizeKey('x'.repeat(4000)).length <= 48)
})

test('a call with no session keeps the shared namespace instead of inventing one', () => {
  // Inventing a scope per call would hand out a NEW cookie jar on every tool
  // call: cookies would never outlive the call that set them, and every session
  // would start logged out. "No session" is a real state with one honest
  // answer — the configured namespace, the same private jar these callers had
  // before scoping existed.
  const { bridge } = makeBridge({ config: { userId: 'dsh-desktop' } })
  const expected = 'dsh-desktop'
  for (const exec of [null, undefined, {}, { agent: {} }, { agent: { id: '   ' } }]) {
    assert.equal(bridge.for(exec).scope, expected, `${JSON.stringify(exec)} invented its own scope`)
  }
  // Stable across calls and across a restart, for the same reason.
  const restarted = makeBridge({ config: { userId: 'dsh-desktop' } }).bridge
  assert.equal(restarted.for(undefined).scope, bridge.for(undefined).scope)
})

test('two sessions never see each other\'s tabs', async () => {
  // Every tab gets a distinct id and every listing is answered for the scope
  // that asked, so the stub behaves like the engine does: one `userId`, one
  // context, one set of tabs.
  let minted = 0
  const live = new Map()
  const { bridge, calls } = makeBridge({
    request: (method, path, body, options) => {
      const scope = String(options?.query?.userId ?? body?.userId ?? '')
      if (method === 'POST' && path === '/tabs') {
        minted += 1
        const tabId = `tab-${minted}`
        live.set(tabId, { tabId, scope, url: 'https://example.com/', title: 'Example' })
        return live.get(tabId)
      }
      if (method === 'GET' && path === '/tabs') {
        // The engine's own boundary: one `userId` sees one context's tabs.
        return { running: true, tabs: [...live.values()].filter((tab) => tab.scope === scope) }
      }
      if (method === 'DELETE' && path.startsWith('/tabs/')) {
        const id = decodeURIComponent(path.slice('/tabs/'.length))
        if (live.has(id)) live.delete(id)
        return { closed: true }
      }
      if (method === 'GET' && path.includes('/snapshot')) {
        return { url: 'https://example.com/', snapshot: 'x'.repeat(100), refsCount: 1, truncated: false, totalChars: 100 }
      }
      return undefined
    },
  })
  const registry = new Map()
  const ctx = { get: () => undefined, tools: { register: (d) => registry.set(d.name, d) } }
  registerTools(ctx, bridge, bridge.config)
  const a = { signal: new AbortController().signal, agent: { id: 'session-aaaa', options: {} } }
  const b = { signal: new AbortController().signal, agent: { id: 'session-bbbb', options: {} } }
  const openedA = await registry.get('camofox_open').execute({ url: 'https://example.com/', readPage: false }, a)
  const openedB = await registry.get('camofox_open').execute({ url: 'https://example.com/', readPage: false }, b)
  const viewA = bridge.for(a)
  const viewB = bridge.for(b)
  assert.notEqual(openedA.tabId, openedB.tabId, 'the fixture gave both sessions one tab id')

  // Two contexts, not one labelled twice.
  assert.notEqual(viewA.scope, viewB.scope, 'the two sessions share a scope')
  assert.notEqual(openedA.sessionKey, openedB.sessionKey)

  // Each session's registry holds its own tab and nothing else.
  assert.deepEqual(viewA.status().trackedTabs.map((tab) => tab.tabId), [openedA.tabId])
  assert.deepEqual(viewB.status().trackedTabs.map((tab) => tab.tabId), [openedB.tabId])
  assert.equal(viewA.status().trackedTabCount, 1)
  assert.equal(viewB.status().trackedTabCount, 1)
  // A session may know that another exists; it may not know anything about it.
  assert.equal(viewA.status().otherActiveScopes, 1)

  // And the engine is asked per scope, which is the boundary that actually
  // holds once the plugin process is gone.
  const listed = async (execution) => registry.get('camofox_tabs').execute({ action: 'list' }, execution)
  const listA = await listed(a)
  const listB = await listed(b)
  assert.deepEqual(listA.tabs.map((tab) => tab.tabId), [openedA.tabId], 'session A saw a tab it does not own')
  assert.deepEqual(listB.tabs.map((tab) => tab.tabId), [openedB.tabId], 'session B saw a tab it does not own')
  const queries = calls.filter((entry) => entry.path === '/tabs' && entry.method === 'GET').map((entry) => entry.options.query.userId)
  assert.ok(queries.includes(viewA.scope) && queries.includes(viewB.scope), 'a tab listing was sent without this session\'s scope')

  // A tab id learned from anywhere is not a capability: reading, acting on or
  // closing another session's tab is refused with a reason, not silently
  // resolved against a jar that does not own it.
  for (const [tool, args] of [
    ['camofox_read', { tabId: openedB.tabId, mode: 'snapshot' }],
    ['camofox_act', { tabId: openedB.tabId, action: 'click', ref: 'e1' }],
    ['camofox_tabs', { action: 'close', tabId: openedB.tabId }],
  ]) {
    const error = await registry.get(tool).execute(args, a).then(
      () => null,
      (thrown) => thrown,
    )
    assert.ok(error, `${tool} accepted another session's tab`)
    assert.equal(error.code, 'foreign_tab', `${tool} failed for the wrong reason: ${error.message}`)
    assert.match(error.message, /belongs to another session/)
    assert.ok(!calls.some((entry) => entry.method === 'POST' && entry.path.endsWith('/click')), `${tool} reached the engine anyway`)
  }
  // B's tab is still there: refusing is not a quiet close.
  assert.deepEqual(viewB.status().trackedTabs.map((tab) => tab.tabId), [openedB.tabId])

  // With two tabs in one scope and no id given, resolution refuses rather than
  // picking — and the message names this session's tabs only.
  await registry.get('camofox_open').execute({ url: 'https://example.com/', readPage: false }, a)
  const ambiguous = await registry.get('camofox_read').execute({ mode: 'snapshot' }, a).then(
    () => null,
    (thrown) => thrown,
  )
  assert.equal(ambiguous?.code, 'ambiguous_tab')
  assert.ok(ambiguous.message.includes(openedA.tabId) && !ambiguous.message.includes(openedB.tabId), 'the ambiguity hint leaked another session\'s tab')
})

test('the maxTabs bound evicts this session\'s tabs and no one else\'s', async () => {
  // `pruneIdleTabs` was process-wide dead code with no callers, so `maxTabs`
  // was a number nothing read. The bound now lives in `evictToMaxTabs`, which
  // `open` calls — and it must be per scope, or one busy session would evict a
  // stranger's tabs.
  let minted = 0
  const { bridge } = makeBridge({
    config: { maxTabs: 3 },
    request: (method, path, body, options) => {
      if (method === 'POST' && path === '/tabs') {
        minted += 1
        return { tabId: `tab-${minted}`, url: 'https://example.com/', title: 'Example' }
      }
      if (method === 'DELETE' && path.startsWith('/tabs/')) return { closed: true }
      return undefined
    },
  })
  const registry = new Map()
  const ctx = { get: () => undefined, tools: { register: (d) => registry.set(d.name, d) } }
  registerTools(ctx, bridge, bridge.config)
  const a = { signal: new AbortController().signal, agent: { id: 'session-aaaa', options: {} } }
  const b = { signal: new AbortController().signal, agent: { id: 'session-bbbb', options: {} } }
  const quiet = await registry.get('camofox_open').execute({ url: 'https://example.com/', readPage: false }, b)
  for (let index = 0; index < 6; index += 1) {
    await registry.get('camofox_open').execute({ url: 'https://example.com/', readPage: false }, a)
  }
  assert.ok(bridge.for(a).status().trackedTabCount <= 3, `the tab bound was not enforced: ${bridge.for(a).status().trackedTabCount} tabs tracked`)
  assert.ok(bridge.for(a).status().trackedTabCount > 0, 'eviction evicted every tab including the newest')
  // The other session's tab was never a candidate.
  assert.deepEqual(bridge.for(b).status().trackedTabs.map((tab) => tab.tabId), [quiet.tabId], 'the bound closed another session\'s tab')
})

test('an action outside the enum cannot become a process-wide cleanup', async () => {
  // `POST /pressure/cleanup` is deliberately global — the engine has no userId
  // filter on it, so it can relieve idle tabs in ANY session sharing the
  // process. Every other action here is per-session. The schema declares an
  // enum, but the harness does not validate tool arguments against it, so a
  // chain ending in a fall-through turns a typo into a cross-session action that
  // still answers "Engine cleanup finished". Both layers matter: the tool
  // refuses by name, and nothing is dispatched.
  const { registry, calls } = mount({
    // `close` and `resetSession` are per-session DELETEs; the base fixture has
    // no route for them, and a stub lacking one would make this pass for the
    // wrong reason.
    request: (method, path) => (method === 'DELETE' && (path.startsWith('/tabs/') || path.startsWith('/sessions/')) ? { closed: true } : undefined),
  })
  const execution = exec()
  await openTab(registry, execution)
  const globalCalls = () => calls.filter((call) => call.method === 'POST' && call.path === '/pressure/cleanup')
  const before = globalCalls().length

  for (const action of ['cleaup', 'closeall', 'free-memory', 'cleanup ', 'Cleanup', '', '../../pressure/cleanup']) {
    let error
    try {
      await registry.get('camofox_tabs').execute({ action }, execution)
    } catch (thrown) {
      error = thrown
    }
    assert.ok(error, `action ${JSON.stringify(action)} was accepted instead of refused`)
    assert.match(String(error.message ?? error), /is not an action camofox_tabs can perform/, `action ${JSON.stringify(action)} produced an unhelpful error`)
  }
  assert.equal(globalCalls().length, before, 'a refused action still ran the process-wide cleanup')

  // The declared actions still work, so the guard is not over-tight, and exactly
  // one of them is allowed to touch the global endpoint.
  const declared = registry.get('camofox_tabs').parameters.properties.action.enum
  assert.deepEqual([...declared], ['list', 'close', 'closeAll', 'resetSession', 'cleanup'], 'the schema enum changed under this test')
  for (const action of declared) {
    await registry.get('camofox_tabs').execute(action === 'close' ? { action, tabId: 'tab-1' } : { action }, execution)
  }
  assert.equal(globalCalls().length, before + 1, 'exactly one declared action must reach the global cleanup')
})

test('a mode outside the enum is refused instead of evaluated as undefined', async () => {
  // `mode` used to index a literal map, so an unknown mode produced
  // `expression: undefined` — which `JSON.stringify` drops, so the call
  // "succeeded" against a stub and became an opaque engine error in production.
  const { registry, calls } = mount()
  const execution = exec()
  await openTab(registry, execution)
  const declared = registry.get('camofox_read').parameters.properties.mode.enum
  const evaluated = () => calls.filter((call) => call.method === 'POST' && /\/evaluate$/.test(call.path))
  const before = evaluated().length

  for (const mode of ['summary', 'TABLE', 'texts', ' snapshot', '', 'snapshot markdown']) {
    let error
    try {
      await registry.get('camofox_read').execute({ mode }, execution)
    } catch (thrown) {
      error = thrown
    }
    assert.ok(error, `mode ${JSON.stringify(mode)} was accepted instead of refused`)
    assert.match(String(error.message ?? error), /is not a mode camofox_read can read/, `mode ${JSON.stringify(mode)} produced an unhelpful error`)
    // The message must name every mode the schema declares, or the two lists
    // have already drifted apart.
    for (const declaredMode of declared) assert.match(String(error.message), new RegExp(declaredMode), `the error never mentions ${declaredMode}`)
  }
  assert.equal(evaluated().length, before, 'a refused mode still reached the engine')

  for (const mode of declared) {
    await registry.get('camofox_read').execute({ mode, maxChars: 400 }, execution)
  }
})

test('an action outside the schema enum cannot become a URL path segment', async () => {
  // The schema declares `action` as an enum, but the harness does not validate
  // tool arguments against it — an enum is advisory text for the model. So the
  // `default:` branch of camofox_act is reachable with arbitrary text, and that
  // text used to be interpolated into a URL path. `../../<scope>/cookies`
  // normalises onto the engine's real POST /sessions/:userId/cookies route,
  // which is another session's boundary. This asserts both layers: the tool
  // names the problem, and no request is ever dispatched.
  const { registry, bridge, calls } = mount({
    request: (method, path) => {
      if (method === 'POST' && /^\/tabs\/[^/]+\/(back|forward|refresh)$/.test(path)) {
        return { ok: true, action: path.split('/').pop() }
      }
      return undefined
    },
  })
  const execution = exec()
  await openTab(registry, execution)
  const before = calls.length

  for (const action of ['../../other-session/cookies', '../../../sessions/victim~abc123/cookies', 'back/../../stop', 'not-an-action', '']) {
    let error
    try {
      await registry.get('camofox_act').execute({ action }, execution)
    } catch (thrown) {
      error = thrown
    }
    assert.ok(error, `action ${JSON.stringify(action)} was accepted instead of refused`)
    assert.match(String(error.message ?? error), /not an action camofox_act can perform/, `action ${JSON.stringify(action)} produced an unhelpful error`)
  }

  assert.equal(calls.length, before, 'a refused action still reached the engine')
  // The bridge is the second line of defence: even a caller that skipped the
  // tool must not be able to turn `action` into a path segment.
  let bridgeError
  try {
    await bridge.for(execution).history('tab-1', '../../other-session/cookies')
  } catch (thrown) {
    bridgeError = thrown
  }
  assert.ok(bridgeError, 'bridge.history accepted a traversal action')
  assert.equal(bridgeError.code, 'bad_history_action', `unexpected classification: ${bridgeError.code}`)
  assert.equal(calls.length, before, 'bridge.history dispatched the traversal action anyway')

  // The three real actions still work, so the allowlist is not over-tight.
  for (const action of ['back', 'forward', 'refresh']) {
    const value = await registry.get('camofox_act').execute({ action }, execution)
    assert.equal(value.action, action, `${action} stopped working`)
  }
})

test('a stale offset is reported instead of returning the wrong region', async () => {
  // The engine drops its cached snapshot on navigation and exposes no id, so a
  // resumed offset can be answered from a completely different document. The
  // first read here sees 500 characters; the resumed one is answered with 812.
  let served = 0
  const { registry } = mount({
    request: (method, path) => {
      if (method === 'GET' && path === '/tabs/tab-1/snapshot') {
        served += 1
        const total = served === 1 ? 500 : 812
        return { url: 'https://example.com/', snapshot: 'x'.repeat(total), refsCount: 3, truncated: false, totalChars: total }
      }
      return undefined
    },
  })
  await openTab(registry, exec())
  const tool = registry.get('camofox_read')
  const first = await tool.execute({ mode: 'snapshot', maxChars: 200 }, exec())
  assert.equal(first.totalChars, 500)
  assert.equal(first.hasMore, true)
  assert.equal(first.nextOffset, 200)
  assert.ok(first.documentId, 'no document token was minted')
  assert.equal(first.restartedRead, undefined)
  const stale = await tool.execute({ mode: 'snapshot', offset: first.nextOffset, maxChars: 200 }, exec())
  assert.equal(stale.restartedRead, true, 'a read across a changed document was not reported')
  assert.match(stale.content, /the page changed under that offset/)
})

test('an untruncated read honours maxChars and hands back an exact cursor', async () => {
  const { registry } = mount()
  await openTab(registry, exec())
  const seen = new Set()
  let offset
  for (let page = 0; page < 3; page += 1) {
    const value = await registry.get('camofox_read').execute({ mode: 'snapshot', maxChars: 200, offset }, exec())
    seen.add(value.content)
    offset = value.nextOffset
    if (offset === null) break
  }
  assert.equal(seen.size, 3, 'three pages were not three distinct documents of content')
  assert.equal(offset, null, 'the last page did not report the end of the document')
})

test('paging fields survive a result far larger than the budget', () => {
  const { registry } = mount()
  const value = { totalChars: 159769, hasMore: true, nextOffset: 74800, refs: 12, content: 'y'.repeat(120000) }
  const rendered = registry.get('camofox_read').output.render({}, value)
  const text = rendered[0].text
  assert.match(text, /"hasMore": true/)
  assert.match(text, /"nextOffset": 74800/)
  assert.ok(text.length > 120000, 'the renderer truncated the serialised value instead of leaving it whole')
  const bounded = registry.get('camofox_read').finalizeContent({}, { content: rendered })
  assert.ok(bounded[0].text.length < text.length, 'finalizeContent did not bound the result')
  assert.match(bounded[0].text, /truncated result/)
})

test('the budget finisher never removes a non-text block', () => {
  const { registry } = mount()
  const image = { type: 'image', attachment: { id: 'a1' } }
  const blocks = registry
    .get('camofox_capture')
    .finalizeContent({}, { content: [{ type: 'text', text: 'z'.repeat(30000) }, image] })
  assert.equal(blocks.length, 2)
  assert.equal(blocks[1], image, 'the screenshot attachment was deleted by the budget')
  // Nothing over budget means nothing is rewritten at all.
  assert.equal(registry.get('camofox_capture').finalizeContent({}, { content: [{ type: 'text', text: 'short' }] }), undefined)
})

test('a bounded status still leads with the summary', () => {
  const { registry } = mount()
  const value = registry.get('camofox_status').output.render({}, {
    trackedTabCount: 63,
    trackedTabs: Array.from({ length: 63 }, (_value, index) => ({ tabId: `t${index}`, url: `https://example.com/${index}` })),
    otherActiveScopes: 2,
    state: 'ready',
    baseUrl: 'http://127.0.0.1:9377',
    logFile: 'engine.log',
  })[0].text
  assert.ok(value.indexOf('"content"') < 200, 'the summary is not at the front of the payload')
})

test('a tool with no content field is still bounded', () => {
  const { registry } = mount()
  // `camofox_act` returns the whole value as its result and has no `content`
  // key, so its bound has to come from the finisher working on the RENDERED
  // blocks rather than on a field of the canonical value.
  const definition = registry.get('camofox_act')
  const rendered = definition.output.render({ action: 'click' }, { action: 'click', tabId: 'tab-1', result: { payload: 'q'.repeat(50000) } })
  assert.ok(rendered[0].text.length > 12000, 'the fixture is not actually over budget')
  const bounded = definition.finalizeContent({}, { content: rendered })
  assert.ok(bounded[0].text.length < rendered[0].text.length, 'a result with no content field was never bounded')
  assert.match(bounded[0].text, /truncated result/)
})

test('camofox_mirror actually writes the site it claims to have copied', async () => {
  // The strongest trap in this tool: `mirrorSite` receives a bridge view, and
  // handing it the raw bridge shifts every argument left by one. That fails
  // SILENTLY — mirror records the page it could not read in `skipped` and
  // still returns a report that reads like a finished copy, while the live
  // suite misses it entirely because it calls `mirrorSite` directly rather than
  // through the tool. So this asserts the FILES, not the report shape.
  const scratch = mkdtempSync(join(tmpdir(), 'camofox-mirror-'))
  const outDir = join(scratch, 'copy')
  const { registry } = mount()
  await openTab(registry, exec())
  const report = await registry.get('camofox_mirror').execute({ url: 'https://example.com/', outDir, maxPages: 1 }, exec())
  assert.equal(report.pagesWritten, 1, `mirror wrote no page (skipped: ${report.skipped.join('; ')})`)
  assert.ok(existsSync(join(outDir, 'index.html')), 'mirror reported a page but wrote no index.html')
  assert.match(readFileSync(join(outDir, 'index.html'), 'utf8'), /Example Domain/)
  rmSync(scratch, { recursive: true, force: true })
})

test('a classified engine failure keeps its code', async () => {
  // Only the read fails; opening the tab must still work, exactly as it would
  // against a real engine that had recycled one page and not the other.
  const { bridge } = makeBridge({
    request: (method, path) => {
      if (method === 'GET' && path.endsWith('/snapshot')) {
        throw new EngineError('the tab no longer exists (gone); open a new tab', { status: 404, code: 'tab_not_found', needsNewTab: true })
      }
      return undefined
    },
  })
  const registry = new Map()
  const ctx = { get: () => undefined, tools: { register: (d) => registry.set(d.name, d) } }
  registerTools(ctx, bridge, bridge.config)
  await openTab(registry, exec())
  const error = await registry.get('camofox_read').execute({ mode: 'snapshot' }, exec()).then(
    () => null,
    (thrown) => thrown,
  )
  assert.ok(error, 'the failure did not propagate')
  assert.equal(error.name, 'EngineError', 'the error lost its identity')
  assert.equal(error.code, 'tab_not_found', 'the error lost its code')
  assert.match(error.message, /action: open a new tab and continue/)
})

test('an overwritten file is reported, and overwrite:false refuses', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'camofox-write-'))
  const target = join(scratch, 'report.txt')
  writeFileSync(target, 'original')
  const { registry } = mount()
  await openTab(registry, exec())

  const refused = await registry.get('camofox_eval').execute({ expression: '1+1', savePath: target, overwrite: false }, exec()).then(
    (value) => value,
    (error) => error,
  )
  assert.match(String(refused.message ?? refused.content), /refused/)
  assert.equal(readFileSync(target, 'utf8'), 'original', 'a refused write still wrote')

  const replaced = await registry.get('camofox_eval').execute({ expression: '1+1', savePath: target }, exec())
  assert.equal(replaced.replacedExisting, true)
  assert.match(replaced.content, /REPLACED an existing file/)
  rmSync(scratch, { recursive: true, force: true })
})

test('a scrape that is refused a write keeps its records', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'camofox-scrape-'))
  const target = join(scratch, 'records.ndjson')
  writeFileSync(target, 'previous')
  const { registry } = mount()
  const value = await registry.get('camofox_scrape').execute(
    { urls: ['https://example.com/'], schema: { properties: { title: { selector: ':title' } } }, outputPath: target, overwrite: false },
    exec(),
  )
  assert.equal(value.savedTo, null)
  assert.match(value.refusedWrite, /refused/)
  assert.equal(value.records.length, 1, 'the scraped record was thrown away')
  assert.equal(readFileSync(target, 'utf8'), 'previous')
  rmSync(scratch, { recursive: true, force: true })
})

test('allowEvaluate:false refuses camofox_eval by name and says what still works', async () => {
  const { registry } = mount({ config: { allowEvaluate: false } })
  const error = await registry.get('camofox_eval').execute({ expression: '1+1' }, exec()).then(
    () => null,
    (thrown) => thrown,
  )
  assert.ok(error)
  assert.match(error.message, /camofox_eval is disabled/)
  assert.match(error.message, /waitForSelector still run/)
})

test('read reports an unsupported offset instead of silently re-sending a prefix', async () => {
  const { registry } = mount()
  await openTab(registry, exec())
  const value = await registry.get('camofox_read').execute({ mode: 'text', offset: 5000, maxChars: 200 }, exec())
  assert.equal(value.offsetSupported, false)
  assert.match(value.content, /offset is not supported in text mode/)
})

test('stats honours its budget and says how much history it withheld', async () => {
  const { registry } = mount()
  await openTab(registry, exec())
  const value = await registry.get('camofox_read').execute({ mode: 'stats', maxChars: 2000 }, exec())
  assert.equal(value.visitedUrls, 200)
  assert.equal(value.earlierVisitsWithheld, 200)
  assert.match(value.content, /truncated tab stats/)
})

test('links cannot emit "undefined" for a missing url', async () => {
  const { registry } = mount()
  await openTab(registry, exec())
  const value = await registry.get('camofox_read').execute({ mode: 'links' }, exec())
  assert.equal(value.links.length, 2)
  assert.ok(value.links.every((row) => !row.includes('undefined')), 'a link row rendered "undefined"')
  assert.equal(value.offsetUnit, 'items')
})

test('navigationFields reports the engine verdict and invents nothing', () => {
  // A 404 with a perfectly readable body is otherwise indistinguishable from
  // success, so the engine's own `httpStatus`/`navigationOk` are the only thing
  // that separates "the page loaded" from "the server rendered an error page".
  // These are direct unit calls because the defect they guard is a SHAPE
  // defect: emitting `httpStatus: null` for a `content:` page, or a `note` on a
  // successful navigation, tells the model something the engine never said.
  // Checked one property per case because a combined assertion would pass on
  // the pair and miss whichever one actually regressed.
  assert.deepEqual(navigationFields({ httpStatus: 404, navigationOk: false }), {
    httpStatus: 404,
    navigationOk: false,
    note: 'the server answered HTTP 404; the page may be an error document rather than what you asked for',
  })
  // A successful navigation carries the status and no complaint: a note here
  // would train the model to distrust every open.
  assert.deepEqual(navigationFields({ httpStatus: 200, navigationOk: true }), { httpStatus: 200, navigationOk: true })
  // A `content:` or `about:` page has no HTTP status at all, so both fields stay
  // missing rather than being reported as null/undefined keys.
  assert.deepEqual(navigationFields({ url: 'about:blank' }), {})
  // A record with only one of the two keeps only that one: half a verdict is
  // still the engine's verdict, and dropping it would hide a real signal.
  assert.deepEqual(navigationFields({ httpStatus: 503 }), { httpStatus: 503 })
  assert.deepEqual(navigationFields({ navigationOk: false, httpStatus: '500' }), {
    navigationOk: false,
    note: 'the server answered HTTP 500; the page may be an error document rather than what you asked for',
  })
  // Non-records are the shape a stub or a crashed engine produces; they must
  // contribute no keys rather than throwing inside a merge.
  for (const payload of [null, undefined, 'navigate ok', 42, []]) assert.deepEqual(navigationFields(payload), {})
})

test('searchProvenance names the engine that actually answered', () => {
  // When Google blocks, the engine silently answers from another engine. The
  // model reads results it believes are Google's and reasons from them as
  // Google's ranking, so the substitution has to be stated. The two branches
  // are distinct states — "answered from a substitute" and "answered with
  // nothing" — and conflating them would report trustable results for a search
  // that returned none.
  const fallback = searchProvenance({ searchEngine: 'duckduckgo', fallbackFrom: 'google' })
  assert.equal(fallback.searchEngine, 'duckduckgo')
  assert.equal(fallback.fallbackFrom, 'google')
  assert.match(fallback.note, /came from duckduckgo, not google/)
  assert.match(fallback.note, /bot check/)

  // A blocked search that produced nothing must not carry a substitute engine:
  // `searchEngine` there would invite the model to trust a ranking that does
  // not exist.
  const blocked = searchProvenance({ googleBlocked: true, searchFallbackAttempted: true })
  assert.equal(blocked.googleBlocked, true)
  assert.equal(blocked.searchFallbackAttempted, true)
  assert.equal(blocked.searchEngine, undefined, 'a search with no results claimed a substitute engine')
  assert.match(blocked.note, /no results to trust/)

  const unattempted = searchProvenance({ googleBlocked: true })
  assert.equal(unattempted.searchFallbackAttempted, false)
  assert.match(unattempted.note, /no fallback engine was available/)

  // The ordinary case stays silent: a note on every search would be noise the
  // model learns to skip.
  assert.deepEqual(searchProvenance({ url: 'https://www.google.com/search?q=x' }), {})
  // A half-filled pair is not a fallback report, and `false` is not `true`.
  assert.deepEqual(searchProvenance({ searchEngine: 'duckduckgo' }), {})
  assert.deepEqual(searchProvenance({ googleBlocked: 'yes' }), {})
  for (const payload of [null, undefined, 'ok', 7]) assert.deepEqual(searchProvenance(payload), {})
})

test('camofox_open surfaces a failed navigation instead of reporting success', async () => {
  // `camofox_open` is the tool most often used with `readPage:false`, where
  // throwing would discard a tab the caller can still use, so the engine's
  // verdict is merged into the result instead. Before the merge existed, a 404
  // came back as `{ tabId, url, title }` and read exactly like a success.
  const { registry } = mount({
    request: (method, path) =>
      method === 'POST' && path === '/tabs'
        ? { tabId: 'tab-1', url: 'https://example.com/missing', title: 'Not Found', httpStatus: 404, navigationOk: false }
        : undefined,
  })
  const value = await registry.get('camofox_open').execute({ url: 'https://example.com/missing', readPage: false }, exec())
  assert.equal(value.httpStatus, 404)
  assert.equal(value.navigationOk, false)
  assert.match(value.note, /HTTP 404/)
})

test('camofox_act back reports the status of the page it went back to', async () => {
  // Going back is a navigation, so it can land on a page that has since gone
  // 404 — and that failure used to be invisible: the result was `{ ok: true }`
  // and the model reported "went back" over an error document.
  const { registry } = mount({
    request: (method, path) => (method === 'POST' && path === '/tabs/tab-1/back' ? { ok: true, httpStatus: 410, navigationOk: false } : undefined),
  })
  await openTab(registry, exec())
  const value = await registry.get('camofox_act').execute({ action: 'back' }, exec())
  assert.equal(value.action, 'back')
  assert.equal(value.httpStatus, 410)
  assert.equal(value.navigationOk, false)
  assert.match(value.note, /HTTP 410/)
  // The engine's own payload survives: the verdict is merged, not substituted.
  assert.equal(value.result.ok, true)
})

test('fullPage reaches the engine as the string "true", and only when asked', async () => {
  // The engine string-compares against `'true'` (server.js:5341), so sending
  // `1` or `yes` yields a viewport capture while the tool reports "captured
  // the full page". Asserted on the recorded query in BOTH directions: a test
  // that only checked the positive case would still pass if the bridge sent
  // `fullPage: 'false'` or the key on every capture.
  const scratch = mkdtempSync(join(tmpdir(), 'camofox-fullpage-'))
  const { registry, calls } = mount()
  await openTab(registry, exec())
  const screenshots = () => calls.filter((call) => call.method === 'GET' && call.path.endsWith('/screenshot'))

  await registry.get('camofox_capture').execute({ savePath: join(scratch, 'viewport.png') }, exec())
  assert.equal(screenshots().at(-1).options.query.fullPage, undefined, 'a viewport capture asked the engine for the whole page')

  await registry.get('camofox_capture').execute({ savePath: join(scratch, 'full.png'), fullPage: true }, exec())
  assert.equal(screenshots().at(-1).options.query.fullPage, 'true', 'a full-page capture did not send fullPage=true as a string')

  // `false` and a truthy non-boolean are both "not the string 'true'", and the
  // tool must not coerce either into a full-page render.
  for (const fullPage of [false, 1, 'yes', 'TRUE', 'true']) {
    await registry.get('camofox_capture').execute({ savePath: join(scratch, 'other.png'), fullPage }, exec())
    assert.equal(screenshots().at(-1).options.query.fullPage, undefined, `fullPage ${JSON.stringify(fullPage)} was forwarded as a full-page render`)
  }
  // Both files were still written, so the query is the only thing that varied.
  assert.ok(existsSync(join(scratch, 'viewport.png')) && existsSync(join(scratch, 'full.png')))
  rmSync(scratch, { recursive: true, force: true })
})

test('camofox_status reports engine-wide counters, and omits a zero failure count', async () => {
  // These four lines are the only place a tab or a session leaked by ANOTHER
  // session becomes visible at all — with per-session scoping the whole point
  // is that this session cannot see them anywhere else.
  const { registry } = mount()
  await openTab(registry, exec())
  const value = await registry.get('camofox_status').execute({}, exec())
  assert.equal(value.engine.activeTabs, 3)
  assert.equal(value.engine.activeSessions, 2)
  assert.match(value.content, /engine tabs: 3 across all sessions/)
  assert.match(value.content, /engine sessions: 2/)
  assert.match(value.content, /engine memory: 185 MiB rss/)
  // `consecutiveFailures` is gated on > 0: printing "0 consecutive" on a
  // healthy engine reads as a warning the operator cannot act on.
  assert.ok(!/consecutive/.test(value.content), `a healthy engine reported a failure count: ${value.content}`)
})

test('camofox_status admits the engine is struggling', async () => {
  // The flip side of the zero case, in its own test: a stub that only ever
  // reported a healthy engine could not catch a regression that dropped the
  // failure and recovery lines entirely — the more likely defect, since they
  // are the only two that mention something is wrong.
  const { registry } = mount({
    request: (method, path) =>
      method === 'GET' && path === '/health'
        ? { ok: true, engine: 'camofox', browserRunning: false, browserConnected: false, activeTabs: 0, activeSessions: 0, consecutiveFailures: 4, recovering: true, memory: { rssMb: 12 } }
        : undefined,
  })
  const value = await registry.get('camofox_status').execute({}, exec())
  assert.match(value.content, /engine failures: 4 consecutive/)
  assert.match(value.content, /engine is recovering/)
  assert.match(value.content, /running=false connected=false/)
})

test('a search macro that fell back reports which engine answered', async () => {
  // `bridge.open` runs a macro through the navigate route and used to AWAIT
  // that result and throw it away, so the fallback the engine reported was
  // discarded before any tool could see it. The result is the whole reason
  // this is a tool test and not a bridge test: `camofox_search` merges
  // `searchProvenance(opened)`, and without the merge the fields never arrive.
  const { registry, calls } = mount({
    request: (method, path) => {
      if (method === 'POST' && path === '/tabs/tab-1/navigate') {
        return { ok: true, url: 'https://duckduckgo.com/?q=camoufox', searchEngine: 'duckduckgo', fallbackFrom: 'google' }
      }
      return undefined
    },
  })
  const value = await registry.get('camofox_search').execute({ macro: '@google_search', query: 'camoufox', maxChars: 400 }, exec())
  assert.equal(value.searchEngine, 'duckduckgo')
  assert.equal(value.fallbackFrom, 'google')
  assert.match(value.note, /came from duckduckgo, not google/)
  // The macro really was expanded by the navigate route, so the provenance did
  // not come from tab creation, which never carries it.
  assert.ok(calls.some((call) => call.method === 'POST' && call.path === '/tabs/tab-1/navigate' && call.body.macro === '@google_search'))
})

test('a search that did not fall back says nothing about engines', async () => {
  // The paired negative: a stub that only ever reported a fallback could not
  // catch a provenance merge that INVENTED the fields, which would tell the
  // model its results came from an engine that never answered. A search that
  // went through must carry no provenance keys at all.
  const { registry } = mount()
  const value = await registry.get('camofox_search').execute({ macro: '@google_search', query: 'camoufox', maxChars: 400 }, exec())
  assert.equal(value.searchEngine, undefined)
  assert.equal(value.fallbackFrom, undefined)
  assert.equal(value.googleBlocked, undefined)
  assert.equal(value.note, undefined)
  // …and the results themselves are still there, so the assertion above is not
  // passing merely because the tool returned an empty result.
  assert.ok(value.results.length > 0)
})

test('camofox_trace lists, downloads and deletes this session\'s archives', async () => {
  // The whole lifecycle in one test because each step is a precondition for the
  // next: an archive that could be listed but not fetched would leave a model
  // debugging a page with no way to see WHY it misbehaved.
  const scratch = mkdtempSync(join(tmpdir(), 'camofox-trace-'))
  const { registry, calls } = mount()
  await openTab(registry, exec())
  const scoped = () => calls.filter((call) => call.path.startsWith(`/sessions/${TRACE_SCOPE}/traces`))

  const listed = await registry.get('camofox_trace').execute({ action: 'list' }, exec())
  assert.equal(listed.count, 1)
  assert.equal(listed.traces[0].filename, 'trace-1.zip')
  assert.equal(listed.traces[0].bytes, 1024)
  // The raw epoch is turned into something a model can read; a bare 1700000000000
  // in the listing is not a date anyone can act on.
  assert.equal(listed.traces[0].createdAt, '2023-11-14T22:13:20.000Z')
  assert.match(listed.content, /trace-1\.zip — 1024 bytes/)
  assert.match(listed.content, /trace\.playwright\.dev/)

  const fetched = await registry.get('camofox_trace').execute({ action: 'get', filename: 'trace-1.zip', savePath: join(scratch, 'trace-1.zip') }, exec())
  const saved = join(scratch, 'trace-1.zip')
  assert.equal(fetched.savedTo, saved)
  assert.equal(fetched.bytes, 4)
  // The bytes on disk are what the engine sent: a JSON error body written to a
  // .zip would still report "written to … (4 bytes)" and open as a broken file.
  assert.deepEqual([...readFileSync(saved)], [0x50, 0x4b, 0x03, 0x04])

  const deleted = await registry.get('camofox_trace').execute({ action: 'delete', filename: 'trace-1.zip' }, exec())
  assert.equal(deleted.action, 'delete')
  assert.match(deleted.content, /Deleted trace trace-1\.zip/)
  assert.ok(scoped().some((call) => call.method === 'DELETE'), 'the delete never reached the engine')
  // Every trace request carried THIS session's scope; a trace archive is the
  // most sensitive artifact a session produces, so a missing scope would let
  // one session list or delete another's.
  for (const call of scoped()) {
    assert.ok(call.path.includes(TRACE_SCOPE), `a trace request escaped the session scope: ${call.path}`)
  }
  rmSync(scratch, { recursive: true, force: true })
})

test('an empty trace list explains that traces only appear after the session closes', async () => {
  // The flush timing is what makes this tool confusing: Playwright writes an
  // archive when the CONTEXT closes, so a list taken while the session is still
  // running legitimately returns nothing. Without that sentence the model
  // concludes tracing is broken and stops using it.
  const { registry } = mount({ request: (method, path) => (method === 'GET' && path.endsWith('/traces') ? { traces: [] } : undefined) })
  const value = await registry.get('camofox_trace').execute({ action: 'list' }, exec())
  assert.equal(value.count, 0)
  assert.deepEqual(value.traces, [])
  assert.match(value.content, /only appears after the recording session closes/)
  assert.match(value.content, /trace:true/)
})

test('camofox_trace refuses get and delete without a filename', async () => {
  // The schema makes `filename` optional — it cannot be required, because
  // `list` does not take one — so `get`/`delete` have to refuse it themselves.
  // Without the guard the tool would interpolate `undefined` into the engine
  // path, or (worse) silently answer `GET /sessions/<scope>/traces/undefined`.
  const { registry, calls } = mount()
  await openTab(registry, exec())
  const before = calls.length
  for (const action of ['get', 'delete']) {
    const error = await registry.get('camofox_trace').execute({ action }, exec()).then(
      () => null,
      (thrown) => thrown,
    )
    assert.ok(error, `camofox_trace ${action} ran without a filename`)
    assert.match(error.message, /needs a filename; call action:"list" first/, `camofox_trace ${action} produced an unhelpful error`)
    // …and a blank string is the same mistake, not a request for the archive
    // whose name is the empty string.
    const blank = await registry.get('camofox_trace').execute({ action, filename: '   ' }, exec()).then(
      () => null,
      (thrown) => thrown,
    )
    assert.ok(blank, `camofox_trace ${action} accepted a blank filename`)
  }
  assert.equal(calls.length, before, 'a refused trace action still reached the engine')
})

test('camofox_open forwards trace:true to tab creation', async () => {
  // `trace` is the whole entry point to the feature: if the flag never reached
  // `POST /tabs` the context would be created untraced and `camofox_trace`
  // would list nothing forever, with no error anywhere. Asserted on the
  // request BODY because the engine reads it there, not from a query.
  const { registry, calls } = mount()
  await registry.get('camofox_open').execute({ url: 'https://example.com/', readPage: false, trace: true }, exec())
  const opened = calls.find((call) => call.method === 'POST' && call.path === '/tabs')
  assert.equal(opened.body.trace, true)

  // The default is an explicit `false`, not `undefined`: the engine reads the
  // field, and a key the plugin forgot would be an engine-version guess.
  await registry.get('camofox_open').execute({ url: 'https://example.com/', readPage: false }, exec())
  const untraced = calls.filter((call) => call.method === 'POST' && call.path === '/tabs').at(-1)
  assert.equal(untraced.body.trace, false)
})

test('camofox_console returns the captured errors and names where each came from', async () => {
  const { registry } = mount()
  await openTab(registry, exec())
  const value = await registry.get('camofox_console').execute({}, exec())
  const rendered = registry.get('camofox_console').output.render({}, value)

  // The model's value is the failures themselves, each with the source that
  // produced it — a bare "something went wrong" is not actionable.
  assert.match(value.content, /API_CALL_FAILED/, 'the console error was not reported')
  assert.match(value.content, /can't access property/, 'the uncaught exception was not reported')
  assert.match(value.content, /\[error\]/, 'the kind is missing, so severity cannot be judged')
  assert.match(value.content, /\[pageerror\]/)
  // A console message carries its own source location; without it the model
  // cannot tell which of several errors on a page is the one it cares about.
  assert.match(value.content, /https:\/\/example\.com\/:3/, 'the console location was dropped')
  assert.match(rendered[0].text, /entr/)
})

test('camofox_console asks the engine for the severity the caller wants', async () => {
  const { registry, calls } = mount()
  await openTab(registry, exec())
  await registry.get('camofox_console').execute({ minSeverity: 'error' }, exec())
  const asked = calls.filter((call) => call.path.startsWith('/dsh-console/')).at(-1)
  assert.equal(asked.options.query.minSeverity, 'error')

  // The default must be stated, not omitted: the engine reads the parameter and
  // a missing one is an engine-version guess about which entries come back.
  await registry.get('camofox_console').execute({}, exec())
  const defaulted = calls.filter((call) => call.path.startsWith('/dsh-console/')).at(-1)
  assert.equal(defaulted.options.query.minSeverity, 'warning')
})

test('camofox_console narrows to one tab and says so when nothing was captured', async () => {
  const { registry } = mount()
  await openTab(registry, exec())
  // The stub reports one tab; asking about another must produce the empty
  // message rather than another tab's errors.
  const other = await registry.get('camofox_console').execute({ tabId: 'tab-9' }, exec())
  assert.equal(other.shown, 0)
  assert.match(other.content, /No console errors/, 'an empty report must explain itself')
  assert.match(other.content, /tab-9/, 'the empty report must name the tab it looked at')
})
