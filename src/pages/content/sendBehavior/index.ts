/**
 * Send Behavior Module
 *
 * Modifies Gemini/AI Studio input behavior with platform-scoped modes:
 *
 * 1. Gemini Ctrl+Enter Send (all browsers):
 *    - Enter key inserts a newline instead of sending
 *    - Ctrl+Enter sends the message
 *    - Controlled by `gvCtrlEnterSend` storage setting
 *
 * 2. AI Studio Enter Send:
 *    - Enter sends the message
 *    - Ctrl+Enter inserts a newline
 *    - Controlled by `gvAIStudioEnterSend` storage setting
 *
 * 3. Safari Enter Fix (Safari only):
 *    - Fixes Gemini's double-Enter-to-send bug on Safari
 *    - Single Enter directly clicks the send button
 *    - Controlled by `gvSafariEnterFix` storage setting
 *
 * If both Gemini modes are enabled, Ctrl+Enter Send takes priority (Enter → newline).
 *
 * ARCHITECTURE:
 * - Observer and listeners are ONLY active when at least one mode is enabled
 * - When both are disabled, no DOM observation or event handling occurs (zero performance overhead)
 * - Storage listener remains active to respond to setting changes
 */
import { LoggerService } from '@/core/services/LoggerService';
import { StorageKeys } from '@/core/types/common';
import { isSafari } from '@/core/utils/browser';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';

import { SEND_BUTTON_SELECTORS, isSendActionButton } from './sendButton';
import { getTextOffset, setCaretPosition } from './utils';

// ============================================================================
// Constants
// ============================================================================

/** Selector for editable elements */
const EDITABLE_SELECTORS = '[contenteditable="true"], [role="textbox"], textarea';

/** Log prefix for consistent logging */
const LOG_PREFIX = '[SendBehavior]';
const OBSERVER_DEBOUNCE_MS = 100;
const logger = LoggerService.getInstance().createChild('SendBehavior');

type SendBehaviorPlatform = 'gemini' | 'aistudio';

// ============================================================================
// State
// ============================================================================

let isCtrlEnterSendEnabled = false;
let isAIStudioEnterSendEnabled = false;
let isSafariEnterFixEnabled = false;
let isListenersActive = false;
let currentPlatform: SendBehaviorPlatform = 'gemini';
let observer: MutationObserver | null = null;
let observerDebounceTimer: number | null = null;
const observerPendingNodes = new Set<HTMLElement>();
let cleanupFns: (() => void)[] = [];
let storageListener:
  | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
  | null = null;

/** Track elements that already have listeners attached to prevent duplicates */
const attachedElements = new WeakSet<HTMLElement>();

// ============================================================================
// DOM Helpers
// ============================================================================

function isVisibleButton(element: Element): element is HTMLButtonElement {
  return element instanceof HTMLButtonElement && element.offsetParent !== null;
}

/**
 * Find the send button associated with the current input element.
 *
 * Strategy:
 * 1. Container Search: Use `closest()` to find a known container (e.g. `.text-input-field`, `chat-message`).
 * 2. Scoped Button Search: Only search for buttons within the found container to avoid stale matches.
 */
function findSendButton(inputElement: HTMLElement): HTMLElement | null {
  // 1. First, find a cohesive container wrapper that holds BOTH the input and its corresponding button
  //    Gemini/AI Studio provide distinct containers for the main input and edit inputs
  const containerSelectors = [
    // Global/main chat input wrapper
    '.text-input-field',
    // AI Studio prompt input wrappers
    'ms-prompt-input-wrapper',
    'ms-prompt-input',
    'ms-chat-turn-input',
    'ms-autosize-textarea',
    '.prompt-input-wrapper',
    '.prompt-input-container',
    // Active conversation edit container
    'chat-message',
    'form',
    // Modals/Dialogs
    '[role="dialog"]',
    '.mat-mdc-dialog-container',
  ];

  let container: HTMLElement | null = null;
  for (const selector of containerSelectors) {
    const closest = inputElement.closest(selector);
    if (closest instanceof HTMLElement) {
      container = closest;
      break;
    }
  }

  // 2. Search for the button strictly WITHIN the container or via bounded upward traversal
  // If we found a known cohesive container, just search in it
  if (container) {
    for (const selector of SEND_BUTTON_SELECTORS) {
      try {
        const element = container.querySelector(selector);
        if (element instanceof HTMLElement) {
          const closestButton = element.closest('button');
          // Ensure the found button is still within our safe container boundary
          const button =
            closestButton && container.contains(closestButton) ? closestButton : element;

          if (button instanceof HTMLElement && button.offsetParent !== null) {
            return button;
          }
        }
      } catch {
        // Invalid selector, continue
      }
    }

    // Fallback search within container by localized labels or icon text
    const allButtons = container.querySelectorAll('button');
    for (const button of allButtons) {
      if (isVisibleButton(button) && isSendActionButton(button)) {
        return button;
      }
    }
  }

  return null;
}

