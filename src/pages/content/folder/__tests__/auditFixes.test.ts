import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PromptItem } from '@/core/types/sync';

import { FolderManager } from '../manager';
import type { FolderData } from '../types';

const { mockBrowser } = vi.hoisted(() => ({
  mockBrowser: {
    runtime: {
      id: 'test-extension-id',
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn(),
    },
    storage: {
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
      sync: { get: vi.fn(), set: vi.fn() },
    },
  },
}));

vi.mock('webextension-polyfill', () => ({ default: mockBrowser }));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => true | undefined;

type StorageChangeListener = (
  changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
  areaName: string,
) => void;

type TestableManager = {
  data: FolderData;
  activeStorageKey: string;
  accountIsolationEnabled: boolean;
  containerElement: HTMLElement | null;
  hideArchivedConversations: boolean;
  folderSearchEnabled: boolean;
  folderSearchQuery: string;
  nativeTitleLookup: Map<string, string> | null;
  pendingTitleUpdates: Map<string, string>;
  setupStorageListener: () => void;
  setupMessageListener: () => void;
  loadData: () => Promise<void>;
  saveData: () => Promise<boolean>;
  scheduleSaveData: () => void;
  flushPendingSaveData: () => void;
  reloadFoldersFromStorage: () => Promise<void>;
  refresh: () => void;
  toggleFolder: (folderId: string) => void;
  buildNativeConversationTitleMap: () => Map<string, string>;
  lookupNativeConversationTitle: (conversationId: string) => string | null;
  syncConversationTitleFromNative: (conversationId: string) => string | null;
  buildConversationUrlFromId: (hexId: string) => string;
  createFoldersList: () => HTMLElement;
  createFolderSearch: () => HTMLElement;
  mergePrompts: (local: PromptItem[], cloud: PromptItem[]) => PromptItem[];
  storage: { saveData: (key: string, data: FolderData) => Promise<boolean> };
};

interface LocationMock {
  pathname: string;
  origin: string;
  href: string;
  reload: ReturnType<typeof vi.fn>;
}

function makeManager(): { manager: FolderManager; internals: TestableManager } {
  const manager = new FolderManager();
  return { manager, internals: manager as unknown as TestableManager };
}

