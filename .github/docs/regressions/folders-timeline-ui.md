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
  `.gv-conversation-archived-actions` markers remain valid native conversations during ordinary
  checks. After an explicitly confirmed current-conversation deletion reaches its completion route,
  however, those markers may remain on Gemini's stale hidden row and must not override the rendered
  row check. The
  current-conversation transition to `/app?pageId=none` is only settlement evidence after that
  confirmation; it can never arm deletion by itself. A hidden stale native row may be ignored only
  for a tracked current-conversation deletion that was explicitly confirmed and reached that
  completion route; otherwise preserve it as deletion-rejection evidence. Bind the candidate and
  every delayed check to the storage key and `/u/<index>` route active when deletion began; treat
  bare `/app` and `/u/0/app` as the same default account, and discard the check if either account
  scope otherwise changes. Clear candidate state on explicit confirmation,
  cancellation (including Escape or overlay dismissal), full runtime teardown, or timeout. Strong
  pin/rename/delete markers take precedence over overlapping report/export markers.
- **Guard:** `src/pages/content/export/__tests__/conversationMenuInjection.test.ts`
  (`keeps current top conversation menus distinct when they also export to Docs`) and
  `src/pages/content/folder/NativeConversationMenus.test.ts`
  (`requires native confirmation, then waits for the current route and row to leave`,
  `checks the row itself after a confirmed current deletion with a %s`,
  `preserves a conversation after %s even when Gemini reaches pageId=none`,
  `preserves a hidden row when the current deletion never reaches its completion route`,
  `expires rejected deletion checks instead of deleting after a later unrelated navigation`, and
  `keeps an explicit deletion check across a transient native-row re-add`). Manager integration
  remains in `src/pages/content/folder/__tests__/observerBatching.test.ts`
  (`removes only the confirmed current conversation after sidebar reinitialization and settlement at %s`,
  `discards a pending native deletion after the %s changes`,
  `preserves folder entries when native deletion is cancelled after sidebar reinitialization`,
  and `clears native deletion on destroy after remount (confirmed: %s)`).

## Batch deletion cancellation must reach native menu waits

- **Trap:** Clearing the batch flag or its outer timers left a pending native-menu promise alive.
  It could click the next account's Delete control or continue the remaining batch after disable.
- **Rule:** Bind the batch to its account activation and route; pass cancellation through row,
  menu, confirmation and inter-item waits. Reset, disable and destroy abort that work immediately.
  Sidebar-only remounts retain the batch. Cancelled work must not report success or schedule reload.
- **Guard:** `src/pages/content/folder/FolderNativeBatchDelete.test.ts` covers each wait, remount,
  account changes and a replacement batch while the old one is unwinding.

## Retained selection must be restored into replacement sidebar UI

- **Trap:** Sidebar recovery kept selected conversation IDs but replaced the toolbar and rows,
  hiding the active selection mode, count and actions while later clicks still selected items.
- **Rule:** After mounting the replacement tree, restore selected rows and toolbar state from the
  selection owner; remove a temporary floating selection host when the sidebar takes over.
- **Guard:** `src/pages/content/folder/FolderSelection.test.ts` covers native/folder selections
  through remount and floating-to-sidebar toolbar handover.

## Native move menus must resolve ownership when clicked

- **Trap:** Gemini can mount a conversation menu before updating the trigger's `aria-expanded`
  and `aria-controls`. Capturing menu context during injection binds the button to a missing or
  incorrect trigger. A sidebar move then does nothing on the new-chat page, or saves the currently
  open conversation instead of the selected sidebar conversation. Injection retries only update
  the existing button's label, so they cannot repair its captured callback context.
- **Rule:** Read the live menu context when the injected Move to folder action is clicked. Resolve
  the sidebar conversation from that trigger; never use the current page to replace an unresolved
  sidebar identity.
- **Guard:** `src/pages/content/folder/__tests__/topMenuInjection.test.ts`
  (`resolves a sidebar trigger linked after menu injection when %s`, with and without another
  conversation open).

