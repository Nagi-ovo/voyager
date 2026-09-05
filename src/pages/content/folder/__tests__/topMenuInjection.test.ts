import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountIsolationService } from '@/core/services/AccountIsolationService';
import type { FolderData } from '@/core/types/folder';

import type { FolderSidebarRuntime } from '../FolderSidebarRuntime';
import type { FolderStore } from '../FolderStore';
import { FolderManager } from '../manager';
import { extractConversationInfoFromPage } from '../nativeSidebarDom';
import * as storageAdapters from '../storage/FolderStorageAdapter';
import { mountSidebar, setLayout } from './sidebarRuntimeHarness';

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

function pageTitle(title: string, containerClass = 'conversation-title-container'): void {
  const container = document.createElement('div');
  container.className = containerClass;
  const label = document.createElement('span');
  label.setAttribute('data-test-id', 'conversation-title');
  label.textContent = title;
  container.appendChild(label);
  document.body.appendChild(container);
}

let originalUrl: string;
let originalTitle: string;

beforeEach(() => {
  originalUrl = window.location.pathname + window.location.search;
  originalTitle = document.title;
  document.title = 'Google Gemini';
});

afterEach(() => {
  document.body.innerHTML = '';
  document.title = originalTitle;
  window.history.replaceState({}, '', originalUrl);
  vi.restoreAllMocks();
});

describe('extractConversationInfoFromPage', () => {
  it.each(['/', '/app', '/app/', '/app/a1b2c3', '/app/not-a-valid-id'])(
    'does not invent a conversation for %s',
    (route) => {
      window.history.replaceState({}, '', route);
      expect(extractConversationInfoFromPage()).toBeNull();
    },
  );

  it.each(['/app/a1b2c3d4e5f6a7b8', '/gem/my-gem/a1b2c3d4e5f6a7b8', '/u/1/app/a1b2c3d4e5f6a7b8'])(
    'extracts the current title and preserves the full conversation route for %s',
    (route) => {
      window.history.replaceState({}, '', route);
      pageTitle('My Chat Title');

      expect(extractConversationInfoFromPage()).toEqual({
        id: 'a1b2c3d4e5f6a7b8',
        title: 'My Chat Title',
        url: window.location.href,
      });
    },
  );

  it.each([
    ['Async Title - Gemini', 'Async Title'],
    ['Google Gemini', 'Untitled'],
  ])('falls back to the document title %s when the header is missing', (title, expected) => {
    window.history.replaceState({}, '', '/app/a1b2c3d4e5f6a7b8');
    document.title = title;

    expect(extractConversationInfoFromPage()).toMatchObject({
      id: 'a1b2c3d4e5f6a7b8',
      title: expected,
    });
  });

  it.each([
    'New chat',
    '新对话',
    '新對話',
    '新しいチャット',
    '새 채팅',
    'Nuevo chat',
    'Nouveau chat',
    'Novo chat',
    'Новый чат',
    'محادثة جديدة',
  ])('ignores the localized new-chat placeholder %s', (placeholder) => {
    window.history.replaceState({}, '', '/app/a1b2c3d4e5f6a7b8');
    pageTitle(placeholder);

    expect(extractConversationInfoFromPage()?.title).toBe('Untitled');
  });

  it('uses the next title selector when the first only contains a placeholder', () => {
    window.history.replaceState({}, '', '/app/a1b2c3d4e5f6a7b8');
    pageTitle('Gemini');
    pageTitle('Valid Title', 'top-bar-actions');

    expect(extractConversationInfoFromPage()?.title).toBe('Valid Title');
  });
});

type ManagerOwners = {
  store: FolderStore;
  sidebarRuntime: FolderSidebarRuntime;
};

