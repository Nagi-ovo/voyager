import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NativeConversationMenus } from './NativeConversationMenus';

vi.mock('@/utils/i18n', () => ({ getTranslationSyncUnsafe: (key: string) => key }));

const CONVERSATION_ID = 'facefacefaceface';

function conversationRow(id = CONVERSATION_ID): HTMLElement {
  const row = document.createElement('div');
  row.setAttribute('data-test-id', 'conversation');
  row.setAttribute('jslog', `["c_${id}"]`);
  row.innerHTML = `<a href="/app/${id}"><span class="title-text">Native title</span></a>`;
  return row;
}

function nativeMenu(): HTMLElement {
  const menu = document.createElement('gem-menu');
  for (const [testId, icon] of [
    ['pin-button', 'push_pin'],
    ['rename-button', 'edit'],
    ['delete-button', 'delete'],
    ['export-to-docs-button', 'docs'],
  ]) {
    const item = document.createElement('gem-menu-item');
    item.setAttribute('data-test-id', testId);
    item.innerHTML = `<mat-icon fonticon="${icon}">${icon}</mat-icon><span class="label">${testId}</span>`;
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  return menu;
}

function clickCurrentDelete(): void {
  const triggerHost = document.createElement('conversation-actions-icon');
  const trigger = document.createElement('gem-icon-button');
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'true');
  triggerHost.appendChild(trigger);
  document.body.appendChild(triggerHost);
  nativeMenu().querySelector<HTMLElement>('[data-test-id="delete-button"]')!.click();
}

function clickDialogButton(testId = 'confirm-delete-button'): void {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const button = document.createElement('button');
  button.setAttribute('data-test-id', testId);
  button.textContent = testId === 'confirm-delete-button' ? 'Delete' : 'Cancel';
  dialog.appendChild(button);
  document.body.appendChild(dialog);
  button.click();
}

