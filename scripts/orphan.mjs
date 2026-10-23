#!/usr/bin/env node
/**
 * Orphan simulator.
 *
 * Starts a supervised engine in its own process and then dies without
 * disposing, which is what a harness that was force-killed leaves behind: a
 * live engine plus a lock file naming it, owned by nobody.
 *
 * Usage: node scripts/orphan.mjs <baseUrl> <stateDir> [repoPath]
 */
import { CamofoxEngine, resolveConfig } from '../src/engine.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [baseUrl, stateDir, explicitRepo] = process.argv.slice(2)
const defaultRepo = process.env.CAMOFOX_REPO ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'camofox', 'repo') : join(homedir(), '.dsh', 'camofox', 'repo'))
const repoPath = explicitRepo ?? defaultRepo

const engine = new CamofoxEngine({
  config: resolveConfig({
    baseUrl,
    repoPath,
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
