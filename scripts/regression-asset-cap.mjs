import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { readCapped } from '../src/mirror.js'

// The bug this guards: `fetchAsset` gated on `content-length`, which is absent for
// every chunked response, then called `arrayBuffer()` — so a host that streams
// without declaring a size had its entire body resident in this process before
// anything rejected it. The documented 8 MB cap was not a cap at all for exactly
// the responses most likely to be huge.

const MiB = 1024 * 1024
const CAP = 8 * MiB

let peak = 0
const sample = setInterval(() => {
  const used = process.memoryUsage().heapUsed
  if (used > peak) peak = used
}, 5)

/**
 * A server that streams a body with no Content-Length.
 *
 * @param {number} total - how many bytes to stream.
 * @returns {Promise<{ port: number, close: () => void }>} the listening server.
 */
function chunkedServer(total) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' })
    const block = Buffer.alloc(1 * MiB, 0x61)
    let sent = 0
    const pump = () => {
      while (sent < total) {
        sent += block.length
        if (!res.write(block)) {
          res.once('drain', pump)
          return
        }
      }
      // Deliberately oversized: the reader must give up before this ends.
      res.end(block)
    }
    pump()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => server.close() })
    })
  })
}

const baseline = process.memoryUsage().heapUsed
const server = await chunkedServer(64 * MiB)

try {
  const response = await fetch(`http://127.0.0.1:${server.port}/asset`)
  console.log('content-length header:', response.headers.get('content-length'))
  console.log('cap:', `${CAP / MiB} MB`)

  const started = Date.now()
  const bytes = await readCapped(response, CAP)
  const elapsed = Date.now() - started

  console.log('result:', bytes === null ? 'null (rejected)' : `${bytes.length} bytes`)
  console.log('settled in:', `${elapsed}ms`)

  assert(bytes === null, 'an oversized streaming body must be rejected')
  assert(elapsed < 10_000, `it took ${elapsed}ms, which is too slow to be an early rejection`)

  // Give the reader's cancellation a moment, then measure.
  await new Promise((r) => setTimeout(r, 500))
  const grew = peak - baseline
  console.log('peak heap growth:', `${(grew / MiB).toFixed(1)} MB`)
  // 64 MB was on the wire. Buffering it all would show here; an early rejection
  // never holds more than the cap plus whatever the socket had buffered.
  assert(grew < 40 * MiB, `heap grew ${(grew / MiB).toFixed(1)} MB, which suggests the body was buffered before being rejected`)
  console.log('PASS: the cap is enforced while the body arrives')
} finally {
  clearInterval(sample)
  server.close()
}