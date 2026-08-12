import { CleanupPositions } from '@/core/types/cleanupPositions';
import { StorageKeys } from '@/core/types/common';
import { isHighlightColor, normalizeHighlightColorPalette } from '@/core/types/highlight';
import { CleanupManager } from '@/core/utils/cleanupManager';
import { customWebsitesIncludeHost, sanitizeCustomWebsites } from '@/core/utils/customWebsites';
import {
  hasValidExtensionContext,
  isExtensionContextInvalidatedError,
} from '@/core/utils/extensionContext';
import { isGeminiEnterpriseEnvironment } from '@/core/utils/gemini';
import { WATERMARK_STORAGE_KEYS } from '@/core/utils/watermarkSettings';
import { startPluginHost } from '@/features/plugins';
import { resolvePluginPlatformId } from '@/features/plugins/sites/registry';
import { initI18n } from '@/utils/i18n';

import { startAccountContextBridge } from './accountContext';
import { startCanvasExport } from './canvasExport/index';
import { startChangelog } from './changelog/index';
import { startChatFontSizeAdjuster } from './chatFontSize/index';
import { startInputVimMode } from './chatInput/vimMode';
import { startChatLineHeightAdjuster } from './chatLineHeight/index';
import { startChatParagraphSpacingAdjuster } from './chatParagraphSpacing/index';
import { startChatWidthAdjuster } from './chatWidth/index';
import { runCoachmarkSequence } from './coachmark';
import { startCodeBlockCollapse } from './codeBlockCollapse';
import { startContextSync } from './contextSync';
import { startDeepResearchExport } from './deepResearch/index';
import DefaultModelManager from './defaultModel/modelLocker';
import { startDraftSave } from './draftSave/index';
import { startEdgeFinalVersionNotice } from './edgeFinalVersionNotice';
import { startEditInputWidthAdjuster } from './editInputWidth/index';
import { startExportButton } from './export/index';
import { folderActivityCoachmarkStep } from './folder/activityCoachmark';
import { startAIStudioFolderManager } from './folder/aistudio';
import { conversationSortCoachmarkStep } from './folder/conversationSortCoachmark';
import { folderSearchCoachmarkStep } from './folder/folderSearchCoachmark';
import { startFolderManager } from './folder/index';
import { startFolderItemFontSizeAdjuster } from './folderItemFontSize/index';
import { startFolderProject } from './folderProject/index';
import { startFolderSpacingAdjuster } from './folderSpacing/index';
import { isForkFeatureEnabledValue } from './fork/featureFlag';
import { startFork } from './fork/index';
import { startNativeFormulaCopyForContent } from './formulaCopyStartup';
import { startGemsHider } from './gemsHider/index';
import { startGemsSidebar } from './gemsSidebar/index';
import { startInputCollapse } from './inputCollapse/index';
import { startInputHaloHider } from './inputHaloHider/index';
import { initKaTeXConfig } from './katexConfig';
import { startMarkdownPatcher } from './markdownPatcher/index';
import { startMermaid } from './mermaid/index';
import { startBrandTheme } from './platformTheme';
import { registerBuiltinNativeHandlers } from './pluginNativeRegistration';
import { startPreventAutoScroll } from './preventAutoScroll/index';
import { createCustomSiteCoverageReconciler } from './prompt/customSiteCoverage';
import { startPromptManager } from './prompt/index';
import { slashPromptCoachmarkStep } from './prompt/slashPromptCoachmark';
import { startSlashPromptFeature } from './prompt/slashPromptFeature';
import { startQuoteReply } from './quoteReply/index';
import { startRemoteAnnouncements } from './remoteAnnouncements/index';
import { startResponseCompleteNotification } from './responseNotification/index';
import { startSendBehavior } from './sendBehavior/index';
import { startSidebarAutoHide } from './sidebarAutoHide';
import { startSidebarWidthAdjuster } from './sidebarWidth';
import { startStorageQuotaWarningToast } from './storageQuotaWarning';
import { startTimeline } from './timeline/index';
import { rulerTimelineCoachmarkStep } from './timeline/rulerTimelineCoachmark';
import { startUsageStatus } from './usageStatus/index';
import { usageCoachmarkStep } from './usageStatus/usageCoachmark';
import { startUserLatex } from './userLatex/index';
import { startVisualEffects } from './visualEffects';
import {
  restartWatermarkRemover,
  startWatermarkRemover,
  stopWatermarkRemover,
} from './watermarkRemover/index';

