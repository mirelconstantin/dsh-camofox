/**
 * Packaging guards: the properties that make the published package loadable.
 *
 * These are cheap, deterministic checks that CI runs before anything ships. They
 * cover the failures that are otherwise silent — a `files` entry that stops
 * matching, an entry point that is not committed, or a bundle patch that grows a
 * second Loader row.
 *
 * Run with: `node scripts/packaging.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * This package's parsed manifest.
 *
 * @returns {any} the parsed package.json.
 */
function manifest() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
}

/**
 * The bundle patch's contents.
 *
 * @returns {string} the raw YAML.
 */
function patch() {
  return readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
}

/**
 * The `- id:` values the patch inserts.
 *
 * @returns {string[]} the row ids, in file order.
 */
function insertedRowIds() {
  return [...patch().matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((match) => match[1])
}

test('the bundle inserts exactly one Loader row', () => {
  // This is the load-bearing invariant of the merged package.
  //
  // `@deepseek-ai/dsh-client-modules` scans the HOST Loader's live entries for
  // packages declaring `dsh.client`, resolves each row's module, walks to the
  // nearest package.json, and reconciles the sources BY PACKAGE NAME. One package
  // resolving from more than one live row throws there; at activation the throw is
  // rethrown as a ClientPackageCompositionError, which fails the dsh-client-modules
  // fiber and leaves the web shell with no `window.__ModuleLoader__` — a
  // whole-GUI-down failure, not a degraded one. The declaration is per-PACKAGE, so
  // every row of a multi-row package resolves as a source.
  assert.deepEqual(insertedRowIds(), ['camofox-runtime'],
    'a second Loader row makes the client-module scan throw and takes the web GUI down')
})

test('the patch declares the client half on the package, not the row', () => {
  const declared = manifest()
  assert.equal(declared.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(declared.dsh.client.inject), 'inject must list the client services the half needs')
  assert.ok(declared.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'),
    'the card registers through the slots service, so that edge must be declared')
  assert.equal(declared.exports['./client'], './src/client.js',
    'the client half must be exported, or the scan finds no bundle to serve')
})

test('the client half is a classic script, not a module', () => {
  // The Host concatenates the bytes and runs them in the page, so an import or an
  // export statement at the top level is a syntax error in the browser.
  const source = readFileSync(join(ROOT, 'src', 'client.js'), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/, 'the half must register through the shell module loader')
  assert.doesNotMatch(source, /^\s*import\s/m, 'a top-level import is invalid in a classic script')
  assert.doesNotMatch(source, /^\s*export\s/m, 'a top-level export is invalid in a classic script')
})

test('the client half declares the package name it is served under', () => {
  // The graph row is keyed by package name, so a mismatch means the half is
  // registered and never mounted.
  const declared = manifest()
  const source = readFileSync(join(ROOT, 'src', 'client.js'), 'utf8')
  const id = /window\.__ModuleLoader__\.load\(\{\s*\n\s*id:\s*'([^']+)'/.exec(source)?.[1]
  assert.equal(id, declared.name, 'the loader id must equal the package name')
})

test('the client half carries no hardcoded user-facing copy', () => {
  // `verify-client-ui-i18n` rejects this, and a literal in the render path is a
  // string a Romanian profile cannot translate.
  const source = readFileSync(join(ROOT, 'src', 'client.js'), 'utf8')
  assert.match(source, /locale:\s*LOCALE_NS/, 'the registration must declare the namespace the renderer builds `t` from')
  assert.match(source, /locale\.register\(LOCALE_NS,\s*'en'/, 'the English dictionary must be registered')
  assert.match(source, /locale\.register\(LOCALE_NS,\s*'ro'/, 'the Romanian dictionary must be registered')

  // The dictionaries legitimately contain English VALUES — that is what a
  // dictionary is. What must not exist is a literal in the render path, so the
  // check is scoped to the component rather than the whole file.
  const renderPath = source.slice(source.indexOf('function CaptureRow'))
  for (const literal of ["'Loading screenshot", "'Enlarge'", "'Screenshot'", "close: 'Close'"]) {
    assert.ok(!renderPath.includes(literal), `hardcoded user-facing copy in the render path: ${literal}`)
  }
})

test('every export and every shipped file exists', () => {
  const declared = manifest()
  for (const target of Object.values(declared.exports)) {
    assert.ok(existsSync(resolve(ROOT, target)), `the export ${target} is not committed, so a git install cannot resolve it`)
  }
  for (const entry of declared.files) {
    assert.ok(existsSync(resolve(ROOT, entry)), `package.json ships ${entry}, which does not exist`)
  }
})

test('the icon is a real, self-contained image that ships', () => {
  const declared = manifest()
  assert.ok(declared.icon, 'the plugin panel needs an icon')
  assert.ok(!declared.icon.startsWith('/'), 'the icon must be relative to the package')
  const target = resolve(ROOT, declared.icon)
  assert.ok(existsSync(target), 'the icon file is missing')
  const source = readFileSync(target, 'utf8')
  assert.ok(statSync(target).size <= 262144, 'the icon is over the 256 KiB limit')
  assert.doesNotMatch(source, /<script[\s>]/i, 'the harness renders an icon as an image, not as inline HTML')
  assert.doesNotMatch(source, /(?:xlink:)?href\s*=\s*["']?\s*https?:/i, 'an icon that fetches anything is not self-contained')
  assert.ok(declared.files.includes(declared.icon.replace(/^\.\//, '')), 'the icon must be listed in files, or it is not published')
})

test('the description counts the tools the plugin actually registers', () => {
  // This shipped once already: the manifest said "eleven" while sixteen tools were
  // registered, and the plugin panel — which shows the description verbatim and
  // nothing else — was the only place the user could see it. Comments and READMEs
  // do not reach the panel, so the number has to be checked where it is shown.
  const declared = manifest()
  const source = readFileSync(join(ROOT, 'src', 'tools.js'), 'utf8')
  const registered = new Set([...source.matchAll(/^\s{4}name: '(camofox_\w+)'/gm)].map((m) => m[1]))
  assert.equal(registered.size, 16, `expected 16 registered tools, found ${registered.size}`)
  for (const word of ['eleven', 'sixteen', 'seventeen', 'fifteen']) {
    if (declared.description?.toLowerCase().includes(word)) {
      assert.equal(word, 'sixteen', `package.json description says "${word}" but ${registered.size} tools are registered`)
    }
  }
  assert.match(declared.description ?? '', /sixteen first-class browser tools/, 'the description should state the tool count')
})

test('the package installs from git with no build permission', () => {
  const declared = manifest()
  // pnpm runs only `prepack` and `prepare` on a git dependency. Either would make
  // pnpm refuse the install until the user allowlists this package's build script.
  const gitInstallScripts = ['prepare', 'prepack', 'preinstall', 'postinstall', 'install']
    .filter((name) => declared.scripts?.[name] !== undefined)
  assert.deepEqual(gitInstallScripts, [], `a git install would need build permission: ${gitInstallScripts.join(', ')}`)
  assert.notEqual(declared.private, true, 'a private package cannot be published to npm')
  for (const name of Object.keys(declared.peerDependencies ?? {})) {
    assert.equal(declared.peerDependenciesMeta?.[name]?.optional, true,
      `${name} is a required peer, so npm must be able to resolve it`)
  }
})

test('the licence and its attribution ship with the package', () => {
  const declared = manifest()
  assert.equal(declared.license, 'MIT')
  for (const file of ['LICENSE', 'NOTICE']) {
    assert.ok(declared.files.includes(file), `${file} is not in files, so it is not published`)
    assert.ok(existsSync(resolve(ROOT, file)), `${file} does not exist`)
  }
  // This plugin drives Camofox and vendors none of it, so the attribution is what
  // credits the creator. MIT requires the notice to travel with the package.
  const notice = readFileSync(resolve(ROOT, 'NOTICE'), 'utf8')
  assert.match(notice, /jo-inc\/camofox-browser/, 'NOTICE does not credit the browser')
  assert.match(notice, /Copyright \(c\) 2025 Jo, Inc/, 'NOTICE does not carry the upstream copyright')
  assert.match(readFileSync(resolve(ROOT, 'LICENSE'), 'utf8'), /Copyright \(c\) 2025 Jo, Inc/,
    'LICENSE does not reproduce the upstream notice')
})

test('no Loader entry file carries a default export', () => {
  // The Loader unwraps a default export in preference to the namespace, which
  // silently drops `inject`, `name` and `Config` and leaves the row pending forever.
  for (const entry of ['src/index.js', 'src/entry-tools.js', 'src/entry-prompt.js']) {
    const source = readFileSync(resolve(ROOT, entry), 'utf8')
    assert.doesNotMatch(source, /^\s*export\s+default\s/m, `${entry} exports a default, which the loader unwraps in preference`)
  }
})

test('the removed Loader rows are gone everywhere', () => {
  // The tools and the prompt section are now effects inside the single row. A row
  // id left behind would have no referent, and a patch targeting it would not
  // match anything.
  for (const removed of ['camofox-tools', 'camofox-prompt', 'camofox-client']) {
    assert.equal(patch().includes(`id: ${removed}`), false, `${removed} is still a row in the patch`)
  }
})
