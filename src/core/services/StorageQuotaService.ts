import { StorageKeys } from '@/core/types/common';
import {
  getSafariMajorVersion,
  getVoyagerBuildTarget,
  hasLegacySafariStorageLimit,
} from '@/core/utils/browser';

const MEBIBYTE = 1024 * 1024;
const KIBIBYTE = 1024;

export const STORAGE_QUOTA_SOFT_CAP_KEY = 'gvStorageSoftCapMb';
export const STORAGE_SOFT_CAP_OPTIONS_MB = [25, 50, 100] as const;
export const DEFAULT_STORAGE_SOFT_CAP_MB = 25;
export const STORAGE_QUOTA_WARNING_RATIO = 0.8;
export const STORAGE_QUOTA_CRITICAL_RATIO = 0.95;

export type StorageSoftCapMb = (typeof STORAGE_SOFT_CAP_OPTIONS_MB)[number];
export type StorageAreaId = 'local' | 'sync';
export type StorageCategoryId =
  | 'prompts'
  | 'folders'
  | 'timeline'
  | 'highlights'
  | 'drafts'
  | 'cache'
  | 'settings'
  | 'other';
export type ClearableStorageCategoryId = 'cache' | 'drafts' | 'highlights';

export interface StorageAreaUsage {
  area: StorageAreaId;
  bytesInUse: number;
  quotaBytes: number | null;
  usageRatio: number | null;
  available: boolean;
  estimated: boolean;
  quotaEstimated: boolean;
}

export interface StorageCategoryUsage {
  id: StorageCategoryId;
  area: 'local';
  bytesInUse: number;
  keys: readonly string[];
  clearable: boolean;
  estimated: boolean;
}

export type UnlimitedStoragePermissionReason =
  | 'available'
  | 'already-granted'
  | 'not-declared'
  | 'unsupported-firefox'
  | 'unsupported-api';

export interface UnlimitedStoragePermissionStatus {
  supported: boolean;
  declared: boolean;
  granted: boolean;
  requestable: boolean;
  browser: 'chromium' | 'firefox' | 'safari' | 'unknown';
  reason: UnlimitedStoragePermissionReason;
}

export type UnlimitedStoragePermissionRequestReason =
  | 'granted'
  | 'already-granted'
  | 'denied'
  | 'not-declared'
  | 'unsupported-firefox'
  | 'unsupported-api'
  | 'error';

export interface UnlimitedStoragePermissionRequestResult {
  requested: boolean;
  granted: boolean;
  reason: UnlimitedStoragePermissionRequestReason;
  status: UnlimitedStoragePermissionStatus;
  error?: string;
}

export interface StorageQuotaSnapshot {
  measuredAt: number;
  softCapMb: StorageSoftCapMb;
  softCapBytes: number;
  softCapUsageRatio: number;
  local: StorageAreaUsage;
  sync: StorageAreaUsage;
  categories: readonly StorageCategoryUsage[];
  permission: UnlimitedStoragePermissionStatus;
  estimated: boolean;
}

export function getStorageQuotaEffectiveUsageRatio(snapshot: StorageQuotaSnapshot): number | null {
  const localRatio =
    snapshot.local.available && snapshot.local.quotaBytes === null
      ? snapshot.softCapUsageRatio
      : snapshot.local.available
        ? snapshot.local.usageRatio
        : null;
  const ratios = [localRatio, snapshot.sync.available ? snapshot.sync.usageRatio : null].filter(
    (ratio): ratio is number => ratio !== null && Number.isFinite(ratio),
  );
  return ratios.length > 0 ? Math.max(...ratios) : null;
}

export interface StorageCleanupResult {
  category: ClearableStorageCategoryId;
  removedKeys: readonly string[];
  bytesBefore: number;
  bytesAfter: number;
  bytesFreed: number;
  estimated: boolean;
}

interface StorageAreaLike {
  get?: (...args: unknown[]) => unknown;
  set?: (...args: unknown[]) => unknown;
  remove?: (...args: unknown[]) => unknown;
  getBytesInUse?: (...args: unknown[]) => unknown;
  QUOTA_BYTES?: number;
}