// Suppress Vite's CSS preload errors in the Chrome extension content script context.
// Dynamic imports (e.g., mermaid) trigger Vite's __vitePreload helper which tries to
// create <link> elements with paths like "/assets/foo.css". In a content script, these
// resolve to the web page origin (e.g., https://gemini.google.com/assets/foo.css)
// instead of the extension, causing false "Unable to preload CSS" errors.
// The CSS is already injected via contentStyle.css, so these preloads are unnecessary.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
});

/**
 * Staggered initialization to prevent "thundering herd" problem when multiple tabs
 * are restored simultaneously (e.g., after browser restart).
 *
 * Background tabs get a random delay (3-8s) to distribute initialization load.
 * Foreground tabs initialize immediately for good UX.
 *
 * This prevents triggering Google's rate limiting when restoring sessions with
 * many Gemini tabs containing long conversations.
 */

// Initialization delay constants (in milliseconds)
const HEAVY_FEATURE_INIT_DELAY = 100; // For resource-intensive features (Timeline, Folder)
const LIGHT_FEATURE_INIT_DELAY = 50; // For lightweight features
const BACKGROUND_TAB_MIN_DELAY = 3000; // Minimum delay for background tabs
const BACKGROUND_TAB_MAX_DELAY = 8000; // Maximum delay for background tabs (3000 + 5000)

const cleanupManager = new CleanupManager();

let initialized = false;
let initializationTimer: number | null = null;
let forkCleanup: (() => void) | null = null;
let watermarkRemoverStarted = false;

async function isForkFeatureEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage?.sync?.get({ [StorageKeys.FORK_ENABLED]: false });
    return isForkFeatureEnabledValue(result?.[StorageKeys.FORK_ENABLED]);
  } catch {
    return false;
  }
}

let onboardingCoachmarkShownThisPage = false;
let onboardingCoachmarkSequenceRunning = false;

function showOnboardingCoachmarksWhenChangelogIsIdle(): void {
  if (
    document.querySelector('.gv-changelog-overlay') ||
    onboardingCoachmarkShownThisPage ||
    onboardingCoachmarkSequenceRunning
  )
    return;

  onboardingCoachmarkSequenceRunning = true;
  void runCoachmarkSequence([
    rulerTimelineCoachmarkStep,
    folderActivityCoachmarkStep,
    usageCoachmarkStep,
    folderSearchCoachmarkStep,
    conversationSortCoachmarkStep,
    slashPromptCoachmarkStep,
  ])
    .then((result) => {
      if (result !== 'skipped') onboardingCoachmarkShownThisPage = true;
    })
    .finally(() => {
      onboardingCoachmarkSequenceRunning = false;
    });
}

/**
 * Check if current hostname matches any custom websites
 */
async function isCustomWebsite(): Promise<boolean> {
  try {
    const result = await chrome.storage?.sync?.get({ gvPromptCustomWebsites: [] });
    const customWebsites = sanitizeCustomWebsites(result?.gvPromptCustomWebsites);

    // Port-pinned entries only match the exact origin, so compare against the
    // host (which carries the port), not the bare hostname.
    const currentHost = location.host.toLowerCase().replace(/^www\./, '');

    console.log('[Gemini Voyager] Checking custom websites:', {
      currentHost,
      customWebsites,
      hostname: location.hostname,
    });

    const isCustom = customWebsitesIncludeHost(customWebsites, currentHost);

    console.log('[Gemini Voyager] Is custom website:', isCustom);
    return isCustom;
  } catch (e) {
    if (isExtensionContextInvalidatedError(e)) {
      return false;
    }
    console.error('[Gemini Voyager] Error checking custom websites:', e);
    return false;
  }
}

/**
 * Initialize all features sequentially to reduce simultaneous load
 */
