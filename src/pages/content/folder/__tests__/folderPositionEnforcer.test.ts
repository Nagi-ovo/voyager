import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { FolderManager } from '../manager';

const { mountFloatingFabMock, mountFloatingPanelMock, unmountFloatingFabMock } = vi.hoisted(() => ({
  mountFloatingFabMock: vi.fn(),
  mountFloatingPanelMock: vi.fn(() => ({
    destroy: vi.fn(),
    update: vi.fn(),
  })),
  unmountFloatingFabMock: vi.fn(),
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      sync: {
        get: vi.fn(),
        set: vi.fn(),
      },
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    runtime: {
      id: 'test-extension-id',
      lastError: null,
    },
  },
}));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

vi.mock('../floatingPanel', () => ({
  mountFloatingPanel: mountFloatingPanelMock,
}));

vi.mock('../floatingModeFab', () => ({
  mountFloatingFab: mountFloatingFabMock,
  unmountFloatingFab: unmountFloatingFabMock,
}));

type TestableManager = {
  containerElement: HTMLElement | null;
  sidebarContainer: HTMLElement | null;
  recentSection: HTMLElement | null;
  folderEnabled: boolean;
  floatingModeActive: boolean;
  floatingFallbackActive: boolean;
  folderAnchor: 'above-recents' | 'above-notebooks';
  notebooksAnchorButton: HTMLElement | null;
  enforceFolderAboveRecents: () => boolean;
  setupPositionEnforcer: () => void;
  runFolderRecoveryTick: () => Promise<void>;
  reinitializeFolderUI: () => void;
  initializeFolderUI: () => Promise<void>;
  waitForSidebar: () => Promise<boolean>;
  ensureDomRecoveryWatchers: () => void;
  teardownDomRecoveryWatchers: () => void;
  runCleanupTasks: () => void;
  folderRecoveryTimer: number | null;
  domRecoveryHandler: (() => void) | null;
  findCurrentSidebarContainer: () => HTMLElement | null;
  ensureNotebooksAnchorButton: () => void;
  cleanupNotebooksAnchorButton: () => void;
  findRecentSection: () => boolean;
  findFolderAnchorCandidate: () => HTMLElement | null;
};

/**
 * Build Gemini's 2026 sidebar layout: an overflow-container holding the
 * Notebooks expandable-section followed by the Recents expandable-section.
 * Returns both sections so tests can simulate re-renders.
 */
function mountSidebar(): {
  sidebar: HTMLElement;
  sectionParent: HTMLElement;
  notebooksSection: HTMLElement;
  recentsSection: HTMLElement;
} {
  const sidebar = document.createElement('div');
  sidebar.setAttribute('data-test-id', 'overflow-container');

  const sectionParent = document.createElement('div');
  sectionParent.className = 'sections';
  sidebar.appendChild(sectionParent);

  const notebooksSection = document.createElement('expandable-section');
  notebooksSection.setAttribute('data-test-id', 'notebooks-expandable-section');
  sectionParent.appendChild(notebooksSection);

  const recentsSection = document.createElement('expandable-section');
  recentsSection.setAttribute('data-test-id', 'chats-expandable-section');
  sectionParent.appendChild(recentsSection);

  document.body.appendChild(sidebar);
  return { sidebar, sectionParent, notebooksSection, recentsSection };
}

function mountFolderContainer(parent: HTMLElement, beforeRecents: HTMLElement): HTMLElement {
  const container = document.createElement('div');
  container.className = 'gv-folder-container';
  parent.insertBefore(container, beforeRecents);
  return container;
}

function mockRect(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }),
  });
}

