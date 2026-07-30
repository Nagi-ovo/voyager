import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';

const POPUP_ROOT_ID = '__root';
const SCROLL_WRITE_DEBOUNCE_MS = 150;
const RESTORE_LAYOUT_WINDOW_MS = 2000;

export interface PopupScrollViewState {
  hasSettingsSearch: boolean;
  isPluginSite: boolean;
  showStarredHistory: boolean;
  showStorageManager: boolean;
}

function normalizePopupScrollTop(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

export function clampPopupScrollTop(value: unknown, maxScrollTop: number): number {
  return Math.min(normalizePopupScrollTop(value), normalizePopupScrollTop(maxScrollTop));
}

export function shouldTrackPopupSettingsScroll(state: PopupScrollViewState): boolean {
  return (
    !state.hasSettingsSearch &&
    !state.isPluginSite &&
    !state.showStarredHistory &&
    !state.showStorageManager
  );
}

export function usePopupScrollRestoration(state: PopupScrollViewState): void {
  const active = shouldTrackPopupSettingsScroll(state);
  const positionRef = useRef(0);
  const restorationTargetRef = useRef<number | null>(null);
  const persistedPositionRef = useRef<number | null>(null);
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loaded, setLoaded] = useState(false);

  const persistPosition = useCallback((): void => {
    if (writeTimerRef.current) {
      clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    }

    const position = normalizePopupScrollTop(positionRef.current);
    if (position === persistedPositionRef.current) return;
    persistedPositionRef.current = position;

    try {
      void browser.storage.local.set({ [StorageKeys.GV_POPUP_SCROLL_TOP]: position }).catch(() => {
        if (persistedPositionRef.current === position) persistedPositionRef.current = null;
      });
    } catch {
      if (persistedPositionRef.current === position) {
        persistedPositionRef.current = null;
      }
    }
  }, []);

  const schedulePersist = useCallback((): void => {
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(persistPosition, SCROLL_WRITE_DEBOUNCE_MS);
  }, [persistPosition]);

  useEffect(() => {
    let cancelled = false;
    const finishAtTop = (): void => {
      if (cancelled) return;
      positionRef.current = 0;
      restorationTargetRef.current = 0;
      persistedPositionRef.current = 0;
      setLoaded(true);
    };

    try {
      void browser.storage.local
        .get(StorageKeys.GV_POPUP_SCROLL_TOP)
        .then((result) => {
          if (cancelled) return;
          const position = normalizePopupScrollTop(result[StorageKeys.GV_POPUP_SCROLL_TOP]);
          positionRef.current = position;
          restorationTargetRef.current = position;
          persistedPositionRef.current = position;
          setLoaded(true);
        })
        .catch(finishAtTop);
    } catch {
      finishAtTop();
    }

    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    if (!loaded || !active) return;
    const container = document.getElementById(POPUP_ROOT_ID);
    if (!container) return;

    const previousOverflowAnchor = container.style.getPropertyValue('overflow-anchor');
    // Firefox scroll anchoring can turn async layout shifts into persisted offset drift.
    container.style.setProperty('overflow-anchor', 'none');

    let resizeObserver: ResizeObserver | null = null;
    let restoreTimer: ReturnType<typeof setTimeout> | null = null;
    let restoreFrame: number | null = null;
    let awaitingInitialLayout = true;
    let lastAppliedScrollTop: number | null = null;

    const stopLayoutObservation = (): void => {
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (restoreTimer) {
        clearTimeout(restoreTimer);
        restoreTimer = null;
      }
      if (restoreFrame !== null) {
        cancelAnimationFrame(restoreFrame);
        restoreFrame = null;
      }
    };
    const finishRestoring = (finalPosition?: number): void => {
      stopLayoutObservation();
      restorationTargetRef.current = null;
      if (finalPosition !== undefined) positionRef.current = finalPosition;
    };
    const applyRestorationTarget = (target: number): number => {
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const restoredPosition = clampPopupScrollTop(target, maxScrollTop);
      lastAppliedScrollTop = restoredPosition;
      container.scrollTop = restoredPosition;
      return restoredPosition;
    };

    const restorationTarget = restorationTargetRef.current ?? positionRef.current;
    restorationTargetRef.current = restorationTarget;
    applyRestorationTarget(restorationTarget);
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        if (restorationTargetRef.current !== restorationTarget) return;
        applyRestorationTarget(restorationTarget);
      });
      resizeObserver.observe(container.firstElementChild ?? container);
      restoreTimer = setTimeout(() => {
        if (restorationTargetRef.current !== restorationTarget) return;
        const finalPosition = applyRestorationTarget(restorationTarget);
        finishRestoring(finalPosition);
        persistPosition();
      }, RESTORE_LAYOUT_WINDOW_MS);
    }

    // Firefox can apply a queued layout clamp after scrollTop appears restored.
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = null;
      if (restorationTargetRef.current !== restorationTarget) return;
      awaitingInitialLayout = false;
      const confirmedPosition = applyRestorationTarget(restorationTarget);
      if (!resizeObserver) {
        finishRestoring(confirmedPosition);
      }
    });

    const onScroll = (): void => {
      const position = normalizePopupScrollTop(container.scrollTop);
      if (awaitingInitialLayout) return;
      const activeRestorationTarget = restorationTargetRef.current;
      if (activeRestorationTarget !== null) {
        if (position === lastAppliedScrollTop) return;
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (position === clampPopupScrollTop(activeRestorationTarget, maxScrollTop)) return;
        finishRestoring();
      }
      positionRef.current = position;
      schedulePersist();
    };
    const onPageHide = (): void => persistPosition();

    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', onPageHide);

    return () => {
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', onPageHide);
      stopLayoutObservation();
      if (previousOverflowAnchor) {
        container.style.setProperty('overflow-anchor', previousOverflowAnchor);
      } else {
        container.style.removeProperty('overflow-anchor');
      }
      persistPosition();
    };
  }, [active, loaded, persistPosition, schedulePersist]);

  useEffect(
    () => () => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    },
    [],
  );
}
