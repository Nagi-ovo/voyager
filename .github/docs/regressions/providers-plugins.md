# Providers and plugins regression notes

Read this file when changing ChatGPT or Claude adapters, plugin lifecycles, temporary chat handoff,
or prompt commands.

## ChatGPT virtual shells must be repositioned after height reconciliation

- **Trap:** Exporting a cold, long ChatGPT conversation could fail with
  `chatgpt_export_message_unavailable:<turn-id>` even though the selected message was present and
  became exportable after manually scrolling to it. The materializer called `scrollIntoView()` only
  once. Mounting nearby turns made ChatGPT replace estimated virtual-shell heights with measured
  heights, which could move the requested shell several viewports away before it mounted. The
  remaining timeout loop only polled the offscreen shell and never corrected its position.
- **Rule:** While a requested shell remains unmounted, re-anchor it at a throttled interval only
  when height reconciliation has moved it outside the viewport.
- **Guard:** `src/pages/content/export/adapter/__tests__/chatgpt.test.ts`
  (`repositions a virtual shell that moves offscreen after height reconciliation`).

## ChatGPT export toolbar must avoid the native header cluster

- **Trap:** The ChatGPT persistent export button sat at `top: 50px` / `right: 84px` and covered
  Share, the more menu, or the conversation title. Avoidance only knew Gemini top-bar selectors, so
  ChatGPT header actions never pushed the toolbar left.
- **Rule:** Keep the ChatGPT toolbar on the header row and include `#conversation-header-actions`
  plus Share / conversation-options in the top-right avoidance list.
- **Guard:** `src/pages/content/export/__tests__/persistentExportToolbar.test.ts`
  (`moves left to avoid ChatGPT header share actions`).

## ChatGPT export UI must belong to the active plugin lifecycle

- **Trap:** Rapidly disabling and re-enabling the ChatGPT exporter could let a stale startup remove
  the replacement toolbar. Disabling while export preferences were still loading could also show a
  dialog after the plugin was already off. Asynchronous startup and dialog loading were not tied to
  an abortable plugin lifecycle, while repeated toolbar mounts shared one DOM root without
  ownership.
- **Rule:** Pass the plugin lifecycle signal through startup and dialog loading, replace the shared
  toolbar's click handler on remount, and allow only the current owner to remove the shared root.
- **Guard:** `src/features/plugins/builtin/chatgptExport/runtime.test.ts`
  (`aborts the stale lifecycle before starting a replacement`) and
  `src/pages/content/export/__tests__/persistentExportToolbar.test.ts`
  (`does not duplicate-mount; second call updates text on existing instance`).

## Temporary-chat handoff state must stay private and tab-scoped

- **Trap:** ChatGPT can reuse its composer, expose unrelated textboxes, replace the accepted
  composer later, or render multiline text differently from `textContent`. Page `sessionStorage`,
  node-replacement assumptions, and broad async guards let payloads leak across editors, vanish
  during hard navigation, replay after cancellation, or restore a late attachment after the user
  edited the composer.
- **Rule:** Resolve ChatGPT composers in selector-priority order and accept a usable same-node
  composer. Keep transcripts in extension storage behind expiring tab-scoped tokens. Bind delivered
  recovery to the exact chat route and cancel it on route mismatch, edit, send, native New Chat,
  plugin disposal, or expiry. Carry a synchronous cancellation revision across async storage,
  insertion, and preview work. Mark hard navigation before root teardown, keep progress mounted
  through departure bookkeeping, sweep expired keys, and suppress cancellation only around the
  plugin's synchronous navigation clicks. Fail closed during generation, an incomplete final user
  turn, or a turn-identity change during collection.
- **Guard:** `src/features/plugins/builtin/chatgptTemporaryHandoff/handoff.test.ts` and
  `src/features/plugins/builtin/chatgptTemporaryHandoff/index.test.ts` cover composer reuse and
  isolation, multiline verification, route-bound recovery, cancellation at every async boundary,
  hard navigation, expiry, generation and turn guards, and attachment preview races.

## Temporary-chat handoff attachments need unique names

- **Trap:** A second long temporary-chat handoff could reuse the first attachment preview and insert
  only the new instruction, silently handing the old transcript to the new chat. Attachment recovery
  treats a visible matching filename as proof that the file was already delivered, while the
  original filename contained only the date.
- **Rule:** Give every handoff a timestamp plus nonce and reuse that identity for both the
  downloaded backup and the composer attachment.
- **Guard:** `src/features/plugins/builtin/chatgptTemporaryHandoff/handoff.test.ts`
  (`gives separate handoffs unique filenames even at the same instant`).

## Claude usage settings hash may not open the modal by itself

- **Trap:** Clicking the Claude usage link changed the URL hash to `#settings/usage`, but the usage
  modal did not open until the page was refreshed. Claude's SPA sometimes observes the usage hash
  only during load. A hash-only navigation on an existing chat path is not always enough to mount
  the settings modal.
- **Rule:** Keep the current chat path in the usage URL and reload only when usage content does not
  appear after opening.
- **Guard:** `src/features/plugins/builtin/claudeUsage/index.test.ts`

## Claude usage reset data can come from multiple surfaces

- **Trap:** The Claude usage bar showed percentages but missed the reset countdown, especially for
  the 5h window. The visible settings DOM and the usage API do not always expose the same reset
  data. Some 5h reset information arrives through `message_limit` events.
- **Rule:** Normalize usage API windows, visible settings DOM, cached snapshots, and `message_limit`
  events into the same metric shape.
- **Guard:** `src/features/plugins/builtin/claudeUsage/index.test.ts`
  `src/features/plugins/builtin/claudeUsage/observer.test.ts`

## Duplicate prompt names are a slash eligibility conflict, not invalid data

- **Trap:** Import or sync dropped Prompt records when names collided, while slash completion
  accepted every non-empty name and made historical duplicates ambiguous. Parallel Drive timestamp
  merges could also let a newer legacy record without `name` erase the local name.
- **Rule:** Preserve every Prompt record. Group names by one shared trimmed, NFKC-normalized,
  case-insensitive key; exclude the whole duplicate group from slash completion and show a
  non-blocking Prompt Manager badge until resolved. Route every Drive merge through the shared
  helper, which retains a local name when the newer cloud record predates prompt names.
- **Guard:** `src/features/backup/services/__tests__/PromptImportExportService.test.ts`
  `src/utils/merge.test.ts` `src/pages/content/folder/__tests__/FolderTransferController.test.ts`
  `src/pages/content/folder/__tests__/aistudioAuditFixes.test.ts`
  `src/pages/content/prompt/__tests__/promptName.test.ts`
  `src/pages/content/prompt/__tests__/slashPrompt.test.ts`
  `src/pages/background/__tests__/runtimeMessageRouting.test.ts`
