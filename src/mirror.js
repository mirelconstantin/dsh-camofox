/**
 * Offline site mirroring built on the Camoufox browser.
 *
 * The engine has no "download site" primitive, but every ingredient exists:
 * navigate, read the live document through the page's own JavaScript context,
 * enumerate links and assets, and fetch bytes either from Node or — when a
 * server refuses a plain request — from inside the authenticated page.
 *
 * @module dsh-camofox/mirror
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { unwrapEvaluate } from './bridge.js'
import { clampInt, isRecord } from './util.js'

/** Asset selectors rewritten into local copies. */
const ASSET_SELECTORS = [
  'link[rel="stylesheet"]',
  'link[rel="icon"]',
  'link[rel="shortcut icon"]',
  'link[rel="apple-touch-icon"]',
  'link[rel="preload"][as="style"]',
  'link[rel="preload"][as="font"]',
  'script[src]',
  'img[src]',
  'source[src]',
  'video[poster]',
  'audio[src]',
  'embed[src]',
  'object[data]',
].join(',')

/** Browser-shaped user agent used when a plain request is rejected. */
const FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0'

/**
 * Turn a URL into a readable, collision-resistant local file name.
 *
 * @param {URL} url - absolute URL.
 * @returns {string} a safe file stem.
 */
function fileStem(url) {
  // `decodeURIComponent` throws URIError on a malformed escape, and an ordinary
  // page can author one: `<a href="%zz">` survives `new URL(...)` untouched, so
  // the harvester hands it back as a perfectly good link. Letting that throw here
  // aborted the whole page, discarding a document that had already been read.
  let path
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    path = url.pathname
  }
  path = path.replace(/\/+$/, '')
  const base = path.split('/').filter(Boolean).pop() ?? url.hostname
  const slug = base.replace(/\.[a-z0-9]{1,6}$/i, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const digest = [...url.href].reduce((hash, char) => (hash * 33 + char.charCodeAt(0)) % 0xffffff, 5381).toString(36)
  return `${slug || 'page'}-${digest}`
}

/**
 * Hash a URL into a stable extension segment for asset folders.
 *
 * @param {string} href - asset URL.
 * @returns {string} a short directory-safe token.
 */
function assetKey(href) {
  let hash = 5381
  for (let index = 0; index < href.length; index += 1) hash = (hash * 33 + href.charCodeAt(index)) % 0xffffff
  return hash.toString(36)
}

/** Ceiling on in-flight asset downloads, whatever the caller asks for. */
const ASSET_CONCURRENCY_CEILING = 8

/**
 * Escape the characters a robots.txt pattern gives a literal meaning to.
 *
 * A pattern is not a regular expression: `/` and `?` appear in patterns as often
 * as `*` does, so every one of them has to survive the round trip into a regexp
 * source unchanged. Note that this keeps `$` literal too, which is what makes a
 * `$` in the middle of a pattern mean itself.
 *
 * @param {string} char - one character of a pattern.
 * @returns {string} its literal form inside a regular expression source.
 */