interface PermissionsLike {
  contains?: (...args: unknown[]) => unknown;
  request?: (...args: unknown[]) => unknown;
}

interface RuntimeLike {
  getManifest?: () => {
    permissions?: string[];
    optional_permissions?: string[];
  };
  lastError?: { message?: string } | null;
}

interface ChromeLike {
  storage?: {
    local?: StorageAreaLike;
    sync?: StorageAreaLike;
  };
  permissions?: PermissionsLike;
  runtime?: RuntimeLike;
}

export interface StorageQuotaServiceDependencies {
  chromeApi?: ChromeLike;
  now?: () => number;
  userAgent?: () => string;
  buildTarget?: () => 'chrome' | 'edge' | 'firefox' | 'safari';
  safariMajorVersion?: () => number | null;
  legacySafariStorageLimit?: () => boolean;
}

interface AreaReadResult {
  usage: StorageAreaUsage;
  items: Record<string, unknown>;
}

interface CategoryDefinition {
  id: Exclude<StorageCategoryId, 'other'>;
  exactKeys?: ReadonlySet<string>;
  prefixes?: readonly string[];
  clearable: boolean;
}

const PROMPT_KEYS = new Set<string>([StorageKeys.PROMPT_ITEMS, StorageKeys.PROMPT_HISTORY_ITEMS]);

const FOLDER_KEYS = new Set<string>([StorageKeys.FOLDER_DATA, StorageKeys.FOLDER_DATA_AISTUDIO]);

const TIMELINE_KEYS = new Set<string>([
  StorageKeys.TIMELINE_STARRED_MESSAGES,
  StorageKeys.TIMELINE_HIERARCHY,
  StorageKeys.FORK_NODES,
  StorageKeys.GV_MESSAGE_TIMESTAMPS,
  'gvPendingFork',
]);

// Only values that can be rebuilt from the page/network belong here. User state
// such as Gems MRU, announcement history, prompts and folders is deliberately excluded.
const REGENERABLE_CACHE_KEYS = new Set<string>([
  StorageKeys.GV_GEMS_LIST_CACHE,
  StorageKeys.GV_USAGE_CACHE,
  StorageKeys.GV_USAGE_RECIPE,
  StorageKeys.GV_CLAUDE_USAGE_CACHE,
  StorageKeys.GV_CLAUDE_USAGE_REFRESH_LOCK,
  StorageKeys.PLUGIN_CATALOG_CACHE,
  'gvLatestVersionCache',
]);

// Centralized settings plus the few persisted literal keys that have not yet
// been moved into StorageKeys. This is intentionally explicit: unknown future
// keys remain visible in Other and are never deletable.
const SETTINGS_KEYS = new Set<string>([
  ...Object.values(StorageKeys),
  STORAGE_QUOTA_SOFT_CAP_KEY,
  'gvAccessToken',
  'gvTokenExpiry',
  'gvSyncMode',
  'gvLastUpload',
  'gvLastDownload',
  'gvSyncError',
  'gvBackupConfig',
  'gvGemsSidebarExpanded',
  // Legacy/pre-release annotation metadata. Canonical account indexes are
  // matched by the settings prefix below so clear markers survive cleanup.
  'gvAnnotation:index',
]);

