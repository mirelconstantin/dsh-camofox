#!/usr/bin/env node
/**
 * Standalone smoke test for the dsh-camofox browser core.
 *
 * Runs the real engine supervisor and every browser operation outside the
 * harness, so a regression shows up here instead of inside a live session.
 * Usage: node scripts/smoke.mjs [engineUrl]
 */
import { CamofoxEngine, resolveConfig } from '../src/engine.js'
import { CamofoxBridge } from '../src/bridge.js'
import { page as pageText } from '../src/util.js'
import { mirrorSite } from '../src/mirror.js'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const defaultRepo = process.env.CAMOFOX_REPO ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'camofox', 'repo') : join(homedir(), '.dsh', 'camofox', 'repo'))
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:9476'
const repoPath = process.argv[3] ?? defaultRepo
const lines = []
let failures = 0

/**
 * Serve a small site of same-origin links on an ephemeral loopback port.
 *
 * Bounding the crawl is a property of the mirror, not of whatever the internet
 * happens to serve today, so this step must not depend on a live site. A public
 * fixture whose links are all cross-origin cannot tell "the cap stopped it"
 * from "there was nothing left to copy", which is exactly the failure this
 * replaces.
 *
 * @param {number} pages - how many same-origin pages to publish.
 * @returns {Promise<{ url: string, close: () => void }>} the entry URL and a closer.
 */
