// Static imports to avoid CSP issues with dynamic imports in content scripts
import { StorageKeys } from '@/core/types/common';
import { isSafari } from '@/core/utils/browser';
import {
  buildConversationIdFromUrl,
  buildLegacyConversationIdFromUrl,
  buildRouteConversationIdFromUrl,
} from '@/core/utils/conversationIdentity';
import { type AppLanguage, normalizeLanguage } from '@/utils/language';
import { extractMessageDictionary } from '@/utils/localeMessages';
import type { TranslationKey } from '@/utils/translations';

import { ConversationExportService } from '../../../features/export/services/ConversationExportService';
import {
  getSavedImageExportWidth,
  saveImageExportWidth,
} from '../../../features/export/services/ImageExportPreferenceService';
import {
  SpeakerLabelPreferenceSaver,
  getSavedSpeakerLabelOverrides,
} from '../../../features/export/services/SpeakerLabelPreferenceService';
import type {
  CanvasDoc,
  ConversationMetadata,
  ChatTurn as ExportChatTurn,
} from '../../../features/export/types/export';
import {
  DEFAULT_IMAGE_EXPORT_WIDTH,
  type ExportFormat,
  type ExportSpeakerLabels,
} from '../../../features/export/types/export';
import { ExportDialog } from '../../../features/export/ui/ExportDialog';
import { resolveExportErrorMessage } from '../../../features/export/ui/ExportErrorMessage';
import { showExportToast } from '../../../features/export/ui/ExportToast';
import { isServerTurnId } from '../fork/turnId';
import { historyTimestampStore } from '../timestamp/historyTimestamps';
import { ExportPlatformAdapter, resolveExportAdapter } from './adapter/platformAdapters';
import { assistantHasCanvasDoc, extractAllCanvasDocs, isAnyCanvasOpen } from './canvasDocExtractor';
import {
  filterOutDeepResearchImmersiveNodes,
  findFirstElementBetweenTurns,
} from './conversationDom';
import {
  getConversationMenuContext,
  getResponseMenuContext,
  injectConversationMenuExportButton,
  injectResponseMenuExportButton,
} from './conversationMenuInjection';
import { withExportCollectingBanner } from './exportCollectingBanner';
import { resolveExportLogoAnchor } from './exportLogoAnchor';
import {
  type PendingExportState,
  advancePendingExportState,
  clearPendingExportState,
  createPendingExportState,
  exportPendingConversation,
  persistPendingExportState,
  restorePendingExportState,
} from './pendingExportState';
import { mountPersistentExportToolbar } from './persistentExportToolbar';
import { injectResponseActionCopyImageButtons } from './responseActionImageButton';
import { showResponseActionCopyImageMenu } from './responseActionImageMenu';
import {
  copyImageBlobToClipboard,
  copyImageBlobViaSafariNativePasteboard,
  downloadImageBlob,
  renderResponseImageBlob,
} from './responseImageCopy';
import { resolveUniqueExportTurnIds } from './selectionIds';
import {
  groupSelectedMessagesByTurn,
  pruneMissingSelectionIds,
  reconcileExistingSelectionHost,
  resolveInitialSelectedMessageIds,
  shouldRefreshSelectionUi,
} from './selectionUtils';
import { resolveSidebarConversationTarget } from './sidebarConversationTarget';
import {
  computeConversationFingerprint,
  waitForConversationFingerprintChangeOrTimeout,
} from './topNodePreload';

const CONVERSATION_MENU_SELECTOR = '.mat-mdc-menu-panel[role="menu"], gem-menu';
const CONVERSATION_MENU_TRIGGER_TEST_IDS = [
  'actions-menu-button',
  'conversation-actions-menu-icon-button',
];
const RESPONSE_MENU_TRIGGER_TEST_ID = 'more-menu-button';
const MENU_INJECTION_RETRY_LIMIT = 8;
const MENU_INJECTION_RETRY_DELAY_MS = 80;
const EXPORT_PRELOAD_WAIT_OPTIONS = {
  timeoutMs: 12000,
  minWaitMs: 700,
  idleMs: 320,
  pollIntervalMs: 90,
  maxSamples: 10,
} as const;
const FINAL_EXPORT_PREPARE_DELAY_MS = 120;
const GENERATED_UI_FRAME_SELECTOR = 'iframe[src*="gemini-code-immersive"]';
const GENERATED_UI_SCREENSHOT_MESSAGE_TYPE = 'gv.generatedUi.captureVisibleTab';
const GENERATED_UI_CAPTURE_PERMISSION_MESSAGE_TYPE = 'gv.generatedUi.ensureCapturePermission';
const GENERATED_UI_SCREENSHOT_SECTION_CLASS = 'gv-generated-ui-screenshot-section';
// Platform adapter — resolved once per page load
const exportAdapter: ExportPlatformAdapter = resolveExportAdapter();
ConversationExportService.setExportAdapter(exportAdapter);

let conversationMenuObserver: MutationObserver | null = null;
let responseActionObserver: MutationObserver | null = null;
let cachedCanvasDocs: CanvasDoc[] | null = null;

let activeExportDialog: ExportDialog | null = null;
let activeExportController: AbortController | null = null;
let activeExportSelectionCleanup: (() => void) | null = null;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function throwIfExportCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
}

function exportRouteKey(url: string): string {
  const parsed = new URL(url, location.href);
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

function beginExportOperation(): AbortController {
  activeExportController?.abort();
  activeExportSelectionCleanup?.();
  activeExportSelectionCleanup = null;
  const controller = new AbortController();
  activeExportController = controller;
  return controller;
}

function cancelActiveExportOperation(): void {
  activeExportController?.abort();
  activeExportController = null;
  activeExportSelectionCleanup?.();
  activeExportSelectionCleanup = null;
}

/** Remove all injected Canvas export sections from the DOM after export completes */
function removeCanvasExportSections(): void {
  document.querySelectorAll('.gv-canvas-export-section').forEach((el) => el.remove());
}

function removeGeneratedUiScreenshotSections(): void {
  document.querySelectorAll(`.${GENERATED_UI_SCREENSHOT_SECTION_CLASS}`).forEach((el) => {
    // PDFPrintService owns the print container lifecycle after window.print().
    if (el.closest('#gv-pdf-print-container')) return;
    el.remove();
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image_load_failed'));
    img.src = src;
  });
}

async function cropViewportScreenshot(dataUrl: string, rect: DOMRect): Promise<string | null> {
  const img = await loadImage(dataUrl);
  const scaleX = img.naturalWidth / window.innerWidth;
  const scaleY = img.naturalHeight / window.innerHeight;
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  const width = Math.floor((right - left) * scaleX);
  const height = Math.floor((bottom - top) * scaleY);
  if (width <= 0 || height <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(img, left * scaleX, top * scaleY, width, height, 0, 0, width, height);
  return canvas.toDataURL('image/png');
}

function insertGeneratedUiScreenshot(frame: HTMLIFrameElement, dataUrl: string): void {
  const section = document.createElement('div');
  section.className = GENERATED_UI_SCREENSHOT_SECTION_CLASS;
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = 'Gemini interactive UI screenshot';
  section.appendChild(img);

  const anchor =
    (frame.closest('.attachment-container') as HTMLElement | null) ||
    (frame.closest('response-element') as HTMLElement | null);
  if (anchor?.parentElement) {
    anchor.insertAdjacentElement('afterend', section);
    return;
  }

  const container =
    (frame.closest('message-content') as HTMLElement | null)?.querySelector(
      '.markdown, .markdown-main-panel',
    ) ||
    (frame.closest('.markdown, .markdown-main-panel, message-content') as HTMLElement | null) ||
    frame.parentElement;
  container?.appendChild(section);
}

async function captureVisibleTab(): Promise<string | null> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: GENERATED_UI_SCREENSHOT_MESSAGE_TYPE,
    })) as { ok?: boolean; dataUrl?: string; error?: string };
    if (response?.ok && typeof response.dataUrl === 'string') return response.dataUrl;
    console.warn(
      '[Gemini Voyager] Generated UI screenshot capture failed:',
      response?.error || 'empty_response',
      response,
    );
  } catch (error) {
    console.warn('[Gemini Voyager] Generated UI screenshot capture failed:', error);
  }
  return null;
}

async function ensureGeneratedUiScreenshotPermission(): Promise<void> {
  if (!document.querySelector(GENERATED_UI_FRAME_SELECTOR)) return;
  try {
    // Must run from export click handlers, before preload/capture awaits erase the gesture.
    const response = (await chrome.runtime.sendMessage({
      type: GENERATED_UI_CAPTURE_PERMISSION_MESSAGE_TYPE,
    })) as { ok?: boolean };
    if (!response?.ok) {
      console.warn('[Gemini Voyager] Generated UI screenshot permission was not granted.');
    }
  } catch (error) {
    console.warn('[Gemini Voyager] Generated UI screenshot permission request failed:', error);
  }
}

async function captureGeneratedUiScreenshots(): Promise<void> {
  removeGeneratedUiScreenshotSections();
  const frames = Array.from(
    document.querySelectorAll<HTMLIFrameElement>(GENERATED_UI_FRAME_SELECTOR),
  );
  if (frames.length === 0) return;

  const hiddenOverlays = Array.from(
    document.querySelectorAll<HTMLElement>('.gv-export-progress-overlay'),
  );
  const previousDisplay = hiddenOverlays.map((overlay) => overlay.style.display);
  hiddenOverlays.forEach((overlay) => {
    overlay.style.display = 'none';
  });

  try {
    for (const frame of frames) {
      frame.scrollIntoView({ block: 'center', inline: 'nearest' });
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      const screenshot = await captureVisibleTab();
      if (!screenshot) continue;
      const rect = frame.getBoundingClientRect();
      const cropped = await cropViewportScreenshot(screenshot, rect);
      if (cropped) {
        insertGeneratedUiScreenshot(frame, cropped);
      } else {
        console.warn('[Gemini Voyager] Generated UI screenshot crop failed:', {
          bottom: rect.bottom,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
          width: rect.width,
        });
      }
    }
  } catch (error) {
    console.warn('[Gemini Voyager] Generated UI screenshot export failed:', error);
    // Link/text fallback still exports if screenshot capture is unavailable.
  } finally {
    hiddenOverlays.forEach((overlay, index) => {
      overlay.style.display = previousDisplay[index] || '';
    });
  }
}

function waitForElement(selector: string, timeoutMs: number = 6000): Promise<Element | null> {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const obs = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) {
        try {
          obs.disconnect();
        } catch {}
        resolve(found);
      }
    });
    try {
      obs.observe(document.body, { childList: true, subtree: true });
    } catch {}
    if (timeoutMs > 0)
      setTimeout(() => {
        try {
          obs.disconnect();
        } catch {}
        resolve(null);
      }, timeoutMs);
  });
}

function waitForAnyElement(
  selectors: string[],
  timeoutMs: number = 10000,
): Promise<Element | null> {
  return new Promise((resolve) => {
    // Check first
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return resolve(el);
    }

    const obs = new MutationObserver(() => {
      for (const s of selectors) {
        const found = document.querySelector(s);
        if (found) {
          try {
            obs.disconnect();
          } catch {}
          resolve(found);
          return;
        }
      }
    });

    try {
      obs.observe(document.body, { childList: true, subtree: true });
    } catch {}

    if (timeoutMs > 0)
      setTimeout(() => {
        try {
          obs.disconnect();
        } catch {}
        resolve(null);
      }, timeoutMs);
  });
}

