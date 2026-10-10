/**
 * Hermetic tests for client-side snapshot reduction and for `waitForUrl`.
 *
 * Two features are covered, and they are covered for the same reason: both were
 * written against the engine's real rendered snapshot, and both had a defect
 * that no syntax check could see. A snapshot filter that drops a link's
 * `/url:` line, or that renumbers a ref, breaks a `camofox_act` call that the
 * model was told was safe; a `waitForUrl` that polls once and gives up breaks
 * every single-page navigation it was written for. So the fixtures below are
 * the engine's own output (captured live from the camofox-browser checkout),
 * not an invented shape, and the assertions are about the properties a caller
 * depends on rather than about the particular lines that happen to be kept.
 *
 * `waitForUrl` is driven through a stub engine built the way `scripts/tools.mjs`
 * builds its fixture: no browser, no network, no camofox checkout.
 *
 * Run with: `node scripts/snapshots.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { INTERACTIVE_ROLES, filterInteractive, scopeSnapshot } from '../src/snapshot-filter.js'
import { CamofoxBridge } from '../src/bridge.js'
import { resolveConfig, EngineError } from '../src/engine.js'
import { resolveScope } from '../src/scope.js'

/**
 * A snapshot captured live from the engine, in the engine's real format.
 *
 * Every fact a filter has to get right is present here and none is invented:
 * refs are bracketed `[e1]`, children are indented two spaces, a `- /url:` line
 * is a continuation and NOT a node (it has no role token), `checkbox` and
 * `combobox` carry no accessible name, and `- paragraph:` / `- text:` use a
 * colon form rather than a quoted name. A fixture that dropped any one of these
 * would let a filter that cannot handle it pass.
 */
const SNAPSHOT = [
  '- heading "Main heading" [level=1]',
  '- paragraph: Static prose that is not interactive at all and only adds noise to a snapshot.',
  '- link "First link" [e1]:',
  '  - /url: https://example.com/one',
  '- button "Push me" [e2]',
  '- textbox "Type here" [e3]',
  '- checkbox [e4]',
  '- combobox [e5]:',
  '  - option "One" [selected]',
  '- textbox [e6]: Area',
  '- img "An image"',
  '- heading "Second heading" [level=2]',
  '- text: Nested static text',
  '- link "Second link" [e7]:',
  '  - /url: https://example.com/two',
  '- button "Go" [e8]',
].join('\n')

/** Every `[eN]` ref in a snapshot, in the order the engine wrote them. */
function refsOf(text) {
  return [...text.matchAll(/\[(e\d+)\]/g)].map((match) => match[1])
}

/** The non-blank lines of a reduction, so a duplicated line is visible. */
function linesOf(text) {
  return text.split('\n').filter((line) => line.trim() !== '')
}

test('filterInteractive drops headings, paragraphs and text lines', () => {
  // These three role shapes are the bulk of any real snapshot and none of them
  // can be acted on. `- paragraph:` and `- text:` use the colon form, so a
  // filter that only understood the quoted-name form would keep them. The
  // colon is required in the patterns: `^- text` alone also matches `textbox`.
  const { text } = filterInteractive(SNAPSHOT)
  assert.doesNotMatch(text, /^- heading\b/m)
  assert.doesNotMatch(text, /^- paragraph:/m)
  assert.doesNotMatch(text, /^- text:/m)
  // The actionable siblings of the dropped ones survived.
  assert.match(text, /^- button "Push me" \[e2\]$/m)
  assert.match(text, /^- textbox "Type here" \[e3\]$/m)
})

