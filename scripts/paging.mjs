/**
 * Does paging a long page actually reach the end?
 *
 * The engine windows the document itself: a page longer than
 * `MAX_SNAPSHOT_CHARS` comes back as a 74 800-character chunk, a truncation
 * marker, and the last 5 000 characters so navigation refs are always in view.
 * `totalChars`, `hasMore` and `nextOffset` are therefore coordinates in the
 * WHOLE document, never in the window.
 *
 * This plugin used to re-derive them from the window's own length, which made a
 * long read report "end of document" with roughly half the page unread. The
 * replacement subdivides an oversized window locally, which is what makes the
 * cursor EXACT — and which makes two ways of getting it wrong very easy:
 * building it from the requested offset when the engine has already clamped
 * that offset, and subdividing the engine's final window, where there is
 * nothing left to subdivide into.
 *
 * So this guard asserts BEHAVIOUR, never a page count or an offset value, so
 * that it survives any change of strategy. For every (document size, character
 * budget) pair it walks the cursor exactly as a model does — take `nextOffset`,
 * ask again — and holds the walk to what a caller is entitled to assume:
 *
 *   1. it terminates, and the last page says so with `hasMore:false` and no
 *      cursor (a run of `hasMore:true` forever is the failure this exists for);
 *   2. the cursor only moves forward;
 *   3. every character of the document is delivered at least once — the two
 *      historical bugs both show up here, one as a gap and one as a page that
 *      declares the end while half the document is unread;
 *   4. a page's body really is the document at the position it claims, so no
 *      page is labelled with a position its first character is not at;
 *   5. the start the engine clamped to is the start the page reports, so every
 *      cursor handed back is one the engine will honour rather than clamp away;
 *   6. the cursor instruction survives the tool's own content budget, because
 *      the tool prints it before the body for exactly that reason;
 *   7. **no page ever needs trimming at all** — measured on the block the
 *      registry really sends.
 *
 * ## Every measurement here is post-budget
 *
 * (7) is the whole point. The tool's `content` field is the canonical value,
 * NOT what the model receives: the registry renders the canonical value as
 * pretty-printed JSON, bounds THAT at 40 000 characters, and hands the trimmed
 * string to the provider. A guard that measures `content` therefore measures a
 * payload no model ever sees, and it passed for two waves while `maxChars` above
 * the budget handed whole 79 850-character windows to a trim that cut them at
 * 40 000 — leaving ~35 000 characters that no cursor returned, ever.
 *
 * So the walk runs the real pipeline: `output.render`, then `projectContent`,
 * then the registered `finalizeContent`, then takes the snapshot back out of the
 * block that survived. Coverage is measured from THAT text. It is still measured
 * from content and never from cursors — a cursor that jumps ahead of the content
 * it came with is a gap, and only the content can show that.
 *
 * The document is built from `a`..`z` only, so the engine's marker — which opens
 * with a newline — is unambiguously distinguishable from document text, and the
 * longest prefix of a page that matches the document measures exactly what that
 * page delivered. Nothing here knows how `renderSnapshot` slices anything.
 *
 * When the camofox-browser checkout is present its real `lib/snapshot.js` is used
 * verbatim. Otherwise the copy below stands in for it; it is byte-equivalent to
 * `lib/snapshot.js:15-39` and its constants are asserted against that file's.
 *
 * Run with: `node scripts/paging.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { CamofoxBridge } from '../src/bridge.js'
import { resolveConfig } from '../src/engine.js'
import { registerTools } from '../src/tools.js'

const ENGINE_CHECKOUT = 'C:/Users/mirel/Desktop/GitHub/camofox-browser/lib/snapshot.js'

/** The engine's own windowing, verbatim from `lib/snapshot.js:6-39`. */
const MAX_SNAPSHOT_CHARS = 80_000
const SNAPSHOT_TAIL_CHARS = 5_000

