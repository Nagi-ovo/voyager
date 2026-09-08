import React, { act, useEffect } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import {
  LAYOUT_SETTINGS_STORAGE_DEFAULTS,
  type PopupLayoutSettingsController,
  usePopupLayoutSettings,
} from '../usePopupLayoutSettings';

function Harness({
  isAIStudio,
  writeSyncStorage,
  capture,
}: {
  isAIStudio: boolean;
  writeSyncStorage: (payload: Record<string, unknown>) => Promise<void>;
  capture: (settings: PopupLayoutSettingsController) => void;
}) {
  const settings = usePopupLayoutSettings({ isAIStudio, writeSyncStorage });
  useEffect(() => {
    capture(settings);
  }, [capture, settings]);
  return null;
}

describe('usePopupLayoutSettings', () => {
  let container: HTMLDivElement;
  let root: Root;
  let settings: PopupLayoutSettingsController;
  let stored: Record<string, unknown>;
  const writeSyncStorage = vi.fn(async (_payload: Record<string, unknown>) => {});

  const render = (isAIStudio = false) => {
    act(() => {
      root.render(
        <Harness
          isAIStudio={isAIStudio}
          writeSyncStorage={writeSyncStorage}
          capture={(next) => (settings = next)}
        />,
      );
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    stored = {};
    vi.mocked(chrome.storage.sync.get).mockImplementation((...args: unknown[]) => {
      const defaults = args[0] as Record<string, unknown>;
      const result = Object.fromEntries(
        Object.entries(defaults).map(([key, fallback]) => [
          key,
          Object.hasOwn(stored, key) ? stored[key] : fallback,
        ]),
      );
      const callback = args[1];
      if (typeof callback === 'function') callback(result);
      return Promise.resolve(result);
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('hydrates the bulk defaults without enabling adjustments or writing storage', () => {
    render();
    act(() => settings.hydrateFromStorage(LAYOUT_SETTINGS_STORAGE_DEFAULTS));
    expect([
      settings.chatWidthEnabled,
      settings.chatFontSizeEnabled,
      settings.chatLineHeightEnabled,
      settings.editInputWidthEnabled,
      settings.sidebarWidthEnabled,
      settings.sidebarAutoHideEnabled,
      settings.sidebarFullHideEnabled,
    ]).toEqual([false, false, false, false, false, false, false]);
    expect(settings.chatWidthAdjuster.width).toBe(70);
    expect(settings.editInputWidthAdjuster.width).toBe(60);
    expect(settings.sidebarWidthAdjuster.width).toBe(312);
    expect(settings.folderSpacingAdjuster.width).toBe(2);
    expect(settings.folderTreeIndentAdjuster.width).toBe(-8);
    expect(settings.gemsSidebarCountAdjuster.width).toBe(3);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(writeSyncStorage).not.toHaveBeenCalled();
  });

  it('converts legacy widths and preserves the legacy custom-width auto-enable rules', () => {
    stored = {
      [StorageKeys.CHAT_WIDTH]: 840,
      [StorageKeys.EDIT_INPUT_WIDTH]: 720,
      [StorageKeys.SIDEBAR_WIDTH]: 26,
    };
    render();
    act(() => settings.hydrateFromStorage({ ...LAYOUT_SETTINGS_STORAGE_DEFAULTS, ...stored }));
    expect(settings.chatWidthAdjuster.width).toBe(70);
    expect(settings.editInputWidthAdjuster.width).toBe(60);
    expect(settings.sidebarWidthAdjuster.width).toBe(312);
    expect(settings.chatWidthEnabled).toBe(true);
    expect(settings.editInputWidthEnabled).toBe(true);
    expect(settings.sidebarWidthEnabled).toBe(false);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();

    act(() =>
      settings.hydrateFromStorage({
        [StorageKeys.CHAT_WIDTH_ENABLED]: false,
        [StorageKeys.CHAT_WIDTH]: '840',
        [StorageKeys.EDIT_INPUT_WIDTH]: 720,
      }),
    );
    expect(settings.chatWidthEnabled).toBe(false);
    expect(settings.editInputWidthEnabled).toBe(false);
  });

  it('bounds stored numeric controls and falls back for non-finite widths', () => {
    stored = {
      [StorageKeys.CHAT_WIDTH]: Number.NaN,
      [StorageKeys.EDIT_INPUT_WIDTH]: Number.POSITIVE_INFINITY,
      [StorageKeys.SIDEBAR_WIDTH]: Number.NaN,
      [StorageKeys.CHAT_FONT_SIZE]: 180,
      [StorageKeys.CHAT_LINE_HEIGHT]: 100,
      [StorageKeys.CHAT_PARAGRAPH_SPACING]: 30,
      [StorageKeys.GV_FOLDER_TREE_INDENT]: -20,
      [StorageKeys.GV_GEMS_SIDEBAR_COUNT]: -1,
    };
    render();
    expect(settings.chatWidthAdjuster.width).toBe(70);
    expect(settings.editInputWidthAdjuster.width).toBe(60);
    expect(settings.sidebarWidthAdjuster.width).toBe(312);
    expect(settings.chatFontSizeAdjuster.width).toBe(150);
    expect(settings.chatLineHeightAdjuster.width).toBe(120);
    expect(settings.chatParagraphSpacingAdjuster.width).toBe(24);
    expect(settings.folderTreeIndentAdjuster.width).toBe(-8);
    expect(settings.gemsSidebarCountAdjuster.width).toBe(0);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('reads and saves the current platform sidebar and folder spacing independently', () => {
    stored = {
      [StorageKeys.SIDEBAR_WIDTH]: 360,
      [StorageKeys.AISTUDIO_SIDEBAR_WIDTH]: 496,
      [StorageKeys.GV_FOLDER_SPACING]: 4,
      [StorageKeys.GV_AISTUDIO_FOLDER_SPACING]: 8,
    };
    render();
    expect(settings.sidebarWidthAdjuster.width).toBe(360);
    expect(settings.folderSpacingAdjuster.width).toBe(4);
    render(true);
    expect(settings.sidebarWidthAdjuster.width).toBe(496);
    expect(settings.folderSpacingAdjuster.width).toBe(8);
    act(() => {
      settings.sidebarWidthAdjuster.handleChange(1000);
      settings.sidebarWidthAdjuster.handleChangeComplete();
      settings.folderSpacingAdjuster.handleChange(20);
      settings.folderSpacingAdjuster.handleChangeComplete();
    });
    expect(vi.mocked(chrome.storage.sync.set).mock.calls).toEqual([
      [{ [StorageKeys.AISTUDIO_SIDEBAR_WIDTH]: 600 }],
      [{ [StorageKeys.GV_AISTUDIO_FOLDER_SPACING]: 16 }],
    ]);
    render();
    expect(settings.sidebarWidthAdjuster.width).toBe(360);
    expect(settings.folderSpacingAdjuster.width).toBe(4);
    expect(chrome.storage.sync.set).toHaveBeenCalledTimes(2);
  });

  it('persists explicit off values under the existing width toggle keys', () => {
    render();
    act(() =>
      settings.hydrateFromStorage({
        [StorageKeys.CHAT_WIDTH_ENABLED]: true,
        [StorageKeys.CHAT_FONT_SIZE_ENABLED]: true,
        [StorageKeys.CHAT_LINE_HEIGHT_ENABLED]: true,
        [StorageKeys.EDIT_INPUT_WIDTH_ENABLED]: true,
        [StorageKeys.SIDEBAR_WIDTH_ENABLED]: true,
      }),
    );
    act(() => {
      settings.onChatWidthEnabledChange(false);
      settings.onChatFontSizeEnabledChange(false);
      settings.onChatLineHeightEnabledChange(false);
      settings.onEditInputWidthEnabledChange(false);
      settings.onSidebarWidthEnabledChange(false);
    });
    expect(settings.chatWidthEnabled).toBe(false);
    expect(settings.editInputWidthEnabled).toBe(false);
    expect(vi.mocked(chrome.storage.sync.set).mock.calls).toEqual([
      [{ [StorageKeys.CHAT_WIDTH_ENABLED]: false }],
      [{ [StorageKeys.CHAT_FONT_SIZE_ENABLED]: false }],
      [{ [StorageKeys.CHAT_LINE_HEIGHT_ENABLED]: false }],
      [{ [StorageKeys.EDIT_INPUT_WIDTH_ENABLED]: false }],
      [{ [StorageKeys.SIDEBAR_WIDTH_ENABLED]: false }],
    ]);
    expect(writeSyncStorage).not.toHaveBeenCalled();
  });

  it('keeps sidebar behavior switches independent and uses the popup storage writer', () => {
    render();
    act(() =>
      settings.hydrateFromStorage({
        [StorageKeys.GV_SIDEBAR_AUTO_HIDE]: true,
        [StorageKeys.GV_SIDEBAR_FULL_HIDE]: true,
      }),
    );
    act(() => settings.onSidebarAutoHideEnabledChange(false));
    expect(settings.sidebarAutoHideEnabled).toBe(false);
    expect(settings.sidebarFullHideEnabled).toBe(true);
    expect(writeSyncStorage).toHaveBeenCalledExactlyOnceWith({
      [StorageKeys.GV_SIDEBAR_AUTO_HIDE]: false,
    });
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });
});
