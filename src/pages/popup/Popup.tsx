import { type ReactNode, useMemo, useState } from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useLanguage } from '@/contexts/LanguageContext';
import { StorageKeys } from '@/core/types/common';
import {
  getVoyagerBuildTarget,
  isSafari,
  supportsExtensionNotifications,
} from '@/core/utils/browser';
import type { FormulaCopyFormat } from '@/features/formulaCopy/FormulaCopyService';

import { CloudSyncSettings } from './components/CloudSyncSettings';
import { ContextSyncSettings } from './components/ContextSyncSettings';
import { DiagnosticsExportCard } from './components/DiagnosticsExportCard';
import { FolderSettingsCard } from './components/FolderSettingsCard';
import { FormulaCopySettings } from './components/FormulaCopySettings';
import { GeneralSettingsCard } from './components/GeneralSettingsCard';
import { InputSettingsCard } from './components/InputSettingsCard';
import { KeyboardShortcutSettings } from './components/KeyboardShortcutSettings';
import { PluginSiteSettings } from './components/PluginSiteSettings';
import { PopupFooter } from './components/PopupFooter';
import { PopupHeader } from './components/PopupHeader';
import { PopupLayoutSettings } from './components/PopupLayoutSettings';
import { PopupSearchBox } from './components/PopupSearchBox';
import { PopupSection } from './components/PopupSection';
import { PopupUpdateBanner } from './components/PopupUpdateBanner';
import { PromptManagerSettingsCard } from './components/PromptManagerSettingsCard';
import { StarredHistory } from './components/StarredHistory';
import { StorageManager } from './components/StorageManager';
import { StorageQuotaCard } from './components/StorageQuotaCard';
import { TimelineSettingsCard } from './components/TimelineSettingsCard';
import { ToolbarPinHint } from './components/ToolbarPinHint';
import { VisualEffectPicker } from './components/VisualEffectPicker';
import { WatermarkSettingsCard } from './components/WatermarkSettingsCard';
import { useActivePopupTab } from './hooks/useActivePopupTab';
import { useFolderPopupSettings } from './hooks/useFolderPopupSettings';
import { useFolderStructureCopy } from './hooks/useFolderStructureCopy';
import { useFormulaCopyPopupSettings } from './hooks/useFormulaCopyPopupSettings';
import { useGeneralPopupSettings } from './hooks/useGeneralPopupSettings';
import { useInputPopupSettings } from './hooks/useInputPopupSettings';
import { usePopupBrandTheme } from './hooks/usePopupBrandTheme';
import { usePopupLayoutSettings } from './hooks/usePopupLayoutSettings';
import { usePopupPlugins } from './hooks/usePopupPlugins';
import { usePopupReleaseInfo } from './hooks/usePopupReleaseInfo';
import { usePopupScrollRestoration } from './hooks/usePopupScrollRestoration';
import {
  type PopupSectionId,
  type PopupSectionOptions,
  usePopupSections,
} from './hooks/usePopupSections';
import { usePopupSettingsHydration } from './hooks/usePopupSettingsHydration';
import { usePromptDataTransfer } from './hooks/usePromptDataTransfer';
import { usePromptManagerSettings } from './hooks/usePromptManagerSettings';
import { useTimelinePopupSettings } from './hooks/useTimelinePopupSettings';
import { useVisualEffectPopupSettings } from './hooks/useVisualEffectPopupSettings';
import { useWatermarkPopupSettings } from './hooks/useWatermarkPopupSettings';
import { writePopupSyncStorage } from './utils/popupStorage';
import { isPluginPopupSite } from './utils/siteMode';
import { canUseVisualEffects } from './utils/visualEffectsAvailability';

interface PopupProps {
  sourceTabId?: number;
}

