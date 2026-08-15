/**
 * Prompt History Storage (#923)
 *
 * Persists sent/edited prompts to chrome.storage.local so users can recover
 * prompts that Gemini may have swallowed on error. Each entry is a single
 * prompt occurrence keyed by id; the list is bounded by MAX_ITEMS (oldest
 * pruned first) so storage usage stays bounded.
 */
import { StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';

export type PromptHistoryType = 'sent' | 'edited';

export interface PromptHistoryItem {
  id: string;
  content: string;
  timestamp: number;
  path: string;
  type: PromptHistoryType;
}

const LOG_PREFIX = '[PromptHistory]';

/** Maximum number of history entries to keep (oldest pruned first). */
export const MAX_ITEMS = 500;

/** Per-entry content length cap to keep storage usage bounded. */
export const MAX_CONTENT_LENGTH = 50000;

/** Prune only every N saves to avoid scanning storage on every write. */
const PRUNE_EVERY_N_SAVES = 20;

let saveCount = 0;

function getStorageKey(): string {
  return StorageKeys.PROMPT_HISTORY_ITEMS;
}

function isEntry(value: unknown): value is PromptHistoryItem {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.content === 'string' &&
    typeof entry.timestamp === 'number' &&
    typeof entry.path === 'string' &&
    (entry.type === 'sent' || entry.type === 'edited')
  );
}

/**
 * Read all stored history entries, newest first.
 */
export async function getPromptHistory(): Promise<PromptHistoryItem[]> {
  return new Promise((resolve) => {
    try {
      chrome.storage?.local?.get(getStorageKey(), (result) => {
        const raw = result?.[getStorageKey()];
        if (!Array.isArray(raw)) {
          resolve([]);
          return;
        }
        const entries = raw.filter(isEntry);
        entries.sort((a, b) => b.timestamp - a.timestamp);
        resolve(entries);
      });
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        resolve([]);
        return;
      }
      console.warn(LOG_PREFIX, 'Failed to read history:', error);
      resolve([]);
    }
  });
}

/**
 * Append a prompt occurrence to the history. The entry is deduplicated so a
 * burst of identical writes (e.g. repeated send-intent hits) only records the
 * first occurrence within a short window.
 */
export async function addPromptHistory(
  content: string,
  type: PromptHistoryType,
  path: string,
): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) return;

  const item: PromptHistoryItem = {
    id: crypto.randomUUID(),
    content: trimmed.slice(0, MAX_CONTENT_LENGTH),
    timestamp: Date.now(),
    path,
    type,
  };

  const items = await getPromptHistory();

  // De-duplicate: skip if an identical entry was just recorded within 10s.
  const now = item.timestamp;
  const duplicate = items.some(
    (existing) =>
      existing.content === item.content &&
      existing.path === item.path &&
      now - existing.timestamp < 10_000,
  );
  if (duplicate) return;

  const next = [item, ...items].slice(0, MAX_ITEMS);

  try {
    chrome.storage?.local?.set({ [getStorageKey()]: next }, () => {
      if (chrome.runtime.lastError) {
        console.warn(LOG_PREFIX, 'Failed to save history:', chrome.runtime.lastError.message);
        return;
      }
      saveCount++;
      if (saveCount % PRUNE_EVERY_N_SAVES === 0) {
        pruneHistory();
      }
    });
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) return;
    console.warn(LOG_PREFIX, 'Failed to save history:', error);
  }
}

/**
 * Remove a single history entry by id.
 */
export async function removePromptHistoryItem(id: string): Promise<void> {
  const items = await getPromptHistory();
  const next = items.filter((entry) => entry.id !== id);
  if (next.length === items.length) return;
  try {
    chrome.storage?.local?.set({ [getStorageKey()]: next });
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) return;
    console.warn(LOG_PREFIX, 'Failed to remove history item:', error);
  }
}

/**
 * Clear the entire prompt history.
 */
export async function clearPromptHistory(): Promise<void> {
  try {
    chrome.storage?.local?.remove(getStorageKey());
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) return;
    console.warn(LOG_PREFIX, 'Failed to clear history:', error);
  }
}

/**
 * Bound storage usage in case of a storage reset or concurrent writes.
 */
export function pruneHistory(): void {
  void getPromptHistory().then((items) => {
    if (items.length <= MAX_ITEMS) return;
    try {
      chrome.storage?.local?.set({ [getStorageKey()]: items.slice(0, MAX_ITEMS) });
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) return;
      console.warn(LOG_PREFIX, 'Failed to prune history:', error);
    }
  });
}
