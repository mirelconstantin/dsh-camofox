/**
 * Run both live suites and fail if either one failed.
 *
 * Why this exists instead of a shell one-liner:
 *
 * - `"a & b"` in a package script runs both under `cmd.exe`, but returns the exit
 *   code of the LAST one only. So `smoke.mjs` can fail outright, `lifecycle.mjs`
 *   pass, and `npm run test:live` still exits 0 — a green result over a red suite.
 * - `"a && b"` propagates failure correctly but never runs `b` once `a` fails,
 *   which is how the original `&&` binding hid a completely dead live tier behind a
 *   suite that reported nothing.
 *
 * Neither shell operator can express "run both, and fail if either failed", so
 * this does: both start, both are awaited, and the exit code is the conjunction.
 *
 * Output is inherited rather than piped, so the suites' step-by-step progress
 * reaches the console live and in order.
 *
 * Run with: `node scripts/live.mjs`
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The live suites, in the order they are reported. */
const SUITES = ['smoke.mjs', 'lifecycle.mjs']

/**
 * Start one suite and resolve with its exit code when it finishes.
 *
 * @param {string} name - file name inside `scripts/`.
 * @returns {Promise<{ name: string, code: number, error?: Error }>} its outcome.
 */
function run(name) {
  return new Promise((resolve) => {
    console.log(`\n=== ${name} ===`)
    const child = spawn(process.execPath, [join(HERE, name)], {
      stdio: 'inherit',
      windowsHide: true,
    })
    child.on('error', (error) => resolve({ name, code: -1, error }))
    child.on('close', (code, signal) => {
      // A signalled death is a failure, never a pass: "killed" and "fine" must
      // not collapse into the same zero.
      resolve({ name, code: signal ? -1 : (code ?? -1), signal })
    })
  })
}

const results = await Promise.all(SUITES.map(run))

console.log('\n=== live summary ===')
for (const result of results) {
  const reason = result.error ? result.error.message : (result.signal ? `killed by ${result.signal}` : `exit ${result.code}`)
  console.log(`${result.name}: ${reason}`)
}

const failed = results.filter((result) => result.code !== 0)
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} live suite(s) failed: ${failed.map((r) => r.name).join(', ')}`)
  process.exit(1)
}
console.log(`\nall ${results.length} live suites passed`)
process.exit(0)