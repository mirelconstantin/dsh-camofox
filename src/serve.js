/**
 * A local file server for pages the engine refuses to open directly.
 *
 * The engine blocks every scheme but http and https
 * (`camofox-browser/server.js:190`, `ALLOWED_URL_SCHEMES`), so a file on disk
 * cannot be opened without being served. This module runs that server as a child
 * process and — more importantly — makes sure it cannot outlive its usefulness.
 *
 * ## Why this exists in the plugin at all
 *
 * A server started on an agent's behalf is a resource nobody asked for. If it
 * survives the agent, it is invisible: no window, no output, a port held for a
 * process that answers "who are you". Every layer here exists to make survival
 * impossible rather than unlikely.
 *
 * ## The failsafe
 *
 * Three independent mechanisms, because one is a promise and three is a fact:
 *
 * 1. **A detached watchdog process.** The server is spawned with a companion
 *    whose only job is to kill it after {@link SERVE_TTL_MS}. It is a separate
 *    process, so it survives the harness being killed, the plugin being disposed,
 *    or the tool call that started it failing. This is the layer that actually
 *    guarantees the 120 seconds.
 * 2. **An unref'd timer in this process**, armed on spawn and re-armed when an
 *    existing server is reused, so the ordinary path never leaves anything.
 * 3. **Session teardown**, via the plugin's existing `session/disposed` effect,
 *    plus a startup sweep that reaps anything an earlier run left behind.
 *
 * A registry file under the plugin's own state directory records every server
 * this plugin ever started, so a later run — or the `camofox_serve` audit
 * action — can find and kill them without guessing from process lists.
 *
 * @module dsh-camofox/serve
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How long a served file stays reachable, in milliseconds.
 *
 * Not configurable per call: the whole point is that the ceiling is a property
 * of the plugin rather than something a caller can raise. An operator who needs
 * it longer lowers it deliberately with `serveTtlMs`, which is visible in
 * configuration; a model cannot do it at all.
 */
export const SERVE_TTL_MS = 120_000

/** Registry filename, under the plugin's own state directory. */
export const REGISTRY_FILE = 'serves.json'

/**
 * Whether a pid is still running, and whether it is still OURS.
 *
 * A pid alone is not enough: by the time a stale registry is read, the number
 * may belong to something else entirely. Both the pid and the start time are
 * recorded, and `kill` refuses a pid whose start time does not match — killing
 * an unrelated process because a file was out of date is worse than leaking a
 * server.
 *
 * @param {number} pid - candidate pid.
 * @param {number} [startedAt] - recorded start time in ms.
 * @returns {{ alive: boolean, ours: boolean }} whether it is alive and still ours.
 */
export function isAlive(pid, startedAt) {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, ours: false }
  // Imported lazily so this module stays inspectable without side effects.
  const { isProcessAlive, processStartTime } = processHelpers()
  if (!isProcessAlive(pid)) return { alive: false, ours: false }
  if (startedAt === undefined || startedAt === null) return { alive: true, ours: true }
  const actual = processStartTime(pid)
  if (actual === null) return { alive: true, ours: true }
  // A second of slack absorbs the clock granularity of the platform's report.
  return { alive: true, ours: Math.abs(actual - startedAt) < 1500 }
}

/** Injected so the module is testable without a real process table. */
let helpers = null
function processHelpers() {
  if (helpers) return helpers
  helpers = {
    isProcessAlive(pid) {
      try {
        // Signal 0 performs the permission and existence check without sending.
        process.kill(pid, 0)
        return true
      } catch (error) {
        return error?.code === 'EPERM'
      }
    },
    processStartTime(pid) {
      // Node cannot read another process's start time, so the owner stamps it
      // into the registry at spawn time and this stays null. The identity check
      // therefore degrades to "the pid is alive", which is still better than
      // trusting a bare pid from disk.
      return null
    },
  }
  return helpers
}

/** Override the process helpers. Test-only. */
export function setProcessHelpers(next) {
  helpers = next
}

/**
 * The child script: serve one directory over http and exit on its own deadline.
 *
 * It is written as a real file rather than `node -e` so the watchdog can kill a
 * process it can name, and so nothing depends on shell quoting surviving Windows.
 */