/**
 * Insert a newline in a contenteditable element
 *
 * Gemini uses Quill editor (identified by class "ql-editor").
 * Direct DOM manipulation with <br> elements doesn't work well with Quill
 * because it manages its own DOM state.
 *
 * Strategy:
 * 1. First try document.execCommand - works in most browsers
 * 2. If that fails, simulate a Shift+Enter keypress which Quill handles natively
 */
function insertNewlineInContentEditable(target: HTMLElement): void {
  // Method 1: Try execCommand (deprecated but still works in most browsers)
  // This is the most reliable method for contenteditable elements
  const currentOffset = getTextOffset(target);

  // This might trigger a React re-render, creating a new DOM structure
  const success = document.execCommand('insertParagraph', false);
  if (success) {
    if (currentOffset !== null) {
      const newOffset = currentOffset + 1;
      const restoreCaret = () => setCaretPosition(target, newOffset);

      restoreCaret();
      requestAnimationFrame(restoreCaret);
    }

    // Trigger input event to notify listeners (ensure data sync)
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  // Method 2: Try insertHTML with a <br> tag
  const htmlSuccess = document.execCommand('insertHTML', false, '<br><br>');

  if (htmlSuccess) {
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  // Method 3: Simulate Shift+Enter keypress as fallback
  // This tells Quill to handle the newline in its own way
  const shiftEnterEvent = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });

  target.dispatchEvent(shiftEnterEvent);
}

/**
 * Insert a newline in a textarea
 */
function insertNewlineInTextarea(textarea: HTMLTextAreaElement): void {
  // add this line to prevent focus loss in Angular's internal Textarea updates
  textarea.focus();
  const success = document.execCommand('insertText', false, '\n');

  if (!success) {
    // Fallback: direct value manipulation (loses undo history but guarantees insertion)
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    textarea.value = value.substring(0, start) + '\n' + value.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + 1;
  }

  // Trigger input event to notify any listeners
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Handle keydown events on the input area
 *
 * Platform modes:
 * - Gemini Ctrl+Enter Send: Enter → newline, Ctrl/Cmd+Enter → send
 * - AI Studio Enter Send: Enter → send, Ctrl/Cmd+Enter → newline
 * - Safari Enter Fix: Plain Enter → directly click send button (bypasses Safari double-Enter bug)
 *
 * If both Gemini modes are enabled, Ctrl+Enter Send takes priority.
 */
function handleKeyDown(event: KeyboardEvent): void {
  // Early exit if no mode is active (should not happen, but defensive check)
  if (!isCtrlEnterSendEnabled && !isAIStudioEnterSendEnabled && !isSafariEnterFixEnabled) return;

  // Fix for Issue 260: Ignore events during IME composition
  if (event.isComposing) return;

  // Only handle Enter key
  if (event.key !== 'Enter') return;

  const target = event.target as HTMLElement;

  // Check if we're in an editable area (Gemini uses contenteditable divs)
  const isContentEditable =
    target.isContentEditable || target.getAttribute('contenteditable') === 'true';
  const isTextarea = target.tagName === 'TEXTAREA';

  // Ignore INPUT elements - they are usually single-line (search, rename)
  // and pressing Enter there should trigger the default submit action
  if (!isContentEditable && !isTextarea) return;

  // --- Gemini Ctrl+Enter Send mode ---
  if (currentPlatform === 'gemini' && isCtrlEnterSendEnabled) {
    // Ctrl+Enter or Cmd+Enter: Send the message
    if (event.ctrlKey || event.metaKey) {
      const sendButton = findSendButton(target);
      if (sendButton) {
        event.preventDefault();
        event.stopPropagation();
        sendButton.click();
      }
      return;
    }

    // Shift+Enter: Default behavior (already inserts newline in most cases)
    if (event.shiftKey) return;

    // Plain Enter: Insert a newline instead of sending
    event.preventDefault();
    event.stopPropagation();

    if (isContentEditable) {
      insertNewlineInContentEditable(target);
    } else if (isTextarea) {
      insertNewlineInTextarea(target as HTMLTextAreaElement);
    }
    return;
  }

  // --- AI Studio Enter Send mode ---
  if (currentPlatform === 'aistudio' && isAIStudioEnterSendEnabled) {
    // Ctrl+Enter or Cmd+Enter: Insert a newline instead of AI Studio's native send action
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopPropagation();

      if (isContentEditable) {
        insertNewlineInContentEditable(target);
      } else if (isTextarea) {
        insertNewlineInTextarea(target as HTMLTextAreaElement);
      }
      return;
    }

    // Shift+Enter remains the native newline behavior
    if (event.shiftKey || event.altKey) return;

    // Plain Enter: Send the message
    const sendButton = findSendButton(target);
    if (sendButton) {
      event.preventDefault();
      event.stopPropagation();
      sendButton.click();
    }
    return;
  }

  // --- Safari Enter Fix mode ---
  // Only active on Gemini when Ctrl+Enter Send is NOT enabled and we're on Safari
  if (currentPlatform === 'gemini' && isSafariEnterFixEnabled && isSafari()) {
    // Only handle plain Enter (no modifiers)
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;

    // Find and click the send button directly, bypassing Gemini's
    // broken double-Enter behavior on Safari
    const sendButton = findSendButton(target);
    if (sendButton) {
      event.preventDefault();
      event.stopPropagation();
      sendButton.click();
    }
  }
}

