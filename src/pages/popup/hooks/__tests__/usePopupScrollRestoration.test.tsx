import React, { act, useLayoutEffect } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import {
  type PopupScrollViewState,
  clampPopupScrollTop,
  shouldTrackPopupSettingsScroll,
  usePopupScrollRestoration,
} from '../usePopupScrollRestoration';

const { storageGet, storageSet } = vi.hoisted(() => ({
  storageGet: vi.fn(),
  storageSet: vi.fn(),
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      local: { get: storageGet, set: storageSet },
    },
  },
}));

const MAIN_VIEW: PopupScrollViewState = {
  activeTabContextLoaded: true,
  hasSettingsSearch: false,
  isPluginSite: false,
  showStarredHistory: false,
  showStorageManager: false,
};

function Harness({
  state,
  onLayoutCommit,
}: {
  state: PopupScrollViewState;
  onLayoutCommit?: () => void;
}) {
  usePopupScrollRestoration(state);
  useLayoutEffect(() => onLayoutCommit?.(), [onLayoutCommit]);
  return <div data-popup-content />;
}

describe('usePopupScrollRestoration', () => {
  let container: HTMLDivElement;
  let root: Root;
  let resizeObserverCallback: ResizeObserverCallback | null;
  let resizeObserverTarget: Element | null;
  let pendingAnimationFrame: { id: number; callback: FrameRequestCallback } | null;
  let nextAnimationFrameId: number;

  const flushAnimationFrame = (): void => {
    const pending = pendingAnimationFrame;
    pendingAnimationFrame = null;
    if (pending) act(() => pending.callback(0));
  };

  const renderState = async (
    state: PopupScrollViewState,
    flushRestoreFrame = true,
  ): Promise<void> => {
    await act(async () => {
      root.render(<Harness state={state} />);
      await Promise.resolve();
    });
    if (flushRestoreFrame) flushAnimationFrame();
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    storageGet.mockReset().mockResolvedValue({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 0 });
    storageSet.mockReset().mockResolvedValue(undefined);
    resizeObserverCallback = null;
    resizeObserverTarget = null;
    pendingAnimationFrame = null;
    nextAnimationFrameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextAnimationFrameId;
      pendingAnimationFrame = { id, callback };
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      if (pendingAnimationFrame?.id === id) pendingAnimationFrame = null;
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeObserverCallback = callback;
        }

        observe(target: Element): void {
          resizeObserverTarget = target;
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );

    container = document.createElement('div');
    container.id = '__root';
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 2000 },
    });
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    container.remove();
  });

  it.each([undefined, null, '420', -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to the top for invalid value %s',
    (value) => {
      expect(clampPopupScrollTop(value, 1400)).toBe(0);
    },
  );

  it('clamps a stored position to the current scroll range', () => {
    expect(clampPopupScrollTop(5000, 1400)).toBe(1400);
    expect(clampPopupScrollTop(419.6, 1400)).toBe(420);
  });

  it('tracks only the full main settings view', () => {
    expect(shouldTrackPopupSettingsScroll(MAIN_VIEW)).toBe(true);
    expect(shouldTrackPopupSettingsScroll({ ...MAIN_VIEW, activeTabContextLoaded: false })).toBe(
      false,
    );
    expect(shouldTrackPopupSettingsScroll({ ...MAIN_VIEW, hasSettingsSearch: true })).toBe(false);
    expect(shouldTrackPopupSettingsScroll({ ...MAIN_VIEW, showStorageManager: true })).toBe(false);
    expect(shouldTrackPopupSettingsScroll({ ...MAIN_VIEW, showStarredHistory: true })).toBe(false);
    expect(shouldTrackPopupSettingsScroll({ ...MAIN_VIEW, isPluginSite: true })).toBe(false);
  });

  it('restores a valid local position', async () => {
    storageGet.mockResolvedValue({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 420 });

    await renderState(MAIN_VIEW);

    expect(container.scrollTop).toBe(420);
  });

  it('retries the stored target when asynchronous layout growth increases the scroll range', async () => {
    storageGet.mockResolvedValue({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 1800 });

    await renderState(MAIN_VIEW);
    expect(container.scrollTop).toBe(1400);

    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 2400 });
    act(() => resizeObserverCallback?.([], {} as ResizeObserver));

    expect(container.scrollTop).toBe(1800);
  });

  it('retries after Firefox applies a delayed layout clamp', async () => {
    storageGet.mockResolvedValue({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 1800 });
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 2400 });

    await renderState(MAIN_VIEW, false);
    expect(container.scrollTop).toBe(1800);
    storageSet.mockClear();

    act(() => {
      container.scrollTop = 121;
      container.dispatchEvent(new Event('scroll'));
      resizeObserverCallback?.([], {} as ResizeObserver);
    });
    flushAnimationFrame();
    act(() => vi.advanceTimersByTime(150));

    expect(container.scrollTop).toBe(1800);
    expect(storageSet).not.toHaveBeenCalledWith({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 121 });
  });

  it('retries a layout clamp that arrives after the first animation frame', async () => {
    storageGet.mockResolvedValue({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 1800 });
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 2400 });

    await renderState(MAIN_VIEW);
    expect(container.scrollTop).toBe(1800);
    storageSet.mockClear();

    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 721 });
    act(() => {
      container.scrollTop = 121;
      container.dispatchEvent(new Event('scroll'));
    });

    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 2400 });
    act(() => resizeObserverCallback?.([], {} as ResizeObserver));
    act(() => vi.advanceTimersByTime(150));

    expect(container.scrollTop).toBe(1800);
    expect(storageSet).not.toHaveBeenCalledWith({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 121 });
  });

  it('observes rendered content while waiting for the scroll range to grow', async () => {
    storageGet.mockResolvedValue({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 1800 });

    await renderState(MAIN_VIEW);

    expect(resizeObserverTarget).toBe(container.firstElementChild);
    expect(resizeObserverTarget).not.toBe(container);
  });

  it('does not reapply the stored target after the user scrolls during layout restoration', async () => {
    storageGet.mockResolvedValue({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 1800 });

    await renderState(MAIN_VIEW);
    const pendingResizeCallback = resizeObserverCallback;
    act(() => {
      container.scrollTop = 600;
      container.dispatchEvent(new Event('scroll'));
    });

    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 2400 });
    act(() => pendingResizeCallback?.([], {} as ResizeObserver));

    expect(container.scrollTop).toBe(600);
  });

  it('disables scroll anchoring while tracking to keep restored positions stable', async () => {
    container.style.setProperty('overflow-anchor', 'auto');

    await renderState(MAIN_VIEW);

    expect(container.style.getPropertyValue('overflow-anchor')).toBe('none');

    await renderState({ ...MAIN_VIEW, hasSettingsSearch: true });

    expect(container.style.getPropertyValue('overflow-anchor')).toBe('auto');
  });

  it('clamps an oversized local position during restore', async () => {
    storageGet.mockResolvedValue({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 5000 });

    await renderState(MAIN_VIEW);

    expect(container.scrollTop).toBe(1400);
  });

  it('keeps retrying an oversized target when layout growth happens after two seconds', async () => {
    storageGet.mockResolvedValue({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 5000 });

    await renderState(MAIN_VIEW);
    storageSet.mockClear();
    act(() => vi.advanceTimersByTime(5000));

    expect(storageSet).not.toHaveBeenCalled();

    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 5600 });
    act(() => resizeObserverCallback?.([], {} as ResizeObserver));

    expect(container.scrollTop).toBe(5000);
  });

  it('falls back to the top when local storage cannot be read', async () => {
    storageGet.mockRejectedValue(new Error('storage unavailable'));
    container.scrollTop = 300;

    await renderState(MAIN_VIEW);

    expect(container.scrollTop).toBe(0);
  });

  it('does not overwrite local position after a read failure without user scrolling', async () => {
    storageGet.mockRejectedValue(new Error('storage unavailable'));

    await renderState(MAIN_VIEW);
    storageSet.mockClear();
    await renderState({ ...MAIN_VIEW, showStorageManager: true });

    expect(storageSet).not.toHaveBeenCalled();
  });

  it('persists user scrolling after a local read failure', async () => {
    storageGet.mockRejectedValue(new Error('storage unavailable'));

    await renderState(MAIN_VIEW);
    storageSet.mockClear();
    act(() => {
      container.scrollTop = 300;
      container.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(150);
    });

    expect(storageSet).toHaveBeenCalledOnce();
    expect(storageSet).toHaveBeenCalledWith({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 300 });
  });

  it('debounces repeated scroll events into one local write', async () => {
    await renderState(MAIN_VIEW);
    storageSet.mockClear();

    act(() => {
      container.scrollTop = 300;
      container.dispatchEvent(new Event('scroll'));
      container.scrollTop = 420;
      container.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(149);
    });
    expect(storageSet).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(storageSet).toHaveBeenCalledOnce();
    expect(storageSet).toHaveBeenCalledWith({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 420 });
  });

  it('flushes the latest main position on pagehide', async () => {
    await renderState(MAIN_VIEW);
    storageSet.mockClear();

    act(() => {
      container.scrollTop = 515;
      container.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(storageSet).toHaveBeenCalledOnce();
    expect(storageSet).toHaveBeenCalledWith({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 515 });
  });

  it('flushes the latest main position when tracking stops', async () => {
    await renderState(MAIN_VIEW);
    storageSet.mockClear();

    act(() => {
      container.scrollTop = 515;
      container.dispatchEvent(new Event('scroll'));
    });
    await renderState({ ...MAIN_VIEW, showStorageManager: true });

    expect(storageSet).toHaveBeenCalledOnce();
    expect(storageSet).toHaveBeenCalledWith({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 515 });
  });

  it('does not break scrolling when a local write throws synchronously', async () => {
    await renderState(MAIN_VIEW);
    storageSet.mockImplementationOnce(() => {
      throw new Error('extension context invalidated');
    });

    expect(() => {
      act(() => {
        container.scrollTop = 515;
        container.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(150);
      });
    }).not.toThrow();
  });

  it('ignores temporary-view scrolling and restores the main position on return', async () => {
    storageGet.mockResolvedValue({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 420 });
    await renderState(MAIN_VIEW);

    act(() => {
      container.scrollTop = 620;
      container.dispatchEvent(new Event('scroll'));
    });
    await renderState({ ...MAIN_VIEW, hasSettingsSearch: true });
    expect(container.scrollTop).toBe(0);
    storageSet.mockClear();

    act(() => {
      container.scrollTop = 100;
      container.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(150);
    });
    expect(storageSet).not.toHaveBeenCalled();

    await renderState(MAIN_VIEW);
    expect(container.scrollTop).toBe(620);
  });

  it('waits for active tab context and opens plugin views at the top', async () => {
    storageGet.mockResolvedValue({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 420 });
    container.scrollTop = 300;

    await renderState({ ...MAIN_VIEW, activeTabContextLoaded: false });
    expect(container.scrollTop).toBe(0);

    container.scrollTop = 300;
    await renderState({ ...MAIN_VIEW, isPluginSite: true });
    expect(container.scrollTop).toBe(0);

    await renderState(MAIN_VIEW);
    expect(container.scrollTop).toBe(420);
  });

  it('does not overwrite scrolling that happens before local storage finishes loading', async () => {
    let resolveStorageGet: ((value: Record<string, number>) => void) | undefined;
    storageGet.mockReturnValue(
      new Promise<Record<string, number>>((resolve) => {
        resolveStorageGet = resolve;
      }),
    );

    await renderState(MAIN_VIEW);
    act(() => {
      container.scrollTop = 300;
      container.dispatchEvent(new Event('scroll'));
    });

    await act(async () => {
      resolveStorageGet?.({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 900 });
      await Promise.resolve();
    });
    flushAnimationFrame();

    expect(container.scrollTop).toBe(300);
    storageSet.mockClear();
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(storageSet).toHaveBeenCalledWith({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 300 });
  });

  it('ignores a layout clamp while a temporary view commits', async () => {
    storageGet.mockResolvedValue({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 420 });
    await renderState(MAIN_VIEW);

    act(() => {
      container.scrollTop = 620;
      container.dispatchEvent(new Event('scroll'));
    });
    storageSet.mockClear();

    let dispatchedClamp = false;
    await act(async () => {
      root.render(
        <Harness
          state={{ ...MAIN_VIEW, hasSettingsSearch: true }}
          onLayoutCommit={() => {
            if (dispatchedClamp) return;
            dispatchedClamp = true;
            container.scrollTop = 0;
            container.dispatchEvent(new Event('scroll'));
          }}
        />,
      );
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(150));

    expect(storageSet).not.toHaveBeenCalledWith({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 0 });

    await renderState(MAIN_VIEW);
    expect(container.scrollTop).toBe(620);
  });

  it('keeps the main target while filtered content grows back after search clears', async () => {
    storageGet.mockResolvedValue({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 1800 });
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 2400 });
    await renderState(MAIN_VIEW);
    expect(container.scrollTop).toBe(1800);

    await renderState({ ...MAIN_VIEW, hasSettingsSearch: true });
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 721 });
    container.scrollTop = 0;
    storageSet.mockClear();

    await renderState(MAIN_VIEW);
    expect(container.scrollTop).toBe(121);

    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 2400 });
    act(() => resizeObserverCallback?.([], {} as ResizeObserver));

    expect(container.scrollTop).toBe(1800);
    expect(storageSet).not.toHaveBeenCalledWith({ [StorageKeys.GV_POPUP_SCROLL_TOP]: 121 });
  });
});