describe('NativeConversationMenus', () => {
  let menus: NativeConversationMenus;
  let sidebar: HTMLElement;
  let storageKey: string;
  let originalPath: string;
  const onConfirmedDelete = vi.fn();
  const onMoveToFolder = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    onConfirmedDelete.mockReset();
    onMoveToFolder.mockReset();
    originalPath = window.location.pathname + window.location.search;
    window.history.replaceState({}, '', `/u/0/app/${CONVERSATION_ID}`);
    sidebar = document.createElement('div');
    sidebar.setAttribute('data-test-id', 'overflow-container');
    document.body.appendChild(sidebar);
    storageKey = 'gvFolderData:account-a';
    menus = new NativeConversationMenus({
      getContext: () => ({
        sidebar,
        storageKey,
        accountIsolationEnabled: false,
        isDestroyed: false,
      }),
      onMoveToFolder,
      onConfirmedDelete,
    });
    menus.startTracking();
    menus.observePanels();
  });

  afterEach(() => {
    menus.stop();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', originalPath);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('requires native confirmation, then waits for the current route and row to leave', () => {
    const row = conversationRow();
    sidebar.appendChild(row);
    clickCurrentDelete();
    vi.advanceTimersByTime(500);
    expect(onConfirmedDelete).not.toHaveBeenCalled();

    clickDialogButton();
    vi.advanceTimersByTime(300);
    expect(onConfirmedDelete).not.toHaveBeenCalled();
    window.history.replaceState({}, '', '/u/0/app');
    vi.advanceTimersByTime(300);
    expect(onConfirmedDelete).not.toHaveBeenCalled();
    row.remove();
    vi.advanceTimersByTime(300);

    expect(onConfirmedDelete).toHaveBeenCalledExactlyOnceWith(CONVERSATION_ID);
  });

  it('resolves a sidebar Delete action from its controlled menu without a prior trigger click', () => {
    const sidebarId = 'bbbbbbbb22222222';
    const row = conversationRow(sidebarId);
    const trigger = document.createElement('button');
    trigger.setAttribute('data-test-id', 'actions-menu-button');
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', 'sidebar-delete-menu');
    row.appendChild(trigger);
    sidebar.appendChild(row);
    const menu = nativeMenu();
    menu.id = 'sidebar-delete-menu';
    menu.querySelector<HTMLElement>('[data-test-id="delete-button"]')!.click();
    clickDialogButton();
    row.remove();
    vi.runAllTimers();

    expect(onConfirmedDelete).toHaveBeenCalledExactlyOnceWith(sidebarId);
  });

  it.each(['unconfirmed', 'Escape', 'backdrop', 'Cancel'] as const)(
    'preserves a conversation after %s even when Gemini reaches pageId=none',
    (cancellation) => {
      clickCurrentDelete();
      if (cancellation === 'Escape') {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else if (cancellation === 'backdrop') {
        const backdrop = document.createElement('div');
        backdrop.className = 'cdk-overlay-backdrop';
        document.body.appendChild(backdrop);
        backdrop.click();
      } else if (cancellation === 'Cancel') {
        clickDialogButton('cancel-delete-button');
      }
      if (cancellation !== 'unconfirmed') clickDialogButton();
      window.history.replaceState({}, '', '/u/0/app?pageId=none');
      vi.runAllTimers();

      expect(onConfirmedDelete).not.toHaveBeenCalled();
    },
  );

  it.each(['hidden row', 'archived row', 'legacy archived row', 'hidden ancestor'] as const)(
    'checks the row itself after a confirmed current deletion with a %s',
    (visibility) => {
      clickCurrentDelete();
      clickDialogButton();
      const row = conversationRow();
      sidebar.appendChild(row);
      if (visibility === 'hidden ancestor') {
        sidebar.style.display = 'none';
      } else {
        row.hidden = true;
        if (visibility === 'archived row') row.classList.add('gv-conversation-archived');
        if (visibility === 'legacy archived row') {
          const actions = document.createElement('div');
          actions.className = 'conversation-actions-container gv-conversation-archived-actions';
          sidebar.appendChild(actions);
        }
      }
      window.history.replaceState({}, '', '/u/0/app?pageId=none');
      vi.runAllTimers();

      if (visibility === 'hidden ancestor') expect(onConfirmedDelete).not.toHaveBeenCalled();
      else expect(onConfirmedDelete).toHaveBeenCalledExactlyOnceWith(CONVERSATION_ID);
    },
  );

  it('preserves a hidden row when the current deletion never reaches its completion route', () => {
    clickCurrentDelete();
    clickDialogButton();
    const row = conversationRow();
    row.hidden = true;
    sidebar.appendChild(row);
    window.history.replaceState({}, '', '/u/0/app');
    vi.runAllTimers();

    expect(onConfirmedDelete).not.toHaveBeenCalled();
  });

  it.each([
    ['/app/facefacefaceface', '/u/0/app?pageId=none'],
    ['/u/0/app/facefacefaceface', '/app?pageId=none'],
  ])('keeps confirmed deletion across equivalent default-account routes %s → %s', (start, end) => {
    window.history.replaceState({}, '', start);
    clickCurrentDelete();
    clickDialogButton();
    window.history.replaceState({}, '', end);
    vi.runAllTimers();

    expect(onConfirmedDelete).toHaveBeenCalledExactlyOnceWith(CONVERSATION_ID);
  });

  it('does not confirm a candidate captured in another storage scope', () => {
    clickCurrentDelete();
    storageKey = 'gvFolderData:account-b';
    clickDialogButton();
    window.history.replaceState({}, '', '/u/0/app?pageId=none');
    vi.runAllTimers();

    expect(onConfirmedDelete).not.toHaveBeenCalled();
  });

  it('keeps an explicit deletion check across a transient native-row re-add', () => {
    clickCurrentDelete();
    clickDialogButton();
    const row = conversationRow();
    sidebar.appendChild(row);
    vi.advanceTimersByTime(300);
    row.remove();
    sidebar.appendChild(row);
    window.history.replaceState({}, '', '/u/0/app');
    vi.advanceTimersByTime(300);
    expect(onConfirmedDelete).not.toHaveBeenCalled();
    row.remove();
    vi.advanceTimersByTime(300);

    expect(onConfirmedDelete).toHaveBeenCalledExactlyOnceWith(CONVERSATION_ID);
  });

  it('expires rejected deletion checks instead of deleting after a later unrelated navigation', () => {
    clickCurrentDelete();
    clickDialogButton();
    vi.runAllTimers();
    window.history.replaceState({}, '', '/u/0/app');
    vi.advanceTimersByTime(1000);

    expect(onConfirmedDelete).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'stops deletion candidates and retries (already confirmed: %s)',
    (confirmed) => {
      clickCurrentDelete();
      if (confirmed) clickDialogButton();
      menus.stop();
      window.history.replaceState({}, '', '/u/0/app');
      clickDialogButton();
      vi.runAllTimers();

      expect(onConfirmedDelete).not.toHaveBeenCalled();
    },
  );

  it('preserves document tracking when only the panel observer is rebound', () => {
    clickCurrentDelete();
    menus.disconnectPanels();
    menus.observePanels();
    menus.startTracking();
    clickDialogButton();
    window.history.replaceState({}, '', '/u/0/app');
    vi.runAllTimers();

    expect(onConfirmedDelete).toHaveBeenCalledExactlyOnceWith(CONVERSATION_ID);
  });

  it('cancels pending menu injection when stopped before the menu finishes rendering', async () => {
    const menu = nativeMenu();
    await Promise.resolve();
    menus.stop();
    await vi.advanceTimersByTimeAsync(1000);

    expect(menu.querySelector('.gv-move-to-folder-btn')).toBeNull();
    expect(onMoveToFolder).not.toHaveBeenCalled();
  });
});
