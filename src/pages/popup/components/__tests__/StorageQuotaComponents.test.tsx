import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  StorageCleanupResult,
  StorageQuotaSnapshot,
} from '@/core/services/StorageQuotaService';

import { StorageManager, type StorageManagerService } from '../StorageManager';
import {
  StorageQuotaCard,
  type StorageQuotaReader,
  getStorageAreaForDisplay,
  getStorageQuotaSeverity,
} from '../StorageQuotaCard';

const translatedMessages: Record<string, string> = {
  storageQuotaClearConfirm: 'Clear {category}?',
  storageQuotaEffectiveLimit: 'Current effective limit: {size}. Voyager enforces the lower limit.',
  storageQuotaHighlightClearConfirm: 'Delete every saved highlight permanently?',
};

vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: 'en',
    setLanguage: vi.fn(),
    t: (key: string) => translatedMessages[key] ?? key,
  }),
}));

const MEBIBYTE = 1024 * 1024;
const KIBIBYTE = 1024;

function createSnapshot(overrides: Partial<StorageQuotaSnapshot> = {}): StorageQuotaSnapshot {
  return {
    measuredAt: 1_700_000_000_000,
    softCapMb: 25,
    softCapBytes: 25 * MEBIBYTE,
    softCapUsageRatio: 0.04,
    local: {
      area: 'local',
      bytesInUse: MEBIBYTE,
      quotaBytes: 10 * MEBIBYTE,
      usageRatio: 0.1,
      available: true,
      estimated: false,
      quotaEstimated: false,
    },
    sync: {
      area: 'sync',
      bytesInUse: 10 * KIBIBYTE,
      quotaBytes: 100 * KIBIBYTE,
      usageRatio: 0.1,
      available: true,
      estimated: false,
      quotaEstimated: false,
    },
    categories: [
      {
        id: 'prompts',
        area: 'local',
        bytesInUse: 300 * KIBIBYTE,
        keys: ['gvPromptItems'],
        clearable: false,
        estimated: false,
      },
      {
        id: 'highlights',
        area: 'local',
        bytesInUse: 0,
        keys: [],
        clearable: true,
        estimated: false,
      },
      {
        id: 'drafts',
        area: 'local',
        bytesInUse: 20 * KIBIBYTE,
        keys: ['gvDraft_one'],
        clearable: true,
        estimated: false,
      },
      {
        id: 'cache',
        area: 'local',
        bytesInUse: 100 * KIBIBYTE,
        keys: ['gvUsageCache'],
        clearable: true,
        estimated: false,
      },
    ],
    permission: {
      supported: true,
      declared: true,
      granted: false,
      requestable: true,
      browser: 'chromium',
      reason: 'available',
    },
    estimated: false,
    ...overrides,
  };
}

