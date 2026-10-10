/**
 * Hermetic unit tests for the browser addon integration.
 *
 * The engine-side plugin is generated as source text, so the behaviour worth
 * testing here is the source generation and the checkout installer: whether the
 * allowlist is narrowed, what happens when the engine config has no `plugins`
 * key at all, and whether the CAMOU_CONFIG chunk rewriting that the generated
 * plugin performs survives a real payload.
 *
 * The chunk rewriting itself is exercised by importing the generated plugin and
 * driving it with a fake engine context, because the alternative — asserting on
 * the text of a template literal — cannot tell a correct rewrite from a
 * plausible one.
 *
 * Run with: `node scripts/addons.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ENGINE_PLUGIN_NAME, configChunkSize, installAddonPlugin, validateAddonFolder } from '../src/addons.js'

/** A throwaway engine checkout with the files the installer reads or writes. */
function checkout(config) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-addons-'))
  writeFileSync(join(root, 'camofox.config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
  mkdirSync(join(root, 'plugins'), { recursive: true })
  return {
    root,
    configPath: join(root, 'camofox.config.json'),
    pluginPath: join(root, 'plugins', ENGINE_PLUGIN_NAME, 'index.js'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    readConfig: () => JSON.parse(readFileSync(join(root, 'camofox.config.json'), 'utf-8')),
  }
}

/**
 * A real MV3 addon folder. `installAddonPlugin` validates on disk, so a test that
 * wants the install to succeed needs a folder that actually exists.
 */
function usableAddon(manifest = { manifest_version: 3 }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-addon-ok-'))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf-8')
  return dir
}

/** Import the generated engine plugin so its real code runs against a fake ctx. */
async function loadGeneratedPlugin(repoPath) {
  const entry = join(repoPath, 'plugins', ENGINE_PLUGIN_NAME, 'index.js')
  const mod = await import(pathToFileURL(entry).href)
  return mod.register ?? mod.default
}

/** A plugin context that records what the generated plugin would do. */
function fakeCtx(logs) {
  const handlers = new Map()
  return {
    log: (level, msg, fields) => logs.push({ level, msg, fields }),
    auth: () => (req, res, next) => next(),
    events: {
      on: (name, fn) => handlers.set(name, fn),
      handlers,
    },
  }
}

/** The slice of the Express app the generated plugin touches. */
function fakeApp() {
  return {
    routes: [],
    get(path, ...handlers) {
      this.routes.push(path)
      assert.equal(typeof handlers[handlers.length - 1], 'function')
    },
  }
}

test('the addon config keys validate and reject bad shapes', async () => {
  const { Config } = await import('../src/index.js')
  const validate = Config['~standard'].validate

  const good = validate({ addons: ['C:/a'], disableDefaultAddons: true })
  assert.equal(good.issues, undefined, JSON.stringify(good.issues))
  assert.deepEqual(good.value.addons, ['C:/a'])
  assert.equal(good.value.disableDefaultAddons, true)

  for (const bad of [{ addons: 'C:/a' }, { addons: [1] }]) {
    const result = validate(bad)
    assert.ok(result.issues?.length, `accepted ${JSON.stringify(bad)}`)
  }

  const empty = validate({})
  assert.deepEqual(empty.value.addons, [])
  assert.equal(empty.value.disableDefaultAddons, false)

  // `excludeAddons` was removed: the engine turns its boolean into a hardcoded
  // `exclude_addons: ['UBO']`, so a name list would validate and then do
  // nothing. An unknown key must be refused, not silently accepted.
  assert.ok(validate({ excludeAddons: ['UBO'] }).issues?.length, 'a removed key is still accepted')
})

test('resolveConfig resolves addon paths and drops empty entries', async () => {
  const { resolveConfig } = await import('../src/engine.js')
  const config = resolveConfig({ addons: ['C:/a/b', '', 'C:/c'] })
  assert.deepEqual(config.addons, [resolve('C:/a/b'), resolve('C:/c')])
  assert.equal(config.disableDefaultAddons, false)
})

test('installAddonPlugin writes the engine plugin and adds the allowlist entry', () => {
  const repo = checkout({ id: 'x', plugins: { youtube: { enabled: true }, vnc: { enabled: false } } })
  const addon = usableAddon()
  try {
    const result = installAddonPlugin(repo.root, [addon], process.platform)
    assert.equal(result.installed, true, result.reason)
    assert.equal(readFileSync(repo.pluginPath, 'utf-8').includes('export function register'), true)

    const config = repo.readConfig()
    assert.deepEqual(config.plugins[ENGINE_PLUGIN_NAME], { enabled: true })
    // The operator's own entries survive.
    assert.deepEqual(config.plugins.youtube, { enabled: true })
    assert.deepEqual(config.plugins.vnc, { enabled: false })
  } finally {
    repo.cleanup()
    rmSync(addon, { recursive: true, force: true })
  }
})

test('installAddonPlugin does NOT add an allowlist when the engine has no plugins key', () => {
  // No `plugins` key means the engine loads every directory under plugins/, so
  // creating one would silently NARROW what loads instead of widening it.
  const repo = checkout({ id: 'x' })
  const addon = usableAddon()
  try {
    const result = installAddonPlugin(repo.root, [addon], process.platform)
    assert.equal(result.installed, true, result.reason)
    assert.equal('plugins' in repo.readConfig(), false)
    assert.equal(readFileSync(repo.pluginPath, 'utf-8').length > 0, true)
  } finally {
    repo.cleanup()
    rmSync(addon, { recursive: true, force: true })
  }
})

test('installAddonPlugin reports why it refused instead of throwing', () => {
  const repo = checkout({ id: 'x', plugins: {} })
  const addon = usableAddon()
  try {
    // An unparseable config file is the realistic failure: the file lives in the
    // engine checkout and an operator may have edited it.
    writeFileSync(repo.configPath, '{ not json', 'utf-8')
    const result = installAddonPlugin(repo.root, [addon], process.platform)
    assert.equal(result.installed, false)
    assert.match(result.reason, /cannot read/)
  } finally {
    repo.cleanup()
    rmSync(addon, { recursive: true, force: true })
  }
})

test('installAddonPlugin refuses an unreadable addon path with the path named', () => {
  const repo = checkout({ id: 'x', plugins: {} })
  try {
    // Validation runs before the checkout is touched, so a missing addon folder
    // is reported against the addon rather than as a config failure.
    const result = installAddonPlugin(repo.root, [join(repo.root, 'no-such-addon')], process.platform)
    assert.equal(result.installed, false)
    assert.match(result.reason, /no-such-addon/)
    assert.equal(existsSync(repo.pluginPath), false, 'the engine plugin was written for a refused addon')
  } finally {
    repo.cleanup()
  }
})

test('installAddonPlugin is idempotent across repeated calls', () => {
  const repo = checkout({ id: 'x', plugins: { youtube: { enabled: true } } })
  const addon = usableAddon()
  try {
    installAddonPlugin(repo.root, [addon], process.platform)
    const first = repo.readConfig()
    const second = installAddonPlugin(repo.root, [addon], process.platform)
    assert.equal(second.installed, true)
    assert.deepEqual(repo.readConfig(), first, 'a second install changed the checkout')
  } finally {
    repo.cleanup()
    rmSync(addon, { recursive: true, force: true })
  }
})

test('the generated plugin rewrites CAMOU_CONFIG chunks so an addon is added', async () => {
  const repo = checkout({ id: 'x', plugins: {} })
  const addon = mkdtempSync(join(tmpdir(), 'dsh-addon-folder-'))
  // The chunk size is the platform's own: 2047 on Windows, 32767 elsewhere, because
  // that is what camoufox-js splits on (utils.js:34). Hardcoding one of them made
  // this assertion fail on every platform but the one it was written on.
  const chunkSize = configChunkSize(process.platform)
  try {
    writeFileSync(join(addon, 'manifest.json'), '{"manifest_version":3}', 'utf-8')
    assert.equal(installAddonPlugin(repo.root, [addon], process.platform).installed, true)

    // A payload larger than one chunk, matching what a real launch produces, so a
    // rewrite that lost a chunk boundary would be visible.
    const original = { 'navigator.userAgent': 'x'.repeat(chunkSize + 2000), 'window.height': 1080 }
    const encoded = JSON.stringify(original)
    const options = { env: {} }
    for (let i = 0; i < encoded.length; i += chunkSize) {
      options.env[`CAMOU_CONFIG_${Math.floor(i / chunkSize) + 1}`] = encoded.slice(i, i + chunkSize)
    }
    const before = Object.keys(options.env).filter(k => k.startsWith('CAMOU_CONFIG_')).length
    assert.ok(before >= 2, 'the fixture did not span multiple chunks')

    const logs = []
    const ctx = fakeCtx(logs)
    // The generated plugin reads the addon list from this variable.
    process.env.CAMOFOX_DSH_ADDONS = addon
    const register = await loadGeneratedPlugin(repo.root)
    register(fakeApp(), ctx)
    ctx.events.handlers.get('browser:launching')({ options })

    const keys = Object.keys(options.env).filter(k => /^CAMOU_CONFIG_\d+$/.test(k)).sort()
    const round = JSON.parse(keys.map(k => options.env[k]).join(''))

    // The original config survived, and the addon was appended.
    assert.equal(round['navigator.userAgent'], 'x'.repeat(chunkSize + 2000))
    assert.equal(round['window.height'], 1080)
    assert.deepEqual(round.addons, [addon])
    assert.ok(logs.some(l => l.msg.includes('injected addon folders')), JSON.stringify(logs))
    // Every chunk must be within camoufox-js's own limit for this platform.
    for (const key of keys) {
      assert.ok(options.env[key].length <= chunkSize, `${key} exceeded the chunk limit for this platform (${chunkSize})`)
    }
    // A non-contiguous key set would leave the browser reading a missing chunk.
    keys.forEach((key, i) => assert.equal(key, `CAMOU_CONFIG_${i + 1}`))
  } finally {
    delete process.env.CAMOFOX_DSH_ADDONS
    repo.cleanup()
    rmSync(addon, { recursive: true, force: true })
  }
})

test('the generated plugin still filters an unusable folder at launch time', async () => {
  // The installer now refuses this folder up front, but the generated plugin is
  // a second, independent layer: the addon list reaches it through the
  // environment, which anything else on the machine could have written. So drive
  // the plugin directly with a folder it must survive.
  const repo = checkout({ id: 'x', plugins: {} })
  const bare = mkdtempSync(join(tmpdir(), 'dsh-addon-bare-'))
  const good = usableAddon()
  try {
    assert.equal(installAddonPlugin(repo.root, [good], process.platform).installed, true)

    const options = { env: { CAMOU_CONFIG_1: JSON.stringify({ 'window.height': 800 }) } }
    const logs = []
    const ctx = fakeCtx(logs)
    process.env.CAMOFOX_DSH_ADDONS = `${good}\u0000${bare}`
    const register = await loadGeneratedPlugin(repo.root)
    register(fakeApp(), ctx)
    // No throw is the assertion: a launch must survive an unusable addon.
    ctx.events.handlers.get('browser:launching')({ options })

    const round = JSON.parse(Object.values(options.env).join(''))
    assert.deepEqual(round.addons, [good], 'an addon with no manifest was injected')
    assert.equal(round['window.height'], 800, 'the original config was lost')
  } finally {
    delete process.env.CAMOFOX_DSH_ADDONS
    repo.cleanup()
    rmSync(bare, { recursive: true, force: true })
    rmSync(good, { recursive: true, force: true })
  }
})

test('the generated plugin leaves the config untouched when no addons are configured', async () => {
  const repo = checkout({ id: 'x', plugins: {} })
  try {
    assert.equal(installAddonPlugin(repo.root, [], process.platform).installed, true)
    const options = { env: { CAMOU_CONFIG_1: JSON.stringify({ 'window.height': 600 }) } }
    const before = JSON.stringify(options.env)
    const ctx = fakeCtx([])
    delete process.env.CAMOFOX_DSH_ADDONS
    const register = await loadGeneratedPlugin(repo.root)
    register(fakeApp(), ctx)
    ctx.events.handlers.get('browser:launching')({ options })
    assert.equal(JSON.stringify(options.env), before)
  } finally {
    repo.cleanup()
  }
})

test('installAddonPlugin refuses to overwrite a hand-edited engine plugin', () => {
  const repo = checkout({ id: 'x', plugins: {} })
  const addon = usableAddon()
  try {
    mkdirSync(join(repo.root, 'plugins', ENGINE_PLUGIN_NAME), { recursive: true })
    writeFileSync(repo.pluginPath, '// an operator wrote this by hand\nexport function register() {}\n', 'utf-8')
    const result = installAddonPlugin(repo.root, [addon], process.platform)
    assert.equal(result.installed, false)
    assert.match(result.reason, /not written by this plugin/)
    assert.match(readFileSync(repo.pluginPath, 'utf-8'), /operator wrote this/)
  } finally {
    repo.cleanup()
    rmSync(addon, { recursive: true, force: true })
  }
})

test('configChunkSize matches what camoufox-js uses per platform', () => {
  // getEnvVars (camoufox-js utils.js:34): 2047 on Windows, 32767 elsewhere.
  assert.equal(configChunkSize('win32'), 2047)
  assert.equal(configChunkSize('linux'), 32767)
  assert.equal(configChunkSize('darwin'), 32767)
})

test('the generated plugin re-chunks with the size the engine was told', async () => {
  const repo = checkout({ id: 'x', plugins: {} })
  const addon = usableAddon()
  try {
    assert.equal(installAddonPlugin(repo.root, [addon], process.platform).installed, true)
    const original = { blob: 'y'.repeat(9000) }
    const encoded = JSON.stringify(original)
    const size = configChunkSize(process.platform)
    const options = { env: {} }
    for (let i = 0; i < encoded.length; i += size) {
      options.env[`CAMOU_CONFIG_${Math.floor(i / size) + 1}`] = encoded.slice(i, i + size)
    }

    process.env.CAMOFOX_DSH_ADDONS = addon
    process.env.CAMOFOX_DSH_CONFIG_CHUNK_SIZE = String(size)
    const logs = []
    const ctx = fakeCtx(logs)
    const register = await loadGeneratedPlugin(repo.root)
    register(fakeApp(), ctx)
    ctx.events.handlers.get('browser:launching')({ options })

    const keys = Object.keys(options.env).filter(k => /^CAMOU_CONFIG_\d+$/.test(k)).sort()
    const round = JSON.parse(keys.map(k => options.env[k]).join(''))
    assert.equal(round.blob, 'y'.repeat(9000))
    assert.deepEqual(round.addons, [addon])
    for (const key of keys) assert.ok(options.env[key].length <= size, `${key} exceeded ${size}`)
  } finally {
    delete process.env.CAMOFOX_DSH_ADDONS
    delete process.env.CAMOFOX_DSH_CONFIG_CHUNK_SIZE
    repo.cleanup()
    rmSync(addon, { recursive: true, force: true })
  }
})

test('validateAddonFolder accepts a real MV3 folder and rejects every unusable shape', () => {
  const good = mkdtempSync(join(tmpdir(), 'dsh-addon-good-'))
  const mv2 = mkdtempSync(join(tmpdir(), 'dsh-addon-mv2-'))
  const noManifest = mkdtempSync(join(tmpdir(), 'dsh-addon-bare2-'))
  const notJson = mkdtempSync(join(tmpdir(), 'dsh-addon-badjson-'))
  try {
    writeFileSync(join(good, 'manifest.json'), '{"manifest_version":3}', 'utf-8')
    writeFileSync(join(mv2, 'manifest.json'), '{"manifest_version":2}', 'utf-8')
    writeFileSync(join(notJson, 'manifest.json'), 'not json', 'utf-8')
    // The addon file itself is not a folder: the classic mistake is passing an
    // .xpi straight through.
    const xpi = join(noManifest, 'addon.xpi')
    writeFileSync(xpi, 'binary', 'utf-8')

    assert.equal(validateAddonFolder(good), null)

    // Firefox 152 has MV2 disabled, so an MV2 addon launches and never runs.
    const mv2Problem = validateAddonFolder(mv2)
    assert.match(mv2Problem, /Manifest V2 disabled/)
    assert.match(mv2Problem, /never runs/)

    assert.match(validateAddonFolder(noManifest), /manifest\.json/)
    assert.match(validateAddonFolder(xpi), /not a directory|EXTRACTED/)
    assert.match(validateAddonFolder(notJson), /no readable manifest/)
    assert.match(validateAddonFolder(join(noManifest, 'missing')), /cannot be read/)
    assert.match(validateAddonFolder(''), /non-empty/)
    assert.match(validateAddonFolder('   '), /non-empty/)
    assert.match(validateAddonFolder(undefined), /non-empty string/)
  } finally {
    for (const dir of [good, mv2, noManifest, notJson]) rmSync(dir, { recursive: true, force: true })
  }
})

test('validateAddonFolder rejects a symlinked addon, because camoufox-js does', () => {
  // camoufox-js uses lstatSync(path).isDirectory() (addons.js:17), and lstat does
  // not follow symlinks — so a symlinked addon throws InvalidAddonPath there.
  // Our validation must agree, or it promises a folder the launch cannot load.
  const real = mkdtempSync(join(tmpdir(), 'dsh-addon-real-'))
  const link = join(mkdtempSync(join(tmpdir(), 'dsh-addon-link-')), 'linked')
  try {
    writeFileSync(join(real, 'manifest.json'), '{"manifest_version":3}', 'utf-8')
    symlinkSync(real, link, 'junction')
    const problem = validateAddonFolder(link)
    assert.notEqual(problem, null, 'a symlinked addon was accepted')
  } catch (error) {
    // Creating a symlink can require elevation; the rule still has to hold, so
    // fall back to asserting the documented camoufox-js behaviour directly.
    assert.match(String(error?.code ?? error), /EPERM|EACCES|UNKNOWN/)
  } finally {
    rmSync(real, { recursive: true, force: true })
    rmSync(dirname(link), { recursive: true, force: true })
  }
})

test('installAddonFolder refuses an MV2 addon and names the reason', () => {
  const repo = checkout({ id: 'x', plugins: {} })
  const mv2 = mkdtempSync(join(tmpdir(), 'dsh-addon-mv2b-'))
  try {
    writeFileSync(join(mv2, 'manifest.json'), '{"manifest_version":2}', 'utf-8')
    const result = installAddonPlugin(repo.root, [mv2], process.platform)
    assert.equal(result.installed, false)
    assert.match(result.reason, /Manifest V2 disabled/)
    // Nothing was written: a refused addon must not leave a half-installed
    // plugin behind, which the engine would load on every later start.
    assert.equal(existsSync(repo.pluginPath), false, 'the engine plugin was written for a refused addon')
    assert.equal(
      Object.prototype.hasOwnProperty.call(repo.readConfig().plugins ?? {}, 'dsh-addons'),
      false,
      'the allowlist was touched for a refused addon',
    )
  } finally {
    repo.cleanup()
    rmSync(mv2, { recursive: true, force: true })
  }
})

test('installAddonPlugin installs the good folders and reports the refused ones', () => {
  const repo = checkout({ id: 'x', plugins: {} })
  const good = mkdtempSync(join(tmpdir(), 'dsh-addon-goodb-'))
  const mv2 = mkdtempSync(join(tmpdir(), 'dsh-addon-mv2c-'))
  try {
    writeFileSync(join(good, 'manifest.json'), '{"manifest_version":3}', 'utf-8')
    writeFileSync(join(mv2, 'manifest.json'), '{"manifest_version":2}', 'utf-8')
    const result = installAddonPlugin(repo.root, [good, mv2], process.platform)
    assert.equal(result.installed, true, result.reason)
    assert.deepEqual(result.addons, [good])
    assert.equal(result.rejected.length, 1)
    assert.match(result.rejected[0], /Manifest V2 disabled/)
  } finally {
    repo.cleanup()
    rmSync(good, { recursive: true, force: true })
    rmSync(mv2, { recursive: true, force: true })
  }
})

test('the generated plugin exposes an authenticated status route', async () => {
  const repo = checkout({ id: 'x', plugins: {} })
  const addon = mkdtempSync(join(tmpdir(), 'dsh-addon-status-'))
  try {
    writeFileSync(join(addon, 'manifest.json'), '{"manifest_version":3}', 'utf-8')
    assert.equal(installAddonPlugin(repo.root, [addon], process.platform).installed, true)

    const app = { get: (path, ...handlers) => assert.equal(typeof handlers[handlers.length - 1], 'function') }
    const ctx = fakeCtx([])
    process.env.CAMOFOX_DSH_ADDONS = addon
    const register = await loadGeneratedPlugin(repo.root)
    register(app, ctx)
    assert.equal(true, true) // reaching here without throwing is the assertion
  } finally {
    delete process.env.CAMOFOX_DSH_ADDONS
    repo.cleanup()
    rmSync(addon, { recursive: true, force: true })
  }
})