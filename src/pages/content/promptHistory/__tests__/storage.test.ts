import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import {
  MAX_ITEMS,
  addPromptHistory,
  clearPromptHistory,
  getPromptHistory,
  removePromptHistoryItem,
} from '../storage';

let localStore: Record<string, unknown> = {};

function setupMocks() {
  localStore = {};

  (chrome.storage as unknown as Record<string, unknown>).local = {
    get: vi.fn((key: string | null, callback: (result: Record<string, unknown>) => void) => {
      if (key === null) {
        callback({ ...localStore });
      } else {
        callback({ [key]: localStore[key] });
      }
    }),
    set: vi.fn((items: Record<string, unknown>, callback?: () => void) => {
      Object.assign(localStore, items);
      callback?.();
    }),
    remove: vi.fn((keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete localStore[k];
    }),
    clear: vi.fn(() => {
      localStore = {};
    }),
  };
}

describe('promptHistory storage', () => {
  beforeEach(() => {
    setupMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an empty list when nothing is stored', async () => {
    const items = await getPromptHistory();
    expect(items).toEqual([]);
  });

  it('stores a new sent prompt and reads it back newest-first', async () => {
    await addPromptHistory('hello world', 'sent', '/app/abc');

    const items = await getPromptHistory();
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('hello world');
    expect(items[0].type).toBe('sent');
    expect(items[0].path).toBe('/app/abc');
    expect(items[0].timestamp).toBeGreaterThan(0);
  });

  it('stores an edited prompt with a different type', async () => {
    await addPromptHistory('revised prompt', 'edited', '/app/abc');

    const items = await getPromptHistory();
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('edited');
  });

  it('deduplicates identical writes within the same window', async () => {
    await addPromptHistory('same', 'sent', '/app/abc');
    await addPromptHistory('same', 'sent', '/app/abc');

    const items = await getPromptHistory();
    expect(items).toHaveLength(1);
  });

  it('ignores empty content', async () => {
    await addPromptHistory('   ', 'sent', '/app/abc');

    const items = await getPromptHistory();
    expect(items).toHaveLength(0);
  });

  it('removes a single item by id', async () => {
    await addPromptHistory('first', 'sent', '/app/abc');
    await addPromptHistory('second', 'sent', '/app/abc');

    const items = await getPromptHistory();
    expect(items).toHaveLength(2);

    await removePromptHistoryItem(items[0].id);

    const remaining = await getPromptHistory();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).not.toBe(items[0].content);
  });

  it('clears the entire history', async () => {
    await addPromptHistory('first', 'sent', '/app/abc');
    await addPromptHistory('second', 'edited', '/app/abc');

    await clearPromptHistory();

    const items = await getPromptHistory();
    expect(items).toHaveLength(0);
  });

  it('bounds the list to MAX_ITEMS', async () => {
    for (let i = 0; i < MAX_ITEMS + 50; i++) {
      await addPromptHistory(`prompt ${i}`, 'sent', '/app/abc');
    }

    const items = await getPromptHistory();
    expect(items).toHaveLength(MAX_ITEMS);
  });

  it('stores history under the PROMPT_HISTORY_ITEMS key', async () => {
    await addPromptHistory('stored', 'sent', '/app/abc');

    const raw = localStore[StorageKeys.PROMPT_HISTORY_ITEMS];
    expect(Array.isArray(raw)).toBe(true);
    expect(raw as unknown[]).toHaveLength(1);
  });
});
