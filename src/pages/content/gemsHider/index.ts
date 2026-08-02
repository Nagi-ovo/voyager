/**
 * Sidebar section hider for legacy Gemini Gems.
 *
 * Gemini keeps shipping new sidebar section shells for project-like content.
 * This module keeps the same hide/show affordance across those variants while
 * persisting state independently for each section.
 */
import browser from 'webextension-polyfill';

import { type StorageKey, StorageKeys } from '@/core/types/common';

import { getTranslationSync } from '../../../utils/i18n';
import { removeSidebarCollapseNudge, showSidebarCollapseNudgeOnce } from '../sidebarCollapseNudge';

const STYLE_ID = 'gv-sidebar-section-hider-style';
const HIDDEN_CLASS = 'gv-sidebar-section-hidden';
const PEEK_BAR_CLASS = 'gv-sidebar-section-peek-bar';
const TOGGLE_BTN_CLASS = 'gv-sidebar-section-toggle-btn';
const TARGET_CLASS = 'gv-sidebar-section-hider-target';
const TOOLTIP_ID = 'gv-sidebar-section-tooltip';
const TOOLTIP_VISIBLE_CLASS = 'gv-visible';
const PROCESSED_ATTR = 'data-gv-sidebar-section-hider';
const SECTION_ID_ATTR = 'data-gv-sidebar-section-id';
const ARROW_ICON_SELECTOR = '[data-test-id="arrow-icon"]';

type SectionId = 'gems';
type TranslationKey = Parameters<typeof getTranslationSync>[0];

interface HidableSectionConfig {
  id: SectionId;
  containerSelector: string;
  requiredDescendantSelector?: string;
  storageKey: StorageKey;
  hideTranslationKey: TranslationKey;
  showTranslationKey: TranslationKey;
  hideFallback: string;
  showFallback: string;
  toggleHostSelector?: string;
  /**
   * Where the hide-toggle button gets mounted.
   *
   * `'inline'` (default) inserts a real `<button>` into the toggle host element.
   *
   * `'absolute'` mounts a `<span role="button">` directly on the section
   * element and positions it via CSS in the top-right corner. Used for Gemini's
   * 2026 `<expandable-section>` shells, where the natural host
   * `.expandable-section-header` is itself a `<button>` — nested interactive
   * elements are invalid HTML and confuse keyboard navigation.
   */
  placement?: 'inline' | 'absolute';
}

const SECTION_CONFIGS: readonly HidableSectionConfig[] = [
  {
    // Gemini's 2026 redesign removed the Gems section from the sidebar. We
    // keep the config so older layouts still get the affordance; the new
    // selector never matches on current Gemini.
    id: 'gems',
    containerSelector: '.gems-list-container',
    storageKey: StorageKeys.GEMS_HIDDEN,
    hideTranslationKey: 'gemsHide',
    showTranslationKey: 'gemsShow',
    hideFallback: 'Hide Gems',
    showFallback: 'Show Gems',
  },
  // Notebooks intentionally omitted: the same top-right slot is now used by
  // the folder-anchor swap button (mounted from the folder manager). Keeping
  // both would crowd the corner and the swap action subsumes the value of
  // hiding the whole Notebooks section. The StorageKeys.NOTEBOOKS_HIDDEN key
  // is preserved so any pre-existing hidden state simply stops applying — the
  // section will naturally render again.
] as const;

