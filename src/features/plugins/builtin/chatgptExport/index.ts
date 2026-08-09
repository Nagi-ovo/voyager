import { logger } from '@/core/services/LoggerService';
import { type Dispose, PluginScope } from '@/features/plugins/runtime/pluginScope';
import type { PluginSettings } from '@/features/plugins/types';
import { getCurrentLanguage } from '@/utils/i18n';

import {
  type ChatGptMessageSnapshot,
  buildConversationMetadata,
  collectChatGptConversation,
} from './conversation';
import { exportChatGptConversation } from './exporter';
import { getChatGptExportCopy } from './i18n';
import { showInlineMessageSelection } from './selectionMode';
import { CHATGPT_EXPORT_CSS } from './styles';
import {
  handoffTemporaryChat,
  isTemporaryChat,
  planHandoff,
  resumePendingHandoff,
} from './tempHandoff';
import {
  showCollectionProgress,
  showConfirmationDialog,
  showExportToast,
  showFormatDialog,
} from './ui';

const BUTTON_MARKER = 'data-gv-chatgpt-export-button';
const HEADER_SELECTOR = '#conversation-header-actions';
const SHARE_SELECTOR = '[data-testid="share-chat-button"]';
const REINJECT_DELAY_MS = 80;

function downloadIcon(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('gv-chatgpt-export-button-icon');
  for (const pathData of [
    'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4',
    'm7 10 5 5 5-5',
    'M12 15V3',
  ]) {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
  }
  return svg;
}

function menuIcon(kind: 'whole' | 'selected' | 'temporary'): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('gv-chatgpt-export-menu-icon');
  const paths: Record<typeof kind, readonly string[]> = {
    whole: ['M12 3v12', 'm7 10 5 5 5-5', 'M5 21h14'],
    selected: ['m3 6 2 2 3-3', 'm3 16 2 2 3-3', 'M12 6h9', 'M12 17h9'],
    temporary: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v6h6', 'M12 7v5l3 2'],
  };
  for (const pathData of paths[kind]) {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
  }
  return svg;
}

interface ButtonMountTarget {
  readonly parent: HTMLElement;
  readonly anchor: Element | null;
  readonly floating: boolean;
}

function findButtonTarget(): ButtonMountTarget {
  const header = document.querySelector<HTMLElement>(HEADER_SELECTOR);
  if (header) return { parent: header, anchor: header.firstElementChild, floating: false };

  const share = document.querySelector<HTMLElement>(SHARE_SELECTOR);
  const wrapper = share?.parentElement;
  const parent = wrapper?.parentElement;
  if (wrapper && parent) return { parent, anchor: wrapper, floating: false };
  return { parent: document.body, anchor: null, floating: true };
}

class ChatGptExportPlugin {
  private button: HTMLButtonElement | null = null;
  private stopButton: Dispose | null = null;
  private stopMenu: Dispose | null = null;
  private stopOperation: Dispose | null = null;
  private stopReinjectTimer: Dispose | null = null;

  constructor(
    private readonly scope: PluginScope,
    private readonly copy: ReturnType<typeof getChatGptExportCopy>,
  ) {}

  start(): void {
    this.scope.style(CHATGPT_EXPORT_CSS);
    this.ensureButton();
    this.scope.observe(document.body, { childList: true, subtree: true }, (records) => {
      if (!this.mutationsTouchMount(records)) return;
      this.scheduleButtonCheck();
    });
    this.scope.on(window, 'popstate', () => this.scheduleButtonCheck());
    this.scope.on(window, 'hashchange', () => this.scheduleButtonCheck());
    this.scope.effect(
      () =>
        resumePendingHandoff(this.scope).then((result) => {
          if (this.scope.isDisposed) return () => {};
          if (result === 'ready') showExportToast(this.scope, this.copy.tempReady);
          else if (result === 'delivery-failed') {
            showExportToast(this.scope, this.copy.tempDeliveryFailed, 'error');
          } else if (result === 'account-mismatch') {
            showExportToast(this.scope, this.copy.tempAccountChanged, 'error');
          }
          return () => {};
        }),
      'chatgpt-export-resume-handoff',
    );
    this.scope.effect(
      () => () => {
        void this.stopOperation?.();
        void this.stopMenu?.();
        void this.stopButton?.();
        document.querySelectorAll(`[${BUTTON_MARKER}]`).forEach((node) => node.remove());
      },
      'chatgpt-export-instance',
    );
  }

