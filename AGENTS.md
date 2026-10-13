# AGENTS.md

Working rules for any AI or human changing this package. DSH's own root
`AGENTS.md` conventions apply on top of this file wherever they are stricter.

## Version every release

**Bump `version` in [package.json](package.json) as part of the change, not after it.** A
release is the commit that carries the new number, so a commit that changes behaviour and
leaves the version alone is an unfinished commit.

- Patch — `1.1.1` → `1.1.2` → `1.1.3`. The ordinary case: a fix, a doc correction, a
  test, a comment. Most changes are this.
- Minor — `1.1.3` → `1.2.0`. A new tool, a new config field with a shipped default, an
  added file under `files`, anything a user can now do that they could not before.
- Major — `1.2.0` → `2.0.0`. A removed or renamed tool, a changed default a user depends
  on, a changed `exports` or row contract. Ask before choosing this one.

Never reuse a number. npm and GitHub both treat a published version as permanent, so a
republished `1.1.1` silently gives people the first one instead of the fix.

### Releasing

```bash
npm test                       # the full suite; CI runs this too
node scripts/check-patch.mjs   # the patch row and what ships must agree
node scripts/pack-check.mjs    # what npm would actually publish
git commit -am "..."           # with the bumped version already in it
git tag -a v<version> -m "<version>: <what changed>"
git push origin main --follow-tags
gh release create v<version> --generate-notes
```

The tag is `v<version>` and must match `package.json` exactly. A tag that disagrees with
the manifest is how a release ends up pointing at the wrong build.

Two places carry the number and both must move together:

- `package.json` → `version`
- the `1.0.0` in the README's "Other routes" table (lines with `dsh-camofox@1.0.0` and
  `dsh-camofox-1.0.0.tgz`) — a pinned example that goes stale reads as a current command

CI no longer hardcodes the tarball name; it resolves `dsh-camofox-*.tgz`, so a version
bump does not need a workflow edit. `pack-check.mjs` prints the version it read, so it
doubles as the confirmation that you bumped it.

## Before pushing

Match the evidence to the change. Full `npm test` is cheap here (no browser needed) and
is what CI runs, so run it rather than a subset.

| Area | Check |
|---|---|
| Engine supervisor, credentials, lifecycle | `node scripts/unit.mjs` |
| Tool surface, paging, addons, errors, console | the matching `scripts/<name>.mjs` |
| Deadlocks, body deadlines, socket leaks | `npm run test:regression` |
| What npm ships, exports, icon | `node scripts/pack-check.mjs` |
| The one-row patch contract | `node scripts/check-patch.mjs` |

A failure is a finding, not an obstacle: report it, never work around it.

## The one row

`cordis.patch.yml` contributes exactly **one** Loader row, `camofox-runtime`. This package
declares `dsh.client`, and `@deepseek-ai/dsh-client-modules` reconciles client sources **by
package name** across the Host Loader's live rows. One package resolving from two rows
throws there, is rethrown as a `ClientPackageCompositionError`, and leaves the web shell
with no `window.__ModuleLoader__` at all — a whole-GUI-down failure, not a degraded one.

`src/entry-tools.js` and `src/entry-prompt.js` still ship as subpath exports. They are
mount points for a deployment that composes the bundle itself; they are not extra rows to
add to `cordis.patch.yml`. `scripts/check-patch.mjs` asserts the row count, so a second row
fails a check instead of the GUI.

## The engine is a separate product

This package drives `camofox-browser`; it does not contain it. See the Credits section of
[README.md](README.md) and [NOTICE](NOTICE) — the Camoufox browser is Jo, Inc's MIT work,
is not redistributed here, and its licence and attribution travel with the package.

- The engine comes from `@askjo/camofox-browser`, which ships a root `server.js`. The
  unscoped `camofox-browser` on npm is a **different publisher's package** and has no root
  `server.js`; bootstrapping from it would fail in a way that looks like a broken install.
- `repoPath` defaults to `${DSH_HOME}/camofox/repo` and the plugin installs the engine
  there on first run. Nothing is downloaded when an engine is already present.
- `nodePath` empty means "whatever runs the harness", which is the Electron binary; the
  plugin passes `ELECTRON_RUN_AS_NODE`, which is usually right. Set it to a plain `node`
  only when the engine genuinely will not start.

Do not add an engine path to `cordis.patch.yml`. It holds only values that differ from the
shipped defaults, precisely so a published install works on a machine that shares nothing
with the author's.

## Change rules

- Registrations are effects: `ctx.effect()` / `ctx.on()`. A `register()` returns its
  disposer.
- No hardcoded tunables in the plugin. A deployment-varying choice is a validated `Config`
  field changeable from `cordis.patch.yml`; a `DEFAULT_*` constant is not configurability.
  Protocol constants and security invariants stay fixed.
- Misconfiguration fails loud at load, or at the earliest resolvable point. Never skip a
  missing referent silently.
- Docs accompany code: update the affected README section and the JSDoc in the same change.
- Files end with exactly one trailing newline.
- Comments state a contract or a reason the code cannot show. No control-flow narration, no
  metaphors, no restating the next line. Prefer the exact term over `shape`/`boundary` when
  one names the subject precisely.

## Bugs to expect

- **Two engine pids.** An engine that outlived its supervisor keeps the port while
  `engine.json` names a dead one, so the reaper finds nothing and the engine is adopted
  rather than reaped. Adoption has to re-offer the generated access key, or every call
  401s for the length of the cooldown.
- **`/health` is exempt from the engine's access-key gate.** Every other route is gated.
  The stamp is `engine: 'camoufox'` — with the `u`, not `camofox`.
- **Concurrency is 3.** `maxConcurrentPerUser` caps simultaneous calls, and the 401 retry
  re-enters the transport while holding a slot. Three slow calls wedge every other tool.
- **`scripts/` is a harness, not a copy.** It imports `../src/`. A fix written only in
  `scripts/` ships nothing; the tests there exercise the real modules.