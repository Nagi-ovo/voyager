# Browser and release regression notes

Read this file when changing browser support, extension permissions or messaging, Safari native
behavior, or bundled public assets.

## Safari support must not be inferred from historical guards

- **Trap:** Safari users with Voyager watermark removal still enabled never saw the one-time notice
  for Gemini's official watermark switch. The notice retained an obsolete Safari early return even
  though Safari watermark removal has been supported since v1.6.0.
- **Rule:** Run the same eligibility check on Safari and document current Safari support in the
  content-script rules and public feature reference.
- **Guard:** `src/pages/content/watermarkNativeNotice/__tests__/watermarkNativeNotice.test.ts`
  (`shows on Safari when its watermark-removal setting is still active`).

## Firefox content scripts must not hold Web Locks with async callbacks

- **Trap:** On Firefox, account-scoped folders appeared empty and timeline/highlight scope
  resolution logged `Permission denied to access property "then"`. Firefox Bug 1873028 runs a Web
  Locks callback from a different security realm than the WebExtension content script. Returning the
  content script's Promise from `navigator.locks.request()` therefore fails even though the same
  code works in Chrome and Safari.
- **Rule:** Firefox web-page content scripts route account-scope resolution through the existing
  extension-background message. The background page keeps the shared Web Lock and serialized
  profile-map update; other browser builds keep their original path unchanged.
- **Guard:** `src/core/services/__tests__/AccountIsolationService.test.ts`
  (`resolves Firefox content-script scopes in the background instead of using Web Locks`).

## Chrome-only permissions must not leak into the shared base manifest

- **Trap:** `manifest.json` feeds every browser build. Adding Chrome-only `declarativeContent` there
  creates an unknown Firefox permission and Safari conversion noise even if runtime code no-ops. Its
  `SetIcon` action also accepts `imageData`, not a path or badge action.
- **Rule:** Inject Chrome/Edge-only permissions in `vite.config.chrome.ts`, keep the base manifest
  portable, and guard runtime access with `if (!chrome.declarativeContent?.onPageChanged) return;`.
  Draw the toolbar dot into `ImageData` with OffscreenCanvas. Chrome cannot programmatically pin the
  icon, so unpinned users see the dot only in the extensions menu.
- **Guard:** `src/features/plugins/__tests__/promptNudge.test.ts` (pure domain math). Manifest
  scoping is verify-by-build:
  `bun run build:chrome && grep -c '"declarativeContent"' dist_chrome/manifest.json` must be `1`,
  while `manifest.json` / `manifest.dev.json` must be `0`.

## Extension pages outside the manifest need their own build input

- **Trap:** CRXJS only bundles HTML pages the manifest references (popup, options, sidebar).
  A page the background opens with `runtime.getURL` (the first-run welcome page) is silently
  missing from `dist_*`, and each browser config owns its own `rollupOptions.input`, so adding
  it to one config leaves the other builds broken.
- **Rule:** List `src/pages/welcome/index.html` in `rollupOptions.input` of the Chrome, Firefox
  and Safari configs. Do not add it to `web_accessible_resources`; the page is for the extension
  origin only. Safari needs no `project.pbxproj` change because `src/` is already a registered
  top-level resource.
- **Guard:** `src/pages/welcome/__tests__/welcomePageWiring.test.ts`.

## Safari notification clicks must be owned by the containing app

- **Trap:** Safari displayed the native completion notification, but its Open Conversation action
  only raised Voyager's status window. The app extension scheduled the notification, so macOS routed
  the click back to that process, which logs showed as `can launch: false`; it could display the
  notification but could not relaunch to handle the response.
- **Rule:** Let the app extension validate permission and hand the notification to the containing
  app before scheduling it. The app owns the notification category and delegate; on click it
  dispatches the typed open-conversation message back to Safari, which focuses the matching tab.
  Keep the handoff payload validated and never log its full URL because it can contain conversation
  details.
