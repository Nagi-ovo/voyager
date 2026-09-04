# AGENTS.md — Voyager

## Execution

- Complete the requested outcome: audits deliver evidence and recommendations; implementations include changes and verification. Make routine, reversible choices within the authorized scope; ask when missing information changes scope, data safety, or authorization.
- Follow current user requirements over repository or skill guidance, within the host's instruction hierarchy. Reuse existing approval. If a document requires a pause, cite the exact instruction and explain why it applies; finish independent authorized work first.
- Check `git status --short --branch -uall` before editing. Preserve unrelated work; recheck status and HEAD before committing or pushing.
- Use subagents for bounded, independent reviews or disjoint implementation when useful. Keep small edits local, give each file one editor, and verify delegated findings.
- Report the outcome, verification and remaining work concisely in the user's language. Distinguish recommendations from applied changes.

## Read the relevant context

Read matching rules before editing; do not assume the client auto-loaded `.claude/rules/`.

| Change                                                                   | Required context                                                                                                            |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `src/**/*.ts`, `src/**/*.tsx`                                            | [.claude/rules/typescript.md](.claude/rules/typescript.md)                                                                  |
| `src/pages/content/**`, `public/contentStyle.css`                        | [.claude/rules/content-scripts.md](.claude/rules/content-scripts.md)                                                        |
| `src/locales/**`                                                         | [.claude/rules/i18n.md](.claude/rules/i18n.md)                                                                              |
| Storage, backup, account isolation, Drive sync, folder or export modules | [.claude/rules/high-complexity.md](.claude/rules/high-complexity.md), including full-file reads and full-suite verification |
| Non-trivial feature, fix or refactor                                     | Search [.github/docs/REGRESSION_NOTES.md](.github/docs/REGRESSION_NOTES.md), then read matching topics                      |
| Contribution or release                                                  | [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md); matching workflows in [.agents/skills/](.agents/skills/)                |

Use `package.json`, build configs, manifests and CI to verify command names and current wiring. Keep `CLAUDE.md` as a pointer here.

## Protected behavior

- Preserve user data and serialized formats, especially localStorage. Legacy keys and cleanup paths may serve migrations. Scope page-derived state, caches, backups and delayed work to the applicable platform/account; preserve `/u/<index>/` routes.
- Generate `dist_*` through build scripts; never edit them directly. Never commit `.env` or secrets.
- Never grant a page or feature direct `<all_urls>` permission without explicit user approval.
- Gemini conversation navigation uses native in-app links first, then History API/router events. Full reloads (`location.assign`, `location.href`, `location.reload`) require explicit user acceptance for normal session navigation.
- Popup Material Symbols use bundled `public/fonts/` assets. Check new glyphs locally or update the bundle; do not introduce a remote Google Fonts URL.
- Every local `xcodebuild` uses `-derivedDataPath .build/safari-native-test-derived -clonedSourcePackagesDirPath .build/sparkle-source-packages`. Only CI uses `.build/ci-xcode-derived`. `bun run clean:build` reclaims derived data while retaining the SPM cache.

## Where changes belong

| Responsibility               | Entry points                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared services and storage  | `src/core/services/`; `StorageKeys` in `src/core/types/common.ts`; sync-backed settings also need `SettingsBackupService.ts` defaults/migrations                                     |
| Feature logic and UI         | `src/features/*/services/` or hooks; functional React UI. Content modules in `src/pages/content/` remain self-contained                                                              |
| Folders                      | `src/pages/content/folder/`, `src/features/folder/`; persisted types currently exist in both `src/core/types/folder.ts` and `src/pages/content/folder/types.ts`                      |
| Popup settings and shortcuts | `src/pages/popup/Popup.tsx` and its `components/`; shortcuts use `src/core/services/KeyboardShortcutService.ts`, related types and `components/KeyboardShortcutSettings.tsx`         |
| Cloud sync                   | `src/core/services/GoogleDriveSyncService.ts`                                                                                                                                        |
| Translations                 | `src/locales/*/messages.json`: all 10 locales for new/removed user-facing keys                                                                                                       |
| Content styles               | Shared/static CSS in `public/contentStyle.css`; computed feature CSS stays local, uses `gv-` prefixes and has teardown                                                               |
| Coachmarks                   | Reuse `src/pages/content/coachmark/`; keep consumers beside the feature and register Gemini guides in `showOnboardingCoachmarksWhenChangelogIsIdle` in `src/pages/content/index.tsx` |
| Plugins                      | `src/features/plugins/`; official CSS/JSON in `catalog/` with `BundledCatalogPluginSource.ts` mapping/tests; native JS in `builtin/index.ts`                                         |

