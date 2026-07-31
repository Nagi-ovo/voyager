# Regression Notes

Internal notes for bugs that were easy to misdiagnose or likely to regress.
This is not a second issue tracker. Keep each entry short and point to the
test that protects the behavior.

Add an entry when all of these are true:

- The root cause was non-obvious.
- A future maintainer could plausibly repeat the mistake.
- There is now a regression test or a clear verification command.

Entry format:

```md
## Short title

Symptom:

Root cause:

Fix:

Regression test:

Commit:
```

## Timeline navigation must validate the live scroll viewport

Symptom:

Timeline dots, preview-list items, and `j`/`k` shortcuts could all appear inert after Gemini rebuilt its chat viewport.

Root cause:

The navigation fast path treated connected marker and container nodes as current. Gemini can insert a new scroll viewport inside the old connected container, so Voyager wrote `scrollTop` to the stale ancestor.

Fix:

Before navigation, validate the target's nearest scroll container against the cached viewport. Rebind and recalculate markers when it changed, including preview-panel navigation.

Regression test:

`src/pages/content/timeline/__tests__/TimelineManagerFlowClickActiveReset.test.ts` (`refreshes connected markers when Gemini inserts a new scroll viewport` and `refreshes the scroll viewport before preview-panel navigation`) and `src/pages/content/timeline/__tests__/TimelineManagerNavigationRefresh.test.ts` (`rebinds a connected stale scroll viewport before shortcut navigation`).

Commit:

`fix(timeline): refresh stale scroll viewports`

## Low-confidence watermark matches require isolated trial removal

Symptom:

Gemini watermarks at a known template and anchor could remain untouched when
image content weakened their spatial and gradient correlations just below the
trusted detection thresholds.

Root cause:

The anchor chooser returned the historical default when no candidate was
trusted, and the removal path then rejected that same untrusted signal without
testing whether one reverse-alpha pass would specifically suppress the known
watermark pattern.

Fix:

When every known anchor misses the trusted thresholds, trial each preset
template and allowed snap offset independently against the original pixels.
Accept only candidates whose spatial and gradient signals both decrease, whose
combined suppression exceeds `0.08`, and whose severe-undershoot ratio stays
below `0.1`; restore every trial before applying the strongest candidate once.
The existing trusted path remains unchanged and keeps priority.

Regression test:

`src/pages/content/watermarkRemover/__tests__/watermarkEngine.test.ts`
(`accepts a difficult match only when both signals improve and removal stays
safe`, `selects the strongest difficult candidate without retaining trial
pixels`, `finds a difficult small watermark at a snapped offset`, and `leaves
trial pixels unchanged when no difficult candidate qualifies`). The same file
also verifies that the difficult path applies exactly one pass and never takes
over after a trusted candidate's safety rollback.

Commit:

`fix(watermark): add difficult-match fallback`

## Full-size V2 removal needs gradient-backed transition evidence

Symptom:

A subtle 96px V2 watermark on a bright diagonal background was detected at the
correct anchor, but the visually correct reverse-alpha result was rolled back.

Root cause:

The reconstructed background retained mild positive spatial correlation with
the star template, leaving spatial suppression at `0.177`, just below the
default `0.2` reliability-transition gate even though gradient correlation
dropped from `0.167` to `0.052` without clipping or severe undershoot.

Fix:

Keep the default safety gate unchanged. Only for the exact 96px May 2026 V2
preset, accept the first transition out of reliable detection when spatial and
gradient suppression independently exceed narrow thresholds, the absolute
residual correlations are below the direct-match thresholds, and the trial
introduces no new black or clipped pixels. Correlation sign is deliberately
ignored because a clean reconstruction can cross zero. Subsequent passes still
use the default gate.

Regression test:

`src/pages/content/watermarkRemover/__tests__/watermarkEngine.test.ts`
(`accepts the reported full-size V2 reliability transition without weakening
the default gate` and `rejects the supported transition when ...`).

Commit:

`fix(watermark): accept safe full-size V2 transitions`

## Dark watermark restoration must distinguish clipping from severe undershoot

Symptom:

Valid white watermarks on dark backgrounds were left untouched even when the
template and anchor matched, because correct restoration produced many black
or channel-clipped pixels.

Root cause:

The removal safety gate treated the number of newly black/clipped pixels as
proof of damage. It could not distinguish a correct reconstruction near zero
from an over-strong alpha subtraction that fell far below zero before clipping.

Fix:

When the legacy near-black or clipping limits are exceeded, only roll back if
at least 10% of watermark-region pixels have a raw reverse-alpha channel below
`-5`.

Regression test:

`src/pages/content/watermarkRemover/__tests__/watermarkEngine.test.ts`
(`accepts clipped pixels that reconstruct a dark background without severe
undershoot` and `rejects a watermark-like pattern when trial removal would clip
pixels`).

Commit:

`fix(watermark): distinguish dark restoration from clipping damage`

## Watermark toggles must reconfigure already-open Gemini tabs

Symptom:

Changing either watermark-removal toggle in the popup had no effect in an
already-open Gemini tab until the page was refreshed.

Root cause:

The content runtime read both settings only during startup. Background
registration kept future documents in sync, but dynamically registering
`fetchInterceptor.js` did not install it into a document that was already open
when download removal changed from disabled to enabled.

Fix:

