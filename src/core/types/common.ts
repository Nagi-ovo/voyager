/**
 * Common types used throughout the application
 * Following strict type safety principles
 */

export type Result<T, E = Error> = { success: true; data: T } | { success: false; error: E };

export interface IDisposable {
  dispose(): void;
}

export interface ILogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;
export type Maybe<T> = T | null | undefined;

/**
 * Brand type for type-safe IDs
 */
export type Brand<K, T> = K & { __brand: T };

export type ConversationId = Brand<string, 'ConversationId'>;
export type FolderId = Brand<string, 'FolderId'>;
export type TurnId = Brand<string, 'TurnId'>;
export type TimelineStyle = 'dots' | 'compact';

/**
 * Storage keys - centralized for type safety
 */
export const StorageKeys = {
  // Folder system
  FOLDER_DATA: 'gvFolderData',
  FOLDER_DATA_AISTUDIO: 'gvFolderDataAIStudio',
  FOLDER_ENABLED: 'geminiFolderEnabled',
  FOLDER_HIDE_ARCHIVED_CONVERSATIONS: 'geminiFolderHideArchivedConversations',
  FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN: 'geminiFolderHideArchivedNudgeShown',
  FOLDER_SEARCH_ENABLED: 'gvFolderSearchEnabled',
  FOLDER_FLOATING_MODE_ENABLED: 'geminiFolderFloatingModeEnabled',
  FOLDER_FLOATING_OPEN_ON_START: 'geminiFolderFloatingOpenOnStart',
  FOLDER_FLOATING_NUDGE_SHOWN: 'geminiFolderFloatingNudgeShown',
  FOLDER_FLOATING_POS: 'geminiFolderFloatingPos',
  FOLDER_FLOATING_FAB_POS: 'geminiFolderFloatingFabPos',
  FOLDER_FLOATING_SIZE: 'geminiFolderFloatingSize',
  // Global conversation ordering preference for folder views. Manual keeps
  // persisted sortIndex authoritative; recent uses lastOpenedAt/addedAt.
  FOLDER_CONVERSATION_SORT_MODE: 'gvFolderConversationSortMode',
  // AI Studio variants — intentionally separate from the Gemini keys so toggling the
  // behaviour on one platform does not surprise users on the other.
  FOLDER_HIDE_ARCHIVED_CONVERSATIONS_AISTUDIO: 'aistudioFolderHideArchivedConversations',
  FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN_AISTUDIO: 'aistudioFolderHideArchivedNudgeShown',

  // Timeline
  TIMELINE_SCROLL_MODE: 'geminiTimelineScrollMode',
  TIMELINE_STYLE: 'geminiTimelineStyle',
  TIMELINE_HIDE_CONTAINER: 'geminiTimelineHideContainer',
  TIMELINE_BAR_WIDTH: 'geminiTimelineBarWidth',
  TIMELINE_DRAGGABLE: 'geminiTimelineDraggable',
  TIMELINE_POSITION: 'geminiTimelinePosition',
  TIMELINE_PREVIEW_PINNED: 'geminiTimelinePreviewPinned',
  TIMELINE_MARKER_LEVEL: 'geminiTimelineMarkerLevel',
  TIMELINE_STARRED_MESSAGES: 'geminiTimelineStarredMessages',
  TIMELINE_HIERARCHY: 'geminiTimelineHierarchy',
  TIMELINE_SHORTCUTS: 'geminiTimelineShortcuts',
  HIGHLIGHT_CLOUD_SYNC_ENABLED: 'gvHighlightCloudSyncEnabled',
  HIGHLIGHT_DEVICE_ID: 'gvAnnotationDeviceId',
  HIGHLIGHT_ENABLED: 'gvHighlightEnabled',
  HIGHLIGHT_DEFAULT_COLOR: 'gvHighlightDefaultColor',
  HIGHLIGHT_COLOR_PALETTE: 'gvHighlightColorPalette',
  HIGHLIGHT_TIMELINE_MARKERS_ENABLED: 'gvHighlightTimelineMarkersEnabled',

  // UI customization
  CHAT_WIDTH: 'geminiChatWidth',
  CHAT_WIDTH_ENABLED: 'gvChatWidthEnabled',
  CHAT_FONT_SIZE: 'gvChatFontSize',
  CHAT_FONT_SIZE_ENABLED: 'gvChatFontSizeEnabled',
  CHAT_LINE_HEIGHT: 'gvChatLineHeight',
  CHAT_LINE_HEIGHT_ENABLED: 'gvChatLineHeightEnabled',
  CHAT_PARAGRAPH_SPACING: 'gvChatParagraphSpacing',
  EDIT_INPUT_WIDTH: 'geminiEditInputWidth',
  EDIT_INPUT_WIDTH_ENABLED: 'gvEditInputWidthEnabled',
  SIDEBAR_WIDTH: 'geminiSidebarWidth',
  SIDEBAR_WIDTH_ENABLED: 'gvSidebarWidthEnabled',
  AISTUDIO_SIDEBAR_WIDTH: 'gvAIStudioSidebarWidth',

  // Prompt Manager
  PROMPT_ITEMS: 'gvPromptItems',
  PROMPT_PANEL_LOCKED: 'gvPromptPanelLocked',
  PROMPT_PANEL_POSITION: 'gvPromptPanelPosition',
  PROMPT_TRIGGER_POSITION: 'gvPromptTriggerPosition',
  PROMPT_CUSTOM_WEBSITES: 'gvPromptCustomWebsites',
  PROMPT_THEME: 'gvPromptTheme',
  PROMPT_INSERT_ON_CLICK: 'gvPromptInsertOnClick',
  PROMPT_VIEW_MODE: 'gvPromptViewMode',
  PROMPT_PANEL_VIEW: 'gvPromptPanelView',
  SLASH_PROMPT_ENABLED: 'gvSlashPromptEnabled',
  // Persisted tag filter for the prompt manager (#729). chrome.storage.local
  // only — the selected tags are a per-device view over this machine's prompt
  // set, not a synced preference; syncing them could restore tags a device
  // hasn't received yet. Shape: string[] of lowercased tag names.
  PROMPT_SELECTED_TAGS: 'gvPromptSelectedTags',

  // Global settings
  LANGUAGE: 'language',
  FORMULA_COPY_FORMAT: 'gvFormulaCopyFormat',
  // Legacy single-toggle key. Kept for migration: when neither
  // WATERMARK_DOWNLOAD_ENABLED nor WATERMARK_PREVIEW_ENABLED is present, this
  // value (defaulting to true) is used to derive both flags so existing users
  // keep their behavior. New writes go to the two split keys below.
  WATERMARK_REMOVER_ENABLED: 'geminiWatermarkRemoverEnabled',
  WATERMARK_DOWNLOAD_ENABLED: 'gvWatermarkDownloadEnabled',
  WATERMARK_PREVIEW_ENABLED: 'gvWatermarkPreviewEnabled',
  HIDE_PROMPT_MANAGER: 'gvHidePromptManager',
  TAB_TITLE_UPDATE_ENABLED: 'gvTabTitleUpdateEnabled',
  MERMAID_ENABLED: 'gvMermaidEnabled',
  QUOTE_REPLY_ENABLED: 'gvQuoteReplyEnabled',
  RESPONSE_COMPLETE_NOTIFICATION_ENABLED: 'gvResponseCompleteNotificationEnabled',
  REMOTE_ANNOUNCEMENTS_ENABLED: 'gvRemoteAnnouncementsEnabled',
  REMOTE_ANNOUNCEMENTS_STATE: 'gvRemoteAnnouncementsState',
  REMOTE_ANNOUNCEMENTS_PENDING: 'gvRemoteAnnouncementsPending',
  STORAGE_QUOTA_WARNING_LEVEL: 'gvStorageQuotaWarningLevel',
  GENERATED_UI_CAPTURE_PERMISSION_CLEANUP_DONE: 'gvGeneratedUiCapturePermissionCleanupDone',

  // Input behavior
  CTRL_ENTER_SEND: 'gvCtrlEnterSend',
  AISTUDIO_ENTER_SEND: 'gvAIStudioEnterSend',
  SAFARI_ENTER_FIX: 'gvSafariEnterFix',
  INPUT_COLLAPSE_ENABLED: 'gvInputCollapseEnabled',
  INPUT_COLLAPSE_WHEN_NOT_EMPTY: 'gvInputCollapseWhenNotEmpty',
  INPUT_VIM_MODE: 'gvInputVimMode',
  DRAFT_AUTO_SAVE: 'gvDraftAutoSave',
  PREVENT_AUTO_SCROLL_ENABLED: 'gvPreventAutoScrollEnabled',

  // Default Model
  DEFAULT_MODEL: 'gvDefaultModel',
  DEFAULT_THINKING_LEVEL: 'gvDefaultThinkingLevel',
  // Master switch for auto-applying the stored default model / thinking level
  // on new conversations. Defaults to enabled; users can flip this off as a
  // kill switch if a Gemini redesign breaks the locker or makes it
  // misbehave. Setting/clearing the default itself (the star buttons inside
  // the model menu) remains available regardless of this flag.
  DEFAULT_MODEL_AUTO_APPLY: 'gvDefaultModelAutoApply',

  // Folder filtering
  GV_FOLDER_FILTER_USER_ONLY: 'gvFolderFilterUserOnly',
  GV_ACCOUNT_ISOLATION_ENABLED: 'gvAccountIsolationEnabled',
  GV_ACCOUNT_ISOLATION_ENABLED_GEMINI: 'gvAccountIsolationEnabledGemini',
  GV_ACCOUNT_ISOLATION_ENABLED_AISTUDIO: 'gvAccountIsolationEnabledAIStudio',
  GV_ACCOUNT_PROFILE_MAP: 'gvAccountProfileMap',

  // Sidebar behavior
  GV_SIDEBAR_AUTO_HIDE: 'gvSidebarAutoHide',
  GV_SIDEBAR_FULL_HIDE: 'gvSidebarFullHide',
  GEMS_HIDDEN: 'gvGemsHidden',
  NOTEBOOKS_HIDDEN: 'gvNotebooksHidden',
  FOLDERS_HIDDEN: 'gvFoldersHidden',
  FOLDERS_COLLAPSED: 'gvFoldersCollapsed',
  // Device-local projection for the Gemini folder panel. `folders` preserves
  // the tree; `activity` groups filed conversations by their latest real turn.
  FOLDERS_VIEW_MODE: 'gvFoldersViewMode',
  // How many recent gems to show as an expandable section in the sidebar.
  // 0 disables the feature entirely (no section injected); 1-10 shows that
  // many items. Cached gem list lives in `GV_GEMS_LIST_CACHE`.
  GV_GEMS_SIDEBAR_COUNT: 'gvGemsSidebarCount',
  // Local cache of the Gems list scraped from /gems/view. Stored as
  // { items: GemMetadata[]; cachedAt: number }. Falls into local (not sync)
  // because gem rosters can be sizeable + sync quota is precious.
  GV_GEMS_LIST_CACHE: 'gvGemsListCache',
  // Most-recently-used gems, newest first. Stored as
  // { entries: Array<GemMetadata & { lastUsedAt: number }> }. Captured when the
  // user opens a `/gem/<id>` page (custom OR premade), so the sidebar ranks gems
  // by recent use rather than by the static management-page order. Local for the
  // same quota reason as the list cache.
  GV_GEMS_MRU: 'gvGemsMru',
  // Ordered list of gem ids the user pinned from Gemini's Gems list. Pinned
  // gems always render first in the sidebar (in this order) and are never
  // trimmed by GV_GEMS_SIDEBAR_COUNT; remaining slots fill with recently-used gems.
  // Empty array (default) preserves the pure MRU behavior. Stored as string[]
  // in chrome.storage.sync — ids only, so it stays tiny; names/icons resolve
  // from the local cache/MRU on each device.
  GV_GEMS_PINNED: 'gvGemsPinned',
  // Usage status-line. Enables the slim daily/weekly usage pill near the
  // composer. Synced so the toggle follows the user across devices. Default off
  // (opt-in) since it injects persistent UI.
  USAGE_STATUS_ENABLED: 'gvUsageStatusEnabled',
  // Local cache of the usage limits scraped from /usage. Stored as a
  // UsageSnapshot envelope ({ daily, weekly, tier, accountKey, updatedAt }).
  // Local (not sync) because it changes constantly and is per-account, not a
  // preference.
  GV_USAGE_CACHE: 'gvUsageCache',
  // Self-calibrated "recipe" for silently refreshing usage off the /usage page:
  // { rpcid, args } of the batchexecute call that carries the usage metrics,
  // captured by the document_start observer and DOM-verified on /usage. Replayed
  // from any Gemini page to refresh the snapshot without navigating.
  GV_USAGE_RECIPE: 'gvUsageRecipe',
  // User-dragged position of the usage mini-bar ({ x, y } viewport px). Absent =
  // default bottom-right. Local since it's a per-device UI placement.
  GV_USAGE_POS: 'gvUsagePos',
  // Local cache scraped from Claude's official settings usage page. Stored as
  // { metrics: Array<{ label, percent, resetLabel }>, plan, lastUpdatedLabel, updatedAt }.
  GV_CLAUDE_USAGE_CACHE: 'gvClaudeUsageCache',
  // Short-lived local lock so multiple Claude tabs share one usage refresh cadence.
  GV_CLAUDE_USAGE_REFRESH_LOCK: 'gvClaudeUsageRefreshLock',
  // User-dragged position of the Claude usage mini-bar ({ x, y } viewport px).
  GV_CLAUDE_USAGE_POS: 'gvClaudeUsagePos',
  // 'above-recents' (default) anchors the folder panel just above the Recents
  // expandable-section; 'above-notebooks' anchors it above the Notebooks
  // section instead. Persisted in chrome.storage.local since it's a UI-only
  // preference and changes feel best when they take effect immediately.
  FOLDERS_ANCHOR: 'gvFoldersAnchor',
  SIDEBAR_COLLAPSE_NUDGE_SHOWN: 'gvSidebarCollapseNudgeShown',
  // Reusable one-time feature coachmarks (spotlight + bubble + optional inline
  // toggle). A single sync key holding the array of coachmark ids the user has
  // already seen, so every coachmark shows at most once per user across devices.
  // See src/pages/content/coachmark.
  COACHMARKS_SEEN: 'gvCoachmarksSeen',

  // Folder spacing
  GV_FOLDER_SPACING: 'gvFolderSpacing',
  GV_AISTUDIO_FOLDER_SPACING: 'gvAIStudioFolderSpacing',
  GV_FOLDER_TREE_INDENT: 'gvFolderTreeIndent',

  // Folder item font size (px). Range 12-18, default 13 to match Gemini's
  // native sidebar item text size after the May 2026 redesign.
  GV_FOLDER_ITEM_FONT_SIZE: 'gvFolderItemFontSize',

  // Hide Gemini's blue radial-gradient halo behind the input box
  // (chat-window::before + .nl-canvas blobs). Default false (halo visible).
  INPUT_HALO_HIDDEN: 'gvInputHaloHidden',

  // Snow effect (legacy, kept for backward compat migration)
  GV_SNOW_EFFECT: 'gvSnowEffect',

  // Visual effect (replaces GV_SNOW_EFFECT): 'off' | 'snow' | 'sakura'
  GV_VISUAL_EFFECT: 'gvVisualEffect',

  // Changelog
  CHANGELOG_DISMISSED_VERSION: 'gvChangelogDismissedVersion',
  CHANGELOG_NOTIFY_MODE: 'gvChangelogNotifyMode',
  EDGE_FINAL_VERSION_NOTICE_FIRST_SEEN_AT: 'gvEdgeFinalVersionNoticeFirstSeenAt',
  EDGE_FINAL_VERSION_NOTICE_SHOWN: 'gvEdgeFinalVersionNoticeShown',
  EDGE_CONTINUED_SUPPORT_NOTICE_FIRST_SEEN_AT: 'gvEdgeContinuedSupportNoticeFirstSeenAt',
  EDGE_CONTINUED_SUPPORT_NOTICE_SHOWN: 'gvEdgeContinuedSupportNoticeShown',

  // Fork nodes
  FORK_NODES: 'gvForkNodes',
  FORK_ENABLED: 'gvForkEnabled',

  // Export
  EXPORT_IMAGE_WIDTH: 'gvExportImageWidth',
  EXPORT_SPEAKER_LABELS: 'gvExportSpeakerLabels',
  // Fallback top-right export toolbar shown when Gemini's logo (the normal
  // inline injection point) is absent. Defaults to true. When false, the
  // toolbar is suppressed even if the logo is missing — users keep the menu
  // injections (顶栏 ⋮ / per-response ⋮) as their only export entry.
  PERSISTENT_EXPORT_TOOLBAR_ENABLED: 'gvPersistentExportToolbarEnabled',

  // AI Studio master toggle
  GV_AISTUDIO_ENABLED: 'gvAIStudioEnabled',

  // Message timestamps
  GV_SHOW_MESSAGE_TIMESTAMPS: 'gvShowMessageTimestamps',
  GV_MESSAGE_TIMESTAMPS: 'gvMessageTimestamps',
  // Local-only cache of Gemini's complete ordered response-id list per
  // conversation. It lets legacy positional turn ids resolve safely after a
  // full reload without persisting message text or response bodies.
  GV_TURN_IDENTITY_CACHE: 'gvTurnIdentityCache',

  // Popup section order
  GV_POPUP_SECTION_ORDER: 'gvPopupSectionOrder',
  // Device-local vertical position for the popup's full main settings view.
  GV_POPUP_SCROLL_TOP: 'gvPopupScrollTop',

  // Context sync
  CONTEXT_SYNC_ENABLED: 'contextSyncEnabled',
  CONTEXT_SYNC_PORT: 'contextSyncPort',

  // Folder as Project
  FOLDER_PROJECT_ENABLED: 'gvFolderProjectEnabled',
  FOLDER_PROJECT_PENDING_FOLDER_ID: 'gvFolderProjectPendingFolderId',

  // Plugin ecosystem
  // Per-plugin install/enable state (chrome.storage.local). Shape:
  //   Record<pluginId, { enabled: boolean; installedAt: number }>
  // Stored in local (not sync) because the installed set can be sizeable; sync
  // quota is precious. Entitlement (purchased/locked) is NOT stored here — it
  // comes from the EntitlementProvider so it can be server-driven later.
  PLUGINS_STATE: 'gvPluginsState',
  // Registered external marketplace sources (git-based catalogs). Reserved for
  // the future remote-registry milestone; unused today.
  PLUGIN_MARKETPLACE_SOURCES: 'gvPluginMarketplaceSources',
  // Cached plugin catalog fetched from the marketplace (chrome.storage.local).
  // Shape: { manifests: PluginManifest[]; fetchedAt: number }. Local (not sync)
  // because it's network-derived per-device data, refreshed on a TTL.
  PLUGIN_CATALOG_CACHE: 'gvPluginCatalogCache',
  // Plugin cards the user has collapsed in the popup list (string[] of plugin
  // ids). Local (not sync) — it's a per-device UI preference, not user data.
  PLUGIN_UI_COLLAPSED: 'gvPluginUiCollapsed',
  // Per-site custom accent colour overrides (chrome.storage.sync, backed up).
  // Shape: Record<siteId, string> keyed by SiteAdapter id ('gemini' | 'claude'
  // | 'chatgpt' | 'aistudio' | 'grok' | ...). A site WITH an entry uses that
  // colour for the whole Voyager UI on that site; a site WITHOUT an entry falls
  // back to its default (Gemini = Everforest sage; others = adapter brandColor).
  ACCENT_COLORS: 'gvAccentColors',
} as const;

export type StorageKey = (typeof StorageKeys)[keyof typeof StorageKeys];