Use `StorageService` where suitable; established direct `chrome.storage`/`browser.storage` paths remain valid for content scripts, popup settings, bulk operations and listeners.

`src/features/plugins/sources/defaultSources.ts` defines active sources: builtin and bundled catalog. The remote `MarketplacePluginSource` is currently disabled. A sibling `../voyager-plugins` clone mirrors that marketplace; bundled official plugins are maintained here.

Coachmarks require a stable ID, side-effect-free eligibility, cleanup after partial mount failure, all 10 locales, a debug trigger and tests. Skip seen/ineligible guides, then show the remaining guides continuously in registration order with `1/N` progress: confirmation advances; close, Escape or outside click exits the tour.

## Keep changes incremental

- Implement the minimum requested behavior. Keep independent options separate; inspect existing data structures and sibling implementations before adding abstractions.
- Before deletion, trace production entry points, callers and regression guards. Distinguish retired implementations from compatibility cleanup. Remove tests that exist solely for deleted, unreachable code.
- Extract cohesive data operations or complete lifecycle responsibilities from large managers. Give helpers explicit inputs and one state owner; avoid passing the whole manager into extracted modules. Each step must work independently and preserve existing callers and data.
- Keep listener, observer and timer cleanup beside setup. Sidebar remount, account change and full teardown have different lifetimes; preserve the appropriate state across each.
- Reuse existing popover integration, such as `gv-pm-confirm`, including outside-click handling, teardown and theme overrides.
- For visual changes, state the expected result and verify alignment, spacing and behavior in light/dark themes, including external resource dependencies.
- Record repeatable, non-obvious bugs as Trap/Rule/Guard entries in the matching regression topic; run `bun run regressions:check` after editing notes.

## Verification

Choose checks by changed surface. Repeat passing checks only after relevant changes or new evidence. `bun run verify:pr` runs complete local PR automation; native/live-browser checks remain separate.

| Changed surface                             | Checks before completion                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Repository prose or agent instructions only | Review the diff for lost requirements, validate referenced paths/commands, format-check changed files                               |
| Extension code, build logic or dependencies | `bun run lint:check`, `bun run test`, `bun run build:chrome`; add `bun run typecheck` for any `.ts`/`.tsx` change                   |
| Added, renamed or removed `public/` entries | `bun run build:all` instead of Chrome only; register every top-level Safari resource in `Voyager/Voyager.xcodeproj/project.pbxproj` |
| `docs/**/*.md` or `docs/.vitepress/**`      | `bun run docs:build`; background `bun run docs:dev` when preview is needed before committing                                        |

`bun run lint` (`oxlint --fix`) and `bun run format` apply corrections: inspect their diffs. Read-only reviews use `:check` variants.

Features and behavior fixes need meaningful tests. Assert observable behavior or data invariants; avoid repeating mocks, private wiring or source spelling. Static checks belong to static contracts such as resource registration or forbidden primitives. Migrate valuable regression assertions with extracted responsibilities. Prose, formatting and other reversible changes without a behavior change need no new tests.

For Chrome development, run `bun run dev:chrome` and load/reload `dist_chrome_dev`. Production checks use `build:chrome`/`dist_chrome`. `build:all` builds Chrome, Firefox and Safari; `build:browsers` includes Edge too.

## Git and publishing

- Use `gh` as the source of truth for GitHub issues, PRs and comments.
- When asked to push without branch/PR instructions, fast-forward `origin/main`. Never force-push unless explicitly requested.
- Commit as `<type>(<scope>): <imperative summary>`: lowercase feature scope, preferably lowercase summary, no trailing period, at most 100 header characters. Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `build`, `ci`, `perf`, `style`, `revert`, `deps`, `ux`.
- Link related issues/discussions with `Fixes #xxx` or `Closes #xxx` in the commit body or PR description. Codex commits include `Co-authored-by: Codex <codex@users.noreply.github.com>`.
- After publishing an issue fix with a pushed `Fixes`/`Closes` commit or PR, comment briefly in the reporter's language: the fix has landed, it will be in the next version, and they can reopen if it persists.