Route watermark storage changes through the existing content-script storage
listener only after normal Gemini startup has activated the watermark runtime,
reuse its initialized engine, and reject stale async starts and in-flight
preview writes with a lifecycle generation. Reconfigure preview and download
as separate lifecycles: if download removal stays enabled, preserve its bridge,
intent, observers, and active feedback while preview changes; only a true
download disable performs the full download teardown. Tag each download intent
and MAIN-world status with the same token so a late result from an older
download cannot finalize a newer sequence. If a restart leaves preview removal
enabled, retry stale preview work after releasing its queue slot. Clear preview
bookkeeping without restoring the current image source, so Gemini can reuse the
same image node without stale markers blocking a later preview. When download
removal is enabled, also inject the guarded MAIN-world interceptor once into
matching open tabs; disabling keeps installed wrappers in immediate
pass-through mode through the DOM bridge.

Regression test:

`src/pages/content/watermarkRemover/__tests__/runtimeToggle.test.ts` verifies
bidirectional runtime changes, engine reuse, stale-start and stale-preview
rejection, latest-lifecycle preview retry, reused-node processing, preview-only
download preservation, stopped-download cleanup, stale-status rejection, and
startup-gated content entry wiring.
`src/pages/background/__tests__/watermarkOpenTabs.test.ts` verifies targeted
MAIN-world injection and closed-tab failure handling.

Commit:

`fix(watermark): apply toggles to open Gemini tabs`

## Watermark download indicators must not wait for engine assets

Symptom:

The 🍌 indicator appeared noticeably after Gemini's download button, even
though clicks during that window already queued correctly for watermark
processing.

Root cause:

The download bridge was installed before `WatermarkEngine.create()`, but both
the initial indicator decoration and its DOM observer were installed only after
the engine finished loading all watermark image assets.

Fix:

Decorate existing buttons and start the lightweight indicator observer before
awaiting engine initialization. When preview removal is enabled, disconnect
that temporary observer before the preview observer takes over so only one
page-wide image observer remains active.

Regression test:

`src/pages/content/watermarkRemover/__tests__/engineRaceCondition.test.ts`
(`shows download indicators while WatermarkEngine.create is still pending`).

Commit:

`fix(watermark): show indicators while engine loads`

## Native download health checks must not depend on watermark removal

Symptom:

Gemini could show a sharp generated-image preview but return a blurred or
partially blank full-size PNG from its native download endpoint. With watermark
removal disabled, Voyager passed the response through correctly but could not
warn the user that Google's file itself was damaged.

Root cause:

Download click intent, the MAIN-world response bridge, and status toasts were
all started only for watermark processing. Turning removal off therefore also
disabled read-only comparison between the clicked preview and Google's final
image bytes. The first implementation also sampled Gemini's visible
`googleusercontent.com` `<img>` directly. Because Gemini does not set a
`crossorigin` attribute, Canvas pixel readback was tainted and silently
returned no preview fingerprint, causing the damaged download to be reported
as successful.

Fix:

Keep lightweight click intent and bridge listeners active independently of the
two removal toggles. When removal is off, return Gemini's original Promise and
Response objects unchanged, inspect only a clone, and warn only when a 32×32
preview/download fingerprint has a severe mismatch. Never warn from the
download alone: a legitimate image may intentionally contain a large flat
region. If direct preview sampling is tainted, fetch that exact preview URL
through the extension runtime and await its origin-clean fingerprint without
delaying the synchronous native download intent.

Regression test:

`src/pages/content/watermarkRemover/__tests__/fetchInterceptor.test.ts` verifies
the disabled path preserves native Promise/Response identity while requesting
inspection. `imageHealthDetector.test.ts` covers damaged, healthy, and
legitimate-flat-region samples; `downloadToasts.test.ts` verifies the disabled
path stays silent unless a corruption status arrives.
`corruptedDownloadDetection.test.ts` reproduces a tainted Gemini preview and
requires the extension-fetch fallback to flag the mismatched download.

Commit:

`fix(watermark): warn about corrupted Google downloads`
`fix(watermark): handle tainted preview health checks`

## Mermaid must honor Gemini explicit light theme

Symptom:

With Gemini set to light while the browser reported a dark system preference,
Mermaid diagrams rendered with the dark theme.

Root cause:

Mermaid treated generic `body`/`html` dark markers as equal to Gemini's
higher-priority `.theme-host.light-theme`, so stale outer markers could
override the active Gemini theme.

Fix:

Resolve `.theme-host` first, then generic page markers, and only then fall back
to the browser preference.

Regression test:

`src/pages/content/mermaid/__tests__/mermaid.test.ts`
(`resolveMermaidTheme`).

Commit:

`fix(mermaid): honor explicit Gemini light theme`

## Folder recovery must remove untracked sidebar clones

Symptom:
Gemini's sidebar showed two complete Voyager folder panels, which displaced the
native conversation history and could make it appear unable to scroll.

Root cause:
Gemini can clone its virtualized sidebar subtree after Voyager mounts the folder
panel. The cloned `.gv-folder-container` is not referenced by
`FolderManager.containerElement`, so the old instance-only cleanup left that
orphan in place when recovery injected a replacement.

Fix:
Before mounting, remove both the tracked panel and untracked direct folder-panel
siblings from the current sidebar section host. Keep AI Studio and floating
multi-select containers out of this cleanup.