  private mutationsTouchMount(records: readonly MutationRecord[]): boolean {
    if (!this.button?.isConnected) return true;
    return records.some((record) =>
      [...record.addedNodes, ...record.removedNodes].some((node) => {
        if (!(node instanceof Element)) return false;
        return (
          node.matches(HEADER_SELECTOR) ||
          node.matches(SHARE_SELECTOR) ||
          node.querySelector(HEADER_SELECTOR) !== null ||
          node.querySelector(SHARE_SELECTOR) !== null ||
          node.contains(this.button)
        );
      }),
    );
  }

  private scheduleButtonCheck(): void {
    if (this.scope.isDisposed) return;
    void this.stopReinjectTimer?.();
    if (this.scope.isDisposed) return;
    this.stopReinjectTimer = this.scope.timer(() => {
      this.stopReinjectTimer = null;
      this.ensureButton();
    }, REINJECT_DELAY_MS);
  }

  private ensureButton(): void {
    if (this.scope.isDisposed || !document.body) return;
    const target = findButtonTarget();
    const correctParent = this.button?.parentElement === target.parent;
    const correctMode =
      this.button?.classList.contains('gv-chatgpt-export-button--floating') === target.floating;
    if (this.button?.isConnected && correctParent && correctMode) return;

    void this.stopButton?.();
    const buttonScope = new PluginScope();
    this.stopButton = this.scope.child(
      { destroy: () => buttonScope.dispose() },
      'chatgpt-export-button',
    );
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `gv-chatgpt-export-button${target.floating ? ' gv-chatgpt-export-button--floating' : ''}`;
    button.setAttribute(BUTTON_MARKER, 'true');
    button.setAttribute('aria-label', this.copy.button);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.title = this.copy.button;
    const label = document.createElement('span');
    label.className = 'gv-chatgpt-export-button-label';
    label.textContent = this.copy.export;
    button.append(downloadIcon(), label);
    buttonScope.on(button, 'click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.toggleMenu(button);
    });
    buttonScope.mount(button, target.parent, target.anchor);
    this.button = button;
  }

  private toggleMenu(anchor: HTMLButtonElement): void {
    if (this.stopMenu) {
      void this.closeMenu();
      return;
    }
    const menuScope = new PluginScope();
    this.stopMenu = this.scope.child({ destroy: () => menuScope.dispose() }, 'chatgpt-export-menu');
    menuScope.effect(
      () => () => {
        anchor.setAttribute('aria-expanded', 'false');
      },
      'chatgpt-export-menu-anchor',
    );

    const menu = document.createElement('div');
    menu.className = 'gv-chatgpt-export-menu';
    menu.dataset.gvChatgptExportOwned = 'true';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', this.copy.menu);
    const items: HTMLButtonElement[] = [];
    const addItem = (
      label: string,
      icon: 'whole' | 'selected' | 'temporary',
      action: () => void,
    ): void => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'gv-chatgpt-export-menu-item';
      item.setAttribute('role', 'menuitem');
      item.tabIndex = items.length === 0 ? 0 : -1;
      item.append(menuIcon(icon), document.createTextNode(label));
      menuScope.on(item, 'click', (event) => {
        event.preventDefault();
        void this.closeMenu();
        action();
      });
      items.push(item);
      menu.appendChild(item);
    };

    addItem(this.copy.whole, 'whole', () => this.startExport(false));
    addItem(this.copy.selected, 'selected', () => this.startExport(true));
    if (isTemporaryChat()) {
      addItem(this.copy.tempRegret, 'temporary', () => this.startTemporaryHandoff());
    }
    menuScope.mount(menu, document.body);
    anchor.setAttribute('aria-expanded', 'true');

    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth || 280;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.right - width))}px`;
    menu.style.top = `${Math.min(innerHeight - menu.offsetHeight - 8, rect.bottom + 7)}px`;

    menuScope.on(
      document,
      'pointerdown',
      (event) => {
        const target = event.target;
        if (target instanceof Node && (menu.contains(target) || anchor.contains(target))) return;
        void this.closeMenu();
      },
      { capture: true },
    );
    menuScope.on(window, 'keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void this.closeMenu();
        anchor.focus();
        return;
      }
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      let next = current;
      if (event.key === 'ArrowDown') next = (current + 1 + items.length) % items.length;
      else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = items.length - 1;
      else return;
      event.preventDefault();
      items.forEach((item, index) => (item.tabIndex = index === next ? 0 : -1));
      items[next]?.focus();
    });
    items[0]?.focus();
  }

  private async closeMenu(): Promise<void> {
    const stop = this.stopMenu;
    this.stopMenu = null;
    await stop?.();
  }

  private runOperation(action: (scope: PluginScope) => Promise<void>): void {
    void this.stopOperation?.();
    const operationScope = new PluginScope();
    const stop = this.scope.child(
      { destroy: () => operationScope.dispose() },
      'chatgpt-export-operation',
    );
    this.stopOperation = stop;
    void action(operationScope)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        logger.error('ChatGPT export plugin operation failed', { error: String(error) });
        if (!this.scope.isDisposed) {
          showExportToast(this.scope, `${this.copy.exportFailed}: ${String(error)}`, 'error');
        }
      })
      .finally(() => {
        if (this.stopOperation === stop) this.stopOperation = null;
        void stop();
      });
  }

  private startExport(selectMessages: boolean): void {
    this.runOperation(async (operationScope) => {
      const messages = selectMessages
        ? await showInlineMessageSelection(operationScope, this.copy)
        : await this.collect(operationScope);
      if (!messages) return;
      if (messages.length === 0) {
        showExportToast(this.scope, this.copy.emptyConversation, 'error');
        return;
      }
      const format = await showFormatDialog(operationScope, this.copy);
      if (!format) return;
      await exportChatGptConversation({
        ...format,
        messages,
        metadata: buildConversationMetadata(messages),
        selected: selectMessages,
      });
    });
  }

  private startTemporaryHandoff(): void {
    this.runOperation(async (operationScope) => {
      if (!isTemporaryChat()) {
        showExportToast(this.scope, this.copy.tempNotActive, 'error');
        return;
      }
      const confirmed = await showConfirmationDialog(operationScope, this.copy);
      if (!confirmed) return;
      const messages = await this.collect(operationScope);
      if (messages.length === 0) {
        showExportToast(this.scope, this.copy.emptyConversation, 'error');
        return;
      }
      const metadata = buildConversationMetadata(messages);
      await exportChatGptConversation({
        format: 'markdown',
        messages,
        metadata,
        selected: false,
      });
      const result = await handoffTemporaryChat(operationScope, planHandoff(messages));
      if (result === 'ready') showExportToast(this.scope, this.copy.tempReady);
      else if (result === 'leave-failed') {
        showExportToast(this.scope, this.copy.tempLeaveFailed, 'error');
      } else if (result === 'delivery-failed') {
        showExportToast(this.scope, this.copy.tempDeliveryFailed, 'error');
      } else if (result === 'account-mismatch') {
        showExportToast(this.scope, this.copy.tempAccountChanged, 'error');
      } else showExportToast(this.scope, this.copy.tempComposerFailed, 'error');
    });
  }

  private async collect(scope: PluginScope): Promise<ChatGptMessageSnapshot[]> {
    const controller = new AbortController();
    scope.effect(() => {
      const abort = (): void => controller.abort();
      scope.signal.addEventListener('abort', abort, { once: true });
      return () => {
        scope.signal.removeEventListener('abort', abort);
        controller.abort();
      };
    }, 'chatgpt-export-collection-abort');
    const progress = showCollectionProgress(scope, this.copy, () => controller.abort());
    try {
      return await collectChatGptConversation({
        signal: controller.signal,
        onProgress: ({ messages }) => progress.setCount(messages),
      });
    } finally {
      await progress.close();
    }
  }
}

export async function activateChatGptExport(
  scope: PluginScope,
  _settings: PluginSettings = {},
): Promise<void> {
  const copy = getChatGptExportCopy(await getCurrentLanguage());
  if (scope.isDisposed) return;
  new ChatGptExportPlugin(scope, copy).start();
}