const CATEGORY_DEFINITIONS: readonly CategoryDefinition[] = [
  {
    id: 'prompts',
    exactKeys: PROMPT_KEYS,
    prefixes: [`${StorageKeys.PROMPT_HISTORY_ITEMS}:`],
    clearable: false,
  },
  {
    id: 'folders',
    exactKeys: FOLDER_KEYS,
    prefixes: [
      `${StorageKeys.FOLDER_DATA}:acct:`,
      `${StorageKeys.FOLDER_DATA_AISTUDIO}:acct:`,
      'gvBackup_gemini-folders_',
      'gvBackup_aistudio-folders_',
    ],
    clearable: false,
  },
  {
    id: 'timeline',
    exactKeys: TIMELINE_KEYS,
    prefixes: [
      `${StorageKeys.TIMELINE_HIERARCHY}:acct:`,
      'geminiTimelineStars:',
      'geminiTimelineLevels:',
      'geminiTimelineCollapsed:',
    ],
    clearable: false,
  },
  {
    // Reserved for issue #794. Matching stays deliberately narrow so future
    // annotation data can be removed without touching unrelated user content.
    id: 'highlights',
    prefixes: ['gvHighlight:', 'gvAnnotation:bucket:'],
    clearable: true,
  },
  { id: 'drafts', prefixes: ['gvDraft_'], clearable: true },
  {
    id: 'cache',
    exactKeys: REGENERABLE_CACHE_KEYS,
    prefixes: [`${StorageKeys.GV_USAGE_CACHE}:`],
    clearable: true,
  },
  {
    id: 'settings',
    exactKeys: SETTINGS_KEYS,
    prefixes: ['gvAnnotation:index:'],
    clearable: false,
  },
];

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function estimateBytes(items: Record<string, unknown>): number {
  try {
    return new TextEncoder().encode(JSON.stringify(items)).byteLength;
  } catch {
    return 0;
  }
}

function pickItems(
  items: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in items).map((key) => [key, items[key]]));
}

function matchesCategory(key: string, definition: CategoryDefinition): boolean {
  return (
    definition.exactKeys?.has(key) === true ||
    definition.prefixes?.some((prefix) => key.startsWith(prefix)) === true
  );
}

function normalizeSoftCap(value: unknown): StorageSoftCapMb {
  return STORAGE_SOFT_CAP_OPTIONS_MB.includes(value as StorageSoftCapMb)
    ? (value as StorageSoftCapMb)
    : DEFAULT_STORAGE_SOFT_CAP_MB;
}

export class StorageQuotaService {
  private readonly dependencies: StorageQuotaServiceDependencies;

  constructor(dependencies: StorageQuotaServiceDependencies = {}) {
    this.dependencies = dependencies;
  }

  private get chromeApi(): ChromeLike {
    return (
      this.dependencies.chromeApi ??
      (globalThis as typeof globalThis & { chrome?: ChromeLike }).chrome ??
      {}
    );
  }

  private get runtime(): RuntimeLike | undefined {
    return this.chromeApi.runtime;
  }