function windowSnapshot(yaml, offset = 0) {
  if (!yaml) return { text: '', truncated: false, totalChars: 0, offset: 0 }
  const total = yaml.length
  if (total <= MAX_SNAPSHOT_CHARS) return { text: yaml, truncated: false, totalChars: total, offset: 0 }
  const contentBudget = MAX_SNAPSHOT_CHARS - SNAPSHOT_TAIL_CHARS - 200
  const tail = yaml.slice(-SNAPSHOT_TAIL_CHARS)
  const clampedOffset = Math.min(Math.max(0, offset), total - SNAPSHOT_TAIL_CHARS)
  const chunk = yaml.slice(clampedOffset, clampedOffset + contentBudget)
  const chunkEnd = clampedOffset + contentBudget
  const hasMore = chunkEnd < total - SNAPSHOT_TAIL_CHARS
  const marker = hasMore
    ? `\n[... truncated at char ${chunkEnd} of ${total}. Call snapshot with offset=${chunkEnd} to see more. Pagination links below. ...]\n`
    : '\n'
  return { text: chunk + marker + tail, truncated: true, totalChars: total, offset: clampedOffset, hasMore, nextOffset: hasMore ? chunkEnd : null }
}

/**
 * A document whose every character position is recoverable.
 *
 * `a`..`z` and nothing else: no newline, so the engine's truncation marker can
 * never be mistaken for document text, and the tail the engine repeats is a
 * visibly different stretch of the page rather than an accidental match.
 *
 * @param {number} size - the document length.
 * @returns {string} the document.
 */
const document_ = (size) => Array.from({ length: size }, (_value, index) => String.fromCharCode(97 + (index % 26))).join('')

/** Letters plus the three characters a JSON string has to escape, and a space. */
const ESCAPE_ALPHABET = 'abcdefghij\n"\\ '

/**
 * A document made of the characters JSON has to escape.
 *
 * The registry sends the snapshot inside a JSON string, so a newline or a quote
 * in the page costs TWO characters of the content budget, not one — every real
 * accessibility snapshot is full of both. A split threshold that counted
 * characters instead of delivered characters would look right on `a`..`z` and
 * lose the tail of every real page. No digit, `.` or `[` is in here, so the
 * engine's marker still cannot be mistaken for document text.
 *
 * @param {number} size - the document length.
 * @returns {string} the document.
 */
const escapedDocument_ = (size) => Array.from({ length: size }, (_value, index) => ESCAPE_ALPHABET[index % ESCAPE_ALPHABET.length]).join('')

/** Document sizes worth paging: around the tail, around the window, and well past both. */
const SIZES = [
  0,
  200,
  5_000,
  // Around the tool's own content budget: a page can carry less than this, so
  // these are the documents that decide whether the split follows `maxChars` or
  // the budget the registry will really apply.
  38_700,
  40_000,
  40_001,
  44_900,
  // Around the engine's 74 800-character chunk, which is where a window starts
  // carrying a chunk the caller asked for and where it stops.
  74_801,
  78_700,
  79_900,
  80_000,
  80_001,
  84_800,
  154_800,
  159_769,
  200_000,
  400_000,
]

/**
 * Budgets from the clamp floor upward, including budgets larger than a whole
 * window and either side of the tool's 40 000-character content budget.
 *
 * The last group is the one the content-budget gap hid behind: 74 800 and up
 * used to be handed whole windows, which the budget then cut in half.
 */
const BUDGETS = [200, 2_000, 20_000, 39_000, 39_600, 40_000, 40_100, 41_000, 74_799, 74_800, 74_801, 75_000, 80_000, 100_000, 159_769, 400_000]

/**
 * The exact case the last wave of paging work existed to prevent, named so a
 * regression reports as itself rather than as a number in a matrix.
 */
const REVIEWER_CASES = [
  [80_001, 74_800],
  [200_000, 159_769],
  [400_000, 400_000],
]

