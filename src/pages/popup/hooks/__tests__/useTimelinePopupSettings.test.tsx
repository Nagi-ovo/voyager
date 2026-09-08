import React, { act, useEffect } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { useTimelinePopupSettings } from '../useTimelinePopupSettings';

type TimelineSettings = ReturnType<typeof useTimelinePopupSettings>;

function Harness({
  capture,
  writeSyncStorage,
}: {
  capture: (settings: TimelineSettings) => void;
  writeSyncStorage: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const settings = useTimelinePopupSettings(writeSyncStorage);
  useEffect(() => {
    capture(settings);
  }, [capture, settings]);
  return null;
}

describe('useTimelinePopupSettings', () => {
  let container: HTMLDivElement;
  let root: Root;
  let settings: TimelineSettings;
  const writeSyncStorage = vi.fn(async (_payload: Record<string, unknown>) => {});

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    writeSyncStorage.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <Harness capture={(next) => (settings = next)} writeSyncStorage={writeSyncStorage} />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('hydrates the stored timeline controls without persisting a new snapshot', () => {
    act(() =>
      settings.hydrateFromStorage({
        geminiTimelineScrollMode: 'jump',
        [StorageKeys.TIMELINE_STYLE]: 'ruler',
        geminiTimelineHideContainer: true,
        geminiTimelineDraggable: true,
        [StorageKeys.TIMELINE_PREVIEW_PINNED]: true,
        geminiTimelineMarkerLevel: true,
        [StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS]: true,
        gvPreventAutoScrollEnabled: true,
      }),
    );
    expect(settings.values).toEqual({
      mode: 'jump',
      timelineStyle: 'ruler',
      hideContainer: true,
      draggableTimeline: true,
      timelinePreviewPinned: true,
      markerLevelEnabled: true,
      showMessageTimestamps: true,
      preventAutoScrollEnabled: true,
    });
    expect(writeSyncStorage).not.toHaveBeenCalled();
  });

  it('keeps the last valid mode and style when storage contains invalid enum values', () => {
    act(() =>
      settings.hydrateFromStorage({
        geminiTimelineScrollMode: 'jump',
        [StorageKeys.TIMELINE_STYLE]: 'compact',
      }),
    );
    act(() =>
      settings.hydrateFromStorage({
        geminiTimelineScrollMode: 'smooth',
        [StorageKeys.TIMELINE_STYLE]: 3,
      }),
    );
    expect(settings.values.mode).toBe('jump');
    expect(settings.values.timelineStyle).toBe('compact');
    expect(writeSyncStorage).not.toHaveBeenCalled();
  });

  it('writes sparse false changes under their existing keys without clearing other controls', () => {
    act(() =>
      settings.hydrateFromStorage({
        geminiTimelineHideContainer: true,
        geminiTimelineDraggable: true,
        geminiTimelineMarkerLevel: true,
        [StorageKeys.TIMELINE_PREVIEW_PINNED]: true,
      }),
    );
    const before = settings.values;
    act(() => settings.onChange({ hideContainer: false, markerLevelEnabled: false }));
    expect(settings.values).toEqual({ ...before, hideContainer: false, markerLevelEnabled: false });
    expect(writeSyncStorage).toHaveBeenCalledExactlyOnceWith({
      geminiTimelineHideContainer: false,
      geminiTimelineMarkerLevel: false,
    });
  });

  it('resets only the saved position and preserves all timeline preferences', () => {
    act(() =>
      settings.hydrateFromStorage({
        geminiTimelineScrollMode: 'jump',
        [StorageKeys.TIMELINE_STYLE]: 'ruler',
        geminiTimelineDraggable: true,
        [StorageKeys.TIMELINE_PREVIEW_PINNED]: true,
      }),
    );
    const before = settings.values;
    act(() => settings.resetPosition());
    expect(settings.values).toEqual(before);
    expect(writeSyncStorage).toHaveBeenCalledExactlyOnceWith({ geminiTimelinePosition: null });
  });
});
