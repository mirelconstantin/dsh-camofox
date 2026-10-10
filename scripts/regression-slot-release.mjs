/**
 * A timed-out call returns its concurrency slot, so nothing wedges for ever.
 *
 * The consequence of an unbounded body read: `Semaphore.run` holds its slot across
 * `await task()`, and `maxConcurrentPerUser` is capped at 3, so three stalled reads
 * held every slot and every later call — including `camofox_status` and
 * `camofox_tabs`, which need no page at all — queued behind them and never ran.
 * That is what "the browser plugin is dead" felt like, and a restart did not help:
 * the reads were already past `fetch()` and waiting on a body.
 *
 * This is the guard for that fix. The window is generous on purpose: a call retries
 * twice with backoff, so one stalled call holds its slot for roughly three budgets.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { CamofoxBridge } from '../src/bridge.js'
import { CamofoxEngine, resolveConfig } from '../src/engine.js'

test('a timed-out call returns its concurrency slot, so nothing wedges', async (t) => {
  // An engine that answers /health normally (so readiness passes) and then stalls
  // every other body.
  const sockets = new Set()
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, engine: 'camoufox' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' })
    res.write('{"ok":true,')
    res.flushHeaders?.()
    // never res.end()
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => { for (const s of sockets) s.destroy(); server.close() })

  const port = server.address().port
  const config = resolveConfig({
    baseUrl: `http://127.0.0.1:${port}`,
    autostart: false,
    requestTimeoutMs: 2000,
    maxConcurrentPerUser: 3,
  })
  const engine = new CamofoxEngine({ config, log: () => {} })
  t.after(() => engine.dispose())
  const bridge = new CamofoxBridge(engine)
  const scope = 'dsh~wedge-0000001'

  // Confirm the engine is reachable and READY, so readiness is not what is failing.
  const ready = await engine.probe(2000)
  console.log(`\n[slots] engine probe ok (engine identifies as camoufox): ${Boolean(ready)}`)
  assert.ok(ready, 'precondition: the engine answers /health')

  // Three concurrent calls, exactly maxConcurrentPerUser. Each one stalls in the
  // body read until its request budget expires, and then RETRIES: `call` allows two
  // retries for an idempotent method with a 300ms-then-600ms backoff, so one call
  // occupies its slot for roughly three budgets plus the delays. The wait has to
  // outlast all of that, which is also the honest answer to "how long is a dead
  // engine allowed to hold the browser" — bounded, but not instant.
  const stalled = []
  for (let i = 0; i < 3; i += 1) {
    stalled.push(bridge.call('GET', `/read-${i}`, undefined, { query: { userId: scope } }).catch((e) => ({ failed: e })))
  }
  await new Promise((r) => setTimeout(r, 9000))

  console.log(`\n[slots] semaphore.active after the budget expired: ${bridge.semaphore.active} of limit ${bridge.semaphore.limit}`)

  // A fourth call — a cheap one, needing no page — must still be able to run.
  const fourth = bridge.call('GET', '/tabs', undefined, { query: { userId: scope } })
  // One handler, attached once: racing two `.then`s over the same promise leaves
  // the first rejection unhandled, which this runner reports as a failure.
  const settle = (promise) => promise.then((v) => ({ how: 'completed', v }), (e) => ({ how: 'failed', e }))
  // Long enough for the fourth call to run its own retry budget: the assertion
  // below distinguishes "reached the engine and failed on its budget" from "never
  // left the queue", and a too-short window would report the second as the first.
  const outcome = await Promise.race([settle(fourth), new Promise((r) => setTimeout(() => r({ how: 'WEDGED-QUEUED-FOREVER' }), 12000))])
  console.log(`[slots] the 4th call settled as: ${outcome.how}`)
  console.log(`[slots] semaphore.active now: ${bridge.semaphore.active}, queued waiters: ${bridge.semaphore.queue.length}`)

  // This is the regression guard. The bug it replaced: the body read was
  // unbounded, so the three slots were held for ever and every later call —
  // including `camofox_status` and `camofox_tabs`, which need no page at all —
  // queued behind them and never ran. That is what "the browser plugin is dead"
  // felt like, and nothing above the bridge could interrupt it.
  assert.equal(bridge.semaphore.active, 0, 'a timed-out call must return its semaphore slot, so nothing wedges for ever')
  assert.equal(bridge.semaphore.queue.length, 0, 'no call may be left queued behind a stalled one')

  // The fourth call gets a slot and then stalls on its OWN budget, because this
  // fake engine stalls every body including `/tabs`. It settling as a failure is
  // the proof that it ran at all — before the fix it never reached the engine and
  // stayed queued for ever.
  assert.notEqual(
    outcome.how,
    'WEDGED-QUEUED-FOREVER',
    'a 4th browser call must acquire a slot and reach the engine once the stalled calls have timed out',
  )
})