describe('native move menu → folder command', () => {
  let manager: FolderManager;
  let owners: ManagerOwners;
  let writes: FolderData[];
  let sidebar: HTMLElement;

  beforeEach(async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/u/1/app/aaaaaaaaaaaaaaaa');
    vi.spyOn(accountIsolationService, 'resolveAccountScope').mockResolvedValue({
      accountKey: 'account-1',
      accountId: 1,
      routeUserId: '1',
      emailHash: null,
    });
    writes = [];
    vi.spyOn(storageAdapters, 'createFolderStorageAdapter').mockReturnValue({
      init: async () => {},
      loadData: async () => ({ folders: [], folderContents: {} }),
      saveData: async (_key, data) => {
        writes.push(structuredClone(data));
        return true;
      },
      removeData: async () => {},
      getBackendName: () => 'test-memory',
    });
    manager = new FolderManager();
    owners = manager as unknown as ManagerOwners;
    await owners.store.setAccountIsolationEnabled(true);
    owners.store.data = {
      folders: [
        { id: 'f1', name: 'Target', parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
      ],
      folderContents: { f1: [] },
    };
    sidebar = mountSidebar().sidebar;
    await owners.sidebarRuntime.start('sidebar');
    setLayout(owners.sidebarRuntime.panel!, 280, 200);
    window.history.replaceState({}, '', '/u/1/app/aaaaaaaaaaaaaaaa');
    pageTitle('Current page title');
  });

  afterEach(() => {
    manager.destroy();
    localStorage.clear();
    vi.useRealTimers();
  });

  async function openMenu(parent: HTMLElement): Promise<HTMLElement> {
    const trigger = document.createElement('button');
    trigger.setAttribute('data-test-id', 'actions-menu-button');
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', 'native-menu');
    parent.appendChild(trigger);
    const menu = document.createElement('gem-menu');
    menu.id = 'native-menu';
    menu.innerHTML =
      '<gem-menu-item data-test-id="rename-button"><mat-icon fonticon="edit">edit</mat-icon><span class="label">Rename</span></gem-menu-item>';
    document.body.appendChild(menu);
    trigger.click();
    await vi.advanceTimersByTimeAsync(40);
    const move = menu.querySelector<HTMLElement>('.gv-move-to-folder-btn');
    expect(move).not.toBeNull();
    return move!;
  }

  function selectFolder(): void {
    const target = document.querySelector<HTMLButtonElement>(
      '.gv-folder-dialog-item[data-folder-id="f1"]',
    );
    expect(target).not.toBeNull();
    target!.click();
  }

  it.each([
    ['another conversation is open', '/u/1/app/aaaaaaaaaaaaaaaa'],
    ['no conversation is open', '/u/1/app'],
  ])('resolves a sidebar trigger linked after menu injection when %s', async (_, route) => {
    window.history.replaceState({}, '', route);
    const row = document.createElement('div');
    row.setAttribute('data-test-id', 'conversation');
    row.setAttribute('jslog', '["c_bbbbbbbbbbbbbbbb"]');
    row.innerHTML =
      '<a href="/u/1/app/bbbbbbbbbbbbbbbb"><span class="title-text">Sidebar conversation</span></a>';
    const trigger = document.createElement('button');
    trigger.setAttribute('data-test-id', 'actions-menu-button');
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    row.appendChild(trigger);
    sidebar.appendChild(row);
    trigger.click();

    const menu = document.createElement('gem-menu');
    menu.id = 'late-linked-menu';
    menu.innerHTML =
      '<gem-menu-item data-test-id="rename-button"><mat-icon fonticon="edit">edit</mat-icon><span class="label">Rename</span></gem-menu-item>';
    document.body.appendChild(menu);
    await vi.advanceTimersByTimeAsync(40);
    expect(menu.querySelector('.gv-move-to-folder-btn')).not.toBeNull();

    // Gemini links the expanded trigger after rendering the panel. Later retries
    // see this linkage, but the already injected action must also use it on click.
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', menu.id);
    await vi.advanceTimersByTimeAsync(80);
    expect(menu.querySelectorAll('.gv-move-to-folder-btn')).toHaveLength(1);
    menu.querySelector<HTMLElement>('.gv-move-to-folder-btn')!.click();
    selectFolder();

    expect(owners.store.data.folderContents.f1).toEqual([
      expect.objectContaining({
        conversationId: 'bbbbbbbbbbbbbbbb',
        title: 'Sidebar conversation',
        url: 'https://gemini.google.com/u/1/app/bbbbbbbbbbbbbbbb',
      }),
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0].folderContents.f1).toEqual(owners.store.data.folderContents.f1);
  });

  it('moves the sidebar conversation with its current native title and scoped URL', async () => {
    const row = document.createElement('div');
    row.setAttribute('data-test-id', 'conversation');
    row.setAttribute('jslog', '["c_bbbbbbbbbbbbbbbb"]');
    row.innerHTML =
      '<a href="/u/1/app/bbbbbbbbbbbbbbbb"><span class="title-text">Sidebar title before rename</span></a>';
    sidebar.appendChild(row);
    const move = await openMenu(row);
    row.querySelector('.title-text')!.textContent = 'Renamed sidebar title';

    move.click();
    selectFolder();

    expect(owners.store.data.folderContents.f1).toEqual([
      expect.objectContaining({
        conversationId: 'bbbbbbbbbbbbbbbb',
        title: 'Renamed sidebar title',
        url: 'https://gemini.google.com/u/1/app/bbbbbbbbbbbbbbbb',
      }),
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0].folderContents.f1).toEqual(owners.store.data.folderContents.f1);
    expect(owners.sidebarRuntime.panel?.querySelector('.gv-conversation-title')?.textContent).toBe(
      'Renamed sidebar title',
    );
    expect(document.querySelector('.gv-folder-dialog-overlay')).toBeNull();
  });

  it('moves the current page conversation from its top menu', async () => {
    const move = await openMenu(document.body);

    move.click();
    selectFolder();

    expect(owners.store.data.folderContents.f1).toEqual([
      expect.objectContaining({
        conversationId: 'aaaaaaaaaaaaaaaa',
        title: 'Current page title',
        url: window.location.href,
      }),
    ]);
  });

  it('leaves an unresolved sidebar menu unbound even while a valid page conversation is open', async () => {
    const row = document.createElement('div');
    row.setAttribute('data-test-id', 'conversation');
    row.textContent = 'Still loading';
    sidebar.appendChild(row);
    const move = await openMenu(row);

    move.click();

    expect(document.querySelector('.gv-folder-dialog-overlay')).toBeNull();
    expect(owners.store.data.folderContents.f1).toEqual([]);
    expect(writes).toHaveLength(0);
  });
});
