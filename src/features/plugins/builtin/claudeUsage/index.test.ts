import { type Mock, afterEach, describe, expect, it, vi } from 'vitest';

import {
  claudeUsageCacheKeyForOrg,
  claudeUsageUrl,
  isClaudeUsageSettings,
  planFromClaudeBootstrap,
  scrapeClaudeUsageFromDocument,
  setClaudeUsageReloadForTest,
  snapshotFromClaudeMessageLimit,
  snapshotFromClaudeUsageApi,
  startClaudeUsage,
  stopClaudeUsage,
} from '.';

type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

let restoreCookie: (() => void) | null = null;

function flushPromises(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await flushPromises();
}

async function waitForAsyncWork(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function mockLocalStorageStore(store: Record<string, unknown>): void {
  (chrome.storage.local.get as unknown as Mock).mockImplementation(async (query) => {
    if (typeof query === 'string') return { [query]: store[query] };
    if (Array.isArray(query)) {
      return Object.fromEntries(query.map((key) => [key, store[key]]));
    }
    if (query && typeof query === 'object') {
      return Object.fromEntries(
        Object.entries(query).map(([key, fallback]) => [
          key,
          Object.prototype.hasOwnProperty.call(store, key) ? store[key] : fallback,
        ]),
      );
    }
    return { ...store };
  });
  (chrome.storage.local.set as unknown as Mock).mockImplementation(async (payload) => {
    Object.assign(store, payload);
  });
}

function mockDocumentCookie(cookie: string): void {
  const cookieSpy = vi.spyOn(document, 'cookie', 'get').mockReturnValue(cookie);
  restoreCookie = () => cookieSpy.mockRestore();
}

function dispatchClaudeMessageLimit(payload: unknown): void {
  const event = new MessageEvent('message', {
    data: {
      source: 'gv-claude-usage-observer',
      type: 'message-limit',
      payload,
    },
  });
  Object.defineProperty(event, 'source', { value: window });
  window.dispatchEvent(event);
}

function mountUsageText(): void {
  document.body.innerHTML = `
    <section>
      <h3>Plan usage limits Max (20x)</h3>
      <p>Current session Resets Tue 10:00 AM</p>
      <div role="progressbar" aria-label="Usage" aria-valuenow="0"></div>
      <p>0% used</p>
      <h3>Weekly limits</h3>
      <p>All models Resets Tue 11:59 AM</p>
      <div role="progressbar" aria-label="Usage" aria-valuenow="45"></div>
      <p>45% used</p>
      <p>Fable Resets Tue 11:59 AM</p>
      <div role="progressbar" aria-label="Usage" aria-valuenow="2"></div>
      <p>2% used</p>
      <p>Last updated: 1 minute ago</p>
      <h3>Usage credits</h3>
      <p>0% used</p>
    </section>`;
}

function mountUsageTextWithPlan(plan: string): void {
  document.body.innerHTML = `
    <section>
      <h3>Plan usage limits ${plan}</h3>
      <p>Current session Starts when a message is sent</p>
      <p>12% used</p>
    </section>`;
}

function mountUsageTextWithoutPlan(): void {
  document.body.innerHTML = `
    <section>
      <h2>Usage</h2>
      <p>Current session Starts when a message is sent</p>
      <p>12% used</p>
      <p>All models Resets Today 11:30 AM</p>
      <p>40% used</p>
    </section>`;
}

afterEach(() => {
  stopClaudeUsage();
  setClaudeUsageReloadForTest(null);
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
  restoreCookie?.();
  restoreCookie = null;
  document.cookie = 'lastActiveOrg=; Max-Age=0; path=/';
  (chrome.storage.local.get as unknown as Mock).mockReset();
  (chrome.storage.local.set as unknown as Mock).mockReset();
  (chrome.storage.onChanged.addListener as unknown as Mock).mockReset();
  (chrome.storage.onChanged.removeListener as unknown as Mock).mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Claude usage bar', () => {
  it('recognizes Claude settings usage hashes', () => {
    expect(isClaudeUsageSettings('#settings/usage')).toBe(true);
    expect(isClaudeUsageSettings('#settings/usage?x=1')).toBe(true);
    expect(isClaudeUsageSettings('#settings/account')).toBe(false);
  });

  it('scrapes the visible Claude usage bars', () => {
    mountUsageText();
    const now = new Date(2026, 0, 4, 10, 0, 0).getTime();

    expect(scrapeClaudeUsageFromDocument(document, now)).toEqual({
      plan: 'Max (20x)',
      lastUpdatedLabel: '1 minute ago',
      updatedAt: now,
      metrics: [
        {
          label: '5h',
          percent: 0,
          resetLabel: 'Tue 10:00 AM',
          resetEpoch: Math.floor(new Date(2026, 0, 6, 10, 0, 0).getTime() / 1000),
        },
        {
          label: 'Week',
          percent: 45,
          resetLabel: 'Tue 11:59 AM',
          resetEpoch: Math.floor(new Date(2026, 0, 6, 11, 59, 0).getTime() / 1000),
        },
        {
          label: 'Fable',
          percent: 2,
          resetLabel: 'Tue 11:59 AM',
          resetEpoch: Math.floor(new Date(2026, 0, 6, 11, 59, 0).getTime() / 1000),
        },
      ],
    });
  });

  it('does not mistake usage credits for Fable when background content mentions the model', () => {
    document.body.innerHTML = `
      <main><p>A conversation about Fable</p></main>
      <section>
        <h3>Plan usage limits Max (20x)</h3>
        <p>Current session Resets Tue 10:00 AM</p>
        <p>12% used</p>
        <p>All models Resets Tue 11:59 AM</p>
        <p>45% used</p>
        <h3>Usage credits</h3>
        <p>2% used</p>
      </section>`;

    expect(scrapeClaudeUsageFromDocument(document, 123)?.metrics).toHaveLength(2);
  });

  it.each(['Pro', 'Max (5x)', 'Max (20x)'])('scrapes Claude plan tier %s', (plan) => {
    mountUsageTextWithPlan(plan);

    expect(scrapeClaudeUsageFromDocument(document, 123)?.plan).toBe(plan);
  });

  it('normalizes Claude usage API windows', () => {
    const snap = snapshotFromClaudeUsageApi(
      {
        five_hour: { utilization: 12.5, resets_at: '2026-06-28T12:00:00.000Z' },
        seven_day: { utilization: 45, resets_at: '2026-06-30T12:00:00.000Z' },
        seven_day_opus: { utilization: 82, resets_at: '2026-06-30T12:00:00.000Z' },
        plan_name: 'claude_max_5x',
      },
      123,
    );

    expect(snap?.metrics.map(({ label, percent }) => ({ label, percent }))).toEqual([
      { label: '5h', percent: 12.5 },
      { label: 'Week', percent: 45 },
      { label: 'Fable', percent: 82 },
    ]);
    expect(snap?.plan).toBe('Max (5x)');
    expect(snap?.updatedAt).toBe(123);
    expect(snap?.metrics[0].resetLabel).toBeTruthy();
    expect(snap?.metrics[0].resetEpoch).toBeTypeOf('number');
    expect(snap?.metrics[1].resetLabel).toBeTruthy();
    expect(snap?.metrics[1].resetEpoch).toBeTypeOf('number');
  });

  it('normalizes Claude message_limit windows', () => {
    const snap = snapshotFromClaudeMessageLimit(
      {
        windows: {
          '5h': {
            utilization: 0.125,
            resets_at: Math.floor(Date.parse('2026-06-28T12:00:00.000Z') / 1000),
          },
          '7d': {
            utilization: 0.45,
            resets_at: Math.floor(Date.parse('2026-06-30T12:00:00.000Z') / 1000),
          },
        },
      },
      123,
    );

    expect(snap?.metrics.map(({ label, percent }) => ({ label, percent }))).toEqual([
      { label: '5h', percent: 12.5 },
      { label: 'Week', percent: 45 },
    ]);
    expect(snap?.metrics[0].resetEpoch).toBe(1_782_648_000);
    expect(snap?.metrics[1].resetEpoch).toBe(1_782_820_800);
  });

  it('extracts Claude subscription tier from bootstrap org metadata', () => {
    expect(
      planFromClaudeBootstrap(
        {
          account: {
            memberships: [
              {
                organization: {
                  uuid: 'org_123',
                  capabilities: ['claude_max'],
                  rate_limit_tier: 'default_claude_max_20x',
                },
              },
            ],
          },
        },
        'org_123',
      ),
    ).toBe('Max (20x)');

    expect(
      planFromClaudeBootstrap(
        {
          account: {
            memberships: [
              {
                organization: {
                  uuid: 'org_123',
                  capabilities: ['claude_pro'],
                  rate_limit_tier: 'default_claude_ai',
                },
              },
            ],
          },
        },
        'org_123',
      ),
    ).toBe('Pro');
  });

  it('returns null for unrelated usage API payloads', () => {
    expect(snapshotFromClaudeUsageApi({ five_hour: { utilization: '12' } })).toBeNull();
  });

  it('builds an open link to Claude usage settings', () => {
    startClaudeUsage();
    expect(claudeUsageUrl()).toBe('https://claude.ai/new#settings/usage');
    expect(document.querySelector<HTMLAnchorElement>('a.gv-usage-open')?.href).toBe(
      'https://claude.ai/new#settings/usage',
    );
    expect(document.querySelector<HTMLAnchorElement>('a.gv-usage-open')?.target).toBe('');
    expect(document.querySelector('.gv-usage-tier')).toBeNull();
  });

  it('keeps the current Claude chat path in the usage link', () => {
    history.replaceState(null, '', '/chat/db82c53c-5c7c-4764-b35d-6329173eaf5b');

    startClaudeUsage();

    expect(claudeUsageUrl()).toBe(
      'https://claude.ai/chat/db82c53c-5c7c-4764-b35d-6329173eaf5b#settings/usage',
    );
    expect(document.querySelector<HTMLAnchorElement>('a.gv-usage-open')?.href).toBe(
      'https://claude.ai/chat/db82c53c-5c7c-4764-b35d-6329173eaf5b#settings/usage',
    );
  });

  it('reloads after opening usage when Claude only changes the hash', async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/chat/db82c53c-5c7c-4764-b35d-6329173eaf5b');
    mockLocalStorageStore({});
    const reload = vi.fn();
    setClaudeUsageReloadForTest(reload);

    startClaudeUsage();
    document.querySelector<HTMLAnchorElement>('a.gv-usage-open')?.click();
    await vi.advanceTimersByTimeAsync(700);

    expect(location.pathname).toBe('/chat/db82c53c-5c7c-4764-b35d-6329173eaf5b');
    expect(location.hash).toBe('#settings/usage');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not reload if usage content appears after opening', async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/chat/db82c53c-5c7c-4764-b35d-6329173eaf5b');
    mountUsageText();
    mockLocalStorageStore({});
    const reload = vi.fn();
    setClaudeUsageReloadForTest(reload);

    startClaudeUsage();
    document.querySelector<HTMLAnchorElement>('a.gv-usage-open')?.click();
    await vi.advanceTimersByTimeAsync(700);

    expect(location.hash).toBe('#settings/usage');
    expect(reload).not.toHaveBeenCalled();
  });

  it('renders cached usage into mini bars when started', async () => {
    vi.useFakeTimers();
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      gvClaudeUsageCache: {
        plan: 'Max (20x)',
        updatedAt: 1,
        metrics: [{ label: 'All', percent: 45, resetLabel: 'Tue 11:59 AM' }],
      },
    });

    startClaudeUsage();
    await flushPromises();

    expect(document.querySelector('.gv-usage-tier')?.textContent).toBe('Max (20x)');
    expect(document.querySelector('.gv-usage-label')?.textContent).toBe('Week');
    expect(document.querySelector('.gv-usage-pct')?.textContent).toBe('45%');
    expect(document.querySelector('.gv-usage-metric')?.getAttribute('title')).toBe(
      'Week resets Tue 11:59 AM',
    );
    expect(document.querySelector<HTMLElement>('.gv-usage-fill')?.style.width).toBe('45%');
  });

  it('renders API reset epochs as countdowns', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T10:00:00.000Z'));
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      gvClaudeUsageCache: {
        plan: 'Max (20x)',
        updatedAt: Date.now(),
        metrics: [
          {
            label: '5h',
            percent: 12,
            resetEpoch: Math.floor(Date.parse('2026-06-28T10:30:00.000Z') / 1000),
            resetLabel: '6/28/2026, 10:30:00 AM',
          },
          {
            label: 'Week',
            percent: 30,
            resetEpoch: Math.floor(Date.parse('2026-06-28T11:30:00.000Z') / 1000),
            resetLabel: '6/28/2026, 11:30:00 AM',
          },
        ],
      },
    });

    startClaudeUsage();
    await flushPromises();

    expect([...document.querySelectorAll('.gv-usage-label')].map((el) => el.textContent)).toEqual([
      '5h',
      'Week',
    ]);
    expect([...document.querySelectorAll('.gv-usage-pct')].map((el) => el.textContent)).toEqual([
      '12% (30m)',
      '30% (1h30m)',
    ]);
  });

  it('refreshes countdown labels without another API request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T10:00:00.000Z'));
    mockDocumentCookie('lastActiveOrg=org_123');
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      gvClaudeUsageCache: {
        orgId: 'org_123',
        plan: 'Pro',
        updatedAt: Date.now(),
        metrics: [
          {
            label: '5h',
            percent: 12,
            resetEpoch: Math.floor(Date.parse('2026-06-28T11:30:00.000Z') / 1000),
            resetLabel: '6/28/2026, 11:30:00 AM',
          },
        ],
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    startClaudeUsage();
    await flushPromises();
    expect(document.querySelector('.gv-usage-pct')?.textContent).toBe('12% (1h30m)');

    vi.setSystemTime(new Date('2026-06-28T10:30:00.000Z'));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(document.querySelector('.gv-usage-pct')?.textContent).toBe('12% (59m)');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes fresh cached usage when reset epochs are missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T10:00:00.000Z'));
    mockLocalStorageStore({
      gvClaudeUsageCache: {
        plan: 'Max (20x)',
        updatedAt: Date.now(),
        metrics: [
          { label: '5h', percent: 12 },
          { label: 'Week', percent: 46 },
        ],
      },
    });
    mockDocumentCookie('lastActiveOrg=org_123');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 12, resets_at: '2026-06-28T10:30:00.000Z' },
        seven_day: { utilization: 46, resets_at: '2026-06-28T11:30:00.000Z' },
        plan_name: 'claude_max_20x',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    startClaudeUsage();
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://claude.ai/api/organizations/org_123/usage',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect([...document.querySelectorAll('.gv-usage-pct')].map((el) => el.textContent)).toEqual([
      '12% (30m)',
      '46% (1h30m)',
    ]);
  });

  it('refreshes an old Max cache that does not contain the Fable bucket', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T10:00:00.000Z'));
    mockLocalStorageStore({
      gvClaudeUsageCache: {
        plan: 'Max (20x)',
        updatedAt: Date.now(),
        metrics: [
          { label: '5h', percent: 12, resetEpoch: 1_782_642_600 },
          { label: 'Week', percent: 46, resetEpoch: 1_782_646_200 },
        ],
      },
    });
    mockDocumentCookie('lastActiveOrg=org_123');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 12, resets_at: '2026-06-28T10:30:00.000Z' },
        seven_day: { utilization: 46, resets_at: '2026-06-28T11:30:00.000Z' },
        seven_day_opus: { utilization: 82, resets_at: '2026-06-30T12:00:00.000Z' },
        plan_name: 'claude_max_20x',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    startClaudeUsage();
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://claude.ai/api/organizations/org_123/usage',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect([...document.querySelectorAll('.gv-usage-label')].map((el) => el.textContent)).toEqual([
      '5h',
      'Week',
      'Fable',
    ]);
  });

  it('fills the 5h countdown from Claude message_limit events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T10:00:00.000Z'));
    mockLocalStorageStore({
      gvClaudeUsageCache: {
        plan: 'Max (20x)',
        updatedAt: Date.now(),
        metrics: [
          { label: 'Week', percent: 46 },
          { label: 'Fable', percent: 82, resetEpoch: 1_782_820_800 },
        ],
      },
    });
    vi.stubGlobal('fetch', vi.fn());

    startClaudeUsage();
    await flushPromises();
    dispatchClaudeMessageLimit({
      windows: {
        '5h': {
          utilization: 0.12,
          resets_at: Math.floor(Date.parse('2026-06-28T10:30:00.000Z') / 1000),
        },
        '7d': {
          utilization: 0.46,
          resets_at: Math.floor(Date.parse('2026-06-28T11:30:00.000Z') / 1000),
        },
      },
    });

    expect(document.querySelector('.gv-usage-tier')?.textContent).toBe('Max (20x)');
    expect([...document.querySelectorAll('.gv-usage-pct')].map((el) => el.textContent)).toEqual([
      '12% (30m)',
      '46% (1h30m)',
      '82% (2d2h)',
    ]);
  });

  it('discovers the Claude org when the active-org cookie is missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T10:00:00.000Z'));
    mockLocalStorageStore({});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ uuid: 'org_from_api' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          five_hour: { utilization: 12, resets_at: '2026-06-28T10:30:00.000Z' },
          seven_day: { utilization: 46, resets_at: '2026-06-28T11:30:00.000Z' },
          plan_name: 'claude_max_20x',
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    startClaudeUsage();
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://claude.ai/api/organizations',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://claude.ai/api/organizations/org_from_api/usage',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(document.querySelector('.gv-usage-pct')?.textContent).toBe('12% (30m)');
  });

  it('uses shared cache to avoid multiplying API requests across Claude tabs', async () => {
    vi.useFakeTimers();
    const orgId = 'org_123';
    const scopedKey = claudeUsageCacheKeyForOrg(orgId);
    const store: Record<string, unknown> = {
      [scopedKey]: {
        orgId,
        plan: 'Pro',
        updatedAt: Date.now(),
        metrics: [
          {
            label: 'All',
            percent: 45,
            resetEpoch: Math.floor((Date.now() + 60 * 60_000) / 1000),
          },
        ],
      },
    };
    mockLocalStorageStore(store);
    mockDocumentCookie(`lastActiveOrg=${orgId}`);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    startClaudeUsage();
    await flushPromises();

    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    store[scopedKey] = {
      orgId,
      plan: 'Pro',
      updatedAt: Date.now(),
      metrics: [
        {
          label: 'All',
          percent: 48,
          resetEpoch: Math.floor((Date.now() + 60 * 60_000) / 1000),
        },
      ],
    };
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>('.gv-usage-fill')?.style.width).toBe('48%');
  });

  it('fetches the plan tier from bootstrap when usage API omits it', async () => {
    mockLocalStorageStore({});
    mockDocumentCookie('lastActiveOrg=org_123');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          five_hour: { utilization: 5 },
          seven_day: { utilization: 40 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          account: {
            memberships: [
              {
                organization: {
                  uuid: 'org_123',
                  capabilities: ['claude_pro'],
                  rate_limit_tier: 'default_claude_ai',
                },
              },
            ],
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    startClaudeUsage();
    await waitForAsyncWork();

    expect(document.querySelector('.gv-usage-tier')?.textContent).toBe('Pro');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://claude.ai/api/bootstrap/org_123/app_start?statsig_hashing_algorithm=djb2',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('keeps the cached plan when Claude page text omits it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 28, 10, 0, 0));
    history.replaceState(null, '', '/#settings/usage');
    mountUsageTextWithoutPlan();
    mockLocalStorageStore({
      gvClaudeUsageCache: {
        plan: 'Pro',
        updatedAt: 10,
        metrics: [
          {
            label: 'All',
            percent: 45,
            resetEpoch: Math.floor(new Date(2026, 5, 28, 11, 30, 0).getTime() / 1000),
            resetLabel: '6/28/2026, 11:30:00 AM',
          },
        ],
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    startClaudeUsage();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();

    expect(document.querySelector('.gv-usage-tier')?.textContent).toBe('Pro');
    expect(document.querySelectorAll('.gv-usage-metric')).toHaveLength(2);
    expect([...document.querySelectorAll('.gv-usage-pct')].map((el) => el.textContent)).toEqual([
      '12%',
      '40% (1h29m)',
    ]);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('does not scrape again after only the pill itself changes', async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/#settings/usage');
    mountUsageText();
    mockLocalStorageStore({});

    startClaudeUsage();
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    const writes = (chrome.storage.local.set as unknown as Mock).mock.calls.length;

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(chrome.storage.local.set).toHaveBeenCalled();
    expect((chrome.storage.local.set as unknown as Mock).mock.calls.length).toBe(writes);
  });

  it('skips API refresh while another Claude tab holds the shared lock', async () => {
    vi.useFakeTimers();
    mockLocalStorageStore({
      gvClaudeUsageRefreshLock: {
        owner: 'other-tab',
        expiresAt: Date.now() + 30_000,
      },
    });
    mockDocumentCookie('lastActiveOrg=org_123');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    startClaudeUsage();
    await flushPromises();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not resurrect the pill when an in-flight refresh resolves after stop', async () => {
    vi.useFakeTimers();
    mockLocalStorageStore({});
    mockDocumentCookie('lastActiveOrg=org_123');
    let resolveUsage: (value: unknown) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUsage = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    startClaudeUsage();
    await flushAsyncWork();
    expect(document.getElementById('gv-claude-usage-pill')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stopClaudeUsage();
    expect(document.getElementById('gv-claude-usage-pill')).toBeNull();

    resolveUsage({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 12, resets_at: '2026-06-28T10:30:00.000Z' },
        seven_day: { utilization: 46, resets_at: '2026-06-28T11:30:00.000Z' },
        plan_name: 'claude_max_20x',
      }),
    });
    await flushAsyncWork();

    expect(document.getElementById('gv-claude-usage-pill')).toBeNull();
  });

  it('loads and mirrors the dragged bar position', async () => {
    const storageListeners: StorageListener[] = [];
    (chrome.storage.onChanged.addListener as unknown as Mock).mockImplementation(
      (listener: StorageListener) => {
        storageListeners.push(listener);
      },
    );
    mockLocalStorageStore({
      gvClaudeUsageCache: {
        updatedAt: 10,
        metrics: [{ label: 'All', percent: 45 }],
      },
      gvClaudeUsagePos: { x: 40, y: 50 },
    });

    startClaudeUsage();
    await flushPromises();

    const el = document.getElementById('gv-claude-usage-pill') as HTMLElement;
    expect(el.style.left).toBe('40px');
    expect(el.style.top).toBe('50px');

    storageListeners[0]?.(
      {
        gvClaudeUsagePos: {
          newValue: { x: 70, y: 90 },
        },
      },
      'local',
    );

    expect(el.style.left).toBe('70px');
    expect(el.style.top).toBe('90px');
  });

  it('ignores stale storage updates after a newer snapshot is rendered', async () => {
    const storageListeners: StorageListener[] = [];
    (chrome.storage.onChanged.addListener as unknown as Mock).mockImplementation(
      (listener: StorageListener) => {
        storageListeners.push(listener);
      },
    );
    mockDocumentCookie('lastActiveOrg=org_123');
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      gvClaudeUsageCache: {
        orgId: 'org_123',
        plan: 'Fresh',
        updatedAt: 10,
        metrics: [{ label: 'All', percent: 45 }],
      },
    });

    startClaudeUsage();
    await flushPromises();

    expect(document.querySelector('.gv-usage-tier')?.textContent).toBe('Fresh');
    const storageListener = storageListeners[0];
    expect(storageListener).toBeDefined();

    storageListener(
      {
        gvClaudeUsageCache: {
          newValue: {
            orgId: 'org_123',
            plan: 'Old',
            updatedAt: 5,
            metrics: [{ label: 'All', percent: 12 }],
          },
        },
      },
      'local',
    );

    expect(document.querySelector('.gv-usage-tier')?.textContent).toBe('Fresh');
    expect(document.querySelector<HTMLElement>('.gv-usage-fill')?.style.width).toBe('45%');

    storageListener(
      {
        gvClaudeUsageCache: {
          newValue: {
            orgId: 'org_123',
            plan: 'New',
            updatedAt: 11,
            metrics: [{ label: 'All', percent: 60 }],
          },
        },
      },
      'local',
    );

    expect(document.querySelector('.gv-usage-tier')?.textContent).toBe('New');
    expect(document.querySelector<HTMLElement>('.gv-usage-fill')?.style.width).toBe('60%');
  });

  it('scopes the cache key by organization id', () => {
    expect(claudeUsageCacheKeyForOrg('org_123')).toBe('gvClaudeUsageCache:org_123');
    expect(claudeUsageCacheKeyForOrg('org_456')).toBe('gvClaudeUsageCache:org_456');
  });

  it('does not show cached usage from a different org after account switch', async () => {
    vi.useFakeTimers();
    const orgAKey = claudeUsageCacheKeyForOrg('org_A');
    const store: Record<string, unknown> = {
      [orgAKey]: {
        orgId: 'org_A',
        plan: 'Max (20x)',
        updatedAt: Date.now(),
        metrics: [{ label: '5h', percent: 80, resetLabel: 'Tue 10:00 AM' }],
      },
    };
    mockLocalStorageStore(store);
    mockDocumentCookie('lastActiveOrg=org_B');

    startClaudeUsage();
    await flushAsyncWork();

    expect(document.querySelector('.gv-usage-pct')?.textContent).not.toBe('80%');
    expect(document.querySelector('.gv-usage-tier')?.textContent).not.toBe('Max (20x)');
  });

  it('preserves cache behavior for the same org', async () => {
    vi.useFakeTimers();
    const orgId = 'org_123';
    mockDocumentCookie(`lastActiveOrg=${orgId}`);
    const scopedKey = claudeUsageCacheKeyForOrg(orgId);
    const cachedSnapshot = {
      orgId,
      plan: 'Pro',
      updatedAt: Date.now(),
      metrics: [{ label: '5h', percent: 30, resetLabel: 'Tue 11:00 AM' }],
    };
    mockLocalStorageStore({ [scopedKey]: cachedSnapshot });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    startClaudeUsage();
    await flushAsyncWork();

    expect(document.querySelector('.gv-usage-pct')?.textContent).toBe('30%');
    expect(document.querySelector('.gv-usage-tier')?.textContent).toBe('Pro');
  });

  it('falls back to legacy cache key when legacy has matching orgId', async () => {
    vi.useFakeTimers();
    const orgId = 'org_legacy';
    mockDocumentCookie(`lastActiveOrg=${orgId}`);
    const legacySnapshot = {
      orgId,
      plan: 'Pro',
      updatedAt: Date.now(),
      metrics: [{ label: '5h', percent: 50, resetLabel: 'Tue 12:00 PM' }],
    };
    mockLocalStorageStore({ gvClaudeUsageCache: legacySnapshot });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    startClaudeUsage();
    await flushAsyncWork();

    expect(document.querySelector('.gv-usage-pct')?.textContent).toBe('50%');
    expect(document.querySelector('.gv-usage-tier')?.textContent).toBe('Pro');
  });
});