Regression test:
`src/pages/content/folder/__tests__/folderPositionEnforcer.test.ts`
(`removes an untracked folder clone before recovery mounts a replacement`).

Commit:
`fix(folder): remove cloned sidebar duplicates`

## Automatic folder fallback must not become a sticky floating mode

Symptom:
Folders briefly disappeared, then returned as a floating panel even though the
floating-mode setting was off. Closing that panel could leave a FAB that the
already-off popup toggle could not remove.

Root cause:
The recovery watchdog applied its grace period only when the sidebar container
existed. A transiently missing sidebar opened the fallback immediately, and the
shared panel-close callback always restored the explicit-mode FAB.

Fix:
Apply the same grace period to a missing sidebar, restore the FAB only for
explicit floating mode, and clear all fallback entry points when the sidebar
recovers.

Regression test:
`src/pages/content/folder/__tests__/folderPositionEnforcer.test.ts`
(`waits before opening the floating fallback when the whole sidebar is temporarily missing`,
`does not leave a FAB or immediately reopen after closing an automatic fallback`, and
`clears every floating fallback entry point when the sidebar recovers`).

Commit:
`fix(folder): prevent sticky automatic floating fallback`

## Firefox content scripts must not hold Web Locks with async callbacks

Symptom:
On Firefox, account-scoped folders appeared empty and timeline/highlight scope
resolution logged `Permission denied to access property "then"`.

Root cause:
Firefox Bug 1873028 runs a Web Locks callback from a different security realm
than the WebExtension content script. Returning the content script's Promise
from `navigator.locks.request()` therefore fails even though the same code works
in Chrome and Safari.

Fix:
Firefox web-page content scripts route account-scope resolution through the
existing extension-background message. The background page keeps the shared Web
Lock and serialized profile-map update; other browser builds keep their original
path unchanged.

Regression test:
`src/core/services/__tests__/AccountIsolationService.test.ts`
(`resolves Firefox content-script scopes in the background instead of using Web Locks`).

Commit:
`fix(firefox): resolve account scopes outside content scripts`

## Folder conversation navigation must not hard-refresh Gemini

Symptom:
Clicking a folder conversation sometimes forced a full Gemini page refresh
instead of switching sessions inside the existing SPA.

Root cause:
The folder navigator tried to preserve Gemini's native SPA behavior by clicking
the corresponding native sidebar link, but its fallback used `location.assign`.
That fallback fired when the native sidebar row was virtualized/not rendered,
or when Gemini's own route change was slower than the confirmation timeout.
The floating folder panel had an even more direct `location.assign` path.

Fix:
Route folder and floating-panel conversation clicks through the shared
conversation navigator. If the native link is missing or does not navigate,
fall back to `history.pushState` plus `popstate`, not a hard page load.

Regression test:
`src/pages/content/folder/__tests__/folderNavigation.test.ts`
`src/pages/content/folder/__tests__/folderDisabledRuntime.test.ts`

Commit:
`fix(folder): keep folder navigation in gemini spa`

## Prevent auto scroll swallowed `scrollIntoView` layout side effects

Symptom:
With prevent-auto-scroll enabled, sending a Gemini message could make the
sidebar/folder area render far too wide. Collapsing and reopening the sidebar
restored the layout.

Root cause:
The page script returned early from Gemini's native `scrollIntoView`. That
blocked the downward chat jump, but it also swallowed Gemini's own layout side
effects for the sidebar.

Fix:
Let the native `scrollIntoView` run, then restore protected vertical scroll
positions for the chat/viewport.

Regression test:
`src/pages/content/preventAutoScroll/__tests__/preventAutoScrollScript.test.ts`

Commit:
`b9dfaf1e fix(prevent-auto-scroll): preserve layout side effects`

## Sidebar scroll exception must stay scoped away from chat scroll blocking

Symptom:
The prevent-auto-scroll feature blocked the Gemini sidebar history list from
scrolling after a submit.

Root cause:
The original blocking logic applied to any scrollable ancestor while the
submit block window was active. Sidebar scroll containers were treated like the
chat transcript.

Fix:
Classify sidebar elements separately from chat scroll elements before blocking
`scrollTo`, `scrollBy`, `scrollTop`, or `scrollIntoView`.

Regression test:
`src/pages/content/preventAutoScroll/__tests__/preventAutoScrollScript.test.ts`

Commit:
`69834523 fix(prevent-auto-scroll): keep sidebar history scrollable`

## Gemini table menus are not model menus

Symptom:
Gemini table option menus showed Voyager default-model star buttons, including
the "Set as default model" tooltip.

Root cause:
The default model injector treated generic Gemini menu DOM such as
`.label-container` as enough evidence that a popup was a model menu. Gemini
table menus use similar menu structure.

Fix:
Require model-menu evidence such as `data-mode-id`, `.mode-title`, or
`.title-and-description` before injecting star buttons.

Regression test:
`src/pages/content/defaultModel/__tests__/modelLocker.test.ts`

Commit:
`2d7d8e12 fix(default-model): avoid table option menu stars`

## Default model auto-apply must yield to active composer input

Symptom:
Typing in a fresh Gemini chat could lose focus while the page was still
loading. Disabling default-model auto-apply made the problem disappear.

