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

| Responsibility                                                | Entry point                                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persisted folder and conversation schema                      | [`core/types/folder.ts`](../../../core/types/folder.ts). Local [`types.ts`](types.ts) re-exports it and keeps the content drag payload.                                                                                                      |
| Tree traversal, moves, removal, ordering and integrity repair | [`features/folder/model/folderData.ts`](../../../features/folder/model/folderData.ts). Functions take data explicitly and return the next data without mutating the input.                                                                   |
| Account data, backup ownership and unload lifetime            | [`FolderDataSession.ts`](FolderDataSession.ts). Each asynchronous load/save belongs to the session in which it started.                                                                                                                      |
| Gemini DOM, user commands and runtime coordination            | [`manager.ts`](manager.ts). The existing public entry points remain available while responsibilities move out incrementally.                                                                                                                 |
| AI Studio host integration                                    | [`aistudio.ts`](aistudio.ts). Shares the persisted schema and account session, with its own navigation and storage path.                                                                                                                     |
| Floating view                                                 | [`floatingPanel.ts`](floatingPanel.ts). Mount with data/callbacks; update or destroy through the returned handle.                                                                                                                            |
| Browser storage implementations                               | [`storage/FolderStorageAdapter.ts`](storage/FolderStorageAdapter.ts). Preserve Safari's durable storage and Chromium's mirror behavior.                                                                                                      |
| JSON import/export                                            | [`FolderImportExportService.ts`](../../../features/folder/services/FolderImportExportService.ts). Shared keys live in the feature's [`constants.ts`](../../../features/folder/constants.ts); this service must not import a content manager. |
| Gem metadata and startup                                      | [`gemConfig.ts`](gemConfig.ts), [`index.ts`](index.ts).                                                                                                                                                                                      |

Test tree and ordering changes directly in the [model tests](../../../features/folder/model/__tests__/folderData.test.ts).
Keep DOM, storage-event and navigation assertions in the content integration tests. Do not pass a
manager into a model helper or add a manager wrapper solely to keep a private test interface alive.

Account changes, sidebar remounts and full destruction have different lifetimes. In-flight writes
retain their original session and snapshot; a sidebar remount keeps the native deletion tracker.
Read the [state/identity](../../../../.github/docs/regressions/state-identity-sync.md) and
[folder UI](../../../../.github/docs/regressions/folders-timeline-ui.md) regression notes before
changing those boundaries. For future extraction, move a complete responsibility together with its
setup, cleanup and behavioral tests.

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
