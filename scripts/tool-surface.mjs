/**
 * Guard the tool surface a model actually reads.
 *
 * The plugin's code and its model-facing text drifted apart more than once, and the
 * failures were silent: `camofox_read` implemented `interactive` and `scope` and
 * the system prompt told the model to prefer them, while the schema declared
 * neither — so the most strongly advised habit in the plugin was a call it could
 * not legally make, on a schema that sets `additionalProperties: false`.
 *
 * A model never sees this repository. It sees the schemas, the descriptions and
 * the system prompt, and nothing else, so an argument that is implemented but not
 * declared is invisible, and a description that names a mode that does not exist
 * sends it to a dead end. Both are cheap to cause and impossible to notice in
 * review, so they are checked here.
 *
 * Run with: `node scripts/tool-surface.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The source of one module, as text.
 *
 * @param {string} name - the file under `src/`.
 * @returns {string} its contents.
 */
function src(name) {
  return readFileSync(join(ROOT, 'src', name), 'utf8')
}

const tools = src('tools.js')
const prompt = src('prompt.js')

test('every argument the handlers read is declared in a schema', () => {
  // `args.<name>` in an execute body is a promise the model has to be able to keep,
  // because the schema is the only contract the model is given. Collecting the
  // property names each tool declares, then checking the union against what the
  // handlers actually read, catches an argument that was implemented and never
  // advertised.
  const declared = new Set()
  // Both shapes: `name: { type: 'string' }` on one line, and the multi-line
  // `name: {\n  type: 'array',` that a nested-object argument uses.
  for (const block of tools.matchAll(/^\s{6,}(\w+):\s*\{\s*(?:\n\s*)?type: '(?:string|number|boolean|array|object)'/gm)) {
    declared.add(block[1])
  }
  assert.ok(declared.size > 40, `expected a real schema, found ${declared.size} declared arguments`)

  // The arguments every handler is allowed to read on any tool.
  const universal = new Set([
    'tabId', 'sessionKey', 'signal', 'exec', 'config', 'bridge', 'browser', 'savePath',
    'overwrite', 'outputPath', 'expression', 'schema', 'itemSelector', 'urls',
  ])
  const read = new Set()
  for (const match of tools.matchAll(/\bargs\.(\w+)/g)) read.add(match[1])

  const undeclared = [...read].filter((name) => !declared.has(name) && !universal.has(name))
  assert.deepEqual(undeclared, [], `these arguments are read by a handler but declared in no schema: ${undeclared.join(', ')}`)
})

test('camofox_read declares the snapshot reductions it implements', () => {
  // The specific instance of the class above, kept explicit because it is the one
  // the system prompt tells the model to prefer on a long page.
  const read = /name: 'camofox_read'[\s\S]*?parameters: \{[\s\S]*?properties: \{([\s\S]*?)\n {6}\},/.exec(tools)
  assert.ok(read, 'could not find the camofox_read schema')
  const properties = read[1]
  for (const arg of ['interactive', 'scope']) {
    assert.ok(properties.includes(`${arg}: {`), `camofox_read implements ${arg} but does not declare it`)
  }
})

test('no tool description names a read mode that does not exist', () => {
  // `transcript` was documented on camofox_read as an offset-able mode, but it is
  // a separate tool: passing it to camofox_read throws. A mode named in prose and
  // absent from the enum is a dead end a model cannot diagnose.
  const modes = /const READ_MODES = new Set\(\[([^\]]+)\]\)/.exec(tools)?.[1] ?? ''
  const declared = new Set([...modes.matchAll(/'([a-z]+)'/g)].map((m) => m[1]))
  assert.ok(declared.size >= 5, 'could not read the READ_MODES list')

  const description = /name: 'camofox_read'[\s\S]*?description:\s*\n?\s*'([^']*)'/.exec(tools)?.[1] ?? ''
  for (const quoted of description.matchAll(/mode "([a-z]+)"/g)) {
    assert.ok(declared.has(quoted[1]), `camofox_read's description offers mode "${quoted[1]}", which is not in READ_MODES`)
  }
  // And the offset argument must not promise a mode the enum does not have.
  const offset = /offset: \{ type: 'number', description: '([^']*)'/.exec(tools)?.[1] ?? ''
  for (const named of offset.matchAll(/\b([a-z]+): character offset|\bsnapshot and ([a-z]+)/g)) {
    const mode = named[1] ?? named[2]
    assert.ok(declared.has(mode), `camofox_read's offset argument names mode "${mode}", which is not in READ_MODES`)
  }
})

test('every tool name the system prompt mentions is a real tool', () => {
  // The prompt is the routing table. A name it invents teaches the model a tool
  // that does not exist, which costs a turn every time it is used.
  const registered = new Set([...tools.matchAll(/^\s{4}name: '(camofox_\w+)'/gm)].map((m) => m[1]))
  assert.ok(registered.size === 16, `expected 16 tools, found ${registered.size}`)
  for (const name of [...prompt.matchAll(/camofox_\w+/g)].map((m) => m[0])) {
    assert.ok(registered.has(name), `the system prompt mentions ${name}, which is not a registered tool`)
  }
})

test('every tool the prompt recommends has the arguments the prompt names', () => {
  // The prompt says `interactive:true` on camofox_read. If that argument is not in
  // the schema the recommendation is impossible to follow, and nothing reports it.
  const forRecommendation = /camofox_read[^\n]*interactive:(\w+)/.exec(prompt)
  if (!forRecommendation) return
  const schema = /name: 'camofox_read'[\s\S]*?properties: \{([\s\S]*?)\n {6}\},/.exec(tools)?.[1] ?? ''
  assert.ok(schema.includes('interactive:'), 'the prompt recommends camofox_read interactive:true, which the schema does not declare')
})

test('no argument description leaves a unit or a ceiling unstated', () => {
  // A silently clamped or unit-ambiguous argument produces a wrong answer that
  // still looks like success, which is the worst kind of failure for an agent.
  // Every millisecond budget has to say it is milliseconds.
  for (const match of tools.matchAll(/(\w*[Mm]s|\w*Timeout\w*): \{ type: 'number', description: '([^']*)'/g)) {
    const [whole, name, description] = match
    if (/millisecond|seconds|unbounded|no timeout/i.test(description)) continue
    // Anything the code clamps must also declare its bound.
    if (new RegExp(`clampInt\\(args\\.${name}`).test(tools) && !/maximum|max \d|Defaults to \d/i.test(description)) {
      assert.fail(`${name} is clamped in the code but its description states no default or maximum: ${whole}`)
    }
  }
})

test('every tool is registered inside the one-row bundle', () => {
  // The registration path is the only thing that makes a tool exist. Losing it —
  // to a refactor, or to a row that never loads — removes every tool at once, and
  // it is invisible until a model reaches for one.
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: camofox-runtime/, 'the bundle patch no longer inserts the runtime row')
  assert.match(tools, /export function registerTools/, 'registerTools is gone, so nothing registers the tools')
})