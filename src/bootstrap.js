/**
 * First-run engine bootstrap.
 *
 * The engine is a separate product — `@askjo/camofox-browser`, MIT, Jo, Inc — and this
 * package drives it rather than containing it. It used to have to be cloned and installed
 * by hand before a single browser tool worked, which made the first error a new user saw
 * an instruction rather than a browser. It is installed here instead, on the first spawn
 * that cannot find it.
 *
 * Two things make this more than an `npm install` wrapper:
 *
 *  - **The install script does not run.** npm 11 gates lifecycle scripts behind
 *    `allow-scripts` (`npm warn allow-scripts … postinstall: node postinstall.js`), and
 *    exits zero having done nothing. That script is what downloads the browser binary, so
 *    `npm install` alone leaves a machine with a working engine and no browser. The
 *    downloader is invoked directly and its result is checked.
 *
 *  - **A failure has to be retryable.** `npm install` writes into the target directory and
 *    can stop halfway; the next attempt must not refuse to run because the directory now
 *    exists. Nothing is deleted, because `installAddonPlugin` edits
 *    `<repoPath>/camofox.config.json` in place and an operator's edits live there.
 *
 * The browser binary is ~1.06 GB and is cached outside `repoPath`, so the first run on a
 * clean machine downloads it once and every later run reuses it.
 *
 * @module dsh-camofox/bootstrap
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'
import { isProcessAlive } from './util.js'

/**
 * npm package that provides the engine.
 *
 * Scoped on purpose. The unscoped `camofox-browser` is a different publisher's package
 * with no root `server.js`, so installing it yields an engine that cannot be started and
 * an error that reads like a broken install rather than the wrong package.
 */
export const ENGINE_PACKAGE = '@askjo/camofox-browser'

/**
 * Engine version this plugin is verified against.
 *
 * Pinned rather than ranged: the engine's REST surface and its environment variables are
 * this plugin's contract, so a minor bump upstream is something to test, not something to
 * discover on a user's machine.
 */
export const ENGINE_VERSION = '1.18.1'

/** File the plugin spawns, relative to the installed engine directory. */
export const ENGINE_ENTRY = 'server.js'

/** Where npm places the package once installed under `repoPath`. */
export function engineDir(repoPath) {
  return join(repoPath, 'node_modules', '@askjo', 'camofox-browser')
}

/**
 * Absolute path of the engine entry point, whether `repoPath` already points at the
 * installed package or at the directory that contains it.
 *
 * A git checkout has `server.js` at its root and an npm install has it under
 * `node_modules`, so both layouts are accepted and only the npm one is created.
 *
 * @param {string} repoPath - configured engine directory.
 * @param {string} entry - entry file name, usually `server.js`.
 * @returns {string} an absolute path; the caller checks whether it exists.
 */
export function resolveEntry(repoPath, entry = ENGINE_ENTRY) {
  const base = resolve(repoPath)
  if (existsSync(join(base, entry))) return join(base, entry)
  return join(engineDir(base), entry)
}

/**
 * Directory npm caches the Camoufox browser binary in.
 *
 * Read from the engine's own `postinstall.js` convention rather than invented here, so a
 * bootstrap and a later manual `npm run fetch-bin` agree on the same cache.
 *
 * @returns {string} an absolute cache directory.
 */
export function camoufoxCacheDir() {
  const home = homedir()
  if (platform() === 'darwin') return join(home, 'Library', 'Caches', 'camoufox')
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'camoufox', 'camoufox', 'Cache')
  return join(process.env.XDG_CACHE_HOME || join(home, '.cache'), 'camoufox')
}

/** Whether the Camoufox binary has already been downloaded on this machine. */
export function browserCached() {
  return existsSync(join(camoufoxCacheDir(), 'version.json'))
}

/**
 * Outcome of a bootstrap attempt.
 *
 * Never throws and never rejects: a machine with no network, no disk or no permission is
 * a reportable state, not a reason to take the plugin down.
 *
 * @typedef {object} BootstrapResult
 * @property {boolean} ok - whether a runnable engine is now present.
 * @property {string} entry - the entry point the plugin should spawn.
 * @property {boolean} installed - whether this call performed the install.
 * @property {boolean} browserReady - whether the browser binary is present.
 * @property {string} [reason] - why it is not ready, phrased for a human.
 */

