import React, { act, useEffect } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { usePopupReleaseInfo } from '../usePopupReleaseInfo';

vi.mock('webextension-polyfill', () => ({
  default: { storage: { local: { get: vi.fn(), set: vi.fn() } } },
}));

type ReleaseInfo = ReturnType<typeof usePopupReleaseInfo>;

function Harness({
  isSafariBrowser,
  capture,
}: {
  isSafariBrowser: boolean;
  capture: (info: ReleaseInfo) => void;
}) {
  const info = usePopupReleaseInfo(isSafariBrowser);
  useEffect(() => {
    capture(info);
  }, [capture, info]);
  return null;
}

describe('usePopupReleaseInfo', () => {
  const cacheKey = 'gvLatestVersionCache';
  const now = Date.UTC(2026, 8, 8, 12);
  const minute = 60_000;
  const dmgUrl = 'https://github.com/Nagi-ovo/voyager/releases/download/v1.9.1/Voyager.dmg';
  let container: HTMLDivElement;
  let root: Root;
  let info: ReleaseInfo;
  let manifest: chrome.runtime.Manifest;
  const fetchRelease = vi.fn<typeof fetch>();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubEnv('ENABLE_SAFARI_UPDATE_CHECK', 'false');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Chrome/140.0.0.0 Safari/537.36');
    vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Google Inc.');
    manifest = { manifest_version: 3, name: 'Voyager', version: '1.8.3' };
    vi.stubGlobal('chrome', {
      ...chrome,
      runtime: { ...chrome.runtime, getManifest: vi.fn(() => manifest) },
    });
    vi.stubGlobal('fetch', fetchRelease);
    fetchRelease.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.9.1',
          assets: [{ name: 'Voyager.dmg', browser_download_url: dmgUrl }],
        }),
        { status: 200 },
      ),
    );
    vi.mocked(browser.storage.local.get).mockResolvedValue({});
    vi.mocked(browser.storage.local.set).mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const render = async (isSafariBrowser = false) => {
    if (isSafariBrowser) {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Version/18.0 Safari/605.1.15');
      vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Apple Computer, Inc.');
    }
    await act(async () => {
      root.render(<Harness isSafariBrowser={isSafariBrowser} capture={(next) => (info = next)} />);
    });
  };

  it('leaves store installations to automatic updates without reading cache or fetching', async () => {
    manifest = { ...manifest, update_url: 'https://clients2.google.com/service/update2/crx' };
    await render();
    expect(info.extVersion).toBe('1.8.3');
    expect(info.releaseUrl).toBe('https://github.com/Nagi-ovo/voyager/releases/tag/v1.8.3');
    expect(info.hasUpdate).toBe(false);
    expect(browser.storage.local.get).not.toHaveBeenCalled();
    expect(fetchRelease).not.toHaveBeenCalled();
  });

  it('uses a fresh cached version without fetching or rewriting it', async () => {
    vi.mocked(browser.storage.local.get).mockResolvedValue({
      [cacheKey]: { version: 'v1.9.0', fetchedAt: now - 60 * minute },
    });
    await render();
    expect(info.normalizedLatestVersion).toBe('1.9.0');
    expect(info.latestReleaseUrl).toBe('https://github.com/Nagi-ovo/voyager/releases/tag/v1.9.0');
    expect(fetchRelease).not.toHaveBeenCalled();
    expect(browser.storage.local.set).not.toHaveBeenCalled();
  });

  it('fetches a replacement when the six-hour version cache expires', async () => {
    vi.mocked(browser.storage.local.get).mockResolvedValue({
      [cacheKey]: { version: 'v1.9.0', fetchedAt: now - 360 * minute },
    });
    await render();
    expect(fetchRelease).toHaveBeenCalledExactlyOnceWith(
      'https://api.github.com/repos/Nagi-ovo/voyager/releases/latest',
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    expect(info.normalizedLatestVersion).toBe('1.9.1');
    expect(browser.storage.local.set).toHaveBeenCalledExactlyOnceWith({
      [cacheKey]: { version: 'v1.9.1', fetchedAt: now },
    });
  });

  it('does not check Safari releases when its build flag is disabled', async () => {
    await render(true);
    expect(info.hasUpdate).toBe(false);
    expect(browser.storage.local.get).not.toHaveBeenCalled();
    expect(fetchRelease).not.toHaveBeenCalled();
  });

  it('waits thirty minutes before retrying a Safari release without a DMG', async () => {
    vi.stubEnv('ENABLE_SAFARI_UPDATE_CHECK', 'true');
    vi.mocked(browser.storage.local.get).mockResolvedValue({
      [cacheKey]: { version: 'v1.9.0', fetchedAt: now - 29 * minute, dmgUrl: null },
    });
    await render(true);
    expect(info.normalizedLatestVersion).toBe('1.9.0');
    expect(info.safariDmgUrl).toBeNull();
    expect(info.hasUpdate).toBe(true);
    expect(fetchRelease).not.toHaveBeenCalled();
    expect(browser.storage.local.set).not.toHaveBeenCalled();
  });

  it('refreshes and caches the Safari DMG after the thirty-minute retry interval', async () => {
    vi.stubEnv('ENABLE_SAFARI_UPDATE_CHECK', 'true');
    vi.mocked(browser.storage.local.get).mockResolvedValue({
      [cacheKey]: { version: 'v1.9.0', fetchedAt: now - 30 * minute, dmgUrl: null },
    });
    await render(true);
    expect(fetchRelease).toHaveBeenCalledOnce();
    expect(info.normalizedLatestVersion).toBe('1.9.1');
    expect(info.safariDmgUrl).toBe(dmgUrl);
    expect(info.hasUpdate).toBe(true);
    expect(browser.storage.local.set).toHaveBeenCalledExactlyOnceWith({
      [cacheKey]: { version: 'v1.9.1', fetchedAt: now, dmgUrl },
    });
  });
});
