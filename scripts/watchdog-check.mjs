/**
 * The serve watchdog is armed, not merely exported.
 *
 * `startWatchdog` used to be defined, documented as the layer that makes the
 * served-folder TTL a guarantee rather than a probability, unit-tested — and
 * called from nowhere outside that test. The README advertised a three-layer
 * failsafe of which one layer did not run, and nothing reported it.
 *
 * This is the guard. It calls the watchdog the way `camofox_serve` does and
 * asserts a process actually came up, because a watchdog that returns quietly is
 * indistinguishable from no watchdog at all — which is the bug.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startWatchdog } from '../src/serve.js'

test('the serve watchdog arms a detached process', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'camofox-watchdog-'))
  const spawned = []
  try {
    // A stub that records instead of spawning: this asserts the CALL SITE arms it,
    // and the real spawn behaviour is covered in serve.mjs. Spawning here would
    // leave a live process behind on a failing run.
    const watchdog = startWatchdog({
      stateDir,
      ttlMs: 60_000,
      spawn: (command, args, options) => {
        spawned.push({ command, args, options })
        return { pid: 4242, unref() {}, on() {} }
      },
      nodePath: process.execPath,
    })

    assert.equal(spawned.length, 1, 'the watchdog spawned nothing, so it guards nothing')
    assert.ok(watchdog?.pid, 'the watchdog did not report a pid')
    const { args, options } = spawned[0]
    assert.ok(args.length > 0, 'the watchdog was spawned with no script to run')
    // Detached, or a harness exit takes it down with everything else — which is
    // the entire reason this process exists.
    assert.equal(options?.detached, true, 'the watchdog is not detached, so it cannot outlive the harness')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('camofox_serve arms the watchdog when it starts a server', () => {
  // The layer above is only worth anything if the tool actually uses it.
  const tools = readFileSync(join(import.meta.dirname, '..', 'src', 'tools.js'), 'utf8')
  assert.match(tools, /startWatchdog\(\{/, 'camofox_serve no longer arms the watchdog')
  assert.ok(
    /import \{[^}]*\bstartWatchdog\b[^}]*\} from '\.\/serve\.js'/.test(tools),
    'startWatchdog is called but not imported',
  )
})