/**
 * Install the engine into `repoPath` if it is not already there.
 *
 * Safe to call concurrently and repeatedly. Concurrent callers converge on one install
 * through a lock file, and a caller that finds the entry already present does nothing at
 * all — so an ordinary run on a configured machine never touches npm.
 *
 * @param {object} options - what to install and where.
 * @param {string} options.repoPath - directory to install into.
 * @param {string} [options.entry] - entry file name.
 * @param {string} [options.npmPath] - Node executable used to run npm.
 * @param {string|null} [options.npmCli] - npm CLI entry point; resolved when omitted.
 * @param {AbortSignal} [options.signal] - cancels the install.
 * @param {(message: string) => void} [options.log] - progress reporter.
 * @param {number} [options.timeoutMs] - budget for the whole attempt.
 * @returns {Promise<BootstrapResult>} the outcome.
 */
export async function ensureEngine({
  repoPath,
  entry = ENGINE_ENTRY,
  npmPath = process.execPath,
  npmCli = npmCliPath(),
  signal,
  log = () => {},
  timeoutMs = 900000,
}) {
  const existing = resolveEntry(repoPath, entry)
  if (existsSync(existing)) {
    // Already installed. The binary is a separate, machine-wide cache, so an engine that
    // is present is a machine that has already paid for it.
    return { ok: true, entry: existing, installed: false, browserReady: browserCached() }
  }

  // An operator who configured a path meant that path. Only the default, never-created
  // location is bootstrapped, so a typo in `repoPath` is still reported as a typo.
  if (!isDefaultRepo(repoPath)) {
    return {
      ok: false,
      entry: existing,
      installed: false,
      browserReady: browserCached(),
      reason: `no camofox-browser engine at ${existing}`,
    }
  }

  mkdirSync(repoPath, { recursive: true })
  const release = await withLock(join(repoPath, '.dsh-camofox-install.lock'), async () => {
    // Another caller may have finished while this one waited for the lock.
    const afterLock = resolveEntry(repoPath, entry)
    if (existsSync(afterLock)) return afterLock

    log(`installing ${ENGINE_PACKAGE}@${ENGINE_VERSION} into ${repoPath}`)
    const spec = `${ENGINE_PACKAGE}@${ENGINE_VERSION}`
    if (!npmCli) {
      // Reported, not thrown past: the caller turns this into the same engine_missing
      // error every other unreachable engine produces, so a machine without npm has a
      // plugin that explains itself instead of one that cannot load.
      throw new Error('npm was not found on PATH, so the camofox engine cannot be installed automatically; install Node.js and npm, or set repoPath to an existing camofox-browser checkout')
    }
    const install = await run(
      npmPath,
      [npmCli, 'install', spec, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd: repoPath, signal, timeoutMs },
    )
    if (install.code !== 0) {
      throw new Error(`npm install failed (exit ${install.code}): ${lastLines(install.output, 3)}`)
    }
    const installed = resolveEntry(repoPath, entry)
    if (!existsSync(installed)) {
      throw new Error(`${ENGINE_PACKAGE}@${ENGINE_VERSION} installed but ${installed} is missing`)
    }
    return installed
  }, { timeoutMs })

  if (typeof release !== 'string') return release

  // npm may have run `postinstall`, but it is gated by allow-scripts and frequently does
  // not, and the browser binary is the one thing nothing else will fetch.
  if (!browserCached()) {
    log('fetching the Camoufox browser binary (about 1.06 GB, once per machine)')
    const fetcher = join(engineDir(repoPath), 'lib', 'camoufox-download.js')
    if (existsSync(fetcher)) {
      const fetch = await run(npmPath, [fetcher], { cwd: engineDir(repoPath), signal, timeoutMs })
      if (fetch.code !== 0) {
        // Not fatal on its own: the engine starts without a browser and reports why on
        // the first launch, which names the remedy. Failing here would leave a machine
        // with no engine at all over a download it can retry later.
        log(`the Camoufox binary download did not finish (exit ${fetch.code}); browser tools will explain on first use`)
      }
    }
  }

  const final = resolveEntry(repoPath, entry)
  return { ok: existsSync(final), entry: final, installed: true, browserReady: browserCached() }
}

