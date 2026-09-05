import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AIStudioFolderManager, mutationAddsPromptLinks, parseDragDataPayload } from '../aistudio';

type DragDataTransferMock = {
  effectAllowed: string;
  setData: ReturnType<typeof vi.fn>;
  setDragImage: ReturnType<typeof vi.fn>;
};

function createPromptRow(
  promptId: string,
  title: string,
): {
  root: HTMLElement;
  row: HTMLElement;
  host: HTMLElement;
  anchor: HTMLAnchorElement;
} {
  const root = document.createElement('ms-prompt-history-v3');
  const row = document.createElement('div');
  row.setAttribute('data-test-id', `history-item-${promptId}`);
  const li = document.createElement('li');
  const anchor = document.createElement('a');
  anchor.className = 'prompt-link';
  anchor.setAttribute('href', `/prompts/${promptId}`);
  anchor.textContent = title;
  li.appendChild(anchor);
  row.appendChild(li);
  root.appendChild(row);
  document.body.appendChild(root);
  return { root, row, host: li, anchor };
}

function createHistoryPopoverPromptLink(
  promptId: string,
  title: string,
  href: string = `/prompts/${promptId}`,
): {
  overlay: HTMLElement;
  row: HTMLElement;
  anchor: HTMLAnchorElement;
} {
  const overlay = document.createElement('div');
  overlay.className = 'cdk-overlay-pane';
  const row = document.createElement('div');
  row.setAttribute('role', 'listitem');
  const anchor = document.createElement('a');
  anchor.setAttribute('href', href);
  anchor.textContent = title;
  row.appendChild(anchor);
  overlay.appendChild(row);
  document.body.appendChild(overlay);
  return { overlay, row, anchor };
}

function createLibraryPromptRow(
  promptId: string,
  title: string,
): {
  table: HTMLTableElement;
  row: HTMLTableRowElement;
  anchor: HTMLAnchorElement;
  moreButton: HTMLButtonElement;
} {
  let table = document.querySelector('table.mat-mdc-table') as HTMLTableElement | null;
  if (!table) {
    table = document.createElement('table');
    table.className = 'mat-mdc-table';
    document.body.appendChild(table);
  }

  const row = document.createElement('tr');
  row.className = 'mat-mdc-row';

  const nameCell = document.createElement('td');
  const anchor = document.createElement('a');
  anchor.className = 'name-link';
  anchor.setAttribute('href', `/prompts/${promptId}`);
  anchor.textContent = title;
  nameCell.appendChild(anchor);
  row.appendChild(nameCell);

  const actionCell = document.createElement('td');
  const moreButton = document.createElement('button');
  moreButton.setAttribute('aria-label', 'More options');
  moreButton.textContent = 'more_vert';
  actionCell.appendChild(moreButton);
  row.appendChild(actionCell);

  table.appendChild(row);
  return { table, row, anchor, moreButton };
}

