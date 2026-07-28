import React, { useCallback, useEffect, useState } from 'react';

import {
  accountIsolationService,
  buildScopedStorageKey,
  detectAccountPlatformFromUrl,
  extractRouteUserIdFromUrl,
} from '@/core/services/AccountIsolationService';
import { restoreBackupableSyncSettings } from '@/core/services/SettingsBackupService';
import { StorageKeys } from '@/core/types/common';
import type { FolderData } from '@/core/types/folder';
import type {
  PluginStateExportPayload,
  PromptItem,
  SettingsExportPayload,
  SyncAccountScope,
  SyncMode,
  SyncPlatform,
  SyncProvider,
  SyncState,
} from '@/core/types/sync';
import { DEFAULT_SYNC_STATE } from '@/core/types/sync';
import { getVoyagerBuildTarget, isSafari } from '@/core/utils/browser';
import { getPromptNameConflictIds } from '@/core/utils/promptName';
import { deleteSafariICloudBackup } from '@/core/utils/safariICloudSync';
import { restorePluginState } from '@/features/plugins/storage/pluginState';
import {
  getTimelineHierarchyStorageKey,
  getTimelineHierarchyStorageKeysToRead,
  resolveTimelineHierarchyDataForStorageScope,
} from '@/pages/content/timeline/hierarchyStorage';
import type { TimelineHierarchyData } from '@/pages/content/timeline/hierarchyTypes';
import type { StarredMessagesData } from '@/pages/content/timeline/starredTypes';

import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardTitle } from '../../../components/ui/card';
import { Label } from '../../../components/ui/label';
import { Switch } from '../../../components/ui/switch';
import { useLanguage } from '../../../contexts/LanguageContext';
import {
  mergeFolderData,
  mergePromptsWithStats,
  mergeStarredMessages,
  mergeTimelineHierarchy,
} from '../../../utils/merge';

function isFolderData(value: unknown): value is FolderData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as { folders?: unknown; folderContents?: unknown };
  return (
    Array.isArray(data.folders) &&
    typeof data.folderContents === 'object' &&
    data.folderContents !== null
  );
}

function parseStoredFolderData(value: unknown): FolderData | null {
  if (isFolderData(value)) return value;
  if (typeof value !== 'string') return null;

  try {
    const parsed: unknown = JSON.parse(value);
    return isFolderData(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPromptItemArray(value: unknown): value is PromptItem[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (typeof item !== 'object' || item === null) return false;
      const prompt = item as Record<string, unknown>;
      return (
        typeof prompt.id === 'string' &&
        typeof prompt.text === 'string' &&
        Array.isArray(prompt.tags) &&
        prompt.tags.every((tag) => typeof tag === 'string') &&
        typeof prompt.createdAt === 'number'
      );
    })
  );
}

function isStarredMessagesData(value: unknown): value is StarredMessagesData {
  if (typeof value !== 'object' || value === null) return false;
  if (!('messages' in value)) return false;
  const messages = (value as { messages: unknown }).messages;
  return typeof messages === 'object' && messages !== null;
}

function isTimelineHierarchyData(value: unknown): value is TimelineHierarchyData {
  if (typeof value !== 'object' || value === null) return false;
  if (!('conversations' in value)) return false;
  const conversations = (value as { conversations: unknown }).conversations;
  return typeof conversations === 'object' && conversations !== null;
}

type DownloadMode = 'merge' | 'overwrite';

/**
 * CloudSyncSettings component for popup
 * Allows users to configure Google Drive sync settings
 */
interface CloudSyncSettingsProps {
  sourceTabId?: number;
}

const PLATFORM_LOGO_URLS: Record<SyncPlatform, string> = {
  gemini: 'https://www.gstatic.com/lamda/images/gemini_sparkle_4g_512_lt_f94943af3be039176192d.png',
  aistudio:
    'https://www.gstatic.com/images/branding/productlogos/ai_studio/v1/web-512dp/logo_ai_studio_color_1x_web_512dp.png',
};

