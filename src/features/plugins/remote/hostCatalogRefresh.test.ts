import { describe, expect, it, vi } from 'vitest';

import { validateManifest } from '../manifest/validate';
import type { PluginManifest } from '../types';
import type { HostCatalogCacheEntry } from './hostCatalogCache';
import { HostCatalogRefresher, parseHostCatalogRefreshPayload } from './hostCatalogRefresh';
import type { PluginCatalogSettings } from './hostCatalogSettings';

const HOST = 'chat.deepseek.com';
const URL_FOR_HOST = 'https://voyager.nagi.fun/catalog/hosts/chat.deepseek.com.json';
const HOUR = 60 * 60 * 1000;

const RAW_PLUGIN = {
  id: 'voyager.deepseek-reading-width',
  name: 'DeepSeek · Reading width',
  version: '1.1.0',
  description: 'd',
  author: 'voyager-official',
  category: 'readability',
  license: 'MIT',
  engine: '>=1.2.0',
  tier: 'declarative',
  matches: ['https://chat.deepseek.com/*'],
  contributes: { styles: [{ css: 'body{--x:1}' }] },
};

function catalogFile(plugins: unknown[] = [RAW_PLUGIN]) {
  return { format: 1, host: HOST, generatedAt: '2026-09-07T00:00:00.000Z', plugins };
}

/** Cached entries hold VALIDATED manifests, exactly as the refresher writes them. */
function manifest(id: string): PluginManifest {
  const result = validateManifest({ ...RAW_PLUGIN, id });
  if (!result.success) throw new Error('fixture manifest must validate');
  return result.data;
}

function entry(overrides: Partial<HostCatalogCacheEntry> = {}): HostCatalogCacheEntry {
  return {
    host: HOST,
    status: 'ok',
    manifests: [manifest('voyager.deepseek-reading-width')],
    fetchedAt: 0,
    lastAttemptAt: 0,
    failureCount: 0,
    extensionVersion: '1.8.3',
    ...overrides,
  };
}

type FetchStub = ReturnType<typeof vi.fn>;

