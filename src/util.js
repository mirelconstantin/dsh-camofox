/**
 * Shared helpers for the dsh-camofox bundle.
 *
 * The bundle is deliberately dependency-free: it imports nothing from the
 * harness at runtime, so module resolution can never fail because of where the
 * package happens to be linked from. Everything it needs is reached through the
 * Cordis `ctx` the framework hands to `apply()`.
 *
 * @module dsh-camofox/util
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'

/** @returns {boolean} whether the runtime is Windows. */
export const isWindows = process.platform === 'win32'

/** Monotonic-ish clock that never goes backwards across NTP steps. */
let lastNow = Date.now()
/** @returns {number} a non-decreasing epoch milliseconds value. */
export function now() {
  const value = Date.now()
  if (value > lastNow) lastNow = value
  return lastNow
}

/**
 * Resolve after `ms` milliseconds.
 *
 * The timer deliberately keeps the event loop alive: this backs user-visible
 * waits such as "wait for this selector", where letting the process fall out of
 * the loop would abandon the call instead of completing it.
 *
 * @param {number} ms - delay in milliseconds.
 * @param {AbortSignal} [signal] - cancels the wait early.
 * @returns {Promise<void>} resolves when the delay elapsed or was cancelled.
 */
export function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    if (!signal) return
    if (signal.aborted) return finish()
    signal.addEventListener('abort', finish, { once: true })

    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
  })
}

/**
 * Compose an abort signal from several sources plus a deadline.
 *
 * `AbortSignal.any` exists on modern Node, but this fallback keeps the bundle
 * usable on older runtimes and makes the "already aborted" case explicit.
 *
 * @param {Array<AbortSignal|undefined>} signals - upstream signals.
 * @param {number} [timeoutMs] - optional deadline.
 * @returns {{ signal: AbortSignal, dispose: () => void, timedOut: () => boolean }}.
 */
export function withDeadline(signals, timeoutMs) {
  const controller = new AbortController()
  const cleanups = []
  let expired = false
  let timer

  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    const onAbort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    cleanups.push(() => signal.removeEventListener('abort', onAbort))
  }

  if (timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => {
      expired = true
      controller.abort(new Error(`deadline of ${timeoutMs}ms exceeded`))
    }, timeoutMs)
  }

  const dispose = () => {
    if (timer) clearTimeout(timer)
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup()
      } catch {
        /* listener removal must never break teardown */
      }
    }
  }

  return { signal: controller.signal, dispose, timedOut: () => expired }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Coerce a value to a finite integer inside `[min, max]`.
 *
 * @param {unknown} value - candidate value.
 * @param {number} fallback - used when the value is not usable.
 * @param {number} [min] - inclusive lower bound.
 * @param {number} [max] - inclusive upper bound.
 * @returns {number} a usable integer.
 */
export function clampInt(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/**
 * Truncate text on a character budget, keeping the head and reporting the cut.
 *
 * @param {string} text - source text.
 * @param {number} maxChars - budget in characters.
 * @param {string} [label] - label used in the truncation notice.
 * @returns {string} the possibly truncated text.
 */
export function truncate(text, maxChars, label = 'content') {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) return value
  const kept = value.slice(0, maxChars)
  return `${kept}\n\n[truncated ${label}: showing ${maxChars} of ${value.length} characters — narrow the request or write the full result to a file]`
}

/**
 * Suffix a numbered sequence so a caller can page through a large result.
 *
 * @param {string} text - full text.
 * @param {number} offset - zero-based character offset.
 * @param {number} limit - character budget for this page.
 * @returns {string} the page of text.
 */
export function page(text, offset, limit) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  const start = clampInt(offset, 0, 0, Math.max(0, value.length))
  const size = clampInt(limit, 20000, 1, 400000)
  if (start >= value.length) {
    return `[no more ${'content'}: the document is ${value.length} characters long]`
  }
  const slice = value.slice(start, start + size)
  const end = start + slice.length
  const header = `characters ${start}-${end} of ${value.length}\n---\n`
  const footer = end < value.length ? `\n---\n[more content: next offset=${end}]` : '\n---\n[end of content]'
  return header + slice + footer
}

/**
 * Build a Standard Schema object without importing a validation library.
 *
 * The harness resolves plugin configuration through the Standard Schema
 * `~standard` interface; this is the whole contract it needs.
 *
 * @param {(value: unknown) => { value: any } | { issues: Array<{ message: string, path?: string[] }> }} validate
 *   - validator returning either a value or issues.
 * @returns {{ '~standard': { version: number, vendor: string, validate: Function } }} a schema.
 */
export function standardSchema(validate) {
  return { '~standard': { version: 1, vendor: 'dsh-camofox', validate } }
}