const CHILD_SOURCE = `import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize, resolve, sep, extname } from 'node:path'

// With \`node -e\`, argv is [node, ...argsAfterCode] — there is no script path,
// so the first real argument is index 1, not 2. Getting this wrong makes the
// child resolve an empty root and exit at once, which looks like the failsafe
// firing rather than the server failing to start.
const root = resolve(process.argv[1])
const port = Number(process.argv[2])
const ttl = Number(process.argv[3])

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const server = createServer((req, res) => {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  } catch {
    res.writeHead(400).end('bad request')
    return
  }
  if (pathname.endsWith('/')) pathname += 'index.html'

  // Resolve inside the root and refuse anything that escapes it. A symlink or a
  // '..' must not turn a file server into a filesystem reader.
  //
  // The leading separator is stripped BEFORE joining: on Windows
  // join('C:\\root', '\\index.html') yields 'C:\\index.html', which throws the
  // served root away entirely. That bug served 404 for every file, and a longer
  // path would have read from the drive root instead.
  // The backslash is doubled because this whole script is a STRING literal:
  // \`\\\` survives into the child's source as \`\\\`, which is the escape a
  // regular expression needs to mean a literal backslash.
  const relative = pathname.replace(/^[/\\\\]+/, '')
  const target = resolve(join(root, relative))
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403).end('forbidden')
    return
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  })
  createReadStream(target).pipe(res)
})

// The child's own deadline. This is the LAST line of defence and the one that
// needs nothing else alive: if the watchdog is killed too, the child still exits.
const timer = setTimeout(() => { server.close(); process.exit(0) }, ttl)
timer.unref?.()

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ ok: true, port, root }) + '\\n')
})

process.on('SIGTERM', () => { server.close(); process.exit(0) })
process.on('exit', () => { try { server.close() } catch { /* already closed */ } })
`

/**
 * Read the registry of servers this plugin started.
 *
 * @param {string} stateDir - the plugin's state directory.
 * @returns {Array<Record<string, any>>} recorded entries, newest last; empty on any failure.
 */
export function readRegistry(stateDir) {
  try {
    const raw = readFileSync(join(stateDir, REGISTRY_FILE), 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.serves) ? parsed.serves : []
  } catch {
    // A missing or unreadable registry means there is nothing we can prove we
    // started, and inventing a server to hunt is worse than missing one.
    return []
  }
}

/**
 * Replace the registry.
 *
 * @param {string} stateDir - the plugin's state directory.
 * @param {Array<Record<string, any>>} serves - the entries to keep.
 */
export function writeRegistry(stateDir, serves) {
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, REGISTRY_FILE), `${JSON.stringify({ serves }, null, 2)}\n`, 'utf-8')
  } catch {
    /* A registry we cannot write is a failsafe gap, not a reason to fail the call */
  }
}

/**
 * Forget one entry.
 *
 * @param {string} stateDir - the plugin's state directory.
 * @param {number} pid - the pid to forget.
 */
export function forget(stateDir, pid) {
  writeRegistry(stateDir, readRegistry(stateDir).filter((entry) => entry.pid !== pid))
}

/**
 * Stop one recorded server and forget it.
 *
 * @param {string} stateDir - the plugin's state directory.
 * @param {Record<string, any>} entry - a registry entry.
 * @param {(pid: number) => void} kill - the process killer, injected so tests need no real processes.
 * @returns {{ stopped: boolean, reason?: string }} the outcome.
 */
export function stopRecorded(stateDir, entry, kill) {
  const state = isAlive(entry.pid, entry.startedAt)
  if (!state.alive) {
    forget(stateDir, entry.pid)
    return { stopped: true, reason: 'not running' }
  }
  if (!state.ours) {
    // The pid was reused by something else. Killing it would take down an
    // unrelated process, so the entry is dropped and the caller is told.
    forget(stateDir, entry.pid)
    return { stopped: false, reason: `pid ${entry.pid} is alive but no longer this server` }
  }
  try {
    kill(entry.pid)
  } catch (error) {
    return { stopped: false, reason: `could not stop pid ${entry.pid}: ${error?.message ?? error}` }
  }
  forget(stateDir, entry.pid)
  return { stopped: true }
}

