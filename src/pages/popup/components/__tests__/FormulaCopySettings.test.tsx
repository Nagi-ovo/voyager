import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranslationKey } from '@/utils/translations';

import { FormulaCopySettings } from '../FormulaCopySettings';

const translate = (key: TranslationKey): string => key;

describe('FormulaCopySettings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('toggles immediately without changing the selected format', () => {
    const onEnabledChange = vi.fn();
    const onFormatChange = vi.fn();
    const render = (enabled: boolean) => {
      act(() => {
        root.render(
          <FormulaCopySettings
            enabled={enabled}
            format="notion"
            onEnabledChange={onEnabledChange}
            onFormatChange={onFormatChange}
            t={translate}
          />,
        );
      });
    };

    render(true);
    const switchInput = container.querySelector<HTMLInputElement>('#formula-copy-enabled')!;
    expect(switchInput.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[value="notion"]')?.checked).toBe(true);

    act(() => switchInput.click());
    expect(onEnabledChange).toHaveBeenCalledWith(false);

    render(false);
    expect(container.querySelector<HTMLInputElement>('#formula-copy-enabled')?.checked).toBe(false);
    expect(container.querySelector<HTMLInputElement>('input[value="notion"]')?.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[value="notion"]')?.disabled).toBe(true);
    expect(onFormatChange).not.toHaveBeenCalled();

    act(() => container.querySelector<HTMLInputElement>('#formula-copy-enabled')!.click());
    expect(onEnabledChange).toHaveBeenLastCalledWith(true);
  });

  it('changes format without changing the master switch', () => {
    const onEnabledChange = vi.fn();
    const onFormatChange = vi.fn();
    act(() => {
      root.render(
        <FormulaCopySettings
          enabled={true}
          format="latex"
          onEnabledChange={onEnabledChange}
          onFormatChange={onFormatChange}
          t={translate}
        />,
      );
    });

    act(() => container.querySelector<HTMLInputElement>('input[value="unicodemath"]')!.click());

    expect(onFormatChange).toHaveBeenCalledWith('unicodemath');
    expect(onEnabledChange).not.toHaveBeenCalled();
  });

  it('does not disable plugin-site formats when the native switch is hidden', () => {
    act(() => {
      root.render(
        <FormulaCopySettings
          enabled={false}
          format="latex"
          onEnabledChange={vi.fn()}
          onFormatChange={vi.fn()}
          showEnabled={false}
          t={translate}
        />,
      );
    });

    expect(container.querySelector<HTMLInputElement>('input[value="latex"]')?.disabled).toBe(false);
  });
});
