import { useCallback, useMemo, useState } from 'react';

import { StorageKeys, type TimelineStyle, isTimelineStyle } from '@/core/types/common';

import type { ScrollMode, TimelineSettingsValues } from '../components/TimelineSettingsCard';
import { type SettingSetters, applySettingsPatch } from '../utils/settingsPatch';

export const TIMELINE_SETTINGS_STORAGE_DEFAULTS = {
  geminiTimelineScrollMode: 'flow',
  [StorageKeys.TIMELINE_STYLE]: 'dots',
  geminiTimelineHideContainer: false,
  geminiTimelineDraggable: false,
  [StorageKeys.TIMELINE_PREVIEW_PINNED]: false,
  geminiTimelineMarkerLevel: false,
  gvPreventAutoScrollEnabled: false,
  [StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS]: false,
};

export function useTimelinePopupSettings(
  writeSyncStorage: (payload: Record<string, unknown>) => Promise<void>,
) {
  const [mode, setMode] = useState<ScrollMode>('flow');
  const [timelineStyle, setTimelineStyle] = useState<TimelineStyle>('dots');
  const [hideContainer, setHideContainer] = useState(false);
  const [draggableTimeline, setDraggableTimeline] = useState(false);
  const [timelinePreviewPinned, setTimelinePreviewPinned] = useState(false);
  const [markerLevelEnabled, setMarkerLevelEnabled] = useState(false);
  const [showMessageTimestamps, setShowMessageTimestamps] = useState(false);
  const [preventAutoScrollEnabled, setPreventAutoScrollEnabled] = useState(false);

  const setters = useMemo<SettingSetters<TimelineSettingsValues>>(
    () => ({
      mode: setMode,
      timelineStyle: setTimelineStyle,
      hideContainer: setHideContainer,
      draggableTimeline: setDraggableTimeline,
      timelinePreviewPinned: setTimelinePreviewPinned,
      markerLevelEnabled: setMarkerLevelEnabled,
      showMessageTimestamps: setShowMessageTimestamps,
      preventAutoScrollEnabled: setPreventAutoScrollEnabled,
    }),
    [],
  );

  const hydrateFromStorage = useCallback((stored: Record<string, unknown>) => {
    const mode = stored.geminiTimelineScrollMode;
    if (mode === 'jump' || mode === 'flow') setMode(mode);
    const style = stored[StorageKeys.TIMELINE_STYLE];
    if (isTimelineStyle(style)) setTimelineStyle(style);
    setHideContainer(!!stored.geminiTimelineHideContainer);
    setDraggableTimeline(!!stored.geminiTimelineDraggable);
    setTimelinePreviewPinned(stored[StorageKeys.TIMELINE_PREVIEW_PINNED] === true);
    setMarkerLevelEnabled(!!stored.geminiTimelineMarkerLevel);
    setShowMessageTimestamps(stored[StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS] === true);
    setPreventAutoScrollEnabled(stored.gvPreventAutoScrollEnabled === true);
  }, []);

  const onChange = useCallback(
    (patch: Partial<TimelineSettingsValues>) => {
      applySettingsPatch(setters, patch);
      const payload: Record<string, unknown> = {};
      if (patch.mode) payload.geminiTimelineScrollMode = patch.mode;
      if (patch.timelineStyle) payload[StorageKeys.TIMELINE_STYLE] = patch.timelineStyle;
      if (typeof patch.hideContainer === 'boolean')
        payload.geminiTimelineHideContainer = patch.hideContainer;
      if (typeof patch.draggableTimeline === 'boolean')
        payload.geminiTimelineDraggable = patch.draggableTimeline;
      if (typeof patch.timelinePreviewPinned === 'boolean')
        payload[StorageKeys.TIMELINE_PREVIEW_PINNED] = patch.timelinePreviewPinned;
      if (typeof patch.markerLevelEnabled === 'boolean')
        payload.geminiTimelineMarkerLevel = patch.markerLevelEnabled;
      if (typeof patch.showMessageTimestamps === 'boolean')
        payload[StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS] = patch.showMessageTimestamps;
      if (typeof patch.preventAutoScrollEnabled === 'boolean')
        payload.gvPreventAutoScrollEnabled = patch.preventAutoScrollEnabled;
      void writeSyncStorage(payload);
    },
    [setters, writeSyncStorage],
  );

  const resetPosition = useCallback(() => {
    void writeSyncStorage({ geminiTimelinePosition: null });
  }, [writeSyncStorage]);

  return {
    values: {
      mode,
      timelineStyle,
      hideContainer,
      draggableTimeline,
      timelinePreviewPinned,
      markerLevelEnabled,
      showMessageTimestamps,
      preventAutoScrollEnabled,
    },
    hydrateFromStorage,
    onChange,
    resetPosition,
  };
}
