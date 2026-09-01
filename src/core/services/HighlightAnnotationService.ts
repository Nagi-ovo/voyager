import {
  DEFAULT_STORAGE_SOFT_CAP_MB,
  STORAGE_QUOTA_SOFT_CAP_KEY,
  STORAGE_SOFT_CAP_OPTIONS_MB,
  type StorageSoftCapMb,
} from '@/core/services/StorageQuotaService';
import type {
  HighlightAccountScope,
  HighlightClearMarkerV1,
  HighlightConversationBucketV1,
  HighlightConversationIndexEntryV1,
  HighlightCreateInput,
  HighlightImportStats,
  HighlightIndexV1,
  HighlightRecordV1,
  HighlightStoredAccountScope,
  HighlightUpdatePatch,
} from '@/core/types/highlight';
import {
  HIGHLIGHT_BUCKET_KEY_PREFIX,
  HIGHLIGHT_DEVICE_ID_KEY,
  HIGHLIGHT_INDEX_KEY_PREFIX,
  HIGHLIGHT_LIMITS,
  HIGHLIGHT_SCHEMA_VERSION,
  isHighlightClearMarkerV1,
  isHighlightRecordV1,
} from '@/core/types/highlight';
import { getSafariMajorVersion, getVoyagerBuildTarget } from '@/core/utils/browser';
import { hashString } from '@/core/utils/hash';

const MEBIBYTE = 1024 * 1024;
const MINIMUM_STORAGE_RESERVE_BYTES = 512 * 1024;
const STORAGE_RESERVE_RATIO = 0.1;

export type HighlightScope = HighlightAccountScope | HighlightStoredAccountScope;

export type HighlightAnnotationErrorCode =
  | 'INVALID_SCOPE'
  | 'VALIDATION_FAILED'
  | 'RECORD_TOO_LARGE'
  | 'SOFT_CAP_REACHED'
  | 'NOT_FOUND'
  | 'ACCOUNT_MISMATCH'
  | 'CORRUPT_DATA'
  | 'STORAGE_UNAVAILABLE';

export class HighlightAnnotationError extends Error {
  constructor(
    public readonly code: HighlightAnnotationErrorCode,
    message: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HighlightAnnotationError';
  }
}

export interface HighlightAddResult {
  record: HighlightRecordV1;
  duplicate: boolean;
}

export interface HighlightRemoveResult {
  removed: boolean;
  tombstone: boolean;
  record?: HighlightRecordV1;
}

export interface HighlightClearResult {
  removed: number;
  clearMarker: HighlightClearMarkerV1;
}

export interface HighlightClearAllAccountsResult {
  removed: number;
  accounts: Array<{
    accountScope: HighlightStoredAccountScope;
    clearMarker: HighlightClearMarkerV1;
  }>;
}

export interface HighlightAccountSnapshot {
  accountScope: HighlightStoredAccountScope;
  clearMarker?: HighlightClearMarkerV1;
  records: HighlightRecordV1[];
}

export interface HighlightImportMergeOptions {
  clearMarker?: HighlightClearMarkerV1;
}

export interface HighlightQueryOptions {
  includeDeleted?: boolean;
}

export interface HighlightStorageAdapter {
  get(keys: null | string | readonly string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | readonly string[]): Promise<void>;
  getBytesInUse?(keys: null | string | readonly string[]): Promise<number>;
  /** null means the granted runtime permission removes the practical quota. */
  getEffectiveQuotaBytes?(): Promise<number | null>;
}

export interface HighlightAnnotationServiceDependencies {
  storage?: HighlightStorageAdapter;
  now?: () => number;
  randomUUID?: () => string;
}

interface ExtensionStorageAreaLike {
  get?: (...args: unknown[]) => unknown;
  set?: (...args: unknown[]) => unknown;
  remove?: (...args: unknown[]) => unknown;
  getBytesInUse?: (...args: unknown[]) => unknown;
  QUOTA_BYTES?: number;
}

interface ExtensionRuntimeLike {
  lastError?: { message?: string } | null;
  getManifest?: () => { permissions?: string[]; optional_permissions?: string[] };
}

