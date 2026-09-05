import {
  HIGHLIGHT_COLORS,
  type HighlightRecordV1,
  getHighlightColorHex,
  isHighlightPresetColor,
} from '@/core/types/highlight';

import { findScrollableAncestor, isVisibleHighlightMark } from './dom';
import { translateWith } from './messages';

export class HighlightTimelineMarkers {
  private readonly ticks = new Map<string, HTMLButtonElement>();
  private timelineStyleObserver: MutationObserver | null = null;
  private observedTimelineBar: HTMLElement | null = null;
  private timelineRaf: number | null = null;
  private enabled = true;
  private destroyed = false;
  private readonly onViewportChange = (): void => this.scheduleTimelineSync();

  constructor(
    private readonly records: ReadonlyMap<string, HighlightRecordV1>,
    private readonly marks: ReadonlyMap<string, readonly HTMLElement[]>,
    private readonly onNavigate: (id: string) => void,
  ) {}

  start(): void {
    window.addEventListener('resize', this.onViewportChange, { passive: true });
    document.addEventListener('scroll', this.onViewportChange, { capture: true, passive: true });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.render();
  }

  clear(): void {
    this.ticks.forEach((tick) => tick.remove());
    this.ticks.clear();
  }

  render(): void {
    if (this.destroyed) return;
    if (!this.enabled) {
      this.clear();
      return;
    }
    const bar = document.querySelector<HTMLElement>('.gemini-timeline-bar');
    const trackContent = bar?.querySelector<HTMLElement>('.timeline-track-content');
    if (!bar || !trackContent) {
      this.timelineStyleObserver?.disconnect();
      this.observedTimelineBar = null;
      this.clear();
      return;
    }
    this.observeTimelineStyle(bar);
    const compact = bar.classList.contains('timeline-style-compact');
    const parent = compact ? bar : trackContent;

    for (const [id, record] of this.records) {
      const mark = this.marks.get(id)?.find(isVisibleHighlightMark);
      if (!mark) {
        this.ticks.get(id)?.remove();
        this.ticks.delete(id);
        continue;
      }

      let tick = this.ticks.get(id);
      if (!tick || !tick.isConnected || tick.parentElement !== parent) {
        tick?.remove();
        tick = document.createElement('button');
        tick.type = 'button';
        tick.className = 'gv-highlight-timeline-tick';
        tick.dataset.gvHighlightId = id;
        tick.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.onNavigate(id);
        });
        parent.appendChild(tick);
        this.ticks.set(id, tick);
      }
      HIGHLIGHT_COLORS.forEach((color) =>
        tick!.classList.remove(`gv-highlight-timeline-tick-${color}`),
      );
      tick.style.removeProperty('background-color');
      if (isHighlightPresetColor(record.color)) {
        tick.classList.add(`gv-highlight-timeline-tick-${record.color}`);
      } else {
        tick.style.backgroundColor = getHighlightColorHex(record.color);
      }
      tick.setAttribute(
        'aria-label',
        translateWith('highlightTimelineAriaLabel', 'Go to highlight: {text}', {
          text: record.anchor.quote.exact.slice(0, 120),
        }),
      );
      tick.title = record.anchor.quote.exact.replace(/\s+/g, ' ').trim().slice(0, 160);
      this.positionTimelineTick(tick, mark, parent, compact);
    }

    for (const [id, tick] of this.ticks) {
      if (this.records.has(id) && this.marks.has(id)) continue;
      tick.remove();
      this.ticks.delete(id);
    }
  }

  private observeTimelineStyle(bar: HTMLElement): void {
    if (this.observedTimelineBar === bar) return;
    this.timelineStyleObserver?.disconnect();
    this.observedTimelineBar = bar;
    this.timelineStyleObserver = new MutationObserver(() => this.render());
    this.timelineStyleObserver.observe(bar, { attributes: true, attributeFilter: ['class'] });
  }

  private positionTimelineTick(
    tick: HTMLButtonElement,
    mark: HTMLElement,
    parent: HTMLElement,
    compact: boolean,
  ): void {
    const scrollContainer = findScrollableAncestor(mark);
    const containerRect = scrollContainer.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    const absoluteTop = scrollContainer.scrollTop + markRect.top - containerRect.top;
    const scrollHeight = Math.max(1, scrollContainer.scrollHeight);
    const ratio = Math.max(0, Math.min(1, absoluteTop / scrollHeight));
    const targetHeight = compact
      ? Math.max(1, parent.clientHeight)
      : Math.max(1, parent.scrollHeight || parent.clientHeight);
    tick.style.top = `${Math.round(ratio * targetHeight)}px`;
  }

  private scheduleTimelineSync(): void {
    if (this.timelineRaf !== null || this.destroyed) return;
    this.timelineRaf = requestAnimationFrame(() => {
      this.timelineRaf = null;
      this.render();
    });
  }

  destroy(): void {
    this.destroyed = true;
    window.removeEventListener('resize', this.onViewportChange);
    document.removeEventListener('scroll', this.onViewportChange, true);
    this.timelineStyleObserver?.disconnect();
    this.timelineStyleObserver = null;
    this.observedTimelineBar = null;
    if (this.timelineRaf !== null) cancelAnimationFrame(this.timelineRaf);
    this.timelineRaf = null;
    this.clear();
  }
}
