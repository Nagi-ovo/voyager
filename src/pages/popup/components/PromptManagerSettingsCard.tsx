import React from 'react';

import type { TranslationKey } from '@/utils/translations';

import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardTitle } from '../../../components/ui/card';
import { Label } from '../../../components/ui/label';
import type { PromptDataTransferController } from '../hooks/usePromptDataTransfer';
import type { PromptManagerSettings } from '../hooks/usePromptManagerSettings';
import { PromptDataTransfer } from './PromptDataTransfer';
import { SettingToggleRow } from './SettingToggleRow';
import {
  IconChatGPT,
  IconClaude,
  IconDeepSeek,
  IconKimi,
  IconMidjourney,
  IconNotebookLM,
  IconQwen,
} from './WebsiteLogos';

export interface PromptManagerSettingsCardProps {
  settings: PromptManagerSettings;
  transfer: PromptDataTransferController;
  t: (key: TranslationKey) => string;
  isVisible: (settingId: string) => boolean;
  isPluginSite: boolean;
}

export function PromptManagerSettingsCard({
  settings,
  transfer,
  t,
  isVisible,
  isPluginSite,
}: PromptManagerSettingsCardProps) {
  const { values, onChange, customWebsites, newWebsiteInput, websiteError } = settings;

  return (
    <Card className="p-4 transition-all hover:shadow-md">
      <CardTitle className="mb-4">{t('promptManagerOptions')}</CardTitle>
      <CardContent className="space-y-3 p-0">
        <SettingToggleRow
          id="hide-prompt-manager"
          settingId="hidePromptManager"
          label="hidePromptManager"
          hint="hidePromptManagerHint"
          checked={values.hidePromptManager}
          onChange={(hidePromptManager) => onChange({ hidePromptManager })}
          isVisible={isVisible}
          unmountWhenHidden
          t={t}
        />
        <SettingToggleRow
          id="prompt-history-enabled"
          settingId="promptHistoryEnabled"
          label="promptHistoryTitle"
          hint="promptHistoryEnabledHint"
          checked={values.promptHistoryEnabled}
          onChange={(promptHistoryEnabled) => onChange({ promptHistoryEnabled })}
          isVisible={isVisible}
          unmountWhenHidden
          t={t}
        />
        <SettingToggleRow
          id="slash-prompt-enabled"
          settingId="slashPromptEnabled"
          label="slashPromptEnabled"
          hint="slashPromptEnabledHint"
          checked={values.slashPromptEnabled}
          onChange={(slashPromptEnabled) => onChange({ slashPromptEnabled })}
          isVisible={isVisible}
          unmountWhenHidden
          t={t}
        />
        <SettingToggleRow
          id="prompt-insert-on-click"
          settingId="promptInsertOnClick"
          label="promptInsertOnClick"
          hint="promptInsertOnClickHint"
          checked={values.promptInsertOnClickEnabled}
          onChange={(promptInsertOnClickEnabled) => onChange({ promptInsertOnClickEnabled })}
          isVisible={isVisible}
          unmountWhenHidden
          t={t}
        />
        {isVisible('promptDataMigration') && <PromptDataTransfer t={t} transfer={transfer} />}
        {isVisible('customWebsites') && (
          <div>
            <Label className="mb-2 block text-sm font-medium">{t('customWebsites')}</Label>
            {!isPluginSite && (
              <div className="bg-primary/10 border-primary/20 mb-2 flex items-center gap-2 rounded-md border p-2">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  className="text-primary shrink-0"
                >
                  <path
                    d="M8 1C4.13 1 1 4.13 1 8s3.13 7 7 7 7-3.13 7-7-3.13-7-7-7zm0 11c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm1-4H7V5h2v3z"
                    fill="currentColor"
                  />
                </svg>
                <p className="text-primary text-xs font-medium">{t('geminiOnlyNotice')}</p>
              </div>
            )}
            {/* Prompt Manager coverage is separate from plugins on these shared sites. */}
            <div className="mb-3 flex flex-wrap gap-1.5">
              {[
                { domain: 'chatgpt.com', label: 'ChatGPT', Icon: IconChatGPT },
                { domain: 'claude.ai', label: 'Claude', Icon: IconClaude },
                { domain: 'deepseek.com', label: 'DeepSeek', Icon: IconDeepSeek },
                { domain: 'qwen.ai', label: 'Qwen', Icon: IconQwen },
                { domain: 'kimi.com', label: 'Kimi', Icon: IconKimi },
                { domain: 'notebooklm.google.com', label: 'NotebookLM', Icon: IconNotebookLM },
                { domain: 'midjourney.com', label: 'Midjourney', Icon: IconMidjourney },
              ].map(({ domain, label, Icon }) => {
                const isEnabled = customWebsites.includes(domain);
                return (
                  <button
                    key={domain}
                    onClick={() => {
                      void settings.toggleQuickWebsite(domain, isEnabled);
                    }}
                    className={`inline-flex min-w-[30%] grow items-center justify-center gap-1 rounded-full px-2 py-1.5 text-[11px] font-medium transition-all ${
                      isEnabled
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground'
                    }`}
                    title={label}
                  >
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                      <Icon />
                    </span>
                    <span className="truncate">{label}</span>
                    <span
                      className={`w-2.5 shrink-0 text-center text-[10px] transition-opacity ${isEnabled ? 'opacity-100' : 'opacity-0'}`}
                    >
                      ✓
                    </span>
                  </button>
                );
              })}
            </div>
            {customWebsites.length > 0 && (
              <div className="mb-3 space-y-2">
                {customWebsites.map((website) => (
                  <div
                    key={website}
                    className="bg-secondary/30 group hover:bg-secondary/50 flex items-center justify-between rounded-md px-3 py-2 transition-colors"
                  >
                    <span className="text-foreground/90 font-mono text-sm">{website}</span>
                    <button
                      onClick={() => {
                        void settings.handleRemoveWebsite(website);
                      }}
                      className="text-destructive hover:text-destructive/80 text-xs font-medium opacity-70 transition-opacity group-hover:opacity-100"
                    >
                      {t('removeWebsite')}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  value={newWebsiteInput}
                  onChange={(event) => settings.onWebsiteInputChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void settings.handleAddWebsite();
                  }}
                  placeholder={t('customWebsitesPlaceholder')}
                  className="bg-background border-border focus:ring-primary/50 min-w-0 flex-1 rounded-md border px-3 py-2 text-sm transition-all focus:ring-2 focus:outline-none"
                />
                <Button
                  onClick={() => {
                    void settings.handleAddWebsite();
                  }}
                  size="sm"
                  className="shrink-0 whitespace-nowrap"
                >
                  {t('addWebsite')}
                </Button>
              </div>
              {websiteError && <p className="text-destructive text-xs">{websiteError}</p>}
            </div>
            <div className="bg-primary/5 border-primary/20 mt-3 rounded-md border p-2">
              <p className="text-muted-foreground text-xs">{t('customWebsitesNote')}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
