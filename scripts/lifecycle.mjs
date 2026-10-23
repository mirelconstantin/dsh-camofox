#!/usr/bin/env node
/**
 * Lifecycle test for the engine supervisor.
 *
 * Proves the three properties the browser integration depends on: the engine
 * starts on demand, a second supervisor adopts it instead of starting another,
 * and disposal takes the whole process tree down. It runs on a private port so
 * a real engine in use is never disturbed.
 *
 * Usage: node scripts/lifecycle.mjs [repoPath]
 */
import { spawn, spawnSync } from 'node:child_process'
import { CamofoxEngine, resolveConfig } from '../src/engine.js'
import { CamofoxBridge } from '../src/bridge.js'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { killProcessTree } from '../src/util.js'

const defaultRepo = process.env.CAMOFOX_REPO ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'camofox', 'repo') : join(homedir(), '.dsh', 'camofox', 'repo'))
const repoPath = process.argv[2] ?? defaultRepo
const port = Number(process.env.CAMOFOX_TEST_PORT ?? 9477)
const baseUrl = `http://127.0.0.1:${port}`
const lines = []
let failures = 0

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

/**
 * @param {number} pid - process id.
 * @returns {boolean} whether the process is alive.
 */
function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const stateDir = join(tmpdir(), `dsh-camofox-lifecycle-${process.pid}`)
const makeEngine = () =>
  new CamofoxEngine({
    config: resolveConfig({
      baseUrl,
      repoPath,
      autostart: true,
      stateDir,
      startTimeoutMs: 150000,
      shutdownTimeoutMs: 2000,
      restartLimit: 1,
      userId: 'dsh-lifecycle',
    }),
    log: (message) => lines.push(`  log: ${message}`),
  })

let first
let childPid