let initialized = false;
let observer: MutationObserver | null = null;
let observerDebounceTimer: number | null = null;
const observerPendingNodes = new Set<HTMLElement>();
let languageChangeListener:
  | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
  | null = null;

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${TARGET_CLASS} {
      position: relative;
      transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .${TOGGLE_BTN_CLASS} {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: none;
      background: transparent;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transform: scale(0.8);
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      color: var(--gm3-sys-color-on-surface-variant, #5f6368);
      vertical-align: middle;
      margin-right: 4px;
    }

    .${TOGGLE_BTN_CLASS}:hover {
      background: var(--gm3-sys-color-surface-container-highest, rgba(0, 0, 0, 0.12));
      transform: scale(1.1);
    }

    .${TOGGLE_BTN_CLASS}:active {
      transform: scale(0.95);
    }

    .${TOGGLE_BTN_CLASS} svg {
      width: 16px;
      height: 16px;
      transition: transform 0.2s ease;
    }

    ${ARROW_ICON_SELECTOR}:hover .${TOGGLE_BTN_CLASS},
    .gv-folder-header:hover .${TOGGLE_BTN_CLASS},
    .${TOGGLE_BTN_CLASS}:hover {
      opacity: 1;
      transform: scale(1);
    }

    /* Absolute-placement variant: mounted on the expandable-section itself
     * (e.g. Notebooks) instead of nested inside the header button. Reveals on
     * hover of the parent section. */
    .${TOGGLE_BTN_CLASS}--absolute {
      position: absolute;
      top: 4px;
      right: 8px;
      margin-right: 0;
      z-index: 2;
    }
    expandable-section:hover > .${TOGGLE_BTN_CLASS}--absolute,
    .${TOGGLE_BTN_CLASS}--absolute:hover,
    .${TOGGLE_BTN_CLASS}--absolute:focus-visible {
      opacity: 1;
      transform: scale(1);
    }

    .${HIDDEN_CLASS} {
      max-height: 0 !important;
      overflow: hidden !important;
      opacity: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      pointer-events: none !important;
    }

    .${PEEK_BAR_CLASS} {
      height: 6px;
      margin: 8px 16px;
      border-radius: 3px;
      background: linear-gradient(
        90deg,
        transparent 0%,
        var(--gm3-sys-color-outline-variant, rgba(0, 0, 0, 0.08)) 20%,
        var(--gm3-sys-color-outline-variant, rgba(0, 0, 0, 0.08)) 80%,
        transparent 100%
      );
      cursor: pointer;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      display: none;
    }

    .${PEEK_BAR_CLASS}::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 40px;
      height: 4px;
      border-radius: 2px;
      background: var(--gm3-sys-color-primary, #1a73e8);
      opacity: 0;
      transition: all 0.2s ease;
    }

    .${PEEK_BAR_CLASS}:hover {
      height: 12px;
      background: linear-gradient(
        90deg,
        transparent 0%,
        var(--gm3-sys-color-primary-container, rgba(26, 115, 232, 0.12)) 15%,
        var(--gm3-sys-color-primary-container, rgba(26, 115, 232, 0.12)) 85%,
        transparent 100%
      );
    }

    .${PEEK_BAR_CLASS}:hover::after {
      opacity: 1;
      width: 60px;
    }

    #${TOOLTIP_ID} {
      position: fixed;
      left: 0;
      top: 0;
      padding: 6px 12px;
      background: var(--gm3-sys-color-inverse-surface, #303030);
      color: var(--gm3-sys-color-inverse-on-surface, #f5f5f5);
      font-family: 'Google Sans', Roboto, sans-serif;
      font-size: 12px;
      font-weight: 500;
      border-radius: 8px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      z-index: 10000;
      transform: translate(-50%, calc(-100% - 8px));
    }

    #${TOOLTIP_ID}.${TOOLTIP_VISIBLE_CLASS} {
      opacity: 1;
    }

    .${PEEK_BAR_CLASS}.gv-visible {
      display: block;
    }

    @media (prefers-color-scheme: dark) {
      .${TOGGLE_BTN_CLASS} {
        background: rgba(255, 255, 255, 0.08);
        color: #e8eaed;
      }

      .${TOGGLE_BTN_CLASS}:hover {
        background: rgba(255, 255, 255, 0.14);
      }

      .${PEEK_BAR_CLASS} {
        background: linear-gradient(
          90deg,
          transparent 0%,
          rgba(255, 255, 255, 0.06) 20%,
          rgba(255, 255, 255, 0.06) 80%,
          transparent 100%
        );
      }

      .${PEEK_BAR_CLASS}:hover {
        background: linear-gradient(
          90deg,
          transparent 0%,
          rgba(138, 180, 248, 0.15) 15%,
          rgba(138, 180, 248, 0.15) 85%,
          transparent 100%
        );
      }

      .${PEEK_BAR_CLASS}::after {
        background: #8ab4f8;
      }
    }

    body[data-theme="dark"] .${TOGGLE_BTN_CLASS},
    body.dark-theme .${TOGGLE_BTN_CLASS} {
      background: rgba(255, 255, 255, 0.08);
      color: #e8eaed;
    }

    body[data-theme="dark"] .${TOGGLE_BTN_CLASS}:hover,
    body.dark-theme .${TOGGLE_BTN_CLASS}:hover {
      background: rgba(255, 255, 255, 0.14);
    }
  `;

  document.head.appendChild(style);
}

function getSectionText(section: HidableSectionConfig, kind: 'hide' | 'show'): string {
  const translationKey = kind === 'hide' ? section.hideTranslationKey : section.showTranslationKey;
  const fallback = kind === 'hide' ? section.hideFallback : section.showFallback;
  return getTranslationSync(translationKey) || fallback;
}

/**
 * Build the hide-toggle element.
 *
 * Inline mode returns a real `<button>`.
 *
 * Absolute mode returns a `<span role="button">` so the toggle can live inside
 * an element that is itself a `<button>` (Gemini's `.expandable-section-header`)
 * without producing invalid nested-button HTML. Keyboard support is added
 * separately in `setupSectionHider`.
 */
function createToggleButton(section: HidableSectionConfig): HTMLElement {
  const placement = section.placement ?? 'inline';
  const useSpan = placement === 'absolute';
  const btn = document.createElement(useSpan ? 'span' : 'button');
  btn.className = TOGGLE_BTN_CLASS;
  if (useSpan) {
    btn.classList.add(`${TOGGLE_BTN_CLASS}--absolute`);
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
  }
  btn.setAttribute(SECTION_ID_ATTR, section.id);

  const label = getSectionText(section, 'hide');
  btn.setAttribute('aria-label', label);
  btn.title = label;

  btn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor">
      <path d="m644-428-58-58q9-47-27-88t-93-32l-58-58q17-8 34.5-12t37.5-4q75 0 127.5 52.5T660-500q0 20-4 37.5T644-428Zm128 126-58-56q38-29 67.5-63.5T832-500q-50-101-143.5-160.5T480-720q-29 0-57 4t-55 12l-62-62q41-17 84-25.5t90-8.5q151 0 269 83.5T920-500q-23 59-60.5 109.5T772-302Zm20 246L624-222q-35 11-70.5 16.5T480-200q-151 0-269-83.5T40-500q21-53 53-98.5t73-81.5L56-792l56-56 736 736-56 56ZM222-624q-29 26-53 57t-41 67q50 101 143.5 160.5T480-280q20 0 39-2.5t39-5.5l-36-38q-11 3-21 4.5t-21 1.5q-75 0-127.5-52.5T300-500q0-11 1.5-21t4.5-21l-84-82Zm319 93Zm-151 75Z"/>
    </svg>
  `;

  return btn;
}

function createPeekBar(section: HidableSectionConfig): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = PEEK_BAR_CLASS;
  bar.setAttribute(SECTION_ID_ATTR, section.id);

  const label = getSectionText(section, 'show');
  bar.setAttribute('data-tooltip', label);
  bar.title = label;
  bar.setAttribute('role', 'button');
  bar.setAttribute('tabindex', '0');
  bar.setAttribute('aria-label', label);

  return bar;
}

