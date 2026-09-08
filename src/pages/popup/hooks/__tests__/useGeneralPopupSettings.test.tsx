import React, { act, useEffect } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import {
  ensureNotificationsPermission,
  hasNotificationsPermission,
} from '@/core/utils/notificationsPermission';
import { requestSafariNativeNotificationPermission } from '@/core/utils/safariNativeNotifications';

import {
  GENERAL_SETTINGS_STORAGE_DEFAULTS,
  type GeneralPopupSettings,
  type GeneralPopupSettingsOptions,
  useGeneralPopupSettings,
} from '../useGeneralPopupSettings';

vi.mock('@/core/utils/notificationsPermission', () => ({
  ensureNotificationsPermission: vi.fn(),
  hasNotificationsPermission: vi.fn(),
}));
vi.mock('@/core/utils/safariNativeNotifications', () => ({
  requestSafariNativeNotificationPermission: vi.fn(),
}));

function Harness({
  capture,
  ...options
}: GeneralPopupSettingsOptions & { capture: (settings: GeneralPopupSettings) => void }) {
  const settings = useGeneralPopupSettings(options);
  useEffect(() => {
    capture(settings);
  }, [capture, settings]);
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useGeneralPopupSettings', () => {
  let container: HTMLDivElement;
  let root: Root;
  let settings: GeneralPopupSettings;
  const writeSyncStorage = vi.fn(async (_payload: Record<string, unknown>) => {});

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.mocked(hasNotificationsPermission).mockResolvedValue(false);
    vi.mocked(ensureNotificationsPermission).mockResolvedValue(false);
    vi.mocked(requestSafariNativeNotificationPermission).mockResolvedValue(false);
    vi.mocked(chrome.storage.local.get).mockImplementation((...args: unknown[]) => {
      const callback = args[1];
      if (typeof callback === 'function') callback({});
      return Promise.resolve({});
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (overrides: Partial<GeneralPopupSettingsOptions> = {}) => {
    await act(async () => {
      root.render(
        <Harness
          writeSyncStorage={writeSyncStorage}
          isSafariBrowser={false}
          canUseSystemNotifications={true}
          {...overrides}
          capture={(next) => (settings = next)}
        />,
      );
    });
  };

  it('keeps initial highlights on, then applies the bulk defaults without reading or writing sync', async () => {
    await render();
    expect(settings.values.highlightEnabled).toBe(true);
    act(() => settings.hydrateFromStorage(GENERAL_SETTINGS_STORAGE_DEFAULTS));

    expect(settings.values).toEqual({
      persistentExportToolbarEnabled: true,
      mermaidEnabled: true,
      wavedromEnabled: true,
      echartsEnabled: true,
      quoteReplyEnabled: true,
      highlightEnabled: false,
      highlightTimelineMarkersEnabled: true,
      responseCompleteNotificationEnabled: false,
      remoteAnnouncementEnabled: true,
      changelogBadgeMode: false,
      usageStatusEnabled: false,
      inputHaloHidden: false,
      defaultModelAutoApplyEnabled: true,
    });
    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
    expect(writeSyncStorage).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('hydrates stored values using the existing opt-in and opt-out rules', async () => {
    await render();
    act(() =>
      settings.hydrateFromStorage({
        [StorageKeys.PERSISTENT_EXPORT_TOOLBAR_ENABLED]: false,
        [StorageKeys.MERMAID_ENABLED]: false,
        [StorageKeys.WAVEDROM_ENABLED]: false,
        [StorageKeys.ECHARTS_ENABLED]: false,
        [StorageKeys.QUOTE_REPLY_ENABLED]: false,
        [StorageKeys.HIGHLIGHT_ENABLED]: true,
        [StorageKeys.HIGHLIGHT_TIMELINE_MARKERS_ENABLED]: false,
        [StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED]: true,
        [StorageKeys.REMOTE_ANNOUNCEMENTS_ENABLED]: false,
        [StorageKeys.USAGE_STATUS_ENABLED]: true,
        [StorageKeys.INPUT_HALO_HIDDEN]: true,
        [StorageKeys.DEFAULT_MODEL_AUTO_APPLY]: false,
      }),
    );
    expect(settings.values).toEqual({
      persistentExportToolbarEnabled: false,
      mermaidEnabled: false,
      wavedromEnabled: false,
      echartsEnabled: false,
      quoteReplyEnabled: false,
      highlightEnabled: true,
      highlightTimelineMarkersEnabled: false,
      responseCompleteNotificationEnabled: true,
      remoteAnnouncementEnabled: false,
      changelogBadgeMode: false,
      usageStatusEnabled: true,
      inputHaloHidden: true,
      defaultModelAutoApplyEnabled: false,
    });
    act(() => settings.hydrateFromStorage({ [StorageKeys.HIGHLIGHT_ENABLED]: 'true' }));
    expect(settings.values.highlightEnabled).toBe(false);
    expect(settings.values.mermaidEnabled).toBe(true);
    expect(writeSyncStorage).not.toHaveBeenCalled();
    expect(ensureNotificationsPermission).not.toHaveBeenCalled();
  });

  it('persists only the changed plain settings and retains other values', async () => {
    await render();
    const before = settings.values;
    act(() => settings.onChange({ mermaidEnabled: false, inputHaloHidden: true }));
    expect(settings.values).toEqual({ ...before, mermaidEnabled: false, inputHaloHidden: true });
    expect(writeSyncStorage).toHaveBeenLastCalledWith({
      [StorageKeys.MERMAID_ENABLED]: false,
      [StorageKeys.INPUT_HALO_HIDDEN]: true,
    });
    act(() => settings.onChange({ persistentExportToolbarEnabled: false }));
    expect(settings.values.mermaidEnabled).toBe(false);
    expect(settings.values.inputHaloHidden).toBe(true);
    expect(writeSyncStorage).toHaveBeenLastCalledWith({
      [StorageKeys.PERSISTENT_EXPORT_TOOLBAR_ENABLED]: false,
    });
    expect(writeSyncStorage).toHaveBeenCalledTimes(2);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('preserves rendering choices made before the bulk storage read finishes', async () => {
    await render();
    act(() => settings.onChange({ wavedromEnabled: false, echartsEnabled: false }));
    act(() => settings.hydrateFromStorage(GENERAL_SETTINGS_STORAGE_DEFAULTS));
    expect(settings.values.wavedromEnabled).toBe(false);
    expect(settings.values.echartsEnabled).toBe(false);
    expect(writeSyncStorage.mock.calls).toEqual([
      [{ [StorageKeys.WAVEDROM_ENABLED]: false }],
      [{ [StorageKeys.ECHARTS_ENABLED]: false }],
    ]);
  });

  it('reads badge mode from local and clears the dismissed version only when enabling it', async () => {
    vi.mocked(chrome.storage.local.get).mockImplementation((...args: unknown[]) => {
      const result = { [StorageKeys.CHANGELOG_NOTIFY_MODE]: 'badge' };
      const callback = args[1];
      if (typeof callback === 'function') callback(result);
      return Promise.resolve(result);
    });
    await render();
    expect(settings.values.changelogBadgeMode).toBe(true);
    act(() => settings.hydrateFromStorage({ [StorageKeys.CHANGELOG_NOTIFY_MODE]: 'popup' }));
    expect(settings.values.changelogBadgeMode).toBe(true);

    act(() => settings.onChange({ changelogBadgeMode: false }));
    expect(settings.values.changelogBadgeMode).toBe(false);
    expect(chrome.storage.local.set).toHaveBeenLastCalledWith({
      [StorageKeys.CHANGELOG_NOTIFY_MODE]: 'popup',
    });
    act(() => settings.onChange({ changelogBadgeMode: true }));
    expect(settings.values.changelogBadgeMode).toBe(true);
    expect(chrome.storage.local.set).toHaveBeenLastCalledWith({
      [StorageKeys.CHANGELOG_NOTIFY_MODE]: 'badge',
      [StorageKeys.CHANGELOG_DISMISSED_VERSION]: '',
    });
    expect(writeSyncStorage).not.toHaveBeenCalled();
  });

  it('does not persist completion notifications when permission is denied', async () => {
    await render();
    await act(async () => settings.onChange({ responseCompleteNotificationEnabled: true }));
    expect(settings.values.responseCompleteNotificationEnabled).toBe(false);
    expect(settings.remoteAnnouncementPermissionGranted).toBe(false);
    expect(writeSyncStorage).not.toHaveBeenCalled();
    expect(requestSafariNativeNotificationPermission).not.toHaveBeenCalled();
  });

  it('persists completion notifications only after permission is granted', async () => {
    const permission = deferred<boolean>();
    vi.mocked(ensureNotificationsPermission).mockReturnValue(permission.promise);
    await render();
    act(() => settings.onChange({ responseCompleteNotificationEnabled: true }));
    expect(ensureNotificationsPermission).toHaveBeenCalledOnce();
    expect(writeSyncStorage).not.toHaveBeenCalled();
    await act(async () => permission.resolve(true));
    expect(settings.values.responseCompleteNotificationEnabled).toBe(true);
    expect(settings.remoteAnnouncementPermissionGranted).toBe(true);
    expect(writeSyncStorage).toHaveBeenCalledExactlyOnceWith({
      [StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED]: true,
    });
  });

  it.each([false, true])(
    'uses Safari native permission without a popup sync write (granted=%s)',
    async (granted) => {
      const permission = deferred<boolean>();
      vi.mocked(requestSafariNativeNotificationPermission).mockReturnValue(permission.promise);
      await render({ isSafariBrowser: true, canUseSystemNotifications: false });
      act(() => settings.onChange({ responseCompleteNotificationEnabled: true }));
      expect(settings.values.responseCompleteNotificationEnabled).toBe(true);
      expect(requestSafariNativeNotificationPermission).toHaveBeenCalledOnce();
      expect(ensureNotificationsPermission).not.toHaveBeenCalled();
      await act(async () => permission.resolve(granted));
      expect(settings.values.responseCompleteNotificationEnabled).toBe(granted);
      expect(settings.remoteAnnouncementPermissionGranted).toBe(false);
      expect(writeSyncStorage).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'disables completion notifications without asking permission (Safari=%s)',
    async (isSafariBrowser) => {
      await render({ isSafariBrowser });
      act(() =>
        settings.hydrateFromStorage({ [StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED]: true }),
      );
      await act(async () => settings.onChange({ responseCompleteNotificationEnabled: false }));
      expect(settings.values.responseCompleteNotificationEnabled).toBe(false);
      expect(writeSyncStorage).toHaveBeenCalledExactlyOnceWith({
        [StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED]: false,
      });
      expect(ensureNotificationsPermission).not.toHaveBeenCalled();
      expect(requestSafariNativeNotificationPermission).not.toHaveBeenCalled();
    },
  );

  it('checks announcement permission only when supported and ignores an obsolete read', async () => {
    const permission = deferred<boolean>();
    vi.mocked(hasNotificationsPermission).mockReturnValue(permission.promise);
    await render({ canUseSystemNotifications: false });
    expect(hasNotificationsPermission).not.toHaveBeenCalled();
    await render({ canUseSystemNotifications: true });
    expect(hasNotificationsPermission).toHaveBeenCalledOnce();
    await render({ canUseSystemNotifications: false });
    await act(async () => permission.resolve(true));
    expect(settings.remoteAnnouncementPermissionGranted).toBe(false);
  });

  it('hydrates granted announcement permission without changing any setting', async () => {
    vi.mocked(hasNotificationsPermission).mockResolvedValue(true);
    await render();
    expect(settings.remoteAnnouncementPermissionGranted).toBe(true);
    expect(settings.values.responseCompleteNotificationEnabled).toBe(false);
    expect(writeSyncStorage).not.toHaveBeenCalled();
  });

  it('updates announcement permission from the CTA without enabling completion notifications', async () => {
    await render();
    await act(async () => settings.requestRemoteAnnouncementSystemPermission());
    expect(settings.remoteAnnouncementPermissionGranted).toBe(false);
    vi.mocked(ensureNotificationsPermission).mockResolvedValue(true);
    await act(async () => settings.requestRemoteAnnouncementSystemPermission());
    expect(settings.remoteAnnouncementPermissionGranted).toBe(true);
    expect(settings.values.responseCompleteNotificationEnabled).toBe(false);
    expect(writeSyncStorage).not.toHaveBeenCalled();
  });
});