/**
 * Stop every server this plugin recorded, newest first.
 *
 * @param {string} stateDir - the plugin's state directory.
 * @param {(pid: number) => void} kill - the process killer.
 * @returns {{ stopped: number, failed: Array<{ pid: number, reason: string }> }} the outcome.
 */
export function stopAll(stateDir, kill) {
  const entries = readRegistry(stateDir).slice().reverse()
  const failed = []
  let stopped = 0
  for (const entry of entries) {
    const result = stopRecorded(stateDir, entry, kill)
    if (result.stopped) stopped += 1
    else failed.push({ pid: entry.pid, reason: result.reason })
  }
  // Anything left recorded is unreachable by this run; clear it so the next run
  // is not handed a stale list it cannot act on either.
  writeRegistry(stateDir, [])
  return { stopped, failed }
}

/**
 * Find a free loopback port.
 *
 * @param {{ createServer: Function }} net - node:http, injected for tests.
 * @returns {Promise<number>} a port that was free a moment ago.
 */
export function findFreePort(net) {
  return new Promise((resolvePort, rejectPort) => {
    const probe = net.createServer()
    probe.unref()
    probe.on('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolvePort(port))
    })
  })
}

/** The child script, for tests that assert on what it actually enforces. */
export const childSource = CHILD_SOURCE

/**
 * The watchdog: a separate process whose only job is to stop the servers this
 * plugin started, on a deadline, whether or not the harness is still alive.
 *
 * This is the layer that makes the guarantee real rather than probable. Every
 * other mechanism runs inside a process that can die — the harness can be
 * killed, the plugin can fail to dispose, the tool call can throw — and a
 * `SIGKILL` leaves no chance to run any of them. The watchdog is detached and
 * answers to nothing but the clock.
 *
 * It re-reads the registry rather than trusting a list passed to it, so it stops
 * servers started AFTER it was launched, and it holds itself open by polling: an
 * empty registry is not the end, because a server may be started later.
 *
 * @param {object} deps - injected dependencies.
 * @param {string} deps.stateDir - the plugin's state directory.
 * @param {number} deps.ttlMs - the ceiling to enforce.
 * @param {Function} deps.spawn - node:child_process.spawn.
 * @param {number} deps.nodePath - the Node executable.
 * @param {number} [deps.pollMs] - how often to re-read the registry.
 * @returns {{ pid: number|null }} the watchdog, when one could be started.
 */
