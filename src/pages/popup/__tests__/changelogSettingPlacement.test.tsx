import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LanguageProvider } from '@/contexts/LanguageContext';
import { StorageKeys } from '@/core/types/common';
import { TRANSLATIONS } from '@/utils/translations';

import Popup from '../Popup';

const extensionApi = vi.hoisted(() => ({
  storage: {
    sync: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), getBytesInUse: vi.fn() },
    local: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), getBytesInUse: vi.fn() },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  tabs: { get: vi.fn(), query: vi.fn(), sendMessage: vi.fn(), create: vi.fn() },
  runtime: {
    id: 'test-extension-id',
    getManifest: vi.fn(),
    getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  permissions: { contains: vi.fn(), request: vi.fn() },
  notifications: { create: vi.fn() },
  i18n: { getUILanguage: vi.fn(() => 'en'), getMessage: vi.fn((key: string) => key) },
}));

// Keep Popup and its settings components/hooks real; replace only browser APIs.
vi.mock('webextension-polyfill', () => ({ default: extensionApi }));

function readStorage(keys: unknown, stored: Record<string, unknown>): Record<string, unknown> {
  if (typeof keys === 'string') return { [keys]: stored[keys] };
  if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, stored[key]]));
  if (keys && typeof keys === 'object') {
    return Object.fromEntries(
      Object.entries(keys).map(([key, fallback]) => [
        key,
        Object.hasOwn(stored, key) ? stored[key] : fallback,
      ]),
    );
  }
  return { ...stored };
}

describe('changelog notification setting in Popup', () => {
  let container: HTMLDivElement;
  let root: Root;
  let local: Record<string, unknown>;
  let sync: Record<string, unknown>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.stubGlobal('chrome', extensionApi);
    local = {
      [StorageKeys.CHANGELOG_NOTIFY_MODE]: 'badge',
      [StorageKeys.CHANGELOG_DISMISSED_VERSION]: '1.8.2',
    };
    sync = { [StorageKeys.MERMAID_ENABLED]: false };
    for (const [area, stored] of [
      ['local', local],
      ['sync', sync],
    ] as const) {
      extensionApi.storage[area].get.mockImplementation((keys: unknown, callback?: unknown) => {
        const result = readStorage(keys, stored);
        if (typeof callback === 'function') callback(result);
        return Promise.resolve(result);
      });
      extensionApi.storage[area].set.mockImplementation(
        (updates: Record<string, unknown>, callback?: unknown) => {
          Object.assign(stored, updates);
          if (typeof callback === 'function') callback();
          return Promise.resolve();
        },
      );
      extensionApi.storage[area].getBytesInUse.mockResolvedValue(0);
    }
    extensionApi.runtime.getManifest.mockReturnValue({
      version: '1.8.3',
      update_url: 'https://clients2.google.com/service/update2/crx',
    });
    extensionApi.runtime.sendMessage.mockResolvedValue(undefined);
    extensionApi.tabs.query.mockResolvedValue([{ id: 7, url: 'https://gemini.google.com/app' }]);
    extensionApi.tabs.sendMessage.mockResolvedValue(undefined);
    extensionApi.permissions.contains.mockResolvedValue(false);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const mount = async () => {
    await act(async () => {
      root.render(
        <LanguageProvider>
          <Popup />
        </LanguageProvider>,
      );
    });
  };

  it('hydrates the badge inside General Options and toggles only local preferences', async () => {
    await mount();
    const generalHeading = Array.from(container.querySelectorAll('h3')).find(
      (heading) => heading.textContent === TRANSLATIONS.en.generalOptions,
    );
    expect(generalHeading).toBeDefined();
    const generalCard = generalHeading!.parentElement!;
    const badge = generalCard.querySelector<HTMLInputElement>('#changelog-notify-badge');
    expect(badge).not.toBeNull();
    expect(container.querySelectorAll('#changelog-notify-badge')).toHaveLength(1);
    expect(badge!.checked).toBe(true);
    expect(badge!.disabled).toBe(false);
    expect(generalCard.textContent).toContain(TRANSLATIONS.en.changelog_badge_mode_hint);

    extensionApi.storage.local.set.mockClear();
    extensionApi.storage.sync.set.mockClear();
    await act(async () => badge!.click());
    expect(badge!.checked).toBe(false);
    expect(extensionApi.storage.local.set).toHaveBeenLastCalledWith({
      [StorageKeys.CHANGELOG_NOTIFY_MODE]: 'popup',
    });
    expect(local[StorageKeys.CHANGELOG_DISMISSED_VERSION]).toBe('1.8.2');

    await act(async () => badge!.click());
    expect(badge!.checked).toBe(true);
    expect(extensionApi.storage.local.set).toHaveBeenLastCalledWith({
      [StorageKeys.CHANGELOG_NOTIFY_MODE]: 'badge',
      [StorageKeys.CHANGELOG_DISMISSED_VERSION]: '',
    });
    expect(extensionApi.storage.local.set).toHaveBeenCalledTimes(2);
    expect(extensionApi.storage.sync.set).not.toHaveBeenCalled();
    expect(
      extensionApi.storage.local.get.mock.calls.filter(
        ([key]) => key === StorageKeys.CHANGELOG_NOTIFY_MODE,
      ),
    ).toHaveLength(1);
  });

  it('hydrates General from one bulk read and keeps that read stable after a setting changes', async () => {
    await mount();
    const generalReads = () =>
      extensionApi.storage.sync.get.mock.calls.filter(
        ([keys]) =>
          keys && typeof keys === 'object' && Object.hasOwn(keys, StorageKeys.MERMAID_ENABLED),
      );
    expect(generalReads()).toHaveLength(1);
    expect(generalReads()[0][0]).toMatchObject({
      [StorageKeys.MERMAID_ENABLED]: true,
      [StorageKeys.HIGHLIGHT_ENABLED]: false,
      [StorageKeys.WAVEDROM_ENABLED]: true,
      [StorageKeys.ECHARTS_ENABLED]: true,
      [StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED]: false,
    });
    const mermaid = container.querySelector<HTMLInputElement>('#mermaid-enabled')!;
    expect(mermaid.checked).toBe(false);
    expect(container.querySelector<HTMLInputElement>('#highlights-enabled')!.checked).toBe(false);
    expect(extensionApi.storage.sync.set).not.toHaveBeenCalled();

    await act(async () => mermaid.click());
    expect(mermaid.checked).toBe(true);
    expect(extensionApi.storage.sync.set).toHaveBeenCalledExactlyOnceWith({
      [StorageKeys.MERMAID_ENABLED]: true,
    });
    expect(generalReads()).toHaveLength(1);
  });
});