export default function Popup({ sourceTabId }: PopupProps = {}) {
  const { t, language } = useLanguage();
  const [showStarredHistory, setShowStarredHistory] = useState(false);
  const [showStorageManager, setShowStorageManager] = useState(false);
  const [aiStudioEnabled, setAiStudioEnabled] = useState(true);
  const tab = useActivePopupTab(sourceTabId);
  const plugins = usePopupPlugins(tab);
  const isAIStudio = tab.activeAccountPlatform === 'aistudio';
  const isSafariBrowser = getVoyagerBuildTarget() === 'safari' || isSafari();
  const canUseSystemNotifications = supportsExtensionNotifications();
  const currentPlatformLabel = isAIStudio ? t('platformAIStudio') : t('platformGemini');
  const isPluginSite = isPluginPopupSite(tab.activeUrl, plugins.siteScopedManifests);
  const activeSiteDomain = useMemo(() => {
    try {
      return new URL(tab.activeUrl).host.replace(/^www\./, '').toLowerCase();
    } catch {
      return '';
    }
  }, [tab.activeUrl]);
  const theme = usePopupBrandTheme({
    activeUrl: tab.activeUrl,
    pluginManifests: plugins.pluginManifests,
    pluginSiteOverride: plugins.pluginSiteOverride,
  });
  const release = usePopupReleaseInfo(isSafariBrowser);

  // These owners remain mounted while search hides cards or an auxiliary view opens.
  const timeline = useTimelinePopupSettings(writePopupSyncStorage);
  const folder = useFolderPopupSettings({
    activeAccountPlatform: tab.activeAccountPlatform,
    writeSyncStorage: writePopupSyncStorage,
  });
  const general = useGeneralPopupSettings({
    writeSyncStorage: writePopupSyncStorage,
    isSafariBrowser,
    canUseSystemNotifications,
  });
  const input = useInputPopupSettings(writePopupSyncStorage);
  const layout = usePopupLayoutSettings({ isAIStudio, writeSyncStorage: writePopupSyncStorage });
  const promptManager = usePromptManagerSettings({
    t,
    pluginManifests: plugins.pluginManifests,
    refreshActiveTabContext: tab.refreshActiveTabContext,
    writeSyncStorage: writePopupSyncStorage,
  });
  const promptTransfer = usePromptDataTransfer(t);
  const watermark = useWatermarkPopupSettings(writePopupSyncStorage);
  const visualEffect = useVisualEffectPopupSettings(writePopupSyncStorage);
  const formulaCopy = useFormulaCopyPopupSettings();
  const folderStructureCopy = useFolderStructureCopy(language, sourceTabId);
  const visualEffectsAvailable = canUseVisualEffects({
    isPluginSite,
    activeSiteDomain,
    customWebsites: promptManager.customWebsites,
    sitePluginIds: plugins.siteScopedManifests.map((plugin) => plugin.id),
    pluginState: plugins.pluginState,
  });
  const sections = usePopupSections({
    nativePopupPlatform: tab.activeAccountPlatform,
    isPluginSite,
    visualEffectsAvailable,
    t,
    writeSyncStorage: writePopupSyncStorage,
  });
  usePopupSettingsHydration({
    timeline: timeline.hydrateFromStorage,
    folder: folder.hydrateFromStorage,
    general: general.hydrateFromStorage,
    input: input.hydrateFromStorage,
    layout: layout.hydrateFromStorage,
    promptManager: promptManager.hydrateFromStorage,
    visualEffect: visualEffect.hydrateFromStorage,
    watermark: watermark.hydrateFromStorage,
    sections: sections.hydrateFromStorage,
    formulaCopy: formulaCopy.hydrateFromStorage,
    aiStudio: setAiStudioEnabled,
  });
  usePopupScrollRestoration({
    activeTabContextLoaded: tab.activeTabContextLoaded,
    hasSettingsSearch: sections.hasSettingsSearch,
    isPluginSite,
    showStarredHistory,
    showStorageManager,
  });
  const wrapSection = (id: PopupSectionId, content: ReactNode, options?: PopupSectionOptions) => (
    <PopupSection key={id} {...sections.getSectionProps(id, options)}>
      {content}
    </PopupSection>
  );
  const handleFormulaCopyEnabledChange = (enabled: boolean) => {
    formulaCopy.setEnabledFromUser(enabled);
    void writePopupSyncStorage({ [StorageKeys.FORMULA_COPY_ENABLED]: enabled });
  };
  const handleFormulaCopyFormatChange = (format: FormulaCopyFormat) => {
    formulaCopy.setFormatFromUser(format);
    void writePopupSyncStorage({ [StorageKeys.FORMULA_COPY_FORMAT]: format });
  };
  if (showStarredHistory)
    return (
      <StarredHistory sourceTabId={sourceTabId} onClose={() => setShowStarredHistory(false)} />
    );
  if (showStorageManager)
    return (
      <div style={theme.style}>
        <StorageManager
          onClose={() => setShowStorageManager(false)}
          onManageHighlights={() => {
            setShowStorageManager(false);
            setShowStarredHistory(true);
          }}
        />
      </div>
    );
  return (
    <div className="bg-background text-foreground w-[360px]" style={theme.style}>
      <PopupHeader themePicker={theme.picker} t={t} />
      <div className="flex flex-col gap-4 p-5">
        {/* Below the search box, above the update banner (order -2, earlier in DOM). */}
        <ToolbarPinHint style={{ order: -2 }} />
        {!isPluginSite && (
          <PopupSearchBox
            query={sections.settingsSearchQuery}
            onChange={sections.updateSettingsSearchQuery}
            t={t}
          />
        )}
        {!isPluginSite && sections.hasSettingsSearch && !sections.hasVisibleSearchResults && (
          <Card style={{ order: -2.5 }} className="p-4 text-center" role="status">
            <p className="text-muted-foreground text-sm">{t('popupSettingsSearchNoResults')}</p>
          </Card>
        )}
        <PopupUpdateBanner release={release} isSafariBrowser={isSafariBrowser} t={t} />
        {!isPluginSite && (
          <div style={{ order: sections.getSectionProps('cloudSync').order + 1 }}>
            <StorageQuotaCard onManage={() => setShowStorageManager(true)} />
          </div>
        )}
        {/* AI Studio master toggle - only shown when on AI Studio */}
        {isAIStudio && (
          <Card
            style={{ order: -1 }}
            className="border-primary/20 p-4 transition-all hover:shadow-md"
          >
            <CardContent className="p-0">
              <div className="group flex items-center justify-between">
                <div className="flex-1">
                  <Label
                    htmlFor="aistudio-enabled"
                    className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                  >
                    {t('enableOnAIStudio')}
                  </Label>
                  <p className="text-muted-foreground mt-1 text-xs">{t('enableOnAIStudioHint')}</p>
                </div>
                <Switch
                  id="aistudio-enabled"
                  checked={aiStudioEnabled}
                  onChange={(e) => {
                    setAiStudioEnabled(e.target.checked);
                    void writePopupSyncStorage({
                      [StorageKeys.GV_AISTUDIO_ENABLED]: e.target.checked,
                    });
                  }}
                />
              </div>
            </CardContent>
          </Card>
        )}
        {/* Cloud Sync */}
        {wrapSection('cloudSync', <CloudSyncSettings sourceTabId={sourceTabId} />)}
        {isPluginSite && (
          <PluginSiteSettings
            siteDomain={activeSiteDomain}
            siteLabel={theme.picker.siteLabel}
            promptEnabled={promptManager.customWebsites.includes(activeSiteDomain)}
            onTogglePrompt={() => {
              void promptManager.toggleQuickWebsite(
                activeSiteDomain,
                promptManager.customWebsites.includes(activeSiteDomain),
              );
            }}
            promptDataTransfer={promptTransfer}
            plugins={{
              manifests: plugins.siteScopedManifests,
              loading: plugins.pluginsLoading,
              onRefresh: plugins.refresh,
              refreshing: plugins.pluginsRefreshing,
              activeUrl: tab.activeUrl,
              sourceIds: plugins.pluginSourceIds,
              blockedUpdates: plugins.pluginBlockedUpdates,
              catalogHost: plugins.pluginCatalogHost,
              statuses: plugins.pluginStatuses,
            }}
            t={t}
          />
        )}
        {/* Context Sync */}
        {wrapSection('contextSync', <ContextSyncSettings sourceTabId={sourceTabId} />)}
        {/* Timeline Options */}
        {wrapSection(
          'timeline',
          <TimelineSettingsCard
            values={timeline.values}
            onChange={timeline.onChange}
            onResetPosition={timeline.resetPosition}
            onViewStarredHistory={() => setShowStarredHistory(true)}
            isVisible={(settingId) => sections.shouldShowSetting('timeline', settingId)}
            t={t}
          />,
        )}
        {/* Folder Options */}
        {wrapSection(
          'folder',
          <FolderSettingsCard
            values={folder.values}
            onChange={folder.onChange}
            accountIsolation={{
              enabled: folder.accountIsolationEnabled,
              platformLabel: currentPlatformLabel,
              onChange: folder.onAccountIsolationChange,
            }}
            aiStructureCopy={folderStructureCopy}
            isVisible={(settingId) => sections.shouldShowSetting('folder', settingId)}
            t={t}
          />,
        )}
        <PopupLayoutSettings
          settings={layout}
          t={t}
          wrapSection={wrapSection}
          isSettingVisible={sections.shouldShowSetting}
        />
        {/* Platform-neutral visual effects. Third-party sites expose this only
            after Prompt Manager or a matching plugin has activated the site. */}
        {visualEffectsAvailable &&
          wrapSection(
            'visualEffect',
            <VisualEffectPicker
              value={visualEffect.value}
              onChange={visualEffect.onChange}
              t={t}
            />,
            { allowPluginSite: true },
          )}

        {/* Formula Copy Options */}
        {wrapSection(
          'formulaCopy',
          <FormulaCopySettings
            enabled={formulaCopy.enabled}
            format={formulaCopy.format}
            onEnabledChange={handleFormulaCopyEnabledChange}
            onFormatChange={handleFormulaCopyFormatChange}
            showEnabled={sections.shouldShowSetting('formulaCopy', 'formulaCopyEnabled')}
            showFormat={sections.shouldShowSetting('formulaCopy', 'formulaCopyFormat')}
            t={t}
          />,
        )}

        {/* Keyboard Shortcuts */}
        {wrapSection('keyboardShortcuts', <KeyboardShortcutSettings />)}

        {wrapSection(
          'inputCollapse',
          <InputSettingsCard
            values={input.values}
            onChange={input.onChange}
            isAIStudio={isAIStudio}
            isSafariBrowser={isSafariBrowser}
            currentPlatformLabel={currentPlatformLabel}
            isVisible={(id) => sections.shouldShowSetting('inputCollapse', id)}
            t={t}
          />,
        )}
        {wrapSection(
          'promptManager',
          <PromptManagerSettingsCard
            settings={promptManager}
            transfer={promptTransfer}
            isPluginSite={isPluginSite}
            isVisible={(id) => sections.shouldShowSetting('promptManager', id)}
            t={t}
          />,
        )}
        {/* General Options */}
        {wrapSection(
          'general',
          <GeneralSettingsCard
            values={general.values}
            onChange={general.onChange}
            isSafariBrowser={isSafariBrowser}
            remoteAnnouncementPermissionCta={{
              visible:
                general.values.remoteAnnouncementEnabled &&
                canUseSystemNotifications &&
                !general.remoteAnnouncementPermissionGranted,
              onRequest: general.requestRemoteAnnouncementSystemPermission,
            }}
            isVisible={(settingId) => sections.shouldShowSetting('general', settingId)}
            t={t}
          />,
        )}

        {wrapSection(
          'nanobanana',
          <WatermarkSettingsCard
            values={watermark.values}
            onChange={watermark.onChange}
            isVisible={(id) => sections.shouldShowSetting('nanobanana', id)}
            t={t}
          />,
        )}
      </div>

      <PopupFooter
        extVersion={release.extVersion}
        releaseUrl={release.releaseUrl}
        language={language}
        t={t}
      >
        <DiagnosticsExportCard
          activeUrl={tab.activeUrl}
          loading={plugins.pluginsLoading || !plugins.pluginStateLoaded}
          plugins={plugins.diagnosticPlugins}
        />
      </PopupFooter>
    </div>
  );
}