## Timeline navigation must validate the live scroll viewport

- **Trap:** Timeline dots, preview-list items, and `j`/`k` shortcuts could all appear inert after
  Gemini rebuilt its chat viewport. The navigation fast path treated connected marker and container
  nodes as current. Gemini can insert a new scroll viewport inside the old connected container, so
  Voyager wrote `scrollTop` to the stale ancestor.
- **Rule:** Before navigation, validate the target's nearest scroll container against the cached
  viewport. Rebind and recalculate markers when it changed, including preview-panel navigation.
- **Guard:** `src/pages/content/timeline/__tests__/TimelineManagerFlowClickActiveReset.test.ts`
  (`rebinds a connected nested viewport before %s navigation`, covering dots and preview items) and
  `src/pages/content/timeline/__tests__/TimelineManagerNavigationRefresh.test.ts`
  (`rebinds a connected stale viewport before shortcut navigation`).

## Timeline state changes must preserve rail browsing position

- **Trap:** Calling the full view render after a star or hierarchy change also synchronized the rail
  to the native chat viewport. A user browsing a long rail with its slider was pulled back to the
  current chat position when editing a marker.
- **Rule:** State changes update geometry, virtual dots, slider and preview without synchronizing
  the rail to the chat. Keep that synchronization in native scrolling and navigation paths.
- **Guard:** `src/pages/content/timeline/__tests__/TimelineManagerFlowClickActiveReset.test.ts`
  (`preserves the manually scrolled rail when a marker level changes`).

## Timeline surfaces must cancel work that has not become visible

- **Trap:** Clearing tooltip DOM without cancelling a queued animation frame could revive it after
  an immediate hide; an old hide timer could close a newer tooltip. A pending long press could also
  star a turn after its interaction owner was destroyed.
- **Rule:** Tooltip visibility and marker interactions own their complete timer/animation/listener
  lifetimes. Hide cancels pending visibility work; destroy cancels pending input actions as well.
- **Guard:** `src/pages/content/timeline/__tests__/TimelineTooltip.test.ts` and
  `src/pages/content/timeline/__tests__/TimelineMarkerInteractions.test.ts` cover queued frames,
  overlapping hide/show and teardown during long press.

## Timestamp opt-in changes can arrive during initialization

- **Trap:** Moving the timestamp setting listener to the end of manager initialization lost changes
  made while history or keyboard settings were loading, leaving timestamps enabled after opt-out.
- **Rule:** The timestamp owner subscribes before its first asynchronous read and preserves settings
  changes received while that read is pending. Unsubscribe when the owner is destroyed.
- **Guard:** `src/pages/content/timeline/__tests__/TimelineTimestamps.test.ts` covers setting changes
  during pending initialization and shared history-store lifetime.

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

## A pending floating mount must preserve the latest requested mode

- **Trap:** Stopping and restarting the folder runtime during an asynchronous floating mount could
  reuse the old mount promise and silently discard the new request. A request for the panel could
  finish as a FAB, or a stopped instance could remove its replacement.
- **Rule:** Track the requested panel/FAB intent along with the in-flight mount. Coalesce identical
  requests within one lifetime; after stop or an intent change, wait for the old mount to settle and
  clean it up before mounting the current request. The mount promise must include asynchronous FAB
  setup, so cleanup cannot race a detached continuation.
  Switching a completed automatic fallback to explicit closed floating mode must close the old
  panel before showing the FAB, even when there is no pending mount promise.
- **Guard:** `src/pages/content/folder/FolderSidebarRuntime.test.ts` covers stop/restart while a
  floating mount is pending with panel-to-panel, panel-to-FAB and FAB-to-panel requests.

## Imported activity timestamps must stay within browser timer limits

- **Trap:** A valid future `lastTurnAt` more than 24.8 days away overflowed the browser timeout
  range, refreshing Activity on a 1 ms loop instead of waiting for its Priority expiry.
