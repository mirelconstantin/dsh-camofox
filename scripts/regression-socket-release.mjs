/**
 * A body read abandoned by a dead engine releases its HTTP socket.
 *
 * Two things were measured here rather than assumed. Cancelling `response.body`
 * does NOT close the undici connection — a socket is released only once its body
 * is drained, and a body that never finishes is never drained — so three timed-out
 * reads pinned three sockets against an engine that was already dead. Aborting the
 * request after the headers arrived does close it, and rejects the pending read.
 *
 * This is the guard for that fix: the budget must bound the caller AND the sockets
 * must go back to the pool. The server here sends headers with a Content-Length far
 * larger than the bytes it delivers, then stops, which is what a killed process
 * looks like on the wire.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { CamofoxEngine, resolveConfig } from '../src/engine.js'

/** An engine that dies mid-body: headers promise N bytes, delivers far fewer. */
function engineThatDiesMidBody() {
  const sockets = new Set()
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000000' })
    res.write('{"ok":true,"result":"')   // far less than the declared 5,000,000
    res.flushHeaders?.()
    // Never finish. The engine "died" here.
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  const ready = new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
  return { ready, server, openSockets: () => sockets.size, close: () => { for (const s of sockets) s.destroy(); server.close() } }
}

/**
 * Poll until a condition holds, or give up.
 *
 * Socket teardown is asynchronous on both ends of the connection, so a single
 * sample taken the moment a call rejects reports a socket that is still closing.
 * A real leak never converges, so the bound is what distinguishes the two.
 *
 * @param {() => boolean} ready - the condition to wait for.
 * @param {number} timeoutMs - how long to keep trying.
 * @returns {Promise<void>} nothing.
 */
async function waitFor(ready, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (!ready() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('a body read abandoned by a dead engine releases its HTTP socket', async (t) => {
  const stub = engineThatDiesMidBody()
  const port = await stub.ready
  t.after(() => stub.close())

  const engine = new CamofoxEngine({
    config: resolveConfig({ baseUrl: `http://127.0.0.1:${port}`, autostart: false, requestTimeoutMs: 2000 }),
    log: () => {},
  })
  engine.state = 'ready' // skip readiness bring-up; we are testing the read path
  t.after(() => engine.dispose())

  // Three reads against an engine that sends headers and then nothing. The body
  // read is bounded now, so each one has to give up on its budget AND release the
  // connection it was holding — a bound that only rejects the promise would still
  // pin a socket per call, and a session that hits this a few times exhausts the
  // connection pool against a server that is already dead.
  const abandoned = []
  for (let i = 0; i < 3; i += 1) {
    abandoned.push(engine.request('GET', `/blob-${i}`).then(() => 'resolved', (e) => ({ rejected: e.code })))
  }
  // Outlast the request budget, then give the abort time to reach the server and
  // the server's socket-close event to come back. The close is asynchronous on both
  // sides, so sampling the instant the call rejects races the teardown and reports
  // a socket that is about to close; it polls until the set empties instead, with a
  // bound of its own so a real leak still fails.
  await new Promise((r) => setTimeout(r, 3200))
  const outcomes = await Promise.all(abandoned)
  await waitFor(() => stub.openSockets() === 0, 3000)

  const socketsOpen = stub.openSockets()

  console.log(`\n[sockets] call outcomes: ${outcomes.map((o) => (o === 'resolved' ? o : o.rejected)).join(', ')}`)
  console.log(`[sockets] server-side open sockets after 3 abandoned reads: ${socketsOpen}`)

  for (const outcome of outcomes) {
    assert.notEqual(outcome, 'resolved', 'a read that never ends must not report success')
    assert.equal(outcome.rejected, 'engine_timeout', 'and it must report the timeout code')
  }
  assert.equal(
    socketsOpen,
    0,
    `a bounded read must also release its socket; ${socketsOpen} are still open against a dead engine`,
  )
})
