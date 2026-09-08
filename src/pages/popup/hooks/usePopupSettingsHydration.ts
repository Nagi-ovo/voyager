import { useEffect } from 'react';

import { StorageKeys } from '@/core/types/common';

import { writePopupSyncStorage } from '../utils/popupStorage';
import { FOLDER_SETTINGS_STORAGE_DEFAULTS } from './useFolderPopupSettings';
import { GENERAL_SETTINGS_STORAGE_DEFAULTS } from './useGeneralPopupSettings';
import { INPUT_SETTINGS_STORAGE_DEFAULTS } from './useInputPopupSettings';
import { LAYOUT_SETTINGS_STORAGE_DEFAULTS } from './usePopupLayoutSettings';
import { SECTION_LAYOUT_STORAGE_DEFAULTS } from './usePopupSections';
import { PROMPT_MANAGER_STORAGE_DEFAULTS } from './usePromptManagerSettings';
import { TIMELINE_SETTINGS_STORAGE_DEFAULTS } from './useTimelinePopupSettings';
import { VISUAL_EFFECT_STORAGE_DEFAULTS } from './useVisualEffectPopupSettings';
import { WATERMARK_SETTINGS_STORAGE_DEFAULTS } from './useWatermarkPopupSettings';

type HydrateSettings = (raw: Record<string, unknown>) => void;

/** One startup snapshot shared by all setting owners; callbacks remain stable across UI changes. */
export function usePopupSettingsHydration({
  timeline,
  folder,
  general,
  input,
  layout,
  promptManager,
  visualEffect,
  watermark,
  sections,
  formulaCopy,
  aiStudio,
}: {
  timeline: HydrateSettings;
  folder: HydrateSettings;
  general: HydrateSettings;
  input: HydrateSettings;
  layout: HydrateSettings;
  promptManager: HydrateSettings;
  visualEffect: HydrateSettings;
  watermark: HydrateSettings;
  sections: HydrateSettings;
  formulaCopy: (enabled: unknown, format: unknown) => void;
  aiStudio: (enabled: boolean) => void;
}) {
  useEffect(() => {
    try {
      chrome.storage?.sync?.get(
        {
          ...TIMELINE_SETTINGS_STORAGE_DEFAULTS,
          ...FOLDER_SETTINGS_STORAGE_DEFAULTS,
          ...GENERAL_SETTINGS_STORAGE_DEFAULTS,
          ...INPUT_SETTINGS_STORAGE_DEFAULTS,
          ...LAYOUT_SETTINGS_STORAGE_DEFAULTS,
          ...PROMPT_MANAGER_STORAGE_DEFAULTS,
          ...VISUAL_EFFECT_STORAGE_DEFAULTS,
          ...WATERMARK_SETTINGS_STORAGE_DEFAULTS,
          ...SECTION_LAYOUT_STORAGE_DEFAULTS,
          [StorageKeys.FORMULA_COPY_ENABLED]: true,
          [StorageKeys.FORMULA_COPY_FORMAT]: 'latex',
          [StorageKeys.GV_AISTUDIO_ENABLED]: true,
          [StorageKeys.TAB_TITLE_UPDATE_ENABLED]: false,
        },
        (result) => {
          const raw = result ?? {};
          timeline(raw);
          folder(raw);
          general(raw);
          input(raw);
          layout(raw);
          promptManager(raw);
          visualEffect(raw);
          watermark(raw);
          sections(raw);
          formulaCopy(raw[StorageKeys.FORMULA_COPY_ENABLED], raw[StorageKeys.FORMULA_COPY_FORMAT]);
          aiStudio(raw[StorageKeys.GV_AISTUDIO_ENABLED] !== false);
          // The retired title setting still needs its compatibility cleanup.
          if (raw[StorageKeys.TAB_TITLE_UPDATE_ENABLED] !== false) {
            void writePopupSyncStorage({ [StorageKeys.TAB_TITLE_UPDATE_ENABLED]: false });
          }
        },
      );
    } catch {
      // Keep initial values when the extension storage context is unavailable.
    }
  }, [
    timeline,
    folder,
    general,
    input,
    layout,
    promptManager,
    visualEffect,
    watermark,
    sections,
    formulaCopy,
    aiStudio,
  ]);
}