async function serveLinkedPages(pages) {
  const links = Array.from({ length: pages }, (_, index) => `<a href="/p${index}.html">page ${index}</a>`).join('\n')
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    const body =
      path === '/' || path === '/index.html'
        ? `<!doctype html><html><head><title>fixture</title></head><body><h1>fixture index</h1>${links}</body></html>`
        : path.endsWith('.html')
          ? `<!doctype html><html><head><title>${path}</title></head><body><p>content of ${path}</p>${links}</body></html>`
          : null
    if (body === null) {
      response.writeHead(404, { 'content-type': 'text/html' })
      response.end('<!doctype html><html><body>not found</body></html>')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * @param {string} name - step name.
 * @param {() => Promise<any>} fn - the step.
 */
async function step(name, fn) {
  const startedAt = Date.now()
  try {
    const detail = await fn()
    lines.push(`PASS  ${name} (${Date.now() - startedAt}ms)${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures += 1
    lines.push(`FAIL  ${name} (${Date.now() - startedAt}ms) — ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * @param {boolean} value - condition that must hold.
 * @param {string} message - failure text.
 */
function assert(value, message) {
  if (!value) throw new Error(message)
}

const engine = new CamofoxEngine({
  // Its own port and its own supervised engine, so running this never touches
  // the engine a live harness is using.
  config: resolveConfig({ baseUrl, repoPath, autostart: true, userId: 'dsh-smoke', stateDir: join(tmpdir(), 'dsh-camofox-smoke') }),
  log: (message) => lines.push(`  log: ${message}`),
})
const bridge = new CamofoxBridge(engine)
// One scoped view for the whole script. Without an `exec` the scope resolves to
// the configured `userId` on its own, so this run keeps exactly the private jar
// it had before scoping existed.
const browser = bridge.for(undefined)

try {
  await step('engine answers a health probe', async () => {
    const health = await engine.probe(4000) ?? (await engine.ensureReady(), await engine.probe(4000))
    assert(health, `no health response from the engine: ${engine.lastError ?? 'unknown'}`)
    return `engine=${health.engine} ok=${health.ok}`
  })

  let tabId
  await step('open a tab', async () => {
    const opened = await browser.open({ url: 'https://example.com', sessionKey: 'smoke' }, undefined)
    tabId = opened.tabId
    assert(tabId, 'no tabId returned')
    return `tab=${tabId}`
  })

  await step('read an accessibility snapshot with refs', async () => {
    const snapshot = await browser.snapshot(tabId, {}, undefined)
    assert(typeof snapshot?.snapshot === 'string' && snapshot.snapshot.length > 0, 'empty snapshot')
    return `refs=${snapshot.refsCount} chars=${snapshot.totalChars}`
  })

  await step('read readable text through page JavaScript', async () => {
    const payload = await browser.evaluate(
      tabId,
      `(() => { const el = document.querySelector('main, article, [role=main]') || document.body; return (el.innerText || '').trim(); })()`,
      undefined,
    )
    const text = payload?.result ?? payload?.value ?? payload
    assert(typeof text === 'string' && text.length > 0, 'no page text')
    return `${text.slice(0, 40).replace(/\s+/g, ' ')}…`
  })

  await step('list links', async () => {
    const payload = await browser.links(tabId, { limit: 50 }, undefined)
    assert(Array.isArray(payload?.links), 'links were not an array')
    return `${payload.links.length} link(s)`
  })

  await step('wait for a selector that is present', async () => {
    const result = await browser.waitForSelector(tabId, 'body', { timeoutMs: 5000, visible: true }, undefined)
    assert(result.matched, 'body never matched')
    return `waited ${result.waitedMs}ms`
  })

  await step('wait for a selector that is absent reports failure', async () => {
    const result = await browser.waitForSelector(tabId, '.definitely-not-here', { timeoutMs: 1200 }, undefined)
    assert(result.matched === false, 'a missing selector reported a match')
    return `waited ${result.waitedMs}ms as expected`
  })

  await step('capture a screenshot', async () => {
    const bytes = await browser.screenshot(tabId, undefined)
    assert(Buffer.isBuffer(bytes) && bytes.length > 100, 'screenshot was empty')
    assert(bytes.subarray(1, 4).toString() === 'PNG', 'screenshot was not a PNG')
    return `${bytes.length} bytes`
  })

  await step('resize the viewport', async () => {
    const result = await browser.viewport(tabId, { width: 390, height: 844 }, undefined)
    assert(result?.width === 390, `viewport did not apply: ${JSON.stringify(result)}`)
    return '390x844'
  })

  await step('type into a field and press a key', async () => {
    const opened = await browser.open({ url: 'https://www.google.com', sessionKey: 'smoke' }, undefined)
    const inputTab = opened.tabId
    await browser.waitForSelector(inputTab, 'textarea[name=q], input[name=q]', { timeoutMs: 15000 }, undefined)
    await browser.type(inputTab, { selector: 'textarea[name=q], input[name=q]', text: 'harness' }, undefined)
    const pressed = await browser.press(inputTab, 'Enter', undefined)
    assert(pressed, 'key press produced no result')
    await browser.closeTab(inputTab, undefined)
    return 'typed and submitted'
  })

  await step('run a search macro', async () => {
    const opened = await browser.open({ macro: '@wikipedia_search', query: 'DeepSeek', sessionKey: 'smoke' }, undefined)
    assert(opened.tabId, 'macro navigation produced no tab')
    const snapshot = await browser.snapshot(opened.tabId, {}, undefined)
    assert(String(snapshot?.url ?? '').includes('wikipedia'), `unexpected macro target: ${snapshot?.url}`)
    await browser.closeTab(opened.tabId, undefined)
    return `landed on ${snapshot.url}`
  })

  await step('extract structured data from refs', async () => {
    const opened = await browser.open({ url: 'https://example.com', sessionKey: 'smoke' }, undefined)
    const extractTab = opened.tabId
    await browser.snapshot(extractTab, {}, undefined)
    const snapshot = await browser.snapshot(extractTab, {}, undefined)
    // Refs are rendered by the engine as `[e1]:`, not as a bare token at the
    // start of a line, which is what the previous `/(^|\s)e(\d+)/` looked for.
    // That regex never matched anything, and the hardcoded `e1` fallback below
    // it hid the fact: on any page with more than one ref this step would have
    // extracted from e1 while claiming to extract from "the first ref".
    const firstRef = /\[e(\d+)\]/.exec(snapshot.snapshot ?? '')
    assert(firstRef, 'the snapshot carried no [eN] refs to extract from')
    const ref = `e${firstRef[1]}`
    const result = await browser.extract(
      extractTab,
      { type: 'object', properties: { heading: { type: 'string', 'x-ref': ref } } },
      undefined,
    )
    // Without this the step only proved that extract() did not throw: a stubbed
    // or empty extraction reported PASS with `data: null`. The shape is asserted,
    // not the text, because which element `e1` lands on varies between renders.
    const data = result?.data
    assert(data && typeof data === 'object' && !Array.isArray(data), `no extraction payload: ${JSON.stringify(result).slice(0, 80)}`)
    // The value has to be real text, not a key holding null: an unknown ref is
    // accepted by the engine and answered with the requested key set to null,
    // which is a silent failure rather than an error.
    assert(typeof data.heading === 'string' && data.heading.length > 0, `ref ${ref} carried no text: ${JSON.stringify(data).slice(0, 80)}`)
    await browser.closeTab(extractTab, undefined)
    return `ref=${ref} data=${JSON.stringify(data).slice(0, 80)}`
  })

  await step('missing tab is classified, not crashed on', async () => {
    try {
      await browser.snapshot('tab-that-does-not-exist', {}, undefined)
    } catch (error) {
      assert(error.code === 'tab_not_found' || error.needsNewTab, `unexpected classification: ${error.code}`)
      return `classified as ${error.code}`
    }
    throw new Error('a missing tab unexpectedly succeeded')
  })

  await step('caller cancellation aborts the call', async () => {
    const controller = new AbortController()
    controller.abort()
    try {
      await browser.call('GET', '/health', undefined, { signal: controller.signal })
    } catch (error) {
      assert(error.code === 'canceled', `unexpected classification: ${error.code}`)
      return 'aborted cleanly'
    }
    throw new Error('a pre-aborted call unexpectedly succeeded')
  })

  const outDir = mkdtempSync(join(tmpdir(), 'dsh-camofox-mirror-'))

  await step('long pages page consistently', async () => {
    const opened = await browser.open({ url: 'https://playwright.dev/docs/intro' })
    const payload = await browser.snapshot(opened.tabId, {}, undefined)
    const body = String(payload?.snapshot ?? '')
    assert(body.length > 3000, `expected a long page, got ${body.length} characters`)

    /** @param {string} text - one page produced by the paging helper. @returns {string} its document slice. */
    const sliceOf = (text) => text.slice(text.indexOf('\n---\n') + 5, text.lastIndexOf('\n---\n'))

    const first = pageText(body, undefined, 800)
    const second = pageText(body, 800, 800)
    assert(first.includes('next offset=800'), 'the first page does not advertise the next offset')
    assert(second.includes('characters 800-1600'), `the second page has the wrong header: ${second.slice(0, 40)}`)
    assert(sliceOf(second) === body.slice(800, 1600), 'the second page does not continue where the first stopped')
    assert(sliceOf(first) !== sliceOf(second), 'paging returned the same text twice')
    await browser.closeTab(opened.tabId, undefined)
    return `${body.length} characters paged at 800`
  })

await step('mirror a single page with its assets', async () => {
    const report = await mirrorSite(browser, {
      url: 'https://example.com',
      outDir,
      maxPages: 1,
      maxDepth: 0,
      includeAssets: true,
      sameOrigin: true,
      respectRobots: false,
      maxAssetBytes: 5_000_000,
      log: () => {},
    })
    assert(report.pagesWritten === 1, `expected one page, wrote ${report.pagesWritten}`)
    assert(existsSync(join(outDir, 'index.html')), 'index.html was not written')
    const html = readFileSync(join(outDir, 'index.html'), 'utf8')
    assert(html.includes('Example Domain') || html.includes('documentation'), 'the mirrored document lost its content')
    // The rewrite is the whole point of a mirror: without it the folder is a
    // pile of HTML that still points at the internet.
    const localRefs = (html.match(/(?:src|href)="assets\//g) ?? []).length
    assert(report.assetsWritten > 0, 'no asset was downloaded')
    assert(localRefs > 0, 'no asset reference was rewritten to a local path')
    assert(existsSync(join(outDir, 'mirror-manifest.json')), 'the manifest was not written')
    return `${report.pagesWritten} page, ${report.assetsWritten} asset(s), ${localRefs} rewritten ref(s)`
  })

  await step('mirror follows links and names them locally', async () => {
    const report = await mirrorSite(browser, {
      url: 'https://www.iana.org/domains/reserved',
      outDir: join(outDir, 'crawl'),
      maxPages: 3,
      maxDepth: 1,
      includeAssets: false,
      sameOrigin: true,
      respectRobots: false,
      maxAssetBytes: 1_000_000,
      log: () => {},
    })
    assert(report.pagesWritten >= 2, `expected the crawl to follow links, copied ${report.pagesWritten} page(s)`)
    const index = readFileSync(join(outDir, 'crawl', 'index.html'), 'utf8')
    const localPageRefs = (index.match(/href="pages\//g) ?? []).length
    assert(localPageRefs > 0, 'no link was rewritten to a local page')
    return `${report.pagesWritten} page(s), ${localPageRefs} rewritten link(s)`
  })

  await step('mirror honours maxPages', async () => {
    const site = await serveLinkedPages(40)
    try {
      const report = await mirrorSite(browser, {
        url: site.url,
        outDir: join(outDir, 'bounded'),
        maxPages: 1,
        maxDepth: 2,
        includeAssets: false,
        sameOrigin: true,
        respectRobots: false,
        maxAssetBytes: 1_000_000,
        log: () => {},
      })
      assert(report.pagesWritten === 1, `wrote ${report.pagesWritten} pages despite maxPages 1`)
      // Proves the cap was actually reached, so this is a bounded crawl and not
      // a site that happened to have nothing left to copy.
      assert(
        report.skipped.some((line) => line.includes('maxPages (1) was reached')),
        `nothing was left uncopied, so the cap was never exercised: ${JSON.stringify(report.skipped)}`,
      )
      return `${report.pagesWritten} page of 41 available, cap reached`
    } finally {
      await site.close()
    }
  })

  rmSync(outDir, { recursive: true, force: true })

  await step('engine status is JSON-safe and scoped', async () => {
    const status = browser.status()
    JSON.stringify(status)
    assert(typeof status.state === 'string', 'no state')
    // A call with no execution has no session, so it must fall back to the
    // configured namespace rather than invent a scope per call.
    assert(status.scope === 'dsh-smoke', `unexpected scope: ${status.scope}`)
    assert(Array.isArray(status.trackedTabs), 'trackedTabs is not an array')
    assert(status.trackedTabCount >= status.trackedTabs.length, 'the capped list is larger than the count')
    return `state=${status.state} scope=${status.scope} tabs=${status.trackedTabCount} macros=${status.searchMacros.length}`
  })
} finally {
  await engine.dispose()
}

lines.push('')
lines.push(failures === 0 ? 'ALL STEPS PASSED' : `${failures} STEP(S) FAILED`)
console.log(lines.join('\n'))
process.exit(failures === 0 ? 0 : 1)