export function CloudSyncSettings({ sourceTabId }: CloudSyncSettingsProps = {}) {
  const { t } = useLanguage();
  const supportsICloud = getVoyagerBuildTarget() === 'safari' || isSafari();

  const [syncState, setSyncState] = useState<SyncState>(DEFAULT_SYNC_STATE);
  const [statusMessage, setStatusMessage] = useState<{
    text: string;
    kind: 'ok' | 'warn' | 'err';
  } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDeletingICloudBackup, setIsDeletingICloudBackup] = useState(false);
  const [downloadMode, setDownloadMode] = useState<DownloadMode | null>(null);
  const [platform, setPlatform] = useState<SyncPlatform>('gemini');
  const [highlightSyncEnabled, setHighlightSyncEnabled] = useState(true);

  const getBaseFolderStorageKey = useCallback(
    (targetPlatform: SyncPlatform) =>
      targetPlatform === 'aistudio' ? StorageKeys.FOLDER_DATA_AISTUDIO : StorageKeys.FOLDER_DATA,
    [],
  );

  const getTargetTab = useCallback(async (): Promise<chrome.tabs.Tab | undefined> => {
    if (typeof sourceTabId === 'number') {
      try {
        return await chrome.tabs.get(sourceTabId);
      } catch {}
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }, [sourceTabId]);

  // Detect current platform from active tab URL
  const detectPlatform = useCallback(async (): Promise<SyncPlatform> => {
    try {
      const tab = await getTargetTab();
      return detectAccountPlatformFromUrl(tab?.url ?? null);
    } catch (e) {
      console.warn('[CloudSyncSettings] Failed to detect platform:', e);
    }
    return 'gemini';
  }, [getTargetTab]);

  const resolveCurrentPageSyncScope = useCallback(
    async (respectIsolationSetting: boolean): Promise<SyncAccountScope | null> => {
      if (respectIsolationSetting) {
        const isolationEnabled = await accountIsolationService.isIsolationEnabled({ platform });
        if (!isolationEnabled) {
          return null;
        }
      }

      let pageUrl = '';
      let routeUserId: string | null = null;
      let email: string | null = null;
      let pageContextAvailable = false;

      try {
        const tab = await getTargetTab();
        pageUrl = tab?.url || '';
        routeUserId = platform === 'gemini' ? extractRouteUserIdFromUrl(pageUrl) : null;

        if (tab?.id) {
          try {
            const response = (await Promise.race([
              chrome.tabs.sendMessage(tab.id, { type: 'gv.account.getContext' }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 400)),
            ])) as {
              ok?: boolean;
              context?: { routeUserId?: string | null; email?: string | null };
            };

            if (response?.ok && response.context) {
              pageContextAvailable = true;
              routeUserId = response.context.routeUserId ?? routeUserId;
              email = response.context.email ?? null;
            }
          } catch {
            // Ignore content-script lookup failure; we'll resolve with URL fallback.
          }
        }
      } catch {
        // Ignore tab query failure; account service will fallback to default scope.
      }

      if (!routeUserId && !email && !pageContextAvailable) {
        return null;
      }

      const resolvedScope = await accountIsolationService.resolveAccountScope({
        pageUrl,
        routeUserId,
        email,
      });

      return {
        accountKey: resolvedScope.accountKey,
        accountId: resolvedScope.accountId,
        routeUserId: resolvedScope.routeUserId,
      };
    },
    [getTargetTab, platform],
  );

  const resolveAccountSyncContext = useCallback(async (): Promise<{
    accountScope: SyncAccountScope | null;
    folderStorageKey: string;
  }> => {
    const baseFolderStorageKey = getBaseFolderStorageKey(platform);
    const accountScope = await resolveCurrentPageSyncScope(true);
    if (!accountScope) {
      return {
        accountScope: null,
        folderStorageKey: baseFolderStorageKey,
      };
    }

    return {
      accountScope,
      folderStorageKey: buildScopedStorageKey(baseFolderStorageKey, accountScope.accountKey),
    };
  }, [getBaseFolderStorageKey, platform, resolveCurrentPageSyncScope]);

  const resolveTimelineHierarchySyncContext = useCallback(async (): Promise<{
    accountScope: SyncAccountScope | null;
    storageKey: string;
  }> => {
    if (platform !== 'gemini') {
      return {
        accountScope: null,
        storageKey: StorageKeys.TIMELINE_HIERARCHY,
      };
    }

    const accountScope = await resolveCurrentPageSyncScope(false);
    return {
      accountScope,
      storageKey: getTimelineHierarchyStorageKey(accountScope?.accountKey),
    };
  }, [platform, resolveCurrentPageSyncScope]);

  // Fetch sync state and detect platform on mount
  useEffect(() => {
    const fetchState = async () => {
      try {
        const [response, highlightSetting] = await Promise.all([
          chrome.runtime.sendMessage({ type: 'gv.sync.getState' }),
          chrome.storage.local.get({ [StorageKeys.HIGHLIGHT_CLOUD_SYNC_ENABLED]: true }),
        ]);
        if (response?.ok && response.state) {
          setSyncState(response.state);
        }
        setHighlightSyncEnabled(
          highlightSetting[StorageKeys.HIGHLIGHT_CLOUD_SYNC_ENABLED] !== false,
        );
      } catch (error) {
        console.error('[CloudSyncSettings] Failed to get sync state:', error);
      }
    };
    const initPlatform = async () => {
      const detected = await detectPlatform();
      setPlatform(detected);
      console.log('[CloudSyncSettings] Detected platform:', detected);
    };
    fetchState();
    initPlatform();
  }, [detectPlatform]);

  // Format timestamp for display
  const formatLastSync = useCallback(
    (timestamp: number | null): string => {
      if (!timestamp) return t('neverSynced');
      const date = new Date(timestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      let timeStr: string;
      if (diffMins < 1) {
        timeStr = t('justNow');
      } else if (diffMins < 60) {
        timeStr = `${diffMins} ${t('minutesAgo')}`;
      } else if (diffHours < 24) {
        timeStr = `${diffHours} ${t('hoursAgo')}`;
      } else if (diffDays === 1) {
        timeStr = t('yesterday');
      } else {
        timeStr = date.toLocaleDateString();
      }

      return t('lastSynced').replace('{time}', timeStr);
    },
    [t],
  );

  // Format upload timestamp for display
  const formatLastUpload = useCallback(
    (timestamp: number | null): string => {
      if (!timestamp) return t('neverUploaded') || 'Never uploaded';
      const date = new Date(timestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      let timeStr: string;
      if (diffMins < 1) {
        timeStr = t('justNow');
      } else if (diffMins < 60) {
        timeStr = `${diffMins} ${t('minutesAgo')}`;
      } else if (diffHours < 24) {
        timeStr = `${diffHours} ${t('hoursAgo')}`;
      } else if (diffDays === 1) {
        timeStr = t('yesterday');
      } else {
        timeStr = date.toLocaleDateString();
      }

      return (t('lastUploaded') || 'Uploaded {time}').replace('{time}', timeStr);
    },
    [t],
  );

  // Handle mode change
  const handleModeChange = useCallback(async (mode: SyncMode) => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'gv.sync.setMode',
        payload: { mode },
      });
      if (response?.ok && response.state) {
        setSyncState(response.state);
      }
    } catch (error) {
      console.error('[CloudSyncSettings] Failed to set sync mode:', error);
    }
  }, []);

  const handleProviderChange = useCallback(async (provider: SyncProvider) => {
    setStatusMessage(null);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'gv.sync.setProvider',
        payload: { provider },
      });
      if (response?.ok && response.state) {
        setSyncState(response.state);
      }
    } catch (error) {
      console.error('[CloudSyncSettings] Failed to set sync provider:', error);
    }
  }, []);

  const handleHighlightSyncChange = useCallback(async (enabled: boolean) => {
    setHighlightSyncEnabled(enabled);
    try {
      await chrome.storage.local.set({
        [StorageKeys.HIGHLIGHT_CLOUD_SYNC_ENABLED]: enabled,
      });
    } catch (error) {
      setHighlightSyncEnabled(!enabled);
      console.error('[CloudSyncSettings] Failed to save highlight sync setting:', error);
    }
  }, []);

  // Handle sign out
  const handleSignOut = useCallback(async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'gv.sync.signOut' });
      if (response?.ok && response.state) {
        setSyncState(response.state);
      }
    } catch (error) {
      console.error('[CloudSyncSettings] Sign out failed:', error);
    }
  }, []);

  const handleDeleteICloudBackup = useCallback(async () => {
    if (!window.confirm(t('syncDeleteICloudConfirm'))) return;

    setStatusMessage(null);
    setIsDeletingICloudBackup(true);
    try {
      const deleted = await deleteSafariICloudBackup();
      setStatusMessage({
        text: t('syncDeleteICloudSuccess').replace('{count}', String(deleted)),
        kind: 'ok',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage({
        text: t('syncDeleteICloudFailed').replace('{error}', message),
        kind: 'err',
      });
    } finally {
      setIsDeletingICloudBackup(false);
    }
  }, [t]);

  // Handle sync now (upload current data)
  const handleSyncNow = useCallback(async () => {
    setStatusMessage(null);
    setIsUploading(true);

    try {
      const accountContext = await resolveAccountSyncContext();
      const timelineHierarchyContext = await resolveTimelineHierarchySyncContext();
      const highlightAccountScope =
        platform === 'gemini' && highlightSyncEnabled
          ? await resolveCurrentPageSyncScope(false)
          : null;
      let accountScope = accountContext.accountScope;
      let folderStorageKey = accountContext.folderStorageKey;
      const timelineHierarchyAccountScope = timelineHierarchyContext.accountScope;

      // Get current data - prioritizing active tab content script for folders
      let folders: FolderData = { folders: [], folderContents: {} };
      let prompts: PromptItem[] = [];

      // 1. Try to get fresh folder data from active tab
      try {
        const tab = await getTargetTab();
        if (tab?.id) {
          // Short timeout to avoid blocking
          const response = (await Promise.race([
            chrome.tabs.sendMessage(tab.id, { type: 'gv.sync.requestData' }),
            new Promise((_, reject) => setTimeout(() => reject('Timeout'), 500)),
          ])) as { ok?: boolean; data?: FolderData; accountScope?: SyncAccountScope } | null;

          if (response?.ok && response.data) {
            folders = response.data;
            console.log('[CloudSyncSettings] Got fresh folder data from content script');
            if (response.accountScope) {
              accountScope = response.accountScope;
              folderStorageKey = buildScopedStorageKey(
                getBaseFolderStorageKey(platform),
                response.accountScope.accountKey,
              );
            }
          }
        }
      } catch (e) {
        console.log('[CloudSyncSettings] Tab fetch failed/skipped:', e);
      }

      // 2. Fallback to storage
      try {
        const storageResult = await chrome.storage.local.get([
          folderStorageKey,
          StorageKeys.PROMPT_ITEMS,
        ]);
        const storedFolders = parseStoredFolderData(storageResult[folderStorageKey]);
        const storedPromptsValue = storageResult[StorageKeys.PROMPT_ITEMS];

        // Only use storage folders if we didn't get them from tab
        if ((!folders.folders || folders.folders.length === 0) && storedFolders) {
          folders = storedFolders;
          console.log(`[CloudSyncSettings] Loaded folders from ${folderStorageKey} (fallback)`);
        }

        // Prompts usually sync well to storage (only for Gemini)
        if (platform === 'gemini' && isPromptItemArray(storedPromptsValue)) {
          prompts = storedPromptsValue;
        }
      } catch (err) {
        console.error('[CloudSyncSettings] Error loading data:', err);
      }

      console.log(
        `[CloudSyncSettings] Uploading ${platform} folders:`,
        folders.folders?.length || 0,
        platform === 'gemini' ? `prompts: ${prompts.length}` : '(prompts skipped for AI Studio)',
      );

      // Upload to Google Drive with platform info
      const response = (await chrome.runtime.sendMessage({
        type: 'gv.sync.upload',
        payload: {
          folders,
          prompts,
          platform,
          accountScope,
          timelineHierarchyAccountScope,
          highlightAccountScope,
          includeHighlights: platform === 'gemini' && highlightSyncEnabled,
        },
      })) as
        | {
            ok?: boolean;
            error?: string;
            state?: SyncState;
            highlights?: { synced?: boolean; skipped?: boolean };
          }
        | undefined;

      if (response?.state) {
        setSyncState(response.state);
      }

      if (response?.ok) {
        setStatusMessage({
          text: t(response.highlights?.skipped ? 'syncSuccessHighlightsSkipped' : 'syncSuccess'),
          kind: response.highlights?.skipped ? 'warn' : 'ok',
        });
      } else {
        throw new Error(response?.error || response?.state?.error || t('syncUploadFailed'));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Sync failed';
      console.error('[CloudSyncSettings] Sync failed:', error);
      setStatusMessage({ text: t('syncError').replace('{error}', errorMessage), kind: 'err' });
    } finally {
      setIsUploading(false);
    }
  }, [
    getBaseFolderStorageKey,
    getTargetTab,
    highlightSyncEnabled,
    platform,
    resolveAccountSyncContext,
    resolveCurrentPageSyncScope,
    resolveTimelineHierarchySyncContext,
    t,
  ]);

  // Handle download from Drive (restore data) with merge as the default safe path.
  const handleDownloadFromDrive = useCallback(
    async (mode: DownloadMode = 'merge') => {
      if (mode === 'overwrite' && !window.confirm(t('syncOverwriteConfirm'))) {
        return;
      }

      setStatusMessage(null);
      setIsDownloading(true);
      setDownloadMode(mode);

      try {
        const accountContext = await resolveAccountSyncContext();
        const timelineHierarchyContext = await resolveTimelineHierarchySyncContext();
        const highlightAccountScope =
          platform === 'gemini' && highlightSyncEnabled
            ? await resolveCurrentPageSyncScope(false)
            : null;
        let accountScope = accountContext.accountScope;
        let folderStorageKey = accountContext.folderStorageKey;
        const timelineHierarchyAccountScope = timelineHierarchyContext.accountScope;
        const timelineHierarchyStorageKey = timelineHierarchyContext.storageKey;

        // Download from Google Drive (platform-specific)
        const response = (await chrome.runtime.sendMessage({
          type: 'gv.sync.download',
          payload: {
            platform,
            accountScope,
            timelineHierarchyAccountScope,
            highlightAccountScope,
            includeHighlights: platform === 'gemini' && highlightSyncEnabled,
          },
        })) as
          | {
              ok?: boolean;
              error?: string;
              state?: SyncState;
              highlights?: {
                synced?: boolean;
                skipped?: boolean;
                count?: number;
                empty?: boolean;
              };
              data?: {
                folders?: { data?: FolderData };
                prompts?: { items?: PromptItem[] };
                settings?: SettingsExportPayload;
                plugins?: PluginStateExportPayload;
                starred?: { data?: StarredMessagesData };
                timelineHierarchy?: { data?: TimelineHierarchyData };
              } | null;
            }
          | undefined;

        if (response?.state) {
          setSyncState(response.state);
        }

        if (!response?.ok) {
          throw new Error(response?.error || response?.state?.error || t('syncDownloadFailed'));
        }

        if (!response.data) {
          if (response.highlights?.synced) {
            setStatusMessage({ text: t('syncSuccess'), kind: 'ok' });
            return;
          }
          setStatusMessage({ text: t('syncNoData'), kind: 'err' });
          setIsDownloading(false);
          return;
        }

        // Get current local data for merging - prioritize Content Script
        let localFolders: FolderData = { folders: [], folderContents: {} };
        let localPrompts: PromptItem[] = [];
        let localTimelineHierarchy: TimelineHierarchyData = { conversations: {} };

        // 1. Try to get fresh folder data from active tab
        try {
          const tab = await getTargetTab();
          console.log('[CloudSyncSettings] Active tab:', tab?.id, tab?.url);
          if (tab?.id) {
            const tabResponse = (await Promise.race([
              chrome.tabs.sendMessage(tab.id, { type: 'gv.sync.requestData' }),
              new Promise((_, reject) => setTimeout(() => reject('Timeout after 2s'), 2000)),
            ])) as { ok?: boolean; data?: FolderData; accountScope?: SyncAccountScope } | null;

            console.log('[CloudSyncSettings] Tab response:', tabResponse);
            if (tabResponse?.ok && tabResponse.data) {
              localFolders = tabResponse.data;
              console.log(
                '[CloudSyncSettings] Got fresh folder data from content script:',
                'folders:',
                localFolders.folders?.length,
                'folderContents keys:',
                Object.keys(localFolders.folderContents || {}).length,
              );
              if (tabResponse.accountScope) {
                accountScope = tabResponse.accountScope;
                folderStorageKey = buildScopedStorageKey(
                  getBaseFolderStorageKey(platform),
                  tabResponse.accountScope.accountKey,
                );
              }
            }
          }
        } catch (e) {
          console.warn('[CloudSyncSettings] Tab fetch failed/skipped:', e);
        }

        // 2. Fallback to storage
        try {
          const storageResult = await chrome.storage.local.get([
            folderStorageKey,
            StorageKeys.PROMPT_ITEMS,
            ...getTimelineHierarchyStorageKeysToRead(timelineHierarchyAccountScope?.accountKey),
          ]);
          const storedFolders = parseStoredFolderData(storageResult[folderStorageKey]);
          const storedPromptsValue = storageResult[StorageKeys.PROMPT_ITEMS];

          // Only use storage folders if we didn't get them from tab
          if ((!localFolders.folders || localFolders.folders.length === 0) && storedFolders) {
            localFolders = storedFolders;
            console.log(`[CloudSyncSettings] Loaded folders from ${folderStorageKey} (fallback)`);
          }

          // Prompts only for Gemini platform
          if (platform === 'gemini' && isPromptItemArray(storedPromptsValue)) {
            localPrompts = storedPromptsValue;
          }

          if (platform === 'gemini') {
            const resolvedHierarchy = resolveTimelineHierarchyDataForStorageScope(
              storageResult as Record<string, unknown>,
              timelineHierarchyAccountScope?.accountKey,
              timelineHierarchyAccountScope?.routeUserId ?? null,
            );
            if (isTimelineHierarchyData(resolvedHierarchy)) {
              localTimelineHierarchy = resolvedHierarchy;
            }
          }
        } catch (err) {
          console.error('[CloudSyncSettings] Error loading local data for merge:', err);
        }

        // Sync payloads contain feature-specific export payloads from Google Drive files.
        const {
          folders: cloudFoldersPayload,
          prompts: cloudPromptsPayload,
          settings: cloudSettingsPayload,
          plugins: cloudPluginsPayload,
          starred: cloudStarredPayload,
          timelineHierarchy: cloudTimelineHierarchyPayload,
        } = response.data;
        const cloudFolderDataRaw = cloudFoldersPayload?.data;
        const hasCloudFolderData = isFolderData(cloudFolderDataRaw);
        const cloudFolderData = hasCloudFolderData
          ? cloudFolderDataRaw
          : { folders: [], folderContents: {} };
        const cloudPromptItems = cloudPromptsPayload?.items || [];
        const cloudStarredData: StarredMessagesData = cloudStarredPayload?.data || { messages: {} };
        const cloudTimelineHierarchyData: TimelineHierarchyData =
          cloudTimelineHierarchyPayload?.data || { conversations: {} };

        console.log('[CloudSyncSettings] === MERGE DEBUG ===');
        console.log('[CloudSyncSettings] Local folders count:', localFolders.folders?.length || 0);
        console.log(
          '[CloudSyncSettings] Local folderContents:',
          JSON.stringify(Object.keys(localFolders.folderContents || {})),
        );
        console.log(
          '[CloudSyncSettings] Cloud folders count:',
          cloudFolderData.folders?.length || 0,
        );
        console.log(
          '[CloudSyncSettings] Cloud folderContents:',
          JSON.stringify(Object.keys(cloudFolderData.folderContents || {})),
        );
        console.log(
          '[CloudSyncSettings] Cloud starred conversations:',
          Object.keys(cloudStarredData.messages || {}).length,
        );
        console.log(
          '[CloudSyncSettings] Cloud hierarchy conversations:',
          Object.keys(cloudTimelineHierarchyData.conversations || {}).length,
        );

        // Get local starred messages for merge
        let localStarred: StarredMessagesData = { messages: {} };
        try {
          const starredResult = await chrome.storage.local.get(['geminiTimelineStarredMessages']);
          if (isStarredMessagesData(starredResult.geminiTimelineStarredMessages)) {
            localStarred = starredResult.geminiTimelineStarredMessages;
          }
        } catch (err) {
          console.warn('[CloudSyncSettings] Could not get local starred messages:', err);
        }

        const shouldOverwrite = mode === 'overwrite';
        if (shouldOverwrite && !hasCloudFolderData) {
          setStatusMessage({ text: t('syncOverwriteMissingFolders'), kind: 'err' });
          setIsDownloading(false);
          return;
        }

        const nextFolders = shouldOverwrite
          ? cloudFolderData
          : mergeFolderData(localFolders, cloudFolderData);
        const promptMerge = shouldOverwrite
          ? {
              items: cloudPromptItems,
              nameConflicts: getPromptNameConflictIds(cloudPromptItems).size,
            }
          : mergePromptsWithStats(localPrompts, cloudPromptItems);
        const nextPrompts = promptMerge.items;
        const nextStarred = shouldOverwrite
          ? cloudStarredData
          : mergeStarredMessages(localStarred, cloudStarredData);
        const nextTimelineHierarchy = shouldOverwrite
          ? cloudTimelineHierarchyData
          : mergeTimelineHierarchy(localTimelineHierarchy, cloudTimelineHierarchyData);
        await restoreBackupableSyncSettings(
          cloudSettingsPayload?.data,
          undefined,
          shouldOverwrite ? 'overwrite' : 'merge',
        );
        if (cloudPluginsPayload?.format === 'gemini-voyager.plugins.v1') {
          await restorePluginState(
            cloudPluginsPayload.data,
            shouldOverwrite ? 'overwrite' : 'merge',
          );
        }

        console.log(
          '[CloudSyncSettings] Resolved folders count:',
          nextFolders.folders?.length || 0,
        );
        console.log(
          '[CloudSyncSettings] Resolved folderContents:',
          JSON.stringify(Object.keys(nextFolders.folderContents || {})),
        );
        console.log(
          '[CloudSyncSettings] Resolved starred conversations:',
          Object.keys(nextStarred.messages || {}).length,
        );
        console.log(
          '[CloudSyncSettings] Resolved hierarchy conversations:',
          Object.keys(nextTimelineHierarchy.conversations || {}).length,
        );
        console.log('[CloudSyncSettings] === END MERGE DEBUG ===');

        // Save merged data to storage (platform-specific storage key for folders)
        const storageUpdate: Record<string, unknown> = {
          [folderStorageKey]: nextFolders,
        };

        // Only save prompts and starred for Gemini platform
        if (platform === 'gemini') {
          storageUpdate[StorageKeys.PROMPT_ITEMS] = nextPrompts;
          storageUpdate.geminiTimelineStarredMessages = nextStarred;
          storageUpdate[timelineHierarchyStorageKey] = nextTimelineHierarchy;
        }

        await chrome.storage.local.set(storageUpdate);

        // Notify content script to reload folders
        try {
          const tab = await getTargetTab();
          if (tab?.id) {
            await chrome.tabs.sendMessage(tab.id, { type: 'gv.folders.reload' });
            console.log('[CloudSyncSettings] Sent reload message to content script');
          }
        } catch (err) {
          console.warn('[CloudSyncSettings] Could not notify content script:', err);
        }

        const foldersMissing = !hasCloudFolderData;
        setStatusMessage({
          text:
            promptMerge.nameConflicts > 0
              ? t('promptNameConflictsDetected').replace(
                  '{count}',
                  String(promptMerge.nameConflicts),
                )
              : t(
                  foldersMissing
                    ? 'syncSuccessFoldersMissing'
                    : response.highlights?.skipped
                      ? 'syncSuccessHighlightsSkipped'
                      : 'syncSuccess',
                ),
          kind:
            foldersMissing || response.highlights?.skipped || promptMerge.nameConflicts > 0
              ? 'warn'
              : 'ok',
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Download failed';
        console.error('[CloudSyncSettings] Download failed:', error);
        setStatusMessage({ text: t('syncError').replace('{error}', errorMessage), kind: 'err' });
      } finally {
        setIsDownloading(false);
        setDownloadMode(null);
      }
    },
    [
      getBaseFolderStorageKey,
      getTargetTab,
      highlightSyncEnabled,
      platform,
      resolveAccountSyncContext,
      resolveCurrentPageSyncScope,
      resolveTimelineHierarchySyncContext,
      t,
    ],
  );

  // Clear status message after 3 seconds
  useEffect(() => {
    if (statusMessage) {
      const timer = setTimeout(() => setStatusMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [statusMessage]);

  return (
    <Card className="p-3 transition-all hover:shadow-md">
      <CardTitle className="mb-2">{t('cloudSync')}</CardTitle>
      <CardContent className="space-y-3 p-0">
        {/* Description */}
        <p className="text-muted-foreground text-xs">
          {t(
            syncState.provider === 'icloud' ? 'cloudSyncDescriptionICloud' : 'cloudSyncDescription',
          )}
        </p>

        {supportsICloud && (
          <div className="grid grid-cols-[auto_1fr] items-center gap-3">
            <Label className="text-sm font-medium">{t('syncProvider')}</Label>
            <div className="bg-secondary/60 grid grid-cols-2 gap-1 rounded-xl p-1">
              {(['googleDrive', 'icloud'] as const).map((provider) => (
                <button
                  key={provider}
                  className={`rounded-lg px-2 py-1.5 text-xs font-bold transition-colors ${
                    syncState.provider === provider
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => void handleProviderChange(provider)}
                  aria-pressed={syncState.provider === provider}
                >
                  {provider === 'icloud' ? t('syncProviderICloud') : t('syncProviderGoogleDrive')}
                </button>
              ))}
            </div>
          </div>
        )}

        {supportsICloud && syncState.provider === 'googleDrive' && !syncState.isAuthenticated && (
          <a
            className="border-primary/25 bg-primary/5 text-primary hover:bg-primary/10 flex h-9 w-full items-center justify-center rounded-lg border text-xs font-semibold transition-colors"
            href="gemini-voyager://google-drive-auth"
          >
            {t('syncConnectGoogleDrive')}
          </a>
        )}

        {/* Sync Mode Toggle */}
        <div className="grid grid-cols-[auto_1fr] items-center gap-3">
          <Label className="text-sm font-medium">{t('syncMode')}</Label>
          <div className="bg-secondary/60 relative grid grid-cols-2 gap-1 rounded-xl p-1">
            <div
              className="bg-primary pointer-events-none absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-lg shadow-sm transition-all duration-300 ease-out"
              style={{
                left: syncState.mode === 'disabled' ? '4px' : 'calc(50% + 2px)',
              }}
            />
            <button
              className={`relative z-10 rounded-lg px-2 py-1.5 text-xs font-bold transition-all duration-200 ${
                syncState.mode === 'disabled'
                  ? 'text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => handleModeChange('disabled')}
            >
              {t('syncModeDisabled')}
            </button>
            <button
              className={`relative z-10 rounded-lg px-2 py-1.5 text-xs font-bold transition-all duration-200 ${
                syncState.mode === 'manual'
                  ? 'text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => handleModeChange('manual')}
            >
              {t('syncModeManual')}
            </button>
          </div>
        </div>

        {platform === 'gemini' && (
          <div className="highlight-cloud-sync-row border-border/70 bg-muted/30 gap-3 rounded-lg border px-3 py-2">
            <div className="min-w-0">
              <Label htmlFor="highlight-cloud-sync" className="cursor-pointer text-sm font-medium">
                {t('highlightCloudSync')}
              </Label>
              <p
                id="highlight-cloud-sync-hint"
                className="text-muted-foreground mt-0.5 text-xs leading-snug"
              >
                {t('highlightCloudSyncHint')}
              </p>
            </div>
            <div className="highlight-cloud-sync-control">
              <Switch
                id="highlight-cloud-sync"
                checked={highlightSyncEnabled}
                onChange={(event) => void handleHighlightSyncChange(event.target.checked)}
                aria-describedby="highlight-cloud-sync-hint"
              />
            </div>
          </div>
        )}

        {/* Sync Actions - Only show if not disabled */}
        {syncState.mode !== 'disabled' && (
          <>
            {/* Upload/Download Buttons */}
            <div className="grid gap-2">
              {/* Upload Button (Local → Drive) */}
              <Button
                variant="outline"
                size="sm"
                className="group hover:border-primary/50 w-full"
                onClick={handleSyncNow}
                disabled={isUploading || isDownloading}
              >
                <span className="flex items-center gap-1 text-xs transition-transform group-hover:scale-105">
                  {isUploading ? (
                    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                  ) : (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
                    </svg>
                  )}
                  {t('syncUpload')}
                </span>
              </Button>

              <div className="grid grid-cols-2 gap-2">
                {/* Sync Button (Drive → Local) */}
                <Button
                  variant="outline"
                  size="sm"
                  className="group hover:border-primary/50"
                  onClick={() => handleDownloadFromDrive('merge')}
                  disabled={isUploading || isDownloading}
                >
                  <span className="flex items-center gap-1 text-xs transition-transform group-hover:scale-105">
                    {downloadMode === 'merge' ? (
                      <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                      </svg>
                    ) : (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M1 4v6h6M23 20v-6h-6" />
                        <path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" />
                      </svg>
                    )}
                    {t('syncMerge')}
                  </span>
                </Button>

                {/* Overwrite Button (Drive → Local, destructive) */}
                <Button
                  variant="outline"
                  size="sm"
                  className="group hover:border-destructive/50"
                  onClick={() => handleDownloadFromDrive('overwrite')}
                  disabled={isUploading || isDownloading}
                >
                  <span className="flex items-center gap-1 text-xs transition-transform group-hover:scale-105">
                    {downloadMode === 'overwrite' ? (
                      <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                      </svg>
                    ) : (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M3 12h18" />
                        <path d="M12 3v18" />
                      </svg>
                    )}
                    {t('syncOverwrite')}
                  </span>
                </Button>
              </div>
            </div>

            {/* Platform context & sync times */}
            <div
              data-testid="sync-platform-summary"
              className="border-border/60 bg-muted/25 relative isolate overflow-hidden rounded-xl border px-3 py-2.5"
            >
              <div className="relative z-10 min-w-0 pe-14">
                <p className="text-foreground/75 mb-1.5 flex min-w-0 items-center gap-1.5 text-xs font-semibold">
                  <span
                    aria-hidden="true"
                    className="bg-primary/70 size-1.5 shrink-0 rounded-full"
                  />
                  <span className="sr-only">{t('currentPlatform')}: </span>
                  <span className="min-w-0 break-words">
                    {t(platform === 'aistudio' ? 'platformAIStudio' : 'platformGemini')}
                  </span>
                </p>

                <div className="text-muted-foreground grid min-w-0 gap-1 text-xs leading-snug">
                  <p className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-1.5">
                    <span aria-hidden="true" className="text-foreground/45">
                      ↑
                    </span>
                    <span className="min-w-0 break-words">
                      {formatLastUpload(
                        platform === 'aistudio'
                          ? syncState.lastUploadTimeAIStudio
                          : syncState.lastUploadTime,
                      )}
                    </span>
                  </p>
                  <p className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-1.5">
                    <span aria-hidden="true" className="text-foreground/45">
                      ↓
                    </span>
                    <span className="min-w-0 break-words">
                      {formatLastSync(
                        platform === 'aistudio'
                          ? syncState.lastSyncTimeAIStudio
                          : syncState.lastSyncTime,
                      )}
                    </span>
                  </p>
                </div>
              </div>

              <div
                aria-hidden="true"
                data-testid="sync-platform-mark"
                className="pointer-events-none absolute inset-y-0 end-0 flex w-20 items-center justify-center overflow-hidden"
              >
                <div className="bg-primary/10 absolute inset-3 rounded-full blur-xl" />
                <img
                  src={PLATFORM_LOGO_URLS[platform]}
                  alt=""
                  draggable={false}
                  className="size-16 object-contain opacity-[0.13] saturate-75 select-none dark:opacity-[0.2] dark:saturate-100"
                />
              </div>
            </div>

            {/* Sign Out Button - Only show if authenticated */}
            {syncState.provider === 'googleDrive' && syncState.isAuthenticated && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive w-full text-xs"
                onClick={handleSignOut}
              >
                {t('signOut')}
              </Button>
            )}
          </>
        )}

        {supportsICloud && syncState.provider === 'icloud' && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive w-full text-xs"
            onClick={handleDeleteICloudBackup}
            disabled={isUploading || isDownloading || isDeletingICloudBackup}
          >
            {isDeletingICloudBackup ? t('syncDeletingICloudBackup') : t('syncDeleteICloudBackup')}
          </Button>
        )}

        {/* Status Message */}
        {statusMessage && (
          <p
            className={`text-center text-xs ${
              statusMessage.kind === 'ok'
                ? 'text-green-600'
                : statusMessage.kind === 'warn'
                  ? 'text-amber-600'
                  : 'text-destructive'
            }`}
          >
            {statusMessage.text}
          </p>
        )}

        {/* Error Display */}
        {syncState.error && !statusMessage && (
          <p className="text-destructive text-center text-xs">
            {t('syncError').replace('{error}', syncState.error)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
