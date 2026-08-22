import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { buildInstructionBlock } from '../../folderProject/instructionBlock';
import { addPromptHistory, getPromptHistory } from '../storage';

type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

let localStore: Record<string, unknown> = {};
let syncStore: Record<string, unknown> = {};
let storageListeners: StorageListener[] = [];
let cleanup: (() => void) | null = null;
let uuidCounter = 0;

function storageResult(keys: unknown, source: Record<string, unknown>): Record<string, unknown> {
  if (keys === null) return { ...source };
  if (typeof keys === 'string') return { [keys]: source[keys] };
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.map((key) => [String(key), source[String(key)]]));
  }
  if (keys && typeof keys === 'object') {
    return Object.fromEntries(
      Object.entries(keys as Record<string, unknown>).map(([key, fallback]) => [
        key,
        key in source ? source[key] : fallback,
      ]),
    );
  }
  return {};
}

function setupStorage(enabled: boolean, ctrlEnter = false): void {
  localStore = {};
  syncStore = {
    [StorageKeys.PROMPT_HISTORY_ENABLED]: enabled,
    [StorageKeys.CTRL_ENTER_SEND]: ctrlEnter,
  };
  storageListeners = [];
  (chrome.runtime as unknown as { lastError: null }).lastError = null;
  (chrome.storage as unknown as Record<string, unknown>).local = {
    get: vi.fn((keys: unknown, callback: (result: Record<string, unknown>) => void) => {
      callback(storageResult(keys, localStore));
    }),
    set: vi.fn((items: Record<string, unknown>, callback?: () => void) => {
      Object.assign(localStore, items);
      callback?.();
    }),
    remove: vi.fn((keys: string | string[], callback?: () => void) => {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete localStore[key]);
      callback?.();
    }),
  };
  (chrome.storage as unknown as Record<string, unknown>).sync = {
    get: vi.fn((keys: unknown, callback: (result: Record<string, unknown>) => void) => {
      callback(storageResult(keys, syncStore));
    }),
    set: vi.fn((items: Record<string, unknown>, callback?: () => void) => {
      Object.assign(syncStore, items);
      callback?.();
    }),
  };
  (chrome.storage as unknown as { onChanged: unknown }).onChanged = {
    addListener: vi.fn((listener: StorageListener) => storageListeners.push(listener)),
    removeListener: vi.fn((listener: StorageListener) => {
      storageListeners = storageListeners.filter((candidate) => candidate !== listener);
    }),
  };
}

function emitStorageChange(
  areaName: 'local' | 'sync',
  changes: Record<string, chrome.storage.StorageChange>,
): void {
  storageListeners.slice().forEach((listener) => listener(changes, areaName));
}

function createMainComposer(label = '发送消息'): {
  container: HTMLDivElement;
  input: HTMLDivElement;
  button: HTMLButtonElement;
} {
  const container = document.createElement('div');
  container.className = 'text-input-field';
  const input = document.createElement('div');
  input.setAttribute('contenteditable', 'true');
  input.setAttribute('role', 'textbox');
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  container.append(input, button);
  document.body.appendChild(container);
  return { container, input, button };
}

async function start(enabled = true, ctrlEnter = false): Promise<void> {
  setupStorage(enabled, ctrlEnter);
  const module = await import('../index');
  cleanup = await module.startPromptHistory();
}