function getTooltipElement(): HTMLDivElement {
  let tooltip = document.getElementById(TOOLTIP_ID) as HTMLDivElement | null;
  if (tooltip) {
    return tooltip;
  }

  tooltip = document.createElement('div');
  tooltip.id = TOOLTIP_ID;
  tooltip.setAttribute('role', 'tooltip');
  document.body.appendChild(tooltip);

  return tooltip;
}

function hideTooltip(): void {
  document.getElementById(TOOLTIP_ID)?.classList.remove(TOOLTIP_VISIBLE_CLASS);
}

function showTooltip(bar: HTMLDivElement): void {
  const label = bar.getAttribute('data-tooltip') || bar.title;
  if (!label) {
    hideTooltip();
    return;
  }

  const tooltip = getTooltipElement();
  const rect = bar.getBoundingClientRect();

  tooltip.textContent = label;
  tooltip.style.left = `${rect.left + rect.width / 2}px`;
  tooltip.style.top = `${Math.max(rect.top, 16)}px`;
  tooltip.classList.add(TOOLTIP_VISIBLE_CLASS);
}

function getSectionConfig(sectionId: string | null): HidableSectionConfig | undefined {
  return SECTION_CONFIGS.find((section) => section.id === sectionId);
}

async function getHiddenState(section: HidableSectionConfig): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.storage?.local?.get({ [section.storageKey]: false }, (result) => {
        // Check for chrome.runtime.lastError to avoid silent failures
        if (chrome.runtime?.lastError) {
          console.warn(
            `[Gemini Voyager] getHiddenState error for ${section.id}:`,
            chrome.runtime.lastError.message,
          );
          resolve(localStorage.getItem(section.storageKey) === 'true');
          return;
        }
        resolve(result?.[section.storageKey] === true);
      });
    } catch {
      resolve(localStorage.getItem(section.storageKey) === 'true');
    }
  });
}

