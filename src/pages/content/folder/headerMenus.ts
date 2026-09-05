import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';
import type { ConversationSortMode } from '@/features/folder/model/folderData';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';

const GEMINI_SIDEBAR_WIDTH_MIN_PX = 180;
const GEMINI_SIDEBAR_WIDTH_MAX_PX = 540;
const GEMINI_SIDEBAR_WIDTH_DEFAULT_PX = 312;
const GEMINI_SIDEBAR_WIDTH_STEP_PX = 8;
const LEGACY_SIDEBAR_WIDTH_MAX_PERCENT = 45;
const LEGACY_SIDEBAR_WIDTH_BASELINE_PX = 1200;

type HeaderMenuAction = {
  label: string;
  icon?: string;
  iconHtml?: string;
  action: () => void;
};

export type FolderHeaderMenus = {
  openActions: (event: MouseEvent, items: readonly HeaderMenuAction[]) => void;
  openSettings: (
    event: MouseEvent,
    sortMode: ConversationSortMode,
    onSortModeChange: (mode: ConversationSortMode) => void,
  ) => void;
  close: () => void;
};

/** Owns the single header popover and its document listener across all header actions. */
export function createFolderHeaderMenus(): FolderHeaderMenus {
  let activeMenu: HTMLElement | null = null;
  let closeHandler: ((event: MouseEvent) => void) | null = null;
  let listenerTimeout: number | null = null;

  const close = () => {
    activeMenu?.remove();
    activeMenu = null;
    if (listenerTimeout !== null) {
      window.clearTimeout(listenerTimeout);
      listenerTimeout = null;
    }
    if (closeHandler) {
      document.removeEventListener('click', closeHandler);
      closeHandler = null;
    }
  };

  const open = (event: MouseEvent, className: string): HTMLElement | null => {
    event.stopPropagation();
    if (activeMenu && !activeMenu.isConnected) close();
    if (activeMenu) {
      close();
      return null;
    }

    const menu = document.createElement('div');
    menu.className = className;
    menu.style.position = 'fixed';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    document.body.appendChild(menu);
    activeMenu = menu;

    const onDocumentClick = (click: MouseEvent) => {
      if (!menu.contains(click.target as Node)) close();
    };
    closeHandler = onDocumentClick;
    listenerTimeout = window.setTimeout(() => {
      document.addEventListener('click', onDocumentClick);
      listenerTimeout = null;
    }, 0);
    return menu;
  };

  return {
    openActions: (event, items) => {
      const menu = open(event, 'gv-folder-menu');
      if (!menu) return;
      for (const item of items) {
        const menuItem = document.createElement('button');
        menuItem.className = 'gv-folder-menu-item';
        const iconMarkup = item.iconHtml
          ? `<span class="gv-folder-menu-icon" aria-hidden="true">${item.iconHtml}</span>`
          : `<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true" style="font-size: 18px; line-height: 1; margin-right: 8px;">${item.icon ?? ''}</mat-icon>`;
        menuItem.innerHTML = `${iconMarkup}${item.label}`;
        menuItem.addEventListener('click', () => {
          close();
          item.action();
        });
        menu.appendChild(menuItem);
      }
    },
    openSettings: (event, sortMode, onSortModeChange) => {
      const menu = open(event, 'gv-folder-menu gv-folder-settings-menu');
      if (!menu) return;
      menu.appendChild(createConversationSortSettingsRow(sortMode, onSortModeChange));
      menu.appendChild(createSidebarWidthSettingsRow());
      for (const config of [
        {
          labelKey: 'folder_item_font_size',
          storageKey: StorageKeys.GV_FOLDER_ITEM_FONT_SIZE,
          min: 12,
          max: 18,
          defaultValue: 13,
          unit: 'px',
        },
        {
          labelKey: 'folderSpacing',
          storageKey: StorageKeys.GV_FOLDER_SPACING,
          min: 0,
          max: 16,
          defaultValue: 2,
        },
        {
          labelKey: 'folderTreeIndent',
          storageKey: StorageKeys.GV_FOLDER_TREE_INDENT,
          min: -8,
          max: 32,
          defaultValue: -8,
        },
      ]) {
        menu.appendChild(createSettingsStepperRow(config));
      }
      // Disabled stepper buttons can retarget a click in some browsers.
      // Keep interactions with the entire settings panel inside this popover.
      menu.addEventListener('click', (click) => click.stopPropagation());
    },
    close,
  };
}

