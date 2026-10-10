<p align="center">
  <img src="https://raw.githubusercontent.com/pazalo/.github/main/assets/pazalo-logo.png" width="112" alt="Pazalo">
</p>

<h1 align="center">dsh-camofox</h1>

<p align="center">
  Camoufox as a first-class DeepSeek Harness capability: a supervised browser engine, sixteen
  native tools, a system-prompt section so every model knows the browser is there and when to
  use it, and a screenshot card the human sees inline.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D22.19-FFC24D?style=flat-square&logo=node&logoColor=black" alt="Node">
  <img src="https://img.shields.io/badge/Tools-16-FFC24D?style=flat-square" alt="Tools">
  <img src="https://img.shields.io/badge/Licence-MIT-F0522C?style=flat-square" alt="Licence">
  <img src="https://img.shields.io/badge/Camofox-MIT-F0522C?style=flat-square" alt="Camofox">
</p>

## Credits — the browser this drives

Camoufox — <https://github.com/jo-inc/camofox-browser> — Copyright (c) 2025 Jo, Inc, MIT.

Camofox is the stealth browser this plugin is built around: it supplies the engine, the
fingerprinting surface and the anti-bot evasion that every tool here configures. **This package
does not redistribute it, and does not download it for you** — it starts and drives a checkout of
the published [`camofox-browser`](https://github.com/jo-inc/camofox-browser) project, which you
install yourself in the step below. [NOTICE](NOTICE) carries that attribution. See
[LICENSE](LICENSE).

## Install

**1. Get Camofox.** It is a separate project with its own dependencies, and a bare clone is not
enough — its `postinstall` also fetches the browser binary:

```bash
git clone https://github.com/jo-inc/camofox-browser
cd camofox-browser
npm install
```

**2. Install this plugin** into a profile. The GUI's **Add plugin** box does this for you; from a
terminal the profile name is required:

```bash
dsh plugin add dsh-camofox --profile desktop
```

**3. Point it at the checkout.** The default is `${DSH_HOME}/camofox/repo`, a directory the
plugin does not create. Either clone there, or set `repoPath` on the `camofox-runtime` row in a
profile-level patch:

```yaml
- insert:
    - id: camofox-runtime
      name: './src/index.js'
      config:
        repoPath: '/absolute/path/to/camofox-browser'
```

Until this is set the first error is `camofox engine entry point not found: …/server.js`, which
is this step and nothing else.

<details>
<summary>Other routes</summary>

| Route | Command |
| --- | --- |
| Pinned to a version | `dsh plugin add dsh-camofox@1.0.0 --profile desktop` |
| Pinned to a commit | `dsh plugin add github:mirelconstantin/dsh-camofox#<sha> --profile desktop` |
| Tarball | `dsh plugin add ./dsh-camofox-1.0.0.tgz --profile desktop` |
| Local checkout | `dsh plugin add /absolute/path/to/dsh-camofox --profile desktop` |

</details>

## What it replaces

It replaces the earlier `mcp__camofox__*` stdio bridge, which advertised 26
tools, of which four could not work at all, and which left its browser engine
running after the harness exited.

If a tool call still answers *MCP resource server "camofox" is unavailable in this agent's
scope*, that is a call to the bridge this package removed, not an error here: no MCP server named
`camofox` exists. Use the native `camofox_*` tools.

## What you get

| Tool | Use it for |
|---|---|
| `camofox_open` | Open a page (or a search macro) and get a tab id, with an optional wait-for-selector so late-rendered pages are ready. Reports `navigationOk` and `httpStatus`. Pass `trace:true` to record a Playwright trace of everything the browser does |
| `camofox_read` | Read a page: `snapshot` (accessibility refs), `text`, `markdown`, `links`, `images`, `html`, `stats`. A snapshot can be narrowed with `interactive:true` (actionable nodes only) or `scope` (one subtree) |
| `camofox_act` | click · type · select · press · scroll · wait · waitForSelector · **waitForUrl** · upload · viewport · back/forward/refresh |
| `camofox_capture` | Screenshot attached to the conversation, or a PDF, written to `savePath`. `fullPage:true` captures the whole scrollable page |
| `camofox_eval` | Run JavaScript in the page for anything the reading tools cannot express |
| `camofox_search` | One call: search Google, YouTube, Amazon, Reddit, Wikipedia, X, Yelp, Spotify, Netflix, LinkedIn, Instagram, TikTok or Twitch and return the results already read |
| `camofox_scrape` | Extract one record from many pages by CSS selector, returned as newline-delimited JSON or written to `outputPath` |
| `camofox_mirror` | Copy a site into a folder that works offline: pages plus their CSS, JS, fonts and images, with links rewritten |
| `camofox_tabs` | List, close, close all, reset the session, or ask the engine to release memory |
| `camofox_status` | Engine health, memory, open tabs **across all sessions**, and the engine log path — use it first when browser tools fail |
| `camofox_transcript` | The spoken transcript of a YouTube video |
| `camofox_cookies` | Import cookies so a page opens already signed in |
| `camofox_console` | The errors this session's pages logged — console errors, uncaught exceptions, failed requests, HTTP errors |
| `camofox_fingerprint` | What the browser claims about itself, and which readings disagree |
| `camofox_trace` | List, download or delete the trace archives `camofox_open(trace:true)` records |
| `camofox_serve` | Serve a local folder over http for the browser, with a hard lifetime ceiling |

**Scraping many pages works by selector, not by ref.** The engine's own
extractor is driven by accessibility refs, and a ref only exists for a page you
have already read — which makes it useless for the pages you have *not* seen
yet. `camofox_scrape` therefore fills the schema with CSS selectors evaluated in
each page, optionally with `attr` (read an attribute instead of the text), `all`
(collect every match) and `type` (`string` / `number` / `boolean`). Ref mode is
still selected automatically when no property carries a `selector`, so a schema
of `x-ref` hints still works.

## Why it is shaped this way

**Native tools, not an MCP server.** The MCP bridge put a stdio process between
the model and the browser, and every capability inherited its limits: the
harness hands an MCP call a cancellation signal and a timeout, and the bridge
discarded both; a failure to boot the engine silently unregisters every tool
with `failOnStartupError: false`; and the MCP client kills only a direct child
on dispose, so the engine it started survived the harness. Native tools get the
same cancellation and deadlines the rest of the harness gets, fail loudly, and
are owned by a plugin whose disposer is guaranteed to run.

**Sixteen tools, not twenty-six.** The old namespace overlapped heavily
(`history` vs `navigate`, `evaluate` vs `extract`, `screenshot` vs the snapshot's
embedded screenshot) and forced the model to read prose to pick one. Each tool
here has one job, a description that says when *not* to use it, and a schema
that makes the arguments self-evident.

**Descriptions that cannot lie.** Four of the old tools were broken behind
confident descriptions: `upload` sent `files` where the engine reads `path` and
could only ever return HTTP 400; `wait` advertised a CSS selector the engine has
never implemented; `traces` could never return anything because no tool ever
enabled tracing, and traces are only flushed when a session closes; `save_pdf`
promised the file would land in the workspace when the bytes were unreachable
through any route. Those four are fixed, rescoped, or replaced here. `traces` is
now `camofox_trace`, and `camofox_open(trace:true)` is what makes it return
something — verified against a live engine, which wrote a 3.4 MB archive that
the tool then listed, downloaded and deleted.

**The engine's own vocabulary.** The engine encodes what went wrong in the
body's `code` field (`lib/browser-errors.js`), and status alone cannot separate
its conditions: a crashed page, a destroyed tab and a real browser restart are
all `410`. Deciding from the status alone told the model a crashed page was a
browser restart and told it to carry on. Every engine code now keeps its own
name, its own instruction, and the engine's own `retryable` flag, so a
page-mutating action is never replayed on a condition the engine marked
non-repeatable.

**Everything is bounded.** Every tool declares its own call deadline, so a bulk
job can never run unbounded. Results are rendered whole and cut afterwards, so
the paging fields a caller needs to continue reading are never the part that gets
truncated, and the cursor line is printed *before* the body so a later trim cannot
remove the instruction that continues the read. Snapshots page across the
engine's own windows, screenshots are opt-in, transcripts page, and scrape
results go to a file whenever `outputPath` is given — without one they come
back inline, cut by the tool's own 20 000-character result budget.

**A page never carries more than the model will actually receive.** The engine
windows a long document itself into a window of up to ~79 850 characters carrying its own
cursor, and the tool's result budget is smaller than that. So `camofox_read` subdivides a
window on a cursor that is exact by construction — **the engine's last window included**,
which is the one that most often overflows, because a read resuming near the start of a small
document can be handed a final window of 60 000 characters.

The split point is not `maxChars` and not a reserved constant: the page is *priced* through
the caller's own rendered fields and the longest page that still fits the tool's own content
budget is chosen. That matters because the budget is spent on pretty-printed JSON, where a
newline or a quote in the page costs two characters — a reserved allowance would look correct
on plain text and quietly lose the tail of every real page. In a windowed read `hasMore` is
the engine's answer, or the statement that this window still holds content no later window
will serve.

**One honest failure taxonomy.** The engine already encodes what went wrong.
`the tab no longer exists` means open a new tab; `element refs are stale` means
read the page again; `the camoufox browser restarted` means carry on. Those
three reach the model as instructions instead of as a status code, and each
failure keeps its `code` on the way out, so the session log can still tell
`tab_not_found` from `engine_timeout`.

**Nothing is done twice.** An action that changes the page — click, type,
press, scroll, select, upload — is sent once, and the retry budget for those
calls is zero, so they are not replayed even when the failure proves the engine
never received them. Reads are retried at most twice, and so are the handful of
POSTs declared harmless (opening a tab, navigating, waiting, resizing a viewport,
evaluating, cleanup); those repeat only on a failure the engine itself
classified as pre-dispatch (`concurrency_timeout`, `browser_launch_timeout`).
An unreachable engine is not such a proof — the transport raises it for a lost
response as well as for a refused connection — so a checkout form cannot be
submitted twice.

## Lifecycle

The engine is a child of the harness, not a stray daemon:

- **Starts with the harness.** The process is spawned during plugin activation.
  Activation does not *wait* for it — the loader awaits the plugin body, and
  anything injecting `camofox` stays pending until that resolves — so the first
  tool call waits for readiness instead of the whole harness waiting for a
  browser launch.
- **Stops with the harness.** Cordis disposal is guaranteed on a normal quit
  (with a five second ceiling) and kills the whole process tree, so no
  Camoufox or Firefox child is orphaned. A synchronous `process.on('exit')`
  guard covers the paths disposal cannot reach.
- **Survives neither a stale lock nor a stranger.** An engine whose pid appears
  in this bundle's lock file, and whose recorded owner process is *gone*, is an
  orphan from an earlier run: it is killed and replaced, so the browser really
  does stop with the harness. Anything else is adopted and never killed by us —
  including an engine owned by a harness process that is still running, which is
  why the lock records the owner's pid. A process that survives the kill keeps
  its lock file, because dropping it would make the next run adopt the orphan
  instead of reaping it. "Anything else" is narrowed by an identity check, not by
  reachability alone: a health response is only believed when the engine names
  itself (`engine: "camoufox"`), so an unrelated service squatting on the port is
  reported rather than adopted and handed the browser API.
- **A new task adopts; a new process replaces.** Both are verified. A second
  supervisor in a *running* process finds the engine already answering the port
  and adopts it — `owned` stays false, no child is spawned, and its tabs and
  cookies are still there. A supervisor in a *fresh* process finds a lock naming
  a dead owner, stops that engine and starts its own. Adoption carries the
  browser, not the session: contexts are per-session, so a new task is still
  logged out.
- **Recovers, and says so when it stops trying.** An unexpected exit is restarted
  with jittered exponential backoff, bounded by `restartLimit` inside a rolling
  window — so a crash loop that keeps briefly reaching `/health` trips the
  breaker instead of reporting itself as "attempt 1 of 3" forever. A child that
  cannot start at all fails in about a second with the OS error and the
  executable, instead of consuming the whole readiness budget.
- **Is authenticated on loopback.** The engine this plugin starts requires a
  bearer token that is generated per harness process; the plugin sends it on  every request. An engine it merely adopted is never sent a token it cannot
  know, and one credential-free retry keeps adoption working.
- **Logs rotate.** `engine.log` is capped at 5 MiB with three generations kept,
  rotated by the supervisor so the engine never sees it happen.


## Configuration

The package is a bundle, so it contributes **one** Loader row, `camofox-runtime`, which owns the
engine, registers the tools and publishes the prompt section. Configuration lives on that row in
`cordis.patch.yml`, and a profile-level patch can override it by id.

That row has to stay the only one. This package also declares a `dsh.client` half, and
`@deepseek-ai/dsh-client-modules` reconciles the sources it finds **by package name** across the
Host Loader's live rows — a second row makes it throw, and the throw takes the whole web shell
down rather than degrading it. The published package asserts the row count, so an accidental
second row fails a check instead of the GUI.

The values worth knowing:

| Key | Default | Meaning |
|---|---|---|
| `repoPath` | `` `${DSH_HOME}/camofox/repo` `` | The camofox-browser checkout |
| `nodePath` | `process.execPath` | A real Node executable for the engine |
| `baseUrl` | `http://127.0.0.1:9377` | The REST engine |
| `autostart` | `true` | Start the engine when nothing answers |
| `startTimeoutMs` | `180000` | Readiness budget after a spawn |
| `requestTimeoutMs` | `120000` | Per-call deadline on one REST request |
| `shutdownTimeoutMs` | `2000` | Tree-kill confirmation wait, inside the host's five second disposal ceiling |
| `restartLimit` | `3` | Restarts tolerated inside a rolling 60 second window — a readiness probe cannot reset it, because a crash loop keeps reaching `/health` |
| `reuseTimeoutMs` | `15000` | How long to wait for an engine process that already exists to bind its port, before treating it as wedged and replacing it. Never exceeds `startTimeoutMs`: an alive-but-not-listening process is a stuck engine, and waiting the full start budget on it just delays the recovery |
| `userId` | `dsh` | **Namespace** for browser identities. The engine `userId` actually sent is `` `${userId}~<sanitised session id>-<digest>` `` |
| `perSessionScope` | `true` | `false` restores one shared cookie jar and tab pool per profile |
| `scopeIdleMs` | `900000` | How long a session's browser context is kept after its last call |
| `accessKey` | generated per process | Bearer token the engine requires. Generated when empty, and exported to the child as `CAMOFOX_ACCESS_KEY` |
| `allowUnauthenticated` | `false` | `true` starts the engine with no key at all — only for an engine you run yourself |
| `allowEvaluate` | `true` | Set false to refuse `camofox_eval` |
| `defaultMaxChars` | `20000` | Default result budget |
| `maxTabs` | `8` | Tabs one session keeps before the least-recently-used one is closed |
| `maxConcurrentPerUser` | `3` | Calls one session may have in flight. Deliberately capped: the engine enforces a per-user limit of its own (three by default), so this is a backstop against a leak wedging the browser |
| `scrapeConcurrency` | `3` | Pages `camofox_scrape` fetches at once, and how many assets `camofox_mirror` downloads per page in parallel |
| `maxExtractChars` | `60000` | Consulted in exactly one place: as the default character budget of `camofox_transcript`. `camofox_scrape` never reads it — that tool is bounded by its own 500-URL cap, by `maxItems`, and by a 20 000-character result budget, so without an `outputPath` it inlines every record it fetched |
| `addons` | `[]` | Absolute paths to **extracted** Camoufox addon folders to load. See [Browser addons](#browser-addons) |
| `disableDefaultAddons` | `false` | `true` drops uBlock Origin, which Camoufox loads by default. The engine supports no per-name exclusion, so there is no name-list key |
| `captureConsole` | `true` | Installs the engine plugin behind `camofox_console`. See [Seeing why a page is broken](#seeing-why-a-page-is-broken) |
| `consoleMaxEntries` | `200` | How many entries one tab keeps before the oldest are dropped. Capped per source as well, so an error loop cannot evict the exception that explains it |
| `stateDir` | `${DSH_HOME}/camofox` | Where the engine lock, log and the `serves.json` registry of file servers live. Changing it also changes where `camofox_serve` records what it started |
| `mirrorAssetLimit` | `150` | Assets one `camofox_mirror` run downloads, across all pages |
| `healthIntervalMs` | `20000` | How often a running engine is re-probed, and when the log is rotated |

## Per-session isolation

The browser belongs to the **DSH session**, not to the harness process. The engine
`userId` on every call is `` `${userId}~<sanitised session id>-<digest>` ``, and the
engine turns each one into its own Playwright context, so:

- every session — and every subagent you delegate to — has its own cookie jar;
- one session's `camofox_tabs resetSession` cannot wipe another's login;
- a tab can only be closed by the session that opened it.

The digest is not decoration. The readable prefix is sanitised, and sanitising is lossy —
`sub/agent-01` and `sub-agent-01` both become `sub-agent-01` — so without a digest two
different sessions would silently share one jar. The prefix makes a scope legible in a log
line; the digest is what keeps two sessions apart. The digest is 32-bit and
non-cryptographic: it separates *sanitisation* collisions, which is the failure that
matters here, and is not a claim of global uniqueness.

The engine's own `sessionKey` is **not** a cookie boundary: it is a tab group
inside one context. It still labels tabs for organisation, and it now defaults to
the session scope so two sessions can never collide on a group name.

**Cookies do not survive across DSH sessions.** That is deliberate and matches the
platform's own browser invariant — *"Browser profiles and login state are not
restored from the Session log"*. Set `perSessionScope: false` to get the old
one-jar-per-profile behaviour back; it is a one-line profile change and needs no
code change.

When a session is disposed the plugin closes its context itself, rather than
waiting for the engine's reapers. `scopeIdleMs` is the backstop for a session the
framework never announced.

**One honest limit.** The plugin can only refuse a tab id that *it* knows belongs
to another session. A tab left open by an earlier run of the plugin — the harness
restarted, the engine survived — is not in any registry, so it cannot be attributed
and is allowed through. The engine's own `userId` scoping remains the real
authority there, which is why refusing locally is a fast, legible error rather than
the security boundary.


## Seeing why a page is broken

A page-level failure is invisible to every other tool. An uncaught exception, a
rejected promise and a failed API call all leave the accessibility tree and the
extracted text looking perfectly healthy, so an agent reading a page has nothing
to react to — it sees an empty panel and no reason why.

`camofox_console` closes that gap. An engine plugin attaches Playwright
listeners to each tab as it is created and keeps a bounded buffer per tab:

| Captured | Not captured | Why |
|---|---|---|
| `console.error`, `console.warning` | `console.log`, `console.info` | a page that logs on every render would bury the two that matter |
| uncaught exceptions | — | they never reach `console` at all, and they are usually the actual cause |
| failed requests | requests the page cancelled itself | `ERR_ABORTED` is a page changing its mind, not a failure |
| HTTP responses ≥ 400 | 2xx and 3xx | the call succeeded |

A host that does not resolve does **not** reach the failed-request listener: the
browser fails it before it leaves the machine and the page sees a `NetworkError`,
which arrives under uncaught exceptions. So a DNS failure is reported, just under
a different heading.

Entries are held in memory only and only for tabs this session opened. The buffer
is capped both in total and per source, because a page in a render loop can
produce errors faster than anyone can read them and an unbounded buffer in a
long-lived engine process is a memory leak.

Set `captureConsole: false` to turn the plugin off.

## Serving local files (`camofox_serve`)

The engine blocks every URL scheme except http and https
(`camofox-browser/server.js:190`, `ALLOWED_URL_SCHEMES`), and that block is a
security decision upstream tests for — a `file://` URL would read any file the
harness can read. So a local repro has to be served before the browser can open
it. `camofox_serve` does that, and the hard part is not serving: it is making
sure the server does not outlive the work that needed it.

```json
{ "action": "start", "root": "C:\\Users\\me\\project\\.tmp-research" }
```

It picks a free loopback port, serves `index.html` at `/`, and returns the URL to
pass to `camofox_open`. It binds loopback only, and confines every path to the
served root — a `..` or a symlink answers 403 rather than reading the drive.

### Nothing survives, by three independent mechanisms

A server started on an agent's behalf is a resource nobody asked for, and if it
outlives the agent it is invisible: no window, no output, a port held. Each
mechanism below can fail on its own, so the guarantee does not rest on any one:

| Layer | What it covers | When it fails |
|---|---|---|
| **The child's own deadline** | Nothing above it needs to be alive | Never, short of a `SIGKILL` aimed at the child itself |
| **A detached watchdog process** | The harness, the plugin, or the tool call dying | Never — it answers only to the clock |
| **Plugin disposal and startup sweep** | The ordinary path, and anything a crash left behind | Only if both processes are killed within the TTL |

The watchdog is a separate detached process that re-reads the registry every two
seconds, so it also covers servers started *after* it launched. Every start is
recorded in `serves.json` under the plugin's state directory, which is what lets
a later run, `camofox_serve action:"stop"`, or the plugin's own startup find and
kill them without guessing from a process list.

**Measured, not asserted.** A server started with a 3-second ceiling and then
left completely alone stopped at 3049 ms. A second server, started after the
watchdog was killed and with the in-process timer disabled, stopped at 3066 ms —
so the deadline does not depend on the watchdog.

The ceiling is a constant, `SERVE_TTL_MS = 120000`. It is not per-call
configurable: a guarantee a caller can raise is not a guarantee.

**What it will not do:** it does not make `file://` work, and it is not a
replacement for running the project. If the app has a dev server, use that — the
page then loads its real assets, modules and API calls, which a static file
server cannot reproduce. `camofox_serve` is for a self-contained HTML repro that
needs no application behind it.

## Browser addons

Camoufox loads **extracted** addon folders — not `.xpi` archives. To use an
`.xpi`, rename it to `.zip`, extract it, and point `addons` at the extracted
folder. Every folder must contain a `manifest.json`, and it must declare
`manifest_version: 3`: the bundled Firefox 152 has Manifest V2 disabled, so an
MV2 addon launches without error and simply never runs.

```yaml
- id: camofox-runtime
  config:
    addons:
      - 'C:\Users\mirel\.dsh\camofox\addons\my-addon'
```

`disableDefaultAddons: true` removes the uBlock Origin copy Camoufox installs by
default, which is the setting to reach for when a site needs to see ad requests.
There is no per-name exclusion: the engine turns that boolean into a hardcoded
`exclude_addons: ['UBO']` at launch, so a list of names would be accepted by
configuration and then do nothing. Note that dropping UBO also drops the
custom privacy filters compiled into the Camoufox build.

### How the addon reaches the browser

`camoufox-js`'s `launchOptions()` consumes the `addons` argument and encodes the
whole resulting config into `CAMOU_CONFIG_<n>` environment chunks on the resolved
Playwright options. The engine emits its mutating `browser:launching` hook
*after* that has happened, so assigning `options.addons` there does nothing — the
browser launches and the addon is silently absent.

This plugin therefore installs its own engine-side plugin,
`plugins/dsh-addons/index.js`, which on that hook concatenates the existing
`CAMOU_CONFIG_<n>` chunks, adds the configured folders to `config.addons`, and
re-chunks the result with camoufox-js's own 2047-character Windows limit. The
addon list travels in `CAMOFOX_DSH_ADDONS`, NUL-separated, because a Windows
path may contain any character that would otherwise need escaping.

The engine loads plugins from `<repoPath>/plugins/<name>/index.js`, and the
`plugins` key in its `camofox.config.json` is an allowlist: a directory the file
does not name is skipped. Both live inside the engine checkout rather than this
package, which is why `installAddonPlugin` writes them at startup. It adds the
allowlist entry only when that file already has an object-shaped `plugins` key
that omits it — a file with no `plugins` key loads every directory, and adding
one would narrow that.

A folder that is missing, or that has no `manifest.json`, is skipped with a log
line rather than failing the launch. `GET /dsh-addons/status` on the engine
reports each configured folder with its `exists` and `manifest` verdict.

**One limit.** The integration is operator-only: addons come from `cordis.yml`
configuration, and no tool lets a model load or change one. A model that could
write an addon into the browser would be handing itself arbitrary code
execution inside the page context, which is a larger capability than browsing.


## The screenshot card

`camofox_capture` returns a PNG as a durable attachment. This package ships a client half that
renders it inline in the conversation as a click-to-enlarge thumbnail, instead of leaving a JSON
blob where the picture should be.

It is presentation only. It registers no tool, touches no tool result, and cannot reach anything
the model sees — every byte it draws was committed host-side before the browser could observe it.
The wire tool name it claims is `camofox_capture`, the same one the host registers, and the card
replaces the generic row for that key outright, so it renders every case: a failed capture, a
capture that produced no bytes, and a call that is still running.

Two properties it is built to keep:

- **The render is total.** A card that throws does not degrade — the renderer abdicates that slot
  key permanently, so every later capture would render as an empty box. A result part that cannot
  be serialized (a circular structure, a BigInt) is described instead of formatted, and an image
  that never loads falls back to the text the generic card would have shown.
- **The copy is locale-owned.** Every string comes from a dictionary through the `t` the renderer
  builds for this registration, in English and Romanian.

This half is served at `/plugins/dsh-camofox/client.js` and runs as a classic script. It is part
of this package rather than a second one, and that is deliberate: `@deepseek-ai/dsh-client-modules`
reconciles the sources it finds by package name across the Host Loader's live rows, so a package
carrying a client half has to resolve from exactly one row. Two rows here would throw at activation
and leave the web shell with no module loader at all.


## Notes and limits

- The engine caps concurrency at three calls per user, as does this plugin, so
  the browser is a scarce resource on purpose: read a page, act, read again
  beats firing a dozen calls at once.
- `camofox_mirror` copies what a browser can see: rendered HTML and the assets
  it references. It cannot recover the pre-hydration document of a single-page
  app, and JavaScript that fetches from an absolute CDN origin at runtime will
  still reach the network.
- `camofox_transcript` is fast when `yt-dlp` is installed and falls back to
  reading captions in the browser otherwise.
- Page content is untrusted. The prompt section tells the model so explicitly.
- **Writes are unrestricted by design.** `savePath`, `outputPath` and
  `camofox_mirror`'s `outDir` may name any path, and the plugin runs in the host
  process, so a model mistake can write anywhere. What it will no longer do is
  hide the consequence: every write reports `replacedExisting`, and
  `overwrite: false` turns a collision into a refusal instead of a lost file.
  This is a deliberate decision, not an oversight — do not "fix" it by adding a
  sandbox without changing the decision first.
- **`allowEvaluate` gates model-authored JavaScript only.** It removes
  `camofox_eval`; it does not stop the fixed scripts compiled into this bundle —
  `camofox_read`'s `text`, `markdown` and `html` modes, `camofox_scrape` in
  selector mode, and the `waitForSelector` wait on `camofox_open`, `camofox_act`
  and `camofox_mirror` still run. Gating those too would remove most of the
  product, and the model never supplies that code.
- `camofox_tabs(action:'cleanup')` asks the engine to release idle memory across
  **every** session sharing the engine; the other `camofox_tabs` actions affect
  the calling session only.
- **`file://` is blocked by the engine and stays blocked.** This plugin does not
  work around it; `camofox_serve` is the supported route for a local file, and it
  exists precisely because a workaround that reads arbitrary paths is not worth
  having.
- **`requestfailed` does not cover a name that does not resolve.** The browser
  fails that before the request leaves the machine, so the page sees a
  `NetworkError` and it arrives under uncaught exceptions instead. The failure is
  reported, under a different heading.
- **Console capture attaches per page, from three hooks.** `tab:created` fires
  after the first navigation resolves (`server.js:3043`), so a listener attached
  only there would miss every error a page raises while loading. The capture
  therefore also subscribes to `context.on('page')` at session creation, which
  is the only place a page can be reached before its first load.
- **Known engine limitations that cannot be fixed from here.** Coordinate
  clicking is not available: the handler destructures only `{userId, ref,
  selector}` and answers 400 without them, so exposing x/y on `camofox_act`
  would produce an error. `main_world` evaluation does not exist in the engine,
  so `camofox_eval` is page-world only. Neither is a choice this plugin makes.
- **Decisions deliberately not taken.** Storage-state export is refused because
  it contradicts the session-isolation invariant below; a persistent fingerprint
  is refused because a frozen identity is the wrong default for an agent; and
  `POST /stop` is refused because this plugin's supervisor owns process death.
  Each of these is available upstream and each was left alone on purpose.

---

<p align="center">
  <sub>
    <b>dsh-camofox</b> — Camoufox as a native DeepSeek Harness capability. MIT.<br>
    Camoufox is Copyright (c) 2025 <a href="https://github.com/jo-inc/camofox-browser">Jo, Inc</a>, MIT, and is not redistributed here.<br>
    Built by <a href="https://github.com/pazalo">Pazalo</a>.
  </sub>
</p>

