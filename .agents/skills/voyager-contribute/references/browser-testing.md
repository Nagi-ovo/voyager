# Browser verification

Read this reference only when a change affects extension runtime, UI, manifests, permissions, packaging, native integration, or plugins.

## Evidence

Report only the highest level actually completed:

- **Build**: the command succeeds and the expected artifact exists.
- **Loaded**: that artifact is enabled once in the browser with no manifest or load error.
- **Live**: after reloading the extension and target tab, the changed workflow works and existing state remains intact.

A build, unit test, or code inspection is not `Loaded` or `Live` evidence.
For `Loaded` or `Live`, record the browser name, exact version, scenario, result, and redacted evidence.

## Route by risk

| Change                                                                                           | Required evidence before review is complete                                                                                                                                                |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Docs, comments, or test-only work                                                                | Relevant automated checks; explain why browsers are not applicable.                                                                                                                        |
| Pure logic with no browser API or visible behavior change                                        | `bun run verify:pr`; add focused tests.                                                                                                                                                    |
| Popup, content script, background, shared CSS, storage, or plugin runtime                        | `verify:pr`, then `Loaded` and `Live` on Chrome and Firefox. Add Edge for Chromium-specific, manifest, permission, or packaging behavior. Add Safari whenever Safari behavior is affected. |
| Browser-specific code, permissions, native messaging, Swift, signing, packaging, or release work | `Loaded` and `Live` on each affected browser, builds for the others, and the feature-specific regression checks. Use the Safari or release skill where applicable.                         |
| Bundled official or builtin plugin                                                               | `Live` on Chrome, Edge, Firefox, and Safari before merge unless the manifest explicitly supports fewer browsers, plus the plugin checks below.                                             |

Missing hardware or access may be covered by another contributor. Record `Needs <browser> test; owner: @name`; a draft PR may remain open, but it is not review-ready until required evidence is added.

## Artifacts

| Browser | Command                                        | Load target                                                                          |
| ------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| Chrome  | `bun run dev:chrome` or `bun run build:chrome` | `dist_chrome_dev` for routine development; `dist_chrome` for production verification |
| Edge    | `bun run build:edge`                           | `dist_edge`                                                                          |
| Firefox | `bun run build:firefox`                        | `dist_firefox/manifest.json` via `about:debugging`                                   |
| Safari  | `bun run build:safari`                         | `dist_safari`; then follow the `update-safari-extension` skill                       |

`bun run build:all` excludes Edge. `bun run build:browsers` and `bun run verify:pr` include the Edge package build.

## Baseline smoke

For each required browser:

- Load exactly one enabled Voyager artifact with no manifest or startup error.
- Open the popup and exercise the changed workflow on every affected site.
- Check relevant popup, background/service-worker, and page consoles for new errors.
- Reload the extension and target page; confirm UI, listeners, styles, and notifications are not duplicated.
- Confirm existing settings and stored data remain intact.
- For visual changes, check light and dark themes, alignment, spacing, narrow and wide layouts as applicable.
- Preserve `/u/<index>/...` account scope when the feature is account-sensitive.
- Run any matching check in `.github/docs/REGRESSION_NOTES.md`.

## Plugin checks

For `src/features/plugins/catalog/`, catalog mappings, or builtin/native plugins:

- Confirm the plugin appears once from the intended bundled source.
- Match the default enabled state of the nearest sibling plugin unless an approved migration says otherwise.
- Enable, disable, re-enable, and reload; verify state persistence and complete teardown without duplication.
- Test every declared target site and confirm unrelated sites are unchanged. Test both start and stop paths for builtin JS plugins.
- Keep custom-site access as an explicit optional grant; direct `<all_urls>` permission requires prior user approval.
- Attach redacted screenshots or recordings for visible behavior. Never expose account data, conversations, tokens, signing identities, or native handoff URLs.