function normalizeText(text: string | null): string {
  try {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

// Note: cleaning of thinking toggles is handled at DOM level in extractAssistantText

/**
 * querySelector variant that skips elements nested inside model-thoughts / thoughts-container.
 * When the user expands Gemini's "thinking" section, a second `message-content` element
 * appears *before* the real response in DOM order.  A plain `querySelector` would match
 * the thinking panel first, causing exports to grab the wrong content.
 */
function queryOutsideThoughts<T extends Element = Element>(
  root: Element,
  selector: string,
): T | null {
  const candidates = root.querySelectorAll<T>(selector);
  for (const el of Array.from(candidates)) {
    if (!el.closest('model-thoughts, .thoughts-container, .thoughts-content')) {
      return el;
    }
  }
  return null;
}

function filterTopLevel(elements: Element[]): HTMLElement[] {
  const arr = elements.map((e) => e as HTMLElement);
  const out: HTMLElement[] = [];
  for (let i = 0; i < arr.length; i++) {
    const el = arr[i];
    let isDescendant = false;
    for (let j = 0; j < arr.length; j++) {
      if (i === j) continue;
      const other = arr[j];
      if (other.contains(el)) {
        isDescendant = true;
        break;
      }
    }
    if (!isDescendant) out.push(el);
  }
  return out;
}

function getConversationRoot(userSelectors: string[]): HTMLElement {
  return exportAdapter.resolveConversationRoot(userSelectors, document);
}

function computeConversationId(): string {
  return (
    exportAdapter.extractConversationIdFromUrl() || buildConversationIdFromUrl(window.location.href)
  );
}

function getUserSelectors(): string[] {
  return exportAdapter.getUserSelectors();
}

function getAssistantSelectors(): string[] {
  return exportAdapter.getAssistantSelectors();
}

function readStarredSet(): Set<string> {
  const cid = computeConversationId();
  try {
    const candidateConversationIds = [
      cid,
      buildRouteConversationIdFromUrl(window.location.href),
      buildLegacyConversationIdFromUrl(window.location.href),
    ];

    for (const candidateConversationId of candidateConversationIds) {
      const raw = localStorage.getItem(`geminiTimelineStars:${candidateConversationId}`);
      if (!raw) continue;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) continue;
      return new Set(arr.map((x: unknown) => String(x)));
    }

    return new Set();
  } catch {
    return new Set();
  }
}

function extractAssistantText(el: HTMLElement): string {
  // Prefer direct text from message container if available (connected to DOM)
  // Use queryOutsideThoughts to avoid matching the message-content inside
  // the expanded thinking/reasoning panel.
  try {
    const mc = queryOutsideThoughts<HTMLElement>(
      el,
      'message-content, .markdown, .markdown-main-panel',
    );
    if (mc) {
      const raw = mc.textContent || mc.innerText || '';
      const txt = normalizeText(raw);
      if (txt) return txt;
    }
  } catch {}

  // Clone and remove reasoning toggles/labels before reading text (detached fallback)
  const clone = el.cloneNode(true) as HTMLElement;
  const matchesReasonToggle = (txt: string): boolean => {
    const s = normalizeText(txt).toLowerCase();
    if (!s) return false;
    return (
      /^(show\s*(thinking|reasoning)|hide\s*(thinking|reasoning))$/i.test(s) ||
      /^(显示\s*(思路|推理)|隐藏\s*(思路|推理))$/u.test(s)
    );
  };
  const shouldDrop = (node: HTMLElement): boolean => {
    const role = (node.getAttribute('role') || '').toLowerCase();
    const aria = (node.getAttribute('aria-label') || '').toLowerCase();
    const txt = node.textContent || '';
    if (matchesReasonToggle(txt)) return true;
    if (role === 'button' && (/thinking|reasoning/i.test(txt) || /思路|推理/u.test(txt)))
      return true;
    if (/thinking|reasoning/i.test(aria) || /思路|推理/u.test(aria)) return true;
    return false;
  };
  try {
    const candidates = clone.querySelectorAll(
      'button, [role="button"], [aria-label], span, div, a',
    );
    candidates.forEach((n) => {
      const eln = n as HTMLElement;
      if (shouldDrop(eln)) eln.remove();
    });
  } catch {}
  const text = normalizeText(clone.innerText || clone.textContent || '');
  return text;
}

type ChatTurn = {
  turnId: string;
  user: string;
  assistant: string;
  starred: boolean;
  userElement?: HTMLElement;
  assistantElement?: HTMLElement;
  assistantHostElement?: HTMLElement;
};

export function collectChatPairs(): ChatTurn[] {
  const userSelectors = getUserSelectors();
  const root = getConversationRoot(userSelectors);
  const assistantSelectors = getAssistantSelectors();
  const userNodeList = filterOutDeepResearchImmersiveNodes(
    Array.from(root.querySelectorAll<HTMLElement>(userSelectors.join(','))),
  );
  if (!userNodeList || userNodeList.length === 0) return [];
  const users = filterTopLevel(userNodeList);
  if (users.length === 0) return [];

  const uniqueTurnIds = resolveUniqueExportTurnIds(users);

  const assistantsAll = filterOutDeepResearchImmersiveNodes(
    Array.from(root.querySelectorAll<HTMLElement>(assistantSelectors.join(','))),
  );
  const assistants = filterTopLevel(assistantsAll);

  const starredSet = readStarredSet();
  const nativeConversationId = extractConversationIdFromUrl();
  const pairs: ChatTurn[] = [];

  for (let i = 0; i < users.length; i++) {
    const uEl = users[i] as HTMLElement;
    const uText = normalizeText(uEl.innerText || uEl.textContent || '');
    let aText = '';
    let aEl = findFirstElementBetweenTurns(uEl, users[i + 1], assistants);

    if (aEl) {
      aText = extractAssistantText(aEl);
    } else {
      // Fallback: search next siblings up to a small window
      let sib: HTMLElement | null = uEl;
      for (let step = 0; step < 8 && sib; step++) {
        sib = sib.nextElementSibling as HTMLElement | null;
        if (!sib) break;
        if (sib.matches(userSelectors.join(','))) break;
        if (sib.matches(assistantSelectors.join(','))) {
          aEl = sib;
          aText = extractAssistantText(sib);
          break;
        }
      }
    }
    const turnId = uniqueTurnIds[i];
    const turnIdAliases =
      turnId && nativeConversationId && isServerTurnId(turnId)
        ? historyTimestampStore.getTurnIdAliases(nativeConversationId, turnId)
        : turnId && isServerTurnId(turnId)
          ? [turnId]
          : [];
    const starred = turnIdAliases.some((alias) => starredSet.has(alias));
    if (uText || aText) {
      // Prefer a richer assistant container for downstream rich extraction
      let finalAssistantEl: HTMLElement | undefined = undefined;
      if (aEl) {
        const pick =
          queryOutsideThoughts<HTMLElement>(aEl, 'message-content') ||
          queryOutsideThoughts<HTMLElement>(aEl, '.markdown, .markdown-main-panel') ||
          (aEl.closest('.presented-response-container') as HTMLElement | null) ||
          queryOutsideThoughts<HTMLElement>(
            aEl,
            '.presented-response-container, .response-content',
          ) ||
          queryOutsideThoughts<HTMLElement>(aEl, 'response-element') ||
          aEl;
        finalAssistantEl = pick || undefined;
      }
      pairs.push({
        turnId,
        user: uText,
        assistant: aText,
        starred,
        userElement: uEl,
        assistantElement: finalAssistantEl,
        assistantHostElement: aEl || undefined,
      });
      // Canvas document content injection: if this assistant response references
      // a Canvas doc and the immersive-editor is open, append full Canvas content
      // directly into the DOM element so DOMContentExtractor can pick it up.
      // Guard against duplicate injection (collectChatPairs may be called multiple times).
      // Canvas document content injection: if this assistant response references
      // a Canvas doc, append full Canvas content directly into the DOM element
      // so DOMContentExtractor can pick it up.
      // Guard against duplicate injection (collectChatPairs may be called multiple times).
      if (
        aEl &&
        assistantHasCanvasDoc(aEl) &&
        (isAnyCanvasOpen() || (cachedCanvasDocs && cachedCanvasDocs.length > 0)) &&
        finalAssistantEl &&
        !finalAssistantEl.querySelector('.gv-canvas-export-section')
      ) {
        const canvasDocs =
          cachedCanvasDocs && cachedCanvasDocs.length > 0
            ? cachedCanvasDocs
            : extractAllCanvasDocs();
        if (canvasDocs.length > 0) {
          const targetContainer =
            finalAssistantEl.querySelector('.markdown, .markdown-main-panel') || finalAssistantEl;
          for (const doc of canvasDocs) {
            const section = document.createElement('div');
            section.className = 'gv-canvas-export-section';
            const heading = document.createElement('h3');
            heading.textContent = `📄 Canvas Document: ${doc.title}`;
            const content = document.createElement('div');
            content.className = 'gv-canvas-content';
            content.textContent = doc.content;
            section.appendChild(heading);
            section.appendChild(content);
            targetContainer.appendChild(section);
          }
        }
      }
    }
  }
  return pairs;
}

type ExportMessageRole = 'user' | 'assistant' | 'unknown';

type ExportMessage = {
  messageId: string;
  role: ExportMessageRole;
  hostElement: HTMLElement;
  exportElement?: HTMLElement;
  text: string;
  starred: boolean;
};

function buildExportMessagesFromPairs(pairs: ChatTurn[]): ExportMessage[] {
  const out: ExportMessage[] = [];
  pairs.forEach((pair) => {
    if (pair.userElement) {
      out.push({
        messageId: `${pair.turnId}:u`,
        role: 'user',
        hostElement: pair.userElement,
        exportElement: pair.userElement,
        text: pair.user,
        starred: pair.starred,
      });
    }

    const assistantHost = pair.assistantHostElement;
    if (assistantHost) {
      out.push({
        messageId: `${pair.turnId}:a`,
        role: 'assistant',
        hostElement: assistantHost,
        exportElement: pair.assistantElement || assistantHost,
        text: pair.assistant,
        starred: pair.starred,
      });
    }
  });
  return out;
}

function resolveSelectionMessages(pairsInput: ChatTurn[]): ExportMessage[] {
  const turnContainers = exportAdapter.collectTurnContainers?.();
  if (turnContainers) {
    // ChatGPT retains these top-level virtual-list items even when it unloads
    // their inner message DOM. Their DOM order and data-turn-id-container value
    // are consequently the only reliable source for selection identity/order.
    return turnContainers.map((turn) => ({
      messageId: turn.id,
      role: turn.role,
      hostElement: turn.container,
      exportElement: turn.container,
      text: '',
      starred: false,
    }));
  }

  const messages = buildExportMessagesFromPairs(pairsInput);
  return messages
    .map((message) => {
      const rect = message.hostElement.getBoundingClientRect();
      return {
        ...message,
        absTop: rect.top + window.scrollY,
      };
    })
    .sort((a, b) => a.absTop - b.absTop);
}

function buildTurnsForSelectedMessages(
  selectedMessages: readonly ExportMessage[],
): ExportChatTurn[] {
  const groupedTurns = groupSelectedMessagesByTurn(
    selectedMessages.filter(
      (message): message is ExportMessage & { role: Exclude<ExportMessageRole, 'unknown'> } =>
        message.role !== 'unknown',
    ),
  );
  return groupedTurns
    .map((turn) => ({
      user: turn.user?.text || '',
      assistant: turn.assistant?.text || '',
      starred: turn.starred,
      omitEmptySections: true,
      userElement: turn.user?.exportElement,
      assistantElement: turn.assistant?.exportElement,
    }))
    .filter(
      (turn) =>
        turn.user.length > 0 ||
        turn.assistant.length > 0 ||
        !!turn.userElement ||
        !!turn.assistantElement,
    );
}

function buildTurnsForSelectedMessageIds(
  selectedMessageIds: ReadonlySet<string>,
  pairsInput: ChatTurn[] = collectChatPairs(),
): ExportChatTurn[] {
  if (selectedMessageIds.size === 0) return [];
  const selectedMessages = resolveSelectionMessages(pairsInput).filter((message) =>
    selectedMessageIds.has(message.messageId),
  );
  return buildTurnsForSelectedMessages(selectedMessages);
}

function resolveAssistantMessageIdFromMenuTrigger(trigger: HTMLElement | null): string | null {
  if (!trigger) return null;

  const assistantHost = trigger.closest(
    '.response-container, response-container, .model-response, model-response',
  ) as HTMLElement | null;
  if (!assistantHost) return null;

  const messages = buildExportMessagesFromPairs(collectChatPairs());
  const target = messages.find((message) => {
    if (message.role !== 'assistant') return false;
    const host = message.hostElement;
    return (
      host === assistantHost ||
      host.contains(assistantHost) ||
      assistantHost.contains(host) ||
      host.contains(trigger)
    );
  });

  return target?.messageId || null;
}

function ensureDropdownInjected(logoElement: Element): HTMLButtonElement | null {
  // Check if already injected
  const existingWrapper = document.querySelector('.gv-logo-dropdown-wrapper');
  if (existingWrapper) {
    return existingWrapper.querySelector('.gv-export-dropdown-btn') as HTMLButtonElement | null;
  }

  const logo = logoElement as HTMLElement;
  const parent = logo.parentElement;
  if (!parent) return null;

  // Create wrapper that will contain both logo and dropdown
  const wrapper = document.createElement('div');
  wrapper.className = 'gv-logo-dropdown-wrapper';

  // Move logo into wrapper
  parent.insertBefore(wrapper, logo);
  wrapper.appendChild(logo);

  // Create dropdown container
  const dropdown = document.createElement('div');
  dropdown.className = 'gv-logo-dropdown';

  // Create export button inside dropdown
  const btn = document.createElement('button');
  btn.className = 'gv-export-dropdown-btn';
  btn.type = 'button';
  btn.title = 'Export chat history';
  btn.setAttribute('aria-label', 'Export chat history');

  // Export icon
  const iconSpan = document.createElement('span');
  iconSpan.className = 'gv-export-dropdown-icon';
  btn.appendChild(iconSpan);

  // Export text label
  const labelSpan = document.createElement('span');
  labelSpan.className = 'gv-export-dropdown-label';
  labelSpan.textContent = 'Export';
  btn.appendChild(labelSpan);

  dropdown.appendChild(btn);
  wrapper.appendChild(dropdown);

  return btn;
}

async function loadDictionaries(): Promise<Record<AppLanguage, Record<string, string>>> {
  try {
    const [enRaw, zhRaw, zhTWRaw, jaRaw, frRaw, esRaw, ptRaw, arRaw, ruRaw, koRaw] =
      await Promise.all([
        import(/* @vite-ignore */ '../../../locales/en/messages.json'),
        import(/* @vite-ignore */ '../../../locales/zh/messages.json'),
        import(/* @vite-ignore */ '../../../locales/zh_TW/messages.json'),
        import(/* @vite-ignore */ '../../../locales/ja/messages.json'),
        import(/* @vite-ignore */ '../../../locales/fr/messages.json'),
        import(/* @vite-ignore */ '../../../locales/es/messages.json'),
        import(/* @vite-ignore */ '../../../locales/pt/messages.json'),
        import(/* @vite-ignore */ '../../../locales/ar/messages.json'),
        import(/* @vite-ignore */ '../../../locales/ru/messages.json'),
        import(/* @vite-ignore */ '../../../locales/ko/messages.json'),
      ]);

    return {
      en: extractMessageDictionary(enRaw),
      zh: extractMessageDictionary(zhRaw),
      zh_TW: extractMessageDictionary(zhTWRaw),
      ja: extractMessageDictionary(jaRaw),
      fr: extractMessageDictionary(frRaw),
      es: extractMessageDictionary(esRaw),
      pt: extractMessageDictionary(ptRaw),
      ar: extractMessageDictionary(arRaw),
      ru: extractMessageDictionary(ruRaw),
      ko: extractMessageDictionary(koRaw),
    };
  } catch {
    return {
      en: {},
      zh: {},
      zh_TW: {},
      ja: {},
      fr: {},
      es: {},
      pt: {},
      ar: {},
      ru: {},
      ko: {},
    };
  }
}

function extractConversationIdFromUrl(): string | null {
  const appMatch = window.location.pathname.match(/\/app\/([^/?#]+)/);
  if (appMatch?.[1]) return appMatch[1];
  const gemMatch = window.location.pathname.match(/\/gem\/[^/]+\/([^/?#]+)/);
  if (gemMatch?.[1]) return gemMatch[1];
  return null;
}

function extractConversationIdFromHref(href: string): string | null {
  if (!href) return null;
  try {
    const parsed = new URL(href, window.location.origin);
    const appMatch = parsed.pathname.match(/\/app\/([^/?#]+)/);
    if (appMatch?.[1]) return appMatch[1];
    const gemMatch = parsed.pathname.match(/\/gem\/[^/]+\/([^/?#]+)/);
    if (gemMatch?.[1]) return gemMatch[1];
    return null;
  } catch {
    return null;
  }
}

function escapeCssAttributeValue(value: string): string {
  const escape = globalThis.CSS?.escape;
  if (typeof escape === 'function') {
    return escape(value);
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getConversationTitleForExport(): string {
  return exportAdapter.extractConversationTitle();
}

function findSidebarConversationLinkById(conversationId: string): HTMLAnchorElement | null {
  const escapedConversationId = escapeCssAttributeValue(conversationId);
  const byJslog = document.querySelector(
    `[data-test-id="conversation"][jslog*="c_${escapedConversationId}"] a[href]`,
  ) as HTMLAnchorElement | null;
  if (byJslog) return byJslog;

  const links = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(
      '[data-test-id="conversation"] a[href], a[data-test-id="conversation"][href]',
    ),
  );
  for (const link of links) {
    if (extractConversationIdFromHref(link.href) === conversationId) {
      return link;
    }
  }

  return null;
}

function triggerNativeClick(target: HTMLElement): void {
  const opts = { bubbles: true, cancelable: true, view: window };
  target.dispatchEvent(new MouseEvent('pointerdown', opts));
  target.dispatchEvent(new MouseEvent('mousedown', opts));
  target.dispatchEvent(new MouseEvent('mouseup', opts));
  target.dispatchEvent(new MouseEvent('click', opts));
}

async function waitForConversationUrl(
  conversationId: string,
  timeoutMs: number = 10000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (extractConversationIdFromUrl() === conversationId) return true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

async function navigateToConversationAndWait(
  conversationId: string,
  fallbackUrl: string,
): Promise<boolean> {
  const currentConversationId = extractConversationIdFromUrl();
  if (currentConversationId === conversationId) {
    const existing = await waitForAnyElement(getUserSelectors(), 8000);
    return !!existing;
  }

  const link = findSidebarConversationLinkById(conversationId);
  if (link) {
    triggerNativeClick(link);
  } else if (fallbackUrl) {
    window.location.assign(fallbackUrl);
  } else {
    return false;
  }

  const routeReady = await waitForConversationUrl(conversationId, 12000);
  if (!routeReady) return false;
  const contentReady = await waitForAnyElement(getUserSelectors(), 15000);
  return !!contentReady;
}

async function exportFromSidebarConversationTrigger(
  trigger: HTMLElement,
  dict: Record<AppLanguage, Record<string, string>>,
  getCurrentLanguage: () => AppLanguage,
): Promise<void> {
  const target = resolveSidebarConversationTarget(trigger);
  if (!target) {
    alert('Unable to locate the selected conversation. Please open it first, then export.');
    return;
  }

  const ready = await navigateToConversationAndWait(target.conversationId, target.url);
  if (!ready) {
    alert('Failed to open the selected conversation for export. Please retry.');
    return;
  }

  await showExportDialog(dict, getCurrentLanguage());
}

function normalizeLang(lang: string | undefined): AppLanguage {
  return normalizeLanguage(lang);
}

async function getLanguage(): Promise<AppLanguage> {
  try {
    // Add timeout to prevent hanging in Firefox
    const stored = await Promise.race([
      new Promise<unknown>((resolve) => {
        try {
          const win = window as Window & {
            chrome?: {
              storage?: {
                sync?: { get: (key: string, cb: (r: unknown) => void) => void };
              };
            };
            browser?: {
              storage?: { sync?: { get: (key: string) => Promise<unknown> } };
            };
          };
          if (win.chrome?.storage?.sync?.get) {
            win.chrome.storage.sync.get(StorageKeys.LANGUAGE, resolve);
          } else if (win.browser?.storage?.sync?.get) {
            win.browser.storage.sync
              .get(StorageKeys.LANGUAGE)
              .then(resolve)
              .catch(() => resolve({}));
          } else {
            resolve({});
          }
        } catch {
          resolve({});
        }
      }),
      new Promise<unknown>((resolve) => setTimeout(() => resolve({}), 1000)),
    ]);
    const rec = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
    const v =
      typeof rec[StorageKeys.LANGUAGE] === 'string'
        ? (rec[StorageKeys.LANGUAGE] as string)
        : undefined;
    return normalizeLang(v || navigator.language || 'en');
  } catch {
    return 'en';
  }
}

/**
 * Finds the top-most user message element in the DOM.
 */
function getTopUserElement(selectors: string[]): HTMLElement | null {
  const root = getConversationRoot(selectors);
  const all = filterOutDeepResearchImmersiveNodes(
    Array.from(root.querySelectorAll<HTMLElement>(selectors.join(','))),
  );
  if (!all.length) return null;
  const topLevel = filterTopLevel(all);
  return topLevel.length > 0 ? topLevel[0] : null;
}

/**
 * Scroll the conversation to the very top so virtual-scroll containers
 * render their topmost nodes, then wait for the DOM to settle.
 */
async function scrollToTopAndRender(userSelectors: string[]): Promise<void> {
  const topEl = getTopUserElement(userSelectors);
  if (topEl) {
    topEl.scrollIntoView({ behavior: 'auto', block: 'start' });
  }
  // Give virtual scroll frameworks time to render the newly-visible nodes.
  await new Promise<void>((resolve) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        obs?.disconnect();
      } catch {}
      if (idleTimer != null) clearTimeout(idleTimer);
      resolve();
    };
    const obs = new MutationObserver(() => {
      if (idleTimer != null) clearTimeout(idleTimer);
      idleTimer = setTimeout(done, 400);
    });
    try {
      obs.observe(document.body, { childList: true, subtree: true });
    } catch {
      done();
      return;
    }
    // Also set a hard cap so we don't hang forever.
    setTimeout(done, 3000);
    // Kick the idle timer in case no mutations fire at all.
    idleTimer = setTimeout(done, 400);
  });
}

function isElementVisibleForAlignment(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 24 || rect.height < 12) return false;

  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const opacity = Number.parseFloat(style.opacity || '1');
  if (Number.isFinite(opacity) && opacity <= 0.01) return false;

  return true;
}

function isLikelySidebarElement(el: HTMLElement): boolean {
  if (
    el.closest(
      [
        '[data-test-id="side-nav"]',
        'side-navigation',
        'mat-sidenav',
        'aside',
        'nav',
        '.side-nav',
        '.sidenav',
        '.chat-history-nav',
      ].join(','),
    )
  ) {
    return true;
  }

  const rect = el.getBoundingClientRect();
  const isNarrow = rect.width > 0 && rect.width <= Math.max(380, window.innerWidth * 0.45);
  const isLeftRail = rect.left <= Math.max(40, window.innerWidth * 0.18);
  const isTall = rect.height >= window.innerHeight * 0.35;
  return isNarrow && isLeftRail && isTall;
}

function pickBestVisibleAlignmentTarget(
  selectors: string[],
  options?: {
    minWidth?: number;
    minHeight?: number;
    allowSidebar?: boolean;
  },
): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selectors.join(',')));
  let best: { el: HTMLElement; score: number } | null = null;
  const minWidth = options?.minWidth ?? 220;
  const minHeight = options?.minHeight ?? 24;
  const viewportCenter = window.innerWidth / 2;

  for (const candidate of candidates) {
    if (!candidate.isConnected) continue;
    if (!isElementVisibleForAlignment(candidate)) continue;
    if (!options?.allowSidebar && isLikelySidebarElement(candidate)) continue;

    const rect = candidate.getBoundingClientRect();
    if (rect.width < minWidth || rect.height < minHeight) continue;
    if (rect.bottom < -16 || rect.top > window.innerHeight + 16) continue;

    const center = rect.left + rect.width / 2;
    const area = rect.width * rect.height;
    const distancePenalty = Math.abs(center - viewportCenter) * 120;
    const score = area - distancePenalty;

    if (!best || score > best.score) {
      best = { el: candidate, score };
    }
  }

  return best?.el || null;
}

function resolveConversationCanvasCenterX(): number {
  const viewportCenter = window.innerWidth / 2;

  const canvasTarget = pickBestVisibleAlignmentTarget(
    [
      '#chat-history',
      'infinite-scroller.chat-history',
      '.chat-history-scroll-container',
      'chat-window-content',
      'main chat-window-content',
    ],
    {
      minWidth: Math.min(420, Math.max(280, window.innerWidth * 0.42)),
      minHeight: 80,
    },
  );
  if (canvasTarget) {
    const rect = canvasTarget.getBoundingClientRect();
    return rect.left + rect.width / 2;
  }

  const composerTarget = pickBestVisibleAlignmentTarget(
    [
      'rich-textarea',
      '[aria-label*="Enter a prompt"]',
      '[aria-label*="prompt"]',
      '[aria-label*="Gemini"]',
      '[contenteditable="true"][aria-label]',
    ],
    {
      minWidth: Math.min(460, Math.max(240, window.innerWidth * 0.28)),
      minHeight: 28,
    },
  );
  if (composerTarget) {
    const rect = composerTarget.getBoundingClientRect();
    return rect.left + rect.width / 2;
  }

  const selectors = getUserSelectors();
  const topUser = getTopUserElement(selectors);
  if (topUser && !isLikelySidebarElement(topUser)) {
    const rect = topUser.getBoundingClientRect();
    if (rect.width > 24) return rect.left + rect.width / 2;
  }

  const root = getConversationRoot(selectors);
  if (root && !isLikelySidebarElement(root)) {
    const rect = root.getBoundingClientRect();
    if (rect.width > Math.max(300, window.innerWidth * 0.42)) return rect.left + rect.width / 2;
  }

  const main = document.querySelector<HTMLElement>('main');
  if (main && !isLikelySidebarElement(main)) {
    const rect = main.getBoundingClientRect();
    if (rect.width > 24) return rect.left + rect.width / 2;
  }

  return viewportCenter;
}

function alignElementToConversationTitleCenter(element: HTMLElement): () => void {
  const apply = () => {
    if (window.innerWidth <= 640) {
      element.style.removeProperty('left');
      element.style.removeProperty('transform');
      return;
    }

    const rawCenter = resolveConversationCanvasCenterX();
    const safeMargin = 24;
    const clampedCenter = Math.round(
      Math.max(safeMargin, Math.min(window.innerWidth - safeMargin, rawCenter)),
    );
    element.style.left = `${clampedCenter}px`;
    element.style.transform = 'translateX(-50%)';
  };

  apply();
  const resizeHandler = () => apply();
  window.addEventListener('resize', resizeHandler);
  const timeoutId = window.setTimeout(apply, 220);

  return () => {
    window.removeEventListener('resize', resizeHandler);
    window.clearTimeout(timeoutId);
  };
}

/**
 * Executes the export sequence:
 * 1. Find top node and click it.
 * 2. Wait to see if refresh happens.
 * 3. If refresh -> script dies, on load we resume.
 * 4. If no refresh -> we are stable, proceed to export.
 */
async function executeExportSequence(
  format: ExportFormat,
  dict: Record<AppLanguage, Record<string, string>>,
  lang: AppLanguage,
  paramState?: PendingExportState,
  fontSize?: number,
  initialSelectedMessageId?: string,
  imageWidth?: number,
  usePromptAsTurnHeading?: boolean,
  speakerLabels?: ExportSpeakerLabels,
): Promise<void> {
  const signal = activeExportController?.signal;
  throwIfExportCancelled(signal);
  // Cache Canvas documents at the very start of the export sequence,
  // before we click the top node or cause any DOM updates/scrolling.
  if (!paramState && isAnyCanvasOpen()) {
    cachedCanvasDocs = extractAllCanvasDocs();
  }

  const state =
    paramState ||
    createPendingExportState(format, location.href, Date.now(), {
      fontSize,
      imageWidth,
      usePromptAsTurnHeading,
      speakerLabels,
      initialSelectedMessageId,
    });

  // Platforms that don't lazy-load history skip the preload loop,
  // but scroll the conversation to the top first so virtual-scroll
  // containers render their topmost nodes before we walk the DOM.
  if (!exportAdapter.shouldPreloadHistory()) {
    await scrollToTopAndRender(getUserSelectors());
    throwIfExportCancelled(signal);
    await performFinalExport(state, dict, lang);
    return;
  }

  if (state.attempt > 25) {
    console.warn('[Gemini Voyager] Export aborted: too many attempts.');
    clearPendingExportState(sessionStorage);
    alert('Export stopped: Too many attempts detected.');
    return;
  }

  // 1. Find Top Node
  if (state.attempt > 0) {
    console.log('[Gemini Voyager] Resuming export... waiting for content load.');
    const userSelectors = getUserSelectors();
    await waitForAnyElement(userSelectors, 15000);
  }

  // Wait a bit if we just reloaded
  const userSelectors = getUserSelectors();
  let topNode = getTopUserElement(userSelectors);
  if (!topNode) {
    await waitForElement('body', 2000);
    const pairs = collectChatPairs();
    if (pairs.length > 0 && pairs[0].userElement) {
      topNode = pairs[0].userElement;
    }
  }

  if (!topNode) {
    console.log('[Gemini Voyager] No top node found, proceeding to export directly.');
    clearPendingExportState(sessionStorage);
    await performFinalExport(state, dict, lang);
    return;
  }

  const fingerprintSelectors = [...getUserSelectors(), ...getAssistantSelectors()];
  const beforeFingerprint = computeConversationFingerprint(document.body, fingerprintSelectors, 10);

  console.log(`[Gemini Voyager] Simulating click on top node (Attempt ${state.attempt + 1})...`);

  // Update state before action to persist across potential reload
  persistPendingExportState(sessionStorage, state, Date.now());

  // Dispatch click logic
  try {
    topNode.scrollIntoView({ behavior: 'auto', block: 'center' });
    const opts = { bubbles: true, cancelable: true, view: window };
    topNode.dispatchEvent(new MouseEvent('mousedown', opts));
    topNode.dispatchEvent(new MouseEvent('mouseup', opts));
    topNode.click();
  } catch (e) {
    console.error('[Gemini Voyager] Failed to click top node:', e);
  }

  // 2. Wait for either hard refresh (page unload) OR a "soft refresh" that loads more history.
  // If the page unloads, the script stops and `checkPendingExport()` resumes on next load via sessionStorage.
  const { changed } = await waitForConversationFingerprintChangeOrTimeout(
    document.body,
    fingerprintSelectors,
    beforeFingerprint,
    EXPORT_PRELOAD_WAIT_OPTIONS,
  );
  throwIfExportCancelled(signal);

  if (changed) {
    console.log('[Gemini Voyager] History expanded (soft refresh). Clicking top node again...');
    await executeExportSequence(format, dict, lang, advancePendingExportState(state, Date.now()));
    return;
  }

  console.log('[Gemini Voyager] No refresh or update detected. Exporting...');
  clearPendingExportState(sessionStorage);
  await performFinalExport(state, dict, lang);
}

async function executeExportSequenceWithProgress(
  format: ExportFormat,
  dict: Record<AppLanguage, Record<string, string>>,
  lang: AppLanguage,
  paramState?: PendingExportState,
  fontSize?: number,
  initialSelectedMessageId?: string,
  imageWidth?: number,
  usePromptAsTurnHeading?: boolean,
  speakerLabels?: ExportSpeakerLabels,
): Promise<void> {
  const t = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;
  const hideProgress = showExportProgressOverlay(t);
  try {
    await executeExportSequence(
      format,
      dict,
      lang,
      paramState,
      fontSize,
      initialSelectedMessageId,
      imageWidth,
      usePromptAsTurnHeading,
      speakerLabels,
    );
  } finally {
    hideProgress();
    cachedCanvasDocs = null;
    removeCanvasExportSections();
    removeGeneratedUiScreenshotSections();
  }
}

/**
 * Performs the actual file generation and download.
 */
async function performFinalExport(
  state: PendingExportState,
  dict: Record<AppLanguage, Record<string, string>>,
  lang: AppLanguage,
) {
  const t = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;
  const signal = activeExportController?.signal;
  throwIfExportCancelled(signal);

  await new Promise((r) => setTimeout(r, FINAL_EXPORT_PREPARE_DELAY_MS));
  throwIfExportCancelled(signal);
  await captureGeneratedUiScreenshots();
  throwIfExportCancelled(signal);

  const pairs = collectChatPairs();
  const messages = resolveSelectionMessages(pairs);
  if (messages.length === 0) {
    alert(t('export_dialog_warning'));
    return;
  }
  document
    .querySelectorAll<HTMLElement>('.gv-export-progress-overlay')
    .forEach((overlay) => overlay.remove());

  const selectedIds = new Set<string>();
  let allMessageIds: string[] = [];
  const cleanupTasks: Array<() => void> = [];
  const idToHost = new Map<string, HTMLElement>();
  const idToCheckbox = new Map<string, HTMLButtonElement>();
  const selectorBindings = new Map<
    string,
    { readonly host: HTMLElement; readonly cleanup: () => void }
  >();
  const messageRoles = new Map<string, ExportMessageRole>();
  let pendingInitialSelectionId: string | null = state.initialSelectedMessageId || null;
  let refreshTimer: number | null = null;
  let uiCleaned = false;
  let sessionSettled = false;
  let resolveSession: () => void = () => {};
  const sessionPromise = new Promise<void>((resolve) => {
    resolveSession = resolve;
  });
  const selectionUrl = location.href;
  const selectionTitle = getConversationTitleForExport();

  let autoSelectAll = false;
  let selectionBusy = false;

  const cleanup = () => {
    if (uiCleaned) return;
    uiCleaned = true;
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    selectorBindings.forEach(({ cleanup: cleanupBinding }) => cleanupBinding());
    selectorBindings.clear();
    idToHost.clear();
    idToCheckbox.clear();
    cleanupTasks.forEach((fn) => {
      try {
        fn();
      } catch {}
    });
    cleanupTasks.length = 0;
  };

  const settleSession = () => {
    if (sessionSettled) return;
    sessionSettled = true;
    if (activeExportSelectionCleanup === cancelSession) activeExportSelectionCleanup = null;
    resolveSession();
  };

  const cancelSession = () => {
    cleanup();
    settleSession();
  };

  const setSelected = (id: string, next: boolean) => {
    if (next) selectedIds.add(id);
    else selectedIds.delete(id);

    const btn = idToCheckbox.get(id);
    if (btn) {
      btn.setAttribute('aria-pressed', next ? 'true' : 'false');
      btn.dataset.selected = next ? 'true' : 'false';
    }
    const host = idToHost.get(id);
    if (host) {
      if (next) host.classList.add('gv-export-msg-selected');
      else host.classList.remove('gv-export-msg-selected');
    }
  };

  const updateBottomBar = (bar: HTMLElement) => {
    const countEl = bar.querySelector(
      '[data-gv-export-selection-count="true"]',
    ) as HTMLElement | null;
    if (countEl) {
      countEl.textContent = t('export_select_mode_count').replace(
        '{count}',
        String(selectedIds.size),
      );
    }

    const exportBtn = bar.querySelector(
      '[data-gv-export-action="export"]',
    ) as HTMLButtonElement | null;
    if (exportBtn) {
      exportBtn.disabled = selectionBusy || selectedIds.size === 0;
    }

    const selectAllBtn = bar.querySelector(
      '[data-gv-export-action="selectAll"]',
    ) as HTMLButtonElement | null;
    if (selectAllBtn) {
      selectAllBtn.disabled = selectionBusy;
      const isAllSelected = allMessageIds.length > 0 && selectedIds.size === allMessageIds.length;
      selectAllBtn.dataset.checked = isAllSelected ? 'true' : 'false';
    }

    const selectUserBtn = bar.querySelector(
      '[data-gv-export-action="selectUser"]',
    ) as HTMLButtonElement | null;
    if (selectUserBtn) {
      selectUserBtn.disabled = selectionBusy;
      const userMessageIds = allMessageIds.filter((id) => messageRoles.get(id) === 'user');
      const isOnlyUserSelected =
        userMessageIds.length > 0 &&
        selectedIds.size === userMessageIds.length &&
        userMessageIds.every((id) => selectedIds.has(id));
      selectUserBtn.dataset.checked = isOnlyUserSelected ? 'true' : 'false';
    }

    const selectAIBtn = bar.querySelector(
      '[data-gv-export-action="selectAI"]',
    ) as HTMLButtonElement | null;
    if (selectAIBtn) {
      selectAIBtn.disabled = selectionBusy;
      const aiMessageIds = allMessageIds.filter((id) => messageRoles.get(id) === 'assistant');
      const isOnlyAISelected =
        aiMessageIds.length > 0 &&
        selectedIds.size === aiMessageIds.length &&
        aiMessageIds.every((id) => selectedIds.has(id));
      selectAIBtn.dataset.checked = isOnlyAISelected ? 'true' : 'false';
    }

    idToCheckbox.forEach((checkbox) => {
      checkbox.disabled = selectionBusy;
    });
  };

  const attachSelectorIfNeeded = (msg: ExportMessage) => {
    messageRoles.set(msg.messageId, msg.role);
    const previousBinding = selectorBindings.get(msg.messageId);
    if (
      reconcileExistingSelectionHost(
        previousBinding?.host,
        msg.hostElement,
        selectedIds.has(msg.messageId),
      )
    ) {
      setSelected(msg.messageId, selectedIds.has(msg.messageId));
      return;
    }
    previousBinding?.cleanup();

    const host = msg.hostElement;
    idToHost.set(msg.messageId, host);
    host.classList.add('gv-export-msg-host');

    const selector = document.createElement('div');
    selector.className = 'gv-export-msg-selector';
    selector.dataset.gvExportMessageId = msg.messageId;

    const checkbox = document.createElement('button');
    checkbox.type = 'button';
    checkbox.className = 'gv-export-msg-checkbox';
    checkbox.setAttribute('aria-pressed', 'false');
    checkbox.title = t('export_select_mode_toggle');

    const mark = document.createElement('span');
    mark.className = 'gv-export-msg-checkbox-mark';
    checkbox.appendChild(mark);

    const swallow = (ev: Event) => {
      try {
        ev.preventDefault();
      } catch {}
      try {
        ev.stopPropagation();
      } catch {}
    };

    const toggleSelection = () => {
      if (selectionBusy) return;
      autoSelectAll = false;
      const next = !selectedIds.has(msg.messageId);
      setSelected(msg.messageId, next);
      const bar = document.querySelector(
        '[data-gv-export-select-bar="true"]',
      ) as HTMLElement | null;
      if (bar) updateBottomBar(bar);
    };

    checkbox.addEventListener('click', (ev) => {
      swallow(ev);
      toggleSelection();
    });

    host.addEventListener('click', toggleSelection);

    selector.appendChild(checkbox);
    host.appendChild(selector);

    idToCheckbox.set(msg.messageId, checkbox);
    setSelected(msg.messageId, selectedIds.has(msg.messageId));

    const cleanupBinding = () => {
      host.removeEventListener('click', toggleSelection);
      host.classList.remove('gv-export-msg-host', 'gv-export-msg-selected');
      selector.remove();
      if (idToHost.get(msg.messageId) === host) idToHost.delete(msg.messageId);
      if (idToCheckbox.get(msg.messageId) === checkbox) idToCheckbox.delete(msg.messageId);
    };
    selectorBindings.set(msg.messageId, { host, cleanup: cleanupBinding });
  };

  const syncMessages = (pairsInput: ChatTurn[]) => {
    const selectionMessages = resolveSelectionMessages(pairsInput);
    allMessageIds = selectionMessages.map((m) => m.messageId);
    const liveMessageIds = new Set(allMessageIds);
    const removedSelectionIds = pruneMissingSelectionIds(selectedIds, liveMessageIds);
    removedSelectionIds.forEach((id) => setSelected(id, false));
    for (const [id, binding] of selectorBindings) {
      if (liveMessageIds.has(id)) continue;
      binding.cleanup();
      selectorBindings.delete(id);
      messageRoles.delete(id);
    }

    selectionMessages.forEach((m) => attachSelectorIfNeeded(m));

    // Auto-select new messages when a policy is active.
    if (autoSelectAll) {
      for (const id of allMessageIds) setSelected(id, true);
    }

    const initialSelected = resolveInitialSelectedMessageIds(
      allMessageIds,
      pendingInitialSelectionId,
    );
    if (initialSelected.size > 0) {
      initialSelected.forEach((id) => setSelected(id, true));
      pendingInitialSelectionId = null;
    }
  };

  // Selection mode body class
  document.body.classList.add('gv-export-select-mode');
  cleanupTasks.push(() => document.body.classList.remove('gv-export-select-mode'));

  // Bottom action bar
  const bar = document.createElement('div');
  bar.className = 'gv-export-select-bar';
  bar.dataset.gvExportSelectBar = 'true';

  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.className = 'gv-export-select-all-toggle';
  selectAllBtn.dataset.gvExportAction = 'selectAll';
  selectAllBtn.textContent = t('export_select_mode_select_all');

  const selectUserBtn = document.createElement('button');
  selectUserBtn.type = 'button';
  selectUserBtn.className = 'gv-export-select-role-btn';
  selectUserBtn.dataset.gvExportAction = 'selectUser';
  selectUserBtn.textContent = t('export_select_mode_only_user');

  const selectAIBtn = document.createElement('button');
  selectAIBtn.type = 'button';
  selectAIBtn.className = 'gv-export-select-role-btn';
  selectAIBtn.dataset.gvExportAction = 'selectAI';
  selectAIBtn.textContent = t('export_select_mode_only_ai');

  const count = document.createElement('div');
  count.className = 'gv-export-select-count';
  count.dataset.gvExportSelectionCount = 'true';
  count.textContent = t('export_select_mode_count').replace('{count}', '0');

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'gv-export-select-export-btn';
  exportBtn.dataset.gvExportAction = 'export';
  exportBtn.textContent = t('pm_export');
  exportBtn.disabled = true;

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'gv-export-select-cancel-btn';
  cancelBtn.title = t('pm_cancel');
  cancelBtn.textContent = '×';

  bar.appendChild(selectAllBtn);
  bar.appendChild(selectUserBtn);
  bar.appendChild(selectAIBtn);
  bar.appendChild(count);
  bar.appendChild(exportBtn);
  bar.appendChild(cancelBtn);

  document.body.appendChild(bar);

  const swallow = (ev: Event) => {
    try {
      ev.preventDefault();
    } catch {}
    try {
      ev.stopPropagation();
    } catch {}
  };

  const selectOnlyRole = async (role: Exclude<ExportMessageRole, 'unknown'>) => {
    if (selectionBusy) return;
    autoSelectAll = false;
    selectionBusy = true;
    updateBottomBar(bar);
    try {
      throwIfExportCancelled(signal);
      if (
        exportAdapter.resolveSelectionRoles &&
        allMessageIds.some((id) => messageRoles.get(id) === 'unknown')
      ) {
        const resolved = await withExportCollectingBanner(
          () =>
            showExportProgressOverlay(t, {
              title: t('export_collecting_title'),
              desc: t('export_collecting_desc'),
            }),
          () =>
            exportAdapter.resolveSelectionRoles!(new Set(allMessageIds), {
              signal,
              expectedUrl: selectionUrl,
            }),
        );
        resolved.forEach((resolvedRole, id) => messageRoles.set(id, resolvedRole));
      }

      throwIfExportCancelled(signal);
      const roleMessageIds = allMessageIds.filter((id) => messageRoles.get(id) === role);
      const isOnlyRoleSelected =
        roleMessageIds.length > 0 &&
        selectedIds.size === roleMessageIds.length &&
        roleMessageIds.every((id) => selectedIds.has(id));
      for (const id of allMessageIds) {
        setSelected(id, isOnlyRoleSelected ? false : messageRoles.get(id) === role);
      }
      updateBottomBar(bar);
    } catch (error) {
      if (!isAbortError(error)) alert(resolveExportErrorMessage(error, t));
    } finally {
      if (!signal?.aborted && !uiCleaned) {
        selectionBusy = false;
        updateBottomBar(bar);
      }
    }
  };

  selectUserBtn.addEventListener('click', (ev) => {
    swallow(ev);
    void selectOnlyRole('user');
  });

  selectAIBtn.addEventListener('click', (ev) => {
    swallow(ev);
    void selectOnlyRole('assistant');
  });
  cleanupTasks.push(() => bar.remove());
  cleanupTasks.push(alignElementToConversationTitleCenter(bar));

  selectAllBtn.addEventListener('click', (ev) => {
    swallow(ev);
    if (selectionBusy) return;
    const isAllSelected = allMessageIds.length > 0 && selectedIds.size === allMessageIds.length;
    if (isAllSelected) {
      selectedIds.clear();
      autoSelectAll = false;
      allMessageIds.forEach((id) => setSelected(id, false));
    } else {
      selectedIds.clear();
      autoSelectAll = true;
      allMessageIds.forEach((id) => setSelected(id, true));
    }
    updateBottomBar(bar);
  });

  const finishUi = () => {
    allMessageIds.forEach((id) => setSelected(id, false));
    selectedIds.clear();
    autoSelectAll = false;
    cleanup();
  };

  cancelBtn.addEventListener('click', (ev) => {
    swallow(ev);
    activeExportController?.abort();
    finishUi();
    settleSession();
  });

  exportBtn.addEventListener('click', async (ev) => {
    swallow(ev);
    if (selectionBusy) return;
    if (selectedIds.size === 0) {
      alert(t('export_select_mode_empty'));
      return;
    }

    let hideProgress: (() => void) | null = null;
    try {
      throwIfExportCancelled(signal);
      await ensureGeneratedUiScreenshotPermission();
      const selectedIdsForExport = new Set(selectedIds);
      // Cleanup before capture/export so selection UI is not included in screenshots.
      finishUi();
      await captureGeneratedUiScreenshots();
      throwIfExportCancelled(signal);

      const buildTurnsForSelection = exportAdapter.buildTurnsForSelection;
      const turnsForExport = buildTurnsForSelection
        ? await withExportCollectingBanner(
            () =>
              showExportProgressOverlay(t, {
                title: t('export_collecting_title'),
                desc: t('export_collecting_desc'),
              }),
            () =>
              buildTurnsForSelection(selectedIdsForExport, {
                signal,
                expectedUrl: selectionUrl,
              }),
          )
        : buildTurnsForSelectedMessageIds(selectedIdsForExport, collectChatPairs());
      throwIfExportCancelled(signal);
      if (exportRouteKey(location.href) !== exportRouteKey(selectionUrl)) {
        throw new Error('export_conversation_changed');
      }
      if (turnsForExport.length === 0) throw new Error('export_empty_selection');

      const metadata: ConversationMetadata = {
        url: selectionUrl,
        exportedAt: new Date().toISOString(),
        count: turnsForExport.length,
        title: selectionTitle,
        platform: exportAdapter.site.label,
      };

      let includeImageSource = true;
      if (state.format === 'markdown') {
        const hasSearchImages = turnsForExport.some(
          (turn) =>
            turn.assistantContent?.html.includes('attachment-container.search-images') ||
            turn.assistantElement?.querySelector('.attachment-container.search-images') != null,
        );
        if (hasSearchImages) includeImageSource = confirm(t('export_md_include_source_confirm'));
      }

      hideProgress = showExportProgressOverlay(t);
      const resultPromise = exportPendingConversation(
        state,
        turnsForExport,
        metadata,
        includeImageSource,
        signal,
      );
      const minVisiblePromise = new Promise((resolve) => setTimeout(resolve, 420));
      const [result] = await Promise.all([resultPromise, minVisiblePromise]);
      throwIfExportCancelled(signal);

      if (!result.success) {
        alert(resolveExportErrorMessage(result.error, t));
      } else if (state.format === 'pdf' && isSafari()) {
        showExportToast(t('export_toast_safari_pdf_ready'), {
          autoDismissMs: 5000,
        });
      }
    } catch (error) {
      if (!isAbortError(error)) {
        console.error('[Gemini Voyager] Export error:', error);
        alert(resolveExportErrorMessage(error, t));
      }
    } finally {
      hideProgress?.();
      removeCanvasExportSections();
      removeGeneratedUiScreenshotSections();
      settleSession();
    }
  });

  // Observe new lazy-loaded messages while selection mode is active.
  const root = getConversationRoot(getUserSelectors());
  const scheduleRefresh = () => {
    if (refreshTimer) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      if (signal?.aborted || uiCleaned) return;
      if (exportRouteKey(location.href) !== exportRouteKey(selectionUrl)) {
        activeExportController?.abort();
        cancelSession();
        return;
      }
      try {
        syncMessages(collectChatPairs());
        updateBottomBar(bar);
      } catch {}
    }, 250);
  };

  const obs = new MutationObserver((mutations) => {
    if (shouldRefreshSelectionUi(mutations)) scheduleRefresh();
  });
  try {
    obs.observe(root, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    });
    cleanupTasks.push(() => obs.disconnect());
  } catch {}

  // Escape to cancel
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      activeExportController?.abort();
      finishUi();
      settleSession();
    }
  };
  document.addEventListener('keydown', onKeyDown);
  cleanupTasks.push(() => document.removeEventListener('keydown', onKeyDown));

  // Initial sync
  activeExportSelectionCleanup = cancelSession;
  syncMessages(pairs);
  updateBottomBar(bar);
  await sessionPromise;
}

function showExportProgressOverlay(
  t: (key: TranslationKey) => string,
  options?: { title?: string; desc?: string },
): () => void {
  // Never stack duplicate progress pills (e.g. export dialog progress followed
  // by the scroll-collection banner) on top of each other.
  document
    .querySelectorAll<HTMLElement>('.gv-export-progress-overlay')
    .forEach((overlay) => overlay.remove());

  const overlay = document.createElement('div');
  overlay.className = 'gv-export-progress-overlay';

  const card = document.createElement('div');
  card.className = 'gv-export-progress-card';

  const spinner = document.createElement('div');
  spinner.className = 'gv-export-progress-spinner';

  const title = document.createElement('div');
  title.className = 'gv-export-progress-title';
  title.textContent = options?.title ?? `${t('pm_export')}...`;

  const desc = document.createElement('div');
  desc.className = 'gv-export-progress-desc';
  desc.textContent = options?.desc ?? t('loading');

  card.appendChild(spinner);
  card.appendChild(title);
  card.appendChild(desc);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  const unbindAlignment = alignElementToConversationTitleCenter(overlay);

  return () => {
    unbindAlignment();
    try {
      overlay.remove();
    } catch {}
  };
}

/**
 * Check if there is a pending export operation from a previous page load.
 */
async function checkPendingExport() {
  try {
    const state = restorePendingExportState(sessionStorage, location.href);
    if (!state) return;

    // If state exists, it means we clicked and page refreshed.
    // So we resume the sequence.
    console.log('[Gemini Voyager] Resuming pending export sequence...');

    // We need i18n for final export/alert
    const dict = await loadDictionaries();
    const lang = await getLanguage();

    await executeExportSequenceWithProgress(
      state.format,
      dict,
      lang,
      state,
      state.fontSize,
      state.initialSelectedMessageId,
      state.imageWidth,
      state.usePromptAsTurnHeading,
      state.speakerLabels,
    );
  } catch (e) {
    console.error('[Gemini Voyager] Failed to resume pending export:', e);
    clearPendingExportState(sessionStorage);
  }
}

function getConversationMenuPanelsFromNode(node: HTMLElement): HTMLElement[] {
  const panels: HTMLElement[] = [];
  if (node.matches(CONVERSATION_MENU_SELECTOR)) {
    panels.push(node);
  }
  panels.push(...Array.from(node.querySelectorAll<HTMLElement>(CONVERSATION_MENU_SELECTOR)));
  return panels;
}

function parseMenuTriggerPanelIds(trigger: HTMLElement): string[] {
  const raw = `${trigger.getAttribute('aria-controls') || ''} ${
    trigger.getAttribute('aria-owns') || ''
  }`;
  return raw
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

type ResponseCopyImageTexts = {
  label: string;
  copied: string;
  downloaded: string;
  failed: string;
  unsupported: string;
  targetMissing: string;
  widthNarrow: string;
  widthMedium: string;
  widthWide: string;
};

function getResponseCopyImageTexts(
  lang: AppLanguage,
  dict: Record<AppLanguage, Record<string, string>>,
): ResponseCopyImageTexts {
  const t = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;
  if (lang === 'zh') {
    return {
      label: '复制回复为图片',
      copied: '已复制回复图片',
      downloaded: '已下载回复图片（Safari 剪贴板限制）',
      failed: '复制回复图片失败',
      unsupported: '当前浏览器不支持复制图片到剪贴板',
      targetMissing: '未找到可复制的回复内容',
      widthNarrow: t('export_image_width_narrow'),
      widthMedium: t('export_image_width_medium'),
      widthWide: t('export_image_width_wide'),
    };
  }

  if (lang === 'zh_TW') {
    return {
      label: '複製回覆為圖片',
      copied: '已複製回覆圖片',
      downloaded: '已下載回覆圖片（Safari 剪貼簿限制）',
      failed: '複製回覆圖片失敗',
      unsupported: '目前瀏覽器不支援將圖片複製到剪貼簿',
      targetMissing: '找不到可複製的回覆內容',
      widthNarrow: t('export_image_width_narrow'),
      widthMedium: t('export_image_width_medium'),
      widthWide: t('export_image_width_wide'),
    };
  }

  return {
    label: 'Copy response as image',
    copied: 'Response image copied',
    downloaded: 'Downloaded response image (Safari clipboard limitation)',
    failed: 'Failed to copy response image',
    unsupported: 'Clipboard image copy is not supported in this browser',
    targetMissing: 'Unable to locate response content',
    widthNarrow: t('export_image_width_narrow'),
    widthMedium: t('export_image_width_medium'),
    widthWide: t('export_image_width_wide'),
  };
}

function buildResponseImageFilename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `gemini-response-${stamp}.png`;
}

function isUnsupportedClipboardError(error: unknown): boolean {
  if (error instanceof DOMException) {
    const name = error.name.toLowerCase();
    if (name === 'notallowederror' || name === 'notsupportederror' || name === 'securityerror') {
      return true;
    }
  }

  if (!(error instanceof Error)) return false;

  if (/clipboard image copy is not supported/i.test(error.message)) {
    return true;
  }

  const lowerMessage = error.message.toLowerCase();
  return (
    lowerMessage.includes('clipboard') &&
    (lowerMessage.includes('not allowed') ||
      lowerMessage.includes('permission') ||
      lowerMessage.includes('gesture') ||
      lowerMessage.includes('unsupported'))
  );
}

async function handleResponseCopyImageClick(
  trigger: HTMLElement,
  getCurrentLanguage: () => AppLanguage,
  dict: Record<AppLanguage, Record<string, string>>,
  imageWidth: number = DEFAULT_IMAGE_EXPORT_WIDTH,
): Promise<void> {
  if (trigger.dataset.gvCopyImageBusy === '1') {
    return;
  }
  trigger.dataset.gvCopyImageBusy = '1';

  const lang = getCurrentLanguage();
  const texts = getResponseCopyImageTexts(lang, dict);
  const t = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;
  const speakerDefaults: ExportSpeakerLabels = {
    user: t('export_speaker_user_default'),
    assistant: t('export_speaker_assistant_default'),
  };
  const messageId = resolveAssistantMessageIdFromMenuTrigger(trigger);
  let blobForFallback: Blob | null = null;
  try {
    if (!messageId) {
      showExportToast(texts.targetMissing);
      return;
    }

    const selectedMessageIds = new Set<string>([messageId]);
    const turnsForExport = buildTurnsForSelectedMessageIds(selectedMessageIds, collectChatPairs());
    if (turnsForExport.length === 0) {
      showExportToast(texts.targetMissing);
      return;
    }

    const metadata: ConversationMetadata = {
      url: location.href,
      exportedAt: new Date().toISOString(),
      count: turnsForExport.length,
      title: getConversationTitleForExport(),
      platform: exportAdapter.site.label,
    };

    const blob = await renderResponseImageBlob(turnsForExport, metadata, {
      imageWidth,
      speakerDefaults,
    });
    blobForFallback = blob;
    await copyImageBlobToClipboard(blob);
    showExportToast(texts.copied);
  } catch (error) {
    if (isSafari() && blobForFallback) {
      if (await copyImageBlobViaSafariNativePasteboard(blobForFallback)) {
        showExportToast(texts.copied);
        return;
      }
      downloadImageBlob(blobForFallback, buildResponseImageFilename());
      showExportToast(texts.downloaded, { autoDismissMs: 3200 });
      return;
    }
    if (isUnsupportedClipboardError(error)) {
      showExportToast(texts.unsupported, { autoDismissMs: 3200 });
      return;
    }
    console.error('[Gemini Voyager] Failed to copy response image:', error);
    showExportToast(texts.failed, { autoDismissMs: 3200 });
  } finally {
    delete trigger.dataset.gvCopyImageBusy;
    removeCanvasExportSections();
  }
}

function applyResponseActionCopyImageButtons(
  getCurrentLanguage: () => AppLanguage,
  dict: Record<AppLanguage, Record<string, string>>,
): void {
  const texts = getResponseCopyImageTexts(getCurrentLanguage(), dict);
  injectResponseActionCopyImageButtons(document, {
    label: texts.label,
    tooltip: texts.label,
    onClick: (button) => {
      showResponseActionCopyImageMenu({
        anchor: button,
        translations: {
          narrow: texts.widthNarrow,
          medium: texts.widthMedium,
          wide: texts.widthWide,
        },
        onSelect: (width) => {
          void handleResponseCopyImageClick(button, getCurrentLanguage, dict, width);
        },
      });
    },
  });
}

function setupResponseActionCopyImageObserver({
  getCurrentLanguage,
  dict,
}: {
  getCurrentLanguage: () => AppLanguage;
  dict: Record<AppLanguage, Record<string, string>>;
}): void {
  applyResponseActionCopyImageButtons(getCurrentLanguage, dict);
  if (responseActionObserver) return;

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        const texts = getResponseCopyImageTexts(getCurrentLanguage(), dict);
        injectResponseActionCopyImageButtons(node, {
          label: texts.label,
          tooltip: texts.label,
          onClick: (button) => {
            showResponseActionCopyImageMenu({
              anchor: button,
              translations: {
                narrow: texts.widthNarrow,
                medium: texts.widthMedium,
                wide: texts.widthWide,
              },
              onSelect: (width) => {
                void handleResponseCopyImageClick(button, getCurrentLanguage, dict, width);
              },
            });
          },
        });
      });
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  responseActionObserver = observer;

  window.addEventListener(
    'beforeunload',
    () => {
      try {
        responseActionObserver?.disconnect();
      } catch {}
      responseActionObserver = null;
    },
    { once: true },
  );
}

function setupConversationMenuExportObserver({
  dict,
  getCurrentLanguage,
  onExport,
}: {
  dict: Record<AppLanguage, Record<string, string>>;
  getCurrentLanguage: () => AppLanguage;
  onExport: (context: {
    menuType: 'top' | 'sidebar' | 'message';
    trigger: HTMLElement | null;
  }) => void;
}): void {
  if (conversationMenuObserver) return;

  const tryInjectOnPanel = (
    menuPanel: HTMLElement,
    retriesLeft: number = MENU_INJECTION_RETRY_LIMIT,
  ) => {
    if (!menuPanel.isConnected) return;
    const currentLang = getCurrentLanguage();
    const label =
      dict[currentLang]?.['exportChatJson'] ??
      dict.en?.['exportChatJson'] ??
      'Export conversation history';
    const tooltip =
      dict[currentLang]?.['exportChatJson'] ??
      dict.en?.['exportChatJson'] ??
      'Export conversation history';

    const menuContext = getConversationMenuContext(menuPanel);
    if (menuContext) {
      const injected = injectConversationMenuExportButton(menuPanel, {
        label,
        tooltip,
        onClick: () => onExport(menuContext),
      });
      if (!injected && retriesLeft > 0) {
        window.setTimeout(
          () => tryInjectOnPanel(menuPanel, retriesLeft - 1),
          MENU_INJECTION_RETRY_DELAY_MS,
        );
      }
      return;
    }

    const responseMenuContext = getResponseMenuContext(menuPanel);
    if (responseMenuContext) {
      const injected = injectResponseMenuExportButton(menuPanel, {
        label,
        tooltip,
        onClick: () =>
          onExport({
            menuType: 'message',
            trigger: responseMenuContext.trigger,
          }),
      });
      if (!injected && retriesLeft > 0) {
        window.setTimeout(
          () => tryInjectOnPanel(menuPanel, retriesLeft - 1),
          MENU_INJECTION_RETRY_DELAY_MS,
        );
      }
      return;
    }

    if (retriesLeft > 0) {
      window.setTimeout(
        () => tryInjectOnPanel(menuPanel, retriesLeft - 1),
        MENU_INJECTION_RETRY_DELAY_MS,
      );
    }
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        const panelSet = new Set<HTMLElement>();
        const panels = getConversationMenuPanelsFromNode(node);
        panels.forEach((panel) => panelSet.add(panel));
        const closestPanel = node.closest(CONVERSATION_MENU_SELECTOR) as HTMLElement | null;
        if (closestPanel) panelSet.add(closestPanel);
        panelSet.forEach((panel) => {
          window.setTimeout(() => tryInjectOnPanel(panel), 30);
        });
      });
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  conversationMenuObserver = observer;

  const existingPanels = document.querySelectorAll<HTMLElement>(CONVERSATION_MENU_SELECTOR);
  existingPanels.forEach((panel) => window.setTimeout(() => tryInjectOnPanel(panel), 30));

  const triggerSelector = [...CONVERSATION_MENU_TRIGGER_TEST_IDS, RESPONSE_MENU_TRIGGER_TEST_ID]
    .map((id) => `[data-test-id="${id}"]`)
    .join(', ');
  const onMenuTriggerInteraction = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const trigger = target.closest(triggerSelector) as HTMLElement | null;
    if (!trigger) return;

    const panelIds = parseMenuTriggerPanelIds(trigger);
    if (panelIds.length === 0) return;

    for (let attempt = 0; attempt <= MENU_INJECTION_RETRY_LIMIT; attempt++) {
      window.setTimeout(() => {
        panelIds.forEach((id) => {
          const panel = document.getElementById(id);
          if (!(panel instanceof HTMLElement)) return;
          if (!panel.matches(CONVERSATION_MENU_SELECTOR)) return;
          tryInjectOnPanel(panel);
        });
      }, attempt * MENU_INJECTION_RETRY_DELAY_MS);
    }
  };

  document.addEventListener('click', onMenuTriggerInteraction, true);
  document.addEventListener('pointerdown', onMenuTriggerInteraction, true);

  window.addEventListener(
    'beforeunload',
    () => {
      try {
        conversationMenuObserver?.disconnect();
      } catch {}
      try {
        document.removeEventListener('click', onMenuTriggerInteraction, true);
      } catch {}
      try {
        document.removeEventListener('pointerdown', onMenuTriggerInteraction, true);
      } catch {}
      conversationMenuObserver = null;
    },
    { once: true },
  );
}

