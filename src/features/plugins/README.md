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
    remote marketplace)                    ▼
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
  issues. Remote marketplace plugins are untrusted; bundled catalog plugins use
  the same validator so official data cannot drift from the runtime contract.
- **`storage/pluginState.ts`** — per-plugin enable state in `chrome.storage.local`.
- **`sources/` `entitlement/`** — the swap points for native first-party
  features, bundled official declarative plugins, remote marketplace plugins,
  and a future paid (Stripe/account) store.
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
authoring shape is `{ "file": "style.css" }` next to `plugin.json`. Bundled and
marketplace sources both resolve that CSS, reject remote-resource loads
(`@import`, external `url()`), and normalize it before the runtime sees it. For
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
- **Third-party/experimental CSS+JSON plugins** can still arrive from the remote
  marketplace. They never fetch executable code.

## What is NOT done yet (next milestones)

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
