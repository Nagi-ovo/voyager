import { type Dispose, PluginScope } from '@/features/plugins/runtime/pluginScope';

const TOOLTIP_DELAY_MS = 160;
const LONG_PRESS_MS = 550;

/** Owns marker hover and long-press interactions, including their delayed work. */
export class ChatGptTimelineMarkerInteractions {
  private element: HTMLElement | null = null;
  private stopTimer: Dispose | null = null;
  private stopLongPressTimer: Dispose | null = null;
  private longPressDot: HTMLButtonElement | null = null;
  suppressClickUntil = 0;

  constructor(
    private readonly scope: PluginScope,
    private readonly textForTurn: (turnId: string) => string | null,
    private readonly toggleStar: (turnId: string) => Promise<void>,
  ) {
    scope.effect(
      () => () => {
        this.hide();
        this.cancelLongPress();
      },
      'chatgpt-timeline-tooltip',
    );
  }

  startLongPress(dot: HTMLButtonElement): void {
    this.cancelLongPress();
    if (this.scope.isDisposed) return;
    this.longPressDot = dot;
    dot.classList.add('holding');
    this.stopLongPressTimer = this.scope.timer(() => {
      this.stopLongPressTimer = null;
      this.suppressClickUntil = Date.now() + 350;
      const id = dot.dataset.targetTurnId;
      if (id && dot.isConnected) void this.toggleStar(id);
      this.cancelLongPress();
    }, LONG_PRESS_MS);
  }

  cancelLongPress(): void {
    void this.stopLongPressTimer?.();
    this.stopLongPressTimer = null;
    this.longPressDot?.classList.remove('holding');
    this.longPressDot = null;
  }

  mount(): void {
    if (this.element || this.scope.isDisposed) return;
    const tooltip = document.createElement('div');
    tooltip.id = 'gv-chatgpt-timeline-tooltip';
    tooltip.className = 'timeline-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.setAttribute('aria-hidden', 'true');
    this.scope.mount(tooltip, document.body);
    this.element = tooltip;
  }

  schedule(dot: HTMLButtonElement): void {
    this.hide();
    if (this.scope.isDisposed || !this.textForTurn(dot.dataset.targetTurnId ?? '')) return;
    this.stopTimer = this.scope.timer(() => {
      this.stopTimer = null;
      this.show(dot);
    }, TOOLTIP_DELAY_MS);
  }

  show(dot: HTMLButtonElement): void {
    const tooltip = this.element;
    if (this.scope.isDisposed || !tooltip || !dot.isConnected) return;
    const text = this.textForTurn(dot.dataset.targetTurnId ?? '');
    if (!text) return;
    tooltip.textContent = text;
    tooltip.setAttribute('dir', 'auto');
    tooltip.setAttribute('aria-hidden', 'false');
    tooltip.style.width = 'min(288px, calc(100vw - 32px))';
    const rect = dot.getBoundingClientRect();
    const width = tooltip.offsetWidth || 288;
    const height = tooltip.offsetHeight || 78;
    const leftPlacement = rect.left > window.innerWidth / 2;
    const left = leftPlacement ? rect.left - 18 - width : rect.right + 18;
    const top = Math.max(
      8,
      Math.min(window.innerHeight - height - 8, rect.top + rect.height / 2 - height / 2),
    );
    tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, left))}px`;
    tooltip.style.top = `${Math.round(top)}px`;
    tooltip.dataset.placement = leftPlacement ? 'left' : 'right';
    tooltip.classList.add('visible');
  }

  hide(): void {
    void this.stopTimer?.();
    this.stopTimer = null;
    this.element?.classList.remove('visible');
    this.element?.setAttribute('aria-hidden', 'true');
  }
}
