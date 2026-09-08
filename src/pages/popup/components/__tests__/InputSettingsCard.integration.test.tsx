import React, { act, type ComponentProps, useEffect } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { TranslationKey } from '@/utils/translations';

import {
  INPUT_SETTINGS_STORAGE_DEFAULTS,
  useInputPopupSettings,
} from '../../hooks/useInputPopupSettings';
import { InputSettingsCard } from '../InputSettingsCard';

type CardContext = Omit<ComponentProps<typeof InputSettingsCard>, 'values' | 'onChange' | 't'>;
const translate = (key: TranslationKey): string => key;

describe('InputSettingsCard with popup settings', () => {
  let container: HTMLDivElement;
  let root: Root;
  let settings: ReturnType<typeof useInputPopupSettings>;
  let context: CardContext;
  const write = vi.fn(async (_payload: Record<string, unknown>) => {});

  function Harness(props: CardContext) {
    const current = useInputPopupSettings(write);
    useEffect(() => {
      settings = current;
    }, [current]);
    return <InputSettingsCard {...props} {...current} t={translate} />;
  }

  const render = (next: Partial<CardContext> = {}) => {
    context = { ...context, ...next };
    act(() => root.render(<Harness {...context} />));
  };
  const input = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    write.mockClear();
    context = {
      isAIStudio: false,
      isSafariBrowser: false,
      currentPlatformLabel: 'Gemini',
      isVisible: () => true,
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

  it('hides the collapse dependency without clearing its stored value', () => {
    act(() =>
      settings.hydrateFromStorage({
        ...INPUT_SETTINGS_STORAGE_DEFAULTS,
        gvInputCollapseWhenNotEmpty: true,
      }),
    );
    expect(input('input-collapse-enabled').checked).toBe(false);
    expect(input('input-collapse-when-not-empty')).toBeNull();

    act(() => input('input-collapse-enabled').click());
    expect(input('input-collapse-when-not-empty').checked).toBe(true);
    act(() => input('input-collapse-enabled').click());
    expect(input('input-collapse-when-not-empty')).toBeNull();
    expect(settings.values.inputCollapseWhenNotEmpty).toBe(true);
    expect(write.mock.calls.map(([payload]) => payload)).toEqual([
      { gvInputCollapseEnabled: true },
      { gvInputCollapseEnabled: false },
    ]);

    act(() => input('input-collapse-enabled').click());
    render({ isVisible: (id) => id !== 'allowCollapseWhenNotEmpty' });
    expect(input('input-collapse-when-not-empty')).toBeNull();
    expect(settings.values.inputCollapseWhenNotEmpty).toBe(true);
  });

  it('writes the active platform send key and preserves unrelated flags in a sparse false patch', () => {
    act(() =>
      settings.hydrateFromStorage({
        ...INPUT_SETTINGS_STORAGE_DEFAULTS,
        gvCtrlEnterSend: true,
        [StorageKeys.INPUT_VIM_MODE]: true,
      }),
    );
    expect(input('aistudio-enter-send')).toBeNull();
    act(() => input('ctrl-enter-send').click());
    expect(write).toHaveBeenLastCalledWith({ gvCtrlEnterSend: false });
    expect(settings.values.inputVimModeEnabled).toBe(true);
    expect(input('input-vim-mode').checked).toBe(true);

    render({ isAIStudio: true, currentPlatformLabel: 'AI Studio' });
    expect(input('ctrl-enter-send')).toBeNull();
    expect(container.textContent).toContain('AI Studio');
    act(() => input('aistudio-enter-send').click());
    expect(write).toHaveBeenLastCalledWith({ [StorageKeys.AISTUDIO_ENTER_SEND]: true });
    act(() => input('aistudio-enter-send').click());
    expect(write).toHaveBeenLastCalledWith({ [StorageKeys.AISTUDIO_ENTER_SEND]: false });
    expect(settings.values.ctrlEnterSendEnabled).toBe(false);
    expect(settings.values.inputVimModeEnabled).toBe(true);
  });

  it('shows the Safari fix only on Safari and when the setting is visible', () => {
    expect(input('safari-enter-fix')).toBeNull();
    render({ isSafariBrowser: true });
    act(() => input('safari-enter-fix').click());
    expect(settings.values.safariEnterFixEnabled).toBe(true);
    expect(write).toHaveBeenCalledWith({ [StorageKeys.SAFARI_ENTER_FIX]: true });
    render({ isVisible: (id) => id !== 'safariEnterFix' });
    expect(input('safari-enter-fix')).toBeNull();
    expect(settings.values.safariEnterFixEnabled).toBe(true);
    expect(input('draft-auto-save')).not.toBeNull();
  });
});
