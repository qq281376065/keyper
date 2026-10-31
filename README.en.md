# Keyper

English | [简体中文](README.md)

A cross-platform key-value cache manager built with **TypeScript + Electron + React 19 + electron-builder**.

**Redis and Memcached, side by side.** Each is wired in as an isolated engine module —
configuration, connection pools, logs and search history are stored per engine, so a fault in one
module cannot reach the other. Adding a new engine only means implementing an adapter and
registering it; no existing code path has to change.

| Engine | Capabilities |
| --- | --- |
| **Redis** | Multiple databases, six data structures (string / hash / list / set / zset / stream), Pub/Sub, slow log, key memory analysis, multi-hop SSH tunnels, built-in CLI |
| **Memcached** | Stats and hit rate, full key browsing (`lru_crawler metadump`, falling back to `stats cachedump` on older servers), paged loading, single-key view and CRUD, `flush_all`, runtime settings |

> This project began as a React port of RedisDesktop (Vue 3). The main process, preload, IPC,
> shared type contracts and packaging configuration follow that structure; the renderer has been
> rebuilt around a multi-engine architecture.

Current version: `1.0.7`

What changed in this release (1.0.6 → 1.0.7):

- **Unified hover shadow for icon buttons across the app**: 15 kinds of icon-only buttons — refresh /
  new key / dialog close / more actions / sidebar new and collapse / sidebar expand / tab overflow /
  top-bar icons / window controls / key row delete / bulk-panel row actions / value row actions /
  search-history delete / theme and language switch / notification close — now lift on hover, sharing
  `--lift-shadow` with tabs and connection tiles (a layered double shadow that rises vertically with
  no movement). All nine skins follow automatically, and only the shadow is added — each button keeps
  its own accent-fill or red-close hover.
- **Connection tiles use a layered double shadow**: a 1px near shadow defines the outline while a wide
  blurred shadow with negative spread settles under the card for depth. Values are grouped by light
  and dark themes (light backgrounds switch to a cool slate ink so pure black does not look dirty on
  white).
- **Tabs and key-browser mini buttons share the tile shadow**: hover and selected states use the same
  shadow level, and the selected state adds shadow only — no inset outline, which belongs to the
  connection tile's selection semantics.
- **Memcached key browser state styles completed**: L1 / L2 / expand all / collapse all / batch select
  previously had size only, with no hover or selected feedback; they now match the Redis key browser.
- **English README added**: `README.en.md` mirrors the Chinese edition section by section, table by
  table and screenshot by screenshot, and the two link to each other at the top.
- **Native tooltips replaced across the app**: native `title` attributes in 13 components —
  connection tabs, the slow-log table, the split-pane handle, the value-area bookmarks and their
  "⋯ more" panel, welcome-page buttons, settings paths and five edit dialogs — now use the project's
  `tipProps` instead (OS-drawn tooltips appear after about a second and pop a bright bubble in dark
  themes). This also fixes a nested-tooltip bug: moving the pointer from a bookmark's close × back
  onto the bookmark itself made the tooltip disappear for good.
- **Home-card colours follow the skin**: the card surface was pure white on all nine light skins —
  the override lived inside `@layer components` and was silently beaten by Tailwind's utilities
  layer. It is now computed from panel + page background, and Mint / Mist / Aurora mix in their own
  accent so the three are instantly distinguishable. The feature grid and the info card became
  transparent, separated by dashed lines, with hover using the global `--bg-hover`.
- **Semantic icons on the value-area sub-tabs**: Redis info / slow log / key memory analysis /
  Pub-Sub, plus Memcached stats / settings, now carry an icon before the label, tinted by the tab's
  own text colour.
- **Layout fix**: the + in the "New connection" button sat 1.5px above the text's centre (the
  content layer had no flex and laid out on the baseline); it is now centred.
- **Value header becomes a masthead**: it replaces the previous ticket-stub + watermark — a 9px
  uppercase type eyebrow in that type's badge colour on top, an 18px key name with right-aligned
  TTL / encoding / size beneath, and the ⋮ menu anchored at the top right. The string value toolbar
  also folds its six actions into one segmented control, making the split from the key-level ⋮ menu
  clearer.

Previous release (1.0.4 → 1.0.6):

- **Three-language UI**: Simplified Chinese / Traditional Chinese / English, switched live from the
  language menu at the top right of the home page and persisted; the first launch follows the OS
  language. Dictionaries moved to semantic keys (`namespace.camelCase`) split into per-language
  files under `lang/`; `MsgKey` is derived from the English catalogue and the other two are
  validated at compile time, with a runtime fallback chain of current language → English → key.
  Main-process strings (errors, logs) follow the setting as well. A new `npm run i18n:check`
  validates key sets, placeholders and source references.
- **Top cards switched to scheme 09 (borderless, typographic)**: the overview cards on the Redis
  and Memcached detail pages drop their border and background, grouping content with whitespace
  and hairlines only; the cards below them are unchanged.
- **Memcached key browsing completed**: full LRU traversal via `lru_crawler metadump`, fixing keys
  still sitting in the WARM segment (e.g. `group:yufei:2030`) that disappeared after a reconnect.
  Older servers fall back to `stats cachedump` and are labelled "may be incomplete". Keys load page
  by page using the global "keys per page" setting, with load-more / load-all mirroring the Redis
  key browser.
- **Startup theme flash fixed**: the saved skin is applied on the first frame instead of being
  overwritten by the default theme while settings are still loading.
