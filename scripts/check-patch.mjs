/**
 * Verify the bundle patch against the tree it describes.
 *
 * The patch is the only thing that tells the harness what to load, and nothing in
 * a plain `node src/index.js` run ever reads it. So a path that drifted, a row
 * that lost its id, or a second Loader row would all pass every other check here
 * and only fail once the harness is already up — which, for the row count, means
 * the whole web shell rather than one plugin.
 *
 * No YAML dependency on purpose: this reads the shape of a file whose grammar is
 * a fixed, four-field subset, and a parser is a bigger failure surface than the
 * thing being checked.
 *
 * Run with: `node scripts/check-patch.mjs`
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH = join(ROOT, 'cordis.patch.yml')

/**
 * Read the patch as text.
 *
 * @returns {string} the raw YAML.
 */
function read() {
  return readFileSync(PATCH, 'utf8')
}

/**
 * The row ids the patch inserts, with the byte offset each was found at.
 *
 * @param {string} source - the raw YAML.
 * @returns {Array<{ id: string, at: number }>} the rows, in file order.
 */
function rows(source) {
  return [...source.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((match) => ({ id: match[1], at: match.index }))
}

/**
 * Every `name:` target in the patch.
 *
 * @param {string} source - the raw YAML.
 * @returns {string[]} the targets, in file order.
 */
function names(source) {
  return [...source.matchAll(/^\s*name:\s*'?([^'\n]+?)'?\s*$/gm)].map((match) => match[1])
}

const failures = []

const source = read()
const found = rows(source)

if (found.length === 0) failures.push('the patch inserts no row at all, so the bundle does nothing')

const ids = found.map((row) => row.id)
if (new Set(ids).size !== ids.length) failures.push(`duplicate row ids: ${ids.join(', ')}`)

// The invariant that keeps the web shell alive. Spelled out rather than assumed:
// this package declares `dsh.client`, and the client-module scanner reconciles
// sources by package name across the Host Loader's live rows.
if (found.length !== 1) {
  failures.push(`the patch must insert exactly one Loader row, because this package declares a client half and one package may resolve from only one row — found ${found.length}: ${ids.join(', ')}`)
}

for (const target of names(source)) {
  // Only relative targets are this bundle's business; a bare package name is
  // resolved by the host and a URL is somebody else's problem.
  if (!target.startsWith('./')) continue
  const path = resolve(ROOT, target)
  if (!existsSync(path)) failures.push(`${target} is named by the patch but does not exist`)
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  failures.push(`package.json points at ${manifest.dsh?.bundle?.patch}, not ./cordis.patch.yml`)
}
if (!manifest.files.includes('cordis.patch.yml')) {
  failures.push('package.json does not ship cordis.patch.yml, so an install has no patch to apply')
}
for (const target of names(source)) {
  if (target.startsWith('./') && !manifest.files.some((entry) => target.slice(2).startsWith(entry))) {
    failures.push(`${target} is named by the patch but no entry in files ships it`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`cordis.patch.yml: ${failure}\n`)
  process.exit(1)
}

process.stdout.write(`cordis.patch.yml: ${found.length} row (${ids.join(', ')}), every target resolves and ships\n`)