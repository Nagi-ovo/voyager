import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FLOATING_PANEL_CLASS,
  type FloatingPanelHandle,
  type FloatingPanelMountArgs,
  mountFloatingPanel,
} from './floatingPanel';
import type { ConversationReference, Folder, FolderData } from './types';

const mockIsSafari = vi.hoisted(() => vi.fn(() => false));

vi.mock('@/core/utils/browser', () => ({
  isSafari: mockIsSafari,
}));

vi.mock('@/utils/i18n', () => ({
  getTranslationSyncUnsafe: (key: string) => key,
}));

let mountedHandles: FloatingPanelHandle[] = [];
let originalResizeObserver: typeof ResizeObserver | undefined;
let originalInnerWidth: number;
let originalInnerHeight: number;

function createFolder(
  id: string,
  name: string,
  parentId: string | null,
  sortIndex: number,
  overrides: Partial<Folder> = {},
): Folder {
  return {
    id,
    name,
    parentId,
    isExpanded: true,
    sortIndex,
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

function createData(): FolderData {
  return {
    folders: [
      createFolder('folder-a', 'Alpha', null, 0),
      createFolder('folder-b', 'Beta', null, 1),
    ],
    folderContents: {
      'folder-a': [createConversation('conv-a', 'Conversation A', { starred: true })],
      'folder-b': [],
    },
  };
}

function setWindowSize(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: height,
  });
}

function mountPanel(args: Partial<FloatingPanelMountArgs> = {}): FloatingPanelHandle {
  const handle = mountFloatingPanel({
    ...args,
    data: args.data ?? createData(),
  });
  mountedHandles.push(handle);
  return handle;
}