test("filterInteractive keeps a link's /url continuation line", () => {
  // Regression: the first implementation only kept lines that parsed as nodes,
  // and `- /url:` is not a node. It dropped every link target while appearing to
  // work — the filtered snapshot still listed the links, just with no href.
  const { text } = filterInteractive(SNAPSHOT)
  assert.match(text, /^- link "First link" \[e1\]:$/m)
  assert.match(text, /^ {2}- \/url: https:\/\/example\.com\/one$/m)
  assert.match(text, /^ {2}- \/url: https:\/\/example\.com\/two$/m)
  // It hangs off its link: the continuation is indented, not floated up to the
  // top level where it would read as a node of its own.
  assert.ok(text.includes('- link "First link" [e1]:\n  - /url: https://example.com/one'))
})

test('filterInteractive keeps a combobox option child', () => {
  // Regression: the same subtree bug, seen from the control's side. Dropping
  // `- option "One"` leaves a combobox with nothing to select, so the filter
  // would emit a control it had just made unusable.
  const { text } = filterInteractive(SNAPSHOT)
  assert.match(text, /^- combobox \[e5\]:$/m)
  assert.match(text, /^ {2}- option "One" \[selected\]$/m)
})

test('filterInteractive emits no line twice', () => {
  // Regression: the subtree walk and the outer loop both emitted a child, so
  // every nested interactive node appeared twice in the output. A duplicate is
  // not cosmetic — it inflates the char budget and makes a model read the same
  // option as two separate choices.
  const { text } = filterInteractive(SNAPSHOT)
  const seen = new Set()
  for (const line of linesOf(text)) {
    assert.equal(seen.has(line), false, `line emitted twice: ${line}`)
    seen.add(line)
  }
  assert.equal(linesOf(text).length, seen.size)
})

/**
 * The same snapshot with non-contiguous refs.
 *
 * The engine numbers refs across the WHOLE page, including the nodes a filter
 * drops, so the refs that survive a filter are rarely `e1, e2, e3…`. That gap
 * is what makes renumbering detectable: against the sequential fixture above a
 * renumbering filter that emitted `e1` for the first kept line would reproduce
 * the input exactly and the safety property would pass by accident.
 */
const GAPPED_SNAPSHOT = [
  '- heading "Main heading" [level=1]',
  '- link "First link" [e3]:',
  '  - /url: https://example.com/one',
  '- paragraph: Static prose that is dropped.',
  '- textbox "Type here" [e41]',
  '- checkbox [e100]',
  '- combobox [e7]:',
  '  - option "One" [selected]',
  '- button "Go" [e256]',
].join('\n')

test('filterInteractive keeps every ref the input had, unrenumbered', () => {
  // The safety property. `camofox_act` takes a ref from the snapshot the model
  // was shown, so the filter must not drop a ref-bearing line and must not
  // renumber anything — an `[e41]` that became `[e2]` would point the click at
  // a different element than the one the model read.
  const before = refsOf(SNAPSHOT)
  const { text } = filterInteractive(SNAPSHOT)
  assert.deepEqual(refsOf(text), before)
  // Every ref survives attached to the line it was on, not merely somewhere.
  assert.match(text, /\[e1\]/)
  assert.match(text, /\[e8\]/)
})

test('filterInteractive does not renumber refs across dropped nodes', () => {
  // The companion to the property above, on refs that are NOT contiguous — which
  // is what the engine actually produces, since it numbers the nodes a filter
  // drops too. Renumbering would pass the sequential fixture untouched.
  const before = refsOf(GAPPED_SNAPSHOT)
  assert.deepEqual(before, ['e3', 'e41', 'e100', 'e7', 'e256'])
  const { text } = filterInteractive(GAPPED_SNAPSHOT)
  assert.deepEqual(refsOf(text), before)
  // And each stayed on its own line: the checkbox did not inherit e7.
  assert.match(text, /^- checkbox \[e100\]$/m)
  assert.match(text, /^- combobox \[e7\]:$/m)
})

test('filterInteractive never repeats a ref across the reduced snapshot', () => {
  // A leak — a subtree copied and then emitted again by the outer loop — would
  // show up as a ref appearing twice. That is worse than a duplicated static
  // line: the model has two handles on one element and no way to tell they are
  // the same one.
  const { text } = filterInteractive(SNAPSHOT)
  const refs = refsOf(text)
  assert.equal(new Set(refs).size, refs.length, `a ref was emitted twice: ${refs.join(' ')}`)
})

