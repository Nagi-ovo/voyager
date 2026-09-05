import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountIsolationService } from '@/core/services/AccountIsolationService';
import type { FolderData } from '@/core/types/folder';

import type { FolderSidebarRuntime } from '../FolderSidebarRuntime';
import type { FolderStore } from '../FolderStore';
import { FolderManager } from '../manager';
import * as storageAdapters from '../storage/FolderStorageAdapter';
import { mountSidebar, setLayout } from './sidebarRuntimeHarness';

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

type ManagerOwners = {
  store: FolderStore;
  sidebarRuntime: FolderSidebarRuntime;
  hideArchivedConversations: boolean;
};

const CONVERSATION_ID = '2468ace02468ace0';
const OTHER_ID = '13579bdf13579bdf';

function createConversationEl(id: string, title = 'Native title'): HTMLElement {
  const row = document.createElement('div');
  row.setAttribute('data-test-id', 'conversation');
  row.setAttribute('jslog', `["c_${id}"]`);
  row.innerHTML = `<a href="/app/${id}"><span class="title-text gds-body-s">${title}</span></a>`;
  return row;
}

function dispatchDragStart(element: HTMLElement) {
  const transfer = { effectAllowed: '', setData: vi.fn(), setDragImage: vi.fn() };
  const event = new Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  element.dispatchEvent(event);
  const payload = transfer.setData.mock.calls.find(([type]) => type === 'application/json')?.[1];
  expect(payload).toBeTruthy();
  return JSON.parse(payload);
}

function clickDelete(): void {
  const triggerHost = document.createElement('conversation-actions-icon');
  const trigger = document.createElement('gem-icon-button');
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'true');
  triggerHost.appendChild(trigger);
  document.body.appendChild(triggerHost);
  const menu = document.createElement('gem-menu');
  menu.innerHTML = '<gem-menu-item data-test-id="delete-button">Delete</gem-menu-item>';
  document.body.appendChild(menu);
  menu.querySelector<HTMLElement>('[data-test-id="delete-button"]')!.click();
}

function clickDeleteDialogButton(testId = 'confirm-delete-button'): void {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const button = document.createElement('button');
  button.setAttribute('data-test-id', testId);
  button.textContent = testId === 'confirm-delete-button' ? 'Delete' : 'Cancel';
  dialog.appendChild(button);
  document.body.appendChild(dialog);
  button.click();
}

