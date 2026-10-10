/**
 * High-level Camoufox browser operations used by the native tools.
 *
 * Everything the model can ask for goes through here so that timeouts,
 * cancellation, concurrency, tab bookkeeping and the engine's error taxonomy
 * are handled in exactly one place.
 *
 * The bridge itself is stateless with respect to a session: every method takes
 * the engine `userId` (the "scope") as its first argument, and {@link
 * CamofoxBridge#for} hands out a per-execution view that supplies it. That is
 * what keeps one session's cookies, tabs and `closeSession` blast radius out of
 * another session's reach inside the same plugin process.
 *
 * @module dsh-camofox/bridge
 */

import { EngineError } from './engine.js'
import { resolveScope } from './scope.js'
import { clampInt, describeError, isRecord, now, sleep } from './util.js'

/** Search macros the engine understands, including the one the old tool omitted. */
export const SEARCH_MACROS = Object.freeze([
  '@google_search',
  '@youtube_search',
  '@amazon_search',
  '@reddit_search',
  '@reddit_subreddit',
  '@wikipedia_search',
  '@twitter_search',
  '@yelp_search',
  '@spotify_search',
  '@netflix_search',
  '@linkedin_search',
  '@instagram_search',
  '@tiktok_search',
  '@twitch_search',
])

/**
 * HTTP methods whose repetition cannot change the page.
 *
 * Everything else is a side-effecting action: replaying it risks a double
 * click, a second checkout submission or a duplicated form post.
 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD'])

/**
 * The tab-history routes `history()` may dispatch to.
 *
 * An allowlist rather than an encode: these are three fixed paths, so there is
 * nothing to escape if the value is one of them, and a value that is not one of
 * them is a bug or a hostile argument, never a legitimate navigation.
 */
const HISTORY_ACTIONS = new Set(['back', 'forward', 'refresh'])

/** A counting semaphore that never lets more than N calls run at once. */
class Semaphore {
  /**
   * @param {number} limit - maximum simultaneous holders.
   */
  constructor(limit) {
    this.limit = Math.max(1, limit)
    this.active = 0
    /** @type {Array<() => void>} */
    this.queue = []
  }

  /**
   * Run `task` once a slot is free.
   *
   * @template T
   * @param {() => Promise<T>} task - work to run.
   * @param {AbortSignal} [signal] - cancels the wait for a slot.
   * @returns {Promise<T>} the task result.
   */
  async run(task, signal) {
    await this.#acquire(signal)
    try {
      return await task()
    } finally {
      this.#release()
    }
  }

  /**
   * Wait for a free slot.
   *
   * @param {AbortSignal} [signal] - cancels the wait.
   * @returns {Promise<void>} resolves when a slot is held.
   */
  #acquire(signal) {
    // The aborted check comes first, before the counter moves. Rejecting after
    // `active` was raised never reaches `run`'s `finally` — that `finally` is
    // only entered once `#acquire` resolves — so the slot leaked for the life
    // of the process and, with `maxConcurrentPerUser` capped at 3, a cancelled
    // tool call could wedge the whole browser behind it.
    if (signal?.aborted) {
      return Promise.reject(new EngineError('the browser call was canceled', { code: 'canceled' }))
    }
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const entry = () => {
        signal?.removeEventListener('abort', onAbort)
        this.active += 1
        resolve()
      }
      const onAbort = () => {
        const index = this.queue.indexOf(entry)
        if (index >= 0) this.queue.splice(index, 1)
        reject(new EngineError('the browser call was canceled while queued', { code: 'canceled' }))
      }
      // Re-checked after the queue entry exists but before it is queued: a
      // listener added to an already-aborted signal never fires, so the entry
      // would sit in the queue forever and this promise would never settle.
      if (signal?.aborted) {
        onAbort()
        return
      }
      this.queue.push(entry)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Release a held slot, handing it to the next waiter. */
  #release() {
    this.active -= 1
    const next = this.queue.shift()
    if (next) next()
  }
}

/**
 * Unwrap the engine's `{ ok, result }` envelope around an evaluated expression.
 *
 * Older builds returned the bare value, so both shapes are accepted; anything
 * else is passed through untouched so a surprising shape stays visible instead
 * of silently becoming `undefined`.
 *
 * @param {any} payload - the engine response.
 * @returns {any} the evaluated value.
 */
export function unwrapEvaluate(payload) {
  if (isRecord(payload)) {
    if ('result' in payload) return payload.result
    if ('value' in payload) return payload.value
  }
  return payload
}

/**
 * Whether a failure provably happened before the engine ran any part of the
 * request.
 *
 * `engine_unreachable` is deliberately NOT here: the transport raises it for a
 * lost response as well as for a refused connection, so it proves nothing about
 * whether the action ran. The two payload codes below name waits the engine
 * performs ahead of an action. Everything else either already happened — a
 * `session_expired` that arrives *after* a click landed must not be replayed, or
 * a checkout is submitted twice — or would fail identically on a second attempt
 * (`stale_refs`, `element_not_actionable`, 422 extraction failures).
 *
 * @param {EngineError} error - the classified failure.
 * @returns {boolean} whether repeating the request is safe.
 */
function isPreDispatch(error) {
  // Only the engine's own classification counts. `engine_unreachable` used to be
  // here too, on the reasoning that no response means no request — but a
  // transport that loses the response AFTER the body was sent (`ECONNRESET`,
  // `EPIPE`, a socket hang-up) raises exactly the same error, and replaying
  // that runs the action twice: a page script runs twice, or a second tab is
  // created and the first is leaked until the engine recycles it. The engine
  // tells us when it rejected a request before doing anything
  // (`concurrency_timeout`, `browser_launch_timeout`); nothing else is proof.
  const payloadCode = isRecord(error?.payload) ? error.payload.code : undefined
  return payloadCode === 'concurrency_timeout' || payloadCode === 'browser_launch_timeout'
}

/**
 * Whether a URL points at the engine itself.
 *
 * The engine's own UI and health pages are real pages a caller can navigate a
 * tab to, so such a tab stays tracked and closable; it is only kept out of an
 * ambiguity suggestion, because it never identifies the tab a caller meant.
 *
 * @param {string} url - a tracked tab URL.
 * @param {string} origin - the engine origin.
 * @returns {boolean} whether both URLs share an origin.
 */
function isEngineSelfUrl(url, origin) {
  try {
    return new URL(String(url)).origin === String(origin)
  } catch {
    return false
  }
}

/**
 * Render a URL as host and path, never query string, capped for an error body.
 *
 * The full URL of three tabs once produced a 5 500-character error message that
 * buried the instruction the caller actually needed.
 *
 * @param {string} url - the URL to shorten.
 * @returns {string} a compact, query-free rendering.
 */
