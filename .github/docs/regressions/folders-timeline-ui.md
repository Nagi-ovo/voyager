# Folders, timeline, and layout regression notes

Read this file when changing folders, timeline navigation, sidebar behavior, chat width, drag and
drop, or hover layout.

## Active folder rows must use the navigation route ID

- **Trap:** The active folder chat lost its background and accent even though the route and CSS were
  valid. Normalizing `c_<route-id>` and bare IDs fixed only one storage shape: legacy native
  fallbacks and imports can retain a synthetic ID such as `conv_*` while their saved URL still
  contains the real `/app/<route-id>`.
- **Rule:** Treat the saved navigation URL (or rendered row `href`) as the canonical route identity,
  with the stored ID only as a fallback. Keep the row's raw stored ID only for distinguishing the
  same conversation across multiple folders. Reuse that URL-first identity for account-scoped links
  and navigation; never migrate or rewrite user data just to repair highlighting.
- **Guard:** `src/pages/content/folder/__tests__/folderNavigation.test.ts`
  (`highlights an initially active legacy row from its stored conversation URL` and
  `uses the URL route id for legacy conversations in account-isolated links and navigation`).

## Explicit native deletion must resolve identity at action time and wait for Gemini to settle

- **Trap:** Deleting the currently open conversation from Gemini's top menu left a dead folder
  entry. The lr26 trigger no longer exposes Voyager's expected test ID, and the menu can contain both
  strong conversation actions and Export to Docs. Even when deletion was captured, a single 300ms
  check permanently gave up while the old route or sidebar row was still mounted. Gemini can also
  rebuild the sidebar between Delete and confirmation; treating that transient reinitialization as a
  full teardown clears the pending conversation identity before confirmation arrives. The lr26
  virtual list can also retain a hidden native conversation row after the visible entry and route are
  gone, so raw DOM presence can block cleanup even after Gemini completes the deletion.
- **Rule:** Identify a Delete action from its live conversation menu, resolve its conversation from
  that menu context at click time, and only arm cleanup after native confirmation. Poll for a bounded
  window until both the route has left and the native row is absent; on timeout, preserve folder data.
  Preserve the document-level delete tracker, candidate identity, and candidate timeout across
  sidebar-only reinitialization. If Gemini's confirmation control is not recognizable, require an
  explicit native confirmation before scheduling cleanup or ignoring any hidden row. The
  rows hidden by Voyager's `.gv-conversation-archived` or
  `.gv-conversation-archived-actions` markers remain valid native conversations and must never be
  treated as deletion evidence, even when their computed display is `none`. The
  current-conversation transition to `/app?pageId=none` is only settlement evidence after that
  confirmation; it can never arm deletion by itself. A hidden stale native row may be ignored only
  for a tracked current-conversation deletion that was explicitly confirmed and reached that
  completion route; otherwise preserve it as deletion-rejection evidence. Clear candidate state on
  explicit confirmation, cancellation (including Escape or overlay dismissal), full runtime teardown,
  or timeout. Strong pin/rename/delete markers take precedence over overlapping report/export markers.
- **Guard:** `src/pages/content/export/__tests__/conversationMenuInjection.test.ts`
  (`keeps current top conversation menus distinct when they also export to Docs`) and
  `src/pages/content/folder/__tests__/observerBatching.test.ts`
  (`resolves the current conversation when the top Delete menu trigger has no test id`,
  `removes only the confirmed current conversation when the sidebar reinitializes before confirmation`,
  `removes the deleted current conversation when Gemini lands on pageId=none`,
  `ignores a hidden stale native row after current deletion completes at pageId=none`,
  `preserves a Voyager-hidden archived row during deletion checks`,
  `preserves a Voyager-hidden archived row marked on legacy actions`,
  `preserves a hidden native row when current deletion never reaches pageId=none`,
  `preserves folder entries when native deletion is cancelled after sidebar reinitialization`,
  `does not infer deletion from pageId=none without an explicit confirmation`,
  `preserves folder entries when native deletion is cancelled with Escape`,
  `preserves folder entries when native deletion is cancelled by clicking the overlay backdrop`,
  `clears native deletion state on destroy after sidebar reinitialization`,
  `retries a confirmed current-conversation deletion until the route and row settle`, and
  `stops retrying a rejected native deletion and preserves the folder entry`).

