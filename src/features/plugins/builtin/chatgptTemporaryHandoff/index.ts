import { logger } from '@/core/services/LoggerService';
import { DOMContentExtractor } from '@/features/export/services/DOMContentExtractor';
import type { ChatTurn } from '@/features/export/types/export';
import { type Dispose, PluginScope } from '@/features/plugins/runtime/pluginScope';
import type { PluginSettings } from '@/features/plugins/types';
import {
  buildChatGptTurnsForSelection,
  chatgptCollectTurnContainers,
} from '@/pages/content/export/adapter/chatgpt';
import { resolveExportAdapter } from '@/pages/content/export/adapter/platformAdapters';
import { watchRouteChanges } from '@/pages/content/utils/routeWatcher';
import { getCurrentLanguage } from '@/utils/i18n';

import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_TEMP_TOGGLE_SELECTOR,
  discardPendingHandoff,
  downloadHandoffBackup,
  handoffTemporaryChat,
  isTemporaryChat,
  planHandoff,
  resumePendingHandoff,
} from './handoff';
import { type TemporaryHandoffCopy, getTemporaryHandoffCopy } from './i18n';
import { CHATGPT_TEMPORARY_HANDOFF_CSS } from './styles';
import { showHandoffConfirmation, showHandoffProgress, showHandoffToast } from './ui';

const BUTTON_MARKER = 'data-gv-chatgpt-handoff-button';
const HEADER_SELECTOR = '#conversation-header-actions';
const SHARE_SELECTOR = '[data-testid="share-chat-button"]';
const REFRESH_DELAY_MS = 80;

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

function handoffIcon(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('gv-chatgpt-handoff-button-icon');
  for (const pathData of ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v6h6', 'M12 7v5l3 2']) {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
  }
  return svg;
}

export async function collectTemporaryChatTurns(
  signal: AbortSignal,
  expectedUrl = location.href,
): Promise<ChatTurn[]> {
  DOMContentExtractor.setExportAdapter(resolveExportAdapter());
  const selectedIds = new Set(chatgptCollectTurnContainers().map(({ id }) => id));
  if (selectedIds.size === 0) return [];
  return await buildChatGptTurnsForSelection(selectedIds, { signal, expectedUrl });
}

class ChatGptTemporaryHandoffPlugin {
  private button: HTMLButtonElement | null = null;
  private stopButton: Dispose | null = null;
  private stopRefreshTimer: Dispose | null = null;
  private stopOperation: Dispose | null = null;
  private operationRequest = 0;
  private resumeInFlight: Promise<void> | null = null;
  private resumeRequested = false;

  constructor(
    private readonly scope: PluginScope,
    private readonly copy: TemporaryHandoffCopy,
    private readonly language: Awaited<ReturnType<typeof getCurrentLanguage>>,
  ) {}

  start(): void {
    this.scope.style(CHATGPT_TEMPORARY_HANDOFF_CSS);
    this.scope.effect(
      () => () => discardPendingHandoff(),
      'discard-chatgpt-temporary-handoff-on-disable',
    );
    this.ensureButton();
    this.scope.observe(
      document.body,
      {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label', 'aria-pressed', 'data-testid'],
      },
      (records) => {
        if (this.mutationsTouchComposer(records)) this.tryResumePendingHandoff();
        if (this.mutationsTouchButtonMount(records)) this.scheduleRefresh();
      },
    );
    this.scope.effect(
      () =>
        watchRouteChanges(() => {
          this.scheduleRefresh();
          this.tryResumePendingHandoff();
        }),
      'watch-chatgpt-handoff-route',
    );
    this.tryResumePendingHandoff();
    this.scope.effect(
      () => () => {
        this.operationRequest += 1;
        void this.stopOperation?.();
        void this.stopButton?.();
        document.querySelectorAll(`[${BUTTON_MARKER}]`).forEach((node) => node.remove());
      },
      'chatgpt-temporary-handoff-instance',
    );
  }

  private mutationsTouchComposer(records: readonly MutationRecord[]): boolean {
    return records.some((record) =>
      [...record.addedNodes].some((node) => {
        if (!(node instanceof Element)) return false;
        return (
          node.matches(CHATGPT_COMPOSER_SELECTOR) ||
          node.querySelector(CHATGPT_COMPOSER_SELECTOR) !== null
        );
      }),
    );
  }

  private mutationsTouchButtonMount(records: readonly MutationRecord[]): boolean {
    if (this.button && !this.button.isConnected) return true;
    const selector = [HEADER_SELECTOR, SHARE_SELECTOR, CHATGPT_TEMP_TOGGLE_SELECTOR].join(',');
    return records.some((record) => {
      const nodes =
        record.type === 'attributes'
          ? [record.target]
          : [...record.addedNodes, ...record.removedNodes];
      return nodes.some((node) => {
        if (!(node instanceof Element)) return false;
        return (
          node.matches(selector) ||
          node.querySelector(selector) !== null ||
          (this.button ? node.contains(this.button) : false)
        );
      });
    });
  }

  private scheduleRefresh(): void {
    if (this.scope.isDisposed) return;
    void this.stopRefreshTimer?.();
    if (this.scope.isDisposed) return;
    this.stopRefreshTimer = this.scope.timer(() => {
      this.stopRefreshTimer = null;
      this.ensureButton();
    }, REFRESH_DELAY_MS);
  }

