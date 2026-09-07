# Plugin Ecosystem (`src/features/plugins`)

A self-contained subsystem that lets Voyager run **plugins** — units that inject
styles / DOM changes into AI chat sites (Gemini, AI Studio, ChatGPT, Claude,
DeepSeek, …). Voyager's own features can migrate onto this over time; third parties
can ship their own plugins against the same contract.

## Two design constraints that shaped everything

1. **Chrome MV3 forbids remotely-hosted code.** You may download _data_ (JSON/CSS)
   and run it through engine logic that ships **inside** the package; you may not
   download and execute JS. (`chrome.userScripts` is the only sanctioned escape
   hatch, and it's gated behind a per-user "Allow User Scripts" toggle and is
   unavailable on Safari.)
2. **The core is GPL-3.0 with many copyright holders.** It can't be relicensed or
   closed. Monetizable / proprietary plugins must therefore be **independent works**
   — and _data read by a GPL engine is not a derivative work of it._

Both constraints point at the same answer → **declarative-first** plugins.

## Two tiers

| Tier                    | Ships                       | Store-safe                     | Runs on                   | Status                                          |
| ----------------------- | --------------------------- | ------------------------------ | ------------------------- | ----------------------------------------------- |
| `declarative` (default) | CSS + JSON (`domOps`)       | ✅ everywhere, remote-loadable | Chrome / Firefox / Safari | **implemented**                                 |
| `scripted` (advanced)   | JS via `chrome.userScripts` | gated toggle, no Safari        | Chrome / Firefox          | reserved (gated, runtime is a future milestone) |

## Architecture

```
PluginSource[]  ──►  manifests        SiteRegistry ──► SiteAdapter (current URL)
   (native builtin,
    bundled catalog,
    remote host catalog)                   ▼
pluginState (storage) ─► enabled?    DeclarativeEngine (interprets contributions)
EntitlementProvider  ─► entitled?         │  styles + domOps, reversible, idempotent
        └──────────►  PluginHost.reconcile() ──► engine.mount/unmount
```

- **`types.ts`** — the whole contract: `PluginManifest`, `PluginContributions`,
  `DomOperation` (discriminated union — the main extension point), `SiteAdapter`,
  and the `PluginSource` / `EntitlementProvider` seams.
- **`sites/`** — `SiteAdapter` per site + a `SiteRegistry` that resolves the
  current URL. Site-specific selectors live **only** here, behind semantic keys
  (`userTurn`, `composer`, …), so a site redesign is a one-file fix.
- **`runtime/declarativeEngine.ts`** — applies a manifest's `styles` + `domOps`.
  Reversible (full teardown), idempotent, and uses a `childList`-only
  MutationObserver so its own mutations can't loop. Pure DOM → all platforms.
- **`runtime/PluginHost.ts`** — orchestrator. Loads manifests, checks
  match-URL + enabled + engine-range + entitlement, mounts/unmounts, reacts to
  state changes. All dependencies injected → fully unit-testable.
- **`manifest/validate.ts`** — turns `unknown` into a typed manifest or a list of
  issues. Remote catalog plugins are untrusted; bundled catalog plugins use
  the same validator so official data cannot drift from the runtime contract.
- **`storage/pluginState.ts`** — per-plugin enable state in `chrome.storage.local`.
- **`sources/` `entitlement/`** — the swap points for native first-party
  features, bundled official declarative plugins, the per-host remote catalog,
  and a future paid (Stripe/account) store. `sources/defaultSources.ts` also
  owns `mergePluginRecords`, the rules that pick which copy of a plugin id wins.
- **`remote/`** — the per-host remote catalog channel: a read-only source over a
  storage cache, plus a background-only fetcher. See below.
- **`catalog/`** — official declarative plugins bundled with the extension. This
  keeps official CSS/JSON changes in the same PR, CI run, and release as engine
  or popup changes.

## Authoring a declarative plugin

```jsonc
{
  "id": "vendor.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "...",
  "author": "...",
  "category": "readability",
  "license": "MIT",
  "engine": ">=1.0.0",
  "tier": "declarative",
  "matches": ["https://claude.ai/*"],
  "contributes": {
    "styles": [{ "file": "style.css" }],
    "domOps": [{ "op": "addClass", "target": "body", "className": "gv-plugin-readable" }],
  },
}
```

Manifests may keep tiny CSS inline with `{ "css": "..." }`, but the preferred
authoring shape is `{ "file": "style.css" }` next to `plugin.json`. The bundled
source and the published catalog file both resolve that CSS to inline text,
reject remote-resource loads (`@import`, external `url()`), and normalize it
before the runtime sees it. For
user settings, `{{settingKey}}` tokens can be used in CSS text or in
`setAttribute` / `setStyle` DOM op values; a common pattern is for CSS files to
use a normal custom property and for a `setStyle` op to set that variable from a
setting.

`target` is a CSS selector string, or `{ "kind": "semantic", "key": "userTurn" }`
to use the site adapter's stable selector. Supported ops: `addClass`,
`setAttribute`, `setStyle`, `hide`. All are reversible. Classes must be `gv-`
prefixed (content-script rule).

## Boundaries

- **Official CSS/JSON plugins** live in `catalog/` and load through
  `BundledCatalogPluginSource`.
