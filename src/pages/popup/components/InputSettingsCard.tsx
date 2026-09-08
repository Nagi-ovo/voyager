import type { ReactNode } from 'react';

import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { getModifierKey } from '@/core/utils/browser';
import type { TranslationKey } from '@/utils/translations';

import type { InputPopupSettingsValues } from '../hooks/useInputPopupSettings';

export function InputSettingsCard({
  values,
  onChange,
  isAIStudio,
  isSafariBrowser,
  currentPlatformLabel,
  isVisible,
  t,
}: {
  values: InputPopupSettingsValues;
  onChange: (patch: Partial<InputPopupSettingsValues>) => void;
  isAIStudio: boolean;
  isSafariBrowser: boolean;
  currentPlatformLabel: string;
  isVisible: (settingId: string) => boolean;
  t: (key: TranslationKey) => string;
}) {
  const {
    inputCollapseEnabled,
    inputCollapseWhenNotEmpty,
    inputVimModeEnabled,
    ctrlEnterSendEnabled,
    aiStudioEnterSendEnabled,
    safariEnterFixEnabled,
    draftAutoSaveEnabled,
  } = values;
  const renderSetting = (id: string, content: ReactNode) => (isVisible(id) ? content : null);
  return (
    <Card className="p-4 transition-all hover:shadow-md">
      <CardTitle className="mb-4">{t('inputCollapseOptions')}</CardTitle>
      <CardContent className="space-y-4 p-0">
        {renderSetting(
          'enableInputCollapse',
          <div className="group flex items-center justify-between">
            <div className="flex-1">
              <Label
                htmlFor="input-collapse-enabled"
                className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
              >
                {t('enableInputCollapse')}
              </Label>
              <p className="text-muted-foreground mt-1 text-xs">
                {t('enableInputCollapseHint')}{' '}
                <span className="text-muted-foreground/70">
                  ({t('inputCollapseShortcutHint').replace('{modifier}', getModifierKey())})
                </span>
              </p>
            </div>
            <Switch
              id="input-collapse-enabled"
              checked={inputCollapseEnabled}
              onChange={(e) => {
                onChange({ inputCollapseEnabled: e.target.checked });
              }}
            />
          </div>,
        )}
        {/* Second toggle - Allow collapse when not empty (only visible when first is enabled) */}
        {inputCollapseEnabled &&
          renderSetting(
            'allowCollapseWhenNotEmpty',
            <div className="group mt-3 ml-4 flex items-center justify-between">
              <div className="flex-1">
                <Label
                  htmlFor="input-collapse-when-not-empty"
                  className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                >
                  {t('allowCollapseWhenNotEmpty')}
                </Label>
                <p className="text-muted-foreground mt-1 text-xs">
                  {t('allowCollapseWhenNotEmptyHint')}
                </p>
              </div>
              <Switch
                id="input-collapse-when-not-empty"
                checked={inputCollapseWhenNotEmpty}
                onChange={(e) => {
                  onChange({ inputCollapseWhenNotEmpty: e.target.checked });
                }}
              />
            </div>,
          )}
        {renderSetting(
          'inputVimMode',
          <div className="group flex items-center justify-between">
            <div className="flex-1">
              <Label
                htmlFor="input-vim-mode"
                className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
              >
                {t('inputVimMode')}
              </Label>
              <p className="text-muted-foreground mt-1 text-xs">{t('inputVimModeHint')}</p>
            </div>
            <Switch
              id="input-vim-mode"
              checked={inputVimModeEnabled}
              onChange={(e) => {
                onChange({ inputVimModeEnabled: e.target.checked });
              }}
            />
          </div>,
        )}
        {renderSetting(
          'enterSend',
          <div className="group flex items-center justify-between">
            <div className="flex-1">
              <Label
                htmlFor={isAIStudio ? 'aistudio-enter-send' : 'ctrl-enter-send'}
                className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
              >
                {isAIStudio
                  ? t('aistudioEnterSend').replace('{modifier}', getModifierKey())
                  : t('ctrlEnterSend').replace('{modifier}', getModifierKey())}
              </Label>
              <p className="text-muted-foreground mt-1 text-xs">
                {(isAIStudio ? t('aistudioEnterSendHint') : t('ctrlEnterSendHint')).replace(
                  '{modifier}',
                  getModifierKey(),
                )}
              </p>
              <div className="mt-1 flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">{t('currentPlatform')}:</span>
                <span className="bg-secondary text-foreground rounded px-1.5 py-0.5 font-medium">
                  {currentPlatformLabel}
                </span>
              </div>
            </div>
            <Switch
              id={isAIStudio ? 'aistudio-enter-send' : 'ctrl-enter-send'}
              checked={isAIStudio ? aiStudioEnterSendEnabled : ctrlEnterSendEnabled}
              onChange={(e) => {
                if (isAIStudio) {
                  onChange({ aiStudioEnterSendEnabled: e.target.checked });
                } else {
                  onChange({ ctrlEnterSendEnabled: e.target.checked });
                }
              }}
            />
          </div>,
        )}
        {/* Safari Enter Fix - only shown on Safari */}
        {isSafariBrowser &&
          renderSetting(
            'safariEnterFix',
            <div className="group flex items-center justify-between">
              <div className="flex-1">
                <Label
                  htmlFor="safari-enter-fix"
                  className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                >
                  {t('safariEnterFix')}
                </Label>
                <p className="text-muted-foreground mt-1 text-xs">{t('safariEnterFixHint')}</p>
              </div>
              <Switch
                id="safari-enter-fix"
                checked={safariEnterFixEnabled}
                onChange={(e) => {
                  onChange({ safariEnterFixEnabled: e.target.checked });
                }}
              />
            </div>,
          )}
        {/* Draft Auto-Save */}
        {renderSetting(
          'draftAutoSave',
          <div className="group flex items-center justify-between">
            <div className="flex-1">
              <Label
                htmlFor="draft-auto-save"
                className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
              >
                {t('draftAutoSave')}
              </Label>
              <p className="text-muted-foreground mt-1 text-xs">{t('draftAutoSaveHint')}</p>
            </div>
            <Switch
              id="draft-auto-save"
              checked={draftAutoSaveEnabled}
              onChange={(e) => {
                onChange({ draftAutoSaveEnabled: e.target.checked });
              }}
            />
          </div>,
        )}
      </CardContent>
    </Card>
  );
}
