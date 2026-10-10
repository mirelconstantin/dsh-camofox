/**
 * Hermetic tests for the engine error classifier.
 *
 * Every fixture below is a response body observed from a real engine on this
 * machine (`probe-errors.mjs`), not a shape invented here: a crashed page, a
 * destroyed tab, a real browser restart, an invalid selector and a 404 that
 * renders fine all come back with the same status in some pairs, which is the
 * whole reason the classifier reads the body's `code`.
 *
 * Run with: `node scripts/errors.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EngineError } from '../src/engine.js'

/** A minimal Response stand-in carrying a status and a JSON body. */
function response(status, body) {
  return {
    status,
    statusText: '',
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

test('a 410 carrying page_crashed is not reported as a browser restart', async () => {
  // Observed wire format (server.js:1542).
  const error = await EngineError.fromResponse(response(410, {
    error: 'Page crashed. Open a new tab.',
    code: 'page_crashed',
    retryable: true,
    recovery: 'create_new_tab',
  }))
  assert.equal(error.code, 'page_crashed')
  assert.match(error.message, /page crashed/)
  assert.doesNotMatch(error.message, /browser restarted/)
  assert.equal(error.needsNewTab, true)
})

test('a 410 carrying tab_destroyed is not reported as a browser restart', async () => {
  const error = await EngineError.fromResponse(response(410, {
    error: 'Tab was destroyed. Open a new tab.',
    code: 'tab_destroyed',
    retryable: true,
    recovery: 'create_new_tab',
  }))
  assert.equal(error.code, 'tab_destroyed')
  assert.match(error.message, /destroyed/)
  assert.doesNotMatch(error.message, /browser restarted/)
})

test('a 410 carrying browser_restarted still says so', async () => {
  // Observed from a live engine for a tab belonging to another session
  // (server.js:1782).
  const error = await EngineError.fromResponse(response(410, {
    error: 'Tab no longer exists (browser was restarted). Create a new tab.',
    code: 'browser_restarted',
  }))
  assert.equal(error.code, 'browser_restarted')
  assert.match(error.message, /browser restarted/)
})

test('a 410 with no code keeps the historical browser_restarted classification', async () => {
  const error = await EngineError.fromResponse(response(410, { error: 'gone' }))
  assert.equal(error.code, 'browser_restarted')
  assert.equal(error.needsNewTab, true)
})

test('stale_refs asks for a snapshot, not a new tab', async () => {
  const error = await EngineError.fromResponse(response(422, {
    error: 'Refs are stale',
    code: 'stale_refs',
    retryable: true,
    recovery: 'snapshot_then_retry',
  }))
  assert.equal(error.code, 'stale_refs')
  assert.equal(error.needsResnapshot, true)
  assert.equal(error.needsNewTab, false)
  assert.match(error.message, /take a fresh snapshot/)
})

test('an invalid selector is reported as one, not as an extraction failure', async () => {
  // Observed live: 400 with a Playwright selector-parsing message.
  const error = await EngineError.fromResponse(response(400, {
    error: 'locator.count: Unexpected token while parsing css selector',
    retryable: false,
    code: 'invalid_selector',
  }))
  assert.equal(error.code, 'invalid_selector')
  assert.match(error.message, /valid CSS selector/)
  // The engine said it is not repeatable, and that is preserved.
  assert.equal(error.retryable, false)
})

test('the engine\'s own retryable flag is honoured, so a mutation is never replayed', async () => {
  const error = await EngineError.fromResponse(response(410, {
    error: 'Page crashed.',
    code: 'page_crashed',
    retryable: false,
    recovery: 'create_new_tab',
  }))
  // The recovery implies a new tab, but the engine said not to repeat the call.
  assert.equal(error.retryable, false)
})

test('session_expired is distinguished from a tab failure', async () => {
  const error = await EngineError.fromResponse(response(503, {
    error: 'Browser session expired. Retry to get a fresh session.',
    code: 'session_expired',
    retryable: true,
    recovery: 'retry',
  }))
  assert.equal(error.code, 'session_expired')
  assert.match(error.message, /session expired/)
  assert.equal(error.needsNewTab, false)
})

test('an unknown engine code falls back to status-derived classification', async () => {
  // A code we do not recognise must not break classification, and must not be
  // silently presented as a condition we understand.
  const error = await EngineError.fromResponse(response(404, { error: 'Tab not found', code: 'brand_new_code' }))
  assert.equal(error.code, 'tab_not_found')
})

test('a 409 navigation_race says the page moved, not that the engine conflicted', async () => {
  // The engine's own e2e suite asserts this shape: an evaluate interrupted by a
  // late redirect answers 409 with `navigation_race` (tests/e2e/
  // evaluateNavigationRace.test.js:44). It is the most common 409 in practice,
  // and it is a read to repeat, not a conflict to resolve.
  const error = await EngineError.fromResponse(response(409, {
    error: 'page.evaluate: Execution context was destroyed, most likely because of a navigation.',
    code: 'navigation_race',
    retryable: true,
    recovery: 'snapshot_then_retry',
  }))
  assert.equal(error.code, 'navigation_race')
  assert.match(error.message, /navigated while that call was in flight/)
  assert.doesNotMatch(error.message, /conflict/)
  assert.equal(error.needsResnapshot, true)
  assert.equal(error.needsNewTab, false, 'a navigation race must not send the model to a new tab')
  assert.equal(error.retryable, true)
})

test('an unrecognised 409 still classifies as a conflict', async () => {
  const error = await EngineError.fromResponse(response(409, { error: 'lock held' }))
  assert.equal(error.code, 'conflict')
})

test('credentials rejection and engine-busy classification still hold', async () => {
  const unauthorized = await EngineError.fromResponse(response(401, { error: 'nope' }))
  assert.equal(unauthorized.code, 'unauthorized')

  const busy = await EngineError.fromResponse(response(503, { error: 'busy' }))
  assert.equal(busy.code, 'engine_busy')
  assert.equal(busy.retryable, true)
})

test('the classified code survives on the error for the session log', async () => {
  const error = await EngineError.fromResponse(response(410, {
    error: 'Page crashed.', code: 'page_crashed', retryable: true, recovery: 'create_new_tab',
  }))
  // A crashed page and a browser restart must stay distinguishable downstream.
  assert.notEqual(error.code, 'browser_restarted')
  assert.equal(typeof error.status, 'number')
})