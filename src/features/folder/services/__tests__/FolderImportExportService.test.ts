/**
 * Regression tests for FolderImportExportService.
 *
 * H3: merge imports used to mutate the caller's live FolderData in place
 * (shared array references behind a shallow copy), which also poisoned the
 * "pre-import" sessionStorage backup — restoreFromBackup rolled back to
 * post-import data. These tests pin the fixed behavior.
 *
 * L10: validatePayload used to accept arbitrarily-shaped folderContents
 * entries; now malformed conversation entries are skipped leniently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationReference, Folder, FolderData } from '@/core/types/folder';
import { AsyncLockTimeoutError, importExportLock } from '@/core/utils/concurrency';

import { SESSION_BACKUP_KEY } from '../../constants';
import type { FolderExportPayload } from '../../types/import-export';
import { FolderImportExportService } from '../FolderImportExportService';

function createFolder(id: string, name: string, overrides: Partial<Folder> = {}): Folder {
  return {
    id,
    name,
    parentId: null,
    isExpanded: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createConversation(
  conversationId: string,
  title: string,
  overrides: Partial<ConversationReference> = {},
): ConversationReference {
  return {
    conversationId,
    title,
    url: `https://gemini.google.com/app/${conversationId}`,
    addedAt: 1,
    ...overrides,
  };
}

function createExistingData(): FolderData {
  return {
    folders: [createFolder('folder-a', 'Alpha')],
    folderContents: {
      'folder-a': [createConversation('conv-1', 'Existing conversation')],
    },
  };
}

function createImportPayload(data: FolderData): FolderExportPayload {
  return {
    format: 'gemini-voyager.folders.v1',
    exportedAt: new Date(0).toISOString(),
    version: '1.0.0',
    data,
  };
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FolderImportExportService.mergeData (H3)', () => {
  it('does not mutate the passed-in existing data', () => {
    const existing = createExistingData();
    const snapshot = JSON.parse(JSON.stringify(existing)) as FolderData;
    const imported: FolderData = {
      folders: [createFolder('folder-b', 'Beta')],
      folderContents: {
        'folder-a': [createConversation('conv-2', 'Imported into existing folder')],
        'folder-b': [createConversation('conv-3', 'Imported into new folder')],
      },
    };

    const { merged, stats } = FolderImportExportService.mergeData(existing, imported);

    // The input must be byte-for-byte untouched.
    expect(existing).toEqual(snapshot);
    // The merged output must not share array references with the input.
    expect(merged.folderContents['folder-a']).not.toBe(existing.folderContents['folder-a']);

    expect(merged.folderContents['folder-a'].map((c) => c.conversationId)).toEqual([
      'conv-1',
      'conv-2',
    ]);
    expect(merged.folderContents['folder-b'].map((c) => c.conversationId)).toEqual(['conv-3']);
    expect(stats.foldersImported).toBe(1);
    expect(stats.conversationsImported).toBe(2);
  });

  it('does not push into frozen input arrays (pure-function guarantee)', () => {
    const existing = createExistingData();
    Object.freeze(existing.folderContents['folder-a']);
    const imported: FolderData = {
      folders: [],
      folderContents: {
        'folder-a': [createConversation('conv-2', 'Imported')],
      },
    };

    expect(() => FolderImportExportService.mergeData(existing, imported)).not.toThrow();
  });
});

describe('FolderImportExportService.importFromPayload backup (H3)', () => {
  it('returns a readable error when another import holds the lock too long', async () => {
    vi.spyOn(importExportLock, 'withLock').mockRejectedValueOnce(
      new AsyncLockTimeoutError('folder:import', 30_000),
    );

    const result = await FolderImportExportService.importFromPayload(
      createImportPayload(createExistingData()),
      createExistingData(),
      { strategy: 'merge', createBackup: true },
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe(
      'Another folder import is already in progress. Please try again shortly.',
    );
  });

  it('stores a pre-import snapshot in sessionStorage after a merge import', async () => {
    const existing = createExistingData();
    const preImportSnapshot = JSON.parse(JSON.stringify(existing)) as FolderData;
    const payload = createImportPayload({
      folders: [createFolder('folder-b', 'Beta')],
      folderContents: {
        'folder-a': [createConversation('conv-2', 'Imported conversation')],
        'folder-b': [createConversation('conv-3', 'Another imported conversation')],
      },
    });

    const result = await FolderImportExportService.importFromPayload(payload, existing, {
      strategy: 'merge',
      createBackup: true,
    });

    expect(result.success).toBe(true);

    const backupRaw = sessionStorage.getItem(SESSION_BACKUP_KEY);
    expect(backupRaw).not.toBeNull();
    // The backup must equal the data as it was BEFORE the import — not the
    // merged result.
    expect(JSON.parse(backupRaw as string)).toEqual(preImportSnapshot);

    // restoreFromBackup round-trips the same pre-import data.
    const restored = FolderImportExportService.restoreFromBackup();
    expect(restored.success).toBe(true);
    if (restored.success) {
      expect(restored.data).toEqual(preImportSnapshot);
    }
  });

  it('leaves the caller-provided current data untouched by a merge import', async () => {
    const existing = createExistingData();
    const snapshot = JSON.parse(JSON.stringify(existing)) as FolderData;
    const payload = createImportPayload({
      folders: [],
      folderContents: {
        'folder-a': [createConversation('conv-2', 'Imported conversation')],
      },
    });

    await FolderImportExportService.importFromPayload(payload, existing, {
      strategy: 'merge',
      createBackup: true,
    });

    expect(existing).toEqual(snapshot);
  });
});

describe('FolderImportExportService.validatePayload folderContents entries (L10)', () => {
  it('skips malformed conversation entries without rejecting the payload', () => {
    const payload = {
      format: 'gemini-voyager.folders.v1',
      exportedAt: new Date(0).toISOString(),
      version: '1.0.0',
      data: {
        folders: [createFolder('folder-a', 'Alpha')],
        folderContents: {
          'folder-a': [
            createConversation('conv-1', 'Valid'),
            { conversationId: '', title: 'Empty id' },
            { conversationId: 'conv-2', title: '' },
            { conversationId: 'conv-3' }, // missing title
            { title: 'missing id' },
            'not-an-object',
            null,
            createConversation('conv-4', 'Also valid'),
          ],
        },
      },
    };

    const result = FolderImportExportService.validatePayload(payload);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.folderContents['folder-a'].map((c) => c.conversationId)).toEqual([
        'conv-1',
        'conv-4',
      ]);
    }
  });

  it('treats a non-array folderContents value as an empty list instead of crashing later', () => {
    const payload = {
      format: 'gemini-voyager.folders.v1',
      exportedAt: new Date(0).toISOString(),
      version: '1.0.0',
      data: {
        folders: [createFolder('folder-a', 'Alpha')],
        folderContents: {
          'folder-a': 'garbage',
        },
      },
    };

    const result = FolderImportExportService.validatePayload(payload);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.folderContents['folder-a']).toEqual([]);
    }
  });

  it('does not mutate the caller-provided payload while sanitizing', () => {
    const payload = {
      format: 'gemini-voyager.folders.v1',
      exportedAt: new Date(0).toISOString(),
      version: '1.0.0',
      data: {
        folders: [createFolder('folder-a', 'Alpha')],
        folderContents: {
          'folder-a': [createConversation('conv-1', 'Valid'), { conversationId: '', title: 'x' }],
        },
      },
    };
    const snapshot = JSON.parse(JSON.stringify(payload));

    FolderImportExportService.validatePayload(payload);

    expect(payload).toEqual(snapshot);
  });

  it('keeps valid entries intact including optional metadata', () => {
    const conv = createConversation('conv-1', 'Valid', { starred: true, gemId: 'gem-x' });
    const payload = {
      format: 'gemini-voyager.folders.v1',
      exportedAt: new Date(0).toISOString(),
      version: '1.0.0',
      data: {
        folders: [createFolder('folder-a', 'Alpha')],
        folderContents: { 'folder-a': [conv] },
      },
    };

    const result = FolderImportExportService.validatePayload(payload);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.folderContents['folder-a'][0]).toEqual(conv);
    }
  });
});
