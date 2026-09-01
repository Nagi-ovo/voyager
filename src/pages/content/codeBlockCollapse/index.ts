import { StorageKeys } from '@/core/types/common';
import { getTranslationSync } from '@/utils/i18n';

export const LONG_CODE_BLOCK_MIN_LINES = 24;
export const LONG_CODE_BLOCK_MIN_HEIGHT = 520;

const HOST_SELECTOR = 'code-block';
const CODE_SELECTOR = 'code[data-test-id="code-content"], code.code-container, pre > code';
const TOGGLE_CLASS = 'gv-code-block-toggle';
const COLLAPSIBLE_CLASS = 'gv-code-block-collapsible';
const COLLAPSED_CLASS = 'gv-code-block-collapsed';
const SCAN_DEBOUNCE_MS = 120;

let observer: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let scanTimer: number | null = null;
const managedBlocks = new Set<HTMLElement>();
const observedBlocks = new Set<HTMLElement>();
const buttonsByBlock = new Map<HTMLElement, HTMLButtonElement>();
const pendingBlocks = new Set<HTMLElement>();
let languageChangeListener:
  | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
  | null = null;

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split(/\r\n?|\n/).length;
}

export function isLongCodeBlock(code: HTMLElement): boolean {
  if (lineCount(code.textContent ?? '') >= LONG_CODE_BLOCK_MIN_LINES) return true;

  const pre = code.closest('pre');
  const renderedHeight = Math.max(
    code.scrollHeight,
    pre instanceof HTMLElement ? pre.scrollHeight : 0,
  );

  return renderedHeight >= LONG_CODE_BLOCK_MIN_HEIGHT;
}

function isMermaidBlock(host: HTMLElement): boolean {
  if (host.closest('.gv-mermaid-wrapper')) return true;

  const language = host
    .querySelector('.code-block-decoration > span')
    ?.textContent?.trim()
    .toLowerCase();
  return language === 'mermaid';
}

