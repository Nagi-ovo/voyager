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
    expect(switchInput.getAttribute('aria-describedby')).toBe('formula-copy-enabled-hint');
    expect(container.querySelector('#formula-copy-enabled-hint')?.textContent).toBe(
      'enableFormulaCopyHint',
    );
    expect(container.querySelector<HTMLInputElement>('input[value="notion"]')?.checked).toBe(true);
    expect(
      container
        .querySelector<HTMLInputElement>('input[value="notion"]')
        ?.closest('label')
        ?.classList.contains('cursor-pointer'),
    ).toBe(true);

    act(() => switchInput.click());
    expect(onEnabledChange).toHaveBeenCalledWith(false);

    render(false);
    expect(container.querySelector<HTMLInputElement>('#formula-copy-enabled')?.checked).toBe(false);
    expect(container.querySelector<HTMLInputElement>('input[value="notion"]')?.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[value="notion"]')?.disabled).toBe(true);
    const disabledFormatLabel = container
      .querySelector<HTMLInputElement>('input[value="notion"]')
      ?.closest('label');
    expect(disabledFormatLabel?.classList.contains('cursor-not-allowed')).toBe(true);
    expect(disabledFormatLabel?.classList.contains('opacity-60')).toBe(true);
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

  it('keeps formats enabled when search hides an enabled native switch', () => {
    const onFormatChange = vi.fn();
    act(() => {
      root.render(
        <FormulaCopySettings
          enabled={true}
          format="latex"
          onEnabledChange={vi.fn()}
          onFormatChange={onFormatChange}
          showEnabled={false}
          t={translate}
        />,
      );
    });

    const notionInput = container.querySelector<HTMLInputElement>('input[value="notion"]')!;
    expect(notionInput.disabled).toBe(false);
    act(() => notionInput.click());
    expect(onFormatChange).toHaveBeenCalledWith('notion');
  });

  it('keeps formats disabled when search hides an off native switch', () => {
    const onFormatChange = vi.fn();
    act(() => {
      root.render(
        <FormulaCopySettings
          enabled={false}
          format="latex"
          onEnabledChange={vi.fn()}
          onFormatChange={onFormatChange}
          showEnabled={false}
          t={translate}
        />,
      );
    });

    const latexInput = container.querySelector<HTMLInputElement>('input[value="latex"]')!;
    expect(latexInput.disabled).toBe(true);
    act(() => latexInput.click());
    expect(onFormatChange).not.toHaveBeenCalled();
  });
});
