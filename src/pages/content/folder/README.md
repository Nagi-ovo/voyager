# Folder Manager

This folder contains the implementation of the conversation folder management feature for Voyager.

## Overview

The folder manager allows users to:

- Create and manage folders and subfolders (2-level nesting)
- Drag and drop conversations from the sidebar into folders
- Move conversations between folders
- Display Gem-specific icons for different conversation types
- Navigate to conversations without page reload (SPA-style)
- Import/export folder JSON and sync folders across devices

## Change the owner of the behavior

`manager.ts` composes the Gemini owners and connects them to native menus, the floating panel,
and extension messages. Start changes at the owner below; keep the public folder-project entry
points (`ensureDataLoaded`, `getFolders`, `addConversationToFolderFromNative`) compatible.

| Responsibility                   | Entry point                                                                                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persisted schema                 | [`core/types/folder.ts`](../../../core/types/folder.ts); local [`types.ts`](types.ts) re-exports it and defines drag data.                                                                                                                                            |
| Pure tree operations             | [`features/folder/model/folderData.ts`](../../../features/folder/model/folderData.ts): moves, removal, ordering and integrity repair with explicit input/output data.                                                                                                 |
| Data and commands                | [`FolderStore.ts`](FolderStore.ts): account switching, storage echoes, title/activity updates and folder mutations.                                                                                                                                                   |
| Account write lifetime           | [`FolderDataSession.ts`](FolderDataSession.ts): captured snapshots, queued saves, recovery namespaces and unload cleanup.                                                                                                                                             |
| Sidebar rendering                | [`FolderTreeView.ts`](FolderTreeView.ts): tree, search, Activity, settings and row actions.                                                                                                                                                                           |
| Selection and drag/drop          | [`FolderSelection.ts`](FolderSelection.ts): shared native/folder selection, drag state and batch actions.                                                                                                                                                             |
| Sidebar mount and recovery       | [`FolderSidebarRuntime.ts`](FolderSidebarRuntime.ts): sidebar discovery, remounts, positioning and floating fallback.                                                                                                                                                 |
| Conversation navigation          | [`FolderNavigation.ts`](FolderNavigation.ts): native links, SPA fallback, route highlighting and new-chat handoff.                                                                                                                                                    |
| Import/export and cloud commands | [`FolderTransferController.ts`](FolderTransferController.ts): dialogs, concurrent-operation guards and account-bound completion. JSON parsing/validation remains in [`FolderImportExportService.ts`](../../../features/folder/services/FolderImportExportService.ts). |
| Temporary editors and dialogs    | [`folderDialogs.ts`](folderDialogs.ts): inline edits, color/move/instructions/confirmation dialogs and their cleanup.                                                                                                                                                 |
| Notifications and tooltips       | [`FolderFeedback.ts`](FolderFeedback.ts).                                                                                                                                                                                                                             |
| Header popovers                  | [`headerMenus.ts`](headerMenus.ts): action/settings controls, delayed listeners and cleanup.                                                                                                                                                                          |
| Native DOM reads                 | [`nativeSidebarDom.ts`](nativeSidebarDom.ts): IDs, titles, links and populated rows from explicit sidebar/account context.                                                                                                                                            |
| Native mutation scheduling       | [`NativeSidebarObserver.ts`](NativeSidebarObserver.ts): observer, frame batch, idle queue and title debounce.                                                                                                                                                         |
| Native menus and deletion        | [`NativeConversationMenus.ts`](NativeConversationMenus.ts): menu injection, confirmation identity and settlement checks; callbacks change data through the store.                                                                                                     |
| Browser storage                  | [`storage/FolderStorageAdapter.ts`](storage/FolderStorageAdapter.ts): Safari durable storage and Chromium mirror behavior.                                                                                                                                            |
| Other hosts and views            | [`aistudio.ts`](aistudio.ts), [`floatingPanel.ts`](floatingPanel.ts); shared schema/session, separate host integration.                                                                                                                                               |
| Gem metadata and startup         | [`gemConfig.ts`](gemConfig.ts), [`index.ts`](index.ts).                                                                                                                                                                                                               |

