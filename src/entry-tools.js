/**
 * Loader entry that mounts the model-facing browser tools.
 *
 * Kept separate from the service plugin so a configuration reload of one does
 * not have to tear the engine down and bring it back up for the other.
 *
 * @module dsh-camofox/entry-tools
 */

import { SERVICE, registerBrowserTools } from './index.js'

/** Loader identity. */
export const name = 'dsh-camofox-tools'

/** Required services: the tool registry and our own browser runtime. */
export const inject = ['tools', SERVICE]

/**
 * Register every browser tool.
 *
 * Returns nothing on purpose: Cordis reads whatever a plugin body returns as
 * an effect, and a list of tool names is neither a disposer nor a promise.
 *
 * @param {any} ctx - Cordis context.
 * @returns {void} nothing.
 */
export function apply(ctx) {
  const names = registerBrowserTools(ctx, ctx.get(SERVICE))
  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : null
  const summary = `registered ${names.length} browser tool(s): ${names.join(', ')}`
  if (logger) logger.info(summary)
  else process.stderr.write(`[${name}] ${summary}\n`)
}

// No default export: the Loader unwraps a default export in preference to the
// namespace, which silently drops `inject` and `name` from the plugin.
export { registerBrowserTools } from './index.js'