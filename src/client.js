/**
 * dsh-camofox — the browser half.
 *
 * This file is served verbatim by the Host at
 * `/plugins/dsh-camofox/client.js` and executed as a CLASSIC script
 * (the Host concatenates the bytes it read from `exports["./client"]`:
 * dsh-client-modules/lib/index.js:330-334 `buildComboScript`, :973-978
 * `serveBundle`). There is no bundler and no transpile step in front of it,
 * so the whole body must be valid plain script and the only way to get a module
 * into the page is the registration below.
 *
 * What it registers: one keyed entry in the Tool-owned view slot, under the
 * wire tool name `camofox_capture`. The Tool layer dispatches that slot by
 * name (dsh-client-ui-tool/lib/client.js:1863-1869), and the renderer picks
 * exactly one entry for the key (dsh-client-ui-renderer/lib/client.js:1153-1156).
 *
 * SCOPE OF THIS FILE — it is presentation only.
 *   - It never registers a tool, never calls an RPC that mutates a session,
 *     and never touches a tool result.
 *   - Everything the model receives is produced Host-side and committed
 *     before this code can see it (dsh-tools/lib/index.js:3359-3369, then
 *     dsh-llm-deepseek/lib/index.js:1577-1608). A browser realm cannot reach
 *     that path.
 *
 * A card that throws while rendering is not a degraded card. The renderer
 * abdicates that slot key permanently, so every later `camofox_capture` row
 * would render as an empty box with no fallback. Every render path here is
 * therefore total: the parts that can throw are contained, and a value that
 * arrives in an unexpected shape is described rather than allowed to fail.
 *
 * @module dsh-camofox/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-camofox',
  factory: (require) => {
    // Both specifiers are platform seed words — the shell hands them to every
    // client bundle through `options.staticModules`
    // (dsh-web-frontend/dist/assets/index-5SrrfWpU.js, `rM()`:
    //   react, react/jsx-runtime, react-dom, react-dom/client,
    //   @deepseek-ai/cordis, @deepseek-ai/dsh-client-store,
    //   @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives,
    //   @deepseek-ai/dsh-client-ui-dockkit)
    // so they resolve from the static table, not from node_modules
    // (dsh-client-modules/lib/client.js:700-705).
    const React = require('react')
    const { ImageLightbox } = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect

    /** The wire tool name this card claims. */
    const TOOL = 'camofox_capture'

    /** Locale namespace owned by this plugin. */
    const LOCALE_NS = 'dsh-camofox'

    /**
     * Every user-facing string this card renders.
     *
     * Client UI copy is locale-owned: the harness gate `verify-client-ui-i18n`
     * rejects a hardcoded string in a client half. They are dictionaries rather
     * than literals so the card follows the shell's language chain, and `ro` is
     * here because a Romanian profile would otherwise fall back to English.
     */
    const en = {
      'card.screenshot': 'Screenshot',
      'card.enlarge': 'Enlarge',
      'card.enlargeLabel': 'Enlarge {name}',
      'card.close': 'Close',
      'card.loading': 'Loading screenshot…',
      'card.unreadable': '[unreadable result]',
      'card.unreadableKeys': '[unreadable result: {keys}]',
    }
    const ro = {
      'card.screenshot': 'Captură de ecran',
      'card.enlarge': 'Mărește',
      'card.enlargeLabel': 'Mărește {name}',
      'card.close': 'Închide',
      'card.loading': 'Se încarcă captura de ecran…',
      'card.unreadable': '[rezultat ilizibil]',
      'card.unreadableKeys': '[rezultat ilizibil: {keys}]',
    }

    /**
     * The first durable image reference in a settled result, or null.
     *
     * A block only carries `content` once its call has produced a result
     * (dsh-client-ui-tool/lib/client.js:1804-1816 `toolCallPhase`), so a
     * running or preparing call yields null and the card degrades to its text.
     *
     * @param {unknown} block - running or settled Tool block.
     * @returns {object|null} the attachment reference, or null.
     */
    function firstAttachment(block) {
      if (block === null || typeof block !== 'object') return null
      if (!('kind' in block) || block.isError === true) return null
      if (!Array.isArray(block.content)) return null
      for (const part of block.content) {
        if (part === null || typeof part !== 'object') continue
        if (part.type !== 'image') continue
        const attachment = part.attachment
        if (attachment === null || typeof attachment !== 'object') continue
        // The id is opaque and provider-owned; presence is the only honest check.
        if (typeof attachment.attachmentId !== 'string' || attachment.attachmentId === '') continue
        return attachment
      }
      return null
    }

    /**
     * The result's display text, in the generic card's own format.
     *
     * Mirrors `resultText` in dsh-client-ui-tool/lib/client.js:179-185 — text
     * blocks verbatim, any other block shape as pretty JSON — so what the human
     * reads here is what they read today. The one deliberate difference: an
     * image block is rendered as an image by this card instead of as its JSON,
     * because that is the entire point of this card. A result that carries only
     * an image block therefore shows the image and no JSON blob.
     *
     * @param {unknown} block - settled Tool result.
     * @returns {string} the flattened text, possibly empty.
     */
    function bodyText(block, t) {
      if (block === null || typeof block !== 'object') return ''
      if (!('kind' in block)) return ''
      const content = Array.isArray(block.content) ? block.content : []
      const parts = []
      for (const part of content) {
        if (part === null || typeof part !== 'object') continue
        if (part.type === 'text') parts.push(part.text)
        else if (part.type === 'image') continue
        else parts.push(stringifyPart(part, t))
      }
      if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
      return parts.join('\n')
    }

    /**
     * Render one non-text, non-image content part as readable text.
     *
     * `JSON.stringify` throws on a circular structure and on a BigInt, and a card
     * that throws while rendering is not a degraded card: the renderer abdicates
     * that slot key permanently, so every later `camofox_capture` row renders as an
     * empty box with no fallback. A part that cannot be serialized is therefore
     * described rather than formatted, and never allowed to fail the render.
     *
     * @param {object} part - the content part.
     * @param {(key: string, vars?: Record<string, any>) => string} t - the translator.
     * @returns {string} its JSON when serializable, a short description when not.
     */
    function stringifyPart(part, t) {
      try {
        return JSON.stringify(part, null, 2)
      } catch {
        const keys = Object.keys(part)
        return keys.length === 0
          ? t('card.unreadable')
          : t('card.unreadableKeys', { keys: keys.slice(0, 8).join(', ') + (keys.length > 8 ? ', …' : '') })
      }
    }

    /**
     * First line of a string.
     *
     * @param {unknown} text - text to shorten.
     * @returns {string} its first line.
     */
    function firstLine(text) {
      if (typeof text !== 'string') return ''
      const at = text.indexOf('\n')
      return at === -1 ? text : text.slice(0, at)
    }

    /**
     * The row's one-line summary, derived from the call arguments.
     *
     * Mirrors `deriveSummary` for an unrecognised tool
     * (dsh-client-ui-tool/lib/client.js:221-233): with no variant-specific
     * keys for `camofox_capture`, the generic card falls through to the first
     * string-valued argument and then to the first line of the raw arguments.
     *
     * @param {unknown} block - running or settled Tool block.
     * @returns {string} the summary, possibly empty.
     */
    function summaryOf(block) {
      if (block === null || typeof block !== 'object') return ''
      const raw = 'kind' in block ? (block.call?.argsRaw ?? '') : block.phase === 'start' ? block.argsRaw : null
      if (raw === null) return ''
      if (raw === '') return block.callId
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return firstLine(raw)
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return firstLine(raw)
      for (const value of Object.values(parsed)) {
        if (typeof value === 'string' && value !== '') return firstLine(value)
      }
      return firstLine(raw)
    }

    /**
     * The `camofox_capture` row.
     *
     * A keyed toolview REPLACES the generic row outright — the fallback only
     * renders when no entry holds the key
     * (dsh-client-ui-renderer/lib/client.js:1153-1156). So this component is
     * responsible for every case: a PDF capture, a failed capture, a capture
     * that produced no bytes, and a still-running call all fall through to the
     * same text rendering the generic card would have produced.
     *
     * @param {object} props - Tool view owner props.
     * @returns {object} React element.
     */
    function CaptureRow(props) {
      const { block, loadImage } = props
      // The renderer supplies `t` from the `locale` namespace this registration
      // declares (slots.md:74). The identity fallback keeps the card renderable if
      // a future renderer stops supplying it, rather than printing raw keys.
      const t = typeof props.t === 'function'
        ? props.t
        : (key, vars) => (vars === undefined ? String(key) : `${String(key)} ${JSON.stringify(vars)}`)
      const attachment = firstAttachment(block)
      const attachmentId = attachment === null ? null : attachment.attachmentId
      const [url, setUrl] = useState(null)
      const [failed, setFailed] = useState(false)
      const [open, setOpen] = useState(false)

      useEffect(() => {
        if (attachment === null || typeof loadImage !== 'function') return undefined
        let live = true
        setUrl(null)
        setFailed(false)
        // `peek` is best effort: it only answers once some other view has
        // already read this attachment, so first paint usually waits on the
        // promise below.
        try {
          const peeked = typeof loadImage.peek === 'function' ? loadImage.peek(attachment) : undefined
          if (typeof peeked === 'string' && peeked !== '') setUrl(peeked)
        } catch {
          // A peek failure is never fatal; the promise below still runs.
        }
        // loadImage resolves a session-authorised browser URL for the durable
        // attachment (dsh-client-ui-chat/lib/client.js:12443 ->
        // dsh-client-ui-conversation/lib/client.js:2750-2764).
        //
        // Two failure modes are contained here, and both used to strand the card:
        // a synchronous throw from `loadImage` escaped the effect entirely, and a
        // value that resolved to something other than a non-empty string left
        // "Loading screenshot…" on screen with nothing ever replacing it. Any
        // settle that is not a usable URL is now a failure, which the card already
        // knows how to render.
        let pending
        try {
          pending = Promise.resolve(loadImage(attachment))
        } catch {
          if (live) setFailed(true)
          return () => {
            live = false
          }
        }
        pending.then(
          (resolved) => {
            if (!live) return
            if (typeof resolved === 'string' && resolved !== '') setUrl(resolved)
            else setFailed(true)
          },
          () => {
            if (live) setFailed(true)
          },
        )
        return () => {
          live = false
        }
        // attachmentId, not `attachment`: the block is frozen, so the object
        // identity is stable too, but the id is the honest cache key.
      }, [attachmentId, loadImage])

      const header = [TOOL, summaryOf(block)].filter((part) => part !== '').join(' · ')
      const text = bodyText(block, t)
      const label = (attachment !== null && typeof attachment.name === 'string' && attachment.name !== ''
        ? attachment.name
        : t('card.screenshot'))

      const children = []
      if (text !== '') {
        children.push(h('div', { key: 'text', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, text))
      }
      if (attachment !== null) {
        if (url !== null) {
          children.push(
            h(
              'button',
              {
                key: 'image',
                type: 'button',
                onClick: () => setOpen(true),
                title: t('card.enlarge'),
                'aria-label': t('card.enlargeLabel', { name: label }),
                style: {
                  display: 'block',
                  marginTop: text === '' ? 0 : 8,
                  padding: 0,
                  border: 0,
                  background: 'none',
                  cursor: 'zoom-in',
                  maxWidth: '100%',
                  lineHeight: 0,
                },
              },
              h('img', {
                src: url,
                alt: label,
                style: { maxWidth: '100%', height: 'auto', borderRadius: 6, display: 'block' },
              }),
            ),
          )
        } else if (!failed) {
          children.push(
            h('div', { key: 'loading', style: { opacity: 0.6, marginTop: text === '' ? 0 : 8 } }, t('card.loading')),
          )
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
        h('div', { style: { fontWeight: 500 } }, header),
        ...children,
        open && url !== null
          ? h(ImageLightbox, {
              src: url,
              alt: label,
              // ImageLightbox reads exactly these two keys
              // (dsh-client-ui-primitives/lib/index.js:11103 `labels.dialog`
              // and :11119 `labels.close`); omitting `labels` entirely throws,
              // so it is always supplied complete.
              labels: { dialog: label, close: t('card.close') },
              onClose: () => setOpen(false),
            })
          : null,
      )
    }

    /**
     * Register the dictionaries and hand the renderer a `t` for them.
     *
     * The renderer builds the localized `t` a registration gets from its
     * `locale` namespace, so the dictionaries and the namespace declaration below
     * are two halves of one thing: without either, every string in this card is a
     * hardcoded literal and `verify-client-ui-i18n` rejects the package.
     *
     * @param {any} ctx - the client context.
     * @returns {(key: string, vars?: Record<string, any>) => string} the translator.
     */
    function registerDictionaries(ctx) {
      let locale
      try {
        locale = ctx.get('locale')
      } catch {
        locale = undefined
      }
      if (locale === undefined || locale === null) {
        return (key) => String(key)
      }
      const dispose = () => {
        // A duplicate apply under HMR leaves the first registration in place, and
        // replacing it is the caller's business, not this card's.
        for (const undo of disposers.splice(0)) {
          try {
            undo()
          } catch {
            /* already gone */
          }
        }
      }
      const disposers = []
      const register = () => {
        for (const undo of [
          locale.register(LOCALE_NS, 'en', en),
          locale.register(LOCALE_NS, 'ro', ro),
        ]) {
          if (typeof undo === 'function') disposers.push(undo)
        }
      }
      if (typeof ctx.effect === 'function') ctx.effect(() => {
        register()
        return dispose
      }, `${LOCALE_NS}: dictionaries`)
      else {
        try {
          register()
        } catch {
          /* a duplicate apply keeps the existing dictionaries */
        }
      }
      try {
        const bound = typeof locale.bind === 'function' ? locale.bind(LOCALE_NS) : undefined
        return typeof bound === 'function' ? bound : (key) => String(key)
      } catch {
        return (key) => String(key)
      }
    }

    /** The keyed `tool.call.toolview` registration for this tool. */
    const captureToolview = {
      name: 'camofox-capture-toolview',
      inject: ['slots'],
      apply(ctx) {
        // No `children` table: `tool.call.images` is declared by the read_image
        // registrant, and declaring it a second time throws at load
        // (dsh-client-ui-slots/lib/index.js:191-194). This card renders its own
        // <img> and opens the shared lightbox directly.
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register(
            {
              name: 'tool.call.toolview',
              key: TOOL,
              // The namespace the renderer builds this entry's `t` from.
              locale: LOCALE_NS,
            },
            CaptureRow,
          ),
        )
      },
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        registerDictionaries(ctx)
        ctx.plugin(captureToolview)
      },
    }
  },
})
