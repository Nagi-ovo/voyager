import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';

import { createSidebarRuntimeHarness, mountSidebar, setLayout } from './sidebarRuntimeHarness';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
  },
}));
vi.mock('@/utils/i18n', () => ({
  getTranslationSyncUnsafe: (key: string) => key,
}));

describe('folder position enforcer (above Recents)', () => {
  let harness: ReturnType<typeof createSidebarRuntimeHarness>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    harness = createSidebarRuntimeHarness();
  });

  afterEach(() => {
    harness.runtime.stop();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('no-ops when the folder container is already directly before Recents', async () => {
    const { sectionParent, recentsSection } = mountSidebar();
    await harness.runtime.start('sidebar');
    const insert = vi.spyOn(sectionParent, 'insertBefore');
    await vi.advanceTimersByTimeAsync(4000);
    expect(insert).not.toHaveBeenCalled();
    expect(harness.runtime.panel?.nextElementSibling).toBe(recentsSection);
  });

  it('re-anchors the folder container above Recents when Gemini swaps the section element', async () => {
    const { sectionParent, recentsSection } = mountSidebar();
    await harness.runtime.start('sidebar');
    const panel = harness.runtime.panel!;
    const replacement = recentsSection.cloneNode(false);
    sectionParent.insertBefore(replacement, panel);
    recentsSection.remove();
    expect(replacement.nextSibling).toBe(panel);
    await vi.advanceTimersByTimeAsync(20);
    expect(panel.nextSibling).toBe(replacement);
  });

  it('moves the folder container when it was stranded below Recents', async () => {
    const { sectionParent, recentsSection } = mountSidebar();
    await harness.runtime.start('sidebar');
    const panel = harness.runtime.panel!;
    sectionParent.appendChild(panel);
    await vi.advanceTimersByTimeAsync(20);
    expect(panel.nextElementSibling).toBe(recentsSection);
  });

  it('stops enforcing placement when the folder feature is disabled', async () => {
    const { sectionParent } = mountSidebar();
    await harness.runtime.start('sidebar');
    const panel = harness.runtime.panel!;
    harness.runtime.stop();
    sectionParent.appendChild(panel);
    harness.runtime.setAnchor('above-notebooks');
    await vi.advanceTimersByTimeAsync(4000);
    expect(panel.nextElementSibling).toBeNull();
    expect(harness.runtime.panel).toBeNull();
  });

  it('leaves sidebar placement alone in explicit floating mode', async () => {
    mountSidebar();
    await harness.runtime.start('floating', false);
    await vi.advanceTimersByTimeAsync(12000);
    expect(harness.runtime.panel).toBeNull();
    expect(document.querySelector('.gv-folders-anchor-toggle')).toBeNull();
    expect(harness.floating.open).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('anchors above Notebooks when folderAnchor is set to "above-notebooks"', async () => {
    const { notebooksSection } = mountSidebar();
    await harness.runtime.start('sidebar');
    harness.runtime.setAnchor('above-notebooks');
    expect(harness.runtime.panel?.nextElementSibling).toBe(notebooksSection);
  });

  it('falls back to Recents anchor when "above-notebooks" is requested but Notebooks is absent', async () => {
    const { notebooksSection, recentsSection } = mountSidebar();
    notebooksSection.remove();
    harness.runtime.setAnchor('above-notebooks');
    await harness.runtime.start('sidebar');
    expect(harness.runtime.panel?.nextElementSibling).toBe(recentsSection);
  });

  it('mounts the Notebooks corner toggle and persists a click without toggling Gemini', async () => {
    const { notebooksSection } = mountSidebar();
    const nativeClick = vi.fn();
    notebooksSection.addEventListener('click', nativeClick);
    await harness.runtime.start('sidebar');
    const button = notebooksSection.querySelector<HTMLElement>('.gv-folders-anchor-toggle')!;
    expect(button.getAttribute('aria-label')).toBe('folder_anchor_move_above_notebooks');
    button.click();
    expect(harness.runtime.panel?.nextElementSibling).toBe(notebooksSection);
    expect(button.getAttribute('aria-label')).toBe('folder_anchor_move_above_recents');
    expect(nativeClick).not.toHaveBeenCalled();
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      [StorageKeys.FOLDERS_ANCHOR]: 'above-notebooks',
    });
  });

  it('re-attaches the Notebooks corner toggle when Gemini replaces the section element', async () => {
    const { sectionParent, notebooksSection } = mountSidebar();
    await harness.runtime.start('sidebar');
    const replacement = notebooksSection.cloneNode(false) as HTMLElement;
    sectionParent.insertBefore(replacement, harness.runtime.panel);
    notebooksSection.remove();
    await vi.advanceTimersByTimeAsync(20);
    expect(replacement.querySelectorAll('.gv-folders-anchor-toggle')).toHaveLength(1);
    expect(document.querySelectorAll('.gv-folders-anchor-toggle')).toHaveLength(1);
  });

  it('removes the Notebooks toggle and host class on full stop', async () => {
    const { notebooksSection } = mountSidebar();
    await harness.runtime.start('sidebar');
    expect(notebooksSection.classList.contains('gv-folders-anchor-host')).toBe(true);
    harness.runtime.stop();
    expect(notebooksSection.querySelector('.gv-folders-anchor-toggle')).toBeNull();
    expect(notebooksSection.classList.contains('gv-folders-anchor-host')).toBe(false);
  });

  it('keeps nested Recents changes from moving the folder panel', async () => {
    const { sectionParent, recentsSection } = mountSidebar();
    await harness.runtime.start('sidebar');
    const insert = vi.spyOn(sectionParent, 'insertBefore');
    for (let index = 0; index < 20; index++)
      recentsSection.appendChild(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(20);
    expect(insert).not.toHaveBeenCalled();
    expect(harness.runtime.panel?.nextElementSibling).toBe(recentsSection);
  });

  it('reinitializes when resize leaves the folder in a hidden old sidebar', async () => {
    const previous = mountSidebar();
    await harness.runtime.start('sidebar');
    const previousPanel = harness.runtime.panel!;
    setLayout(previous.sidebar, 0, 0);
    const current = mountSidebar();
    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(800);
    expect(harness.runtime.sidebar).toBe(current.sidebar);
    expect(harness.runtime.panel?.nextElementSibling).toBe(current.recentsSection);
    expect(previousPanel.isConnected).toBe(false);
  });

  it('waits before opening the floating fallback when a visible sidebar anchor is temporarily missing', async () => {
    mountSidebar().recentsSection.remove();
    await harness.runtime.start('sidebar');
    await vi.advanceTimersByTimeAsync(7999);
    expect(harness.floating.open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.floating.open).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('waits before opening the floating fallback when the whole sidebar is temporarily missing', async () => {
    const initial = harness.runtime.start('sidebar');
    await vi.advanceTimersByTimeAsync(7999);
    expect(harness.floating.open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.floating.open).toHaveBeenCalledExactlyOnceWith(true);
    harness.runtime.stop();
    await initial;
  });

  it('does not leave a FAB or immediately reopen after closing an automatic fallback', async () => {
    mountSidebar().recentsSection.remove();
    await harness.runtime.start('sidebar');
    await vi.advanceTimersByTimeAsync(8000);
    harness.closeFloatingPanel();
    await vi.advanceTimersByTimeAsync(8000);
    expect(harness.hasFab()).toBe(false);
    expect(harness.runtime.isFallbackActive).toBe(true);
    expect(harness.floating.open).toHaveBeenCalledTimes(1);
  });

  it('clears every floating fallback entry point when the sidebar recovers', async () => {
    const initial = harness.runtime.start('sidebar');
    await vi.advanceTimersByTimeAsync(8000);
    expect(harness.floating.open).toHaveBeenCalledTimes(1);
    const { recentsSection } = mountSidebar();
    await vi.advanceTimersByTimeAsync(2000);
    await initial;
    expect(harness.runtime.panel?.nextElementSibling).toBe(recentsSection);
    expect(harness.floating.close).toHaveBeenCalledTimes(1);
    expect(harness.hasFab()).toBe(false);
    expect(harness.runtime.isFallbackActive).toBe(false);
  });

  it('keeps the DOM-recovery watchers armed across a reinit teardown', async () => {
    const { sectionParent, recentsSection } = mountSidebar();
    await harness.runtime.start('sidebar');
    recentsSection.remove();
    await harness.runtime.remount();
    expect(harness.runtime.panel).toBeNull();
    sectionParent.appendChild(recentsSection);
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.runtime.panel?.nextElementSibling).toBe(recentsSection);
    expect(harness.onPanelMount).toHaveBeenCalledTimes(2);
  });

  it('injects native menu actions while initial sidebar discovery is pending and after it times out', async () => {
    const initial = harness.runtime.start('sidebar');
    const appendMenu = () => {
      const menu = document.createElement('gem-menu');
      menu.innerHTML = '<gem-menu-item data-test-id="rename-button">Rename</gem-menu-item>';
      document.body.appendChild(menu);
      return menu;
    };
    const firstMenu = appendMenu();
    await vi.advanceTimersByTimeAsync(100);
    expect(firstMenu.querySelector('.gv-move-to-folder-btn')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10000);
    await initial;
    firstMenu.remove();
    const secondMenu = appendMenu();
    await vi.advanceTimersByTimeAsync(100);
    expect(secondMenu.querySelector('.gv-move-to-folder-btn')).not.toBeNull();
    expect(harness.runtime.panel).toBeNull();
  });

  it('does not strand a duplicate container when the sidebar is remounted twice', async () => {
    mountSidebar();
    await harness.runtime.start('sidebar');
    const first = harness.runtime.panel!;
    await harness.runtime.remount();
    expect(document.querySelectorAll('.gv-folder-container')).toHaveLength(1);
    expect(first.isConnected).toBe(false);
    expect(harness.runtime.panel?.isConnected).toBe(true);
  });

  it('removes an untracked folder clone before recovery mounts a replacement', async () => {
    const { sectionParent, recentsSection } = mountSidebar();
    await harness.runtime.start('sidebar');
    const tracked = harness.runtime.panel!;
    const clone = tracked.cloneNode(true) as HTMLElement;
    const aistudio = document.createElement('div');
    aistudio.className = 'gv-folder-container gv-aistudio';
    const floatingSelection = document.createElement('div');
    floatingSelection.className = 'gv-folder-container gv-multi-select-floating-host';
    sectionParent.insertBefore(clone, recentsSection);
    sectionParent.append(aistudio, floatingSelection);
    await harness.runtime.remount();
    expect(tracked.isConnected).toBe(false);
    expect(clone.isConnected).toBe(false);
    expect(aistudio.isConnected).toBe(true);
    expect(floatingSelection.isConnected).toBe(true);
    expect(harness.runtime.panel?.nextElementSibling).toBe(recentsSection);
  });

  it('mounts the complete panel only after a late anchor is available', async () => {
    const { sectionParent, recentsSection, sidebar } = mountSidebar();
    recentsSection.remove();
    await harness.runtime.start('sidebar');
    expect(harness.createPanel).not.toHaveBeenCalled();
    sectionParent.appendChild(recentsSection);
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.onPanelMount).toHaveBeenCalledExactlyOnceWith(harness.runtime.panel, sidebar);
    expect(harness.runtime.panel?.nextElementSibling).toBe(recentsSection);
  });

  it('uses the persisted anchor on the initial mount', async () => {
    const { notebooksSection } = mountSidebar();
    vi.mocked(browser.storage.local.get).mockResolvedValueOnce({
      [StorageKeys.FOLDERS_ANCHOR]: 'above-notebooks',
    });
    await harness.runtime.loadAnchor();
    await harness.runtime.start('sidebar');
    expect(harness.runtime.panel?.nextElementSibling).toBe(notebooksSection);
  });
});
