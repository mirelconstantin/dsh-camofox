/**
 * Native model-facing browser tools for DeepSeek Harness.
 *
 * The previous integration exposed 26 narrow MCP tools that overlapped heavily,
 * ignored cancellation and timeouts, and hid four broken ones behind confident
 * descriptions. These are sixteen tools with wide, explicitly bounded jobs:
 * each one validates its own arguments, classifies engine failures, and
 * returns a typed canonical value plus bounded model-facing text.
 *
 * @module dsh-camofox/tools
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer as httpNet } from 'node:http'
import { spawn as spawnProc } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { SERVE_TTL_MS, isAlive, readRegistry, startServe, startWatchdog, stopAll } from './serve.js'
import { CamofoxBridge, SEARCH_MACROS, unwrapEvaluate } from './bridge.js'
import { EngineError } from './engine.js'
import { filterInteractive, scopeSnapshot } from './snapshot-filter.js'
import { FINGERPRINT_PROBE, fingerprintTensions } from './fingerprint.js'
import { clampInt, isRecord, page as pageText, truncate } from './util.js'
import { mirrorSite } from './mirror.js'

/** Media types the harness attachment store accepts as an image. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * What `camofox_read` can read, and the one list its schema enum and its
 * validation are both built from.
 *
 * A JSON Schema `enum` is advice to the model, not a runtime check: the harness
 * does not validate tool arguments against it. So the same set has to be
 * enforced in the body, or an unrecognised mode reaches a literal map, indexes
 * it to `undefined`, and the request goes out with no script in it.
 */
const READ_MODES = new Set(['snapshot', 'text', 'markdown', 'links', 'images', 'html', 'stats'])

/**
 * Build a per-call image projection pair.
 *
 * Image bytes are execution-local: they are stashed against the execution and
 * converted into durable attachments by `projectContent`, so the canonical value
 * that is logged stays small.
 *
 * The stashed blocks are returned by `project` at the TOP LEVEL. There is no
 * `images` content block in the harness vocabulary — every provider adapter maps
 * a block with a `switch` over `text` and `image` and drops anything else — so
 * wrapping them would make the model receive an empty result while the tool
 * still claims an attachment exists.
 *
 * @returns {{ stash: (exec: any, blocks: Array<any>) => void, project: (exec: any) => Array<any> | undefined }} the helpers.
 */
function createImageProjection() {
  /** @type {WeakMap<object, Array<any>>} */
  const projections = new WeakMap()
  return {
    stash(exec, blocks) {
      projections.set(exec, blocks)
    },
    project(exec) {
      const blocks = projections.get(exec)
      if (!blocks) return undefined
      projections.delete(exec)
      return blocks.length > 0 ? blocks : undefined
    },
  }
}

/**
 * Store image bytes as durable attachments when the current model accepts them.
 *
 * @param {any} ctx - plugin context carrying optional attachment and model services.
 * @param {any} exec - the tool execution.
 * @param {Array<{ data: Buffer, mediaType: string }>} images - decoded images.
 * @returns {Promise<Array<{ type: 'text', text: string } | { type: 'image', attachment: any }>>} model-facing content.
 */
async function admitImages(ctx, exec, images) {
  const usable = images.filter((image) => IMAGE_MEDIA_TYPES.has(image.mediaType) && image.data?.length > 0)
  if (usable.length === 0) {
    return [{ type: 'text', text: '[no displayable image was produced]' }]
  }
  const attachments = ctx.get('attachments')
  const llm = ctx.get('llm')
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  let reason = ''
  if (!attachments) reason = 'no attachment store is mounted'
  else if (!llm || provider === undefined || model === undefined) reason = 'the current model route could not be resolved'
  else {
    try {
      const info = await llm.resolveModelInfo(provider, model, exec.signal)
      if (!info.inputModalities?.includes('image')) reason = `model "${model}" does not declare image input`
    } catch (error) {
      reason = `the current model route could not be verified (${error.message})`
    }
  }
  if (reason) {
    return usable.map((image) => ({
      type: 'text',
      text: `[image unavailable: ${image.mediaType}; ${reason}; the capture was still written to disk when savePath was given]`,
    }))
  }
  try {
    const refs = await attachments.saveImages(usable)
    return refs.map((attachment) => ({ type: 'image', attachment }))
  } catch (error) {
    return [{ type: 'text', text: `[image could not be stored: ${error.message}]` }]
  }
}

/**
 * Turn a canonical tool value into complete model-facing text.
 *
 * There is deliberately no budget here. A budget applied to the serialised
 * object cuts the trailing keys — which are exactly the paging fields — and
 * hands the model invalid JSON with no way to continue reading. The bound
 * belongs in {@link boundedContent}, the content-only last-mile hook the tool
 * registry provides for exactly this.
 *
 * @param {any} value - the canonical value.
 * @returns {string} the rendered text.
 */
function renderValue(value) {
  if (typeof value === 'string') return value
  if (value?.text) return String(value.text)
  return JSON.stringify(value, null, 2)
}

/**
 * Build the `finalizeContent` finisher that enforces one tool's character budget.
 *
 * `finalizeContent` runs after `projectContent`, so it must pass every non-text
 * block through untouched — `camofox_capture` installs its screenshot through
 * `projectContent`, and a finisher that rebuilt the array from text blocks alone
 * would silently delete every image attachment. It also replaces only the
 * content: the canonical value, `isError`, structured error identity and
 * presentation metadata stay registry-owned.
 *
 * @param {number} budget - character budget across this result's text blocks.
 * @returns {(exec: any, result: any) => Array<any> | undefined} the finisher.
 */
function boundedContent(budget) {
  return (_exec, result) => {
    const blocks = Array.isArray(result?.content) ? result.content : []
    if (blocks.length === 0) return undefined
    let left = budget
    let changed = false
    const next = []
    for (const block of blocks) {
      if (block?.type !== 'text' || typeof block.text !== 'string') {
        next.push(block)
        continue
      }
      if (block.text.length > left) {
        next.push({ type: 'text', text: truncate(block.text, Math.max(left, 0), 'result') })
        left = 0
        changed = true
        continue
      }
      left -= block.text.length
      next.push(block)
    }
    return changed ? next : undefined
  }
}

/**
 * Normalise any thrown value into a short, actionable model-facing message.
 *
 * The `[action: …]` suffixes are the part that matters: a model that is told only
 * what went wrong spends the turn guessing. Each one names the next call to make.
 * A `retryable` engine error gets one too, because that flag was already set on the
 * error object and never reached the model — so "the engine is temporarily
 * unavailable" used to read as a dead end when it is the one case worth retrying.
 *
 * @param {unknown} error - thrown value.
 * @returns {string} the message.
 */
function explainError(error) {
  if (!(error instanceof EngineError)) {
    return error instanceof Error ? error.message : String(error)
  }
  const actions = []
  if (error.needsNewTab) actions.push('open a new tab and continue')
  if (error.needsResnapshot) actions.push('read the page again before interacting')
  // Only when nothing more specific applies, so the two never compete.
  if (actions.length === 0 && error.retryable === true) actions.push('retry the same call once')
  return actions.length === 0 ? error.message : `${error.message} [action: ${actions.join('; ')}]`
}

/**
 * Validate the common "which element" arguments.
 *
 * @param {any} args - tool arguments.
 * @returns {{ ref?: string, selector?: string }} the routing fields.
 */
function target(args) {
  const result = {}
  if (typeof args.ref === 'string' && args.ref.trim() !== '') result.ref = args.ref.trim()
  if (typeof args.selector === 'string' && args.selector.trim() !== '') result.selector = args.selector.trim()
  return result
}

/**
 * Write bytes to an absolute path, creating parent directories.
 *
 * Paths are unrestricted by owner decision, so the risk is not *where* this
 * writes but that a model mistake silently destroys a real file. Two honest
 * behaviours, both keeping today's one-call ergonomics: the write always
 * happens, and the result reports whether it replaced something. A caller that
 * wants consent first passes `overwrite: false` and gets a refusal instead.
 *
 * @param {string | undefined} savePath - destination path.
 * @param {Buffer | string} data - payload.
 * @param {{ overwrite?: boolean }} [options] - `overwrite:false` refuses an existing file.
 * @returns {{ path: string, replacedExisting: boolean, previousBytes: number | null, refused: boolean, reason?: string } | undefined} the outcome.
 */
function writeArtifact(savePath, data, options = {}) {
  if (typeof savePath !== 'string' || savePath.trim() === '') return undefined
  const target = savePath.trim()
  let replacedExisting = false
  let previousBytes = null
  if (existsSync(target)) {
    replacedExisting = true
    try {
      previousBytes = statSync(target).size
    } catch {
      previousBytes = null
    }
    if (options.overwrite === false) {
      return {
        path: target,
        replacedExisting,
        previousBytes,
        refused: true,
        reason: `refused: ${target} already exists (${previousBytes ?? 'unknown size'} bytes)`,
      }
    }
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, data)
  return { path: target, replacedExisting, previousBytes, refused: false }
}

/**
 * One clause naming what happened to a destination file.
 *
 * @param {{ path: string, replacedExisting: boolean, previousBytes: number | null } | undefined} written - the write outcome.
 * @returns {string} the model-facing note.
 */
function writeNote(written) {
  if (!written) return ''
  return written.replacedExisting
    ? ` — it REPLACED an existing file of ${written.previousBytes ?? 'unknown'} bytes`
    : ''
}

/**
 * Decode a base64 payload that may arrive bare or as a data URL.
 *
 * @param {string | undefined} value - engine-supplied data.
 * @returns {Buffer} the decoded bytes.
 */
function decodeDataUrl(value) {
  if (typeof value !== 'string' || value === '') throw new Error('the engine returned no downloadable data')
  const comma = value.indexOf(',')
  const base64 = value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value
  return Buffer.from(base64, 'base64')
}

/** The trailing characters the engine repeats onto every window for navigation refs. */
const SNAPSHOT_TAIL_CHARS = 5000

/**
 * Surface the engine's own navigation verdict.
 *
 * The engine returns `httpStatus` and `navigationOk` from tab creation
 * (server.js:3048-3049) and from navigation (server.js:3494-3495). They are the
 * only signal that separates a page that loaded from a page that rendered an
 * error document: a 404 with a perfectly readable body is otherwise
 * indistinguishable from success. A `content:` or `about:` page has no HTTP
 * status at all, so both fields are emitted only when the engine sent them.
 *
 * @param {Record<string, any>} payload - an engine response.
 * @returns {{ httpStatus?: number, navigationOk?: boolean, note?: string }} the fields to merge into a tool result.
 */
/**
 * Surface a search fallback the engine performed behind the model's back.
 *
 * When Google blocks, the engine tries other engines and reports which one
 * answered: `searchEngine` and `fallbackFrom` on success (server.js:3348),
 * `googleBlocked` and `searchFallbackAttempted` when it could not get an answer
 * at all (server.js:3482-3483). Silently substituting an engine changes what the
 * results mean, so the model is told which engine produced them.
 *
 * @param {Record<string, any>} payload - the engine's open/navigate response.
 * @returns {Record<string, any>} the fields to merge into a tool result.
 */
