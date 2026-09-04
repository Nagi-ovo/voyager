/**
 * Shared folder storage and import/export schema.
 * Persisted IDs are opaque strings, including legacy and imported IDs.
 * Normalize conversation identities only at the routing/identity boundary.
 */
import type { ConversationId, FolderId } from './common';

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  isExpanded: boolean;
  pinned?: boolean;
  color?: string;
  sortIndex?: number;
  createdAt: number;
  updatedAt: number;
  instructions?: string; // Optional system instructions injected on new chats (Folder-as-Project)
}

export interface ConversationReference {
  conversationId: string;
  title: string;
  url: string;
  addedAt: number;
  lastOpenedAt?: number; // Timestamp when the conversation was last opened
  lastTurnAt?: number; // Latest known real conversation turn time, never a view/open time
  updatedAt?: number; // Timestamp when the reference was last updated (e.g., renamed)
  isGem?: boolean;
  gemId?: string;
  starred?: boolean; // Whether this conversation is starred in the folder
  customTitle?: boolean; // Whether title was manually renamed in folder (don't auto-sync from native)
  sortIndex?: number;
}

export interface FolderData {
  folders: Folder[];
  folderContents: Record<string, ConversationReference[]>;
}

export type DragDataType = 'conversation' | 'folder';

export interface BaseDragData {
  type: DragDataType;
  title: string;
}

export interface ConversationDragData extends BaseDragData {
  type: 'conversation';
  conversationId: ConversationId;
  url: string;
  isGem?: boolean;
  gemId?: string;
  sourceFolderId?: FolderId;
}

export interface FolderDragData extends BaseDragData {
  type: 'folder';
  folderId: FolderId;
}

export type DragData = ConversationDragData | FolderDragData;

export interface GemConfig {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
}