const CURRENT = { size: 0, document: '', last: null }

/**
 * Mount the real tools against a stub that answers with the engine's own shapes.
 *
 * The stub also records what the engine was asked for and where it actually
 * started, because "a cursor the engine honours" is only meaningful against what
 * the engine really returned — not against what was requested.
 *
 * @returns {{ registry: Map<string, any>, execution: any }} the mounted tools.
 */
function mount() {
  const registry = new Map()
  const engine = {
    config: resolveConfig({ autostart: false, userId: 'paging-probe' }),
    log() {},
    origin: 'http://127.0.0.1:9377',
    lastError: null,
    async ensureReady() {
      return true
    },
    status: () => ({ state: 'ready' }),
    async probe() {
      return { ok: true }
    },
    // The bridge passes query parameters as the fourth argument, not in the body.
    async request(method, path, _body, options) {
      if (!path.endsWith('/snapshot')) return { tabId: 'tab-1', url: 'https://example.com/' }
      const requested = Number(options?.query?.offset ?? 0)
      const win = windowSnapshot(CURRENT.document, requested)
      CURRENT.last = { requested, served: win.offset, truncated: win.truncated === true, hasMore: win.hasMore === true, nextOffset: win.nextOffset ?? null }
      return { url: 'https://example.com/', snapshot: win.text, refsCount: 1, ...win }
    },
  }
  const bridge = new CamofoxBridge(engine)
  bridge.config = engine.config
  registerTools({ get: () => undefined, tools: { register: (d) => registry.set(d.name, d) } }, bridge, engine.config)
  const execution = { signal: new AbortController().signal, agent: { id: 'probe-session', options: {} } }
  return { registry, execution }
}

const { registry, execution } = mount()

/** What a rendered page says about continuing — the line a budget must never trim. */
const CURSOR_LINE = /more: call camofox_read again with offset=\d+|end of document/

/**
 * Where the registry's rendered block carries the snapshot text.
 *
 * The block is pretty-printed JSON, so the top-level keys sit at two spaces of
 * indentation and the snapshot lives in the last of them. That cannot be
 * confused with a key inside the text itself: a quote inside a JSON string is
 * escaped, and a newline inside one is written `\n`, so this exact byte sequence
 * can only occur where a key does.
 */
const CONTENT_KEY = '\n  "content": "'

/**
 * The snapshot text the model actually receives, taken out of the block that
 * survived the registry's own budget.
 *
 * The block is one JSON string, so the text is walked back out of its escapes
 * and the walk stops at the first unescaped quote — whether the block ended
 * cleanly or was cut in the middle of the string, which is exactly the case
 * this guard exists to see.
 *
 * @param {string} block - the text block the registry would hand to the provider.
 * @returns {string} the snapshot text as the model receives it.
 */
function deliveredContent(block) {
  const at = String(block ?? '').indexOf(CONTENT_KEY)
  if (at === -1) throw new Error('the rendered block carries no snapshot to measure')
  let text = ''
  for (let index = at + CONTENT_KEY.length; index < block.length; index += 1) {
    const character = block[index]
    if (character === '"') break
    if (character !== '\\') {
      text += character
      continue
    }
    const escaped = block[(index += 1)]
    if (escaped === 'n') text += '\n'
    else if (escaped === 't') text += '\t'
    else if (escaped === 'r') text += '\r'
    else if (escaped === 'b') text += '\b'
    else if (escaped === 'f') text += '\f'
    else if (escaped === 'u') {
      text += String.fromCharCode(Number.parseInt(block.slice(index + 1, index + 5), 16))
      index += 4
    } else text += escaped
  }
  return text
}

