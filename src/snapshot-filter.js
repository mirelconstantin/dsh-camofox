/**
 * Client-side snapshot filtering.
 *
 * The engine has no filter parameter — its snapshot route accepts only
 * `userId`, `offset` and `includeScreenshot` (`server.js:3594-3599`) — so both
 * reductions below run on the text it already returned.
 *
 * The engine renders one line per node, with children indented two spaces, and
 * marks the refs `camofox_act` needs in brackets:
 *
 * ```
 * - heading "Main heading" [level=1]
 * - paragraph: Static prose that adds nothing.
 * - link "First link" [e1]:
 *   - /url: https://example.com/one
 * - checkbox [e4]
 * - combobox [e5]:
 *   - option "One" [selected]
 * ```
 *
 * Keeping a ref line's SUBTREE is what distinguishes this from dropping
 * children: `- combobox [e5]` without its `- option "One"` line is not a
 * usable combobox.
 *
 * @module dsh-camofox/snapshot-filter
 */

/**
 * The roles a model can act on, and therefore the only ones worth its tokens.
 *
 * Structural roles (`heading`, `listitem`, `generic`) carry no action, while
 * `option` and `img` describe the control they belong to and are kept as that
 * control's children rather than as lines in their own right.
 */
export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'slider',
  'spinbutton', 'switch', 'treeitem', 'option', 'img',
])

/**
 * A parsed snapshot line.
 *
 * The pattern also matches a continuation line such as `  - /url: …`, which
 * parses with the pseudo-role `/url`. That is harmless for filtering — such a
 * line is never an interactive role and never carries a ref — but it is why
 * `total` counts parsed lines rather than accessibility nodes: it is the
 * denominator of what the engine returned, which is what a caller comparing
 * "showing N of M" is asking about.
 */
const ITEM_RE = /^(\s*)-\s+([a-zA-Z][\w/-]*)\s*(.*)$/

/**
 * Parse the first bracketed token of a node's tail when it is a ref.
 *
 * The engine writes refs as `[e1]` and attributes as `[level=1]` or
 * `[selected]`; only the `e<n>` form is a ref.
 *
 * @param {string} tail - everything after the role on the node's line.
 * @returns {{ ref: string, end: number }|null} the ref and where its bracket ends, or null.
 */
function refIn(tail) {
  const match = tail.match(/\[(e\d+)\]/)
  return match ? { ref: match[1], end: match.index + match[0].length } : null
}

/**
 * Keep only the lines a model can act on, with each kept line's subtree.
 *
 * @param {string} snapshot - the engine's snapshot text.
 * @returns {{ text: string, kept: number, total: number }} the reduction and what it cost.
 */
export function filterInteractive(snapshot) {
  const lines = String(snapshot ?? '').split('\n')
  // Indentation of each line, or null for a line that is neither a node nor a
  // continuation. Computed once so the subtree walk is a comparison rather than
  // a repeated regex.
  const info = lines.map((line) => {
    const match = line.match(ITEM_RE)
    return match ? { indent: match[1].length, role: match[2], tail: match[3] } : null
  })
  const total = info.filter(Boolean).length

  const keptLines = []
  let kept = 0
  // Set while a copied subtree is being emitted, so its nodes are not emitted
  // a second time when the outer loop reaches them.
  let skipUntilIndent = -1

  for (let i = 0; i < lines.length; i += 1) {
    const node = info[i]
    const indent = node ? node.indent : (lines[i].match(/^(\s*)\S/) ?? [])[1]?.length ?? 0

    // Inside a subtree already copied: only a line that ends it is interesting.
    if (skipUntilIndent >= 0) {
      if (indent > skipUntilIndent) continue
      skipUntilIndent = -1
    }
    if (!node) continue

    if (!INTERACTIVE_ROLES.has(node.role) && !refIn(node.tail)) continue

    keptLines.push(lines[i])
    if (INTERACTIVE_ROLES.has(node.role)) kept += 1

    // Copy the node's own subtree: every following line indented deeper,
    // INCLUDING continuation lines like `- /url:` that are not nodes. That is
    // what keeps `- combobox [e5]` usable, since its `- option` line hangs off
    // it, and what keeps a link's URL attached to the link.
    let subtreeEnd = i
    for (let j = i + 1; j < lines.length; j += 1) {
      const childIndent = info[j]
        ? info[j].indent
        : (lines[j].match(/^(\s*)\S/) ?? [])[1]?.length ?? 0
      const blank = lines[j].trim() === ''
      if (!blank && childIndent <= node.indent) break
      if (blank && j + 1 >= lines.length) break
      keptLines.push(lines[j])
      if (info[j] && INTERACTIVE_ROLES.has(info[j].role)) kept += 1
      subtreeEnd = j
    }
    i = subtreeEnd
    skipUntilIndent = node.indent
  }

  return { text: keptLines.join('\n'), kept, total }
}

/**
 * Keep only the subtree under the first node matching a selector's text.
 *
 * The engine exposes no way to scope a snapshot server-side, so the scope is
 * found here by matching the rendered role and name. The selector is the same
 * CSS a caller would pass to `camofox_act`, and only the part that names a node
 * is used: `main`, `[role=region]`, `nav`, or a role name fragment.
 *
 * @param {string} snapshot - the engine's snapshot text.
 * @param {string} scopeText - what identifies the root, lower-cased.
 * @returns {string|null} the scoped subtree, or null when nothing matched.
 */
export function scopeSnapshot(snapshot, scopeText) {
  const needle = String(scopeText ?? '').trim().toLowerCase()
  if (!needle) return String(snapshot ?? '')
  const lines = String(snapshot ?? '').split('\n')
  const info = lines.map((line) => {
    const match = line.match(ITEM_RE)
    return match ? { indent: match[1].length, role: match[2], tail: match[3] } : null
  })

  for (let i = 0; i < lines.length; i += 1) {
    const node = info[i]
    if (!node) continue
    // The scope matches a node by its role or its accessible name, which is the
    // quoted run right after the role.
    const name = (node.tail.match(/^"([^"]*)"/) ?? [])[1] ?? ''
    const haystack = `${node.role} ${name}`.toLowerCase()
    if (!haystack.includes(needle)) continue

    const kept = [lines[i]]
    for (let j = i + 1; j < lines.length; j += 1) {
      const childIndent = info[j]
        ? info[j].indent
        : (lines[j].match(/^(\s*)\S/) ?? [])[1]?.length ?? 0
      const blank = lines[j].trim() === ''
      if (!blank && childIndent <= node.indent) break
      if (blank) break
      kept.push(lines[j])
    }
    return kept.join('\n')
  }
  return null
}