- **Guard:** `Voyager/Tests/NativeSupportTests.swift`,
  `src/pages/background/__tests__/responseCompleteNativeNotification.test.ts`,
  `src/core/utils/__tests__/safariNativeNotifications.test.ts`, and
  `src/core/utils/__tests__/nativeOpenConversation.test.ts`. A live Safari check must reach
  privacy-safe logs `app didReceive` and `app dispatchMessage delivered to Safari`, then visibly
  focus the target conversation.

## A new file in public/ breaks the Safari build

- **Trap:** `bun run build:safari` failed with `Missing Xcode file references` and
  `Missing Xcode resource entries` after a PNG was added to `public/`. Chrome and Firefox built
  fine, and every unit test passed, so the break surfaced only in CI and also stopped the dependent
  release job. `public/` is copied verbatim into `dist_safari`, and
  `scripts/verify-safari-resources.mjs` requires every top-level entry there to be registered in
  `Voyager/Voyager.xcodeproj/project.pbxproj`. Nothing wires that up automatically, so a new bundled
  asset silently fails the check.
- **Rule:** Register the file in all four places the pbxproj needs, mirroring an existing PNG such
  as `icon-32.png`: a `PBXBuildFile` entry, a `PBXFileReference` with
  `path = "../../dist_safari/<name>"`, the group's `children` list, and the Resources build phase.
- **Guard:** `bun run build:safari` ends with `Safari Xcode resource wiring is complete.` Run it
  whenever you add or rename anything under `public/`; the other browser builds will not catch this.

## A RegExp lookbehind in shared code breaks every feature on Safari 15.4-16.3

- **Trap:** `src/features/prompt/model/promptTemplate.ts` matched legacy `{name}` placeholders with
  `(?<!\{)\{(?!\{)...` in a module-level `new RegExp`. Safari only gained lookbehind assertions in
  16.4, while `vite.config.safari.ts` declares `strict_min_version: '15.4'` and
  `.github/docs/safari/INSTALLATION.md` promises macOS 11+, whose Safari stops at 15.6. The module
  is statically imported by `src/pages/content/prompt/index.ts`, so the constructor throws during
  content-script evaluation and takes down every Voyager feature on that page, not just prompt
  templates. Nothing caught it: `bun run build:safari` passed because
  `scripts/verify-safari-resources.mjs` only scans the `preserveLatexPipeCommandsInMarkdownTable`
  fragment, the bundlers cannot see inside a runtime `new RegExp` string, and Node and jsdom both
  support lookbehind so the unit tests stayed green.
- **Rule:** No RegExp lookbehind in anything a content script can reach. Match the opening delimiter
  plainly and inspect the preceding character through the `offset` argument of the `String.replace`
  callback. Do not stand in for `(?<!x)` with a leading `(^|[^x])` group: it consumes the character,
  so adjacent matches such as `{a}{b}` silently lose the second one.
- **Guard:** `src/features/prompt/model/__tests__/promptTemplate.test.ts`
  (`is built without a RegExp lookbehind so Safari 15.4 can evaluate it`,
  `migrates adjacent single braces with nothing between them`).

## Popup requests and feedback belong to the current source tab and operation

- **Trap:** An embedded popup can change its source tab while a tab query or folder-structure
  request is pending. An older response could then replace the new platform context or copy the
  previous tab's structure. A previous copy's feedback timer could also clear a newer copy status.
- **Rule:** Invalidate pending tab reads when another read starts or the source changes. Folder
  copy owns its request generation and reset timer: reject obsolete responses before copying,
  clear the previous timer before starting again, and release pending work on unmount.
- **Guard:** `src/pages/popup/hooks/__tests__/useActivePopupTab.test.tsx` and
  `src/pages/popup/hooks/__tests__/useFolderStructureCopy.test.tsx` cover out-of-order responses,
  source-tab changes, clipboard ownership and reset-timer cleanup.
