import type { TimelineStyle } from '@/core/types/common';

import type { DotElement } from './types';

export interface TimelineTooltipContent {
  text: string;
  summary: string;
  assistantSummary: string;
  starred: boolean;
}

interface TimelineTooltipOptions {
  getContext(): { style: TimelineStyle; previewOpen: boolean };
  getContent(dot: DotElement): TimelineTooltipContent;
}

/** Owns the timeline preview surface, hover intent, and measured placement. */
export class TimelineTooltip {
  private element: HTMLElement | null;
  private measureEl: HTMLElement | null;
  private readonly tooltipShowDelay = 250;
  private readonly tooltipHideDelay = 100;
  private tooltipHideTimer: number | null = null;
  private tooltipShowTimer: number | null = null;
  private tooltipPendingDot: DotElement | null = null;
  private tooltipDotId: string | null = null;
  private showRafId: number | null = null;

  constructor(
    private readonly bar: HTMLElement,
    private readonly options: TimelineTooltipOptions,
  ) {
    const tip = document.createElement('div');
    tip.className = 'timeline-tooltip';
    tip.id = 'gemini-timeline-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('dir', 'auto');
    document.body.appendChild(tip);
    this.element = tip;

    const measure = document.createElement('div');
    measure.setAttribute('aria-hidden', 'true');
    measure.setAttribute('dir', 'auto');
    Object.assign(measure.style, {
      position: 'fixed',
      left: '-9999px',
      top: '0',
      visibility: 'hidden',
      pointerEvents: 'none',
    });
    const style = getComputedStyle(tip);
    Object.assign(measure.style, {
      backgroundColor: style.backgroundColor,
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      padding: style.padding,
      border: style.border,
      borderRadius: style.borderRadius,
      whiteSpace: 'pre-line',
      wordBreak: 'break-word',
      maxWidth: 'none',
      display: 'block',
    });
    document.body.appendChild(measure);
    this.measureEl = measure;
  }

  refreshCurrent(): void {
    if (!this.element?.classList.contains('visible')) return;
    const dot = this.bar.querySelector<DotElement>('.timeline-dot:hover, .timeline-dot:focus');
    if (dot) this.refresh(dot);
  }

  destroy(): void {
    this.cancelPending();
    if (this.tooltipHideTimer !== null) clearTimeout(this.tooltipHideTimer);
    this.tooltipHideTimer = null;
    if (this.showRafId !== null) cancelAnimationFrame(this.showRafId);
    this.showRafId = null;
    this.element?.remove();
    this.measureEl?.remove();
    this.element = null;
    this.measureEl = null;
  }