// ============================================================================
// Attachment Logic
// ============================================================================

/**
 * Attach event listener to an input element
 */
function attachToInput(element: HTMLElement): void {
  // Prevent duplicate listeners
  if (attachedElements.has(element)) return;

  // Use capture phase to intercept before other handlers
  element.addEventListener('keydown', handleKeyDown, { capture: true });

  attachedElements.add(element);

  cleanupFns.push(() => {
    element.removeEventListener('keydown', handleKeyDown, { capture: true });
    attachedElements.delete(element);
  });
}

/**
 * Find and attach to all input areas on the page
 */
function attachToAllInputs(): void {
  const editables = document.querySelectorAll<HTMLElement>(EDITABLE_SELECTORS);
  editables.forEach(attachToInput);
}

// ============================================================================
// Observer Management
// ============================================================================

/**
 * Setup observer to watch for dynamically added input elements
 * NOTE: Only call this when the feature is enabled!
 */
function setupObserver(): void {
  if (observer) return;

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement) observerPendingNodes.add(node);
      }
    }

    if (observerPendingNodes.size === 0) return;
    if (observerDebounceTimer !== null) window.clearTimeout(observerDebounceTimer);
    observerDebounceTimer = window.setTimeout(() => {
      observerDebounceTimer = null;
      const pendingNodes = Array.from(observerPendingNodes);
      observerPendingNodes.clear();
      pendingNodes.forEach((node) => {
        if (!node.isConnected) return;

        // Check if the node itself is an input
        if (
          node.isContentEditable ||
          node.getAttribute('role') === 'textbox' ||
          node.tagName === 'TEXTAREA'
        ) {
          attachToInput(node);
        }

        // Check descendants
        const editables = node.querySelectorAll<HTMLElement>(EDITABLE_SELECTORS);
        editables.forEach(attachToInput);
      });
    }, OBSERVER_DEBOUNCE_MS);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

/**
 * Disconnect the observer
 */
function disconnectObserver(): void {
  if (observerDebounceTimer !== null) {
    window.clearTimeout(observerDebounceTimer);
    observerDebounceTimer = null;
  }
  observerPendingNodes.clear();
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

// ============================================================================
// Feature Enable/Disable
// ============================================================================

/**
 * Check if at least one mode requires active listeners.
 * Safari Enter Fix only activates on Safari to avoid unnecessary
 * overhead on Chrome/Firefox (e.g. when the setting is synced from Safari).
 */
function shouldBeActive(): boolean {
  if (currentPlatform === 'aistudio') {
    return isAIStudioEnterSendEnabled;
  }

  return isCtrlEnterSendEnabled || (isSafariEnterFixEnabled && isSafari());
}

/**
 * Activate listeners: attach to inputs and start observing.
 * Called when transitioning from no active modes to at least one active mode.
 */
function activateListeners(): void {
  if (isListenersActive) return;

  isListenersActive = true;
  attachToAllInputs();
  setupObserver();

  logger.info('Listeners activated');
}

/**
 * Deactivate listeners: remove all listeners and stop observing.
 * Called when transitioning from active modes to no active modes.
 */
function deactivateListeners(): void {
  if (!isListenersActive) return;

  isListenersActive = false;

  // Remove all event listeners
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];

  // Stop observing DOM changes
  disconnectObserver();

  logger.info('Listeners deactivated');
}

