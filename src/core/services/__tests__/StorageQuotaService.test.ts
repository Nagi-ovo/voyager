import { describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import {
  DEFAULT_STORAGE_SOFT_CAP_MB,
  STORAGE_QUOTA_SOFT_CAP_KEY,
  StorageQuotaService,
  type StorageSoftCapMb,
} from '../StorageQuotaService';

const MEBIBYTE = 1024 * 1024;

interface MockAreaOptions {
  quotaBytes?: number;
  withGetBytesInUse?: boolean;
  rejectGetBytesInUse?: boolean;
  weights?: Record<string, number>;
}

function storageKeys(input: unknown, data: Record<string, unknown>): string[] {
  if (input === null || input === undefined) return Object.keys(data);
  if (typeof input === 'string') return [input];
  if (Array.isArray(input)) return input.map(String);
  if (typeof input === 'object') return Object.keys(input as Record<string, unknown>);
  return [];
}

function createArea(initial: Record<string, unknown>, options: MockAreaOptions = {}) {
  const data = { ...initial };
  const get = vi.fn(async (...args: unknown[]) => {
    const keys = storageKeys(args[0], data);
    return Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]]));
  });
  const set = vi.fn(async (...args: unknown[]) => {
    Object.assign(data, args[0] as Record<string, unknown>);
  });
  const remove = vi.fn(async (...args: unknown[]) => {
    for (const key of storageKeys(args[0], data)) delete data[key];
  });
  const clear = vi.fn(async () => {
    for (const key of Object.keys(data)) delete data[key];
  });
  const getBytesInUse = vi.fn(async (...args: unknown[]) => {
    if (options.rejectGetBytesInUse) throw new Error('getBytesInUse unavailable');
    return storageKeys(args[0], data).reduce(
      (total, key) => total + (options.weights?.[key] ?? 1),
      0,
    );
  });

  return {
    data,
    api: {
      get,
      set,
      remove,
      clear,
      ...(options.withGetBytesInUse === false ? {} : { getBytesInUse }),
      ...(options.quotaBytes === undefined ? {} : { QUOTA_BYTES: options.quotaBytes }),
    },
    mocks: { get, set, remove, clear, getBytesInUse },
  };
}

interface ChromeMockOptions {
  declared?: boolean;
  required?: boolean;
  granted?: boolean;
  requestResult?: boolean;
  includePermissionsApi?: boolean;
}

function createChromeMock(
  local: ReturnType<typeof createArea>,
  sync: ReturnType<typeof createArea>,
  options: ChromeMockOptions = {},
) {
  let granted = options.granted ?? false;
  const contains = vi.fn(async () => granted);
  const request = vi.fn(async () => {
    granted = options.requestResult ?? true;
    return granted;
  });
  const permissions = options.includePermissionsApi === false ? undefined : { contains, request };
  const chromeApi = {
    storage: { local: local.api, sync: sync.api },
    permissions,
    runtime: {
      lastError: null,
      getManifest: () => ({
        permissions: ['storage', ...(options.required ? ['unlimitedStorage'] : [])],
        optional_permissions:
          options.declared === false || options.required ? [] : ['unlimitedStorage'],
      }),
    },
  };

  return { chromeApi, contains, request };
}

function category(snapshot: Awaited<ReturnType<StorageQuotaService['getSnapshot']>>, id: string) {
  const result = snapshot.categories.find((item) => item.id === id);
  expect(result, `missing category ${id}`).toBeDefined();
  return result!;
}

