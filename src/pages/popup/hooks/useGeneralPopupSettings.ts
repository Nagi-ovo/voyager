import { useCallback, useEffect, useState } from 'react';

import { StorageKeys } from '@/core/types/common';
import {
  ensureNotificationsPermission,
  hasNotificationsPermission,
} from '@/core/utils/notificationsPermission';
import { requestSafariNativeNotificationPermission } from '@/core/utils/safariNativeNotifications';

import type { GeneralSettingsValues } from '../components/GeneralSettingsCard';
import { useEchartsPopupSettings } from './useEchartsPopupSettings';
import { useWaveDromPopupSettings } from './useWaveDromPopupSettings';

export const GENERAL_SETTINGS_STORAGE_DEFAULTS = {
  [StorageKeys.PERSISTENT_EXPORT_TOOLBAR_ENABLED]: true,
  [StorageKeys.MERMAID_ENABLED]: true,
  [StorageKeys.WAVEDROM_ENABLED]: true,
  [StorageKeys.ECHARTS_ENABLED]: true,
  [StorageKeys.QUOTE_REPLY_ENABLED]: true,
  [StorageKeys.HIGHLIGHT_ENABLED]: false,
  [StorageKeys.HIGHLIGHT_TIMELINE_MARKERS_ENABLED]: true,
  [StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED]: false,
  [StorageKeys.REMOTE_ANNOUNCEMENTS_ENABLED]: true,
  [StorageKeys.USAGE_STATUS_ENABLED]: false,
  [StorageKeys.INPUT_HALO_HIDDEN]: false,
  [StorageKeys.DEFAULT_MODEL_AUTO_APPLY]: true,
};

type PlainGeneralSettings = Omit<
  GeneralSettingsValues,
  | 'wavedromEnabled'
  | 'echartsEnabled'
  | 'changelogBadgeMode'
  | 'responseCompleteNotificationEnabled'
>;

const PLAIN_SETTING_STORAGE_KEYS = {
  persistentExportToolbarEnabled: StorageKeys.PERSISTENT_EXPORT_TOOLBAR_ENABLED,
  mermaidEnabled: StorageKeys.MERMAID_ENABLED,
  quoteReplyEnabled: StorageKeys.QUOTE_REPLY_ENABLED,
  highlightEnabled: StorageKeys.HIGHLIGHT_ENABLED,
  highlightTimelineMarkersEnabled: StorageKeys.HIGHLIGHT_TIMELINE_MARKERS_ENABLED,
  remoteAnnouncementEnabled: StorageKeys.REMOTE_ANNOUNCEMENTS_ENABLED,
  usageStatusEnabled: StorageKeys.USAGE_STATUS_ENABLED,
  inputHaloHidden: StorageKeys.INPUT_HALO_HIDDEN,
  defaultModelAutoApplyEnabled: StorageKeys.DEFAULT_MODEL_AUTO_APPLY,
} satisfies Record<keyof PlainGeneralSettings, string>;

export interface GeneralPopupSettingsOptions {
  writeSyncStorage: (payload: Record<string, unknown>) => Promise<void>;
  isSafariBrowser: boolean;
  canUseSystemNotifications: boolean;
}

export interface GeneralPopupSettings {
  values: GeneralSettingsValues;
  onChange: (patch: Partial<GeneralSettingsValues>) => void;
  hydrateFromStorage: (raw: Record<string, unknown>) => void;
  remoteAnnouncementPermissionGranted: boolean;
  requestRemoteAnnouncementSystemPermission: () => Promise<void>;
}

