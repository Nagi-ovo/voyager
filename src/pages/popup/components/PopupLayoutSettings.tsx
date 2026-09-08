import React, { useEffect, useRef, useState } from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import type { TranslationKey } from '@/utils/translations';

import type { PopupLayoutSettingsController } from '../hooks/usePopupLayoutSettings';
import {
  CHAT_FONT_SIZE,
  CHAT_LINE_HEIGHT,
  CHAT_PARAGRAPH_SPACING,
  CHAT_PERCENT,
  EDIT_PERCENT,
  FOLDER_SPACING,
  FOLDER_TREE_INDENT,
  GEMS_SIDEBAR_COUNT,
} from '../utils/layoutSettings';
import type { NativePopupSectionId } from '../utils/nativeSiteCapabilities';
import WidthSlider from './WidthSlider';

export interface PopupLayoutSettingsProps {
  settings: PopupLayoutSettingsController;
  t: (key: TranslationKey) => string;
  wrapSection: (id: NativePopupSectionId, content: React.ReactNode) => React.ReactNode;
  isSettingVisible: (sectionId: NativePopupSectionId, settingId: string) => boolean;
}

interface ParagraphSpacingControlProps {
  value: number;
  label: string;
  tightLabel: string;
  looseLabel: string;
  onChange: (value: number) => void;
  onChangeComplete: (value: number) => void;
}

function ParagraphSpacingControl({
  value,
  label,
  tightLabel,
  looseLabel,
  onChange,
  onChangeComplete,
}: ParagraphSpacingControlProps) {
  const [draftValue, setDraftValue] = useState(value);
  const isInteracting = useRef(false);

  useEffect(() => {
    if (!isInteracting.current) setDraftValue(value);
  }, [value]);

  const commit = (nextValue: number) => {
    onChange(nextValue);
    onChangeComplete(nextValue);
    isInteracting.current = false;
  };

  return (
    <div className="border-border/60 mt-4 border-t pt-3">
      <div className="mb-2 flex items-center justify-between text-xs font-medium">
        <span className="text-foreground">{label}</span>
        <span className="text-primary bg-primary/10 rounded-md px-2 py-0.5 font-bold">
          {draftValue}px
        </span>
      </div>
      <Slider
        min={CHAT_PARAGRAPH_SPACING.min}
        max={CHAT_PARAGRAPH_SPACING.max}
        step={1}
        value={draftValue}
        onValueChange={(nextValue) => {
          isInteracting.current = true;
          setDraftValue(nextValue);
        }}
        onValueCommit={commit}
        aria-label={label}
        aria-valuetext={`${draftValue}px`}
      />
      <div className="text-muted-foreground mt-3 flex items-center justify-between text-xs font-medium">
        <span>{tightLabel}</span>
        <span>{looseLabel}</span>
      </div>
    </div>
  );
}