/**
 * Whether `repoPath` is the default location the bootstrap is allowed to create.
 *
 * @param {string} repoPath - configured engine directory.
 * @returns {boolean} true for the default under the harness home.
 */
export function isDefaultRepo(repoPath) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return resolve(repoPath) === join(home, 'camofox', 'repo')
}

/**
 * Path to npm's CLI entry, which `node` has to be pointed at to run npm.
 *
 * `npm_execpath` is set only when npm itself started this process, so it is empty in a
 * harness that was launched any other way — and passing npm's arguments to `node`
 * without it runs `node install …`, which fails as a missing module. The CLI is located
 * from `PATH` instead, which is where a user who can run `npm` has it.
 *
 * @returns {string|null} an absolute path to `npm-cli.js`, or null when not found.
 */
export function npmCliPath() {
  if (process.env.npm_execpath && /\.js$/i.test(process.env.npm_execpath)) return process.env.npm_execpath
  const names = process.platform === 'win32' ? ['npm.cmd'] : ['npm']
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (!existsSync(candidate)) continue
      // Windows ships `npm.cmd`, a batch file `node` cannot execute. The real CLI sits
      // beside it in the same `node_modules` tree.
      if (process.platform === 'win32') {
        const cli = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
        if (existsSync(cli)) return cli
      } else {
        return candidate
      }
    }
  }
  return null
}

/**
 * Run a child process and collect its output.
 *
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @param {{ cwd: string, signal?: AbortSignal, timeoutMs?: number }} options - run options.
 * @returns {Promise<{ code: number, output: string }>} exit code and merged output.
 */
function run(command, args, { cwd, signal, timeoutMs }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      // npm resolves its own registry and proxy configuration from the environment, and
      // a corporate proxy the harness inherited is the one that works here.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    const collect = (chunk) => {
      // Bounded: a failing npm install can be verbose, and this string is only ever read
      // for its last few lines.
      output = (output + chunk.toString()).slice(-8192)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    const timer = setTimeout(() => child.kill(), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      rejectRun(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolveRun({ code: code ?? -1, output })
    })
  })
}

/**
 * Run `task` under a lock file so concurrent harnesses install once.
 *
 * A stale lock is taken over rather than waited on: the record carries the pid that made
 * it, and a pid that is gone cannot be waiting for anything. Without this, two profiles
 * starting at once would both install into one directory.
 *
 * @param {string} path - lock file path.
 * @param {() => Promise<any>} task - the work to protect.
 * @param {{ timeoutMs: number }} options - how long to wait for a held lock.
 * @returns {Promise<any>} the task result, or the `already installed` result.
 */
async function withLock(path, task, { timeoutMs }) {
  const deadline = Date.now() + timeoutMs
  mkdirSync(join(path, '..'), { recursive: true })
  for (;;) {
    try {
      // 'wx' fails rather than truncating, so two writers cannot both create it.
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!lockIsHeld(path)) {
        // The owner is gone. Removing the record is safe for the same reason: a process
        // that cannot hold a lock cannot be inside the critical section.
        rmSync(path, { force: true })
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`another process has held ${path} for longer than ${timeoutMs}ms`)
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  try {
    return await task()
  } finally {
    rmSync(path, { force: true })
  }
}

/**
 * Whether the pid recorded in a lock file is still running.
 *
 * @param {string} path - lock file path.
 * @returns {boolean} true when a live process holds it.
 */
function lockIsHeld(path) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'))
    const pid = Number(record.pid)
    // This process's own record means a previous attempt was interrupted, not that
    // another one is waiting: nothing is in the critical section right now.
    if (pid === process.pid) return false
    // `isProcessAlive` handles the platform differences this needs — `process.kill(pid, 0)`
    // is not a usable existence test on Windows, where a pid that has been reused by an
    // unrelated process answers the same way as a live one.
    return isProcessAlive(pid, spawnSync)
  } catch {
    return false
  }
}

/** The last few non-empty lines of a command's output. */
function lastLines(output, count) {
  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== '')
  return lines.slice(-count).join(' | ') || 'no output'
}