function makeFolderData(): FolderData {
  return {
    folders: [
      {
        id: 'folder-1',
        name: 'Folder One',
        parentId: null,
        isExpanded: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    folderContents: { 'folder-1': [] },
  };
}

function appendNativeRow(hexId: string, title: string, options?: { omitJslog?: boolean }): void {
  const row = document.createElement('div');
  row.setAttribute('data-test-id', 'conversation');
  if (!options?.omitJslog) {
    row.setAttribute('jslog', `["c_${hexId}"]`);
  }
  const link = document.createElement('a');
  link.href = `/app/${hexId}`;
  const titleEl = document.createElement('span');
  titleEl.className = 'conversation-title-text';
  titleEl.textContent = title;
  link.appendChild(titleEl);
  row.appendChild(link);
  document.body.appendChild(row);
}

describe('folder manager audit fixes', () => {
  let manager: FolderManager | null = null;

  beforeEach(() => {
    mockBrowser.runtime.onMessage.addListener.mockClear();
    mockBrowser.storage.onChanged.addListener.mockClear();
    (chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>).mockClear();
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(() => {
    manager?.destroy();
    manager = null;
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  // ── H1/M1: runtime message handling ───────────────────────────────────────

  describe('runtime message listeners (H1/M1)', () => {
    function getMessageListener(internals: TestableManager): MessageListener {
      internals.setupMessageListener();
      const call = mockBrowser.runtime.onMessage.addListener.mock.calls.at(-1);
      expect(call).toBeDefined();
      return call?.[0] as MessageListener;
    }

    it('does not register a duplicate raw chrome.runtime.onMessage listener (M1)', () => {
      const { manager: m, internals } = makeManager();
      manager = m;

      internals.setupStorageListener();
      internals.setupMessageListener();

      // The duplicate gv.folders.reload listener used to be registered on the
      // raw chrome.runtime API from setupStorageListener.
      expect(chrome.runtime.onMessage.addListener).not.toHaveBeenCalled();
      expect(mockBrowser.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    });

    it('handles gv.folders.reload exactly once (M1)', async () => {
      const { manager: m, internals } = makeManager();
      manager = m;
      internals.setupStorageListener();

      const loadSpy = vi.spyOn(internals, 'loadData').mockResolvedValue(undefined);
      const refreshSpy = vi.spyOn(internals, 'refresh').mockImplementation(() => {});
      const sendResponse = vi.fn();

      const listener = getMessageListener(internals);
      const result = listener({ type: 'gv.folders.reload' }, {}, sendResponse);

      expect(result).toBe(true); // async response promised — channel stays open
      await Promise.resolve();
      await Promise.resolve();

      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    });

    it('responds synchronously to gv.sync.requestData and keeps the channel open', () => {
      const { manager: m, internals } = makeManager();
      manager = m;
      internals.data = makeFolderData();

      const sendResponse = vi.fn();
      const listener = getMessageListener(internals);
      const result = listener({ type: 'gv.sync.requestData' }, {}, sendResponse);

      expect(result).toBe(true);
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, data: internals.data }),
      );
    });

    it('returns undefined for unknown messages so the sender promise settles (H1)', () => {
      const { manager: m, internals } = makeManager();
      manager = m;

      const sendResponse = vi.fn();
      const listener = getMessageListener(internals);
      const result = listener({ type: 'gv.remoteAnnouncement.show' }, {}, sendResponse);

      expect(result).toBeUndefined();
      expect(sendResponse).not.toHaveBeenCalled();
    });
  });

  // ── H2: self-write storage echo suppression ────────────────────────────────

  describe('Drive prompt merge', () => {
    it('preserves the local name when a newer legacy cloud prompt omits it', () => {
      const { manager: m, internals } = makeManager();
      manager = m;
      const local: PromptItem = {
        id: 'prompt-1',
        name: 'Keep this name',
        text: 'local text',
        tags: ['local'],
        createdAt: 1,
        updatedAt: 10,
      };
      const cloud: PromptItem = {
        id: 'prompt-1',
        text: 'newer cloud text',
        tags: ['cloud'],
        createdAt: 1,
        updatedAt: 20,
      };

      expect(internals.mergePrompts([local], [cloud])).toEqual([
        { ...cloud, name: 'Keep this name' },
      ]);
    });
  });

  describe('storage echo suppression (H2)', () => {
    function getStorageListener(internals: TestableManager): StorageChangeListener {
      internals.setupStorageListener();
      const call = mockBrowser.storage.onChanged.addListener.mock.calls.at(-1);
      expect(call).toBeDefined();
      return call?.[0] as StorageChangeListener;
    }

    it('skips the reload for our own mirror-write echo', async () => {
      const { manager: m, internals } = makeManager();
      manager = m;
      internals.data = makeFolderData();

      const reloadSpy = vi
        .spyOn(internals, 'reloadFoldersFromStorage')
        .mockResolvedValue(undefined);
      const listener = getStorageListener(internals);

      // Our own save arms echo suppression internally...
      const saved = await internals.saveData();
      expect(saved).toBe(true);

      // ...so the onChanged echo fired back into this context must NOT reload.
      listener({ [internals.activeStorageKey]: { newValue: internals.data } }, 'local');
      expect(reloadSpy).not.toHaveBeenCalled();
    });

    it('still reloads for external writes (other tab / popup cloud sync)', () => {
      const { manager: m, internals } = makeManager();
      manager = m;

      const reloadSpy = vi
        .spyOn(internals, 'reloadFoldersFromStorage')
        .mockResolvedValue(undefined);
      const listener = getStorageListener(internals);

      // No local save happened — this change came from another context.
      listener({ [internals.activeStorageKey]: { newValue: makeFolderData() } }, 'local');
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    it('consumes exactly one echo per save, then resumes reloading', async () => {
      const { manager: m, internals } = makeManager();
      manager = m;
      internals.data = makeFolderData();

      const reloadSpy = vi
        .spyOn(internals, 'reloadFoldersFromStorage')
        .mockResolvedValue(undefined);
      const listener = getStorageListener(internals);

      await internals.saveData();

      const changes = { [internals.activeStorageKey]: { newValue: internals.data } };
      listener(changes, 'local'); // own echo — suppressed
      listener(changes, 'local'); // genuinely external — must reload
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── H6: native title lookup table ─────────────────────────────────────────

  describe('native title lookup table (H6)', () => {
    it('matches the legacy per-conversation scan for every id shape', () => {
      const hexA = 'abc123def4567890';
      const hexB = '1111222233334444';
      const hexC = 'feedfacecafebeef';
      appendNativeRow(hexA, 'Title A');
      appendNativeRow(hexB, 'Title B');
      appendNativeRow(hexC, 'Title C', { omitJslog: true }); // href-only row

      const { manager: m, internals } = makeManager();
      manager = m;

      internals.nativeTitleLookup = internals.buildNativeConversationTitleMap();

      const ids = [`c_${hexA}`, hexA, `c_${hexB}`, hexB, hexC, 'c_deadbeef00000000'];
      for (const id of ids) {
        const legacy = internals.syncConversationTitleFromNative(id);
        const viaLookup = internals.lookupNativeConversationTitle(id);
        expect(viaLookup).toBe(legacy);
      }
      internals.nativeTitleLookup = null;
    });

    it('render pass uses the lookup table instead of per-conversation scans', () => {
      const hexId = 'abc123def4567890';
      appendNativeRow(hexId, 'Fresh native title');

      const { manager: m, internals } = makeManager();
      manager = m;
      internals.data = {
        folders: [],
        folderContents: {
          __root_conversations__: [
            {
              conversationId: `c_${hexId}`,
              title: 'Stale stored title',
              url: `https://gemini.google.com/app/${hexId}`,
              addedAt: Date.now(),
            },
          ],
        },
      };

      const legacyScanSpy = vi.spyOn(internals, 'syncConversationTitleFromNative');
      const list = internals.createFoldersList();

      expect(legacyScanSpy).not.toHaveBeenCalled();
      expect(list.querySelector('.gv-conversation-title')?.textContent).toBe('Fresh native title');
      expect(internals.pendingTitleUpdates.get(`c_${hexId}`)).toBe('Fresh native title');
      // Table is render-scoped only.
      expect(internals.nativeTitleLookup).toBeNull();
    });

    it('search-triggered renders skip the native title sync scan (M7)', () => {
      const hexId = 'abc123def4567890';
      appendNativeRow(hexId, 'Fresh native title');

      const { manager: m, internals } = makeManager();
      manager = m;
      internals.folderSearchEnabled = true;
      internals.folderSearchQuery = 'stale';
      internals.data = {
        folders: [],
        folderContents: {
          __root_conversations__: [
            {
              conversationId: `c_${hexId}`,
              title: 'Stale stored title',
              url: `https://gemini.google.com/app/${hexId}`,
              addedAt: Date.now(),
            },
          ],
        },
      };

      const buildSpy = vi.spyOn(internals, 'buildNativeConversationTitleMap');
      const legacyScanSpy = vi.spyOn(internals, 'syncConversationTitleFromNative');
      const list = internals.createFoldersList();

      expect(buildSpy).not.toHaveBeenCalled();
      expect(legacyScanSpy).not.toHaveBeenCalled();
      expect(list.querySelector('.gv-conversation-title')?.textContent).toBe('Stale stored title');
    });
  });

  // ── M3: debounced saves for pure-UI state ──────────────────────────────────

  describe('debounced saveData scheduling (M3)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });

    it('coalesces 5 rapid folder toggles into a single storage write', () => {
      const { manager: m, internals } = makeManager();
      manager = m;
      internals.data = makeFolderData();

      const storageWriteSpy = vi.spyOn(internals.storage, 'saveData').mockResolvedValue(true);

      for (let i = 0; i < 5; i++) {
        internals.toggleFolder('folder-1');
      }
      expect(storageWriteSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(350);
      expect(storageWriteSpy).toHaveBeenCalledTimes(1);
    });

    it('flushes a pending debounced save immediately (beforeunload path)', () => {
      const { manager: m, internals } = makeManager();
      manager = m;
      internals.data = makeFolderData();

      const saveSpy = vi.spyOn(internals, 'saveData').mockResolvedValue(true);

      internals.scheduleSaveData();
      expect(saveSpy).not.toHaveBeenCalled();

      internals.flushPendingSaveData();
      expect(saveSpy).toHaveBeenCalledTimes(1);

      // Timer was consumed by the flush — no second save later.
      vi.advanceTimersByTime(1000);
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    it('flushing without a pending schedule is a no-op', () => {
      const { manager: m, internals } = makeManager();
      manager = m;

      const saveSpy = vi.spyOn(internals, 'saveData').mockResolvedValue(true);
      internals.flushPendingSaveData();
      expect(saveSpy).not.toHaveBeenCalled();
    });

    it('runs one trailing write when data changes during an in-flight save', async () => {
      const { manager: m, internals } = makeManager();
      manager = m;
      internals.data = makeFolderData();

      let finishFirstSave!: (value: boolean) => void;
      const storageWriteSpy = vi
        .spyOn(internals.storage, 'saveData')
        .mockImplementationOnce(
          () =>
            new Promise<boolean>((resolve) => {
              finishFirstSave = resolve;
            }),
        )
        .mockResolvedValue(true);

      const firstSave = internals.saveData();
      const queuedSave = internals.saveData();

      expect(await queuedSave).toBe(false);
      expect(storageWriteSpy).toHaveBeenCalledTimes(1);

      finishFirstSave(true);
      await firstSave;
      await Promise.resolve();
      await Promise.resolve();

      expect(storageWriteSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── M7: search input debounce ──────────────────────────────────────────────

  describe('folder search debounce (M7)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });

    it('rebuilds the tree once after the user stops typing', () => {
      const { manager: m, internals } = makeManager();
      manager = m;

      const refreshSpy = vi.spyOn(internals, 'refresh').mockImplementation(() => {});
      const search = internals.createFolderSearch();
      const input = search.querySelector('input');
      expect(input).not.toBeNull();

      for (const value of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
        input!.value = value;
        input!.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Query state updates immediately; the expensive rebuild is deferred.
      expect(internals.folderSearchQuery).toBe('abcde');
      expect(refreshSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(250);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── M8: account prefix in jslog-fallback URLs ─────────────────────────────

  describe('buildConversationUrlFromId account scope (M8)', () => {
    let locationMock: LocationMock;
    let originalLocation: Location;

    beforeEach(() => {
      originalLocation = window.location;
      locationMock = {
        pathname: '/app',
        origin: 'https://gemini.google.com',
        href: '',
        reload: vi.fn(),
      };
      Object.defineProperty(window, 'location', {
        value: locationMock,
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      });
    });

    it('preserves the /u/N account prefix on /app URLs', () => {
      locationMock.pathname = '/u/1/app/existing123';
      const { manager: m, internals } = makeManager();
      manager = m;

      expect(internals.buildConversationUrlFromId('abc123def4567890')).toBe(
        'https://gemini.google.com/u/1/app/abc123def4567890',
      );
    });

    it('preserves the /u/N account prefix on gem URLs', () => {
      locationMock.pathname = '/u/2/gem/gem-42/existing123';
      const { manager: m, internals } = makeManager();
      manager = m;

      expect(internals.buildConversationUrlFromId('abc123def4567890')).toBe(
        'https://gemini.google.com/u/2/gem/gem-42/abc123def4567890',
      );
    });

    it('emits no prefix outside multi-account routes', () => {
      locationMock.pathname = '/app/existing123';
      const { manager: m, internals } = makeManager();
      manager = m;

      expect(internals.buildConversationUrlFromId('abc123def4567890')).toBe(
        'https://gemini.google.com/app/abc123def4567890',
      );
    });

    it('omits the prefix under hard account isolation (rebuilt at navigation time)', () => {
      locationMock.pathname = '/u/3/app/existing123';
      const { manager: m, internals } = makeManager();
      manager = m;
      internals.accountIsolationEnabled = true;

      expect(internals.buildConversationUrlFromId('abc123def4567890')).toBe(
        'https://gemini.google.com/app/abc123def4567890',
      );
    });
  });
});
