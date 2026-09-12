# ChatGPT Timeline native handler

Timeline-only migration onto upstream `efca34b7`, based on the validated Timeline revision
`28a754f0`. No Highlight, scroll interception, floating-button preference or export changes.

## Ownership

- `index.ts`: PluginHost native-handler lifecycle and compatibility entry points.
- `ChatGptTimeline.ts`: scope-owned rail, route transitions, active tracking and bounded homing.
- `ChatGptTimelineMarkerInteractions.ts`: tooltip and long-press lifetime.
- `registry.ts`: grow-only native turn IDs, mounted text cache and remount reconciliation.
- `geometry.ts`: shell-position-based rail geometry; `identity.ts`: historical storage prefixes.
- `styles.ts`: ChatGPT-scoped explicit light/dark fallbacks over shared timeline styles.
- `../../sites/chatgptDom.ts`: read-only retained-shell, role, route and scroll-root contract.

Reuses upstream `TimelinePreviewPanel`, `StarredMessagesService`, `PluginScope`, route watching
and compact tick hit-testing. The builtin intentionally has a native-handler binding and **no**
`native` DOM op, so it cannot also start a primitive instance.

`turnNavigator` currently derives content-hash identities and index-spaced Standard markers.
Replacing ChatGPT's retained shell IDs or repeated height reconciliation with that behavior would
change working navigation and persisted stars. Keep this engine isolated until the shared primitive
has an appropriate stable-identity/navigation seam; do not add hostname branches to it.

## Validation before upstream submission

Unit fixtures are not live-browser evidence. Reload exactly one unpacked extension from this branch
and refresh the ChatGPT tab before checking:

1. Standard and Compact: one marker per known user turn, correct ordering and contrast in both themes.
2. Scroll a long conversation manually: discover new turns without losing old markers or auto-scanning.
3. Click near/distant and unmounted targets; verify final alignment after height reconciliation.
4. Interrupt homing with wheel, touch or scrollbar; confirm it stays stopped.
5. Check active marker, preview hover, search, star/unstar and persistence after reload.
6. Switch sidebar conversations, back/forward, new chat, custom GPT and workspace routes.
7. Toggle off/on twice: no rail/preview while disabled, exactly one of each when enabled.

Record browser/version, theme, shell/marker counts and screenshots. Chrome, Edge, Firefox and Safari
live evidence for the migrated artifact is pending; validation owner: @lezebomb, with maintainer
review before submission. Existing development-branch browser results do not satisfy this checklist.