async function initializeFeatures(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    if (!hasValidExtensionContext()) {
      return;
    }

    const slashPrompt = await startSlashPromptFeature();
    cleanupManager.registerCleanupFunction(
      () => slashPrompt.destroy(),
      CleanupPositions.DestroySlashPromptFeatureInstance,
    );

    // Yield between features instead of sleeping a fixed amount. On an idle main
    // thread (the common foreground case) requestIdleCallback fires on the next
    // idle slice — typically well under `ms` — so tail features (timeline, export,
    // mermaid, …) wire up promptly instead of waiting out a ~2s floor of stacked
    // setTimeouts. When the thread is busy, the `timeout` cap makes it back off
    // exactly like the old fixed delay, preserving the anti-thundering-herd intent.
    // Falls back to setTimeout where requestIdleCallback is unavailable (older WebKit).
    const delay = (ms: number) =>
      new Promise<void>((resolve) => {
        if (typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(() => resolve(), { timeout: ms });
        } else {
          setTimeout(resolve, ms);
        }
      });

    // Check if this is a custom website (only prompt manager should be enabled)
    const isCustomSite = await isCustomWebsite();

    if (isCustomSite) {
      // Only start prompt manager for custom websites
      console.log('[Gemini Voyager] Custom website detected, starting Prompt Manager only');

      // Turning the site off only unregisters the content script for future
      // navigations — this page keeps running — so mirror both directions here
      // instead of making the user reload.
      const coverage = createCustomSiteCoverageReconciler({
        host: location.host.toLowerCase(),
        start: startPromptManager,
        initial: await startPromptManager(),
      });

      chrome.storage?.onChanged?.addListener(coverage.handleChange);
      cleanupManager.registerCleanupFunction(
        () => chrome.storage?.onChanged?.removeListener(coverage.handleChange),
        CleanupPositions.RemoveStorageOnChangedListener,
      );
      cleanupManager.registerCleanupFunction(
        () => coverage.destroy(),
        CleanupPositions.DestroyPromptManagerInstance,
      );
      return;
    }

    console.log('[Gemini Voyager] Not a custom website, checking for Gemini/AI Studio');

    cleanupManager.registerCleanupFunction(
      startEdgeFinalVersionNotice(),
      CleanupPositions.CleanupEdgeFinalVersionNotice,
    );

    const isEnterprise = isGeminiEnterpriseEnvironment(
      {
        hostname: location.hostname,
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
      },
      document,
    );

    if (isEnterprise) {
      console.log('[Gemini Voyager] Gemini Enterprise detected, starting Prompt Manager only');
      const pm = await startPromptManager();
      cleanupManager.registerCleanupFunction(
        () => pm.destroy(),
        CleanupPositions.DestroyPromptManagerInstance,
      );
      return;
    }

    if (location.hostname === 'gemini.google.com') {
      // Timeline is most resource-intensive, start it first
      startTimeline();
      await delay(HEAVY_FEATURE_INIT_DELAY);

      const folderManager = await startFolderManager();
      if (folderManager) {
        cleanupManager.registerCleanupFunction(
          () => folderManager.destroy(),
          CleanupPositions.DestroyFolderManagerInstance,
        );
        startFolderProject(folderManager);
      }
      await delay(HEAVY_FEATURE_INIT_DELAY);

      // Layout preferences are independent and only install lightweight
      // storage listeners/styles, so yield once for the group instead of once
      // per setting.
      startFolderSpacingAdjuster('gemini');
      startFolderItemFontSizeAdjuster();
      startChatWidthAdjuster();
      startChatFontSizeAdjuster();
      startChatLineHeightAdjuster();
      startChatParagraphSpacingAdjuster();
      startEditInputWidthAdjuster();
      startSidebarWidthAdjuster();
      startSidebarAutoHide();
      await delay(LIGHT_FEATURE_INIT_DELAY);

      startInputCollapse();
      startInputHaloHider();
      cleanupManager.registerCleanupFunction(
        await startInputVimMode(),
        CleanupPositions.CleanupInputVimMode,
      );
      await delay(LIGHT_FEATURE_INIT_DELAY);

      // Send behavior must be ready before prevent-auto-scroll reads its bridge state.
      cleanupManager.registerCleanupFunction(
        await startSendBehavior('gemini'),
        CleanupPositions.CleanupSendBehavior,
      );
      startPreventAutoScroll();
      await startNativeFormulaCopyForContent({
        registerCleanup: (cleanup) =>
          cleanupManager.registerCleanupFunction(cleanup, CleanupPositions.CleanupFormulaCopy),
      });
      await delay(LIGHT_FEATURE_INIT_DELAY);

      // Quote Reply - conditionally start based on storage setting
      const quoteReplyResult = await new Promise<Record<string, unknown>>((resolve) => {
        const defaults = {
          [StorageKeys.QUOTE_REPLY_ENABLED]: true,
          [StorageKeys.HIGHLIGHT_ENABLED]: false,
          [StorageKeys.HIGHLIGHT_DEFAULT_COLOR]: 'yellow',
          [StorageKeys.HIGHLIGHT_COLOR_PALETTE]: null,
          [StorageKeys.HIGHLIGHT_TIMELINE_MARKERS_ENABLED]: true,
        };
        try {
          chrome.storage?.sync?.get(defaults, resolve);
        } catch {
          resolve(defaults);
        }
      });
      const storedHighlightColor = quoteReplyResult[StorageKeys.HIGHLIGHT_DEFAULT_COLOR];
      // Highlight shares Quote Reply's single selection toolbar/listener. Keep
      // the toolbar manager alive when Quote Reply is disabled; only its Quote
      // action is hidden in that case.
      cleanupManager.registerCleanupFunction(
        startQuoteReply({
          quoteEnabled: quoteReplyResult[StorageKeys.QUOTE_REPLY_ENABLED] !== false,
          highlightEnabled: quoteReplyResult[StorageKeys.HIGHLIGHT_ENABLED] === true,
          highlightDefaultColor: isHighlightColor(storedHighlightColor)
            ? storedHighlightColor
            : 'yellow',
          highlightColorPalette: normalizeHighlightColorPalette(
            quoteReplyResult[StorageKeys.HIGHLIGHT_COLOR_PALETTE],
            storedHighlightColor,
          ),
          highlightTimelineMarkersEnabled:
            quoteReplyResult[StorageKeys.HIGHLIGHT_TIMELINE_MARKERS_ENABLED] !== false,
        }),
        CleanupPositions.CleanupQuoteReply,
      );
      await delay(LIGHT_FEATURE_INIT_DELAY);

      // Independent content helpers can initialize in the same idle slice.
      watermarkRemoverStarted = true;
      void startWatermarkRemover();
      cleanupManager.registerCleanupFunction(
        () => stopWatermarkRemover(),
        CleanupPositions.StopWatermarkRemover,
      );
      startDeepResearchExport();
      startContextSync();
      startGemsHider();
      await delay(LIGHT_FEATURE_INIT_DELAY);

      // These modules only share the extension storage API and can hydrate in
      // parallel without changing their runtime ordering.
      const [notificationResult, draftResult, gemsResult, usageResult] = await Promise.allSettled([
        startResponseCompleteNotification(),
        startDraftSave(),
        startGemsSidebar(),
        startUsageStatus(),
      ]);
      if (notificationResult.status === 'fulfilled') {
        cleanupManager.registerCleanupFunction(
          notificationResult.value,
          CleanupPositions.CleanupResponseCompleteNotification,
        );
      }
      if (draftResult.status === 'fulfilled') {
        cleanupManager.registerCleanupFunction(
          draftResult.value,
          CleanupPositions.CleanupDraftSave,
        );
      }
      if (gemsResult.status === 'fulfilled') {
        cleanupManager.registerCleanupFunction(
          gemsResult.value,
          CleanupPositions.CleanupGemsSidebar,
        );
      }
      if (usageResult.status === 'fulfilled') {
        cleanupManager.registerCleanupFunction(
          usageResult.value,
          CleanupPositions.CleanupUsageStatus,
        );
      }

      const failedInitializer = [notificationResult, draftResult, gemsResult, usageResult].find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failedInitializer) throw failedInitializer.reason;
      await delay(LIGHT_FEATURE_INIT_DELAY);

      // DOM enhancements install observers/listeners but do not need separate
      // idle waits between each initializer.
      startMarkdownPatcher();
      cleanupManager.registerCleanupFunction(
        startCodeBlockCollapse(),
        CleanupPositions.CleanupCodeBlockCollapse,
      );
      DefaultModelManager.getInstance().init();
      startExportButton();
      void startCanvasExport();
      await delay(LIGHT_FEATURE_INIT_DELAY);

      if (await isForkFeatureEnabled()) {
        forkCleanup = cleanupManager.registerCleanupFunctionAndReturnIt(
          startFork(),
          CleanupPositions.CleanupFork,
        );
      }

      // Introduce new feature coachmarks once the changelog is out of the way;
      // if the changelog doesn't show (already read / badge mode), still try.
      void startChangelog({ onClosed: showOnboardingCoachmarksWhenChangelogIsIdle }).then(() => {
        window.setTimeout(showOnboardingCoachmarksWhenChangelogIsIdle, 1200);
      });
    }

    if (
      location.hostname === 'gemini.google.com' ||
      location.hostname === 'aistudio.google.com' ||
      location.hostname === 'aistudio.google.cn'
    ) {
      const pm = await startPromptManager();
      cleanupManager.registerCleanupFunction(
        () => pm.destroy(),
        CleanupPositions.DestroyPromptManagerInstance,
      );
      await delay(HEAVY_FEATURE_INIT_DELAY);
    }

    if (location.hostname === 'gemini.google.com') {
      // Initialize Mermaid rendering (lightweight)
      startMermaid();
      // Initialize user message LaTeX rendering
      startUserLatex();
      await delay(LIGHT_FEATURE_INIT_DELAY);
    }

    if (location.hostname === 'aistudio.google.com' || location.hostname === 'aistudio.google.cn') {
      // Check if user has disabled Voyager on AI Studio
      const aiStudioEnabled = await new Promise<boolean>((resolve) => {
        try {
          chrome.storage?.sync?.get({ [StorageKeys.GV_AISTUDIO_ENABLED]: true }, (res) =>
            resolve(res?.[StorageKeys.GV_AISTUDIO_ENABLED] !== false),
          );
        } catch {
          resolve(true);
        }
      });

      if (!aiStudioEnabled) {
        console.log('[Gemini Voyager] AI Studio features disabled by user');
        return;
      }

      startAIStudioFolderManager();
      await delay(HEAVY_FEATURE_INIT_DELAY);

      startFolderSpacingAdjuster('aistudio');
      await delay(LIGHT_FEATURE_INIT_DELAY);

      // Formula copy support for AI Studio
      await startNativeFormulaCopyForContent({
        registerCleanup: (cleanup) =>
          cleanupManager.registerCleanupFunction(cleanup, CleanupPositions.CleanupFormulaCopy),
      });
      await delay(LIGHT_FEATURE_INIT_DELAY);

      // Send behavior (Enter to send)
      cleanupManager.registerCleanupFunction(
        await startSendBehavior('aistudio'),
        CleanupPositions.CleanupSendBehavior,
      );
      await delay(LIGHT_FEATURE_INIT_DELAY);
    }
  } catch (e) {
    if (isExtensionContextInvalidatedError(e)) {
      return;
    }
    console.error('[Gemini Voyager] Initialization error:', e);
  }
}

