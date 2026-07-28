# CLAUDE.md - Gemini Voyager

## Commands

```bash
bun install                # Setup
bun run dev:chrome         # Dev (also: dev, dev:firefox, dev:safari, dev:chrome-open)
bun run build:chrome       # Build Chrome (also: build, build:firefox, build:safari)
bun run build:edge         # Edge package (runs Chrome build, adjusts manifest, creates zip)
bun run build:all          # Build Chrome + Firefox + Safari (does not include Edge)
bun run build:browsers     # Build Chrome + Edge + Firefox + Safari
bun run test               # Test (also: test:watch, test:ui, test:coverage)
bun run typecheck          # Type check
bun run lint               # Lint and auto-fix
bun run format             # Format
bun run verify:pr          # Standard local PR automation (excludes native/live browser tests)
bun run bump               # Bump package/manifest versions and run format
bun run docs:dev           # Docs dev server
bun run docs:build         # Build docs
bun run docs:preview       # Preview built docs
```

## Chrome Development Builds

- Use `bun run dev:chrome` for routine Chrome development. It watches the source and writes complete builds to `dist_chrome_dev`.
- Load and reload `dist_chrome_dev` in Chrome when testing local changes.
- `bun run build:chrome` and `bun run build:all` write production artifacts to `dist_chrome`; use them for production verification and releases, not as the normal local development target.

## Core Rules