test('filterInteractive reports what it dropped', () => {
  // The counts are what a caller renders as "showing N of M", so they have to
  // describe the snapshot it received. `total` counts every line the node
  // pattern accepts, which includes the two `- /url:` continuations: they carry
  // a `/` and so never match a role token, but they DO start with `- url`,
  // which is a role-shaped token. The count is of parsed nodes, so an
  // implementation that changed what counts as a node would move it.
  const { kept, total } = filterInteractive(SNAPSHOT)
  assert.equal(total, 14)
  // Kept actionables: 2 links, 2 buttons, 2 textboxes, 1 checkbox, 1 combobox,
  // 1 option, 1 img. The `- /url:` lines ride along with their links and the
  // `option` rides along with its combobox, so neither inflates the count.
  assert.equal(kept, 10)
  assert.ok(kept < total, 'the filter kept everything')
})

test('filterInteractive reports a ref-bearing non-interactive line as kept-by-ref', () => {
  // A node the role set does not list but that carries a ref is still
  // actionable, and must be kept — the ref is the model's only handle on it.
  const { text, kept } = filterInteractive('- generic "Clickable thing" [e12]')
  assert.match(text, /^- generic "Clickable thing" \[e12\]$/)
  assert.equal(kept, 0, 'a ref-only line was counted as an interactive role')
})

test('filterInteractive does not treat an attribute bracket as a ref', () => {
  // `[level=1]`, `[selected]` and `[expanded]` look exactly like `[e1]` and are
  // not one. A filter that matched any bracketed token would keep every static
  // node in the snapshot — which is the exact failure the filter exists to
  // prevent, and it would do it on every `heading` and `paragraph`.
  const staticNodes = [
    '- heading "Main heading" [level=1]',
    '- paragraph: Prose. [expanded]',
    '- generic "Wrapper" [e12]',
  ].join('\n')
  const { text } = filterInteractive(staticNodes)
  // `[level=1]` and `[expanded]` are attributes, so both lines are dropped.
  assert.doesNotMatch(text, /level=1/)
  assert.doesNotMatch(text, /expanded/)
  // And the genuinely ref-bearing sibling IS kept, proving the bracket is what
  // differed rather than the surrounding text.
  assert.match(text, /^- generic "Wrapper" \[e12\]$/)
})

test('an option survives because of its role, not because of its [selected] flag', () => {
  // The counterpart to the attribute test, and the case that keeps a combobox
  // usable: `- option "One" [selected]` has no ref at all, so only the role set
  // can be what kept it.
  const { text } = filterInteractive('- combobox [e5]:\n  - option "One" [selected]')
  assert.equal(text, '- combobox [e5]:\n  - option "One" [selected]')
})

test('scopeSnapshot on "combobox" returns the combobox and its option child', () => {
  // The point of scoping a snapshot is to shrink it; returning the combobox
  // without its option would shrink it into something useless.
  const scoped = scopeSnapshot(SNAPSHOT, 'combobox')
  assert.equal(scoped, '- combobox [e5]:\n  - option "One" [selected]')
  // Nothing beyond the subtree leaked in.
  assert.doesNotMatch(scoped, /e[1-46-8]/)
})

test('scopeSnapshot matches an accessible name, case-insensitively', () => {
  // `main heading` matches only by the quoted name, never by the role: the
  // second heading is also a `heading` and must not come along.
  const scoped = scopeSnapshot(SNAPSHOT, 'main heading')
  assert.equal(scoped, '- heading "Main heading" [level=1]')
  assert.doesNotMatch(scoped, /Second heading/)
  assert.equal(scopeSnapshot(SNAPSHOT, 'MAIN HEADING'), '- heading "Main heading" [level=1]')
})