export function searchProvenance(payload) {
  if (!isRecord(payload)) return {}
  const fields = {}
  if (typeof payload.fallbackFrom === 'string' && typeof payload.searchEngine === 'string') {
    fields.searchEngine = payload.searchEngine
    fields.fallbackFrom = payload.fallbackFrom
    fields.note = `these results came from ${payload.searchEngine}, not ${payload.fallbackFrom}, because ${payload.fallbackFrom} served a bot check; treat them as that engine's ranking, not ${payload.fallbackFrom}'s`
  } else if (payload.googleBlocked === true) {
    fields.googleBlocked = true
    fields.searchFallbackAttempted = payload.searchFallbackAttempted === true
    fields.note = payload.searchFallbackAttempted === true
      ? 'the search engine served a bot check and every fallback engine also failed; there are no results to trust here'
      : 'the search engine served a bot check and no fallback engine was available'
  }
  return fields
}

/**
 * Apply the snapshot reductions `camofox_read` offers, before the page is priced.
 *
 * `interactive` keeps the actionable nodes and each one's subtree; `scope` keeps
 * one subtree. Neither renumbers the engine's refs, so every `e` in the reduced
 * page is still valid for `camofox_act` — that is the property which makes the
 * reduction safe rather than merely shorter.
 *
 * @param {any} payload - the engine's snapshot payload.
 * @param {any} args - the tool arguments.
 * @returns {any|null} the reduced payload, or null when neither option applies.
 */
function reduceSnapshot(payload, args) {
  const wantInteractive = args.interactive === true
  const scope = typeof args.scope === 'string' ? args.scope.trim() : ''
  if (!wantInteractive && !scope) return null

  const original = String(payload?.snapshot ?? '')
  let text = original
  const notes = {}

  if (scope) {
    const scoped = scopeSnapshot(original, scope)
    // Naming the scope rather than quietly returning the whole page: a typo here
    // would otherwise look like a page that contains no elements at all.
    if (scoped === null) {
      throw new Error(`no node's role or name contains "${scope}"; read the page without scope to see what is there, or scope to a role such as navigation, main, or a visible name`)
    }
    text = scoped
    notes.scope = scope
  }

  if (wantInteractive) {
    const out = filterInteractive(text)
    text = out.text
    notes.interactive = true
    notes.nodesKept = out.kept
    notes.nodesTotal = out.total
  }

  // The paging fields describe the UNFILTERED engine document. Reporting them
  // against a reduced page would invite a resume at offsets that no longer
  // address this text, so a reduced read declares itself complete.
  return {
    ...payload,
    snapshot: text,
    totalChars: text.length,
    truncated: false,
    hasMore: false,
    nextOffset: null,
    filtered: true,
    notes,
  }
}

export function navigationFields(payload) {
  if (!isRecord(payload)) return {}
  const fields = {}
  if (typeof payload.httpStatus === 'number') fields.httpStatus = payload.httpStatus
  // `navigationOk` is `httpStatus === null || httpStatus < 400` server-side, so
  // a false is always meaningful and a missing value must stay missing.
  if (typeof payload.navigationOk === 'boolean') {
    fields.navigationOk = payload.navigationOk
    if (!payload.navigationOk) {
      fields.note = `the server answered HTTP ${payload.httpStatus}; the page may be an error document rather than what you asked for`
    }
  }
  return fields
}

/**
 * The largest character budget a snapshot-rendering tool accepts.
 *
 * One engine window is at most 80 000 characters, so a page can never carry
 * more than a whole window: a larger number buys nothing and only hides a
 * caller mistake. 200 000 is also the ceiling `resolveConfig` puts on
 * `defaultMaxChars`, so `maxChars` means the same thing to every tool.
 */
const SNAPSHOT_MAX_CHARS = 200_000

/**
 * The content budgets, one per tool that renders a snapshot.
 *
 * These are the SAME numbers those tools hand to {@link boundedContent}, and
 * that is the entire point of naming them once. The registry bounds the
 * rendered block AFTER `execute` returns, so a page built against the caller's
 * `maxChars` alone can be cut in a place no cursor ever returns to — the gap
 * this constant exists to prevent. The tool knows its own bound, so it hands
 * the bound to {@link renderSnapshot}; a number written twice in one file
 * would drift.
 */
const OPEN_CONTENT_BUDGET = 40_000
const READ_CONTENT_BUDGET = 40_000
const SEARCH_CONTENT_BUDGET = 30_000

/**
 * How many characters at the head of a truncated engine window are real content.
 *
 * A truncated window is `chunk + marker + tail`, where the tail is a repeat of
 * the document's last 5 000 characters. Only the chunk advances the document
 * cursor, so only the chunk may be split.
 *
 * The marker is located by its stable opening text; its position is the exact
 * end of the chunk. The fallback — subtract the tail alone — OVER-estimates, by
 * the marker (or by the single separator newline on the one window that has no
 * marker), and the engine omits the marker only on its final window, which is
 * never split. So an over-estimate can never reach a cursor; it is still bounded
 * by the caller against the furthest offset the engine will actually serve.
 *
 * @param {string} body - the engine's window text.
 * @param {number} totalChars - the whole document's length.
 * @returns {number} an upper bound on the chunk length.
 */
function chunkLengthOf(body, totalChars) {
  const tail = Math.min(SNAPSHOT_TAIL_CHARS, Math.max(0, totalChars))
  const markerAt = body.lastIndexOf('\n[... truncated at char ')
  const found = markerAt > 0 ? markerAt : Math.max(0, body.length - tail)
  return Math.min(body.length, found)
}

/**
 * Convert an engine snapshot payload into model-facing text.
 *
 * The engine windows the document itself (`camofox-browser/lib/snapshot.js`),
 * so `snapshot` is a *window*, not the page: when the document is large it is a
 * chunk of the document, a truncation marker, and the last 5 000 characters so
 * navigation refs are always in view. `totalChars`, `hasMore` and `nextOffset`
 * are therefore coordinates in the whole document, never in `snapshot`.
 *
 * This used to re-derive them from `snapshot.length`, which made a long read
 * report "you have reached the end" with roughly half the document unread.
 *
 * ## The rule this function implements
 *
 * **A page may carry only as many document characters as the model will
 * actually receive, and the split happens whenever that is fewer than the window
 * holds — including on the engine's final window.** The ceiling is
 * `options.contentBudget`, the bound the calling tool's own `finalizeContent`
 * will apply, not `maxChars`: the registry bounds the rendered block after
 * `execute` returns, so a window handed over whole because `maxChars` allowed it
 * is silently cut at the budget and **every character between the cut and the
 * cursor is undelivered forever** — no later offset ever reaches it, because the
 * next window starts after the whole chunk.
 *
 * "As many as the model will actually receive" is not `budget`, because the
 * page is only part of what gets sent. The registry renders the canonical value
 * as pretty-printed JSON and bounds THAT, so a character also costs what JSON
 * escaping costs it (every newline and quote is two), beside the header, the
 * cursor line and the canonical fields around the page. Rather than reserve a
 * guessed constant that can be wrong by thousands — and wrong in the dangerous
 * direction — the page is measured the way it will be sent, with the caller's own
 * `fields`, and one binary search finds the longest page that still fits.
 *
 * ## Why splitting the final window is safe
 *
 * It used to be exempted: when the engine says `hasMore:false` the window
 * already reaches the document's tail, so subdividing it "would mean handing
 * back a cursor the engine has already refused to go past". That reasoning was
 * about a window of a fixed 10 001 characters, and it is wrong for the windows
 * that actually occur. A final window's chunk runs from the cursor to the
 * document's end, which is anything up to 74 800 characters — at
 * `total = 80 001`, a read resuming at 20 000 gets a final window holding
 * 60 001 characters, which the 40 000-character budget cuts by a third. A final
 * window that is over budget is therefore split too, and the cursor it hands
 * back is bounded by `total - 5 000`: the furthest offset the engine will serve.
 * Past that offset the engine clamps and re-serves this same window, but by then
 * everything below it has been delivered, so the bound loses nothing. The tail
 * region `[total - 5 000, total)` is always served, as the window the engine
 * repeats onto every one of them.
 *
 * ## The engine facts this depends on
 *
 * - **The engine clamps the offset it is asked for** — `min(offset, total -
 *   5 000)` — and echoes the clamped start back as `payload.offset`. The window
 *   this call produced starts *there*, not at the offset that was requested.
 *   Paging from the requested offset labels a page with a position its first
 *   character is not at.
 * - **A window's own navigation tail is not new content.** Only the head of a
 *   truncated window advances the document; the tail repeats its last 5 000
 *   characters, so `chunkLength` never counts them and they are delivered for
 *   free by whichever window carries them.
 *
 * `hasMore` is therefore no longer always the engine's own answer, and the
 * change is deliberate: it is the engine's answer OR "this window still holds
 * content that no other window will serve". Both are honest, and the second is
 * the only one that keeps `hasMore:false` off an incomplete read.
 *
 * The cursor line is printed BEFORE the body, so that a result trimmed by
 * anything the plugin does not control still tells the caller how to continue.
 *
 * @param {any} payload - engine snapshot.
 * @param {object} options - rendering options.
 * @param {number} [options.offset] - offset the read was resumed at.
 * @param {number} [options.maxChars] - the caller's budget for one page.
 * @param {number} [options.contentBudget] - the bound this tool's `finalizeContent` will apply.
 * @param {(page: any) => object} options.fields - the canonical value this tool returns, minus `content`.
 * @param {string} [options.prefix] - a line printed before the page, such as a restart notice.
 * @returns {{ text: string, refs: number, totalChars: number, hasMore: boolean, nextOffset: number | null, documentId: string | null }} the rendered parts.
 */
