import { useCallback, useMemo, useState } from 'react';

import { StorageKeys } from '@/core/types/common';
import { useWidthAdjuster } from '@/hooks/useWidthAdjuster';

import {
  AI_STUDIO_SIDEBAR_PX,
  CHAT_FONT_SIZE,
  CHAT_LINE_HEIGHT,
  CHAT_PARAGRAPH_SPACING,
  CHAT_PERCENT,
  EDIT_PERCENT,
  FOLDER_SPACING,
  FOLDER_TREE_INDENT,
  GEMS_SIDEBAR_COUNT,
  SIDEBAR_PX,
  clampNumber,
  normalizePercent,
  normalizeSidebarPx,
} from '../utils/layoutSettings';

export const LAYOUT_SETTINGS_STORAGE_DEFAULTS = {
  [StorageKeys.CHAT_WIDTH_ENABLED]: false,
  [StorageKeys.CHAT_FONT_SIZE_ENABLED]: false,
  [StorageKeys.CHAT_FONT_SIZE]: CHAT_FONT_SIZE.defaultValue,
  [StorageKeys.CHAT_LINE_HEIGHT_ENABLED]: false,
  [StorageKeys.CHAT_LINE_HEIGHT]: CHAT_LINE_HEIGHT.defaultValue,
  [StorageKeys.CHAT_PARAGRAPH_SPACING]: CHAT_PARAGRAPH_SPACING.defaultValue,
  [StorageKeys.EDIT_INPUT_WIDTH_ENABLED]: false,
  [StorageKeys.SIDEBAR_WIDTH_ENABLED]: false,
  [StorageKeys.CHAT_WIDTH]: CHAT_PERCENT.defaultValue,
  [StorageKeys.EDIT_INPUT_WIDTH]: EDIT_PERCENT.defaultValue,
  [StorageKeys.GV_SIDEBAR_AUTO_HIDE]: false,
  [StorageKeys.GV_SIDEBAR_FULL_HIDE]: false,
};

export interface PopupLayoutSettingsOptions {
  isAIStudio: boolean;
  writeSyncStorage: (payload: Record<string, unknown>) => Promise<void>;
}