  private ensureButton(): void {
    if (this.scope.isDisposed || !document.body) return;
    if (!isTemporaryChat()) {
      void this.stopButton?.();
      this.stopButton = null;
      this.button = null;
      return;
    }

    const target = findButtonTarget();
    const correctParent = this.button?.parentElement === target.parent;
    const correctMode =
      this.button?.classList.contains('gv-chatgpt-handoff-button--floating') === target.floating;
    if (this.button?.isConnected && correctParent && correctMode) return;

    void this.stopButton?.();
    const buttonScope = new PluginScope();
    this.stopButton = this.scope.child(
      { destroy: () => buttonScope.dispose() },
      'chatgpt-temporary-handoff-button',
    );
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `gv-chatgpt-handoff-button${target.floating ? ' gv-chatgpt-handoff-button--floating' : ''}`;
    button.setAttribute(BUTTON_MARKER, 'true');
    button.setAttribute('aria-label', this.copy.button);
    button.title = this.copy.button;
    const label = document.createElement('span');
    label.className = 'gv-chatgpt-handoff-button-label';
    label.textContent = this.copy.button;
    button.append(handoffIcon(), label);
    buttonScope.on(button, 'click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.startHandoff();
    });
    buttonScope.effect(
      () => () => {
        if (this.button === button) this.button = null;
      },
      'chatgpt-temporary-handoff-button-reference',
    );
    buttonScope.mount(button, target.parent, target.anchor);
    this.button = button;
  }

  private cancelCurrentOperation(): void {
    this.operationRequest += 1;
    const stop = this.stopOperation;
    this.stopOperation = null;
    void stop?.();
  }

  private runOperation(action: (scope: PluginScope) => Promise<void>): void {
    const request = ++this.operationRequest;
    void (async () => {
      await this.stopOperation?.();
      if (this.scope.isDisposed || request !== this.operationRequest) return;

      const operationScope = new PluginScope();
      const stop = this.scope.child(
        { destroy: () => operationScope.dispose() },
        'chatgpt-temporary-handoff-operation',
      );
      this.stopOperation = stop;
      try {
        await action(operationScope);
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        logger.error('ChatGPT temporary handoff failed', { error: String(error) });
        showHandoffToast(this.scope, this.copy.failed, 'error');
      } finally {
        await stop();
        if (this.stopOperation === stop) this.stopOperation = null;
      }
    })();
  }

  private startHandoff(): void {
    this.runOperation(async (operationScope) => {
      if (!isTemporaryChat()) {
        showHandoffToast(this.scope, this.copy.notTemporary, 'error');
        return;
      }
      if (!(await showHandoffConfirmation(operationScope, this.copy))) return;
      if (!isTemporaryChat()) {
        showHandoffToast(this.scope, this.copy.notTemporary, 'error');
        return;
      }

      const expectedUrl = location.href;
      const progress = showHandoffProgress(operationScope, this.copy, () =>
        this.cancelCurrentOperation(),
      );
      let turns: ChatTurn[];
      try {
        turns = await collectTemporaryChatTurns(operationScope.signal, expectedUrl);
      } finally {
        await progress.close();
      }
      if (turns.length === 0) {
        showHandoffToast(this.scope, this.copy.emptyConversation, 'error');
        return;
      }

      const plan = planHandoff(turns, this.language);
      downloadHandoffBackup(plan.transcript, plan.backupFilename);
      const result = await handoffTemporaryChat(operationScope, plan.delivery);
      if (result === 'ready') showHandoffToast(this.scope, this.copy.ready);
      else if (result === 'leave-failed') {
        showHandoffToast(this.scope, this.copy.leaveFailed, 'error');
      } else if (result === 'composer-missing') {
        showHandoffToast(this.scope, this.copy.composerMissing);
      } else if (result === 'delivery-failed') {
        showHandoffToast(this.scope, this.copy.deliveryFailed, 'error');
      } else if (result === 'storage-failed') {
        showHandoffToast(this.scope, this.copy.failed, 'error');
      } else showHandoffToast(this.scope, this.copy.accountChanged, 'error');
    });
  }

  private tryResumePendingHandoff(): void {
    if (this.scope.isDisposed) return;
    if (this.resumeInFlight) {
      this.resumeRequested = true;
      return;
    }

    this.resumeInFlight = resumePendingHandoff(this.scope)
      .then((result) => {
        if (this.scope.isDisposed) return;
        if (result === 'ready') showHandoffToast(this.scope, this.copy.ready);
        else if (result === 'delivery-failed') {
          showHandoffToast(this.scope, this.copy.deliveryFailed, 'error');
        } else if (result === 'account-mismatch') {
          showHandoffToast(this.scope, this.copy.accountChanged, 'error');
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        logger.error('ChatGPT temporary handoff resume failed', { error: String(error) });
      })
      .finally(() => {
        this.resumeInFlight = null;
        if (!this.resumeRequested) return;
        this.resumeRequested = false;
        this.tryResumePendingHandoff();
      });
  }
}

export async function activateChatGptTemporaryHandoff(
  scope: PluginScope,
  _settings: PluginSettings = {},
): Promise<void> {
  const language = await getCurrentLanguage();
  if (scope.isDisposed) return;
  new ChatGptTemporaryHandoffPlugin(scope, getTemporaryHandoffCopy(language), language).start();
}
