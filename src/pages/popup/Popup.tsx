import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Download, Search, Upload, X } from 'lucide-react';
import browser from 'webextension-polyfill';

import { CLOUD_SYNC_PATH, CLOUD_UPLOAD_PATH } from '@/core/icons/cloudSyncPaths';
import {
  type AccountPlatform,
  detectAccountPlatformFromUrl,
  getAccountIsolationStorageKey,
} from '@/core/services/AccountIsolationService';
import {
  type DiagnosticPluginInput,
  diagnosticPluginSourceFromId,
} from '@/core/services/DiagnosticsExportService';
import { StorageKeys, type TimelineStyle } from '@/core/types/common';
import type { ConversationReference, Folder } from '@/core/types/folder';
import {
  getModifierKey,
  getVoyagerBuildTarget,
  getWebStoreRatingChannel,
  isFirefox,
  isSafari,
  shouldShowSafariUpdateReminder,
  supportsExtensionNotifications,
  supportsOptionalHostPermissions,
} from '@/core/utils/browser';
import { normalizeCustomWebsite, sanitizeCustomWebsites } from '@/core/utils/customWebsites';
import {
  ensureNotificationsPermission,
  hasNotificationsPermission,
} from '@/core/utils/notificationsPermission';
import { requestSafariNativeNotificationPermission } from '@/core/utils/safariNativeNotifications';
import { shouldShowUpdateReminderForCurrentVersion } from '@/core/utils/updateReminder';
import { compareVersions } from '@/core/utils/version';
import { resolveWatermarkSettings } from '@/core/utils/watermarkSettings';
import { PromptImportExportService } from '@/features/backup/services/PromptImportExportService';
import { matchesAnyPattern } from '@/features/plugins/sites/matchPattern';
import {
  listPluginManifestsWithSources,
  refreshPluginManifestsWithSources,
} from '@/features/plugins/sources/defaultSources';
import {
  type PluginStateMap,
  loadPluginState,
  subscribePluginState,
} from '@/features/plugins/storage/pluginState';
import type { PluginManifest } from '@/features/plugins/types';
import {
  effectiveAccentForDisplay,
  resolveBrandColor,
  resolveSiteId,
} from '@/pages/content/platformTheme';
import { createPopupBrandThemeStyle } from '@/pages/popup/utils/brandTheme';
import {
  extractDmgDownloadUrl,
  extractLatestReleaseVersion,
  getCachedLatestVersion,
  getManifestUpdateUrl,
} from '@/pages/popup/utils/latestVersion';
import { isPluginPopupSite } from '@/pages/popup/utils/siteMode';
import { canUseVisualEffects } from '@/pages/popup/utils/visualEffectsAvailability';
import type { TranslationKey } from '@/utils/translations';

import { DarkModeToggle } from '../../components/DarkModeToggle';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardTitle } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import { Slider } from '../../components/ui/slider';
import { Switch } from '../../components/ui/switch';
import { useLanguage } from '../../contexts/LanguageContext';
import { useWidthAdjuster } from '../../hooks/useWidthAdjuster';
import { CloudSyncSettings } from './components/CloudSyncSettings';
import { ContextSyncSettings } from './components/ContextSyncSettings';
import { DiagnosticsExportCard } from './components/DiagnosticsExportCard';
import { KeyboardShortcutSettings } from './components/KeyboardShortcutSettings';
import { PluginManager } from './components/PluginManager';
import { StarredHistory } from './components/StarredHistory';
import { StorageManager } from './components/StorageManager';
import { StorageQuotaCard } from './components/StorageQuotaCard';
import { ThemeColorButton } from './components/ThemeColorButton';
import {
  IconChatGPT,
  IconClaude,
  IconDeepSeek,
  IconKimi,
  IconMidjourney,
  IconNotebookLM,
  IconQwen,
} from './components/WebsiteLogos';
import WidthSlider from './components/WidthSlider';
import { usePopupScrollRestoration } from './hooks/usePopupScrollRestoration';
import { type SettingsSearchItem, getSettingsSearchMatches } from './utils/settingsSearch';

/**
 * Inline Material Symbols glyph, so the prompt cloud-sync buttons match the
 * injected Gemini folder panel exactly (which also inlines these SVG paths)
 * rather than the thin lucide outline used elsewhere in the popup.
 */
function MaterialGlyphIcon({ path, className }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true" className={className}>
      <path d={path} />
    </svg>
  );
}

type ScrollMode = 'jump' | 'flow';

/**
 * Reorderable popup section IDs — order here is the default display order.
 */
const POPUP_SECTION_IDS = [
  'cloudSync',
  'contextSync',
  'timeline',
  'folder',
  'folderSpacing',
  'folderTreeIndent',
  'gemsSidebar',
  'chatWidth',
  'chatFontSize',
  'chatLineHeight',
  'editInputWidth',
  'sidebarWidth',
  'sidebarBehavior',
  'visualEffect',
  'formulaCopy',
  'keyboardShortcuts',
  'inputCollapse',
  'promptManager',
  'plugins',
  'general',
  'nanobanana',
] as const;

type PopupSectionId = (typeof POPUP_SECTION_IDS)[number];

const DEFAULT_SECTION_ORDER: readonly PopupSectionId[] = POPUP_SECTION_IDS;
const VALUE_BADGE_SECTION_IDS = new Set<PopupSectionId>([
  'folderSpacing',
  'folderTreeIndent',
  'gemsSidebar',
  'chatWidth',
  'chatFontSize',
  'chatLineHeight',
  'editInputWidth',
  'sidebarWidth',
]);

type PopupSettingsSearchTargetId = `${PopupSectionId}:${string}`;

interface PopupSettingsSearchItem extends SettingsSearchItem<PopupSettingsSearchTargetId> {
  sectionId: PopupSectionId;
  settingId: string;
}

const SECTION_SEARCH_SETTING_ID = '__section';

function popupSearchTarget(
  sectionId: PopupSectionId,
  settingId: string,
  keys: readonly TranslationKey[],
  aliases?: readonly string[],
): PopupSettingsSearchItem {
  return {
    id: `${sectionId}:${settingId}` as PopupSettingsSearchTargetId,
    sectionId,
    settingId,
    keys,
    aliases,
  };
}

function popupSectionSearchTarget(
  sectionId: PopupSectionId,
  keys: readonly TranslationKey[],
  aliases?: readonly string[],
): PopupSettingsSearchItem {
  return popupSearchTarget(sectionId, SECTION_SEARCH_SETTING_ID, keys, aliases);
}

function isEmptyPromptImportPayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (!value || typeof value !== 'object') return false;
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) && items.length === 0;
}

const POPUP_SETTINGS_SEARCH_ITEMS = [
  popupSectionSearchTarget('cloudSync', ['cloudSync']),
  popupSearchTarget(
    'cloudSync',
    'controls',
    [
      'cloudSyncDescription',
      'syncUpload',
      'syncMerge',
      'syncOverwrite',
      'syncMode',
      'signInWithGoogle',
      'signOut',
      'lastSynced',
      'lastUploaded',
      'syncSuccess',
      'syncError',
    ],
    ['backup restore drive google cloud save 云端 云同步 备份 恢复'],
  ),
  popupSectionSearchTarget('contextSync', ['contextSync']),
  popupSearchTarget(
    'contextSync',
    'controls',
    [
      'contextSyncDescription',
      'syncToIDE',
      'syncServerPort',
      'ideOnline',
      'ideOffline',
      'capturing',
      'syncedSuccess',
      'syncMode',
    ],
    ['ide vscode cursor local server code context 上下文 代码 编辑器 本地'],
  ),
  popupSectionSearchTarget('timeline', ['timelineOptions']),
  popupSearchTarget('timeline', 'timelineStyle', [
    'timelineStyle',
    'timelineStyleDots',
    'timelineStyleCompact',
  ]),
  popupSearchTarget('timeline', 'scrollMode', ['scrollMode', 'flow', 'jump']),
  popupSearchTarget('timeline', 'hideOuterContainer', ['hideOuterContainer']),
  popupSearchTarget('timeline', 'draggableTimeline', ['draggableTimeline']),
  popupSearchTarget('timeline', 'pinTimelinePreview', [
    'pinTimelinePreview',
    'pinTimelinePreviewHint',
  ]),
  popupSearchTarget('timeline', 'preventAutoScroll', [
    'preventAutoScroll',
    'preventAutoScrollHint',
  ]),
  popupSearchTarget('timeline', 'enableMarkerLevel', [
    'enableMarkerLevel',
    'enableMarkerLevelHint',
  ]),
  popupSearchTarget('timeline', 'showMessageTimestamps', [
    'showMessageTimestamps',
    'showMessageTimestampsHint',
  ]),
  popupSearchTarget('timeline', 'resetTimelinePosition', ['resetTimelinePosition']),
  popupSearchTarget(
    'timeline',
    'viewStarredHistory',
    ['viewStarredHistory'],
    ['bookmark star history 收藏 历史'],
  ),
  popupSectionSearchTarget('folder', ['folderOptions']),
  popupSearchTarget('folder', 'enableFolderFeature', ['enableFolderFeature']),
  popupSearchTarget('folder', 'enableFolderFloatingMode', [
    'enableFolderFloatingMode',
    'enableFolderFloatingModeHint',
  ]),
  popupSearchTarget('folder', 'openFloatingFolderOnStartup', [
    'openFloatingFolderOnStartup',
    'openFloatingFolderOnStartupHint',
  ]),
  popupSearchTarget('folder', 'hideArchivedConversations', ['hideArchivedConversations']),
  popupSearchTarget('folder', 'showFolderSearch', ['showFolderSearch'], ['search 查找 搜索']),
  popupSearchTarget('folder', 'enableForkFeature', ['enableForkFeature', 'enableForkFeatureHint']),
  popupSearchTarget('folder', 'enableAccountIsolation', [
    'enableAccountIsolation',
    'enableAccountIsolationHint',
  ]),
  popupSearchTarget('folder', 'folderAsProject', [
    'folderAsProject_enable',
    'folderAsProject_description',
  ]),
  popupSearchTarget('folder', 'aiOrgCopy', ['aiOrgCopyButton', 'aiOrgCopyHint']),
  popupSectionSearchTarget('folderSpacing', ['folderSpacing']),
  popupSearchTarget(
    'folderSpacing',
    'controls',
    ['folderSpacing', 'folderSpacingCompact', 'folderSpacingSpacious'],
    ['folder gap density padding margin 间距 密度 紧凑 宽松'],
  ),
  popupSectionSearchTarget('folderTreeIndent', ['folderTreeIndent']),
  popupSearchTarget(
    'folderTreeIndent',
    'controls',
    ['folderTreeIndent', 'folderTreeIndentCompact', 'folderTreeIndentSpacious'],
    ['folder nesting tree indent hierarchy 层级 缩进 树'],
  ),
  popupSectionSearchTarget('gemsSidebar', ['gemsSidebarCount']),
  popupSearchTarget(
    'gemsSidebar',
    'controls',
    ['gemsSidebarCount', 'gemsSidebarCountOff', 'gemsSidebarCountMany'],
    ['gems notebook recent side nav gem 宝石 侧边栏 最近'],
  ),
  popupSectionSearchTarget('chatWidth', ['chatWidth']),
  popupSearchTarget(
    'chatWidth',
    'controls',
    ['chatWidth', 'chatWidthNarrow', 'chatWidthWide'],
    ['conversation width message width content width 宽 窄 对话宽度'],
  ),
  popupSectionSearchTarget('chatFontSize', ['chatFontSize']),
  popupSearchTarget(
    'chatFontSize',
    'controls',
    ['chatFontSize', 'chatFontSizeSmall', 'chatFontSizeLarge'],
    ['font text size typography zoom 字号 字体 大小'],
  ),
  popupSectionSearchTarget('chatLineHeight', ['chatLineHeight']),
  popupSearchTarget(
    'chatLineHeight',
    'controls',
    ['chatLineHeight', 'chatLineHeightTight', 'chatLineHeightLoose', 'chatParagraphSpacing'],
    ['line spacing paragraph leading readability 行高 段落 间距'],
  ),
  popupSectionSearchTarget('editInputWidth', ['editInputWidth']),
  popupSearchTarget(
    'editInputWidth',
    'controls',
    ['editInputWidth', 'editInputWidthNarrow', 'editInputWidthWide'],
    ['prompt input compose editor width 输入框 编辑框 宽度'],
  ),
  popupSectionSearchTarget('sidebarWidth', ['sidebarWidth']),
  popupSearchTarget(
    'sidebarWidth',
    'controls',
    ['sidebarWidth', 'sidebarWidthNarrow', 'sidebarWidthWide'],
    ['side panel nav rail left width 侧边栏 宽度'],
  ),
  popupSectionSearchTarget('sidebarBehavior', ['sidebarAutoHide']),
  popupSearchTarget('sidebarBehavior', 'sidebarAutoHide', [
    'sidebarAutoHide',
    'sidebarAutoHideHint',
  ]),
  popupSearchTarget('sidebarBehavior', 'sidebarFullHide', [
    'sidebarFullHide',
    'sidebarFullHideHint',
  ]),
  popupSectionSearchTarget('visualEffect', ['visualEffect']),
  popupSearchTarget(
    'visualEffect',
    'controls',
    [
      'visualEffect',
      'visualEffectHint',
      'visualEffectOff',
      'visualEffectSnow',
      'visualEffectSakura',
      'visualEffectRain',
    ],
    ['animation background sakura rain effects off snow 动效 背景 樱花 下雨 下雪 关闭'],
  ),
  popupSectionSearchTarget('formulaCopy', ['formulaCopyFormat']),
  popupSearchTarget(
    'formulaCopy',
    'controls',
    [
      'formulaCopyFormat',
      'formulaCopyFormatHint',
      'formulaCopyFormatLatex',
      'formulaCopyFormatUnicodeMath',
      'formulaCopyFormatNoDollar',
      'formulaCopyFormatNotion',
    ],
    ['math equation latex unicode notion copy formula 数学 公式 复制'],
  ),
  popupSectionSearchTarget('keyboardShortcuts', ['keyboardShortcuts']),
  popupSearchTarget(
    'keyboardShortcuts',
    'controls',
    ['enableShortcuts', 'previousNode', 'nextNode', 'firstNode', 'lastNode', 'resetShortcuts'],
    ['hotkey keybinding vim navigation keyboard 快捷键 键盘 热键'],
  ),
  popupSectionSearchTarget('inputCollapse', ['inputCollapseOptions']),
  popupSearchTarget('inputCollapse', 'enableInputCollapse', [
    'enableInputCollapse',
    'enableInputCollapseHint',
    'inputCollapseShortcutHint',
  ]),
  popupSearchTarget('inputCollapse', 'allowCollapseWhenNotEmpty', [
    'allowCollapseWhenNotEmpty',
    'allowCollapseWhenNotEmptyHint',
  ]),
  popupSearchTarget('inputCollapse', 'inputVimMode', ['inputVimMode', 'inputVimModeHint']),
  popupSearchTarget(
    'inputCollapse',
    'enterSend',
    ['ctrlEnterSend', 'ctrlEnterSendHint', 'aistudioEnterSend', 'aistudioEnterSendHint'],
    ['send enter return 发送 回车'],
  ),
  popupSearchTarget('inputCollapse', 'safariEnterFix', ['safariEnterFix', 'safariEnterFixHint']),
  popupSearchTarget('inputCollapse', 'draftAutoSave', ['draftAutoSave', 'draftAutoSaveHint']),
  popupSectionSearchTarget('promptManager', ['promptManagerOptions']),
  popupSearchTarget('promptManager', 'hidePromptManager', [
    'hidePromptManager',
    'hidePromptManagerHint',
  ]),
  popupSearchTarget(
    'promptManager',
    'slashPromptEnabled',
    ['slashPromptEnabled', 'slashPromptEnabledHint'],
    ['slash autocomplete quick insert 斜杠 快速插入'],
  ),
  popupSearchTarget('promptManager', 'promptInsertOnClick', [
    'promptInsertOnClick',
    'promptInsertOnClickHint',
  ]),
  popupSearchTarget(
    'promptManager',
    'promptDataMigration',
    ['promptDataMigration', 'promptDataMigrationHint', 'pm_import', 'pm_export'],
    ['prompt import export backup migrate 提示词 导入 导出 迁移 备份'],
  ),
  popupSearchTarget(
    'promptManager',
    'customWebsites',
    [
      'customWebsites',
      'customWebsitesPlaceholder',
      'geminiOnlyNotice',
      'addWebsite',
      'removeWebsite',
    ],
    ['prompt library vault snippets templates websites 提示词 指令 宝库 网站 模板'],
  ),
  popupSectionSearchTarget('plugins', ['pluginsTitle']),
  popupSearchTarget(
    'plugins',
    'controls',
    ['pluginsDescription', 'pluginsEmpty', 'pluginsRefresh', 'pluginViewSource'],
    ['extension plugin marketplace add-on 插件 市场 扩展'],
  ),
  popupSectionSearchTarget('general', ['generalOptions']),
  popupSearchTarget('general', 'enableTabTitleUpdate', [
    'enableTabTitleUpdate',
    'enableTabTitleUpdateHint',
  ]),
  popupSearchTarget('general', 'persistentExportToolbar', [
    'persistentExportToolbar',
    'persistentExportToolbarHint',
  ]),
  popupSearchTarget('general', 'enableMermaidRendering', [
    'enableMermaidRendering',
    'enableMermaidRenderingHint',
  ]),
  popupSearchTarget('general', 'enableQuoteReply', ['enableQuoteReply', 'enableQuoteReplyHint']),
  popupSearchTarget('general', 'enableHighlights', ['enableHighlights', 'enableHighlightsHint']),
  popupSearchTarget('general', 'showHighlightTimelineMarkers', [
    'showHighlightTimelineMarkers',
    'showHighlightTimelineMarkersHint',
  ]),
  popupSearchTarget(
    'general',
    'responseCompleteNotification',
    [
      'responseCompleteNotification',
      'responseCompleteNotificationHint',
      'responseCompleteNotificationHintSafari',
    ],
    ['notification alert reminder notice 通知 提醒 推送'],
  ),
  popupSearchTarget('general', 'remoteAnnouncementNotification', [
    'remoteAnnouncementNotification',
    'remoteAnnouncementNotificationHint',
    'remoteAnnouncementSystemPermissionCta',
  ]),
  popupSearchTarget(
    'general',
    'changelogBadgeMode',
    ['changelog_badge_mode', 'changelog_badge_mode_hint', 'changelog_title'],
    ['update release changelog new badge 更新 版本 更新日志 提醒'],
  ),
  popupSearchTarget(
    'general',
    'usageStatusToggle',
    ['usageStatusToggle', 'usageStatusToggleHint'],
    ['usage quota limit 用量 限额'],
  ),
  popupSearchTarget(
    'general',
    'hideInputHalo',
    ['hideInputHalo', 'hideInputHaloHint'],
    ['halo ripple 光晕 水波纹'],
  ),
  popupSearchTarget('general', 'enableDefaultModelAutoApply', [
    'enableDefaultModelAutoApply',
    'enableDefaultModelAutoApplyHint',
  ]),
  popupSectionSearchTarget('nanobanana', ['nanobananaOptions']),
  popupSearchTarget(
    'nanobanana',
    'download',
    ['nanobananaDownloadLabel', 'nanobananaDownloadHint', 'nanobananaBadgeRecommended'],
    ['watermark image banana picture photo download 水印 图片 去水印 下载'],
  ),
  popupSearchTarget(
    'nanobanana',
    'preview',
    ['nanobananaPreviewLabel', 'nanobananaPreviewHint', 'nanobananaBadgeUnstable'],
    ['watermark image banana picture photo preview 水印 图片 预览'],
  ),
] as const satisfies readonly PopupSettingsSearchItem[];

