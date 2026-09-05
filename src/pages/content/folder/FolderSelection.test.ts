import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFolderViewHarness,
  resetFolderViewBrowserMocks,
} from './__tests__/folderViewHarness';
import { mountSidebar } from './__tests__/sidebarRuntimeHarness';

vi.mock('webextension-polyfill', () => ({ default: chrome }));
vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

function pointer(target: EventTarget, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
}

describe('FolderSelection toolbar lifetime', () => {
  let harness: Awaited<ReturnType<typeof createFolderViewHarness>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetFolderViewBrowserMocks();
    harness = await createFolderViewHarness({
      folders: [
        { id: 'root', name: 'Root', parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
      ],
      folderContents: {
        root: [
          {
            conversationId: 'c_0123456789abcdef',
            title: 'Saved conversation',
            url: 'https://gemini.google.com/app/0123456789abcdef',
            addedAt: 1,
          },
        ],
      },
    });
  });

  afterEach(() => {
    harness.destroy();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function selectFolderConversation(): Promise<void> {
    const row = harness.runtime.panel!.querySelector<HTMLElement>('.gv-folder-conversation')!;
    pointer(row, 'mousedown', 0, 0);
    await vi.advanceTimersByTimeAsync(500);
    pointer(row, 'mouseup', 0, 0);
    expect(harness.runtime.panel!.classList.contains('gv-multi-select-mode')).toBe(true);
  }

  it('keeps the mounted toolbar draggable after resetting and re-entering selection', async () => {
    await selectFolderConversation();
    const panel = harness.runtime.panel!;
    const toolbar = panel.querySelector<HTMLElement>('[data-multi-select-indicator="true"]')!;
    const beforeDrag = toolbar.style.transform;
    pointer(toolbar, 'mousedown', 50, 60);
    pointer(document, 'mousemove', 90, 100);
    pointer(document, 'mouseup', 90, 100);
    expect(toolbar.style.transform).not.toBe(beforeDrag);
    const position = toolbar.style.transform;

    harness.selection.reset();
    expect(panel.classList.contains('gv-multi-select-mode')).toBe(false);
    expect(panel.querySelector('[data-multi-select-indicator="true"]')).toBe(toolbar);
    expect(toolbar.style.transform).toBe(position);
    await selectFolderConversation();

    pointer(toolbar, 'mousedown', 20, 30);
    pointer(document, 'mousemove', 70, 90);
    pointer(document, 'mouseup', 70, 90);
    expect(toolbar.style.transform).not.toBe(position);
    expect(harness.adapter.saveData).not.toHaveBeenCalled();
  });

  it('releases an old toolbar drag on remount and binds the replacement toolbar', async () => {
    await selectFolderConversation();
    const oldToolbar = harness.runtime.panel!.querySelector<HTMLElement>(
      '[data-multi-select-indicator="true"]',
    )!;
    pointer(oldToolbar, 'mousedown', 10, 10);
    pointer(document, 'mousemove', 20, 30);
    const oldPosition = oldToolbar.style.transform;

    await harness.runtime.remount();
    expect(oldToolbar.isConnected).toBe(false);
    pointer(document, 'mousemove', 90, 100);
    expect(oldToolbar.style.transform).toBe(oldPosition);
    // A retained detached node must not be able to reinstall document drag listeners.
    pointer(oldToolbar, 'mousedown', 0, 0);
    pointer(document, 'mousemove', 140, 150);
    expect(oldToolbar.style.transform).toBe(oldPosition);

    const replacement = harness.runtime.panel!.querySelector<HTMLElement>(
      '[data-multi-select-indicator="true"]',
    )!;
    const initialPosition = replacement.style.transform;
    pointer(replacement, 'mousedown', 10, 10);
    pointer(document, 'mousemove', 40, 50);
    pointer(document, 'mouseup', 40, 50);
    expect(replacement.style.transform).not.toBe(initialPosition);
    expect(oldToolbar.style.transform).toBe(oldPosition);
  });

  it.each(['folder', 'native'] as const)(
    'restores selected rows, count and actions after replacing a sidebar with %s selection',
    async (source) => {
      const stored = harness.store.data.folderContents.root;
      stored.push({
        ...stored[0],
        conversationId: 'c_1111222233334444',
        title: 'Second conversation',
        url: 'https://gemini.google.com/app/1111222233334444',
      });
      harness.treeView.render();
      const nativeRows = (sidebar: HTMLElement) =>
        stored.map((conversation) => {
          const row = document.createElement('div');
          row.dataset.testId = 'conversation';
          row.setAttribute('jslog', JSON.stringify([conversation.conversationId]));
          sidebar.appendChild(row);
          harness.selection.makeConversationDraggable(row);
          return row;
        });
      const first =
        source === 'folder'
          ? harness.runtime.panel!.querySelector<HTMLElement>('.gv-folder-conversation')!
          : nativeRows(harness.runtime.sidebar!)[0];
      pointer(first, 'mousedown', 0, 0);
      await vi.advanceTimersByTimeAsync(500);
      pointer(first, 'mouseup', 0, 0);
      const oldPanel = harness.runtime.panel!;
      harness.sidebar.host.remove();
      const replacementSidebar = mountSidebar();
      const replacementNativeRows =
        source === 'native' ? nativeRows(replacementSidebar.sidebar) : [];
      await harness.runtime.remount();
      harness.selection.mount();
      const panel = harness.runtime.panel!;
      expect(panel).not.toBe(oldPanel);
      expect(panel.classList.contains('gv-multi-select-mode')).toBe(true);
      expect(panel.querySelector('[data-selection-count="true"]')?.textContent).toBe('1 selected');
      expect(panel.querySelector('.gv-multi-select-delete-btn')).not.toBeNull();
      expect(panel.querySelector('.gv-multi-select-exit-btn')).not.toBeNull();
      const rows =
        source === 'folder'
          ? Array.from(panel.querySelectorAll<HTMLElement>('.gv-folder-conversation'))
          : replacementNativeRows;
      expect(
        rows[0].classList.contains(
          source === 'folder' ? 'gv-folder-conversation-selected' : 'gv-conversation-selected',
        ),
      ).toBe(true);
      const navigate = vi.spyOn(harness.navigation, 'navigate').mockImplementation(() => {});
      if (source === 'folder') rows[1].querySelector<HTMLAnchorElement>('a')!.click();
      else rows[1].click();
      expect(navigate).not.toHaveBeenCalled();
      expect(panel.querySelector('[data-selection-count="true"]')?.textContent).toBe('2 selected');
      panel.querySelector<HTMLButtonElement>('.gv-multi-select-exit-btn')!.click();
      expect(panel.classList.contains('gv-multi-select-mode')).toBe(false);
      expect(panel.querySelector('[data-selection-count="true"]')?.textContent).toBe('0 selected');
    },
  );

  it('opens a floating multi-select toolbar for a native long-press without a mounted sidebar', async () => {
    harness.runtime.stop();
    harness.sidebar.host.remove();
    const conversation = document.createElement('div');
    conversation.setAttribute('data-test-id', 'conversation');
    conversation.setAttribute('jslog', '["c_abc123"]');
    document.body.appendChild(conversation);
    harness.selection.makeConversationDraggable(conversation);
    expect(document.querySelector('[data-test-id="overflow-container"]')).toBeNull();
    expect(harness.runtime.panel).toBeNull();

    pointer(conversation, 'mousedown', 0, 0);
    await vi.advanceTimersByTimeAsync(500);
    pointer(conversation, 'mouseup', 0, 0);

    const host = document.querySelector<HTMLElement>('[data-multi-select-floating-host="true"]')!;
    expect(conversation.classList.contains('gv-conversation-selected')).toBe(true);
    expect(host.classList.contains('gv-multi-select-mode')).toBe(true);
    expect(host.querySelector('[data-selection-count="true"]')?.textContent).toBe('1 selected');
    expect(host.querySelector('.gv-multi-select-delete-btn')).not.toBeNull();

    host.querySelector<HTMLButtonElement>('.gv-multi-select-exit-btn')!.click();
    expect(conversation.classList.contains('gv-conversation-selected')).toBe(false);
    expect(host.classList.contains('gv-multi-select-mode')).toBe(false);
    expect(host.querySelector('.gv-multi-select-delete-btn')).toBeNull();
    expect(host.querySelector('[data-selection-count="true"]')?.textContent).toBe('0 selected');
    expect(harness.adapter.saveData).not.toHaveBeenCalled();
  });

  it('moves native selection from a temporary floating host into the restored sidebar', async () => {
    harness.runtime.stop();
    harness.sidebar.host.remove();
    const conversation = document.createElement('div');
    conversation.dataset.testId = 'conversation';
    conversation.setAttribute('jslog', '["c_abc123"]');
    document.body.appendChild(conversation);
    harness.selection.makeConversationDraggable(conversation);
    pointer(conversation, 'mousedown', 0, 0);
    await vi.advanceTimersByTimeAsync(500);
    pointer(conversation, 'mouseup', 0, 0);
    const floatingHost = document.querySelector('[data-multi-select-floating-host="true"]')!;
    expect(floatingHost).not.toBeNull();

    const restored = mountSidebar();
    restored.sidebar.appendChild(conversation);
    await harness.runtime.start('sidebar');
    harness.selection.mount();
    const panel = harness.runtime.panel!;
    expect(floatingHost.isConnected).toBe(false);
    expect(document.querySelectorAll('[data-multi-select-indicator="true"]')).toHaveLength(1);
    expect(panel.classList.contains('gv-multi-select-mode')).toBe(true);
    expect(panel.querySelector('[data-selection-count="true"]')?.textContent).toBe('1 selected');
    expect(conversation.classList.contains('gv-conversation-selected')).toBe(true);
    panel.querySelector<HTMLButtonElement>('.gv-multi-select-exit-btn')!.click();
    expect(conversation.classList.contains('gv-conversation-selected')).toBe(false);
  });
});
