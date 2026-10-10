#!/usr/bin/env node
/**
 * Orphan simulator.
 *
 * Starts a supervised engine in its own process and then dies without
 * disposing, which is what a harness that was force-killed leaves behind: a
 * live engine plus a lock file naming it, owned by nobody.
 *
 * Usage: node scripts/orphan.mjs <baseUrl> <stateDir>
 */
import { CamofoxEngine, resolveConfig } from '../src/engine.js'

const [baseUrl, stateDir] = process.argv.slice(2)
const engine = new CamofoxEngine({
  config: resolveConfig({
    baseUrl,
    repoPath: process.env.CAMOFOX_REPO ?? 'C:\\Users\\mirel\\Desktop\\GitHub\\camofox-browser',
    autostart: true,
    stateDir,
    startTimeoutMs: 150000,
    userId: 'dsh-orphan',
  }),
  log: () => {},
})

const ready = await engine.ensureReady()
if (!ready) {
  process.stderr.write(`orphan simulator could not start the engine: ${engine.lastError}\n`)
  process.exit(1)
}
process.stdout.write(`${engine.child?.pid ?? 0}\n`)
process.exit(0)