function toggleIcon(collapsed: boolean): string {
  const path = collapsed ? 'M8 8l4 4 4-4M8 13l4 4 4-4' : 'M8 16l4-4 4 4M8 11l4-4 4 4';
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="${path}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" />
    </svg>
  `;
}

function updateToggle(host: HTMLElement, button: HTMLButtonElement): void {
  const collapsed = host.classList.contains(COLLAPSED_CLASS);
  const state = collapsed ? 'collapsed' : 'expanded';
  const label = getTranslationSync(collapsed ? 'pm_expand' : 'pm_collapse');

  if (button.dataset.state !== state) {
    button.dataset.state = state;
    button.innerHTML = toggleIcon(collapsed);
  }
  if (button.title !== label) button.title = label;
  if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function removeEnhancement(host: HTMLElement): void {
  const button =
    buttonsByBlock.get(host) ?? host.querySelector<HTMLButtonElement>(`.${TOGGLE_CLASS}`);
  button?.remove();
  buttonsByBlock.delete(host);
  managedBlocks.delete(host);
  host.classList.remove(COLLAPSIBLE_CLASS, COLLAPSED_CLASS);
}

interface CodeBlockMeasurement {
  host: HTMLElement;
  actions: HTMLElement | null;
  shouldEnhance: boolean;
}

function observeBlock(host: HTMLElement): void {
  if (!resizeObserver || observedBlocks.has(host)) return;
  resizeObserver.observe(host);
  observedBlocks.add(host);
}

function measureCodeBlock(host: HTMLElement): CodeBlockMeasurement {
  observeBlock(host);
  const code = host.querySelector<HTMLElement>(CODE_SELECTOR);
  const decoration = host.querySelector<HTMLElement>('.code-block-decoration');
  const actions = decoration?.querySelector<HTMLElement>('.buttons') ?? decoration;

  return {
    host,
    actions: actions ?? null,
    shouldEnhance: Boolean(code && actions && !isMermaidBlock(host) && isLongCodeBlock(code)),
  };
}

function applyCodeBlockMeasurement({ host, actions, shouldEnhance }: CodeBlockMeasurement): void {
  if (!shouldEnhance || !actions) {
    removeEnhancement(host);
    return;
  }

  managedBlocks.add(host);
  host.classList.add(COLLAPSIBLE_CLASS);

  let button = buttonsByBlock.get(host);
  if (!button || !button.isConnected || button.parentElement !== actions) {
    button?.remove();
    button = document.createElement('button');
    button.type = 'button';
    button.className = TOGGLE_CLASS;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      host.classList.toggle(COLLAPSED_CLASS);
      updateToggle(host, button!);
    });
    actions.appendChild(button);
    buttonsByBlock.set(host, button);
  }

  updateToggle(host, button);
}

export function enhanceCodeBlock(host: HTMLElement): void {
  applyCodeBlockMeasurement(measureCodeBlock(host));
}

function cleanupDisconnectedBlocks(): void {
  // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot: the loop body mutates the collection
  for (const host of [...observedBlocks]) {
    if (host.isConnected) continue;
    resizeObserver?.unobserve(host);
    observedBlocks.delete(host);
    removeEnhancement(host);
  }
}

export function processCodeBlocks(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>(HOST_SELECTOR).forEach(enhanceCodeBlock);

  cleanupDisconnectedBlocks();
}

function collectContainingCodeBlock(node: Node): void {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) return;

  const containingBlock = element.closest<HTMLElement>(HOST_SELECTOR);
  if (containingBlock) pendingBlocks.add(containingBlock);
}

function collectAddedCodeBlocks(node: Node): void {
  const element = node instanceof Element ? node : null;
  if (!element) return;

  if (element.matches(HOST_SELECTOR)) pendingBlocks.add(element as HTMLElement);
  element.querySelectorAll<HTMLElement>(HOST_SELECTOR).forEach((block) => pendingBlocks.add(block));
}

function flushPendingBlocks(): void {
  const measurements = [...pendingBlocks]
    .filter((block) => block.isConnected)
    .map(measureCodeBlock);
  pendingBlocks.clear();

  // Finish every layout read before adding/removing buttons and classes. This
  // prevents one block's DOM write from forcing the next block's measurement.
  measurements.forEach(applyCodeBlockMeasurement);
  cleanupDisconnectedBlocks();
}

function schedulePendingFlush(): void {
  if (scanTimer !== null) window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    flushPendingBlocks();
  }, SCAN_DEBOUNCE_MS);
}

function scheduleScan(records: MutationRecord[]): void {
  for (const record of records) {
    collectContainingCodeBlock(record.target);
    record.addedNodes.forEach(collectAddedCodeBlocks);
  }

  schedulePendingFlush();
}

export function stopCodeBlockCollapse(): void {
  observer?.disconnect();
  observer = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (scanTimer !== null) {
    window.clearTimeout(scanTimer);
    scanTimer = null;
  }
  pendingBlocks.clear();
  observedBlocks.clear();
  // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot: the loop body mutates the collection
  for (const host of [...managedBlocks]) removeEnhancement(host);
  if (languageChangeListener) {
    try {
      chrome.storage?.onChanged?.removeListener(languageChangeListener);
    } catch {}
    languageChangeListener = null;
  }
}

export function startCodeBlockCollapse(): () => void {
  stopCodeBlockCollapse();

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target instanceof HTMLElement && entry.target.matches(HOST_SELECTOR)) {
          pendingBlocks.add(entry.target);
        }
      }
      if (pendingBlocks.size > 0) schedulePendingFlush();
    });
  }
  processCodeBlocks();

  observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  languageChangeListener = (changes, areaName) => {
    if ((areaName !== 'sync' && areaName !== 'local') || !changes[StorageKeys.LANGUAGE]) return;
    queueMicrotask(() => {
      for (const [host, button] of buttonsByBlock) updateToggle(host, button);
    });
  };
  chrome.storage?.onChanged?.addListener(languageChangeListener);

  return stopCodeBlockCollapse;
}