async function setHiddenState(section: HidableSectionConfig, hidden: boolean): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage?.local?.set({ [section.storageKey]: hidden }, () => {
        if (chrome.runtime?.lastError) {
          console.warn(
            `[Gemini Voyager] setHiddenState error for ${section.id}:`,
            chrome.runtime.lastError.message,
          );
          localStorage.setItem(section.storageKey, String(hidden));
        }
        resolve();
      });
    } catch {
      localStorage.setItem(section.storageKey, String(hidden));
      resolve();
    }
  });
}

function applyState(sectionEl: HTMLElement, peekBar: HTMLDivElement, hidden: boolean): void {
  // Guard: if either element was removed from the DOM (e.g. Gemini re-rendered
  // the sidebar), skip applying state to avoid orphaned hidden elements.
  if (!sectionEl.isConnected || !peekBar.isConnected) {
    return;
  }

  if (hidden) {
    sectionEl.classList.add(HIDDEN_CLASS);
    peekBar.classList.add('gv-visible');
    return;
  }

  sectionEl.classList.remove(HIDDEN_CLASS);
  peekBar.classList.remove('gv-visible');
}

function isTargetSectionElement(element: HTMLElement, section: HidableSectionConfig): boolean {
  if (!element.matches(section.containerSelector)) {
    return false;
  }

  if (!section.requiredDescendantSelector) {
    return true;
  }

  return element.querySelector(section.requiredDescendantSelector) !== null;
}

function setupSectionCandidates(root: ParentNode): void {
  SECTION_CONFIGS.forEach((section) => {
    if (root instanceof HTMLElement && isTargetSectionElement(root, section)) {
      void setupSectionHider(root, section);
    }

    root.querySelectorAll<HTMLElement>(section.containerSelector).forEach((element) => {
      if (isTargetSectionElement(element, section)) {
        void setupSectionHider(element, section);
      }
    });
  });
}

async function setupSectionHider(
  sectionEl: HTMLElement,
  section: HidableSectionConfig,
): Promise<void> {
  if (sectionEl.getAttribute(PROCESSED_ATTR) === section.id) {
    return;
  }

  const placement = section.placement ?? 'inline';
  const parent = sectionEl.parentElement;
  if (!parent) {
    return;
  }

  // Inline mode needs an explicit host element to nest the button into.
  // Absolute mode mounts the button directly on the section, but we still
  // verify the requiredDescendantSelector matched (handled in caller) before
  // proceeding so we don't paint a toggle on the wrong element.
  let inlineHost: Element | null = null;
  if (placement === 'inline') {
    inlineHost = sectionEl.querySelector(section.toggleHostSelector ?? ARROW_ICON_SELECTOR);
    if (!inlineHost) return;
  }

  const toggleBtn = createToggleButton(section);
  const peekBar = createPeekBar(section);
  let hasUserInteraction = false;

  sectionEl.classList.add(TARGET_CLASS);
  sectionEl.setAttribute(PROCESSED_ATTR, section.id);

  if (placement === 'absolute') {
    // The button is `position: absolute` per CSS; mount it on the section
    // (which has `position: relative` via TARGET_CLASS). Appending — instead
    // of `insertBefore` on the header button — keeps it outside the native
    // header `<button>`, avoiding nested-button HTML.
    sectionEl.appendChild(toggleBtn);
  } else {
    inlineHost!.insertBefore(toggleBtn, inlineHost!.firstChild);
  }
  parent.insertBefore(peekBar, sectionEl.nextSibling);

  const handleHideRequest = async () => {
    hasUserInteraction = true;
    await setHiddenState(section, true);
    applyState(sectionEl, peekBar, true);
    void showSidebarCollapseNudgeOnce(peekBar);
  };

  toggleBtn.addEventListener('click', async (event) => {
    event.stopPropagation();
    event.preventDefault();
    await handleHideRequest();
  });

  // Span-as-button (absolute mode) needs explicit keyboard handling — native
  // <button> Enter/Space activation isn't synthesized for span[role=button].
  // Also stop pointerdown/mousedown bubbling so the underlying section header
  // (which is itself a <button>) doesn't toggle expand/collapse on a stray
  // drag-click that lands on the toggle.
  if (placement === 'absolute') {
    toggleBtn.addEventListener('keydown', async (event) => {
      const ke = event as KeyboardEvent;
      if (ke.key !== 'Enter' && ke.key !== ' ') return;
      event.stopPropagation();
      event.preventDefault();
      await handleHideRequest();
    });
    toggleBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    toggleBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  peekBar.addEventListener('click', async () => {
    hasUserInteraction = true;
    hideTooltip();
    removeSidebarCollapseNudge();
    await setHiddenState(section, false);
    applyState(sectionEl, peekBar, false);
  });

  peekBar.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      hasUserInteraction = true;
      hideTooltip();
      removeSidebarCollapseNudge();
      await setHiddenState(section, false);
      applyState(sectionEl, peekBar, false);
    }
  });

  peekBar.addEventListener('mouseenter', () => {
    showTooltip(peekBar);
  });

  peekBar.addEventListener('mouseleave', () => {
    hideTooltip();
  });

  peekBar.addEventListener('focus', () => {
    showTooltip(peekBar);
  });

  peekBar.addEventListener('blur', () => {
    hideTooltip();
  });

  const isHidden = await getHiddenState(section);
  if (!hasUserInteraction) {
    applyState(sectionEl, peekBar, isHidden);
  }
}

