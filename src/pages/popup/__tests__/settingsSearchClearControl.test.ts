import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TranslationKey } from '@/utils/translations';

import { PopupSearchBox } from '../components/PopupSearchBox';

const translate = (key: TranslationKey) => key;

function Harness() {
  const [query, setQuery] = useState('timeline');
  return React.createElement(PopupSearchBox, { query, onChange: setQuery, t: translate });
}

describe('settings search clear control', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(React.createElement(Harness)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('hides the native Chromium cancel button and provides one accessible clear action', async () => {
    const input = container.querySelector('input')!;
    const clear = container.querySelector('button')!;
    expect(input.type).toBe('search');
    expect(input.value).toBe('timeline');
    expect(input.getAttribute('aria-label')).toBe('popupSettingsSearchPlaceholder');
    expect(input.classList.contains('[&::-webkit-search-cancel-button]:hidden')).toBe(true);
    expect(clear.getAttribute('aria-label')).toBe('popupSettingsSearchClear');
    expect(clear.title).toBe('popupSettingsSearchClear');

    await act(async () => clear.click());
    expect(input.value).toBe('');
    expect(container.querySelector('button')).toBeNull();

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'folder',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('folder');
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'popupSettingsSearchClear',
    );
  });
});