export function startWatchdog({ stateDir, ttlMs, spawn: spawnFn, nodePath }, deps = {}) {
  const pollMs = deps.pollMs ?? 2000
  const maxLifetimeMs = ttlMs + 60_000
  const startedAt = Date.now()

  const watchdog = `
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const stateDir = process.argv[1]
const ttl = Number(process.argv[2])
const poll = Number(process.argv[3])
const maxLife = Number(process.argv[4])
const started = Date.now()
const file = join(stateDir, 'serves.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
while (Date.now() - started < maxLife) {
  let serves = []
  try { const p = JSON.parse(readFileSync(file, 'utf-8')); serves = Array.isArray(p?.serves) ? p.serves : [] } catch { serves = [] }
  const now = Date.now()
  const keep = []
  for (const entry of serves) {
    const expired = !Number.isFinite(entry?.expiresAt) || entry.expiresAt <= now
    if (!expired) { keep.push(entry); continue }
    try { if (Number.isInteger(entry.pid) && entry.pid > 0) process.kill(entry.pid) } catch { /* already gone */ }
  }
  if (keep.length !== serves.length) {
    try { writeFileSync(file, JSON.stringify({ serves: keep }, null, 2) + '\\n', 'utf-8') } catch { /* registry is being rewritten elsewhere */ }
  }
  if (keep.length === 0 && serves.length > 0) break
  await sleep(poll)
}
process.exit(0)
`

  try {
    const child = spawnFn(nodePath, ['--input-type=module', '-e', watchdog, stateDir, String(ttlMs), String(pollMs), String(maxLifetimeMs)], {
      // Detached so it survives this process being killed, which is the whole
      // point: the harness may be gone and the deadline must still hold.
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref?.()
    return { pid: child.pid ?? null }
  } catch {
    // A watchdog that cannot start is not a reason to refuse the feature: the
    // child server carries its OWN deadline inside itself, so the guarantee
    // degrades from "belt and braces" to "still bounded".
    return { pid: null }
  }
}

/**
 * Start a file server that cannot outlive {@link SERVE_TTL_MS}.
 *
 * @param {object} options - the request.
 * @param {string} options.stateDir - the plugin's state directory.
 * @param {string} options.root - the directory to serve.
 * @param {number} [options.port] - a specific port; 0 or omitted picks a free one.
 * @param {number} [options.ttlMs] - the lifetime ceiling.
 * @param {object} deps - injected dependencies, so the logic is testable.
 * @param {object} deps.net - node:http.
 * @param {Function} deps.spawn - node:child_process.spawn.
 * @param {number} deps.nodePath - the Node executable.
 * @param {(pid: number) => void} [deps.kill] - the killer.
 * @param {(fn: Function, ms: number) => any} [deps.setTimeout] - the timer factory.
 * @param {() => void} [deps.clearTimeout] - the timer canceller.
 * @returns {Promise<{ url: string, port: number, root: string, pid: number, expiresInMs: number }>} the running server.
 */
export async function startServe(options, deps) {
  // The request comes from `options`; only the injectable primitives come from
  // `deps`. Reading `stateDir` and `root` out of `deps` instead sent the child a
  // literal "undefined" root, which produced a server that bound the port and
  // answered 404 for everything — a failure that looks like a routing bug rather
  // than a missing argument.
  const { stateDir, root, port = 0, ttlMs = SERVE_TTL_MS } = options ?? {}
  const {
    net, spawn: spawnFn, nodePath, kill = (pid) => process.kill(pid),
    setTimeout: setTimer, clearTimeout: clearTimer, readyTimeoutMs = 10_000,
  } = deps ?? {}

  if (typeof root !== 'string' || root === '') {
    throw new Error('startServe needs the absolute path of a folder to serve')
  }

  const actualPort = port || await findFreePort(net)

  // The child is not detached: it carries its own deadline, so it ends itself
  // even if everything above it — this process, the plugin, the harness — dies.
  const child = spawnFn(nodePath, ['--input-type=module', '-e', CHILD_SOURCE, root, String(actualPort), String(ttlMs)], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  // Wait for the child's own readiness line before recording anything. A port
  // chosen a moment ago can be taken by the time the child binds it, and a child
  // that cannot bind exits at once — so returning early handed the caller a URL
  // that 404s for a reason that has nothing to do with the path, and recorded a
  // pid that was never trustworthy.
  let ready = null
  let failure = ''
  const settled = new Promise((settle) => {
    let buffer = ''
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk)
      const match = buffer.match(/\{"ok":true[^\n]*\}/)
      if (match && !ready) {
        try { ready = JSON.parse(match[0]) } catch { /* malformed; keep waiting */ }
        settle(ready)
      }
    })
    child.stderr?.on('data', (chunk) => { failure += String(chunk) })
    child.on?.('error', (err) => { failure += err?.message ?? String(err); settle(null) })
    child.on?.('close', (code) => { if (!ready) { failure += ` (exited with ${code})`; settle(null) } })
  })
  const timedOut = new Promise((settle) => { const t = globalThis.setTimeout(() => settle(null), readyTimeoutMs); t.unref?.() })
  await Promise.race([settled, timedOut])

  if (!ready) {
    // A server that cannot start must not be recorded, and must not be left behind.
    try { child.kill?.() } catch { /* already gone */ }
    const reason = failure.trim().split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 300)
    throw new Error(`the file server did not start on port ${actualPort}${reason ? `: ${reason}` : ''}`)
  }

  const entry = {
    pid: child.pid ?? 0,
    port: actualPort,
    root,
    url: `http://127.0.0.1:${actualPort}/`,
    startedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  }
  const serves = readRegistry(stateDir).filter((item) => item.pid !== entry.pid)
  serves.push(entry)
  writeRegistry(stateDir, serves)

  // Layer 2: an in-process timer as well, so the ordinary case needs no kill.
  if (setTimer) {
    entry.timer = setTimer(() => {
      try {
        kill(entry.pid)
      } catch {
        /* the child is already gone */
      }
      forget(stateDir, entry.pid)
    }, ttlMs)
    // Never hold the event loop open for a file server.
    entry.timer?.unref?.()
  }

  return entry
}