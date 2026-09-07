import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginManifest } from '../types';
import {
  type HostCatalogCacheEntry,
  hostCatalogSignature,
  hostCatalogStorageKey,
  isHostCatalogStorageKey,
  loadHostCatalogCache,
  normalizeHostCatalogCacheEntry,
  saveHostCatalogCache,
  siteAdapterFromEntry,
  subscribeHostCatalog,
} from './hostCatalogCache';

const SITE = {
  id: 'deepseek',
  label: 'DeepSeek',
  matches: ['https://chat.deepseek.com/*'],
  selectors: { userTurn: '.ds-message.user' },
  theme: { hostSelector: 'body', lightSelector: 'body.light', darkSelector: 'body.dark' },
  brandColor: '#abcdef',
  capabilities: ['chat'],
};

const HOST = 'chat.deepseek.com';
const KEY = 'gvPluginHostCatalog:chat.deepseek.com';

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
    host: HOST,
    status: 'ok',
    manifests: [manifest('voyager.a')],
    fetchedAt: 10,
    lastAttemptAt: 10,
    failureCount: 0,
    extensionVersion: '1.8.3',
    ...overrides,
  };
}

/** Grab the listener subscribeHostCatalog registered on chrome.storage.onChanged. */
function registeredListener(): (
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
) => void {
  const addListener = chrome.storage.onChanged.addListener as unknown as Mock;
  return addListener.mock.calls[addListener.mock.calls.length - 1][0];
}

beforeEach(() => {
  (chrome.storage.onChanged.addListener as unknown as Mock).mockClear();
  (chrome.storage.onChanged.removeListener as unknown as Mock).mockClear();
});

afterEach(() => {
  (chrome.storage.local.get as unknown as Mock).mockReset?.();
  (chrome.storage.local.set as unknown as Mock).mockReset?.();
});

describe('host catalog storage keys', () => {
  it('prefixes the host and recognises its own keys', () => {
    expect(hostCatalogStorageKey(HOST)).toBe(KEY);
    expect(isHostCatalogStorageKey(KEY)).toBe(true);
    expect(isHostCatalogStorageKey('gvPluginHostCatalog:')).toBe(false);
    expect(isHostCatalogStorageKey('gvPluginCatalogCache')).toBe(false);
  });
});

describe('normalizeHostCatalogCacheEntry', () => {
  it('round-trips a valid entry and drops manifests that fail validation', () => {
    const stored = { ...entry(), manifests: [manifest('voyager.a'), { id: '' }] };
    const normalized = normalizeHostCatalogCacheEntry(stored, HOST);
    expect(normalized?.manifests.map((m) => m.id)).toEqual(['voyager.a']);
    expect(normalized?.status).toBe('ok');
    expect(normalized?.extensionVersion).toBe('1.8.3');
  });

  it('rejects entries written for another host and coerces unknown statuses', () => {
    expect(normalizeHostCatalogCacheEntry(entry({ host: 'claude.ai' }), HOST)).toBeNull();
    expect(normalizeHostCatalogCacheEntry(null, HOST)).toBeNull();
    const odd = normalizeHostCatalogCacheEntry(
      { ...entry(), status: 'weird', failureCount: -3, fetchedAt: 'x' },
      HOST,
    );
    expect(odd?.status).toBe('unknown');
    expect(odd?.manifests).toEqual([]);
    expect(odd?.failureCount).toBe(0);
    expect(odd?.fetchedAt).toBe(0);
  });
});

describe('load / save', () => {
  it('reads the per-host key and writes the entry under it', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({ [KEY]: entry() });
    const loaded = await loadHostCatalogCache(HOST);
    expect(loaded?.manifests.map((m) => m.id)).toEqual(['voyager.a']);
    expect((chrome.storage.local.get as unknown as Mock).mock.calls[0][0]).toEqual({ [KEY]: null });

    (chrome.storage.local.set as unknown as Mock).mockResolvedValue(undefined);
    await saveHostCatalogCache(entry({ failureCount: 2 }));
    expect((chrome.storage.local.set as unknown as Mock).mock.calls[0][0]).toEqual({
      [KEY]: entry({ failureCount: 2 }),
    });
  });

  it('returns null when storage throws', async () => {
    (chrome.storage.local.get as unknown as Mock).mockRejectedValue(new Error('boom'));
    expect(await loadHostCatalogCache(HOST)).toBeNull();
  });
});