- **First-party features that need JS** live in `builtin/` and register native
  handlers in the content script. `voyager.formula-copy` is the model here.
- **Updates to those official plugins** can also reach users between releases
  through the per-host remote catalog below. Only data travels; executable code
  never does.

## Remote host catalog (`remote/`)

The official CSS/JSON plugins ship as a snapshot inside the extension, and the
same data is published per site at `<base>/hosts/<host>.json` (default base
`https://voyager.nagi.fun/catalog`, so DeepSeek is
`https://voyager.nagi.fun/catalog/hosts/chat.deepseek.com.json`). A selector fix
can therefore reach users without a store release, while the engine that reads
the data still ships in the package.

- **`remote/HostCatalogSource.ts`** — a read-only `PluginSource`
  (`kind: 'remote'`). `list({ host })` serves whatever the cache holds for that
  host and never touches the network, so page loads, popup opens and
  catalog-change reloads all stay local. It is authoritative for a host only
  when the cached entry is a successful fetch written by the running extension
  version.
- **`remote/hostCatalogRefresh.ts`** — the only network writer, and it runs in
  the background only. Single flight per host, so concurrent tabs share one
  pass. Gates in order: the build flag; the host shape (plain hostnames, no
  wildcards or ports); the user settings (online-updates switch, check interval
  counted from the last attempt, failure backoff, writer-version staleness); and
  page eligibility, meaning at least one **enabled** plugin targets the host.
  Gemini and AI Studio have no plugins, so they never pass the last gate and
  never produce a request. A manual check sends `force` and skips every gate
  except the build flag.
- **`remote/hostCatalogPolicy.ts`** — the pure rules the background and the
  content script must agree on (which hosts may be looked up, when a check is
  due, the backoff curve, when a cached entry may be used at all), each one
  directly testable without storage or network.
- **`remote/hostCatalogCache.ts`** — one entry per host under
  `StorageKeys.PLUGIN_HOST_CATALOG_PREFIX`, i.e. `gvPluginHostCatalog:<host>` in
  `chrome.storage.local`. Readers subscribe to **content** changes only:
  recording a failed or byte-identical attempt must not remount plugin CSS or
  feed back into another refresh.
- **`remote/hostCatalogFile.ts`** — validates the published file (`format: 1`,
  matching `host`, a plugin array), which `scripts/build-plugin-catalog.ts`
  generates from `catalog/` with the CSS inlined. Every entry passes the same
  `validateManifest` as the bundled snapshot; a bad entry is skipped and logged,
  a bad file is discarded whole.
- **`remote/config.ts`** — build-time flags injected through Vite `define`:
  `VOYAGER_PLUGIN_CATALOG_URL` repoints the base URL (https only) for a preview
  environment, and `VOYAGER_PLUGIN_CATALOG_REMOTE=off` compiles a build that
  never contacts the catalog host, leaving the bundled snapshot as the only
  source. The second flag is the store-review fallback.

**Settings** live in `chrome.storage.sync` and are covered by
`SettingsBackupService`: `gvPluginOnlineUpdatesEnabled` (master switch, on by
default) and `gvPluginCatalogCheckInterval` (`1h` / `6h` / `24h` / `manual`,
default `6h`). The popup surfaces both on plugin sites, plus a manual check that
works even when the switch is off.

**Message**: a content script or the popup sends `gv.pluginCatalog.refresh`
(`PLUGIN_CATALOG_REFRESH_MESSAGE` in `runtime/messages.ts`) with
`{ host, force }`. The background decides and writes the cache entry; nothing
else fetches.

**Merge rules** — `mergePluginRecords` in `sources/defaultSources.ts`, per
plugin id:

- builtin ids always come from `builtin/`; a remote entry with the same id is
  ignored, so first-party scope and settings can never be rewritten remotely;
- a remote entry whose `engine` range this build satisfies replaces the bundled
  copy;
- if the remote entry needs a newer engine, the bundled copy stays and carries
  `blockedUpdate`, which the popup renders as "needs a newer Voyager" (when
  neither copy is compatible the remote one is listed and the status machine
  reports needs-engine);
- when the remote catalog is authoritative for the host, a bundled plugin that
  targets the page and is absent from the catalog is dropped: the kill switch;
- a 404, a failed fetch, or an entry written by a different extension version
  contributes nothing, so the bundled snapshot stays in force until the next
  successful fetch.

## What is NOT done yet (next milestones)

- **A remote-only NEW site.** The catalog updates plugins for hosts the
  extension already knows: the file is fetched per host, but site adapters, host
  permissions and manifest entries still ship in the package. Adding a site is
  still an extension release.
- **Full setting UI coverage.** The schema accepts boolean/string/color/select;
  the popup currently renders boolean switches and number/range controls, while
  string, color and select controls remain future work.
- **Scripted runtime** via gated `chrome.userScripts`.
- **Account + Stripe entitlement**.

## Platform notes

- **Safari**: declarative only (no `userScripts`, App Store review). Cross-site
  dynamic registration is limited — keep Safari on manifest-declared sites.
- **Firefox**: declarative works; `userScripts` exists but differs; AMO review
  forbids remote code (declarative is the safe path).
- **Chrome/Edge**: full support, including the future gated `scripted` tier.
