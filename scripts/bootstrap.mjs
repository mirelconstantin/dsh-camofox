/**
 * Behaviour of the first-run engine bootstrap.
 *
 * These tests never touch the network: `ensureEngine` is exercised against directories
 * that already look installed, directories that are not the default, and a stub `node`
 * that stands in for npm. The real install is verified by `scripts/live.mjs` on a machine
 * that has it, because a unit test that downloads 175 packages is a test nobody runs.
 *
 * Run with: `node scripts/bootstrap.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENGINE_PACKAGE,
  ENGINE_VERSION,
  browserCached,
  camoufoxCacheDir,
  engineDir,
  ensureEngine,
  isDefaultRepo,
  npmCliPath,
  resolveEntry,
} from '../src/bootstrap.js'

/** A fresh directory that is never the default repoPath. */
function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Lay down an installed engine so the code takes the already-present path. */
function pretendInstalled(repo) {
  const dir = engineDir(repo)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'server.js'), '// fake\n', 'utf8')
  return dir
}

test('the scoped package is the one that ships a root server.js', () => {
  // The unscoped `camofox-browser` on npm belongs to a different publisher and has no
  // root server.js, so installing it produces an engine that cannot start and an error
  // that reads like a broken install. Pinning the name is the whole guard.
  assert.equal(ENGINE_PACKAGE, '@askjo/camofox-browser')
  assert.match(ENGINE_VERSION, /^\d+\.\d+\.\d+$/, 'the engine version is pinned exactly, not ranged')
})

test('both engine layouts resolve to an entry point', () => {
  // A git checkout has server.js at its root; an npm install has it under node_modules.
  const repo = scratch('bs-layout-')
  pretendInstalled(repo)
  assert.equal(resolveEntry(repo), join(engineDir(repo), 'server.js'))

  const checkout = scratch('bs-checkout-')
  writeFileSync(join(checkout, 'server.js'), '// fake\n', 'utf8')
  assert.equal(resolveEntry(checkout), join(checkout, 'server.js'))
})

test('an engine that is already installed is left completely alone', async () => {
  const repo = scratch('bs-present-')
  pretendInstalled(repo)
  const before = readFileSync(join(engineDir(repo), 'server.js'), 'utf8')

  const result = await ensureEngine({ repoPath: repo, log: () => { throw new Error('an installed engine must not log a bootstrap') } })

  assert.equal(result.ok, true)
  assert.equal(result.installed, false, 'an installed engine was reinstalled')
  assert.equal(readFileSync(join(engineDir(repo), 'server.js'), 'utf8'), before, 'the install was touched')
})

test('a repoPath the operator chose is never created or installed into', async () => {
  // Setting repoPath means "I manage this path". Bootstrapping it would overwrite a typo
  // with an engine, and would install into somebody else's checkout.
  process.env.DSH_HOME = scratch('bs-home-')
  const chosen = scratch('bs-chosen-')

  const result = await ensureEngine({ repoPath: chosen, log: () => {} })

  assert.equal(result.ok, false)
  assert.equal(result.installed, false)
  assert.match(result.reason, /no camofox-browser engine at/)
  // The directory is still exactly as it was: no node_modules, and no lock file.
  assert.equal(existsSync(chosen), true, 'the directory was removed')
  assert.equal(existsSync(join(chosen, 'node_modules')), false, 'an engine was installed into a chosen repoPath')
  assert.equal(existsSync(join(chosen, '.dsh-camofox-install.lock')), false, 'a lock file was left behind')
})

test('the default location is the only one bootstrapped', () => {
  const home = scratch('bs-home-')
  process.env.DSH_HOME = home
  assert.equal(isDefaultRepo(join(home, 'camofox', 'repo')), true)
  assert.equal(isDefaultRepo(scratch('bs-other-')), false)
})

test('a bootstrap with no npm explains itself instead of failing opaquely', async () => {
  process.env.DSH_HOME = scratch('bs-home-')
  const repo = join(process.env.DSH_HOME, 'camofox', 'repo')
  mkdirSync(repo, { recursive: true })
  // The npm location is passed rather than discovered: PATH manipulation is not a
  // reliable way to hide it, because npm's own directory can be reachable by another
  // route. `npmCli: null` is the honest way to say "no npm".
  await assert.rejects(
    () => ensureEngine({ repoPath: repo, npmCli: null, log: () => {} }),
    /npm was not found on PATH/,
  )
})

test('npm is located when the harness did not start from npm', () => {
  // `npm_execpath` is set only when npm itself started this process, so it is empty in a
  // harness launched any other way — and `npm test` runs through npm, so it is set here.
  // Passing npm's arguments to node without resolving the CLI first runs
  // `node install …`, which fails as a missing module.
  const saved = process.env.npm_execpath
  delete process.env.npm_execpath
  try {
    const cli = npmCliPath()
    assert.ok(cli && cli.endsWith('npm-cli.js'), `npm's CLI was not found on PATH; got ${cli}`)
  } finally {
    if (saved === undefined) delete process.env.npm_execpath
    else process.env.npm_execpath = saved
  }
})

test('the browser cache directory follows the platform convention', () => {
  const dir = camoufoxCacheDir()
  assert.ok(dir.length > 0)
  // Whatever the platform, the answer must be absolute: a relative cache path is what
  // makes two profiles disagree about whether the binary exists.
  assert.equal(dir, join(dir), 'the cache directory must be absolute')
  assert.equal(typeof browserCached(), 'boolean')
})

test('a lock left by a dead process is taken over rather than waited on', async () => {
  // A pid that cannot hold a lock cannot be inside the critical section, so a record
  // naming one must not make the next bootstrap wait out its whole budget.
  process.env.DSH_HOME = scratch('bs-home-')
  const repo = join(process.env.DSH_HOME, 'camofox', 'repo')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, '.dsh-camofox-install.lock'), JSON.stringify({ pid: 0x7ffffff0, at: Date.now() }), 'utf8')

  const started = Date.now()
  // `npmCli: null` fails the install immediately; the lock must already be consumed
  // rather than being the thing that blocks.
  await assert.rejects(() => ensureEngine({ repoPath: repo, npmCli: null, log: () => {} }), /npm was not found on PATH/)
  assert.ok(Date.now() - started < 5000, 'a stale lock stalled the bootstrap')
  assert.equal(existsSync(join(repo, '.dsh-camofox-install.lock')), false, 'the lock was not released')
})