function escapePatternChar(char) {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

/**
 * Compile one robots.txt path pattern into an anchored matcher.
 *
 * RFC 9309 §2.2.3 defines a pattern language of its own: `*` stands for any
 * sequence of octets — including an empty one, and including `/` — and a `$`
 * in the *final* position anchors the pattern to the end of the path. A `$`
 * anywhere else is an ordinary character. Compiling that once, at parse time,
 * is what lets {@link robotsAllows} stay a pure function of its arguments.
 *
 * @param {string} pattern - a robots.txt path pattern.
 * @returns {RegExp} a matcher for one path-with-query string.
 */
function compileRobotsPattern(pattern) {
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  let source = ''
  for (const char of body) source += char === '*' ? '.*' : escapePatternChar(char)
  // No `g` flag, deliberately: with it, `test` would carry `lastIndex` between
  // calls and the same rule could match one path and miss the next.
  return new RegExp(`^${source}${anchored ? '$' : ''}`)
}

/**
 * Pick the one group whose rules apply to this crawler.
 *
 * RFC 9309 §2.2.1: the group naming the longest user-agent token that is a
 * substring of the crawler's own token wins; `*` is the fallback when nothing
 * names us. A group is never merged with a neighbour, which is the difference
 * between "these two agents share these rules" and "every rule any group ever
 * mentioned, last one wins".
 *
 * @param {Array<{ agents: string[], rules: object[] }>} groups - parsed groups in file order.
 * @param {string} userAgent - this crawler's product token.
 * @returns {object[]} the rules of the winning group, or none.
 */
function selectRobotsGroup(groups, userAgent) {
  const token = String(userAgent ?? '').trim().toLowerCase()
  let best = null
  let bestToken = ''
  let fallback = null
  for (const group of groups) {
    for (const agent of group.agents) {
      const candidate = agent.trim().toLowerCase()
      if (candidate === '') continue
      if (candidate === '*') {
        // `*` matches every crawler, so it can never outrank a named group
        // however short that name is; it only wins when nothing names us.
        if (fallback === null) fallback = group
        continue
      }
      if (candidate.length > bestToken.length && token.includes(candidate)) {
        best = group
        bestToken = candidate
      }
    }
  }
  return (best ?? fallback)?.rules ?? []
}

/**
 * Parse a robots.txt body into the rules that apply to one crawler.
 *
 * A group is a run of `user-agent` lines followed by that group's rule lines;
 * a `user-agent` line arriving after any rule opens the next group. That is the
 * whole reason the previous implementation — which kept one flat list and let
 * the last matching line win — could hand a crawler the rules of an agent it is
 * not.
 *
 * @param {string} body - robots.txt content.
 * @param {string} userAgent - this crawler's product token.
 * @returns {Array<{ pattern: string, allow: boolean, specificity: number, match: RegExp }>} ordered rules.
 */
export function parseRobots(body, userAgent) {
  /** @type {Array<{ agents: string[], rules: object[] }>} */
  const groups = []
  let agents = []
  let rules = []
  let sawRule = false

  const closeGroup = () => {
    // Rules with no group above them belong to nobody: a file that opens with a
    // bare `Disallow:` addresses no agent at all.
    if (agents.length > 0) groups.push({ agents, rules })
    agents = []
    rules = []
    sawRule = false
  }

  for (const rawLine of String(body ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (line === '') continue
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const field = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (field === 'user-agent') {
      if (sawRule) closeGroup()
      if (!agents.includes(value)) agents.push(value)
      continue
    }
    if (field !== 'disallow' && field !== 'allow') continue
    // It is a rule line even when the value is empty, so it still closes the
    // block of agent names above it.
    sawRule = true
    // An empty `Disallow:` means "crawl everything" (RFC 9309 §2.2.1), which is
    // already the default. Storing it as the pattern `''` would be actively
    // harmful: it matches every path and, being specific by length, it would
    // outrank every real rule in the group.
    if (value === '') continue
    rules.push({
      pattern: value,
      allow: field === 'allow',
      // Specificity is measured on the pattern as written, which is what
      // RFC 9309 §2.2.2 compares.
      specificity: value.length,
      match: compileRobotsPattern(value),
    })
  }
  closeGroup()
  return selectRobotsGroup(groups, userAgent)
}

/**
 * Decide whether robots rules permit one path.
 *
 * RFC 9309 §2.2.2: the most specific matching rule decides, and "most specific"
 * is the longest pattern — so a longer `Disallow` beats a shorter `Allow`, which
 * is what makes `Disallow: /*.pdf$` survive an `Allow: /` above it. An exact tie
 * goes to `Allow`, the more permissive rule.
 *
 * @param {string} pathWithQuery - the URL path *including* its query string.
 * @param {Array<{ pattern: string, allow: boolean, specificity: number, match: RegExp }>} rules - rules from {@link parseRobots}.
 * @returns {boolean} whether crawling is allowed.
 */
export function robotsAllows(pathWithQuery, rules) {
  const target = String(pathWithQuery ?? '')
  let best = -1
  let decision = true
  for (const rule of rules ?? []) {
    if (!rule.match.test(target)) continue
    if (rule.specificity > best) {
      best = rule.specificity
      decision = rule.allow
    } else if (rule.specificity === best && rule.allow) {
      // Equally specific: `allow` wins, so the tie resolves permissively.
      decision = true
    }
  }
  return decision
}

/**
 * The whole robots decision as a single pure function.
 *
 * `mirrorSite` cannot use this shape — it fetches robots.txt once and then
 * matches one path per page — but a caller that has the body and the path
 * should not have to know that.
 *
 * @param {string} body - robots.txt content.
 * @param {string} userAgent - this crawler's product token.
 * @param {string} pathWithQuery - the URL path including its query string.
 * @returns {boolean} whether crawling is allowed.
 */
export function robotsPermits(body, userAgent, pathWithQuery) {
  return robotsAllows(pathWithQuery, parseRobots(body, userAgent))
}

/**
 * Run an async worker over `items` with at most `limit` calls in flight.
 *
 * Results come back in item order regardless of completion order, so a caller
 * that only wants the results does not care about the scheduling; a caller that
 * writes as it goes must make each write depend on its own item alone.
 *
 * A rejecting worker rejects the whole run, so a caller that wants to survive a
 * failure has to catch it inside `worker`. That is deliberate: silently dropping
 * a rejection is how a mirror ends up reporting a completed copy with a hole in
 * it. Cancellation stops the queue at the next item and lets the in-flight calls
 * settle on their own — the signal is the caller's to pass down.
 *
 * @template T
 * @template R
 * @param {T[]} items - work items.
 * @param {number} limit - maximum simultaneous workers; fewer than 1 means one.
 * @param {(item: T, index: number) => Promise<R>} worker - per-item work.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<R[]>} results in item order.
 */
export async function mapBounded(items, limit, worker, signal) {
  const list = Array.isArray(items) ? items : []
  const width = Math.max(1, Math.floor(limit) || 1, 0)
  const results = new Array(list.length)
  let cursor = 0
  const run = async () => {
    while (cursor < list.length) {
      if (signal?.aborted) return
      // The index is taken and the cursor advanced without an intervening
      // await, so no two workers can ever claim the same item.
      const index = cursor
      cursor += 1
      results[index] = await worker(list[index], index)
    }
  }
  const lanes = Math.min(width, list.length)
  if (lanes > 0) await Promise.all(Array.from({ length: lanes }, () => run()))
  return results
}

/**
 * Read the document and its asset and link lists out of the live page.
 *
 * Relative references resolve in the page itself, against `document.baseURI`,
 * so no URL needs to travel in here.
 *
 * @param {object} bridge - scoped browser view (`bridge.for(exec)`).
 * @param {string} tabId - tab showing the page.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ html: string, links: string[], assets: string[], title: string }>} the harvested page.
 */
async function harvestPage(bridge, tabId, signal) {
  const script = `(() => {
    const absolute = (value) => { try { return new URL(value, document.baseURI).href; } catch { return null; } };
    const selectors = ${JSON.stringify(ASSET_SELECTORS)};
    const assets = [];
    const add = (node, attribute) => {
      const raw = node.getAttribute(attribute);
      if (!raw || /^(data:|blob:|javascript:|#)/.test(raw)) return;
      const url = absolute(raw);
      if (url) assets.push({ raw, url });
    };
    for (const node of document.querySelectorAll(selectors)) {
      const tag = node.tagName;
      if (tag === 'LINK') add(node, 'href');
      else if (tag === 'OBJECT') add(node, 'data');
      else add(node, tag === 'SOURCE' ? 'src' : 'src');
    }
    for (const node of document.querySelectorAll('img[srcset], source[srcset]')) {
      for (const part of (node.getAttribute('srcset') || '').split(',')) {
        const candidate = part.trim().split(/\\s+/)[0];
        if (!candidate || /^(data:|blob:)/.test(candidate)) continue;
        const url = absolute(candidate);
        if (url) assets.push({ raw: candidate, url });
      }
    }
    const inline = [...document.querySelectorAll('style')].map((node) => node.textContent || '').join('\\n');
    const links = [...document.querySelectorAll('a[href]')]
      .map((node) => ({ raw: node.getAttribute('href'), url: absolute(node.getAttribute('href')) }))
      .filter((link) => link.url && link.raw && !/^(javascript:|mailto:|tel:|#)/.test(link.raw));
    return {
      title: document.title,
      html: '<!doctype html>\\n' + document.documentElement.outerHTML + (inline ? '\\n<style data-mirrored-inline>' + inline + '</style>' : ''),
      links: [...new Map(links.map((link) => [link.raw, link])).values()],
      assets: [...new Map(assets.map((asset) => [asset.url, asset])).values()],
    };
  })()`
  const payload = await bridge.evaluate(tabId, script, signal)
  const value = unwrapEvaluate(payload)
  if (!isRecord(value) || typeof value.html !== 'string') throw new Error('could not read the document from the page')
  return {
    html: value.html,
    links: Array.isArray(value.links) ? value.links.filter((link) => isRecord(link) && typeof link.raw === 'string') : [],
    assets: Array.isArray(value.assets) ? value.assets.filter((asset) => isRecord(asset) && typeof asset.url === 'string') : [],
    title: typeof value.title === 'string' ? value.title : '',
  }
}

/**
 * Fetch one asset, preferring a plain request and falling back to the page.
 *
 * @param {object} bridge - browser bridge.
 * @param {string} tabId - tab whose session should be used for the fallback.
 * @param {string} url - absolute asset URL.
 * @param {number} maxBytes - skip anything larger.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ bytes: Buffer, contentType: string } | null>} the asset, or null when unavailable.
 */
async function fetchAsset(bridge, tabId, url, maxBytes, signal) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': FALLBACK_UA, accept: '*/*' },
      redirect: 'follow',
      signal,
    })
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (response.ok && (declared === 0 || declared <= maxBytes)) {
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length <= maxBytes) {
        return { bytes: buffer, contentType: response.headers.get('content-type') ?? '' }
      }
    }
  } catch {
    /* fall through to the in-page attempt */
  }
  try {
    const expression = `(async () => {
      const response = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
      if (!response.ok) return null;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > ${maxBytes}) return null;
      let binary = '';
      const view = new Uint8Array(buffer);
      for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
      return { base64: btoa(binary), contentType: response.headers.get('content-type') || '' };
    })()`
    const payload = await bridge.evaluate(tabId, expression, signal)
    const value = unwrapEvaluate(payload)
    if (!isRecord(value) || typeof value.base64 !== 'string') return null
    return { bytes: Buffer.from(value.base64, 'base64'), contentType: String(value.contentType ?? '') }
  } catch {
    return null
  }
}