/**
 * Reconcile listener state based on current mode flags.
 * Activates or deactivates listeners as needed.
 */
function reconcileListeners(): void {
  if (shouldBeActive()) {
    activateListeners();
  } else {
    deactivateListeners();
  }
}

// ============================================================================
// Storage & Initialization
// ============================================================================

/**
 * Load the enabled state from storage for both modes
 */
async function loadSettings(): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage?.sync?.get) {
        resolve();
        return;
      }
      chrome.storage.sync.get(
        {
          [StorageKeys.CTRL_ENTER_SEND]: false,
          [StorageKeys.AISTUDIO_ENTER_SEND]: false,
          [StorageKeys.SAFARI_ENTER_FIX]: false,
        },
        (result) => {
          isCtrlEnterSendEnabled = result?.[StorageKeys.CTRL_ENTER_SEND] === true;
          isAIStudioEnterSendEnabled = result?.[StorageKeys.AISTUDIO_ENTER_SEND] === true;
          isSafariEnterFixEnabled = result?.[StorageKeys.SAFARI_ENTER_FIX] === true;
          resolve();
        },
      );
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        resolve();
        return;
      }
      console.warn(LOG_PREFIX, 'Failed to load settings:', error);
      resolve();
    }
  });
}

/**
 * Setup storage change listener
 * NOTE: This listener remains active even when feature is disabled,
 * so we can respond to setting changes.
 */
function setupStorageListener(): void {
  if (storageListener) return;

  storageListener = (changes, areaName) => {
    if (areaName !== 'sync') return;

    const hasCtrlEnterChange = StorageKeys.CTRL_ENTER_SEND in changes;
    const hasAIStudioEnterChange = StorageKeys.AISTUDIO_ENTER_SEND in changes;
    const hasSafariFixChange = StorageKeys.SAFARI_ENTER_FIX in changes;

    if (!hasCtrlEnterChange && !hasAIStudioEnterChange && !hasSafariFixChange) return;

    if (hasCtrlEnterChange) {
      isCtrlEnterSendEnabled = changes[StorageKeys.CTRL_ENTER_SEND].newValue === true;
    }
    if (hasAIStudioEnterChange) {
      isAIStudioEnterSendEnabled = changes[StorageKeys.AISTUDIO_ENTER_SEND].newValue === true;
    }
    if (hasSafariFixChange) {
      isSafariEnterFixEnabled = changes[StorageKeys.SAFARI_ENTER_FIX].newValue === true;
    }

    reconcileListeners();
  };

  try {
    chrome.storage?.onChanged?.addListener(storageListener);
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      return;
    }
    console.warn(LOG_PREFIX, 'Failed to setup storage listener:', error);
  }
}

/**
 * Cleanup all resources
 */
function cleanup(): void {
  isCtrlEnterSendEnabled = false;
  isAIStudioEnterSendEnabled = false;
  isSafariEnterFixEnabled = false;
  currentPlatform = 'gemini';
  deactivateListeners();

  if (storageListener) {
    try {
      chrome.storage?.onChanged?.removeListener(storageListener);
    } catch {
      // Ignore cleanup errors
    }
    storageListener = null;
  }

  logger.info('Cleanup complete');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the send behavior module
 * @returns A cleanup function to be called on unmount
 */
export async function startSendBehavior(
  platform: SendBehaviorPlatform = 'gemini',
): Promise<() => void> {
  currentPlatform = platform;

  // Always setup storage listener first (to respond to setting changes)
  setupStorageListener();

  // Load initial settings and activate if any mode is enabled
  await loadSettings();
  reconcileListeners();

  if (!shouldBeActive()) {
    logger.info('All modes disabled, skipping initialization');
  }

  return cleanup;
}
