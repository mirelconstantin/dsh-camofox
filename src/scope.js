/**
 * Derivation of the per-session browser scope.
 *
 * The engine's `userId` is a cookie-jar and tab-pool boundary, not a label: one
 * `userId` is one Playwright context. So the `userId` a session sends decides
 * which cookies it can see and which tabs it can close. A single process-wide
 * value therefore hands every DSH session — and every delegated subagent — one
 * shared jar and one shared `closeSession` blast radius.
 *
 * This module maps a tool `exec` onto that identity, so the boundary is the live
 * Session rather than the plugin process.
 *
 * @module dsh-camofox/scope
 */

/** Longest readable session key kept verbatim in a scope string. */
const MAX_KEY_LENGTH = 48

/**
 * Width of the digest suffix, excluding the separator in front of it.
 *
 * A 32-bit value never needs more than seven base-36 digits (`36^7` exceeds
 * `2^32`), so this is the width {@link shortHash} produces and the width the
 * key budget below reserves. Naming it once is what keeps the two from drifting:
 * a wider digest would silently push every key past `MAX_KEY_LENGTH`.
 */
const DIGEST_WIDTH = 7

/**
 * FNV-1a over UTF-16 code units, rendered base-36.
 *
 * A non-cryptographic digest is the right tool: this only has to keep two
 * different session ids apart after sanitisation, never resist an attacker. It
 * is computed in-process and never leaves it, so no secret is hashed.
 *
 * @param {string} value - the string to digest.
 * @returns {string} a fixed-width base-36 token.
 */
export function shortHash(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(DIGEST_WIDTH, '0')
}

/**
 * Reduce an arbitrary session id to a short, stable, engine-safe token.
 *
 * The engine's `normalizeUserId` is `String(userId)` and imposes no charset, but
 * the value still travels in URL path segments and query strings and is printed
 * into engine logs and proxy keys. Restricting it to `[A-Za-z0-9._-]` keeps all
 * three sane.
 *
 * A digest is ALWAYS appended, never used only as a fallback for short ids:
 * sanitising is lossy — `a/b/c` and `a-b-c` both become `a-b-c` — and two
 * different sessions must never end up sharing one cookie jar. The digest is
 * what keeps them apart; the readable prefix is what makes a scope legible in a
 * log line.
 *
 * The result is at most `MAX_KEY_LENGTH` characters: a prefix of
 * `MAX_KEY_LENGTH - DIGEST_WIDTH - 1`, a separator, and the digest. The budget
 * is stated in terms of `DIGEST_WIDTH` rather than a literal, because a literal
 * is how the two silently disagree — a digest one digit wider would push every
 * key past the limit without anything failing.
 *
 * @param {string} value - the raw session id.
 * @returns {string} a filesystem-, URL- and log-safe token.
 */
export function sanitizeKey(value) {
  const raw = String(value)
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, Math.max(1, MAX_KEY_LENGTH - DIGEST_WIDTH - 1))
  return `${safe || 'session'}-${shortHash(raw)}`
}

/**
 * Read the live session identity out of a tool execution.
 *
 * `Agent.id` is the documented, authoritative handle. The two fallbacks exist
 * for call paths that are not a full agent execution. `null` means "no session",
 * which the caller must map to the SHARED namespace rather than to a fresh
 * scope — inventing a scope per call would hand out a new cookie jar on every
 * tool call.
 *
 * @param {any} exec - the tool execution.
 * @returns {string | null} the session id, or null when there is none.
 */
function readSessionKey(exec) {
  const agent = exec?.agent
  const candidate = agent?.id ?? agent?.session?.id ?? exec?.session?.id
  if (candidate === undefined || candidate === null) return null
  const text = String(candidate).trim()
  return text === '' ? null : text
}

/**
 * Resolve the engine `userId` that a tool execution must use.
 *
 * The result is `${config.userId}~${sessionKey}`: namespaced, never replacing the
 * configured value, so `userId` keeps an honest meaning (it is the operator's
 * lever for forcing a clean jar) and the two profiles stay separate.
 *
 * The string is a pure function of the config and the session id, which is what
 * makes it survive a harness restart: a resumed session recomputes the same
 * scope and finds the cookies its predecessor left in the engine.
 *
 * When `perSessionScope` is `false`, this returns the bare configured `userId`,
 * which is byte-identical to the behaviour before this change.
 *
 * @param {any} exec - the tool execution.
 * @param {{ userId?: string, perSessionScope?: boolean }} config - resolved plugin config.
 * @returns {string} the scope to send as the engine `userId`.
 */
export function resolveScope(exec, config) {
  const namespace = typeof config?.userId === 'string' && config.userId !== '' ? config.userId : 'dsh'
  if (config?.perSessionScope === false) return namespace
  const seed = readSessionKey(exec)
  if (seed === null) return namespace
  return `${namespace}~${sanitizeKey(seed)}`
}