/**
 * Determine initialization delay based on tab visibility
 */
function getInitializationDelay(): number {
  // Check if tab is currently visible
  const isVisible = document.visibilityState === 'visible';

  if (isVisible) {
    // Foreground tab: initialize immediately for good UX
    console.log('[Gemini Voyager] Foreground tab detected, initializing immediately');
    return 0;
  } else {
    // Background tab: add random delay to distribute load across multiple tabs
    const randomRange = BACKGROUND_TAB_MAX_DELAY - BACKGROUND_TAB_MIN_DELAY;
    const randomDelay = BACKGROUND_TAB_MIN_DELAY + Math.random() * randomRange;
    console.log(
      `[Gemini Voyager] Background tab detected, delaying initialization by ${Math.round(randomDelay)}ms`,
    );
    return randomDelay;
  }
}

/**
 * Handle tab visibility changes
 */
function handleVisibilityChange(): void {
  if (document.visibilityState === 'visible' && !initialized) {
    // Tab became visible before initialization completed
    // Cancel any pending delayed initialization and start immediately
    if (initializationTimer !== null) {
      clearTimeout(initializationTimer);
      initializationTimer = null;
      console.log('[Gemini Voyager] Tab became visible, initializing immediately');
    }
    initializeFeatures();
  }
}