function shortUrl(url) {
  const text = String(url ?? '')
  let short
  try {
    const parsed = new URL(text)
    short = `${parsed.host}${parsed.pathname}`
  } catch {
    short = text
  }
  return short.length > 60 ? `${short.slice(0, 59)}…` : short
}

/**
 * The generated delegate table behind {@link CamofoxBridge#for}.
 *
 * A view created with `Object.create(SCOPED_DELEGATES)` carries `bridge` and
 * `scope` as own properties; every method forwards its own arguments to the
 * bridge with that scope prepended, so there is exactly one implementation of
 * each operation and every existing call site keeps its signature. A caller
 * that already has a scope can always reach the bridge directly.
 *
 * The view deliberately exposes no `userId` of its own: the scope is the only
 * identity it can speak with, and a caller that reached past it would be talking
 * to an arbitrary cookie jar.
 */
const SCOPED_DELEGATES = {
  for(exec) {
    return this.bridge.for(exec)
  },
  get config() {
    return this.bridge.config
  },
  get engine() {
    return this.bridge.engine
  },
  call(method, path, body, options) {
    return this.bridge.call(method, path, body, options)
  },
  status() {
    return this.bridge.status(this.scope)
  },
  resolveTabId(tabId, operation) {
    return this.bridge.resolveTabId(this.scope, tabId, operation)
  },
  evictToMaxTabs(signal, keepTabId) {
    return this.bridge.evictToMaxTabs(this.scope, signal, keepTabId)
  },
  open(args, signal) {
    return this.bridge.open(this.scope, args, signal)
  },
  listTabs(signal) {
    return this.bridge.listTabs(this.scope, signal)
  },
  closeTab(tabId, signal) {
    return this.bridge.closeTab(this.scope, tabId, signal)
  },
  closeSession(signal) {
    return this.bridge.closeSession(this.scope, signal)
  },
  disposeScope() {
    return this.bridge.disposeScope(this.scope)
  },
  navigate(tabId, args, signal) {
    return this.bridge.navigate(this.scope, tabId, args, signal)
  },
  snapshot(tabId, args, signal) {
    return this.bridge.snapshot(this.scope, tabId, args, signal)
  },
  links(tabId, args, signal) {
    return this.bridge.links(this.scope, tabId, args, signal)
  },
  images(tabId, args, signal) {
    return this.bridge.images(this.scope, tabId, args, signal)
  },
  extract(tabId, schema, signal) {
    return this.bridge.extract(this.scope, tabId, schema, signal)
  },
  click(tabId, args, signal) {
    return this.bridge.click(this.scope, tabId, args, signal)
  },
  type(tabId, args, signal) {
    return this.bridge.type(this.scope, tabId, args, signal)
  },
  select(tabId, args, signal) {
    return this.bridge.select(this.scope, tabId, args, signal)
  },
  press(tabId, key, signal) {
    return this.bridge.press(this.scope, tabId, key, signal)
  },
  scroll(tabId, args, signal) {
    return this.bridge.scroll(this.scope, tabId, args, signal)
  },
  extractBySelector(tabId, schema, signal) {
    return this.bridge.extractBySelector(this.scope, tabId, schema, signal)
  },
  waitForReady(tabId, args, signal) {
    return this.bridge.waitForReady(this.scope, tabId, args, signal)
  },
  waitForSelector(tabId, selector, args, signal) {
    return this.bridge.waitForSelector(this.scope, tabId, selector, args, signal)
  },
  waitForUrl(tabId, pattern, args, signal) {
    return this.bridge.waitForUrl(this.scope, tabId, pattern, args, signal)
  },
  evaluate(tabId, expression, signal) {
    return this.bridge.evaluate(this.scope, tabId, expression, signal)
  },
  screenshot(tabId, options, signal) {
    return this.bridge.screenshot(this.scope, tabId, options, signal)
  },
  viewport(tabId, args, signal) {
    return this.bridge.viewport(this.scope, tabId, args, signal)
  },
  downloads(tabId, args, signal) {
    return this.bridge.downloads(this.scope, tabId, args, signal)
  },
  captureCurrentResource(tabId, signal) {
    return this.bridge.captureCurrentResource(this.scope, tabId, signal)
  },
  upload(tabId, args, signal) {
    return this.bridge.upload(this.scope, tabId, args, signal)
  },
  history(tabId, action, signal) {
    return this.bridge.history(this.scope, tabId, action, signal)
  },
  stats(tabId, signal) {
    return this.bridge.stats(this.scope, tabId, signal)
  },
  youtubeTranscript(args, signal) {
    return this.bridge.youtubeTranscript(args, signal)
  },
  traces(signal) {
    return this.bridge.traces(this.scope, signal)
  },
  traceFile(filename, signal) {
    return this.bridge.traceFile(this.scope, filename, signal)
  },
  importCookies(cookies, signal) {
    return this.bridge.importCookies(this.scope, cookies, signal)
  },
  consoleEntries(options, signal) {
    return this.bridge.consoleEntries(this.scope, options, signal)
  },
  deleteTrace(filename, signal) {
    return this.bridge.deleteTrace(this.scope, filename, signal)
  },
  traceFile(filename, signal) {
    return this.bridge.traceFile(this.scope, filename, signal)
  },
  pressureCleanup(args, signal) {
    return this.bridge.pressureCleanup(this.scope, args, signal)
  },
}

/** One browser scope is released after this long without a single call. */
const DEFAULT_SCOPE_IDLE_MS = 900000

/** How often the sweep may consider disposing idle scopes. */
const SCOPE_SWEEP_INTERVAL_MS = 60000

/**
 * Typed facade over the Camoufox REST engine.
 */
export class CamofoxBridge {
  /** Cached per-execution scoped views; entries die with their execution. */
  #views = new WeakMap()

  /** Timestamp of the last scope sweep, so at most one runs per minute. */
  #lastSweep = 0

  /**
   * @param {import('./engine.js').CamofoxEngine} engine - supervised engine.
   */
  constructor(engine) {
    this.engine = engine
    this.config = engine.config
    this.semaphore = new Semaphore(this.config.maxConcurrentPerUser)
    /** @type {Map<string, Map<string, { tabId: string, sessionKey: string, url: string, title: string, createdAt: number, lastUsedAt: number }>>} */
    this.tabs = new Map()
    /**
     * Last moment each scope was seen, including scopes whose last tab was
     * closed: without it a scope that holds no tabs is indistinguishable from
     * one that never existed, and can never be disposed.
     *
     * @type {Map<string, number>}
     */
    this.scopeLastUsed = new Map()
    /**
     * The last document read from each tab, used to detect a resumed read that
     * the engine answered from a different page.
     *
     * @type {Map<string, { documentId: string, totalChars: number, url: string }>}
     */
    this.snapshotDocs = new Map()
    /** Sequence behind plugin-minted snapshot document tokens. */
    this.documentSeq = 0
    this.#views = new WeakMap()
    this.#lastSweep = 0
  }