## Timeline navigation must validate the live scroll viewport

- **Trap:** Timeline dots, preview-list items, and `j`/`k` shortcuts could all appear inert after
  Gemini rebuilt its chat viewport. The navigation fast path treated connected marker and container
  nodes as current. Gemini can insert a new scroll viewport inside the old connected container, so
  Voyager wrote `scrollTop` to the stale ancestor.
- **Rule:** Before navigation, validate the target's nearest scroll container against the cached
  viewport. Rebind and recalculate markers when it changed, including preview-panel navigation.
- **Guard:** `src/pages/content/timeline/__tests__/TimelineManagerFlowClickActiveReset.test.ts`
  (`refreshes connected markers when Gemini inserts a new scroll viewport` and
  `refreshes the scroll viewport before preview-panel navigation`) and
  `src/pages/content/timeline/__tests__/TimelineManagerNavigationRefresh.test.ts`
  (`rebinds a connected stale scroll viewport before shortcut navigation`).

## Folder recovery must remove untracked sidebar clones

- **Trap:** Gemini's sidebar showed two complete Voyager folder panels, which displaced the native
  conversation history and could make it appear unable to scroll. Gemini can clone its virtualized
  sidebar subtree after Voyager mounts the folder panel. The cloned `.gv-folder-container` is not
  referenced by `FolderManager.containerElement`, so the old instance-only cleanup left that orphan
  in place when recovery injected a replacement.
- **Rule:** Before mounting, remove both the tracked panel and untracked direct folder-panel
  siblings from the current sidebar section host. Keep AI Studio and floating multi-select
  containers out of this cleanup.
- **Guard:** `src/pages/content/folder/__tests__/folderPositionEnforcer.test.ts`
  (`removes an untracked folder clone before recovery mounts a replacement`).

## Automatic folder fallback must not become a sticky floating mode

- **Trap:** Folders briefly disappeared, then returned as a floating panel even though the
  floating-mode setting was off. Closing that panel could leave a FAB that the already-off popup
  toggle could not remove. The recovery watchdog applied its grace period only when the sidebar
  container existed. A transiently missing sidebar opened the fallback immediately, and the shared
  panel-close callback always restored the explicit-mode FAB.
- **Rule:** Apply the same grace period to a missing sidebar, restore the FAB only for explicit
  floating mode, and clear all fallback entry points when the sidebar recovers.
- **Guard:** `src/pages/content/folder/__tests__/folderPositionEnforcer.test.ts`
  (`waits before opening the floating fallback when the whole sidebar is temporarily missing`,
  `does not leave a FAB or immediately reopen after closing an automatic fallback`, and
  `clears every floating fallback entry point when the sidebar recovers`).

## Folder conversation navigation must not hard-refresh Gemini

- **Trap:** Clicking a folder conversation sometimes forced a full Gemini page refresh instead of
  switching sessions inside the existing SPA. The folder navigator tried to preserve Gemini's native
  SPA behavior by clicking the corresponding native sidebar link, but its fallback used
  `location.assign`. That fallback fired when the native sidebar row was virtualized/not rendered,
  or when Gemini's own route change was slower than the confirmation timeout. The floating folder
  panel had an even more direct `location.assign` path.
- **Rule:** Route folder and floating-panel conversation clicks through the shared conversation
  navigator. If the native link is missing or does not navigate, fall back to `history.pushState`
  plus `popstate`, not a hard page load.
- **Guard:** `src/pages/content/folder/__tests__/folderNavigation.test.ts`
  `src/pages/content/folder/__tests__/folderDisabledRuntime.test.ts`

## Sidebar scroll exception must stay scoped away from chat scroll blocking

- **Trap:** The prevent-auto-scroll feature blocked the Gemini sidebar history list from scrolling
  after a submit. The original blocking logic applied to any scrollable ancestor while the submit
  block window was active. Sidebar scroll containers were treated like the chat transcript.