test('scopeSnapshot keeps a matched link with its /url line', () => {
  // The continuation is what makes a scoped link usable; dropping it here would
  // reintroduce the filter's original bug through the second code path.
  assert.equal(
    scopeSnapshot(SNAPSHOT, 'second link'),
    '- link "Second link" [e7]:\n  - /url: https://example.com/two',
  )
})

test('scopeSnapshot returns null when nothing matches, for the caller to name', () => {
  // `null` is the signal that "no such element" is distinct from "the whole
  // snapshot", which is what lets the tool raise a named error instead of
  // handing the model an unrelated subtree.
  assert.equal(scopeSnapshot(SNAPSHOT, 'no-such-thing'), null)
})

test('scopeSnapshot with an empty scope returns the input unchanged', () => {
  // "No scope" must mean "everything", not "nothing": returning an empty string
  // here would make an unscoped read look like a blank page.
  assert.equal(scopeSnapshot(SNAPSHOT, ''), SNAPSHOT)
  assert.equal(scopeSnapshot(SNAPSHOT, '   '), SNAPSHOT)
  assert.equal(scopeSnapshot(SNAPSHOT, undefined), SNAPSHOT)
})

test('the snapshot filters survive empty and non-string input without throwing', () => {
  // These reach the client from a tool arg or a failed engine call, and a throw
  // here would replace a useful empty result with an opaque failure.
  for (const value of [undefined, null, '', 0, false, {}]) {
    assert.doesNotThrow(() => filterInteractive(value), `filterInteractive(${String(value)}) threw`)
    assert.doesNotThrow(() => scopeSnapshot(value, 'button'), `scopeSnapshot(${String(value)}) threw`)
    assert.doesNotThrow(() => scopeSnapshot(SNAPSHOT, value), `scopeSnapshot('…', ${String(value)}) threw`)
  }
  assert.equal(filterInteractive('').total, 0)
  assert.equal(scopeSnapshot(undefined, 'button'), null)
  // An empty scope over a non-string still returns the input, coerced.
  assert.equal(scopeSnapshot(7, ''), '7')
})

/**
 * A bridge whose engine answers from a small route table and records every call.
 *
 * This is the `scripts/tools.mjs` fixture: one resolved config shared by the
 * engine and the bridge, a `ROUTES` table keyed by `METHOD /path`, and a missing
 * route answered as a 404 rather than silently undefined. The scope comes from
 * {@link resolveScope} rather than a literal, so the query the bridge sends is
 * the one a real session would send.
 *
 * @param {Record<string, any>} routes - the routes the stub answers.
 * @returns {{ bridge: CamofoxBridge, calls: any[], scope: string }} the fixture.
 */
function makeBridge(routes) {
  const calls = []
  const table = new Map(Object.entries(routes))
  const config = resolveConfig({ stateDir: mkdtempSync(join(tmpdir(), 'camofox-snap-')), autostart: false })
  const engine = {
    config,
    log() {},
    ensureReady: async () => true,
    origin: 'http://127.0.0.1:9377',
    lastError: null,
    status: () => ({ state: 'ready', baseUrl: 'http://127.0.0.1:9377', logFile: 'engine.log' }),
    async request(method, path, body, options) {
      calls.push({ method, path, body, options })
      const entry = table.get(`${method} ${path}`)
      if (entry === undefined) throw new EngineError(`no stub for ${method} ${path}`, { code: 'bad_request', status: 404 })
      return typeof entry === 'function' ? entry(body) : entry
    },
  }
  const bridge = new CamofoxBridge(engine)
  bridge.config = config
  const scope = resolveScope({ agent: { id: 'session-snapshots' } }, config)
  return { bridge, calls, scope, cleanup: () => rmSync(config.stateDir, { recursive: true, force: true }) }
}

/** The engine's `/stats` shape, as `server.js` returns it. */
function statsPayload(url) {
  return { tabId: 'tab-1', sessionKey: 'default', url, visitedUrls: [], downloadsCount: 0, toolCalls: 1, refsCount: 3 }
}