/**
 * Validate a plain object config against a shape description.
 *
 * Unknown keys are rejected loudly (a typo in `cordis.patch.yml` should fail
 * the plugin load, not silently disable a feature).
 *
 * The result is always a fresh object and never aliases its input: the host may
 * hand in a frozen configuration, and validation must not be able to fail — or
 * silently rewrite — somebody else's state.
 *
 * @param {Record<string, any>} defaults - default value per known key.
 * @param {Record<string, 'string'|'number'|'boolean'|'string[]'|'record'>} types - expected type per key.
 * @returns {(value: unknown) => any} a Standard Schema validate function.
 */
export function configValidator(defaults, types) {
  return (input) => {
    if (input == null) return { value: { ...defaults } }
    if (!isRecord(input)) return { issues: [{ message: 'config must be an object' }] }
    const issues = []
    const value = { ...defaults }
    for (const [key, raw] of Object.entries(input)) {
      if (!(key in defaults)) {
        issues.push({ message: `unknown config key "${key}"`, path: [key] })
        continue
      }
      if (raw === undefined) continue
      const expected = types[key]
      const actual = Array.isArray(raw) ? 'string[]' : typeof raw
      if (expected === 'number') {
        const parsed = typeof raw === 'number' ? raw : Number(raw)
        if (!Number.isFinite(parsed)) {
          issues.push({ message: `"${key}" must be a finite number`, path: [key] })
        } else {
          value[key] = parsed
        }
        continue
      }
      if (expected === 'string[]') {
        if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
          issues.push({ message: `"${key}" must be an array of strings`, path: [key] })
          continue
        }
      } else if (expected === 'record') {
        if (!isRecord(raw)) {
          issues.push({ message: `"${key}" must be an object`, path: [key] })
          continue
        }
        // Node's spawn template-stringifies whatever it is handed, so a nested
        // object would reach the child as `[object Object]`. An environment is
        // made of strings: coerce the primitives and refuse the rest.
        //
        // The result is a NEW object. `raw` is the caller's own configuration
        // (`input.engineEnv`, by reference — the harness may hand us a frozen
        // object straight from its config store), so writing back into it
        // mutated somebody else's state and threw a `TypeError` out of the
        // Standard Schema entry point on a frozen config, which in the host is an
        // unhandled error during plugin load.
        const record = {}
        for (const [childKey, childValue] of Object.entries(raw)) {
          if (typeof childValue === 'string') {
            record[childKey] = childValue
            continue
          }
          if (childValue == null) {
            // Unset and empty are not the same thing: `spawn` keeps a
            // present-but-empty entry in the child's environment, so a null is
            // omitted rather than written as `''`.
            continue
          }
          if (typeof childValue === 'number') {
            if (!Number.isFinite(childValue)) {
              issues.push({ message: `"${key}.${childKey}" must be a finite number`, path: [key, childKey] })
              continue
            }
            record[childKey] = String(childValue)
            continue
          }
          if (typeof childValue === 'boolean') {
            record[childKey] = String(childValue)
            continue
          }
          issues.push({ message: `"${key}.${childKey}" must be a string, number or boolean`, path: [key, childKey] })
        }
        value[key] = record
        continue
      } else if (actual !== expected) {
        issues.push({ message: `"${key}" must be a ${expected}, received ${actual}`, path: [key] })
        continue
      }
      value[key] = raw
    }
    return issues.length > 0 ? { issues } : { value }
  }
}

/**
 * Find all descendant PIDs of a process on Linux by parsing /proc.
 *
 * @param {number} rootPid - ancestor process id.
 * @returns {number[]} list of descendant PIDs.
 */
export function getDescendantPids(rootPid) {
  const descendants = []
  if (!Number.isInteger(rootPid) || rootPid <= 0 || isWindows) return descendants
  try {
    const ppidMap = new Map()
    const entries = readdirSync('/proc')
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (entry.charCodeAt(0) < 48 || entry.charCodeAt(0) > 57) continue
      const pid = Number(entry)
      if (!Number.isInteger(pid) || pid <= 0) continue
      try {
        const statStr = readFileSync(`/proc/${pid}/stat`, 'utf8')
        const rightParen = statStr.lastIndexOf(')')
        if (rightParen === -1) continue
        const rest = statStr.slice(rightParen + 2).trimStart()
        const spaceIdx = rest.indexOf(' ')
        if (spaceIdx === -1) continue
        const spaceIdx2 = rest.indexOf(' ', spaceIdx + 1)
        const ppidStr = spaceIdx2 === -1 ? rest.slice(spaceIdx + 1) : rest.slice(spaceIdx + 1, spaceIdx2)
        const ppid = Number(ppidStr)
        if (Number.isInteger(ppid) && ppid > 0) {
          let list = ppidMap.get(ppid)
          if (!list) {
            list = []
            ppidMap.set(ppid, list)
          }
          list.push(pid)
        }
      } catch {
        /* process may have exited while scanning */
      }
    }
    const queue = [rootPid]
    const seen = new Set([rootPid])
    while (queue.length > 0) {
      const current = queue.shift()
      const children = ppidMap.get(current)
      if (children) {
        for (let i = 0; i < children.length; i++) {
          const child = children[i]
          if (!seen.has(child)) {
            seen.add(child)
            descendants.push(child)
            queue.push(child)
          }
        }
      }
    }
  } catch {
    /* /proc not accessible */
  }
  return descendants
}

