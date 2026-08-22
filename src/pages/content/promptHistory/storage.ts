/**
 * Account-scoped prompt history storage (#923).
 *
 * Every occurrence has its own storage key. Independent keys keep concurrent
 * captures from different tabs from overwriting each other, while the account
 * prefix keeps Gemini's /u/<index> profiles isolated.
 */
import { StorageKeys } from '@/core/types/common';

export type PromptHistoryType = 'sent' | 'edited';

export interface PromptHistoryItem {
  id: string;
  accountScope: string;
  content: string;
  timestamp: number;
  path: string;
  type: PromptHistoryType;
}

interface StoredPromptHistoryItem {
  key: string;
  item: PromptHistoryItem;
  bytes: number;
}

const HISTORY_KEY_SEPARATOR = ':';
const DEFAULT_ACCOUNT_INDEX = '0';
const DEDUPLICATION_WINDOW_MS = 10_000;

/** Maximum number of history entries across all Gemini accounts. */
export const MAX_ITEMS = 500;

/** Maximum bytes reserved for prompt history across all Gemini accounts. */
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/** Per-entry content length cap. */
export const MAX_CONTENT_LENGTH = 50_000;

function runtimeError(): Error | null {
  const message = chrome.runtime?.lastError?.message;
  return message ? new Error(message) : null;
}

function localGetAll(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    try {
      if (!chrome.storage?.local?.get) {
        reject(new Error('Local extension storage is unavailable'));
        return;
      }
      chrome.storage.local.get(null, (result) => {
        const error = runtimeError();
        if (error) {
          reject(error);
          return;
        }
        resolve(result ?? {});
      });
    } catch (error) {
      reject(error);
    }
  });
}

function localSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      if (!chrome.storage?.local?.set) {
        reject(new Error('Local extension storage is unavailable'));
        return;
      }
      chrome.storage.local.set(items, () => {
        const error = runtimeError();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function localRemove(keys: string[]): Promise<void> {
  if (keys.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    try {
      if (!chrome.storage?.local?.remove) {
        reject(new Error('Local extension storage is unavailable'));
        return;
      }
      chrome.storage.local.remove(keys, () => {
        const error = runtimeError();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function isEntry(value: unknown): value is PromptHistoryItem {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.accountScope === 'string' &&
    typeof entry.content === 'string' &&
    typeof entry.timestamp === 'number' &&
    Number.isFinite(entry.timestamp) &&
    typeof entry.path === 'string' &&
    (entry.type === 'sent' || entry.type === 'edited')
  );
}

function estimateEntryBytes(key: string, item: PromptHistoryItem): number {
  return new TextEncoder().encode(JSON.stringify({ [key]: item })).byteLength;
}

function historyRootPrefix(): string {
  return `${StorageKeys.PROMPT_HISTORY_ITEMS}${HISTORY_KEY_SEPARATOR}`;
}

export function getPromptHistoryAccountScope(pathname: string): string {
  const accountIndex = pathname.match(/^\/u\/(\d+)(?:\/|$)/)?.[1] ?? DEFAULT_ACCOUNT_INDEX;
  return `u:${accountIndex}`;
}

export function getPromptHistoryStoragePrefix(accountScope: string): string {
  return `${historyRootPrefix()}${accountScope}${HISTORY_KEY_SEPARATOR}`;
}

export function isPromptHistoryStorageKey(key: string): boolean {
  return key.startsWith(historyRootPrefix());
}

export function isPromptHistoryStorageKeyForAccount(key: string, accountScope: string): boolean {
  return key.startsWith(getPromptHistoryStoragePrefix(accountScope));
}

function getStoredEntries(items: Record<string, unknown>): StoredPromptHistoryItem[] {
  return Object.entries(items).flatMap(([key, value]) => {
    if (!isPromptHistoryStorageKey(key) || !isEntry(value)) return [];
    const expectedPrefix = getPromptHistoryStoragePrefix(value.accountScope);
    if (!key.startsWith(expectedPrefix) || !key.endsWith(value.id)) return [];
    return [{ key, item: value, bytes: estimateEntryBytes(key, value) }];
  });
}

function getItemKey(item: PromptHistoryItem): string {
  return `${getPromptHistoryStoragePrefix(item.accountScope)}${item.id}`;
}

/** Read one Gemini account's history, newest first. */
export async function getPromptHistory(accountScope: string): Promise<PromptHistoryItem[]> {
  const stored = getStoredEntries(await localGetAll());
  return stored
    .filter(({ item }) => item.accountScope === accountScope)
    .map(({ item }) => item)
    .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Store one prompt occurrence. The independent item key makes concurrent tab
 * writes additive; the follow-up pruning pass only removes exact oldest keys.
 */
export async function addPromptHistory(
  content: string,
  type: PromptHistoryType,
  path: string,
  accountScope = getPromptHistoryAccountScope(path),
): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) return;

  const now = Date.now();
  const boundedContent = trimmed.slice(0, MAX_CONTENT_LENGTH);
  const existing = await getPromptHistory(accountScope);
  const duplicate = existing.some(
    (item) =>
      item.content === boundedContent &&
      item.path === path &&
      item.type === type &&
      now - item.timestamp >= 0 &&
      now - item.timestamp < DEDUPLICATION_WINDOW_MS,
  );
  if (duplicate) return;

  const item: PromptHistoryItem = {
    id: crypto.randomUUID(),
    accountScope,
    content: boundedContent,
    timestamp: now,
    path,
    type,
  };

  await localSet({ [getItemKey(item)]: item });
  await prunePromptHistory();
}

/** Remove one exact item without reading or rewriting its siblings. */
export async function removePromptHistoryItem(id: string, accountScope: string): Promise<void> {
  await localRemove([`${getPromptHistoryStoragePrefix(accountScope)}${id}`]);
}

/** Clear only the active Gemini account's prompt history. */
export async function clearPromptHistory(accountScope: string): Promise<void> {
  const items = await localGetAll();
  const keys = Object.keys(items).filter((key) =>
    isPromptHistoryStorageKeyForAccount(key, accountScope),
  );
  await localRemove(keys);
}

/** Bound total prompt-history count and encoded size across all accounts. */
export async function prunePromptHistory(): Promise<void> {
  const entries = getStoredEntries(await localGetAll()).sort(
    (a, b) => b.item.timestamp - a.item.timestamp,
  );
  let retainedBytes = 0;
  const removeKeys: string[] = [];

  entries.forEach((entry, index) => {
    const withinCount = index < MAX_ITEMS;
    const withinBytes = retainedBytes + entry.bytes <= MAX_TOTAL_BYTES;
    if (withinCount && withinBytes) {
      retainedBytes += entry.bytes;
      return;
    }
    removeKeys.push(entry.key);
  });

  if (removeKeys.length === 0) return;
  await localRemove(removeKeys);
}
