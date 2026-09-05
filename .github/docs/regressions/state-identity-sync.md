# State, identity, and sync regression notes

Read this file when changing account or route identity, extension message lifetimes, storage
mirrors, clear markers, or Drive sync.

## Route indexes are not durable account identities

- **Trap:** Prompt History could show one Google account's prompts after another account reused the
  same Gemini `/u/<index>` route. Prompt History persisted the route index directly, and the shared
  account resolver also preferred a stale route alias when it observed a new email on that route.
- **Rule:** Resolve Prompt History storage through `AccountIsolationService`, require an explicit
  stable scope for every write, and let an observed email override a route alias owned by a
  different email.
- **Guard:** `src/core/services/__tests__/AccountIsolationService.test.ts`
  (`does not reuse a route alias after that route switches to another email`) and
  `src/pages/content/promptHistory/__tests__/promptHistory.test.ts`
  (`keeps captures separate when the same route switches to another account`).

## onMessage listeners must not return true unconditionally

- **Trap:** Background broadcasts (e.g. `gv.remoteAnnouncement.show` via `chrome.tabs.sendMessage`)
  hung forever on tabs running the folder content scripts; `await Promise.all` over the broadcast
  never settled. Per-tab `catch` did not help because the promise neither resolved nor rejected.
  Both folder `runtime.onMessage` listeners (Gemini `manager.ts` and `aistudio.ts`) ended with an
  unconditional `return true`, telling Chrome "I will respond asynchronously" for every message,
  including types they never answer. A message with no responder anywhere on the page then keeps the
  channel open forever. `return true` is only safe on branches that actually call `sendResponse`.
- **Rule:** Return `true` only from branches that respond; fall through to `return undefined` for
  unknown messages so the sender's promise settles immediately. Any new content-script onMessage
  listener must follow this.