- **Rule:** Classify sidebar elements separately from chat scroll elements before blocking
  `scrollTo`, `scrollBy`, `scrollTop`, or `scrollIntoView`.
- **Guard:** `src/pages/content/preventAutoScroll/__tests__/preventAutoScrollScript.test.ts`

## Claude timeline must treat the DOM as a sliding virtualized window

- **Trap:** Claude mounts only about 6 to 9 turns and can briefly expose sparse, non-contiguous
  windows during long jumps. Rebuilding from the mounted DOM made dots twitch or disappear;
  mount-index IDs changed as the window slid, and pruning missing turns deleted valid markers.
  Remembered absolute offsets also drift while Claude remeasures newly mounted content.
- **Rule:** Keep a grow-only registry stitched across overlapping windows by content hash:
  `c-<textHash>`, with `~n` for duplicates and hash-segment matching for legacy stars. Navigate to
  unmounted turns iteratively with instant probing and direction-aware bisection, then smooth
  fine-aim after mount. Make jumps over three viewports instant. Reuse this virtual-window model for
  future Claude DOM features.
- **Guard:** `src/features/plugins/builtin/claudeTimeline/index.test.ts` covers sparse-window
  stability, durable IDs, and marker retention during virtualization.

## The chat width sparkle rule also matches the Gemini logo pill

- **Trap:** At widths of at least 1024px, the `chatWidth` loading selector
  `main > div:has(img[src*="sparkle"])` also matched Gemini's logo wrapper. It stretched the wrapper
  from 101px to the slider's computed width. Although the wrapper had `pointer-events: none`, its
  auto-pointer child inherited the large box and became a transparent hit target over header
  buttons. The affected area therefore tracked the chat-width slider, not sidebar width.
- **Rule:** Exclude the logo wrapper with `:not(:has(chat-app-side-nav-menu-button))` while
  retaining the #110 clamp for real loading wrappers. Do not change the static, in-flow host's
  geometry because that perturbs the header layout.
- **Guard:** `src/pages/content/chatWidth/__tests__/chatWidth.test.ts` Live-page verification:
  toggling only that selector moves the host between 101px (hit-stack top `mat-icon` /
  `span.dynamic-upsell-label`) and the slider's pixel value (hit-stack top
  `chat-app-side-nav-menu-button`) at 30/50/70/100%.

## The file-drop overlay is pinned to Gemini's native input width

- **Trap:** Gemini fixes the visual file-drop overlay at
  `var(--bard-chat-window-max-width-default, 760px)`. The variable is unset, so the hint stays 760px
  while `chatWidth` or `editInputWidth` can widen `input-area-v2`. Upload still works outside the
  hint because `.chat-container` is the real drop target.
- **Rule:** Both width modules must inject an overlay width with the same value and precedence as
  their input rule. Keep `chatWidth`'s `input-container` prefix more specific than `editInputWidth`,
  so the overlay and visible input choose the same winner regardless of injection order.
- **Guard:** `src/pages/content/chatWidth/__tests__/chatWidth.test.ts` and
  `src/pages/content/editInputWidth/__tests__/editInputWidth.test.ts`. At 70% width, a synthetic
  drag over `.chat-container` must give the overlay and `input-area-v2` identical left and right
  edges.

## Compact timeline preview hover gap closes panel

- **Trap:** In compact timeline mode, moving the pointer from the rail to the preview panel could
  close the panel before the pointer reached it, making history items hard to click. The rail and
  panel each owned separate hover enter/leave handlers, but the panel is positioned with a 12px
  visual gap from the rail. A slow pointer crossing that non-hit-tested gap could outlive the
  compact close delay before panel mouseenter canceled it.
- **Rule:** Add a transparent fixed hover bridge over the actual rail-to-panel gap while the compact
  preview is open. Treat the bridge as part of the interaction area for hover and outside-click
  handling, and hide it when compact mode closes or turns off.
- **Guard:** `src/pages/content/timeline/__tests__/TimelinePreviewPanel.test.ts`
  (`keeps the panel open while the pointer pauses in the compact hover gap`,
  `treats the compact hover bridge as part of the preview interaction area`).
