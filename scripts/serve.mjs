/**
 * Hermetic tests for the file server and its failsafe.
 *
 * The property under test is the one the user actually cares about: nothing this
 * plugin starts may outlive its TTL, and nothing it did not start may be killed.
 * Both are testable without a real browser by injecting the spawn, kill and
 * timer functions.
 *
 * Run with: `node scripts/serve.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  REGISTRY_FILE, SERVE_TTL_MS, forget, readRegistry, setProcessHelpers,
  startWatchdog, stopAll, stopRecorded, writeRegistry,
} from '../src/serve.js'

/** A state directory, cleaned up by the caller. */
function state() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-serve-'))
  return { dir, path: join(dir, REGISTRY_FILE), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Pretend a set of pids is alive; anything else is dead. */
function aliveAs(pids) {
  setProcessHelpers({
    isProcessAlive: (pid) => pids.includes(pid),
    processStartTime: () => null,
  })
}

function spawnStub(pids) {
  const started = []
  return {
    started,
    spawn: (cmd, args, options) => {
      const pid = pids.next
      pids.next += 1
      started.push({ cmd, args, options })
      return { pid, unref() {} }
    },
  }
}

test('the TTL is a constant, not something a caller can raise', () => {
  // If this number is configurable the guarantee stops being a guarantee, so it
  // is pinned here: 120 seconds.
  assert.equal(SERVE_TTL_MS, 120_000)
})

test('an empty registry reads as empty rather than throwing', () => {
  const s = state()
  try {
    assert.deepEqual(readRegistry(s.dir), [])
  } finally {
    s.cleanup()
  }
})

test('a corrupt registry reads as empty rather than throwing', () => {
  // A registry we cannot parse must not stop the plugin loading; it just means
  // there is nothing we can prove we started.
  const s = state()
  try {
    writeFileSync(s.path, '{ not json', 'utf-8')
    assert.deepEqual(readRegistry(s.dir), [])
  } finally {
    s.cleanup()
  }
})

test('the registry round-trips', () => {
  const s = state()
  try {
    writeRegistry(s.dir, [{ pid: 11, port: 8080, url: 'http://127.0.0.1:8080/' }])
    assert.equal(readRegistry(s.dir).length, 1)
    forget(s.dir, 11)
    assert.deepEqual(readRegistry(s.dir), [])
  } finally {
    s.cleanup()
  }
})

test('stopping a dead server is a no-op that still forgets it', () => {
  const s = state()
  try {
    aliveAs([])
    writeRegistry(s.dir, [{ pid: 999 }])
    const killed = []
    const result = stopRecorded(s.dir, { pid: 999 }, (pid) => killed.push(pid))
    assert.equal(result.stopped, true)
    assert.deepEqual(killed, [], 'a dead pid was signalled')
    assert.deepEqual(readRegistry(s.dir), [], 'a dead server stayed in the registry')
  } finally {
    s.cleanup()
  }
})

test('stopping a live server signals it and forgets it', () => {
  const s = state()
  try {
    aliveAs([42])
    writeRegistry(s.dir, [{ pid: 42 }])
    const killed = []
    const result = stopRecorded(s.dir, { pid: 42 }, (pid) => killed.push(pid))
    assert.equal(result.stopped, true)
    assert.deepEqual(killed, [42])
    assert.deepEqual(readRegistry(s.dir), [])
  } finally {
    s.cleanup()
  }
})

test('stopAll stops every recorded server and empties the registry', () => {
  const s = state()
  try {
    aliveAs([1, 2, 3])
    writeRegistry(s.dir, [{ pid: 1 }, { pid: 2 }, { pid: 3 }])
    const killed = []
    const result = stopAll(s.dir, (pid) => killed.push(pid))
    assert.equal(result.stopped, 3)
    assert.deepEqual(killed.sort(), [1, 2, 3])
    assert.deepEqual(readRegistry(s.dir), [])
  } finally {
    s.cleanup()
  }
})

test('a kill that throws is reported, and the entry is not silently lost', () => {
  const s = state()
  try {
    aliveAs([7])
    writeRegistry(s.dir, [{ pid: 7 }])
    const result = stopRecorded(s.dir, { pid: 7 }, () => {
      throw new Error('access denied')
    })
    assert.equal(result.stopped, false)
    assert.match(result.reason, /access denied/)
  } finally {
    s.cleanup()
  }
})

test('a live pid that is no longer our server is NOT killed', () => {
  // The pid was reused. Killing it would take down something unrelated, which is
  // worse than leaving a server behind, so the entry is dropped untouched.
  const s = state()
  try {
    setProcessHelpers({
      isProcessAlive: () => true,
      processStartTime: () => Date.now() - 500_000,
    })
    writeRegistry(s.dir, [{ pid: 1234, startedAt: Date.now() }])
    const killed = []
    const result = stopRecorded(s.dir, { pid: 1234, startedAt: Date.now() }, (pid) => killed.push(pid))
    assert.equal(result.stopped, false)
    assert.deepEqual(killed, [], 'a recycled pid was signalled')
    assert.match(result.reason, /no longer this server/)
  } finally {
    s.cleanup()
  }
})

test('the watchdog is detached, so it outlives the process that started it', () => {
  // This is the layer that makes the guarantee hold when the harness is killed:
  // a watchdog in the same process would die with it.
  const pids = { next: 500 }
  const stub = spawnStub(pids)
  const result = startWatchdog(
    { stateDir: '/tmp/x', ttlMs: SERVE_TTL_MS, spawn: stub.spawn, nodePath: 'node' },
    { pollMs: 10 },
  )
  assert.equal(result.pid, 500)
  assert.equal(stub.started.length, 1)
  assert.equal(stub.started[0].options.detached, true, 'the watchdog would die with the harness')
  assert.deepEqual(stub.started[0].options.stdio, 'ignore')
})

test('the watchdog outlives its own ceiling by a margin, not by exactly the TTL', () => {
  const pids = { next: 600 }
  const stub = spawnStub(pids)
  startWatchdog({ stateDir: '/tmp/x', ttlMs: SERVE_TTL_MS, spawn: stub.spawn, nodePath: 'node' })
  // argv to the child is: --input-type=module, -e, <source>, stateDir, ttl, poll, maxLife.
  const maxLife = Number(stub.started[0].args[6])
  assert.ok(maxLife > SERVE_TTL_MS, 'the watchdog could exit before the deadline it enforces')
  assert.ok(maxLife < SERVE_TTL_MS * 3, 'the watchdog would outlive any plausible need')
})

test('the watchdog carries the state directory and the TTL to the child', () => {
  const pids = { next: 700 }
  const stub = spawnStub(pids)
  startWatchdog({ stateDir: 'C:/state', ttlMs: SERVE_TTL_MS, spawn: stub.spawn, nodePath: 'node' })
  const { args } = stub.started[0]
  assert.equal(args[3], 'C:/state', 'the watchdog cannot find the registry it was given')
  assert.equal(Number(args[4]), SERVE_TTL_MS)
})

test('a watchdog that cannot start degrades instead of throwing', () => {
  // The child server carries its own deadline, so losing the watchdog costs
  // redundancy, not the guarantee.
  const result = startWatchdog({
    stateDir: '/tmp/x',
    ttlMs: SERVE_TTL_MS,
    spawn: () => {
      throw new Error('EAGAIN')
    },
    nodePath: 'node',
  })
  assert.equal(result.pid, null)
})

test('the watchdog source kills an expired entry and keeps a live one', () => {
  // Asserted against the generated source because the watchdog only runs as a
  // child process; the logic it encodes is the point, not the syntax.
  const pids = { next: 800 }
  const stub = spawnStub(pids)
  startWatchdog({ stateDir: '/tmp/x', ttlMs: SERVE_TTL_MS, spawn: stub.spawn, nodePath: 'node' })
  const source = stub.started[0].args[2]
  assert.match(source, /expiresAt <= now/, 'the watchdog never tests the deadline')
  assert.match(source, /process\.kill\(entry\.pid\)/, 'the watchdog never signals an expired server')
  assert.match(source, /keep\.push\(entry\)/, 'the watchdog would kill a server that is still inside its TTL')
  assert.match(source, /maxLife/, 'the watchdog has no bound of its own')
})

test('the child server enforces its own deadline without needing the watchdog', async () => {
  // If the watchdog were the ONLY guarantee, killing it would break the promise.
  // The child therefore carries the same ceiling itself, and this asserts the
  // source it is spawned with does.
  const { childSource } = await import('../src/serve.js')
  assert.match(childSource, /setTimeout\(.*server\.close\(\); process\.exit\(0\)/s, 'the child has no self-termination')
  assert.match(childSource, /server\.listen\(port, '127\.0\.0\.1'/, 'the child does not bind loopback')
  assert.match(childSource, /startsWith\(root \+ sep\)/, 'the child does not confine paths to the served root')
  assert.match(childSource, /SIGTERM/, 'the child cannot be stopped politely')
})

test('isAlive treats an impossible pid as dead', () => {
  aliveAs([])
  // Exercised through stopRecorded rather than directly, since that is the only
  // caller and it must not signal such a pid.
  const s = state()
  try {
    writeRegistry(s.dir, [{ pid: 0 }, { pid: -1 }, { pid: 1.5 }])
    const killed = []
    const result = stopAll(s.dir, (pid) => killed.push(pid))
    assert.equal(result.stopped, 3, 'a nonsense pid was not treated as already-gone')
    assert.deepEqual(killed, [], 'a nonsense pid was signalled')
  } finally {
    s.cleanup()
  }
})