/**
 * Split a rendered page into its header, its cursor line, and its body.
 *
 * The cursor line is found by what it SAYS rather than by where it sits, so a
 * regression that moves it after the body is reported as itself instead of
 * quietly turning every page into an empty one. `where` is its block index,
 * which is 1 for a page that honours the contract and higher only when the tool
 * has something to say first.
 *
 * @param {string} text - the rendered page.
 * @returns {{ header: string, footer: string, body: string, where: number }} the parts.
 */
function splitPage(text) {
  const blocks = String(text ?? '').split('\n\n')
  const where = blocks.findIndex((block) => CURSOR_LINE.test(block))
  if (where === -1) return { header: blocks[0] ?? '', footer: '', body: blocks.slice(1).join('\n\n'), where }
  const body = where <= 1 ? blocks.slice(where + 1).join('\n\n') : blocks.slice(1, where).join('\n\n')
  return { header: blocks[0] ?? '', footer: blocks[where], body, where }
}

/**
 * Where a page says its own characters begin.
 *
 * A truncated window is labelled in the footer, because its true start is the
 * engine's CLAMPED offset and can differ from the one that was requested — that
 * difference is the whole bug. A window that fits in one piece is the document
 * itself, carries no label, and starts where the read was asked to start.
 *
 * @param {string} text - the rendered page.
 * @param {number} requested - the offset this page was asked for.
 * @returns {number} the character offset the page claims to start at.
 */
function claimedStartOf(text, requested) {
  const claim = /this page starts at (\d+)/.exec(String(text ?? ''))
  return claim ? Number(claim[1]) : requested
}

/**
 * Walk the whole document the way a model does.
 *
 * Every page is measured twice: once as the canonical value the tool returned,
 * and once as the block the registry would actually send — rendered, projected
 * and bounded by the tool's own registered finisher. Only the second one counts
 * for coverage; the first is kept because the cursor, `hasMore` and the claims
 * the page makes about itself all live there.
 *
 * @param {number} size - the document length.
 * @param {number} maxChars - the per-page budget.
 * @param {(size: number) => string} [build] - how the document is written.
 * @returns {Promise<{ pages: Array<any>, terminated: boolean, delivered: Array<string> }>} the walk.
 */
async function walk(size, maxChars, build = document_) {
  CURRENT.size = size
  CURRENT.document = build(size)
  CURRENT.last = null
  await registry.get('camofox_open').execute({ url: 'https://example.com/', readPage: false }, execution)
  const read = registry.get('camofox_read')
  const pages = []
  const delivered = []
  // Every page must deliver at least `min(maxChars, what the content budget
  // leaves)` characters except the last, so a correct walk cannot need more than
  // `size / 200 + 1` of them. The floor is the smallest budget the tool accepts;
  // anything larger only terminates sooner, and a walk that does not is a bug the
  // cap must catch, not hide.
  const limit = Math.ceil(size / 200) + 16
  let offset
  for (let page = 0; page < limit; page += 1) {
    const args = { mode: 'snapshot', maxChars, offset }
    const value = await read.execute(args, execution)
    // The real pipeline, in the registry's order: render the canonical value,
    // let the tool project its own content, then let the tool bound it. The
    // result is what a provider is handed.
    const rendered = read.output.render(args, value)
    const projected = read.projectContent?.(execution, { content: rendered, isError: false }) ?? rendered
    const bounded = read.finalizeContent?.(execution, { content: projected }) ?? projected
    const seen = deliveredContent(bounded[0].text)
    const parts = splitPage(seen)
    delivered.push(seen)
    pages.push({
      index: page,
      sent: offset ?? 0,
      start: claimedStartOf(seen, offset ?? 0),
      next: value.nextOffset ?? null,
      hasMore: value.hasMore === true,
      total: value.totalChars,
      // The DELIVERED body, not the canonical one: coverage is what a model read.
      body: parts.body,
      cursorAt: parts.where,
      served: CURRENT.last,
      whole: seen,
      // Kept only to assert that the finisher did not have to touch this page.
      trimmed: bounded !== projected,
      canonicalLength: String(value.content ?? '').length,
    })
    if (value.hasMore !== true) return { pages, terminated: true, delivered }
    if (!(Number.isFinite(value.nextOffset) && value.nextOffset > pages[page].start)) return { pages, terminated: false, delivered }
    offset = value.nextOffset
  }
  return { pages, terminated: false, delivered }
}

