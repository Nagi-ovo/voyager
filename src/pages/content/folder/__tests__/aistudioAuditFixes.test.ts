import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import type { PromptItem } from '@/core/types/sync';

import { AIStudioFolderManager } from '../aistudio';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      sync: { get: vi.fn(), set: vi.fn() },
      local: { get: vi.fn(), set: vi.fn() },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn(),
    },
  },
}));

type StoredConversation = {
  conversationId: string;
  title: string;
  url: string;
  addedAt: number;
  updatedAt?: number;
  customTitle?: boolean;
};

type ManagerInternals = {
  data: {
    folders: Array<{
      id: string;
      name: string;
      parentId: string | null;
      isExpanded: boolean;
      createdAt: number;
      updatedAt: number;
    }>;
    folderContents: Record<string, StoredConversation[]>;
  };
  container: HTMLElement | null;
  cleanupFns: Array<() => void>;
  folderEnabled: boolean;
  hideArchivedEnabled: boolean;
  accountContextPoller: number | null;
  stopRouteWatcher: (() => void) | null;
  containerMountObserver: MutationObserver | null;
  bodyPromptPopoverObserver: MutationObserver | null;
  libraryTableObserver: MutationObserver | null;
  libraryDropZoneInjected: boolean;
  showNotification: (message: string, level?: 'info' | 'warning' | 'error') => void;
  timestamp: () => string;
  setupMessageListener: () => void;
  setupAccountContextPoller: () => void;
  installRouteChangeListener: () => void;
  observeLibraryTable: () => void;
  observeBodyPromptPopovers: () => void;
  injectLibraryDropZone: () => void;
  watchContainerMount: () => void;
  destroy: () => void;
  applyFolderEnabledSetting: () => void;
  initializeFolderUI: () => Promise<void>;
  syncConversationTitlesFromPromptList: () => Promise<void>;
  applyHideArchivedToLibraryTable: () => void;
  mergePromptsData: (local: PromptItem[], cloud: PromptItem[]) => PromptItem[];
  save: () => Promise<void>;
  render: () => void;
};

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => unknown;

const managersToDestroy: ManagerInternals[] = [];

function createManager(): { manager: AIStudioFolderManager; internals: ManagerInternals } {
  const manager = new AIStudioFolderManager();
  const internals = manager as unknown as ManagerInternals;
  managersToDestroy.push(internals);
  return { manager, internals };
}

function createPromptLink(
  promptId: string,
  title: string,
  options: { promptLinkClass?: boolean; href?: string } = {},
): HTMLAnchorElement {
  const anchor = document.createElement('a');
  if (options.promptLinkClass !== false) anchor.className = 'prompt-link';
  anchor.setAttribute('href', options.href ?? `/prompts/${promptId}`);
  anchor.textContent = title;
  document.body.appendChild(anchor);
  return anchor;
}

function createLibraryRow(promptId: string): HTMLTableRowElement {
  let table = document.querySelector('table.mat-mdc-table') as HTMLTableElement | null;
  if (!table) {
    table = document.createElement('table');
    table.className = 'mat-mdc-table';
    document.body.appendChild(table);
  }
  const row = document.createElement('tr');
  row.className = 'mat-mdc-row';
  const cell = document.createElement('td');
  const anchor = document.createElement('a');
  anchor.setAttribute('href', `/prompts/${promptId}`);
  anchor.textContent = `Prompt ${promptId}`;
  cell.appendChild(anchor);
  row.appendChild(cell);
  table.appendChild(row);
  return row;
}

function storedConversation(conversationId: string, title: string): StoredConversation {
  return { conversationId, title, url: `/prompts/${conversationId}`, addedAt: Date.now() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const internals of managersToDestroy.splice(0)) {
    try {
      internals.destroy();
    } catch {}
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.documentElement.className = '';
  window.history.pushState({}, '', '/');
});

describe('M12 — notification and export timestamp string integrity', () => {
  it('renders notification className with gv- prefix and no stray spaces', () => {
    vi.useFakeTimers();
    const { internals } = createManager();

    internals.showNotification('boom', 'warning');

    const el = document.querySelector('.gv-notification') as HTMLElement | null;
    expect(el).not.toBeNull();
    expect(el?.className).toBe('gv-notification gv-notification-warning');
    expect(el?.className).toMatch(/^gv-notification gv-notification-(info|warning|error)$/);
    expect(el?.className).not.toMatch(/\s{2,}|^\s|\s$/);
    expect(el?.textContent).toBe('[Gemini Voyager] boom');
  });

  it('produces an export timestamp without embedded spaces', () => {
    const { internals } = createManager();
    expect(internals.timestamp()).toMatch(/^\d{8}-\d{6}$/);
  });
});

