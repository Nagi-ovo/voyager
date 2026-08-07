/**
 * Adjusts the chat area width based on user settings (stored as viewport %)
 */

const STYLE_ID = 'gemini-voyager-chat-width';
const DEFAULT_PERCENT = 70;
const MIN_PERCENT = 30;
const MAX_PERCENT = 100;
const LEGACY_BASELINE_PX = 1200;

// Selectors based on the export functionality that already works
function getUserSelectors(): string[] {
  return [
    '.user-query-bubble-container',
    '.user-query-container',
    'user-query-content',
    'user-query',
    'div[aria-label="User message"]',
    'article[data-author="user"]',
    '[data-message-author-role="user"]',
  ];
}

function getAssistantSelectors(): string[] {
  return [
    'model-response',
    '.model-response',
    'response-container',
    '.response-container',
    '.presented-response-container',
    '[aria-label="Gemini response"]',
    '[data-message-author-role="assistant"]',
    '[data-message-author-role="model"]',
    'article[data-author="assistant"]',
  ];
}

function getTableSelectors(): string[] {
  return [
    'table-block',
    '.table-block',
    'table-block .table-block',
    'table-block .table-content',
    '.table-block.new-table-style',
    '.table-block.has-scrollbar',
    '.table-block .table-content',
    '.table-block-component',
    '.horizontal-scroll-wrapper',
  ];
}

const clampPercent = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const normalizePercent = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  if (value > MAX_PERCENT) {
    const approx = (value / LEGACY_BASELINE_PX) * 100;
    return clampPercent(approx, MIN_PERCENT, MAX_PERCENT);
  }
  return clampPercent(value, MIN_PERCENT, MAX_PERCENT);
};

function applyWidth(widthPercent: number) {
  const normalizedPercent = normalizePercent(widthPercent, DEFAULT_PERCENT);
  // Use screen width as reference to compute pixel-based max-width.
  // This provides adaptive behavior for split-screen / narrow windows:
  // - Fullscreen: width ≈ percent% of screen (as intended by the slider)
  // - Split-screen: content fills available space since pixel max-width > viewport
  const screenWidth = screen.availWidth || screen.width || 1920;
  const widthValue = `${Math.round((normalizedPercent / 100) * screenWidth)}px`;

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }

  const userSelectors = getUserSelectors();
  const assistantSelectors = getAssistantSelectors();
  const tableSelectors = getTableSelectors();

  // Build comprehensive CSS rules
  const userRules = userSelectors.map((sel) => `${sel}`).join(',\n    ');
  const assistantRules = assistantSelectors.map((sel) => `${sel}`).join(',\n    ');
  const tableRules = tableSelectors.map((sel) => `${sel}`).join(',\n    ');

  // A small gap to account for scrollbars
  const GAP_PX = 10;

  style.textContent = `
    /* Remove width constraints from outer containers that contain conversations */
    .content-wrapper:has(chat-window),
    .main-content:has(chat-window),
    .content-container:has(chat-window),
    .content-container:has(.conversation-container) {
      max-width: none !important;
    }

    /* Remove width constraints from main and conversation containers, but not buttons */
    [role="main"]:has(chat-window),
    [role="main"]:has(.conversation-container) {
      max-width: none !important;
    }

    /* Target chat window and related containers; A small gap to account for scrollbars */
    chat-window,
    .chat-container,
    chat-window-content,
    .chat-history-scroll-container,
    .chat-history,
    .conversation-container {
      max-width: none !important;
      padding-right: ${GAP_PX}px !important;
      box-sizing: border-box !important;
    }

    main > div:has(user-query),
    main > div:has(model-response),
    main > div:has(.conversation-container) {
      max-width: none !important;
      width: 100% !important;
    }

    /* Fallback for browsers without :has() support */
    @supports not selector(:has(*)) {
      .content-wrapper,
      .main-content,
      .content-container {
        max-width: none !important;
      }

      main > div:not(:has(button)):not(.main-menu-button) {
        max-width: none !important;
        width: 100% !important;
      }
    }

    /* User query containers */
    ${userRules} {
      max-width: ${widthValue} !important;
      width: min(100%, ${widthValue}) !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }

    /* Model response containers */
    ${assistantRules} {
      max-width: ${widthValue} !important;
      width: min(100%, ${widthValue}) !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }

    /* Gemini table containers */
    ${tableRules} {
      max-width: ${widthValue} !important;
      width: min(100%, ${widthValue}) !important;
      margin-left: auto !important;
      margin-right: auto !important;
      box-sizing: border-box !important;
    }

    table-block .table-block,
    .table-block.has-scrollbar,
    .table-block.new-table-style {
      overflow-x: hidden !important;
    }

    table-block .table-content,
    .table-block .table-content {
      width: 100% !important;
      overflow-x: auto !important;
    }

    model-response:has(> .deferred-response-indicator),
    .response-container:has(img[src*="sparkle"]), 
    main > div:has(img[src*="sparkle"]) {
      max-width: ${widthValue} !important;
      width: min(100%, ${widthValue}) !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }

    /* Additional deep targeting for nested elements */
    user-query,
    user-query > *,
    user-query > * > *,
    model-response,
    model-response > *,
    model-response > * > *,
    response-container,
    response-container > *,
    response-container > * > * {
      max-width: ${widthValue} !important;
    }

    /* Target specific internal containers that might have fixed widths */
    .presented-response-container,
    [data-message-author-role] {
      max-width: ${widthValue} !important;
    }

    /* Extend input-container gradient to match chat width */
    input-container {
      max-width: none !important;
      width: 100% !important;
    }

    input-container .input-area-container,
    input-container input-area-v2 {
      max-width: ${widthValue} !important;
      width: min(100%, ${widthValue}) !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }

    /* Widen the file-drop overlay with the input area (#887). Gemini pins it to
       var(--bard-chat-window-max-width-default, 760px), which only matches the
       native input width. The input-container prefix keeps this rule more
       specific than editInputWidth's overlay rule, mirroring how the two
       modules' input-area-v2 rules already resolve when both are enabled. */
    input-container file-drop-indicator .overlay-container[data-filedrop-id="chat-window-input-container"] {
      max-width: ${widthValue} !important;
      width: min(100%, ${widthValue}) !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }

    /* Specific fix for user bubble background to fit content but respect max-width */
    .user-query-bubble-with-background {
      max-width: ${widthValue} !important;
      width: fit-content !important;
    }
  `;
}

