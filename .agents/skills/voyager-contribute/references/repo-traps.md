# Repository-Specific Traps

Every item below cost a real contributor at least one review round (source PR in parentheses). CI catches none of them — read this before writing code, not after review.

## Git and PR mechanics

- **This repository squash-merges.** After your PR merges, your local branch will show as unmerged or conflicting — that is normal. Delete it and branch fresh from `main`; never re-open a PR from the old branch (#867 was closed as a self-duplicate created exactly this way).
- **The PR title becomes the squash commit header.** Title it `type(scope): imperative summary` — never the branch name or "Fixes #N" (#859, #865, #867).
- **Check `git diff origin/main --stat` (or whichever remote tracks the base repository's `main`) before opening the PR** so unrelated churn (assets, lockfiles) never rides along (#865 accidentally wiped `sponsors.svg`).
- **`@codex review` triggers the automated review** (bare `@codex` does nothing). Trigger it once per new head, re-trigger after any rebase/force-push, and don't re-trigger while a run is pending (#854). The human reviewer finalizes only after Codex has covered the exact current head SHA.

## Reuse the sibling precedent

Grep for the existing primitive before writing parallel logic — reviewers treat a one-off reimplementation of an existing behavior as a defect:

- Send/keyboard handling: reuse the `sendBehavior` detector — it already handles localized labels (发送/送信/enviar) and icon-only buttons, and respects the `gvCtrlEnterSend` setting. An English-only selector or unconditional Enter handler will be rejected (#854).
- Text insertion: `chatInput` has multiline-aware insertion; a bare `createTextNode` path flattens multiline prompt bodies (#854).
- Export CSS: extend a shared style builder (see `buildKatexExportStyles`) instead of pasting CSS into a second export service (#847).
- Export DOM walking: `DOMContentExtractor` must use ONE shared DOM-order traversal helper — Gemini nests arbitrary `section`/`div`/`response-element` layers, and any second code path will miss one (#847 spent 4+ rounds on this).
- Body-level popovers, global listeners, overlays: copy an existing `gv-pm-*` integration (close-outside handlers, teardown, theme overrides).

## New-site features go through the plugin system

- Adding support for a new site (ChatGPT, Claude, …) goes through the plugin system: declarative CSS+JSON plugins belong in the bundled catalog (`src/features/plugins/catalog/` via `BundledCatalogPluginSource`); only native-function plugins that genuinely need JS go in `src/features/plugins/builtin/` with default-disabled state, optional host permission, dynamic content-script registration, and a `start`/`stop` lifecycle with teardown. Never add static `content_scripts` or required `host_permissions` to `manifest*.json` — manifest permission escalation without prior Issue approval is a hard stop (#865).
- Platform registries are additive: never delete or narrow another platform's adapter or tests to make room for yours (#865).
- Any storage-toggled feature needs a full lifecycle — working start AND destroy at page load and on runtime toggle. Hiding the UI is not disabling the feature (#854).

## Docs and locale mirrors

- "The docs" are 20+ surfaces: the main `README.md`, nine `.github/README_*.md` locale mirrors, ten `docs/<locale>/` trees, and `docs/public/llms*.txt`. The green `i18n` CI check only compares `src/locales/*/messages.json` keys — it covers none of these (#874, #853).
- Never delete a published docs route — there is no redirect layer, so replace retired pages with a localized notice at the original URL (#874).

## Theme and data correctness

- Theme resolution order: `.theme-host.light-theme` / `.theme-host.dark-theme` first, generic `body`/`html`/data-theme markers second, `prefers-color-scheme` as fallback only. Write tests with _conflicting_ markers, not single signals (#859).
- Theme the whole export artifact consistently — a dark diagram on a forced-white document is not dark-mode support (#847).
- Gemini conversation IDs are namespaced (`gemini:conv:<id>`); shared code that handles raw IDs silently orphans existing starred/bookmark data (#865). Preserve `/u/<index>/...` account scope in every constructed route.
- Prompt/folder data has multiple merge entry points (`utils/merge.ts` plus page-level Drive merges); route data-shape changes through one shared merge helper, and never drop or rename existing user records on conflict (#854).
- A committed `REGRESSION_NOTES.md` entry must reference the real PR/commit, not a placeholder (#859).

## Scope discipline

- The reviewer diffs your behavior against the Issue's confirmed scope and blocks deviations in either direction. When an edge case tempts you to change a product constraint (e.g. enforce name uniqueness), ask in the Issue first (#854); state non-goals explicitly in the PR description.
- Trivially verifiable one-line fixes may go straight to PR (#876); features always need prior Issue approval (#865).