describe('H1 — runtime message listener response contract', () => {
  function getRegisteredListener(internals: ManagerInternals): MessageListener {
    internals.setupMessageListener();
    const addListener = vi.mocked(browser.runtime.onMessage.addListener);
    const lastCall = addListener.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    return lastCall?.[0] as unknown as MessageListener;
  }

  it('returns undefined for unknown messages so the sender promise settles', () => {
    const { internals } = createManager();
    const listener = getRegisteredListener(internals);
    const sendResponse = vi.fn();

    const result = listener({ type: 'gv.some.unrelated.broadcast' }, {}, sendResponse);

    expect(result).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('still answers gv.sync.requestData synchronously with return true', () => {
    const { internals } = createManager();
    const listener = getRegisteredListener(internals);
    const sendResponse = vi.fn();

    const result = listener({ type: 'gv.sync.requestData' }, {}, sendResponse);

    expect(result).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });
});

describe('Drive prompt merge', () => {
  it('preserves the local name when a newer legacy cloud prompt omits it', () => {
    const { internals } = createManager();
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

    expect(internals.mergePromptsData([local], [cloud])).toEqual([
      { ...cloud, name: 'Keep this name' },
    ]);
  });
});

describe('H7 — single-scan native title sync', () => {
  it('resolves all stored conversation titles with one document scan', async () => {
    createPromptLink('conv1', 'Native One');
    createPromptLink('conv2', 'Native Two');
    createPromptLink('conv3', 'Native Three', {
      promptLinkClass: false,
      href: '/u/1/prompts/conv3',
    });

    const { internals } = createManager();
    internals.data = {
      folders: [],
      folderContents: {
        folderA: [storedConversation('conv1', 'Old One'), storedConversation('conv2', 'Old Two')],
        folderB: [storedConversation('conv3', 'Old Three')],
      },
    };
    internals.save = vi.fn().mockResolvedValue(undefined);
    internals.render = vi.fn();

    const qsaSpy = vi.spyOn(document, 'querySelectorAll');
    await internals.syncConversationTitlesFromPromptList();

    expect(internals.data.folderContents.folderA[0]?.title).toBe('Native One');
    expect(internals.data.folderContents.folderA[1]?.title).toBe('Native Two');
    expect(internals.data.folderContents.folderB[0]?.title).toBe('Native Three');
    // One collectNativePromptTitles scan — not 3 selector scans per conversation.
    expect(qsaSpy).toHaveBeenCalledTimes(1);
    expect(internals.save).toHaveBeenCalledTimes(1);
    expect(internals.render).toHaveBeenCalledTimes(1);
  });

  it('prefers prompt-link anchors over generic anchors for the same prompt id', async () => {
    createPromptLink('dup1', 'Generic Title', { promptLinkClass: false });
    createPromptLink('dup1', 'Prompt Link Title');

    const { internals } = createManager();
    internals.data = {
      folders: [],
      folderContents: { folderA: [storedConversation('dup1', 'Old')] },
    };
    internals.save = vi.fn().mockResolvedValue(undefined);
    internals.render = vi.fn();

    await internals.syncConversationTitlesFromPromptList();

    expect(internals.data.folderContents.folderA[0]?.title).toBe('Prompt Link Title');
  });

  it('leaves titles untouched when no native prompt links are present', async () => {
    const { internals } = createManager();
    internals.data = {
      folders: [],
      folderContents: { folderA: [storedConversation('ghost1', 'Kept Title')] },
    };
    internals.save = vi.fn().mockResolvedValue(undefined);
    internals.render = vi.fn();

    await internals.syncConversationTitlesFromPromptList();

    expect(internals.data.folderContents.folderA[0]?.title).toBe('Kept Title');
    expect(internals.save).not.toHaveBeenCalled();
  });
});

describe('M11 — destroy() lifecycle teardown', () => {
  it('clears pollers, observers, listeners and injected DOM, and is idempotent', () => {
    vi.useFakeTimers();
    const { internals } = createManager();

    const container = document.createElement('div');
    container.className = 'gv-folder-container gv-aistudio';
    document.body.appendChild(container);
    internals.container = container;
    document.documentElement.classList.add('gv-aistudio-root');
    internals.data = {
      folders: [
        {
          id: 'f1',
          name: 'Folder',
          parentId: null,
          isExpanded: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      folderContents: { f1: [] },
    };
    internals.save = vi.fn().mockResolvedValue(undefined);

    internals.setupAccountContextPoller();
    internals.installRouteChangeListener();
    internals.observeLibraryTable();
    internals.observeBodyPromptPopovers();
    internals.injectLibraryDropZone();

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(document.querySelector('.gv-library-drop-zone')).not.toBeNull();
    expect(internals.libraryTableObserver).not.toBeNull();
    expect(internals.bodyPromptPopoverObserver).not.toBeNull();

    internals.destroy();

    expect(vi.getTimerCount()).toBe(0);
    expect(internals.accountContextPoller).toBeNull();
    expect(internals.stopRouteWatcher).toBeNull();
    expect(internals.libraryTableObserver).toBeNull();
    expect(internals.bodyPromptPopoverObserver).toBeNull();
    expect(internals.containerMountObserver).toBeNull();
    expect(internals.cleanupFns).toHaveLength(0);
    expect(internals.container).toBeNull();
    expect(internals.libraryDropZoneInjected).toBe(false);
    expect(document.querySelector('.gv-folder-container')).toBeNull();
    expect(document.querySelector('.gv-library-drop-zone')).toBeNull();
    expect(document.documentElement.classList.contains('gv-aistudio-root')).toBe(false);

    expect(() => internals.destroy()).not.toThrow();
    expect(internals.cleanupFns).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('destroys on disable and re-initializes through initializeFolderUI on enable', () => {
    vi.useFakeTimers();
    const { internals } = createManager();

    const container = document.createElement('div');
    document.body.appendChild(container);
    internals.container = container;

    internals.folderEnabled = false;
    internals.applyFolderEnabledSetting();

    expect(internals.container).toBeNull();
    expect(document.body.contains(container)).toBe(false);
    expect(internals.accountContextPoller).toBeNull();

    const initSpy = vi.fn().mockResolvedValue(undefined);
    internals.initializeFolderUI = initSpy;
    internals.folderEnabled = true;
    internals.applyFolderEnabledSetting();

    expect(initSpy).toHaveBeenCalledTimes(1);
    // The account-scope poller stopped by destroy() is restarted on re-enable.
    expect(internals.accountContextPoller).not.toBeNull();
  });

  it('does not grow cleanupFns when watchContainerMount re-arms repeatedly', () => {
    const navContent = document.createElement('div');
    navContent.className = 'nav-content v3-left-nav';
    document.body.appendChild(navContent);

    const { internals } = createManager();
    const before = internals.cleanupFns.length;

    internals.watchContainerMount();
    internals.watchContainerMount();
    internals.watchContainerMount();

    expect(internals.cleanupFns.length).toBe(before);
    expect(internals.containerMountObserver).not.toBeNull();
  });
});

describe('L12 — floating drop zone heartbeat and archived-row set', () => {
  function dispatchLibraryDragStart(row: HTMLElement): void {
    const dragstart = new Event('dragstart', { bubbles: true }) as DragEvent;
    row.dispatchEvent(dragstart);
  }

  it('hides the floating drop zone when dragover heartbeats stop mid-drag', async () => {
    vi.useFakeTimers();
    const { internals } = createManager();
    internals.data = {
      folders: [
        {
          id: 'f1',
          name: 'Folder',
          parentId: null,
          isExpanded: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      folderContents: { f1: [] },
    };
    internals.save = vi.fn().mockResolvedValue(undefined);

    const row = createLibraryRow('drag1');
    internals.injectLibraryDropZone();
    const zone = document.querySelector('.gv-library-drop-zone') as HTMLElement;
    expect(zone).not.toBeNull();

    dispatchLibraryDragStart(row);
    await vi.advanceTimersByTimeAsync(0);
    expect(zone.style.opacity).toBe('1');

    // dragover traffic keeps the zone alive past the heartbeat window...
    await vi.advanceTimersByTimeAsync(500);
    document.dispatchEvent(new Event('dragover', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(500);
    expect(zone.style.opacity).toBe('1');

    // ...but a silent gap (source row torn out, no dragend/drop) hides it.
    await vi.advanceTimersByTimeAsync(400);
    expect(zone.style.opacity).toBe('0');
  });

  it('hides the floating drop zone on a document-level drop', async () => {
    vi.useFakeTimers();
    const { internals } = createManager();
    internals.data = {
      folders: [
        {
          id: 'f1',
          name: 'Folder',
          parentId: null,
          isExpanded: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      folderContents: { f1: [] },
    };
    internals.save = vi.fn().mockResolvedValue(undefined);

    const row = createLibraryRow('drag2');
    internals.injectLibraryDropZone();
    const zone = document.querySelector('.gv-library-drop-zone') as HTMLElement;

    dispatchLibraryDragStart(row);
    await vi.advanceTimersByTimeAsync(0);
    expect(zone.style.opacity).toBe('1');

    document.dispatchEvent(new Event('drop', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(150);
    expect(zone.style.opacity).toBe('0');
  });

  it('hides archived library rows via a per-pass id set', () => {
    window.history.pushState({}, '', '/library');
    const archivedRow = createLibraryRow('archived1');
    const freeRow = createLibraryRow('free1');

    const { internals } = createManager();
    internals.hideArchivedEnabled = true;
    internals.data = {
      folders: [
        {
          id: 'f1',
          name: 'Folder',
          parentId: null,
          isExpanded: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      folderContents: { f1: [storedConversation('archived1', 'Archived')] },
    };

    internals.applyHideArchivedToLibraryTable();

    expect(archivedRow.classList.contains('gv-conversation-archived')).toBe(true);
    expect(freeRow.classList.contains('gv-conversation-archived')).toBe(false);
  });
});
