import { useCallback, useState } from 'react';

import { StorageKeys } from '@/core/types/common';

export interface InputPopupSettingsValues {
  inputCollapseEnabled: boolean;
  inputCollapseWhenNotEmpty: boolean;
  inputVimModeEnabled: boolean;
  ctrlEnterSendEnabled: boolean;
  aiStudioEnterSendEnabled: boolean;
  safariEnterFixEnabled: boolean;
  draftAutoSaveEnabled: boolean;
}

const STORAGE_KEYS = {
  inputCollapseEnabled: 'gvInputCollapseEnabled',
  inputCollapseWhenNotEmpty: 'gvInputCollapseWhenNotEmpty',
  inputVimModeEnabled: StorageKeys.INPUT_VIM_MODE,
  ctrlEnterSendEnabled: 'gvCtrlEnterSend',
  aiStudioEnterSendEnabled: StorageKeys.AISTUDIO_ENTER_SEND,
  safariEnterFixEnabled: StorageKeys.SAFARI_ENTER_FIX,
  draftAutoSaveEnabled: StorageKeys.DRAFT_AUTO_SAVE,
} satisfies Record<keyof InputPopupSettingsValues, string>;

export const INPUT_SETTINGS_STORAGE_DEFAULTS = Object.fromEntries(
  Object.values(STORAGE_KEYS).map((key) => [key, false]),
);

export function useInputPopupSettings(
  writeSyncStorage: (payload: Record<string, unknown>) => Promise<void>,
) {
  const [values, setValues] = useState<InputPopupSettingsValues>({
    inputCollapseEnabled: false,
    inputCollapseWhenNotEmpty: false,
    inputVimModeEnabled: false,
    ctrlEnterSendEnabled: false,
    aiStudioEnterSendEnabled: false,
    safariEnterFixEnabled: false,
    draftAutoSaveEnabled: false,
  });

  const hydrateFromStorage = useCallback((raw: Record<string, unknown>) => {
    setValues({
      inputCollapseEnabled: raw.gvInputCollapseEnabled !== false,
      inputCollapseWhenNotEmpty: raw.gvInputCollapseWhenNotEmpty === true,
      inputVimModeEnabled: raw[StorageKeys.INPUT_VIM_MODE] === true,
      ctrlEnterSendEnabled: raw.gvCtrlEnterSend === true,
      aiStudioEnterSendEnabled: raw[StorageKeys.AISTUDIO_ENTER_SEND] === true,
      safariEnterFixEnabled: raw[StorageKeys.SAFARI_ENTER_FIX] === true,
      draftAutoSaveEnabled: raw[StorageKeys.DRAFT_AUTO_SAVE] === true,
    });
  }, []);

  const onChange = useCallback(
    (patch: Partial<InputPopupSettingsValues>) => {
      const updates: Partial<InputPopupSettingsValues> = {};
      const payload: Record<string, unknown> = {};
      for (const key of Object.keys(STORAGE_KEYS) as Array<keyof InputPopupSettingsValues>) {
        const value = patch[key];
        if (typeof value !== 'boolean') continue;
        updates[key] = value;
        payload[STORAGE_KEYS[key]] = value;
      }
      setValues((current) => ({ ...current, ...updates }));
      void writeSyncStorage(payload);
    },
    [writeSyncStorage],
  );

  return { values, onChange, hydrateFromStorage };
}