/**
 * Mount the export entry point for the current platform.
 *
 * The returned cleanup is intentionally platform-agnostic. Native plugins own
 * their lifecycle and retain this callback; Gemini's native caller may ignore it
 * because its content script owns the page lifetime.
 */
export async function startExportButton(
  options: { signal?: AbortSignal } = {},
): Promise<() => void> {
  const noCleanup = () => {};
  if (options.signal?.aborted) return noCleanup;
  // Check for pending export immediately
  if (exportAdapter.shouldPreloadHistory()) {
    checkPendingExport();
  }

  const dict = await loadDictionaries();
  if (options.signal?.aborted) return noCleanup;
  let lang = await getLanguage();
  if (options.signal?.aborted) return noCleanup;
  const t = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;

  // Platforms without Gemini's logo/menu UI: mount the persistent toolbar directly.
  if (!exportAdapter.shouldPreloadHistory()) {
    const toolbarHandle = mountPersistentExportToolbar({
      label: t('pm_export'),
      tooltip: t('exportChatJson'),
      onClick: () => void showExportDialog(dict, lang, { signal: options.signal }),
    });
    toolbarHandle.root.setAttribute('data-gv-platform', exportAdapter.site.id);
    const onStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'sync') return;
      const nextRaw = changes[StorageKeys.LANGUAGE]?.newValue;
      if (typeof nextRaw === 'string') {
        const next = normalizeLang(nextRaw);
        lang = next;
        toolbarHandle.setText(
          dict[next]?.['pm_export'] ?? dict.en?.['pm_export'] ?? 'Export',
          dict[next]?.['exportChatJson'] ?? dict.en?.['exportChatJson'] ?? 'Export chat history',
        );
      }
    };
    try {
      chrome.storage?.onChanged?.addListener(onStorageChange);
    } catch {}
    return () => {
      cancelActiveExportOperation();
      toolbarHandle.remove();
      try {
        chrome.storage?.onChanged?.removeListener(onStorageChange);
      } catch {}
      activeExportDialog?.hide();
      activeExportDialog = null;
    };
  }

  // --- Gemini path: logo anchor + menu injection ---

  setupConversationMenuExportObserver({
    dict,
    getCurrentLanguage: () => lang,
    onExport: (context) => {
      if (context.menuType === 'sidebar' && context.trigger) {
        void exportFromSidebarConversationTrigger(context.trigger, dict, () => lang);
        return;
      }
      if (context.menuType === 'message') {
        const initialSelectedMessageId = resolveAssistantMessageIdFromMenuTrigger(context.trigger);
        void showExportDialog(dict, lang, { initialSelectedMessageId });
        return;
      }
      void showExportDialog(dict, lang);
    },
  });
  setupResponseActionCopyImageObserver({
    getCurrentLanguage: () => lang,
    dict,
  });

  // The lr26 UI removed the logo entirely; resolveExportLogoAnchor short-circuits
  // there instead of waiting out the full timeout (which delayed this fallback
  // toolbar by several seconds on every conversation load).
  const logo = await resolveExportLogoAnchor(waitForElement);
  if (!logo) {
    // Fallback for lr26+ Gemini UI where the logo has been removed: mount a
    // persistent top-right toolbar so users still have an always-visible
    // export entry point. Menu injection (conversation ⋮ / response ⋮) still
    // runs in parallel via the observers above.
    let toolbarHandle: ReturnType<typeof mountPersistentExportToolbar> | null = null;

    const readToolbarEnabled = async (): Promise<boolean> => {
      try {
        const stored = await new Promise<Record<string, unknown>>((resolve) => {
          try {
            chrome.storage?.sync?.get([StorageKeys.PERSISTENT_EXPORT_TOOLBAR_ENABLED], (items) =>
              resolve(items || {}),
            );
          } catch {
            resolve({});
          }
        });
        const v = stored[StorageKeys.PERSISTENT_EXPORT_TOOLBAR_ENABLED];
        return v !== false;
      } catch {
        return true;
      }
    };

    const ensureToolbarVisibility = (enabled: boolean) => {
      if (enabled && !toolbarHandle) {
        toolbarHandle = mountPersistentExportToolbar({
          label: t('pm_export'),
          tooltip: t('exportChatJson'),
          onClick: () => showExportDialog(dict, lang),
        });
      } else if (!enabled && toolbarHandle) {
        toolbarHandle.remove();
        toolbarHandle = null;
      }
    };

    ensureToolbarVisibility(await readToolbarEnabled());

    const onStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'sync') return;
      const nextRaw = changes[StorageKeys.LANGUAGE]?.newValue;
      if (typeof nextRaw === 'string') {
        const next = normalizeLang(nextRaw);
        lang = next;
        const lbl = dict[next]?.['pm_export'] ?? dict.en?.['pm_export'] ?? 'Export';
        const ttl =
          dict[next]?.['exportChatJson'] ?? dict.en?.['exportChatJson'] ?? 'Export chat history';
        toolbarHandle?.setText(lbl, ttl);
        applyResponseActionCopyImageButtons(() => lang, dict);
      }
      const toolbarChange = changes[StorageKeys.PERSISTENT_EXPORT_TOOLBAR_ENABLED];
      if (toolbarChange && 'newValue' in toolbarChange) {
        ensureToolbarVisibility(toolbarChange.newValue !== false);
      }
    };
    try {
      chrome.storage?.onChanged?.addListener(onStorageChange);
      window.addEventListener(
        'beforeunload',
        () => {
          try {
            chrome.storage?.onChanged?.removeListener(onStorageChange);
          } catch {}
        },
        { once: true },
      );
    } catch {}
    return () => {};
  }
  const btn = ensureDropdownInjected(logo);
  if (!btn) return () => {};
  if ((btn as Element & { _gvBound?: boolean })._gvBound) return () => {};
  (btn as Element & { _gvBound?: boolean })._gvBound = true;

  // Swallow events on the button to avoid parent navigation (logo click -> /app)
  const swallow = (e: Event) => {
    try {
      e.preventDefault();
    } catch {}
    try {
      e.stopPropagation();
    } catch {}
  };
  // Capture low-level press events to avoid parent logo navigation, but do NOT capture 'click'
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((type) => {
    try {
      btn.addEventListener(type, swallow, true);
    } catch {}
  });

  const title = t('exportChatJson');
  const labelText = t('pm_export');
  btn.title = title;
  btn.setAttribute('aria-label', title);

  // Update label text
  const labelEl = btn.querySelector('.gv-export-dropdown-label');
  if (labelEl) labelEl.textContent = labelText;

  // listen for runtime language changes
  const storageChangeHandler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'sync') return;
    const nextRaw = changes[StorageKeys.LANGUAGE]?.newValue;
    if (typeof nextRaw === 'string') {
      const next = normalizeLang(nextRaw);
      lang = next;
      const ttl =
        dict[next]?.['exportChatJson'] ?? dict.en?.['exportChatJson'] ?? 'Export chat history';
      btn.title = ttl;
      btn.setAttribute('aria-label', ttl);

      // Update visible label text
      const lbl = btn.querySelector('.gv-export-dropdown-label');
      if (lbl) lbl.textContent = dict[next]?.['pm_export'] ?? dict.en?.['pm_export'] ?? 'Export';

      applyResponseActionCopyImageButtons(() => lang, dict);
    }
  };

  try {
    chrome.storage?.onChanged?.addListener(storageChangeHandler);

    // Cleanup listener on page unload to prevent memory leaks
    window.addEventListener(
      'beforeunload',
      () => {
        try {
          chrome.storage?.onChanged?.removeListener(storageChangeHandler);
        } catch (e) {
          console.error('[Gemini Voyager] Failed to remove storage listener on unload:', e);
        }
      },
      { once: true },
    );
  } catch {}

  btn.addEventListener('click', (ev) => {
    // Stop parent navigation, but allow this handler to run
    swallow(ev);
    try {
      // Show export dialog instead of directly exporting
      showExportDialog(dict, lang);
    } catch (err) {
      try {
        console.error('Gemini Voyager export failed', err);
      } catch {}
    }
  });

  // ─── DOM recovery (resize / print) ─────────────────────────────────────
  // Gemini may re-render the logo/header area (and thus destroy the wrapper
  // + export button) during window resize or window.print().  We use a
  // single debounced handler that fires on resize, afterprint, and our own
  // gv-print-cleanup event.  It checks whether the button is still attached
  // and re-injects if not.
  let currentBtn: HTMLButtonElement = btn;
  let reinjectTimer: ReturnType<typeof setTimeout> | null = null;

  const reinjectExportButtonIfNeeded = () => {
    // Debounce: Gemini fires many mutations during resize; wait until it
    // settles before we attempt re-injection.
    if (reinjectTimer !== null) clearTimeout(reinjectTimer);
    reinjectTimer = setTimeout(() => {
      reinjectTimer = null;
      try {
        // If the button is still in the document, nothing to do.
        if (document.body.contains(currentBtn)) return;

        // Remove stale wrapper if it somehow survived but lost the button.
        const staleWrapper = document.querySelector('.gv-logo-dropdown-wrapper');
        if (staleWrapper) staleWrapper.remove();

        // Re-find the logo element (Gemini may have created a fresh one).
        const newLogo =
          document.querySelector('[data-test-id="logo"]') ?? document.querySelector('.logo');
        if (!newLogo) return;

        const newBtn = ensureDropdownInjected(newLogo);
        if (!newBtn) return;
        if ((newBtn as Element & { _gvBound?: boolean })._gvBound) return;
        (newBtn as Element & { _gvBound?: boolean })._gvBound = true;

        // Re-bind all event listeners on the fresh button.
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((type) => {
          try {
            newBtn.addEventListener(type, swallow, true);
          } catch {}
        });

        const freshT = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;
        const ttl = freshT('exportChatJson');
        const lbl = freshT('pm_export');
        newBtn.title = ttl;
        newBtn.setAttribute('aria-label', ttl);
        const labelEl = newBtn.querySelector('.gv-export-dropdown-label');
        if (labelEl) labelEl.textContent = lbl;

        newBtn.addEventListener('click', (ev) => {
          swallow(ev);
          try {
            showExportDialog(dict, lang);
          } catch (err) {
            try {
              console.error('Gemini Voyager export failed', err);
            } catch {}
          }
        });

        // Update our tracking reference so the next check uses the new element.
        currentBtn = newBtn;
      } catch (e) {
        try {
          console.debug('[Gemini Voyager] Export button re-injection failed:', e);
        } catch {}
      }
    }, 800);
  };

  window.addEventListener('resize', reinjectExportButtonIfNeeded);
  window.addEventListener('gv-print-cleanup', reinjectExportButtonIfNeeded);
  window.addEventListener('afterprint', reinjectExportButtonIfNeeded);

  return () => {
    if (reinjectTimer !== null) clearTimeout(reinjectTimer);
    window.removeEventListener('resize', reinjectExportButtonIfNeeded);
    window.removeEventListener('gv-print-cleanup', reinjectExportButtonIfNeeded);
    window.removeEventListener('afterprint', reinjectExportButtonIfNeeded);
    try {
      chrome.storage?.onChanged?.removeListener(storageChangeHandler);
    } catch {}
  };
}