type AIStudioManagerInternals = {
  data: {
    folders: Array<{
      id: string;
      name: string;
      parentId: string | null;
      isExpanded: boolean;
      createdAt: number;
      updatedAt: number;
    }>;
    folderContents: Record<
      string,
      Array<{
        conversationId: string;
        title: string;
        url: string;
        addedAt: number;
        customTitle?: boolean;
      }>
    >;
  };
  historyRoot: HTMLElement | null;
  dataSession: { ready: boolean };
  observePromptList: () => void;
  observeLibraryTable: () => void;
  bindDraggablesInLibraryTable: () => void;
  syncConversationTitlesFromPromptList: () => Promise<void>;
  save: () => Promise<boolean>;
  render: () => void;
};

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('AIStudio prompt binding performance guards', () => {
  it('detects prompt-link additions in mutations', () => {
    const wrapper = document.createElement('div');
    const promptAnchor = document.createElement('a');
    promptAnchor.className = 'prompt-link';
    promptAnchor.setAttribute('href', '/prompts/abc');
    wrapper.appendChild(promptAnchor);

    const hitMutation = {
      addedNodes: [wrapper],
    } as unknown as MutationRecord;
    const missMutation = {
      addedNodes: [document.createElement('span')],
    } as unknown as MutationRecord;

    expect(mutationAddsPromptLinks([hitMutation])).toBe(true);
    expect(mutationAddsPromptLinks([missMutation])).toBe(false);
  });

  it('detects body-level history popover prompt link additions', () => {
    const { overlay } = createHistoryPopoverPromptLink('hover123', 'Hover Prompt Title');

    const mutation = {
      addedNodes: [overlay],
    } as unknown as MutationRecord;

    expect(mutationAddsPromptLinks([mutation])).toBe(true);
  });

  it('detects absolute AI Studio prompt links in popovers', () => {
    const overlay = document.createElement('div');
    overlay.className = 'cdk-overlay-pane';
    const anchor = document.createElement('a');
    anchor.href = 'https://aistudio.google.com/prompts/absolute123';
    anchor.textContent = 'Absolute Prompt Title';
    overlay.appendChild(anchor);

    const mutation = {
      addedNodes: [overlay],
    } as unknown as MutationRecord;

    expect(mutationAddsPromptLinks([mutation])).toBe(true);
  });

  it('detects account-prefixed AI Studio prompt links in popovers', () => {
    const { overlay: relativeOverlay } = createHistoryPopoverPromptLink(
      'accountRelative123',
      'Account Relative Prompt',
      '/u/1/prompts/accountRelative123',
    );
    const absoluteOverlay = document.createElement('div');
    absoluteOverlay.className = 'cdk-overlay-pane';
    const absoluteAnchor = document.createElement('a');
    absoluteAnchor.href = 'https://aistudio.google.com/u/2/prompts/accountAbsolute123';
    absoluteAnchor.textContent = 'Account Absolute Prompt';
    absoluteOverlay.appendChild(absoluteAnchor);

    expect(
      mutationAddsPromptLinks([{ addedNodes: [relativeOverlay] } as unknown as MutationRecord]),
    ).toBe(true);
    expect(
      mutationAddsPromptLinks([{ addedNodes: [absoluteOverlay] } as unknown as MutationRecord]),
    ).toBe(true);
  });

  it('parses fallback URL payloads used by Firefox native drag data', () => {
    const fromUriList = parseDragDataPayload('https://aistudio.google.com/prompts/xyz987');
    expect(fromUriList?.conversationId).toBe('xyz987');

    const fromMozUrl = parseDragDataPayload(
      'https://aistudio.google.com/prompts/abc555\nPrompt title from firefox',
    );
    expect(fromMozUrl?.conversationId).toBe('abc555');
  });

  it('binds drag handler once per host and marks anchors as bound', () => {
    const { root, row, host, anchor } = createPromptRow('abc123', 'Prompt Title');
    const manager = new AIStudioFolderManager();
    const bindDraggablesInPromptList = (
      manager as unknown as {
        bindDraggablesInPromptList: (scope?: ParentNode | null) => void;
      }
    ).bindDraggablesInPromptList.bind(manager);

    bindDraggablesInPromptList(root);
    bindDraggablesInPromptList(root);

    expect(anchor.dataset.gvDragBound).toBe('1');
    expect(row.draggable).toBe(true);
    expect(host.draggable).toBe(false);

    const transfer: DragDataTransferMock = {
      effectAllowed: '',
      setData: vi.fn(),
      setDragImage: vi.fn(),
    };
    const dragstart = new Event('dragstart') as DragEvent;
    Object.defineProperty(dragstart, 'dataTransfer', {
      value: transfer,
      configurable: true,
    });

    row.dispatchEvent(dragstart);

    const calls = transfer.setData.mock.calls as Array<[string, string]>;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls).toEqual(
      expect.arrayContaining([
        ['application/json', expect.stringContaining('"conversationId":"abc123"')],
        ['text/plain', expect.stringContaining('"conversationId":"abc123"')],
      ]),
    );
  });

  it('uses aria-label/title fallback for drag payload titles when text is missing', () => {
    const { root, row, anchor } = createPromptRow('abc124', '');
    anchor.setAttribute('aria-label', 'Native prompt title');
    anchor.setAttribute('title', 'Backup title');

    const manager = new AIStudioFolderManager();
    const bindDraggablesInPromptList = (
      manager as unknown as {
        bindDraggablesInPromptList: (scope?: ParentNode | null) => void;
      }
    ).bindDraggablesInPromptList.bind(manager);

    bindDraggablesInPromptList(root);

    const transfer: DragDataTransferMock = {
      effectAllowed: '',
      setData: vi.fn(),
      setDragImage: vi.fn(),
    };
    const dragstart = new Event('dragstart') as DragEvent;
    Object.defineProperty(dragstart, 'dataTransfer', {
      value: transfer,
      configurable: true,
    });

    row.dispatchEvent(dragstart);

    const jsonPayload = (transfer.setData.mock.calls as Array<[string, string]>).find(
      ([type]) => type === 'application/json',
    )?.[1];
    expect(jsonPayload).toBeTruthy();
    expect(JSON.parse(jsonPayload || '{}')).toMatchObject({
      conversationId: 'abc124',
      title: 'Native prompt title',
    });
  });

  it('preserves titles when dragging from the body-level history popover', () => {
    const { row, anchor } = createHistoryPopoverPromptLink('hover456', 'Hover Prompt Title');
    const manager = new AIStudioFolderManager();
    const bindDraggablesInPromptList = (
      manager as unknown as {
        bindDraggablesInPromptList: (scope?: ParentNode | null) => void;
      }
    ).bindDraggablesInPromptList.bind(manager);

    bindDraggablesInPromptList(document.body);

    expect(anchor.dataset.gvDragBound).toBe('1');
    expect(row.draggable).toBe(true);

    const transfer: DragDataTransferMock = {
      effectAllowed: '',
      setData: vi.fn(),
      setDragImage: vi.fn(),
    };
    const dragstart = new Event('dragstart', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(dragstart, 'dataTransfer', {
      value: transfer,
      configurable: true,
    });

    anchor.dispatchEvent(dragstart);

    const jsonPayload = (transfer.setData.mock.calls as Array<[string, string]>).find(
      ([type]) => type === 'application/json',
    )?.[1];
    expect(jsonPayload).toBeTruthy();
    expect(JSON.parse(jsonPayload || '{}')).toMatchObject({
      conversationId: 'hover456',
      title: 'Hover Prompt Title',
      url: expect.stringMatching(/\/prompts\/hover456$/),
    });
  });

  it('preserves titles when dragging from account-prefixed history popovers', () => {
    const { row, anchor } = createHistoryPopoverPromptLink(
      'accountHover456',
      'Account Hover Prompt Title',
      '/u/1/prompts/accountHover456',
    );
    const manager = new AIStudioFolderManager();
    const bindDraggablesInPromptList = (
      manager as unknown as {
        bindDraggablesInPromptList: (scope?: ParentNode | null) => void;
      }
    ).bindDraggablesInPromptList.bind(manager);

    bindDraggablesInPromptList(document.body);

    expect(anchor.dataset.gvDragBound).toBe('1');
    expect(row.draggable).toBe(true);

    const transfer: DragDataTransferMock = {
      effectAllowed: '',
      setData: vi.fn(),
      setDragImage: vi.fn(),
    };
    const dragstart = new Event('dragstart', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(dragstart, 'dataTransfer', {
      value: transfer,
      configurable: true,
    });

    anchor.dispatchEvent(dragstart);

    const jsonPayload = (transfer.setData.mock.calls as Array<[string, string]>).find(
      ([type]) => type === 'application/json',
    )?.[1];
    expect(jsonPayload).toBeTruthy();
    expect(JSON.parse(jsonPayload || '{}')).toMatchObject({
      conversationId: 'accountHover456',
      title: 'Account Hover Prompt Title',
      url: expect.stringMatching(/\/u\/1\/prompts\/accountHover456$/),
    });
  });

  it('supports multi-select on AI Studio library rows', async () => {
    vi.useFakeTimers();
    const first = createLibraryPromptRow('library111', 'First Library Prompt');
    const second = createLibraryPromptRow('library222', 'Second Library Prompt');
    const manager = new AIStudioFolderManager();
    const internals = manager as unknown as AIStudioManagerInternals;

    internals.bindDraggablesInLibraryTable();

    first.row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await vi.advanceTimersByTimeAsync(500);

    expect(first.row.classList.contains('gv-library-row-selected')).toBe(true);
    expect(
      document.querySelector(
        '[data-multi-select-floating-host="true"] [data-selection-count="true"]',
      )?.textContent,
    ).toBe('1 selected');

    second.row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(second.row.classList.contains('gv-library-row-selected')).toBe(true);
    expect(
      document.querySelector(
        '[data-multi-select-floating-host="true"] [data-selection-count="true"]',
      )?.textContent,
    ).toBe('2 selected');
  });

  it('does not re-bind library rows when the floating multi-select host changes', async () => {
    createLibraryPromptRow('library333', 'Loop Guard Prompt');
    const manager = new AIStudioFolderManager();
    const internals = manager as unknown as AIStudioManagerInternals;
    const bindSpy = vi.fn();

    internals.bindDraggablesInLibraryTable = bindSpy;
    internals.observeLibraryTable();

    const floatingHost = document.createElement('div');
    floatingHost.dataset.multiSelectFloatingHost = 'true';
    document.body.appendChild(floatingHost);
    floatingHost.appendChild(document.createElement('button'));

    await Promise.resolve();

    expect(bindSpy).not.toHaveBeenCalled();
  });
});

describe('AIStudio theme compatibility', () => {
  it('uses body light/dark theme selectors for folder palette variables', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');

    expect(css).toContain('.theme-host.dark-theme,\nbody.dark-theme');
    expect(css).toContain('.theme-host.light-theme,\nbody.light-theme');
    expect(css).toContain('body.dark-theme .gv-folder-action-btn:hover');
  });

  it('renders cloud action icons with currentColor in AI Studio', () => {
    const code = readFileSync(
      resolve(process.cwd(), 'src/pages/content/folder/aistudio.ts'),
      'utf8',
    );

    expect(code).toContain('fill="currentColor"');
    expect(code).not.toContain('fill="#e3e3e3"');
  });
});

