import React, { act, useEffect } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { type EchartsPopupSettings, useEchartsPopupSettings } from '../useEchartsPopupSettings';

function Harness({
  capture,
  writeSyncStorage,
}: {
  capture: (settings: EchartsPopupSettings) => void;
  writeSyncStorage: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const settings = useEchartsPopupSettings(writeSyncStorage);

  useEffect(() => {
    capture(settings);
  }, [capture, settings]);

  return null;
}

describe('useEchartsPopupSettings', () => {
  let container: HTMLDivElement;
  let root: Root;
  let settings: EchartsPopupSettings;
  const writeSyncStorage = vi.fn(async (_payload: Record<string, unknown>) => {});

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    writeSyncStorage.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <Harness
          capture={(nextSettings) => (settings = nextSettings)}
          writeSyncStorage={writeSyncStorage}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('hydrates the toggle as false and persists the switched value under the typed key', () => {
    act(() => settings.hydrateFromStorage(false));
    expect(settings.enabled).toBe(false);

    act(() => settings.setEnabledFromUser(true));

    expect(settings.enabled).toBe(true);
    expect(writeSyncStorage).toHaveBeenCalledWith({
      [StorageKeys.ECHARTS_ENABLED]: true,
    });
  });

  it('does not overwrite a user change with a late storage snapshot', () => {
    act(() => settings.setEnabledFromUser(false));
    act(() => settings.hydrateFromStorage(true));

    expect(settings.enabled).toBe(false);
  });
});
