/**
 * Verify what npm would actually publish.
 *
 * `files` is the release, and it is the one thing a local `node src/...` run can
 * never disagree with. A path that exists on disk but is not in `files` installs
 * fine from a link and breaks from a tarball, which is exactly the shape of bug
 * that reaches a user and not a developer.
 *
 * This does the checking itself rather than parsing `npm pack --dry-run`, so it
 * runs in any environment and does not depend on npm's output format.
 *
 * Run with: `node scripts/pack-check.mjs`
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'
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
 * Whether a path is excluded from the package by npm's always-ignored rules.
 *
 * @param {string} rel - a package-relative path, with forward slashes.
 * @returns {boolean} true when npm would never ship it.
 */
function alwaysIgnored(rel) {
  const parts = rel.split('/')
  const name = parts[parts.length - 1]
  return name === '.git' || name === 'node_modules' || name === '.DS_Store'
    || name.endsWith('.log') || name === '.npmrc' || name === '.gitignore'
}

const declared = manifest()
const failures = []

if (declared.name !== 'dsh-camofox') failures.push(`the package is named ${declared.name}`)
if (declared.private === true) failures.push('the package is private, so npm refuses to publish it')
if (!declared.version) failures.push('the package has no version')
if (!declared.license) failures.push('the package has no licence')
if (!declared.description) failures.push('the package has no description')

// Every export must resolve inside the tree, and inside what `files` ships.
// `package.json` is the exception npm makes for every package, so it is listed
// in `exports` for resolution without needing an entry in `files`.
const ALWAYS_SHIPPED = new Set(['./package.json'])

for (const [subpath, target] of Object.entries(declared.exports ?? {})) {
  if (typeof target !== 'string') {
    failures.push(`export ${subpath} is not a plain string; the client-module scanner reads a string or a string default`)
    continue
  }
  const path = resolve(ROOT, target)
  if (!existsSync(path)) {
    failures.push(`export ${subpath} -> ${target} does not exist`)
    continue
  }
  if (!ALWAYS_SHIPPED.has(target) && !isShipped(target, declared.files)) {
    failures.push(`export ${subpath} -> ${target} is not covered by files, so it would not be published`)
  }
}

// The files that make the plugin recognisable and its attribution travel.
for (const required of ['src', 'cordis.patch.yml', 'README.md', 'LICENSE', 'NOTICE', 'icon.svg']) {
  if (!existsSync(resolve(ROOT, required))) failures.push(`${required} is missing from the package`)
  else if (!declared.files.includes(required)) failures.push(`${required} is not listed in files, so it is not published`)
}

// The icon the panel shows has to survive the trip as an image.
if (declared.icon) {
  const path = resolve(ROOT, declared.icon)
  if (!existsSync(path)) failures.push(`the icon ${declared.icon} does not exist`)
  else {
    const bytes = statSync(path).size
    if (bytes > 262144) failures.push(`the icon is ${bytes} bytes, over the 256 KiB limit`)
    const source = readFileSync(path, 'utf8')
    for (const [what, pattern] of [
      ['inline script', /<script[\s>]/i],
      ['remote reference', /(?:xlink:)?href\s*=\s*["']?\s*https?:/i],
      ['remote import', /@import\s+url\(\s*["']?https?:/i],
      ['embedded bitmap', /<image[\s>]/i],
    ]) {
      if (pattern.test(source)) failures.push(`the icon is not self-contained: it has a ${what}`)
    }
  }
}

// Nothing under the published tree may still be a work in progress.
const shipped = readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => declared.files.includes(name) || declared.files.some((entry) => entry === name))

for (const name of shipped) {
  const walk = (absolute, prefix) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const rel = `${prefix}/${entry.name}`
      if (alwaysIgnored(rel)) continue
      if (entry.isDirectory()) {
        walk(join(absolute, entry.name), rel)
        continue
      }
      if (/\.(test|spec)\.[cm]?js$/.test(entry.name)) {
        failures.push(`${rel} would be published, but a test file has no place in a runtime package`)
      }
      if (entry.name.endsWith('.mjs') && rel.startsWith('/scripts')) {
        failures.push(`${rel} would be published; scripts/ is not in files and must not be`)
      }
    }
  }
  walk(join(ROOT, name), name)
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`pack: ${failure}\n`)
  process.exit(1)
}

process.stdout.write(`pack: ${declared.name}@${declared.version} — ${declared.files.length} shipped entries, icon self-contained\n`)

/**
 * Whether a package-relative target falls inside one of the `files` entries.
 *
 * @param {string} target - the package-relative target, with `/` separators.
 * @param {string[]} files - the manifest's `files` list.
 * @returns {boolean} true when npm would ship it.
 */
function isShipped(target, files) {
  const rel = relative(ROOT, resolve(ROOT, target)).split(sep).join('/')
  return files.some((entry) => {
    const clean = entry.replace(/^\.\//, '').replace(/\/$/, '')
    return rel === clean || rel.startsWith(`${clean}/`)
  })
}