async function showExportDialog(
  dict: Record<AppLanguage, Record<string, string>>,
  lang: AppLanguage,
  options?: {
    initialSelectedMessageId?: string | null;
    signal?: AbortSignal;
  },
): Promise<void> {
  if (options?.signal?.aborted) return;
  const t = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;
  const speakerDefaults: ExportSpeakerLabels = {
    user: t('export_speaker_user_default'),
    assistant: t('export_speaker_assistant_default'),
  };
  const [initialImageWidth, savedSpeakerLabelOverrides] = await Promise.all([
    getSavedImageExportWidth(),
    getSavedSpeakerLabelOverrides(),
  ]);
  if (options?.signal?.aborted) return;

  // We defer collection until after the export sequence (scrolling/refresh checks)

  const dialog = new ExportDialog();
  const speakerLabelPreferenceSaver = new SpeakerLabelPreferenceSaver();
  activeExportDialog = dialog;

  dialog.show({
    onExport: async (format, fontSize, imageWidth, usePromptAsTurnHeading, speakerLabels) => {
      const controller = beginExportOperation();
      try {
        await speakerLabelPreferenceSaver.flush();
        throwIfExportCancelled(controller.signal);
        await ensureGeneratedUiScreenshotPermission();
        if (format === 'image') {
          await saveImageExportWidth(imageWidth);
        }
        await executeExportSequenceWithProgress(
          format,
          dict,
          lang,
          undefined,
          fontSize,
          options?.initialSelectedMessageId || undefined,
          imageWidth,
          usePromptAsTurnHeading,
          speakerLabels,
        );
      } catch (err) {
        if (!isAbortError(err)) console.error('[Gemini Voyager] Export error:', err);
      } finally {
        if (activeExportController === controller) {
          activeExportController = null;
          activeExportSelectionCleanup = null;
        }
      }
    },

    onCancel: () => {
      void speakerLabelPreferenceSaver.flush();
      if (activeExportDialog === dialog) activeExportDialog = null;
    },
    onSpeakerLabelOverridesChange: (speakerLabelOverrides) => {
      speakerLabelPreferenceSaver.schedule(speakerLabelOverrides);
    },
    initialImageWidth,
    showPromptHeadingOption: true,
    initialSpeakerLabelOverrides: savedSpeakerLabelOverrides,
    speakerNames: {
      title: t('export_speaker_names'),
      userLabel: t('export_speaker_user_label'),
      assistantLabel: t('export_speaker_ai_label'),
      userDefault: speakerDefaults.user,
      assistantDefault: speakerDefaults.assistant,
    },
    translations: {
      title: t('export_dialog_title'),
      selectFormat: t('export_dialog_select'),
      warning: t('export_dialog_warning'),
      safariCmdpHint: t('export_dialog_safari_cmdp_hint'),
      safariMarkdownHint: t('export_dialog_safari_markdown_hint'),
      cancel: t('pm_cancel'),
      export: t('pm_export'),
      fontSizeLabel: t('export_fontsize_label'),
      fontSizePreview: t('export_fontsize_preview'),
      imageWidthLabel: t('export_image_width_label'),
      imageWidthNarrow: t('export_image_width_narrow'),
      imageWidthMedium: t('export_image_width_medium'),
      imageWidthWide: t('export_image_width_wide'),
      promptHeadingLabel: t('export_markdown_prompt_heading'),
      promptHeadingHint: t('export_markdown_prompt_heading_hint'),
      formatDescriptions: {
        json: t('export_format_json_description'),
        markdown: t('export_format_markdown_description'),
        pdf: t('export_format_pdf_description'),
        image: t('export_format_image_description'),
      },
    },
  });
}

export default { startExportButton };
