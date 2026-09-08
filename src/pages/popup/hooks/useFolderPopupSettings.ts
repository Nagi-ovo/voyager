import { useCallback, useMemo, useState } from 'react';

import {
  type AccountPlatform,
  getAccountIsolationStorageKey,
} from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';

import type { FolderSettingsValues } from '../components/FolderSettingsCard';
import { type SettingSetters, applySettingsPatch } from '../utils/settingsPatch';

export const FOLDER_SETTINGS_STORAGE_DEFAULTS = {
  geminiFolderEnabled: true,
  [StorageKeys.FOLDER_FLOATING_MODE_ENABLED]: false,
  [StorageKeys.FOLDER_FLOATING_OPEN_ON_START]: true,
  geminiFolderHideArchivedConversations: false,
  [StorageKeys.FOLDER_SEARCH_ENABLED]: true,
  [StorageKeys.FORK_ENABLED]: false,
  [StorageKeys.FOLDER_PROJECT_ENABLED]: false,
  [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED]: false,
  [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI]: null,
  [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_AISTUDIO]: null,
};

export function useFolderPopupSettings({
  activeAccountPlatform,
  writeSyncStorage,
}: {
  activeAccountPlatform: AccountPlatform;
  writeSyncStorage: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [folderEnabled, setFolderEnabled] = useState(true);
  const [floatingModeEnabled, setFloatingModeEnabled] = useState(false);
  const [floatingOpenOnStart, setFloatingOpenOnStart] = useState(true);
  const [hideArchivedConversations, setHideArchivedConversations] = useState(false);
  const [folderSearchEnabled, setFolderSearchEnabled] = useState(true);
  const [forkEnabled, setForkEnabled] = useState(false);
  const [folderProjectEnabled, setFolderProjectEnabled] = useState(false);
  const [accountIsolationEnabledGemini, setAccountIsolationEnabledGemini] = useState(false);
  const [accountIsolationEnabledAIStudio, setAccountIsolationEnabledAIStudio] = useState(false);

  const setters = useMemo<SettingSetters<FolderSettingsValues>>(
    () => ({
      folderEnabled: setFolderEnabled,
      floatingModeEnabled: setFloatingModeEnabled,
      floatingOpenOnStart: setFloatingOpenOnStart,
      hideArchivedConversations: setHideArchivedConversations,
      folderSearchEnabled: setFolderSearchEnabled,
      forkEnabled: setForkEnabled,
      folderProjectEnabled: setFolderProjectEnabled,
    }),
    [],
  );

  const hydrateFromStorage = useCallback((stored: Record<string, unknown>) => {
    setFolderEnabled(stored.geminiFolderEnabled !== false);
    setFloatingModeEnabled(stored[StorageKeys.FOLDER_FLOATING_MODE_ENABLED] === true);
    setFloatingOpenOnStart(stored[StorageKeys.FOLDER_FLOATING_OPEN_ON_START] !== false);
    setHideArchivedConversations(!!stored.geminiFolderHideArchivedConversations);
    setFolderSearchEnabled(stored[StorageKeys.FOLDER_SEARCH_ENABLED] !== false);
    setForkEnabled(stored[StorageKeys.FORK_ENABLED] === true);
    setFolderProjectEnabled(stored[StorageKeys.FOLDER_PROJECT_ENABLED] === true);

    const legacyIsolationEnabled = stored[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED] === true;
    const geminiIsolationRaw = stored[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI];
    const aiStudioIsolationRaw = stored[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_AISTUDIO];
    setAccountIsolationEnabledGemini(
      typeof geminiIsolationRaw === 'boolean' ? geminiIsolationRaw : legacyIsolationEnabled,
    );
    setAccountIsolationEnabledAIStudio(
      typeof aiStudioIsolationRaw === 'boolean' ? aiStudioIsolationRaw : legacyIsolationEnabled,
    );
  }, []);

  const onChange = useCallback(
    (patch: Partial<FolderSettingsValues>) => {
      applySettingsPatch(setters, patch);
      const payload: Record<string, unknown> = {};
      if (typeof patch.folderEnabled === 'boolean')
        payload.geminiFolderEnabled = patch.folderEnabled;
      if (typeof patch.floatingModeEnabled === 'boolean')
        payload[StorageKeys.FOLDER_FLOATING_MODE_ENABLED] = patch.floatingModeEnabled;
      if (typeof patch.floatingOpenOnStart === 'boolean')
        payload[StorageKeys.FOLDER_FLOATING_OPEN_ON_START] = patch.floatingOpenOnStart;
      if (typeof patch.hideArchivedConversations === 'boolean')
        payload.geminiFolderHideArchivedConversations = patch.hideArchivedConversations;
      if (typeof patch.folderSearchEnabled === 'boolean')
        payload[StorageKeys.FOLDER_SEARCH_ENABLED] = patch.folderSearchEnabled;
      if (typeof patch.forkEnabled === 'boolean')
        payload[StorageKeys.FORK_ENABLED] = patch.forkEnabled;
      if (typeof patch.folderProjectEnabled === 'boolean')
        payload[StorageKeys.FOLDER_PROJECT_ENABLED] = patch.folderProjectEnabled;
      void writeSyncStorage(payload);
    },
    [setters, writeSyncStorage],
  );

  const onAccountIsolationChange = useCallback(
    (enabled: boolean) => {
      if (activeAccountPlatform === 'aistudio') {
        setAccountIsolationEnabledAIStudio(enabled);
      } else {
        setAccountIsolationEnabledGemini(enabled);
      }
      void writeSyncStorage({ [getAccountIsolationStorageKey(activeAccountPlatform)]: enabled });
    },
    [activeAccountPlatform, writeSyncStorage],
  );

  return {
    values: {
      folderEnabled,
      floatingModeEnabled,
      floatingOpenOnStart,
      hideArchivedConversations,
      folderSearchEnabled,
      forkEnabled,
      folderProjectEnabled,
    },
    accountIsolationEnabled:
      activeAccountPlatform === 'aistudio'
        ? accountIsolationEnabledAIStudio
        : accountIsolationEnabledGemini,
    hydrateFromStorage,
    onChange,
    onAccountIsolationChange,
  };
}