// Main initialization logic
(function () {
  try {
    if (!hasValidExtensionContext()) return;

    const pluginPlatformId = resolvePluginPlatformId(location.href);
    const isPluginSubframe = window.top !== window && pluginPlatformId !== null;

    // Snow, rain and sakura are fullscreen canvas effects with no host-UI
    // dependency. Keep them out of embedded plugin frames: those frames only
    // need the declarative plugin host and would otherwise render a duplicate
    // effect above their parent page.
    if (!isPluginSubframe) startVisualEffects();

    // Answer the background's ping so injectPluginScriptIntoOpenTabs can tell
    // a live content script from a missing/orphaned one and skip re-injecting
    // CSS/JS into tabs that already run us.
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if ((message as { type?: string } | null)?.type === 'gv.content.ping') {
        sendResponse({ ok: true });
      }
    });

    // Saved Library and cloud sync need the same account identity as highlights.
    // This bridge must exist even when optional Folder Manager code never starts.
    if (!isPluginSubframe)
      cleanupManager.registerCleanupFunction(
        startAccountContextBridge(),
        CleanupPositions.CleanupAccountContextBridge,
      );

    // Plugin ecosystem host. Started up-front on EVERY page the content script is
    // injected into (Gemini / AI Studio, and any site a user enabled a plugin for,
    // e.g. claude.ai via dynamic registration). It self-detects the site adapter
    // and only mounts plugins that match the current URL AND are enabled — inert by
    // default since all builtin plugins ship disabled, so it has no effect unless a
    // user turns a plugin on in the popup.
    // Bind builtin "native function plugins" before the host starts, so
    // PluginHost can run them when enabled on Claude/ChatGPT (default off).
    // Gemini/AI Studio keep their existing core feature lifecycle.
    registerBuiltinNativeHandlers();
    cleanupManager.registerCleanupFunction(startPluginHost(), CleanupPositions.CleanupPluginHost);

    // Cosmetic: on Claude / ChatGPT, re-skin Voyager's accent to the host
    // platform's brand colour (injects --gv-pm-brand + a gv-platform-themed body
    // class; CSS derives the rest). Applies the adapter's built-in colour at
    // once, then lets an enabled plugin's declared theme override it live. No-op
    // on Gemini / AI Studio.
    if (!isPluginSubframe)
      cleanupManager.registerCleanupFunction(startBrandTheme(), CleanupPositions.CleanupBrandTheme);

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isExtensionContextInvalidatedError(event.reason)) {
        event.preventDefault();
      }
    };
    const onWindowError = (event: ErrorEvent) => {
      if (isExtensionContextInvalidatedError(event.error ?? event.message)) {
        event.preventDefault();
      }
    };
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    cleanupManager.registerCleanupFunction(
      () => window.removeEventListener('unhandledrejection', onUnhandledRejection),
      CleanupPositions.RemoveUnhandledRejectionEventListener,
    );
    window.addEventListener('error', onWindowError);
    cleanupManager.registerCleanupFunction(
      () => window.removeEventListener('error', onWindowError),
      CleanupPositions.RemoveErrorEventListener,
    );
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (
        watermarkRemoverStarted &&
        areaName === 'sync' &&
        WATERMARK_STORAGE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(changes, key))
      ) {
        void restartWatermarkRemover();
      }

      if (
        (areaName !== 'sync' && areaName !== 'local') ||
        location.hostname !== 'gemini.google.com'
      ) {
        return;
      }

      const forkSetting = changes[StorageKeys.FORK_ENABLED];
      if (!forkSetting) return;

      const enabled = isForkFeatureEnabledValue(forkSetting.newValue);
      if (enabled) {
        if (!forkCleanup) {
          forkCleanup = cleanupManager.registerCleanupFunctionAndReturnIt(
            startFork(),
            CleanupPositions.CleanupFork,
          );
        }
      } else if (forkCleanup) {
        forkCleanup();
        forkCleanup = null;
        cleanupManager.withdrawCleanupFunctionsByPositionNumber(CleanupPositions.CleanupFork);
      }
    };

    // Quick check: only run on supported websites
    const hostname = location.hostname.toLowerCase();
    const isSupportedSite =
      hostname.includes('gemini.google.com') ||
      hostname.includes('business.gemini.google') ||
      hostname.includes('aistudio.google.com') ||
      hostname.includes('aistudio.google.cn');
    if (!isPluginSubframe && (isSupportedSite || pluginPlatformId)) {
      cleanupManager.registerCleanupFunction(
        startRemoteAnnouncements(),
        CleanupPositions.CleanupRemoteAnnouncements,
      );
    }

    // Initialize KaTeX configuration early to suppress Unicode warnings
    // This must run before any formulas are rendered on the page
    if (isSupportedSite) {
      initKaTeXConfig();
      // Initialize i18n early to ensure translations are available
      initI18n().catch((e) => console.error('[Gemini Voyager] i18n init error:', e));
      cleanupManager.registerCleanupFunction(
        startStorageQuotaWarningToast(),
        CleanupPositions.CleanupStorageQuotaWarning,
      );
    }

    // Initialize i18n for plugin platforms (Claude/ChatGPT) so export translations load
    if (pluginPlatformId && !isSupportedSite) {
      initI18n().catch((e) => console.error('[Gemini Voyager] i18n init error:', e));
    }

    // If not a known site, check if it's a custom website (async)
    if (!isSupportedSite) {
      // Third-party plugin platforms (Claude / ChatGPT / Grok …): the plugin
      // host and platform theme already ran above. Start the cross-site Voyager
      // features that belong everywhere — currently just the Prompt Manager
      // floating ball. Native function plugins such as formula-copy and input
      // Vim are driven exclusively by PluginHost. Do NOT start Gemini-specific
      // features (folders, timeline, export, width adjusters, …) here. We set
      // `initialized` so the visibilitychange handler doesn't later fall into
      // initializeFeatures() (which is Gemini/AI-Studio/custom-site shaped).
      if (pluginPlatformId) {
        initialized = true;
        if (isPluginSubframe) return;
        console.log('[Gemini Voyager] Plugin platform: prompt manager');
        void startPromptManager()
          .then((instance) => {
            cleanupManager.registerCleanupFunction(
              () => instance.destroy(),
              CleanupPositions.DestroyPromptManagerInstance,
            );
          })
          .catch((error) => {
            console.error('[Gemini Voyager] Prompt Manager init error on plugin platform:', error);
          });
        // ChatGPT export is driven by PluginHost via the voyager.chatgpt-export
        // builtin plugin (opt-in), not started unconditionally here.
        // Formula copy here is driven by PluginHost via the voyager.formula-copy
        // builtin plugin (opt-in), not started unconditionally.
        return;
      }

      // For unknown sites, check storage asynchronously
      chrome.storage?.sync?.get({ gvPromptCustomWebsites: [] }, (result) => {
        const currentHost = location.host.toLowerCase();
        const isCustomSite = customWebsitesIncludeHost(result?.gvPromptCustomWebsites, currentHost);

        if (isCustomSite) {
          console.log('[Gemini Voyager] Custom website detected:', currentHost);
          initializeFeatures();
        } else {
          // Not a supported site, exit early
          console.log('[Gemini Voyager] Not a supported website, skipping initialization');
        }
      });
      return;
    }
    chrome.storage?.onChanged?.addListener(onStorageChanged);
    cleanupManager.registerCleanupFunction(
      () => chrome.storage?.onChanged?.removeListener(onStorageChanged),
      CleanupPositions.RemoveStorageOnChangedListener,
    );

    const delay = getInitializationDelay();

    if (delay === 0) {
      // Immediate initialization for foreground tabs
      initializeFeatures();
    } else {
      // Delayed initialization for background tabs
      initializationTimer = window.setTimeout(() => {
        initializationTimer = null;
        initializeFeatures();
      }, delay);
    }

    // Listen for visibility changes to handle tab switching
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Setup cleanup on page unload to prevent memory leaks
    window.addEventListener('beforeunload', () => {
      try {
        cleanupManager.executeCleanups();
      } catch (e) {
        if (isExtensionContextInvalidatedError(e)) {
          return;
        }
        console.error('[Gemini Voyager] Cleanup error:', e);
      }
    });
  } catch (e) {
    if (isExtensionContextInvalidatedError(e)) {
      return;
    }
    console.error('[Gemini Voyager] Fatal initialization error:', e);
  }
})();
