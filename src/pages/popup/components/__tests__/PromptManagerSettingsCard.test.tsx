import React, { act, createRef } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranslationKey } from '@/utils/translations';

import {
  PromptManagerSettingsCard,
  type PromptManagerSettingsCardProps,
} from '../PromptManagerSettingsCard';

const translate = (key: TranslationKey): string => key;

describe('PromptManagerSettingsCard', () => {
  let root: Root;
  let container: HTMLDivElement;
  let props: PromptManagerSettingsCardProps;
  const render = (overrides: Partial<PromptManagerSettingsCardProps> = {}) => {
    props = { ...props, ...overrides };
    act(() => root.render(<PromptManagerSettingsCard {...props} />));
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    props = {
      settings: {
        values: {
          hidePromptManager: false,
          promptHistoryEnabled: true,
          slashPromptEnabled: true,
          promptInsertOnClickEnabled: false,
        },
        onChange: vi.fn(),
        hydrateFromStorage: vi.fn(),
        customWebsites: ['claude.ai'],
        newWebsiteInput: 'example.com',
        websiteError: 'permissionDenied',
        onWebsiteInputChange: vi.fn(),
        handleAddWebsite: vi.fn(async () => {}),
        handleRemoveWebsite: vi.fn(async () => {}),
        toggleQuickWebsite: vi.fn(async () => {}),
      },
      transfer: {
        busy: false,
        status: null,
        inputRef: createRef<HTMLInputElement>(),
        onExport: vi.fn(async () => {}),
        onImport: vi.fn(async () => {}),
        onCloudPull: vi.fn(async () => {}),
        onCloudPush: vi.fn(async () => {}),
      },
      t: translate,
      isVisible: () => true,
      isPluginSite: false,
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    render();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders all flag values and reports just the toggled setting', () => {
    const input = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!;
    expect(input('hide-prompt-manager').checked).toBe(false);
    expect(input('prompt-history-enabled').checked).toBe(true);
    expect(input('slash-prompt-enabled').checked).toBe(true);
    expect(input('prompt-insert-on-click').checked).toBe(false);
    act(() => input('prompt-insert-on-click').click());
    expect(props.settings.onChange).toHaveBeenCalledWith({ promptInsertOnClickEnabled: true });
  });

  it('keeps quick choices, removal, input editing and Enter on the website controller', () => {
    const quick = Array.from(container.querySelectorAll<HTMLButtonElement>('button[title]'));
    expect(quick.map((item) => item.title)).toEqual([
      'ChatGPT',
      'Claude',
      'DeepSeek',
      'Qwen',
      'Kimi',
      'NotebookLM',
      'Midjourney',
    ]);
    act(() => quick.find((item) => item.title === 'Claude')!.click());
    expect(props.settings.toggleQuickWebsite).toHaveBeenCalledWith('claude.ai', true);
    const remove = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'removeWebsite',
    )!;
    act(() => remove.click());
    expect(props.settings.handleRemoveWebsite).toHaveBeenCalledWith('claude.ai');
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(input.value).toBe('example.com');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'next.example',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(props.settings.onWebsiteInputChange).toHaveBeenCalledWith('next.example');
    expect(props.settings.handleAddWebsite).toHaveBeenCalledOnce();
    expect(container.querySelector('p.text-destructive')?.textContent).toBe('permissionDenied');
  });

  it('retains the shared transfer panel and site-specific notice while applying search visibility', () => {
    expect(container.textContent).toContain('geminiOnlyNotice');
    const exportButton = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'pm_export',
    )!;
    act(() => exportButton.click());
    expect(props.transfer.onExport).toHaveBeenCalledOnce();
    render({
      isPluginSite: true,
      isVisible: (id) => !['promptHistoryEnabled', 'promptDataMigration'].includes(id),
    });
    expect(container.textContent).not.toContain('geminiOnlyNotice');
    expect(container.querySelector('#prompt-history-enabled')).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(container.querySelector('#slash-prompt-enabled')).not.toBeNull();
    render({ isVisible: (id) => id !== 'customWebsites' });
    expect(container.querySelector('input[type="text"]')).toBeNull();
  });
});