  private getCSSVarNumber(el: Element, name: string, fallback: number): number {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  private truncateToThreeLines(
    text: string,
    targetWidth: number,
  ): { text: string; height: number } {
    if (!this.measureEl || !this.element) return { text, height: 0 };
    const tip = this.element;
    const lineH = this.getCSSVarNumber(tip, '--timeline-tooltip-lh', 18);
    const padY = this.getCSSVarNumber(tip, '--timeline-tooltip-pad-y', 10);
    const borderW = this.getCSSVarNumber(tip, '--timeline-tooltip-border-w', 1);
    const maxH = Math.round(3 * lineH + 2 * padY + 2 * borderW);
    const ell = '…';
    const el = this.measureEl;
    el.style.width = `${Math.max(0, Math.floor(targetWidth))}px`;
    const normalized = String(text || '')
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .trim();
    el.textContent = normalized;
    let h = el.offsetHeight;
    if (h <= maxH) return { text: el.textContent, height: h };
    const raw = el.textContent;
    let lo = 0,
      hi = raw.length,
      ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      el.textContent = raw.slice(0, mid).trimEnd() + ell;
      h = el.offsetHeight;
      if (h <= maxH) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const out = ans >= raw.length ? raw : raw.slice(0, ans).trimEnd() + ell;
    el.textContent = out;
    h = el.offsetHeight;
    return { text: out, height: Math.min(h, maxH) };
  }

  private computePlacementInfo(dot: HTMLElement): { placement: 'left' | 'right'; width: number } {
    const tip = this.element || document.body;
    const dotRect = dot.getBoundingClientRect();
    const vw = window.innerWidth;
    const arrowOut = this.getCSSVarNumber(tip, '--timeline-tooltip-arrow-outside', 6);
    const baseGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-visual', 12);
    const boxGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-box', 8);
    const gap = baseGap + Math.max(0, arrowOut) + Math.max(0, boxGap);
    const viewportPad = 8;
    const maxW = this.getCSSVarNumber(tip, '--timeline-tooltip-max', 288);
    const minW = 160;
    const leftAvail = Math.max(0, dotRect.left - gap - viewportPad);
    const rightAvail = Math.max(0, vw - dotRect.right - gap - viewportPad);
    let placement: 'left' | 'right' = rightAvail > leftAvail ? 'right' : 'left';
    let avail = placement === 'right' ? rightAvail : leftAvail;
    const tiers =
      this.options.getContext().style === 'ruler'
        ? [320, 280, 240, 200, 160]
        : [280, 240, 200, 160];
    const hardMax = Math.max(minW, Math.min(maxW, Math.floor(avail)));
    let width = tiers.find((t) => t <= hardMax) || Math.max(minW, Math.min(hardMax, 160));
    if (width < minW && placement === 'left' && rightAvail > leftAvail) {
      placement = 'right';
      avail = rightAvail;
      const hardMax2 = Math.max(minW, Math.min(maxW, Math.floor(avail)));
      width = tiers.find((t) => t <= hardMax2) || Math.max(120, Math.min(hardMax2, minW));
    } else if (width < minW && placement === 'right' && leftAvail >= rightAvail) {
      placement = 'left';
      avail = leftAvail;
      const hardMax2 = Math.max(minW, Math.min(maxW, Math.floor(avail)));
      width = tiers.find((t) => t <= hardMax2) || Math.max(120, Math.min(hardMax2, minW));
    }
    width = Math.max(120, Math.min(width, maxW));
    return { placement, width };
  }

  show(dot: DotElement): void {
    if (!this.element) return;
    if (this.options.getContext().previewOpen) return;
    this.cancelPending();
    if (this.tooltipHideTimer) {
      clearTimeout(this.tooltipHideTimer);
      this.tooltipHideTimer = null;
    }
    const tip = this.element;
    tip.setAttribute('dir', 'auto');
    tip.classList.toggle('gv-timeline-ruler-tooltip', this.options.getContext().style === 'ruler');
    const dotId = dot.dataset.targetTurnId || '';
    if (tip.classList.contains('visible') && this.tooltipDotId === dotId) {
      this.refresh(dot);
      return;
    }
    this.tooltipDotId = dotId;
    tip.classList.remove('visible');
    const p = this.computePlacementInfo(dot);
    const height = this.renderTooltipContent(dot, p.width);
    this.placeTooltipAt(dot, p.placement, p.width, height);
    tip.setAttribute('aria-hidden', 'false');
    if (this.showRafId !== null) {
      cancelAnimationFrame(this.showRafId);
      this.showRafId = null;
    }
    this.showRafId = requestAnimationFrame(() => {
      this.showRafId = null;
      tip.classList.add('visible');
    });
  }

  schedule(dot: DotElement): void {
    if (!this.element) return;
    if (this.options.getContext().previewOpen) return;

    // Ruler ticks are a dense, precision-hover control. Delaying their preview
    // makes a successful hit feel missed, so only the roomier node style keeps
    // the hover-intent guard.
    if (this.options.getContext().style === 'ruler') {
      this.show(dot);
      return;
    }

    const dotId = dot.dataset.targetTurnId || '';
    if (this.element.classList.contains('visible') && this.tooltipDotId === dotId) {
      this.show(dot);
      return;
    }

    if (this.tooltipShowTimer !== null && this.tooltipPendingDot === dot) return;

    this.cancelPending();
    this.tooltipPendingDot = dot;
    this.tooltipShowTimer = window.setTimeout(() => {
      const pendingDot = this.tooltipPendingDot;
      this.tooltipShowTimer = null;
      this.tooltipPendingDot = null;

      if (!pendingDot?.isConnected) return;
      this.show(pendingDot);
    }, this.tooltipShowDelay);
  }

  cancelPending(): void {
    if (this.tooltipShowTimer !== null) {
      clearTimeout(this.tooltipShowTimer);
      this.tooltipShowTimer = null;
    }
    this.tooltipPendingDot = null;
  }

  private placeTooltipAt(
    dot: HTMLElement,
    placement: 'left' | 'right',
    width: number,
    height: number,
  ): void {
    if (!this.element) return;
    const tip = this.element;
    const dotRect = dot.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const arrowOut = this.getCSSVarNumber(tip, '--timeline-tooltip-arrow-outside', 6);
    const baseGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-visual', 12);
    const boxGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-box', 8);
    const gap = baseGap + Math.max(0, arrowOut) + Math.max(0, boxGap);
    const viewportPad = 8;
    let left: number;
    if (placement === 'left') {
      left = Math.round(dotRect.left - gap - width);
      if (left < viewportPad) {
        const altLeft = Math.round(dotRect.right + gap);
        if (altLeft + width <= vw - viewportPad) {
          placement = 'right';
          left = altLeft;
        } else {
          const fitWidth = Math.max(120, vw - viewportPad - altLeft);
          left = altLeft;
          width = fitWidth;
        }
      }
    } else {
      left = Math.round(dotRect.right + gap);
      if (left + width > vw - viewportPad) {
        const altLeft = Math.round(dotRect.left - gap - width);
        if (altLeft >= viewportPad) {
          placement = 'left';
          left = altLeft;
        } else {
          const fitWidth = Math.max(120, vw - viewportPad - left);
          width = fitWidth;
        }
      }
    }
    // Set width first, let height auto-size to text
    tip.style.width = `${Math.floor(width)}px`;
    // If height not provided, measure after width + content set
    const autoH = !height || height <= 0 ? tip.offsetHeight : height;
    let top = Math.round(dotRect.top + dotRect.height / 2 - autoH / 2);
    top = Math.max(viewportPad, Math.min(vh - height - viewportPad, top));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.setAttribute('data-placement', placement);
  }

  refresh(dot: DotElement): void {
    if (!this.element) return;
    const tip = this.element;
    tip.setAttribute('dir', 'auto');
    if (!tip.classList.contains('visible')) return;
    tip.classList.toggle('gv-timeline-ruler-tooltip', this.options.getContext().style === 'ruler');
    const p = this.computePlacementInfo(dot);
    const height = this.renderTooltipContent(dot, p.width);
    this.placeTooltipAt(dot, p.placement, p.width, height);
  }

  private renderTooltipContent(dot: DotElement, width: number): number {
    const tip = this.element;
    if (!tip) return 0;

    const content = this.options.getContent(dot);
    if (this.options.getContext().style !== 'ruler') {
      tip.removeAttribute('aria-label');
      const fullText = content.text;
      const layout = this.truncateToThreeLines(fullText, width);
      tip.textContent = layout.text;
      return layout.height;
    }

    const id = dot.dataset.targetTurnId || '';
    const userText = content.summary || (dot.getAttribute('aria-label') || '').trim();
    const prompt = document.createElement('div');
    prompt.className = 'gv-timeline-ruler-prompt';
    prompt.setAttribute('dir', 'auto');
    prompt.textContent = id && content.starred ? `★ ${userText}` : userText;

    const children: HTMLElement[] = [prompt];
    const assistantText = content.assistantSummary.trim();
    if (assistantText) {
      const response = document.createElement('div');
      response.className = 'gv-timeline-ruler-response';
      response.setAttribute('dir', 'auto');
      response.textContent = assistantText;
      children.push(response);
    }

    tip.replaceChildren(...children);
    tip.setAttribute('aria-label', [prompt.textContent, assistantText].filter(Boolean).join('\n'));
    tip.style.width = `${Math.floor(width)}px`;
    return tip.offsetHeight || (assistantText ? 70 : 42);
  }

  hide(immediate = false): void {
    if (!this.element) return;
    this.cancelPending();
    if (this.showRafId !== null) cancelAnimationFrame(this.showRafId);
    this.showRafId = null;
    if (this.tooltipHideTimer !== null) clearTimeout(this.tooltipHideTimer);
    this.tooltipHideTimer = null;
    const doHide = () => {
      this.element!.classList.remove('visible');
      this.element!.setAttribute('aria-hidden', 'true');
      this.tooltipDotId = null;
      this.tooltipHideTimer = null;
    };
    if (immediate) return doHide();
    this.tooltipHideTimer = window.setTimeout(doHide, this.tooltipHideDelay);
  }
}