Root cause:
The default-model lock loop opened Gemini's model picker after startup even
when the user had already started typing in the composer. The follow-up
refocus helped after the switch, but the menu click still stole focus first.

Fix:
Track composer input/keydown activity and skip the current auto-apply attempt
once the user has started editing the chat input.

Regression test:
`src/pages/content/defaultModel/__tests__/modelLocker.test.ts`

Commit:
`fix(default-model): avoid stealing composer focus`

## Thinking-level default must resolve by label, not per-row OR

Symptom:
Both Standard and Extended showed a filled default star at once in the
Thinking level submenu — two "defaults" selected simultaneously.

Root cause:
`isThinkingDefaultForItem` marked a row default when EITHER its label matched
the stored label OR its position matched the stored index. When the stored
`{index, label}` pair drifted apart (e.g. saved under a different submenu
order/language), the label lit one row and the stale index lit another, so two
stars turned gold. The stored index and label are separate keys and can
disagree; an OR test over each row cannot stay single-valued.

Fix:
Resolve exactly one default row per render (`resolveThinkingDefaultIndex`):
prefer the label match, fall back to the stored index only when no label
matches and it addresses a real row. The star click now reads its own
`is-default` class instead of re-deriving from `(index, label)`.

Regression test:
`src/pages/content/defaultModel/__tests__/modelLocker.test.ts`
("marks only one thinking level default when the stored index and label
disagree")

Commit:
`fix(default-model): resolve single thinking-level default`

## Auto-applied thinking level must close the picker it opened

Symptom:
After auto-selection ran, the Thinking level row was unresponsive — clicking it
did nothing until the whole model picker was closed and reopened by hand.

Root cause:
`tryLockToThinkingLevel` opened the picker and thinking-level submenu
programmatically, clicked the target level, then refocused the composer but
never closed the menu. The half-open picker (with a lingering submenu overlay)
left the row's hover/submenu machinery in a state the user's next open could
not drive.

Fix:
Close the menu (`document.body.click()`) right after the auto-switch click, so
the next manual open starts clean — mirroring the already-selected branch.

Regression test:
`src/pages/content/defaultModel/__tests__/modelLocker.test.ts`

Commit:
`fix(default-model): close picker after auto thinking switch`

## Never lock to the page-default Standard thinking level

Symptom:
On an already-correct new chat (model + thinking already at the starred value)
the model picker still flashed open for a moment on load, intermittently.

Root cause:
The lock loop always started (first tick at 1s) and, in load-timing windows,
opened the picker to "enforce" a thinking-level default even when Standard —
Gemini's built-in default — was the target. Enforcing Standard is a pure no-op
(the page already opens there) so the open was always wasted churn. A default
corrupted to a non-Standard value by the double-star bug made it worse.

Fix:
Treat a Standard target (index 0 / label "standard") as "no thinking
preference" for enforcement (`isPageDefaultThinkingLevel`), keeping the raw
value only for the star display. Also bail before starting the loop when the
trigger pill already shows the starred model + thinking level.

Regression test:
`src/pages/content/defaultModel/__tests__/modelLocker.test.ts`
("never enforces the page-default Standard thinking level")

Commit:
`fix(default-model): don't enforce Standard thinking level`

## tryLockToModel must reuse the bidirectional pill match

Symptom:
On load the model picker still flashed open for an instant and left a focus
ring on the trigger pill, even though the model + thinking level were already
the starred values (Pro + Standard).

Root cause:
`tryLockToModel`'s "already selected" early-return used a forward-only
whole-word test: it checked whether the stored long name ("3.1 pro") appeared
in the short pill label ("pro"), which is false. So whenever a tick reached
it — e.g. a load-timing window where the pill briefly read empty and
`modelMatchesLines` returned false — it opened the picker to "switch" to a
model that was already selected, then closed it. Angular CDK restored focus to
the trigger on close, leaving the ring.

Fix:
Early-return using the same `modelMatchesLines` (bidirectional short/long)
check as the fast-path, and bail without opening the menu when the pill is not
readable yet (retry next tick).

Regression test:
`src/pages/content/defaultModel/__tests__/modelLocker.test.ts`
("does not open the picker while the trigger pill is still empty")

Commit:
`fix(default-model): reuse bidirectional match in tryLockToModel`

## Gemini native copy traffic is not generation traffic

Symptom:
Clicking Gemini's native copy response button could make the page feel stuck
or trigger generation-related observers.

Root cause:
The observers looked at `batchexecute` request bodies and could match
generation-looking text inside copy-related traffic. Both `fetch` and XHR paths
needed the same guard.

Fix:
Ignore copy/non-generation `batchexecute` requests before treating traffic as
generation completion or usage refresh evidence.

Regression test:
`src/pages/content/responseNotification/__tests__/pageObserver.test.ts`
`src/pages/content/usageStatus/__tests__/usageObserver.test.ts`

Commit:
`7c0916fd fix(notification): ignore copy batchexecute keyword matches`

## Gemini usage buckets must use the period enum, not reset order

Symptom:
The Gemini usage bar could swap the 5h and weekly limits.

Root cause:
The parser inferred bucket labels from reset order. That breaks when the
weekly reset is sooner than the rolling 5h window.

Fix:
Use Gemini's period enum when present. Do not guess labels from reset order
when the enum is unknown.

Regression test:
`src/pages/content/usageStatus/__tests__/usageStatus.test.ts`

Commit:
`146a698f fix(usage): map Gemini usage buckets by period`

## Gemini usage parsing must tolerate unknown sibling buckets

Symptom:
On both Chrome and Edge, refreshing the usage pill from a conversation could
finish without an error but leave the quota and "updated" timestamp unchanged.
Opening `/usage` still refreshed the values.

Root cause:
Gemini added a `period=4` quota bucket whose tuple layout differs from the
existing 5h (`period=1`) and weekly (`period=2`) buckets. The parser required
every sibling tuple to match the known layout, so one unfamiliar bucket caused
it to discard the entire otherwise-valid HTTP 200 RPC response.

Fix:
Recognize a candidate metric array when it contains any valid known tuple,
parse its members independently, and ignore unfamiliar buckets. Continue to
map only `period=1` and `period=2`; do not infer unknown periods by position.

Regression test:
`src/pages/content/usageStatus/__tests__/usageStatus.test.ts`
("ignores unfamiliar sibling quota buckets without dropping daily and weekly usage")

Commit:
`335572c6 fix(usage): tolerate unknown quota buckets`

## KaTeX radicals need their SVG layout preserved before export

Symptom:
PDF/image exports rendered square-root radicals and fractions misaligned,
especially for Gemini math such as `\sqrt{2} \approx 1.414`.

Root cause:
Export rendering changed display/layout primitives around Gemini's KaTeX/SVG
radical nodes. The live DOM looked acceptable, but the export clone lost
enough layout information for radicals to shift.

Fix:
Preserve KaTeX layout primitives and inline radical SVG layout before PDF/image
rendering.

Regression test:
`src/features/export/services/__tests__/DOMContentExtractor.test.ts`
`src/features/export/services/__tests__/PDFPrintService.test.ts`
`src/features/export/services/__tests__/ImageRenderService.test.ts`
`src/features/export/services/__tests__/PDFPrintService.test.ts`
`bun run verify:katex-export`

Commit:
`fa059943 fix(export): preserve Gemini KaTeX radicals`

## KaTeX image export does not follow the PDF path

Symptom:
PDF export rendered square-root formulas correctly, but image export still
misplaced radicals/fraction layout. It was easy to think the fix worked by only
checking the PDF output.

Root cause:
PDF and image exports use different render paths. The image path goes through
`html-to-image`, which clones the target node and may scan the whole page's
stylesheets. On Gemini, cross-origin stylesheets can trip `cssRules` access and
KaTeX radicals/fractions depend on fragile `.vlist`, `.pstrut`, `.sqrt`, and
stretchy SVG/image layout rules, not just the KaTeX font files.

Fix:
Use Fable 5's verified image-path fix: supply scoped KaTeX font CSS via
`fontEmbedCSS` and inline the critical KaTeX layout primitives before capture.
The verification harness must exercise `ImageRenderService.renderTargetToBlob`,
not a direct `html-to-image` call or the PDF print flow.

Regression test:
`src/features/export/services/__tests__/ImageRenderService.test.ts`
`bun run verify:katex-export`

Commit:
`5a28ef00 fix(export): preserve katex layout in image exports`

## Claude usage settings hash may not open the modal by itself

Symptom:
Clicking the Claude usage link changed the URL hash to `#settings/usage`, but
the usage modal did not open until the page was refreshed.

Root cause:
Claude's SPA sometimes observes the usage hash only during load. A hash-only
navigation on an existing chat path is not always enough to mount the settings
modal.

Fix:
Keep the current chat path in the usage URL and reload only when usage content
does not appear after opening.

Regression test:
`src/features/plugins/builtin/claudeUsage/index.test.ts`

Commit:
`50f947fc fix(plugins): match claude usage reset display to gemini`

## Claude usage reset data can come from multiple surfaces

Symptom:
The Claude usage bar showed percentages but missed the reset countdown,
especially for the 5h window.

Root cause:
The visible settings DOM and the usage API do not always expose the same reset
data. Some 5h reset information arrives through `message_limit` events.

Fix:
Normalize usage API windows, visible settings DOM, cached snapshots, and
`message_limit` events into the same metric shape.

Regression test:
`src/features/plugins/builtin/claudeUsage/index.test.ts`
`src/features/plugins/builtin/claudeUsage/observer.test.ts`

Commit:
`8adae20a fix(plugins): fill claude 5h reset countdown`

## Chrome-only permissions must not leak into the shared base manifest

Symptom:
The Prompt Manager discovery nudge dots the toolbar icon via
`chrome.declarativeContent`, which exists only on Chrome/Edge. Declaring
`declarativeContent` in `manifest.json` would ship it to Firefox and Safari
too, where it is an unknown permission (AMO lint failure / Safari conversion
noise) even though the runtime code already no-ops there.

Root cause:
`manifest.json` is the single base manifest spread into every browser build
(`vite.config.base.ts` → `baseManifest`, consumed by the chrome/firefox/safari
configs). A permission added there is cross-browser by default. It is tempting
to drop a new permission into `manifest.json` next to the others.

Fix:
Inject Chrome/Edge-only permissions in `vite.config.chrome.ts`, where it spreads
`baseManifest` (`permissions: [...base, 'declarativeContent']`), keeping the base
manifest cross-browser clean. Guard the runtime with
`if (!chrome.declarativeContent?.onPageChanged) return;`. Two related traps for
the same feature: declarativeContent has no badge action, so `SetIcon` needs
`imageData` (an `ImageData`, not a `path`) — draw the dot with OffscreenCanvas;
and the dot lives on the toolbar icon, so unpinned users only see it inside the
puzzle menu (Chrome has no pin API; an in-page banner was rejected to preserve
"No access needed").

Regression test:
`src/features/plugins/__tests__/promptNudge.test.ts` (pure domain math).
Manifest scoping is verify-by-build:
`bun run build:chrome && grep -c '"declarativeContent"' dist_chrome/manifest.json`
must be `1`, while `manifest.json` / `manifest.dev.json` must be `0`.

Commit:
`f0f4bebe feat(prompt-nudge): dot the toolbar icon on unenabled chatgpt/claude sites`

## Claude timeline must treat the DOM as a sliding virtualized window

Symptom:
On claude.ai, the timeline "twitched" while scrolling long conversations —
dot count and positions changed constantly; after a long jump the timeline
suddenly shrank to a few dots; clicking a dot for an off-screen turn landed
mid-conversation instead of on the target message.

Root cause:
Claude virtualizes long conversations: only ~6–9 turns are mounted, the
window slides during scroll, and during long jumps the mounted set can be
sparse and NON-contiguous (old + new window briefly coexist; the tail tends
to stay mounted). Rebuilding markers from `querySelectorAll` each mutation
made the timeline mirror the mounted window; mount-index-based turn ids
(`c-<index>-<hash>`) changed as the window slid; any "drop what's missing
between two mounted turns" pruning rule mass-deletes markers when the window
goes sparse. Absolute offsets also drift because Claude re-measures content
as it mounts, so one-shot smooth scrolls to remembered offsets land off
target.

Fix:
`claudeTimeline` keeps a grow-only marker registry stitched by content-hash
anchors across overlapping windows (never drops; ids `c-<textHash>`, `~n`
for duplicates; legacy starred ids match via their hash segment). Navigation
to unmounted turns homes in iteratively (instant probe + direction-aware
bisection, smooth fine-aim once mounted); jumps >3 viewports are instant
even for mounted turns. Reuse this pattern for any future Claude DOM
feature.

Regression test:
`bun run test src/features/plugins/builtin/claudeTimeline/index.test.ts`
(esp. "never shrinks when the mounted window turns sparse mid-transition",
"keeps dots and ids stable when Claude virtualizes turns out during scroll").

Commit:
`05e0ef79 fix(claude-timeline): stop timeline jitter from claude's virtualized dom`

## onMessage listeners must not return true unconditionally

Symptom:
Background broadcasts (e.g. `gv.remoteAnnouncement.show` via
`chrome.tabs.sendMessage`) hung forever on tabs running the folder content
scripts; `await Promise.all` over the broadcast never settled. Per-tab
`catch` did not help because the promise neither resolved nor rejected.

Root cause:
Both folder `runtime.onMessage` listeners (Gemini `manager.ts` and
`aistudio.ts`) ended with an unconditional `return true`, telling Chrome "I
will respond asynchronously" for every message — including types they never
answer. A message with no responder anywhere on the page then keeps the
channel open forever. `return true` is only safe on branches that actually
call `sendResponse`.

Fix:
Return `true` only from branches that respond; fall through to
`return undefined` for unknown messages so the sender's promise settles
immediately. Any new content-script onMessage listener must follow this.

Regression test:
`src/pages/content/folder/__tests__/auditFixes.test.ts`
("returns undefined for unknown messages so the sender promise settles")
`src/pages/content/folder/__tests__/aistudioAuditFixes.test.ts`

## Folder storage mirror writes echo back through storage.onChanged

Symptom:
Every local folder save (star, drag, expand/collapse) triggered a redundant
full `loadData` + `renderAllFolders`, and rapid consecutive edits could
briefly flash the UI back to a stale state.

Root cause:
`FolderStorageAdapter.saveData` mirrors folder data into
`chrome.storage.local`, and `chrome.storage.onChanged` fires in the SAME
context that performed the write (unlike the window `storage` event). The
manager's onChanged handler treated its own mirror write as an external
change and reloaded.

Fix:
`armStorageEchoSuppression()` (counter + 2s window) is called before every
`storage.saveData`; the onChanged handler consumes one suppression per echo
and still reloads on genuine external writes (popup sync, other tabs). Any
new `storage.saveData` call site must arm the suppression first.

Regression test:
`src/pages/content/folder/__tests__/auditFixes.test.ts`
("skips the reload for our own mirror-write echo",
"still reloads for external writes")

## Highlight cleanup must preserve account clear markers

Symptom:
After a user cleared all highlights from Storage Manager, a later Google
Drive pull could restore the deleted highlights.

Root cause:
Deleting every `gvAnnotation:*` key also deleted the bounded account/platform
clear marker. Without that marker, an older remote record looked newer than
an empty local store and was imported again.

Fix:
Highlight cleanup must go through
`HighlightAnnotationService.clearAllAccounts()`. It removes annotation
buckets in one serialized commit while retaining small versioned clear
markers. Quota classification counts only `gvAnnotation:bucket:*` as
highlight content; `gvAnnotation:index:*` and the device id are protected
metadata/settings. Do not replace this path with `storage.remove()` over the
whole annotation namespace.

Regression tests:
`src/core/services/__tests__/HighlightAnnotationService.test.ts`
(`clearAllAccounts` cases) and
`src/core/services/__tests__/StorageQuotaService.test.ts`
(`clears the narrowly matched highlights category`).

## Safari notification clicks must be owned by the containing app

Symptom:
Safari showed the native response-complete notification, but clicking its
Open Conversation action only brought Voyager's status window forward. The
target conversation did not open or receive focus.

Root cause:
The notification was scheduled by the Safari app extension, so macOS routed
the response back to that process. System logs showed the response target with
`can launch: false`: the notification could be displayed, but Safari's app
extension was not relaunched to run its notification delegate. Adding a
foreground action or repeatedly reloading Safari did not change that process
ownership.

Fix:
Let the app extension validate permission and hand the notification to the
containing app before scheduling it. The app owns the notification category
and delegate; on click it dispatches the typed open-conversation message back
to Safari, which focuses the matching tab. Keep the handoff payload validated
and never log its full URL because it can contain conversation details.

Regression test:
`Voyager/Tests/NativeSupportTests.swift`
`src/pages/background/__tests__/responseCompleteNativeNotification.test.ts`
`src/core/utils/__tests__/safariNativeNotifications.test.ts`
`src/core/utils/__tests__/nativeOpenConversation.test.ts`

This also requires a live macOS/Safari check. The privacy-safe log chain must
reach `app didReceive` and `app dispatchMessage delivered to Safari`, and the
browser must visibly focus the target conversation. A passing build or a
visible notification alone does not verify the click route.

Commit:
`6e552732 fix(safari): route notification clicks through app`

## Safari full-size watermark downloads require a static page-world interceptor

Symptom:
Safari watermark downloads failed with **Original Image Not Found**. Processing
the image visible in Gemini appeared to work, but produced only a low-resolution
preview instead of the full-size generated image.

Root cause:
Gemini exposed only a `blob:` preview in the DOM. The full-size image URL was
available to `public/fetchInterceptor.js`, but Safari did not reliably install
the dynamically registered `MAIN`-world script for the temporary extension. A
stale dynamic registration could also win the interceptor's double-injection
guard after a rebuild.

Fix:
Declare `public/fetchInterceptor.js` as a static Safari `MAIN`-world manifest
content script, and unregister the legacy dynamic Safari copy. Keep the shared
fetch-interceptor download path instead of adding a Safari-only path that saves
the visible preview Blob.

Regression test:
`src/core/utils/__tests__/manifestPermissions.test.ts` verifies that the Safari
manifest loads the interceptor first in `MAIN` world. A live Safari check must
also confirm that the bridge is installed and enabled and that the downloaded
image has full-size pixel dimensions, not merely that a PNG file exists.

Commit:
`d3f0e71a fix(safari): restore full-size watermark downloads`

## Duplicate prompt names are a slash eligibility conflict, not invalid data

Symptom:
Import or cloud sync could silently drop an entire Prompt whose name matched an
existing Prompt. Historical duplicate-name groups also produced ambiguous slash
completion entries.

Root cause:
Name uniqueness was enforced while merging stored data. Conflict branches
skipped new records or replaced a newer same-ID name, while slash completion
accepted every non-empty name without grouping normalized equivalents.
Two page-level Drive merge paths also kept parallel timestamp-merge
implementations, so a newer legacy cloud record without `name` could erase the
local name even after the shared merge helper was fixed.

Fix:
Always preserve imported and synced Prompt records. Detect duplicate groups
with the shared trimmed, NFKC-normalized, case-insensitive key; exclude every
member of a duplicate group from slash completion and show a non-blocking
Prompt Manager badge until the names become unique. Route every Drive prompt
merge through the shared helper, which carries forward a local name when the
newer cloud record predates prompt names.

Regression tests:
`src/features/backup/services/__tests__/PromptImportExportService.test.ts`
`src/utils/merge.test.ts`
`src/pages/content/folder/__tests__/auditFixes.test.ts`
`src/pages/content/folder/__tests__/aistudioAuditFixes.test.ts`
`src/pages/content/prompt/__tests__/promptName.test.ts`
`src/pages/content/prompt/__tests__/slashPrompt.test.ts`
`src/pages/background/__tests__/runtimeMessageRouting.test.ts`

## Google Drive backup folders need a stable identity beyond their display name

Symptom:
Renaming `Gemini Voyager Data`, or resolving two syncs concurrently after the
folder cache was lost, could make Voyager create another root-level backup
folder. Changing the product name to `Voyager Data` would amplify this for
every existing user.

Root cause:
The Drive service rediscovered its folder only through an exact display-name
query. Drive keeps the file ID stable across moves and renames, but the ID was
cached only in memory and the folder carried no app-owned identity metadata.

Fix:
Create and tag `Voyager Data` with the private `voyagerDataFolder=1`
`appProperties` marker. Resolve marked folders first, recover pre-marker custom
renames from known sync-file parents, rename an unambiguous legacy folder in
place, and serialize first-time resolution so concurrent uploads cannot create
duplicates. Preserve custom names after marking. If both canonical and legacy
folders exist, never delete or ambiguously rename either folder automatically.
Search sync files inside the resolved folder before any global fallback.

Regression tests:
`src/core/services/__tests__/GoogleDriveSyncService.test.ts`
(`GoogleDriveSyncService backup folder migration`) and
`Voyager/Tests/NativeSupportTests.swift`
(`testDriveFolderIdentityMigratesOnlyAnUnambiguousLegacyName`). A live Drive
check must also preserve the original folder ID, parent location, and JSON
contents while changing only the legacy display name.

## Mermaid exports must prefer the rendered diagram over hidden source

Symptom:
PDF and image exports showed Mermaid source code even when Voyager displayed a
rendered diagram in the conversation.

Root cause:
The Mermaid wrapper contains both the hidden `code-block` and the rendered SVG.
The DOM extractor's generic nested-code-block branch matched the wrapper first,
emitted `<pre><code>`, and skipped the diagram. The same shortcut could match a
parent `response-element` or list before traversal reached the wrapper.

Fix:
When a `.gv-mermaid-wrapper` contains a rendered diagram SVG, emit a clean
`.gv-export-mermaid` clone for rich exports while preserving the original fenced
source in text output. Recurse through Mermaid response wrappers and preserve
list structure with indented fenced source. Fall back to the source block when
no SVG is available. Before opening the regular PDF print dialog or rendering a
whole-document PNG, rasterize only the Mermaid clone at 2x resolution: browser
renderers can otherwise preserve the SVG shapes while dropping or clipping
labels inside `foreignObject`. Keep the rest of the PDF as native text, and cap
the diagram to one printable page with proportional scaling. If rasterization
fails, replace the original SVG with a sanitized SVG data image directly; never
leave the raw SVG in the print DOM.

Regression test:
`src/features/export/services/__tests__/DOMContentExtractor.test.ts`
`src/features/export/services/__tests__/PDFPrintService.test.ts`
`src/features/export/services/__tests__/ImageRenderService.test.ts`
`src/features/export/services/__tests__/ImageExportService.test.ts`

Commit:
`fix(export): render Mermaid diagrams in exports`

## Gemini turn identity must not come from the mounted DOM index

Symptom:
After reloading a long conversation, bookmarks (stars) in Timeline Navigation
appeared on the wrong turns. Un-starring one of those wrong dots silently
deleted the original bookmark record.

Root cause:
Voyager used the current user-turn DOM index (`u-<index>`) as content identity.
Gemini virtualizes long conversations: after a reload the first mounted node
can be turn 60, yet it receives `u-0`. Prompt text cannot repair this reliably
because prompts can be duplicated, edited, truncated, or rendered differently.

Fix:
Use Gemini's response id (`rid`) as the canonical `s-<rid>` turn id. The
`hNvQHb` response supplies the complete ordered turn list, including unmounted
turns, so cache only that bounded id list per conversation and use it to map
legacy `u-N` records. Never derive a legacy alias from the current DOM window
and never guess by prompt text. If the complete map is unavailable, keep the
legacy record untouched but do not display, migrate, or delete it. Timeline
stars, hierarchy/collapse, timestamps, forks, highlights, and exports all use
the same resolver.

Regression test:
`src/pages/content/timeline/__tests__/starredResolution.test.ts`
`src/pages/content/timeline/__tests__/TimelineManagerStarredRelocation.test.ts`
`src/pages/content/timeline/__tests__/TimelineManagerIdentityAliases.test.ts`
`src/pages/content/timestamp/__tests__/historyTimestamps.test.ts`

Commit:
`fix(timeline): use stable Gemini turn identities`

## The chat width sparkle rule also matches the Gemini logo pill

Symptom:
With Voyager loaded and the sidebar open at >=1024px, Gemini's own header
buttons (close sidebar, Upgrade, temporary chat, more) became hard or impossible
to click. Narrowing the conversation-width slider changed how many buttons were
affected, which made the bug look like a sidebar-width problem.

Root cause:
`chatWidth` clamps loading indicators with `main > div:has(img[src*="sparkle"])`
(added for #110). Gemini's header logo wrapper `main > div.side-nav-menu-button`
also contains a sparkle SVG, so it matched too and was stretched to
`round(percent% x screen.availWidth)`. The wrapper itself is
`pointer-events: none`, but its child `chat-app-side-nav-menu-button` is
`pointer-events: auto` and inherits the stretched box, turning a 101px pill into
a transparent hit box across the header. That is why the blast radius tracked
the slider: the phantom width equals the computed pixel value, so low
percentages only covered the close-sidebar button while 100% swallowed the whole
header. Measuring the phantom box while only `sidebarWidth` is suspected is a
dead end — the box is real but `pointer-events: none`, so it looks harmless.

Fix:
Exclude the logo wrapper from that one rule with
`:not(:has(chat-app-side-nav-menu-button))`. Genuine sparkle content wrappers
still get clamped, so #110 does not regress. Do not clamp the host's width or
geometry instead: the host is `static` and in-flow, so touching its box
perturbs header layout.

Regression test:
`src/pages/content/chatWidth/__tests__/chatWidth.test.ts`
Live-page verification: toggling only that selector moves the host between 101px
(hit-stack top `mat-icon` / `span.dynamic-upsell-label`) and the slider's pixel
value (hit-stack top `chat-app-side-nav-menu-button`) at 30/50/70/100%.

Commit:
`fix(chatwidth): stop the sparkle rule from stretching the Gemini logo pill`
