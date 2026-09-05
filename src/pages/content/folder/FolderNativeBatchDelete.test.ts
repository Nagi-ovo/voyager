import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFolderViewHarness,
  resetFolderViewBrowserMocks,
} from './__tests__/folderViewHarness';

vi.mock('webextension-polyfill', () => ({ default: chrome }));
vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) =>
    key === 'batch_delete_match_patterns' ? 'delete' : key,
  initI18n: () => Promise.resolve(),
}));

const FIRST_ID = 'aaaabbbbccccdddd';
const SECOND_ID = '1111222233334444';

describe('native batch deletion lifetime', () => {
  let harness: Awaited<ReturnType<typeof createFolderViewHarness>>;
  let deleted: string[];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetFolderViewBrowserMocks();
    history.replaceState({}, '', '/u/0/app');
    deleted = [];
    harness = await createFolderViewHarness({ folders: [], folderContents: {} });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    harness.destroy();
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function visibleButton(testId: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.dataset.testId = testId;
    Object.defineProperty(button, 'offsetParent', { get: () => document.body });
    button.addEventListener('click', action);
    // Native menu clicks must not trigger the selection owner's outside-click exit.
    const overlay = document.createElement('div');
    overlay.className = 'cdk-overlay-container';
    overlay.appendChild(button);
    document.body.appendChild(overlay);
    return button;
  }

  function showDeletionMenu(id: string): HTMLButtonElement {
    const menu = visibleButton('delete-button', () => {
      menu.remove();
      const confirm = visibleButton('confirm-delete-button', () => {
        deleted.push(id);
        confirm.remove();
      });
    });
    return menu;
  }

  function addMoreButton(row: HTMLElement, id: string): HTMLButtonElement {
    const action = document.createElement('button');
    action.dataset.testId = 'actions-menu-button';
    action.addEventListener('click', () => showDeletionMenu(id));
    row.appendChild(action);
    return action;
  }

  function nativeRow(id: string, withAction = true): HTMLElement {
    const row = document.createElement('div');
    row.dataset.testId = 'conversation';
    row.setAttribute('jslog', `["c_${id}"]`);
    if (withAction) addMoreButton(row, id);
    harness.runtime.sidebar!.appendChild(row);
    harness.selection.makeConversationDraggable(row);
    return row;
  }

  async function startBatch(): Promise<void> {
    const first = nativeRow(FIRST_ID);
    const second = nativeRow(SECOND_ID);
    first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await vi.advanceTimersByTimeAsync(500);
    first.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    second.click();
    expect(document.querySelector('[data-selection-count="true"]')?.textContent).toBe('2 selected');
    document.querySelector<HTMLButtonElement>('.gv-multi-select-delete-btn')!.click();
  }

  it.each(['destroy', 'disable'] as const)(
    'stops the remaining batch and result UI after %s during the inter-item wait',
    async (action) => {
      const notify = vi.spyOn(harness.feedback, 'showNotification');
      await startBatch();
      await vi.advanceTimersByTimeAsync(1100);
      expect(deleted).toEqual([FIRST_ID]);
      if (action === 'destroy') harness.destroy();
      else {
        harness.selection.reset();
        harness.runtime.stop();
      }
      const timer = vi.spyOn(window, 'setTimeout');
      await vi.advanceTimersByTimeAsync(6000);
      expect(deleted).toEqual([FIRST_ID]);
      expect(notify).not.toHaveBeenCalled();
      expect(timer.mock.calls.some(([, delay]) => delay === 1500)).toBe(false);
    },
  );

  it('keeps a replacement batch active when the cancelled batch finishes unwinding', async () => {
    const notify = vi.spyOn(harness.feedback, 'showNotification');
    await startBatch();
    harness.selection.reset();
    document.querySelectorAll('.cdk-overlay-container').forEach((overlay) => overlay.remove());
    const next = harness.runtime.sidebar!.querySelectorAll<HTMLElement>(
      '[data-test-id="conversation"]',
    )[1];
    next.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    // Start the new batch before the old cancelled Promise continuation runs.
    vi.advanceTimersByTime(500);
    next.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('.gv-multi-select-delete-btn')!.click();
    const progress = document.querySelector('.gv-batch-delete-progress');
    expect(progress).not.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.gv-batch-delete-progress')).toBe(progress);
    await vi.advanceTimersByTimeAsync(1100);
    expect(deleted).toEqual([SECOND_ID]);
    expect(notify).toHaveBeenCalledExactlyOnceWith('batch_delete_success', 'success');
  });

  it('keeps a confirmed batch running across a sidebar-only remount', async () => {
    const notify = vi.spyOn(harness.feedback, 'showNotification');
    await startBatch();
    await vi.advanceTimersByTimeAsync(1100);
    await harness.runtime.remount();
    await vi.advanceTimersByTimeAsync(1600);
    expect(deleted).toEqual([FIRST_ID, SECOND_ID]);
    expect(notify).toHaveBeenCalledWith('batch_delete_success', 'success');
  });

  it('does not resume an old batch after leaving and returning to its account activation', async () => {
    const notify = vi.spyOn(harness.feedback, 'showNotification');
    await startBatch();
    const activation = harness.store.activation;
    history.replaceState({}, '', '/u/1/app');
    await harness.store.refreshAccountScope();
    history.replaceState({}, '', '/u/0/app');
    await harness.store.refreshAccountScope();
    expect(harness.store.activation).toBeGreaterThan(activation);
    await vi.advanceTimersByTimeAsync(6000);
    expect(deleted).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(['row action', 'menu', 'confirmation'] as const)(
    'releases a cancelled native %s wait without clicking or waiting for its timeout',
    async (stage) => {
      const row = nativeRow(FIRST_ID, stage !== 'row action');
      const controller = new AbortController();
      let result: boolean | undefined;
      const deleting = harness.nativeMenus
        .deleteConversation(FIRST_ID, controller.signal)
        .then((value) => {
          result = value;
        });
      await vi.advanceTimersByTimeAsync(stage === 'confirmation' ? 300 : 0);
      controller.abort();
      if (stage === 'row action') addMoreButton(row, FIRST_ID);
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toBe(false);
      await deleting;
      await vi.advanceTimersByTimeAsync(6000);
      expect(deleted).toEqual([]);
    },
  );

  it('stops an active native delete when the menu owner is stopped', async () => {
    nativeRow(FIRST_ID);
    const deleting = harness.nativeMenus.deleteConversation(FIRST_ID);
    await vi.advanceTimersByTimeAsync(0);
    harness.nativeMenus.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(await deleting).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(deleted).toEqual([]);
  });

  it('does not click a new account menu while an old native delete is awaiting its menu', async () => {
    nativeRow(FIRST_ID);
    const deleting = harness.nativeMenus.deleteConversation(FIRST_ID);
    await vi.advanceTimersByTimeAsync(0);
    document.querySelector('[data-test-id="delete-button"]')!.remove();
    history.replaceState({}, '', '/u/1/app');
    showDeletionMenu('unrelated-account-B-conversation');
    await vi.advanceTimersByTimeAsync(1100);
    expect(await deleting).toBe(false);
    expect(deleted).toEqual([]);
  });
});