describe('Prompt History capture and lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.replaceChildren();
    window.history.replaceState({}, '', '/u/0/app/test');
    uuidCounter = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
      () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    vi.restoreAllMocks();
  });

  it('captures localized and icon-only send buttons before Gemini clears the composer', async () => {
    await start();
    const localized = createMainComposer('发送消息');
    localized.input.textContent = 'localized send';
    localized.button.click();
    localized.input.textContent = '';

    const iconComposer = createMainComposer('');
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.textContent = 'send';
    iconComposer.button.appendChild(icon);
    iconComposer.input.textContent = 'icon send';
    icon.click();

    await vi.waitFor(async () => {
      expect((await getPromptHistory('u:0')).map((item) => item.content).sort()).toEqual([
        'icon send',
        'localized send',
      ]);
    });
  });

  it('captures Enter and Ctrl+Enter send intent without treating manual clearing as a send', async () => {
    await start();
    const { input } = createMainComposer('Send message');

    input.textContent = 'plain enter';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.textContent = 'ctrl enter';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    );
    input.textContent = 'abandoned draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.textContent = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.waitFor(async () => {
      expect((await getPromptHistory('u:0')).map((item) => item.content).sort()).toEqual([
        'ctrl enter',
        'plain enter',
      ]);
    });
  });

  it('preserves user blank paragraphs with and without an injected instruction block', async () => {
    await start();
    const plain = createMainComposer('Send message');
    plain.input.textContent = 'Plain first\n\nPlain second';
    plain.button.click();

    const injected = createMainComposer('Send message');
    injected.input.textContent = `${buildInstructionBlock(
      'Research',
      'Always cite sources.',
    )}Injected first\n\nInjected second`;
    injected.button.click();

    await vi.waitFor(async () => {
      expect((await getPromptHistory('u:0')).map((item) => item.content).sort()).toEqual([
        'Injected first\n\nInjected second',
        'Plain first\n\nPlain second',
      ]);
    });
  });

  it('deduplicates the keydown and generated button click for one send action', async () => {
    await start();
    const { input, button } = createMainComposer('Send message');
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') button.click();
    });
    input.textContent = 'one physical send';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(async () => {
      const items = await getPromptHistory('u:0');
      expect(items.map((item) => item.content)).toEqual(['one physical send']);
    });
  });

  it('respects Ctrl+Enter mode and ignores plain Enter in that mode', async () => {
    await start(true, true);
    const { input } = createMainComposer('Send message');
    input.textContent = 'newline only';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.textContent = 'send with ctrl';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    );

    await vi.waitFor(async () => {
      expect((await getPromptHistory('u:0')).map((item) => item.content)).toEqual([
        'send with ctrl',
      ]);
    });
  });

  it('records only the current edit input when Update is submitted', async () => {
    await start();
    const message = document.createElement('chat-message');
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.setAttribute('aria-label', 'Edit prompt');
    message.appendChild(editButton);
    document.body.appendChild(message);
    editButton.click();

    const input = document.createElement('textarea');
    input.value = 'updated prompt text';
    const updateButton = document.createElement('button');
    updateButton.type = 'button';
    updateButton.className = 'update-button';
    message.append(input, updateButton);
    input.focus();
    updateButton.click();

    await vi.waitFor(async () => {
      const items = await getPromptHistory('u:0');
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ content: 'updated prompt text', type: 'edited' });
    });
  });

  it('can be disabled and re-enabled in the same tab', async () => {
    await start(false);
    expect(document.querySelector('.gv-ph-trigger')).toBeNull();

    emitStorageChange('sync', {
      [StorageKeys.PROMPT_HISTORY_ENABLED]: { oldValue: false, newValue: true },
    });
    expect(document.querySelector('.gv-ph-trigger')).not.toBeNull();

    emitStorageChange('sync', {
      [StorageKeys.PROMPT_HISTORY_ENABLED]: { oldValue: true, newValue: false },
    });
    expect(document.querySelector('.gv-ph-trigger')).toBeNull();

    emitStorageChange('sync', {
      [StorageKeys.PROMPT_HISTORY_ENABLED]: { oldValue: false, newValue: true },
    });
    expect(document.querySelector('.gv-ph-trigger')).not.toBeNull();
  });

  it('shows a visible alert when extension storage rejects a capture', async () => {
    await start();
    vi.mocked(chrome.storage.local.set).mockImplementation((_items, callback) => {
      (chrome.runtime as unknown as { lastError: { message: string } | null }).lastError = {
        message: 'quota exceeded',
      };
      callback?.();
      (chrome.runtime as unknown as { lastError: { message: string } | null }).lastError = null;
    });
    const { input, button } = createMainComposer('Send message');
    input.textContent = 'cannot persist';
    button.click();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-ph-global-notice')?.getAttribute('role')).toBe('alert');
    });
  });

  it('updates reused notice accessibility semantics from success to error', async () => {
    await start();
    await addPromptHistory('copy me', 'sent', '/u/0/app/test');
    document.querySelector<HTMLButtonElement>('.gv-ph-trigger')?.click();
    await vi.waitFor(() => expect(document.querySelectorAll('.gv-ph-item')).toHaveLength(1));

    const copyButton = document.querySelector<HTMLButtonElement>('.gv-ph-item-actions button');
    copyButton?.click();
    await vi.waitFor(() => {
      const notice = document.querySelector('.gv-ph-notice');
      expect(notice?.getAttribute('role')).toBe('status');
      expect(notice?.getAttribute('aria-live')).toBe('polite');
    });

    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'));
    copyButton?.click();
    await vi.waitFor(() => {
      const notice = document.querySelector('.gv-ph-notice');
      expect(notice?.getAttribute('role')).toBe('alert');
      expect(notice?.getAttribute('aria-live')).toBe('assertive');
    });
  });

  it('requires confirmation and clears only the current account', async () => {
    await start();
    await addPromptHistory('account zero', 'sent', '/u/0/app/test');
    await addPromptHistory('account one', 'sent', '/u/1/app/test');

    const trigger = document.querySelector<HTMLButtonElement>('.gv-ph-trigger');
    trigger?.click();
    await vi.waitFor(() => expect(document.querySelectorAll('.gv-ph-item')).toHaveLength(1));
    const clearButton = document.querySelector<HTMLButtonElement>('.gv-ph-header .gv-ph-action');
    clearButton?.click();

    expect(document.querySelector('.gv-ph-confirm')).not.toBeNull();
    expect(await getPromptHistory('u:0')).toHaveLength(1);
    const cancel = document.querySelector<HTMLButtonElement>('.gv-ph-confirm button:last-child');
    expect(document.activeElement).toBe(cancel);
    cancel?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    const confirm = document.querySelector<HTMLButtonElement>('.gv-pm-confirm-yes');
    expect(document.activeElement).toBe(confirm);
    confirm?.click();

    await vi.waitFor(async () => expect(await getPromptHistory('u:0')).toHaveLength(0));
    expect(await getPromptHistory('u:1')).toHaveLength(1);
  });

  it('exposes localized dialog relationships and moves focus into the panel', async () => {
    await start();
    const trigger = document.querySelector<HTMLButtonElement>('.gv-ph-trigger');
    const panel = document.querySelector<HTMLDivElement>('.gv-ph-panel');
    trigger?.click();

    expect(trigger?.getAttribute('aria-controls')).toBe(panel?.id);
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(panel?.getAttribute('aria-labelledby')).toBe('gv-ph-title');
    expect(document.activeElement).toBe(panel);
  });

  it('places the global error notice below the trigger on short viewports', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');

    expect(css).toMatch(
      /@media \(max-height: 440px\)[\s\S]*?\.gv-ph-trigger\s*\{\s*top: 12px;\s*\}[\s\S]*?\.gv-ph-global-notice\s*\{\s*top: 66px;\s*\}/,
    );
  });
});
