import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import {
  MAX_ITEMS,
  MAX_TOTAL_BYTES,
  addPromptHistory,
  clearPromptHistory,
  getPromptHistory,
  getPromptHistoryAccountScope,
  getPromptHistoryStoragePrefix,
  removePromptHistoryItem,
} from '../storage';

let localStore: Record<string, unknown> = {};

function setRuntimeError(message: string | null): void {
  (chrome.runtime as unknown as { lastError: { message: string } | null }).lastError = message
    ? { message }
    : null;
}

function setupMocks(): void {
  localStore = {};
  setRuntimeError(null);
  (chrome.storage as unknown as Record<string, unknown>).local = {
    get: vi.fn((key: unknown, callback: (result: Record<string, unknown>) => void) => {
      if (key === null) callback({ ...localStore });
      else if (typeof key === 'string') callback({ [key]: localStore[key] });
      else callback({ ...localStore });
    }),
    set: vi.fn((items: Record<string, unknown>, callback?: () => void) => {
      Object.assign(localStore, items);
      callback?.();
    }),
    remove: vi.fn((keys: string | string[], callback?: () => void) => {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((key) => delete localStore[key]);
      callback?.();
    }),
  };
}

describe('promptHistory storage', () => {
  beforeEach(setupMocks);

  afterEach(() => {
    setRuntimeError(null);
    vi.restoreAllMocks();
  });

  it('maps the implicit Gemini route to u:0 and isolates explicit account indexes', () => {
    expect(getPromptHistoryAccountScope('/app/abc')).toBe('u:0');
    expect(getPromptHistoryAccountScope('/u/0/app/abc')).toBe('u:0');
    expect(getPromptHistoryAccountScope('/u/12/app/abc')).toBe('u:12');
  });

  it('stores and reads newest-first under independent account-scoped item keys', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200);
    await addPromptHistory('first', 'sent', '/u/1/app/abc');
    await addPromptHistory('second', 'edited', '/u/1/app/abc');

    const items = await getPromptHistory('u:1');
    expect(items.map((item) => item.content)).toEqual(['second', 'first']);
    expect(Object.keys(localStore)).toHaveLength(2);
    expect(
      Object.keys(localStore).every((key) => key.startsWith('gvPromptHistoryItems:u:1:')),
    ).toBe(true);
  });

  it('keeps reads, removal, and clear isolated to the active Gemini account', async () => {
    await addPromptHistory('account zero', 'sent', '/u/0/app/abc');
    await addPromptHistory('account one', 'sent', '/u/1/app/abc');

    const zero = await getPromptHistory('u:0');
    const one = await getPromptHistory('u:1');
    expect(zero.map((item) => item.content)).toEqual(['account zero']);
    expect(one.map((item) => item.content)).toEqual(['account one']);

    await removePromptHistoryItem(zero[0].id, zero[0].accountScope);
    expect(await getPromptHistory('u:0')).toEqual([]);
    expect(await getPromptHistory('u:1')).toHaveLength(1);

    await clearPromptHistory('u:1');
    expect(await getPromptHistory('u:1')).toEqual([]);
  });

  it('deduplicates identical occurrences but keeps sent and edited types distinct', async () => {
    await addPromptHistory('same', 'sent', '/u/0/app/abc');
    await addPromptHistory('same', 'sent', '/u/0/app/abc');
    await addPromptHistory('same', 'edited', '/u/0/app/abc');

    const items = await getPromptHistory('u:0');
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.type))).toEqual(new Set(['sent', 'edited']));
  });

  it('does not lose overlapping writes when storage callbacks are delayed', async () => {
    const pendingSets: Array<() => void> = [];
    vi.mocked(chrome.storage.local.set).mockImplementation(
      (items: Record<string, unknown>, callback?: () => void) => {
        pendingSets.push(() => {
          Object.assign(localStore, items);
          callback?.();
        });
      },
    );

    const first = addPromptHistory('from tab one', 'sent', '/u/0/app/one');
    const second = addPromptHistory('from tab two', 'sent', '/u/0/app/two');
    await vi.waitFor(() => expect(pendingSets).toHaveLength(2));

    pendingSets.splice(0).forEach((complete) => complete());
    await Promise.all([first, second]);

    expect((await getPromptHistory('u:0')).map((item) => item.content).sort()).toEqual([
      'from tab one',
      'from tab two',
    ]);
  });

  it('does not resolve a save before its storage callback completes', async () => {
    const pendingSet: { complete?: () => void } = {};
    vi.mocked(chrome.storage.local.set).mockImplementation(
      (items: Record<string, unknown>, callback?: () => void) => {
        pendingSet.complete = () => {
          Object.assign(localStore, items);
          callback?.();
        };
      },
    );
    const settled = vi.fn();
    const save = addPromptHistory('wait for storage', 'sent', '/u/0/app/abc').then(settled);
    await vi.waitFor(() => expect(pendingSet.complete).toBeTypeOf('function'));
    expect(settled).not.toHaveBeenCalled();

    pendingSet.complete?.();
    await save;
    expect(settled).toHaveBeenCalledOnce();
  });

  it('rejects reads and writes when chrome.runtime.lastError is set', async () => {
    (
      chrome.storage.local.get as unknown as {
        mockImplementation: (implementation: (...args: unknown[]) => void) => void;
      }
    ).mockImplementation((...args: unknown[]) => {
      const callback = args[1] as (result: Record<string, unknown>) => void;
      setRuntimeError('read failed');
      callback({});
      setRuntimeError(null);
    });
    await expect(getPromptHistory('u:0')).rejects.toThrow('read failed');

    setupMocks();
    vi.mocked(chrome.storage.local.set).mockImplementation((_items, callback) => {
      setRuntimeError('quota exceeded');
      callback?.();
      setRuntimeError(null);
    });
    await expect(addPromptHistory('cannot save', 'sent', '/u/0/app/abc')).rejects.toThrow(
      'quota exceeded',
    );
  });

  it('bounds history by item count', async () => {
    for (let index = 0; index < MAX_ITEMS + 5; index++) {
      await addPromptHistory(`prompt ${index}`, 'sent', `/u/0/app/${index}`);
    }
    expect(await getPromptHistory('u:0')).toHaveLength(MAX_ITEMS);
  });

  it('bounds total encoded prompt-history bytes', async () => {
    const chunk = 'x'.repeat(50_000);
    for (let index = 0; index < 60; index++) {
      await addPromptHistory(`${index}${chunk}`, 'sent', `/u/0/app/${index}`);
    }
    const historyEntries = Object.entries(localStore).filter(([key]) =>
      key.startsWith(`${StorageKeys.PROMPT_HISTORY_ITEMS}:`),
    );
    const encodedBytes = new TextEncoder().encode(
      JSON.stringify(Object.fromEntries(historyEntries)),
    ).byteLength;
    expect(encodedBytes).toBeLessThanOrEqual(MAX_TOTAL_BYTES + historyEntries.length * 2);
  });

  it('ignores the unshipped legacy global array instead of migrating it', async () => {
    localStore[StorageKeys.PROMPT_HISTORY_ITEMS] = [{ content: 'legacy global prompt' }];
    await addPromptHistory('scoped', 'sent', '/u/2/app/abc');

    expect((await getPromptHistory('u:2')).map((item) => item.content)).toEqual(['scoped']);
    expect(
      Object.keys(localStore).some((key) => key.startsWith(getPromptHistoryStoragePrefix('u:2'))),
    ).toBe(true);
  });
});