Path-scoped rules live in `.claude/rules/` and load automatically by glob: `typescript.md` (src/**/*.ts(x)), `content-scripts.md` (src/pages/content/** and public/contentStyle.css), `i18n.md` (src/locales/**), `high-complexity.md` (core storage/sync services plus folder/export services and content modules).

Project-wide rules (always in effect):

1. **Never modify `dist_*` folders directly.**
2. **Never commit `.env` or secrets.**
3. **Never grant a page or feature direct `<all_urls>` permission.** If it is truly unavoidable, discuss it with the user first and get explicit approval before implementation.
4. **When adding Material Symbol icons**, the popup uses the bundled font in `public/fonts/`; verify the glyph exists locally or update the bundled font assets. Do not add a remote Google Fonts URL.
5. **For GitHub issue/PR/comment work, prefer `gh` as the source of truth** instead of browser scraping or unstable connectors.
6. **After fixing an issue with a pushed `Fixes #xxx` / `Closes #xxx` commit or PR**, leave a short GitHub comment in the reporter's language: the fix has landed, it will be available in the next version, and they are welcome to reopen the issue if the problem remains.
7. **Default push target**: when asked to push without explicit branch/PR instructions, push a fast-forward update to `origin/main`. Never force-push unless explicitly requested.
8. **Regression notes are required context.** Before implementing a non-trivial feature or bug fix, skim `.github/docs/REGRESSION_NOTES.md` for related traps. After fixing a non-obvious bug that future maintainers could plausibly repeat, proactively suggest adding a short entry with the protecting test or verification command.
9. **Do not force-refresh Gemini's SPA for feature navigation.** For Gemini content-script navigation, prefer native in-app links first and History API / router events as the fallback. Do not introduce `location.assign`, `location.href`, or `location.reload` for normal conversation/session navigation unless the user explicitly accepts a full page reload. Preserve `/u/<index>/...` account scope when constructing routes.

## Verification (run before declaring done)

1. `bun run typecheck` — after any `.ts`/`.tsx` change
2. `bun run lint` — before finishing; note this runs `eslint . --fix`, so inspect resulting changes
3. `bun run test` — all tests pass
4. `bun run build:chrome` — builds without error
5. `bun run docs:build` — after any `docs/**/*.md` or `docs/.vitepress/**` change
6. `bun run docs:dev` — after docs changes when preview is needed, start in background so user can preview in browser before committing
7. New features/fixes must include tests

## Commit Format

Conventional Commits: `<type>(<scope>): <imperative summary>`

- Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `build`, `ci`, `perf`, `style`, `revert`, `deps`, `ux`
- Scope: short, feature-focused, lowercase when possible; commitlint currently enforces lowercase scopes and a 100-character header limit
- Summary: imperative, preferably lowercase, no trailing period
- If the commit relates to a GitHub issue or discussion, include `Closes #xxx` or `Fixes #xxx` in the commit body or PR description
- Codex-authored commits should include `Co-authored-by: Codex <codex@users.noreply.github.com>` in the commit body.

## Design Principles

1. **KISS.** Implement the minimum interpretation of requirements. Never combine orthogonal features (e.g., "fade" and "thin") without explicit confirmation.
2. **Backward compatibility is iron law.** Zero destructiveness to user data (especially `localStorage`).
3. **Data structures first.** Eliminate special cases by redesigning data, not adding branches.
4. **For visual/CSS changes:** describe expected rendering, verify alignment/centering/spacing in both light and dark themes, and check external resources (icon fonts, CDN links).
5. **For ambiguous requirements:** implement the minimal version first. Ask before adding scope.
6. **Grep for a sibling precedent before adding a new primitive.** Body-level popover, global listener, CSS overlay — there is almost always an existing `gv-pm-*` analogue (e.g., `.gv-pm-confirm` for body-appended popovers) already wired into close-outside handlers, teardown, and theme overrides. Copy its integration points; don't reinvent and miss one.
7. **Account scope matters.** Any Gemini feature that persists or reuses page-derived data must consider multi-account routes (`/u/<index>/...`). Cache keys, storage payloads, background refreshes, DOM-derived state, and links back to Gemini pages should preserve the current account scope where applicable. Avoid global caches unless the data is truly account-independent.

## Architecture

- **Services**: service classes, singleton exports, factories, and service helpers live in `src/core/services/`. `StorageService` is the typed wrapper for storage when suitable; existing persistence also uses direct `chrome.storage`/`browser.storage` and local fallback paths in popup, background, services, and content scripts.
- **Content scripts**: `src/pages/content/`. Each sub-module is self-contained.
- **UI**: functional React components + hooks. Business logic in `features/*/services/` or custom hooks, not in UI files.
- **Types**: `src/core/types/common.ts` for StorageKeys and shared types.
- **Translations**: `src/locales/*/messages.json` (10 languages).
- **Injected CSS**: shared/static content CSS lives in `public/contentStyle.css`; feature-specific dynamic CSS may be injected by content modules or the plugin runtime when values are computed at runtime, with `gv-` prefixes and teardown.
- **Feature coachmarks**: reuse the primitive in `src/pages/content/coachmark/`; keep feature-specific consumers beside their feature, and register Gemini onboarding in `showOnboardingCoachmarksWhenChangelogIsIdle` in `src/pages/content/index.tsx`. Each coachmark needs a stable ID, a side-effect-free eligibility check, complete reveal cleanup (including partial mount failure), all 10 locales, a debug trigger, and tests. The scheduler filters seen/ineligible guides first, then shows the remaining guides continuously in registration order with `1/N` progress; confirmation advances, while close/Escape/outside click exits the current tour.
- **Plugins**: declarative CSS+JSON plugin system in `src/features/plugins/` (engine + `PluginHost` + popup `PluginManager`). Default sources are builtin native plugins, bundled official catalog plugins, and the remote marketplace. Official CSS/JSON plugins that ship with Voyager live in `src/features/plugins/catalog/` and load through `BundledCatalogPluginSource`; update them in this repo together with engine/popup changes. Third-party or experimental marketplace plugins can still live in `github.com/nagi-studio/voyager-plugins` and are fetched at runtime by `MarketplacePluginSource`. A local sibling clone may exist at `../voyager-plugins`, but treat it as the remote marketplace mirror, not the source of truth for bundled official plugins. Builtin/native-function plugins that need JS (e.g. **Formula Copy**, which targets Claude + ChatGPT) live in `src/features/plugins/builtin/index.ts`.

## Task Map

| Task | Where |
|------|-------|
| Add storage key | `src/core/types/common.ts` → storage defaults/migrations (`SettingsBackupService.ts` for sync-backed settings) → popup/content consumers → locale keys only when new UI text is added |
| Update translations | `src/locales/*/messages.json` (all 10) |
| Change DOM injection | `src/pages/content/` |
| Add a one-time feature guide | Reuse `src/pages/content/coachmark/` → add a feature-local consumer → register it in `src/pages/content/index.tsx` → add all 10 locale strings and tests |
| Modify popup settings | Existing top-level settings often live in `src/pages/popup/Popup.tsx`; extracted sections live in `src/pages/popup/components/` |
| Fix cloud sync | `src/core/services/GoogleDriveSyncService.ts` |
| Add keyboard shortcut | `src/core/services/KeyboardShortcutService.ts` + related types + `src/pages/popup/components/KeyboardShortcutSettings.tsx` |
| Add/update bundled official plugin | `src/features/plugins/catalog/` + `BundledCatalogPluginSource.ts` mapping/tests |
