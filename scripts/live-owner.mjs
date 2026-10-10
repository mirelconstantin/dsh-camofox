#!/usr/bin/env node
/**
 * Live-owner simulator.
 *
 * Starts a supervised engine in its own process and stays alive, which is what
 * a running harness looks like from the outside. A second process that shares
 * the same state directory must adopt this engine, never reap it.
 *
 * Usage: node scripts/live-owner.mjs <baseUrl> <stateDir>
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
    userId: 'dsh-live-owner',
  }),
  log: () => {},
})

const ready = await engine.ensureReady()
if (!ready) {
  process.stderr.write(`live-owner simulator could not start the engine: ${engine.lastError}\n`)
  process.exit(1)
}
process.stdout.write(`${engine.child?.pid ?? 0}\n`)
setInterval(() => {}, 1000)