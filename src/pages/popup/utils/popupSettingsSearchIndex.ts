import type { TranslationKey } from '@/utils/translations';

import {
  type NativePopupSectionId as PopupSectionId,
  POPUP_SECTION_SEARCH_SETTING_ID,
} from './nativeSiteCapabilities';
import type { SettingsSearchItem } from './settingsSearch';

export type PopupSettingsSearchTargetId = `${PopupSectionId}:${string}`;

interface PopupSettingsSearchItem extends SettingsSearchItem<PopupSettingsSearchTargetId> {
  sectionId: PopupSectionId;
  settingId: string;
}

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
  return popupSearchTarget(sectionId, POPUP_SECTION_SEARCH_SETTING_ID, keys, aliases);
}

export const POPUP_SETTINGS_SEARCH_ITEMS = [
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
    'timelineStyleRuler',
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
  popupSectionSearchTarget('formulaCopy', ['formulaCopyFormat', 'enableFormulaCopy']),
  popupSearchTarget(
    'formulaCopy',
    'formulaCopyEnabled',
    ['enableFormulaCopy', 'enableFormulaCopyHint'],
    ['enable disable toggle math equation latex copy formula 开启 关闭 数学 公式 复制'],
  ),
  popupSearchTarget(
    'formulaCopy',
    'formulaCopyFormat',
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
  popupSearchTarget('promptManager', 'promptHistoryEnabled', [
    'promptHistoryTitle',
    'promptHistoryEnabledHint',
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
    [
      'pluginsDescription',
      'pluginsEmpty',
      'pluginsRefresh',
      'pluginViewSource',
      'pluginsOnlineUpdates',
      'pluginsOnlineUpdatesHint',
      'pluginsCheckInterval',
    ],
    ['extension plugin marketplace add-on catalog update 插件 市场 扩展 目录 更新'],
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
  popupSearchTarget(
    'general',
    'enableWaveDromRendering',
    ['enableWaveDromRendering', 'enableWaveDromRenderingHint'],
    ['wavedrom wavejson timing diagram'],
  ),
  popupSearchTarget(
    'general',
    'enableEchartsRendering',
    ['enableEchartsRendering', 'enableEchartsRenderingHint'],
    ['echarts chart diagram'],
  ),
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
