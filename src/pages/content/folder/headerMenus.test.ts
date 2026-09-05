import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';

import { type FolderHeaderMenus, createFolderHeaderMenus } from './headerMenus';

vi.mock('webextension-polyfill', () => ({
  default: { storage: { sync: { get: vi.fn(), set: vi.fn() } } },
}));

vi.mock('@/utils/i18n', () => ({
  getTranslationSyncUnsafe: (key: string) => key,
}));

function openingClick(): MouseEvent {
  return new MouseEvent('click', { bubbles: true, clientX: 24, clientY: 16 });
}

function element<T extends Element>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Expected ${selector}`);
  return result;
}

describe('folder header menus', () => {
  let menus: FolderHeaderMenus;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(browser.storage.sync.get).mockResolvedValue({});
    vi.mocked(browser.storage.sync.set).mockResolvedValue(undefined);
    vi.mocked(chrome.storage.sync.get).mockImplementation(async () => ({}));
    vi.mocked(chrome.storage.sync.set).mockResolvedValue(undefined);
    menus = createFolderHeaderMenus();
  });

  afterEach(() => {
    menus.close();
    vi.runOnlyPendingTimers();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('toggles one shared menu at the click position across action and settings buttons', () => {
    menus.openActions(openingClick(), []);
    const first = element<HTMLElement>('.gv-folder-menu');
    expect(first.style.position).toBe('fixed');
    expect(first.style.left).toBe('24px');
    expect(first.style.top).toBe('16px');

    menus.openSettings(openingClick(), 'manual', vi.fn());
    expect(document.querySelector('.gv-folder-menu')).toBeNull();
    menus.openSettings(openingClick(), 'manual', vi.fn());
    expect(document.querySelectorAll('.gv-folder-menu')).toHaveLength(1);
    expect(document.querySelector('.gv-folder-settings-menu')).not.toBeNull();
    menus.openActions(openingClick(), []);
    expect(document.querySelector('.gv-folder-menu')).toBeNull();
  });

  it('renders both icon formats and closes before invoking the chosen action', () => {
    const action = vi.fn(() => expect(document.querySelector('.gv-folder-menu')).toBeNull());
    menus.openActions(openingClick(), [
      { label: 'Import', icon: 'upload', action },
      { label: 'Sync', iconHtml: '<svg viewBox="0 0 24 24"></svg>', action: vi.fn() },
    ]);
    const items = document.querySelectorAll<HTMLButtonElement>('.gv-folder-menu-item');
    expect(items[0].querySelector('mat-icon')?.textContent).toBe('upload');
    expect(items[0].textContent).toContain('Import');
    expect(items[1].querySelector('.gv-folder-menu-icon svg')).not.toBeNull();

    items[0].click();

    expect(action).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'removes old outside-click listeners on close and reopen (listener already attached: %s)',
    (listenerAttached) => {
      menus.openActions(openingClick(), []);
      if (listenerAttached) vi.runOnlyPendingTimers();
      menus.close();
      expect(document.querySelector('.gv-folder-menu')).toBeNull();

      menus.openActions(openingClick(), []);
      vi.runOnlyPendingTimers();
      const reopened = element<HTMLElement>('.gv-folder-menu');
      reopened.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(reopened.isConnected).toBe(true);
      expect(document.querySelectorAll('.gv-folder-menu')).toHaveLength(1);

      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(document.querySelector('.gv-folder-menu')).toBeNull();
    },
  );

  it('reopens after the previous menu was removed externally', () => {
    menus.openSettings(openingClick(), 'manual', vi.fn());
    element('.gv-folder-menu').remove();

    menus.openActions(openingClick(), []);
    vi.runOnlyPendingTimers();
    const reopened = element<HTMLElement>('.gv-folder-menu');
    reopened.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(reopened.isConnected).toBe(true);
    expect(document.querySelector('.gv-folder-settings-menu')).toBeNull();
  });

  it('shows the current sort mode and reports changes through its callback', () => {
    const onSortModeChange = vi.fn();
    menus.openSettings(openingClick(), 'manual', onSortModeChange);
    const options = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.gv-folder-sort-option'),
    );
    expect(options.map((button) => button.textContent)).toEqual([
      'folder_sort_manual',
      'folder_sort_recent',
    ]);
    expect(options[0].getAttribute('aria-pressed')).toBe('true');

    options[1].click();

    expect(options[0].getAttribute('aria-pressed')).toBe('false');
    expect(options[1].getAttribute('aria-pressed')).toBe('true');
    expect(onSortModeChange).toHaveBeenCalledExactlyOnceWith('recent');
    expect(document.querySelector('.gv-folder-settings-menu')).not.toBeNull();
  });

  it('loads legacy width, previews slider input and persists width and enabled state', async () => {
    vi.mocked(browser.storage.sync.get).mockResolvedValue({
      [StorageKeys.SIDEBAR_WIDTH]: 26,
      [StorageKeys.SIDEBAR_WIDTH_ENABLED]: true,
    });
    menus.openSettings(openingClick(), 'manual', vi.fn());
    await Promise.resolve();
    const toggle = element<HTMLButtonElement>('.gv-folder-width-switch');
    const slider = element<HTMLInputElement>('.gv-folder-width-slider');
    const value = element<HTMLOutputElement>('.gv-folder-width-value');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(slider.disabled).toBe(false);
    expect(slider.value).toBe('312');
    expect(value.textContent).toBe('312px');

    slider.value = '360';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(value.textContent).toBe('360px');
    expect(browser.storage.sync.set).not.toHaveBeenCalled();
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    expect(browser.storage.sync.set).toHaveBeenCalledWith({ [StorageKeys.SIDEBAR_WIDTH]: 360 });

    toggle.click();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(slider.disabled).toBe(true);
    expect(browser.storage.sync.set).toHaveBeenCalledWith({
      [StorageKeys.SIDEBAR_WIDTH_ENABLED]: false,
    });
  });

  it.each([
    ['26', '312'],
    [45, '540'],
    [46, '180'],
    [700, '540'],
    ['invalid', '312'],
  ])('normalizes stored width %s to %s pixels', async (stored, expected) => {
    vi.mocked(browser.storage.sync.get).mockResolvedValue({ [StorageKeys.SIDEBAR_WIDTH]: stored });
    menus.openSettings(openingClick(), 'manual', vi.fn());
    await Promise.resolve();

    expect(element<HTMLInputElement>('.gv-folder-width-slider').value).toBe(expected);
  });

  it.each(['minimum', 'maximum'] as const)(
    'clamps font, spacing and indent at their %s and keeps stepper clicks inside the menu',
    async (boundary) => {
      vi.mocked(chrome.storage.sync.get).mockImplementation(async (defaults: unknown) =>
        Object.fromEntries(
          Object.keys(defaults as Record<string, unknown>).map((key) => [
            key,
            boundary === 'minimum' ? -999 : 999,
          ]),
        ),
      );
      menus.openSettings(openingClick(), 'manual', vi.fn());
      await Promise.resolve();
      vi.runOnlyPendingTimers();
      const menu = element<HTMLElement>('.gv-folder-settings-menu');
      for (const [label, key, min, max, unit] of [
        ['folder_item_font_size', StorageKeys.GV_FOLDER_ITEM_FONT_SIZE, 12, 18, 'px'],
        ['folderSpacing', StorageKeys.GV_FOLDER_SPACING, 0, 16, ''],
        ['folderTreeIndent', StorageKeys.GV_FOLDER_TREE_INDENT, -8, 32, ''],
      ] as const) {
        const row = Array.from(menu.querySelectorAll('.gv-folder-settings-row')).find(
          (candidate) =>
            candidate.querySelector('.gv-folder-settings-label')?.textContent === label,
        );
        if (!row) throw new Error(`Expected settings row: ${label}`);
        const [minus, plus] = row.querySelectorAll<HTMLButtonElement>('.gv-folder-stepper-btn');
        const limit = boundary === 'minimum' ? min : max;
        expect(row.querySelector('.gv-folder-stepper-value')?.textContent).toBe(`${limit}${unit}`);
        expect((boundary === 'minimum' ? minus : plus).disabled).toBe(true);

        (boundary === 'minimum' ? plus : minus).click();

        expect(chrome.storage.sync.set).toHaveBeenCalledWith({
          [key]: limit + (boundary === 'minimum' ? 1 : -1),
        });
        expect(menu.isConnected).toBe(true);
      }
    },
  );
});