function installResizeObserverMock(): {
  emit: () => void;
} {
  let callback: ResizeObserverCallback | null = null;

  class MockResizeObserver implements ResizeObserver {
    constructor(nextCallback: ResizeObserverCallback) {
      callback = nextCallback;
    }

    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  globalThis.ResizeObserver = MockResizeObserver;

  return {
    emit: () => callback?.([], {} as ResizeObserver),
  };
}

function setElementRect(element: HTMLElement, width: number, height: number): void {
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect;
}

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Expected element for selector: ${selector}`);
  }
  return element;
}

function keydown(element: Element, key: string): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function contextMenu(element: Element): void {
  element.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 32,
    }),
  );
}

function createDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  const transfer = {
    dropEffect: 'none' as DataTransfer['dropEffect'],
    effectAllowed: 'uninitialized' as DataTransfer['effectAllowed'],
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    // Browsers expose `types` as a live view of stored MIME keys. The mock
    // regenerates it on read so dragover checks (which can't read values
    // for security) still observe what setData put in.
    get types(): readonly string[] {
      return Array.from(store.keys());
    },
    clearData: (format?: string) => {
      if (format) {
        store.delete(format);
      } else {
        store.clear();
      }
    },
    getData: (format: string) => store.get(format) ?? '',
    setData: (format: string, value: string) => {
      store.set(format, value);
    },
    setDragImage: () => {},
  };
  return transfer as unknown as DataTransfer;
}

function createDragEvent(type: string, dataTransfer: DataTransfer): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', {
    value: dataTransfer,
  });
  return event;
}

function pointerEvent(type: string, init: MouseEventInit): Event {
  // jsdom has no PointerEvent constructor; MouseEvent carries everything the
  // drag handlers read (button, clientX/Y).
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
}

function stubPointerCapture(element: HTMLElement): void {
  Object.assign(element, {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  });
}

function folderHeader(root: ParentNode, folderId: string): HTMLElement {
  return requireElement<HTMLElement>(
    root,
    `.${FLOATING_PANEL_CLASS}__folder-header[data-folder-id="${folderId}"]`,
  );
}

afterEach(() => {
  for (const handle of mountedHandles) {
    handle.destroy();
  }
  mountedHandles = [];
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  mockIsSafari.mockReturnValue(false);
  globalThis.ResizeObserver = originalResizeObserver as typeof ResizeObserver;
  setWindowSize(originalInnerWidth, originalInnerHeight);
});

describe('mountFloatingPanel', () => {
  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    originalInnerWidth = window.innerWidth;
    originalInnerHeight = window.innerHeight;
  });

  it('renders folder conversations and fires navigation from a conversation row', () => {
    const onNavigate = vi.fn();
    const handle = mountPanel({ onNavigate });

    expect(handle.element.textContent).toContain('Alpha');
    expect(handle.element.textContent).toContain('Conversation A');

    const title = requireElement<HTMLButtonElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__conv-title`,
    );
    click(title);

    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-a' }));
  });

  it('follows the conversation order selected in folder settings', () => {
    const data = createData();
    data.folderContents['folder-a'] = [
      createConversation('manual-first', 'Manual first', { sortIndex: 0, lastOpenedAt: 100 }),
      createConversation('recent-first', 'Recent first', { sortIndex: 1, lastOpenedAt: 200 }),
    ];
    const handle = mountPanel({ data });
    const getOrder = () =>
      Array.from(
        handle.element.querySelectorAll<HTMLElement>(`.${FLOATING_PANEL_CLASS}__conv`),
      ).map((row) => row.dataset.conversationId);

    expect(getOrder()).toEqual(['manual-first', 'recent-first']);

    expect(handle.element.querySelector(`.${FLOATING_PANEL_CLASS}__icon-button--sort`)).toBeNull();

    handle.update(data, 'recent');
    expect(getOrder()).toEqual(['recent-first', 'manual-first']);
  });

  it('renders the move-to-folder hint above the folder tree', () => {
    const handle = mountPanel();

    const hint = requireElement<HTMLElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__hint-stack`,
    );

    expect(hint.textContent).toContain('floatingPanelMoveHint');
    expect(hint.textContent).toContain('floatingPanelGestureHint');
  });

  it('fires onCreateFolder for the header create input', () => {
    const onCreateFolder = vi.fn();
    const handle = mountPanel({ onCreateFolder });

    const createButton = requireElement<HTMLButtonElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__icon-button--create`,
    );
    click(createButton);

    const input = requireElement<HTMLInputElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__inline-input`,
    );
    input.value = 'New root';
    keydown(input, 'Enter');

    expect(onCreateFolder).toHaveBeenCalledWith('New root', null);
  });

  it('fires onCreateFolder with a parent id from the folder-row add button', () => {
    const onCreateFolder = vi.fn();
    const handle = mountPanel({ onCreateFolder });

    const addChildButton = requireElement<HTMLButtonElement>(
      folderHeader(handle.element, 'folder-a'),
      `.${FLOATING_PANEL_CLASS}__icon-button--add-child`,
    );
    click(addChildButton);

    const input = requireElement<HTMLInputElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__inline-input`,
    );
    input.value = 'Nested';
    keydown(input, 'Enter');

    expect(onCreateFolder).toHaveBeenCalledWith('Nested', 'folder-a');
  });

  it('fires onRenameFolder from double-click inline rename', () => {
    const onRenameFolder = vi.fn();
    const handle = mountPanel({ onRenameFolder });

    const name = requireElement<HTMLElement>(
      folderHeader(handle.element, 'folder-a'),
      `.${FLOATING_PANEL_CLASS}__folder-name`,
    );
    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));

    const input = requireElement<HTMLInputElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__inline-input`,
    );
    input.value = 'Renamed';
    keydown(input, 'Enter');

    expect(onRenameFolder).toHaveBeenCalledWith('folder-a', 'Renamed');
  });

  it('fires context-menu pin and delete callbacks without mutating data directly', () => {
    const onToggleFolderPinned = vi.fn();
    const onDeleteFolder = vi.fn();
    const handle = mountPanel({ onToggleFolderPinned, onDeleteFolder });

    contextMenu(folderHeader(handle.element, 'folder-a'));
    const pinButton = requireElement<HTMLButtonElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__menu-item`,
    );
    click(pinButton);
    expect(onToggleFolderPinned).toHaveBeenCalledWith('folder-a');

    contextMenu(folderHeader(handle.element, 'folder-a'));
    const deleteButton = requireElement<HTMLButtonElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__menu-item--danger`,
    );
    click(deleteButton);

    const confirmDeleteButton = requireElement<HTMLButtonElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__menu-item--danger`,
    );
    const confirmMenu = requireElement<HTMLElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__context-menu--confirming`,
    );
    const confirmButtons = confirmMenu.querySelectorAll(`.${FLOATING_PANEL_CLASS}__menu-item`);
    expect(confirmMenu.querySelector(`.${FLOATING_PANEL_CLASS}__confirm-message`)).toBeNull();
    expect(confirmButtons).toHaveLength(2);
    click(confirmDeleteButton);

    expect(onDeleteFolder).toHaveBeenCalledWith('folder-a');
    expect(handle.element.textContent).toContain('Alpha');
  });

  it('fires conversation star and remove callbacks from row action buttons', () => {
    const onToggleStar = vi.fn();
    const onRemoveConversation = vi.fn();
    const handle = mountPanel({ onToggleStar, onRemoveConversation });

    const row = requireElement<HTMLElement>(handle.element, `.${FLOATING_PANEL_CLASS}__conv`);
    click(requireElement<HTMLButtonElement>(row, `.${FLOATING_PANEL_CLASS}__icon-button--star`));
    click(requireElement<HTMLButtonElement>(row, `.${FLOATING_PANEL_CLASS}__icon-button--remove`));

    expect(onToggleStar).toHaveBeenCalledWith('folder-a', 'conv-a');
    expect(onRemoveConversation).toHaveBeenCalledWith('folder-a', 'conv-a');
  });

  it('moves an existing floating-panel conversation by dragging it onto another folder', () => {
    const onMoveConversation = vi.fn();
    const handle = mountPanel({ onMoveConversation });
    const row = requireElement<HTMLElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__conv[data-conversation-id="conv-a"]`,
    );
    const target = folderHeader(handle.element, 'folder-b');
    const dataTransfer = createDataTransfer();

    row.dispatchEvent(createDragEvent('dragstart', dataTransfer));
    const dragover = createDragEvent('dragover', dataTransfer);
    target.dispatchEvent(dragover);
    target.dispatchEvent(createDragEvent('drop', dataTransfer));

    expect(row.draggable).toBe(true);
    expect(dataTransfer.effectAllowed).toBe('move');
    expect(dragover.defaultPrevented).toBe(true);
    expect(onMoveConversation).toHaveBeenCalledWith('conv-a', 'folder-a', 'folder-b');
  });

  it('does not move anything when a native conversation drag payload is dropped', () => {
    // The panel accepts any `application/json` payload at dragover time — it
    // can't peek at the content then (browser security blocks getData()), so
    // the native "drop target highlight" may flash briefly. The drop handler
    // is where native payloads (no `sourceFolderId`) are actually rejected.
    const onMoveConversation = vi.fn();
    const handle = mountPanel({ onMoveConversation });
    const target = folderHeader(handle.element, 'folder-b');
    const dataTransfer = createDataTransfer();
    dataTransfer.setData(
      'application/json',
      JSON.stringify({
        type: 'conversation',
        conversationId: 'native-a',
        title: 'Native Conversation A',
        url: 'https://gemini.google.com/app/native-a',
      }),
    );

    target.dispatchEvent(createDragEvent('dragover', dataTransfer));
    target.dispatchEvent(createDragEvent('drop', dataTransfer));

    expect(onMoveConversation).not.toHaveBeenCalled();
  });

  it('suppresses create-subfolder affordances at the floating panel max depth', () => {
    const handle = mountPanel({
      data: {
        folders: [
          createFolder('root', 'Root', null, 0),
          createFolder('child', 'Child', 'root', 0),
          createFolder('grandchild', 'Grandchild', 'child', 0),
        ],
        folderContents: {
          root: [],
          child: [],
          grandchild: [],
        },
      },
    });

    expect(
      folderHeader(handle.element, 'grandchild').querySelector(
        `.${FLOATING_PANEL_CLASS}__icon-button--add-child`,
      ),
    ).toBeNull();

    contextMenu(folderHeader(handle.element, 'grandchild'));
    expect(handle.element.textContent).not.toContain('floatingPanelCreateSubfolder');
  });

  it('cancels create and rename inline forms on outside mousedown', () => {
    const onCreateFolder = vi.fn();
    const onRenameFolder = vi.fn();
    const handle = mountPanel({ onCreateFolder, onRenameFolder });

    click(
      requireElement<HTMLButtonElement>(
        handle.element,
        `.${FLOATING_PANEL_CLASS}__icon-button--create`,
      ),
    );
    expect(handle.element.querySelector(`.${FLOATING_PANEL_CLASS}__inline-input`)).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(handle.element.querySelector(`.${FLOATING_PANEL_CLASS}__inline-input`)).toBeNull();
    expect(onCreateFolder).not.toHaveBeenCalled();

    requireElement<HTMLElement>(
      folderHeader(handle.element, 'folder-a'),
      `.${FLOATING_PANEL_CLASS}__folder-name`,
    ).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(handle.element.querySelector(`.${FLOATING_PANEL_CLASS}__inline-input`)).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(handle.element.querySelector(`.${FLOATING_PANEL_CLASS}__inline-input`)).toBeNull();
    expect(onRenameFolder).not.toHaveBeenCalled();
  });

  it('fires onSetFolderColor from the context-menu color swatches', () => {
    const onSetFolderColor = vi.fn();
    const handle = mountPanel({ onSetFolderColor });

    contextMenu(folderHeader(handle.element, 'folder-a'));
    const redSwatch = requireElement<HTMLButtonElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__color-swatch[aria-label="folder_color_red"]`,
    );
    click(redSwatch);

    expect(onSetFolderColor).toHaveBeenCalledWith('folder-a', 'red');
  });

  it('renders cloud buttons, fires callbacks, and updates dynamic tooltips', async () => {
    const onCloudUpload = vi.fn();
    const onCloudSync = vi.fn();
    const getCloudUploadTooltip = vi.fn().mockResolvedValue('Upload latest folders');
    const getCloudSyncTooltip = vi.fn().mockResolvedValue('Sync from Drive');
    const handle = mountPanel({
      onCloudUpload,
      onCloudSync,
      getCloudUploadTooltip,
      getCloudSyncTooltip,
    });

    const uploadButton = requireElement<HTMLButtonElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__icon-button--cloud-upload`,
    );
    const syncButton = requireElement<HTMLButtonElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__icon-button--cloud-sync`,
    );

    click(uploadButton);
    click(syncButton);
    uploadButton.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    syncButton.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await Promise.resolve();

    expect(onCloudUpload).toHaveBeenCalledTimes(1);
    expect(onCloudSync).toHaveBeenCalledTimes(1);
    expect(getCloudUploadTooltip).toHaveBeenCalledTimes(1);
    expect(getCloudSyncTooltip).toHaveBeenCalledTimes(1);
    expect(uploadButton.title).toBe('Upload latest folders');
    expect(syncButton.title).toBe('Sync from Drive');
  });

  it('hides cloud buttons on Safari', () => {
    mockIsSafari.mockReturnValue(true);
    const handle = mountPanel({
      onCloudUpload: vi.fn(),
      onCloudSync: vi.fn(),
    });

    expect(
      handle.element.querySelector(`.${FLOATING_PANEL_CLASS}__icon-button--cloud-upload`),
    ).toBeNull();
    expect(
      handle.element.querySelector(`.${FLOATING_PANEL_CLASS}__icon-button--cloud-sync`),
    ).toBeNull();
  });

  it('applies a stored floating panel size on mount', () => {
    const handle = mountPanel({
      storedSize: { w: 500, h: 550 },
    });

    expect(handle.element.style.width).toBe('500px');
    expect(handle.element.style.height).toBe('550px');
  });

  it('clamps stored floating panel size to min and viewport max bounds', () => {
    setWindowSize(700, 500);

    const handle = mountPanel({
      storedSize: { w: 1000, h: 100 },
    });

    expect(handle.element.style.width).toBe('640px');
    expect(handle.element.style.height).toBe('320px');
  });

  it('ignores non-primary-button pointerdown on the header (no right/middle drags)', () => {
    const handle = mountPanel();
    const header = requireElement<HTMLElement>(handle.element, `.${FLOATING_PANEL_CLASS}__header`);
    stubPointerCapture(header);
    setElementRect(handle.element, 320, 420);
    const initialLeft = handle.element.style.left;
    const initialTop = handle.element.style.top;

    header.dispatchEvent(pointerEvent('pointerdown', { button: 2, clientX: 700, clientY: 330 }));
    header.dispatchEvent(pointerEvent('pointermove', { clientX: 500, clientY: 200 }));

    expect(handle.element.style.left).toBe(initialLeft);
    expect(handle.element.style.top).toBe(initialTop);
    expect(header.classList.contains(`${FLOATING_PANEL_CLASS}__header--dragging`)).toBe(false);

    // Sanity: a primary-button drag still moves the panel.
    header.dispatchEvent(pointerEvent('pointerdown', { button: 0, clientX: 700, clientY: 330 }));
    header.dispatchEvent(pointerEvent('pointermove', { clientX: 500, clientY: 200 }));

    expect(handle.element.style.left).not.toBe(initialLeft);
    header.dispatchEvent(pointerEvent('pointerup', { button: 0, clientX: 500, clientY: 200 }));
  });

  it('defers a background update while an inline form is focused, applying it on submit', () => {
    const handle = mountPanel();

    click(
      requireElement<HTMLButtonElement>(
        handle.element,
        `.${FLOATING_PANEL_CLASS}__icon-button--create`,
      ),
    );
    const input = requireElement<HTMLInputElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__inline-input`,
    );
    input.value = 'Half-typed name';
    input.focus();

    const next = createData();
    next.folders[0] = createFolder('folder-a', 'Alpha Renamed', null, 0);
    handle.update(next);

    // The form (and the user's typed value) must survive the background update.
    const inputAfter = requireElement<HTMLInputElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__inline-input`,
    );
    expect(inputAfter).toBe(input);
    expect(inputAfter.value).toBe('Half-typed name');
    expect(handle.element.textContent).toContain('Alpha');
    expect(handle.element.textContent).not.toContain('Alpha Renamed');

    // Closing the form applies the deferred data.
    keydown(input, 'Enter');
    expect(handle.element.textContent).toContain('Alpha Renamed');
  });

  it('rebuilds immediately when the folder being renamed was deleted by the update', () => {
    const handle = mountPanel();

    requireElement<HTMLElement>(
      folderHeader(handle.element, 'folder-a'),
      `.${FLOATING_PANEL_CLASS}__folder-name`,
    ).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const input = requireElement<HTMLInputElement>(
      handle.element,
      `.${FLOATING_PANEL_CLASS}__inline-input`,
    );
    input.focus();

    handle.update({
      folders: [createFolder('folder-b', 'Beta', null, 1)],
      folderContents: { 'folder-b': [] },
    });

    expect(handle.element.querySelector(`.${FLOATING_PANEL_CLASS}__inline-input`)).toBeNull();
    expect(handle.element.textContent).not.toContain('Alpha');
  });

  it.each(['create-root', 'create-child', 'rename'] as const)(
    'discards a focused %s draft and old rows on account reset while preserving panel geometry',
    (mode) => {
      const onCreateFolder = vi.fn();
      const onRenameFolder = vi.fn();
      const handle = mountPanel({
        onCreateFolder,
        onRenameFolder,
        storedPos: { x: 24, y: 32 },
        storedSize: { w: 400, h: 500 },
      });
      const geometry = handle.element.style.cssText;
      if (mode === 'rename') {
        requireElement<HTMLElement>(
          folderHeader(handle.element, 'folder-a'),
          `.${FLOATING_PANEL_CLASS}__folder-name`,
        ).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      } else {
        click(
          requireElement<HTMLButtonElement>(
            mode === 'create-root' ? handle.element : folderHeader(handle.element, 'folder-a'),
            `.${FLOATING_PANEL_CLASS}__icon-button--${mode === 'create-root' ? 'create' : 'add-child'}`,
          ),
        );
      }
      const input = requireElement<HTMLInputElement>(
        handle.element,
        `.${FLOATING_PANEL_CLASS}__inline-input`,
      );
      input.value = 'Account A private draft';
      input.focus();

      handle.reset({ folders: [], folderContents: {} });

      expect(handle.element.querySelector(`.${FLOATING_PANEL_CLASS}__inline-input`)).toBeNull();
      expect(handle.element.querySelector(`.${FLOATING_PANEL_CLASS}__folder`)).toBeNull();
      expect(handle.element.textContent).not.toContain('Conversation A');
      expect(handle.element.style.cssText).toBe(geometry);
      expect(onCreateFolder).not.toHaveBeenCalled();
      expect(onRenameFolder).not.toHaveBeenCalled();
      const outsideClick = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      document.body.dispatchEvent(outsideClick);
      expect(outsideClick.defaultPrevented).toBe(false);

      click(
        requireElement<HTMLButtonElement>(
          handle.element,
          `.${FLOATING_PANEL_CLASS}__icon-button--create`,
        ),
      );
      expect(
        requireElement<HTMLInputElement>(handle.element, `.${FLOATING_PANEL_CLASS}__inline-input`)
          .value,
      ).toBe('');
    },
  );

  it('clears the previous account menu and expansion when the next account reuses folder ids', () => {
    const handle = mountPanel();
    click(folderHeader(handle.element, 'folder-a'));
    contextMenu(folderHeader(handle.element, 'folder-a'));
    expect(handle.element.querySelector(`.${FLOATING_PANEL_CLASS}__context-menu`)).not.toBeNull();

    const next = createData();
    next.folders[0].name = 'Other account';
    next.folderContents['folder-a'] = [];
    handle.reset(next);

    expect(handle.element.querySelector(`.${FLOATING_PANEL_CLASS}__context-menu`)).toBeNull();
    expect(handle.element.textContent).toContain('Other account');
    expect(handle.element.textContent).not.toContain('Conversation A');
    expect(
      requireElement<HTMLElement>(
        folderHeader(handle.element, 'folder-a').parentElement!,
        `.${FLOATING_PANEL_CLASS}__folder-body`,
      ).style.display,
    ).not.toBe('none');
  });

  it('debounces onSizeChange and commits only the final observed size', () => {
    vi.useFakeTimers();
    const resizeObserver = installResizeObserverMock();
    const onSizeChange = vi.fn();
    const handle = mountPanel({ onSizeChange });

    setElementRect(handle.element, 410, 520);
    resizeObserver.emit();
    vi.advanceTimersByTime(100);

    setElementRect(handle.element, 430, 540);
    resizeObserver.emit();
    vi.advanceTimersByTime(299);
    expect(onSizeChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onSizeChange).toHaveBeenCalledTimes(1);
    expect(onSizeChange).toHaveBeenCalledWith({ w: 430, h: 540 });

    vi.useRealTimers();
  });
});