describe('AIStudio conversation title sync', () => {
  it('syncs stored conversation titles from native prompt links', async () => {
    createPromptRow('abc123', 'Renamed in AI Studio');
    const manager = new AIStudioFolderManager();
    const internals = manager as unknown as AIStudioManagerInternals;
    internals.dataSession.ready = true;

    internals.data = {
      folders: [],
      folderContents: {
        folderA: [
          {
            conversationId: 'abc123',
            title: 'Old title',
            url: '/prompts/abc123',
            addedAt: Date.now(),
          },
        ],
      },
    };

    const saveSpy = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const renderSpy = vi.fn<() => void>();
    internals.save = saveSpy;
    internals.render = renderSpy;

    await internals.syncConversationTitlesFromPromptList();

    expect(internals.data.folderContents.folderA[0]?.title).toBe('Renamed in AI Studio');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite custom titles during native sync', async () => {
    createPromptRow('abc999', 'Native New Name');
    const manager = new AIStudioFolderManager();
    const internals = manager as unknown as AIStudioManagerInternals;
    internals.dataSession.ready = true;

    internals.data = {
      folders: [],
      folderContents: {
        folderA: [
          {
            conversationId: 'abc999',
            title: 'Manually Renamed',
            url: '/prompts/abc999',
            addedAt: Date.now(),
            customTitle: true,
          },
        ],
      },
    };

    const saveSpy = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const renderSpy = vi.fn<() => void>();
    internals.save = saveSpy;
    internals.render = renderSpy;

    await internals.syncConversationTitlesFromPromptList();

    expect(internals.data.folderContents.folderA[0]?.title).toBe('Manually Renamed');
    expect(saveSpy).not.toHaveBeenCalled();
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('observes prompt title mutations and syncs with debounce', async () => {
    vi.useFakeTimers();
    const { root, anchor } = createPromptRow('debounce1', 'Before Rename');
    const manager = new AIStudioFolderManager();
    const internals = manager as unknown as AIStudioManagerInternals;
    internals.dataSession.ready = true;

    internals.data = {
      folders: [],
      folderContents: {
        folderA: [
          {
            conversationId: 'debounce1',
            title: 'Before Rename',
            url: '/prompts/debounce1',
            addedAt: Date.now(),
          },
        ],
      },
    };
    internals.historyRoot = root;

    const saveSpy = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const renderSpy = vi.fn<() => void>();
    internals.save = saveSpy;
    internals.render = renderSpy;

    internals.observePromptList();

    anchor.textContent = 'After Rename';
    await vi.advanceTimersByTimeAsync(350);

    expect(internals.data.folderContents.folderA[0]?.title).toBe('After Rename');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });
});