  /**
   * The view every tool call should use.
   *
   * The scope is recomputed on every call rather than frozen into the view, so a
   * configuration reload is honoured by calls already holding a view. The view
   * itself is cached per execution, which keeps the object count flat across a
   * long session without pinning the execution alive: a `WeakMap` entry dies
   * with its execution.
   *
   * An `exec` that is not an object (a script calling the bridge directly) gets
   * an uncached view instead of a `WeakMap` key, and `resolveScope` maps it to
   * the shared namespace — the configured `userId` on its own, which is exactly
   * the single private jar those callers had before scoping existed.
   *
   * @param {any} exec - the tool execution, or undefined outside a session.
   * @returns {{ bridge: CamofoxBridge, scope: string }} the scoped view.
   */
  for(exec) {
    const cacheable = (typeof exec === 'object' && exec !== null) || typeof exec === 'function'
    const view = (cacheable ? this.#views.get(exec) : undefined) ?? Object.create(SCOPED_DELEGATES)
    view.bridge = this
    view.scope = resolveScope(exec, this.config)
    if (cacheable) this.#views.set(exec, view)
    return view
  }

  /**
   * One scope's tab registry, created on first use and stamped as live.
   *
   * @param {string} scope - engine `userId` for this session.
   * @returns {Map<string, any>} the scope's tab records.
   */
  #tabsFor(scope) {
    let tabs = this.tabs.get(scope)
    if (!tabs) {
      tabs = new Map()
      this.tabs.set(scope, tabs)
    }
    this.scopeLastUsed.set(scope, now())
    return tabs
  }