describe('subscribeHostCatalog', () => {
  it('fires only when the manifest content, status or writer version changes', () => {
    const callback = vi.fn();
    subscribeHostCatalog(HOST, callback);
    const listener = registeredListener();

    // Bookkeeping-only rewrite (failed attempt): same content → silent.
    listener(
      { [KEY]: { oldValue: entry(), newValue: entry({ lastAttemptAt: 99, failureCount: 1 }) } },
      'local',
    );
    expect(callback).not.toHaveBeenCalled();

    // New plugin set → fires.
    listener(
      { [KEY]: { oldValue: entry(), newValue: entry({ manifests: [manifest('voyager.b')] }) } },
      'local',
    );
    expect(callback).toHaveBeenCalledTimes(1);

    // Status flip to missing → fires (the snapshot takes over).
    listener({ [KEY]: { oldValue: entry(), newValue: entry({ status: 'missing' }) } }, 'local');
    expect(callback).toHaveBeenCalledTimes(2);

    // Same content rewritten by a new extension version → fires (entry became usable).
    listener(
      { [KEY]: { oldValue: entry(), newValue: entry({ extensionVersion: '1.9.0' }) } },
      'local',
    );
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('also reports bookkeeping-only writes when asked to (popup "last checked")', () => {
    const callback = vi.fn();
    subscribeHostCatalog(HOST, callback, { includeBookkeeping: true });
    const listener = registeredListener();
    listener(
      { [KEY]: { oldValue: entry(), newValue: entry({ lastAttemptAt: 99, failureCount: 1 }) } },
      'local',
    );
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('ignores other hosts, other areas and the legacy whole-catalog key', () => {
    const callback = vi.fn();
    subscribeHostCatalog(HOST, callback);
    const listener = registeredListener();
    listener(
      { 'gvPluginHostCatalog:claude.ai': { newValue: entry({ host: 'claude.ai' }) } },
      'local',
    );
    listener({ [KEY]: { newValue: entry({ manifests: [] }) } }, 'sync');
    listener({ gvPluginCatalogCache: { newValue: { manifests: [], fetchedAt: 1 } } }, 'local');
    expect(callback).not.toHaveBeenCalled();
  });

  it('detaches on unsubscribe', () => {
    const unsubscribe = subscribeHostCatalog(HOST, vi.fn());
    const listener = registeredListener();
    unsubscribe();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(listener);
  });
});

describe('site override on the entry', () => {
  it('keeps a valid site through normalisation and drops an invalid one', () => {
    expect(normalizeHostCatalogCacheEntry(entry({ site: SITE }), HOST)?.site).toEqual(SITE);
    expect(
      normalizeHostCatalogCacheEntry(entry({ site: { ...SITE, brandColor: 'red' } }), HOST)?.site,
    ).toBeUndefined();
    expect(
      normalizeHostCatalogCacheEntry(entry({ status: 'missing', site: SITE }), HOST)?.site,
    ).toBeUndefined();
  });

  it('exposes the site only for a usable entry', () => {
    expect(siteAdapterFromEntry(entry({ site: SITE }), '1.8.3')?.brandColor).toBe('#abcdef');
    expect(siteAdapterFromEntry(entry({ site: SITE }), '1.8.3')?.capabilities).toEqual(
      new Set(['chat']),
    );
    expect(
      siteAdapterFromEntry(entry({ site: SITE, extensionVersion: '1.8.2' }), '1.8.3'),
    ).toBeNull();
    expect(siteAdapterFromEntry(entry({ site: SITE, status: 'missing' }), '1.8.3')).toBeNull();
    expect(siteAdapterFromEntry(entry(), '1.8.3')).toBeNull();
    expect(siteAdapterFromEntry(null, '1.8.3')).toBeNull();
  });

  it('a changed site wakes subscribers even when the plugin set is unchanged', () => {
    const callback = vi.fn();
    subscribeHostCatalog(HOST, callback);
    const listener = registeredListener();
    listener({ [KEY]: { oldValue: entry(), newValue: entry({ site: SITE }) } }, 'local');
    listener(
      {
        [KEY]: {
          oldValue: entry({ site: SITE }),
          newValue: entry({ site: { ...SITE, brandColor: '#000000' } }),
        },
      },
      'local',
    );
    expect(callback).toHaveBeenCalledTimes(2);
  });
});

describe('hostCatalogSignature', () => {
  it('ignores attempt bookkeeping and empties manifests for non-ok entries', () => {
    expect(hostCatalogSignature(entry())).toBe(
      hostCatalogSignature(entry({ lastAttemptAt: 5, failureCount: 4, fetchedAt: 1 })),
    );
    expect(hostCatalogSignature(entry({ status: 'missing' }))).toBe(
      hostCatalogSignature(entry({ status: 'missing', manifests: [] })),
    );
    expect(hostCatalogSignature(undefined)).toBe('');
  });
});