try {
  await step('nothing is listening before the first start', async () => {
    assert(!(await makeEngine().probe(1000)), 'something already answered on the test port')
    return `port ${port} was free`
  })

  await step('the engine starts on demand', async () => {
    first = makeEngine()
    const ready = await first.ensureReady()
    assert(ready, `engine did not become ready: ${first.lastError}`)
    childPid = first.child?.pid
    assert(alive(childPid), 'the supervised child is not alive')
    return `pid=${childPid} state=${first.state}`
  })

  await step('a lock file records the supervised process', async () => {
    const lockPath = join(stateDir, 'engine.json')
    assert(existsSync(lockPath), 'no lock file was written')
    const record = JSON.parse(readFileSync(lockPath, 'utf8'))
    assert(record.pid === childPid, `lock file records pid ${record.pid}, expected ${childPid}`)
    assert(record.owner === 'dsh-camofox', 'lock file has no owner marker')
    return `pid=${record.pid}`
  })

  await step('the browser actually works through the supervised engine', async () => {
    const bridge = new CamofoxBridge(first)
    // One scoped view for the script; with no `exec` the scope is the configured
    // `userId` on its own.
    const browser = bridge.for(undefined)
    const opened = await browser.open({ url: 'https://example.com' }, undefined)
    const snapshot = await browser.snapshot(opened.tabId, {}, undefined)
    assert(typeof snapshot?.snapshot === 'string' && snapshot.snapshot.length > 0, 'empty snapshot')
    await browser.closeTab(opened.tabId, undefined)
    return 'opened, read, and closed a tab'
  })

  await step('a second supervisor adopts the running engine instead of starting another', async () => {
    const second = makeEngine()
    const ready = await second.ensureReady()
    assert(ready, 'adoption failed')
    assert(second.child === null, 'the second supervisor started its own process')
    assert(second.owned === false, 'the second supervisor claimed ownership')
    await second.dispose()
    return 'adopted without spawning'
  })

  await step('disposal kills the engine process tree', async () => {
    await first.dispose()
    const stillAlive = alive(childPid)
    assert(!stillAlive, `pid ${childPid} survived disposal`)
    const probe = await makeEngine().probe(1200)
    assert(!probe, 'the engine still answers after disposal')
    return `pid ${childPid} is gone and the port is closed`
  })

  await step('the lock file is removed on disposal', async () => {
    assert(!existsSync(join(stateDir, 'engine.json')), 'the lock file outlived the engine')
    return 'clean'
  })

  await step('a stale lock is reaped instead of being adopted', async () => {
    // A real earlier run: a separate process starts an engine and dies without
    // disposing, leaving a live engine and a lock file naming it.
    const orphan = spawnSync(process.execPath, ['scripts/orphan.mjs', baseUrl, stateDir, repoPath], {
      encoding: 'utf8',
      timeout: 180000,
      windowsHide: true,
    })
    const orphanPid = Number(String(orphan.stdout ?? '').trim())
    assert(orphan.status === 0, `the orphan simulator failed: ${orphan.stderr || orphan.stdout}`)
    assert(Number.isInteger(orphanPid) && orphanPid > 0, 'the orphan simulator returned no pid')
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert(alive(orphanPid), 'the simulated orphan died with its supervisor')

    const replacement = makeEngine()
    const ready = await replacement.ensureReady()
    assert(ready, 'the replacement engine did not start')
    assert(replacement.owned === true, 'the replacement engine did not take ownership')
    assert(!alive(orphanPid), `the stale engine pid ${orphanPid} was not reaped`)
    await replacement.dispose()
    return `reaped pid ${orphanPid} from an earlier run and took ownership`
  })

  await step('an engine supervised by another live process is adopted, never reaped', async () => {
    // A separate process that keeps running is what a real harness looks like
    // from the outside. Sharing the state directory must never make this
    // process treat a healthy, owned engine as a leftover.
    let enginePid = 0
    const child = spawn(process.execPath, ['scripts/live-owner.mjs', baseUrl, stateDir, repoPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      enginePid = await new Promise((resolve, reject) => {
        let buffer = ''
        const timer = setTimeout(() => reject(new Error('the live owner never reported a pid')), 60000)
        child.stdout.on('data', (chunk) => {
          buffer += chunk
          const line = buffer.split(/\r?\n/).find((value) => /^\d+$/.test(value.trim()))
          if (line) {
            clearTimeout(timer)
            resolve(Number(line.trim()))
          }
        })
        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.on('exit', (code) => {
          if (code !== 0) {
            clearTimeout(timer)
            reject(new Error(`live owner exited with code ${code}`))
          }
        })
      })
      assert(alive(enginePid), 'the live owner reported a pid that is not running')

      const guest = makeEngine()
      assert(await guest.ensureReady(), 'the guest supervisor did not adopt the live engine')
      assert(guest.owned === false, 'the guest claimed ownership of an engine another process supervises')
      assert(guest.child === null, 'the guest started a second engine')
      await guest.dispose()
      assert(alive(enginePid), `adoption destroyed pid ${enginePid}, which a live process owns`)
      return `adopted and left pid ${enginePid} owned by another process`
    } finally {
      // The simulator is deliberately detached and survives its owner, so the
      // test has to clean it up or every later step sees a taken port.
      child.kill()
      if (enginePid) killProcessTree(enginePid, spawnSync)
      try { rmSync(join(stateDir, 'engine.json'), { force: true }) } catch {}
    }
  })

  await step('an engine with no lock of ours is adopted and never killed', async () => {
    const owner = new CamofoxEngine({
      config: resolveConfig({
        baseUrl,
        repoPath,
        autostart: true,
        stateDir,
        startTimeoutMs: 150000,
        shutdownTimeoutMs: 2000,
        userId: 'dsh-adopt',
      }),
      log: () => {},
    })
    assert(await owner.ensureReady(), 'could not start the engine to be adopted')
    const foreignPid = owner.child?.pid
    // Drop our lock so the engine looks like somebody else's deliberate
    // instance; adoption must then be completely non-destructive.
    try { rmSync(join(stateDir, 'engine.json'), { force: true }) } catch {}

    const guest = makeEngine()
    assert(await guest.ensureReady(), 'the guest supervisor did not adopt the engine')
    assert(guest.owned === false, 'the guest claimed ownership of an engine it did not start')
    assert(guest.child === null, 'the guest started its own process')
    await guest.dispose()
    assert(alive(foreignPid), `adoption destroyed pid ${foreignPid}, which we do not own`)
    await owner.dispose()
    return `adopted and left pid ${foreignPid} untouched`
  })

  await step('disposing twice is a no-op', async () => {
    const engine = makeEngine()
    await engine.ensureReady()
    await engine.dispose()
    await engine.dispose()
    return 'safe'
  })

  await step('a missing engine entry point fails loudly, not silently', async () => {
    const broken = new CamofoxEngine({
      config: resolveConfig({ baseUrl, repoPath: join(tmpdir(), 'nope-does-not-exist'), autostart: true, stateDir, userId: 'dsh-broken' }),
      log: () => {},
    })
    const ready = await broken.ensureReady()
    assert(!ready, 'a broken configuration reported ready')
    assert(broken.lastError, 'no error was recorded')
    await broken.dispose()
    return broken.lastError.slice(0, 60)
  })

  await step('autostart disabled leaves the engine untouched', async () => {
    const passive = new CamofoxEngine({
      config: resolveConfig({ baseUrl, repoPath, autostart: false, stateDir, userId: 'dsh-passive' }),
      log: () => {},
    })
    const ready = await passive.ensureReady()
    assert(!ready, 'a passive supervisor reported ready')
    assert(passive.child === null, 'a passive supervisor started a process')
    await passive.dispose()
    return 'reported unavailable without spawning'
  })
} finally {
  if (first) await first.dispose()
  if (childPid) killProcessTree(childPid, spawnSync)
  try { rmSync(stateDir, { recursive: true, force: true }) } catch {}
}

lines.push('')
lines.push(failures === 0 ? 'ALL STEPS PASSED' : `${failures} STEP(S) FAILED`)
console.log(lines.join('\n'))
process.exit(failures === 0 ? 0 : 1)
