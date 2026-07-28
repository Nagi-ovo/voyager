import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { PromptImportExportService } from '../PromptImportExportService';

type MockedChrome = typeof chrome;

function createChromeMock(initialStore: Record<string, unknown>) {
  const store = { ...initialStore };
  const chromeMock = {
    runtime: {
      lastError: null,
    },
    storage: {
      local: {
        get: vi.fn((keys: string[], callback: (items: Record<string, unknown>) => void) => {
          callback(Object.fromEntries(keys.map((key) => [key, store[key]])));
        }),
        set: vi.fn((items: Record<string, unknown>, callback?: () => void) => {
          Object.assign(store, items);
          callback?.();
        }),
      },
    },
  } as unknown as MockedChrome;

  return { chromeMock, store };
}

describe('PromptImportExportService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('exports prompts from extension local storage', async () => {
    localStorage.setItem(
      StorageKeys.PROMPT_ITEMS,
      JSON.stringify([{ id: 'local', text: 'Legacy prompt', tags: [], createdAt: 1 }]),
    );
    const { chromeMock } = createChromeMock({
      [StorageKeys.PROMPT_ITEMS]: [
        { id: 'stored', text: 'Stored prompt', tags: ['tag'], createdAt: 2 },
      ],
    });
    (globalThis as { chrome: MockedChrome }).chrome = chromeMock;

    const result = await PromptImportExportService.exportToJSON();

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(JSON.parse(result.data)).toEqual(
      expect.objectContaining({
        format: 'gemini-voyager.prompts.v1',
        items: [{ id: 'stored', text: 'Stored prompt', tags: ['tag'], createdAt: 2 }],
      }),
    );
  });

  it('imports prompts by merging duplicate text into extension local storage', async () => {
    const { chromeMock, store } = createChromeMock({
      [StorageKeys.PROMPT_ITEMS]: [
        { id: 'existing', text: 'Same prompt', tags: ['local'], createdAt: 1 },
      ],
    });
    (globalThis as { chrome: MockedChrome }).chrome = chromeMock;
    const payload = PromptImportExportService.validatePayload({
      format: 'gemini-voyager.prompts.v1',
      items: [
        { text: 'Same prompt', tags: ['imported'], name: 'Imported title' },
        { text: 'New prompt', tags: ['new'] },
      ],
    });

    expect(payload.success).toBe(true);
    if (!payload.success) return;
    const result = await PromptImportExportService.importFromPayload(payload.data);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.nameConflicts).toBe(0);
    expect(store[StorageKeys.PROMPT_ITEMS]).toEqual([
      expect.objectContaining({ text: 'New prompt', tags: ['new'] }),
      expect.objectContaining({
        id: 'existing',
        text: 'Same prompt',
        tags: ['local', 'imported'],
        name: 'Imported title',
      }),
    ]);
  });

  it('preserves historical and newly imported duplicate-name prompts', async () => {
    const historicalItems = [
      { id: 'legacy-a', name: 'Translator', text: 'First body', tags: [], createdAt: 1 },
      { id: 'legacy-b', name: 'Ｔｒａｎｓｌａｔｏｒ', text: 'Second body', tags: [], createdAt: 2 },
      { id: 'legacy-c', name: 'translator', text: 'First body', tags: [], createdAt: 3 },
    ];
    const { chromeMock, store } = createChromeMock({
      [StorageKeys.PROMPT_ITEMS]: historicalItems,
    });
    (globalThis as { chrome: MockedChrome }).chrome = chromeMock;
    const payload = PromptImportExportService.validatePayload({
      format: 'gemini-voyager.prompts.v1',
      items: [
        { text: 'Conflicting body', tags: [], name: 'translator' },
        { text: 'Unique body', tags: [], name: 'Summarizer' },
        { text: 'Another conflict', tags: [], name: 'summarizer' },
      ],
    });

    expect(payload.success).toBe(true);
    if (!payload.success) return;
    const result = await PromptImportExportService.importFromPayload(payload.data);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ imported: 3, nameConflicts: 6, total: 6 });
    expect(store[StorageKeys.PROMPT_ITEMS]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'translator', text: 'Conflicting body' }),
        expect.objectContaining({ name: 'Summarizer', text: 'Unique body' }),
        expect.objectContaining({ name: 'summarizer', text: 'Another conflict' }),
        ...historicalItems,
      ]),
    );
  });

  it('merges duplicate text while preserving an incoming conflicting name', async () => {
    const { chromeMock, store } = createChromeMock({
      [StorageKeys.PROMPT_ITEMS]: [
        { id: 'named', name: 'Translator', text: 'Named body', tags: [], createdAt: 1 },
        { id: 'legacy', text: 'Legacy body', tags: ['local'], createdAt: 2 },
      ],
    });
    (globalThis as { chrome: MockedChrome }).chrome = chromeMock;
    const payload = PromptImportExportService.validatePayload({
      format: 'gemini-voyager.prompts.v1',
      items: [{ text: 'Legacy body', tags: ['imported'], name: 'translator' }],
    });

    expect(payload.success).toBe(true);
    if (!payload.success) return;
    const result = await PromptImportExportService.importFromPayload(payload.data);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ duplicates: 1, nameConflicts: 2 });
    expect(store[StorageKeys.PROMPT_ITEMS]).toEqual([
      expect.objectContaining({
        id: 'legacy',
        name: 'translator',
        tags: ['local', 'imported'],
      }),
      expect.objectContaining({ id: 'named', name: 'Translator' }),
    ]);
  });

  it('applies a newer same-ID body edit and its conflicting cloud rename', async () => {
    const { chromeMock, store } = createChromeMock({
      [StorageKeys.PROMPT_ITEMS]: [
        {
          id: 'editing',
          name: 'Translator',
          text: 'Old body',
          tags: ['local'],
          createdAt: 1,
          updatedAt: 1,
        },
        { id: 'other', name: 'Summarizer', text: 'Other body', tags: [], createdAt: 1 },
      ],
    });
    (globalThis as { chrome: MockedChrome }).chrome = chromeMock;
    const payload = PromptImportExportService.validatePayload({
      format: 'gemini-voyager.prompts.v1',
      items: [
        {
          id: 'editing',
          name: 'summarizer',
          text: 'New body',
          tags: ['cloud'],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });

    expect(payload.success).toBe(true);
    if (!payload.success) return;
    const result = await PromptImportExportService.importFromPayload(payload.data);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ duplicates: 1, nameConflicts: 2 });
    expect(store[StorageKeys.PROMPT_ITEMS]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'editing',
          name: 'summarizer',
          text: 'New body',
          tags: ['local', 'cloud'],
        }),
      ]),
    );
  });

  it('applies a newer legacy same-ID body while preserving the existing name', async () => {
    const { chromeMock, store } = createChromeMock({
      [StorageKeys.PROMPT_ITEMS]: [
        {
          id: 'editing',
          name: 'Translator',
          text: 'Old body',
          tags: ['local'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    (globalThis as { chrome: MockedChrome }).chrome = chromeMock;
    const payload = PromptImportExportService.validatePayload({
      format: 'gemini-voyager.prompts.v1',
      items: [
        {
          id: 'editing',
          text: 'New body',
          tags: ['cloud'],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });

    expect(payload.success).toBe(true);
    if (!payload.success) return;
    const result = await PromptImportExportService.importFromPayload(payload.data);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ duplicates: 1, nameConflicts: 0 });
    expect(store[StorageKeys.PROMPT_ITEMS]).toEqual([
      expect.objectContaining({
        id: 'editing',
        name: 'Translator',
        text: 'New body',
        tags: ['local', 'cloud'],
      }),
    ]);
  });
});
