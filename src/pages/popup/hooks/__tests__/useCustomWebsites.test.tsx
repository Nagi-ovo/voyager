import React, { act, useEffect } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { TranslationKey } from '@/utils/translations';

import { type CustomWebsitesOptions, useCustomWebsites } from '../useCustomWebsites';

const mocks = vi.hoisted(() => ({
  contains: vi.fn<(permissions: { origins: string[] }) => Promise<boolean>>(),
  request: vi.fn<(permissions: { origins: string[] }) => Promise<boolean>>(),
  remove: vi.fn<(permissions: { origins: string[] }) => Promise<boolean>>(),
  isFirefox: vi.fn<() => boolean>(),
  supported: vi.fn<() => boolean>(),
}));
vi.mock('webextension-polyfill', () => ({ default: { permissions: mocks } }));
vi.mock('@/core/utils/browser', () => ({
  isFirefox: mocks.isFirefox,
  supportsOptionalHostPermissions: mocks.supported,
}));

type Websites = ReturnType<typeof useCustomWebsites>;
const translate = (key: TranslationKey): string => key;

function Harness({
  options,
  capture,
}: {
  options: CustomWebsitesOptions;
  capture: (value: Websites) => void;
}) {
  const settings = useCustomWebsites(options);
  useEffect(() => {
    capture(settings);
  }, [capture, settings]);
  return null;
}

