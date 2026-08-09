import { afterEach, describe, expect, it } from 'vitest';

import { PluginScope } from '@/features/plugins/runtime/pluginScope';

import { getChatGptExportCopy } from './i18n';
import { showFormatDialog } from './ui';

function clickButton(label: string): void {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  button.click();
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('ChatGPT export plugin dialogs', () => {
  it('offers PDF controls without the removed PNG format', async () => {
    const copy = getChatGptExportCopy();
    const scope = new PluginScope();
    const result = showFormatDialog(scope, copy);
    const attribution = document.querySelector<HTMLAnchorElement>('.gv-chatgpt-export-attribution');
    expect(attribution?.textContent).toBe('Powered by ChatGPT Voyager');
    expect(attribution?.href).toBe('https://github.com/TanChuping/chatgpt-voyager');
    expect(attribution?.target).toBe('_blank');
    expect(attribution?.rel).toBe('noopener noreferrer');
    expect(attribution?.referrerPolicy).toBe('no-referrer');
    expect(document.querySelector('input[value="image"]')).toBeNull();
    const pdf = document.querySelector<HTMLInputElement>('input[value="pdf"]');
    expect(pdf).not.toBeNull();
    pdf!.click();
    const ranges = document.querySelectorAll<HTMLInputElement>('input[type="range"]');
    expect(ranges).toHaveLength(1);
    ranges[0].value = '14';

    clickButton(copy.export);

    await expect(result).resolves.toEqual({ format: 'pdf', fontSize: 14 });
    await scope.dispose();
  });

  it('resolves an open dialog as cancelled when the plugin scope is disposed', async () => {
    const scope = new PluginScope();
    const result = showFormatDialog(scope, getChatGptExportCopy());

    await scope.dispose();

    await expect(result).resolves.toBeNull();
    expect(document.querySelector('.gv-chatgpt-export-overlay')).toBeNull();
  });

  it('labels the modal, traps Tab focus, and restores the trigger focus after close', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open export';
    document.body.appendChild(trigger);
    trigger.focus();
    const scope = new PluginScope();
    const copy = getChatGptExportCopy();
    const result = showFormatDialog(scope, copy);
    const dialog = document.querySelector<HTMLElement>('.gv-chatgpt-export-dialog')!;
    const title = document.querySelector<HTMLElement>('.gv-chatgpt-export-dialog-title')!;
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), a[href]',
      ),
    ).filter((element) => !element.closest('[hidden]'));

    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(document.activeElement).toBe(focusables[0]);

    focusables.at(-1)!.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(focusables[0]);

    focusables[0].focus();
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(focusables.at(-1));

    clickButton(copy.cancel);
    await expect(result).resolves.toBeNull();
    await Promise.resolve();
    expect(document.activeElement).toBe(trigger);
    await scope.dispose();
  });
});
