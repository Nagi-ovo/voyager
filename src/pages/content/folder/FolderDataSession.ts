import { type AccountScope, buildScopedStorageKey } from '@/core/services/AccountIsolationService';
import { DataBackupService } from '@/core/services/DataBackupService';

import type { FolderData } from './types';

/** Owns one account's live data, recovery slots, and pending writes. */
export class FolderDataSession {
  data: FolderData = { folders: [], folderContents: {} };
  ready = false;
  loadVersion = 0;
  saveInProgress = false;
  activeSave: Promise<boolean> | null = null;
  replacingData = false;
  pendingSave: FolderData | null = null;
  pendingSaveCompletion: {
    promise: Promise<boolean>;
    resolve: (saved: boolean) => void;
  } | null = null;
  readonly backup: DataBackupService<FolderData>;
  private active = true;

  constructor(
    readonly storageKey: string,
    namespace: string,
    public accountScope: AccountScope | null,
    validateData: (data: unknown) => boolean,
  ) {
    // Global recovery slots have no account owner. Keep them compatible only
    // when isolation is off; never migrate or remove them during account setup.
    this.backup = new DataBackupService<FolderData>(
      accountScope ? buildScopedStorageKey(namespace, accountScope.accountKey) : namespace,
      validateData,
    );
  }

  markReady(): void {
    this.ready = true;
    if (this.active) this.backup.setupBeforeUnloadBackup(() => this.data);
  }

  activate(): void {
    this.active = true;
    if (this.ready) this.markReady();
  }

  deactivate(): void {
    this.active = false;
    // Invalidates reads already in flight without discarding pending writes.
    this.loadVersion += 1;
    this.backup.destroy();
  }
}

export function cloneFolderData(data: FolderData): FolderData {
  const folders = data.folders.map((folder) => ({ ...folder }));
  const folderContents = Object.fromEntries(
    Object.entries(data.folderContents || {}).map(([folderId, conversations]) => [
      folderId,
      conversations.map((conversation) => ({ ...conversation })),
    ]),
  );
  return { folders, folderContents };
}