function renderSnapshot(payload, options) {
  // Not optional: the page has to be measured as the registry will send it, and
  // only the caller knows what else goes into that block. Guessing here is the
  // defect this function exists to fix.
  if (typeof options?.fields !== 'function') throw new Error('renderSnapshot needs the fields its caller returns, so a page can be measured against the budget it is actually sent')
  const fields = options.fields
  const body = typeof payload?.snapshot === 'string' ? payload.snapshot : payload?.text ?? JSON.stringify(payload ?? {}, null, 2)
  const totalChars = Number.isFinite(payload?.totalChars) ? payload.totalChars : body.length
  const truncated = payload?.truncated === true
  const engineHasMore = truncated && payload?.hasMore === true
  const requested = clampInt(options.offset, 0, 0)
  const limit = clampInt(options.maxChars, SNAPSHOT_MAX_CHARS, 200, SNAPSHOT_MAX_CHARS)
  const budget = Number.isFinite(options.contentBudget) && options.contentBudget > 0 ? Math.floor(options.contentBudget) : READ_CONTENT_BUDGET
  const prefix = typeof options.prefix === 'string' && options.prefix !== '' ? options.prefix : ''

  // Where this window really starts: the engine's own echo, which is the offset
  // it clamped to. The requested offset is only a fallback for a payload that
  // does not echo one — and the whole document's start for an untruncated one,
  // which the engine always serves from zero.
  const start = truncated ? clampInt(payload?.offset, requested, 0) : requested
  // The furthest offset the engine will serve: past it the offset is clamped
  // back onto the window just read, so a cursor that goes further loses nothing
  // (everything below it is delivered) and can only be served again.
  const servable = Math.max(0, totalChars - SNAPSHOT_TAIL_CHARS)
  // How much of this window is document content the reader has not been shown
  // yet. Bounded by the distance to the navigation tail, which every window
  // repeats: a "chunk" that claims to run past it would credit the reader with
  // characters nobody has read.
  const chunkLength = truncated ? Math.min(chunkLengthOf(body, totalChars), Math.max(0, servable - start)) : Math.max(0, body.length - start)

  /**
   * Build the page that carries `kept` characters of this window.
   *
   * @param {number} kept - how many characters of document content the body holds.
   * @returns {{ text: string, refs: number, totalChars: number, hasMore: boolean, nextOffset: number | null, documentId: string | null }} the page.
   */
  const page = (kept) => {
    // An untruncated window IS the whole document — the engine ignores `offset`
    // here — so a slice of it is a true prefix and the cursor is exact. A
    // truncated window is sliced from its head, which is where the document
    // continues from — unless the whole of it fits, in which case the window
    // rides along as it is, navigation tail and all.
    const slice = !truncated ? body.slice(start, start + kept) : kept < chunkLength ? body.slice(0, kept) : body
    let nextOffset = null
    let hasMore = false
    let note = ''
    if (!truncated) {
      hasMore = start + kept < body.length
      nextOffset = hasMore ? start + kept : null
    } else if (kept < chunkLength) {
      // This window still holds content that no other window will serve, so the
      // read can continue inside it. The cursor is bounded by the furthest
      // offset the engine serves, so every cursor handed out is one the next
      // call really gets.
      nextOffset = Math.min(start + kept, servable)
      hasMore = nextOffset > start
      note = hasMore
        ? `this is the first ${kept} characters of the engine's ${engineHasMore ? 'window' : 'final window'}; the remainder of that window continues at this offset`
        : kept === 0
          ? 'the content budget could not carry even one character of this page, so the read ends here and the document is not fully covered'
          : 'the engine has more content but this window has no offset left to hand back, so the read ends here; the document is not fully covered'
    } else if (engineHasMore) {
      // The whole chunk rides along, so the cursor is the engine's own.
      nextOffset = Number.isFinite(payload?.nextOffset) ? Math.min(payload.nextOffset, servable) : null
      hasMore = nextOffset !== null && nextOffset > start
      if (!hasMore) {
        nextOffset = null
        note = 'the engine reported more content but returned no usable cursor, so the read ends here; the document is not fully covered'
      }
    } else {
      // The window carries every remaining character of the document, its
      // navigation tail included: there is nothing after it and nothing to
      // resume, so it is delivered whole.
      note = `this is the engine's final window of the document: it carries the rest of the document, navigation tail included, it fits the content budget whole, and there is nothing after it to resume`
    }

    const header = [`url: ${payload?.url ?? options.url ?? 'unknown'}`, payload?.title ? `title: ${payload.title}` : null].filter(Boolean).join('  |  ')
    const footer = [`refs: ${payload?.refsCount ?? 0} (use them in camofox_act as ref:"e12")`]
    if (truncated) footer.push(`document: ${totalChars} characters; this page starts at ${start}`)
    footer.push(nextOffset !== null ? `more: call camofox_read again with offset=${nextOffset}` : 'end of document')
    if (note) footer.push(note)
    return {
      // Header and cursor first, body last: a budget that trims the result must
      // not be able to trim away the instruction that continues the read.
      text: [prefix, header, footer.join('  |  '), slice].filter(Boolean).join('\n\n'),
      refs: payload?.refsCount ?? 0,
      totalChars,
      hasMore,
      nextOffset,
      documentId: payload?.documentId ?? null,
    }
  }

  /**
   * What one page costs the model, measured the way it is actually sent.
   *
   * The registry renders the canonical value as pretty-printed JSON and bounds
   * that string, so a page costs its own characters, the JSON escaping of every
   * one of them, and every canonical field around it. `fields` is the caller's
   * own value, which is the only way to know that last part without guessing.
   *
   * @param {number} kept - body length to price.
   * @returns {number} the characters this page costs.
   */
  const cost = (kept) => {
    const candidate = page(kept)
    return renderValue({ ...fields(candidate), content: candidate.text }).length
  }

  // The most a page may carry is the caller's budget and the window's own
  // content — and then whatever the tool's content budget leaves room for.
  let kept = Math.min(limit, chunkLength)
  if (cost(kept) > budget) {
    // A page's cost rises with its body, so one binary search finds the longest
    // page that still fits instead of a reserved constant that can be wrong in
    // the direction that loses characters.
    let low = 0
    let high = kept
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (cost(mid) <= budget) low = mid
      else high = mid - 1
    }
    kept = low
  }
  return page(kept)
}

/**
 * Register every browser tool on a Cordis context.
 *
 * @param {any} ctx - plugin context providing `tools` and `camofox`.
 * @param {CamofoxBridge} bridge - the browser browser.
 * @param {object} config - resolved plugin configuration.
 * @returns {string[]} the registered tool names.
 */
