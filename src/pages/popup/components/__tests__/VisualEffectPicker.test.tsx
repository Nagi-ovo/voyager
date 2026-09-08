import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranslationKey } from '@/utils/translations';

import { VisualEffectPicker } from '../VisualEffectPicker';

const translate = (key: TranslationKey): string => key;

describe('VisualEffectPicker', () => {
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

  it('offers the four effects, marks the active one and reports a pick', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(<VisualEffectPicker value="sakura" onChange={onChange} t={translate} />);
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent)).toEqual([
      'visualEffectOff',
      'visualEffectSnow',
      'visualEffectSakura',
      'visualEffectRain',
    ]);
    expect(
      buttons.filter((b) => b.classList.contains('shadow-md')).map((b) => b.textContent),
    ).toEqual(['visualEffectSakura']);
    expect(buttons.every((b) => b.querySelector('svg'))).toBe(true);

    act(() => buttons[3].click());
    expect(onChange).toHaveBeenCalledWith('rain');
  });
});