/** A live signal, so a call is not cancelled by the fixture rather than by the test. */
const signal = () => new AbortController().signal

test('waitForUrl polls the URL until the pattern matches', async () => {
  // The engine's `/wait` route blocks on a load event, which a single-page app
  // never fires when it only changes the route. So the wait has to be the
  // client's, and it has to actually poll: a single stats call that happened to
  // land on the old URL would have to come back `matched: false`.
  let calls = 0
  const urls = ['https://example.com/', 'https://example.com/app', 'https://example.com/app/inbox']
  const fixture = makeBridge({ 'GET /tabs/tab-1/stats': () => statsPayload(urls[Math.min(calls++, urls.length - 1)]) })
  try {
    const result = await fixture.bridge.waitForUrl(fixture.scope, 'tab-1', '/app/inbox', { timeoutMs: 4000 }, signal())
    assert.equal(result.ok, true)
    assert.equal(result.matched, true)
    assert.equal(result.url, 'https://example.com/app/inbox')
    assert.ok(result.waitedMs >= 0, 'waitedMs is not a duration')
    // It really polled: the match was on the third read, not the first.
    assert.equal(calls, 3, `expected 3 stats polls, made ${calls}`)
    // Every poll was the stats route, scoped to this session's userId.
    for (const call of fixture.calls) {
      assert.equal(call.method, 'GET')
      assert.equal(call.path, '/tabs/tab-1/stats')
      assert.equal(call.options.query.userId, fixture.scope)
    }
  } finally {
    fixture.cleanup()
  }
})

