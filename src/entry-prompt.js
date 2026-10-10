/**
 * Loader entry that publishes the browser guidance into the system prompt.
 *
 * This is what makes the browser something every model knows about, rather than
 * a capability it only discovers by reading tool schemas.
 *
 * @module dsh-camofox/entry-prompt
 */

import { SERVICE, registerBrowserPrompt } from './index.js'

/** Loader identity. */
export const name = 'dsh-camofox-prompt'

/** Required services: system-prompt assembly and our own browser runtime. */
export const inject = ['systemPrompt', SERVICE]

/**
 * Publish the browser guidance section.
 *
 * @param {any} ctx - Cordis context.
 * @returns {() => void} the section disposer.
 */
export function apply(ctx) {
  return registerBrowserPrompt(ctx)
}

// No default export: the Loader unwraps a default export in preference to the
// namespace, which silently drops `inject` and `name` from the plugin.
export { registerBrowserPrompt } from './index.js'