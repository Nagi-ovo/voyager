import React, { act, useEffect } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { TranslationKey } from '@/utils/translations';

import { VisualEffectPicker } from '../../components/VisualEffectPicker';
import { WatermarkSettingsCard } from '../../components/WatermarkSettingsCard';
import { useVisualEffectPopupSettings } from '../useVisualEffectPopupSettings';
import { useWatermarkPopupSettings } from '../useWatermarkPopupSettings';

const translate = (key: TranslationKey): string => key;

describe('media popup settings with their controls', () => {
  let root: Root;
  let container: HTMLDivElement;
  let watermark: ReturnType<typeof useWatermarkPopupSettings>;
  let visual: ReturnType<typeof useVisualEffectPopupSettings>;
  const write = vi.fn(async (_payload: Record<string, unknown>) => {});

  function Harness() {
    const currentWatermark = useWatermarkPopupSettings(write);
    const currentVisual = useVisualEffectPopupSettings(write);
    useEffect(() => {
      watermark = currentWatermark;
      visual = currentVisual;
    }, [currentWatermark, currentVisual]);
    return (
      <>
        <WatermarkSettingsCard {...currentWatermark} isVisible={() => true} t={translate} />
        <VisualEffectPicker {...currentVisual} t={translate} />
      </>
    );
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    write.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const input = (kind: string) => container.querySelector<HTMLInputElement>(`#watermark-${kind}`)!;

  it('hydrates legacy watermark preferences and gives either split key precedence', () => {
    act(() => watermark.hydrateFromStorage({ [StorageKeys.WATERMARK_REMOVER_ENABLED]: false }));
    expect(input('download').checked).toBe(false);
    expect(input('preview').checked).toBe(false);

    act(() =>
      watermark.hydrateFromStorage({
        [StorageKeys.WATERMARK_REMOVER_ENABLED]: false,
        [StorageKeys.WATERMARK_PREVIEW_ENABLED]: false,
      }),
    );
    expect(input('download').checked).toBe(true);
    expect(input('preview').checked).toBe(false);

    act(() =>
      watermark.hydrateFromStorage({
        [StorageKeys.WATERMARK_REMOVER_ENABLED]: true,
        [StorageKeys.WATERMARK_DOWNLOAD_ENABLED]: false,
      }),
    );
    expect(input('download').checked).toBe(false);
    expect(input('preview').checked).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes only the changed watermark flag and clears the legacy key for each toggle', () => {
    act(() => input('download').click());
    expect(watermark.values).toEqual({ download: false, preview: true });
    expect(write).toHaveBeenLastCalledWith({
      [StorageKeys.WATERMARK_DOWNLOAD_ENABLED]: false,
      [StorageKeys.WATERMARK_REMOVER_ENABLED]: null,
    });

    act(() => input('preview').click());
    expect(watermark.values).toEqual({ download: false, preview: false });
    expect(write).toHaveBeenLastCalledWith({
      [StorageKeys.WATERMARK_PREVIEW_ENABLED]: false,
      [StorageKeys.WATERMARK_REMOVER_ENABLED]: null,
    });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('falls back to legacy snow, prefers a named effect, and clears legacy snow when choosing off', () => {
    const activeLabel = () => container.querySelector('button.shadow-md')?.textContent;
    act(() => visual.hydrateFromStorage({ gvVisualEffect: 'off', gvSnowEffect: true }));
    expect(visual.value).toBe('snow');
    expect(activeLabel()).toBe('visualEffectSnow');

    act(() => visual.hydrateFromStorage({ gvVisualEffect: 'rain', gvSnowEffect: true }));
    expect(visual.value).toBe('rain');
    expect(activeLabel()).toBe('visualEffectRain');
    const off = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'visualEffectOff',
    )!;
    act(() => off.click());
    expect(visual.value).toBe('off');
    expect(activeLabel()).toBe('visualEffectOff');
    expect(write).toHaveBeenCalledWith({ gvVisualEffect: 'off', gvSnowEffect: false });
    act(() => visual.hydrateFromStorage(write.mock.calls[0][0]));
    expect(visual.value).toBe('off');
  });
});