test('waitForUrl returns matched false on timeout, with the last URL it saw', async () => {
  // A timeout is a normal answer, not an error: the caller reports "the page
  // never navigated" and can decide what to do. Reporting the URL it actually
  // observed is what makes that message useful for diagnosis.
  let polls = 0
  const fixture = makeBridge({ 'GET /tabs/tab-1/stats': () => statsPayload(`https://example.com/never/${polls++}`) })
  try {
    const result = await fixture.bridge.waitForUrl(fixture.scope, 'tab-1', '/app/inbox', { timeoutMs: 120 }, signal())
    assert.equal(result.ok, true)
    assert.equal(result.matched, false)
    assert.match(result.url, /^https:\/\/example\.com\/never\//)
    assert.ok(result.waitedMs >= 120, `waited ${result.waitedMs}ms for a 120ms timeout`)
    // One poll, not several — and that is the documented consequence of the 250ms
    // poll interval against the 100ms `timeoutMs` floor: the deadline falls
    // between two polls, so a short-timeout `waitForUrl` never gets a second
    // look. This is harmless for real callers (the default is 15000ms, 60 polls)
    // and is asserted here so the behaviour is a known quantity rather than a
    // surprise discovered through a flaky test.
    assert.equal(polls, 1, 'a sub-interval timeout did not produce exactly one poll')
  } finally {
    fixture.cleanup()
  }
})

test('waitForUrl matches an already-correct URL without sleeping first', async () => {
  // A wait that always slept 250ms before its first read would add a guaranteed
  // quarter second to every navigation that has already happened, which is the
  // common case when a test retries after the click.
  const fixture = makeBridge({ 'GET /tabs/tab-1/stats': statsPayload('https://example.com/app/inbox') })
  try {
    const startedAt = Date.now()
    const result = await fixture.bridge.waitForUrl(fixture.scope, 'tab-1', '/app/inbox', { timeoutMs: 15000 }, signal())
    assert.equal(result.matched, true)
    assert.equal(result.url, 'https://example.com/app/inbox')
    assert.ok(Date.now() - startedAt < 250, 'the already-matching URL still cost a poll interval')
    assert.equal(fixture.calls.length, 1, 'it polled more than once against a matching URL')
  } finally {
    fixture.cleanup()
  }
})

test('waitForUrl names an invalid pattern instead of polling until it times out', async () => {
  // A pattern that will not compile is a caller mistake, and it must be loud:
  // reported as `bad_request` and naming the pattern itself. Left uncompiled it
  // would degrade into a silent 15s wait that looks exactly like a slow page.
  const fixture = makeBridge({ 'GET /tabs/tab-1/stats': statsPayload('https://example.com/') })
  try {
    await assert.rejects(
      () => fixture.bridge.waitForUrl(fixture.scope, 'tab-1', '/app/[unclosed', { timeoutMs: 4000 }, signal()),
      (error) => {
        assert.ok(error instanceof EngineError, `not an EngineError: ${error}`)
        assert.equal(error.code, 'bad_request')
        assert.match(error.message, /\/app\/\[unclosed/)
        return true
      },
    )
    assert.equal(fixture.calls.length, 0, 'a bad pattern still reached the engine')
  } finally {
    fixture.cleanup()
  }
})

test('the session-scoped waitForUrl wrapper reaches the same implementation', async () => {
  // The wrapper exists so a tool never has to know the scope, which means it
  // must not be a second copy of the polling loop: a fix applied to the bridge
  // has to reach the wrapper too.
  let calls = 0
  const urls = ['https://example.com/', 'https://example.com/done']
  const fixture = makeBridge({ 'GET /tabs/tab-1/stats': () => statsPayload(urls[Math.min(calls++, urls.length - 1)]) })
  try {
    const result = await fixture.bridge
      .for({ agent: { id: 'session-snapshots' } })
      .waitForUrl('tab-1', '/done', { timeoutMs: 4000 }, signal())
    assert.equal(result.matched, true)
    assert.equal(result.url, 'https://example.com/done')
    // The wrapper derived the same scope the bridge method was called with, so
    // the stats query carried this session's userId.
    assert.equal(fixture.calls[0].options.query.userId, fixture.scope)
    assert.equal(calls, 2)
  } finally {
    fixture.cleanup()
  }
})

test('waitForUrl stops and reports cancellation when the signal aborts', async () => {
  // A cancelled tool call must end, not burn the rest of its budget in a loop
  // nobody is waiting for.
  const controller = new AbortController()
  let polls = 0
  const fixture = makeBridge({
    'GET /tabs/tab-1/stats': () => {
      polls += 1
      if (polls === 1) controller.abort()
      return statsPayload('https://example.com/never')
    },
  })
  try {
    await assert.rejects(
      () => fixture.bridge.waitForUrl(fixture.scope, 'tab-1', '/app', { timeoutMs: 15000 }, controller.signal),
      (error) => {
        assert.equal(error.code, 'canceled')
        return true
      },
    )
    assert.equal(polls, 1, 'it kept polling after the signal aborted')
  } finally {
    fixture.cleanup()
  }
})

test('INTERACTIVE_ROLES is the set the filter actually applies', () => {
  // The export is part of the module's surface, so a role added to the filter
  // but not to the set (or the reverse) would leave a caller reading a stale
  // list of what it can act on.
  for (const role of ['button', 'link', 'textbox', 'checkbox', 'combobox', 'option', 'img', 'searchbox', 'slider', 'tab']) {
    assert.equal(INTERACTIVE_ROLES.has(role), true, `${role} is missing from INTERACTIVE_ROLES`)
  }
  // Structural roles carry no action and must not be in the set.
  for (const role of ['heading', 'paragraph', 'text', 'generic', 'listitem', 'main', 'navigation']) {
    assert.equal(INTERACTIVE_ROLES.has(role), false, `${role} is in INTERACTIVE_ROLES`)
  }
  // And the filter really is driven by that set: a node whose role is in it is
  // kept with no ref and no attribute anywhere on its line.
  for (const role of INTERACTIVE_ROLES) {
    const { text } = filterInteractive(`- ${role} "Name"`)
    assert.equal(text, `- ${role} "Name"`, `${role} is in the set but the filter dropped it`)
  }
})