export function usePopupLayoutSettings({
  isAIStudio,
  writeSyncStorage,
}: PopupLayoutSettingsOptions) {
  const [chatWidthEnabled, setChatWidthEnabled] = useState(false);
  const [chatFontSizeEnabled, setChatFontSizeEnabled] = useState(false);
  const [chatLineHeightEnabled, setChatLineHeightEnabled] = useState(false);
  const [editInputWidthEnabled, setEditInputWidthEnabled] = useState(false);
  const [sidebarWidthEnabled, setSidebarWidthEnabled] = useState(false);
  const [sidebarAutoHideEnabled, setSidebarAutoHideEnabled] = useState(false);
  const [sidebarFullHideEnabled, setSidebarFullHideEnabled] = useState(false);

  // Width adjuster for chat width
  const chatWidthAdjuster = useWidthAdjuster({
    storageKey: StorageKeys.CHAT_WIDTH,
    defaultValue: CHAT_PERCENT.defaultValue,
    normalize: (v) =>
      normalizePercent(
        v,
        CHAT_PERCENT.defaultValue,
        CHAT_PERCENT.min,
        CHAT_PERCENT.max,
        CHAT_PERCENT.legacyBaselinePx,
      ),
    onApply: useCallback((widthPercent: number) => {
      const normalized = normalizePercent(
        widthPercent,
        CHAT_PERCENT.defaultValue,
        CHAT_PERCENT.min,
        CHAT_PERCENT.max,
        CHAT_PERCENT.legacyBaselinePx,
      );
      try {
        chrome.storage?.sync?.set({ [StorageKeys.CHAT_WIDTH]: normalized });
      } catch {}
    }, []),
  });

  // Font size adjuster for chat messages
  const chatFontSizeAdjuster = useWidthAdjuster({
    storageKey: StorageKeys.CHAT_FONT_SIZE,
    defaultValue: CHAT_FONT_SIZE.defaultValue,
    normalize: (v) => clampNumber(v, CHAT_FONT_SIZE.min, CHAT_FONT_SIZE.max),
    onApply: useCallback((value: number) => {
      const clamped = clampNumber(value, CHAT_FONT_SIZE.min, CHAT_FONT_SIZE.max);
      try {
        chrome.storage?.sync?.set({ [StorageKeys.CHAT_FONT_SIZE]: clamped });
      } catch {}
    }, []),
  });

  // Line height adjuster for chat messages
  const chatLineHeightAdjuster = useWidthAdjuster({
    storageKey: StorageKeys.CHAT_LINE_HEIGHT,
    defaultValue: CHAT_LINE_HEIGHT.defaultValue,
    normalize: (v) => clampNumber(v, CHAT_LINE_HEIGHT.min, CHAT_LINE_HEIGHT.max),
    onApply: useCallback((value: number) => {
      const clamped = clampNumber(value, CHAT_LINE_HEIGHT.min, CHAT_LINE_HEIGHT.max);
      try {
        chrome.storage?.sync?.set({ [StorageKeys.CHAT_LINE_HEIGHT]: clamped });
      } catch {}
    }, []),
  });

  // Paragraph spacing adjuster for chat messages
  const chatParagraphSpacingAdjuster = useWidthAdjuster({
    storageKey: StorageKeys.CHAT_PARAGRAPH_SPACING,
    defaultValue: CHAT_PARAGRAPH_SPACING.defaultValue,
    normalize: (v) => clampNumber(v, CHAT_PARAGRAPH_SPACING.min, CHAT_PARAGRAPH_SPACING.max),
    onApply: useCallback((value: number) => {
      const clamped = clampNumber(value, CHAT_PARAGRAPH_SPACING.min, CHAT_PARAGRAPH_SPACING.max);
      try {
        chrome.storage?.sync?.set({ [StorageKeys.CHAT_PARAGRAPH_SPACING]: clamped });
      } catch {}
    }, []),
  });

  // Width adjuster for edit input width
  const editInputWidthAdjuster = useWidthAdjuster({
    storageKey: StorageKeys.EDIT_INPUT_WIDTH,
    defaultValue: EDIT_PERCENT.defaultValue,
    normalize: (v) =>
      normalizePercent(
        v,
        EDIT_PERCENT.defaultValue,
        EDIT_PERCENT.min,
        EDIT_PERCENT.max,
        EDIT_PERCENT.legacyBaselinePx,
      ),
    onApply: useCallback((widthPercent: number) => {
      const normalized = normalizePercent(
        widthPercent,
        EDIT_PERCENT.defaultValue,
        EDIT_PERCENT.min,
        EDIT_PERCENT.max,
        EDIT_PERCENT.legacyBaselinePx,
      );
      try {
        chrome.storage?.sync?.set({ [StorageKeys.EDIT_INPUT_WIDTH]: normalized });
      } catch {}
    }, []),
  });

  // Width adjuster for sidebar width (Context-aware: Gemini vs AI Studio)
  const sidebarConfig = useMemo(
    () =>
      isAIStudio
        ? {
            key: StorageKeys.AISTUDIO_SIDEBAR_WIDTH,
            min: AI_STUDIO_SIDEBAR_PX.min,
            max: AI_STUDIO_SIDEBAR_PX.max,
            def: AI_STUDIO_SIDEBAR_PX.defaultValue,
            norm: (v: number) => clampNumber(v, AI_STUDIO_SIDEBAR_PX.min, AI_STUDIO_SIDEBAR_PX.max),
          }
        : {
            key: StorageKeys.SIDEBAR_WIDTH,
            min: SIDEBAR_PX.min,
            max: SIDEBAR_PX.max,
            def: SIDEBAR_PX.defaultValue,
            norm: normalizeSidebarPx,
          },
    [isAIStudio],
  );

  const sidebarWidthAdjuster = useWidthAdjuster({
    storageKey: sidebarConfig.key,
    defaultValue: sidebarConfig.def,
    normalize: sidebarConfig.norm,
    onApply: useCallback(
      (widthPx: number) => {
        const clamped = sidebarConfig.norm(widthPx);
        try {
          chrome.storage?.sync?.set({ [sidebarConfig.key]: clamped });
        } catch {}
      },
      [sidebarConfig],
    ),
  });

  // Folder spacing adjuster (Context-aware: Gemini vs AI Studio)
  const folderSpacingKey = isAIStudio
    ? StorageKeys.GV_AISTUDIO_FOLDER_SPACING
    : StorageKeys.GV_FOLDER_SPACING;

  const folderSpacingAdjuster = useWidthAdjuster({
    storageKey: folderSpacingKey,
    defaultValue: FOLDER_SPACING.defaultValue,
    normalize: (v) => clampNumber(v, FOLDER_SPACING.min, FOLDER_SPACING.max),
    onApply: useCallback(
      (spacing: number) => {
        const clamped = clampNumber(spacing, FOLDER_SPACING.min, FOLDER_SPACING.max);
        try {
          chrome.storage?.sync?.set({ [folderSpacingKey]: clamped });
        } catch {}
      },
      [folderSpacingKey],
    ),
  });

  const folderTreeIndentAdjuster = useWidthAdjuster({
    storageKey: StorageKeys.GV_FOLDER_TREE_INDENT,
    defaultValue: FOLDER_TREE_INDENT.defaultValue,
    normalize: (v) => clampNumber(v, FOLDER_TREE_INDENT.min, FOLDER_TREE_INDENT.max),
    onApply: useCallback((indent: number) => {
      const clamped = clampNumber(indent, FOLDER_TREE_INDENT.min, FOLDER_TREE_INDENT.max);
      try {
        chrome.storage?.sync?.set({ [StorageKeys.GV_FOLDER_TREE_INDENT]: clamped });
      } catch {}
    }, []),
  });

  // Gems sidebar count — 0 hides the section, 1-10 controls how many recent
  // gems show above Notebooks. Persists to chrome.storage.sync so the
  // preference follows the user across devices.
  const gemsSidebarCountAdjuster = useWidthAdjuster({
    storageKey: StorageKeys.GV_GEMS_SIDEBAR_COUNT,
    defaultValue: GEMS_SIDEBAR_COUNT.defaultValue,
    normalize: (v) => clampNumber(v, GEMS_SIDEBAR_COUNT.min, GEMS_SIDEBAR_COUNT.max),
    onApply: useCallback((count: number) => {
      const clamped = clampNumber(count, GEMS_SIDEBAR_COUNT.min, GEMS_SIDEBAR_COUNT.max);
      try {
        chrome.storage?.sync?.set({ [StorageKeys.GV_GEMS_SIDEBAR_COUNT]: clamped });
      } catch {}
    }, []),
  });

  const hydrateFromStorage = useCallback((stored: Record<string, unknown>) => {
    // Preserve legacy auto-enable: a saved custom width enables its adjuster.
    setChatWidthEnabled(
      stored[StorageKeys.CHAT_WIDTH_ENABLED] === true ||
        (stored[StorageKeys.CHAT_WIDTH_ENABLED] === false &&
          typeof stored[StorageKeys.CHAT_WIDTH] === 'number' &&
          stored[StorageKeys.CHAT_WIDTH] !== CHAT_PERCENT.defaultValue),
    );
    setChatFontSizeEnabled(stored[StorageKeys.CHAT_FONT_SIZE_ENABLED] === true);
    setChatLineHeightEnabled(stored[StorageKeys.CHAT_LINE_HEIGHT_ENABLED] === true);
    setEditInputWidthEnabled(
      stored[StorageKeys.EDIT_INPUT_WIDTH_ENABLED] === true ||
        (stored[StorageKeys.EDIT_INPUT_WIDTH_ENABLED] === false &&
          typeof stored[StorageKeys.EDIT_INPUT_WIDTH] === 'number' &&
          stored[StorageKeys.EDIT_INPUT_WIDTH] !== EDIT_PERCENT.defaultValue),
    );
    setSidebarWidthEnabled(stored[StorageKeys.SIDEBAR_WIDTH_ENABLED] === true);
    setSidebarAutoHideEnabled(stored[StorageKeys.GV_SIDEBAR_AUTO_HIDE] === true);
    setSidebarFullHideEnabled(stored[StorageKeys.GV_SIDEBAR_FULL_HIDE] === true);
  }, []);

  const onChatWidthEnabledChange = useCallback((enabled: boolean) => {
    setChatWidthEnabled(enabled);
    try {
      chrome.storage?.sync?.set({ [StorageKeys.CHAT_WIDTH_ENABLED]: enabled });
    } catch {}
  }, []);

  const onChatFontSizeEnabledChange = useCallback((enabled: boolean) => {
    setChatFontSizeEnabled(enabled);
    try {
      chrome.storage?.sync?.set({ [StorageKeys.CHAT_FONT_SIZE_ENABLED]: enabled });
    } catch {}
  }, []);

  const onChatLineHeightEnabledChange = useCallback((enabled: boolean) => {
    setChatLineHeightEnabled(enabled);
    try {
      chrome.storage?.sync?.set({ [StorageKeys.CHAT_LINE_HEIGHT_ENABLED]: enabled });
    } catch {}
  }, []);

  const onEditInputWidthEnabledChange = useCallback((enabled: boolean) => {
    setEditInputWidthEnabled(enabled);
    try {
      chrome.storage?.sync?.set({ [StorageKeys.EDIT_INPUT_WIDTH_ENABLED]: enabled });
    } catch {}
  }, []);

  const onSidebarWidthEnabledChange = useCallback((enabled: boolean) => {
    setSidebarWidthEnabled(enabled);
    try {
      chrome.storage?.sync?.set({ [StorageKeys.SIDEBAR_WIDTH_ENABLED]: enabled });
    } catch {}
  }, []);

  const onSidebarAutoHideEnabledChange = useCallback(
    (enabled: boolean) => {
      setSidebarAutoHideEnabled(enabled);
      void writeSyncStorage({ [StorageKeys.GV_SIDEBAR_AUTO_HIDE]: enabled });
    },
    [writeSyncStorage],
  );

  const onSidebarFullHideEnabledChange = useCallback(
    (enabled: boolean) => {
      setSidebarFullHideEnabled(enabled);
      void writeSyncStorage({ [StorageKeys.GV_SIDEBAR_FULL_HIDE]: enabled });
    },
    [writeSyncStorage],
  );

  return {
    isAIStudio,
    sidebarConfig,
    chatWidthAdjuster,
    chatFontSizeAdjuster,
    chatLineHeightAdjuster,
    chatParagraphSpacingAdjuster,
    editInputWidthAdjuster,
    sidebarWidthAdjuster,
    folderSpacingAdjuster,
    folderTreeIndentAdjuster,
    gemsSidebarCountAdjuster,
    chatWidthEnabled,
    chatFontSizeEnabled,
    chatLineHeightEnabled,
    editInputWidthEnabled,
    sidebarWidthEnabled,
    sidebarAutoHideEnabled,
    sidebarFullHideEnabled,
    hydrateFromStorage,
    onChatWidthEnabledChange,
    onChatFontSizeEnabledChange,
    onChatLineHeightEnabledChange,
    onEditInputWidthEnabledChange,
    onSidebarWidthEnabledChange,
    onSidebarAutoHideEnabledChange,
    onSidebarFullHideEnabledChange,
  };
}

export type PopupLayoutSettingsController = ReturnType<typeof usePopupLayoutSettings>;