/** Owner timing/confirmation cases live beside NativeSidebarObserver and NativeConversationMenus. */
describe('FolderManager native sidebar integration', () => {
  let manager: FolderManager;
  let owners: ManagerOwners;
  let writes: FolderData[];
  let sidebar: HTMLElement;
  let originalUrl: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    originalUrl = window.location.pathname + window.location.search;
    window.history.replaceState({}, '', `/u/0/app/${CONVERSATION_ID}`);
    sidebar = mountSidebar().sidebar;
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
    owners.store.data = {
      folders: ['f1', 'f2'].map((id) => ({
        id,
        name: id,
        parentId: null,
        isExpanded: true,
        createdAt: 0,
        updatedAt: 0,
      })),
      folderContents: {
        f1: [
          {
            conversationId: `c_${CONVERSATION_ID}`,
            title: 'Deleted conversation',
            url: `/app/${CONVERSATION_ID}`,
            addedAt: 0,
          },
          {
            conversationId: `c_${OTHER_ID}`,
            title: 'Preserved conversation',
            url: `/app/${OTHER_ID}`,
            addedAt: 0,
          },
        ],
        f2: [
          {
            conversationId: CONVERSATION_ID,
            title: 'Same conversation in another folder',
            url: `/app/${CONVERSATION_ID}`,
            addedAt: 0,
          },
        ],
      },
    };
    await owners.sidebarRuntime.start('sidebar');
    setLayout(owners.sidebarRuntime.panel!, 280, 200);
    expect(owners.sidebarRuntime.sidebar).toBe(sidebar);
  });

  afterEach(() => {
    manager.destroy();
    document.body.innerHTML = '';
    localStorage.clear();
    window.history.replaceState({}, '', originalUrl);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function remountSidebar(): Promise<void> {
    sidebar.remove();
    sidebar = mountSidebar().sidebar;
    await owners.sidebarRuntime.remount();
    setLayout(owners.sidebarRuntime.panel!, 280, 200);
    expect(owners.sidebarRuntime.sidebar).toBe(sidebar);
  }

  it.each(['replace', 'remove'])(
    'preserves folder assignments when Gemini virtualizes native rows (%s)',
    async (mutation) => {
      const row = createConversationEl(CONVERSATION_ID);
      sidebar.appendChild(row);
      await vi.advanceTimersByTimeAsync(50);
      if (mutation === 'replace') row.replaceWith(createConversationEl(CONVERSATION_ID));
      else row.remove();
      window.history.replaceState({}, '', '/app?pageId=none');
      await vi.advanceTimersByTimeAsync(1000);

      expect(
        owners.store.data.folderContents.f1.map(({ conversationId }) => conversationId),
      ).toEqual([`c_${CONVERSATION_ID}`, `c_${OTHER_ID}`]);
      expect(owners.store.data.folderContents.f2[0].conversationId).toBe(CONVERSATION_ID);
    },
  );

  it.each(['/app', '/u/0/app?pageId=none'])(
    'removes only the confirmed current conversation after sidebar reinitialization and settlement at %s',
    async (completionRoute) => {
      clickDelete();
      await remountSidebar();
      clickDeleteDialogButton();
      window.history.replaceState({}, '', completionRoute);
      await vi.advanceTimersByTimeAsync(350);

      expect(
        owners.store.data.folderContents.f1.map((conversation) => conversation.conversationId),
      ).toEqual([`c_${OTHER_ID}`]);
      expect(owners.store.data.folderContents.f2).toEqual([]);
      expect(writes.at(-1)?.folderContents).toEqual(owners.store.data.folderContents);
    },
  );

  it.each([
    ['storage key', '/u/0/app?pageId=none'],
    ['route account', '/u/1/app?pageId=none'],
  ])('discards a pending native deletion after the %s changes', async (change, route) => {
    clickDelete();
    clickDeleteDialogButton();
    if (change === 'storage key') {
      const previousKey = owners.store.storageKey;
      vi.spyOn(accountIsolationService, 'resolveAccountScope').mockResolvedValue({
        accountKey: 'account-b',
        accountId: 1,
        routeUserId: '0',
        emailHash: null,
      });
      await owners.store.setAccountIsolationEnabled(true);
      expect(owners.store.storageKey).not.toBe(previousKey);
    }
    owners.store.data.folderContents = {
      f2: [
        {
          conversationId: `c_${CONVERSATION_ID}`,
          title: 'Account B conversation',
          url: `/u/1/app/${CONVERSATION_ID}`,
          addedAt: 0,
        },
      ],
    };
    window.history.replaceState({}, '', route);
    await vi.advanceTimersByTimeAsync(1000);

    expect(owners.store.data.folderContents.f2).toHaveLength(1);
    expect(owners.store.data.folderContents.f2[0].title).toBe('Account B conversation');
    expect(writes).toHaveLength(0);
  });

  it('preserves folder entries when native deletion is cancelled after sidebar reinitialization', async () => {
    clickDelete();
    await remountSidebar();
    clickDeleteDialogButton('cancel-delete-button');
    window.history.replaceState({}, '', '/u/0/app?pageId=none');
    await vi.advanceTimersByTimeAsync(1000);

    expect(owners.store.data.folderContents.f1).toHaveLength(2);
    expect(owners.store.data.folderContents.f2).toHaveLength(1);
    expect(writes).toHaveLength(0);
  });

  it.each([false, true])(
    'clears native deletion on destroy after remount (confirmed: %s)',
    async (confirmed) => {
      clickDelete();
      await remountSidebar();
      if (confirmed) {
        clickDeleteDialogButton();
        await vi.advanceTimersByTimeAsync(350);
      }
      manager.destroy();
      window.history.replaceState({}, '', '/app');
      if (!confirmed) clickDeleteDialogButton();
      await vi.advanceTimersByTimeAsync(1000);

      expect(owners.store.data.folderContents.f1).toHaveLength(2);
      expect(owners.store.data.folderContents.f2).toHaveLength(1);
      expect(writes).toHaveLength(0);
    },
  );

  it('uses lr26 title-text when dragging an observed native conversation into folders', async () => {
    const row = createConversationEl('1234abcd', 'Quarterly planning notes');
    sidebar.appendChild(row);
    await vi.advanceTimersByTimeAsync(50);

    expect(dispatchDragStart(row)).toMatchObject({
      conversationId: 'c_1234abcd',
      title: 'Quarterly planning notes',
      url: expect.stringContaining('/app/1234abcd'),
    });
  });

  it('uses lr26 title-text for every selected native conversation drag payload', async () => {
    const first = createConversationEl('aaaabbbb', 'First selected chat');
    const second = createConversationEl('ccccdddd', 'Second selected chat');
    sidebar.append(first, second);
    await vi.advanceTimersByTimeAsync(50);
    first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await vi.advanceTimersByTimeAsync(500);
    first.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    first.click();
    second.click();
    expect(first.classList.contains('gv-conversation-selected')).toBe(true);
    expect(second.classList.contains('gv-conversation-selected')).toBe(true);

    const payload = dispatchDragStart(first);

    expect(payload.title).toBe('2 conversations');
    expect(payload.conversations).toEqual([
      expect.objectContaining({ conversationId: 'c_aaaabbbb', title: 'First selected chat' }),
      expect.objectContaining({ conversationId: 'c_ccccdddd', title: 'Second selected chat' }),
    ]);
  });

  it('cancels queued native enhancements when the manager is destroyed', async () => {
    const row = createConversationEl(CONVERSATION_ID);
    sidebar.appendChild(row);
    await Promise.resolve();
    manager.destroy();
    await vi.advanceTimersByTimeAsync(1000);

    expect(row.draggable).toBe(false);
    expect(row.classList.contains('gv-conversation-archived')).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('skips folder membership scans and caches the legacy-layout miss while archive hiding is off', async () => {
    owners.hideArchivedConversations = false;
    const membershipSpy = vi.spyOn(owners.store, 'isConversationInFolders');
    const querySpy = vi.spyOn(sidebar, 'querySelector');
    const rows = [createConversationEl('ee55ee55'), createConversationEl('ee66ee66')];
    sidebar.append(...rows);
    await vi.advanceTimersByTimeAsync(50);

    expect(rows.every((row) => row.draggable)).toBe(true);
    expect(membershipSpy).not.toHaveBeenCalled();
    expect(
      querySpy.mock.calls.filter(([selector]) => selector === '.conversation-actions-container'),
    ).toHaveLength(1);
  });

  it('clears leftover archived state in the legacy sibling layout when archive hiding is off', async () => {
    owners.hideArchivedConversations = false;
    const row = createConversationEl(CONVERSATION_ID);
    row.classList.add('gv-conversation-archived');
    const actions = document.createElement('div');
    actions.className = 'conversation-actions-container gv-conversation-archived-actions';
    sidebar.append(row, actions);
    await vi.advanceTimersByTimeAsync(50);

    expect(actions.classList.contains('gv-conversation-archived-actions')).toBe(false);
    expect(row.classList.contains('gv-conversation-archived')).toBe(false);
  });
});