describe('useCustomWebsites', () => {
  let root: Root;
  let container: HTMLDivElement;
  let settings: Websites;
  let events: string[];
  let options: CustomWebsitesOptions;
  const write = vi.fn<(payload: Record<string, unknown>) => Promise<void>>();
  const refresh = vi.fn<() => Promise<void>>();
  const render = (overrides: Partial<CustomWebsitesOptions> = {}) => {
    options = { ...options, ...overrides };
    act(() => root.render(<Harness options={options} capture={(value) => (settings = value)} />));
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    events = [];
    mocks.isFirefox.mockReturnValue(false);
    mocks.supported.mockReturnValue(true);
    mocks.contains.mockImplementation(async () => {
      events.push('contains');
      return false;
    });
    mocks.request.mockImplementation(async () => {
      events.push('request');
      return true;
    });
    mocks.remove.mockImplementation(async () => {
      events.push('remove');
      return true;
    });
    write.mockImplementation(async () => {
      events.push('write');
    });
    refresh.mockImplementation(async () => {
      events.push('refresh');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    options = {
      t: translate,
      pluginManifests: [],
      refreshActiveTabContext: refresh,
      writeSyncStorage: write,
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    render();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const start = (action: 'add' | 'quick') =>
    action === 'add'
      ? settings.handleAddWebsite()
      : settings.toggleQuickWebsite('example.com', false);

  it('sanitizes legacy entries, retains either granted scheme and fails open on API errors', async () => {
    mocks.contains.mockImplementation(async ({ origins }) => {
      if (origins[0].includes('error.example')) throw new Error('Unavailable');
      return origins[0] === 'http://*.example.com/*';
    });
    await act(async () =>
      settings.hydrateFromStorage({
        [StorageKeys.PROMPT_CUSTOM_WEBSITES]: [
          ' HTTPS://WWW.Example.com/path ',
          'example.com',
          '<all_urls>',
          'missing.example',
          'error.example',
        ],
      }),
    );

    expect(settings.customWebsites).toEqual(['example.com', 'error.example']);
    expect(
      write.mock.calls.map(([payload]) => payload[StorageKeys.PROMPT_CUSTOM_WEBSITES]),
    ).toEqual([
      ['example.com', 'missing.example', 'error.example'],
      ['example.com', 'error.example'],
    ]);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('keeps hydration stable when translations, current tab or the catalog change', () => {
    const hydrate = settings.hydrateFromStorage;
    render({
      t: (key) => `translated:${key}`,
      refreshActiveTabContext: vi.fn(async () => {}),
      pluginManifests: [{ matches: ['https://claude.ai/*'] }],
    });
    expect(settings.hydrateFromStorage).toBe(hydrate);
    expect(mocks.contains).not.toHaveBeenCalled();
  });

  it.each(['add', 'quick'] as const)(
    'requests Firefox permission synchronously before %s persists',
    async (action) => {
      mocks.isFirefox.mockReturnValue(true);
      act(() => settings.onWebsiteInputChange(' HTTPS://WWW.Example.com/path '));
      let pending!: Promise<void>;
      act(() => {
        pending = start(action);
      });
      expect(events).toEqual(['request']);
      expect(mocks.request).toHaveBeenCalledWith({
        origins: ['https://*.example.com/*', 'http://*.example.com/*'],
      });
      await act(async () => pending);
      expect(events).toEqual(['request', 'refresh', 'write']);
      expect(settings.customWebsites).toEqual(['example.com']);
      if (action === 'add') expect(settings.newWebsiteInput).toBe('');
    },
  );

  it.each(['add', 'quick'] as const)('keeps Firefox denied %s out of storage', async (action) => {
    mocks.isFirefox.mockReturnValue(true);
    mocks.request.mockResolvedValue(false);
    act(() => settings.onWebsiteInputChange('example.com'));
    await act(async () => start(action));
    expect(settings.customWebsites).toEqual([]);
    expect(settings.newWebsiteInput).toBe('example.com');
    expect(settings.websiteError).toBe('permissionDenied');
    expect(write).not.toHaveBeenCalled();
    expect(mocks.contains).not.toHaveBeenCalled();
  });

  it.each(['add', 'quick'] as const)(
    'persists non-Firefox %s before requesting and rolls back a denial',
    async (action) => {
      mocks.contains.mockResolvedValueOnce(true);
      await act(async () =>
        settings.hydrateFromStorage({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: ['keep.example'] }),
      );
      events = [];
      mocks.request.mockImplementation(async () => {
        events.push('request');
        return false;
      });
      act(() => settings.onWebsiteInputChange('example.com'));
      let pending!: Promise<void>;
      act(() => {
        pending = start(action);
      });
      expect(events).toEqual(['write']);
      await act(async () => pending);
      expect(events).toEqual(['write', 'contains', 'request', 'write']);
      expect(
        write.mock.calls.map(([payload]) => payload[StorageKeys.PROMPT_CUSTOM_WEBSITES]),
      ).toEqual([['keep.example', 'example.com'], ['keep.example']]);
      expect(settings.customWebsites).toEqual(['keep.example']);
      expect(settings.websiteError).toBe('permissionDenied');
      if (action === 'add') expect(settings.newWebsiteInput).toBe('');
    },
  );

  it('reuses a non-Firefox grant and refreshes the active tab after persisting', async () => {
    mocks.contains.mockImplementation(async () => {
      events.push('contains');
      return true;
    });
    act(() => settings.onWebsiteInputChange('example.com'));
    await act(async () => settings.handleAddWebsite());
    expect(events).toEqual(['write', 'contains', 'refresh']);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('rejects invalid and duplicate input without requesting permission or writing', async () => {
    for (const input of ['', '<all_urls>', 'localhost']) {
      act(() => settings.onWebsiteInputChange(input));
      await act(async () => settings.handleAddWebsite());
    }
    expect(settings.websiteError).toBe('invalidUrl');
    mocks.contains.mockResolvedValue(true);
    await act(async () =>
      settings.hydrateFromStorage({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: ['example.com'] }),
    );
    act(() => settings.onWebsiteInputChange('https://www.example.com/path'));
    expect(settings.websiteError).toBe('');
    await act(async () => settings.handleAddWebsite());
    expect(settings.websiteError).toBe('invalidUrl');
    expect(write).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('reports unsupported Firefox and request errors without saving a selection', async () => {
    mocks.isFirefox.mockReturnValue(true);
    mocks.supported.mockReturnValue(false);
    await act(async () => settings.toggleQuickWebsite('example.com', false));
    expect(settings.websiteError).toBe('pluginUnsupportedPlatform');
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.supported.mockReturnValue(true);
    mocks.request.mockRejectedValue(new Error('Request failed'));
    await act(async () => settings.toggleQuickWebsite('example.com', false));
    expect(settings.websiteError).toBe('permissionRequestFailed');
    expect(write).not.toHaveBeenCalled();
  });

  it.each(['remove', 'quick'] as const)(
    '%s preserves permissions required anywhere in the full plugin catalog',
    async (action) => {
      mocks.contains.mockResolvedValue(true);
      await act(async () =>
        settings.hydrateFromStorage({
          [StorageKeys.PROMPT_CUSTOM_WEBSITES]: ['example.com', 'claude.ai'],
        }),
      );
      render({
        pluginManifests: [
          { matches: ['https://chatgpt.com/*'] },
          { matches: ['https://claude.ai/*'] },
        ],
      });
      await act(async () =>
        action === 'remove'
          ? settings.handleRemoveWebsite('claude.ai')
          : settings.toggleQuickWebsite('claude.ai', true),
      );
      expect(settings.customWebsites).toEqual(['example.com']);
      expect(write).toHaveBeenCalledWith({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: ['example.com'] });
      expect(mocks.remove).not.toHaveBeenCalled();
    },
  );

  it('removes an ordinary host grant only after persisting the reduced website list', async () => {
    mocks.contains.mockResolvedValue(true);
    await act(async () =>
      settings.hydrateFromStorage({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: ['example.com'] }),
    );
    events = [];
    await act(async () => settings.handleRemoveWebsite('example.com'));
    expect(events).toEqual(['write', 'remove']);
    expect(mocks.remove).toHaveBeenCalledWith({
      origins: ['https://*.example.com/*', 'http://*.example.com/*'],
    });
    expect(settings.customWebsites).toEqual([]);
  });
});
