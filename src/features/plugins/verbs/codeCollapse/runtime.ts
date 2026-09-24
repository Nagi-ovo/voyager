import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ChevronDown,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  type LucideIcon,
} from 'lucide-react';

import { StorageKeys } from '@/core/types/common';
import { getCurrentLanguage } from '@/utils/i18n';

import { PluginScope, type Dispose } from '../../runtime/pluginScope';
import type { PluginSettings } from '../../types';
import {
  DEFAULT_THRESHOLD_LINES,
  isThresholdLines,
  type CodeCollapseParams,
} from '../codeCollapse';
import type { PrimitiveContext, PrimitiveHandle } from '../types';
import { codeCollapseLabels } from './labels';
import { CODE_COLLAPSE_STYLES } from './styles';

const TOGGLE_CLASS = 'gv-code-collapse-toggle';
const TOOLBAR_CLASS = 'gv-code-collapse-toolbar';
const CLAMP_PROPERTIES = ['max-height', 'min-height', 'overflow-y'] as const;
const MAX_CODE_CHARACTERS = 200_000;
const MAX_CODE_NODES = 10_000;

function readCode(pre: HTMLElement): string | null {
  const walker = pre.ownerDocument.createTreeWalker(
    pre,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  const chunks: string[] = [];
  let length = 0;
  let nodes = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (++nodes > MAX_CODE_NODES) return null;
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const text = node as Text;
    if (length + text.length > MAX_CODE_CHARACTERS) return null;
    chunks.push(text.substringData(0, text.length));
    length += text.length;
  }
  return chunks.join('');
}

interface Block {
  pre: HTMLElement;
  parent: HTMLElement;
  identity: string;
  text: string;
  folded: boolean;
  decision: boolean | undefined;
  autoFolded: boolean;
  toggle: HTMLButtonElement | null;
  releaseToggle: Dispose | null;
  clamp: ClampHandle | null;
}

interface ClampHandle {
  restore(): void;
  isCurrent(): boolean;
  reapply(): void;
}

function clamp(pre: HTMLElement, lines: number): ClampHandle {
  const original = pre.getAttribute('style');
  const prior = CLAMP_PROPERTIES.map((key) => ({
    key,
    value: pre.style.getPropertyValue(key),
    priority: pre.style.getPropertyPriority(key),
  }));
  const view = pre.ownerDocument.defaultView;
  const computed = view?.getComputedStyle(pre);
  const lineHeight =
    Number.parseFloat(computed?.lineHeight ?? '') ||
    (Number.parseFloat(computed?.fontSize ?? '') || 16) * 1.5;
  const height = view?.CSS?.supports('max-height', '1lh')
    ? lines + 'lh'
    : lines * lineHeight + 'px';
  let applied = CLAMP_PROPERTIES.map((key) => ({ key, value: '', priority: '' }));
  let appliedStyle = '';
  let hostEdited = false;
  const current = (key: string) => ({
    value: pre.style.getPropertyValue(key),
    priority: pre.style.getPropertyPriority(key),
  });
  const isCurrent = () =>
    applied.every(({ key, value, priority }) => {
      const valueNow = current(key);
      return valueNow.value === value && valueNow.priority === priority;
    });
  const captureHostChanges = () => {
    if (pre.style.cssText !== appliedStyle) hostEdited = true;
    for (let i = 0; i < prior.length; i++) {
      const valueNow = current(prior[i].key);
      if (valueNow.value !== applied[i].value || valueNow.priority !== applied[i].priority) {
        prior[i].value = valueNow.value;
        prior[i].priority = valueNow.priority;
      }
    }
  };
  const writeClamp = () => {
    pre.style.setProperty('max-height', height, 'important');
    pre.style.setProperty('min-height', '0', 'important');
    pre.style.setProperty('overflow-y', 'hidden', 'important');
    applied = CLAMP_PROPERTIES.map((key) => ({ key, ...current(key) }));
    appliedStyle = pre.style.cssText;
  };
  writeClamp();
  return {
    isCurrent,
    reapply() {
      captureHostChanges();
      writeClamp();
    },
    restore() {
      captureHostChanges();
      if (!hostEdited) {
        if (original === null) pre.removeAttribute('style');
        else pre.setAttribute('style', original);
        return;
      }
      for (let i = 0; i < prior.length; i++) {
        const { key, value, priority } = prior[i];
        const valueNow = current(key);
        if (valueNow.value !== applied[i].value || valueNow.priority !== applied[i].priority)
          continue;
        if (value) pre.style.setProperty(key, value, priority);
        else pre.style.removeProperty(key);
      }
    },
  };
}