export function PopupLayoutSettings({
  settings,
  t,
  wrapSection,
  isSettingVisible,
}: PopupLayoutSettingsProps) {
  const {
    isAIStudio,
    sidebarConfig,
    chatWidthAdjuster,
    chatFontSizeAdjuster,
    chatLineHeightAdjuster,
    chatParagraphSpacingAdjuster,
    editInputWidthAdjuster,
    sidebarWidthAdjuster,
    folderSpacingAdjuster,
    folderTreeIndentAdjuster,
    gemsSidebarCountAdjuster,
    chatWidthEnabled,
    chatFontSizeEnabled,
    chatLineHeightEnabled,
    editInputWidthEnabled,
    sidebarWidthEnabled,
    sidebarAutoHideEnabled,
    sidebarFullHideEnabled,
    onChatWidthEnabledChange,
    onChatFontSizeEnabledChange,
    onChatLineHeightEnabledChange,
    onEditInputWidthEnabledChange,
    onSidebarWidthEnabledChange,
    onSidebarAutoHideEnabledChange,
    onSidebarFullHideEnabledChange,
  } = settings;

  return (
    <>
      {/* Folder Spacing */}
      {wrapSection(
        'folderSpacing',
        <WidthSlider
          label={t('folderSpacing')}
          value={folderSpacingAdjuster.width}
          min={FOLDER_SPACING.min}
          max={FOLDER_SPACING.max}
          step={1}
          narrowLabel={t('folderSpacingCompact')}
          wideLabel={t('folderSpacingSpacious')}
          valueFormatter={(v) => `${v}px`}
          onChange={folderSpacingAdjuster.handleChange}
          onChangeComplete={folderSpacingAdjuster.handleChangeComplete}
        />,
      )}
      {wrapSection(
        'folderTreeIndent',
        <WidthSlider
          label={t('folderTreeIndent')}
          value={folderTreeIndentAdjuster.width}
          min={FOLDER_TREE_INDENT.min}
          max={FOLDER_TREE_INDENT.max}
          step={1}
          narrowLabel={t('folderTreeIndentCompact')}
          wideLabel={t('folderTreeIndentSpacious')}
          valueFormatter={(v) => `${v}px`}
          onChange={folderTreeIndentAdjuster.handleChange}
          onChangeComplete={folderTreeIndentAdjuster.handleChangeComplete}
        />,
      )}
      {wrapSection(
        'gemsSidebar',
        <WidthSlider
          label={t('gemsSidebarCount')}
          value={gemsSidebarCountAdjuster.width}
          min={GEMS_SIDEBAR_COUNT.min}
          max={GEMS_SIDEBAR_COUNT.max}
          step={1}
          narrowLabel={t('gemsSidebarCountOff')}
          wideLabel={t('gemsSidebarCountMany')}
          valueFormatter={(v) => (v === 0 ? t('gemsSidebarCountOff') : String(v))}
          onChange={gemsSidebarCountAdjuster.handleChange}
          onChangeComplete={gemsSidebarCountAdjuster.handleChangeComplete}
        />,
      )}
      {/* Chat Width */}
      {wrapSection(
        'chatWidth',
        <WidthSlider
          label={t('chatWidth')}
          value={chatWidthAdjuster.width}
          min={CHAT_PERCENT.min}
          max={CHAT_PERCENT.max}
          step={1}
          narrowLabel={t('chatWidthNarrow')}
          wideLabel={t('chatWidthWide')}
          onChange={chatWidthAdjuster.handleChange}
          onChangeComplete={chatWidthAdjuster.handleChangeComplete}
          enabled={chatWidthEnabled}
          onToggle={onChatWidthEnabledChange}
        />,
      )}
      {/* Chat Font Size */}
      {wrapSection(
        'chatFontSize',
        <WidthSlider
          label={t('chatFontSize')}
          value={chatFontSizeAdjuster.width}
          min={CHAT_FONT_SIZE.min}
          max={CHAT_FONT_SIZE.max}
          step={5}
          narrowLabel={t('chatFontSizeSmall')}
          wideLabel={t('chatFontSizeLarge')}
          onChange={chatFontSizeAdjuster.handleChange}
          onChangeComplete={chatFontSizeAdjuster.handleChangeComplete}
          enabled={chatFontSizeEnabled}
          onToggle={onChatFontSizeEnabledChange}
        />,
      )}
      {/* Chat Spacing */}
      {wrapSection(
        'chatLineHeight',
        <WidthSlider
          label={t('chatLineHeight')}
          value={chatLineHeightAdjuster.width}
          min={CHAT_LINE_HEIGHT.min}
          max={CHAT_LINE_HEIGHT.max}
          step={5}
          narrowLabel={t('chatLineHeightTight')}
          wideLabel={t('chatLineHeightLoose')}
          onChange={chatLineHeightAdjuster.handleChange}
          onChangeComplete={chatLineHeightAdjuster.handleChangeComplete}
          enabled={chatLineHeightEnabled}
          onToggle={onChatLineHeightEnabledChange}
        >
          <ParagraphSpacingControl
            value={chatParagraphSpacingAdjuster.width}
            label={t('chatParagraphSpacing')}
            tightLabel={t('chatLineHeightTight')}
            looseLabel={t('chatLineHeightLoose')}
            onChange={chatParagraphSpacingAdjuster.handleChange}
            onChangeComplete={chatParagraphSpacingAdjuster.handleChangeComplete}
          />
        </WidthSlider>,
      )}
      {/* Edit Input Width */}
      {wrapSection(
        'editInputWidth',
        <WidthSlider
          label={t('editInputWidth')}
          value={editInputWidthAdjuster.width}
          min={EDIT_PERCENT.min}
          max={EDIT_PERCENT.max}
          step={1}
          narrowLabel={t('editInputWidthNarrow')}
          wideLabel={t('editInputWidthWide')}
          onChange={editInputWidthAdjuster.handleChange}
          onChangeComplete={editInputWidthAdjuster.handleChangeComplete}
          enabled={editInputWidthEnabled}
          onToggle={onEditInputWidthEnabledChange}
        />,
      )}

      {/* Sidebar Width */}
      {wrapSection(
        'sidebarWidth',
        <WidthSlider
          label={isAIStudio ? 'AI Studio Sidebar' : t('sidebarWidth')}
          value={sidebarWidthAdjuster.width}
          min={sidebarConfig.min}
          max={sidebarConfig.max}
          step={8}
          narrowLabel={t('sidebarWidthNarrow')}
          wideLabel={t('sidebarWidthWide')}
          valueFormatter={(v) => `${v}px`}
          onChange={sidebarWidthAdjuster.handleChange}
          onChangeComplete={sidebarWidthAdjuster.handleChangeComplete}
          enabled={sidebarWidthEnabled}
          onToggle={onSidebarWidthEnabledChange}
        />,
      )}

      {wrapSection(
        'sidebarBehavior',
        <Card className="p-4 transition-all hover:shadow-md">
          <CardContent className="space-y-3 p-0">
            <div
              hidden={!isSettingVisible('sidebarBehavior', 'sidebarAutoHide')}
              className="group flex items-center justify-between"
            >
              <div className="flex-1">
                <Label
                  htmlFor="sidebar-auto-hide"
                  className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                >
                  {t('sidebarAutoHide')}
                </Label>
                <p className="text-muted-foreground mt-1 text-xs">{t('sidebarAutoHideHint')}</p>
              </div>
              <Switch
                id="sidebar-auto-hide"
                checked={sidebarAutoHideEnabled}
                onChange={(event) => onSidebarAutoHideEnabledChange(event.target.checked)}
              />
            </div>
            <div
              hidden={!isSettingVisible('sidebarBehavior', 'sidebarFullHide')}
              className="group flex items-center justify-between"
            >
              <div className="flex-1">
                <Label
                  htmlFor="sidebar-full-hide"
                  className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                >
                  {t('sidebarFullHide')}
                </Label>
                <p className="text-muted-foreground mt-1 text-xs">{t('sidebarFullHideHint')}</p>
              </div>
              <Switch
                id="sidebar-full-hide"
                checked={sidebarFullHideEnabled}
                onChange={(event) => onSidebarFullHideEnabledChange(event.target.checked)}
              />
            </div>
          </CardContent>
        </Card>,
      )}
    </>
  );
}
