/**
 * The scope sweep never leaks an unhandled rejection.
 *
 * The sweep ran `void this.disposeScope(scope)` — `void` discards the promise with
 * no rejection handler. `disposeScope` logs inside its own catch, through
 * `engine.log`, and that write throws EPIPE once the host has closed stderr. The
 * catch block would then throw, the rejection would reach Node's default policy as
 * an uncaught exception, and in this host that is `process.exit(1)`: the whole
 * harness died over one routine cleanup line.
 *
 * A throwing logger is not hypothetical. The plugin's own log helper writes to
 * `process.stderr`, and its comments name the EPIPE case it is written to survive.
 * The same function reached from the `session/disposed` effect already attached a
 * `.catch`, so only the sweep path was exposed.
 *
 * This is the guard for that fix.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CamofoxBridge } from '../src/bridge.js'

test('the scope sweep leaks no unhandled rejection when a release fails', async () => {
  const unhandled = []
  const listener = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', listener)
  try {
    // An engine whose session close fails AND whose logger then throws — the
    // closed-stderr case the plugin's own index.js:252 comment describes.
    const engine = {
      config: { userId: 'dsh', perSessionScope: true, scopeIdleMs: 60000, maxTabs: 8, maxConcurrentPerUser: 3 },
      origin: 'http://127.0.0.1:9377',
      logPath: 'engine.log',
      status: () => ({}),
      lastError: null,
      async ensureReady() { return true },
      async request(method) {
        if (method === 'DELETE') {
          throw Object.assign(new Error('the camofox engine could not close the session'), {
            name: 'EngineError', status: 500, code: 'engine_error',
          })
        }
        return {}
      },
      // EPIPE / ERR_STREAM_DESTROYED once the host has closed the stream.
      log() { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) },
    }

    const bridge = new CamofoxBridge(engine)
    const scope = 'dsh~abc-0000001'
    // Live and idle far past scopeIdleMs, so the sweep selects it.
    bridge.scopeLastUsed.set(scope, Date.now() - 10 * 60 * 1000)

    // Any ordinary call runs #sweepScopes() at the top of call() (bridge.js:597).
    await bridge.call('GET', '/tabs', undefined, { query: { userId: scope } }).catch(() => {})

    // Let Node's microtask queue drain so the rejection is surfaced.
    await new Promise((r) => setTimeout(r, 50))

    console.log(`\n[scope-sweep] unhandled rejections observed: ${unhandled.length}`)
    for (const reason of unhandled) console.log(`[scope-sweep]   -> ${reason?.message ?? reason}`)

    assert.equal(
      unhandled.length,
      0,
      `EXPECTED the scope sweep to swallow its own failure; got ${unhandled.length} unhandled rejection(s): ` +
        unhandled.map((r) => r?.message ?? String(r)).join(' | '),
    )
  } finally {
    process.off('unhandledRejection', listener)
  }
})
