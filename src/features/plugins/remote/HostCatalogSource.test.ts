import { describe, expect, it, vi } from 'vitest';

import type { PluginManifest } from '../types';
import { HostCatalogSource } from './HostCatalogSource';
import type { HostCatalogCacheEntry } from './hostCatalogCache';

function manifest(id: string): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: 'd',
    author: 'a',
    category: 'other',
    license: 'MIT',
    engine: '>=1.0.0',
    tier: 'declarative',
    matches: ['https://chat.deepseek.com/*'],
    contributes: {},
  };
}

function entry(overrides: Partial<HostCatalogCacheEntry> = {}): HostCatalogCacheEntry {
  return {
    host: 'chat.deepseek.com',
    status: 'ok',
    manifests: [manifest('voyager.remote')],
    fetchedAt: 1,
    lastAttemptAt: 1,
    failureCount: 0,
    extensionVersion: '1.8.3',
    ...overrides,
  };
}

describe('HostCatalogSource', () => {
  it('serves the cached catalog for the context host and is authoritative for it', async () => {
    const loadEntry = vi.fn(async () => entry());
    const source = new HostCatalogSource({ extensionVersion: '1.8.3', loadEntry, enabled: true });
    const context = { host: 'chat.deepseek.com' };

    expect((await source.list(context)).map((m) => m.id)).toEqual(['voyager.remote']);
    expect(await source.isAuthoritative(context)).toBe(true);
    expect(loadEntry).toHaveBeenCalledWith('chat.deepseek.com');
  });

  it('yields nothing without a host, for an ineligible host, or when the build disables remote', async () => {
    const loadEntry = vi.fn(async () => entry());
    const source = new HostCatalogSource({ extensionVersion: '1.8.3', loadEntry, enabled: true });
    expect(await source.list()).toEqual([]);
    expect(await source.list({ host: '*.frame.claudeusercontent.com' })).toEqual([]);
    expect(loadEntry).not.toHaveBeenCalled();

    const disabled = new HostCatalogSource({
      extensionVersion: '1.8.3',
      loadEntry,
      enabled: false,
    });
    expect(await disabled.list({ host: 'chat.deepseek.com' })).toEqual([]);
    expect(await disabled.isAuthoritative({ host: 'chat.deepseek.com' })).toBe(false);
    expect(loadEntry).not.toHaveBeenCalled();
  });

  it('is not authoritative for a 404, an unfetched host, or an entry from another version', async () => {
    const context = { host: 'chat.deepseek.com' };
    for (const stale of [
      entry({ status: 'missing', manifests: [] }),
      entry({ status: 'unknown', manifests: [] }),
      entry({ extensionVersion: '1.8.2' }),
      null,
    ]) {
      const source = new HostCatalogSource({
        extensionVersion: '1.8.3',
        loadEntry: async () => stale,
        enabled: true,
      });
      expect(await source.list(context)).toEqual([]);
      expect(await source.isAuthoritative(context)).toBe(false);
    }
  });

  it('answers manifests and authority from one cache read so a mid-listing write cannot split them', async () => {
    // First read sees an unfetched host, the second a fresh catalog: two
    // separate reads would report "no manifests" yet "authoritative".
    const loadEntry = vi
      .fn<() => Promise<HostCatalogCacheEntry | null>>()
      .mockResolvedValueOnce(entry({ status: 'unknown', manifests: [] }))
      .mockResolvedValueOnce(entry());
    const source = new HostCatalogSource({ extensionVersion: '1.8.3', loadEntry, enabled: true });

    const listing = await source.listWithAuthority({ host: 'chat.deepseek.com' });
    expect(loadEntry).toHaveBeenCalledTimes(1);
    expect(listing).toEqual({ manifests: [], authoritative: false });

    const next = await source.listWithAuthority({ host: 'chat.deepseek.com' });
    expect(next.authoritative).toBe(true);
    expect(next.manifests.map((m) => m.id)).toEqual(['voyager.remote']);
  });
});