function createConversationSortSettingsRow(
  initialMode: ConversationSortMode,
  onSortModeChange: (mode: ConversationSortMode) => void,
): HTMLElement {
  let currentMode = initialMode;
  const row = document.createElement('div');
  row.className = 'gv-folder-settings-row gv-folder-sort-settings-row';

  const label = document.createElement('span');
  label.className = 'gv-folder-settings-label';
  label.textContent = t('folder_sort');

  const options = document.createElement('div');
  options.className = 'gv-folder-sort-options';
  options.setAttribute('role', 'group');
  options.setAttribute('aria-label', t('folder_sort'));

  const buttons = new Map<ConversationSortMode, HTMLButtonElement>();
  const render = () => {
    buttons.forEach((button, mode) => {
      const active = currentMode === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  };

  (['manual', 'recent'] as const).forEach((mode) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gv-folder-sort-option';
    button.textContent = t(mode === 'manual' ? 'folder_sort_manual' : 'folder_sort_recent');
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      currentMode = mode;
      onSortModeChange(mode);
      render();
    });
    buttons.set(mode, button);
    options.appendChild(button);
  });

  render();
  row.append(label, options);
  return row;
}

function createSidebarWidthSettingsRow(): HTMLElement {
  const clampWidth = (value: number) =>
    Math.min(GEMINI_SIDEBAR_WIDTH_MAX_PX, Math.max(GEMINI_SIDEBAR_WIDTH_MIN_PX, Math.round(value)));
  const normalizeStoredWidth = (value: unknown) => {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return GEMINI_SIDEBAR_WIDTH_DEFAULT_PX;
    if (numeric <= LEGACY_SIDEBAR_WIDTH_MAX_PERCENT) {
      return clampWidth((numeric / 100) * LEGACY_SIDEBAR_WIDTH_BASELINE_PX);
    }
    return clampWidth(numeric);
  };

  const row = document.createElement('div');
  row.className = 'gv-folder-settings-row gv-folder-width-settings-row';

  const header = document.createElement('div');
  header.className = 'gv-folder-width-settings-header';

  const label = document.createElement('span');
  label.className = 'gv-folder-settings-label';
  label.textContent = t('sidebarWidth');

  const controls = document.createElement('div');
  controls.className = 'gv-folder-width-settings-controls';

  const value = document.createElement('output');
  value.className = 'gv-folder-width-value';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'gv-folder-width-switch';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-label', t('sidebarWidth'));

  const knob = document.createElement('span');
  knob.className = 'gv-folder-width-switch-knob';
  toggle.appendChild(knob);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'gv-folder-width-slider';
  slider.min = String(GEMINI_SIDEBAR_WIDTH_MIN_PX);
  slider.max = String(GEMINI_SIDEBAR_WIDTH_MAX_PX);
  slider.step = String(GEMINI_SIDEBAR_WIDTH_STEP_PX);
  slider.setAttribute('aria-label', t('sidebarWidth'));

  let current = GEMINI_SIDEBAR_WIDTH_DEFAULT_PX;
  let enabled = false;

  const render = () => {
    const progress =
      ((current - GEMINI_SIDEBAR_WIDTH_MIN_PX) /
        (GEMINI_SIDEBAR_WIDTH_MAX_PX - GEMINI_SIDEBAR_WIDTH_MIN_PX)) *
      100;
    value.textContent = `${current}px`;
    slider.value = String(current);
    slider.disabled = !enabled;
    slider.setAttribute('aria-valuetext', `${current}px`);
    slider.style.setProperty('--gv-folder-width-progress', `${progress}%`);
    toggle.setAttribute('aria-checked', String(enabled));
    row.classList.toggle('is-disabled', !enabled);
  };

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    enabled = !enabled;
    render();
    try {
      void browser.storage.sync
        .set({ [StorageKeys.SIDEBAR_WIDTH_ENABLED]: enabled })
        .catch((error) => {
          console.warn('[FolderHeaderMenus] Failed to toggle sidebar width:', error);
        });
    } catch (error) {
      console.warn('[FolderHeaderMenus] Failed to toggle sidebar width:', error);
    }
  });

  slider.addEventListener('input', (event) => {
    event.stopPropagation();
    current = clampWidth(Number((event.currentTarget as HTMLInputElement).value));
    render();
  });

  slider.addEventListener('change', (event) => {
    event.stopPropagation();
    try {
      void browser.storage.sync.set({ [StorageKeys.SIDEBAR_WIDTH]: current }).catch((error) => {
        console.warn('[FolderHeaderMenus] Failed to save sidebar width:', error);
      });
    } catch (error) {
      console.warn('[FolderHeaderMenus] Failed to save sidebar width:', error);
    }
  });

  try {
    void browser.storage.sync
      .get({
        [StorageKeys.SIDEBAR_WIDTH]: GEMINI_SIDEBAR_WIDTH_DEFAULT_PX,
        [StorageKeys.SIDEBAR_WIDTH_ENABLED]: false,
      })
      .then((result) => {
        current = normalizeStoredWidth(result?.[StorageKeys.SIDEBAR_WIDTH]);
        enabled = result?.[StorageKeys.SIDEBAR_WIDTH_ENABLED] === true;
        render();
      })
      .catch((error) => {
        console.warn('[FolderHeaderMenus] Failed to load sidebar width:', error);
      });
  } catch {
    // Fall through to the defaults rendered below.
  }

  controls.append(value, toggle);
  header.append(label, controls);
  row.append(header, slider);
  render();
  return row;
}

