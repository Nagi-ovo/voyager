import React from 'react';

import type { TimelineStyle } from '@/core/types/common';
import type { TranslationKey } from '@/utils/translations';

import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardTitle } from '../../../components/ui/card';
import { Label } from '../../../components/ui/label';
import { SettingToggleRow } from './SettingToggleRow';

export type ScrollMode = 'jump' | 'flow';

/** Every timeline setting the card edits; the popup owns the state and persistence. */
export interface TimelineSettingsValues {
  timelineStyle: TimelineStyle;
  mode: ScrollMode;
  hideContainer: boolean;
  draggableTimeline: boolean;
  timelinePreviewPinned: boolean;
  preventAutoScrollEnabled: boolean;
  markerLevelEnabled: boolean;
  showMessageTimestamps: boolean;
}

export interface TimelineSettingsCardProps {
  values: TimelineSettingsValues;
  /** One key per call; the popup mirrors it into state and storage. */
  onChange: (patch: Partial<TimelineSettingsValues>) => void;
  onResetPosition: () => void;
  onViewStarredHistory: () => void;
  /** Site capability and settings-search gate, keyed by the setting's search id. */
  isVisible: (settingId: string) => boolean;
  t: (key: TranslationKey) => string;
}

const TIMELINE_STYLE_OPTIONS: readonly {
  value: TimelineStyle;
  label: TranslationKey;
  left: string;
}[] = [
  { value: 'dots', label: 'timelineStyleDots', left: '4px' },
  { value: 'ruler', label: 'timelineStyleRuler', left: 'calc(33.333% + 2px)' },
  { value: 'compact', label: 'timelineStyleCompact', left: '66.666%' },
];

const SCROLL_MODE_OPTIONS: readonly { value: ScrollMode; label: TranslationKey; left: string }[] = [
  { value: 'flow', label: 'flow', left: '4px' },
  { value: 'jump', label: 'jump', left: 'calc(50% + 2px)' },
];

export function TimelineSettingsCard({
  values,
  onChange,
  onResetPosition,
  onViewStarredHistory,
  isVisible,
  t,
}: TimelineSettingsCardProps) {
  const activeStyle = TIMELINE_STYLE_OPTIONS.find((o) => o.value === values.timelineStyle);
  const activeMode = SCROLL_MODE_OPTIONS.find((o) => o.value === values.mode);

  return (
    <Card className="p-4 transition-all hover:shadow-md">
      <CardTitle className="mb-4">{t('timelineOptions')}</CardTitle>
      <CardContent className="space-y-4 p-0">
        <div hidden={!isVisible('timelineStyle')}>
          <Label className="mb-2 block text-sm font-medium">{t('timelineStyle')}</Label>
          <div className="bg-secondary/60 relative grid grid-cols-3 gap-1 rounded-xl p-1">
            <div
              className="bg-primary pointer-events-none absolute top-1 bottom-1 w-[calc(33.333%-4px)] rounded-lg shadow-sm transition-all duration-300 ease-out"
              style={{ left: activeStyle?.left ?? '4px' }}
            />
            {TIMELINE_STYLE_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={`relative z-10 rounded-lg px-2 py-2 text-sm font-bold transition-all duration-200 ${
                  values.timelineStyle === option.value
                    ? 'text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => onChange({ timelineStyle: option.value })}
              >
                {t(option.label)}
              </button>
            ))}
          </div>
        </div>
        <div hidden={!isVisible('scrollMode')}>
          <Label className="mb-2 block text-sm font-medium">{t('scrollMode')}</Label>
          <div className="bg-secondary/60 relative grid grid-cols-2 gap-1 rounded-xl p-1">
            <div
              className="bg-primary pointer-events-none absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-lg shadow-sm transition-all duration-300 ease-out"
              style={{ left: activeMode?.left ?? '4px' }}
            />
            {SCROLL_MODE_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={`relative z-10 rounded-lg px-3 py-2 text-sm font-bold transition-all duration-200 ${
                  values.mode === option.value
                    ? 'text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => onChange({ mode: option.value })}
              >
                {t(option.label)}
              </button>
            ))}
          </div>
        </div>
        <SettingToggleRow
          id="hide-container"
          settingId="hideOuterContainer"
          label="hideOuterContainer"
          checked={values.hideContainer}
          onChange={(hideContainer) => onChange({ hideContainer })}
          isVisible={isVisible}
          t={t}
        />
        <SettingToggleRow
          id="draggable-timeline"
          settingId="draggableTimeline"
          label="draggableTimeline"
          checked={values.draggableTimeline}
          onChange={(draggableTimeline) => onChange({ draggableTimeline })}
          isVisible={isVisible}
          t={t}
        />
        <SettingToggleRow
          id="timeline-preview-pinned"
          settingId="pinTimelinePreview"
          label="pinTimelinePreview"
          hint="pinTimelinePreviewHint"
          checked={values.timelinePreviewPinned}
          onChange={(timelinePreviewPinned) => onChange({ timelinePreviewPinned })}
          isVisible={isVisible}
          t={t}
        />
        <SettingToggleRow
          id="prevent-auto-scroll"
          settingId="preventAutoScroll"
          label="preventAutoScroll"
          hint="preventAutoScrollHint"
          checked={values.preventAutoScrollEnabled}
          onChange={(preventAutoScrollEnabled) => onChange({ preventAutoScrollEnabled })}
          isVisible={isVisible}
          t={t}
        />
        <SettingToggleRow
          id="marker-level-enabled"
          settingId="enableMarkerLevel"
          label="enableMarkerLevel"
          hint="enableMarkerLevelHint"
          experimental
          checked={values.markerLevelEnabled}
          onChange={(markerLevelEnabled) => onChange({ markerLevelEnabled })}
          isVisible={isVisible}
          t={t}
        />
        <SettingToggleRow
          id="show-message-timestamps"
          settingId="showMessageTimestamps"
          label="showMessageTimestamps"
          hint="showMessageTimestampsHint"
          experimental
          checked={values.showMessageTimestamps}
          onChange={(showMessageTimestamps) => onChange({ showMessageTimestamps })}
          isVisible={isVisible}
          t={t}
        />
        <Button
          hidden={!isVisible('resetTimelinePosition')}
          variant="outline"
          size="sm"
          className="group hover:border-primary/50 mt-2 w-full"
          onClick={onResetPosition}
        >
          <span className="text-xs transition-transform group-hover:scale-105">
            {t('resetTimelinePosition')}
          </span>
        </Button>
        <Button
          hidden={!isVisible('viewStarredHistory')}
          variant="outline"
          size="sm"
          className="group hover:border-primary/50 mt-2 w-full"
          onClick={onViewStarredHistory}
        >
          <span className="flex items-center gap-1.5 text-xs transition-transform group-hover:scale-105">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="text-primary"
            >
              <path
                d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
                fill="currentColor"
              />
            </svg>
            {t('viewStarredHistory')}
          </span>
        </Button>
      </CardContent>
    </Card>
  );
}