- **Rule:** Clamp the scheduled delay to the signed 32-bit timeout limit, then recompute expiry
  when it fires. Preserve the imported timestamp.
- **Guard:** `src/pages/content/folder/__tests__/folderActivityView.test.ts` covers future data
  without a refresh loop and ordinary Priority expiry.

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
  unmounted turns iteratively with instant probing and direction-aware bisection, then fine-aim
  after mount. Every jump passes `behavior: 'instant'` (`'auto'` follows the page's CSS
  `scroll-behavior`, so it can still animate): smooth scrolling drifts while Claude re-measures, and mixing
  smooth short hops with instant long ones reads as erratic. Reuse this virtual-window model for
  future Claude DOM features.
- **Guard:** `src/features/plugins/builtin/claudeTimeline/index.test.ts` covers sparse-window
  stability, durable IDs, and marker retention during virtualization.

## Turn navigator blocks are filed by scroll position between anchors

- **Trap:** Claude now mounts about four turns plus the latest turn, which stays mounted while the
  reader sits at the top. Stitching a freshly mounted block "right before its first anchor" filed the
  conversation's opening turns behind the bottom window, so the preview list, the rail order and
  the active marker were all wrong after one scroll to the top.
- **Rule:** Anchors (hash matches) fix the relative order; a block of unknown turns is inserted by
  its scroll position among the known turns between its two bounding anchors, comparing known
  centres after the nearest anchor's re-measure drift. Never assume a mounted window is contiguous.
- **Guard:** `src/features/plugins/builtin/claudeTimeline/index.test.ts`
  (`keeps the opening turns ahead of the bottom window when Claude leaves the latest turn mounted`,
  `files a bottom window behind the known opening turns when the first turn stays mounted`).

## Compact turn-navigator ticks spread over the track and stay clickable

- **Trap:** Compact ticks were squeezed into a fixed 240px cluster, so a long conversation rendered
  as an unreadable barcode on a 1100px track, and `pointer-events: none` on the ticks meant a click
  only toggled the preview panel instead of jumping.
- **Rule:** Keep a fixed tick pitch and let the cluster use the whole track (minus end padding);
  shrink the pitch only when the conversation outgrows the track, and re-space on resize. On
  `[data-gv-turn-navigator]` rails a tick click navigates (stop propagation so the rail's panel
  toggle does not fire) while hover still opens the preview; compact ticks show no tooltip.