interface ExtensionChromeLike {
  storage?: { local?: ExtensionStorageAreaLike };
  permissions?: { contains?: (...args: unknown[]) => unknown };
  runtime?: ExtensionRuntimeLike;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function serializedItemBytes(key: string, value: unknown): number {
  return utf8Bytes(JSON.stringify({ [key]: value }));
}

function normalizeSoftCap(value: unknown): StorageSoftCapMb {
  return STORAGE_SOFT_CAP_OPTIONS_MB.includes(value as StorageSoftCapMb)
    ? (value as StorageSoftCapMb)
    : DEFAULT_STORAGE_SOFT_CAP_MB;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Deterministic total ordering used by local imports and future cloud merges. */
export function compareHighlightRecords(left: HighlightRecordV1, right: HighlightRecordV1): number {
  if (left.revision.counter !== right.revision.counter) {
    return left.revision.counter - right.revision.counter;
  }
  if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt;
  const deviceOrder = compareStrings(left.revision.deviceId, right.revision.deviceId);
  return deviceOrder !== 0 ? deviceOrder : compareStrings(left.id, right.id);
}

function compareClearMarkers(left: HighlightClearMarkerV1, right: HighlightClearMarkerV1): number {
  if (left.generation && right.generation) {
    if (left.generation.counter !== right.generation.counter) {
      return left.generation.counter - right.generation.counter;
    }
    const generationOrder = compareStrings(left.generation.id, right.generation.id);
    if (generationOrder !== 0) return generationOrder;
  } else if (left.generation || right.generation) {
    // Any marker written by the generation-aware implementation supersedes a
    // legacy marker whose ordering could only rely on cross-device clocks.
    return left.generation ? 1 : -1;
  }

  // Legacy fallback for v1 exports written before clear generations existed.
  if (left.revision.deviceId === right.revision.deviceId) {
    if (left.revision.counter !== right.revision.counter) {
      return left.revision.counter - right.revision.counter;
    }
    return left.clearedAt - right.clearedAt;
  }

  // Like record revisions, counters from different devices have no shared
  // scale. Prefer the later clear time, then use the remaining fields only as
  // deterministic tie-breakers.
  if (left.clearedAt !== right.clearedAt) return left.clearedAt - right.clearedAt;
  if (left.revision.counter !== right.revision.counter) {
    return left.revision.counter - right.revision.counter;
  }
  return compareStrings(left.revision.deviceId, right.revision.deviceId);
}

function isClearedByMarker(
  record: HighlightRecordV1,
  marker: HighlightClearMarkerV1 | undefined,
): boolean {
  if (!marker) return false;

  // New records inherit the current generation. Everything from an earlier
  // or concurrent generation is compacted, independent of device wall clocks.
  if (marker.generation) return record.clearGeneration !== marker.generation.id;

  // Legacy fallback for v1 exports written before clear generations existed.
  // Revision counters are monotonic only within one device. For that device,
  // the counter is authoritative even if the system clock moves backwards.
  if (record.revision.deviceId === marker.revision.deviceId) {
    return record.revision.counter <= marker.revision.counter;
  }

  // Counters from different devices are not directly comparable. Use the
  // clear timestamp first so a stale remote record cannot reappear merely
  // because that device happened to have a larger local counter.
  if (record.updatedAt !== marker.clearedAt) return record.updatedAt < marker.clearedAt;
  if (record.revision.counter !== marker.revision.counter) {
    return record.revision.counter < marker.revision.counter;
  }
  return compareStrings(record.revision.deviceId, marker.revision.deviceId) <= 0;
}

function anchorIdentity(record: Pick<HighlightRecordV1, 'turnId' | 'anchor'>): string {
  const { quote, position, sourceTextHash } = record.anchor;
  return JSON.stringify([record.turnId, position.start, position.end, sourceTextHash, quote.exact]);
}

function generateFallbackUuid(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createHighlightSourceTextHash(sourceText: string): string {
  return `fnv1a:${hashString(sourceText)}`;
}

export function getHighlightAccountHash(scope: HighlightScope): string {
  if ('accountHash' in scope) {
    if (!scope.accountHash.trim()) {
      throw new HighlightAnnotationError('INVALID_SCOPE', 'Highlight account hash is required');
    }
    return scope.accountHash;
  }
  if (!scope.accountKey.trim()) {
    throw new HighlightAnnotationError('INVALID_SCOPE', 'Highlight account key is required');
  }
  return hashString(scope.accountKey);
}

export function getHighlightIndexStorageKey(scope: HighlightScope): string {
  return `${HIGHLIGHT_INDEX_KEY_PREFIX}${getHighlightAccountHash(scope)}`;
}

export function getHighlightConversationKey(
  scope: Pick<HighlightStoredAccountScope, 'platform'>,
  conversationId: string,
): string {
  return hashString(`${scope.platform}:${conversationId}`);
}

export function getHighlightBucketStorageKey(
  scope: HighlightScope,
  conversationId: string,
): string {
  const accountHash = getHighlightAccountHash(scope);
  const conversationKey = getHighlightConversationKey(scope, conversationId);
  return `${HIGHLIGHT_BUCKET_KEY_PREFIX}${accountHash}:conv:${conversationKey}`;
}

function storedScope(scope: HighlightScope): HighlightStoredAccountScope {
  return { platform: scope.platform, accountHash: getHighlightAccountHash(scope) };
}

async function callExtensionApi<T>(
  owner: object,
  method: ((...args: unknown[]) => unknown) | undefined,
  args: unknown[],
  runtime: ExtensionRuntimeLike | undefined,
): Promise<T> {
  if (!method) {
    throw new HighlightAnnotationError('STORAGE_UNAVAILABLE', 'Extension storage is unavailable');
  }

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
      const lastError = runtime?.lastError;
      if (lastError) {
        fail(new Error(lastError.message || 'Extension storage request failed'));
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

function createDefaultStorageAdapter(): HighlightStorageAdapter {
  const chromeApi = (globalThis as typeof globalThis & { chrome?: ExtensionChromeLike }).chrome;
  const area = chromeApi?.storage?.local;
  if (!area) {
    throw new HighlightAnnotationError(
      'STORAGE_UNAVAILABLE',
      'Extension local storage is unavailable',
    );
  }

  return {
    async get(keys) {
      return (
        (await callExtensionApi<Record<string, unknown>>(
          area,
          area.get,
          [keys],
          chromeApi?.runtime,
        )) ?? {}
      );
    },
    async set(items) {
      await callExtensionApi<void>(area, area.set, [items], chromeApi?.runtime);
    },
    async remove(keys) {
      await callExtensionApi<void>(area, area.remove, [keys], chromeApi?.runtime);
    },
    getBytesInUse: area.getBytesInUse
      ? async (keys) =>
          await callExtensionApi<number>(area, area.getBytesInUse, [keys], chromeApi?.runtime)
      : undefined,
    async getEffectiveQuotaBytes() {
      const manifest = chromeApi.runtime?.getManifest?.() ?? {};
      const requiredUnlimited = (manifest.permissions ?? []).includes('unlimitedStorage');
      let unlimitedGranted = requiredUnlimited;
      if (!unlimitedGranted && chromeApi.permissions?.contains) {
        try {
          unlimitedGranted =
            (await callExtensionApi<boolean>(
              chromeApi.permissions,
              chromeApi.permissions.contains,
              [{ permissions: ['unlimitedStorage'] }],
              chromeApi.runtime,
            )) === true;
        } catch {
          unlimitedGranted = false;
        }
      }

      const target = getVoyagerBuildTarget();
      if (unlimitedGranted) {
        if (target !== 'safari') return null;
        const majorVersion = getSafariMajorVersion();
        if (majorVersion !== null && majorVersion >= 16) return null;
        return 10 * MEBIBYTE;
      }
      if (typeof area.QUOTA_BYTES === 'number' && area.QUOTA_BYTES > 0) {
        return area.QUOTA_BYTES;
      }
      return target === 'firefox' || target === 'safari' ? 5 * MEBIBYTE : 10 * MEBIBYTE;
    },
  };
}

function createEmptyIndex(accountHash: string, now: number): HighlightIndexV1 {
  return {
    schemaVersion: HIGHLIGHT_SCHEMA_VERSION,
    accountHash,
    conversations: {},
    updatedAt: now,
  };
}

function createEmptyBucket(
  scope: HighlightStoredAccountScope,
  conversationId: string,
  now: number,
): HighlightConversationBucketV1 {
  return {
    schemaVersion: HIGHLIGHT_SCHEMA_VERSION,
    platform: scope.platform,
    accountHash: scope.accountHash,
    conversationId,
    records: {},
    updatedAt: now,
  };
}

function parseIndex(value: unknown, accountHash: string, now: number): HighlightIndexV1 {
  if (value === undefined) return createEmptyIndex(accountHash, now);
  if (
    !isObject(value) ||
    value.schemaVersion !== HIGHLIGHT_SCHEMA_VERSION ||
    value.accountHash !== accountHash ||
    !isObject(value.conversations) ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt)
  ) {
    throw new HighlightAnnotationError('CORRUPT_DATA', 'Highlight index is invalid', {
      accountHash,
    });
  }

  const conversations: Record<string, HighlightConversationIndexEntryV1> = {};
  for (const [key, rawEntry] of Object.entries(value.conversations)) {
    if (
      !isObject(rawEntry) ||
      (rawEntry.platform !== 'gemini' && rawEntry.platform !== 'aistudio') ||
      typeof rawEntry.conversationId !== 'string' ||
      typeof rawEntry.conversationKey !== 'string' ||
      rawEntry.conversationKey !== key ||
      typeof rawEntry.bucketKey !== 'string' ||
      !rawEntry.bucketKey.startsWith(HIGHLIGHT_BUCKET_KEY_PREFIX) ||
      !Number.isSafeInteger(rawEntry.activeCount) ||
      (rawEntry.activeCount as number) < 0 ||
      !Number.isSafeInteger(rawEntry.totalCount) ||
      (rawEntry.totalCount as number) < 0 ||
      typeof rawEntry.updatedAt !== 'number' ||
      !Number.isFinite(rawEntry.updatedAt)
    ) {
      throw new HighlightAnnotationError('CORRUPT_DATA', 'Highlight index entry is invalid', {
        accountHash,
        conversationKey: key,
      });
    }
    conversations[key] = rawEntry as unknown as HighlightConversationIndexEntryV1;
  }

  const clearMarkers: HighlightIndexV1['clearMarkers'] = {};
  if (value.clearMarkers !== undefined) {
    if (!isObject(value.clearMarkers)) {
      throw new HighlightAnnotationError('CORRUPT_DATA', 'Highlight clear markers are invalid');
    }
    for (const platform of ['gemini', 'aistudio'] as const) {
      const marker = value.clearMarkers[platform];
      if (marker === undefined) continue;
      if (!isHighlightClearMarkerV1(marker)) {
        throw new HighlightAnnotationError('CORRUPT_DATA', 'Highlight clear marker is invalid', {
          platform,
        });
      }
      clearMarkers[platform] = marker;
    }
  }

  return {
    schemaVersion: HIGHLIGHT_SCHEMA_VERSION,
    accountHash,
    conversations,
    ...(Object.keys(clearMarkers).length > 0 ? { clearMarkers } : {}),
    updatedAt: value.updatedAt,
  };
}

function parseBucket(
  value: unknown,
  scope: HighlightStoredAccountScope,
  conversationId: string,
  now: number,
): HighlightConversationBucketV1 {
  if (value === undefined) return createEmptyBucket(scope, conversationId, now);
  if (
    !isObject(value) ||
    value.schemaVersion !== HIGHLIGHT_SCHEMA_VERSION ||
    value.platform !== scope.platform ||
    value.accountHash !== scope.accountHash ||
    value.conversationId !== conversationId ||
    !isObject(value.records) ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt)
  ) {
    throw new HighlightAnnotationError('CORRUPT_DATA', 'Highlight conversation bucket is invalid', {
      accountHash: scope.accountHash,
      conversationId,
    });
  }

  const records: Record<string, HighlightRecordV1> = {};
  for (const [id, record] of Object.entries(value.records)) {
    if (
      id !== (isObject(record) ? record.id : undefined) ||
      !isHighlightRecordV1(record) ||
      record.platform !== scope.platform ||
      record.accountHash !== scope.accountHash ||
      record.conversationId !== conversationId
    ) {
      throw new HighlightAnnotationError('CORRUPT_DATA', 'Highlight record is invalid', {
        accountHash: scope.accountHash,
        conversationId,
        id,
      });
    }
    records[id] = record;
  }

  return {
    schemaVersion: HIGHLIGHT_SCHEMA_VERSION,
    platform: scope.platform,
    accountHash: scope.accountHash,
    conversationId,
    records,
    updatedAt: value.updatedAt,
  };
}

function updateIndexEntry(
  index: HighlightIndexV1,
  bucketKey: string,
  bucket: HighlightConversationBucketV1,
  now: number,
): HighlightIndexV1 {
  const conversationKey = getHighlightConversationKey(bucket, bucket.conversationId);
  const records = Object.values(bucket.records);
  const conversations = { ...index.conversations };
  if (records.length === 0) {
    delete conversations[conversationKey];
  } else {
    conversations[conversationKey] = {
      platform: bucket.platform,
      conversationId: bucket.conversationId,
      conversationKey,
      bucketKey,
      activeCount: records.filter((record) => record.deletedAt === undefined).length,
      totalCount: records.length,
      updatedAt: now,
    };
  }
  return { ...index, conversations, updatedAt: now };
}

export class HighlightAnnotationService {
  private readonly dependencies: HighlightAnnotationServiceDependencies;
  private operationQueue: Promise<unknown> = Promise.resolve();

  constructor(dependencies: HighlightAnnotationServiceDependencies = {}) {
    this.dependencies = dependencies;
  }

  private get storage(): HighlightStorageAdapter {
    return this.dependencies.storage ?? createDefaultStorageAdapter();
  }

  private get now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.catch(() => undefined);
    return next;
  }

  private generateUuid(): string {
    return (
      this.dependencies.randomUUID?.() ??
      globalThis.crypto?.randomUUID?.() ??
      generateFallbackUuid()
    );
  }

  private async getDeviceId(): Promise<{ id: string; needsWrite: boolean }> {
    const result = await this.storage.get(HIGHLIGHT_DEVICE_ID_KEY);
    const existing = result[HIGHLIGHT_DEVICE_ID_KEY];
    if (typeof existing === 'string' && existing.length > 0 && existing.length <= 128) {
      return { id: existing, needsWrite: false };
    }
    return { id: this.generateUuid(), needsWrite: true };
  }

  private async readIndex(scope: HighlightStoredAccountScope): Promise<HighlightIndexV1> {
    const key = getHighlightIndexStorageKey(scope);
    const result = await this.storage.get(key);
    return parseIndex(result[key], scope.accountHash, this.now);
  }

  private async readBucket(
    scope: HighlightStoredAccountScope,
    conversationId: string,
  ): Promise<HighlightConversationBucketV1> {
    const key = getHighlightBucketStorageKey(scope, conversationId);
    const result = await this.storage.get(key);
    return parseBucket(result[key], scope, conversationId, this.now);
  }

  private async readBucketsFromIndex(
    scope: HighlightStoredAccountScope,
    index: HighlightIndexV1,
  ): Promise<Map<string, { key: string; bucket: HighlightConversationBucketV1 }>> {
    const entries = Object.values(index.conversations).filter(
      (entry) => entry.platform === scope.platform,
    );
    const keys = entries.map((entry) => entry.bucketKey);
    const raw = keys.length > 0 ? await this.storage.get(keys) : {};
    const buckets = new Map<string, { key: string; bucket: HighlightConversationBucketV1 }>();
    for (const entry of entries) {
      const bucket = parseBucket(raw[entry.bucketKey], scope, entry.conversationId, this.now);
      buckets.set(entry.conversationKey, { key: entry.bucketKey, bucket });
    }
    return buckets;
  }

  private filterRecords(
    records: Iterable<HighlightRecordV1>,
    marker: HighlightClearMarkerV1 | undefined,
    options: HighlightQueryOptions,
  ): HighlightRecordV1[] {
    return Array.from(records)
      .filter((record) => !isClearedByMarker(record, marker))
      .filter((record) => options.includeDeleted === true || record.deletedAt === undefined)
      .sort((left, right) => right.updatedAt - left.updatedAt || compareStrings(left.id, right.id));
  }

  private async getAllUnsafe(
    scopeInput: HighlightScope,
    options: HighlightQueryOptions,
  ): Promise<HighlightRecordV1[]> {
    const scope = storedScope(scopeInput);
    const index = await this.readIndex(scope);
    const buckets = await this.readBucketsFromIndex(scope, index);
    const records = Array.from(buckets.values()).flatMap(({ bucket }) =>
      Object.values(bucket.records),
    );
    return this.filterRecords(records, index.clearMarkers?.[scope.platform], options);
  }

  async getAll(
    scope: HighlightScope,
    options: HighlightQueryOptions = {},
  ): Promise<HighlightRecordV1[]> {
    return this.serialize(() => this.getAllUnsafe(scope, options));
  }

  async getConversation(
    scopeInput: HighlightScope,
    conversationId: string,
    options: HighlightQueryOptions = {},
  ): Promise<HighlightRecordV1[]> {
    return this.serialize(async () => {
      const scope = storedScope(scopeInput);
      const [index, bucket] = await Promise.all([
        this.readIndex(scope),
        this.readBucket(scope, conversationId),
      ]);
      return this.filterRecords(
        Object.values(bucket.records),
        index.clearMarkers?.[scope.platform],
        options,
      );
    });
  }

  async getAllAccounts(options: HighlightQueryOptions = {}): Promise<HighlightRecordV1[]> {
    return this.serialize(async () => {
      const all = await this.storage.get(null);
      const clearMarkers = new Map<string, HighlightClearMarkerV1>();
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(HIGHLIGHT_INDEX_KEY_PREFIX)) continue;
        const accountHash = key.slice(HIGHLIGHT_INDEX_KEY_PREFIX.length);
        try {
          const index = parseIndex(value, accountHash, this.now);
          for (const platform of ['gemini', 'aistudio'] as const) {
            const marker = index.clearMarkers?.[platform];
            if (marker) clearMarkers.set(`${accountHash}:${platform}`, marker);
          }
        } catch {
          // Keep other accounts readable when one index is corrupt.
        }
      }
      const records: HighlightRecordV1[] = [];
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(HIGHLIGHT_BUCKET_KEY_PREFIX) || !isObject(value)) continue;
        if (
          (value.platform !== 'gemini' && value.platform !== 'aistudio') ||
          typeof value.accountHash !== 'string' ||
          typeof value.conversationId !== 'string'
        ) {
          continue;
        }
        try {
          const bucket = parseBucket(
            value,
            { platform: value.platform, accountHash: value.accountHash },
            value.conversationId,
            this.now,
          );
          records.push(...Object.values(bucket.records));
        } catch {
          // One corrupt account must not make the global read unusable.
        }
      }
      return records
        .filter(
          (record) =>
            !isClearedByMarker(
              record,
              clearMarkers.get(`${record.accountHash}:${record.platform}`),
            ),
        )
        .filter((record) => options.includeDeleted === true || record.deletedAt === undefined)
        .sort(
          (left, right) => right.updatedAt - left.updatedAt || compareStrings(left.id, right.id),
        );
    });
  }

  async getAccountSnapshot(scopeInput: HighlightScope): Promise<HighlightAccountSnapshot> {
    return this.serialize(async () => {
      const scope = storedScope(scopeInput);
      const index = await this.readIndex(scope);
      const buckets = await this.readBucketsFromIndex(scope, index);
      const records = this.filterRecords(
        Array.from(buckets.values()).flatMap(({ bucket }) => Object.values(bucket.records)),
        index.clearMarkers?.[scope.platform],
        { includeDeleted: true },
      );
      return {
        accountScope: scope,
        clearMarker: index.clearMarkers?.[scope.platform],
        records,
      };
    });
  }

  /**
   * Claim highlights written before a route id/email was available. Older page
   * loads could resolve to the unscoped `default` account during startup and
   * later resolve the Saved Library to the real email account. Treat that
   * default bucket as one-time legacy data: merge it into the first resolved
   * account, then clear only the matching platform from the legacy bucket.
   */
  async claimLegacyDefaultHighlights(scope: HighlightAccountScope): Promise<number> {
    if (scope.accountKey === 'default') return 0;

    const legacyScope: HighlightAccountScope = {
      platform: scope.platform,
      accountKey: 'default',
      accountId: 0,
      routeUserId: null,
    };
    const snapshot = await this.getAccountSnapshot(legacyScope);
    const legacyRecords = snapshot.records.filter((record) => record.platform === scope.platform);
    if (legacyRecords.length === 0) return 0;

    const accountHash = getHighlightAccountHash(scope);
    await this.importMerge(
      scope,
      legacyRecords.map((record) => ({ ...record, accountHash })),
    );
    await this.clearAll(legacyScope);
    return legacyRecords.filter((record) => record.deletedAt === undefined).length;
  }

  private async assertWithinSoftCap(
    setItems: Record<string, unknown>,
    removeKeys: readonly string[] = [],
    options: { allowOverCapGrowth?: boolean } = {},
  ): Promise<void> {
    const affectedKeys = Array.from(new Set([...Object.keys(setItems), ...removeKeys]));
    const keysToRead = Array.from(new Set([...affectedKeys, STORAGE_QUOTA_SOFT_CAP_KEY]));
    let currentItems = await this.storage.get(this.storage.getBytesInUse ? keysToRead : null);
    let currentBytes: number | null = null;
    if (this.storage.getBytesInUse) {
      try {
        const measured = await this.storage.getBytesInUse(null);
        if (Number.isFinite(measured) && measured >= 0) currentBytes = measured;
      } catch {
        // Fall back to a complete deterministic estimate below.
      }
    }
    if (currentBytes === null) {
      if (this.storage.getBytesInUse) currentItems = await this.storage.get(null);
      currentBytes = utf8Bytes(JSON.stringify(currentItems));
    }

    const softCapMb = normalizeSoftCap(currentItems[STORAGE_QUOTA_SOFT_CAP_KEY]);
    const configuredSoftCapBytes = softCapMb * MEBIBYTE;
    const runtimeQuotaBytes = await this.storage.getEffectiveQuotaBytes?.();
    const softCapBytes =
      typeof runtimeQuotaBytes === 'number'
        ? Math.min(configuredSoftCapBytes, runtimeQuotaBytes)
        : configuredSoftCapBytes;
    const reserveBytes = Math.max(
      MINIMUM_STORAGE_RESERVE_BYTES,
      Math.ceil(softCapBytes * STORAGE_RESERVE_RATIO),
    );
    const usableBytes = softCapBytes - reserveBytes;
    let oldAffectedBytes = 0;
    for (const key of affectedKeys) {
      if (key in currentItems) oldAffectedBytes += serializedItemBytes(key, currentItems[key]);
    }
    const newAffectedBytes = Object.entries(setItems).reduce(
      (sum, [key, value]) => sum + serializedItemBytes(key, value),
      0,
    );
    const projectedBytes = Math.max(0, currentBytes - oldAffectedBytes + newAffectedBytes);

    if (
      projectedBytes > usableBytes &&
      projectedBytes > currentBytes &&
      options.allowOverCapGrowth !== true
    ) {
      throw new HighlightAnnotationError(
        'SOFT_CAP_REACHED',
        'Highlight was not saved because the local storage safety reserve would be crossed',
        {
          currentBytes,
          projectedBytes,
          softCapBytes,
          configuredSoftCapBytes,
          runtimeQuotaBytes,
          reserveBytes,
          softCapMb,
        },
      );
    }
  }

  private async commit(
    setItems: Record<string, unknown>,
    removeKeys: readonly string[] = [],
    options: { allowOverCapGrowth?: boolean } = {},
  ): Promise<void> {
    await this.assertWithinSoftCap(setItems, removeKeys, options);
    if (Object.keys(setItems).length > 0) await this.storage.set(setItems);
    if (removeKeys.length > 0) await this.storage.remove(removeKeys);
  }

  private validateRecord(record: HighlightRecordV1): void {
    const recordId = record.id;
    const recordBytes = utf8Bytes(JSON.stringify(record));
    if (!isHighlightRecordV1(record)) {
      const code: HighlightAnnotationErrorCode =
        recordBytes > HIGHLIGHT_LIMITS.recordBytes ? 'RECORD_TOO_LARGE' : 'VALIDATION_FAILED';
      throw new HighlightAnnotationError(code, 'Highlight record failed validation', {
        id: recordId,
        recordBytes,
        maximumRecordBytes: HIGHLIGHT_LIMITS.recordBytes,
      });
    }
  }

  private nextRevisionCounter(
    bucket: HighlightConversationBucketV1,
    marker: HighlightClearMarkerV1 | undefined,
  ): number {
    return (
      Math.max(
        marker?.revision.counter ?? 0,
        ...Object.values(bucket.records).map((record) => record.revision.counter),
      ) + 1
    );
  }

  async add(scopeInput: HighlightScope, input: HighlightCreateInput): Promise<HighlightAddResult> {
    return this.serialize(async () => {
      const scope = storedScope(scopeInput);
      if (!input.conversationId.trim()) {
        throw new HighlightAnnotationError('VALIDATION_FAILED', 'Conversation id is required');
      }

      const [index, bucket] = await Promise.all([
        this.readIndex(scope),
        this.readBucket(scope, input.conversationId),
      ]);
      const marker = index.clearMarkers?.[scope.platform];
      const identity = anchorIdentity(input);
      const duplicate = Object.values(bucket.records).find(
        (record) =>
          record.deletedAt === undefined &&
          !isClearedByMarker(record, marker) &&
          anchorIdentity(record) === identity,
      );
      if (duplicate) return { record: duplicate, duplicate: true };

      const device = await this.getDeviceId();
      const now = this.now;
      const record: HighlightRecordV1 = {
        id: this.generateUuid(),
        schemaVersion: HIGHLIGHT_SCHEMA_VERSION,
        platform: scope.platform,
        accountHash: scope.accountHash,
        conversationId: input.conversationId,
        conversationUrl: input.conversationUrl,
        ...(input.conversationTitle !== undefined
          ? { conversationTitle: input.conversationTitle }
          : {}),
        turnId: input.turnId,
        role: input.role,
        anchor: input.anchor,
        ...(input.note !== undefined && input.note !== '' ? { note: input.note } : {}),
        color: input.color ?? 'yellow',
        createdAt: now,
        updatedAt: now,
        revision: {
          counter: this.nextRevisionCounter(bucket, marker),
          deviceId: device.id,
        },
        ...(marker?.generation ? { clearGeneration: marker.generation.id } : {}),
      };
      this.validateRecord(record);

      const bucketKey = getHighlightBucketStorageKey(scope, input.conversationId);
      const nextBucket: HighlightConversationBucketV1 = {
        ...bucket,
        records: { ...bucket.records, [record.id]: record },
        updatedAt: now,
      };
      const nextIndex = updateIndexEntry(index, bucketKey, nextBucket, now);
      await this.commit({
        [getHighlightIndexStorageKey(scope)]: nextIndex,
        [bucketKey]: nextBucket,
        ...(device.needsWrite ? { [HIGHLIGHT_DEVICE_ID_KEY]: device.id } : {}),
      });
      return { record, duplicate: false };
    });
  }

  async update(
    scopeInput: HighlightScope,
    conversationId: string,
    id: string,
    patch: HighlightUpdatePatch,
  ): Promise<HighlightRecordV1> {
    return this.serialize(async () => {
      const scope = storedScope(scopeInput);
      const [index, bucket, device] = await Promise.all([
        this.readIndex(scope),
        this.readBucket(scope, conversationId),
        this.getDeviceId(),
      ]);
      const existing = bucket.records[id];
      if (!existing || existing.deletedAt !== undefined) {
        throw new HighlightAnnotationError('NOT_FOUND', 'Highlight record was not found', {
          conversationId,
          id,
        });
      }

      const now = this.now;
      const updated: HighlightRecordV1 = {
        ...existing,
        ...(patch.conversationUrl !== undefined ? { conversationUrl: patch.conversationUrl } : {}),
        ...(patch.turnId !== undefined ? { turnId: patch.turnId } : {}),
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        ...(patch.anchor !== undefined ? { anchor: patch.anchor } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        updatedAt: now,
        revision: {
          counter: this.nextRevisionCounter(bucket, index.clearMarkers?.[scope.platform]),
          deviceId: device.id,
        },
      };
      if (patch.conversationTitle === null) delete updated.conversationTitle;
      else if (patch.conversationTitle !== undefined) {
        updated.conversationTitle = patch.conversationTitle;
      }
      if (patch.note === null || patch.note === '') delete updated.note;
      else if (patch.note !== undefined) updated.note = patch.note;
      this.validateRecord(updated);

      const updatedIdentity = anchorIdentity(updated);
      const duplicate = Object.values(bucket.records).find(
        (record) =>
          record.id !== id &&
          record.deletedAt === undefined &&
          anchorIdentity(record) === updatedIdentity,
      );
      if (duplicate) {
        throw new HighlightAnnotationError(
          'VALIDATION_FAILED',
          'Another highlight already uses this text anchor',
          { id, duplicateId: duplicate.id },
        );
      }

      const bucketKey = getHighlightBucketStorageKey(scope, conversationId);
      const nextBucket: HighlightConversationBucketV1 = {
        ...bucket,
        records: { ...bucket.records, [id]: updated },
        updatedAt: now,
      };
      const nextIndex = updateIndexEntry(index, bucketKey, nextBucket, now);
      await this.commit({
        [getHighlightIndexStorageKey(scope)]: nextIndex,
        [bucketKey]: nextBucket,
        ...(device.needsWrite ? { [HIGHLIGHT_DEVICE_ID_KEY]: device.id } : {}),
      });
      return updated;
    });
  }

  async remove(
    scopeInput: HighlightScope,
    conversationId: string,
    id: string,
    options: { tombstone?: boolean } = {},
  ): Promise<HighlightRemoveResult> {
    return this.serialize(async () => {
      const scope = storedScope(scopeInput);
      const [index, bucket] = await Promise.all([
        this.readIndex(scope),
        this.readBucket(scope, conversationId),
      ]);
      const existing = bucket.records[id];
      if (!existing) return { removed: false, tombstone: false };

      const now = this.now;
      const bucketKey = getHighlightBucketStorageKey(scope, conversationId);
      if (options.tombstone === true) {
        if (existing.deletedAt !== undefined) {
          return { removed: false, tombstone: true, record: existing };
        }
        const device = await this.getDeviceId();
        const tombstoneRecord: HighlightRecordV1 = {
          ...existing,
          anchor: {
            quote: { exact: 'x', prefix: '', suffix: '' },
            position: { start: 0, end: 1 },
            sourceTextHash: `deleted:${id}`,
          },
          updatedAt: now,
          deletedAt: now,
          revision: {
            counter: this.nextRevisionCounter(bucket, index.clearMarkers?.[scope.platform]),
            deviceId: device.id,
          },
        };
        delete tombstoneRecord.note;
        delete tombstoneRecord.conversationTitle;
        this.validateRecord(tombstoneRecord);
        const nextBucket: HighlightConversationBucketV1 = {
          ...bucket,
          records: { ...bucket.records, [id]: tombstoneRecord },
          updatedAt: now,
        };
        const nextIndex = updateIndexEntry(index, bucketKey, nextBucket, now);
        await this.commit(
          {
            [getHighlightIndexStorageKey(scope)]: nextIndex,
            [bucketKey]: nextBucket,
            ...(device.needsWrite ? { [HIGHLIGHT_DEVICE_ID_KEY]: device.id } : {}),
          },
          [],
          // Deletion must remain possible at the cap. The compact tombstone is
          // bounded and normally shrinks the bucket, but may add a few bytes to
          // an unusually tiny record.
          { allowOverCapGrowth: true },
        );
        return { removed: true, tombstone: true, record: tombstoneRecord };
      }

      const nextRecords = { ...bucket.records };
      delete nextRecords[id];
      const nextBucket: HighlightConversationBucketV1 = {
        ...bucket,
        records: nextRecords,
        updatedAt: now,
      };
      const nextIndex = updateIndexEntry(index, bucketKey, nextBucket, now);
      if (Object.keys(nextRecords).length === 0) {
        await this.commit(
          {
            [getHighlightIndexStorageKey(scope)]: nextIndex,
            // An empty write makes a crash between set/remove non-destructive.
            [bucketKey]: nextBucket,
          },
          [bucketKey],
        );
      } else {
        await this.commit({
          [getHighlightIndexStorageKey(scope)]: nextIndex,
          [bucketKey]: nextBucket,
        });
      }
      return { removed: true, tombstone: false };
    });
  }

  async clearAll(
    scopeInput: HighlightScope,
    options: { tombstone?: boolean } = {},
  ): Promise<HighlightClearResult> {
    return this.serialize(async () => {
      // A bounded account/platform clear marker is always kept. The option is
      // accepted for API symmetry with remove(), but clear never retains every
      // quote as an unbounded collection of tombstones.
      void options;
      const scope = storedScope(scopeInput);
      const index = await this.readIndex(scope);
      const buckets = await this.readBucketsFromIndex(scope, index);
      const device = await this.getDeviceId();
      const records = Array.from(buckets.values()).flatMap(({ bucket }) =>
        Object.values(bucket.records),
      );
      const now = this.now;
      const clearMarker: HighlightClearMarkerV1 = {
        clearedAt: now,
        revision: {
          counter:
            Math.max(
              index.clearMarkers?.[scope.platform]?.revision.counter ?? 0,
              ...records.map((record) => record.revision.counter),
            ) + 1,
          deviceId: device.id,
        },
        generation: {
          counter: (index.clearMarkers?.[scope.platform]?.generation?.counter ?? 0) + 1,
          id: this.generateUuid(),
        },
      };
      const conversations = Object.fromEntries(
        Object.entries(index.conversations).filter(
          ([, entry]) => entry.platform !== scope.platform,
        ),
      );
      const nextIndex: HighlightIndexV1 = {
        ...index,
        conversations,
        clearMarkers: {
          ...index.clearMarkers,
          [scope.platform]: clearMarker,
        },
        updatedAt: now,
      };
      await this.commit(
        {
          [getHighlightIndexStorageKey(scope)]: nextIndex,
          ...(device.needsWrite ? { [HIGHLIGHT_DEVICE_ID_KEY]: device.id } : {}),
        },
        Array.from(buckets.values()).map(({ key }) => key),
      );
      return {
        removed: records.filter((record) => record.deletedAt === undefined).length,
        clearMarker,
      };
    });
  }

  async clearAllAccounts(): Promise<HighlightClearAllAccountsResult> {
    return this.serialize(async () => {
      const all = await this.storage.get(null);
      const device = await this.getDeviceId();
      const now = this.now;
      const bucketKeys = Object.keys(all).filter((key) =>
        key.startsWith(HIGHLIGHT_BUCKET_KEY_PREFIX),
      );
      const accountStates = new Map<
        string,
        {
          index: HighlightIndexV1;
          platforms: Set<HighlightStoredAccountScope['platform']>;
          records: HighlightRecordV1[];
        }
      >();
      const invalidIndexKeys: string[] = [];

      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(HIGHLIGHT_INDEX_KEY_PREFIX)) continue;
        const accountHash = key.slice(HIGHLIGHT_INDEX_KEY_PREFIX.length);
        try {
          const index = parseIndex(value, accountHash, now);
          const platforms = new Set<HighlightStoredAccountScope['platform']>();
          Object.values(index.conversations).forEach((entry) => platforms.add(entry.platform));
          for (const platform of ['gemini', 'aistudio'] as const) {
            if (index.clearMarkers?.[platform]) platforms.add(platform);
          }
          accountStates.set(accountHash, { index, platforms, records: [] });
        } catch {
          // The explicit clear still removes corrupt annotation buckets. It
          // does not overwrite an index that cannot be safely interpreted.
          invalidIndexKeys.push(key);
        }
      }

      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(HIGHLIGHT_BUCKET_KEY_PREFIX) || !isObject(value)) continue;
        if (
          (value.platform !== 'gemini' && value.platform !== 'aistudio') ||
          typeof value.accountHash !== 'string' ||
          typeof value.conversationId !== 'string'
        ) {
          continue;
        }
        try {
          const scope: HighlightStoredAccountScope = {
            platform: value.platform,
            accountHash: value.accountHash,
          };
          const bucket = parseBucket(value, scope, value.conversationId, now);
          const state = accountStates.get(scope.accountHash) ?? {
            index: createEmptyIndex(scope.accountHash, now),
            platforms: new Set<HighlightStoredAccountScope['platform']>(),
            records: [],
          };
          state.platforms.add(scope.platform);
          state.records.push(...Object.values(bucket.records));
          accountStates.set(scope.accountHash, state);
        } catch {
          // The raw key remains in bucketKeys and is removed below.
        }
      }

      const setItems: Record<string, unknown> = device.needsWrite
        ? { [HIGHLIGHT_DEVICE_ID_KEY]: device.id }
        : {};
      const accounts: HighlightClearAllAccountsResult['accounts'] = [];
      let removed = 0;
      for (const [accountHash, state] of accountStates) {
        const clearMarkers = { ...state.index.clearMarkers };
        for (const platform of state.platforms) {
          const platformRecords = state.records.filter((record) => record.platform === platform);
          removed += platformRecords.filter((record) => record.deletedAt === undefined).length;
          const clearMarker: HighlightClearMarkerV1 = {
            clearedAt: now,
            revision: {
              counter:
                Math.max(
                  clearMarkers[platform]?.revision.counter ?? 0,
                  ...platformRecords.map((record) => record.revision.counter),
                ) + 1,
              deviceId: device.id,
            },
            generation: {
              counter: (clearMarkers[platform]?.generation?.counter ?? 0) + 1,
              id: this.generateUuid(),
            },
          };
          clearMarkers[platform] = clearMarker;
          accounts.push({
            accountScope: { platform, accountHash },
            clearMarker,
          });
        }
        setItems[`${HIGHLIGHT_INDEX_KEY_PREFIX}${accountHash}`] = {
          ...state.index,
          conversations: {},
          clearMarkers,
          updatedAt: now,
        } satisfies HighlightIndexV1;
      }

      const removeKeys = [...bucketKeys, ...invalidIndexKeys].filter((key) => !(key in setItems));
      await this.commit(setItems, removeKeys);
      return { removed, accounts };
    });
  }

  async importMerge(
    scopeInput: HighlightScope,
    importedRecords: readonly HighlightRecordV1[],
    options: HighlightImportMergeOptions = {},
  ): Promise<HighlightImportStats> {
    return this.serialize(async () => {
      const scope = storedScope(scopeInput);
      for (const record of importedRecords) {
        this.validateRecord(record);
        if (record.accountHash !== scope.accountHash || record.platform !== scope.platform) {
          throw new HighlightAnnotationError(
            'ACCOUNT_MISMATCH',
            'Imported highlight belongs to a different account or platform',
            {
              id: record.id,
              expectedAccountHash: scope.accountHash,
              actualAccountHash: record.accountHash,
              expectedPlatform: scope.platform,
              actualPlatform: record.platform,
            },
          );
        }
      }
      if (options.clearMarker !== undefined && !isHighlightClearMarkerV1(options.clearMarker)) {
        throw new HighlightAnnotationError('VALIDATION_FAILED', 'Imported clear marker is invalid');
      }

      const index = await this.readIndex(scope);
      const localMarker = index.clearMarkers?.[scope.platform];
      const importedMarker = options.clearMarker;
      const effectiveMarker =
        localMarker && importedMarker
          ? compareClearMarkers(localMarker, importedMarker) >= 0
            ? localMarker
            : importedMarker
          : (localMarker ?? importedMarker);

      const indexedBuckets = await this.readBucketsFromIndex(scope, index);
      const buckets = new Map<string, { key: string; bucket: HighlightConversationBucketV1 }>();
      for (const { key, bucket } of indexedBuckets.values()) {
        buckets.set(bucket.conversationId, { key, bucket });
      }

      const missingConversationIds = Array.from(
        new Set(importedRecords.map((record) => record.conversationId)),
      ).filter((conversationId) => !buckets.has(conversationId));
      const missingKeys = missingConversationIds.map((conversationId) =>
        getHighlightBucketStorageKey(scope, conversationId),
      );
      const missingRaw = missingKeys.length > 0 ? await this.storage.get(missingKeys) : {};
      missingConversationIds.forEach((conversationId, indexPosition) => {
        const key = missingKeys[indexPosition];
        buckets.set(conversationId, {
          key,
          bucket: parseBucket(missingRaw[key], scope, conversationId, this.now),
        });
      });

      // Compact anything covered by the winning bounded clear marker before
      // processing imported records. This prevents cleared data from being
      // resurrected and prevents per-record deletion history from growing.
      if (effectiveMarker) {
        for (const [conversationId, state] of buckets) {
          const records = Object.fromEntries(
            Object.entries(state.bucket.records).filter(
              ([, record]) => !isClearedByMarker(record, effectiveMarker),
            ),
          );
          buckets.set(conversationId, {
            ...state,
            bucket: { ...state.bucket, records },
          });
        }
      }

      let imported = 0;
      let updated = 0;
      let duplicates = 0;
      let skippedByClearMarker = 0;

      for (const incoming of importedRecords) {
        if (isClearedByMarker(incoming, effectiveMarker)) {
          skippedByClearMarker += 1;
          continue;
        }
        const state = buckets.get(incoming.conversationId);
        if (!state) {
          throw new HighlightAnnotationError('CORRUPT_DATA', 'Import bucket was not prepared', {
            conversationId: incoming.conversationId,
          });
        }
        const records = { ...state.bucket.records };
        const existingById = records[incoming.id];
        if (existingById) {
          if (compareHighlightRecords(incoming, existingById) > 0) {
            records[incoming.id] = incoming;
            updated += 1;
          } else {
            duplicates += 1;
            continue;
          }
        } else {
          const incomingIdentity = anchorIdentity(incoming);
          const existingAnchor = Object.values(records).find(
            (record) =>
              record.deletedAt === undefined &&
              incoming.deletedAt === undefined &&
              anchorIdentity(record) === incomingIdentity,
          );
          if (existingAnchor) {
            if (compareHighlightRecords(incoming, existingAnchor) > 0) {
              delete records[existingAnchor.id];
              records[incoming.id] = incoming;
              updated += 1;
            } else {
              duplicates += 1;
              continue;
            }
          } else {
            records[incoming.id] = incoming;
            imported += 1;
          }
        }
        buckets.set(incoming.conversationId, {
          ...state,
          bucket: { ...state.bucket, records, updatedAt: this.now },
        });
      }

      const now = this.now;
      let nextIndex: HighlightIndexV1 = {
        ...index,
        conversations: Object.fromEntries(
          Object.entries(index.conversations).filter(
            ([, entry]) => entry.platform !== scope.platform,
          ),
        ),
        clearMarkers: effectiveMarker
          ? { ...index.clearMarkers, [scope.platform]: effectiveMarker }
          : index.clearMarkers,
        updatedAt: now,
      };
      const setItems: Record<string, unknown> = {};
      const removeKeys: string[] = [];
      for (const state of buckets.values()) {
        const bucket = { ...state.bucket, updatedAt: now };
        nextIndex = updateIndexEntry(nextIndex, state.key, bucket, now);
        if (Object.keys(bucket.records).length === 0) removeKeys.push(state.key);
        else setItems[state.key] = bucket;
      }
      setItems[getHighlightIndexStorageKey(scope)] = nextIndex;
      await this.commit(setItems, removeKeys);

      const total = Array.from(buckets.values()).reduce(
        (sum, { bucket }) =>
          sum +
          Object.values(bucket.records).filter((record) => record.deletedAt === undefined).length,
        0,
      );
      return { imported, updated, duplicates, skippedByClearMarker, total };
    });
  }
}

export const highlightAnnotationService = new HighlightAnnotationService();
