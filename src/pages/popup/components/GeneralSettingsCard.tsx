import React from 'react';

import type { TranslationKey } from '@/utils/translations';

import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardTitle } from '../../../components/ui/card';
import { Label } from '../../../components/ui/label';
import { Switch } from '../../../components/ui/switch';
import { SettingToggleRow } from './SettingToggleRow';

/** Every general toggle the card edits; the popup owns the state and persistence. */
export interface GeneralSettingsValues {
  persistentExportToolbarEnabled: boolean;
  mermaidEnabled: boolean;
  wavedromEnabled: boolean;
  echartsEnabled: boolean;
  quoteReplyEnabled: boolean;
  highlightEnabled: boolean;
  highlightTimelineMarkersEnabled: boolean;
  responseCompleteNotificationEnabled: boolean;
  remoteAnnouncementEnabled: boolean;
  changelogBadgeMode: boolean;
  usageStatusEnabled: boolean;
  inputHaloHidden: boolean;
  defaultModelAutoApplyEnabled: boolean;
}

export interface GeneralSettingsCardProps {
  values: GeneralSettingsValues;
  /** One key per call; the popup decides how each key is persisted. */
  onChange: (patch: Partial<GeneralSettingsValues>) => void;
  /** Safari routes completion notifications through the native app, so its hint differs. */
  isSafariBrowser: boolean;
  /** Shown under the announcements row until system notifications are granted. */
  remoteAnnouncementPermissionCta: { visible: boolean; onRequest: () => void };
  /** Site capability and settings-search gate, keyed by the setting's search id. */
  isVisible: (settingId: string) => boolean;
  t: (key: TranslationKey) => string;
}

export function GeneralSettingsCard({
  values,
  onChange,
  isSafariBrowser,
  remoteAnnouncementPermissionCta,
  isVisible,
  t,
}: GeneralSettingsCardProps) {
  const row = (
    id: string,
    settingId: string,
    key: keyof GeneralSettingsValues,
    label: TranslationKey,
    hint: TranslationKey,
    options: { disabled?: boolean; extra?: React.ReactNode } = {},
  ) => (
    <SettingToggleRow
      id={id}
      settingId={settingId}
      label={label}
      hint={hint}
      checked={values[key]}
      disabled={options.disabled}
      extra={options.extra}
      onChange={(checked) => onChange({ [key]: checked })}
      isVisible={isVisible}
      unmountWhenHidden
      t={t}
    />
  );

  return (
    <Card className="p-4 transition-all hover:shadow-md">
      <CardTitle className="mb-4">{t('generalOptions')}</CardTitle>
      <CardContent className="space-y-4 p-0">
        {isVisible('enableTabTitleUpdate') && (
          <div className="flex items-center justify-between opacity-60">
            <div className="flex-1">
              <Label
                htmlFor="tab-title-update"
                className="text-muted-foreground cursor-not-allowed text-sm font-medium"
              >
                {t('enableTabTitleUpdate')}
              </Label>
              <p className="text-muted-foreground mt-1 text-xs">{t('enableTabTitleUpdateHint')}</p>
            </div>
            <Switch id="tab-title-update" checked={false} disabled className="opacity-70" />
          </div>
        )}
        {row(
          'persistent-export-toolbar',
          'persistentExportToolbar',
          'persistentExportToolbarEnabled',
          'persistentExportToolbar',
          'persistentExportToolbarHint',
        )}
        {row(
          'mermaid-enabled',
          'enableMermaidRendering',
          'mermaidEnabled',
          'enableMermaidRendering',
          'enableMermaidRenderingHint',
        )}
        {row(
          'wavedrom-enabled',
          'enableWaveDromRendering',
          'wavedromEnabled',
          'enableWaveDromRendering',
          'enableWaveDromRenderingHint',
        )}
        {row(
          'echarts-enabled',
          'enableEchartsRendering',
          'echartsEnabled',
          'enableEchartsRendering',
          'enableEchartsRenderingHint',
        )}
        {row(
          'quote-reply-enabled',
          'enableQuoteReply',
          'quoteReplyEnabled',
          'enableQuoteReply',
          'enableQuoteReplyHint',
        )}
        {row(
          'highlights-enabled',
          'enableHighlights',
          'highlightEnabled',
          'enableHighlights',
          'enableHighlightsHint',
        )}
        {row(
          'highlight-timeline-markers-enabled',
          'showHighlightTimelineMarkers',
          'highlightTimelineMarkersEnabled',
          'showHighlightTimelineMarkers',
          'showHighlightTimelineMarkersHint',
          { disabled: !values.highlightEnabled },
        )}
        {row(
          'response-complete-notification',
          'responseCompleteNotification',
          'responseCompleteNotificationEnabled',
          'responseCompleteNotification',
          isSafariBrowser
            ? 'responseCompleteNotificationHintSafari'
            : 'responseCompleteNotificationHint',
        )}
        {row(
          'remote-announcement-notification',
          'remoteAnnouncementNotification',
          'remoteAnnouncementEnabled',
          'remoteAnnouncementNotification',
          'remoteAnnouncementNotificationHint',
          {
            extra: remoteAnnouncementPermissionCta.visible ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-2 h-7 px-2.5 text-xs"
                onClick={remoteAnnouncementPermissionCta.onRequest}
              >
                {t('remoteAnnouncementSystemPermissionCta')}
              </Button>
            ) : null,
          },
        )}
        {row(
          'changelog-notify-badge',
          'changelogBadgeMode',
          'changelogBadgeMode',
          'changelog_badge_mode',
          'changelog_badge_mode_hint',
        )}
        {row(
          'usage-status-enabled',
          'usageStatusToggle',
          'usageStatusEnabled',
          'usageStatusToggle',
          'usageStatusToggleHint',
        )}
        {row(
          'input-halo-hidden',
          'hideInputHalo',
          'inputHaloHidden',
          'hideInputHalo',
          'hideInputHaloHint',
        )}
        {row(
          'default-model-auto-apply',
          'enableDefaultModelAutoApply',
          'defaultModelAutoApplyEnabled',
          'enableDefaultModelAutoApply',
          'enableDefaultModelAutoApplyHint',
        )}
      </CardContent>
    </Card>
  );
}