  private async callApi<T>(
    owner: object,
    method: ((...args: unknown[]) => unknown) | undefined,
    args: unknown[],
  ): Promise<T> {
    if (typeof method !== 'function') throw new Error('Storage API unavailable');

    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (value: T): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const callback = (value: T): void => {
        const lastError = this.runtime?.lastError;
        if (lastError) {
          fail(new Error(lastError.message || 'Extension API request failed'));
          return;
        }
        finish(value);
      };

      try {
        const returned = method.apply(owner, [...args, callback]);
        if (isPromiseLike(returned)) {
          void Promise.resolve(returned).then((value) => finish(value as T), fail);
        } else if (returned !== undefined) {
          finish(returned as T);
        }
      } catch (error) {
        fail(error);
      }
    });
  }

  private async readArea(
    areaId: StorageAreaId,
    unlimitedGranted: boolean,
  ): Promise<AreaReadResult> {
    const area = this.chromeApi.storage?.[areaId];
    if (!area?.get) {
      return this.unavailableArea(areaId);
    }

    let items: Record<string, unknown>;
    try {
      items = (await this.callApi<Record<string, unknown>>(area, area.get, [null])) ?? {};
    } catch {
      return this.unavailableArea(areaId);
    }

    let bytesInUse = estimateBytes(items);
    let estimated = true;
    if (area.getBytesInUse) {
      try {
        const measured = await this.callApi<number>(area, area.getBytesInUse, [null]);
        if (typeof measured === 'number' && Number.isFinite(measured) && measured >= 0) {
          bytesInUse = measured;
          estimated = false;
        }
      } catch {
        // JSON byte estimation above is the graceful fallback for older APIs.
      }
    }

    const { quotaBytes, quotaEstimated } = this.resolveAreaQuota(
      areaId,
      area.QUOTA_BYTES,
      unlimitedGranted,
    );

    return {
      usage: {
        area: areaId,
        bytesInUse,
        quotaBytes,
        usageRatio: quotaBytes === null ? null : clampRatio(bytesInUse / quotaBytes),
        available: true,
        estimated,
        quotaEstimated,
      },
      items,
    };
  }

  private unavailableArea(area: StorageAreaId): AreaReadResult {
    return {
      usage: {
        area,
        bytesInUse: 0,
        quotaBytes: null,
        usageRatio: null,
        available: false,
        estimated: true,
        quotaEstimated: true,
      },
      items: {},
    };
  }

  private resolveAreaQuota(
    area: StorageAreaId,
    declaredQuota: number | undefined,
    unlimitedGranted: boolean,
  ): Pick<StorageAreaUsage, 'quotaBytes' | 'quotaEstimated'> {
    if (area === 'sync') {
      return typeof declaredQuota === 'number' && declaredQuota > 0
        ? { quotaBytes: declaredQuota, quotaEstimated: false }
        : { quotaBytes: 100 * KIBIBYTE, quotaEstimated: true };
    }

    if (this.detectBrowser() === 'safari') {
      if (!unlimitedGranted) return { quotaBytes: 5 * MEBIBYTE, quotaEstimated: false };

      const majorVersion = this.dependencies.safariMajorVersion?.() ?? getSafariMajorVersion();
      const hasLegacyLimit =
        this.dependencies.legacySafariStorageLimit?.() ?? hasLegacySafariStorageLimit();
      if (hasLegacyLimit || (majorVersion !== null && majorVersion < 16)) {
        return { quotaBytes: 10 * MEBIBYTE, quotaEstimated: false };
      }
      if (majorVersion !== null && majorVersion >= 16) {
        return { quotaBytes: null, quotaEstimated: false };
      }

      return typeof declaredQuota === 'number' && declaredQuota > 0
        ? { quotaBytes: declaredQuota, quotaEstimated: true }
        : { quotaBytes: null, quotaEstimated: true };
    }

    if (unlimitedGranted) return { quotaBytes: null, quotaEstimated: false };
    return typeof declaredQuota === 'number' && declaredQuota > 0
      ? { quotaBytes: declaredQuota, quotaEstimated: false }
      : { quotaBytes: 10 * MEBIBYTE, quotaEstimated: true };
  }

  private async bytesForKeys(
    area: StorageAreaLike | undefined,
    items: Record<string, unknown>,
    keys: readonly string[],
  ): Promise<{ bytes: number; estimated: boolean }> {
    if (keys.length === 0) return { bytes: 0, estimated: false };
    if (area?.getBytesInUse) {
      try {
        const measured = await this.callApi<number>(area, area.getBytesInUse, [[...keys]]);
        if (typeof measured === 'number' && Number.isFinite(measured) && measured >= 0) {
          return { bytes: measured, estimated: false };
        }
      } catch {
        // Fall through to a deterministic JSON estimate.
      }
    }
    return { bytes: estimateBytes(pickItems(items, keys)), estimated: true };
  }

  private async buildCategories(items: Record<string, unknown>): Promise<StorageCategoryUsage[]> {
    const keysByCategory = new Map<StorageCategoryId, string[]>();
    for (const definition of CATEGORY_DEFINITIONS) keysByCategory.set(definition.id, []);
    keysByCategory.set('other', []);

    for (const key of Object.keys(items)) {
      const definition = CATEGORY_DEFINITIONS.find((candidate) => matchesCategory(key, candidate));
      keysByCategory.get(definition?.id ?? 'other')?.push(key);
    }

    const area = this.chromeApi.storage?.local;
    const categories: StorageCategoryUsage[] = [];
    for (const definition of CATEGORY_DEFINITIONS) {
      const keys = keysByCategory.get(definition.id) ?? [];
      const usage = await this.bytesForKeys(area, items, keys);
      categories.push({
        id: definition.id,
        area: 'local',
        bytesInUse: usage.bytes,
        keys,
        clearable: definition.clearable,
        estimated: usage.estimated,
      });
    }

    const otherKeys = keysByCategory.get('other') ?? [];
    const otherUsage = await this.bytesForKeys(area, items, otherKeys);
    categories.push({
      id: 'other',
      area: 'local',
      bytesInUse: otherUsage.bytes,
      keys: otherKeys,
      clearable: false,
      estimated: otherUsage.estimated,
    });
    return categories;
  }

  private detectBrowser(): UnlimitedStoragePermissionStatus['browser'] {
    const target = this.dependencies.buildTarget?.() ?? getVoyagerBuildTarget();
    const ua = this.dependencies.userAgent?.() ?? globalThis.navigator?.userAgent ?? '';
    if (target === 'firefox' || /firefox/i.test(ua)) return 'firefox';
    if (target === 'safari') return 'safari';
    if (target === 'chrome' || target === 'edge' || /(?:chrome|chromium|edg)/i.test(ua)) {
      return 'chromium';
    }
    return 'unknown';
  }

  async getUnlimitedStoragePermissionStatus(): Promise<UnlimitedStoragePermissionStatus> {
    const browser = this.detectBrowser();
    const permissionsApi = this.chromeApi.permissions;
    const manifest = this.runtime?.getManifest?.() ?? {};
    const required = (manifest.permissions ?? []).includes('unlimitedStorage');
    const declared = [
      ...(manifest.permissions ?? []),
      ...(manifest.optional_permissions ?? []),
    ].includes('unlimitedStorage');

    if (required) {
      return {
        supported: true,
        declared: true,
        granted: true,
        requestable: false,
        browser,
        reason: 'already-granted',
      };
    }
    if (browser === 'firefox') {
      return {
        supported: true,
        declared,
        granted: false,
        requestable: false,
        browser,
        reason: 'not-declared',
      };
    }
    if (!permissionsApi?.contains || !permissionsApi.request) {
      return {
        supported: false,
        declared,
        granted: false,
        requestable: false,
        browser,
        reason: 'unsupported-api',
      };
    }

    let granted = false;
    try {
      granted =
        (await this.callApi<boolean>(permissionsApi, permissionsApi.contains, [
          { permissions: ['unlimitedStorage'] },
        ])) === true;
    } catch {
      // A missing/older permissions implementation behaves as unsupported.
      return {
        supported: false,
        declared,
        granted: false,
        requestable: false,
        browser,
        reason: 'unsupported-api',
      };
    }

    return {
      supported: true,
      declared,
      granted,
      requestable: declared && !granted,
      browser,
      reason: granted ? 'already-granted' : declared ? 'available' : 'not-declared',
    };
  }

  async requestUnlimitedStoragePermission(): Promise<UnlimitedStoragePermissionRequestResult> {
    // Keep all gating synchronous. Browser permission prompts require a live
    // user gesture, which would be lost by awaiting contains() first.
    const browser = this.detectBrowser();
    const permissionsApi = this.chromeApi.permissions;
    const manifest = this.runtime?.getManifest?.() ?? {};
    const required = (manifest.permissions ?? []).includes('unlimitedStorage');
    const declared = [
      ...(manifest.permissions ?? []),
      ...(manifest.optional_permissions ?? []),
    ].includes('unlimitedStorage');
    if (required || browser === 'firefox') {
      const status = await this.getUnlimitedStoragePermissionStatus();
      return {
        requested: false,
        granted: status.granted,
        reason: status.granted ? 'already-granted' : 'not-declared',
        status,
      };
    }

    const unsupportedReason: UnlimitedStoragePermissionReason = !declared
      ? 'not-declared'
      : 'unsupported-api';
    if (!declared || !permissionsApi?.request) {
      const status: UnlimitedStoragePermissionStatus = {
        supported: !!permissionsApi?.contains && !!permissionsApi?.request,
        declared,
        granted: false,
        requestable: false,
        browser,
        reason: unsupportedReason,
      };
      const reason: UnlimitedStoragePermissionRequestReason =
        unsupportedReason === 'not-declared' ? 'not-declared' : 'unsupported-api';
      return { requested: false, granted: false, reason, status };
    }

    try {
      // This must remain the first await in the supported path.
      const granted =
        (await this.callApi<boolean>(permissionsApi, permissionsApi.request, [
          { permissions: ['unlimitedStorage'] },
        ])) === true;
      const status = await this.getUnlimitedStoragePermissionStatus();
      return {
        requested: true,
        granted,
        reason: granted ? 'granted' : 'denied',
        status,
      };
    } catch (error) {
      const status = await this.getUnlimitedStoragePermissionStatus();
      return {
        requested: true,
        granted: false,
        reason: 'error',
        status,
        error: errorMessage(error),
      };
    }
  }

  async getSnapshot(): Promise<StorageQuotaSnapshot> {
    const permission = await this.getUnlimitedStoragePermissionStatus();
    const [local, sync] = await Promise.all([
      this.readArea('local', permission.granted),
      this.readArea('sync', false),
    ]);
    const softCapMb = normalizeSoftCap(local.items[STORAGE_QUOTA_SOFT_CAP_KEY]);
    const softCapBytes = softCapMb * MEBIBYTE;
    const categories = await this.buildCategories(local.items);

    return {
      measuredAt: this.dependencies.now?.() ?? Date.now(),
      softCapMb,
      softCapBytes,
      softCapUsageRatio: clampRatio(local.usage.bytesInUse / softCapBytes),
      local: local.usage,
      sync: sync.usage,
      categories,
      permission,
      estimated:
        local.usage.estimated || sync.usage.estimated || categories.some((item) => item.estimated),
    };
  }

  async saveSoftCapMb(value: StorageSoftCapMb): Promise<void> {
    if (!STORAGE_SOFT_CAP_OPTIONS_MB.includes(value)) {
      throw new RangeError('Storage soft cap must be 25, 50, or 100 MB');
    }
    const area = this.chromeApi.storage?.local;
    await this.callApi<void>(area ?? {}, area?.set, [{ [STORAGE_QUOTA_SOFT_CAP_KEY]: value }]);
  }

  async clearCategory(category: ClearableStorageCategoryId): Promise<StorageCleanupResult> {
    if (category !== 'cache' && category !== 'drafts' && category !== 'highlights') {
      throw new Error(`Storage category is not clearable: ${String(category)}`);
    }

    const beforeSnapshot = await this.getSnapshot();
    const before = beforeSnapshot.categories.find((item) => item.id === category);
    const removedKeys = [...(before?.keys ?? [])];
    if (removedKeys.length > 0) {
      const area = this.chromeApi.storage?.local;
      await this.callApi<void>(area ?? {}, area?.remove, [removedKeys]);
    }
    const afterSnapshot = await this.getSnapshot();
    const after = afterSnapshot.categories.find((item) => item.id === category);
    const bytesBefore = before?.bytesInUse ?? 0;
    const bytesAfter = after?.bytesInUse ?? 0;

    return {
      category,
      removedKeys,
      bytesBefore,
      bytesAfter,
      bytesFreed: Math.max(0, bytesBefore - bytesAfter),
      estimated: before?.estimated === true || after?.estimated === true,
    };
  }
}

export const storageQuotaService = new StorageQuotaService();

export const getStorageQuotaSnapshot = (): Promise<StorageQuotaSnapshot> =>
  storageQuotaService.getSnapshot();
export const saveStorageSoftCapMb = (value: StorageSoftCapMb): Promise<void> =>
  storageQuotaService.saveSoftCapMb(value);
export const getUnlimitedStoragePermissionStatus = (): Promise<UnlimitedStoragePermissionStatus> =>
  storageQuotaService.getUnlimitedStoragePermissionStatus();
export const requestUnlimitedStoragePermission =
  (): Promise<UnlimitedStoragePermissionRequestResult> =>
    storageQuotaService.requestUnlimitedStoragePermission();
export const clearStorageCategory = (
  category: ClearableStorageCategoryId,
): Promise<StorageCleanupResult> => storageQuotaService.clearCategory(category);