/**
 * Measure what one page actually delivered.
 *
 * The longest run of leading characters that matches the document at the
 * position the page claims is exactly the stretch that page handed back. It is
 * measured from the DELIVERED text — the block after the registry's own budget —
 * rather than from the canonical value, because a gap is not a property of what
 * a tool returned but of what a model read. It is measured from that text and
 * never from cursors, because a cursor that jumps ahead of the content it came
 * with is a gap and only the content can show that.
 *
 * @param {any} page - one page of a walk, annotated in place.
 * @param {string} documentText - the document being paged.
 * @returns {number} how many characters the page delivered from its claimed start.
 */
function measureRun(page, documentText) {
  const from = page.start
  let run = 0
  while (run < page.body.length && from + run < documentText.length && page.body[run] === documentText[from + run]) run += 1
  page.run = run
  return run
}

/**
 * Hold one walk to every invariant, with messages that name the failure.
 *
 * @param {Awaited<ReturnType<typeof walk>>} result - the walk.
 * @param {number} size - the document length.
 * @param {number} maxChars - the per-page budget.
 * @param {(size: number) => string} [build] - how the document was written.
 */
function assertPaging(result, size, maxChars, build = document_) {
  const where = `a ${size}-character document at maxChars=${maxChars}`
  const { pages } = result
  assert.ok(pages.length > 0, `${where} returned no pages`)
  assert.ok(
    result.terminated,
    `${where} never finished paging: ${pages.length} pages, the last at offset ${pages.at(-1).sent} still reporting hasMore:true with cursor ${pages.at(-1).next}`,
  )

  const last = pages.at(-1)
  assert.equal(last.hasMore, false, `${where} finished on a page that still claims more content`)
  assert.equal(last.next, null, `${where} finished on a page that still hands back a cursor`)
  assert.match(last.whole, /end of document/, `${where} finished without saying it reached the end of the document`)

  for (const page of pages) {
    const at = `${where}, page ${page.index} (offset ${page.sent})`
    assert.equal(page.total, size, `${at} reported the wrong document length (${page.total})`)
    assert.ok(page.served, `${at} never reached the engine`)
    // The defect this file was rewritten for: a page that fits the caller's
    // `maxChars` can still be too big for the tool's content budget, which then
    // cuts it — and a cut the cursor has already stepped past is a region no
    // later offset ever returns to. So no page may need trimming at all, and
    // this is measured on the block the registry really sends.
    assert.equal(page.trimmed, false, `${at} did not fit the tool's content budget: ${page.canonicalLength} characters of snapshot were trimmed to the budget, and the cursor is ${page.next}`)
    // A window the engine truncated was CLAMPED to where it could start, so the
    // page has to report that start and not the one that was requested — paging
    // from the requested offset is what let a cursor repeat its own window. A
    // window that fits is the document itself, the engine ignores the offset,
    // and the page is simply where the read was resumed.
    if (page.served.truncated) {
      assert.equal(page.start, page.served.served, `${at} says it starts at ${page.start}, but the engine served a window starting at ${page.served.served}`)
    } else {
      assert.equal(page.start, page.sent, `${at} is a window the engine did not truncate, so it should start where the read was resumed`)
    }
    // The cursor line is printed before the body on purpose, so that a budget
    // trimming the body from the end can never trim away the instruction that
    // continues the read. Asserted twice: that it is there in the delivered
    // text, and that it was in front of the body to begin with.
    const instruction = page.hasMore ? `offset=${page.next}` : 'end of document'
    assert.equal(page.cursorAt, 1, `${at}: the cursor line is block ${page.cursorAt}, not printed before the body, so trimming the body can trim it away`)
    assert.ok(page.whole.includes(instruction), `${at}: the content budget trimmed away "${instruction}"`)
  }

  const documentText = build(size)
  const ranges = []
  for (const page of pages) {
    const at = `${where}, page ${page.index} (offset ${page.sent})`
    const run = measureRun(page, documentText)
    if (page.hasMore) {
      assert.ok(page.next > page.start, `${at} handed back cursor ${page.next}, which does not move forward from ${page.start}`)
      // Whatever else the page carried — the engine's marker and its repeated
      // navigation tail ride along whenever a whole window is delivered — the
      // cursor may not sit past what the reader was actually shown, or those
      // characters are gone for good.
      assert.ok(page.next >= page.start + run, `${at} skipped ${page.next - page.start - run} characters nobody was ever shown`)
      ranges.push([page.start, page.start + run])
    } else {
      // The final window repeats the document's navigation tail after its chunk,
      // so a finished read has delivered the document up to its last character.
      const tail = Math.min(SNAPSHOT_TAIL_CHARS, page.body.length)
      assert.ok(
        page.start + run >= size - Math.min(SNAPSHOT_TAIL_CHARS, size),
        `${at} stopped ${size - page.start - run} characters short of the document's tail`,
      )
      assert.ok(documentText.endsWith(page.body.slice(-tail)), `${at} did not carry the end of the document`)
      ranges.push([page.start, size])
    }
  }

  // Every page begins at or after the end of the one before it: the cursor never
  // moves backwards, and no page re-serves the middle of a window under a cursor
  // the engine has already gone past.
  let cursor = 0
  for (const page of pages) {
    assert.ok(page.start >= cursor, `${where}: page ${page.index} starts at ${page.start}, back behind ${cursor}`)
    cursor = page.hasMore ? page.next : size
  }

  // Coverage is the invariant both historical bugs break, from opposite sides:
  // re-deriving the cursor from `snapshot.length` leaves a gap before the end,
  // and trusting the window's own length declares the end half-way through.
  let reached = 0
  for (const [from, to] of ranges.sort((a, b) => a[0] - b[0])) {
    assert.ok(from <= reached, `${where}: characters ${from}-${to} were never delivered — the read stops at ${reached}`)
    reached = Math.max(reached, to)
  }
  assert.equal(reached, size, `${where}: the read ended after ${reached} of ${size} characters`)
}