const ROOT_CONVERSATIONS_ID = '__root_conversations__';

/**
 * Build a folder path string like "Parent / Child / Grandchild"
 */
function buildFolderPath(folderId: string, foldersById: Map<string, Folder>): string {
  const parts: string[] = [];
  let current = foldersById.get(folderId);
  while (current) {
    parts.unshift(current.name);
    current = current.parentId ? foldersById.get(current.parentId) : undefined;
  }
  return parts.join(' / ');
}

/**
 * Map language code to a human-readable language name for prompt instructions
 */
function getLanguageName(lang: string): string {
  const map: Record<string, string> = {
    en: 'English',
    zh: '中文',
    zh_TW: '繁體中文',
    ja: '日本語',
    ko: '한국어',
    ar: 'العربية',
    es: 'Español',
    fr: 'Français',
    pt: 'Português',
    ru: 'Русский',
  };
  return map[lang] || 'English';
}

/**
 * Format all conversations and folder structure as a prompt for AI organization.
 *
 * Key design: the output JSON should only contain INCREMENTAL changes —
 * new folders + new conversation-to-folder assignments for currently unfiled
 * conversations. Existing folders/conversations must NOT be re-emitted, so
 * a "Merge" import won't touch the user's carefully curated structure.
 */
function formatFolderStructurePrompt(
  sidebarConversations: Array<{ id: string; title: string; url: string }>,
  folderData: { folders: Folder[]; folderContents: Record<string, ConversationReference[]> },
  language: string,
): string {
  const lines: string[] = [];
  const langName = getLanguageName(language);

  // Build folder lookup
  const foldersById = new Map<string, Folder>();
  for (const folder of folderData.folders) {
    foldersById.set(folder.id, folder);
  }

  // Collect IDs of conversations already in folders
  const organizedIds = new Set<string>();
  for (const [folderId, convs] of Object.entries(folderData.folderContents)) {
    if (folderId === ROOT_CONVERSATIONS_ID) continue;
    for (const conv of convs) {
      organizedIds.add(conv.conversationId);
    }
  }

  // Section 1: Existing folder names (reference only, no conversations listed)
  const sortedFolders = [...folderData.folders].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return (a.sortIndex ?? 0) - (b.sortIndex ?? 0);
  });

  if (sortedFolders.length > 0) {
    lines.push('## Existing Folders (DO NOT re-create or modify)');
    lines.push('');
    for (const folder of sortedFolders) {
      const path = buildFolderPath(folder.id, foldersById);
      const convCount = (folderData.folderContents[folder.id] || []).length;
      lines.push(`- ${path}  (id: ${folder.id}, ${convCount} conversations)`);
    }
    lines.push('');
  }

  // Section 2: Unfiled conversations — these are the ones to organize
  const unfiledConvs = sidebarConversations.filter((c) => !organizedIds.has(c.id));
  if (unfiledConvs.length > 0) {
    lines.push('## Unfiled Conversations (to be organized)');
    lines.push('');
    for (const conv of unfiledConvs) {
      lines.push(`- [${conv.id}] ${conv.title} | ${conv.url}`);
    }
    lines.push('');
  }

  // Section 3: Instructions
  lines.push('## Instructions');
  lines.push('');
  lines.push(`Please respond in **${langName}** (folder names, explanations, etc.).`);
  lines.push('');
  lines.push('Organize the **unfiled conversations** above into folders. Rules:');
  lines.push('');
  lines.push(
    '1. **Do NOT re-output existing folders or their conversations.** The result will be merged (not replaced), so anything you output will be added on top of the current structure.',
  );
  lines.push(
    "2. You MAY place an unfiled conversation into an **existing folder** — just reference that folder's id in `folderContents`.",
  );
  lines.push(
    '3. You MAY create **new folders** as needed. Use a short random hex string (8 chars) as the folder id. Name them in ' +
      langName +
      '.',
  );
  lines.push(
    "4. New folders can be nested under existing folders by setting `parentId` to the existing folder's id.",
  );
  lines.push(
    '5. Each conversation must keep its original `conversationId` and `url` exactly as shown above.',
  );
  lines.push(
    '6. Only output the **incremental** JSON — new folders + new conversation assignments.',
  );
  lines.push('');
  lines.push('Output format (paste-ready for Gemini Voyager import):');
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "format": "gemini-voyager.folders.v1",');
  lines.push(`  "exportedAt": "${new Date().toISOString()}",`);
  lines.push('  "version": "1.3.3",');
  lines.push('  "data": {');
  lines.push('    "folders": [');
  lines.push('      // ONLY new folders here (omit existing ones)');
  lines.push('      {');
  lines.push('        "id": "<8-char-hex>",');
  lines.push(`        "name": "<folder name in ${langName}>",`);
  lines.push('        "parentId": null,');
  lines.push('        "isExpanded": true,');
  lines.push('        "createdAt": <unix-ms>,');
  lines.push('        "updatedAt": <unix-ms>');
  lines.push('      }');
  lines.push('    ],');
  lines.push('    "folderContents": {');
  lines.push('      // Can reference EXISTING folder ids or NEW folder ids');
  lines.push('      "<folder-id>": [');
  lines.push('        {');
  lines.push('          "conversationId": "<id from unfiled list>",');
  lines.push('          "title": "<title>",');
  lines.push('          "url": "<url>",');
  lines.push('          "addedAt": <unix-ms>');
  lines.push('        }');
  lines.push('      ]');
  lines.push('    }');
  lines.push('  }');
  lines.push('}');
  lines.push('```');

  return lines.join('\n');
}

const LEGACY_BASELINE_PX = 1200; // used to migrate old px widths to %
const pxFromPercent = (percent: number) => (percent / 100) * LEGACY_BASELINE_PX;

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const clampPercent = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const normalizePercent = (
  value: number,
  fallback: number,
  min: number,
  max: number,
  legacyBaselinePx: number,
) => {
  if (!Number.isFinite(value)) return fallback;
  if (value > max) {
    const approx = (value / legacyBaselinePx) * 100;
    return clampPercent(approx, min, max);
  }
  return clampPercent(value, min, max);
};

const FOLDER_SPACING = { min: 0, max: 16, defaultValue: 2 };
const FOLDER_TREE_INDENT = { min: -8, max: 32, defaultValue: -8 };
// Gems sidebar count: 0 disables the section entirely (no UI), 1-10 shows
// that many recent gems above Notebooks.
const GEMS_SIDEBAR_COUNT = { min: 0, max: 10, defaultValue: 3 };
const CHAT_PERCENT = { min: 30, max: 100, defaultValue: 70, legacyBaselinePx: LEGACY_BASELINE_PX };
const CHAT_FONT_SIZE = { min: 80, max: 150, defaultValue: 100 };
const CHAT_LINE_HEIGHT = { min: 120, max: 220, defaultValue: 160 };
const CHAT_PARAGRAPH_SPACING = { min: 0, max: 24, defaultValue: 12 };
const EDIT_PERCENT = { min: 30, max: 100, defaultValue: 60, legacyBaselinePx: LEGACY_BASELINE_PX };
const SIDEBAR_PERCENT = {
  min: 15,
  max: 45,
  defaultValue: 26,
  legacyBaselinePx: LEGACY_BASELINE_PX,
};
const SIDEBAR_PX = {
  min: Math.round(pxFromPercent(SIDEBAR_PERCENT.min)),
  max: Math.round(pxFromPercent(SIDEBAR_PERCENT.max)),
  defaultValue: Math.round(pxFromPercent(SIDEBAR_PERCENT.defaultValue)),
};
const AI_STUDIO_SIDEBAR_PX = {
  min: 240,
  max: 600,
  defaultValue: 280,
};

const clampSidebarPx = (value: number) => clampNumber(value, SIDEBAR_PX.min, SIDEBAR_PX.max);
const normalizeSidebarPx = (value: number) => {
  if (!Number.isFinite(value)) return SIDEBAR_PX.defaultValue;
  // If the stored value looks like a legacy percent, convert to px first.
  if (value <= SIDEBAR_PERCENT.max) {
    const px = pxFromPercent(value);
    return clampSidebarPx(px);
  }
  return clampSidebarPx(value);
};

const LATEST_VERSION_CACHE_KEY = 'gvLatestVersionCache';
const LATEST_VERSION_MAX_AGE = 1000 * 60 * 60 * 6; // 6 hours
const SAFARI_DMG_RETRY_AGE = 1000 * 60 * 30; // 30 min — re-check for DMG if missing

const normalizeVersionString = (version?: string | null): string | null => {
  if (!version) return null;
  const trimmed = version.trim();
  return trimmed ? trimmed.replace(/^v/i, '') : null;
};

const toReleaseTag = (version?: string | null): string | null => {
  if (!version) return null;
  const trimmed = version.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
};

interface SettingsUpdate {
  mode?: ScrollMode | null;
  timelineStyle?: TimelineStyle;
  hideContainer?: boolean;
  draggableTimeline?: boolean;
  timelinePreviewPinned?: boolean;
  markerLevelEnabled?: boolean;
  resetPosition?: boolean;
  folderEnabled?: boolean;
  floatingModeEnabled?: boolean;
  floatingOpenOnStart?: boolean;
  hideArchivedConversations?: boolean;
  folderSearchEnabled?: boolean;
  customWebsites?: string[];
  watermarkDownloadEnabled?: boolean;
  watermarkPreviewEnabled?: boolean;
  hidePromptManager?: boolean;
  slashPromptEnabled?: boolean;
  promptInsertOnClickEnabled?: boolean;
  inputCollapseEnabled?: boolean;
  inputCollapseWhenNotEmpty?: boolean;
  inputVimModeEnabled?: boolean;
  mermaidEnabled?: boolean;
  quoteReplyEnabled?: boolean;
  highlightEnabled?: boolean;
  highlightTimelineMarkersEnabled?: boolean;
  responseCompleteNotificationEnabled?: boolean;
  remoteAnnouncementEnabled?: boolean;
  usageStatusEnabled?: boolean;
  defaultModelAutoApplyEnabled?: boolean;
  ctrlEnterSendEnabled?: boolean;
  aiStudioEnterSendEnabled?: boolean;
  safariEnterFixEnabled?: boolean;
  draftAutoSaveEnabled?: boolean;
  sidebarAutoHideEnabled?: boolean;
  sidebarFullHideEnabled?: boolean;
  visualEffect?: 'off' | 'snow' | 'sakura' | 'rain';
  preventAutoScrollEnabled?: boolean;
  inputHaloHidden?: boolean;
  forkEnabled?: boolean;
  accountIsolationEnabled?: boolean;
  accountIsolationPlatform?: AccountPlatform;
  aiStudioEnabled?: boolean;
  showMessageTimestamps?: boolean;
  folderProjectEnabled?: boolean;
  persistentExportToolbarEnabled?: boolean;
}

interface PopupProps {
  sourceTabId?: number;
}

function SectionReorderControls({
  isFirst,
  isLast,
  hasValueBadge,
  onMoveUp,
  onMoveDown,
  moveUpLabel,
  moveDownLabel,
}: {
  isFirst: boolean;
  isLast: boolean;
  hasValueBadge: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  moveUpLabel: string;
  moveDownLabel: string;
}) {
  const positionClass = hasValueBadge ? 'top-px' : 'top-1';
  const buttonClass = hasValueBadge
    ? 'text-muted-foreground hover:text-foreground hover:bg-secondary/80 flex h-4 w-4 items-center justify-center rounded-sm transition-colors disabled:cursor-not-allowed disabled:opacity-30'
    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/80 rounded-sm p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-30';
  const iconSize = hasValueBadge ? 12 : 14;

  return (
    <div
      className={`absolute ${positionClass} right-1 z-10 flex gap-px rounded-md opacity-0 transition-opacity group-hover/reorder:opacity-100`}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onMoveUp();
        }}
        disabled={isFirst}
        className={buttonClass}
        aria-label={moveUpLabel}
        title={moveUpLabel}
      >
        <svg
          width={iconSize}
          height={iconSize}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onMoveDown();
        }}
        disabled={isLast}
        className={buttonClass}
        aria-label={moveDownLabel}
        title={moveDownLabel}
      >
        <svg
          width={iconSize}
          height={iconSize}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
    </div>
  );
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