export function registerTools(ctx, bridge, config) {
  /** @type {string[]} */
  const names = []
  /**
   * @param {object} definition - a registry-ready tool definition.
   * @returns {object} the same definition.
   */
  const register = (definition) => {
    ctx.tools.register(definition)
    names.push(definition.name)
    return definition
  }

  /** Common wrapper turning failures into readable tool errors. */
  /**
   * The tool registry builds `ToolErrorInfo` from the thrown value, so a
   * classified {@link EngineError} is rethrown as itself: wrapping it in a plain
   * `Error` discarded `code`, and `tab_not_found` became indistinguishable from
   * `engine_timeout` in the durable result. Only the model-facing message is
   * decorated; the identity is carried through untouched.
   *
   * @template T
   * @param {() => Promise<T>} body - tool body.
   * @returns {Promise<T>} its result.
   */
  const guard = (body) =>
    body().catch((error) => {
      if (error instanceof EngineError) {
        error.message = explainError(error)
        throw error
      }
      const failure = new Error(explainError(error))
      if (typeof error?.name === 'string' && error.name !== '' && error.name !== 'Error') failure.name = error.name
      if (typeof error?.code === 'string' && error.code !== '') failure.code = error.code
      throw failure
    })

  register({
    name: 'camofox_open',
    timeoutMs: 180000,
    description:
      'Open a web page in the Camoufox anti-detection browser and return its tab id. Prefer this over any plain HTTP fetch when a site blocks bots, needs JavaScript, or requires a real user agent. Also the fastest way to test a web app you just changed locally. Accepts a URL, or a search macro plus a query — but for any of the supported engines prefer camofox_search, which does the search and the read in one call; use this tool\'s macro only when you specifically need a waitForSelector or a trace on the results page.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to open, including http:// or https://. Local addresses such as http://127.0.0.1:3000 work.' },
        macro: { type: 'string', enum: [...SEARCH_MACROS], description: 'Search macro to run instead of a URL.' },
        query: { type: 'string', description: 'Search text; required with macro.' },
        sessionKey: { type: 'string', description: 'Optional label grouping this tab with others you open under the same name, e.g. "research" or "checkout". It only organises your own tabs: every tab in this session shares one cookie jar whatever you pass here. Omit it and tabs are grouped by session automatically.' },
        waitForSelector: { type: 'string', description: 'CSS selector to wait for after load, so late-rendered pages are ready before the next call. Use this instead of guessing delays.' },
        waitMs: { type: 'number', description: 'Extra settle time in milliseconds after the page loads. Prefer waitForSelector.' },
        readPage: { type: 'boolean', description: 'Return the page snapshot immediately instead of only navigation metadata. Defaults to true.' },
        trace: { type: 'boolean', description: 'Record a Playwright trace of everything this browser context does, retrievable later with camofox_trace. Use it when a page misbehaves and you need to see why: a stale ref, a click that did nothing, a navigation race. Costs a large archive per session and is flushed when the session closes, so turn it on only while diagnosing.' },
        maxChars: { type: 'number', description: 'Character budget for the returned snapshot when readPage is true.' },
        screenshot: { type: 'boolean', description: 'Ask the engine to include the page PNG in this response. Costs a full-page render and does not display here — use camofox_capture to actually see an image.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(OPEN_CONTENT_BUDGET),
    async execute(args, exec) {
      return await guard(async () => {
        const browser = bridge.for(exec)
        if (!args.url && !args.macro) throw new Error('provide either url or macro')
        if (args.macro && !args.query) throw new Error('macro requires a query')
        const opened = await browser.open({ ...args, trace: args.trace === true }, exec.signal)
        const tabId = browser.resolveTabId(opened.tabId, 'camofox_open')
        let waited
        if (args.waitForSelector) {
          waited = await browser.waitForSelector(tabId, args.waitForSelector, { timeoutMs: args.waitMs ?? 15000 }, exec.signal)
        } else if (args.waitMs) {
          await new Promise((resolve) => setTimeout(resolve, clampInt(args.waitMs, 1000, 0, 60000)))
        }
        const result = {
          tabId,
          url: opened.url ?? '',
          title: opened.title ?? '',
          sessionKey: opened.sessionKey ?? 'default',
          // The engine reports both (server.js:3048-3049) and they are what
          // separates a page that loaded from a page that rendered an error.
          // Without them a 404 with a readable body looks exactly like success.
          ...navigationFields(opened),
          // Reported rather than thrown: the navigation itself succeeded, and
          // `camofox_open` is also the tool a caller uses with `readPage:false`,
          // where failing the whole call would be wrong. `camofox_act` still
          // throws for the same condition, because there the wait is the request.
          ...(waited
            ? { waitedForSelector: waited.selector, selectorMatched: waited.matched, waitedMs: waited.waitedMs }
            : {}),
        }
        if (args.readPage === false) return { ...result, read: false }
        const snapshot = await browser.snapshot(tabId, { screenshot: args.screenshot }, exec.signal)
        // The page is built against this tool's OWN content budget, and the same
        // canonical fields the result below carries, so it is measured as the
        // registry will send it rather than as `maxChars` asked for it.
        const fields = (page) => ({ ...result, read: true, refs: page.refs, totalChars: page.totalChars, hasMore: page.hasMore, nextOffset: page.nextOffset, documentId: page.documentId })
        const rendered = renderSnapshot(snapshot, {
          maxChars: clampInt(args.maxChars, config.defaultMaxChars, 200, SNAPSHOT_MAX_CHARS),
          contentBudget: OPEN_CONTENT_BUDGET,
          fields,
        })
        return { ...fields(rendered), content: rendered.text }
      })
    },
  })

  register({
    name: 'camofox_read',
    timeoutMs: 90000,
    description:
      'Read the current content of a browser tab. Use mode "snapshot" for an accessibility view with e1, e2… element refs you can act on, "text" for readable page text, "markdown" for clean structured text, "links" for crawling and pagination, "images" for assets, "html" for the raw document, "stats" for tab counters. This is the main tool for scraping; modes text, markdown and html run this bundle\'s own fixed extraction script in the page, which the allowEvaluate setting does not disable; prefer them over evaluating JavaScript.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab from camofox_open. Optional when exactly one tab is open.' },
        mode: {
          type: 'string',
          enum: [...READ_MODES],
          description: 'What to read. Defaults to snapshot.',
        },
        offset: { type: 'number', description: 'snapshot: character offset to resume at, using the nextOffset a previous call returned. links: item offset, so nextOffset counts items, not characters. Paging units differ by mode — check offsetUnit in the result before resuming. Ignored by text, markdown, html, images and stats.' },
        maxChars: { type: 'number', description: 'Character budget for this result.' },
        limit: { type: 'number', description: 'Item limit for links and images modes. The engine returns at most 20 images per call.' },
        includeContent: { type: 'boolean', description: 'links and images: also return the same records as a plain text block. Defaults to true; pass false when you only need the structured array.' },
        screenshot: { type: 'boolean', description: 'Ask the engine to include the page PNG alongside the snapshot. Defaults to false; it costs a full-page render and does not display here — use camofox_capture to actually see an image.' },
        includeData: { type: 'boolean', description: 'links or images: include full URLs and inline data. For images this can be very large.' },
        // These two are implemented in reduceSnapshot and the system prompt
        // recommends interactive above every other way of handling a long page,
        // so leaving them out of the schema made the most strongly advised habit
        // in this plugin the one call it could not legally make.
        interactive: { type: 'boolean', description: 'snapshot only: drop non-actionable prose and keep every actionable element with its subtree. Refs are not renumbered, so every returned ref stays valid for camofox_act. Cheaper than maxChars on a long page, because it drops content instead of paging through it.' },
        scope: { type: 'string', description: 'snapshot only: keep only the one subtree whose role or accessible name contains this text, e.g. "navigation", "main", "Search". A scope that matches nothing is an error rather than an empty result.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(READ_CONTENT_BUDGET),
    async execute(args, exec) {
      return await guard(async () => {
        const browser = bridge.for(exec)
        // The schema declares `mode` as an enum, and the harness does not enforce
        // tool arguments against it, so this set is the only thing standing
        // between a model and the fallback below — an unrecognised mode used to
        // index a literal map to `undefined`, which `JSON.stringify` drops: the
        // call "succeeded" against a stub and became an opaque engine error in
        // production. Validated against the same set the schema declares.
        if (args.mode !== undefined && !READ_MODES.has(args.mode)) {
          throw new Error(`"${String(args.mode)}" is not a mode camofox_read can read; use ${[...READ_MODES].join(', ')}`)
        }
        const tabId = browser.resolveTabId(args.tabId, 'camofox_read')
        const mode = args.mode ?? 'snapshot'
        const maxChars = clampInt(args.maxChars, config.defaultMaxChars, 200, SNAPSHOT_MAX_CHARS)
        if (mode === 'snapshot') {
          const resume = Number.isFinite(args.offset) && args.offset > 0 ? args.offset : undefined
          const payload = await browser.snapshot(tabId, { offset: resume, screenshot: args.screenshot }, exec.signal)
          // The engine caches one snapshot per tab and silently drops it on
          // navigation, so a resumed offset is answered with a fresh render of a
          // different document and no error. When the plugin notices that, it
          // restarts the read instead of returning the wrong region quietly.
          const restarted = payload?.staleDocument === true
          // Built against this tool's OWN content budget and its own canonical
          // fields, so the page is measured the way the registry will send it
          // rather than the way `maxChars` asked for it.
          const fields = (page) => ({
            mode,
            tabId,
            url: payload?.url,
            // Paging facts come before `content` so they survive any budget.
            refs: page.refs,
            totalChars: page.totalChars,
            hasMore: page.hasMore,
            nextOffset: page.nextOffset,
            documentId: page.documentId,
            restartedRead: restarted || undefined,
          })
          // Reduce the page BEFORE it is priced and rendered, so the budget is spent on
          // what the model will actually receive. The engine exposes no filter
          // parameter (`server.js:3594-3599`), so both reductions run on the text
          // it returned.
          const reduced = reduceSnapshot(payload, args)
          const rendered = renderSnapshot(reduced ?? payload, {
            maxChars,
            offset: restarted ? undefined : resume,
            contentBudget: READ_CONTENT_BUDGET,
            fields,
            prefix: restarted ? `the page changed under that offset (${payload?.knownTotalChars ?? 'unknown'} → ${payload?.totalChars ?? 'unknown'} characters), so the read restarted from the beginning` : undefined,
          })
          // The reduction notes are merged here rather than through the
          // renderer's `fields` callback: that callback prices the page against
          // the window it will receive, and these describe the reduction rather
          // than the window.
          return { ...fields(rendered), ...reduced?.notes, content: rendered.text }
        }
        if (mode === 'links') {
          const payload = await browser.links(tabId, { limit: args.limit, offset: args.offset ? clampInt(args.offset, 0, 0) : undefined }, exec.signal)
          const links = Array.isArray(payload?.links) ? payload.links : []
          const pagination = payload?.pagination ?? {}
          // One formatter feeds both the structured array and the text block, so
          // they cannot disagree and the engine's field name (`url`; `href`
          // appears only in a stale OpenAPI block) is resolved in one place.
          const rows = links.map((link) => `${link.text ?? ''} → ${link.url ?? link.href ?? ''}`.trim())
          const shown = rows.slice(0, clampInt(args.limit, 200, 1, 1000))
          const includeContent = args.includeContent !== false
          return {
            mode,
            tabId,
            count: shown.length,
            total: Number.isFinite(pagination.total) ? pagination.total : links.length,
            hasMore: pagination.hasMore === true,
            nextOffset: pagination.hasMore === true ? clampInt(pagination.offset ?? 0, 0) + links.length : null,
            offsetUnit: 'items',
            links: shown,
            content: includeContent
              ? truncate(shown.join('\n'), maxChars, 'link list')
              : `${shown.length} link(s) are in the "links" field; pass includeContent:true for the same rows as text.`,
          }
        }
        if (mode === 'images') {
          const payload = await browser.images(tabId, { includeData: args.includeData === true, limit: args.limit, maxBytes: 2_000_000 }, exec.signal)
          const images = Array.isArray(payload?.images) ? payload.images : []
          const shown = images.slice(0, 200).map((image) => ({ src: image.src, alt: image.alt ?? '' }))
          const includeContent = args.includeContent !== false
          return {
            mode,
            tabId,
            count: shown.length,
            limitNote: 'the engine returns at most 20 images per call, whatever limit is passed',
            images: shown,
            content: includeContent
              ? truncate(shown.map((image) => `${image.alt || '(no alt)'} → ${image.src}`).join('\n'), maxChars, 'image list')
              : `${shown.length} image(s) are in the "images" field; pass includeContent:true for the same rows as text.`,
          }
        }
        if (mode === 'stats') {
          const payload = await browser.stats(tabId, exec.signal)
          const visited = Array.isArray(payload?.visitedUrls) ? payload.visitedUrls : []
          // The engine serialises a tab's whole visit history with no limit and
          // the route has no pagination parameter, so this is the one unbounded
          // field here and the character budget has to bound it.
          const kept = visited.slice(-200)
          return {
            mode,
            tabId,
            visitedUrls: kept.length,
            earlierVisitsWithheld: visited.length - kept.length,
            content: truncate(JSON.stringify({ ...payload, visitedUrls: kept }, null, 2), maxChars, 'tab stats'),
          }
        }
        const script = {
          text: `(() => { const el = document.querySelector('main, article, [role=main]') || document.body; return (el.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim(); })()`,
          markdown:
            `(() => { const el = document.querySelector('main, article, [role=main]') || document.body; const md = (n) => { if (n.nodeType === 3) return n.textContent.replace(/\\s+/g,' '); if (n.nodeType !== 1) return ''; const tag = n.tagName.toLowerCase(); const kids = [...n.childNodes].map(md).join(''); if (/^(script|style|noscript|svg)$/.test(tag)) return ''; if (/^h([1-6])$/.test(tag)) return '\\n\\n' + '#'.repeat(+tag[1]) + ' ' + kids.trim() + '\\n\\n'; if (tag === 'li') return '\\n- ' + kids.trim(); if (tag === 'a' && n.href) return '[' + kids.trim() + '](' + n.href + ')'; if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'tr') return kids + '\\n\\n'; return kids; }; return md(el).replace(/\\n{3,}/g, '\\n\\n').trim(); })()`,
          html: `document.documentElement.outerHTML`,
        }[mode]
        const payload = await browser.evaluate(tabId, script, exec.signal)
        const text = typeof payload === 'string' ? payload : String(unwrapEvaluate(payload) ?? '')
        // These three modes return the whole document in one response, so there
        // is nothing to resume from: a character offset would silently re-send
        // the same prefix. Say so rather than ignoring the argument.
        const note =
          Number.isFinite(args.offset) && args.offset > 0
            ? `\n\n[offset is not supported in ${mode} mode: this is the whole document, capped at ${maxChars} characters. Narrow the request, or slice it yourself with camofox_eval.]`
            : ''
        return {
          mode,
          tabId,
          offsetSupported: false,
          content: `${truncate(text, maxChars, mode === 'html' ? 'document' : 'page')}${note}`,
        }
      })
    },
  })

  register({
    name: 'camofox_act',
    timeoutMs: 60000,
    description:
      'Interact with a page: click, type, choose a dropdown option, press a key, scroll, wait for a selector, resize the viewport for a responsive check, upload a file, or move through history. Targets are element refs from camofox_read (ref "e12") or CSS selectors. Use type with mode "keyboard" for rich editors that ignore fast fill.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab from camofox_open. Optional when exactly one tab is open.' },
        action: {
          type: 'string',
          enum: ['click', 'type', 'select', 'press', 'scroll', 'wait', 'waitForSelector', 'waitForUrl', 'upload', 'viewport', 'back', 'forward', 'refresh'],
          description: 'The interaction to perform.',
        },
        ref: { type: 'string', description: 'Element ref from a snapshot, e.g. "e12".' },
        selector: { type: 'string', description: 'CSS selector, used when no ref is available.' },
        text: { type: 'string', description: 'type: the text to enter.' },
        option: { type: 'string', description: 'select: visible option label or HTML value.' },
        key: { type: 'string', description: 'press: key name such as Enter, Escape, Tab, ArrowDown, Control+a.' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'scroll: direction. Defaults to "down".' },
        amount: { type: 'number', description: 'scroll: pixels to move. Defaults to 800, maximum 20000. To reach the bottom of a page, prefer repeated scroll or camofox_read with offset rather than one huge value — a value over the maximum is clamped, not rejected.' },
        clear: { type: 'boolean', description: 'type: clear the field first.' },
        pressEnter: { type: 'boolean', description: 'type: submit the form afterwards.' },
        mode: { type: 'string', enum: ['fill', 'keyboard'], description: 'type: fill is fast, keyboard types key by key for rich editors.' },
        delay: { type: 'number', description: 'type: per-key delay in keyboard mode, in milliseconds.' },
        doubleClick: { type: 'boolean', description: 'click: send a double click.' },
        waitForSelector: { type: 'string', description: 'waitForSelector: CSS selector to wait for.' },
        waitForUrlPattern: { type: 'string', description: 'waitForUrl: regular expression tested against the full page URL, e.g. "/orders/\\\\d+". Use it after an action that navigates within a single-page app, where the URL changes but no load event fires.' },
        visible: { type: 'boolean', description: 'waitForSelector: require the element to be visible, not just present.' },
        timeoutMs: { type: 'number', description: 'wait, waitForSelector, waitForUrl and upload: how long to wait, in MILLISECONDS. Defaults to 15000 for waitForSelector and 12000 for upload; pass e.g. 30000 for 30 seconds. Every timeoutMs in this plugin is milliseconds.' },
        dismissConsent: { type: 'boolean', description: 'wait: also dismiss a cookie or consent dialog first.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'upload: absolute file paths inside the camofox uploads directory.' },
        width: { type: 'number', description: 'viewport: width in pixels.' },
        height: { type: 'number', description: 'viewport: height in pixels.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(12000),
    async execute(args, exec) {
      return await guard(async () => {
        const browser = bridge.for(exec)
        const tabId = browser.resolveTabId(args.tabId, `camofox_act(${args.action})`)
        const where = target(args)
        switch (args.action) {
          case 'click':
            if (!where.ref && !where.selector) throw new Error('click needs ref or selector')
            return { action: 'click', tabId, result: await browser.click(tabId, { ...where, doubleClick: args.doubleClick === true }, exec.signal) }
          case 'type': {
            if (typeof args.text !== 'string') throw new Error('type needs text')
            const result = await browser.type(
              tabId,
              {
                ...where,
                text: args.text,
                clear: args.clear === true,
                pressEnter: args.pressEnter === true,
                submit: args.pressEnter === true,
                mode: args.mode,
                delay: args.delay,
              },
              exec.signal,
            )
            return { action: 'type', tabId, typed: args.text.length, result }
          }
          case 'select': {
            if (typeof args.option !== 'string') throw new Error('select needs option')
            return { action: 'select', tabId, result: await browser.select(tabId, { ...where, option: args.option }, exec.signal) }
          }
          case 'press': {
            if (typeof args.key !== 'string') throw new Error('press needs key')
            return { action: 'press', tabId, result: await browser.press(tabId, args.key, exec.signal) }
          }
          case 'scroll':
            return { action: 'scroll', tabId, result: await browser.scroll(tabId, { direction: args.direction, amount: args.amount }, exec.signal) }
          case 'wait':
            return { action: 'wait', tabId, result: await browser.waitForReady(tabId, { timeoutMs: args.timeoutMs, dismissConsent: args.dismissConsent }, exec.signal) }
          case 'waitForSelector': {
            if (typeof args.waitForSelector !== 'string' || args.waitForSelector.trim() === '') throw new Error('waitForSelector needs a CSS selector')
            const result = await browser.waitForSelector(tabId, args.waitForSelector, { timeoutMs: args.timeoutMs, visible: args.visible === true }, exec.signal)
            if (!result.matched) throw new Error(`"${args.waitForSelector}" did not appear within the timeout; the page may render later, need a different selector, or be blocked`)
            return { action: 'waitForSelector', tabId, ...result }
          }
          case 'waitForUrl': {
            if (typeof args.waitForUrlPattern !== 'string' || args.waitForUrlPattern.trim() === '') {
              throw new Error('waitForUrl needs waitForUrlPattern, a regular expression such as "/orders/\\\\d+"')
            }
            const result = await browser.waitForUrl(tabId, args.waitForUrlPattern, { timeoutMs: args.timeoutMs }, exec.signal)
            if (!result.matched) throw new Error(`the URL never matched ${args.waitForUrlPattern} within the timeout; it is now "${result.url}". The navigation may not have happened, or the pattern may be wrong.`)
            return { action: 'waitForUrl', tabId, ...result }
          }
          case 'upload': {
            const paths = Array.isArray(args.paths) ? args.paths.filter((item) => typeof item === 'string' && item !== '') : []
            if (paths.length === 0) throw new Error('upload needs one or more absolute file paths')
            return { action: 'upload', tabId, files: paths.length, result: await browser.upload(tabId, { paths, ...where, timeoutMs: args.timeoutMs }, exec.signal) }
          }
          case 'viewport': {
            if (!args.width || !args.height) throw new Error('viewport needs width and height')
            return { action: 'viewport', tabId, result: await browser.viewport(tabId, { width: args.width, height: args.height }, exec.signal) }
          }
          default: {
            // Named explicitly rather than forwarded. The schema declares an
            // enum, but the harness does not enforce tool arguments against it,
            // so `default:` is reachable with any text at all — and a typo then
            // surfaced as an opaque engine 404 instead of saying what was wrong.
            if (args.action === 'back' || args.action === 'forward' || args.action === 'refresh') {
              const result = await browser.history(tabId, args.action, exec.signal)
              // History moves are navigations too: going back to a page that is
              // now a 404 must not look like a clean return.
              return { action: args.action, tabId, result, ...navigationFields(result) }
            }
            throw new Error(
              `"${String(args.action)}" is not an action camofox_act can perform; use click, type, select, press, scroll, wait, waitForSelector, waitForUrl, upload, viewport, back, forward or refresh`,
            )
          }
        }
      })
    },
  })

  const captureProjection = createImageProjection()
  register({
    name: 'camofox_capture',
    timeoutMs: 180000,
    description:
      'Capture what the page looks like: a PNG screenshot attached to the conversation, or a PDF of the current document. Use it to verify a UI change, compare responsive breakpoints, or keep a visual record. If the current model cannot accept images the result says so in words instead of showing pixels, so always pass savePath when the image has to outlive the conversation.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab from camofox_open. Optional when exactly one tab is open.' },
        kind: { type: 'string', enum: ['screenshot', 'pdf'], description: 'screenshot renders the viewport; pdf captures the current document resource.' },
        savePath: { type: 'string', description: 'Absolute path to write the bytes to, e.g. C:\\Users\\me\\shot.png. Parent folders are created.' },
        overwrite: { type: 'boolean', description: 'Allow replacing a file that already exists at savePath. Defaults to true, and the result always says whether it replaced something. Pass false to be refused instead.' },
        width: { type: 'number', description: 'screenshot: resize the viewport before capturing.' },
        height: { type: 'number', description: 'screenshot: resize the viewport before capturing.' },
        fullPage: { type: 'boolean', description: 'screenshot: capture the whole scrollable page instead of the viewport. Costs a much larger image on long pages. Defaults to false.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(8000),
    async execute(args, exec) {
      return await guard(async () => {
        const browser = bridge.for(exec)
        const tabId = browser.resolveTabId(args.tabId, 'camofox_capture')
        if (args.kind === 'pdf') {
          await browser.captureCurrentResource(tabId, exec.signal)
          const downloads = await browser.downloads(tabId, { includeData: true, maxBytes: 40_000_000 }, exec.signal)
          const entries = Array.isArray(downloads?.downloads) ? downloads.downloads : []
          const last = entries[entries.length - 1]
          if (!last) throw new Error('the engine captured no downloadable resource; the page may not be a document')
          const bytes = decodeDataUrl(last.data ?? last.base64 ?? last.content)
          const written = writeArtifact(args.savePath ?? join(browser.config.tempDir, `${tabId}.pdf`), bytes, { overwrite: args.overwrite })
          if (written?.refused) throw new Error(`${written.reason}; pass overwrite:true to replace it, or choose another savePath`)
          return {
            kind: 'pdf',
            tabId,
            savedTo: written?.path ?? null,
            replacedExisting: written?.replacedExisting === true,
            bytes: bytes.length,
            content: `PDF captured (${bytes.length} bytes) and written to ${written?.path}${writeNote(written)}`,
          }
        }
        if (args.width && args.height) await browser.viewport(tabId, { width: args.width, height: args.height }, exec.signal)
        const bytes = await browser.screenshot(tabId, { fullPage: args.fullPage === true }, exec.signal)
        const written = writeArtifact(args.savePath, bytes, { overwrite: args.overwrite })
        if (written?.refused) throw new Error(`${written.reason}; pass overwrite:true to replace it, or choose another savePath`)
        // The summary is written AFTER `admitImages` decides, so the model is
        // never told about an attachment that was rejected or never produced.
        const where = written ? `, written to ${written.path}${writeNote(written)}` : ''
        const images = bytes.length > 0 ? await admitImages(ctx, exec, [{ data: bytes, mediaType: 'image/png' }]) : []
        const attached = images.filter((block) => block.type === 'image').length
        const notes = images.filter((block) => block.type === 'text').map((block) => block.text)
        const tail =
          attached > 0
            ? ' and attached to this message'
            : bytes.length === 0
              ? ' but the capture was empty'
              : ' but it could not be attached to the model; see the note below'
        const summary = `Screenshot captured (${bytes.length} bytes)${where}${tail}.`
        // `projectContent` REPLACES the model-visible content, so the image has
        // to travel with the text that describes it — a bare image would leave
        // the call with no explanation, and text alone would leave the model
        // staring at an empty result. Blocks go out at the top level: the
        // harness vocabulary has `text` and `image`, and nothing else.
        if (attached > 0) {
          captureProjection.stash(exec, [
            { type: 'text', text: notes.length > 0 ? `${summary}\n\n${notes.join('\n\n')}` : summary },
            ...images.filter((block) => block.type === 'image'),
          ])
        }
        return {
          kind: 'screenshot',
          tabId,
          savedTo: written?.path ?? null,
          replacedExisting: written?.replacedExisting === true,
          bytes: bytes.length,
          attached,
          content: notes.length > 0 ? `${summary}\n\n${notes.join('\n\n')}` : summary,
        }
      })
    },
    projectContent(exec, result) {
      const pending = captureProjection.project(exec)
      if (!pending || result.isError) return undefined
      return pending.length > 0 ? pending : undefined
    },
  })

  register({
    name: 'camofox_eval',
    timeoutMs: 45000,
    description:
      'Run JavaScript inside the page you are browsing and return its result. Use it for what the reading tools cannot do: read a computed value, fill a field through a framework API, scroll an element into view, or pull data straight out of a page API. Everything the page can see, this can reach, so only run code you trust.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab from camofox_open. Optional when exactly one tab is open.' },
        expression: { type: 'string', description: 'JavaScript expression. Use an IIFE for multi-step work, e.g. (async () => { ... })().' },
        savePath: { type: 'string', description: 'Absolute path to write a large string result to instead of returning it inline.' },
        overwrite: { type: 'boolean', description: 'Allow replacing a file that already exists at savePath. Defaults to true, and the result always says whether it replaced something. Pass false to be refused instead.' },
        maxChars: { type: 'number', description: 'Character budget for the returned value.' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(20000),
    async execute(args, exec) {
      return await guard(async () => {
        const browser = bridge.for(exec)
        if (config.allowEvaluate === false) {
          throw new Error(
            'camofox_eval is disabled by the allowEvaluate configuration setting, so you may not run JavaScript of your own in a page. camofox_read modes text/markdown/html, camofox_scrape in selector mode, and waitForSelector still run this bundle\'s own fixed scripts.',
          )
        }
        // `expression` is the one required argument whose absence would otherwise
        // reach the engine as `undefined` and be evaluated as a script with no code
        // in it — the failure the sibling tools already guard against. A model
        // that sends no expression gets told what to send instead.
        if (typeof args.expression !== 'string' || args.expression.trim() === '') {
          throw new Error(
            'camofox_eval needs an expression; pass a JavaScript expression string such as document.title. It runs in the page, so it must be an expression, not a statement list.',
          )
        }
        const tabId = browser.resolveTabId(args.tabId, 'camofox_eval')
        const payload = await browser.evaluate(tabId, args.expression, exec.signal)
        const value = unwrapEvaluate(payload)
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        const written = writeArtifact(args.savePath, text ?? '', { overwrite: args.overwrite })
        if (written?.refused) throw new Error(`${written.reason}; pass overwrite:true to replace it, or choose another savePath`)
        return {
          tabId,
          savedTo: written?.path ?? null,
          replacedExisting: written?.replacedExisting === true,
          type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
          content: written
            ? `result written to ${written.path}${writeNote(written)}`
            : truncate(String(text ?? ''), clampInt(args.maxChars, config.defaultMaxChars, 200, 400000), 'result'),
        }
      })
    },
  })

  register({
    name: 'camofox_search',
    timeoutMs: 180000,
    description:
      'Run a search on Google, YouTube, Amazon, Reddit, Wikipedia, X, Yelp, Spotify, Netflix, LinkedIn, Instagram, TikTok or Twitch through the anti-detection browser and return the results page already read, plus a parsed link list. Use this instead of a plain search-engine fetch when the site blocks bots, when you need the session\'s login state, or when you intend to act on the results. One call instead of camofox_open plus camofox_read.',
    parameters: {
      type: 'object',
      properties: {
        macro: { type: 'string', enum: [...SEARCH_MACROS], description: 'Which site to search.' },
        query: { type: 'string', description: 'What to search for.' },
        sessionKey: { type: 'string', description: 'Optional label grouping this search tab with others under the same name, so they list together. Cookies are already shared by every tab in this session, so this affects organisation only, never login state.' },
        maxChars: { type: 'number', description: 'Character budget for the returned page.' },
      },
      required: ['macro', 'query'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(SEARCH_CONTENT_BUDGET),
    async execute(args, exec) {
      return await guard(async () => {
        const browser = bridge.for(exec)
        const opened = await browser.open({ macro: args.macro, query: args.query, sessionKey: args.sessionKey }, exec.signal)
        const tabId = browser.resolveTabId(opened.tabId, 'camofox_search')
        await browser.waitForReady(tabId, { timeoutMs: 8000 }, exec.signal)
        const snapshot = await browser.snapshot(tabId, {}, exec.signal)
        const links = await browser.links(tabId, { limit: 40 }, exec.signal)
        const results = (Array.isArray(links?.links) ? links.links : []).slice(0, 25).map((link) => `${link.text ?? ''} → ${link.url ?? ''}`.trim()).filter(Boolean)
        // This tool renders a snapshot too, so the page is measured against this
        // tool's own — smaller — content budget, and against the result list that
        // competes with the page inside the very same rendered block.
        const fields = () => ({
          tabId,
          macro: args.macro,
          query: args.query,
          url: snapshot?.url ?? opened.url ?? '',
          // When Google blocks, the engine answers from another engine and says
          // so (server.js:3348, :3482-3483). Without this the model reads results
          // it believes are Google's and reasons from them accordingly.
          ...searchProvenance(opened),
          results,
        })
        const rendered = renderSnapshot(snapshot, {
          maxChars: clampInt(args.maxChars, config.defaultMaxChars, 200, SNAPSHOT_MAX_CHARS),
          contentBudget: SEARCH_CONTENT_BUDGET,
          fields,
        })
        return { ...fields(rendered), content: rendered.text }
      })
    },
  })

  register({
    name: 'camofox_scrape',
    timeoutMs: 900000,
    description:
      'Extract the same structured record from many pages at once, then write newline-delimited JSON. Give each property of the JSON Schema a "selector" (a CSS selector, or the shorthands :title and :url) plus an optional "attr" to read an attribute, "all" to collect every match, and "type" of string, number or boolean. The tool opens each page, fills the schema, and closes the tab. Use it for listings, catalogues, and price or spec tables instead of looping camofox_open by hand.',
    parameters: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'Pages to extract from. Pass urls OR discoverFrom — one of the two is required, and the call fails with neither.' },
        discoverFrom: { type: 'string', description: 'Page to read links from when you do not have the URLs yet. Pass this OR urls — one of the two is required.' },
        linkFilter: { type: 'string', description: 'Only follow links whose href contains this text, when discovering URLs.' },
        schema: {
          type: 'object',
          description:
            'JSON Schema with type "object" and a properties map. Give each property a "selector" (CSS selector, or ":title" / ":url"), and optionally "attr", "all" and "type" ("string" | "number" | "boolean"). Use "required" for fields that must resolve.',
        },
        maxItems: { type: 'number', description: 'How many records to produce. Defaults to the number of URLs, maximum 500.' },
        outputPath: { type: 'string', description: 'Absolute path for newline-delimited JSON results. Strongly recommended for more than a handful of records.' },
        overwrite: { type: 'boolean', description: 'Allow replacing a file that already exists at outputPath. Defaults to true, and the result always says whether it replaced something. Pass false to be refused instead.' },
        sessionKey: { type: 'string', description: 'Optional label applied to every tab this tool opens, so they group together in camofox_tabs. All pages already share this session\'s cookies, including any login you did; the label changes organisation only.' },
      },
      required: ['schema'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(20000),
    async execute(args, exec) {
      return await guard(async () => {
        const browser = bridge.for(exec)
        if (!isRecord(args.schema) || !isRecord(args.schema.properties)) throw new Error('schema must be an object with a properties map')
        let urls = Array.isArray(args.urls) ? args.urls.filter((url) => typeof url === 'string' && url !== '') : []
        if (urls.length === 0 && args.discoverFrom) {
          // The discovery tab is an implementation detail: its id is never
          // returned to the model, so nothing can read it afterwards. Close it
          // here or it occupies a slot until the cap evicts it. This runs before
          // the worker pool exists, so the semaphore is uncontended.
          const opened = await browser.open({ url: args.discoverFrom, sessionKey: args.sessionKey }, exec.signal)
          const discoverTabId = browser.resolveTabId(opened.tabId, 'camofox_scrape')
          try {
            const links = await browser.links(discoverTabId, { limit: 500 }, exec.signal)
            const base = new URL(args.discoverFrom)
            urls = (Array.isArray(links?.links) ? links.links : [])
              .map((link) => link.url)
              .filter((url) => typeof url === 'string')
              .filter((url) => (args.linkFilter ? url.includes(args.linkFilter) : true))
              .map((url) => {
                try {
                  return new URL(url, base).toString()
                } catch {
                  return url
                }
              })
          } finally {
            try {
              await browser.closeTab(discoverTabId, exec.signal)
            } catch {
              /* the engine reaps it anyway */
            }
          }
        }
        const maxItems = clampInt(args.maxItems, urls.length || 1, 1, 500)
        urls = [...new Set(urls)].slice(0, maxItems)
        if (urls.length === 0) throw new Error('no URLs to scrape; pass urls or a discoverFrom page that actually contains links')

        const records = []
        const failures = []
        const unaddressed = new Set()
        const concurrency = clampInt(config.scrapeConcurrency, 3, 1, 3)
        // Refs only exist for a page you have already read, so a schema meant
        // for pages nobody has seen yet has to name CSS selectors instead. The
        // two modes are told apart by what the schema actually contains.
        const properties = args.schema.properties
        const useSelectors = Object.values(properties).some((property) => isRecord(property) && typeof property.selector === 'string')
        let cursor = 0
        const worker = async () => {
          while (cursor < urls.length && !exec.signal.aborted) {
            const url = urls[cursor++]
            let tabId
            try {
              const opened = await browser.open({ url, sessionKey: args.sessionKey }, exec.signal)
              tabId = browser.resolveTabId(opened.tabId, 'camofox_scrape')
              if (useSelectors) {
                // Selector mode needs no accessibility tree, so the page is not
                // snapshotted first: that is a full render per URL saved.
                await browser.waitForReady(tabId, { timeoutMs: 8000 }, exec.signal)
                const result = await browser.extractBySelector(tabId, args.schema, exec.signal)
                records.push({ url, ok: true, data: result.data })
                if (result.missing.length > 0) {
                  unaddressed.add(`${result.missing.join(', ')} (needs a selector on ${url})`)
                }
              } else {
                await browser.snapshot(tabId, {}, exec.signal)
                const extracted = await browser.extract(tabId, args.schema, exec.signal)
                records.push({ url, ok: true, data: extracted?.data ?? extracted })
              }
            } catch (error) {
              failures.push({ url, error: explainError(error) })
            } finally {
              if (tabId) {
                try {
                  await browser.closeTab(tabId, exec.signal)
                } catch {
                  /* the engine reaps it anyway */
                }
              }
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()))

        const outputPath = typeof args.outputPath === 'string' && args.outputPath !== '' ? args.outputPath : undefined
        let savedTo
        let replacedExisting = false
        let refusedWrite = null
        if (outputPath) {
          const written = writeArtifact(outputPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, { overwrite: args.overwrite })
          // Refusing a write must never discard the records that were just
          // scraped, so this is a reported outcome rather than a thrown error.
          savedTo = written?.refused ? null : (written?.path ?? null)
          replacedExisting = written?.replacedExisting === true && !written?.refused
          refusedWrite = written?.refused ? written : null
        }
        return {
          requested: urls.length,
          succeeded: records.length,
          failed: failures.length,
          mode: useSelectors ? 'selector' : 'ref',
          savedTo: savedTo ?? null,
          replacedExisting,
          refusedWrite: refusedWrite ? refusedWrite.reason : null,
          records: savedTo ? records.slice(0, 5) : records,
          failures: failures.slice(0, 20),
          content: [
            `Scraped ${records.length}/${urls.length} pages (${useSelectors ? 'selector' : 'ref'} mode).`,
            savedTo
              ? `Full results written to ${savedTo}.`
              : refusedWrite
                ? `${refusedWrite.reason}; all ${records.length} record(s) are inline below. Pass overwrite:true to replace it, or choose another outputPath.`
                : 'No outputPath was given, so every record is inline above.',
            unaddressed.size > 0
              ? `Properties with no selector produced null: ${[...unaddressed].slice(0, 3).join('; ')}. Give every property a "selector" when scraping pages you have not read.`
              : '',
            failures.length > 0 ? `Failures:\n${failures.map((failure) => `- ${failure.url}: ${failure.error}`).join('\n')}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        }
      })
    },
  })

  register({
    name: 'camofox_mirror',
    timeoutMs: 1200000,
    description:
      'Copy a website into a local folder that still works offline: every visited page becomes an HTML file and its stylesheets, scripts, fonts and images are downloaded next to it with links rewritten to local paths. Use it to keep a reference copy of a page or a small site, to read a documentation site without network access, or to hand someone a self-contained snapshot.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Entry URL to start from.' },
        outDir: { type: 'string', description: 'Absolute folder to write the copy into. It is created if missing.' },
        maxPages: { type: 'number', description: 'Maximum number of pages to copy. Defaults to 20, maximum 500.' },
        maxDepth: { type: 'number', description: 'How many link levels to follow from the entry URL. 0 copies only that page; maximum 10.' },
        includeAssets: { type: 'boolean', description: 'Download stylesheets, scripts, fonts and images. Defaults to true.' },
        sameOrigin: { type: 'boolean', description: 'Restrict copied pages to the entry origin. Defaults to true.' },
        respectRobots: { type: 'boolean', description: 'Read and honour robots.txt disallow rules. Defaults to true.' },
        maxAssetBytes: { type: 'number', description: 'Skip any single asset larger than this. Defaults to 8 MB, maximum 200 MB. An asset that streams without declaring a size is dropped once it passes this cap, rather than buffered first.' },
      },
      required: ['url', 'outDir'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(20000),
    async execute(args, exec) {
      return await guard(async () => {
        const browser = bridge.for(exec)
        // The scoped view, never the raw bridge: `mirrorSite` calls the same
        // unscoped method signatures every other tool uses, and handing it the
        // raw bridge would shift every argument left by one — which fails
        // silently, because mirror records a page it could not read and still
        // returns a report that looks like a completed copy.
        const report = await mirrorSite(browser, {
          url: args.url,
          outDir: args.outDir,
          maxPages: clampInt(args.maxPages, 20, 1, 500),
          maxDepth: clampInt(args.maxDepth, 1, 0, 10),
          includeAssets: args.includeAssets !== false,
          sameOrigin: args.sameOrigin !== false,
          respectRobots: args.respectRobots !== false,
          maxAssetBytes: clampInt(args.maxAssetBytes, 8_000_000, 0, 200_000_000),
          signal: exec.signal,
          log: (message) => browser.engine.log(`[mirror] ${message}`),
        })
        return {
          // `content` first, and the long arrays sampled: this result is budgeted,
          // and a budget cut from the end used to drop the "Open X to browse the
          // copy" line — the one thing the model needs from it.
          content: [
            `Mirrored ${report.pagesWritten} page(s) into ${report.outDir}.`,
            `Assets: ${report.assetsWritten} written, ${report.assetsSkipped} skipped.`,
            report.skipped.length > 0 ? `Skipped: ${report.skipped.slice(0, 10).join(', ')}${report.skipped.length > 10 ? '…' : ''}` : '',
            `Open ${report.entryFile} to browse the copy.`,
          ]
            .filter(Boolean)
            .join('\n'),
          ...report,
          pages: report.pages.slice(0, 20),
          pagesTotal: report.pages.length,
          skipped: report.skipped.slice(0, 20),
          skippedTotal: report.skipped.length,
        }
      })
    },
  })

  register({
    name: 'camofox_tabs',
    timeoutMs: 30000,
    description:
      'Inspect and tidy the tabs belonging to this session. Every tab here shares one cookie jar, and no other DSH session or subagent can list or close them. Use it whenever any camofox tool fails with "needs a tabId", or when you want to see or free this session\'s tabs. Closing every tab also clears this session\'s cookies.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'close', 'closeAll', 'resetSession', 'cleanup'], description: 'list shows this session\'s tabs; close removes one; closeAll removes every tab in this session; resetSession also drops this session\'s cookies and stored state; cleanup asks the engine to release memory held by idle tabs, across every session that shares this engine.' },
        tabId: { type: 'string', description: 'Tab to close.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(8000),
    async execute(args, exec) {
      return await guard(async () => {
        const browser = bridge.for(exec)
        if (args.action === 'list') {
          const payload = await browser.listTabs(exec.signal)
          return {
            action: 'list',
            tabs: (Array.isArray(payload?.tabs) ? payload.tabs : []).map((tab) => ({ tabId: tab.tabId, url: tab.url, title: tab.title })),
            content: JSON.stringify(payload, null, 2),
          }
        }
        if (args.action === 'close') {
          const tabId = browser.resolveTabId(args.tabId, 'camofox_tabs(close)')
          await browser.closeTab(tabId, exec.signal)
          return { action: 'close', tabId, content: `Closed tab ${tabId}.` }
        }
        if (args.action === 'closeAll') {
          const payload = await browser.listTabs(exec.signal)
          const ids = (Array.isArray(payload?.tabs) ? payload.tabs : []).map((tab) => tab.tabId)
          for (const id of ids) {
            try {
              await browser.closeTab(id, exec.signal)
            } catch {
              /* the engine reaps it anyway */
            }
          }
          return { action: 'closeAll', closed: ids.length, content: `Closed ${ids.length} tab(s).` }
        }
        if (args.action === 'resetSession') {
          const result = await browser.closeSession(exec.signal)
          return { action: 'resetSession', content: `This session's cookies and stored state were dropped and its tabs are gone; other DSH sessions are unaffected. ${JSON.stringify(result ?? {})}` }
        }
        // Named explicitly rather than reached by falling through. The schema
        // declares an enum, but the harness does not enforce tool arguments
        // against it, so a fall-through is reachable with any text at all — and
        // `POST /pressure/cleanup` is deliberately process-wide: it relieves idle
        // tabs in EVERY session sharing the engine, not this one. A typo would
        // therefore escalate a per-session call into a cross-session one that
        // still reports success. Exactly as `camofox_act` does.
        if (args.action === 'cleanup') {
          const report = await browser.pressureCleanup({ dryRun: false }, exec.signal)
          return { action: 'cleanup', content: `Engine cleanup finished: ${JSON.stringify(report ?? {})}` }
        }
        throw new Error(`"${String(args.action)}" is not an action camofox_tabs can perform; use list, close, closeAll, resetSession or cleanup`)
      })
    },
  })

  register({
    name: 'camofox_trace',
    timeoutMs: 120000,
    description:
      'List, download or delete the Playwright trace archives recorded for this session. A trace is the record of every action the browser took — clicks, typing, navigation, network — and is the only artifact that shows WHY an interaction failed. Turn tracing on with camofox_open(trace:true); it is flushed when the session closes, so list it after closing or at the end of the investigation.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'delete'], description: 'list the archives, download one, or delete one. Deleting frees disk; archives are large.' },
        filename: { type: 'string', description: 'Archive name from the list. Required for get and delete.' },
        savePath: { type: 'string', description: 'get: absolute path to write the archive to. Defaults to the session temp directory.' },
        overwrite: { type: 'boolean', description: 'Allow replacing a file that already exists at savePath. Defaults to true.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(8000),
    async execute(args, exec) {
      return await guard(async () => {
        const browser = bridge.for(exec)
        if (args.action === 'list') {
          const payload = await browser.traces(exec.signal)
          const traces = (Array.isArray(payload?.traces) ? payload.traces : [])
            .map((entry) => ({
              filename: entry?.filename ?? entry?.name ?? null,
              bytes: typeof entry?.sizeBytes === 'number' ? entry.sizeBytes : null,
              createdAt: typeof entry?.createdAt === 'number' ? new Date(entry.createdAt).toISOString() : null,
            }))
            .filter((entry) => entry.filename)
          return {
            action: 'list',
            count: traces.length,
            traces,
            // The flush timing is the thing that makes this tool confusing, so it
            // is stated rather than left for the model to rediscover.
            content: traces.length === 0
              ? 'No traces for this session. A trace only appears after the recording session closes, so enable it with camofox_open(trace:true) and list again afterwards.'
              : `${traces.length} trace archive(s) for this session:\n${traces.map((t) => `  ${t.filename} — ${t.bytes ?? '?'} bytes — ${t.createdAt ?? '?'}`).join('\n')}\nFetch one with camofox_trace action:"get" and its filename, then open it at https://trace.playwright.dev.`,
          }
        }

        const filename = typeof args.filename === 'string' ? args.filename.trim() : ''
        if (!filename) throw new Error(`camofox_trace action:"${args.action}" needs a filename; call action:"list" first`)

        if (args.action === 'delete') {
          const result = await browser.deleteTrace(filename, exec.signal)
          return { action: 'delete', filename, content: `Deleted trace ${filename}${result?.ok === false ? ' (the engine reported a failure)' : ''}` }
        }

        const bytes = await browser.traceFile(filename, exec.signal)
        const written = writeArtifact(args.savePath ?? join(browser.config.tempDir, filename), bytes, { overwrite: args.overwrite })
        if (written?.refused) throw new Error(`${written.reason}; pass overwrite:true to replace it, or choose another savePath`)
        return {
          action: 'get',
          filename,
          savedTo: written?.path ?? null,
          replacedExisting: written?.replacedExisting === true,
          bytes: bytes.length,
          content: `Trace ${filename} (${bytes.length} bytes) written to ${written?.path}${writeNote(written)}. Open it at https://trace.playwright.dev — it shows every action the browser took, which is how you find out why an interaction did not do what you expected.`,
        }
      })
    },
  })

  register({
    name: 'camofox_serve',
    timeoutMs: 60000,
    description:
      'Serve a folder of local files over http so the browser can open them, because the engine refuses every scheme except http and https — a file:// URL is rejected. Use it when you need the browser to open a local HTML repro, a built asset, or a spec fixture. The server stops ITSELF after a fixed short lifetime whether or not you stop it, and starting one records it so camofox_serve action:"stop" can clean up. Never assume a served URL still works when you come back to it.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'list'],
          description: 'start serving a folder, stop everything this plugin started, or list what is running. stop and list are safe to call at any time.',
        },
        root: { type: 'string', description: 'start: absolute path to the folder to serve. Its index.html is served at /.' },
        port: { type: 'number', description: 'start: a specific loopback port. Omit to let the plugin choose a free one.' },
        ttlMs: { type: 'number', description: 'start: how long the server may live, in milliseconds. It is clamped to the plugin ceiling and always stops by then.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(6000),
    async execute(args, exec) {
      return await guard(async () => {
        const stateDir = config.stateDir
        if (args.action === 'stop') {
          const result = stopAll(stateDir, (pid) => { try { process.kill(pid) } catch { /* gone */ } })
          return {
            action: 'stop',
            stopped: result.stopped,
            failed: result.failed,
            content: result.stopped === 0
              ? 'No served folders were running; nothing to stop.'
              : `Stopped ${result.stopped} served folder(s).${result.failed.length > 0 ? ` Could not stop: ${result.failed.map((f) => `pid ${f.pid} (${f.reason})`).join('; ')}.` : ''}`,
          }
        }
        if (args.action === 'list') {
          const running = readRegistry(stateDir).filter((entry) => isAlive(entry.pid, entry.startedAt).alive)
          return {
            action: 'list',
            running: running.length,
            content: running.length === 0
              ? 'No served folders are running.'
              : running.map((e) => `${e.url} → ${e.root} (pid ${e.pid}, stops by ${new Date(e.expiresAt).toISOString()})`).join('\n'),
          }
        }

        // start
        const root = typeof args.root === 'string' ? args.root.trim() : ''
        if (!root) throw new Error('camofox_serve action:"start" needs root, the absolute path of a folder to serve')
        const resolved = resolve(root)
        if (!existsSync(resolved)) throw new Error(`${resolved} does not exist`)
        if (!statSync(resolved).isDirectory()) throw new Error(`${resolved} is not a folder; serve the folder that contains the file`)

        const ttlMs = clampInt(args.ttlMs, SERVE_TTL_MS, 1000, SERVE_TTL_MS)
        const entry = await startServe({
          stateDir,
          root: resolved,
          port: clampInt(args.port, 0, 0, 65535),
          ttlMs,
        }, {
          net: httpNet,
          spawn: spawnProc,
          nodePath: process.execPath,
          setTimeout: globalThis.setTimeout,
          clearTimeout: globalThis.clearTimeout,
        })

        // The child stops itself on the clock, but a child that outlives its own
        // timer — because it was SIGSTOPped, or because the machine slept across
        // the deadline — leaves nothing but this to answer for it. The watchdog is
        // detached and holds itself open by polling, so it also covers servers
        // started after this call. Its absence used to make the three-layer
        // guarantee in the README two layers, in silence.
        startWatchdog({ stateDir, ttlMs, spawn: spawnProc, nodePath: process.execPath })

        return {
          action: 'start',
          url: entry.url,
          port: entry.port,
          root: resolved,
          pid: entry.pid,
          expiresInMs: ttlMs,
          content: `Serving ${resolved} at ${entry.url} — open ${entry.url} with camofox_open. It stops by itself in at most ${Math.round(ttlMs / 1000)}s, whether or not you stop it, so do not rely on this URL after that. Call camofox_serve action:"stop" when you are done sooner.`,
        }
      })
    },
  })

  register({
    name: 'camofox_console',
    timeoutMs: 30000,
    description:
      'Read the errors this session\'s pages logged: console errors and warnings, uncaught exceptions, unhandled promise rejections, failed requests, and HTTP errors. Call it when a page looks wrong but reads as healthy — a blank panel, missing data, a feature that never renders — because those failures are invisible to every other reading tool. Also call it after an interaction fails, since it usually explains why. Captures nothing on a page you have not opened in this session.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Narrow the report to one tab. Omit for every tab in this session.' },
        minSeverity: { type: 'string', enum: ['error', 'warning'], description: 'error keeps only errors, exceptions, failed requests and HTTP errors; warning (the default) also keeps console warnings.' },
        limit: { type: 'number', description: 'Maximum entries to return, newest last. Defaults to 40.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(12000),
    async execute(args, exec) {
      return await guard(async () => {
        const browser = bridge.for(exec)
        const payload = await browser.consoleEntries({ minSeverity: args.minSeverity ?? 'warning' }, exec.signal)
        const tabs = Array.isArray(payload?.tabs) ? payload.tabs : []
        const wanted = typeof args.tabId === 'string' && args.tabId !== '' ? args.tabId : null

        const lines = []
        let shown = 0
        for (const tab of tabs) {
          if (wanted && tab.tabId !== wanted) continue
          const entries = Array.isArray(tab.entries) ? tab.entries : []
          if (entries.length === 0) continue
          lines.push(`— tab ${tab.tabId}${tab.url ? ` (${tab.url})` : ''} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`)
          for (const entry of entries) {
            if (shown >= clampInt(args.limit, 40, 1, 500)) break
            shown += 1
            const where = entry.location?.line !== undefined && entry.location?.line !== null
              ? ` (${entry.location.url ?? 'page'}:${entry.location.line})`
              : entry.url ? ` (${entry.url})` : ''
            lines.push(`  [${entry.kind}] ${entry.text}${where}`)
          }
          if (shown >= clampInt(args.limit, 40, 1, 500)) break
        }

        const counts = isRecord(payload?.counts) ? payload.counts : {}
        const summary = Object.entries(counts).map(([kind, n]) => `${n} ${kind}`).join(', ')
        return {
          total: typeof payload?.total === 'number' ? payload.total : shown,
          counts,
          shown,
          entries: tabs.flatMap((tab) => (Array.isArray(tab.entries) ? tab.entries : []).map((e) => ({ tabId: tab.tabId, kind: e.kind, text: e.text }))).slice(0, clampInt(args.limit, 40, 1, 500)),
          content: lines.length === 0
            ? `No console errors or failed requests in this session${wanted ? ` for tab ${wanted}` : ''}. If the page looks wrong, the failure is not being reported to the browser console — check the network with camofox_read mode:links, or look at the screenshot with camofox_capture.${summary ? ` (Captured so far: ${summary}.)` : ''}`
            : `${shown} of ${payload?.total ?? shown} entr${(payload?.total ?? shown) === 1 ? 'y' : 'ies'} shown.\n\n${lines.join('\n')}`,
        }
      })
    },
  })

  register({
    name: 'camofox_cookies',
    timeoutMs: 60000,
    description:
      'Import cookies into this session\'s browser, so a page opens already signed in. Use it when a site needs a login you have the cookie values for, or to carry a session across machines. The engine has no cookie-export route, so getting cookies out means reading document.cookie in the page with camofox_eval, which sees only what that page can see.',
    parameters: {
      type: 'object',
      properties: {
        cookies: {
          type: 'array',
          description: 'Cookie objects. Each needs name, value and domain; path, expires, httpOnly, secure and sameSite are optional. The engine accepts at most 500 per call.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
              domain: { type: 'string', description: 'e.g. ".example.com".' },
              path: { type: 'string' },
              expires: { type: 'number', description: 'Unix seconds. Omit for a session cookie.' },
              httpOnly: { type: 'boolean' },
              secure: { type: 'boolean' },
              sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'] },
            },
            required: ['name', 'value', 'domain'],
            additionalProperties: false,
          },
        },
      },
      required: ['cookies'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(6000),
    async execute(args, exec) {
      return await guard(async () => {
        const browser = bridge.for(exec)
        const list = Array.isArray(args.cookies) ? args.cookies : []
        if (list.length === 0) throw new Error('camofox_cookies needs at least one cookie')
        // Checked here so a typo names itself instead of arriving at the engine
        // as a 400 that lists which index was wrong.
        if (list.length > 500) throw new Error(`the engine accepts at most 500 cookies per call; got ${list.length}`)
        const bad = list.findIndex((cookie) => !isRecord(cookie)
          || typeof cookie.name !== 'string' || cookie.name === ''
          || typeof cookie.value !== 'string'
          || typeof cookie.domain !== 'string' || cookie.domain === '')
        if (bad >= 0) throw new Error(`cookie ${bad} needs a non-empty name, a string value and a domain`)

        const result = await browser.importCookies(list, exec.signal)
        const count = typeof result?.count === 'number' ? result.count : list.length
        return {
          imported: count,
          domains: [...new Set(list.map((cookie) => cookie.domain))],
          content: `Imported ${count} cookie(s) into this session's browser for ${[...new Set(list.map((c) => c.domain))].join(', ')}. Tabs opened after this share them. The change is in memory only — it does not persist past this session.`,
        }
      })
    },
  })

  register({
    name: 'camofox_fingerprint',
    timeoutMs: 60000,
    description:
      'Report what this browser claims about itself — user agent, platform, screen, timezone, locale, WebGL, canvas, plugins — and name any readings that disagree with each other. Use it when a site treats the browser as a bot and you need to find which property is leaking: compare the readings against what the site expects, or run camofox_capture fullPage to see what a human would. The readings are what the page observes, which is exactly what a bot check sees.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab to inspect. Optional when exactly one tab is open.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(8000),
    async execute(args, exec) {
      return await guard(async () => {
        const browser = bridge.for(exec)
        const tabId = browser.resolveTabId(args.tabId, 'camofox_fingerprint')
        // The probe returns a JSON string because the engine coerces an
        // evaluated object to `[object Object]`, so the structure has to be
        // serialised in the page.
        const raw = unwrapEvaluate(await browser.evaluate(tabId, FINGERPRINT_PROBE, exec.signal))
        let reading
        try {
          reading = JSON.parse(String(raw))
        } catch {
          throw new Error(`the page returned something that is not the fingerprint JSON (${String(raw).slice(0, 120)}); the tab may not have finished loading`)
        }
        const notes = fingerprintTensions(reading)
        const lines = [
          `user agent: ${reading.userAgent ?? '(none)'}`,
          `platform: ${reading.platform ?? '(none)'} · languages: ${(reading.languages ?? []).join(', ') || '(none)'}`,
          `timezone: ${reading.timezone ?? '(none)'} · locale: ${reading.locale ?? '(none)'}`,
          `screen: ${reading.screen ? `${reading.screen.width}x${reading.screen.height} avail ${reading.screen.availWidth}x${reading.screen.availHeight} dpr ${reading.screen.devicePixelRatio} depth ${reading.screen.colorDepth}` : '(unknown)'}`,
          `hardware: ${reading.hardwareConcurrency ?? '?'} cores · memory: ${reading.deviceMemory ?? '(not reported)'} · touch points: ${reading.maxTouchPoints ?? '?'}`,
          `plugins: ${reading.plugins ?? '?'} · webdriver: ${reading.webdriver} · webrtc: ${reading.webrtc} · cookies: ${reading.cookieEnabled}`,
          `webgl: ${reading.webgl ? `${reading.webgl.vendor} — ${reading.webgl.renderer}` : '(unavailable)'}`,
          `canvas hash: ${reading.canvas ? `${String(reading.canvas).slice(0, 40)}…` : '(unavailable)'}`,
          '',
          notes.length === 0
            ? 'No reading contradicts another. If a site still blocks you, the mismatch is one this check does not compare — the PDF viewer, the WebRTC local-IP leak, or the fonts.'
            : `Worth a look:\n${notes.map((note) => `  - ${note}`).join('\n')}`,
        ]
        return { tabId, reading, notes, lines: notes.length, content: lines.join('\n') }
      })
    },
  })

  register({
    name: 'camofox_status',
    timeoutMs: 30000,
    description:
      'Report browser engine health, memory, open tabs and the engine log path. Call it first when browser tools fail, to tell an engine problem apart from a page problem.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(8000),
    // The only tool that touches no tab, so it is safe to run beside anything.
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return await guard(async () => {
        const browser = bridge.for(exec)
        const status = browser.status()
        let engine = null
        try {
          engine = await browser.engine.probe(3000)
        } catch {
          engine = null
        }
        return {
          // `content` leads deliberately: `output.render` serialises in key
          // order, and with a long tab list it used to be pushed past the
          // budget, leaving the model engine bookkeeping and no summary.
          content: [
            `state: ${status.state}`,
            `engine: ${status.baseUrl}${engine?.ok ? ' (responding)' : ' (not responding)'}`,
            `browser: running=${engine?.browserRunning ?? 'unknown'} connected=${engine?.browserConnected ?? 'unknown'}`,
            `tabs open: ${status.trackedTabCount ?? status.trackedTabs.length} in this session`,
            // These four are engine-wide. They are the only place a tab or a
            // session leaked by ANOTHER session becomes visible at all, and
            // `consecutiveFailures` is the engine's own signal that it is
            // struggling rather than idle.
            typeof engine?.activeTabs === 'number' ? `engine tabs: ${engine.activeTabs} across all sessions` : '',
            typeof engine?.activeSessions === 'number' ? `engine sessions: ${engine.activeSessions}` : '',
            typeof engine?.consecutiveFailures === 'number' && engine.consecutiveFailures > 0
              ? `engine failures: ${engine.consecutiveFailures} consecutive`
              : '',
            engine?.recovering ? 'engine is recovering (restarting the browser)' : '',
            status.otherActiveScopes > 0 ? `other sessions using this browser: ${status.otherActiveScopes}` : '',
            typeof engine?.memory?.rssMb === 'number' ? `engine memory: ${engine.memory.rssMb} MiB rss` : '',
            `log: ${status.logFile}`,
            status.lastError ? `last error: ${status.lastError}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          ...status,
          engine,
          healthy: engine?.ok === true,
        }
      })
    },
  })

  register({
    name: 'camofox_transcript',
    timeoutMs: 240000,
    description:
      'Get the spoken transcript of a YouTube video as text, with its title. Use it to absorb a talk, lecture, tutorial or interview without watching it. For a long video, page through it with maxChars and offset exactly as this tool returned them; you do not need camofox_eval.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'YouTube video URL.' },
        language: { type: 'string', description: 'Preferred caption language code, e.g. en or ro. Defaults to en.' },
        maxChars: { type: 'number', description: 'Character budget for this call.' },
        offset: { type: 'number', description: 'Character offset to start from, for paging through a long transcript.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }], },
    finalizeContent: boundedContent(40000),
    async execute(args, exec) {
      return await guard(async () => {
        const browser = bridge.for(exec)
        const payload = await browser.youtubeTranscript({ url: args.url, language: args.language }, exec.signal)
        // The engine answers with a JSON body even when it failed, so an error
        // here would otherwise be presented to the model as a transcript.
        if (isRecord(payload) && payload.status === 'error') {
          throw new Error(
            `no transcript was available for this video (${payload.code ?? 'unknown'}${payload.message ? `: ${payload.message}` : ''}). The video may have captions disabled, or it may be age-restricted, private, or region-locked.`,
          )
        }
        const transcript = typeof payload?.transcript === 'string' ? payload.transcript : JSON.stringify(payload ?? {})
        const maxChars = clampInt(args.maxChars, config.maxExtractChars, 200, 400000)
        return {
          url: args.url,
          title: payload?.video_title ?? payload?.title ?? '',
          words: payload?.total_words ?? null,
          totalChars: transcript.length,
          content: pageText(transcript, args.offset, maxChars),
        }
      })
    },
  })

  return names
}