function createSettingsStepperRow(config: {
  labelKey: string;
  storageKey: string;
  min: number;
  max: number;
  defaultValue: number;
  unit?: string;
}): HTMLElement {
  const { labelKey, storageKey, min, max, defaultValue, unit } = config;
  const clamp = (n: number) =>
    Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : defaultValue)));

  const row = document.createElement('div');
  row.className = 'gv-folder-settings-row';

  const label = document.createElement('span');
  label.className = 'gv-folder-settings-label';
  label.textContent = t(labelKey);

  const stepper = document.createElement('div');
  stepper.className = 'gv-folder-stepper';

  const minus = document.createElement('button');
  minus.className = 'gv-folder-stepper-btn';
  minus.type = 'button';
  minus.innerHTML = `<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">remove</mat-icon>`;
  minus.title = t('folder_item_font_size_decrease');

  const value = document.createElement('span');
  value.className = 'gv-folder-stepper-value';

  const plus = document.createElement('button');
  plus.className = 'gv-folder-stepper-btn';
  plus.type = 'button';
  plus.innerHTML = `<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">add</mat-icon>`;
  plus.title = t('folder_item_font_size_increase');

  let current = defaultValue;

  const render = () => {
    value.textContent = unit ? `${current}${unit}` : `${current}`;
    minus.disabled = current <= min;
    plus.disabled = current >= max;
  };

  const persist = (next: number) => {
    current = clamp(next);
    render();
    try {
      void chrome.storage.sync.set({ [storageKey]: current });
    } catch (err) {
      console.warn(`[FolderHeaderMenus] Failed to save ${storageKey}:`, err);
    }
  };

  minus.addEventListener('click', (e) => {
    e.stopPropagation();
    persist(current - 1);
  });
  plus.addEventListener('click', (e) => {
    e.stopPropagation();
    persist(current + 1);
  });

  try {
    void chrome.storage.sync.get({ [storageKey]: defaultValue }).then((res) => {
      const raw = (res as Record<string, unknown>)?.[storageKey];
      const n = typeof raw === 'number' ? raw : Number(raw);
      current = Number.isFinite(n) ? clamp(n) : defaultValue;
      render();
    });
  } catch {
    // Fall through to default render below.
  }
  render();

  stepper.appendChild(minus);
  stepper.appendChild(value);
  stepper.appendChild(plus);

  row.appendChild(label);
  row.appendChild(stepper);
  return row;
}