export default function Popup({ sourceTabId }: PopupProps = {}) {
  const { t, language } = useLanguage();
  const [mode, setMode] = useState<ScrollMode>('flow');
  const [timelineStyle, setTimelineStyle] = useState<TimelineStyle>('dots');
  const [hideContainer, setHideContainer] = useState<boolean>(false);
  const [draggableTimeline, setDraggableTimeline] = useState<boolean>(false);
  const [timelinePreviewPinned, setTimelinePreviewPinned] = useState<boolean>(false);
  const [markerLevelEnabled, setMarkerLevelEnabled] = useState<boolean>(false);
  const [folderEnabled, setFolderEnabled] = useState<boolean>(true);
  const [floatingModeEnabled, setFloatingModeEnabled] = useState<boolean>(false);
  const [floatingOpenOnStart, setFloatingOpenOnStart] = useState<boolean>(true);
  const [hideArchivedConversations, setHideArchivedConversations] = useState<boolean>(false);
  const [folderSearchEnabled, setFolderSearchEnabled] = useState<boolean>(true);
  const [customWebsites, setCustomWebsites] = useState<string[]>([]);
  const [newWebsiteInput, setNewWebsiteInput] = useState<string>('');
  const [websiteError, setWebsiteError] = useState<string>('');
  const [showStarredHistory, setShowStarredHistory] = useState<boolean>(false);
  const [showStorageManager, setShowStorageManager] = useState<boolean>(false);
  const [formulaCopyFormat, setFormulaCopyFormat] = useState<
    'latex' | 'unicodemath' | 'no-dollar' | 'notion'
  >('latex');
  const [extVersion, setExtVersion] = useState<string | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [safariDmgUrl, setSafariDmgUrl] = useState<string | null>(null);
  const [watermarkDownloadEnabled, setWatermarkDownloadEnabled] = useState<boolean>(true);
  const [watermarkPreviewEnabled, setWatermarkPreviewEnabled] = useState<boolean>(true);
  const [hidePromptManager, setHidePromptManager] = useState<boolean>(false);
  const [slashPromptEnabled, setSlashPromptEnabled] = useState<boolean>(true);
  const [promptInsertOnClickEnabled, setPromptInsertOnClickEnabled] = useState<boolean>(false);
  const [promptMigrationStatus, setPromptMigrationStatus] = useState<{
    kind: 'ok' | 'warn' | 'err';
    text: string;
  } | null>(null);
  const [promptMigrationBusy, setPromptMigrationBusy] = useState<boolean>(false);
  const [inputCollapseEnabled, setInputCollapseEnabled] = useState<boolean>(false);
  const [inputCollapseWhenNotEmpty, setInputCollapseWhenNotEmpty] = useState<boolean>(false);
  const [inputVimModeEnabled, setInputVimModeEnabled] = useState<boolean>(false);
  // Changelog notification mode: when true, new-version notes announce via a NEW
  // badge on the floating ball instead of auto-popping the modal.
  const [changelogBadgeMode, setChangelogBadgeMode] = useState<boolean>(false);
  const [mermaidEnabled, setMermaidEnabled] = useState<boolean>(true);
  const [showMessageTimestamps, setShowMessageTimestamps] = useState<boolean>(false);
  const [quoteReplyEnabled, setQuoteReplyEnabled] = useState<boolean>(true);

  // Load the changelog notification-mode preference (StorageKeys.CHANGELOG_NOTIFY_MODE).
  useEffect(() => {
    try {
      chrome.storage?.local?.get(StorageKeys.CHANGELOG_NOTIFY_MODE, (res) => {
        setChangelogBadgeMode(res?.[StorageKeys.CHANGELOG_NOTIFY_MODE] === 'badge');
      });
    } catch {
      // Ignore storage errors (e.g. invalidated extension context).
    }
  }, []);

  // Mirror the modal's old behavior: switching to badge mode clears the dismissed
  // version so the NEW badge appears for the current release.
  const handleChangelogBadgeModeChange = (checked: boolean) => {
    setChangelogBadgeMode(checked);
    try {
      const updates: Record<string, string> = {
        [StorageKeys.CHANGELOG_NOTIFY_MODE]: checked ? 'badge' : 'popup',
      };
      if (checked) {
        updates[StorageKeys.CHANGELOG_DISMISSED_VERSION] = '';
      }
      chrome.storage?.local?.set(updates);
    } catch {
      // Ignore storage errors.
    }
  };
  const [highlightEnabled, setHighlightEnabled] = useState<boolean>(true);
  const [highlightTimelineMarkersEnabled, setHighlightTimelineMarkersEnabled] =
    useState<boolean>(true);
  const [responseCompleteNotificationEnabled, setResponseCompleteNotificationEnabled] =
    useState<boolean>(false);
  const [remoteAnnouncementEnabled, setRemoteAnnouncementEnabled] = useState<boolean>(true);
  const [remoteAnnouncementPermissionGranted, setRemoteAnnouncementPermissionGranted] =
    useState<boolean>(false);
  const [usageStatusEnabled, setUsageStatusEnabled] = useState<boolean>(false);
  const [defaultModelAutoApplyEnabled, setDefaultModelAutoApplyEnabled] = useState<boolean>(true);
  const [folderProjectEnabled, setFolderProjectEnabled] = useState<boolean>(false);
  const [ctrlEnterSendEnabled, setCtrlEnterSendEnabled] = useState<boolean>(false);
  const [aiStudioEnterSendEnabled, setAiStudioEnterSendEnabled] = useState<boolean>(false);
  const [safariEnterFixEnabled, setSafariEnterFixEnabled] = useState<boolean>(false);
  const [draftAutoSaveEnabled, setDraftAutoSaveEnabled] = useState<boolean>(false);
  const [sidebarAutoHideEnabled, setSidebarAutoHideEnabled] = useState<boolean>(false);
  const [sidebarFullHideEnabled, setSidebarFullHideEnabled] = useState<boolean>(false);
  const [visualEffect, setVisualEffect] = useState<'off' | 'snow' | 'sakura' | 'rain'>('off');
  const [preventAutoScrollEnabled, setPreventAutoScrollEnabled] = useState<boolean>(false);
  const [inputHaloHidden, setInputHaloHidden] = useState<boolean>(false);
  const [forkEnabled, setForkEnabled] = useState<boolean>(false);
  const [chatWidthEnabled, setChatWidthEnabled] = useState<boolean>(false);
  const [chatFontSizeEnabled, setChatFontSizeEnabled] = useState<boolean>(false);
  const [chatLineHeightEnabled, setChatLineHeightEnabled] = useState<boolean>(false);
  const [editInputWidthEnabled, setEditInputWidthEnabled] = useState<boolean>(false);
  const [sidebarWidthEnabled, setSidebarWidthEnabled] = useState<boolean>(false);
  const [accountIsolationEnabledGemini, setAccountIsolationEnabledGemini] =
    useState<boolean>(false);
  const [accountIsolationEnabledAIStudio, setAccountIsolationEnabledAIStudio] =
    useState<boolean>(false);
  const [aiStudioEnabled, setAiStudioEnabled] = useState<boolean>(true);
  const [persistentExportToolbarEnabled, setPersistentExportToolbarEnabled] =
    useState<boolean>(true);
  const [activeAccountPlatform, setActiveAccountPlatform] = useState<AccountPlatform>('gemini');
  const [activeUrl, setActiveUrl] = useState<string>('');
  const [activeTabContextLoaded, setActiveTabContextLoaded] = useState(false);
  const [pluginManifests, setPluginManifests] = useState<readonly PluginManifest[]>([]);
  const [pluginSourceIds, setPluginSourceIds] = useState<Readonly<Record<string, string>>>({});
  const [pluginState, setPluginState] = useState<PluginStateMap>({});
  const [pluginStateLoaded, setPluginStateLoaded] = useState(false);
  // Per-site custom accent overrides: Record<siteId, hex>.
  const [accentColors, setAccentColors] = useState<Record<string, string>>({});
  // Debounce timer for persisting accent changes to throttled sync storage.
  const accentWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptImportInputRef = useRef<HTMLInputElement | null>(null);
  const [pluginsLoading, setPluginsLoading] = useState<boolean>(true);
  const [pluginsRefreshing, setPluginsRefreshing] = useState<boolean>(false);
  const [aiStructureCopyStatus, setAiStructureCopyStatus] = useState<
    'idle' | 'loading' | 'copied' | 'empty' | 'error'
  >('idle');
  const [sectionOrder, setSectionOrder] = useState<PopupSectionId[]>([...DEFAULT_SECTION_ORDER]);
  const [settingsSearchQuery, setSettingsSearchQuery] = useState<string>('');

  const isAIStudio = activeAccountPlatform === 'aistudio';
  const currentPlatformLabel = isAIStudio ? t('platformAIStudio') : t('platformGemini');

  // Plugins whose match patterns cover the active tab's URL. A plugin only ever
  // shows on — and only affects — the site it targets, so Claude plugins appear
  // only on Claude, ChatGPT plugins only on ChatGPT, and neither on Gemini.
  const siteScopedManifests = useMemo(
    () => pluginManifests.filter((plugin) => matchesAnyPattern(activeUrl, plugin.matches)),
    [activeUrl, pluginManifests],
  );
  const diagnosticPlugins = useMemo<readonly DiagnosticPluginInput[]>(
    () =>
      pluginManifests.map((plugin) => {
        const state = pluginState[plugin.id];
        return {
          id: plugin.id,
          version: plugin.version,
          source: diagnosticPluginSourceFromId(pluginSourceIds[plugin.id]),
          enabled: state?.enabled ?? false,
          settingsSchema: plugin.contributes.settings,
          settings: state?.settings,
        };
      }),
    [pluginManifests, pluginSourceIds, pluginState],
  );
  // True for non-native web pages even before the plugin manifest list loads.
  // Keeps Claude / ChatGPT / Grok and arbitrary third-party sites in their
  // plugin-only popup instead of falling back to Gemini's full settings UI.
  const isPluginSite = useMemo(
    () => isPluginPopupSite(activeUrl, siteScopedManifests),
    [activeUrl, siteScopedManifests],
  );

  // The host platform to theme the popup for (claude → orange, chatgpt → sky blue).
  // Brand accent for the popup, matching the tab the user is on (adapter
  // built-in, or a plugin's declared theme). Drives --primary/--ring/--accent so
  // the whole popup — not just primary buttons — adopts the platform colour.
  const activeBrand = useMemo(
    () => resolveBrandColor(activeUrl, pluginManifests, accentColors),
    [activeUrl, pluginManifests, accentColors],
  );

  // Theme-colour picker: which site the override applies to, that site's
  // default (what "reset" returns to), and a friendly scope label.
  const activeSiteId = useMemo(() => resolveSiteId(activeUrl), [activeUrl]);
  const activeSiteDefault = useMemo(
    () => effectiveAccentForDisplay(activeUrl, pluginManifests, {}),
    [activeUrl, pluginManifests],
  );
  const activeSiteLabel = useMemo(() => {
    const labels: Record<string, string> = {
      gemini: 'Gemini',
      aistudio: 'AI Studio',
      claude: 'Claude',
      chatgpt: 'ChatGPT',
      grok: 'Grok',
    };
    return activeSiteId ? (labels[activeSiteId] ?? activeSiteId) : '';
  }, [activeSiteId]);

  // The registrable host of the active tab, used by the top-of-popup
  // "enable Prompt Manager here" toggle on third-party plugin sites.
  const activeSiteDomain = useMemo(() => {
    try {
      return new URL(activeUrl).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return '';
    }
  }, [activeUrl]);

  const visualEffectsAvailable = useMemo(
    () =>
      canUseVisualEffects({
        isPluginSite,
        activeSiteDomain,
        customWebsites,
        sitePluginIds: siteScopedManifests.map((plugin) => plugin.id),
        pluginState,
      }),
    [isPluginSite, activeSiteDomain, customWebsites, siteScopedManifests, pluginState],
  );

  // Load the per-site accent map once and keep it live (changes flow back in
  // from this same popup's writes, or another device's sync).
  useEffect(() => {
    let alive = true;
    const read = (): void => {
      try {
        chrome.storage?.sync?.get(StorageKeys.ACCENT_COLORS, (res) => {
          if (!alive) return;
          const value = res?.[StorageKeys.ACCENT_COLORS];
          setAccentColors(value && typeof value === 'object' ? value : {});
        });
      } catch {
        /* storage unavailable */
      }
    };
    read();
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area === 'sync' && StorageKeys.ACCENT_COLORS in changes) read();
    };
    chrome.storage?.onChanged?.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage?.onChanged?.removeListener(onChanged);
    };
  }, []);

  const handleAccentColorChange = useCallback(
    (next: string | null) => {
      if (!activeSiteId) return;
      const updated = { ...accentColors };
      if (next) updated[activeSiteId] = next;
      else delete updated[activeSiteId];
      setAccentColors(updated); // instant popup preview from React state
      // Debounce the sync write: dragging the native colour wheel fires onChange
      // rapidly, and chrome.storage.sync throttles write bursts (~120/min), after
      // which writes are dropped and the colour appears to "freeze". Persist only
      // the final value once the user pauses.
      if (accentWriteTimer.current) clearTimeout(accentWriteTimer.current);
      accentWriteTimer.current = setTimeout(() => {
        try {
          chrome.storage?.sync?.set({ [StorageKeys.ACCENT_COLORS]: updated });
        } catch {
          /* storage unavailable */
        }
      }, 200);
    },
    [activeSiteId, accentColors],
  );

  const handleRefreshPlugins = useCallback(async () => {
    setPluginsRefreshing(true);
    try {
      const records = await refreshPluginManifestsWithSources();
      setPluginManifests(records.map(({ manifest }) => manifest));
      setPluginSourceIds(
        Object.fromEntries(records.map(({ manifest, sourceId }) => [manifest.id, sourceId])),
      );
    } finally {
      setPluginsRefreshing(false);
    }
  }, []);

  const refreshActiveTabContext = useCallback(async () => {
    try {
      let tab =
        typeof sourceTabId === 'number'
          ? await browser.tabs.get(sourceTabId).catch(() => null)
          : null;
      tab ??= (await browser.tabs.query({ active: true, currentWindow: true }))[0] ?? null;
      const url = tab?.url || '';
      setActiveUrl(url);
      setActiveAccountPlatform(detectAccountPlatformFromUrl(url));
    } catch {
      // Keep the default empty URL when the tab cannot be inspected.
    } finally {
      setActiveTabContextLoaded(true);
    }
  }, [sourceTabId]);

  useEffect(() => {
    void refreshActiveTabContext();
  }, [refreshActiveTabContext]);

  // Load plugin manifests from bundled sources plus the remote marketplace.
  useEffect(() => {
    let active = true;
    void listPluginManifestsWithSources()
      .then((records) => {
        if (!active) return;
        setPluginManifests(records.map(({ manifest }) => manifest));
        setPluginSourceIds(
          Object.fromEntries(records.map(({ manifest, sourceId }) => [manifest.id, sourceId])),
        );
      })
      .finally(() => {
        if (active) setPluginsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void loadPluginState().then((state) => {
      if (active) {
        setPluginState(state);
        setPluginStateLoaded(true);
      }
    });
    const unsubscribe = subscribePluginState((state) => {
      if (active) setPluginState(state);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const handleFormulaCopyFormatChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const format = e.target.value as 'latex' | 'unicodemath' | 'no-dollar' | 'notion';
    setFormulaCopyFormat(format);
    try {
      chrome.storage?.sync?.set({ gvFormulaCopyFormat: format });
    } catch (err) {
      console.error('[Gemini Voyager] Failed to save formula copy format:', err);
    }
  }, []);

  const setSyncStorage = useCallback(async (payload: Record<string, unknown>) => {
    try {
      await browser.storage.sync.set(payload);
      return;
    } catch {
      // Fallback to chrome.* if polyfill is unavailable in this context.
    }

    await new Promise<void>((resolve) => {
      try {
        chrome.storage?.sync?.set(payload, () => resolve());
      } catch {
        resolve();
      }
    });
  }, []);

  // Helper function to apply settings to storage
  const apply = useCallback(
    (settings: SettingsUpdate) => {
      const payload: Record<string, unknown> = {};
      if (settings.mode) payload.geminiTimelineScrollMode = settings.mode;
      if (settings.timelineStyle) payload[StorageKeys.TIMELINE_STYLE] = settings.timelineStyle;
      if (typeof settings.hideContainer === 'boolean')
        payload.geminiTimelineHideContainer = settings.hideContainer;
      if (typeof settings.draggableTimeline === 'boolean')
        payload.geminiTimelineDraggable = settings.draggableTimeline;
      if (typeof settings.timelinePreviewPinned === 'boolean')
        payload[StorageKeys.TIMELINE_PREVIEW_PINNED] = settings.timelinePreviewPinned;
      if (typeof settings.markerLevelEnabled === 'boolean')
        payload.geminiTimelineMarkerLevel = settings.markerLevelEnabled;
      if (typeof settings.folderEnabled === 'boolean')
        payload.geminiFolderEnabled = settings.folderEnabled;
      if (typeof settings.floatingModeEnabled === 'boolean')
        payload[StorageKeys.FOLDER_FLOATING_MODE_ENABLED] = settings.floatingModeEnabled;
      if (typeof settings.floatingOpenOnStart === 'boolean')
        payload[StorageKeys.FOLDER_FLOATING_OPEN_ON_START] = settings.floatingOpenOnStart;
      if (typeof settings.hideArchivedConversations === 'boolean')
        payload.geminiFolderHideArchivedConversations = settings.hideArchivedConversations;
      if (typeof settings.folderSearchEnabled === 'boolean')
        payload[StorageKeys.FOLDER_SEARCH_ENABLED] = settings.folderSearchEnabled;
      if (settings.resetPosition) payload.geminiTimelinePosition = null;
      if (settings.customWebsites) payload.gvPromptCustomWebsites = settings.customWebsites;
      if (typeof settings.watermarkDownloadEnabled === 'boolean') {
        payload[StorageKeys.WATERMARK_DOWNLOAD_ENABLED] = settings.watermarkDownloadEnabled;
        // Clear the legacy single-toggle key once the user touches either new
        // switch so it can never override the split flags on a future read.
        payload[StorageKeys.WATERMARK_REMOVER_ENABLED] = null;
      }
      if (typeof settings.watermarkPreviewEnabled === 'boolean') {
        payload[StorageKeys.WATERMARK_PREVIEW_ENABLED] = settings.watermarkPreviewEnabled;
        payload[StorageKeys.WATERMARK_REMOVER_ENABLED] = null;
      }
      if (typeof settings.hidePromptManager === 'boolean')
        payload.gvHidePromptManager = settings.hidePromptManager;
      if (typeof settings.slashPromptEnabled === 'boolean')
        payload[StorageKeys.SLASH_PROMPT_ENABLED] = settings.slashPromptEnabled;
      if (typeof settings.promptInsertOnClickEnabled === 'boolean')
        payload[StorageKeys.PROMPT_INSERT_ON_CLICK] = settings.promptInsertOnClickEnabled;
      if (typeof settings.inputCollapseEnabled === 'boolean')
        payload.gvInputCollapseEnabled = settings.inputCollapseEnabled;
      if (typeof settings.inputCollapseWhenNotEmpty === 'boolean')
        payload.gvInputCollapseWhenNotEmpty = settings.inputCollapseWhenNotEmpty;
      if (typeof settings.inputVimModeEnabled === 'boolean')
        payload[StorageKeys.INPUT_VIM_MODE] = settings.inputVimModeEnabled;
      if (typeof settings.mermaidEnabled === 'boolean')
        payload.gvMermaidEnabled = settings.mermaidEnabled;
      if (typeof settings.quoteReplyEnabled === 'boolean')
        payload.gvQuoteReplyEnabled = settings.quoteReplyEnabled;
      if (typeof settings.highlightEnabled === 'boolean') {
        payload[StorageKeys.HIGHLIGHT_ENABLED] = settings.highlightEnabled;
      }
      if (typeof settings.highlightTimelineMarkersEnabled === 'boolean') {
        payload[StorageKeys.HIGHLIGHT_TIMELINE_MARKERS_ENABLED] =
          settings.highlightTimelineMarkersEnabled;
      }
      if (typeof settings.responseCompleteNotificationEnabled === 'boolean') {
        payload[StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED] =
          settings.responseCompleteNotificationEnabled;
      }
      if (typeof settings.remoteAnnouncementEnabled === 'boolean') {
        payload[StorageKeys.REMOTE_ANNOUNCEMENTS_ENABLED] = settings.remoteAnnouncementEnabled;
      }
      if (typeof settings.usageStatusEnabled === 'boolean')
        payload[StorageKeys.USAGE_STATUS_ENABLED] = settings.usageStatusEnabled;
      if (typeof settings.defaultModelAutoApplyEnabled === 'boolean')
        payload[StorageKeys.DEFAULT_MODEL_AUTO_APPLY] = settings.defaultModelAutoApplyEnabled;
      if (typeof settings.folderProjectEnabled === 'boolean')
        payload[StorageKeys.FOLDER_PROJECT_ENABLED] = settings.folderProjectEnabled;
      if (typeof settings.ctrlEnterSendEnabled === 'boolean')
        payload.gvCtrlEnterSend = settings.ctrlEnterSendEnabled;
      if (typeof settings.aiStudioEnterSendEnabled === 'boolean')
        payload[StorageKeys.AISTUDIO_ENTER_SEND] = settings.aiStudioEnterSendEnabled;
      if (typeof settings.safariEnterFixEnabled === 'boolean')
        payload[StorageKeys.SAFARI_ENTER_FIX] = settings.safariEnterFixEnabled;
      if (typeof settings.draftAutoSaveEnabled === 'boolean')
        payload[StorageKeys.DRAFT_AUTO_SAVE] = settings.draftAutoSaveEnabled;
      if (typeof settings.sidebarAutoHideEnabled === 'boolean')
        payload.gvSidebarAutoHide = settings.sidebarAutoHideEnabled;
      if (typeof settings.sidebarFullHideEnabled === 'boolean')
        payload.gvSidebarFullHide = settings.sidebarFullHideEnabled;
      if (settings.visualEffect) {
        payload.gvVisualEffect = settings.visualEffect;
        // Clear legacy key
        payload.gvSnowEffect = false;
      }
      if (typeof settings.preventAutoScrollEnabled === 'boolean')
        payload.gvPreventAutoScrollEnabled = settings.preventAutoScrollEnabled;
      if (typeof settings.inputHaloHidden === 'boolean')
        payload[StorageKeys.INPUT_HALO_HIDDEN] = settings.inputHaloHidden;
      if (typeof settings.forkEnabled === 'boolean')
        payload[StorageKeys.FORK_ENABLED] = settings.forkEnabled;
      if (typeof settings.accountIsolationEnabled === 'boolean') {
        const isolationPlatform = settings.accountIsolationPlatform ?? activeAccountPlatform;
        payload[getAccountIsolationStorageKey(isolationPlatform)] =
          settings.accountIsolationEnabled;
      }
      if (typeof settings.aiStudioEnabled === 'boolean')
        payload[StorageKeys.GV_AISTUDIO_ENABLED] = settings.aiStudioEnabled;
      if (typeof settings.showMessageTimestamps === 'boolean')
        payload[StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS] = settings.showMessageTimestamps;
      if (typeof settings.persistentExportToolbarEnabled === 'boolean')
        payload[StorageKeys.PERSISTENT_EXPORT_TOOLBAR_ENABLED] =
          settings.persistentExportToolbarEnabled;
      void setSyncStorage(payload);
    },
    [activeAccountPlatform, setSyncStorage],
  );

  const handlePromptExport = useCallback(async () => {
    setPromptMigrationBusy(true);
    setPromptMigrationStatus(null);
    try {
      const result = await PromptImportExportService.loadPrompts();
      if (!result.success) throw result.error;

      const prompts = result.data;
      PromptImportExportService.downloadJSON(PromptImportExportService.exportToPayload(prompts));
      setPromptMigrationStatus({
        kind: 'ok',
        text: t('promptExportSuccess').replace('{count}', String(prompts.length)),
      });
    } catch (error) {
      console.error('[Gemini Voyager] Failed to export prompts:', error);
      setPromptMigrationStatus({ kind: 'err', text: t('promptExportError') });
    } finally {
      setPromptMigrationBusy(false);
    }
  }, [t]);

  const handlePromptImport = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      setPromptMigrationBusy(true);
      setPromptMigrationStatus(null);
      try {
        const readResult = await PromptImportExportService.readJSONFile(file);
        if (!readResult.success) throw readResult.error;

        const payloadResult = PromptImportExportService.validatePayload(readResult.data);
        if (!payloadResult.success) {
          setPromptMigrationStatus({
            kind: 'err',
            text: isEmptyPromptImportPayload(readResult.data)
              ? t('pm_import_empty')
              : t('pm_import_invalid'),
          });
          return;
        }

        const importResult = await PromptImportExportService.importFromPayload(payloadResult.data);
        if (!importResult.success) throw importResult.error;

        const processed = importResult.data.imported + importResult.data.duplicates;
        setPromptMigrationStatus({
          kind: importResult.data.nameConflicts > 0 ? 'warn' : 'ok',
          text:
            importResult.data.nameConflicts > 0
              ? t('promptNameConflictsDetected').replace(
                  '{count}',
                  String(importResult.data.nameConflicts),
                )
              : t('pm_import_success').replace('{count}', String(processed)),
        });
      } catch (error) {
        console.error('[Gemini Voyager] Failed to import prompts:', error);
        setPromptMigrationStatus({ kind: 'err', text: t('promptImportError') });
      } finally {
        event.target.value = '';
        setPromptMigrationBusy(false);
      }
    },
    [t],
  );

  // Cloud (Google Drive) prompt sync — prompts-only, merge semantics.
  // The whole merge runs in the background (see gv.sync.*PromptsMerge) so a
  // first-time Google account picker closing the popup can't abandon it.
  const handlePromptCloudPull = useCallback(async () => {
    setPromptMigrationBusy(true);
    setPromptMigrationStatus(null);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'gv.sync.pullPromptsMerge',
        payload: { interactive: true },
      })) as
        | {
            ok?: boolean;
            empty?: boolean;
            imported?: number;
            duplicates?: number;
            nameConflicts?: number;
          }
        | undefined;

      if (!response?.ok) {
        setPromptMigrationStatus({ kind: 'err', text: t('promptCloudError') });
        return;
      }
      if (response.empty) {
        setPromptMigrationStatus({ kind: 'ok', text: t('promptCloudPullEmpty') });
        return;
      }

      const processed = (response.imported ?? 0) + (response.duplicates ?? 0);
      setPromptMigrationStatus({
        kind: (response.nameConflicts ?? 0) > 0 ? 'warn' : 'ok',
        text:
          (response.nameConflicts ?? 0) > 0
            ? t('promptNameConflictsDetected').replace(
                '{count}',
                String(response.nameConflicts ?? 0),
              )
            : t('promptCloudPullSuccess').replace('{count}', String(processed)),
      });
    } catch (error) {
      console.error('[Gemini Voyager] Failed to pull prompts from cloud:', error);
      setPromptMigrationStatus({ kind: 'err', text: t('promptCloudError') });
    } finally {
      setPromptMigrationBusy(false);
    }
  }, [t]);

  const handlePromptCloudPush = useCallback(async () => {
    setPromptMigrationBusy(true);
    setPromptMigrationStatus(null);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'gv.sync.pushPromptsMerge',
        payload: { interactive: true },
      })) as { ok?: boolean; count?: number; nameConflicts?: number } | undefined;

      if (!response?.ok) {
        setPromptMigrationStatus({ kind: 'err', text: t('promptCloudError') });
        return;
      }
      setPromptMigrationStatus({
        kind: (response.nameConflicts ?? 0) > 0 ? 'warn' : 'ok',
        text:
          (response.nameConflicts ?? 0) > 0
            ? t('promptNameConflictsDetected').replace(
                '{count}',
                String(response.nameConflicts ?? 0),
              )
            : t('promptCloudPushSuccess').replace('{count}', String(response.count ?? 0)),
      });
    } catch (error) {
      console.error('[Gemini Voyager] Failed to push prompts to cloud:', error);
      setPromptMigrationStatus({ kind: 'err', text: t('promptCloudError') });
    } finally {
      setPromptMigrationBusy(false);
    }
  }, [t]);

  // Copy folder structure for AI organization
  const handleCopyFolderStructureForAI = useCallback(async () => {
    setAiStructureCopyStatus('loading');
    try {
      const tabId =
        typeof sourceTabId === 'number'
          ? sourceTabId
          : (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      if (!tabId) {
        setAiStructureCopyStatus('error');
        return;
      }

      const response = (await browser.tabs.sendMessage(tabId, {
        type: 'gv.folders.getStructureForAI',
      })) as {
        ok: boolean;
        sidebarConversations: Array<{ id: string; title: string; url: string }>;
        folderData: { folders: Folder[]; folderContents: Record<string, ConversationReference[]> };
      };

      if (!response?.ok) {
        setAiStructureCopyStatus('error');
        return;
      }

      const { sidebarConversations, folderData } = response;
      // The lr26 sidebar lazily renders conversation rows; if none were
      // readable, copying an empty prompt is useless — guide the user instead.
      if (!sidebarConversations?.length) {
        setAiStructureCopyStatus('empty');
        setTimeout(() => setAiStructureCopyStatus('idle'), 4000);
        return;
      }
      const prompt = formatFolderStructurePrompt(sidebarConversations, folderData, language);
      await navigator.clipboard.writeText(prompt);
      setAiStructureCopyStatus('copied');
      setTimeout(() => setAiStructureCopyStatus('idle'), 2000);
    } catch {
      setAiStructureCopyStatus('error');
      setTimeout(() => setAiStructureCopyStatus('idle'), 2000);
    }
  }, [language, sourceTabId]);

  // Width adjuster for chat width
  const chatWidthAdjuster = useWidthAdjuster({
    storageKey: 'geminiChatWidth',
    defaultValue: CHAT_PERCENT.defaultValue,
    normalize: (v) =>
      normalizePercent(
        v,
        CHAT_PERCENT.defaultValue,
        CHAT_PERCENT.min,
        CHAT_PERCENT.max,
        CHAT_PERCENT.legacyBaselinePx,
      ),
    onApply: useCallback((widthPercent: number) => {
      const normalized = normalizePercent(
        widthPercent,
        CHAT_PERCENT.defaultValue,
        CHAT_PERCENT.min,
        CHAT_PERCENT.max,
        CHAT_PERCENT.legacyBaselinePx,
      );
      try {
        chrome.storage?.sync?.set({ geminiChatWidth: normalized });
      } catch {}
    }, []),
  });

  // Font size adjuster for chat messages
  const chatFontSizeAdjuster = useWidthAdjuster({
    storageKey: StorageKeys.CHAT_FONT_SIZE,
    defaultValue: CHAT_FONT_SIZE.defaultValue,
    normalize: (v) => clampNumber(v, CHAT_FONT_SIZE.min, CHAT_FONT_SIZE.max),
    onApply: useCallback((value: number) => {
      const clamped = clampNumber(value, CHAT_FONT_SIZE.min, CHAT_FONT_SIZE.max);
      try {
        chrome.storage?.sync?.set({ [StorageKeys.CHAT_FONT_SIZE]: clamped });
      } catch {}
    }, []),
  });

  // Line height adjuster for chat messages
  const chatLineHeightAdjuster = useWidthAdjuster({
    storageKey: StorageKeys.CHAT_LINE_HEIGHT,
    defaultValue: CHAT_LINE_HEIGHT.defaultValue,
    normalize: (v) => clampNumber(v, CHAT_LINE_HEIGHT.min, CHAT_LINE_HEIGHT.max),
    onApply: useCallback((value: number) => {
      const clamped = clampNumber(value, CHAT_LINE_HEIGHT.min, CHAT_LINE_HEIGHT.max);
      try {
        chrome.storage?.sync?.set({ [StorageKeys.CHAT_LINE_HEIGHT]: clamped });
      } catch {}
    }, []),
  });

  // Paragraph spacing adjuster for chat messages
  const chatParagraphSpacingAdjuster = useWidthAdjuster({
    storageKey: StorageKeys.CHAT_PARAGRAPH_SPACING,
    defaultValue: CHAT_PARAGRAPH_SPACING.defaultValue,
    normalize: (v) => clampNumber(v, CHAT_PARAGRAPH_SPACING.min, CHAT_PARAGRAPH_SPACING.max),
    onApply: useCallback((value: number) => {
      const clamped = clampNumber(value, CHAT_PARAGRAPH_SPACING.min, CHAT_PARAGRAPH_SPACING.max);
      try {
        chrome.storage?.sync?.set({ [StorageKeys.CHAT_PARAGRAPH_SPACING]: clamped });
      } catch {}
    }, []),
  });

  // Width adjuster for edit input width
  const editInputWidthAdjuster = useWidthAdjuster({
    storageKey: 'geminiEditInputWidth',
    defaultValue: EDIT_PERCENT.defaultValue,
    normalize: (v) =>
      normalizePercent(
        v,
        EDIT_PERCENT.defaultValue,
        EDIT_PERCENT.min,
        EDIT_PERCENT.max,
        EDIT_PERCENT.legacyBaselinePx,
      ),
    onApply: useCallback((widthPercent: number) => {
      const normalized = normalizePercent(
        widthPercent,
        EDIT_PERCENT.defaultValue,
        EDIT_PERCENT.min,
        EDIT_PERCENT.max,
        EDIT_PERCENT.legacyBaselinePx,
      );
      try {
        chrome.storage?.sync?.set({ geminiEditInputWidth: normalized });
      } catch {}
    }, []),
  });

  // Width adjuster for sidebar width (Context-aware: Gemini vs AI Studio)
  const sidebarConfig = useMemo(
    () =>
      isAIStudio
        ? {
            key: 'gvAIStudioSidebarWidth',
            min: AI_STUDIO_SIDEBAR_PX.min,
            max: AI_STUDIO_SIDEBAR_PX.max,
            def: AI_STUDIO_SIDEBAR_PX.defaultValue,
            norm: (v: number) => clampNumber(v, AI_STUDIO_SIDEBAR_PX.min, AI_STUDIO_SIDEBAR_PX.max),
          }
        : {
            key: 'geminiSidebarWidth',
            min: SIDEBAR_PX.min,
            max: SIDEBAR_PX.max,
            def: SIDEBAR_PX.defaultValue,
            norm: normalizeSidebarPx,
          },
    [isAIStudio],
  );

  const sidebarWidthAdjuster = useWidthAdjuster({
    storageKey: sidebarConfig.key,
    defaultValue: sidebarConfig.def,
    normalize: sidebarConfig.norm,
    onApply: useCallback(
      (widthPx: number) => {
        const clamped = sidebarConfig.norm(widthPx);
        try {
          chrome.storage?.sync?.set({ [sidebarConfig.key]: clamped });
        } catch {}
      },
      [sidebarConfig],
    ),
  });

  // Folder spacing adjuster (Context-aware: Gemini vs AI Studio)
  const folderSpacingKey = isAIStudio ? 'gvAIStudioFolderSpacing' : 'gvFolderSpacing';

  const folderSpacingAdjuster = useWidthAdjuster({
    storageKey: folderSpacingKey,
    defaultValue: FOLDER_SPACING.defaultValue,
    normalize: (v) => clampNumber(v, FOLDER_SPACING.min, FOLDER_SPACING.max),
    onApply: useCallback(
      (spacing: number) => {
        const clamped = clampNumber(spacing, FOLDER_SPACING.min, FOLDER_SPACING.max);
        try {
          chrome.storage?.sync?.set({ [folderSpacingKey]: clamped });
        } catch {}
      },
      [folderSpacingKey],
    ),
  });

  const folderTreeIndentAdjuster = useWidthAdjuster({
    storageKey: 'gvFolderTreeIndent',
    defaultValue: FOLDER_TREE_INDENT.defaultValue,
    normalize: (v) => clampNumber(v, FOLDER_TREE_INDENT.min, FOLDER_TREE_INDENT.max),
    onApply: useCallback((indent: number) => {
      const clamped = clampNumber(indent, FOLDER_TREE_INDENT.min, FOLDER_TREE_INDENT.max);
      try {
        chrome.storage?.sync?.set({ gvFolderTreeIndent: clamped });
      } catch {}
    }, []),
  });

  // Gems sidebar count — 0 hides the section, 1-10 controls how many recent
  // gems show above Notebooks. Persists to chrome.storage.sync so the
  // preference follows the user across devices.
  const gemsSidebarCountAdjuster = useWidthAdjuster({
    storageKey: StorageKeys.GV_GEMS_SIDEBAR_COUNT,
    defaultValue: GEMS_SIDEBAR_COUNT.defaultValue,
    normalize: (v) => clampNumber(v, GEMS_SIDEBAR_COUNT.min, GEMS_SIDEBAR_COUNT.max),
    onApply: useCallback((count: number) => {
      const clamped = clampNumber(count, GEMS_SIDEBAR_COUNT.min, GEMS_SIDEBAR_COUNT.max);
      try {
        chrome.storage?.sync?.set({ [StorageKeys.GV_GEMS_SIDEBAR_COUNT]: clamped });
      } catch {}
    }, []),
  });

  useEffect(() => {
    try {
      const version = chrome?.runtime?.getManifest?.()?.version;
      if (version) {
        setExtVersion(version);
      }
    } catch (err) {
      console.error('[Gemini Voyager] Failed to get extension version:', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchLatestVersion = async () => {
      if (!extVersion) return;

      // Check for store installation (Chrome/Edge Web Store)
      // Store-installed extensions have an 'update_url' in the manifest.
      // We skip manual version checks for these users to rely on store auto-updates
      // and prevent confusing "new version" prompts when GitHub is ahead of the store.
      const manifest = chrome?.runtime?.getManifest?.();

      // For Safari: only skip update check if the feature is disabled (default)
      // If shouldShowSafariUpdateReminder() returns true, allow update checks
      if (isSafari() && !shouldShowSafariUpdateReminder()) {
        return;
      }

      // For other browsers: skip if they have update_url (store installation)
      if (!isSafari() && getManifestUpdateUrl(manifest)) {
        return;
      }

      try {
        const cache = await browser.storage.local.get(LATEST_VERSION_CACHE_KEY);
        const now = Date.now();

        const cachedEntry = cache?.[LATEST_VERSION_CACHE_KEY];
        let latest = getCachedLatestVersion(cachedEntry, now, LATEST_VERSION_MAX_AGE);
        let dmgUrl: string | null = null;

        if (latest && isSafari()) {
          // Try to read cached DMG URL
          if (
            typeof cachedEntry === 'object' &&
            cachedEntry !== null &&
            'dmgUrl' in cachedEntry &&
            typeof (cachedEntry as Record<string, unknown>).dmgUrl === 'string'
          ) {
            dmgUrl = (cachedEntry as Record<string, unknown>).dmgUrl as string;
          }
          // If DMG URL was not cached, re-fetch — but respect a 30 min cooldown
          // to avoid hitting GitHub API rate limits
          if (
            !dmgUrl &&
            typeof cachedEntry === 'object' &&
            cachedEntry !== null &&
            'fetchedAt' in cachedEntry &&
            typeof (cachedEntry as Record<string, unknown>).fetchedAt === 'number' &&
            now - ((cachedEntry as Record<string, unknown>).fetchedAt as number) >=
              SAFARI_DMG_RETRY_AGE
          ) {
            latest = null;
          }
        }

        if (!latest) {
          const resp = await fetch(
            'https://api.github.com/repos/Nagi-ovo/voyager/releases/latest',
            {
              headers: { Accept: 'application/vnd.github+json' },
            },
          );

          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
          }

          const data: unknown = await resp.json();
          const candidate = extractLatestReleaseVersion(data);

          if (candidate) {
            latest = candidate;
            const isSafariFetch = isSafari();
            if (isSafariFetch) {
              dmgUrl = extractDmgDownloadUrl(data);
            }
            await browser.storage.local.set({
              [LATEST_VERSION_CACHE_KEY]: {
                version: candidate,
                fetchedAt: now,
                ...(isSafariFetch ? { dmgUrl } : {}),
              },
            });
          }
        }

        if (cancelled || !latest) return;

        setLatestVersion(latest);
        if (isSafari()) {
          setSafariDmgUrl(dmgUrl);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('[Gemini Voyager] Failed to check latest version:', error);
        }
      }
    };

    fetchLatestVersion();

    return () => {
      cancelled = true;
    };
  }, [extVersion]);

  useEffect(() => {
    try {
      chrome.storage?.sync?.get(
        {
          geminiTimelineScrollMode: 'flow',
          [StorageKeys.TIMELINE_STYLE]: 'dots',
          geminiTimelineHideContainer: false,
          geminiTimelineDraggable: false,
          [StorageKeys.TIMELINE_PREVIEW_PINNED]: false,
          geminiTimelineMarkerLevel: false,
          geminiFolderEnabled: true,
          [StorageKeys.FOLDER_FLOATING_MODE_ENABLED]: false,
          [StorageKeys.FOLDER_FLOATING_OPEN_ON_START]: true,
          geminiFolderHideArchivedConversations: false,
          [StorageKeys.FOLDER_SEARCH_ENABLED]: true,
          gvPromptCustomWebsites: [],
          gvFormulaCopyFormat: 'latex',
          [StorageKeys.WATERMARK_REMOVER_ENABLED]: null,
          [StorageKeys.WATERMARK_DOWNLOAD_ENABLED]: null,
          [StorageKeys.WATERMARK_PREVIEW_ENABLED]: null,
          gvHidePromptManager: false,
          [StorageKeys.SLASH_PROMPT_ENABLED]: true,
          [StorageKeys.PROMPT_INSERT_ON_CLICK]: false,
          gvInputCollapseEnabled: false,
          gvInputCollapseWhenNotEmpty: false,
          [StorageKeys.INPUT_VIM_MODE]: false,
          [StorageKeys.TAB_TITLE_UPDATE_ENABLED]: false,
          gvMermaidEnabled: true,
          gvQuoteReplyEnabled: true,
          [StorageKeys.HIGHLIGHT_ENABLED]: false,
          [StorageKeys.HIGHLIGHT_TIMELINE_MARKERS_ENABLED]: true,
          [StorageKeys.USAGE_STATUS_ENABLED]: false,
          [StorageKeys.DEFAULT_MODEL_AUTO_APPLY]: true,
          [StorageKeys.FOLDER_PROJECT_ENABLED]: false,
          gvCtrlEnterSend: false,
          [StorageKeys.AISTUDIO_ENTER_SEND]: false,
          [StorageKeys.SAFARI_ENTER_FIX]: false,
          [StorageKeys.DRAFT_AUTO_SAVE]: false,
          gvSidebarAutoHide: false,
          gvSidebarFullHide: false,
          gvVisualEffect: 'off',
          gvSnowEffect: false,
          gvPreventAutoScrollEnabled: false,
          [StorageKeys.INPUT_HALO_HIDDEN]: false,
          [StorageKeys.FORK_ENABLED]: false,
          [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED]: false,
          [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI]: null,
          [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_AISTUDIO]: null,
          [StorageKeys.GV_AISTUDIO_ENABLED]: true,
          gvChatWidthEnabled: false,
          [StorageKeys.CHAT_FONT_SIZE_ENABLED]: false,
          [StorageKeys.CHAT_FONT_SIZE]: CHAT_FONT_SIZE.defaultValue,
          [StorageKeys.CHAT_LINE_HEIGHT_ENABLED]: false,
          [StorageKeys.CHAT_LINE_HEIGHT]: CHAT_LINE_HEIGHT.defaultValue,
          [StorageKeys.CHAT_PARAGRAPH_SPACING]: CHAT_PARAGRAPH_SPACING.defaultValue,
          gvEditInputWidthEnabled: false,
          gvSidebarWidthEnabled: false,
          geminiChatWidth: CHAT_PERCENT.defaultValue,
          geminiEditInputWidth: EDIT_PERCENT.defaultValue,
          [StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS]: false,
          [StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED]: false,
          [StorageKeys.REMOTE_ANNOUNCEMENTS_ENABLED]: true,
          [StorageKeys.PERSISTENT_EXPORT_TOOLBAR_ENABLED]: true,
          [StorageKeys.GV_POPUP_SECTION_ORDER]: null,
        },
        (res) => {
          const m = res?.geminiTimelineScrollMode as ScrollMode;
          if (m === 'jump' || m === 'flow') setMode(m);
          const storedTimelineStyle = res?.[StorageKeys.TIMELINE_STYLE];
          if (storedTimelineStyle === 'dots' || storedTimelineStyle === 'compact') {
            setTimelineStyle(storedTimelineStyle);
          }
          const format = res?.gvFormulaCopyFormat as
            | 'latex'
            | 'unicodemath'
            | 'no-dollar'
            | 'notion';
          if (
            format === 'latex' ||
            format === 'unicodemath' ||
            format === 'no-dollar' ||
            format === 'notion'
          )
            setFormulaCopyFormat(format);
          setHideContainer(!!res?.geminiTimelineHideContainer);
          setDraggableTimeline(!!res?.geminiTimelineDraggable);
          setTimelinePreviewPinned(res?.[StorageKeys.TIMELINE_PREVIEW_PINNED] === true);
          setMarkerLevelEnabled(!!res?.geminiTimelineMarkerLevel);
          setFolderEnabled(res?.geminiFolderEnabled !== false);
          setFloatingModeEnabled(res?.[StorageKeys.FOLDER_FLOATING_MODE_ENABLED] === true);
          setFloatingOpenOnStart(res?.[StorageKeys.FOLDER_FLOATING_OPEN_ON_START] !== false);
          setHideArchivedConversations(!!res?.geminiFolderHideArchivedConversations);
          setFolderSearchEnabled(res?.[StorageKeys.FOLDER_SEARCH_ENABLED] !== false);
          const rawCustomWebsites = Array.isArray(res?.gvPromptCustomWebsites)
            ? res.gvPromptCustomWebsites
            : [];
          const loadedCustomWebsites = sanitizeCustomWebsites(rawCustomWebsites);
          setCustomWebsites(loadedCustomWebsites);
          if (
            rawCustomWebsites.length !== loadedCustomWebsites.length ||
            rawCustomWebsites.some((website, index) => website !== loadedCustomWebsites[index])
          ) {
            void setSyncStorage({ gvPromptCustomWebsites: loadedCustomWebsites });
          }
          {
            const watermarkSettings = resolveWatermarkSettings(res);
            setWatermarkDownloadEnabled(watermarkSettings.download);
            setWatermarkPreviewEnabled(watermarkSettings.preview);
          }
          setHidePromptManager(!!res?.gvHidePromptManager);
          setSlashPromptEnabled(res?.[StorageKeys.SLASH_PROMPT_ENABLED] !== false);
          setPromptInsertOnClickEnabled(res?.[StorageKeys.PROMPT_INSERT_ON_CLICK] === true);
          setInputCollapseEnabled(res?.gvInputCollapseEnabled !== false);
          setInputCollapseWhenNotEmpty(res?.gvInputCollapseWhenNotEmpty === true);
          setInputVimModeEnabled(res?.[StorageKeys.INPUT_VIM_MODE] === true);
          if (res?.[StorageKeys.TAB_TITLE_UPDATE_ENABLED] !== false) {
            void setSyncStorage({ [StorageKeys.TAB_TITLE_UPDATE_ENABLED]: false });
          }
          setMermaidEnabled(res?.gvMermaidEnabled !== false);
          setQuoteReplyEnabled(res?.gvQuoteReplyEnabled !== false);
          setHighlightEnabled(res?.[StorageKeys.HIGHLIGHT_ENABLED] === true);
          setHighlightTimelineMarkersEnabled(
            res?.[StorageKeys.HIGHLIGHT_TIMELINE_MARKERS_ENABLED] !== false,
          );
          setResponseCompleteNotificationEnabled(
            res?.[StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED] === true,
          );
          setRemoteAnnouncementEnabled(res?.[StorageKeys.REMOTE_ANNOUNCEMENTS_ENABLED] !== false);
          setUsageStatusEnabled(res?.[StorageKeys.USAGE_STATUS_ENABLED] === true);
          setDefaultModelAutoApplyEnabled(res?.[StorageKeys.DEFAULT_MODEL_AUTO_APPLY] !== false);
          setFolderProjectEnabled(res?.[StorageKeys.FOLDER_PROJECT_ENABLED] === true);
          setCtrlEnterSendEnabled(res?.gvCtrlEnterSend === true);
          setAiStudioEnterSendEnabled(res?.[StorageKeys.AISTUDIO_ENTER_SEND] === true);
          setSafariEnterFixEnabled(res?.[StorageKeys.SAFARI_ENTER_FIX] === true);
          setDraftAutoSaveEnabled(res?.[StorageKeys.DRAFT_AUTO_SAVE] === true);
          setSidebarAutoHideEnabled(res?.gvSidebarAutoHide === true);
          setSidebarFullHideEnabled(res?.gvSidebarFullHide === true);
          // Resolve visual effect: new key takes precedence over legacy boolean
          const storedVisualEffect = res?.gvVisualEffect;
          if (
            storedVisualEffect === 'snow' ||
            storedVisualEffect === 'sakura' ||
            storedVisualEffect === 'rain'
          ) {
            setVisualEffect(storedVisualEffect);
          } else if (res?.gvSnowEffect === true) {
            setVisualEffect('snow');
          } else {
            setVisualEffect('off');
          }
          setPreventAutoScrollEnabled(res?.gvPreventAutoScrollEnabled === true);
          setInputHaloHidden(res?.[StorageKeys.INPUT_HALO_HIDDEN] === true);
          setForkEnabled(res?.[StorageKeys.FORK_ENABLED] === true);
          setAiStudioEnabled(res?.[StorageKeys.GV_AISTUDIO_ENABLED] !== false);
          setPersistentExportToolbarEnabled(
            res?.[StorageKeys.PERSISTENT_EXPORT_TOOLBAR_ENABLED] !== false,
          );

          // Width enabled flags — auto-enable if user previously customized the width
          setChatWidthEnabled(
            res?.gvChatWidthEnabled === true ||
              (res?.gvChatWidthEnabled === false &&
                typeof res?.geminiChatWidth === 'number' &&
                res.geminiChatWidth !== CHAT_PERCENT.defaultValue),
          );
          setChatFontSizeEnabled(res?.[StorageKeys.CHAT_FONT_SIZE_ENABLED] === true);
          setChatLineHeightEnabled(res?.[StorageKeys.CHAT_LINE_HEIGHT_ENABLED] === true);
          setEditInputWidthEnabled(
            res?.gvEditInputWidthEnabled === true ||
              (res?.gvEditInputWidthEnabled === false &&
                typeof res?.geminiEditInputWidth === 'number' &&
                res.geminiEditInputWidth !== EDIT_PERCENT.defaultValue),
          );
          setSidebarWidthEnabled(res?.gvSidebarWidthEnabled === true);

          const legacyIsolationEnabled = res?.[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED] === true;
          const geminiIsolationRaw = res?.[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI];
          const aiStudioIsolationRaw = res?.[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_AISTUDIO];
          setAccountIsolationEnabledGemini(
            typeof geminiIsolationRaw === 'boolean' ? geminiIsolationRaw : legacyIsolationEnabled,
          );
          setAccountIsolationEnabledAIStudio(
            typeof aiStudioIsolationRaw === 'boolean'
              ? aiStudioIsolationRaw
              : legacyIsolationEnabled,
          );

          // Timestamp settings
          setShowMessageTimestamps(res?.[StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS] === true);

          // Section order
          const storedOrder = res?.[StorageKeys.GV_POPUP_SECTION_ORDER];
          if (Array.isArray(storedOrder)) {
            const validIds = new Set<string>(POPUP_SECTION_IDS);
            const filtered = storedOrder.filter(
              (id: unknown): id is PopupSectionId => typeof id === 'string' && validIds.has(id),
            );
            const seen = new Set(filtered);
            const missing = POPUP_SECTION_IDS.filter((id) => !seen.has(id));
            setSectionOrder([...filtered, ...missing]);
          }

          // Reconcile stored custom websites with actual granted permissions.
          // If the user denied a permission request, the popup may have closed before we could revert storage.
          void (async () => {
            if (!loadedCustomWebsites.length) return;
            if (!browser.permissions?.contains) return;

            const hasAnyPermission = async (domain: string) => {
              try {
                const normalized = domain
                  .trim()
                  .toLowerCase()
                  .replace(/^https?:\/\//, '')
                  .replace(/^www\./, '')
                  .replace(/\/.*$/, '')
                  .replace(/^\*\./, '');
                if (!normalized) return false;

                const origins = [`https://*.${normalized}/*`, `http://*.${normalized}/*`];
                for (const origin of origins) {
                  if (await browser.permissions.contains({ origins: [origin] })) return true;
                }
                return false;
              } catch {
                return true; // fail open to avoid destructive cleanup on unexpected errors
              }
            };

            const filtered = (
              await Promise.all(
                loadedCustomWebsites.map(async (domain: string) => ({
                  domain,
                  ok: await hasAnyPermission(domain),
                })),
              )
            )
              .filter((item) => item.ok)
              .map((item) => item.domain);

            if (filtered.length !== loadedCustomWebsites.length) {
              setCustomWebsites(filtered);
              await setSyncStorage({ gvPromptCustomWebsites: filtered });
            }
          })();
        },
      );
    } catch {}
  }, [setSyncStorage]);

  // Validate and normalize URL
  const normalizeUrl = useCallback((url: string): string | null => {
    return normalizeCustomWebsite(url);
  }, []);

  const originPatternsForDomain = useCallback((domain: string): string[] | null => {
    try {
      const normalized = normalizeCustomWebsite(domain);
      if (!normalized) return null;
      return [`https://*.${normalized}/*`, `http://*.${normalized}/*`];
    } catch {
      return null;
    }
  }, []);

  const requestCustomWebsitePermission = useCallback(
    async (domain: string): Promise<boolean> => {
      const originPatterns = originPatternsForDomain(domain);
      if (!originPatterns) {
        setWebsiteError(t('invalidUrl'));
        return false;
      }

      if (!browser.permissions?.request || !browser.permissions?.contains) {
        setWebsiteError(t('permissionRequestFailed'));
        return false;
      }

      if (!supportsOptionalHostPermissions()) {
        // Firefox < 128 ignores optional_host_permissions, so the host grant can
        // never succeed. Explain instead of showing a misleading "denied".
        setWebsiteError(t('pluginUnsupportedPlatform'));
        return false;
      }

      try {
        // Firefox requires permissions.request to run directly from a user gesture.
        // Avoid awaiting other extension APIs before this call in Firefox.
        if (!isFirefox()) {
          const alreadyGranted = await browser.permissions.contains({ origins: originPatterns });
          if (alreadyGranted) {
            await refreshActiveTabContext();
            return true;
          }
        }

        const granted = await browser.permissions.request({ origins: originPatterns });
        if (!granted) {
          setWebsiteError(t('permissionDenied'));
        } else {
          await refreshActiveTabContext();
        }
        return granted;
      } catch (err) {
        console.error('[Gemini Voyager] Failed to request permissions for custom website:', err);
        setWebsiteError(t('permissionRequestFailed'));
        return false;
      }
    },
    [originPatternsForDomain, refreshActiveTabContext, t],
  );

  // A domain any catalog plugin can run on (ChatGPT / Claude are both
  // Prompt-Manager quick sites AND plugin platforms).
  const isPluginCapableDomain = useCallback(
    (domain: string): boolean => {
      const normalized = domain
        .trim()
        .toLowerCase()
        .replace(/^www\./, '');
      if (!normalized) return false;
      const url = `https://${normalized}/`;
      return pluginManifests.some((plugin) => matchesAnyPattern(url, plugin.matches));
    },
    [pluginManifests],
  );

  const revokeCustomWebsitePermission = useCallback(
    async (domain: string) => {
      const originPatterns = originPatternsForDomain(domain);
      if (!originPatterns || !browser.permissions?.remove) return;

      // Keep the host permission when a plugin can run on this domain —
      // revoking it would tear down an enabled plugin's content script on a
      // site shared with the Prompt Manager (e.g. chatgpt.com / claude.ai).
      if (isPluginCapableDomain(domain)) return;

      try {
        await browser.permissions.remove({ origins: originPatterns });
      } catch (err) {
        console.warn('[Gemini Voyager] Failed to revoke permission for', domain, err);
      }
    },
    [originPatternsForDomain, isPluginCapableDomain],
  );

  // Add website handler
  const handleAddWebsite = useCallback(async () => {
    setWebsiteError('');

    if (!newWebsiteInput.trim()) {
      return;
    }

    const normalized = normalizeUrl(newWebsiteInput);

    if (!normalized) {
      setWebsiteError(t('invalidUrl'));
      return;
    }

    // Check if already exists
    if (customWebsites.includes(normalized)) {
      setWebsiteError(t('invalidUrl'));
      return;
    }

    if (isFirefox()) {
      const granted = await requestCustomWebsitePermission(normalized);
      if (!granted) return;

      const updatedWebsites = [...customWebsites, normalized];
      setCustomWebsites(updatedWebsites);
      await setSyncStorage({ gvPromptCustomWebsites: updatedWebsites });
      setNewWebsiteInput('');
      return;
    }

    // Persist the user's selection first on non-Firefox browsers.
    // Popup may close during the permission prompt.
    const updatedWebsites = [...customWebsites, normalized];
    setCustomWebsites(updatedWebsites);
    await setSyncStorage({ gvPromptCustomWebsites: updatedWebsites });
    setNewWebsiteInput('');

    const granted = await requestCustomWebsitePermission(normalized);
    if (!granted) {
      setCustomWebsites(customWebsites);
      await setSyncStorage({ gvPromptCustomWebsites: customWebsites });
    }
  }, [
    newWebsiteInput,
    customWebsites,
    normalizeUrl,
    t,
    requestCustomWebsitePermission,
    setSyncStorage,
  ]);

  // Remove website handler
  const handleRemoveWebsite = useCallback(
    async (website: string) => {
      const updatedWebsites = customWebsites.filter((w) => w !== website);
      setCustomWebsites(updatedWebsites);
      await setSyncStorage({ gvPromptCustomWebsites: updatedWebsites });
      await revokeCustomWebsitePermission(website);
    },
    [customWebsites, revokeCustomWebsitePermission, setSyncStorage],
  );

  const toggleQuickWebsite = useCallback(
    async (domain: string, isEnabled: boolean) => {
      if (isEnabled) {
        const updated = customWebsites.filter((w) => w !== domain);
        setCustomWebsites(updated);
        await setSyncStorage({ gvPromptCustomWebsites: updated });
        await revokeCustomWebsitePermission(domain);
        return;
      }

      if (isFirefox()) {
        const granted = await requestCustomWebsitePermission(domain);
        if (!granted) return;

        const updated = [...customWebsites, domain];
        setCustomWebsites(updated);
        await setSyncStorage({ gvPromptCustomWebsites: updated });
        return;
      }

      // Persist the user's selection first on non-Firefox browsers.
      // Popup may close during the permission prompt.
      const updated = [...customWebsites, domain];
      setCustomWebsites(updated);
      await setSyncStorage({ gvPromptCustomWebsites: updated });

      const granted = await requestCustomWebsitePermission(domain);
      if (!granted) {
        setCustomWebsites(customWebsites);
        await setSyncStorage({ gvPromptCustomWebsites: customWebsites });
      }
    },
    [customWebsites, requestCustomWebsitePermission, revokeCustomWebsitePermission, setSyncStorage],
  );

  const normalizedCurrentVersion = normalizeVersionString(extVersion);
  const normalizedLatestVersion = normalizeVersionString(latestVersion);
  const isSafariBrowser = getVoyagerBuildTarget() === 'safari' || isSafari();
  const canUseSystemNotifications = supportsExtensionNotifications();
  const webStoreRatingChannel = getWebStoreRatingChannel();
  const safariUpdateReminderEnabled = isSafariBrowser && shouldShowSafariUpdateReminder();
  useEffect(() => {
    let active = true;
    if (!canUseSystemNotifications) {
      setRemoteAnnouncementPermissionGranted(false);
      return () => {
        active = false;
      };
    }
    void hasNotificationsPermission().then((granted) => {
      if (active) setRemoteAnnouncementPermissionGranted(granted);
    });
    return () => {
      active = false;
    };
  }, [canUseSystemNotifications]);

  const requestRemoteAnnouncementSystemPermission = useCallback(async () => {
    if (await ensureNotificationsPermission()) {
      setRemoteAnnouncementPermissionGranted(true);
    }
  }, []);
  const shouldShowUpdateNotification = shouldShowUpdateReminderForCurrentVersion({
    currentVersion: normalizedCurrentVersion,
    isSafariBrowser,
    safariReminderEnabled: safariUpdateReminderEnabled,
  });
  const hasUpdate =
    shouldShowUpdateNotification && normalizedCurrentVersion && normalizedLatestVersion
      ? compareVersions(normalizedLatestVersion, normalizedCurrentVersion) > 0
      : false;
  const latestReleaseTag = toReleaseTag(latestVersion ?? normalizedLatestVersion ?? undefined);
  const latestReleaseUrl = latestReleaseTag
    ? `https://github.com/Nagi-ovo/voyager/releases/tag/${latestReleaseTag}`
    : 'https://github.com/Nagi-ovo/voyager/releases/latest';
  const currentReleaseTag = toReleaseTag(extVersion);
  const releaseUrl = extVersion
    ? `https://github.com/Nagi-ovo/voyager/releases/tag/${currentReleaseTag ?? `v${extVersion}`}`
    : 'https://github.com/Nagi-ovo/voyager/releases';

  const websiteUrl =
    language === 'zh' ? 'https://voyager.nagi.fun' : `https://voyager.nagi.fun/${language}`;

  // Bundled "Fable 5 Verified" badge (public/fable-verified-badge.png). Guarded
  // so non-extension contexts (e.g. tests) don't throw on chrome.runtime.getURL.
  const fableBadgeUrl = (() => {
    try {
      return chrome?.runtime?.getURL?.('fable-verified-badge.png') ?? null;
    } catch {
      return null;
    }
  })();

  // ── Section reorder helpers ──────────────────────────────────
  const isSectionVisible = (id: PopupSectionId): boolean => {
    switch (id) {
      case 'cloudSync':
        return true;
      case 'nanobanana':
        return true;
      case 'folderTreeIndent':
      case 'sidebarBehavior':
        return !isAIStudio;
      case 'plugins':
        // The Plugins section is always rendered pinned to the top (and only on
        // sites a plugin targets). It never appears in the reorderable list.
        return false;
      default:
        return true;
    }
  };

  const visibleSections = sectionOrder.filter(isSectionVisible);
  const hasSettingsSearch = settingsSearchQuery.trim().length > 0;
  usePopupScrollRestoration({
    activeTabContextLoaded,
    hasSettingsSearch,
    isPluginSite,
    showStarredHistory,
    showStorageManager,
  });
  const settingsSearchMatches = useMemo(
    () => getSettingsSearchMatches(POPUP_SETTINGS_SEARCH_ITEMS, settingsSearchQuery),
    [settingsSearchQuery],
  );
  const settingsSearchSections = useMemo(() => {
    if (!hasSettingsSearch) return new Set<PopupSectionId>(visibleSections);
    const sections = new Set<PopupSectionId>();
    for (const item of POPUP_SETTINGS_SEARCH_ITEMS) {
      if (settingsSearchMatches.has(item.id)) sections.add(item.sectionId);
    }
    return sections;
  }, [hasSettingsSearch, settingsSearchMatches, visibleSections]);
  const displayedSections = hasSettingsSearch
    ? visibleSections.filter((id) => settingsSearchSections.has(id))
    : visibleSections;

  const getSearchTargetId = (
    sectionId: PopupSectionId,
    settingId: string,
  ): PopupSettingsSearchTargetId => `${sectionId}:${settingId}` as PopupSettingsSearchTargetId;

  const sectionTitleMatchesSearch = (sectionId: PopupSectionId): boolean =>
    settingsSearchMatches.has(getSearchTargetId(sectionId, SECTION_SEARCH_SETTING_ID));

  const shouldShowSetting = (sectionId: PopupSectionId, settingId: string): boolean =>
    !hasSettingsSearch ||
    sectionTitleMatchesSearch(sectionId) ||
    settingsSearchMatches.has(getSearchTargetId(sectionId, settingId));

  const renderSetting = (
    sectionId: PopupSectionId,
    settingId: string,
    content: React.ReactNode,
  ): React.ReactNode => (shouldShowSetting(sectionId, settingId) ? content : null);

  // Prompt data import/export/cloud-sync panel. The prompt library is global
  // (shared across Gemini, ChatGPT and Claude), so this is rendered both inside
  // the native Prompt Manager section AND, standalone, on plugin sites where
  // wrapSection() would otherwise hide the whole section.
  const renderPromptDataMigration = (): React.ReactNode => (
    <div className="space-y-2">
      <div>
        <Label className="text-sm font-medium">{t('promptDataMigration')}</Label>
        <p className="text-muted-foreground mt-1 text-xs">{t('promptDataMigrationHint')}</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={promptMigrationBusy}
          onClick={() => {
            void handlePromptExport();
          }}
        >
          <span className="inline-flex items-center gap-1.5">
            <Download className="h-3.5 w-3.5" />
            <span>{t('pm_export')}</span>
          </span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={promptMigrationBusy}
          onClick={() => promptImportInputRef.current?.click()}
        >
          <span className="inline-flex items-center gap-1.5">
            <Upload className="h-3.5 w-3.5" />
            <span>{t('pm_import')}</span>
          </span>
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={promptMigrationBusy}
          onClick={() => {
            void handlePromptCloudPull();
          }}
        >
          <span className="inline-flex items-center gap-1.5">
            <MaterialGlyphIcon path={CLOUD_SYNC_PATH} className="h-3.5 w-3.5" />
            <span>{t('promptCloudPull')}</span>
          </span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={promptMigrationBusy}
          onClick={() => {
            void handlePromptCloudPush();
          }}
        >
          <span className="inline-flex items-center gap-1.5">
            <MaterialGlyphIcon path={CLOUD_UPLOAD_PATH} className="h-3.5 w-3.5" />
            <span>{t('promptCloudPush')}</span>
          </span>
        </Button>
      </div>
      <input
        ref={promptImportInputRef}
        type="file"
        aria-label={t('pm_import')}
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => {
          void handlePromptImport(event);
        }}
      />
      {promptMigrationStatus && (
        <p
          className={`text-xs ${
            promptMigrationStatus.kind === 'ok'
              ? 'text-emerald-600 dark:text-emerald-400'
              : promptMigrationStatus.kind === 'warn'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-destructive'
          }`}
        >
          {promptMigrationStatus.text}
        </p>
      )}
    </div>
  );

  const moveSectionInOrder = (sectionId: PopupSectionId, direction: 'up' | 'down') => {
    setSectionOrder((prev) => {
      const idx = prev.indexOf(sectionId);
      if (idx === -1) return prev;

      const step = direction === 'up' ? -1 : 1;
      let swapIdx = idx + step;
      // Skip hidden sections so the swap targets the next visible one
      while (swapIdx >= 0 && swapIdx < prev.length && !isSectionVisible(prev[swapIdx])) {
        swapIdx += step;
      }
      if (swapIdx < 0 || swapIdx >= prev.length) return prev;

      const next = [...prev];
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      void setSyncStorage({ [StorageKeys.GV_POPUP_SECTION_ORDER]: next });
      return next;
    });
  };

  const wrapSection = (
    id: PopupSectionId,
    content: React.ReactNode,
    options: { allowPluginSite?: boolean } = {},
  ) => {
    // On plugin / third-party sites, keep the popup focused on the pinned
    // Plugins section only. Gemini-specific settings, including Prompt Manager
    // custom-site controls, remain available from the native Gemini/AI Studio popup.
    if (isPluginSite && !options.allowPluginSite) return null;
    if (hasSettingsSearch && !settingsSearchSections.has(id)) return null;

    return (
      <div
        key={id}
        style={{ order: sectionOrder.indexOf(id) * 2 }}
        className="group/reorder relative"
      >
        {!isPluginSite && !hasSettingsSearch && (
          <SectionReorderControls
            isFirst={displayedSections[0] === id}
            isLast={displayedSections[displayedSections.length - 1] === id}
            hasValueBadge={VALUE_BADGE_SECTION_IDS.has(id)}
            onMoveUp={() => moveSectionInOrder(id, 'up')}
            onMoveDown={() => moveSectionInOrder(id, 'down')}
            moveUpLabel={t('moveSectionUp')}
            moveDownLabel={t('moveSectionDown')}
          />
        )}
        {content}
      </div>
    );
  };

  // Show starred history if requested
  if (showStarredHistory) {
    return (
      <StarredHistory sourceTabId={sourceTabId} onClose={() => setShowStarredHistory(false)} />
    );
  }

  if (showStorageManager) {
    return (
      <div style={activeBrand ? createPopupBrandThemeStyle(activeBrand) : undefined}>
        <StorageManager
          onClose={() => setShowStorageManager(false)}
          onManageHighlights={() => {
            setShowStorageManager(false);
            setShowStarredHistory(true);
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="bg-background text-foreground w-[360px]"
      style={activeBrand ? createPopupBrandThemeStyle(activeBrand) : undefined}
    >
      {/* Header */}
      <div className="border-border/50 flex items-center justify-between border-b px-5 py-5">
        <h1 className="text-primary text-2xl font-extrabold tracking-tight">{t('extName')}</h1>
        <div className="flex items-center gap-1">
          <DarkModeToggle />
          <ThemeColorButton
            siteId={activeSiteId}
            siteLabel={activeSiteLabel}
            defaultColor={activeSiteDefault}
            value={(activeSiteId && accentColors[activeSiteId]) || null}
            onChange={handleAccentColorChange}
          />
          <LanguageSwitcher />
        </div>
      </div>

      <div className="flex flex-col gap-4 p-5">
        {!isPluginSite && (
          <div style={{ order: -3 }} className="relative">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
              aria-hidden="true"
            />
            <input
              type="search"
              value={settingsSearchQuery}
              onChange={(e) => setSettingsSearchQuery(e.target.value)}
              placeholder={t('popupSettingsSearchPlaceholder')}
              aria-label={t('popupSettingsSearchPlaceholder')}
              className="bg-card border-border focus:ring-primary/40 w-full rounded-lg border py-2 pr-9 pl-9 text-sm shadow-sm transition-all outline-none focus:ring-2"
            />
            {settingsSearchQuery && (
              <button
                type="button"
                onClick={() => setSettingsSearchQuery('')}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md transition-colors"
                aria-label={t('popupSettingsSearchClear')}
                title={t('popupSettingsSearchClear')}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        {!isPluginSite && hasSettingsSearch && displayedSections.length === 0 && (
          <Card style={{ order: -2.5 }} className="p-4 text-center" role="status">
            <p className="text-muted-foreground text-sm">{t('popupSettingsSearchNoResults')}</p>
          </Card>
        )}
        {hasUpdate && normalizedLatestVersion && normalizedCurrentVersion && (
          <Card
            style={{ order: -2 }}
            className="border-amber-200 bg-amber-50 p-3 text-amber-900 shadow-sm"
          >
            <div className="flex items-start gap-3">
              <div className="mt-1 text-amber-600">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M12 2l4 4h-3v7h-2V6H8l4-4zm6 11v6H6v-6H4v8h16v-8h-2z" />
                </svg>
              </div>
              <div className="flex-1 space-y-1">
                <p className="text-sm leading-tight font-semibold">{t('newVersionAvailable')}</p>
                <p className="text-xs leading-tight">
                  {t('currentVersionLabel')}: v{normalizedCurrentVersion} ·{' '}
                  {t('latestVersionLabel')}: v{normalizedLatestVersion}
                </p>
              </div>
              {isSafariBrowser ? (
                safariDmgUrl ? (
                  <a
                    href={safariDmgUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 rounded-md bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-200"
                  >
                    {t('updateNow')}
                  </a>
                ) : (
                  <span className="shrink-0 text-xs leading-tight text-amber-700">
                    {t('safariUpdateNotSynced')}
                  </span>
                )
              ) : (
                <a
                  href={latestReleaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 rounded-md bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-200"
                >
                  {t('updateNow')}
                </a>
              )}
            </div>
          </Card>
        )}
        {!isPluginSite && (
          <div style={{ order: sectionOrder.indexOf('cloudSync') * 2 + 1 }}>
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
                    apply({ aiStudioEnabled: e.target.checked });
                  }}
                />
              </div>
            </CardContent>
          </Card>
        )}
        {/* Cloud Sync */}
        {wrapSection('cloudSync', <CloudSyncSettings sourceTabId={sourceTabId} />)}
        {/* Prompt Manager enable toggle for third-party plugin sites (ChatGPT /
            Claude / …). Pinned ABOVE the plugin list so users who installed
            Voyager for those platforms see the onboarding action first, instead
            of scrolling past plugins to find it. */}
        {isPluginSite && activeSiteDomain && (
          <Card
            style={{ order: -2 }}
            className="border-primary/20 p-4 transition-all hover:shadow-md"
          >
            <CardContent className="p-0">
              <div className="group flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <Label
                    htmlFor="prompt-manager-site-enabled"
                    className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                  >
                    {t('enablePromptManagerOnSite').replace(
                      '{site}',
                      activeSiteLabel || activeSiteDomain,
                    )}
                  </Label>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t('enablePromptManagerOnSiteHint')}
                  </p>
                </div>
                <Switch
                  id="prompt-manager-site-enabled"
                  checked={customWebsites.includes(activeSiteDomain)}
                  onChange={() => {
                    void toggleQuickWebsite(
                      activeSiteDomain,
                      customWebsites.includes(activeSiteDomain),
                    );
                  }}
                />
              </div>
            </CardContent>
          </Card>
        )}
        {/* Prompt data import/export on plugin sites. The Prompt Manager section
            (which carries these controls on native Gemini) is hidden here by
            wrapSection, but the prompt library is global, so surface the same
            panel standalone so ChatGPT / Claude users can still migrate prompts. */}
        {isPluginSite && (
          <Card style={{ order: -2 }} className="border-primary/20 p-4">
            <CardContent className="p-0">{renderPromptDataMigration()}</CardContent>
          </Card>
        )}
        {/* Plugin ecosystem — pinned to the top on third-party web pages (just
            below the Prompt Manager toggle), scoped to plugins that target the
            active site. Hidden on native Gemini / AI Studio, where the full
            settings surface belongs. */}
        {isPluginSite && (
          <div style={{ order: -1 }}>
            <PluginManager
              manifests={siteScopedManifests}
              loading={pluginsLoading}
              onRefresh={handleRefreshPlugins}
              refreshing={pluginsRefreshing}
              activeUrl={activeUrl}
            />
          </div>
        )}
        {/* Context Sync */}
        {wrapSection('contextSync', <ContextSyncSettings sourceTabId={sourceTabId} />)}
        {/* Timeline Options */}
        {wrapSection(
          'timeline',
          <Card className="p-4 transition-all hover:shadow-md">
            <CardTitle className="mb-4">{t('timelineOptions')}</CardTitle>
            <CardContent className="space-y-4 p-0">
              <div hidden={!shouldShowSetting('timeline', 'timelineStyle')}>
                <Label className="mb-2 block text-sm font-medium">{t('timelineStyle')}</Label>
                <div className="bg-secondary/60 relative grid grid-cols-2 gap-1 rounded-xl p-1">
                  <div
                    className="bg-primary pointer-events-none absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-lg shadow-sm transition-all duration-300 ease-out"
                    style={{ left: timelineStyle === 'dots' ? '4px' : 'calc(50% + 2px)' }}
                  />
                  <button
                    className={`relative z-10 rounded-lg px-3 py-2 text-sm font-bold transition-all duration-200 ${
                      timelineStyle === 'dots'
                        ? 'text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => {
                      setTimelineStyle('dots');
                      apply({ timelineStyle: 'dots' });
                    }}
                  >
                    {t('timelineStyleDots')}
                  </button>
                  <button
                    className={`relative z-10 rounded-lg px-3 py-2 text-sm font-bold transition-all duration-200 ${
                      timelineStyle === 'compact'
                        ? 'text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => {
                      setTimelineStyle('compact');
                      apply({ timelineStyle: 'compact' });
                    }}
                  >
                    {t('timelineStyleCompact')}
                  </button>
                </div>
              </div>
              {/* Scroll Mode */}
              <div hidden={!shouldShowSetting('timeline', 'scrollMode')}>
                <Label className="mb-2 block text-sm font-medium">{t('scrollMode')}</Label>
                <div className="bg-secondary/60 relative grid grid-cols-2 gap-1 rounded-xl p-1">
                  <div
                    className="bg-primary pointer-events-none absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-lg shadow-sm transition-all duration-300 ease-out"
                    style={{ left: mode === 'flow' ? '4px' : 'calc(50% + 2px)' }}
                  />
                  <button
                    className={`relative z-10 rounded-lg px-3 py-2 text-sm font-bold transition-all duration-200 ${
                      mode === 'flow'
                        ? 'text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => {
                      setMode('flow');
                      apply({ mode: 'flow' });
                    }}
                  >
                    {t('flow')}
                  </button>
                  <button
                    className={`relative z-10 rounded-lg px-3 py-2 text-sm font-bold transition-all duration-200 ${
                      mode === 'jump'
                        ? 'text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => {
                      setMode('jump');
                      apply({ mode: 'jump' });
                    }}
                  >
                    {t('jump')}
                  </button>
                </div>
              </div>
              <div
                hidden={!shouldShowSetting('timeline', 'hideOuterContainer')}
                className="group flex items-center justify-between"
              >
                <Label
                  htmlFor="hide-container"
                  className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                >
                  {t('hideOuterContainer')}
                </Label>
                <Switch
                  id="hide-container"
                  checked={hideContainer}
                  onChange={(e) => {
                    setHideContainer(e.target.checked);
                    apply({ hideContainer: e.target.checked });
                  }}
                />
              </div>
              <div
                hidden={!shouldShowSetting('timeline', 'draggableTimeline')}
                className="group flex items-center justify-between"
              >
                <Label
                  htmlFor="draggable-timeline"
                  className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                >
                  {t('draggableTimeline')}
                </Label>
                <Switch
                  id="draggable-timeline"
                  checked={draggableTimeline}
                  onChange={(e) => {
                    setDraggableTimeline(e.target.checked);
                    apply({ draggableTimeline: e.target.checked });
                  }}
                />
              </div>
              <div
                hidden={!shouldShowSetting('timeline', 'pinTimelinePreview')}
                className="group flex items-center justify-between"
              >
                <div className="flex-1">
                  <Label
                    htmlFor="timeline-preview-pinned"
                    className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                  >
                    {t('pinTimelinePreview')}
                  </Label>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t('pinTimelinePreviewHint')}
                  </p>
                </div>
                <Switch
                  id="timeline-preview-pinned"
                  checked={timelinePreviewPinned}
                  onChange={(e) => {
                    setTimelinePreviewPinned(e.target.checked);
                    apply({ timelinePreviewPinned: e.target.checked });
                  }}
                />
              </div>
              <div
                hidden={!shouldShowSetting('timeline', 'preventAutoScroll')}
                className="group flex items-center justify-between"
              >
                <div className="flex-1">
                  <Label
                    htmlFor="prevent-auto-scroll"
                    className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                  >
                    {t('preventAutoScroll')}
                  </Label>
                  <p className="text-muted-foreground mt-1 text-xs">{t('preventAutoScrollHint')}</p>
                </div>
                <Switch
                  id="prevent-auto-scroll"
                  checked={preventAutoScrollEnabled}
                  onChange={(e) => {
                    setPreventAutoScrollEnabled(e.target.checked);
                    apply({ preventAutoScrollEnabled: e.target.checked });
                  }}
                />
              </div>
              <div
                hidden={!shouldShowSetting('timeline', 'enableMarkerLevel')}
                className="group flex items-center justify-between"
              >
                <div className="flex-1">
                  <Label
                    htmlFor="marker-level-enabled"
                    className="group-hover:text-primary flex cursor-pointer items-center gap-1 text-sm font-medium transition-colors"
                  >
                    {t('enableMarkerLevel')}
                    <span
                      className="material-symbols-outlined cursor-help text-[16px] leading-none opacity-50 transition-opacity hover:opacity-100"
                      title={t('experimentalLabel')}
                      style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}
                    >
                      experiment
                    </span>
                  </Label>
                  <p className="text-muted-foreground mt-1 text-xs">{t('enableMarkerLevelHint')}</p>
                </div>
                <Switch
                  id="marker-level-enabled"
                  checked={markerLevelEnabled}
                  onChange={(e) => {
                    setMarkerLevelEnabled(e.target.checked);
                    apply({ markerLevelEnabled: e.target.checked });
                  }}
                />
              </div>
              {/* Message Timestamps */}
              <div
                hidden={!shouldShowSetting('timeline', 'showMessageTimestamps')}
                className="group flex items-center justify-between"
              >
                <div className="flex-1">
                  <Label
                    htmlFor="show-message-timestamps"
                    className="group-hover:text-primary flex cursor-pointer items-center gap-1 text-sm font-medium transition-colors"
                  >
                    {t('showMessageTimestamps')}
                    <span
                      className="material-symbols-outlined cursor-help text-[16px] leading-none opacity-50 transition-opacity hover:opacity-100"
                      title={t('experimentalLabel')}
                      style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}
                    >
                      experiment
                    </span>
                  </Label>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t('showMessageTimestampsHint')}
                  </p>
                </div>
                <Switch
                  id="show-message-timestamps"
                  checked={showMessageTimestamps}
                  onChange={(e) => {
                    setShowMessageTimestamps(e.target.checked);
                    apply({ showMessageTimestamps: e.target.checked });
                  }}
                />
              </div>
              {/* Reset Timeline Position Button */}
              <Button
                hidden={!shouldShowSetting('timeline', 'resetTimelinePosition')}
                variant="outline"
                size="sm"
                className="group hover:border-primary/50 mt-2 w-full"
                onClick={() => {
                  apply({ resetPosition: true });
                }}
              >
                <span className="text-xs transition-transform group-hover:scale-105">
                  {t('resetTimelinePosition')}
                </span>
              </Button>
              {/* View Starred History Button */}
              <Button
                hidden={!shouldShowSetting('timeline', 'viewStarredHistory')}
                variant="outline"
                size="sm"
                className="group hover:border-primary/50 mt-2 w-full"
                onClick={() => setShowStarredHistory(true)}
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
          </Card>,
        )}
        {/* Folder Options */}
        {wrapSection(
          'folder',
          <Card className="p-4 transition-all hover:shadow-md">
            <CardTitle className="mb-4">{t('folderOptions')}</CardTitle>
            <CardContent className="space-y-4 p-0">
              <div
                hidden={!shouldShowSetting('folder', 'enableFolderFeature')}
                className="group flex items-center justify-between"
              >
                <Label
                  htmlFor="folder-enabled"
                  className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                >
                  {t('enableFolderFeature')}
                </Label>
                <Switch
                  id="folder-enabled"
                  checked={folderEnabled}
                  onChange={(e) => {
                    setFolderEnabled(e.target.checked);
                    apply({ folderEnabled: e.target.checked });
                  }}
                />
              </div>
              <div
                hidden={!shouldShowSetting('folder', 'enableFolderFloatingMode')}
                className="group flex items-center justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <Label
                    htmlFor="floating-mode"
                    className="group-hover:text-primary flex cursor-pointer items-center gap-1 text-sm font-medium transition-colors"
                  >
                    {t('enableFolderFloatingMode')}
                    <span
                      className="material-symbols-outlined cursor-help text-[16px] leading-none opacity-50 transition-opacity hover:opacity-100"
                      title={t('experimentalLabel')}
                      style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}
                    >
                      experiment
                    </span>
                  </Label>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t('enableFolderFloatingModeHint')}
                  </p>
                </div>
                <Switch
                  id="floating-mode"
                  checked={floatingModeEnabled}
                  onChange={(e) => {
                    setFloatingModeEnabled(e.target.checked);
                    apply({ floatingModeEnabled: e.target.checked });
                  }}
                />
              </div>
              {floatingModeEnabled &&
                shouldShowSetting('folder', 'openFloatingFolderOnStartup') && (
                  <div className="group flex items-center justify-between gap-3 pl-4">
                    <div className="min-w-0 flex-1">
                      <Label
                        htmlFor="floating-open-on-start"
                        className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                      >
                        {t('openFloatingFolderOnStartup')}
                      </Label>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {t('openFloatingFolderOnStartupHint')}
                      </p>
                    </div>
                    <Switch
                      id="floating-open-on-start"
                      checked={floatingOpenOnStart}
                      onChange={(e) => {
                        setFloatingOpenOnStart(e.target.checked);
                        apply({ floatingOpenOnStart: e.target.checked });
                      }}
                    />
                  </div>
                )}
              <div
                hidden={!shouldShowSetting('folder', 'hideArchivedConversations')}
                className="group flex items-center justify-between"
              >
                <Label
                  htmlFor="hide-archived"
                  className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                >
                  {t('hideArchivedConversations')}
                </Label>
                <Switch
                  id="hide-archived"
                  checked={hideArchivedConversations}
                  onChange={(e) => {
                    setHideArchivedConversations(e.target.checked);
                    apply({ hideArchivedConversations: e.target.checked });
                  }}
                />
              </div>
              <div
                hidden={!shouldShowSetting('folder', 'showFolderSearch')}
                className="group flex items-center justify-between"
              >
                <Label
                  htmlFor="folder-search-enabled"
                  className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                >
                  {t('showFolderSearch')}
                </Label>
                <Switch
                  id="folder-search-enabled"
                  checked={folderSearchEnabled}
                  onChange={(e) => {
                    setFolderSearchEnabled(e.target.checked);
                    apply({ folderSearchEnabled: e.target.checked });
                  }}
                />
              </div>
              <div
                hidden={!shouldShowSetting('folder', 'enableForkFeature')}
                className="group flex items-center justify-between"
              >
                <div className="flex-1">
                  <Label
                    htmlFor="fork-enabled"
                    className="group-hover:text-primary flex cursor-pointer items-center gap-1 text-sm font-medium transition-colors"
                  >
                    {t('enableForkFeature')}
                    <span
                      className="material-symbols-outlined cursor-help text-[16px] leading-none opacity-50 transition-opacity hover:opacity-100"
                      title={t('experimentalLabel')}
                      style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}
                    >
                      experiment
                    </span>
                  </Label>
                  <p className="text-muted-foreground mt-1 text-xs">{t('enableForkFeatureHint')}</p>
                </div>
                <Switch
                  id="fork-enabled"
                  checked={forkEnabled}
                  onChange={(e) => {
                    setForkEnabled(e.target.checked);
                    apply({ forkEnabled: e.target.checked });
                  }}
                />
              </div>
              <div
                hidden={!shouldShowSetting('folder', 'enableAccountIsolation')}
                className="group flex items-center justify-between"
              >
                <div className="flex-1">
                  <Label
                    htmlFor="account-isolation-enabled"
                    className="group-hover:text-primary flex cursor-pointer items-center gap-1 text-sm font-medium transition-colors"
                  >
                    {t('enableAccountIsolation')}
                    <span
                      className="material-symbols-outlined cursor-help text-[16px] leading-none opacity-50 transition-opacity hover:opacity-100"
                      title={t('experimentalLabel')}
                      style={{
                        fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20",
                      }}
                    >
                      experiment
                    </span>
                  </Label>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t('enableAccountIsolationHint')}
                  </p>
                  <div className="mt-1 flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">{t('currentPlatform')}:</span>
                    <span className="bg-secondary text-foreground rounded px-1.5 py-0.5 font-medium">
                      {currentPlatformLabel}
                    </span>
                  </div>
                </div>
                <Switch
                  id="account-isolation-enabled"
                  checked={
                    isAIStudio ? accountIsolationEnabledAIStudio : accountIsolationEnabledGemini
                  }
                  onChange={(e) => {
                    if (isAIStudio) {
                      setAccountIsolationEnabledAIStudio(e.target.checked);
                    } else {
                      setAccountIsolationEnabledGemini(e.target.checked);
                    }
                    apply({
                      accountIsolationEnabled: e.target.checked,
                      accountIsolationPlatform: activeAccountPlatform,
                    });
                  }}
                />
              </div>
              <div
                hidden={!shouldShowSetting('folder', 'folderAsProject')}
                className="group flex items-center justify-between"
              >
                <div className="flex-1">
                  <Label
                    htmlFor="folder-project-enabled"
                    className="group-hover:text-primary flex cursor-pointer items-center gap-1 text-sm font-medium transition-colors"
                  >
                    {t('folderAsProject_enable')}
                    <span
                      className="material-symbols-outlined cursor-help text-[16px] leading-none opacity-50 transition-opacity hover:opacity-100"
                      title={t('experimentalLabel')}
                      style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}
                    >
                      experiment
                    </span>
                  </Label>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t('folderAsProject_description')}
                  </p>
                </div>
                <Switch
                  id="folder-project-enabled"
                  checked={folderProjectEnabled}
                  onChange={(e) => {
                    setFolderProjectEnabled(e.target.checked);
                    apply({ folderProjectEnabled: e.target.checked });
                  }}
                />
              </div>
              {/* Copy folder structure for AI organization */}
              <div
                hidden={!shouldShowSetting('folder', 'aiOrgCopy')}
                className="border-border/50 border-t pt-3"
              >
                <Button
                  variant="outline"
                  className="w-full text-sm"
                  onClick={handleCopyFolderStructureForAI}
                  disabled={aiStructureCopyStatus === 'loading'}
                >
                  <span className="inline-flex items-center justify-center gap-1.5">
                    <span
                      className="material-symbols-outlined translate-y-px text-[16px] leading-none"
                      style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}
                    >
                      {aiStructureCopyStatus === 'copied' ? 'check' : 'content_copy'}
                    </span>
                    <span className="leading-5">
                      {aiStructureCopyStatus === 'copied'
                        ? t('aiOrgCopied')
                        : aiStructureCopyStatus === 'empty'
                          ? t('aiOrgNoConversations')
                          : aiStructureCopyStatus === 'error'
                            ? t('aiOrgError')
                            : t('aiOrgCopyButton')}
                    </span>
                  </span>
                </Button>
                <p className="text-muted-foreground mt-1.5 text-center text-[11px] leading-tight">
                  {t('aiOrgCopyHint')}
                </p>
              </div>
            </CardContent>
          </Card>,
        )}
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
        {!isAIStudio &&
          wrapSection(
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
        {/* Gems sidebar — only on gemini.google.com, not AI Studio */}
        {!isAIStudio &&
          wrapSection(
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
            onToggle={(v) => {
              setChatWidthEnabled(v);
              try {
                chrome.storage?.sync?.set({ gvChatWidthEnabled: v });
              } catch {}
            }}
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
            onToggle={(v) => {
              setChatFontSizeEnabled(v);
              try {
                chrome.storage?.sync?.set({ [StorageKeys.CHAT_FONT_SIZE_ENABLED]: v });
              } catch {}
            }}
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
            onToggle={(v) => {
              setChatLineHeightEnabled(v);
              try {
                chrome.storage?.sync?.set({ [StorageKeys.CHAT_LINE_HEIGHT_ENABLED]: v });
              } catch {}
            }}
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
            onToggle={(v) => {
              setEditInputWidthEnabled(v);
              try {
                chrome.storage?.sync?.set({ gvEditInputWidthEnabled: v });
              } catch {}
            }}
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
            onToggle={(v) => {
              setSidebarWidthEnabled(v);
              try {
                chrome.storage?.sync?.set({ gvSidebarWidthEnabled: v });
              } catch {}
            }}
          />,
        )}

        {/* Sidebar Auto-Hide & Full-Hide - Gemini only */}
        {!isAIStudio &&
          wrapSection(
            'sidebarBehavior',
            <Card className="p-4 transition-all hover:shadow-md">
              <CardContent className="space-y-3 p-0">
                <div
                  hidden={!shouldShowSetting('sidebarBehavior', 'sidebarAutoHide')}
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
                    onChange={(e) => {
                      setSidebarAutoHideEnabled(e.target.checked);
                      apply({ sidebarAutoHideEnabled: e.target.checked });
                    }}
                  />
                </div>
                <div
                  hidden={!shouldShowSetting('sidebarBehavior', 'sidebarFullHide')}
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
                    onChange={(e) => {
                      setSidebarFullHideEnabled(e.target.checked);
                      apply({ sidebarFullHideEnabled: e.target.checked });
                    }}
                  />
                </div>
              </CardContent>
            </Card>,
          )}

        {/* Platform-neutral visual effects. Third-party sites expose this only
            after Prompt Manager or a matching plugin has activated the site. */}
        {visualEffectsAvailable &&
          wrapSection(
            'visualEffect',
            <Card className="p-4 transition-all hover:shadow-md">
              <CardContent className="p-0">
                <div className="flex-1">
                  <Label className="text-sm font-medium">{t('visualEffect')}</Label>
                  <p className="text-muted-foreground mt-1 text-xs">{t('visualEffectHint')}</p>
                </div>
                <div className="bg-secondary/60 mt-3 flex items-center gap-0.5 rounded-full p-1">
                  {(
                    [
                      {
                        value: 'off' as const,
                        label: t('visualEffectOff'),
                        icon: (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <circle cx="12" cy="12" r="10" />
                            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                          </svg>
                        ),
                      },
                      {
                        value: 'snow' as const,
                        label: t('visualEffectSnow'),
                        icon: (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <line x1="12" y1="2" x2="12" y2="22" />
                            <line x1="2" y1="12" x2="22" y2="12" />
                            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                            <line x1="19.07" y1="4.93" x2="4.93" y2="19.07" />
                            <line x1="12" y1="2" x2="14.5" y2="4.5" />
                            <line x1="12" y1="2" x2="9.5" y2="4.5" />
                            <line x1="12" y1="22" x2="14.5" y2="19.5" />
                            <line x1="12" y1="22" x2="9.5" y2="19.5" />
                            <line x1="2" y1="12" x2="4.5" y2="9.5" />
                            <line x1="2" y1="12" x2="4.5" y2="14.5" />
                            <line x1="22" y1="12" x2="19.5" y2="9.5" />
                            <line x1="22" y1="12" x2="19.5" y2="14.5" />
                          </svg>
                        ),
                      },
                      {
                        value: 'sakura' as const,
                        label: t('visualEffectSakura'),
                        icon: (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <g transform="translate(12,12)">
                              {[0, 72, 144, 216, 288].map((deg) => (
                                <ellipse
                                  key={deg}
                                  cx="0"
                                  cy="-6"
                                  rx="2.8"
                                  ry="5.5"
                                  transform={`rotate(${deg})`}
                                  opacity="0.85"
                                />
                              ))}
                              <circle cx="0" cy="0" r="2" opacity="0.6" />
                            </g>
                          </svg>
                        ),
                      },
                      {
                        value: 'rain' as const,
                        label: t('visualEffectRain'),
                        icon: (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                          >
                            <line x1="8" y1="3" x2="6.5" y2="10" />
                            <line x1="14" y1="2" x2="12.5" y2="9" />
                            <line x1="20" y1="4" x2="18.5" y2="11" />
                            <line x1="5" y1="12" x2="3.5" y2="19" />
                            <line x1="11" y1="11" x2="9.5" y2="18" />
                            <line x1="17" y1="13" x2="15.5" y2="20" />
                          </svg>
                        ),
                      },
                    ] as const
                  ).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        setVisualEffect(option.value);
                        apply({ visualEffect: option.value });
                      }}
                      className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-1.5 text-xs font-bold transition-all duration-200 ${
                        visualEffect === option.value
                          ? 'bg-background text-foreground shadow-md'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {option.icon}
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>,
            { allowPluginSite: true },
          )}

        {/* Formula Copy Options */}
        {wrapSection(
          'formulaCopy',
          <Card className="p-4 transition-all hover:shadow-md">
            <CardTitle className="mb-4">{t('formulaCopyFormat')}</CardTitle>
            <CardContent className="space-y-3 p-0">
              <p className="text-muted-foreground mb-3 text-xs">{t('formulaCopyFormatHint')}</p>
              <div className="space-y-2">
                <label className="flex cursor-pointer items-center space-x-3">
                  <input
                    type="radio"
                    name="formulaCopyFormat"
                    value="latex"
                    checked={formulaCopyFormat === 'latex'}
                    onChange={handleFormulaCopyFormatChange}
                    className="h-4 w-4"
                  />
                  <span className="text-sm">{t('formulaCopyFormatLatex')}</span>
                </label>
                <label className="flex cursor-pointer items-center space-x-3">
                  <input
                    type="radio"
                    name="formulaCopyFormat"
                    value="unicodemath"
                    checked={formulaCopyFormat === 'unicodemath'}
                    onChange={handleFormulaCopyFormatChange}
                    className="h-4 w-4"
                  />
                  <span className="text-sm">{t('formulaCopyFormatUnicodeMath')}</span>
                </label>
                <label className="flex cursor-pointer items-center space-x-3">
                  <input
                    type="radio"
                    name="formulaCopyFormat"
                    value="no-dollar"
                    checked={formulaCopyFormat === 'no-dollar'}
                    onChange={handleFormulaCopyFormatChange}
                    className="h-4 w-4"
                  />
                  <span className="text-sm">{t('formulaCopyFormatNoDollar')}</span>
                </label>
                <label className="flex cursor-pointer items-center space-x-3">
                  <input
                    type="radio"
                    name="formulaCopyFormat"
                    value="notion"
                    checked={formulaCopyFormat === 'notion'}
                    onChange={handleFormulaCopyFormatChange}
                    className="h-4 w-4"
                  />
                  <span className="text-sm">{t('formulaCopyFormatNotion')}</span>
                </label>
              </div>
            </CardContent>
          </Card>,
        )}

        {/* Keyboard Shortcuts */}
        {wrapSection('keyboardShortcuts', <KeyboardShortcutSettings />)}

        {/* Input Collapse Options */}
        {wrapSection(
          'inputCollapse',
          <Card className="p-4 transition-all hover:shadow-md">
            <CardTitle className="mb-4">{t('inputCollapseOptions')}</CardTitle>
            <CardContent className="space-y-4 p-0">
              {renderSetting(
                'inputCollapse',
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
                      setInputCollapseEnabled(e.target.checked);
                      apply({ inputCollapseEnabled: e.target.checked });
                    }}
                  />
                </div>,
              )}
              {/* Second toggle - Allow collapse when not empty (only visible when first is enabled) */}
              {inputCollapseEnabled &&
                renderSetting(
                  'inputCollapse',
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
                        setInputCollapseWhenNotEmpty(e.target.checked);
                        apply({ inputCollapseWhenNotEmpty: e.target.checked });
                      }}
                    />
                  </div>,
                )}
              {renderSetting(
                'inputCollapse',
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
                      setInputVimModeEnabled(e.target.checked);
                      apply({ inputVimModeEnabled: e.target.checked });
                    }}
                  />
                </div>,
              )}
              {renderSetting(
                'inputCollapse',
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
                        setAiStudioEnterSendEnabled(e.target.checked);
                        apply({ aiStudioEnterSendEnabled: e.target.checked });
                      } else {
                        setCtrlEnterSendEnabled(e.target.checked);
                        apply({ ctrlEnterSendEnabled: e.target.checked });
                      }
                    }}
                  />
                </div>,
              )}
              {/* Safari Enter Fix - only shown on Safari */}
              {isSafariBrowser &&
                renderSetting(
                  'inputCollapse',
                  'safariEnterFix',
                  <div className="group flex items-center justify-between">
                    <div className="flex-1">
                      <Label
                        htmlFor="safari-enter-fix"
                        className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                      >
                        {t('safariEnterFix')}
                      </Label>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {t('safariEnterFixHint')}
                      </p>
                    </div>
                    <Switch
                      id="safari-enter-fix"
                      checked={safariEnterFixEnabled}
                      onChange={(e) => {
                        setSafariEnterFixEnabled(e.target.checked);
                        apply({ safariEnterFixEnabled: e.target.checked });
                      }}
                    />
                  </div>,
                )}
              {/* Draft Auto-Save */}
              {renderSetting(
                'inputCollapse',
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
                      setDraftAutoSaveEnabled(e.target.checked);
                      apply({ draftAutoSaveEnabled: e.target.checked });
                    }}
                  />
                </div>,
              )}
            </CardContent>
          </Card>,
        )}

        {/* Prompt Manager Options */}
        {wrapSection(
          'promptManager',
          <Card className="p-4 transition-all hover:shadow-md">
            <CardTitle className="mb-4">{t('promptManagerOptions')}</CardTitle>
            <CardContent className="space-y-3 p-0">
              {/* Hide Prompt Manager Toggle */}
              {renderSetting(
                'promptManager',
                'hidePromptManager',
                <div className="group flex items-center justify-between">
                  <div className="flex-1">
                    <Label
                      htmlFor="hide-prompt-manager"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('hidePromptManager')}
                    </Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('hidePromptManagerHint')}
                    </p>
                  </div>
                  <Switch
                    id="hide-prompt-manager"
                    checked={hidePromptManager}
                    onChange={(e) => {
                      setHidePromptManager(e.target.checked);
                      apply({ hidePromptManager: e.target.checked });
                    }}
                  />
                </div>,
              )}
              {renderSetting(
                'promptManager',
                'slashPromptEnabled',
                <div className="group flex items-center justify-between">
                  <div className="flex-1">
                    <Label
                      htmlFor="slash-prompt-enabled"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('slashPromptEnabled')}
                    </Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('slashPromptEnabledHint')}
                    </p>
                  </div>
                  <Switch
                    id="slash-prompt-enabled"
                    checked={slashPromptEnabled}
                    onChange={(e) => {
                      setSlashPromptEnabled(e.target.checked);
                      apply({ slashPromptEnabled: e.target.checked });
                    }}
                  />
                </div>,
              )}
              {renderSetting(
                'promptManager',
                'promptInsertOnClick',
                <div className="group flex items-center justify-between">
                  <div className="flex-1">
                    <Label
                      htmlFor="prompt-insert-on-click"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('promptInsertOnClick')}
                    </Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('promptInsertOnClickHint')}
                    </p>
                  </div>
                  <Switch
                    id="prompt-insert-on-click"
                    checked={promptInsertOnClickEnabled}
                    onChange={(e) => {
                      setPromptInsertOnClickEnabled(e.target.checked);
                      apply({ promptInsertOnClickEnabled: e.target.checked });
                    }}
                  />
                </div>,
              )}
              {renderSetting('promptManager', 'promptDataMigration', renderPromptDataMigration())}
              {renderSetting(
                'promptManager',
                'customWebsites',
                <div>
                  <Label className="mb-2 block text-sm font-medium">{t('customWebsites')}</Label>
                  {/* Gemini-default notice — only meaningful on Gemini itself, so
                    hide it on Claude/ChatGPT where the user is already off-Gemini. */}
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

                  {/* Quick-select buttons for popular websites. ChatGPT / Claude are
                    ALSO plugin platforms, but the Prompt Manager is a separate
                    feature — a plugin can't enable it — so keep the quick toggles
                    here. The plugin-site exclusion in the background only blocks
                    *auto*-adding these domains on a plugin permission grant; an
                    explicit toggle here still enables the Prompt Manager on them. */}
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {[
                      { domain: 'chatgpt.com', label: 'ChatGPT', Icon: IconChatGPT },
                      { domain: 'claude.ai', label: 'Claude', Icon: IconClaude },
                      { domain: 'deepseek.com', label: 'DeepSeek', Icon: IconDeepSeek },
                      { domain: 'qwen.ai', label: 'Qwen', Icon: IconQwen },
                      { domain: 'kimi.com', label: 'Kimi', Icon: IconKimi },
                      {
                        domain: 'notebooklm.google.com',
                        label: 'NotebookLM',
                        Icon: IconNotebookLM,
                      },
                      { domain: 'midjourney.com', label: 'Midjourney', Icon: IconMidjourney },
                    ].map(({ domain, label, Icon }) => {
                      const isEnabled = customWebsites.includes(domain);
                      return (
                        <button
                          key={domain}
                          onClick={() => {
                            void toggleQuickWebsite(domain, isEnabled);
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

                  {/* Website List */}
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
                              void handleRemoveWebsite(website);
                            }}
                            className="text-destructive hover:text-destructive/80 text-xs font-medium opacity-70 transition-opacity group-hover:opacity-100"
                          >
                            {t('removeWebsite')}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add Website Input */}
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <input
                        type="text"
                        value={newWebsiteInput}
                        onChange={(e) => {
                          setNewWebsiteInput(e.target.value);
                          setWebsiteError('');
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            void handleAddWebsite();
                          }
                        }}
                        placeholder={t('customWebsitesPlaceholder')}
                        className="bg-background border-border focus:ring-primary/50 min-w-0 flex-1 rounded-md border px-3 py-2 text-sm transition-all focus:ring-2 focus:outline-none"
                      />
                      <Button
                        onClick={() => {
                          void handleAddWebsite();
                        }}
                        size="sm"
                        className="shrink-0 whitespace-nowrap"
                      >
                        {t('addWebsite')}
                      </Button>
                    </div>
                    {websiteError && <p className="text-destructive text-xs">{websiteError}</p>}
                  </div>

                  {/* Note about reloading */}
                  <div className="bg-primary/5 border-primary/20 mt-3 rounded-md border p-2">
                    <p className="text-muted-foreground text-xs">{t('customWebsitesNote')}</p>
                  </div>
                </div>,
              )}
            </CardContent>
          </Card>,
        )}

        {/* General Options */}
        {wrapSection(
          'general',
          <Card className="p-4 transition-all hover:shadow-md">
            <CardTitle className="mb-4">{t('generalOptions')}</CardTitle>
            <CardContent className="space-y-4 p-0">
              {renderSetting(
                'general',
                'enableTabTitleUpdate',
                <div className="flex items-center justify-between opacity-60">
                  <div className="flex-1">
                    <Label
                      htmlFor="tab-title-update"
                      className="text-muted-foreground cursor-not-allowed text-sm font-medium"
                    >
                      {t('enableTabTitleUpdate')}
                    </Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('enableTabTitleUpdateHint')}
                    </p>
                  </div>
                  <Switch id="tab-title-update" checked={false} disabled className="opacity-70" />
                </div>,
              )}
              {renderSetting(
                'general',
                'persistentExportToolbar',
                <div className="group flex items-center justify-between">
                  <div className="flex-1">
                    <Label
                      htmlFor="persistent-export-toolbar"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('persistentExportToolbar')}
                    </Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('persistentExportToolbarHint')}
                    </p>
                  </div>
                  <Switch
                    id="persistent-export-toolbar"
                    checked={persistentExportToolbarEnabled}
                    onChange={(e) => {
                      setPersistentExportToolbarEnabled(e.target.checked);
                      apply({ persistentExportToolbarEnabled: e.target.checked });
                    }}
                  />
                </div>,
              )}
              {renderSetting(
                'general',
                'enableMermaidRendering',
                <div className="group flex items-center justify-between">
                  <div className="flex-1">
                    <Label
                      htmlFor="mermaid-enabled"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('enableMermaidRendering')}
                    </Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('enableMermaidRenderingHint')}
                    </p>
                  </div>
                  <Switch
                    id="mermaid-enabled"
                    checked={mermaidEnabled}
                    onChange={(e) => {
                      setMermaidEnabled(e.target.checked);
                      apply({ mermaidEnabled: e.target.checked });
                    }}
                  />
                </div>,
              )}
              {renderSetting(
                'general',
                'enableQuoteReply',
                <div className="group flex items-center justify-between">
                  <div className="flex-1">
                    <Label
                      htmlFor="quote-reply-enabled"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('enableQuoteReply')}
                    </Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('enableQuoteReplyHint')}
                    </p>
                  </div>
                  <Switch
                    id="quote-reply-enabled"
                    checked={quoteReplyEnabled}
                    onChange={(e) => {
                      setQuoteReplyEnabled(e.target.checked);
                      apply({ quoteReplyEnabled: e.target.checked });
                    }}
                  />
                </div>,
              )}
              {renderSetting(
                'general',
                'enableHighlights',
                <div className="group flex items-center justify-between">
                  <div className="flex-1">
                    <Label
                      htmlFor="highlights-enabled"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('enableHighlights')}
                    </Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('enableHighlightsHint')}
                    </p>
                  </div>
                  <Switch
                    id="highlights-enabled"
                    checked={highlightEnabled}
                    onChange={(e) => {
                      setHighlightEnabled(e.target.checked);
                      apply({ highlightEnabled: e.target.checked });
                    }}
                  />
                </div>,
              )}
              {renderSetting(
                'general',
                'showHighlightTimelineMarkers',
                <div className="group flex items-center justify-between">
                  <div className="flex-1">
                    <Label
                      htmlFor="highlight-timeline-markers-enabled"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('showHighlightTimelineMarkers')}
                    </Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('showHighlightTimelineMarkersHint')}
                    </p>
                  </div>
                  <Switch
                    id="highlight-timeline-markers-enabled"
                    checked={highlightTimelineMarkersEnabled}
                    disabled={!highlightEnabled}
                    onChange={(e) => {
                      setHighlightTimelineMarkersEnabled(e.target.checked);
                      apply({ highlightTimelineMarkersEnabled: e.target.checked });
                    }}
                  />
                </div>,
              )}
              {renderSetting(
                'general',
                'responseCompleteNotification',
                <div className="group flex items-center justify-between">
                  <div className="flex-1">
                    <Label
                      htmlFor="response-complete-notification"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('responseCompleteNotification')}
                    </Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t(
                        isSafariBrowser
                          ? 'responseCompleteNotificationHintSafari'
                          : 'responseCompleteNotificationHint',
                      )}
                    </p>
                  </div>
                  <Switch
                    id="response-complete-notification"
                    checked={responseCompleteNotificationEnabled}
                    onChange={async (e) => {
                      const next = e.target.checked;
                      if (next && isSafariBrowser) {
                        setResponseCompleteNotificationEnabled(true);
                        const granted = await requestSafariNativeNotificationPermission();
                        setResponseCompleteNotificationEnabled(granted);
                        return;
                      }
                      if (next) {
                        const granted = await ensureNotificationsPermission();
                        if (!granted) {
                          setResponseCompleteNotificationEnabled(false);
                          return;
                        }
                      }
                      if (next) setRemoteAnnouncementPermissionGranted(true);
                      setResponseCompleteNotificationEnabled(next);
                      apply({ responseCompleteNotificationEnabled: next });
                    }}
                  />
                </div>,
              )}
              {renderSetting(
                'general',
                'remoteAnnouncementNotification',
                <div className="group flex items-center justify-between">
                  <div className="flex-1">
                    <Label
                      htmlFor="remote-announcement-notification"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('remoteAnnouncementNotification')}
                    </Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('remoteAnnouncementNotificationHint')}
                    </p>
                    {remoteAnnouncementEnabled &&
                      canUseSystemNotifications &&
                      !remoteAnnouncementPermissionGranted && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="mt-2 h-7 px-2.5 text-xs"
                          onClick={requestRemoteAnnouncementSystemPermission}
                        >
                          {t('remoteAnnouncementSystemPermissionCta')}
                        </Button>
                      )}
                  </div>
                  <Switch
                    id="remote-announcement-notification"
                    checked={remoteAnnouncementEnabled}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setRemoteAnnouncementEnabled(next);
                      apply({ remoteAnnouncementEnabled: next });
                    }}
                  />
                </div>,
              )}
              {renderSetting(
                'general',
                'changelogBadgeMode',
                <div className="group flex items-center justify-between">
                  <div className="flex-1">
                    <Label
                      htmlFor="changelog-notify-badge"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('changelog_badge_mode')}
                    </Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('changelog_badge_mode_hint')}
                    </p>
                  </div>
                  <Switch
                    id="changelog-notify-badge"
                    checked={changelogBadgeMode}
                    onChange={(e) => handleChangelogBadgeModeChange(e.target.checked)}
                  />
                </div>,
              )}
              {renderSetting(
                'general',
                'usageStatusToggle',
                <div className="group flex items-center justify-between">
                  <div className="flex-1">
                    <Label
                      htmlFor="usage-status-enabled"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('usageStatusToggle')}
                    </Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('usageStatusToggleHint')}
                    </p>
                  </div>
                  <Switch
                    id="usage-status-enabled"
                    checked={usageStatusEnabled}
                    onChange={(e) => {
                      setUsageStatusEnabled(e.target.checked);
                      apply({ usageStatusEnabled: e.target.checked });
                    }}
                  />
                </div>,
              )}
              {renderSetting(
                'general',
                'hideInputHalo',
                <div className="group flex items-center justify-between">
                  <div className="flex-1">
                    <Label
                      htmlFor="input-halo-hidden"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('hideInputHalo')}
                    </Label>
                    <p className="text-muted-foreground mt-1 text-xs">{t('hideInputHaloHint')}</p>
                  </div>
                  <Switch
                    id="input-halo-hidden"
                    checked={inputHaloHidden}
                    onChange={(e) => {
                      setInputHaloHidden(e.target.checked);
                      apply({ inputHaloHidden: e.target.checked });
                    }}
                  />
                </div>,
              )}
              {renderSetting(
                'general',
                'enableDefaultModelAutoApply',
                <div className="group flex items-center justify-between">
                  <div className="flex-1">
                    <Label
                      htmlFor="default-model-auto-apply"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('enableDefaultModelAutoApply')}
                    </Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('enableDefaultModelAutoApplyHint')}
                    </p>
                  </div>
                  <Switch
                    id="default-model-auto-apply"
                    checked={defaultModelAutoApplyEnabled}
                    onChange={(e) => {
                      setDefaultModelAutoApplyEnabled(e.target.checked);
                      apply({ defaultModelAutoApplyEnabled: e.target.checked });
                    }}
                  />
                </div>,
              )}
            </CardContent>
          </Card>,
        )}

        {/* Image Refinement Options */}
        {wrapSection(
          'nanobanana',
          <Card className="p-4 transition-all hover:shadow-md">
            <CardTitle className="mb-4">{t('nanobananaOptions')}</CardTitle>
            <CardContent className="space-y-4 p-0">
              <div
                hidden={!shouldShowSetting('nanobanana', 'download')}
                className="group flex items-center justify-between"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-1.5">
                    <Label
                      htmlFor="watermark-download"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('nanobananaDownloadLabel')}
                    </Label>
                    <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-600 uppercase dark:text-emerald-400">
                      {t('nanobananaBadgeRecommended')}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t('nanobananaDownloadHint')}
                  </p>
                </div>
                <Switch
                  id="watermark-download"
                  checked={watermarkDownloadEnabled}
                  onChange={(e) => {
                    setWatermarkDownloadEnabled(e.target.checked);
                    apply({ watermarkDownloadEnabled: e.target.checked });
                  }}
                />
              </div>
              <div
                hidden={!shouldShowSetting('nanobanana', 'preview')}
                className="group flex items-center justify-between"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-1.5">
                    <Label
                      htmlFor="watermark-preview"
                      className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
                    >
                      {t('nanobananaPreviewLabel')}
                    </Label>
                    <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-600 uppercase dark:text-amber-400">
                      {t('nanobananaBadgeUnstable')}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1 text-xs">{t('nanobananaPreviewHint')}</p>
                </div>
                <Switch
                  id="watermark-preview"
                  checked={watermarkPreviewEnabled}
                  onChange={(e) => {
                    setWatermarkPreviewEnabled(e.target.checked);
                    apply({ watermarkPreviewEnabled: e.target.checked });
                  }}
                />
              </div>
            </CardContent>
          </Card>,
        )}
      </div>

      {/* Footer */}
      <div className="border-border/50 flex flex-col gap-3 border-t px-5 py-4">
        <DiagnosticsExportCard
          activeUrl={activeUrl}
          loading={pluginsLoading || !pluginStateLoaded}
          plugins={diagnosticPlugins}
        />

        <div className="flex w-full items-center justify-between">
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <span className="text-foreground/80 font-semibold">{t('extensionVersion')}</span>
            <a
              href={releaseUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:text-primary/80 font-semibold transition-colors"
              title={extVersion ? extVersion : undefined}
            >
              {extVersion ?? '...'}
            </a>
            {fableBadgeUrl && (
              <a
                href="https://github.com/yetone/alma-releases/issues/56"
                target="_blank"
                rel="noreferrer"
                className="flex items-center opacity-75 transition-opacity hover:opacity-100"
                title={t('fableVerifiedBadgeAlt')}
                aria-label={t('fableVerifiedBadgeAlt')}
              >
                <img
                  src={fableBadgeUrl}
                  alt={t('fableVerifiedBadgeAlt')}
                  className="h-[40px] w-auto"
                />
              </a>
            )}
          </div>

          <a
            href={websiteUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-primary flex items-center gap-1.5 text-xs font-semibold transition-colors"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="2" y1="12" x2="22" y2="12"></line>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>
            {t('officialDocs')}
          </a>
        </div>

        {webStoreRatingChannel && (
          <a
            href={
              webStoreRatingChannel === 'edge'
                ? 'https://microsoftedge.microsoft.com/addons/detail/voyager/gibmkggjijalcjinbdhcpklodjkhhlne'
                : 'https://chromewebstore.google.com/detail/gemini-voyager/iifacdnjakkhjjiengaffnegbndgingi'
            }
            target="_blank"
            rel="noreferrer"
            className="group hover:border-primary/30 flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs shadow-sm transition-[border-color,box-shadow] hover:shadow-md"
          >
            <span className="text-base leading-none" aria-hidden="true">
              ⭐
            </span>
            <span className="flex-1 leading-snug text-slate-700">
              {webStoreRatingChannel === 'edge'
                ? t('changelog_rate_edge')
                : t('changelog_rate_chrome')}
            </span>
            <span className="text-primary font-semibold whitespace-nowrap transition-transform group-hover:translate-x-0.5">
              {`${webStoreRatingChannel === 'edge' ? t('changelog_rate_edge_cta') : t('changelog_rate_chrome_cta')} →`}
            </span>
          </a>
        )}

        <a
          href="https://github.com/Nagi-ovo/voyager"
          target="_blank"
          rel="noreferrer"
          className="bg-primary hover:bg-primary/90 text-primary-foreground hover:shadow-primary/25 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold tracking-wide transition-all hover:scale-[1.02] hover:shadow-lg active:scale-[0.97]"
          title={t('starProject')}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          <span>{t('starProject')}</span>
        </a>
      </div>
    </div>
  );
}