  /**
   * Drop tracked tabs the engine has told us, directly or by implication, are gone.
   *
   * The engine silently recycles the least-used tab once a session reaches its
   * cap, so tracked tabs drift into ghosts that resolve, suggest and act as if
   * they exist. Reconciliation against the engine's own answers is what makes
   * this map truthful; capping it is not, because the cap is exactly the
   * condition that causes the drift.
   *
   * @param {any} error - the failure that was classified as losing a tab.
   * @param {string} path - the engine path the failure came from.
   */
  #forgetDeadTabs(error, path) {
    if (!(error instanceof EngineError) || !error.needsNewTab) return
    if (error.code === 'browser_restarted') {
      // A restarted browser took every context with it, so every registry entry
      // and every remembered document now describes something that no longer
      // exists.
      let dropped = 0
      for (const tabs of this.tabs.values()) dropped += tabs.size
      this.tabs.clear()
      this.snapshotDocs.clear()
      if (dropped > 0) this.engine.log(`forgot ${dropped} tracked tab(s): the browser restarted`)
      return
    }
    const match = /^\/tabs\/([^/?]+)/.exec(path)
    if (!match) return
    let tabId
    try {
      tabId = decodeURIComponent(match[1])
    } catch {
      tabId = match[1]
    }
    // Tab ids are engine-generated and unique across contexts, so the owner does
    // not have to be known to forget the tab.
    for (const tabs of this.tabs.values()) {
      if (tabs.delete(tabId)) return
    }
  }

  /**
   * Drop tracked tabs the engine's own listing no longer reports.
   *
   * A tab touched within the last two seconds is spared: a `GET /tabs` that
   * raced a `POST /tabs` answers without the tab that was just created, and
   * forgetting it here would make the tool that opened it lose it immediately.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {Set<string>} liveIds - tab ids the engine currently reports.
   * @returns {number} how many records were dropped.
   */
  #forgetMissingTabs(scope, liveIds) {
    const tabs = this.tabs.get(scope)
    if (!tabs) return 0
    const stamp = now()
    let dropped = 0
    for (const [tabId, record] of [...tabs]) {
      if (liveIds.has(tabId)) continue
      if (stamp - record.lastUsedAt < 2000) continue
      tabs.delete(tabId)
      dropped += 1
    }
    return dropped
  }

  /**
   * The tab map for one scope, stamped as live.
   *
   * @param {string} scope - engine `userId`.
   * @param {string} tabId - tab to mark as used.
   * @returns {object | undefined} the record, when it is tracked.
   */
  #touch(scope, tabId) {
    this.scopeLastUsed.set(scope, now())
    const record = this.tabs.get(scope)?.get(tabId)
    if (record) record.lastUsedAt = now()
    return record
  }

  /**
   * Release every scope that has been idle past the configured TTL.
   *
   * It needs no timer of its own: it runs at most once a minute on the first
   * call, which is the only moment a sweep can be free. It exists because a
   * session that was never announced is never reported anywhere, and the
   * engine's own reapers are environment-tunable rather than owned here — an
   * abandoned context otherwise holds its cookies for as long as the browser
   * lives.
   */
  #sweepScopes() {
    if (this.config.perSessionScope === false) return
    const stamp = now()
    if (stamp - this.#lastSweep < SCOPE_SWEEP_INTERVAL_MS) return
    // Stamped before the loop so a dispose — which calls back into `call` —
    // cannot start a second sweep while this one runs.
    this.#lastSweep = stamp
    const idleMs = Number.isFinite(this.config.scopeIdleMs) ? this.config.scopeIdleMs : DEFAULT_SCOPE_IDLE_MS
    for (const [scope, lastUsedAt] of [...this.scopeLastUsed]) {
      if (stamp - lastUsedAt < idleMs) continue
      // Every exit from disposeScope must be caught. A rejection here is otherwise
      // a floating promise, and `disposeScope` logs inside its own catch — through
      // `engine.log`, the raw sink, which throws EPIPE once the host has closed
      // stderr. That rejection would reach the host's unhandled-rejection policy
      // and take the whole process down over a routine scope sweep.
      void this.disposeScope(scope).catch(() => {})
    }
  }

  /**
   * @param {string} scope - engine `userId` for this session.
   * @returns {object} JSON-safe runtime status for the status tool.
   */
  status(scope) {
    const records = [...(this.tabs.get(scope)?.values() ?? [])]
    let otherActiveScopes = 0
    for (const other of this.scopeLastUsed.keys()) if (other !== scope) otherActiveScopes += 1
    return {
      ...this.engine.status(),
      scope,
      trackedTabs: records.slice(0, this.config.maxTabs).map((tab) => ({
        tabId: tab.tabId,
        tabGroup: tab.sessionKey,
        url: tab.url,
        title: tab.title,
        idleMs: now() - tab.lastUsedAt,
      })),
      // The list is capped for a render budget, so the true count is reported
      // beside it: otherwise "8 tabs" would read as "there are 8 tabs".
      trackedTabCount: records.length,
      otherActiveScopes,
      searchMacros: SEARCH_MACROS,
    }
  }

  /**
   * Ensure the engine is up and run one REST call with retry and serialization.
   *
   * A retry repeats only a request that is idempotent (GET/HEAD) or provably
   * never reached the engine; `options.retry` is the explicit override for a
   * POST whose repetition is known to be harmless. Without it the worst case was
   * three readiness attempts of `startTimeoutMs` plus three backoffs for a call
   * that could not have succeeded once, and a side-effecting action could be
   * replayed after it had already landed.
   *
   * @param {string} method - HTTP method.
   * @param {string} path - engine path.
   * @param {any} [body] - JSON body.
   * @param {{ signal?: AbortSignal, timeoutMs?: number, query?: Record<string, any>, raw?: boolean, retry?: boolean, retries?: number }} [options] - call options; `retry` opts a non-idempotent call into replay, `retries` caps the attempts.
   * @returns {Promise<any>} the decoded payload.
   */
  async call(method, path, body, options = {}) {
    this.#sweepScopes()
    const replayable = options.retry === undefined ? IDEMPOTENT_METHODS.has(method) : options.retry !== false
    const retries = replayable ? clampInt(options.retries, 2, 0, 5) : 0
    let lastError
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (options.signal?.aborted) throw new EngineError('the browser call was canceled', { code: 'canceled' })
      try {
        return await this.semaphore.run(
          async () => {
            // The boolean is the readiness answer. Discarding it is what turned
            // a readiness failure into three full `startTimeoutMs` waits before
            // the call failed anyway.
            const ready = await this.engine.ensureReady(options.signal)
            if (ready === false) {
              throw new EngineError(this.engine.lastError || `the camofox engine at ${this.engine.origin} is not ready`, {
                code: 'engine_not_ready',
              })
            }
            return await this.engine.request(method, path, body, options)
          },
          options.signal,
        )
      } catch (error) {
        lastError = error
        this.#forgetDeadTabs(error, path)
        const safeToReplay = IDEMPOTENT_METHODS.has(method) || (error instanceof EngineError && isPreDispatch(error))
        const retryable =
          error instanceof EngineError && error.retryable && safeToReplay && !error.needsNewTab && !error.needsResnapshot
        if (!retryable || attempt === retries) break
        const delay = Math.min(4000, 300 * 2 ** attempt)
        this.engine.log(`retrying ${method} ${path} in ${delay}ms: ${describeError(error)}`)
        await sleep(delay, options.signal)
      }
    }
    throw lastError
  }

  /**
   * Remember a tab so later calls can use a short reference.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {any} payload - engine tab payload.
   * @param {string} [sessionKey] - grouping key supplied at creation.
   * @returns {object} the tracked tab record.
   */
  #track(scope, payload, sessionKey) {
    const tabId = typeof payload?.tabId === 'string' ? payload.tabId : String(payload?.tabId ?? '')
    if (!tabId) throw new EngineError('the camofox engine did not return a tab id', { code: 'no_tab_id' })
    const record = {
      tabId,
      sessionKey: sessionKey || 'default',
      url: typeof payload?.url === 'string' ? payload.url : '',
      title: typeof payload?.title === 'string' ? payload.title : '',
      createdAt: now(),
      lastUsedAt: now(),
    }
    this.#tabsFor(scope).set(tabId, record)
    return record
  }

  /**
   * The scope OTHER than `scope` that claims a tab id, if any.
   *
   * Every scope holds its tabs in its own inner map, so a tab id that appears
   * under a different key is another session's tab by definition: tab ids are
   * engine-generated and unique across contexts, so no scope legitimately
   * tracks a tab another scope also tracks.
   *
   * This is the only place cross-session reachability is decided, so it answers
   * a negative only when another scope really holds the tab. A tab nobody here
   * tracks — the plugin restarted and the engine still serves the tab — is not
   * a reachability finding: the request still carries this scope's `userId`, so
   * the engine keeps deciding that.
   *
   * @param {string} scope - the scope asking.
   * @param {string} tabId - the tab id it asked for.
   * @returns {string | null} the owning scope, or null when no other scope claims it.
   */
  #foreignOwner(scope, tabId) {
    for (const [owner, tabs] of this.tabs) {
      if (owner !== scope && tabs.has(tabId)) return owner
    }
    return null
  }

  /**
   * Validate a tab id argument, allowing omission when exactly one tab is open.
   *
   * This is the single chokepoint every caller-supplied tab id passes through —
   * `resolveTabId` is what each read, act, capture, eval and close calls before
   * it touches the engine — so the ownership check belongs here rather than in
   * eleven tools.
   *
   * A tab id this scope does not own is REFUSED, not resolved: without the
   * check a session that learned another session's id from any side channel
   * would drive that tab through its own `userId`, and the `closeTab` half of
   * that is a denial of service against a stranger's browser.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string | undefined} tabId - caller supplied tab id.
   * @param {string} operation - operation name used in the error message.
   * @returns {string} a usable tab id.
   */
  resolveTabId(scope, tabId, operation) {
    const tabs = this.tabs.get(scope)
    if (typeof tabId === 'string' && tabId.trim() !== '') {
      const id = tabId.trim()
      const foreign = this.#foreignOwner(scope, id)
      if (foreign !== null) {
        throw new EngineError(
          `${operation} cannot use tab ${id}: it belongs to another session's browser context, not yours. Call camofox_tabs(action:"list") for your own tabs.`,
          { code: 'foreign_tab' },
        )
      }
      return id
    }
    if (tabs?.size === 1) return [...tabs.keys()][0]
    if (!tabs || tabs.size === 0) {
      throw new EngineError(`${operation} needs an open tab; call camofox_open first`, { code: 'no_tab', needsNewTab: true })
    }
    const recent = [...tabs.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    // Three most recent, at most: the untruncated list of every tab id and full
    // URL once made a 5 500-character error that buried the instruction.
    const useful = recent.filter((tab) => !isEngineSelfUrl(tab.url, this.engine.origin))
    const shown = (useful.length > 0 ? useful : recent).slice(0, 3)
    throw new EngineError(
      `${operation} needs a tabId because ${tabs.size} tabs are open (${shown.map((tab) => `${tab.tabId} → ${shortUrl(tab.url)}`).join(', ')}); call camofox_tabs(action:"list") for the live list from the engine.`,
      { code: 'ambiguous_tab' },
    )
  }

  /**
   * Open a tab, optionally navigating straight away.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {{ url?: string, macro?: string, query?: string, sessionKey?: string, trace?: boolean }} args - open arguments.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>} the tracked tab record plus the engine payload.
   */
  async open(scope, args, signal) {
    // `POST /tabs` requires a sessionKey, and defaulting it to the scope means
    // two sessions can never pick a colliding group name inside one context.
    const sessionKey = args.sessionKey || scope
    const body = { userId: scope, sessionKey, trace: args.trace === true }
    // A search macro is expanded by the navigate route, not by tab creation, so
    // the tab is opened first and the macro is then run against it.
    if (!args.macro && args.url) body.url = args.url
    // This runs outside the semaphore on purpose: `open` is not itself inside
    // `call`, so entering it here would queue this step behind the very slot it
    // is about to use, and deadlock once the concurrency limit is reached.
    await this.evictToMaxTabs(scope, signal)
    const payload = await this.call('POST', '/tabs', body, { signal, retry: true })
    const record = this.#track(scope, payload, sessionKey)
    // The navigate result carries fields tab creation never has — `httpStatus`,
    // `navigationOk`, and the search-fallback provenance the engine reports
    // when Google blocks and it answers from another engine instead
    // (server.js:3489-3497). It used to be awaited and dropped, so a search
    // macro's own answer was thrown away.
    let navigated = null
    if (args.macro) {
      navigated = await this.navigate(scope, record.tabId, { macro: args.macro, query: args.query }, signal)
      const refreshed = await this.call('GET', `/tabs/${encodeURIComponent(record.tabId)}/stats`, undefined, {
        signal,
        query: { userId: scope },
        retry: false,
      })
      if (typeof refreshed?.url === 'string') record.url = refreshed.url
    }
    return { ...payload, ...(navigated ?? {}), sessionKey: record.sessionKey, tabId: record.tabId, url: record.url, title: record.title }
  }

  /**
   * List the engine's own view of this scope's tabs, reconciled with the registry.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} open tabs.
   */
  async listTabs(scope, signal) {
    const payload = await this.call('GET', '/tabs', undefined, { signal, query: { userId: scope } })
    const live = new Set(
      (Array.isArray(payload?.tabs) ? payload.tabs : [])
        .map((tab) => tab?.tabId)
        .filter((tabId) => typeof tabId === 'string' && tabId !== ''),
    )
    const dropped = this.#forgetMissingTabs(scope, live)
    if (dropped > 0) this.engine.log(`forgot ${dropped} tracked tab(s) in ${scope}: the engine no longer reports them`)
    this.scopeLastUsed.set(scope, now())
    return payload
  }

  /**
   * Close one tab.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - tab to close.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the engine response.
   */
  async closeTab(scope, tabId, signal) {
    const response = await this.call('DELETE', `/tabs/${encodeURIComponent(tabId)}`, undefined, {
      signal,
      query: { userId: scope },
      retry: false,
    })
    // A scope that never opened a tab has no inner map at all.
    this.tabs.get(scope)?.delete(tabId)
    return response
  }

  /**
   * Close this scope's whole engine context, cookies included.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} session reset result.
   */
  async closeSession(scope, signal) {
    const response = await this.call('DELETE', `/sessions/${encodeURIComponent(scope)}`, undefined, { signal, retry: false })
    this.tabs.delete(scope)
    this.scopeLastUsed.delete(scope)
    return response
  }

  /**
   * Give back everything one session holds in the browser.
   *
   * @param {string} scope - engine `userId` for this session.
   * @returns {Promise<boolean>} whether the scope was known here at all.
   */
  async disposeScope(scope) {
    if (!this.tabs.has(scope) && !this.scopeLastUsed.has(scope)) return false
    try {
      await this.closeSession(scope)
      this.engine.log(`released browser scope ${scope}`)
    } catch (error) {
      // The local entries go either way: keeping them would leave a scope the
      // engine no longer serves in the registry forever, and it would be
      // counted as a live scope in every later status report.
      this.engine.log(`could not release browser scope ${scope}: ${describeError(error)}`)
      this.tabs.delete(scope)
      this.scopeLastUsed.delete(scope)
    }
    return true
  }

  /**
   * Close this scope's least recently used tabs until it fits the tab budget.
   *
   * The cap is per scope, never process-wide: one busy session must not close
   * another session's tabs. Process-wide relief is the engine's
   * `POST /pressure/cleanup`, which is globally scoped by design.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {AbortSignal} [signal] - cancellation.
   * @param {string} [keepTabId] - a tab that must never be chosen.
   * @returns {Promise<string[]>} the closed tab ids.
   */
  async evictToMaxTabs(scope, signal, keepTabId) {
    const tabs = this.tabs.get(scope)
    if (!tabs) return []
    const limit = Math.max(1, this.config.maxTabs - 1)
    const closed = []
    while (tabs.size > limit) {
      const oldest = [...tabs.values()]
        .filter((tab) => tab.tabId !== keepTabId)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
      if (!oldest) break
      this.engine.log(`evicting tab ${oldest.tabId} from ${scope} to stay within ${limit} tabs`)
      try {
        await this.closeTab(scope, oldest.tabId, signal)
      } catch {
        tabs.delete(oldest.tabId)
      }
      closed.push(oldest.tabId)
    }
    return closed
  }

  /**
   * Navigate an existing tab.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {{ url?: string, macro?: string, query?: string }} args - destination.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the navigation result.
   */
  async navigate(scope, tabId, args, signal) {
    const body = { userId: scope }
    if (args.macro) {
      // The engine expands a macro from its own `macro` field; passing the
      // macro as `url` fails URL validation before the macro is ever read.
      body.macro = args.macro
      body.query = args.query
    } else {
      body.url = args.url
    }
    const result = await this.call('POST', `/tabs/${encodeURIComponent(tabId)}/navigate`, body, { signal, retry: true })
    this.#touch(scope, tabId)
    return result
  }

  /**
   * Read the accessibility snapshot of a page.
   *
   * The plugin mints its own document token because the engine exposes none: it
   * drops its cached snapshot on navigation and then answers a resumed offset
   * with a fresh render of a different document and no error at all. A total
   * that changed under an offset is the only signal left that the caller's
   * coordinates no longer address what it thinks they do, and it is what
   * `staleDocument` reports.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {{ offset?: number, screenshot?: boolean }} args - snapshot options.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the snapshot payload with `documentId`, `staleDocument` and `knownTotalChars`.
   */
  async snapshot(scope, tabId, args, signal) {
    const result = await this.call('GET', `/tabs/${encodeURIComponent(tabId)}/snapshot`, undefined, {
      signal,
      query: {
        userId: scope,
        offset: args.offset,
        includeScreenshot: (args.screenshot ?? this.config.snapshotScreenshotByDefault) === true ? 'true' : 'false',
      },
    })
    this.#touch(scope, tabId)
    const engineId = typeof result?.documentId === 'string' ? result.documentId : null
    const offset = clampInt(args.offset, 0, 0)
    if (offset > 0) {
      const known = this.snapshotDocs.get(tabId)
      const staleDocument = known !== undefined && Number.isFinite(result?.totalChars) && result.totalChars !== known.totalChars
      return {
        ...result,
        documentId: engineId ?? known?.documentId ?? null,
        staleDocument,
        knownTotalChars: known?.totalChars ?? null,
      }
    }
    const documentId = engineId ?? `snap-${++this.documentSeq}`
    this.snapshotDocs.set(tabId, {
      documentId,
      totalChars: Number(result?.totalChars) || 0,
      url: typeof result?.url === 'string' ? result.url : '',
    })
    return { ...result, documentId, staleDocument: false, knownTotalChars: null }
  }

  /**
   * List the links of a page with real pagination.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {{ limit?: number, offset?: number }} args - pagination options.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the link payload.
   */
  async links(scope, tabId, args, signal) {
    return await this.call('GET', `/tabs/${encodeURIComponent(tabId)}/links`, undefined, {
      signal,
      query: {
        userId: scope,
        limit: clampInt(args.limit, 200, 1, 1000),
        offset: clampInt(args.offset, 0, 0),
      },
    })
  }

  /**
   * List images, optionally with inline data.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {{ includeData?: boolean, maxBytes?: number, limit?: number }} args - listing options.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the image payload.
   */
  async images(scope, tabId, args, signal) {
    return await this.call('GET', `/tabs/${encodeURIComponent(tabId)}/images`, undefined, {
      signal,
      query: {
        userId: scope,
        includeData: args.includeData === true ? 'true' : undefined,
        maxBytes: args.maxBytes,
        limit: clampInt(args.limit, 200, 1, 1000),
      },
    })
  }

  /**
   * Extract schema-guided structured data from the current page.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {any} schema - JSON Schema with `x-ref` hints.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the extraction result.
   */
  async extract(scope, tabId, schema, signal) {
    return await this.call('POST', `/tabs/${encodeURIComponent(tabId)}/extract`, { userId: scope, schema }, {
      signal,
      retry: false,
    })
  }

  /**
   * Click an element by ref, CSS selector or coordinates.
   *
   * No retry option: a click that timed out on the way back may already have
   * landed, and repeating it is a double submission.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {object} args - click arguments.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the click result.
   */
  async click(scope, tabId, args, signal) {
    const body = { userId: scope }
    if (args.ref) body.ref = args.ref
    if (args.selector) body.selector = args.selector
    if (args.doubleClick) body.doubleClick = true
    if (isRecord(args.coordinates)) body.coordinates = args.coordinates
    const result = await this.call('POST', `/tabs/${encodeURIComponent(tabId)}/click`, body, { signal })
    this.#touch(scope, tabId)
    return result
  }

  /**
   * Type text into an element.
   *
   * Never replayed: a retried submission can charge a card twice.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {object} args - typing arguments.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the typing result.
   */
  async type(scope, tabId, args, signal) {
    const body = { userId: scope, text: args.text }
    if (args.ref) body.ref = args.ref
    if (args.selector) body.selector = args.selector
    if (args.clear) body.clear = true
    if (args.pressEnter || args.submit) body.submit = true
    if (args.mode === 'keyboard') {
      body.mode = 'keyboard'
      body.delay = clampInt(args.delay, 20, 0, 2000)
    }
    const result = await this.call('POST', `/tabs/${encodeURIComponent(tabId)}/type`, body, { signal })
    this.#touch(scope, tabId)
    return result
  }

  /**
   * Choose an option in a native `<select>`.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {object} args - select arguments.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the select result.
   */
  async select(scope, tabId, args, signal) {
    const body = { userId: scope, option: args.option }
    if (args.ref) body.ref = args.ref
    if (args.selector) body.selector = args.selector
    const result = await this.call('POST', `/tabs/${encodeURIComponent(tabId)}/select`, body, { signal, retry: false })
    this.#touch(scope, tabId)
    return result
  }

  /**
   * Press a single key.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {string} key - key name.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the key-press result.
   */
  async press(scope, tabId, key, signal) {
    const result = await this.call('POST', `/tabs/${encodeURIComponent(tabId)}/press`, { userId: scope, key }, { signal })
    this.#touch(scope, tabId)
    return result
  }

  /**
   * Scroll the page.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {{ direction?: string, amount?: number }} args - scroll arguments.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the scroll result.
   */
  async scroll(scope, tabId, args, signal) {
    const body = { userId: scope, direction: args.direction ?? 'down', amount: clampInt(args.amount, 800, 1, 20000) }
    const result = await this.call('POST', `/tabs/${encodeURIComponent(tabId)}/scroll`, body, { signal })
    this.#touch(scope, tabId)
    return result
  }

  /**
   * Extract a schema from a page using CSS selectors rather than refs.
   *
   * The engine's own extractor is ref-driven, and a ref is derived from one
   * page's accessibility tree — so it cannot be used on pages nobody has seen
   * yet, which is exactly the bulk case. This evaluates the schema in the page
   * instead, so it works on any page.
   *
   * A property may carry `selector` (a CSS selector), `attr` (read that
   * attribute instead of the text), `all` (return every match as an array) and
   * `type` (`string`, `number`, `boolean`). The shorthands `:title` and `:url`
   * read the document title and the current URL.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {any} schema - JSON Schema with selector-aware properties.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{ data: Record<string, any>, missing: string[] }>} the extracted record.
   */
  async extractBySelector(scope, tabId, schema, signal) {
    const script = `(() => {
      const spec = ${JSON.stringify(schema)};
      const properties = (spec && spec.properties) || {};
      const read = (def) => {
        const selector = typeof def.selector === 'string' ? def.selector : null;
        if (selector === ':title') return { value: document.title };
        if (selector === ':url') return { value: location.href };
        if (!selector) return { value: null, missing: true };
        let nodes;
        try { nodes = [...document.querySelectorAll(selector)]; } catch (error) { return { value: null, error: String(error) }; }
        const take = (node) => {
          if (!node) return null;
          if (typeof def.attr === 'string') return node.getAttribute(def.attr);
          return (node.innerText ?? node.textContent ?? '').replace(/\\s+/g, ' ').trim() || null;
        };
        if (def.all === true) return { value: nodes.map(take) };
        return { value: take(nodes[0]) };
      };
      const out = {};
      const missing = [];
      for (const [key, raw] of Object.entries(properties)) {
        const def = raw || {};
        const result = read(def);
        let value = result.value;
        if (value != null && def.type === 'number') {
          const parsed = Number(String(value).replace(/[^0-9.,-]/g, '').replace(',', '.'));
          value = Number.isFinite(parsed) ? parsed : null;
        } else if (value != null && def.type === 'boolean') {
          value = value !== 'false' && value !== '0' && value !== '';
        }
        out[key] = value ?? null;
        if (result.missing) missing.push(key);
      }
      return { data: out, missing };
    })()`
    const payload = await this.evaluate(scope, tabId, script, signal)
    const value = unwrapEvaluate(payload)
    if (!isRecord(value) || !isRecord(value.data)) {
      throw new EngineError('the page did not return the requested fields', { code: 'extraction_failed' })
    }
    return { data: value.data, missing: Array.isArray(value.missing) ? value.missing : [] }
  }

  /**
   * Wait for the page to settle.
   *
   * The engine route only knows how to wait for load/network readiness and to
   * dismiss a consent wall; it has never supported a selector. Waiting for a
   * selector is therefore implemented natively below.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {{ timeoutMs?: number, waitForNetwork?: boolean, dismissConsent?: boolean }} args - wait options.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the wait result.
   */
  async waitForReady(scope, tabId, args, signal) {
    const body = { userId: scope }
    if (args.timeoutMs != null) body.timeout = clampInt(args.timeoutMs, 10000, 100, 120000)
    if (args.waitForNetwork === false) body.waitForNetwork = false
    if (args.dismissConsent) body.dismissConsent = true
    return await this.call('POST', `/tabs/${encodeURIComponent(tabId)}/wait`, body, { signal, retry: true })
  }

  /**
   * Wait until a CSS selector matches, implemented in this client.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {string} selector - CSS selector to await.
   * @param {{ timeoutMs?: number, visible?: boolean }} args - wait options.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{ ok: boolean, matched: boolean, waitedMs: number, selector: string }>} the outcome.
   */
  async waitForSelector(scope, tabId, selector, args, signal) {
    const timeoutMs = clampInt(args.timeoutMs, 15000, 100, 120000)
    const wantVisible = args.visible === true
    const startedAt = now()
    const expression = wantVisible
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; })()`
      : `!!document.querySelector(${JSON.stringify(selector)})`
    let matched = false
    while (now() - startedAt < timeoutMs) {
      if (signal?.aborted) throw new EngineError('the browser call was canceled', { code: 'canceled' })
      if (unwrapEvaluate(await this.evaluate(scope, tabId, expression, signal)) === true) {
        matched = true
        break
      }
      await sleep(250, signal)
    }
    return { ok: true, matched, selector, waitedMs: now() - startedAt }
  }

  /**
   * Wait until the page URL matches a pattern, implemented in this client.
   *
   * The engine's `/wait` route blocks on load state and consent banners
   * (`server.js:3780`); it has no URL condition. Single-page apps change the URL
   * without a load event, so waiting for readiness is not waiting for the route
   * you asked for.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {string} pattern - a regular expression source, tested against the full URL.
   * @param {{ timeoutMs?: number }} args - wait options.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{ ok: boolean, matched: boolean, url: string, waitedMs: number }>} the outcome.
   */
  async waitForUrl(scope, tabId, pattern, args, signal) {
    const timeoutMs = clampInt(args.timeoutMs, 15000, 100, 120000)
    const startedAt = now()
    // Compiled here rather than in the page: a pattern that failed to compile is
    // a caller mistake, and it should name itself instead of becoming a silent
    // poll that times out.
    let test
    try {
      test = new RegExp(pattern)
    } catch (error) {
      throw new EngineError(`"${pattern}" is not a valid regular expression: ${error.message}`, { code: 'bad_request' })
    }
    let url = ''
    while (now() - startedAt < timeoutMs) {
      if (signal?.aborted) throw new EngineError('the browser call was canceled', { code: 'canceled' })
      const stats = await this.stats(scope, tabId, signal)
      url = typeof stats?.url === 'string' ? stats.url : ''
      if (test.test(url)) return { ok: true, matched: true, url, waitedMs: now() - startedAt }
      await sleep(250, signal)
    }
    return { ok: true, matched: false, url, waitedMs: now() - startedAt }
  }

  /**
   * Execute JavaScript in the page.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {string} expression - JavaScript expression or statement body.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the engine result.
   */
  async evaluate(scope, tabId, expression, signal) {
    const result = await this.call('POST', `/tabs/${encodeURIComponent(tabId)}/evaluate`, { userId: scope, expression }, {
      signal,
      retry: true,
    })
    this.#touch(scope, tabId)
    return result
  }

  /**
   * Capture a PNG screenshot of the viewport.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {{ fullPage?: boolean }} [options] - capture options.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<Buffer>} the PNG bytes.
   */
  async screenshot(scope, tabId, options = {}, signal) {
    return await this.call('GET', `/tabs/${encodeURIComponent(tabId)}/screenshot`, undefined, {
      signal,
      // The engine string-compares against 'true' (server.js:5341), so sending
      // `1` or `yes` would silently yield a viewport capture.
      query: { userId: scope, ...(options.fullPage === true ? { fullPage: 'true' } : {}) },
      raw: true,
    })
  }

  /**
   * Resize the viewport, which forces a real layout reflow.
   *
   * Replayable: it sets a size rather than performing an action, and
   * `camofox_capture` resizes before every width/height screenshot, so a single
   * transient `503 engine_busy` here would otherwise fail a screenshot outright.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {{ width: number, height: number }} args - target size.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the resize result.
   */
  async viewport(scope, tabId, args, signal) {
    const body = {
      userId: scope,
      width: clampInt(args.width, 1280, 200, 7680),
      height: clampInt(args.height, 800, 200, 4320),
    }
    const result = await this.call('POST', `/tabs/${encodeURIComponent(tabId)}/viewport`, body, { signal, retry: true })
    this.#touch(scope, tabId)
    return result
  }

  /**
   * List the files the tab captured, optionally with their bytes.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {{ includeData?: boolean, consume?: boolean, maxBytes?: number }} args - listing options.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the download payload.
   */
  async downloads(scope, tabId, args, signal) {
    return await this.call('GET', `/tabs/${encodeURIComponent(tabId)}/downloads`, undefined, {
      signal,
      query: {
        userId: scope,
        includeData: args.includeData === true ? 'true' : undefined,
        consume: args.consume === true ? 'true' : undefined,
        maxBytes: args.maxBytes,
      },
    })
  }

  /**
   * Ask the engine to fetch the tab's current resource, which captures inline PDFs.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the capture result.
   */
  async captureCurrentResource(scope, tabId, signal) {
    return await this.call('POST', `/tabs/${encodeURIComponent(tabId)}/fetch-current-resource`, { userId: scope }, { signal, retry: true })
  }

  /**
   * Attach files to an upload control.
   *
   * The engine's contract is `path`, not `files`; the previous MCP adapter sent
   * the wrong field name, so this tool could only ever fail.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {{ paths: string[], ref?: string, selector?: string, timeoutMs?: number }} args - upload arguments.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the upload result.
   */
  async upload(scope, tabId, args, signal) {
    const body = {
      userId: scope,
      path: Array.isArray(args.paths) && args.paths.length > 1 ? args.paths : args.paths[0],
    }
    if (args.ref) body.ref = args.ref
    if (args.selector) body.selector = args.selector
    if (args.timeoutMs != null) body.timeout = clampInt(args.timeoutMs, 12000, 500, 120000)
    const result = await this.call('POST', `/tabs/${encodeURIComponent(tabId)}/upload`, body, { signal, retry: false })
    this.#touch(scope, tabId)
    return result
  }

  /**
   * Move through tab history.
   *
   * `action` is the one interpolated path segment in this file that is not
   * `encodeURIComponent`-wrapped, because it is not free text — it must be one
   * of three fixed routes. Validating it here rather than trusting the caller's
   * schema matters twice over: a JSDoc union is not a runtime check, and the
   * harness does NOT enforce a tool schema's `enum` at runtime, so `action` is
   * whatever text reached the tool. Without the guard, a value like
   * `../../<other-session>/cookies` normalises onto a real engine route outside
   * this tab and crosses the per-session boundary the scope exists to hold.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {'back' | 'forward' | 'refresh'} action - history action.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the navigation result.
   */
  async history(scope, tabId, action, signal) {
    if (!HISTORY_ACTIONS.has(action)) {
      throw new EngineError(
        `cannot ${String(action)}: a tab history action must be one of ${[...HISTORY_ACTIONS].join(', ')}`,
        { code: 'bad_history_action' },
      )
    }
    const result = await this.call('POST', `/tabs/${encodeURIComponent(tabId)}/${action}`, { userId: scope }, { signal })
    this.#touch(scope, tabId)
    return result
  }

  /**
   * Read the tab's own bookkeeping counters.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} tabId - target tab.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the stats payload.
   */
  async stats(scope, tabId, signal) {
    return await this.call('GET', `/tabs/${encodeURIComponent(tabId)}/stats`, undefined, { signal, query: { userId: scope } })
  }

  /**
   * Fetch a YouTube transcript through the engine's youtube plugin.
   *
   * @param {{ url: string, language?: string }} args - transcript request.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the transcript payload.
   */
  async youtubeTranscript(args, signal) {
    return await this.call('POST', '/youtube/transcript', { url: args.url, languages: [args.language || 'en'] }, {
      signal,
      timeoutMs: Math.max(this.config.requestTimeoutMs, 180000),
      retry: true,
    })
  }

  /**
   * List Playwright trace archives captured for this scope.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the trace listing.
   */
  async traces(scope, signal) {
    return await this.call('GET', `/sessions/${encodeURIComponent(scope)}/traces`, undefined, { signal })
  }

  /**
   * Download one trace archive.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} filename - trace archive name.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<Buffer>} the zip bytes.
   */
  async traceFile(scope, filename, signal) {
    return await this.call('GET', `/sessions/${encodeURIComponent(scope)}/traces/${encodeURIComponent(filename)}`, undefined, {
      signal,
      raw: true,
    })
  }

  /**
   * Read the console and network errors the capture plugin collected.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {{ minSeverity?: string }} [options] - severity filter.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the captured entries.
   */
  async consoleEntries(scope, options = {}, signal) {
    return await this.call('GET', `/dsh-console/${encodeURIComponent(scope)}`, undefined, {
      signal,
      // The engine string-compares `minSeverity` against its own severity order.
      query: { minSeverity: options.minSeverity },
      // Safe to repeat: it only reads what the capture plugin already holds.
      retry: true,
    })
  }

  /**
   * Import cookies into this session's browser context.
   *
   * The engine gates this route with `CAMOFOX_API_KEY` when one is configured
   * (`server.js:415-421`) and otherwise accepts any loopback request outside
   * production (`server.js:422-431`). This plugin runs the engine on loopback
   * with no API key, so the access key already held is sufficient — verified
   * against a live engine, which answered `{ ok: true, count }` and had the
   * cookie readable from `document.cookie` immediately afterwards.
   *
   * There is no export route on the engine: `GET /sessions/{userId}/cookies`
   * and `GET /sessions/{userId}/storage_state` both answer 404. Reading cookies
   * back out therefore means reading them from the page, which is a page-world
   * operation and sees only what the page itself can see.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {any[]} cookies - cookies in Playwright's shape.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the import result.
   */
  async importCookies(scope, cookies, signal) {
    return await this.call('POST', `/sessions/${encodeURIComponent(scope)}/cookies`, { cookies }, {
      signal,
      // Deliberately not retried: the engine caps a request at 500 cookies and
      // a repeated import is not obviously idempotent once the context has
      // navigated since.
      retry: false,
    })
  }

  /**
   * Ask the engine to delete one trace archive.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {string} filename - trace archive name.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the deletion result.
   */
  async deleteTrace(scope, filename, signal) {
    return await this.call('DELETE', `/sessions/${encodeURIComponent(scope)}/traces/${encodeURIComponent(filename)}`, undefined, {
      signal,
      retry: false,
    })
  }

  /**
   * Ask the engine to release memory held by idle tabs.
   *
   * The endpoint is unconditionally global: there is no userId filter on it, so
   * it can relieve any session in the process. Its report carries hashed tab ids
   * only, so the registry cannot be trimmed from the response; reconciling
   * against the engine's own listing is the only honest repair. Clearing the
   * registry wholesale — what this did before — UNTRACKED live tabs, because the
   * request deliberately keeps one per session.
   *
   * @param {string} scope - engine `userId` for this session.
   * @param {{ dryRun?: boolean, maxTabsToClose?: number }} args - cleanup options.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<any>} the cleanup report.
   */
  async pressureCleanup(scope, args, signal) {
    const body = {
      dryRun: args.dryRun !== false,
      minIdleMs: 60000,
      maxTabsToClose: clampInt(args.maxTabsToClose, 4, 0, 50),
      minTabsPerSession: 1,
      closeEmptySessions: false,
    }
    const report = await this.call('POST', '/pressure/cleanup', body, { signal, retry: true })
    if (args.dryRun === false) {
      try {
        await this.listTabs(scope, signal)
      } catch {
        /* the engine is unreachable; the next listing reconciles instead */
      }
    }
    return report
  }
}