test('every document size and budget reaches the end, with no gap and no cursor the engine refuses', async () => {
  for (const size of SIZES) {
    for (const maxChars of BUDGETS) {
      assertPaging(await walk(size, maxChars), size, maxChars)
    }
  }
})

test('a budget larger than a whole window delivers the window the budget cut', async () => {
  // The exact defect the paging rework existed to prevent, reintroduced one
  // layer up: `maxChars` at or above the engine's chunk length meant "deliver
  // this window whole", the registry then cut it at 40 000 characters, and the
  // cursor stepped to 74 800 — so everything between the cut and the cursor was
  // returned by no offset, ever. 35 000-odd characters, silently, on every large
  // read whose budget was generous. Each of these was reported as "covered" by a
  // guard that measured the canonical value instead of the delivered block.
  for (const [size, maxChars] of REVIEWER_CASES) {
    const result = await walk(size, maxChars)
    assertPaging(result, size, maxChars)
    const cut = result.pages.find((page) => page.trimmed)
    assert.equal(cut, undefined, `a ${size}-character document at maxChars=${maxChars} still produced a page the content budget had to cut`)
  }
})

test('a page of characters JSON must escape still fits the budget, and still reaches the end', async () => {
  // Every newline and quote in a page costs two characters of the content
  // budget, because the registry sends the snapshot inside a JSON string. A
  // split threshold that counted characters rather than delivered characters
  // would pass the whole matrix above and still lose the tail of every real
  // page, which is nothing but newlines and quotes.
  for (const [size, maxChars] of [
    [80_001, 74_800],
    [80_001, 20_000],
    [200_000, 159_769],
    [200_000, 20_000],
  ]) {
    assertPaging(await walk(size, maxChars, escapedDocument_), size, maxChars, escapedDocument_)
  }
})