function createManagerService(snapshot: StorageQuotaSnapshot): StorageManagerService {
  return {
    getSnapshot: vi.fn().mockResolvedValue(snapshot),
    saveSoftCapMb: vi.fn().mockResolvedValue(undefined),
    requestUnlimitedStoragePermission: vi.fn().mockResolvedValue({
      requested: true,
      granted: true,
      reason: 'granted',
      status: { ...snapshot.permission, granted: true, requestable: false },
    }),
    clearCategory: vi.fn().mockImplementation(async (category): Promise<StorageCleanupResult> => ({
      category,
      removedKeys: [`gv${category}`],
      bytesBefore: 100 * KIBIBYTE,
      bytesAfter: 0,
      bytesFreed: 100 * KIBIBYTE,
      estimated: false,
    })),
  };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('storage quota popup UI', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses 80% and 95% as the warning and critical thresholds', () => {
    expect(getStorageQuotaSeverity(createSnapshot())).toBe('normal');
    expect(
      getStorageQuotaSeverity(
        createSnapshot({
          local: { ...createSnapshot().local, usageRatio: 0.8 },
        }),
      ),
    ).toBe('warning');
    expect(
      getStorageQuotaSeverity(
        createSnapshot({
          sync: { ...createSnapshot().sync, usageRatio: 0.95 },
        }),
      ),
    ).toBe('critical');
  });

  it('uses the selected soft cap when unlimited local storage has no hard quota', () => {
    const snapshot = createSnapshot({
      softCapUsageRatio: 0.82,
      local: {
        ...createSnapshot().local,
        quotaBytes: null,
        usageRatio: null,
      },
    });

    expect(getStorageAreaForDisplay(snapshot, 'local')).toEqual(
      expect.objectContaining({
        quotaBytes: 25 * MEBIBYTE,
        usageRatio: 0.82,
        quotaEstimated: false,
      }),
    );
    expect(getStorageQuotaSeverity(snapshot)).toBe('warning');
  });

  it('renders both quota areas and opens the storage manager', async () => {
    const onManage = vi.fn();
    const service: StorageQuotaReader = {
      getSnapshot: vi.fn().mockResolvedValue(createSnapshot()),
    };

    await act(async () => {
      root.render(<StorageQuotaCard onManage={onManage} service={service} />);
    });
    await flushMicrotasks();

    expect(container.textContent).toContain('storageQuotaHealthy');
    expect(container.textContent).toContain('storageQuotaLocal');
    expect(container.textContent).toContain('1 MB / 10 MB');
    expect(container.textContent).toContain('storageQuotaSync');

    const manageButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'storageQuotaManage',
    );
    act(() => manageButton?.click());
    expect(onManage).toHaveBeenCalledOnce();
  });

  it('debounces local and sync storage change refreshes without polling', async () => {
    vi.useFakeTimers();
    const getSnapshot = vi.fn().mockResolvedValue(createSnapshot());

    await act(async () => {
      root.render(<StorageQuotaCard onManage={vi.fn()} service={{ getSnapshot }} />);
    });
    await flushMicrotasks();
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    const addListener = chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>;
    const storageListener = addListener.mock.calls.at(-1)?.[0] as (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => void;

    act(() => {
      storageListener({}, 'local');
      storageListener({}, 'sync');
      vi.advanceTimersByTime(119);
    });
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('keeps the newest snapshot when overlapping refreshes finish out of order', async () => {
    vi.useFakeTimers();
    const olderRequest = deferred<StorageQuotaSnapshot>();
    const newerRequest = deferred<StorageQuotaSnapshot>();
    const getSnapshot = vi
      .fn()
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(newerRequest.promise);

    await act(async () => {
      root.render(<StorageQuotaCard onManage={vi.fn()} service={{ getSnapshot }} />);
    });

    const addListener = chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>;
    const storageListener = addListener.mock.calls.at(-1)?.[0] as (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => void;

    await act(async () => {
      storageListener({}, 'local');
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });
    expect(getSnapshot).toHaveBeenCalledTimes(2);

    const newerSnapshot = createSnapshot({
      local: { ...createSnapshot().local, bytesInUse: 2 * MEBIBYTE, usageRatio: 0.2 },
    });
    await act(async () => {
      newerRequest.resolve(newerSnapshot);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('2 MB / 10 MB');

    await act(async () => {
      olderRequest.resolve(createSnapshot());
      await Promise.resolve();
    });
    expect(container.textContent).toContain('2 MB / 10 MB');
    expect(container.textContent).not.toContain('1 MB / 10 MB');
  });

  it('marks an existing manager snapshot as unavailable when refresh fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = createManagerService(createSnapshot());
    vi.mocked(service.getSnapshot)
      .mockResolvedValueOnce(createSnapshot())
      .mockRejectedValueOnce(new Error('quota read failed'));

    await act(async () => {
      root.render(<StorageManager onClose={vi.fn()} service={service} />);
    });
    await flushMicrotasks();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'storageQuotaHealthy',
    );

    const refreshButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="usageStatusRefresh"]',
    );
    await act(async () => {
      refreshButton?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'storageQuotaUnknown',
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('storageQuotaUnknown');
  });

  it('only exposes safe cleanup actions and confirms before clearing', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const service = createManagerService(createSnapshot());

    await act(async () => {
      root.render(<StorageManager onClose={vi.fn()} service={service} />);
    });
    await flushMicrotasks();

    expect(container.textContent).toContain('storageQuotaHighlights');
    const deleteButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label^="pm_delete"]'),
    );
    expect(deleteButtons).toHaveLength(2);
    expect(deleteButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'pm_delete draftAutoSave',
      'pm_delete storageQuotaCache',
    ]);

    const cacheButton = deleteButtons[1];
    await act(async () => {
      cacheButton.click();
      await Promise.resolve();
    });

    expect(confirmSpy).toHaveBeenCalledWith('Clear storageQuotaCache?');
    expect(service.clearCategory).toHaveBeenCalledWith('cache');
  });

  it('shows the effective browser limit when it is lower than the selected soft limit', async () => {
    const service = createManagerService(createSnapshot());

    await act(async () => {
      root.render(<StorageManager onClose={vi.fn()} service={service} />);
    });
    await flushMicrotasks();

    expect(container.textContent).toContain(
      'Current effective limit: 10 MB. Voyager enforces the lower limit.',
    );
  });

  it('shows non-empty highlights and uses the irreversible confirmation copy', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const base = createSnapshot();
    const snapshot = createSnapshot({
      categories: base.categories.map((category) =>
        category.id === 'highlights'
          ? {
              ...category,
              bytesInUse: 12 * KIBIBYTE,
              keys: ['gvHighlight:one'],
            }
          : category,
      ),
    });
    const service = createManagerService(snapshot);
    const clearHighlights = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        <StorageManager onClose={vi.fn()} service={service} clearHighlights={clearHighlights} />,
      );
    });
    await flushMicrotasks();

    const highlightButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="pm_delete storageQuotaHighlights"]',
    );
    expect(highlightButton).toBeTruthy();

    await act(async () => {
      highlightButton?.click();
      await Promise.resolve();
    });

    expect(confirmSpy).toHaveBeenCalledWith('Delete every saved highlight permanently?');
    expect(clearHighlights).toHaveBeenCalledOnce();
    expect(service.clearCategory).not.toHaveBeenCalledWith('highlights');
  });

  it('opens the saved library from the highlights storage row', async () => {
    const onManageHighlights = vi.fn();
    const service = createManagerService(createSnapshot());

    await act(async () => {
      root.render(
        <StorageManager
          onClose={vi.fn()}
          onManageHighlights={onManageHighlights}
          service={service}
        />,
      );
    });
    await flushMicrotasks();

    const manageButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'storageQuotaManage',
    );
    act(() => manageButton?.click());
    expect(onManageHighlights).toHaveBeenCalledOnce();
  });
});
