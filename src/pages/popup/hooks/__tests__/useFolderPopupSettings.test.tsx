import React, { act, useEffect } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountPlatform } from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';

import { useFolderPopupSettings } from '../useFolderPopupSettings';

type FolderSettings = ReturnType<typeof useFolderPopupSettings>;

function Harness({
  capture,
  ...options
}: Parameters<typeof useFolderPopupSettings>[0] & {
  capture: (settings: FolderSettings) => void;
}) {
  const settings = useFolderPopupSettings(options);
  useEffect(() => {
    capture(settings);
  }, [capture, settings]);
  return null;
}

describe('useFolderPopupSettings', () => {
  let container: HTMLDivElement;
  let root: Root;
  let settings: FolderSettings;
  const writeSyncStorage = vi.fn(async (_payload: Record<string, unknown>) => {});

  const render = (activeAccountPlatform: AccountPlatform = 'gemini') => {
    act(() => {
      root.render(
        <Harness
          activeAccountPlatform={activeAccountPlatform}
          writeSyncStorage={writeSyncStorage}
          capture={(next) => (settings = next)}
        />,
      );
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    writeSyncStorage.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    render();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('hydrates folder controls and account isolation without writing storage', () => {
    act(() =>
      settings.hydrateFromStorage({
        geminiFolderEnabled: false,
        [StorageKeys.FOLDER_FLOATING_MODE_ENABLED]: true,
        [StorageKeys.FOLDER_FLOATING_OPEN_ON_START]: false,
        geminiFolderHideArchivedConversations: true,
        [StorageKeys.FOLDER_SEARCH_ENABLED]: false,
        [StorageKeys.FORK_ENABLED]: true,
        [StorageKeys.FOLDER_PROJECT_ENABLED]: true,
        [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI]: true,
      }),
    );
    expect(settings.values).toEqual({
      folderEnabled: false,
      floatingModeEnabled: true,
      floatingOpenOnStart: false,
      hideArchivedConversations: true,
      folderSearchEnabled: false,
      forkEnabled: true,
      folderProjectEnabled: true,
    });
    expect(settings.accountIsolationEnabled).toBe(true);
    expect(writeSyncStorage).not.toHaveBeenCalled();
  });

  it('falls back to legacy isolation while preserving an explicit platform false', () => {
    act(() =>
      settings.hydrateFromStorage({
        [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED]: true,
        [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI]: false,
        [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_AISTUDIO]: null,
      }),
    );
    expect(settings.accountIsolationEnabled).toBe(false);
    render('aistudio');
    expect(settings.accountIsolationEnabled).toBe(true);
    render('gemini');
    expect(settings.accountIsolationEnabled).toBe(false);
    expect(writeSyncStorage).not.toHaveBeenCalled();
  });

  it('edits the active platform independently and retains each choice across platform switches', () => {
    act(() => settings.onAccountIsolationChange(true));
    expect(settings.accountIsolationEnabled).toBe(true);
    render('aistudio');
    expect(settings.accountIsolationEnabled).toBe(false);
    act(() => settings.onAccountIsolationChange(true));
    render('gemini');
    expect(settings.accountIsolationEnabled).toBe(true);
    act(() => settings.onAccountIsolationChange(false));
    render('aistudio');
    expect(settings.accountIsolationEnabled).toBe(true);
    expect(writeSyncStorage.mock.calls).toEqual([
      [{ [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI]: true }],
      [{ [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_AISTUDIO]: true }],
      [{ [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI]: false }],
    ]);
  });

  it('writes sparse false changes using the existing folder keys', () => {
    act(() =>
      settings.hydrateFromStorage({
        geminiFolderEnabled: true,
        geminiFolderHideArchivedConversations: true,
        [StorageKeys.FORK_ENABLED]: true,
        [StorageKeys.FOLDER_PROJECT_ENABLED]: true,
      }),
    );
    const before = settings.values;
    act(() => settings.onChange({ folderEnabled: false, hideArchivedConversations: false }));
    expect(settings.values).toEqual({
      ...before,
      folderEnabled: false,
      hideArchivedConversations: false,
    });
    expect(writeSyncStorage).toHaveBeenCalledExactlyOnceWith({
      geminiFolderEnabled: false,
      geminiFolderHideArchivedConversations: false,
    });
  });

  it('preserves the startup preference when floating mode is turned off and back on', () => {
    act(() =>
      settings.hydrateFromStorage({
        [StorageKeys.FOLDER_FLOATING_MODE_ENABLED]: true,
        [StorageKeys.FOLDER_FLOATING_OPEN_ON_START]: false,
      }),
    );
    act(() => settings.onChange({ floatingModeEnabled: false }));
    expect(settings.values.floatingModeEnabled).toBe(false);
    expect(settings.values.floatingOpenOnStart).toBe(false);
    act(() => settings.onChange({ floatingModeEnabled: true }));
    expect(settings.values.floatingModeEnabled).toBe(true);
    expect(settings.values.floatingOpenOnStart).toBe(false);
    expect(writeSyncStorage.mock.calls).toEqual([
      [{ [StorageKeys.FOLDER_FLOATING_MODE_ENABLED]: false }],
      [{ [StorageKeys.FOLDER_FLOATING_MODE_ENABLED]: true }],
    ]);
  });
});
