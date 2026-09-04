import type { ConversationReference } from '@/core/types/folder';

export type { ConversationReference, Folder, FolderData } from '@/core/types/folder';

export interface DragData {
  type?: 'conversation' | 'folder'; // Type of dragged item
  conversationId?: string;
  folderId?: string; // For folder dragging
  title: string;
  url?: string;
  isGem?: boolean;
  gemId?: string;
  conversations?: ConversationReference[]; // For multi-select dragging
  sourceFolderId?: string; // Track where conversations are being dragged from
}