describe('folder position enforcer (above Recents)', () => {
  let manager: FolderManager | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(browser.storage.sync.get).mockResolvedValue({});
    vi.mocked(browser.storage.sync.set).mockResolvedValue(undefined);
  });

  afterEach(() => {
    manager?.destroy();
    manager = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('no-ops when the folder container is already directly before Recents', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    const { sidebar, sectionParent, recentsSection } = mountSidebar();
    const container = mountFolderContainer(sectionParent, recentsSection);

    typed.sidebarContainer = sidebar;
    typed.recentSection = recentsSection;
    typed.containerElement = container;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;

    const moved = typed.enforceFolderAboveRecents();

    expect(moved).toBe(false);
    expect(container.nextElementSibling).toBe(recentsSection);
  });

  it('re-anchors the folder container above Recents when Gemini swaps the section element', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    const { sidebar, sectionParent, recentsSection } = mountSidebar();
    const container = mountFolderContainer(sectionParent, recentsSection);

    typed.sidebarContainer = sidebar;
    typed.recentSection = recentsSection;
    typed.containerElement = container;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;

    // Simulate Gemini re-rendering Recents: remove the old section and insert
    // a brand-new one BEFORE the folder container (where Gemini's render
    // pipeline tends to drop the freshly-built section), stranding the folder
    // container below.
    recentsSection.remove();
    const newRecents = document.createElement('expandable-section');
    newRecents.setAttribute('data-test-id', 'chats-expandable-section');
    sectionParent.insertBefore(newRecents, container);

    // Sanity: container is now below the new Recents (matches the bug
    // screenshot).
    expect(newRecents.nextElementSibling).toBe(container);

    const moved = typed.enforceFolderAboveRecents();

    expect(moved).toBe(true);
    expect(container.nextElementSibling).toBe(newRecents);
    expect(typed.recentSection).toBe(newRecents);
  });

  it('moves the folder container when it was stranded below Recents', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    const { sidebar, sectionParent, recentsSection } = mountSidebar();
    // Insert the container AFTER Recents to simulate the bug screenshot
    // (Folders rendered below Recents).
    const container = document.createElement('div');
    container.className = 'gv-folder-container';
    sectionParent.appendChild(container);

    typed.sidebarContainer = sidebar;
    typed.recentSection = recentsSection;
    typed.containerElement = container;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;

    const moved = typed.enforceFolderAboveRecents();

    expect(moved).toBe(true);
    expect(container.nextElementSibling).toBe(recentsSection);
  });

  it('skips enforcement when folder feature is disabled', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    const { sidebar, sectionParent, recentsSection } = mountSidebar();
    const container = document.createElement('div');
    container.className = 'gv-folder-container';
    sectionParent.appendChild(container);

    typed.sidebarContainer = sidebar;
    typed.recentSection = recentsSection;
    typed.containerElement = container;
    typed.folderEnabled = false;
    typed.floatingModeActive = false;

    const moved = typed.enforceFolderAboveRecents();

    expect(moved).toBe(false);
    // Untouched
    expect(container.nextElementSibling).toBeNull();
  });

  it('skips enforcement in floating mode', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    const { sidebar, sectionParent, recentsSection } = mountSidebar();
    const container = document.createElement('div');
    container.className = 'gv-folder-container';
    sectionParent.appendChild(container);

    typed.sidebarContainer = sidebar;
    typed.recentSection = recentsSection;
    typed.containerElement = container;
    typed.folderEnabled = true;
    typed.floatingModeActive = true;

    const moved = typed.enforceFolderAboveRecents();

    expect(moved).toBe(false);
    expect(container.nextElementSibling).toBeNull();
  });

  it('anchors above Notebooks when folderAnchor is set to "above-notebooks"', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    const { sidebar, sectionParent, notebooksSection, recentsSection } = mountSidebar();

    // Folder container starts above Recents (default state).
    const container = mountFolderContainer(sectionParent, recentsSection);

    typed.sidebarContainer = sidebar;
    typed.recentSection = recentsSection;
    typed.containerElement = container;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;

    // Flip the anchor preference: enforcer should move the container above the
    // Notebooks section instead.
    typed.folderAnchor = 'above-notebooks';
    const moved = typed.enforceFolderAboveRecents();

    expect(moved).toBe(true);
    expect(container.nextElementSibling).toBe(notebooksSection);
    // recentSection field now mirrors the active anchor element.
    expect(typed.recentSection).toBe(notebooksSection);
  });

  it('falls back to Recents anchor when "above-notebooks" is requested but Notebooks is absent', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    const sidebar = document.createElement('div');
    sidebar.setAttribute('data-test-id', 'overflow-container');
    const sectionParent = document.createElement('div');
    sidebar.appendChild(sectionParent);
    const recentsSection = document.createElement('expandable-section');
    recentsSection.setAttribute('data-test-id', 'chats-expandable-section');
    sectionParent.appendChild(recentsSection);
    document.body.appendChild(sidebar);

    const container = document.createElement('div');
    container.className = 'gv-folder-container';
    sectionParent.appendChild(container); // Below Recents — wrong position.

    typed.sidebarContainer = sidebar;
    typed.recentSection = recentsSection;
    typed.containerElement = container;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;
    typed.folderAnchor = 'above-notebooks'; // requested, but no Notebooks present

    const moved = typed.enforceFolderAboveRecents();

    expect(moved).toBe(true);
    expect(container.nextElementSibling).toBe(recentsSection);
  });

  it('mounts the Notebooks corner swap toggle when ensureNotebooksAnchorButton runs', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    const { sidebar, sectionParent, notebooksSection, recentsSection } = mountSidebar();
    const container = mountFolderContainer(sectionParent, recentsSection);

    typed.sidebarContainer = sidebar;
    typed.recentSection = recentsSection;
    typed.containerElement = container;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;

    typed.ensureNotebooksAnchorButton();

    const btn = notebooksSection.querySelector('.gv-folders-anchor-toggle');
    expect(btn).not.toBeNull();
    expect(notebooksSection.classList.contains('gv-folders-anchor-host')).toBe(true);
    // Default anchor is above-recents → tooltip should describe "move above
    // notebooks" (the click action, not the current state).
    expect(btn?.getAttribute('aria-label')).toBe('folder_anchor_move_above_notebooks');
  });

  it('re-attaches the Notebooks corner toggle when Gemini replaces the section element', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    const { sidebar, sectionParent, notebooksSection, recentsSection } = mountSidebar();
    const container = mountFolderContainer(sectionParent, recentsSection);

    typed.sidebarContainer = sidebar;
    typed.recentSection = recentsSection;
    typed.containerElement = container;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;

    typed.ensureNotebooksAnchorButton();
    const firstBtn = notebooksSection.querySelector('.gv-folders-anchor-toggle');
    expect(firstBtn).not.toBeNull();

    // Swap the Notebooks section element for a new one.
    notebooksSection.remove();
    const newNotebooks = document.createElement('expandable-section');
    newNotebooks.setAttribute('data-test-id', 'notebooks-expandable-section');
    sectionParent.insertBefore(newNotebooks, container);

    typed.ensureNotebooksAnchorButton();

    expect(newNotebooks.querySelector('.gv-folders-anchor-toggle')).not.toBeNull();
    // The old button (still detached) is no longer the tracked one.
    expect(typed.notebooksAnchorButton?.parentElement).toBe(newNotebooks);
  });

  it('cleanupNotebooksAnchorButton removes the button and host class', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    const { sidebar, sectionParent, notebooksSection, recentsSection } = mountSidebar();
    const container = mountFolderContainer(sectionParent, recentsSection);

    typed.sidebarContainer = sidebar;
    typed.recentSection = recentsSection;
    typed.containerElement = container;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;
    typed.ensureNotebooksAnchorButton();
    expect(notebooksSection.querySelector('.gv-folders-anchor-toggle')).not.toBeNull();

    typed.cleanupNotebooksAnchorButton();

    expect(notebooksSection.querySelector('.gv-folders-anchor-toggle')).toBeNull();
    expect(notebooksSection.classList.contains('gv-folders-anchor-host')).toBe(false);
    expect(typed.notebooksAnchorButton).toBeNull();
  });

  it('observer reacts to childList mutations and re-anchors within an animation frame', async () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    const { sidebar, sectionParent, recentsSection } = mountSidebar();
    const container = mountFolderContainer(sectionParent, recentsSection);

    typed.sidebarContainer = sidebar;
    typed.recentSection = recentsSection;
    typed.containerElement = container;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;

    typed.setupPositionEnforcer();

    // Simulate Gemini swapping the Recents section so the container ends up
    // below it.
    recentsSection.remove();
    const newRecents = document.createElement('expandable-section');
    newRecents.setAttribute('data-test-id', 'chats-expandable-section');
    sectionParent.insertBefore(newRecents, container);

    expect(newRecents.nextElementSibling).toBe(container);

    // MutationObserver callbacks are async — wait two animation frames so the
    // rAF-batched enforcer runs.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(container.nextElementSibling).toBe(newRecents);
    expect(typed.recentSection).toBe(newRecents);
  });

  it('reinitializes when resize leaves the folder in a hidden old sidebar', async () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    const oldLayout = mountSidebar();
    const container = mountFolderContainer(oldLayout.sectionParent, oldLayout.recentsSection);
    mockRect(oldLayout.sidebar, 0, 0);

    const newLayout = mountSidebar();
    mockRect(newLayout.sidebar, 280, 800);

    typed.sidebarContainer = oldLayout.sidebar;
    typed.recentSection = oldLayout.recentsSection;
    typed.containerElement = container;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;

    const reinitializeSpy = vi.spyOn(typed, 'reinitializeFolderUI').mockImplementation(() => {});

    await typed.runFolderRecoveryTick();

    expect(typed.findCurrentSidebarContainer()).toBe(newLayout.sidebar);
    expect(reinitializeSpy).toHaveBeenCalledTimes(1);
  });

  it('waits before opening the floating fallback when a visible sidebar anchor is temporarily missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T00:00:00.000Z'));

    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    const sidebar = document.createElement('div');
    sidebar.setAttribute('data-test-id', 'overflow-container');
    document.body.appendChild(sidebar);
    mockRect(sidebar, 280, 800);

    typed.folderEnabled = true;
    typed.floatingModeActive = false;

    await typed.runFolderRecoveryTick();

    expect(mountFloatingPanelMock).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-06-12T00:00:06.001Z'));
    await typed.runFolderRecoveryTick();

    expect(mountFloatingPanelMock).toHaveBeenCalledTimes(1);
  });

  it('waits before opening the floating fallback when the whole sidebar is temporarily missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T00:00:00.000Z'));

    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;

    await typed.runFolderRecoveryTick();
    expect(mountFloatingPanelMock).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-06-12T00:00:06.001Z'));
    await typed.runFolderRecoveryTick();

    expect(mountFloatingPanelMock).toHaveBeenCalledTimes(1);
  });

  it('does not leave a FAB or immediately reopen after closing an automatic fallback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T00:00:00.000Z'));

    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;

    await typed.runFolderRecoveryTick();
    vi.setSystemTime(new Date('2026-06-12T00:00:06.001Z'));
    await typed.runFolderRecoveryTick();

    const calls = mountFloatingPanelMock.mock.calls as unknown as Array<[{ onClose?: () => void }]>;
    const panelArgs = calls[0]?.[0];
    panelArgs?.onClose?.();

    expect(mountFloatingFabMock).not.toHaveBeenCalled();
    expect(typed.floatingFallbackActive).toBe(true);

    await typed.runFolderRecoveryTick();
    expect(mountFloatingPanelMock).toHaveBeenCalledTimes(1);
  });

  it('clears every floating fallback entry point when the sidebar recovers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T00:00:00.000Z'));

    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;

    await typed.runFolderRecoveryTick();
    vi.setSystemTime(new Date('2026-06-12T00:00:06.001Z'));
    await typed.runFolderRecoveryTick();

    const panelHandle = mountFloatingPanelMock.mock.results[0]?.value;
    const { sidebar, sectionParent, recentsSection } = mountSidebar();
    const container = mountFolderContainer(sectionParent, recentsSection);
    mockRect(sidebar, 280, 800);
    typed.sidebarContainer = sidebar;
    typed.recentSection = recentsSection;
    typed.containerElement = container;

    await typed.runFolderRecoveryTick();

    expect(panelHandle.destroy).toHaveBeenCalledTimes(1);
    expect(unmountFloatingFabMock).toHaveBeenCalled();
    expect(typed.floatingFallbackActive).toBe(false);
  });

  // Regression: dragging the window across Gemini's mobile breakpoint strips the
  // folder and fires a recovery reinit. `reinitializeFolderUI` runs
  // `runCleanupTasks()` BEFORE re-running `initializeFolderUI`; if that init bails
  // mid-transition (chats anchor not present yet), the self-heal watchers must NOT
  // have been torn down, or the folder stays gone until a full page reload and
  // widening the window never re-triggers recovery. The watchers are therefore
  // lifetime-scoped (not cleanup tasks) and survive `runCleanupTasks()`.
  it('keeps the DOM-recovery watchers armed across a reinit teardown', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    typed.ensureDomRecoveryWatchers();

    // The resize listener and the 2s watchdog interval are now armed.
    expect(typed.folderRecoveryTimer).not.toBeNull();
    expect(typed.domRecoveryHandler).not.toBeNull();
    const armedHandler = typed.domRecoveryHandler;
    expect(addSpy).toHaveBeenCalledWith('resize', armedHandler);

    // `reinitializeFolderUI` runs this first. The watchers must survive it.
    typed.runCleanupTasks();

    expect(typed.folderRecoveryTimer).not.toBeNull();
    expect(typed.domRecoveryHandler).toBe(armedHandler);
    expect(removeSpy).not.toHaveBeenCalledWith('resize', armedHandler);

    // Idempotent: a second arm (e.g. the top of a re-run init) is a no-op and
    // never stacks a duplicate resize listener.
    addSpy.mockClear();
    typed.ensureDomRecoveryWatchers();
    expect(addSpy).not.toHaveBeenCalledWith('resize', expect.anything());

    // Full teardown actually removes them.
    typed.teardownDomRecoveryWatchers();
    expect(typed.folderRecoveryTimer).toBeNull();
    expect(typed.domRecoveryHandler).toBeNull();
    expect(removeSpy).toHaveBeenCalledWith('resize', armedHandler);
  });

  it('injects native menu actions while initial sidebar discovery is pending and after it times out', async () => {
    vi.useFakeTimers();
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    let finishSidebarWait!: (found: boolean) => void;
    vi.spyOn(typed, 'waitForSidebar').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSidebarWait = resolve;
        }),
    );
    const initialization = typed.initializeFolderUI();
    const menu = document.createElement('gem-menu');
    menu.innerHTML = '<gem-menu-item data-test-id="rename-button">Rename</gem-menu-item>';
    const nextMenu = menu.cloneNode(true) as HTMLElement;
    document.body.appendChild(menu);
    await vi.advanceTimersByTimeAsync(100);

    expect(document.querySelector('[data-test-id="overflow-container"]')).toBeNull();
    expect(menu.querySelector('.gv-move-to-folder-btn')).not.toBeNull();

    finishSidebarWait(false);
    await initialization;
    menu.remove();
    document.body.appendChild(nextMenu);
    await vi.advanceTimersByTimeAsync(100);

    expect(document.querySelector('.gv-folder-container')).toBeNull();
    expect(nextMenu.querySelector('.gv-move-to-folder-btn')).not.toBeNull();
  });

  // Regression: recovery-driven reinit can call `createFolderUI` while an older
  // container still exists. Drop the old one first so we never strand a
  // duplicate folder in the sidebar.
  it('does not strand a duplicate container when createFolderUI runs twice', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager &
      Record<'createFolderUI', () => void> & { data: unknown };

    const { sidebar, sectionParent, recentsSection } = mountSidebar();
    typed.sidebarContainer = sidebar;
    typed.recentSection = recentsSection;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;

    typed.createFolderUI();
    const first = typed.containerElement;
    expect(first).not.toBeNull();
    expect(sectionParent.querySelectorAll('.gv-folder-container')).toHaveLength(1);

    // Second call (for example, a recovery reinit) must replace, not duplicate.
    typed.createFolderUI();
    expect(sectionParent.querySelectorAll('.gv-folder-container')).toHaveLength(1);
    expect(first?.isConnected).toBe(false);
    expect(typed.containerElement?.isConnected).toBe(true);
  });

  it('removes an untracked folder clone before recovery mounts a replacement', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager &
      Record<'createFolderUI', () => void> & { data: unknown };

    const { sidebar, sectionParent, recentsSection } = mountSidebar();
    typed.sidebarContainer = sidebar;
    typed.recentSection = recentsSection;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;

    typed.createFolderUI();
    const tracked = typed.containerElement;
    const untrackedClone = tracked?.cloneNode(true) as HTMLElement;
    sectionParent.insertBefore(untrackedClone, recentsSection);
    expect(sectionParent.querySelectorAll('.gv-folder-container')).toHaveLength(2);

    // Gemini can clone the sidebar subtree without updating our tracked node.
    // Recovery must remove both the tracked original and the orphaned clone.
    typed.createFolderUI();
    expect(sectionParent.querySelectorAll('.gv-folder-container')).toHaveLength(1);
    expect(tracked?.isConnected).toBe(false);
    expect(untrackedClone.isConnected).toBe(false);
    expect(typed.containerElement?.isConnected).toBe(true);
  });

  it('does not partially mount from findRecentSection when the anchor appears late', async () => {
    vi.useFakeTimers();

    manager = new FolderManager();
    const typed = manager as unknown as TestableManager & Record<'createFolderUI', () => void>;

    const sidebar = document.createElement('div');
    sidebar.setAttribute('data-test-id', 'overflow-container');
    document.body.appendChild(sidebar);

    typed.sidebarContainer = sidebar;
    typed.folderEnabled = true;
    typed.floatingModeActive = false;

    const createSpy = vi.spyOn(typed, 'createFolderUI');

    expect(typed.findRecentSection()).toBe(false);

    const recentsSection = document.createElement('expandable-section');
    recentsSection.setAttribute('data-test-id', 'chats-expandable-section');
    sidebar.appendChild(recentsSection);

    await vi.advanceTimersByTimeAsync(2500);

    expect(createSpy).not.toHaveBeenCalled();
    expect(typed.containerElement).toBeNull();
  });
});