- **Guard:** `src/pages/content/folder/__tests__/folderRuntimeMessages.test.ts` ("returns undefined for unknown
  messages so the sender promise settles")
  `src/pages/content/folder/__tests__/aistudioAuditFixes.test.ts`

## Folder storage mirror writes echo back through storage.onChanged

- **Trap:** Every local folder save (star, drag, expand/collapse) triggered a redundant full
  `loadData` + `renderAllFolders`, and rapid consecutive edits could briefly flash the UI back to a
  stale state. `FolderStorageAdapter.saveData` mirrors folder data into `chrome.storage.local`, and
  `chrome.storage.onChanged` fires in the SAME context that performed the write (unlike the window
  `storage` event). The manager's onChanged handler treated its own mirror write as an external
  change and reloaded.
- **Rule:** Call `armStorageEchoSuppression()` (counter + 2s window) before every
  `storage.saveData` for the active account session. The onChanged handler consumes one suppression
  per echo and still reloads on genuine external writes (popup sync, other tabs). Reset the counter
  when switching accounts; delayed writes for a previous session must not arm the new session's
  counter because the listener ignores events for their old storage key.
- **Guard:** `src/pages/content/folder/FolderStore.test.ts` ("consumes one mirror echo per write and then applies an external update" and "applies an external update when no local write has armed echo suppression")

## Folder recovery and pending writes belong to an account session

- **Trap:** Live folder storage used stable account keys, but both managers shared platform-wide
  recovery backups. AI Studio could recover account A into a new account B; Gemini could do so
  when B's live value was corrupt. Keeping the previous in-memory data on load failure also crossed
  accounts. A delayed load, save, import or sync completion could use the manager's newly selected
  account instead of the account where the operation began.
- **Rule:** Bind data, backup namespace and pending saves to one `FolderDataSession`. Capture its
  key and data snapshot before asynchronous writes, reject stale reads/import/sync completions,
  and detach its unload handler on account changes. Returning to an account with pending writes
  must reuse its writer and retain unsaved memory; leaving the account still invalidates earlier
  import/sync operations. Clear the old account's visible rows and transient editors while resolving
  the next account. Resolution failure must not fall back to global storage. Keep ownerless legacy
  backups intact and readable only with isolation off; never adopt them into an isolated account.
  Arm storage-echo suppression only for the session currently observed by the manager.
  Accept user mutations only after the current session is ready; disable the sidebar/floating
  editing controls during both account resolution and initial loading, including global data after
  disabling isolation and AI Studio's library drop targets. Floating mode, including
  its closed FAB state, must observe account route changes without waiting for a sidebar mount.
  A queued save must await its coalesced snapshot's actual storage result. Import, sync and
  instructions editors report
  success only after persistence succeeds; failed saves retain editable input for retry.
- **Guard:** `src/pages/content/folder/__tests__/accountScopedBackup.test.ts` covers same-account
  recovery, legacy compatibility, new/empty accounts, same-instance switching, unload ownership,
  deferred loads/writes, account revisits and failed resolution. `src/pages/content/folder/FolderStore.test.ts`
  preserves the per-write echo and trailing-save behavior; `src/pages/content/folder/floatingPanel.test.ts`
  guards reset during inline editing.
  `src/pages/content/folder/FolderStorePersistence.test.ts` covers pending resolution/load and queued
  save results. `src/pages/content/folder/__tests__/folderAccountRouting.test.ts` covers disabled
  controls and real manager route wiring in sidebar, floating and FAB modes and its teardown.
  `src/pages/content/folder/__tests__/FolderTransferController.test.ts`
  and `src/pages/content/folder/folderDialogs.test.ts` cover save failures and stale completions.
  `src/pages/content/folder/__tests__/aistudioPersistence.test.ts` covers AI Studio's pending
  global/scoped loads, coalesced save results, library drops and import/sync completion feedback.

## Failed folder drafts must not become later ordinary saves

- **Trap:** Import, cloud sync and instructions editors changed live folder data before saving. A failed save
  kept the dialog open, but cancelling it left the draft in memory and recovery backups; the next
  ordinary edit could persist the cancelled import, including an overwrite of existing folders.
- **Rule:** Persist drafts through `FolderStore.replaceData` or AI Studio's `replaceData`, then
  publish them only on success. AI Studio writes merged folders and prompts in the same storage call.
  Track migration writes as well as ordinary saves, and finish accepted writes first; keep the current account's editing controls
  disabled during replacement so old live snapshots cannot overwrite the draft. Keep drafts out of
  emergency/unload backups, retain the account owner while replacing, and submit an issued write's
  successful result only to that owner. A draft still waiting for ordinary writes is abandoned when
  its account activation ends.
- **Guard:** `src/pages/content/folder/__tests__/folderImportPersistence.test.ts` exercises the real
  manager UI through failed merge/overwrite, cancellation, a later ordinary save and successful retry.
  `src/pages/content/folder/FolderStorePersistence.test.ts` covers failed instructions, queued writes,
  debounce/unload backups and account changes while a draft is pending.
  `src/pages/content/folder/__tests__/aistudioPersistence.test.ts` covers failed import/sync drafts,
  recovery slots, later ordinary edits and account changes before/after issuing the draft write.

## Highlight cleanup must preserve account clear markers

- **Trap:** After a user cleared all highlights from Storage Manager, a later Google Drive pull
  could restore the deleted highlights. Deleting every `gvAnnotation:*` key also deleted the bounded
  account/platform clear marker. Without that marker, an older remote record looked newer than an
  empty local store and was imported again.
- **Rule:** Highlight cleanup must go through `HighlightAnnotationService.clearAllAccounts()`. It
  removes annotation buckets in one serialized commit while retaining small versioned clear markers.
  Quota classification counts only `gvAnnotation:bucket:*` as highlight content;
  `gvAnnotation:index:*` and the device id are protected metadata/settings. Do not replace this path
  with `storage.remove()` over the whole annotation namespace.
- **Guard:** `src/core/services/__tests__/HighlightAnnotationService.test.ts` (`clearAllAccounts`
  cases) and `src/core/services/__tests__/StorageQuotaService.test.ts`
  (`clears the narrowly matched highlights category`).

## Google Drive backup folders need a stable identity beyond their display name

- **Trap:** Drive folder discovery used only the exact display name, while its stable file ID lived
  in memory and the folder had no app-owned marker. A rename, product-name migration, lost cache, or
  concurrent first resolution could therefore create duplicate root backup folders.
- **Rule:** Tag `Voyager Data` with private `appProperties` marker `voyagerDataFolder=1` and resolve
  marked folders first. Recover pre-marker renames from known sync-file parents, rename only an
  unambiguous legacy folder in place, serialize first resolution, and preserve custom names after
  marking. If canonical and legacy folders coexist, never delete or rename either automatically.
  Search inside the resolved folder before global fallback.
- **Guard:** `src/core/services/__tests__/GoogleDriveSyncService.test.ts` and
  `Voyager/Tests/NativeSupportTests.swift` cover identity and unambiguous migration. A live Drive
  check must preserve folder ID, parent, and JSON while changing only the legacy display name.

## Gemini turn identity must not come from the mounted DOM index

- **Trap:** Gemini virtualizes long conversations, so the first mounted node after reload might be
  turn 60 but receive DOM index `u-0`. Using that index moved stars to wrong turns and could delete
  the original bookmark when unstarred. Prompt text is not identity because it can repeat, change,
  truncate, or render differently.
- **Rule:** Use response `rid` as canonical `s-<rid>` identity. Cache the bounded complete ordered
  ID list from `hNvQHb`, including unmounted turns, and use it to map legacy `u-N` records. Never
  infer aliases from the mounted DOM or prompt text. Without the complete map, retain the legacy
  record but do not show, migrate, or delete it. Timeline, hierarchy, timestamps, forks, highlights,
  and exports share this resolver.
- **Guard:** `src/pages/content/timeline/__tests__/starredResolution.test.ts`,
  `src/pages/content/timeline/__tests__/TimelineStateStars.test.ts`,
  `src/pages/content/timeline/__tests__/TimelineStateIdentity.test.ts`, and
  `src/pages/content/timestamp/__tests__/historyTimestamps.test.ts` cover complete-map identity and
  safe legacy handling.