- **Guard:** `src/features/plugins/builtin/claudeTimeline/index.test.ts`
  (`spreads compact ticks over the whole track instead of a fixed cluster`,
  `jumps from a compact tick without toggling the preview panel or a tooltip`).

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
  their input rule. When only chat width is on, its `input-container` prefix wins. When edit input
  width is also on, `html body input-container …` must beat that prefix so the composer and overlay
  follow the edit slider (#955), while the thread still follows chat width.
- **Guard:** `src/pages/content/chatWidth/__tests__/chatWidth.test.ts` and
  `src/pages/content/editInputWidth/__tests__/editInputWidth.test.ts`. At 70% width, a synthetic
  drag over `.chat-container` must give the overlay and `input-area-v2` identical left and right
  edges. `editInputWidth` tests must keep the `html body input-container` composer/overlay prefix.

## Gemini luminous width variables cap the thread at 708px

- **Trap:** Gemini 3.8's `.enable-luminous-content-width-update` host sets
  `--bard-chat-window-content-width-default: 708px`. Native conversation and input rules read
  `max-width: var(...)`. Voyager used to only set `max-width: none` / a pixel cap on its own
  selectors, so the composer stayed on chat width's more specific `input-area-v2` rule and the
  thread could look stuck at the luminous cap on the new layout.
- **Rule:** `chatWidth` must assign both luminous variables on the chat-window hosts and keep an
  explicit width on `.conversation-container`. `editInputWidth` must assign the same variables on
  `input-container` and beat chat width's input/overlay selectors when both sliders are enabled.
- **Guard:** `src/pages/content/chatWidth/__tests__/chatWidth.test.ts` and
  `src/pages/content/editInputWidth/__tests__/editInputWidth.test.ts`.

## Template placeholders must stay on double braces

- **Trap:** Prompt bodies render through `marked` with `marked-katex-extension`, so a single-brace
  placeholder syntax would claim `{a}` and `{b}` out of `\frac{a}{b}`, and the `{` in any JSON
  snippet a prompt happens to quote. Widening the syntax looks like a small convenience and
  silently corrupts every maths and code prompt in the library.
- **Rule:** Only `{{name}}` is a placeholder, and a prompt is a template only when it contains one,
  so a body without them keeps exactly its previous behaviour. `\{{` escapes a literal opener.
  Migration from single braces is an explicit author action (`convertLegacyBraces` behind the
  form's button), never inferred: only the author knows whether a given `{x}` is a placeholder or
  prose. Anything that has to find placeholders in already-rendered text builds its matcher from
  `TEMPLATE_VARIABLE_SOURCE` rather than copying the character class.
- **Guard:** `src/features/prompt/model/__tests__/promptTemplate.test.ts` asserts that
  `\frac{a}{b}` and `{"role": "user"}` yield no variables, and that the escape survives parsing.

## Prompt panel accent must come from the brand token, not a rebuilt hue

- **Trap:** The prompt panel's form controls are themed in three parallel layers: the base rules, a
  `prefers-color-scheme` / `.theme-host.<theme>` layer, and a `.gv-pm-panel[data-gv-theme='…']`
  layer. The panel always carries `data-gv-theme`, so that last layer is the one that renders.
  `.gv-pm-save` rebuilt its colour as `oklch(0.55 0.17 var(--gv-pm-brand-h))` — keeping only the
  hue — and then hardcoded hue 158 in `:hover` and hue 160 in the dark foreground. A user's custom
  accent therefore lost its chroma at rest and snapped back to the default green on hover.
- **Rule:** Paint accent surfaces with `var(--gv-pm-brand, var(--gv-pm-brand-default))`,
  `var(--gv-pm-brand-fg, …)` and `var(--gv-pm-brand-hover)`. The `*-default` tokens are already
  theme-scoped for `:root`, `prefers-color-scheme: dark`, `.theme-host.dark-theme` and
  `.theme-host.light-theme`, so a token-driven rule adapts without a per-theme copy. Reserve
  `oklch(… var(--gv-pm-brand-h) / <alpha>)` for translucent washes, never for a solid fill. When
  restyling one layer, update the `data-gv-theme` layer too or the change never ships.
- **Guard:** `src/pages/content/prompt/__tests__/promptFormStyle.test.ts`. Every `.gv-pm-save` block
  that sets a background must resolve it through a brand token, and no `.gv-pm-save` / `.gv-pm-add`
  block may contain a literal hue 158 or 160.

## Gemini's edit-mode actions rely on block-level `justify-self`

- **Trap:** Gemini right-aligns the Cancel/Update row with `justify-self: flex-end` on
  `.edit-button-area`, a block-level flex container inside a `display: block` parent.
  Self-alignment in block layout is a Chrome-only feature today. Safari drops the declaration, so
  the row stretches to the full container width per spec and its own `justify-content: flex-start`
  parks both buttons at the far left, visually detached from the edit box. Measured on the live
  page: Chrome `x=904 w=172`, Safari `x=352 w=724`, with every other element in the edit tree
  identical. No Voyager module targets this element, and the width sliders do not need to be
  enabled for it to happen — do not start by suspecting `editInputWidth`.
- **Rule:** Reproduce Gemini's intended result with properties every engine implements:
  `width: fit-content` plus `margin-inline-start: auto` on `.user-query-container
.edit-button-area`. Both need `!important` because Gemini's own `margin: 0` rule carries two
  attribute selectors. Keep the margin logical so the row still lands on the inline end in RTL.
  Verified as a no-op in Chrome: the row measures `x=904 w=172` with and without the shim.
- **Guard:** `src/pages/content/__tests__/geminiEditActionsStyle.test.ts`. The shim must keep both
  `!important` declarations, must not use a physical `margin-left`, and its selector must match the
  edit-mode row without catching an unrelated `.edit-button-area`.

## Edit input width desynced Cancel/Update from the edit box

- **Trap:** Gemini's edit mode nests two `.edit-container` elements. The outer one holds both the
  prompt box and `.edit-button-area` (Cancel/Update); the inner one sits inside
  `.query-content.edit-mode` and starts indented by that element's horizontal padding.
  `editInputWidth` matched both with `.edit-mode .edit-container` and gave them the same
  `width: min(100%, <slider>)`, without `box-sizing: border-box`. Measured live at 60%: the outer
  container ended at x=1036 and the form field at x=1088, so the box overhung the button row by
  exactly the padding and the actions no longer sat under it.
- **Rule:** The slider width belongs to the outermost edit container only. Anything nested
  (`.edit-mode .edit-container .edit-container`, `.edit-mode .edit-container .query-content.edit-mode`)
  must be `width: 100%` so it fills that owner instead of re-clamping from a different left offset.
  Every selector that carries a width must also carry `box-sizing: border-box`, because these
  containers have horizontal padding.
- **Guard:** `src/pages/content/editInputWidth/__tests__/editInputWidth.test.ts`. The nested-fill
  selector is read back out of the injected CSS and run against Gemini's real edit-mode shape: it
  must match the inner container and `.query-content.edit-mode`, and must not match the outer one.

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

## A panel remount must not close the folder dialogs that hold unsaved input

- **Trap:** `onPanelUnmount` called `dialogs.closeAll()`, and `FolderSidebarRuntime` runs that same
  unmount when Gemini rebuilds its sidebar, not only on stop. A folder instructions editor or
  move-to-folder picker open at that moment vanished mid-edit and took the typed text with it. The
  two are body-level overlays with no tie to the sidebar, so nothing about the rebuild required
  closing them.
- **Rule:** Give the unmount a reason. `stop` closes everything; `remount` closes only the transient
  views. A view is transient unless it is a body-level modal holding user input — the colour picker,
  delete confirmations and context menus are anchored to a sidebar row and would otherwise be
  stranded at stale coordinates against a rebuilt list, so those must still close.
- **Guard:** `src/pages/content/folder/folderDialogs.test.ts`
  (`keeps the input-bearing modals across a panel remount and drops the anchored ones`).

## Template fill slots must be measured, not sized by the `size` attribute

- **Trap:** `openTemplateFill` created each inline slot as `<input type="text">` with
  `slot.size = Math.max(variableName.length, 4)`, set once at creation and never updated. Typing a
  value longer than the variable name left the box at its original width with the text scrolling
  horizontally inside it, so the sentence the slots sit in visibly broke apart. Measured live on
  gemini.google.com: a slot for `{{topic}}` stayed 68.5 px wide while `一个 AI 的可解释性研究方向`
  needed 171 px. `size` could not have fixed it either — it counts characters against an average
  Latin advance, so a CJK value is about twice as wide as the attribute claims.
- **Rule:** Size an inline slot from a hidden sizer span that inherits the slot's font and padding,
  and re-fit on every `input` — including the peer slots that mirror a repeated variable. Fit after
  the surface is in the document, since nothing is measurable before it inherits its font.
- **Guard:** `src/pages/content/prompt/__tests__/PromptTemplateFill.test.ts`
  (`grows a slot to fit what is typed into it, and its repeats too`).

## An off-canvas measuring span must not be `position: absolute` inside a scroll container

- **Trap:** `.gv-pm-slot-sizer` parked itself at `position: absolute; left: -9999px` inside
  `.gv-pm-fill`, which is `overflow: auto`. `visibility: hidden` does not remove a box from its
  ancestor's scrollable overflow, and the `-9999px` escape only works while that ancestor is LTR:
  overflow past the inline-start edge is unreachable, so no scrollbar appears. On an RTL host page
  the surface inherits `direction: rtl` from the page — `body.gv-rtl` is only a scoping hook and
  never sets `direction` itself — which makes the same offset end-side overflow. Every template fill
  surface then carries a horizontal scrollbar, and a wheel or trackpad gesture pans the sentence
  off-screen.
- **Rule:** Measure with a `position: fixed` span, not an absolute one. A fixed box contributes to no
  ancestor's scrollable overflow in either direction. It is safe here because its containing block is
  the viewport, exactly like `.gv-pm-fill` itself, so it adds no dependency the surface does not
  already have — but that holds only while no ancestor carries `transform`, `filter` or `contain`,
  which would re-contain the fixed box and would already be mispositioning the surface.
- **Guard:** `src/pages/content/prompt/__tests__/promptFormStyle.test.ts`
  (`keeps the slot sizer out of the fill surface scroll region`), which also pins the
  no-transform premise on `.gv-pm-fill`.

## A Gemini user turn's `textContent` is not the message

- **Trap:** `SentPromptChips` read the whole bubble to decide which saved prompt a turn came from, and
  nothing ever matched. Read off gemini.google.com, `.user-query-bubble-with-background.textContent`
  is `"You said 给出 md 版本的本文  给出 md 版本的本文 "` — a `cdk-visually-hidden` screen-reader
  prefix, then the text again. The bubble also holds the copy, edit and expand controls, which render
  through a Material Symbols icon font whose glyph _is_ the element's text, so the string gains
  literal words like `content_copy` and `expand_more`. The same effect shows in sidebar titles, which
  read `chat_bubble请求 Markdown 格式转换`.
- **Rule:** Read a user turn through `.query-text-line` (then `.query-text`), as
  `DOMContentExtractor` already does. Only fall back to the bubble with the controls stripped from a
  clone, never from the live node.
- **Guard:** `src/pages/content/prompt/__tests__/SentPromptChips.test.ts`
  (`ignores the icon-font controls beside the message`), whose fixture carries the same controls.

## A long Gemini turn is clamped, not truncated

- **Trap:** A long user message shows a few lines and an expand chevron, which reads as Gemini having
  dropped the rest. It has not: measured on two real turns, all 62 `.query-text-line` elements and
  all 956 characters are in the DOM, with `scrollHeight === clientHeight === 62` because
  `.query-text.collapsed` clamps the height. Designing around recovering text that is already there
  wastes a fix.
- **Rule:** Read the text regardless of the clamp, and do not try to lift it. Removing `.collapsed`
  makes Gemini put it straight back; pressing its own
  `[data-test-id="luminous-expand-button"]` makes Gemini re-render the whole turn. Both land as a
  grow-then-shrink flicker. A feature that needs the full text on screen should render its own copy
  and keep Gemini's lines hidden, which is what `SentPromptChips` does.
- **Guard:** `src/pages/content/prompt/__tests__/SentPromptChips.test.ts`
  (`never presses Gemini's expand button`).

## Pressing Gemini's expand button re-renders the whole turn

- **Trap:** With the clamp no longer being fought, expanding still flickered. Sampling the bubble
  across the click showed its height going to `0` at +600 ms: Angular replaces the turn's nodes, so
  the element reference, the inserted chip and every class on it are gone. The observer then sees a
  fresh matching turn and collapses it again — the reader's expand undone by our own code.
- **Rule:** Any per-turn state a content module keeps must be keyed on something that survives a
  re-render, such as the message text. An element reference, a class or a dataset flag on a Gemini
  node cannot be.
- **Guard:** `src/pages/content/prompt/__tests__/SentPromptChips.test.ts`
  (`stays open on a turn the reader opened, even after the nodes are replaced`).

## Text typed after a slash token lands on the prompt's own last line

- **Trap:** Matching a sent turn against its saved prompt was anchored at both ends, so a turn where
  the person kept typing never matched. Measured on a real send: the prompt normalised to 749
  characters, the message to 751, diverging at 749 with `大大` appended — on the prompt's final line,
  with no newline between them. Splitting only on line boundaries missed it too.
- **Rule:** Measure how far the prompt reaches in characters (`^pattern` with lazy wildcards, then
  the match length) and render the remainder as the feature's own element. Collapsing the whole turn
  would hide the sentence the person actually wrote. Note also that each rendered line carries its
  own padding - the first comes back as `" # 寓言写作 Prompt "` - so the pattern has to absorb
  leading whitespace, and that whitespace must be a counted capture group or every offset after it
  is short by its length.
- **Guard:** `src/features/prompt/model/__tests__/promptTextMatch.test.ts`
  (`finds the boundary inside a line when the person typed straight on`).

## A placeholder name must survive everything the parser accepts

- **Trap:** `NAME` was `[\w一-龥.\-]+`. Outside `u` mode `\w` is ASCII-only, and the Han range that
  followed it covers neither kana, hangul, Cyrillic, Arabic, nor an accented Latin letter, so
  `{{テーマ}}`, `{{주제}}`, `{{имя}}`, `{{العنوان}}`, `{{año}}` and `{{thème}}` all failed
  `isPromptTemplate`: the fill surface never opened and the raw `{{...}}` went to the model, with no
  error anywhere. Separately, the names the parser did accept included `constructor`, `toString` and
  `__proto__`, and the fill surface collected them into a plain object — reading one back answered
  from `Object.prototype` with a non-string, and the `.trim()` that followed threw and took the
  whole surface down on submit.
- **Rule:** The charset is `[\p{L}\p{M}\p{N}._-]` and every regex built from it carries `u`
  (property escapes are a syntax error without it; Safari has had them since 11.1, under our 15.4
  floor, unlike the lookbehind the same module still avoids). `\p{M}` keeps a decomposed accent part
  of its name. Because a name is whatever the author typed, never read a value out of a plain object
  by that name: collect into `Object.create(null)` and read through `hasOwnProperty`.
- **Guard:** `src/features/prompt/model/__tests__/promptTemplate.test.ts`
  (`accepts a name written in any locale the extension ships`,
  `fills a name that collides with an Object prototype member`),
  `src/pages/content/prompt/__tests__/PromptTemplateFill.test.ts`
  (`fills a placeholder named after an Object prototype member`).

## A preview that hangs over a live chat must not be able to navigate it

- **Trap:** The prompt hover preview renders the body as Markdown into `document.body`. DOMPurify
  sanitises the URL of a link but adds no `target`, so following one replaced the current Gemini,
  Claude or ChatGPT tab and discarded an in-progress conversation. Every other outbound link in the
  same module already used `window.open(..., '_blank', 'noopener')`.
- **Rule:** After sanitising rendered Markdown into any surface that floats over the host page,
  rewrite `a[href]` to `target="_blank"` with `rel="noopener noreferrer"`. Sanitising the markup is
  not the same as making it safe to click.
- **Guard:** `src/pages/content/prompt/index.ts` (`openTooltipLinksInNewTab`, called from the
  tooltip's `paint`).

## A template fill action must match the button the user opened

- **Trap:** The fill button chose Copy or Insert when the surface opened, but its submit callback
  read the current `PROMPT_INSERT_ON_CLICK` preference. Changing that preference from the extension
  popup while filling a template left the button unchanged and silently switched its action.
- **Rule:** Capture the delivery mode when opening the fill surface and use it for both the label
  and submission, including Keep as is. A later opening or a plain prompt click uses the latest
  preference; a setting change must not discard values already being entered.
- **Guard:** `src/pages/content/prompt/__tests__/templateFillAction.test.ts` exercises the real
  manager's fill surface and storage listener, then checks delivery before and after reopening.