/** Attributes whose whole value may be a local reference. */
const URL_ATTRIBUTE = /(\s(?:href|src|poster|data-src|data-href|data)\s*=\s*)(["'])([^"']*)\2/gi

/**
 * Rewrite one attribute value at a time, matching whole values only.
 *
 * A substring replacement is not safe here: a root-relative link such as "/"
 * appears inside every absolute URL, so replacing it corrupts the whole
 * document. Confining each replacement to a complete attribute value means a
 * value either *is* the reference or is left alone.
 *
 * @param {string} value - the attribute value as authored.
 * @param {Map<string, string>} replacements - authored value to local path.
 * @returns {string | null} the local path, or null when nothing should change.
 */
function localPathFor(value, replacements) {
  if (value === '' || /^(#|data:|blob:|javascript:|mailto:|tel:)/i.test(value)) return null
  const direct = replacements.get(value)
  if (direct) return direct
  // srcset-style values carry several candidates with descriptors.
  if (value.includes(',')) {
    const rewritten = value
      .split(',')
      .map((candidate) => {
        const trimmed = candidate.trim()
        if (trimmed === '') return trimmed
        const [url, ...descriptor] = trimmed.split(/\s+/)
        const local = replacements.get(url)
        return local ? [local, ...descriptor].join(' ') : trimmed
      })
      .join(', ')
    return rewritten === value ? null : rewritten
  }
  return null
}

/**
 * Rewrite a copied document so it points at the local copies.
 *
 * The map is keyed by what the document literally contains, not by the resolved
 * URL: serialised HTML keeps the author's own relative paths.
 *
 * @param {string} html - original document.
 * @param {Map<string, string>} replacements - authored value to local path.
 * @param {string} origin - the URL this page came from, for the banner.
 * @returns {string} the rewritten document.
 */
function rewriteDocument(html, replacements, origin) {
  let output = html.replace(URL_ATTRIBUTE, (match, prefix, quote, value) => {
    const local = localPathFor(value, replacements)
    return local ? `${prefix}${quote}${local}${quote}` : match
  })
  // Inline styles and style attributes carry `url(...)`, which is not a URL
  // attribute. Whole-token matching keeps a bare "/" from matching everything.
  output = output.replace(/url\((["']?)([^"')]+)\1\)/gi, (match, quote, value) => {
    const local = localPathFor(value, replacements)
    return local ? `url(${quote}${local}${quote})` : match
  })
  const banner = `<meta name="x-dsh-mirror" content="offline copy captured by dsh-camofox">\n<!-- original: ${origin} -->`
  return output.includes('<head') ? output.replace(/<head[^>]*>/i, (tag) => `${tag}\n${banner}`) : `${banner}\n${output}`
}

/**
 * Rewrite absolute references inside a downloaded stylesheet.
 *
 * CSS is the one asset kind whose own file contains URLs to other assets, and
 * a mirror whose CSS still points at a CDN is not an offline copy. Only exact
 * known asset URLs are replaced, and the result is a bare file name because
 * every asset lives in the same folder.
 *
 * @param {Buffer} bytes - the stylesheet.
 * @param {Map<string, string>} assetMap - asset URL to local `assets/…` path.
 * @returns {Buffer} the rewritten stylesheet.
 */
function rewriteStylesheet(bytes, assetMap) {
  const text = bytes.toString('utf8')
  const rewritten = text.replace(/url\((["']?)([^"')]+)\1\)/gi, (match, quote, value) => {
    const local = assetMap.get(value.trim())
    if (!local) return match
    const name = local.slice(local.lastIndexOf('/') + 1)
    return `url(${quote}${name}${quote})`
  })
  return rewritten === text ? bytes : Buffer.from(rewritten, 'utf8')
}

/**
 * Mirror a website into a local folder that works offline.
 *
 * @param {{ open: Function, snapshot: Function, evaluate: Function, resolveTabId: Function, closeTab: Function, config: object }} bridge - scoped browser view, `bridge.for(exec)`.
 * @param {object} options - mirror options.
 * @returns {Promise<object>} a JSON-safe report of what was written.
 */
export async function mirrorSite(bridge, options) {
  const { url, outDir, maxPages, maxDepth, includeAssets, sameOrigin, respectRobots, maxAssetBytes, signal } = options
  // `log` is optional and every use of it sits on the crawl's own hot path. An
  // unguarded call throws from inside the per-page `try`, where it is recorded as
  // a page failure it had nothing to do with — or, on the last line of the run,
  // straight out of `mirrorSite` with the copy already written to disk.
  const log = typeof options.log === 'function' ? options.log : () => {}
  // One pool per mirror, bounded by the same `scrapeConcurrency` the scrape tool
  // uses, which `resolveConfig` already clamps to [1, 3]. The ceiling is the
  // part that matters for a caller that hands this function a hand-built bridge,
  // or an `assetConcurrency` of 10000: without it one page's asset list becomes
  // a stampede against the origin and the browser at the same time. Eight is
  // comfortably above the configured default and far below anything a static
  // asset host or the engine's own per-user call semaphore would object to.
  const assetConcurrency = clampInt(
    options.assetConcurrency,
    clampInt(bridge?.config?.scrapeConcurrency, 3, 1, ASSET_CONCURRENCY_CEILING),
    1,
    ASSET_CONCURRENCY_CEILING,
  )
  const assetLimit = bridge?.config?.mirrorAssetLimit
  const entry = new URL(url)
  const origin = entry.origin
  const pagesDir = join(outDir, 'pages')
  const assetsDir = join(outDir, 'assets')
  mkdirSync(pagesDir, { recursive: true })
  if (includeAssets) mkdirSync(assetsDir, { recursive: true })

  const report = {
    outDir,
    entryFile: join(outDir, 'index.html'),
    pagesWritten: 0,
    assetsWritten: 0,
    assetsSkipped: 0,
    skipped: [],
    pages: [],
    robotsRespected: false,
    truncated: 0,
  }

  let rules = []
  if (respectRobots) {
    try {
      const response = await fetch(new URL('/robots.txt', origin), { headers: { 'user-agent': FALLBACK_UA }, signal })
      if (response.ok) {
        rules = parseRobots(await response.text(), 'dsh-camofox')
        report.robotsRespected = true
      }
    } catch {
      /* no robots.txt, or it is unreachable: carry on */
    }
    if (rules.length > 0) log(`robots.txt loaded with ${rules.length} rule(s)`)
  }

  const visited = new Set()
  const queue = [{ url: entry.toString(), depth: 0, file: 'index.html' }]
  /** @type {Map<string, string>} page URL to local relative path. */
  const pageMap = new Map()
  /** @type {Map<string, string>} asset URL to local relative path. */
  const assetMap = new Map()
  const seenAssets = new Set()
  let discovered = 1

  while (queue.length > 0 && report.pagesWritten < maxPages) {
    if (signal?.aborted) throw new Error('the mirror was canceled')
    const current = queue.shift()
    if (visited.has(current.url)) continue
    visited.add(current.url)

    const parsed = new URL(current.url)
    if (sameOrigin && parsed.origin !== origin) {
      report.skipped.push(`${current.url} (different origin)`)
      continue
    }
    // The path a crawler is judged on is the path *with its query*: that is what
    // `Disallow: /*.php?` is written against, and matching a bare pathname would
    // silently stop honouring every query-shaped rule.
    if (respectRobots && rules.length > 0 && !robotsAllows(`${parsed.pathname}${parsed.search}`, rules)) {
      report.skipped.push(`${current.url} (robots.txt disallow)`)
      log(`robots.txt disallows ${parsed.pathname}`)
      continue
    }

    let tabId
    try {
      const opened = await bridge.open({ url: current.url, sessionKey: 'mirror' }, signal)
      tabId = bridge.resolveTabId(opened.tabId, 'camofox_mirror')
      await bridge.snapshot(tabId, {}, signal)
      const harvested = await harvestPage(bridge, tabId, signal)
      if (harvested.html.length > 4_000_000) {
        report.truncated += 1
        report.skipped.push(`${current.url} (document larger than 4 MB)`)
        continue
      }

      // This document's own replacements: the literal text it contains, mapped
      // to the local copy. Built per page so a relative href on one page never
      // rewrites the same-looking href on another.
      /** @type {Map<string, string>} */
      const replacements = new Map()
      let assetsForPage = 0

      if (includeAssets) {
        // Fetching this page's assets one at a time, inside an already-serial
        // page loop, is what made a 41-page mirror take 73 seconds: the crawl is
        // latency-bound, and every asset was a round trip the CPU sat out.
        //
        // Completion order does not matter here, and these are the reasons
        // rather than an assumption:
        //  - the destination is `assets/<assetKey(url)><ext>`, derived from the
        //    asset URL alone, so the file a URL lands in does not depend on which
        //    of two pages reached it first;
        //  - every write is `writeFileSync`, which Node runs to completion before
        //    any other worker can run a line, so two workers cannot interleave
        //    bytes into one file;
        //  - the shared mutable state (`seenAssets`, `assetMap`, `replacements`,
        //    the counters) is only ever touched between awaits, in steps that do
        //    not await, so no two workers can be inside one at the same time.
        // The page's own `replacements` map is the exception's only victim, and
        // it is a map: concurrent `set`s of distinct keys cannot lose each other.
        //
        // What does change is the ORDER of entries in `report.skipped`, which
        // becomes the order requests finished rather than the order the document
        // listed them. The field's shape, and every other reported field, is
        // untouched.
        let reserved = 0
        await mapBounded(
          harvested.assets,
          assetConcurrency,
          async (asset) => {
            let assetParsed
            try {
              assetParsed = new URL(asset.url)
            } catch {
              return
            }
            if (assetParsed.protocol !== 'http:' && assetParsed.protocol !== 'https:') return
            if (seenAssets.has(asset.url)) {
              const known = assetMap.get(asset.url)
              if (known) replacements.set(asset.raw, known)
              return
            }
            // The slot is reserved before the first await, not after the write.
            // Checking `assetsWritten` and incrementing it around a fetch would
            // let every worker in the pool pass a check that only
            // `mirrorAssetLimit - written` of them should pass.
            if (report.assetsWritten + reserved >= assetLimit) {
              report.assetsSkipped += 1
              report.skipped.push(`${asset.url} (asset limit reached)`)
              return
            }
            seenAssets.add(asset.url)
            reserved += 1
            try {
              const fetched = await fetchAsset(bridge, tabId, asset.url, maxAssetBytes, signal)
              if (!fetched || fetched.bytes.length === 0) {
                report.assetsSkipped += 1
                report.skipped.push(`${asset.url} (not retrievable)`)
                return
              }
              const extension = guessExtension(assetParsed.pathname, fetched.contentType)
              const local = `assets/${assetKey(asset.url)}${extension}`
              writeFileSync(join(assetsDir, `${assetKey(asset.url)}${extension}`), fetched.bytes)
              assetMap.set(asset.url, local)
              replacements.set(asset.raw, local)
              assetsForPage += 1
              report.assetsWritten += 1
            } catch (error) {
              // One asset that throws must not take its siblings down with it, and
              // it must not cost the page its copy either: `Promise.all` over the
              // pool rejects on the first refusal, so the failure is absorbed here
              // and counted the way every other asset failure already is.
              report.assetsSkipped += 1
              report.skipped.push(`${asset.url} (${error instanceof Error ? error.message : String(error)})`)
            } finally {
              reserved -= 1
            }
          },
          signal,
        )
        // `mapBounded` returns as soon as the queue drains on an aborted signal, so
        // the crawl notices here rather than one loop iteration later.
        if (signal?.aborted) throw new Error('the mirror was canceled')
      }

      // Enqueue this page's links before rewriting, so a link that will become a
      // local file is already known when the document is written.
      if (current.depth < maxDepth) {
        for (const link of harvested.links) {
          let linkParsed
          try {
            linkParsed = new URL(link.url)
          } catch {
            continue
          }
          if (linkParsed.protocol !== 'http:' && linkParsed.protocol !== 'https:') continue
          if (sameOrigin && linkParsed.origin !== origin) continue
          const target = linkParsed.toString()
          if (visited.has(target)) continue
          if (!pageMap.has(target)) {
            pageMap.set(target, `pages/${fileStem(linkParsed)}.html`)
            queue.push({ url: target, depth: current.depth + 1, file: pageMap.get(target) })
            discovered += 1
          }
          replacements.set(link.raw, pageMap.get(target))
        }
      }

      pageMap.set(current.url, current.file)
      mkdirSync(dirname(join(outDir, current.file)), { recursive: true })
      writeFileSync(join(outDir, current.file), rewriteDocument(harvested.html, replacements, current.url))
      report.pagesWritten += 1
      report.pages.push({ url: current.url, file: current.file, title: harvested.title, assets: assetsForPage })
    } catch (error) {
      // A cancelled mirror must not be laundered into a report. The crawl loop
      // checks `signal.aborted` on every turn and would throw, but on the last
      // page there is no next turn — so an abort raised while that page's assets
      // were in flight would otherwise return a report that reads like a
      // completed copy, missing exactly the pages it had not reached.
      if (signal?.aborted) throw error
      report.skipped.push(`${current.url} (${error instanceof Error ? error.message : String(error)})`)
    } finally {
      if (tabId) {
        try {
          await bridge.closeTab(tabId, signal)
        } catch {
          /* the engine reaps it anyway */
        }
      }
    }
  }

  // No second HTML rewrite pass is needed: a link's local file name is derived
  // from its URL when the link is first seen, so a page can already point at a
  // page that has not been crawled yet.
  //
  // Stylesheets do need a second look: one CSS file can reference assets that
  // were only discovered on a later page, and those are only known once the
  // crawl has finished.
  if (includeAssets) {
    for (const local of assetMap.values()) {
      if (!local.endsWith('.css')) continue
      const file = join(outDir, local)
      try {
        writeFileSync(file, rewriteStylesheet(readFileSync(file), assetMap))
      } catch {
        /* the stylesheet stays as downloaded, which is still readable */
      }
    }
  }

  const unreached = Math.max(0, discovered - report.pagesWritten)
  if (unreached > 0) report.skipped.push(`${unreached} discovered page(s) were not copied because maxPages (${maxPages}) was reached`)

  writeFileSync(
    join(outDir, 'mirror-manifest.json'),
    `${JSON.stringify({ capturedFrom: entry.toString(), capturedAt: new Date().toISOString(), ...report }, null, 2)}\n`,
  )
  log(`mirror finished: ${report.pagesWritten} page(s), ${report.assetsWritten} asset(s)`)
  // No tab is left open: every page's own `finally` closes the tab it opened,
  // including on the paths that `continue` out of the middle of the loop. A
  // second close here was closing a tab id the engine had already forgotten.
  return report
}

/**
 * Guess a file extension from a URL path and content type.
 *
 * @param {string} pathname - URL path.
 * @param {string} contentType - response content type.
 * @returns {string} an extension including the dot.
 */
function guessExtension(pathname, contentType) {
  const match = /\.([a-z0-9]{2,5})$/i.exec(pathname)
  if (match && match[1].length <= 5) return `.${match[1].toLowerCase()}`
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  const known = {
    'text/css': '.css',
    'text/javascript': '.js',
    'application/javascript': '.js',
    'application/x-javascript': '.js',
    'application/json': '.json',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/x-icon': '.ico',
    'image/vnd.microsoft.icon': '.ico',
    'font/woff': '.woff',
    'font/woff2': '.woff2',
    'application/font-woff': '.woff',
    'application/font-woff2': '.woff2',
    'video/mp4': '.mp4',
    'application/pdf': '.pdf',
    'text/html': '.html',
  }
  return known[type] ?? '.bin'
}