function makeFetch(handler: (url: string) => { status: number; body?: unknown }): FetchStub {
  return vi.fn(async (url: string) => {
    const { status, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  });
}

interface Harness {
  readonly refresher: HostCatalogRefresher;
  readonly fetchImpl: FetchStub;
  readonly saved: HostCatalogCacheEntry[];
}

function harness(options: {
  entry?: HostCatalogCacheEntry | null;
  settings?: Partial<PluginCatalogSettings>;
  now?: number;
  eligible?: boolean;
  enabled?: boolean;
  respond?: (url: string) => { status: number; body?: unknown };
}): Harness {
  const saved: HostCatalogCacheEntry[] = [];
  const fetchImpl = makeFetch(options.respond ?? (() => ({ status: 200, body: catalogFile() })));
  const refresher = new HostCatalogRefresher({
    baseUrl: 'https://voyager.nagi.fun/catalog',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => options.now ?? 10 * HOUR,
    extensionVersion: '1.8.3',
    enabled: options.enabled ?? true,
    loadSettings: async () => ({
      onlineUpdatesEnabled: true,
      checkInterval: '6h',
      ...options.settings,
    }),
    loadEntry: async () => options.entry ?? null,
    saveEntry: async (next) => {
      saved.push(next);
    },
    isHostEligible: async () => options.eligible ?? true,
  });
  return { refresher, fetchImpl, saved };
}

describe('HostCatalogRefresher', () => {
  it('fetches, validates and caches a host file on the first check', async () => {
    const { refresher, fetchImpl, saved } = harness({});
    const result = await refresher.refresh(HOST);

    expect(result.status).toBe('updated');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(URL_FOR_HOST);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: 'omit', cache: 'no-cache' });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      host: HOST,
      status: 'ok',
      failureCount: 0,
      extensionVersion: '1.8.3',
      generatedAt: '2026-09-07T00:00:00.000Z',
    });
    expect(saved[0].manifests.map((m) => m.id)).toEqual(['voyager.deepseek-reading-width']);
  });

  it('reports unchanged content without waking subscribers needlessly', async () => {
    const { refresher, saved } = harness({ entry: entry(), now: 20 * HOUR });
    expect((await refresher.refresh(HOST)).status).toBe('unchanged');
    expect(saved[0].lastAttemptAt).toBe(20 * HOUR);
  });

  it('stays off the network inside the interval and honours the online switch', async () => {
    const fresh = harness({ entry: entry({ lastAttemptAt: 9 * HOUR }), now: 10 * HOUR });
    expect(await fresh.refresher.refresh(HOST)).toEqual({
      ok: true,
      status: 'skipped',
      reason: 'fresh',
    });
    expect(fresh.fetchImpl).not.toHaveBeenCalled();

    const off = harness({ settings: { onlineUpdatesEnabled: false } });
    expect(await off.refresher.refresh(HOST)).toEqual({
      ok: true,
      status: 'skipped',
      reason: 'disabled',
    });
    expect(off.fetchImpl).not.toHaveBeenCalled();

    const manual = harness({ settings: { checkInterval: 'manual' } });
    expect(await manual.refresher.refresh(HOST)).toEqual({
      ok: true,
      status: 'skipped',
      reason: 'manual-only',
    });
    expect(manual.fetchImpl).not.toHaveBeenCalled();
  });

  it('a forced (manual) check bypasses the switch, the interval and backoff', async () => {
    const { refresher, fetchImpl } = harness({
      entry: entry({ lastAttemptAt: 10 * HOUR - 1, failureCount: 5 }),
      settings: { onlineUpdatesEnabled: false, checkInterval: 'manual' },
      eligible: false,
    });
    expect((await refresher.refresh(HOST, { force: true })).status).toBe('unchanged');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never fetches for a page without an enabled plugin (Gemini, AI Studio, cold hosts)', async () => {
    const { refresher, fetchImpl } = harness({ eligible: false });
    expect(await refresher.refresh(HOST)).toEqual({ ok: true, status: 'ineligible' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects hosts that cannot name a file and a build with the channel off', async () => {
    const { refresher, fetchImpl } = harness({});
    expect(await refresher.refresh('*.frame.claudeusercontent.com')).toEqual({
      ok: true,
      status: 'invalid-host',
    });
    expect(await refresher.refresh('chat.deepseek.com/../x')).toEqual({
      ok: true,
      status: 'invalid-host',
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const off = harness({ enabled: false });
    expect(await off.refresher.refresh(HOST, { force: true })).toEqual({
      ok: true,
      status: 'disabled',
    });
    expect(off.fetchImpl).not.toHaveBeenCalled();
  });

  it('caches a 404 as "missing" so the snapshot stays in force and the host is not re-asked early', async () => {
    const { refresher, saved } = harness({ respond: () => ({ status: 404 }) });
    expect((await refresher.refresh(HOST)).status).toBe('missing');
    expect(saved[0]).toMatchObject({ status: 'missing', manifests: [], failureCount: 0 });
    expect(saved[0].fetchedAt).toBe(10 * HOUR);
  });

  it('keeps the previous catalog and records a failed attempt on 5xx, invalid JSON or a foreign file', async () => {
    const previous = entry({ failureCount: 1, fetchedAt: 1, lastAttemptAt: 1 });
    const cases = [
      () => ({ status: 503 }),
      () => ({ status: 200, body: 'not an object' }),
      () => ({ status: 200, body: { ...catalogFile(), host: 'claude.ai' } }),
      () => ({ status: 200, body: { ...catalogFile(), format: 9 } }),
    ];
    for (const respond of cases) {
      const { refresher, saved } = harness({ entry: previous, now: 20 * HOUR, respond });
      expect((await refresher.refresh(HOST)).status).toBe('failed');
      expect(saved[0]).toMatchObject({
        status: 'ok',
        failureCount: 2,
        lastAttemptAt: 20 * HOUR,
        fetchedAt: 1,
        extensionVersion: '1.8.3',
      });
      expect(saved[0].manifests.map((m) => m.id)).toEqual(['voyager.deepseek-reading-width']);
    }
  });

  it('backs off after failures and retries once the backoff has elapsed', async () => {
    // 3 failures → 2 h backoff on a 1 h interval.
    const failing = entry({ status: 'unknown', manifests: [], failureCount: 3, lastAttemptAt: 0 });
    const early = harness({ entry: failing, now: 1.5 * HOUR, settings: { checkInterval: '1h' } });
    expect(await early.refresher.refresh(HOST)).toEqual({
      ok: true,
      status: 'skipped',
      reason: 'backoff',
    });
    expect(early.fetchImpl).not.toHaveBeenCalled();

    const late = harness({ entry: failing, now: 2 * HOUR, settings: { checkInterval: '1h' } });
    expect((await late.refresher.refresh(HOST)).status).toBe('updated');
    expect(late.saved[0].failureCount).toBe(0);
  });

  it('re-fetches immediately after an extension update even inside the interval', async () => {
    const written = entry({ lastAttemptAt: 10 * HOUR - 1, extensionVersion: '1.8.2' });
    const { refresher, fetchImpl, saved } = harness({ entry: written, now: 10 * HOUR });
    expect((await refresher.refresh(HOST)).status).toBe('updated');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(saved[0].extensionVersion).toBe('1.8.3');
  });

  it('aborts a request that never settles, records the failed attempt and frees the host', async () => {
    vi.useFakeTimers();
    try {
      const saved: HostCatalogCacheEntry[] = [];
      let aborted = false;
      const fetchImpl = vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise(() => {
            init.signal.addEventListener('abort', () => {
              aborted = true;
            });
          }),
      );
      const refresher = new HostCatalogRefresher({
        baseUrl: 'https://voyager.nagi.fun/catalog',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => 10 * HOUR,
        extensionVersion: '1.8.3',
        enabled: true,
        loadSettings: async () => ({ onlineUpdatesEnabled: true, checkInterval: '6h' }),
        loadEntry: async () => null,
        saveEntry: async (next) => {
          saved.push(next);
        },
        isHostEligible: async () => true,
        timeoutMs: 1000,
      });

      const first = refresher.refresh(HOST);
      await vi.advanceTimersByTimeAsync(1001);
      const result = await first;
      expect(aborted).toBe(true);
      expect(result).toMatchObject({ ok: true, status: 'failed', reason: 'timeout after 1000ms' });
      expect(saved.at(-1)).toMatchObject({ status: 'unknown', failureCount: 1 });

      // The host is no longer pinned in flight: a forced retry starts a new request.
      void refresher.refresh(HOST, { force: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('collapses concurrent requests for one host into a single fetch', async () => {
    const { refresher, fetchImpl } = harness({});
    const results = await Promise.all([
      refresher.refresh(HOST),
      refresher.refresh(HOST),
      refresher.refresh('CHAT.deepseek.com'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['updated', 'updated', 'updated']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('logs and skips invalid plugin entries while keeping the valid ones', async () => {
    const { refresher, saved } = harness({
      respond: () => ({ status: 200, body: catalogFile([RAW_PLUGIN, { id: '' }]) }),
    });
    expect((await refresher.refresh(HOST)).status).toBe('updated');
    expect(saved[0].manifests).toHaveLength(1);
  });
});

describe('parseHostCatalogRefreshPayload', () => {
  it('accepts only an object with a string host', () => {
    expect(parseHostCatalogRefreshPayload({ host: HOST })).toEqual({ host: HOST, force: false });
    expect(parseHostCatalogRefreshPayload({ host: HOST, force: true })).toEqual({
      host: HOST,
      force: true,
    });
    expect(parseHostCatalogRefreshPayload({ host: HOST, force: 'yes' })).toEqual({
      host: HOST,
      force: false,
    });
    expect(parseHostCatalogRefreshPayload({ host: 42 })).toBeNull();
    expect(parseHostCatalogRefreshPayload(HOST)).toBeNull();
    expect(parseHostCatalogRefreshPayload(null)).toBeNull();
  });
});