- **New brand mark**: a solid red rounded square with a white K (the key's bit), geometrically
  consistent with the in-app logo.

Earlier (1.0.3 → 1.0.4):

- **React 19 and React Compiler 1.0**: build-time automatic memoization with `target: 19` using
  React's own compiler runtime — no extra runtime dependency (bundle +54.7 kB, gzip +23.7 kB).
- **Value tabs kept alive (`<Activity>`)**: switching away hides a tab instead of unmounting it, so
  filters, sorting, edit drafts, column widths and scroll position all survive. Returning to a
  cached tab renders instantly and refreshes silently — no skeleton flash.
- **Operation log list**: a connection column up front, a sticky header and a pinned action column
  so columns do not drift when scrolling horizontally. Time / action / detail / connection / result
  can each be sorted (time newest-first by default, text in Chinese collation, result grouped
  OK / FAIL first). Minimum row height 30px, so copy buttons no longer overflow in compact density.
- **PixelHeading animation**: per-character font switching now writes to the DOM directly instead
  of re-rendering the whole component every 50ms.
- **Fixes**: sidebar expand button tooltip and optical centring; the home page compatibility notes
  now mention Memcached.

Earlier (1.0.2 → 1.0.3):

- **Memcached engine module**: fully isolated from Redis (its own pool, manager, IPC channels and
  log fields). The connection list carries an engine badge, the new-connection dialog lets you pick
  an engine, and logs can be filtered by module.
- **Memcached information panel**: four overview cards (service / memory / hits / status), a stats
  tab, keys browsed by slab, and a settings tab including `flush_all`.
- **Project renamed to Keyper**: product name, appId, installer config directory and theme storage
  keys all updated, with migration for the old names (RedisDocter / RedisDesktop).
- **Engine identity and branding**: the connection name row uses an engine glyph, the same glyph
  appears on the engine cards in the new-connection dialog, and the top bar wordmark, home page
  logo hover and CTA gradient all follow the skin.

Earlier (1.0.1 → 1.0.2):

- **Value header becomes a ticket stub with watermark** (75px): a 26px stub on the left carrying the
  type name vertically, a mask biting a semicircular tear out of the right edge, and a 72px
  type-initial watermark pressed onto the right of the face.
- **Connection list becomes tile cards** (one per row): card background, border and radius, a status
  hairline on top, and the pin icon right after the connection name.
- **Exit confirmation becomes a custom dialog**: it lists the instances still connected, disconnects
  them in parallel, then closes the window — no more native OS dialog.
- **Missing UI ported to the right-hand panel**: the list of subscribed Pub/Sub channels (each
  unsubscribable), the slow-log ID column and relative time, and an explanation of the slow-log
  threshold.
- **All buttons become pills** (999px): key memory analysis uses a recessed segmented control, and
  start / clear / stop / subscribe / publish all adopt the `.tool` metrics.
- **Fixes**: operation menus hidden behind table headers (`transform` creating a containing block),
  long content blowing out the List edit dialog width, key names tinted by type colour, and dialog
  text boxes growing with their content.

Cumulative capabilities:

Three-language UI (Simplified Chinese / Traditional Chinese / English); multi-tab workspace (one tab
per connection, closing a tab disconnects, context menu / overflow scrolling / more-tabs dropdown);
value tabs kept alive (`<Activity>` hides instead of unmounting, preserving state); sortable
operation log with a pinned action column; multi-hop SSH tunnels with keep-alive; four value-area
tabs (Redis info / slow log / key memory analysis / Pub/Sub); batch TTL and rename; full-database
search pushed down to the main process with flat virtual scrolling; key search history with
autocomplete (isolated per connection and database, LRU 30, persisted to the config file); batch
delete from deep tree directories via context menu; string values editable on double click; batch
delete of two or more keys routed through the value panel; nine skins (including Aurora); credential
expiry banner; solid line-number gutter for string values; installer start-menu shortcut page;
error log files (renderer and main-process exceptions written to
`logs/errors-yyyymmdd.log` with stack traces and 5-second de-duplication); batch delete in the
connection list (entry appears at three or more); dialog close discipline (regular dialogs ignore
mask clicks); symmetric entry points for all six types; nine-cell feature tour on the home page;
vitest unit tests.

---

## Renderer state and components

| Path | Responsibility |
| --- | --- |
| `src/store/reactiveStore.ts` | A minimal reactive store (Proxy + version counter), semantically equivalent to Vue's `reactive` |
| `src/store/session.ts` | Per-tab session: race tokens for scan / select / value updates, local CRUD, batch jobs |
| `src/store/global.ts` | Connection management, tabs, snapshot restore |
| `src/store/useRedis.ts` | Context wrapper: a Context inside the tab tree, an active-session proxy outside it |
| `src/hooks/` | Settings, theme, search history, dialog dragging, six value-type editors (`valueEditor/`) |
| `src/components/` | 48 UI components (`.tsx`) + `ui/` primitives + `components.css` |

---

## Internationalization (i18n)

The UI ships with Simplified Chinese, Traditional Chinese and English, switchable live from the
language menu at the top right of the home page. The choice is persisted to `settings.json` and
restored on the next launch.

| Path | Responsibility |
| --- | --- |
| `lang/en.ts` | English catalogue, **the single source of truth**: semantic key + English text, exports `MsgKey` |
| `lang/zh-CN.ts` / `lang/zh-TW.ts` | Translations typed as `Record<MsgKey, string>`, so a missing or extra key fails the build |
| `shared/i18n/index.ts` | Language codes, dictionary lookup, `{name}` interpolation, fallback chain; shared by main and renderer |
| `src/i18n/index.ts` | Renderer entry: `useI18n()` (subscribes to language changes) and a module-level `t()` |

Design notes:

- **Semantic keys** (`namespace.camelCase`, e.g. `common.cancel`) describe intent rather than copy,
  so rewriting a string never touches call sites. `MsgKey = keyof typeof en` makes a typo, a missing
  translation or an extra one a compile error;
- runtime fallback is current language → English → key, so nothing ever renders blank;
- `npm run i18n:check` verifies that the three catalogues share the same key set and placeholders,
  that English text contains no leftover Chinese, that every literal `t()` key in the source exists,
  and that no key is unused;
- components call `const { t } = useI18n()` and translate during render; the main process does
  `import { t } from '@shared/i18n'` and follows the setting via `syncMainLocale`;
- module-level constants (theme names, header maps, TTL presets) store a `MsgKey` and call `t(key)`
  at render time;
- persisted operation logs keep Chinese action names (easy to grep, backward compatible) and are
  mapped to a `MsgKey` through `logActionKey` when displayed;
- language names always appear in their own script (「繁體中文」 is not translated in the English UI),
  and `<html lang>` is updated to match.

Adding a language: add a file under `lang/` implementing `Record<MsgKey, string>` → register it in
`LocaleCode` / `LOCALES` / `LOCALE_NAMES` / `LOCALE_HTML_LANG` / `DICTIONARIES` in `shared/i18n` →
run `npm run i18n:check`.

Adding a string: add the semantic key under the right namespace in `lang/en.ts` → add the same key
to zh-CN and zh-TW → call `t('ns.key', { … })` in the source → run `npm run i18n:check`.

---

## Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Main process | Electron 33 + TypeScript 5.7 | Window management, IPC, connection pools, engine registry |
| Renderer | **React 19 + Vite 6** | UI and interaction; state layer under `src/store/` |
| Compile-time optimization | **React Compiler 1.0** | Build-time automatic memoization, `target: 19` uses React's built-in runtime |
| Transport | contextBridge + ipcRenderer.invoke | Context isolation; the renderer never touches Node |
| Redis client | ioredis 5 | TLS / ACL / paged SCAN |
| Packaging | electron-builder 25 | Windows NSIS / macOS DMG / Linux AppImage + deb |

---

## Project structure

```
Keyper/
├── electron/                        # Main process
│   ├── main.ts                      # App entry: windows, single instance, lifecycle
│   ├── preload.ts                   # Preload: exposes window.redisApi via contextBridge
│   ├── ipc/index.ts                 # IPC channel registration and uniform error wrapping
│   └── services/
│       ├── engines/                 # Engine modules (isolated from each other)
│       │   ├── registry.ts          # Engine registry: adapter registration and lookup
│       │   └── memcached/           # Memcached: client / manager / pool
│       ├── connection-manager.ts    # Redis connection pool + every Redis command
│       ├── ssh-tunnel.ts            # SSH tunnel (local port forwarding)
│       ├── connection-store.ts      # Connection config persistence
│       ├── credential-crypto.ts     # Credential encryption (safeStorage + fallback)
│       ├── settings-store.ts        # App settings persistence (settings.json)
│       ├── search-history-store.ts  # Key search history (LRU 30, per connection and db)
│       ├── log-service.ts           # Manual operation log (daily shards, expiry cleanup)
│       ├── update-service.ts        # Update checks
│       ├── config-path.ts           # Portable directory resolution and fallback
│       └── close-signal.ts          # Disconnect-before-exit signal
├── lang/                            # Three dictionaries (semantic keys)
│   ├── en.ts                        # English (single source of truth, exports MsgKey)
│   ├── zh-CN.ts                     # Simplified (Record<MsgKey, string>)
│   └── zh-TW.ts                     # Traditional (Record<MsgKey, string>)
├── shared/                          # Type contracts shared by main and renderer
│   ├── types.ts                     # Data models
│   ├── api.ts                       # Interfaces + IPC channel constants
│   ├── keyspace.ts                  # Key namespace parsing (separators / prefixes)
│   ├── i18n/index.ts                # Translation core: language codes, lookup, interpolation
│   └── version.ts                   # Version parsing and comparison
├── src/                             # Renderer
│   ├── main.tsx                     # Mount entry
│   ├── App.tsx                      # Overall layout (top bar / three columns / CLI)
│   ├── api/                         # Data layer: IPC in Electron, mock fallback in the browser
│   ├── store/                       # defineStore + session / global / subscriptions
│   ├── hooks/                       # Settings, theme, search history, dialog drag, value editors
│   ├── components/                  # 49 UI components + ui/ primitives
│   ├── services/                    # Settings, theme, error reporting
│   ├── utils/                       # Key tree, capability detection, formatting, clipboard
│   ├── styles/                      # main.css (design tokens) + components.css
│   └── preview/                     # Browser-only preview pages
├── tests/unit/                      # vitest unit tests (16 specs)
├── build/                           # Icons and NSIS customization scripts
├── scripts/                         # Development probes and screenshot scripts
├── vite.config.ts                   # Renderer + main process builds
├── vitest.config.ts                 # Unit test configuration
└── electron-builder.yml             # Packaging configuration
```

---

## Common commands

```bash
npm install          # Install dependencies (a mirror helps on mainland networks, see below)
npm run dev          # Dev mode: Vite + Electron with hot reload
npm run dev:web      # Browser-only renderer debugging: Vite only, no Electron build or launch
npm run preview      # Preview the built output (http://127.0.0.1:4173)
npm run preview:title # Preview the animated title page in a browser
npm run typecheck    # Type checking (main process + renderer)
npm run test         # vitest unit tests (tests/unit, 16 specs)
npm run i18n:check   # Validate the three dictionaries: key sets, placeholders, source references
npm run build        # Type check + build into dist/ and dist-electron/
npm run dist         # Package for the current platform
npm run dist:win     # Build the Windows installer
npm run dist:win:alt # Build Windows into release/<version>-final (keeps the previous output)
```

Build output lands in `release/<version>/` as `Keyper-1.0.7-win-x64.exe`.

Downloading the Electron binary is slow on mainland networks, so set a mirror first:

```bash
npm config set registry https://registry.npmmirror.com
# Electron binary mirror (the project already configures build-time mirrors in electron-builder.yml)
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   # Windows
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ # macOS / Linux
```

### Packaging toolchain mirror

When wrapping the NSIS installer, `electron-builder` also downloads `nsis`, `nsis-resources`,
`winCodeSign` and friends. These come from **GitHub Releases** by default, which frequently times
out on mainland networks, surfacing as `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE` and leaving an **empty
directory** under `%LOCALAPPDATA%\electron-builder\Cache\nsis\`.

This is a **different** concern from `electronDownload.mirror` (the Electron runtime binary), and
`electron-builder.yml` has **no** setting for it — only an environment variable works. The project
already declares it in the `config` field of `package.json`, so `npm run` injects it automatically:

```json
"config": {
  "electron_builder_binaries_mirror": "https://npmmirror.com/mirrors/electron-builder-binaries/"
}
```

### Verifying the packaged build

In a terminal where `ELECTRON_RUN_AS_NODE=1` is set (some Electron-integrated environments do this),
the packaged exe runs in plain Node mode without creating a window — it looks like "starts and exits
with no error", and `exe --version` prints the Node version rather than the Electron one. Clear both
variables before testing:

```bash
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./Keyper.exe
```

To diagnose startup problems, enable the main-process diagnostic log:

```bash
KEYPER_DEBUG_LOG=/tmp/rd.log ./Keyper.exe
# The log records: module loaded → requestSingleInstanceLock result → app ready → window created
```

---

## Installer (NSIS customization)

The installer is customized by the NSIS scripts under `build/`. `installer.nsh` is the single entry
point (`nsis.include` in `electron-builder.yml`); it `!include`s the other three:

| File | Responsibility |
| --- | --- |
| `installer.nsh` | Aggregating entry: mounts hooks, writes and cleans PATH, includes the three below |
| `installer-env.nsh` | Environment check page: detection logic and nsDialogs UI |
| `installer-upgrade.nsh` | Existing-install detection: upgrade mode reuses the original directory and keeps user data |
| `installer-config.nsh` | Preserving and cleaning user config (upgrades never delete `config/`) |
| `icon.ico` / `icon.png` | Application and installer icons (already committed) |

### What the environment check actually does

This is an Electron app: the runtime (Node / Chromium / V8) ships inside the package, and both
ioredis and ssh2 are bundled libraries. The main process **never invokes an external program**. So
the traditional "check VC++ / .NET / Node.js" page would be pure theatre — extra clicks, zero
protection.

What it checks instead are the conditions that make "installed but won't start" happen. The page
sits **after directory selection**, where `$INSTDIR` is final and disk and permission probes are
meaningful:

| Check | Rule | On failure |
| --- | --- | --- |
| Windows version | Build ≥ 17763 (Win10 1809) | Warn, user may opt to continue |
| Architecture | x64 required | **Hard stop** |
| Disk space | ≥ 600 MB | Warn, user may opt to continue |
| Install directory | Write a probe file and verify | Warn, user may opt to continue |

### PATH environment variable

On install the directory is appended to the **current user's** PATH (`HKCU\Environment`) and removed
on uninstall:

- `WriteRegExpandStr` keeps the value `REG_EXPAND_SZ`, so `%USERPROFILE%`-style variables are not
  frozen into absolute paths
- idempotent: reinstalling does not create duplicate entries (verified)
- uninstall compares by semicolon boundaries, so `Keyper2` is never mistaken for `Keyper`

### Pitfalls (read before editing)

1. **`installer.nsh` is compiled twice** (once for the installer, once for the uninstaller). Any
   `Var` / `Function` used only by the installer must sit inside `!ifndef BUILD_UNINSTALLER`, and
   `un.`-prefixed functions inside `!ifdef BUILD_UNINSTALLER`. Otherwise you get
   `warning 6010 / 6001 / 6020`, and electron-builder **treats NSIS warnings as errors** — packaging
   fails with nothing but a single `Error output:` line.
2. **Hook the check page with `customPageAfterChangeDir`**, never `customWelcomePage` (the latter
   replaces the welcome page and runs before the directory page).
3. Adding your own `!include "StrContains.nsh"` outside `-D` triggers an unreferenced-symbol warning;
   build the PATH duplicate check with semicolon-boundary concatenation instead.

### Icon

Both the window icon and the installer icons read `build/icon.ico` (`win.icon` / `installerIcon` /
`uninstallerIcon` / `installerHeaderIcon` in `electron-builder.yml`). The file is committed and has
no generator script; to replace it, supply a 256×256 PNG and convert it to a multi-size ICO.

The mark is a solid red rounded square with a white K (the key's bit): brand red `#CE3F33`, no
gradient, no highlight. The K is drawn with vector strokes rather than a font — a font glyph's ink
is only about 66% of the em size, so at 16×16 the white pixels vanish and the taskbar shows a plain
red square. The geometry matches the 128×128 coordinate system in `src/components/BrandMark.tsx`.

---

## UI preview

| Approach | Command | What you see | When to use it |
| --- | --- | --- | --- |
| Real components in a browser | `npm run dev:web` → open `http://127.0.0.1:5173` | Actual React components with hot reload; data comes from `src/api/mock.ts` | Day-to-day UI work without waiting for an Electron window; the screenshots below are generated this way |
| Built output preview | `npm run build && npm run preview` | The production bundle served statically at `http://127.0.0.1:4173` | Verifying the packaging result |
| Full application | `npm run dev` | A real Electron window with IPC and ioredis end to end | Verifying connections, commands, log files, settings persistence and other real behaviour |

> In browser mode there is no main process: settings and logs come from demo data in
> `src/api/mock.ts`. Use `npm run dev` to verify their real behaviour (logs written to `logs/` in the
> config directory, persisted settings).
>
> **Previewing field-level TTL**: the demo data contains four connections. "**新版演示 (7.4+)**"
> (`127.0.0.1:6381`) emulates Redis 7.4.4 — connect to it to see the hash TTL column and its edit
> entry point. The other three are 7.2.4, where the TTL column is hidden and the status bar explains
> why. For lower-version connections the mock returns `null` from `hashFieldTtls`, matching the
> `unknown command` behaviour of a real server.
>
> **There is only one implementation of the UI, in `src/`.**
> An earlier hand-written static prototype (`preview/index.html`, plain HTML/JS) was removed: it
> meant maintaining two implementations, and they had already drifted — a dialog could not be closed
> in the static page because its `display:flex` overrode the `hidden` attribute.

### Screenshots

> The screenshots below come from the `npm run dev:web` browser preview. All data is demo
> configuration from `src/api/mock.ts` — no real addresses, accounts or business key names.

#### Home page

<p>
  <img src="docs/screenshots/home-dark.png" width="49%" alt="Home · dark" />
  <img src="docs/screenshots/home-light.png" width="49%" alt="Home · light" />
</p>
<p>
  <img src="docs/screenshots/home-aurora.png" width="49%" alt="Home · Aurora" />
  <img src="docs/screenshots/home-sakura.png" width="49%" alt="Home · Sakura" />
</p>

#### Key browser · nine skins

Same data, same layout — only `data-theme` changes. Colours are driven by CSS variables and the
components know nothing about themes, so a new skin is just another set of variables.

| Dark | Light | Ocean |
| :---: | :---: | :---: |
| ![](docs/screenshots/key-browser-dark.png) | ![](docs/screenshots/key-browser-light.png) | ![](docs/screenshots/key-browser-ocean.png) |

| Solarized | Forest | Sakura |
| :---: | :---: | :---: |
| ![](docs/screenshots/key-browser-solarized.png) | ![](docs/screenshots/key-browser-forest.png) | ![](docs/screenshots/key-browser-sakura.png) |

| Mint | Mist | Aurora |
| :---: | :---: | :---: |
| ![](docs/screenshots/key-browser-mint.png) | ![](docs/screenshots/key-browser-mist.png) | ![](docs/screenshots/key-browser-aurora.png) |

#### Tree view and value viewing

The tree is built level by level on the key separator, and directory nodes show how many keys their
subtree holds. On the right, each type gets its own viewer — hash as a field table (with a
field-level TTL column), zset as a member + score table.

<p>
  <img src="docs/screenshots/key-browser-tree.png" width="49%" alt="Tree view · dark" />
  <img src="docs/screenshots/key-browser-tree-light.png" width="49%" alt="Tree view · light" />
</p>

<p>
  <img src="docs/screenshots/key-value-string.png" width="49%" alt="string value" />
  <img src="docs/screenshots/key-value-hash.png" width="49%" alt="hash value" />
</p>

<p>
  <img src="docs/screenshots/key-value-zset.png" width="49%" alt="zset value" />
  <img src="docs/screenshots/key-value-hash-light.png" width="49%" alt="hash value · light" />
</p>
<p>
  <img src="docs/screenshots/key-value-string-light.png" width="49%" alt="string value · light" />
</p>

The value header is a **masthead**: a 9px uppercase eyebrow in that type's badge colour, an 18px key
name with TTL / encoding / size right-aligned on the same line, and the ⋮ action menu anchored at the
top right. Moving the type out of a leading badge gives the key name the whole row — about 40px more
for long keys.

#### Server information panel

Four tabs at the top right: **Redis info** (nine sections — Server / Clients / Memory / Persistence /
Stats / Replication / CPU / Cluster / Keyspace, each collapsible), **slow log**, **key memory
analysis** (aggregated by prefix, scanning up to 10,000 keys and keeping the 200 largest prefixes),
and **Pub/Sub subscriptions** (solid chips for channels, dashed chips for patterns, click × to
unsubscribe one).

<p>
  <img src="docs/screenshots/overview-info.png" width="49%" alt="Redis info · dark" />
  <img src="docs/screenshots/overview-info-light.png" width="49%" alt="Redis info · light" />
</p>

<p>
  <img src="docs/screenshots/overview-slowlog.png" width="49%" alt="Slow log" />
  <img src="docs/screenshots/overview-memory.png" width="49%" alt="Key memory analysis" />
</p>

<p>
  <img src="docs/screenshots/overview-pubsub.png" width="49%" alt="Pub/Sub subscriptions" />
</p>

#### Search, CLI and operation log

Full-database search pushes `SCAN` down to the main process, streaming progress as it goes and
cancellable at any time. The CLI keeps one tab per connection and echoes results inline. The
operation log records manual actions only and can be filtered by date or connection.

<p>
  <img src="docs/screenshots/search-result.png" width="49%" alt="Full-database search" />
  <img src="docs/screenshots/cli-console.png" width="49%" alt="CLI console" />
</p>

<p>
  <img src="docs/screenshots/operation-log.png" width="49%" alt="Operation log" />
  <img src="docs/screenshots/dialog-connection.png" width="49%" alt="New connection" />
</p>

#### New connection

Built on Cult UI's shadcn primitives (Dialog / Input / Label / Switch / Select / Button) with
semantic colour tokens that follow all nine skins. Supports SSH tunnels and multi-hop jump hosts.

<p>
  <img src="docs/screenshots/dialog-connection.png" width="49%" alt="New connection · dark" />
  <img src="docs/screenshots/dialog-connection-light.png" width="49%" alt="New connection · light" />
</p>

---

## What's implemented

**Core path**

- Window lifecycle, single-instance lock, separate dev and production load paths
- Connection config CRUD with local persistence; **passwords are encrypted with Electron `safeStorage`
  before hitting disk**
- Connection pool management: connect / disconnect / test / release everything
- Server information: version, mode, total keys, clients, memory, hit rate, OPS
- Key browsing: paged `SCAN` + pattern matching + client-side filtering + multi-DB switching
- Value viewing: read-only rendering for six types — string / hash / list / set / zset / stream.
  **JSON beautification is offered for `string` only** — only a block of text can meaningfully be
  re-indented; hash / list / set are already structured, and indenting each item makes rows uneven
  and lowers information density, so it is not offered; zset's member/score and stream's fixed shape
  leave nothing to beautify either.
  Container types support search: hash **matches on field only**; list/set/zset/stream filter by
  content (string is a single value, so no search).
- **string value toolbar**: sits above the value area (clearly separated from the key-level ⋮ menu at
  the top right). Six actions share one segmented control — edit, copy, JSON beautify, word wrap,
  export, refresh; JSON beautify and word wrap are view toggles that stay on by default, so they read
  as raised blocks and separate at a glance from the action buttons. With word wrap off, long lines
  scroll horizontally, which helps when comparing long strings; export goes through the main-process
  save dialog; character and line counts sit on the right.
- **hash value table**: the first column is a fixed-width (40px) **row-number column** that does not
  stretch or sort; numbers are re-issued in display order (after sorting it still reads 1, 2, 3…,
  meaning "the nth row"). field / value both sort on header click; the footer summarises field count,
  total bytes and the largest field.
- **hash value toolbar**: copy (all fields as JSON), export (JSON file), refresh; the **search box is
  pinned to the far right** and **matches fields only** (values are often long, and including them
  makes results hard to read); the right side shows "hits / total fields".
- **hash row actions**: each row ends with copy (field name + value) / edit / delete icon buttons
  (with tooltips), semi-transparent by default and clearly visible only on row hover, so they do not
  interfere with reading.
  "Edit" opens a dedicated dialog that can change field and value together; a rename is HDEL old +
  HSET new, and the dialog says so. Delete goes through `HDEL` (a new `redis:delHashField` IPC) with
  a second confirmation; deleting the last field makes Redis remove the key itself, which the copy
  explains.
- **hash row context menu (copy only, two groups)**:
  "Field" — copy name / copy value / copy name and value;
  "Other formats" — copy as an HSET command (paste into redis-cli to reproduce), copy as a JSON
  key-value pair.
  The field name is shown at the top so the target is unambiguous; the menu flips against the
  viewport to avoid overflow and closes on Esc / blank click / window resize.
- **Search box icons**: value-area search (hash field search, container element search) and the key
  list's "filter current results" share one structure — icon + input + clear button: the magnifier
  sits on the left, icon and border turn accent-coloured on focus, and a round clear button appears
  on the right when there is content. **The "match pattern" input next to the db selector has no
  icon** — it is a path-style pattern input, not a search.
- **list value UI**: reuses the hash table shape but **drops the field and TTL columns** (a list has
  no fields) — just row number / value / actions, with the number column fixed at 40px and not
  sortable. The value column sorts on header click, and elements can be searched and single rows
  selected (same structure as hash).
  Toolbar: copy all (joined by line), export as text, append to end, refresh, auto-refresh toggle,
  search; the footer summarises element count / matches / total bytes / longest element index /
  selection.
- **list row actions**: the context menu has only two groups — "Copy" (**copy field value** / LSET
  command / JSON) and "Position" (insert before this item, insert after this item);
  edit and delete moved to **inline icon buttons** (copy / edit / delete), and double-clicking a row
  also edits it. Edit and insert **share `EditListElementDialog.tsx`** (distinguished by `mode`) with
  an identical shape: a key preview bar on top (list type badge + full key name + `#pos/total` or
  `insert point #N`) and a **status bar** at the bottom (characters / lines / bytes; **edit mode** adds
  a change delta and disables Save when nothing changed; **insert mode** shows `N items after insert`,
  or `will append as item N` when appending). JSON content additionally shows "valid JSON" or "invalid
  JSON".
- **Delete confirmation dialog (structured)**: `ConfirmRequest` in `ConfirmDialog` supports
  `details` (key-value rows: grey label, highlighted value, monospace for data),
  `preview` (the content to be deleted in its own block, accent bar on the left, monospace, marked
  "truncated" when long) and
  `warning` (risk note, red background with a circular exclamation icon). All three are optional and
  compatible with the original `message`.
  **list delete** shows key name / position / size plus a preview of the content; **hash field delete**
  adds `field count N → N-1` and warns when it is the last one ("the whole key will be removed too").
  This separates metadata from content, so a wall of same-coloured text never hides the point.
- **set value UI**: table shape (row number / member / actions). **Row numbers stay, sorting and
  insertion are gone** — a set is unordered, so sorting would make "the nth item" jump around and
  insertion has no position to speak of; both would mislead. Numbers are a row count only (both the
  header tooltip and the footer say "does not imply storage order").
  Toolbar: copy all, export, **add member** (replacing list's "append"), refresh, auto-refresh
  toggle, search; the footer summarises member count / matches / total bytes / longest member.
  The context menu keeps only "Copy" (member content / SADD command / JSON) — an unordered set has no
  "position" group.
- **set member actions**: adds `redis:setSetMember` / `delSetMember` / `addSetMember`.
  **Editing a member means SREM old + SADD new** (the member is its own identity), done in a pipeline
  so both steps travel together. If the new member already existed, the UI says so plainly
  ("old member removed — X already existed") instead of letting the user think the edit failed.
  SADD is idempotent, so re-adding reports "already exists, not added again".
  The edit dialog reuses `EditListElementDialog`, adapted to unordered semantics through `item-label`
  / `key-type` / `show-position` (it says "member" and hides position).
- **zset value UI**: table shape (row number / member / score / actions).
  **Sorted by score descending by default** (the ZREVRANGE leaderboard view); clicking the score
  header toggles direction — order is the point of a zset (it is a collection ordered by score).
  The score column is **right-aligned** for easy comparison and tinted with the zset theme colour; the
  number column is the current rank.
  Toolbar: copy all, export, **add member**, refresh, auto-refresh, search; the footer summarises
  member count / matches / total bytes / **score range** (expressing the ordered semantics).
- **zset members are addressed by name, not index**: a zset reorders as scores change, so an index can
  shift at any moment; the member name is the stable identity — edit and delete both locate by member.
- **zset member actions**: adds `redis:setZsetMember` / `delZsetMember` / `addZsetMember`.
  **Changing the score** goes through ZADD update semantics (an existing member is updated);
  **renaming a member** goes through ZREM + ZADD (same pipeline round trip), and if the new name
  already exists the UI says "score updated" honestly.
  A score must be a finite number (Redis' native error is unfriendly, so it is validated first).
  The dedicated `EditZsetMemberDialog.tsx` takes member and score, shows the parsed score and member
  byte size live in the footer, and blocks submission with a red mark when the score is invalid.
- **stream value UI**: table shape (row number / entry ID / fields / actions), **read-only**.
  A stream is an append-only message log — editing past entries breaks consumer-position semantics and
  deleting entries punches holes in consumption, so only copy-style actions are offered: no add, edit
  or delete entry point.
  The number and action columns are fixed and **no column-resize handle is provided** (a read-only
  type needs no width tuning).
- **The "read-only" tag in the table footer**: all five table-shaped types (hash / list / set / zset /
  stream) show a "read-only" tag at the far right of the footer, opposite the operation hint on the
  left (`.row-tip` became `flex` with `.tip-text { flex: 1 }`).
  It means **the table itself is a read-only view**; changes go through the context menu or a row
  double-click (the tooltip says exactly that). For stream, being an append-only log, the tooltip adds
  its own note. string is not a table, so it shows no tag.
  The old "read-only" tag in the toolbar was removed — it describes the table, and putting it in the
  value status bar would blur it with global statistics.
- **No JSON beautification for stream fields**: fields are a flat `key=value` list rather than a nested
  structure, so re-indenting only stretches row height and cuts how much fits on one screen; they are
  shown as-is (unlike hash).
- **stream field column truncates to one line**: a field may be a long JSON blob or text, and
  `pre-wrap` would blow a single row up to a dozen lines, leaving two or three messages per screen;
  `nowrap` + `ellipsis` keeps row height consistent, with the full content available via tooltip or
  context-menu copy.
- **stream entry ID sorting**: **segment-wise numeric comparison** of "millisecond timestamp + sequence".
  Plain string comparison puts `…-10` before `…-9`, while Redis increments the sequence numerically.
- **Dialog button icons**: footer buttons all carry an icon before the text, provided by
  `src/components/DialogIcon.tsx`. Icons are named **semantically** (`cancel` / `save` / `close` /
  `check` / `test` / `copy` / `add` / `edit` / `trash`) — callers care about what the button does, so
  reshaping an icon does not require touching every call site.
  Spec: 16×16 viewBox, `stroke: currentColor` (follows the button text colour, works on primary and
  secondary buttons alike), 1.5 stroke (slightly heavier than inline table icons, since dialog buttons
  use a larger font).
  It is a component rather than inlined paths: the same icon set appears on 25 buttons across 12
  dialogs, and inlining would scatter hundreds of duplicate path lines through the codebase.
- **Dialog button radius**: footer buttons use the pill shape (`border-radius: 999px`).
  All 12 dialogs share `.dialog-foot`, with the rule centralised in `src/styles/main.css`.
  **The selector must carry two classes** (`.dialog-foot button.btn`): `body .dialog-foot button`
  loses against the component-level `.btn` rule — **a class selector outranks any number of element
  selectors**, so adding more `body`/`button` never buys a class of specificity and the rule is
  silently overridden (no error, the radius simply does not change).
  `ConfirmDialog`'s confirm button uses its own `.confirm-btn` class (without `.btn`), so it is not
  covered by that rule and declares the pill radius directly in the component.
  A pill's curved ends make equal horizontal padding look tighter, so the horizontal padding is
  slightly increased to compensate.
- **Dialog dragging**: all 12 dialogs can be dragged **by their title bar**.
  Provided by `src/hooks/useDialogDrag.ts` (`dragStyle` on `.dialog`, `onDragStart` on `.dialog-head`).
  Key points: movement uses `transform` rather than `top/left` (no reflow, and no fight with the
  flex-centred initial position); only the title bar initiates it (inputs and text selection in the
  body need normal mouse behaviour); the offset is clamped inside the viewport per dialog size
  (otherwise a dialog dragged off-screen has unreachable buttons); while dragging, `body` gets
  `.dialog-dragging` to lock the cursor and disable selection.
  Note that `body`-level rules must live in `src/styles/main.css`; component-scoped style files must
  not declare rules that attach to `body`.
- **stream entry viewer**: the first context-menu item, "View full content", opens
  `ViewStreamEntryDialog.tsx`. Fields in the table are truncated to one line, and the whole point of
  the viewer is **seeing everything**:
  fields are parsed into a **key-value table** (JSON objects and `key=value` both supported), with the
  value column **wrapping instead of truncating** (long values cap at 220px and scroll internally);
  when no structure can be parsed it falls back to the raw text (no explanatory copy — just show the
  content, rather than piling prose into a read-only dialog).
  The field area has a **"fields / JSON" view switch** at the top right, styled exactly like the
  "tree / flat" switch in the home page `KeyBrowser` (same border, same font size, accent fill when
  selected) — the same interaction looking different in two places reads as two different controls.
  The field view splits everything out for checking one field; the JSON view shows the beautified full
  text for copying wholesale. **The switch hides itself when the content is not JSON** (forcing
  `key=value` through a formatter only yields a quoted string).
  The dialog also shows the entry ID's **readable time** (converted from the millisecond timestamp) and
  its position `#N / total`.
  It is a separate component rather than a reuse of the edit dialog: the latter has an editable
  textarea in the middle, and an editable box with no Save button in a read-only log would be a
  semantic contradiction.
- **stream statistics**: the footer shows entry count / matches / total bytes / **entry ID range** (the
  message time span; long IDs are abbreviated with the full value on hover).
- **Switching keys closes every row menu**: hash / list / set / zset / stream each keep independent
  menu state, all cleared by `closeAllRowMenus()` (called on Esc, window resize and key switch) —
  closing only the current type leaves a popover that "appears out of nowhere" when you switch back.
- **Column resizing (hash / zset)**: each header cell has a drag handle on its right edge (a hairline
  appears on hover, turning accent while dragging); drag to resize, **double-click to reset**. Only
  hash and zset support it, and **only for the current session** (deliberately not persisted).
  Implementation notes: widths are driven by the CSS variables `--w-first` / `--w-second`, so dragging
  changes one number instead of concatenating a `grid-template-columns` string; the handle is
  absolutely positioned against the **header cell** rather than being its own grid item, which would
  add a column and misalign header and body; the width is computed as "start width + total delta"
  rather than accumulated step by step, avoiding sub-pixel drift; the range is clamped to 80–900px.
  While dragging, `body` gets `.col-resizing` to lock the cursor and disable text selection.
- **Header style**: weight 600 in the secondary colour (`--text-secondary`), against body rows in the
  primary colour at normal weight. Bolding without brightening gets muddier on dark themes — bold text
  at a small size and low contrast actually reduces legibility, so the two must move together.
- **Sort indicators are SVG triangles** (`src/components/SortIcon.tsx`), replacing the `⇅ / ↑ / ↓`
  characters: character arrows differ in weight and baseline across fonts, and `⇅` in particular
  smears at small sizes; a triangle is pure geometry, so scaling and alignment stay controllable. The
  three states are **unsorted (both triangles, opacity 0.28, rising to 0.55 on hover)** / **ascending
  (solid up triangle)** / **descending (solid down triangle)**, using `fill: currentColor` to follow the
  header and inheriting the `.th.on` accent colour when sorting is active. It is a component rather
  than six repeated ternaries.
- **Local updates after an action**: deleting / inserting / editing list elements and hash fields, and
  deleting a hash field, **touch only the affected data instead of re-reading the whole table**.
  The reason: `refreshSelected()` runs `selectKey` and sets `loadingValue`, flashing the skeleton — a
  one-row change looks like a full page reload.
  `dropElementLocally()` / `insertElementLocally()` / `replaceElementLocally()` /
  `renameFieldLocally()` mutate `selectedValue` directly and keep `length` in sync with zero IPC
  round trips, while maintaining related state (the field TTL cache, clearing the selection when the
  last element is deleted).
  **Reads are still kept** for: the toolbar refresh button (the user asked for a re-read), the
  auto-refresh timer (its purpose is freshness) and setting a field TTL (the TTL is computed
  server-side).
- **Refresh vs. skeleton**: `selectKey` takes a `silent` flag to distinguish two kinds of read —
  **switching keys** shows the skeleton (the whole content is replaced, and the skeleton avoids layout
  jumps); **refreshing the current key** (toolbar refresh / auto-refresh / after saving a dialog /
  changing a field TTL) sets `state.refreshingValue` and overlays a **translucent veil with a spinner**
  on the value area, leaving the page structure and interactive regions (header, toolbar, footer)
  intact. Translucency rather than a solid fill says "the content is still there, just updating",
  semantically distinct from the skeleton's "content is about to be replaced".
- **Loading animation**: clicking a key shows a **skeleton** on the right (header bar / toolbar / six
  placeholder rows), each row offset by 70ms for a top-down flow. A skeleton rather than a spinner
  because it preserves the real layout dimensions, so nothing jumps when data arrives.
- **hash auto-refresh**: a **slider switch** in the toolbar (32×18; the track turns accent, the knob
  slides and a breathing dot animates when on), not a native checkbox look. Note that the global
  `input { background / border / padding }` rule hits this control, so the native input needs
  `appearance: none` and each of those properties overridden (`opacity: 0` alone still shows the
  default box).
  When on it re-reads the current hash **every 5 seconds** (off by default).
  Three situations skip a tick to avoid interrupting work or piling up requests: a dialog is open
  (edit / TTL / rename menu), a context menu is open (it is anchored to a specific row), or the
  previous read has not returned (no stacking on slow connections).
  It switches off automatically when moving to a non-hash type, and the timer is cleared on unmount.
- **hash single-row selection**: click a row to select (accent bar on the left, tinted background,
  highlighted number), click again to deselect; right-clicking selects the row as well, so the menu
  target matches the highlight; the footer shows the selected field name.
  Selection and hover are clearly distinct — hover disappears with the mouse, selection persists.
- **hash field-level TTL (Redis 7.4+)**: `HEXPIRE` / `HTTL` / `HPERSIST` arrived in 7.4.0, and older
  versions answer `unknown command` rather than degrading gracefully.
  The UI **renders the TTL column based on the connection's `redis_version`**, conservatively hiding it
  when the version is unknown; the column is clickable to set a TTL (numeric box + common values +
  permanent), and the footer explains when the capability is unavailable.
  Version checks and capability derivation live in `src/utils/redisCapability.ts` for easy extension.
- **Version information**: the connection menu gains "Version info…", showing the version and
  deployment mode, **capability findings** (field-level TTL, ACL, threaded IO and so on) and detailed
  fields grouped by INFO section (Server / Clients / Memory / Persistence / Stats / Replication / CPU /
  Keyspace), with a "key items only" toggle and "copy full INFO".
- Value editing: never inline; a dedicated dialog opens from the ⋮ menu, and writes carry the original
  TTL so a full key rebuild does not lose the expiry.
- Key actions: rename, TTL change, delete (all via the menu, delete with a second confirmation).
- CLI console: command parsing (quotes supported), result formatting, history (↑↓).
  **Dangerous command guard**: `FLUSHALL` / `FLUSHDB` / `SHUTDOWN` prompt for confirmation and require
  typing the command name literally (not a soft "click to confirm"), and cancelling leaves a record in
  the console.

**Interface capabilities**

- **Theme**: follow system / light / dark, following the system by default; the choice is persisted
  to `localStorage`, and an inline script in `index.html` presets `data-theme` on the first frame to
  avoid a flash. The window background follows the system too.
- **Key tree**: keys are split on the separator (default `:`, configurable to `/`, `-` and so on) and
  folded level by level, **collapsed by default** (the "collapse all" button shows as selected).
  Supports expanding level by level, expand-all / collapse-all (buttons carry selected state, turning
  into neither-selected "custom" once you adjust levels by hand) and a one-click switch back to flat
  view.

  **When collapse state resets**: only when the **dataset identity** (connection + database + match
  pattern) changes — those three decide which keys you are looking at, and the old tree is meaningless
  after a switch.
  **Deleting / creating / renaming a key is just data change, and the user's expand-collapse state is
  preserved in full.**
  The criterion is deliberately dataset identity rather than "did the tree structure change": the
  latter misfires on paging, deletion, filtering and any other data change, collapsing a directory the
  user just opened (or the reverse).
  "Continue scanning" (incremental append) likewise preserves the current expansion.
- **New key**: the ＋ button in the key browser toolbar opens a dialog for string / hash / list / set /
  zset, with initial content and an optional TTL; on success the ancestor path expands and the new key
  is selected.
  Container types require at least one element (a Redis container key only exists once it has one).
- **Connection menu**: connect / disconnect, refresh server metrics, **version info**, test connection,
  edit config, clone connection, copy connection URL (`redis://…`), delete connection.
- **SSH tunnel**: reach a Redis instance that only answers on an internal or loopback address through a
  jump host. Tick "connect through SSH tunnel" in the new-connection dialog to expand the settings:

  | Field | Notes |
  | --- | --- |
  | Jump host / port | The SSH server, port 22 by default |
  | SSH user | Account used to log into the jump host |
  | Authentication | **Password** or **private key** (paste it or read it from a file) |
  | Key passphrase | Fill in when the key itself is encrypted; leave empty otherwise |

  How it works (`electron/services/ssh-tunnel.ts`): after the SSH connection is established, a
  system-assigned free port is opened on local `127.0.0.1`; every local connection opens a
  direct-tcpip channel to `target:port` via `forwardOut` and pipes both ways.
  ioredis only talks to the local port — **the layers above know nothing about SSH**.

  - Why not hand a single `forwardOut` channel to ioredis: ioredis opens and reopens connections on its
    own and cannot accept an already-established socket; a local listening port is the only way to keep
    plain-TCP semantics.
  - Tunnels are cached per connection id: `test` and `connect` on the same config create one tunnel,
    avoiding duplicate SSH handshakes and rate limits on the jump host.
  - **Lifecycle**: opened when the connection is established, closed on disconnect / connection failure
    / probe completion, leaving no idle sessions on the jump host.
  - **Credential safety**: the SSH password and key passphrase are treated like the Redis password and
    encrypted with `safeStorage` before hitting disk (the key body itself is not encrypted — the user
    pasted it from a local file that already sits on disk, and encrypting it would only slow reads and
    writes).
  - The connection row shows an `SSH` badge (jump host on hover), so a failing connection cannot be
    confused between "direct address" and "jump host address".
- **CLI console collapsed by default**: the command line is a low-frequency capability, and leaving it
  expanded permanently costs about a quarter of the vertical space. By default only a single entry row
  remains (title + current connection hint) and a click expands it; the collapsed state is not
  persisted, so every launch starts collapsed.
- **Server overview cards**: when connected but no key is selected, the right-hand side shows three
  equal-width cards — **server** (Redis version / mode / process ID), **memory** (used memory / Lua
  usage / ops per second) and **status** (clients / total keys / hit rate), each with a semantic icon
  before the title.
  The top shows "connection name + host:port + SSH badge" and **a single refresh button** that
  refreshes both the overview and the details below (both come from one INFO call; refreshing them
  separately would show inconsistent numbers); the button is disabled and its icon spins while
  refreshing. The hit rate is coloured by threshold (≥95% normal, <90% flagged).
  Cards use `auto-fit + minmax(200px, 1fr)` and wrap when squeezed below the threshold.
  Note: the Lua memory field differs by version (7.0+ has `used_memory_lua_human`); earlier versions
  fall back to the byte count in `used_memory_lua` and convert it.
- **Redis info card**: the full-width card below the overview, showing every field grouped by INFO
  section (Server / Clients / Memory / Persistence / Stats / Replication / Cluster / Keyspace).
  - **Loaded on demand**: a full INFO can be tens of KB, so it is not fetched with the connection but
    once when first rendered; switching connections clears and refetches it, so instance-bound fields
    like `run_id` and `config_file` never bleed across connections.
  - Sections use CSS `columns` to flow naturally (field counts vary widely, and a fixed grid would
    leave large gaps) and collapse individually; field names are localised, and rare ones not in the
    map are shown as-is.
  - Over-long values are ellipsised with a tooltip, keeping the panel scannable rather than fully
    exposed.
- **Welcome page**: with no connections configured, the main area shows the local runtime (Electron /
  Chromium / Node / V8 / platform) and Redis quick reference (default port, connection string format,
  common commands).
- **Global settings**: UI font size (12–16px, all sizes derived from `--fs-base`), UI font, code font,
  density, keys per page, default key separator, delete confirmation, log retention days, plus
  **theme, view mode (tree/flat), CLI expanded state, last used connection and database, tree expansion
  state**; persisted in `settings.json`.
  - **Location (portable mode)**: `config/` next to the executable — copy the whole folder and all
    settings and logs come along. If the program directory is not writable (installed under
    `C:\Program Files\`, say), it falls back to the system directory (Windows `%APPDATA%\Keyper\`) and
    the settings UI states the reason.
  - The `KEYPER_CONFIG_DIR` environment variable can point anywhere.
  - Resolution lives in `electron/services/config-path.ts` (result cached, so every read and write does
    not re-probe with a test file).
- **Operation log**: records **manual actions only** (CLI commands, key create/update/delete, connection
  and config changes). Recording happens at the IPC layer, so automatic work inside the main process
  never passes through IPC and is naturally excluded; read operations (scan / value / info) are not
  recorded either, so browsing does not drown out the important entries.
  Files are sharded by day under `<config dir>/logs/yyyymmdd.log`, one line per record for easy
  grepping, filterable by date / connection / keyword, with expired files cleaned up automatically
  (30 days by default).
  **Operations severity**: deletions are red (`danger`), changes (writes / creates / renames / TTL /
  saving config) are amber (`change`) — a colour bar on the left plus a tinted action name, with a
  one-click "changes only" filter that hides command runs and connection events.
  Severity is derived from action-name keywords in `logSeverity()` (`src/utils/log.ts`), so new actions
  fall into place automatically; `FLUSHALL` / `FLUSHDB` / `SHUTDOWN` typed in the CLI are marked
  `danger` too (the detail text is matched as well).
- **Key list paging**: cursor-based `SCAN` loading, with "loaded N / total in db" at the bottom and
  "load more" (one more page) plus "load all" (scan until the cursor is zero, capped at 5,000 keys so
  the UI stays responsive).
- **Key context menu**: tree and flat modes share one menu (tree nodes emit the right-click and
  `KeyBrowser` renders it at the top level) — one menu per recursive node would fill a long list with
  hidden popovers.
  There are **two shapes**, decided by "has children + is it a real key" (**not by depth**):

  | Target | Condition | Menu |
  |---|---|---|
  | Single key | Flat item / any key that exists (`node.leaf`) | View value · Copy (name / value / as command) · Manage (rename / TTL) · Delete key |
  | Subtree | Top-level node **and has children** (`depth === 0 && children.length > 0`) | **Batch delete N keys** |

  ⚠️ **Top level is not the same as subtree**: a key without separators (such as `healthcheck`) is also
  top-level in the tree, but it is an atomic node, not a prefix — it must use the single-key menu, or
  you lose every single-key action and end up with the awkward "batch delete 1 key".
  A subtree target represents a prefix, and deleting means **deleting every key under that prefix**
  (all levels inside, plus the node itself if it is also a key). Deep directory nodes (children only,
  not a key themselves) do not respond.
  **Right-clicking an atomic key selects the row** (selection only, no value read — use "view value"
  in the menu); a prefix subtree is not selectable, since it is not a key and has no value.
  "Copy value" reads once when the target is not the current key (the key list holds metadata only);
  "copy as command" generates **read commands only** (`GET` / `HGETALL` / `LRANGE`…), never destructive
  ones, so a careless paste cannot run them.
  Menu icons use SVG (`DialogIcon`) rather than emoji or special characters — emoji render through
  system colour fonts, clash with line icons and differ across platforms, while symbol characters shift
  baseline and width with the font and stop lining up.
  The menu **measures its real size after rendering** before flipping and clamping (the two shapes
  differ about threefold in height, and a fixed estimate would make short menus jump); Esc / blank click
  / window resize all close it.
- **Delete confirmation**: deleting a key prompts first, in four layers — one-line summary + structured
  details + preview + risk note. A single key shows **name / type / expiry** so the target can be
  verified; a batch shows the **count** and the **list of key names** (marked "truncated" beyond 30).
  The confirm button is the danger colour and its label follows the count ("Delete 12 keys"). Can be
  turned off in settings.
- **Tooltips**: the project **never uses native `title`**; all tooltips are self-drawn.
  Native tooltips are drawn by the OS, appear after about a second and cannot be styled — a bright
  bubble in a dark theme is jarring.
  The React version spreads `tipProps()` onto the element (`src/components/tip.ts`) without adding DOM
  nodes, and a single global bubble is mounted once by `AppTooltip.tsx` in `App`:
  ```tsx
  <button {...tipProps('Copy all content')}>…</button>        {/* plain text */}
  <span {...tipProps(row.field)}>{row.field}</span>          {/* dynamic text */}
  <button {...tipProps({ text: 'Re-read this key', placement: 'bottom' })}>…</button>
  ```
  Rules: **above by default, flipping automatically when there is no room**; wraps beyond 40 characters
  (`maxWidth: 320px`) while short labels stay on one line; clamped horizontally inside the viewport;
  hides on scroll / resize / click / unmount.
  The positioning algorithm is covered by `tests/unit` and by browser probe scripts.
  **Nested bindings** (a tab that contains its own close ×) get dedicated handling: moving the
  pointer from the child back onto the parent restores the parent's tooltip instead of losing it —
  the pointer never left the parent, so the parent's `mouseenter` never fires again.
  ⚠️ **`tipProps` and `title` must not coexist** — the browser still shows the native tooltip and the two
  bubbles overlap. Note also that `title` on components such as `PromptDialog` is a **component prop**
  (the dialog title), not a tooltip; do not "fix" it.

## Roadmap

1. **Connection coverage**: Sentinel / Cluster mode, connection import and export
2. **Performance and ergonomics**: paged loading for large keys, incremental key list refresh, virtual
   scrolling for more types
3. **Feature depth**: monitoring charts, keyspace notifications, Memcached batch operations
4. **Engineering**: CI packaging, incremental updates (electron-updater), smaller installers

---

## Security

- The renderer enables `contextIsolation` and disables `nodeIntegration`; main-process capabilities are
  reachable only through whitelisted IPC
- Connection passwords are encrypted with the system keychain where available, degrading to plaintext
  storage only when it is not (marked with a `raw:` prefix)
- Production builds can tighten further: load a `Content-Security-Policy` for the renderer and enable
  `sandbox: true` (which requires turning the preload into a pure IPC bridge without `require`)




