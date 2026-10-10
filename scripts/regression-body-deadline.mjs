/**
 * The request budget bounds the response BODY, not just the header exchange.
 *
 * `fetch` resolves when the response headers arrive, so a budget that is disposed
 * at that moment leaves the body read unbounded. Against an engine that sends
 * headers and then nothing, the call never settled — and because the bridge holds
 * a concurrency slot across the whole read, three such calls wedged every tool in
 * the plugin, with nothing above the bridge able to interrupt them.
 *
 * This is the guard for that fix: both the binary and the JSON branch must reject
 * with `engine_timeout` inside the configured budget.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CamofoxEngine, resolveConfig } from '../src/engine.js'

const stateDir = mkdtempSync(join(tmpdir(), 'camofox-regression-'))

/** A server that sends headers immediately and then stalls the body forever. */
function stalledServer() {
  return new Promise((resolve) => {
    const sockets = new Set()
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' })
      res.write('partial')
      res.flushHeaders?.()
      // Never call res.end(). The headers are on the wire; the body never finishes.
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, close: () => { for (const s of sockets) s.destroy() } })
    })
  })
}

test('the request budget bounds the response body, not just the headers', async (t) => {
  const { server, port, close } = await stalledServer()
  t.after(() => { close(); server.close(); rmSync(stateDir, { recursive: true, force: true }) })

  const config = resolveConfig({
    baseUrl: `http://127.0.0.1:${port}`,
    stateDir,
    autostart: false,
    // A small, deliberate budget so the proof is quick and unambiguous.
    requestTimeoutMs: 2000,
  })
  const engine = new CamofoxEngine({ config, log: () => {} })
  t.after(() => engine.dispose())

  const started = Date.now()
  // raw:true is the branch that does `await response.arrayBuffer()`.
  // That branch is used by the bridge for binary payloads.
  const call = engine.request('GET', '/raw-blob', undefined, { raw: true })

  // One handler, attached once. Racing two `.then`s over the same promise leaves
  // the first one's rejection unhandled, which Node reports as an uncaught
  // exception and which this runner turns into a failing test — so the race is
  // built from a single settled-shape conversion instead.
  const settle = (promise) => promise.then(
    (v) => ({ settled: 'resolved', v }),
    (e) => ({ settled: 'rejected', e }),
  )
  const outcome = await Promise.race([settle(call), new Promise((r) => setTimeout(() => r({ settled: 'STILL-PENDING' }), 6000))])

  const elapsed = Date.now() - started
  console.log(`\n[body] requestTimeoutMs=2000ms; after ${elapsed}ms the call settled as: ${outcome.settled}`)
  if (outcome.e?.message) console.log(`[body] rejection reason: ${outcome.e.message}`)

  // Second leg: the NON-raw branch, which is the path every ordinary tool call
  // takes. If that one IS bounded, the defect is limited to the binary payloads.
  const jsonCall = engine.request('GET', '/json-blob')
  const jsonOutcome = await Promise.race([settle(jsonCall), new Promise((r) => setTimeout(() => r({ settled: 'STILL-PENDING' }), 6000))])
  console.log(`[body] non-raw JSON branch (engine.js:1373) settled as: ${jsonOutcome.settled}`)
  if (jsonOutcome.e?.message) console.log(`[body] non-raw rejection reason: ${jsonOutcome.e.message}`)

  // This asserts the FIXED behaviour, and it is the regression guard for it.
  //
  // The bug this replaced: `fetch` resolves on response headers, the request
  // deadline was disposed as soon as it did, and the body read that followed was
  // unbounded. A dead engine that sends headers and then nothing left the call
  // pending forever, and because the bridge holds a concurrency slot across the
  // whole read, three such calls wedged every tool in the plugin.
  assert.equal(
    outcome.settled,
    'rejected',
    `the 2000ms requestTimeoutMs must bound the body read too; after ${elapsed}ms the call was ${outcome.settled}`,
  )
  assert.equal(outcome.e?.code, 'engine_timeout', 'and it must report the timeout code the other paths use')
  assert.equal(outcome.e?.retryable, true, 'a stalled engine is retryable')
  assert.notEqual(jsonOutcome.settled, 'STILL-PENDING', 'the JSON branch is bounded as well as the raw one')
})