function isEditable(el: Element): boolean {
  for (let current: Element | null = el; current; current = current.parentElement) {
    const value = current.getAttribute('contenteditable')?.toLowerCase();
    if (value === 'false') return false;
    if (value === '' || value === 'true' || value === 'plaintext-only') return true;
  }
  return false;
}

function setIcon(button: HTMLButtonElement, icon: LucideIcon, label: string): void {
  if (button.getAttribute('aria-label') === label) return;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = renderToStaticMarkup(createElement(icon, { 'aria-hidden': true, size: 18 }));
}

export function activateCodeCollapse(
  scope: PluginScope,
  params: CodeCollapseParams,
  context: PrimitiveContext,
): PrimitiveHandle {
  const { doc } = context;
  let labels = codeCollapseLabels('en');
  let languageRequest = 0;
  const blocks = new Map<HTMLElement, Block>();
  let threshold = DEFAULT_THRESHOLD_LINES;
  let toolbar: HTMLElement | null = null;
  let releaseToolbar: Dispose | null = null;
  let pending = false;
  let route = doc.location?.href;

  function identity(pre: HTMLElement): string {
    const parts: string[] = [];
    for (let el: Element | null = pre; el; el = el.parentElement) {
      parts.push(
        ['id', 'data-message-id', 'data-turn-id', 'data-message-author-role']
          .map((key) => el?.getAttribute(key) ?? '')
          .join('|'),
      );
    }
    return JSON.stringify(parts);
  }

  function targets(): HTMLElement[] {
    try {
      // Query within each turn so a comma-separated adapter selector cannot leak scope.
      const candidates = params.code
        ? Array.from(doc.querySelectorAll(params.code))
        : Array.from(
            doc.querySelectorAll(context.adapter?.selectors.assistantTurn ?? ':not(*)'),
          ).flatMap((turn) => Array.from(turn.querySelectorAll('pre')));
      return [...new Set(candidates)].filter(
        (el): el is HTMLElement =>
          el.tagName === 'PRE' &&
          el.ownerDocument === doc &&
          el.isConnected &&
          (params.code !== undefined ||
            !context.adapter?.selectors.thinkingBlock ||
            !el.closest(context.adapter.selectors.thinkingBlock)) &&
          !isEditable(el) &&
          !el.querySelector('button, input, textarea, [role="button"]'),
      );
    } catch {
      return [];
    }
  }

  function resetBlock(block: Block): void {
    block.clamp?.restore();
    block.clamp = null;
    block.folded = false;
    block.toggle?.remove();
    void block.releaseToggle?.();
    block.releaseToggle = null;
    block.toggle = null;
  }

  function apply(block: Block, folded: boolean): void {
    if (block.folded !== folded) {
      block.clamp?.restore();
      block.clamp = folded ? clamp(block.pre, threshold) : null;
      block.folded = folded;
    } else if (folded && block.clamp && !block.clamp.isCurrent()) {
      block.clamp.reapply();
    }
    if (block.toggle) {
      setIcon(
        block.toggle,
        folded ? ChevronDown : ChevronUp,
        folded ? labels.expand : labels.collapse,
      );
      block.toggle.setAttribute('aria-expanded', String(!folded));
    }
  }

  function button(
    parent: HTMLElement,
    icon: LucideIcon,
    label: string,
    click: () => void,
    child: PluginScope,
  ) {
    const el = doc.createElement('button');
    el.type = 'button';
    setIcon(el, icon, label);
    child.on(el, 'click', (event) => {
      if (child.isDisposed || scope.isDisposed) return;
      event.preventDefault();
      event.stopPropagation();
      click();
    });
    child.mount(el, parent);
    return el;
  }

  function refreshLabels(): void {
    const request = ++languageRequest;
    void getCurrentLanguage()
      .catch(() => doc.defaultView?.navigator.language ?? 'en')
      .then((language) => {
        if (scope.isDisposed || request !== languageRequest) return;
        labels = codeCollapseLabels(language);
        for (const block of blocks.values()) {
          if (block.toggle) {
            setIcon(
              block.toggle,
              block.folded ? ChevronDown : ChevronUp,
              block.folded ? labels.expand : labels.collapse,
            );
          }
        }
        if (toolbar) {
          toolbar.setAttribute('aria-label', labels.toolbar);
          const buttons = toolbar.querySelectorAll('button');
          setIcon(buttons[0], ChevronsUpDown, labels.expandAll);
          setIcon(buttons[1], ChevronsDownUp, labels.collapseAll);
        }
      });
  }

  function syncToolbar(): void {
    const active = [...blocks.values()].filter((block) => block.toggle);
    const first = active[0];
    if (!first) {
      toolbar?.remove();
      void releaseToolbar?.();
      toolbar = null;
      releaseToolbar = null;
      return;
    }
    if (!toolbar) {
      const child = new PluginScope();
      releaseToolbar = scope.effect(() => () => child.dispose(), 'code-collapse-toolbar');
      toolbar = doc.createElement('div');
      toolbar.className = TOOLBAR_CLASS;
      toolbar.setAttribute('role', 'group');
      toolbar.setAttribute('aria-label', labels.toolbar);
      for (const folded of [false, true]) {
        button(
          toolbar,
          folded ? ChevronsDownUp : ChevronsUpDown,
          folded ? labels.collapseAll : labels.expandAll,
          () => {
            for (const block of blocks.values()) {
              block.decision = folded;
              if (block.toggle) apply(block, folded);
            }
            syncToolbar();
          },
          child,
        );
      }
      child.mount(toolbar, first.parent, first.pre);
    } else if (toolbar.parentElement !== first.parent || toolbar.nextElementSibling !== first.pre) {
      first.parent.insertBefore(toolbar, first.pre);
    }
    const buttons = toolbar.querySelectorAll('button');
    buttons[0].disabled = active.every((block) => !block.folded);
    buttons[1].disabled = active.every((block) => block.folded);
  }

  function reconcile(): void {
    if (scope.isDisposed) return;
    const found = new Map<HTMLElement, string>();
    for (const pre of targets()) {
      const text = readCode(pre);
      if (text !== null) found.set(pre, text);
    }
    const routeChanged = route !== doc.location?.href;
    route = doc.location?.href;
    for (const [pre, block] of blocks) {
      const text = found.get(pre) ?? '';
      if (
        !found.has(pre) ||
        pre.parentElement !== block.parent ||
        identity(pre) !== block.identity ||
        routeChanged ||
        !text.startsWith(block.text)
      ) {
        resetBlock(block);
        blocks.delete(pre);
      }
    }
    for (const [pre, text] of found) {
      if (!pre.parentElement) continue;
      let block = blocks.get(pre);
      if (!block) {
        block = {
          pre,
          parent: pre.parentElement,
          identity: identity(pre),
          text: '',
          folded: false,
          decision: undefined,
          autoFolded: false,
          toggle: null,
          releaseToggle: null,
          clamp: null,
        };
        blocks.set(pre, block);
      }
      block.text = text;
      const lines = block.text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length;
      if (lines <= threshold) {
        resetBlock(block);
        continue;
      }
      if (!block.toggle) {
        const child = new PluginScope();
        block.releaseToggle = scope.effect(() => () => child.dispose(), 'code-collapse-toggle');
        const current = block;
        block.toggle = button(
          block.parent,
          ChevronDown,
          labels.expand,
          () => {
            current.decision = !current.folded;
            apply(current, current.decision);
            syncToolbar();
          },
          child,
        );
        block.toggle.className = TOGGLE_CLASS;
      }
      if (pre.nextElementSibling !== block.toggle) pre.after(block.toggle);
      const folded = block.decision ?? (block.folded || !block.autoFolded);
      block.autoFolded = true;
      apply(block, folded);
    }
    syncToolbar();
  }

  function schedule(): void {
    if (scope.isDisposed || pending) return;
    pending = true;
    scope.timer(() => {
      pending = false;
      reconcile();
    }, 32);
  }

  function containsPre(node: Node): boolean {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const el = node as Element;
    return el.tagName === 'PRE' || el.querySelector('pre') !== null;
  }

  function insidePre(node: Node): boolean {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    return Boolean(el?.closest('pre'));
  }

  function relevantMutation(record: MutationRecord): boolean {
    if (record.type === 'attributes' && record.attributeName === 'style') {
      const block = blocks.get(record.target as HTMLElement);
      return Boolean(block?.clamp && !block.clamp.isCurrent());
    }
    if (record.type === 'characterData') return insidePre(record.target);
    if (record.type === 'attributes') {
      return insidePre(record.target) || containsPre(record.target);
    }
    if (insidePre(record.target)) return true;
    return [...record.addedNodes, ...record.removedNodes].some(
      (node) =>
        node.nodeType === Node.ELEMENT_NODE &&
        (containsPre(node) ||
          (node === toolbar && !toolbar?.isConnected) ||
          [...blocks.values()].some(
            (block) => block.toggle === node && !block.toggle?.isConnected,
          )),
    );
  }

  scope.effect(
    () => () => {
      for (const block of blocks.values()) resetBlock(block);
      blocks.clear();
      toolbar?.remove();
    },
    'code-collapse-blocks',
  );
  scope.style(CODE_COLLAPSE_STYLES, doc);
  scope.observe(
    doc.documentElement,
    {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'class',
        'id',
        'data-message-id',
        'data-turn-id',
        'data-message-author-role',
        'contenteditable',
        'style',
      ],
    },
    (records) => {
      let relevant = route !== doc.location?.href;
      for (const record of records) {
        if (relevantMutation(record)) relevant = true;
        for (const removed of record.removedNodes) {
          if (!containsPre(removed)) continue;
          for (const [pre, block] of blocks) {
            if (removed === pre || removed.contains(pre)) {
              resetBlock(block);
              blocks.delete(pre);
              relevant = true;
            }
          }
        }
      }
      if (relevant) schedule();
    },
  );
  if (doc.defaultView) {
    scope.on(doc.defaultView, 'popstate', schedule);
    scope.on(doc.defaultView, 'hashchange', schedule);
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    scope.onChromeEvent(chrome.storage.onChanged, (changes, areaName) => {
      if (scope.isDisposed) return;
      if ((areaName === 'sync' || areaName === 'local') && changes[StorageKeys.LANGUAGE]) {
        refreshLabels();
      }
    });
  }
  refreshLabels();
  context.setTargetCounter(() => targets().length);

  function updateSettings(settings: PluginSettings): void {
    if (scope.isDisposed) return;
    const next = isThresholdLines(settings.thresholdLines)
      ? settings.thresholdLines
      : (params.thresholdLines ?? DEFAULT_THRESHOLD_LINES);
    if (next !== threshold) {
      threshold = next;
      for (const block of blocks.values()) {
        block.clamp?.restore();
        block.clamp = block.folded ? clamp(block.pre, threshold) : null;
      }
    }
    reconcile();
  }
  updateSettings(context.settings);
  return { updateSettings };
}