function removeStyles() {
  const style = document.getElementById(STYLE_ID);
  if (style) {
    style.remove();
  }
}

const ENABLED_KEY = 'gvChatWidthEnabled';

export function startChatWidthAdjuster() {
  let currentWidthPercent = DEFAULT_PERCENT;
  let enabled = false;

  // Load initial state — request keys without defaults so we can distinguish
  // "key never existed" (upgrade) from "explicitly set to false"
  chrome.storage?.sync?.get(['geminiChatWidth', ENABLED_KEY], (res) => {
    const storedWidth = res?.geminiChatWidth;
    const numericStoredWidth = typeof storedWidth === 'number' ? storedWidth : DEFAULT_PERCENT;
    const normalized = normalizePercent(numericStoredWidth, DEFAULT_PERCENT);
    currentWidthPercent = normalized;

    const enabledRaw = res?.[ENABLED_KEY];
    if (enabledRaw === undefined) {
      // Upgrade path: enabled key was never set.
      // Auto-enable if user had previously customized the width.
      enabled =
        typeof storedWidth === 'number' &&
        normalizePercent(storedWidth, DEFAULT_PERCENT) !== DEFAULT_PERCENT;
      if (enabled) {
        try {
          chrome.storage?.sync?.set({ [ENABLED_KEY]: true });
        } catch {}
      }
    } else {
      enabled = enabledRaw === true;
    }

    if (enabled) {
      applyWidth(currentWidthPercent);
    }

    if (typeof storedWidth === 'number' && storedWidth !== normalized) {
      try {
        chrome.storage?.sync?.set({ geminiChatWidth: normalized });
      } catch (e) {
        console.warn('[Gemini Voyager] Failed to migrate chat width to %:', e);
      }
    }
  });

  // Listen for changes from storage
  const storageChangeHandler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'sync') return;

    if (changes[ENABLED_KEY]) {
      enabled = changes[ENABLED_KEY].newValue === true;
      if (enabled) {
        applyWidth(currentWidthPercent);
      } else {
        removeStyles();
      }
    }

    if (changes.geminiChatWidth) {
      const newWidth = changes.geminiChatWidth.newValue;
      if (typeof newWidth === 'number') {
        const normalized = normalizePercent(newWidth, DEFAULT_PERCENT);
        currentWidthPercent = normalized;
        if (enabled) {
          applyWidth(currentWidthPercent);
        }

        if (normalized !== newWidth) {
          try {
            chrome.storage?.sync?.set({ geminiChatWidth: normalized });
          } catch (e) {
            console.warn('[Gemini Voyager] Failed to migrate chat width to % on change:', e);
          }
        }
      }
    }
  };

  chrome.storage?.onChanged?.addListener(storageChangeHandler);

  // Re-apply styles when DOM changes (for dynamic content)
  // Use debouncing and cache the width to avoid storage reads
  let debounceTimer: number | null = null;
  const observer = new MutationObserver(() => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = window.setTimeout(() => {
      if (enabled) {
        applyWidth(currentWidthPercent);
      }
      debounceTimer = null;
    }, 200);
  });

  // Observe the main conversation area for changes
  const main = document.querySelector('main');
  if (main) {
    observer.observe(main, {
      childList: true,
      subtree: true,
    });
  }

  // Clean up on unload to prevent memory leaks
  window.addEventListener(
    'beforeunload',
    () => {
      observer.disconnect();
      removeStyles();
      // Remove storage listener
      try {
        chrome.storage?.onChanged?.removeListener(storageChangeHandler);
      } catch (e) {
        console.error('[Gemini Voyager] Failed to remove storage listener on unload:', e);
      }
    },
    { once: true },
  );
}