Test data invariants and scheduling at their owner. Keep account transitions and manager wiring in
integration tests. UI tests can compose real owners with memory storage using
[`folderViewHarness.ts`](__tests__/folderViewHarness.ts). Do not pass the entire manager into a
module or add production wrappers solely to preserve a private test interface.

Account changes, sidebar remounts and destruction have different lifetimes:

- Async writes retain their original session and snapshot. Import/sync work also captures an
  activation so leaving and returning to the same account still rejects stale completion. Account
  changes clear transient editors, selection, navigation and title work before displaying new data.
- Sidebar remounts disconnect the native observer and menu panels while retaining document-level
  deletion tracking. Start that tracking before waiting for the sidebar, including floating mode.
  Pending deletion checks validate their captured storage key and route against live context.
- Disabling or destroying stops native owners and recovery work. Permanent message/settings
  listeners survive remounts and are removed only on destruction.
- Native and folder drag gestures share one selection owner. Reset clears selection; unmount also
  removes mounted toolbar listeners. Floating recovery remains distinct from explicit floating mode.

Read the [state/identity](../../../../.github/docs/regressions/state-identity-sync.md) and
[folder UI](../../../../.github/docs/regressions/folders-timeline-ui.md) notes before changing those
boundaries. Extract only a complete responsibility with its state, setup, cleanup and behavior tests;
file length alone is not a reason to add another layer.

## Adding Support for New Gems

To add support for a new Gem (either official Google Gems or custom Gems):

1. Open `gemConfig.ts`
2. Add a new entry to the `GEM_CONFIG` array:

```typescript
{
  id: 'your-gem-id',           // The ID as it appears in URLs (/gem/your-gem-id/...)
  name: 'Your Gem Name',       // Display name
  icon: 'material_icon_name',  // Google Material Symbols icon name
}
```

### Finding the Gem ID

The Gem ID is the URL slug used by Gemini:

- Open a conversation with the Gem
- Check the URL: `https://gemini.google.com/app/gem/[GEM_ID]/...`
- Use this ID in the configuration

### Choosing an Icon

Icons should be valid [Google Material Symbols](https://fonts.google.com/icons) icon names. Common examples:

- `auto_stories` - Learning Coach
- `lightbulb` - Brainstorm Buddy
- `work` - Career Guide
- `code` - Coding Partner
- `edit_note` - Writing Editor
- `menu_book` - Storybook
- `chess` - Chess Champ
- `check_circle` - Productivity Helper
- `sports_cricket` - Cricket

### Example

```typescript
export const GEM_CONFIG: GemConfig[] = [
  // ... existing entries ...
  {
    id: 'data-analyst',
    name: 'Data Analyst',
    icon: 'analytics',
  },
];
```

## Contributing

If you're adding support for a new official Google Gem, please submit a pull request with:

1. The new entry in `gemConfig.ts`
2. A brief description of the Gem in your PR

## Technical Details

### Gem Detection

The folder manager detects Gem conversations by analyzing the `jslog` attribute:

- **Regular conversations**: `BardVeMetadataKey:[...,[id,null,0,1]]` (4 elements)
- **Gem conversations**: `BardVeMetadataKey:[...,[id,null,0]]` (3 elements)

### URL Generation

- Regular conversations: `/app/{hex-id}`
- Gem conversations: `/gem/{gem-id}/{hex-id}`
- Multi-account support: `/u/{account-number}/...`

### AI Studio History Drag Sources

AI Studio exposes saved prompts in two shapes:

- `/library` table rows
- V2 left-nav History hover popovers rendered as body-level overlays

Both paths must populate Voyager's JSON drag payload before a prompt is dropped into a folder.
The payload includes the prompt id, title, and URL; if a browser native URL drag reaches the
folder without that JSON payload, the folder can only recover the id and must fall back to the
localized untitled label.

### Icon Mapping

The system uses a two-way mapping:

- **Gem ID → Icon**: Used when rendering conversations in folders
- **Icon → Gem ID**: Used when detecting Gem type from DOM elements

## Future Enhancements

Potential improvements that could be contributed:

- Custom user-defined Gems
- Gem icon customization
- Support for more than 2 levels of folder nesting