/**
 * Remove a process tree.
 * On Windows, `taskkill /T /F` reaches grandchildren.
 * On Linux, process group signaling, `/proc` descendant scanning, and `pkill`
 * ensure all child, grandchild, and browser processes are terminated.
 *
 * @param {number} pid - process id.
 * @param {import('node:child_process').SpawnSyncReturns<Buffer>} [spawnSync] - injected for testing.
 * @param {NodeJS.Signals | string} [signal='SIGTERM'] - signal to send.
 * @returns {boolean} whether the kill was reported as successful.
 */
export function killProcessTree(pid, spawnSync, signal = 'SIGTERM') {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    if (isWindows) {
      if (typeof spawnSync === 'function') {
        const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 15000,
        })
        return result?.status === 0
      }
      return false
    }

    // On Linux/POSIX:
    // 1. Gather all descendants (children, grandchildren, browser processes)
    const descendants = getDescendantPids(pid)

    // 2. Kill the process group (since child is spawned detached: true, PGID == pid)
    try {
      process.kill(-pid, signal)
    } catch {
      /* process group might not exist */
    }

    // 3. Kill all descendants in reverse topological order (leaves first)
    for (let i = descendants.length - 1; i >= 0; i--) {
      try {
        process.kill(descendants[i], signal)
      } catch {
        /* already dead */
      }
    }

    // 4. Fallback pkill for any process not caught in /proc scan
    if (typeof spawnSync === 'function') {
      try {
        const sigName = String(signal).replace(/^SIG/, '')
        spawnSync('pkill', [`-${sigName}`, '-P', String(pid)], { stdio: 'ignore', timeout: 5000 })
      } catch {
        /* pkill failed or missing */
      }
    }

    // 5. Kill the root process itself
    try {
      process.kill(pid, signal)
    } catch {
      /* already dead */
    }

    return true
  } catch {
    return false
  }
}

/**
 * Test whether a process id currently exists.
 *
 * @param {number} pid - process id.
 * @param {import('node:child_process').SpawnSyncReturns<string>} [spawnSync] - injected for testing.
 * @returns {boolean} whether the pid is live.
 */
export function isProcessAlive(pid, spawnSync) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    if (!isWindows) {
      try {
        const statStr = readFileSync(`/proc/${pid}/stat`, 'utf8')
        const rightParen = statStr.lastIndexOf(')')
        if (rightParen !== -1) {
          const state = statStr.charAt(rightParen + 2)
          if (state === 'Z') return false // zombie process is dead
        }
      } catch {
        /* process may have exited */
      }
    }
    return true
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) return true
    return false
  }
}

/** JSON-safe short description of an unknown thrown value. */
export function describeError(error) {
  if (error == null) return 'unknown error'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message || error.name
  try {
    return JSON.stringify(error).slice(0, 500)
  } catch {
    return String(error)
  }
}

/** Size at which the engine log is rotated into numbered generations. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024

/** Number of rotated generations kept beside the live log. */
export const LOG_KEEP = 3

/**
 * Shift a growing log file into numbered generations once it passes `maxBytes`.
 *
 * `path.1` is always the newest generation and `path.keep` the oldest, so the
 * tail of a long session stays readable without an unbounded file. Rotation is
 * best-effort by contract: every caller is a lifecycle path, and a log that
 * cannot be measured, renamed or unlinked must never be the reason an engine
 * dies or a harness exits.
 *
 * @param {string} path - live log path.
 * @param {number} [maxBytes] - size that triggers a rotation.
 * @param {number} [keep] - how many generations to keep.
 * @returns {boolean} whether the file was rotated.
 */
export function rotateLogFile(path, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP) {
  try {
    const generations = Math.max(1, Math.floor(keep))
    if (!existsSync(path)) return false
    if (statSync(path).size < maxBytes) return false
    const oldest = `${path}.${generations}`
    if (existsSync(oldest)) unlinkSync(oldest)
    // Shifting downwards leaves every destination free: `path.N` has already
    // been moved to `path.N+1` by the time it is overwritten, which is what
    // makes the rename legal on Windows.
    for (let index = generations - 1; index >= 1; index -= 1) {
      const source = `${path}.${index}`
      if (!existsSync(source)) continue
      renameSync(source, `${path}.${index + 1}`)
    }
    renameSync(path, `${path}.1`)
    return true
  } catch {
    return false
  }
}