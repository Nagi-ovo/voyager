# Timeline ownership

Start with the owner of the behavior being changed. `manager.ts` composes one conversation;
it observes Gemini DOM changes and rebinds the live scroll viewport.

| Change                                                                              | Owner                           |
| ----------------------------------------------------------------------------------- | ------------------------------- |
| Find turns, stable IDs, prompt/response summaries                                   | `TimelineTurns.ts`              |
| Stars, verified legacy aliases, levels, collapse, persistence                       | `TimelineState.ts`              |
| Dot/preview/shortcut navigation, active turn, scrolling and navigation cancellation | `TimelineNavigation.ts`         |
| Rail geometry, virtual dots, slider, dragging, runner animation                     | `TimelineView.ts`               |
| Preview list, search, pinning and compact hover bridge                              | `TimelinePreviewPanel.ts`       |
| Hover delay, tooltip content layout and visibility                                  | `TimelineTooltip.ts`            |
| Marker clicks, long press and hierarchy menu                                        | `TimelineMarkerInteractions.ts` |
| Timestamp opt-in, draft adoption, history matching and timestamp DOM                | `TimelineTimestamps.ts`         |

`TimelineState` owns the marker snapshot. `TimelineView` owns dot elements and measured positions;
DOM nodes do not belong in persisted state. Owners take their required data/actions explicitly,
without a reference back to the manager. Rendering reads state; user actions and storage events
update state and notify the manager.

A native viewport rebind preserves conversation state. Conversation teardown cancels each owner's
listeners, observers, timers and animation frames. The shared `historyTimestampStore` has page
lifetime: the timestamp owner unsubscribes from it but must not stop it. State and timestamp owners
capture the conversation URL so delayed work retains the correct account and conversation scope.

Keep these less obvious boundaries intact:

- A mounted `u-N` is a DOM-window position. Only a complete history mapping can prove that it is a
  stored full-conversation alias. Use `TimelineState` for alias resolution before star/hierarchy edits.
- A state repaint preserves the user's manually scrolled rail position. Synchronize the rail to the
  native viewport only for navigation, native scrolling or layout changes that require it.
- Keep setup and cleanup together when moving UI behavior. Closing a surface must cancel its pending
  work, including callbacks that have not yet made anything visible.

Owner tests exercise DOM behavior and data invariants. The `TimelineManager*` tests cover composition:
viewport replacement, real navigation surfaces, initialization and teardown. Migrate those assertions
with their owner instead of retaining private manager forwarding methods for old tests.

## Highlight integration

[`../highlight/manager.ts`](../highlight/manager.ts) owns account/route loading, records, text anchors
and mutations. [`HighlightEditor`](../highlight/HighlightEditor.ts) owns the annotation popover and
focus/listener cleanup. [`HighlightTimelineMarkers`](../highlight/HighlightTimelineMarkers.ts) owns
highlight ticks and observes the rail's DOM contract (`.gemini-timeline-bar`,
`.timeline-track-content`, `.timeline-style-compact`). Update its tests when that contract changes;
the two managers do not call each other.