describe('StorageQuotaService', () => {
  it('measures local and sync separately and classifies explicit keys and prefixes', async () => {
    const localValues = {
      [StorageKeys.PROMPT_ITEMS]: [{ id: 'prompt' }],
      [StorageKeys.FOLDER_DATA]: { folders: [] },
      [`${StorageKeys.FOLDER_DATA}:acct:abc`]: { folders: [] },
      [`${StorageKeys.TIMELINE_HIERARCHY}:acct:def`]: { conversations: {} },
      'gvHighlight:records': [{ id: 'highlight' }],
      'gvAnnotation:index': { count: 1 },
      'gvAnnotation:bucket:v1:acct:abc:conv:def': { records: {} },
      'gvDraft_/app/one': { text: 'draft' },
      [StorageKeys.GV_GEMS_LIST_CACHE]: { items: [] },
      [`${StorageKeys.GV_USAGE_CACHE}:account`]: { daily: [] },
      [`${StorageKeys.GV_CLAUDE_USAGE_CACHE}:org_123`]: { metrics: [] },
      [StorageKeys.LANGUAGE]: 'en',
      [STORAGE_QUOTA_SOFT_CAP_KEY]: 50,
      unknownFuturePayload: { large: true },
    };
    const weights = Object.fromEntries(
      Object.keys(localValues).map((key, index) => [key, (index + 1) * 10]),
    );
    const local = createArea(localValues, { quotaBytes: 10 * MEBIBYTE, weights });
    const sync = createArea(
      { [StorageKeys.LANGUAGE]: 'zh' },
      {
        quotaBytes: 100 * 1024,
        weights: { [StorageKeys.LANGUAGE]: 37 },
      },
    );
    const { chromeApi } = createChromeMock(local, sync, { granted: false });
    const service = new StorageQuotaService({
      chromeApi,
      buildTarget: () => 'chrome',
      now: () => 1234,
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.measuredAt).toBe(1234);
    expect(snapshot.local.bytesInUse).toBe(Object.values(weights).reduce((a, b) => a + b, 0));
    expect(snapshot.sync.bytesInUse).toBe(37);
    expect(snapshot.local.area).toBe('local');
    expect(snapshot.sync.area).toBe('sync');
    expect(snapshot.local.estimated).toBe(false);
    expect(snapshot.sync.estimated).toBe(false);
    expect(snapshot.softCapMb).toBe(50);
    expect(snapshot.softCapBytes).toBe(50 * MEBIBYTE);

    expect(category(snapshot, 'prompts').keys).toEqual([StorageKeys.PROMPT_ITEMS]);
    expect(category(snapshot, 'folders').keys).toEqual([
      StorageKeys.FOLDER_DATA,
      `${StorageKeys.FOLDER_DATA}:acct:abc`,
    ]);
    expect(category(snapshot, 'timeline').keys).toEqual([
      `${StorageKeys.TIMELINE_HIERARCHY}:acct:def`,
    ]);
    expect(category(snapshot, 'highlights').keys).toEqual([
      'gvHighlight:records',
      'gvAnnotation:bucket:v1:acct:abc:conv:def',
    ]);
    expect(category(snapshot, 'drafts').keys).toEqual(['gvDraft_/app/one']);
    expect(category(snapshot, 'cache').keys).toEqual([
      StorageKeys.GV_GEMS_LIST_CACHE,
      `${StorageKeys.GV_USAGE_CACHE}:account`,
      `${StorageKeys.GV_CLAUDE_USAGE_CACHE}:org_123`,
    ]);
    expect(category(snapshot, 'settings').keys).toEqual([
      'gvAnnotation:index',
      StorageKeys.LANGUAGE,
      STORAGE_QUOTA_SOFT_CAP_KEY,
    ]);
    expect(category(snapshot, 'other').keys).toEqual(['unknownFuturePayload']);
    expect(category(snapshot, 'other').clearable).toBe(false);
  });

  it('falls back to deterministic estimated bytes when getBytesInUse is missing', async () => {
    const local = createArea(
      { [StorageKeys.PROMPT_ITEMS]: ['你好'], [STORAGE_QUOTA_SOFT_CAP_KEY]: 75 },
      { withGetBytesInUse: false },
    );
    const sync = createArea({ setting: true }, { rejectGetBytesInUse: true });
    const { chromeApi } = createChromeMock(local, sync);
    const snapshot = await new StorageQuotaService({
      chromeApi,
      buildTarget: () => 'chrome',
    }).getSnapshot();

    expect(snapshot.local.available).toBe(true);
    expect(snapshot.local.bytesInUse).toBeGreaterThan(0);
    expect(snapshot.local.estimated).toBe(true);
    expect(snapshot.sync.estimated).toBe(true);
    expect(snapshot.estimated).toBe(true);
    expect(snapshot.softCapMb).toBe(DEFAULT_STORAGE_SOFT_CAP_MB);
    expect(category(snapshot, 'prompts').estimated).toBe(true);
  });

  it('returns an unavailable estimated area instead of throwing when APIs are absent', async () => {
    const service = new StorageQuotaService({
      chromeApi: {
        runtime: { getManifest: () => ({ permissions: [], optional_permissions: [] }) },
      },
      buildTarget: () => 'chrome',
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.local).toMatchObject({ available: false, bytesInUse: 0, estimated: true });
    expect(snapshot.sync).toMatchObject({ available: false, bytesInUse: 0, estimated: true });
    expect(snapshot.permission).toMatchObject({
      supported: false,
      requestable: false,
      reason: 'unsupported-api',
    });
    expect(category(snapshot, 'other').keys).toEqual([]);
  });

  it('persists only the supported 25/50/100 MB soft caps', async () => {
    const local = createArea({});
    const sync = createArea({});
    const { chromeApi } = createChromeMock(local, sync);
    const service = new StorageQuotaService({ chromeApi, buildTarget: () => 'chrome' });

    await service.saveSoftCapMb(100);
    expect(local.data[STORAGE_QUOTA_SOFT_CAP_KEY]).toBe(100);
    await expect(service.saveSoftCapMb(75 as StorageSoftCapMb)).rejects.toThrow(RangeError);
    expect(local.data[STORAGE_QUOTA_SOFT_CAP_KEY]).toBe(100);
  });

  it('reports undeclared and required Firefox permission states without requesting', async () => {
    const local = createArea({});
    const sync = createArea({});
    const undeclared = createChromeMock(local, sync, { declared: false });
    const undeclaredService = new StorageQuotaService({
      chromeApi: undeclared.chromeApi,
      buildTarget: () => 'chrome',
    });

    await expect(undeclaredService.getUnlimitedStoragePermissionStatus()).resolves.toMatchObject({
      declared: false,
      granted: false,
      requestable: false,
      reason: 'not-declared',
    });
    await expect(undeclaredService.requestUnlimitedStoragePermission()).resolves.toMatchObject({
      requested: false,
      reason: 'not-declared',
    });
    expect(undeclared.request).not.toHaveBeenCalled();

    const firefox = createChromeMock(local, sync, { required: true });
    const firefoxService = new StorageQuotaService({
      chromeApi: firefox.chromeApi,
      buildTarget: () => 'firefox',
    });
    await expect(firefoxService.requestUnlimitedStoragePermission()).resolves.toMatchObject({
      requested: false,
      granted: true,
      reason: 'already-granted',
      status: {
        browser: 'firefox',
        supported: true,
        granted: true,
        requestable: false,
      },
    });
    expect(firefox.request).not.toHaveBeenCalled();
  });

  it('treats a required Chromium permission as granted without a runtime request', async () => {
    const local = createArea({});
    const sync = createArea({});
    const chromium = createChromeMock(local, sync, { required: true, granted: false });
    const service = new StorageQuotaService({
      chromeApi: chromium.chromeApi,
      buildTarget: () => 'chrome',
    });

    await expect(service.getUnlimitedStoragePermissionStatus()).resolves.toMatchObject({
      browser: 'chromium',
      declared: true,
      granted: true,
      requestable: false,
      reason: 'already-granted',
    });
    await expect(service.requestUnlimitedStoragePermission()).resolves.toMatchObject({
      requested: false,
      granted: true,
      reason: 'already-granted',
    });
    expect(chromium.request).not.toHaveBeenCalled();
    expect(chromium.contains).not.toHaveBeenCalled();
  });

  it('requests unlimitedStorage before the first asynchronous permission status check', async () => {
    const local = createArea({});
    const sync = createArea({});
    const permissions = createChromeMock(local, sync, { requestResult: true });
    const service = new StorageQuotaService({
      chromeApi: permissions.chromeApi,
      buildTarget: () => 'chrome',
    });

    const result = await service.requestUnlimitedStoragePermission();

    expect(permissions.request).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ requested: true, granted: true, reason: 'granted' });
    expect(permissions.contains).toHaveBeenCalledTimes(1);
    expect(permissions.request.mock.invocationCallOrder[0]).toBeLessThan(
      permissions.contains.mock.invocationCallOrder[0],
    );
  });

  it.each([
    { granted: false, major: 15, legacy: true, expected: 5 * MEBIBYTE },
    { granted: true, major: 15, legacy: true, expected: 10 * MEBIBYTE },
    { granted: true, major: 16, legacy: false, expected: null },
  ])(
    'uses the Safari-version local quota for granted=$granted major=$major',
    async ({ granted, major, legacy, expected }) => {
      const local = createArea({}, { quotaBytes: 99 * MEBIBYTE });
      const sync = createArea({});
      const { chromeApi } = createChromeMock(local, sync, { granted });
      const service = new StorageQuotaService({
        chromeApi,
        buildTarget: () => 'safari',
        safariMajorVersion: () => major,
        legacySafariStorageLimit: () => legacy,
      });

      const snapshot = await service.getSnapshot();

      expect(snapshot.local.quotaBytes).toBe(expected);
      expect(snapshot.local.quotaEstimated).toBe(false);
    },
  );

  it('marks an unknown Safari granted quota as estimated instead of assuming 10 MiB', async () => {
    const local = createArea({}, { quotaBytes: 99 * MEBIBYTE });
    const sync = createArea({});
    const { chromeApi } = createChromeMock(local, sync, { granted: true });
    const snapshot = await new StorageQuotaService({
      chromeApi,
      buildTarget: () => 'safari',
      safariMajorVersion: () => null,
      legacySafariStorageLimit: () => false,
    }).getSnapshot();

    expect(snapshot.local.quotaBytes).toBe(99 * MEBIBYTE);
    expect(snapshot.local.quotaEstimated).toBe(true);
  });

  it('clears only the explicit regenerable cache keys and never calls clear()', async () => {
    const local = createArea(
      {
        [StorageKeys.GV_GEMS_LIST_CACHE]: { items: [1] },
        [`${StorageKeys.GV_USAGE_CACHE}:account`]: { daily: [1] },
        [StorageKeys.GV_GEMS_MRU]: { entries: [1] },
        [StorageKeys.PROMPT_ITEMS]: [{ id: 'keep' }],
        unknownCacheLikeName: { keep: true },
      },
      {
        weights: {
          [StorageKeys.GV_GEMS_LIST_CACHE]: 100,
          [`${StorageKeys.GV_USAGE_CACHE}:account`]: 50,
          [StorageKeys.GV_GEMS_MRU]: 80,
          [StorageKeys.PROMPT_ITEMS]: 70,
          unknownCacheLikeName: 60,
        },
      },
    );
    const sync = createArea({});
    const { chromeApi } = createChromeMock(local, sync);
    const service = new StorageQuotaService({ chromeApi, buildTarget: () => 'chrome' });

    const result = await service.clearCategory('cache');

    expect(result.removedKeys).toEqual([
      StorageKeys.GV_GEMS_LIST_CACHE,
      `${StorageKeys.GV_USAGE_CACHE}:account`,
    ]);
    expect(result.bytesBefore).toBe(150);
    expect(result.bytesAfter).toBe(0);
    expect(result.bytesFreed).toBe(150);
    expect(local.data[StorageKeys.GV_GEMS_MRU]).toBeDefined();
    expect(local.data[StorageKeys.PROMPT_ITEMS]).toBeDefined();
    expect(local.data.unknownCacheLikeName).toBeDefined();
    expect(local.mocks.clear).not.toHaveBeenCalled();
  });

  it.each([
    ['drafts' as const, ['gvDraft_/app/one', 'gvDraft_/app/two']],
    ['highlights' as const, ['gvHighlight:records', 'gvAnnotation:bucket:v1:acct:a:conv:b']],
  ])('clears the narrowly matched %s category', async (categoryId, expectedKeys) => {
    const local = createArea({
      'gvDraft_/app/one': { text: 'one' },
      'gvDraft_/app/two': { text: 'two' },
      'gvHighlight:records': [1],
      'gvAnnotation:index': [2],
      'gvAnnotation:bucket:v1:acct:a:conv:b': [3],
      gvHighlightedTheme: 'keep because unknown keys are never deleted',
      [StorageKeys.FOLDER_DATA]: { folders: [] },
    });
    const sync = createArea({});
    const { chromeApi } = createChromeMock(local, sync);
    const service = new StorageQuotaService({ chromeApi, buildTarget: () => 'chrome' });

    const result = await service.clearCategory(categoryId);

    expect(result.removedKeys).toEqual(expectedKeys);
    expect(local.data.gvHighlightedTheme).toBeDefined();
    expect(local.data['gvAnnotation:index']).toBeDefined();
    expect(local.data[StorageKeys.FOLDER_DATA]).toBeDefined();
    expect(local.mocks.clear).not.toHaveBeenCalled();
  });

  it('rejects protected categories even if a caller bypasses the TypeScript union', async () => {
    const local = createArea({ [StorageKeys.PROMPT_ITEMS]: [{ id: 'keep' }] });
    const sync = createArea({});
    const { chromeApi } = createChromeMock(local, sync);
    const service = new StorageQuotaService({ chromeApi, buildTarget: () => 'chrome' });

    await expect(service.clearCategory('prompts' as 'cache')).rejects.toThrow(
      'Storage category is not clearable',
    );
    expect(local.mocks.remove).not.toHaveBeenCalled();
    expect(local.mocks.clear).not.toHaveBeenCalled();
  });
});
