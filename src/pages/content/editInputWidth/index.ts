/**
 * Adjusts the edit input textarea width based on user settings
 * Targets the edit mode textarea in Gemini conversations
 *
 * Based on the chatWidth implementation pattern
 */

const STYLE_ID = 'gemini-voyager-edit-input-width';
const DEFAULT_PERCENT = 60;
const MIN_PERCENT = 30;
const MAX_PERCENT = 100;
const LEGACY_BASELINE_PX = 1200;

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

/**
 * Selectors for edit mode containers
 * Based on actual DOM structure: .query-content.edit-mode
 */
function getEditModeSelectors(): string[] {
  return ['.query-content.edit-mode', 'div.edit-mode', '[class*="edit-mode"]'];
}

/**
 * Applies the specified width (%) to edit input elements
 * Following the chatWidth pattern with container width removal and precise targeting
 */
function applyWidth(widthPercent: number): void {
  const normalizedPercent = normalizePercent(widthPercent, DEFAULT_PERCENT);
  const widthValue = `${normalizedPercent}vw`;

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }

  const editModeSelectors = getEditModeSelectors();
  const editModeRules = editModeSelectors.map((sel) => `${sel}`).join(',\n    ');

  style.textContent = `
    /* Remove width constraints from outer containers that contain edit mode (similar to chatWidth) */
    .content-wrapper:has(.edit-mode),
    .main-content:has(.edit-mode),
    .content-container:has(.edit-mode) {
      max-width: none !important;
    }

    /* Remove width constraints from main container when it has edit mode */
    [role="main"]:has(.edit-mode) {
      max-width: none !important;
    }

    main > div:has(.edit-mode) {
      max-width: none !important;
      width: 100% !important;
    }

    /* Target edit mode containers directly */
    ${editModeRules} {
      max-width: ${widthValue} !important;
      width: min(100%, ${widthValue}) !important;
    }

    /* Target the edit-container within edit-mode */
    .edit-mode .edit-container,
    .query-content.edit-mode .edit-container {
      max-width: ${widthValue} !important;
      width: min(100%, ${widthValue}) !important;
    }

    /* Target Material Design form field */
    .edit-mode .mat-mdc-form-field,
    .edit-container .mat-mdc-form-field,
    .edit-mode .edit-form {
      max-width: ${widthValue} !important;
      width: 100% !important;
    }

    /* Target text field wrapper and flex container */
    .edit-mode .mat-mdc-text-field-wrapper,
    .edit-mode .mat-mdc-form-field-flex,
    .edit-mode .mdc-text-field {
      max-width: ${widthValue} !important;
      width: 100% !important;
    }

    /* Target form field infix (contains the textarea) */
    .edit-mode .mat-mdc-form-field-infix {
      max-width: ${widthValue} !important;
      width: 100% !important;
    }

    /* Target the textarea itself */
    .edit-mode textarea,
    .edit-container textarea,
    .edit-mode .mat-mdc-input-element,
    .edit-mode .cdk-textarea-autosize {
      max-width: ${widthValue} !important;
      width: 100% !important;
      box-sizing: border-box !important;
    }

    /* ===== Main chat input area (input-container > input-area-v2) ===== */
    input-container {
      max-width: ${widthValue} !important;
      width: min(100%, ${widthValue}) !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }

    input-container .input-area-container {
      max-width: 100% !important;
      width: 100% !important;
    }

    input-area-v2 {
      max-width: 100% !important;
      width: 100% !important;
    }

    input-area-v2 .input-area {
      max-width: 100% !important;
      width: 100% !important;
    }

    /* Widen the file-drop overlay with the input area (#887). Gemini pins it to
       var(--bard-chat-window-max-width-default, 760px), which only matches the
       native input width. Kept less specific than chatWidth's overlay rule so
       both-enabled sessions follow chatWidth, like the input-area-v2 rules do. */
    file-drop-indicator .overlay-container[data-filedrop-id="chat-window-input-container"] {
      max-width: ${widthValue} !important;
      width: min(100%, ${widthValue}) !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }

    /* Fallback for browsers without :has() support */
    @supports not selector(:has(*)) {
      .content-wrapper,
      .main-content,
      .content-container {
        max-width: none !important;
      }
    }
  `;
}

/**
 * Removes the injected styles
 */
function removeStyles(): void {
  const style = document.getElementById(STYLE_ID);
  if (style) {
    style.remove();
  }
}

const ENABLED_KEY = 'gvEditInputWidthEnabled';

/**
 * Initializes and starts the edit input width adjuster
 */
export function startEditInputWidthAdjuster(): void {
  let currentWidthPercent = DEFAULT_PERCENT;
  let enabled = false;

  // Load initial state — request keys without defaults so we can distinguish
  // "key never existed" (upgrade) from "explicitly set to false"
  chrome.storage?.sync?.get(['geminiEditInputWidth', ENABLED_KEY], (res) => {
    const storedWidth = res?.geminiEditInputWidth;
    const normalized = normalizePercent(
      typeof storedWidth === 'number' ? storedWidth : DEFAULT_PERCENT,
      DEFAULT_PERCENT,
    );
    currentWidthPercent = normalized;

    const enabledRaw = res?.[ENABLED_KEY];
    if (enabledRaw === undefined) {
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
        chrome.storage?.sync?.set({ geminiEditInputWidth: normalized });
      } catch (e) {
        console.warn('[Gemini Voyager] Failed to migrate edit input width to %:', e);
      }
    }
  });

  // Listen for changes from storage (when user adjusts in popup)
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync') return;

    if (changes[ENABLED_KEY]) {
      enabled = changes[ENABLED_KEY].newValue === true;
      if (enabled) {
        applyWidth(currentWidthPercent);
      } else {
        removeStyles();
      }
    }

    if (changes.geminiEditInputWidth) {
      const newWidth = changes.geminiEditInputWidth.newValue;
      if (typeof newWidth === 'number') {
        const normalized = normalizePercent(newWidth, DEFAULT_PERCENT);
        currentWidthPercent = normalized;
        if (enabled) {
          applyWidth(currentWidthPercent);
        }

        if (normalized !== newWidth) {
          try {
            chrome.storage?.sync?.set({ geminiEditInputWidth: normalized });
          } catch (e) {
            console.warn('[Gemini Voyager] Failed to migrate edit input width to % on change:', e);
          }
        }
      }
    }
  });

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
      attributes: true,
      attributeFilter: ['class'], // Watch for class changes (e.g., edit-mode added)
    });
  }

  // Clean up on unload
  window.addEventListener('beforeunload', () => {
    observer.disconnect();
    removeStyles();
  });
}
