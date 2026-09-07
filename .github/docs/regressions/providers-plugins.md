# Providers and plugins regression notes

Read this file when changing ChatGPT or Claude adapters, plugin lifecycles, temporary chat handoff,
or prompt commands.

## Remote plugin catalog checks are triggered only by pages an enabled plugin targets

- **Trap:** The plugin host starts on every injected page, including Gemini, AI Studio and
  Claude's per-artifact `*.frame.claudeusercontent.com` iframes. A catalog check keyed on
  `location.host` from every start would contact voyager.nagi.fun from Gemini (breaking the
  zero-request promise) and would produce one 404 plus one storage key per random artifact
  frame host.
- **Rule:** Only the top frame asks the background for a check, only when
  `hasEnabledPluginForUrl` is true for the page, and only for a plain hostname
  (`isEligibleCatalogHost`); the background re-checks eligibility and the user's switch,
  interval and backoff before any fetch. Manual checks from the popup bypass the interval, not
  the host-shape rule.
- **Guard:** `src/features/plugins/runtime/PluginHost.test.ts` (`PluginHost remote catalog`),
  `src/features/plugins/remote/hostCatalogPolicy.test.ts`,
  `src/features/plugins/remote/hostCatalogRefresh.test.ts` (`ineligible` case).

## A missing or failed remote catalog must never unmount bundled plugins

- **Trap:** The remote catalog is authoritative for a host (a bundled plugin it no longer lists is
  dropped). Treating a 404, a network failure, or an entry written by another extension version as
  "the remote says this plugin is gone" would silently disable every user's plugins the moment the
  deploy, the CDN or the build lags behind the extension release.
- **Rule:** Only a valid `format: 1` file for the same host, fetched by the running extension
  version, is authoritative. 404 is cached as `missing`, failures keep the previous entry and only
  bump the attempt bookkeeping, and both fall back to the bundled snapshot. Cache writes that do not
  change the plugin set must not notify subscribers, or every failed attempt would remount CSS.
- **Guard:** `src/features/plugins/sources/defaultSources.test.ts` (`mergePluginRecords`),
  `src/features/plugins/remote/HostCatalogSource.test.ts`,
  `src/features/plugins/remote/hostCatalogCache.test.ts` (`subscribeHostCatalog`),
  `src/features/plugins/remote/hostCatalogRefresh.test.ts` (404 and failure cases).

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

## ChatGPT bookkeeping roots and message-less turns must not abort the export

- **Trap:** Exporting a ChatGPT conversation opened from history failed with
  `chatgpt_export_message_unavailable:paginated-root:<conversation-id>`, surfaced to the user as the
  generic "refresh and retry" alert, and select mode showed a phantom checkbox above the first
  message. ChatGPT stores its virtual-list roots in the same `data-turn-id-container` attribute as
  turns: `client-created-root` for a conversation started in the tab and `paginated-root:<id>` for
  one opened from history; only the first was excluded. A turn whose response rendered nothing
  (`section[data-turn="assistant"]` without any `[data-message-author-role]`) then hit the same
  timeout because it looked like an unmounted virtual shell.
- **Rule:** Skip every `*-root` container. Resolve the role from `[data-turn]` when no message root
  exists, and once a mounted frame stays message-less through the settle window treat the turn as
  empty: count it as handled, export nothing for it, and keep pairing sequence-based so the
  preceding prompt becomes a user-only turn. A frame-less shell must still time out.
- **Guard:** `src/pages/content/export/adapter/__tests__/chatgpt.test.ts`
  (`ignores the paginated history root the same way`,
  `resolves the role from the turn frame when ChatGPT renders a turn without a message`,
  `skips a rendered turn without a message instead of failing the export`,
  `fails when a selected virtual shell never mounts`).

## ChatGPT export entry point only where a conversation can exist

- **Trap:** The ChatGPT export plugin matches the whole origin, and the persistent toolbar was
  mounted as soon as the plugin started, so it also appeared on Codex, settings and library pages
  where nothing can be exported, and stayed there as the SPA moved between such pages and chats.
- **Rule:** Platforms whose chat UI shares an origin with unrelated pages implement
  `isConversationPage(doc, url)` on their export adapter; `startExportEntryGate` mounts the entry
  point only while it returns true and re-checks on route changes and settled DOM mutations. For
  ChatGPT that is a `/c/<id>` route (optionally under `/u/<n>/` or `/g/<gpt>/`) or a rendered
  turn, because a temporary chat keeps `/?temporary-chat=true`.
- **Guard:** `src/pages/content/export/adapter/__tests__/chatgpt.test.ts`
  (`chatgptIsConversationPage`), `src/pages/content/export/__tests__/exportEntryGate.test.ts`.

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