test('every tool that renders a snapshot fits its own content budget', async () => {
  // `renderSnapshot` is told each tool's bound rather than guessing it, so this
  // asserts the wiring: the page a tool builds is one ITS OWN finisher can carry,
  // with the canonical fields that tool returns competing for the same block.
  CURRENT.size = 200_000
  CURRENT.document = document_(CURRENT.size)
  CURRENT.last = null
  const cases = [
    ['camofox_open', { url: 'https://example.com/', maxChars: 400_000 }],
    ['camofox_search', { macro: '@google_search', query: 'camoufox', maxChars: 400_000 }],
    ['camofox_read', { mode: 'snapshot', maxChars: 400_000 }],
  ]
  for (const [name, args] of cases) {
    const definition = registry.get(name)
    const value = await definition.execute(args, execution)
    const rendered = definition.output.render(args, value)
    const bounded = definition.finalizeContent?.(execution, { content: rendered }) ?? rendered
    assert.deepEqual(bounded, rendered, `${name} built a page its own content budget had to trim`)
    // And the page really is a page of the document, not an empty stub a smaller
    // budget would have produced to stay under it.
    assert.ok(
      deliveredContent(bounded[0].text).length > 1_000,
      `${name} shrank its page to ${deliveredContent(bounded[0].text).length} characters to fit the budget`,
    )
  }
})

test('the last page is the engine\'s final window, delivered whole', async () => {
  // The final window is the one page that cannot be narrowed: past it there is
  // no offset left to ask for, so it has to say that out loud rather than hand
  // back a cursor the engine will clamp to the window it just served. It is
  // still not exempt from the content budget — a final window's chunk runs from
  // the cursor to the end of the document and is anything up to 74 800
  // characters, so it is subdivided like any other until what remains fits.
  const size = 200_000
  const { pages } = await walk(size, 200)
  const final = pages.at(-1)
  assert.ok(final.served.hasMore === false, 'the last page was not the engine\'s final window')
  assert.ok(final.body.length > 200, `the final window was cut to the ${200}-character budget, which leaves its remainder unreachable`)
  assert.match(final.whole, /final window of the document/, 'the final window did not explain why it is larger than maxChars')
  // And the walk reached that window only by paging through the part of it that
  // did not fit, which is the case the old exemption lost.
  assert.ok(pages.length > 1, 'the final window was the first page, so its subdivision was never exercised')
  const split = pages.filter((page) => /remainder of that window continues at this offset/.test(page.whole))
  assert.ok(split.length > 0, 'a final window larger than the budget was never subdivided')
})

test('the copied windowing still matches the engine, when the checkout is present', async (t) => {
  if (!existsSync(ENGINE_CHECKOUT)) {
    t.skip(`camofox-browser checkout not found at ${ENGINE_CHECKOUT}`)
    return
  }
  const engineModule = await import(pathToFileURL(ENGINE_CHECKOUT).href)
  assert.equal(engineModule.MAX_SNAPSHOT_CHARS, MAX_SNAPSHOT_CHARS)
  assert.equal(engineModule.SNAPSHOT_TAIL_CHARS, SNAPSHOT_TAIL_CHARS)
  for (const size of SIZES) {
    for (const offset of [0, 1, 74_800, 149_600, size - 1]) {
      assert.deepEqual(
        engineModule.windowSnapshot(document_(size), offset),
        windowSnapshot(document_(size), offset),
        `windowSnapshot diverged at size=${size} offset=${offset}`,
      )
    }
  }
})