function updateLanguageText(): void {
  document.querySelectorAll<HTMLButtonElement>(`.${TOGGLE_BTN_CLASS}`).forEach((btn) => {
    const section = getSectionConfig(btn.getAttribute(SECTION_ID_ATTR));
    if (!section) {
      return;
    }

    const label = getSectionText(section, 'hide');
    btn.setAttribute('aria-label', label);
    btn.title = label;
  });

  document.querySelectorAll<HTMLDivElement>(`.${PEEK_BAR_CLASS}`).forEach((bar) => {
    const section = getSectionConfig(bar.getAttribute(SECTION_ID_ATTR));
    if (!section) {
      return;
    }

    const label = getSectionText(section, 'show');
    bar.setAttribute('data-tooltip', label);
    bar.title = label;
    bar.setAttribute('aria-label', label);
  });
}

function initGemsHider(): void {
  if (initialized) return;
  initialized = true;

  injectStyles();
  setupSectionCandidates(document);

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement) {
          observerPendingNodes.add(node);
        }
      }
    }

    if (observerDebounceTimer !== null) {
      window.clearTimeout(observerDebounceTimer);
    }
    observerDebounceTimer = window.setTimeout(() => {
      observerDebounceTimer = null;
      const pendingNodes = Array.from(observerPendingNodes);
      observerPendingNodes.clear();
      pendingNodes.forEach((node) => setupSectionCandidates(node));
    }, 100);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  languageChangeListener = (changes, areaName) => {
    if ((areaName === 'sync' || areaName === 'local') && changes[StorageKeys.LANGUAGE]) {
      updateLanguageText();
    }
  };

  browser.storage.onChanged.addListener(languageChangeListener);
}

function cleanup(): void {
  if (observerDebounceTimer !== null) {
    window.clearTimeout(observerDebounceTimer);
    observerDebounceTimer = null;
  }
  observerPendingNodes.clear();

  if (observer) {
    observer.disconnect();
    observer = null;
  }

  if (languageChangeListener) {
    browser.storage.onChanged.removeListener(languageChangeListener);
    languageChangeListener = null;
  }

  document.getElementById(STYLE_ID)?.remove();
  document.querySelectorAll(`.${TOGGLE_BTN_CLASS}`).forEach((element) => element.remove());
  document.querySelectorAll(`.${PEEK_BAR_CLASS}`).forEach((element) => element.remove());
  document.getElementById(TOOLTIP_ID)?.remove();
  removeSidebarCollapseNudge();
  document.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((element) => {
    element.classList.remove(HIDDEN_CLASS);
  });
  document.querySelectorAll<HTMLElement>(`[${PROCESSED_ATTR}]`).forEach((element) => {
    element.classList.remove(TARGET_CLASS);
    element.removeAttribute(PROCESSED_ATTR);
  });

  initialized = false;
}

export function startGemsHider(): () => void {
  if (location.hostname !== 'gemini.google.com') {
    return () => {};
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGemsHider);
  } else {
    setTimeout(initGemsHider, 500);
  }

  return cleanup;
}