export function useGeneralPopupSettings({
  writeSyncStorage,
  isSafariBrowser,
  canUseSystemNotifications,
}: GeneralPopupSettingsOptions): GeneralPopupSettings {
  const [plainSettings, setPlainSettings] = useState<PlainGeneralSettings>({
    persistentExportToolbarEnabled: true,
    mermaidEnabled: true,
    quoteReplyEnabled: true,
    // Preserve the initial render; the bulk storage read defaults highlights off.
    highlightEnabled: true,
    highlightTimelineMarkersEnabled: true,
    remoteAnnouncementEnabled: true,
    usageStatusEnabled: false,
    inputHaloHidden: false,
    defaultModelAutoApplyEnabled: true,
  });
  const {
    enabled: wavedromEnabled,
    hydrateFromStorage: hydrateWavedromEnabled,
    setEnabledFromUser: setWavedromEnabledFromUser,
  } = useWaveDromPopupSettings(writeSyncStorage);
  const {
    enabled: echartsEnabled,
    hydrateFromStorage: hydrateEchartsEnabled,
    setEnabledFromUser: setEchartsEnabledFromUser,
  } = useEchartsPopupSettings(writeSyncStorage);
  const [changelogBadgeMode, setChangelogBadgeMode] = useState(false);
  const [responseCompleteNotificationEnabled, setResponseCompleteNotificationEnabled] =
    useState(false);
  const [remoteAnnouncementPermissionGranted, setRemoteAnnouncementPermissionGranted] =
    useState(false);

  useEffect(() => {
    try {
      chrome.storage?.local?.get(StorageKeys.CHANGELOG_NOTIFY_MODE, (res) => {
        setChangelogBadgeMode(res?.[StorageKeys.CHANGELOG_NOTIFY_MODE] === 'badge');
      });
    } catch {
      // Ignore storage errors (e.g. invalidated extension context).
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (!canUseSystemNotifications) {
      setRemoteAnnouncementPermissionGranted(false);
      return () => {
        active = false;
      };
    }
    void hasNotificationsPermission().then((granted) => {
      if (active) setRemoteAnnouncementPermissionGranted(granted);
    });
    return () => {
      active = false;
    };
  }, [canUseSystemNotifications]);

  const hydrateFromStorage = useCallback(
    (raw: Record<string, unknown>): void => {
      setPlainSettings({
        persistentExportToolbarEnabled:
          raw[StorageKeys.PERSISTENT_EXPORT_TOOLBAR_ENABLED] !== false,
        mermaidEnabled: raw[StorageKeys.MERMAID_ENABLED] !== false,
        quoteReplyEnabled: raw[StorageKeys.QUOTE_REPLY_ENABLED] !== false,
        highlightEnabled: raw[StorageKeys.HIGHLIGHT_ENABLED] === true,
        highlightTimelineMarkersEnabled:
          raw[StorageKeys.HIGHLIGHT_TIMELINE_MARKERS_ENABLED] !== false,
        remoteAnnouncementEnabled: raw[StorageKeys.REMOTE_ANNOUNCEMENTS_ENABLED] !== false,
        usageStatusEnabled: raw[StorageKeys.USAGE_STATUS_ENABLED] === true,
        inputHaloHidden: raw[StorageKeys.INPUT_HALO_HIDDEN] === true,
        defaultModelAutoApplyEnabled: raw[StorageKeys.DEFAULT_MODEL_AUTO_APPLY] !== false,
      });
      hydrateWavedromEnabled(raw[StorageKeys.WAVEDROM_ENABLED]);
      hydrateEchartsEnabled(raw[StorageKeys.ECHARTS_ENABLED]);
      setResponseCompleteNotificationEnabled(
        raw[StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED] === true,
      );
    },
    [hydrateEchartsEnabled, hydrateWavedromEnabled],
  );

  const handleChangelogBadgeModeChange = useCallback((checked: boolean): void => {
    setChangelogBadgeMode(checked);
    try {
      const updates: Record<string, string> = {
        [StorageKeys.CHANGELOG_NOTIFY_MODE]: checked ? 'badge' : 'popup',
      };
      // Allow the current release's NEW badge to appear when badge mode is enabled.
      if (checked) updates[StorageKeys.CHANGELOG_DISMISSED_VERSION] = '';
      chrome.storage?.local?.set(updates);
    } catch {
      // Ignore storage errors.
    }
  }, []);

  const handleResponseCompleteNotificationChange = useCallback(
    async (next: boolean): Promise<void> => {
      if (next && isSafariBrowser) {
        setResponseCompleteNotificationEnabled(true);
        const granted = await requestSafariNativeNotificationPermission();
        setResponseCompleteNotificationEnabled(granted);
        return;
      }
      if (next) {
        const granted = await ensureNotificationsPermission();
        if (!granted) {
          setResponseCompleteNotificationEnabled(false);
          return;
        }
      }
      if (next) setRemoteAnnouncementPermissionGranted(true);
      setResponseCompleteNotificationEnabled(next);
      void writeSyncStorage({ [StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED]: next });
    },
    [isSafariBrowser, writeSyncStorage],
  );

  const requestRemoteAnnouncementSystemPermission = useCallback(async (): Promise<void> => {
    if (await ensureNotificationsPermission()) {
      setRemoteAnnouncementPermissionGranted(true);
    }
  }, []);

  const onChange = useCallback(
    (patch: Partial<GeneralSettingsValues>): void => {
      const {
        wavedromEnabled: nextWavedromEnabled,
        echartsEnabled: nextEchartsEnabled,
        changelogBadgeMode: badgeMode,
        responseCompleteNotificationEnabled: nextResponseNotificationEnabled,
        ...rest
      } = patch;
      if (nextWavedromEnabled !== undefined) setWavedromEnabledFromUser(nextWavedromEnabled);
      if (nextEchartsEnabled !== undefined) setEchartsEnabledFromUser(nextEchartsEnabled);
      if (badgeMode !== undefined) handleChangelogBadgeModeChange(badgeMode);
      if (nextResponseNotificationEnabled !== undefined) {
        void handleResponseCompleteNotificationChange(nextResponseNotificationEnabled);
      }
      if (Object.keys(rest).length === 0) return;

      const nextSettings: Partial<PlainGeneralSettings> = {};
      const payload: Record<string, unknown> = {};
      for (const key of Object.keys(PLAIN_SETTING_STORAGE_KEYS) as Array<
        keyof PlainGeneralSettings
      >) {
        const value = rest[key];
        if (typeof value !== 'boolean') continue;
        nextSettings[key] = value;
        payload[PLAIN_SETTING_STORAGE_KEYS[key]] = value;
      }
      setPlainSettings((current) => ({ ...current, ...nextSettings }));
      void writeSyncStorage(payload);
    },
    [
      handleChangelogBadgeModeChange,
      handleResponseCompleteNotificationChange,
      setEchartsEnabledFromUser,
      setWavedromEnabledFromUser,
      writeSyncStorage,
    ],
  );

  return {
    values: {
      ...plainSettings,
      wavedromEnabled,
      echartsEnabled,
      changelogBadgeMode,
      responseCompleteNotificationEnabled,
    },
    onChange,
    hydrateFromStorage,
    remoteAnnouncementPermissionGranted,
    requestRemoteAnnouncementSystemPermission,
  };
}
