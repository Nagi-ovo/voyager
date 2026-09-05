import { type TimelineStyle } from '@/core/types/common';
import { applyRTLClass } from '@/core/utils/rtl';

import { getTimelineSpringProfile } from './TimelineNavigation';
import { TimelinePreviewPanel } from './TimelinePreviewPanel';
import type { TimelineState } from './TimelineState';
import type { ExtGlobal, TimelinePositionData } from './types';
import type { DotElement } from './types';
interface TimelineViewOptions {
  getViewport: () => HTMLElement | null;
  getActiveId: () => string | null;
  navigate: (turnId: string, index: number) => void;
  search: (query: string) => void;
  onStyleChange: () => void;
  onResize: () => void;
}
/** Owns the timeline rail, rendered dots, slider and their pointer/resize lifetimes. */
export class TimelineView {
  ui: {
    timelineBar: HTMLElement | null;
    track?: HTMLElement | null;
    trackContent?: HTMLElement | null;
    slider?: HTMLElement | null;
    sliderHandle?: HTMLElement | null;
  } = { timelineBar: null };

  timelineStyle: TimelineStyle = 'dots';

  hideContainer: boolean = false;

  barWidth: number = 4;

  readonly barWidthMin = 4;

  readonly barWidthMax = 24;

  private resizing = false;

  private onResizeMove: ((ev: PointerEvent) => void) | null = null;

  private onResizeUp: ((ev: PointerEvent) => void) | null = null;

  private runnerRing: HTMLElement | null = null;

  private runnerAnimationGeneration = 0;

  private contentHeight = 0;

  yPositions: number[] = [];

  markerTops: number[] = [];

  private visibleRange: { start: number; end: number } = { start: 0, end: -1 };

  firstUserTurnOffset = 0;

  contentSpanPx = 1;

  private usePixelTop = false;

  private _cssVarTopSupported: boolean | null = null;

  private sliderDragging = false;

  private sliderFadeTimer: number | null = null;

  private sliderFadeDelay = 1000;

  private sliderAlwaysVisible = false;

  private onSliderMove: ((ev: PointerEvent) => void) | null = null;

  private onSliderUp: ((ev: PointerEvent) => void) | null = null;

  private sliderStartClientY = 0;

  private sliderStartTop = 0;

  private sliderMaxTop = 0;

  private sliderScrollRange = 1;

  private resizeIdleTimer: number | null = null;

  private resizeIdleDelay = 140;

  savedTimelinePosition: TimelinePositionData | null = null;

  private draggable = false;

  private barDragging = false;

  private barStartPos = { x: 0, y: 0 };

  private barStartOffset = { x: 0, y: 0 };

  private onBarPointerMove: ((ev: PointerEvent) => void) | null = null;

  private onBarPointerUp: ((ev: PointerEvent) => void) | null = null;

  previewPanel: TimelinePreviewPanel | null = null;

  rtl = false;
  private readonly dots = new Map<string, DotElement>();
  private normalizedPositions: number[] = [];
  private destroyed = false;
  private runnerRaf: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly lifetime = new AbortController();
  constructor(
    private readonly state: TimelineState,
    private readonly options: TimelineViewOptions,
  ) {}
  private get markers() {
    return this.state.markers;
  }
  private get scrollContainer() {
    return this.options.getViewport();
  }
  private get activeTurnId() {
    return this.options.getActiveId();
  }
  private getActiveIndex() {
    return this.markers.findIndex((marker) => marker.id === this.activeTurnId);
  }
  mount(): void {
    if (this.destroyed) return;
    let bar = document.querySelector('.gemini-timeline-bar') as HTMLElement | null;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'gemini-timeline-bar';
      document.body.appendChild(bar);
    }
    this.ui.timelineBar = bar;
    let track = bar.querySelector('.timeline-track') as HTMLElement | null;
    if (!track) {
      track = document.createElement('div');
      track.className = 'timeline-track';
      bar.appendChild(track);
    }
    let content = track.querySelector('.timeline-track-content') as HTMLElement | null;
    if (!content) {
      content = document.createElement('div');
      content.className = 'timeline-track-content';
      track.appendChild(content);
    }
    this.ui.track = track;
    this.ui.trackContent = content;

    let slider = document.querySelector('.timeline-left-slider') as HTMLElement | null;
    if (!slider) {
      slider = document.createElement('div');
      slider.className = 'timeline-left-slider';
      const handle = document.createElement('div');
      handle.className = 'timeline-left-handle';
      slider.appendChild(handle);
      document.body.appendChild(slider);
    }
    this.ui.slider = slider;
    this.ui.sliderHandle = slider.querySelector('.timeline-left-handle') as HTMLElement | null;

    this.previewPanel = new TimelinePreviewPanel(bar);
    this.previewPanel.init(this.options.navigate, this.options.search, (id) =>
      this.state.toggleStar(id),
    );
    this.setupEventListeners();
    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(bar);
  }
  render(): void {
    if (this.destroyed) return;
    this.updateTimelineGeometry();
    this.syncTimelineTrackToMain();
    this.updateVirtualRangeAndRender();
    this.updateSlider();
  }
  updateActiveDotUI(): void {
    for (const [id, dot] of this.dots) dot.classList.toggle('active', id === this.activeTurnId);
    this.previewPanel?.updateActiveTurn(this.activeTurnId);
  }
  updatePreviewMarkers(): void {
    this.previewPanel?.updateMarkers(
      this.markers.map((marker, index) => ({
        id: marker.id,
        summary: marker.summary,
        index,
        starred: marker.starred,
      })),
    );
  }
  updateVirtualRangeAndRender(): void {
    if (!this.ui.track || !this.ui.trackContent) return;
    const hidden = this.state.getHiddenMarkerIndices();
    const dense = this.timelineStyle !== 'dots';
    const top = this.ui.track.scrollTop;
    const height = this.ui.track.clientHeight;
    const buffer = Math.max(100, height);
    const start = dense ? 0 : this.lowerBound(this.yPositions, top - buffer);
    const end = dense
      ? this.markers.length - 1
      : Math.max(start - 1, this.upperBound(this.yPositions, top + height + buffer));
    const offsets = dense ? this.buildCompactMarkerOffsets(hidden) : new Map<number, number>();
    const visibleIds = new Set<string>();
    const fragment = document.createDocumentFragment();
    for (let index = start; index <= end; index++) {
      const marker = this.markers[index];
      if (!marker || hidden.has(index)) continue;
      visibleIds.add(marker.id);
      let dot = this.dots.get(marker.id);
      if (!dot) {
        dot = document.createElement('button') as DotElement;
        dot.className = 'timeline-dot';
        dot.dataset.targetTurnId = marker.id;
        dot.setAttribute('tabindex', '0');
        dot.setAttribute('aria-describedby', 'gemini-timeline-tooltip');
        this.dots.set(marker.id, dot);
        fragment.appendChild(dot);
      }
      dot.dataset.markerIndex = String(index);
      dot.setAttribute('aria-label', marker.summary);
      this.applyDotPosition(dot, index, offsets.get(index));
      const collapsed = this.state.isMarkerCollapsed(marker.id);
      dot.classList.toggle('active', marker.id === this.activeTurnId);
      dot.classList.toggle('starred', marker.starred);
      dot.classList.toggle('collapsed', collapsed);
      dot.setAttribute('aria-pressed', String(marker.starred));
      dot.setAttribute('aria-expanded', String(!collapsed));
      dot.dataset.level = String(this.state.getMarkerLevel(marker.id));
    }
    for (const [id, dot] of this.dots) {
      if (visibleIds.has(id)) continue;
      dot.remove();
      this.dots.delete(id);
    }
    this.ui.trackContent.appendChild(fragment);
    this.visibleRange = { start, end };
    this.updateRulerWave();
  }
  private setupEventListeners(): void {
    const signal = this.lifetime.signal;
    this.ui.timelineBar!.addEventListener(
      'wheel',
      (event) => {
        if (this.scrollContainer) this.scrollContainer.scrollTop += event.deltaY;
        this.showSlider();
        event.preventDefault();
      },
      { passive: false, signal },
    );
    // Both resize sources funnel through one trailing debounce so a resize
    // burst runs geometry/layout work only once per idle window.
    const onWindowResize = () => this.scheduleResizeWork();
    window.addEventListener('resize', onWindowResize, { signal: this.lifetime.signal });
    if (window.visualViewport) {
      const onVisualViewportResize = () => this.scheduleResizeWork();
      window.visualViewport.addEventListener('resize', onVisualViewportResize, {
        signal: this.lifetime.signal,
      });
    }

    const onSliderDown = (ev: PointerEvent) => {
      if (!this.ui.sliderHandle) return;
      try {
        this.ui.sliderHandle.setPointerCapture(ev.pointerId);
      } catch {}
      this.sliderDragging = true;
      this.showSlider();
      this.sliderStartClientY = ev.clientY;
      const rect = this.ui.sliderHandle.getBoundingClientRect();
      this.sliderStartTop = rect.top;
      this.onSliderMove = (e: PointerEvent) => this.handleSliderDrag(e);
      this.onSliderUp = (e: PointerEvent) => this.endSliderDrag(e);
      window.addEventListener('pointermove', this.onSliderMove, { signal: this.lifetime.signal });
      // pointercancel must end the drag too, otherwise sliderDragging stays
      // true forever and syncTimelineTrackToMain() short-circuits.
      window.addEventListener('pointerup', this.onSliderUp, { signal: this.lifetime.signal });
      window.addEventListener('pointercancel', this.onSliderUp, { signal: this.lifetime.signal });
    };
    this.ui.sliderHandle?.addEventListener('pointerdown', onSliderDown, {
      signal: this.lifetime.signal,
    });

    const onBarEnter = () => this.showSlider();
    const onBarLeave = () => this.hideSliderDeferred();
    const onSliderEnter = () => this.showSlider();
    const onSliderLeave = () => this.hideSliderDeferred();
    this.ui.timelineBar!.addEventListener('pointerenter', onBarEnter, {
      signal: this.lifetime.signal,
    });
    this.ui.timelineBar!.addEventListener('pointerleave', onBarLeave, {
      signal: this.lifetime.signal,
    });
    this.ui.slider?.addEventListener('pointerenter', onSliderEnter, {
      signal: this.lifetime.signal,
    });
    this.ui.slider?.addEventListener('pointerleave', onSliderLeave, {
      signal: this.lifetime.signal,
    });

    const onBarPointerDown = (ev: PointerEvent) => {
      if ((ev.target as HTMLElement).closest('.timeline-dot, .timeline-thumb')) {
        return;
      }
      // Resize takes priority over position drag
      if (this.isInResizeEdge(ev)) {
        this.startResize(ev);
        return;
      }
      // Position drag only when enabled
      if (!this.draggable) return;
      this.barDragging = true;
      this.barStartPos = { x: ev.clientX, y: ev.clientY };
      const rect = this.ui.timelineBar!.getBoundingClientRect();
      this.barStartOffset = { x: rect.left, y: rect.top };
      this.ui.timelineBar!.setPointerCapture(ev.pointerId);
      this.onBarPointerMove = (e: PointerEvent) => this.handleBarDrag(e);
      this.onBarPointerUp = (e: PointerEvent) => this.endBarDrag(e);
      window.addEventListener('pointermove', this.onBarPointerMove, {
        signal: this.lifetime.signal,
      });
      // pointercancel shares the pointerup path so a cancelled touch drag
      // cannot leave barDragging stuck true.
      window.addEventListener('pointerup', this.onBarPointerUp, { signal: this.lifetime.signal });
      window.addEventListener('pointercancel', this.onBarPointerUp, {
        signal: this.lifetime.signal,
      });
    };
    // Always attach pointerdown for resize (drag is gated by this.draggable inside)
    this.ui.timelineBar!.addEventListener('pointerdown', onBarPointerDown, {
      signal: this.lifetime.signal,
    });

    // Cursor management: show resize cursor near inner edge
    const onBarCursorMove = (ev: PointerEvent) => {
      if (this.resizing || this.barDragging) return;
      if (this.isInResizeEdge(ev)) {
        this.ui.timelineBar!.style.cursor = 'ew-resize';
      } else if (this.draggable) {
        this.ui.timelineBar!.style.cursor = 'move';
      } else {
        this.ui.timelineBar!.style.cursor = '';
      }
    };
    this.ui.timelineBar!.addEventListener('pointermove', onBarCursorMove, {
      signal: this.lifetime.signal,
    });
  }
  destroy(): void {
    this.destroyed = true;

    this.lifetime.abort();
    this.resizeObserver?.disconnect();
    if (this.runnerRaf !== null) cancelAnimationFrame(this.runnerRaf);
    if (this.resizeIdleTimer !== null) clearTimeout(this.resizeIdleTimer);
    if (this.sliderFadeTimer !== null) clearTimeout(this.sliderFadeTimer);
    this.previewPanel?.destroy();
    this.previewPanel = null;
    this.ui.slider?.remove();
    this.ui.timelineBar?.remove();
    this.ui = { timelineBar: null };
    this.dots.clear();
  }
  applyContainerVisibility(): void {
    if (!this.ui.timelineBar) return;
    const bar = this.ui.timelineBar;
    // Visual background width (::before is centered, bar stays 24px for dots)
    bar.style.setProperty('--timeline-bar-width', `${this.barWidth}px`);
    // hideContainer is an independent binary toggle
    bar.classList.toggle('timeline-no-container', !!this.hideContainer);
  }

  applyTimelineStyle(): void {
    const bar = this.ui.timelineBar;
    if (!bar) return;
    const compact = this.timelineStyle === 'compact';
    const ruler = this.timelineStyle === 'ruler';
    const dense = compact || ruler;
    bar.classList.toggle('timeline-style-compact', compact);
    bar.classList.toggle('gv-timeline-style-ruler', ruler);
    this.updateRulerDirection();
    this.ui.slider?.classList.toggle('timeline-style-compact', dense);
    this.options.onStyleChange();
    if (dense) {
      if (this.ui.track) this.ui.track.scrollTop = 0;
    }
    if (compact) {
      this.ui.track?.setAttribute('aria-hidden', 'true');
    } else {
      this.ui.track?.removeAttribute('aria-hidden');
      if (!ruler) this.syncTimelineTrackToMain();
    }
    this.previewPanel?.setCompactMode(compact);
    this.previewPanel?.setFloatingToggleSuppressed(ruler);
    this.updateVirtualRangeAndRender();
    this.updateSlider();
  }

  /** Check if pointer is near either edge of the visual background (::before, centered in the 24px bar). */
  private isInResizeEdge(ev: PointerEvent): boolean {
    if (this.timelineStyle !== 'dots') return false;
    if (!this.ui.timelineBar) return false;
    const rect = this.ui.timelineBar.getBoundingClientRect();
    const barCenter = rect.left + rect.width / 2;
    const halfWidth = this.barWidth / 2;
    const ZONE = 6;

    const leftEdge = barCenter - halfWidth;
    const rightEdge = barCenter + halfWidth;
    const nearLeft = ev.clientX >= leftEdge - 2 && ev.clientX <= leftEdge + ZONE;
    const nearRight = ev.clientX >= rightEdge - ZONE && ev.clientX <= rightEdge + 2;
    return nearLeft || nearRight;
  }

  private startResize(ev: PointerEvent): void {
    this.resizing = true;
    this.ui.timelineBar!.classList.add('timeline-resizing');
    this.ui.timelineBar!.setPointerCapture(ev.pointerId);
    const barRect = this.ui.timelineBar!.getBoundingClientRect();
    const barCenterX = barRect.left + barRect.width / 2;

    this.onResizeMove = (e: PointerEvent) => {
      // Width = 2 × distance from pointer to bar center (symmetric expansion)
      const dist = Math.abs(e.clientX - barCenterX);
      this.barWidth = Math.max(this.barWidthMin, Math.min(this.barWidthMax, dist * 2));
      this.applyContainerVisibility();
    };

    this.onResizeUp = (_e: PointerEvent) => {
      this.resizing = false;
      this.ui.timelineBar?.classList.remove('timeline-resizing');
      window.removeEventListener('pointermove', this.onResizeMove!);
      window.removeEventListener('pointerup', this.onResizeUp!);
      window.removeEventListener('pointercancel', this.onResizeUp!);
      this.onResizeMove = null;
      this.onResizeUp = null;
      this.saveBarWidth();
    };

    window.addEventListener('pointermove', this.onResizeMove, { signal: this.lifetime.signal });
    // pointercancel shares the pointerup path so a cancelled touch drag
    // (e.g. browser gesture takeover) cannot leave `resizing` stuck true.
    window.addEventListener('pointerup', this.onResizeUp, { signal: this.lifetime.signal });
    window.addEventListener('pointercancel', this.onResizeUp, { signal: this.lifetime.signal });
    ev.preventDefault();
    ev.stopPropagation();
  }

  private saveBarWidth(): void {
    const g = globalThis as ExtGlobal;
    const value = Math.round(this.barWidth);
    if (g.chrome?.storage?.sync?.set) {
      g.chrome.storage.sync.set({ geminiTimelineBarWidth: value });
    } else if (g.browser?.storage?.sync?.set) {
      g.browser.storage.sync.set({ geminiTimelineBarWidth: value });
    }
  }

  private getCSSVarNumber(el: Element, name: string, fallback: number): number {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  private getTrackPadding(): number {
    return this.ui.timelineBar
      ? this.getCSSVarNumber(this.ui.timelineBar, '--timeline-track-padding', 12)
      : 12;
  }

  private getMinGap(): number {
    return this.ui.timelineBar
      ? this.getCSSVarNumber(this.ui.timelineBar, '--timeline-min-gap', 12)
      : 12;
  }

  private detectCssVarTopSupport(pad: number, usableC: number): boolean {
    try {
      const test = document.createElement('button');
      test.className = 'timeline-dot';
      test.style.visibility = 'hidden';
      test.setAttribute('aria-hidden', 'true');
      test.style.setProperty('--n', '0.5');
      this.ui.trackContent!.appendChild(test);
      const cs = getComputedStyle(test);
      const px = parseFloat(cs.top || '');
      test.remove();
      const expected = pad + 0.5 * usableC;
      return Number.isFinite(px) && Math.abs(px - expected) <= 2;
    } catch {
      return false;
    }
  }

  updateTimelineGeometry(): void {
    if (!this.ui.timelineBar || !this.ui.trackContent) return;
    const H = this.ui.timelineBar.clientHeight || 0;
    const pad = this.getTrackPadding();
    const minGap = this.getMinGap();
    const N = this.markers.length;
    // Get hidden markers for collapse feature
    const hiddenIndices = this.state.getHiddenMarkerIndices();
    const visibleCount = N - hiddenIndices.size;
    const desired = Math.max(
      H,
      visibleCount > 0 ? 2 * pad + Math.max(0, visibleCount - 1) * minGap : H,
    );
    this.contentHeight = Math.ceil(desired);
    this.ui.trackContent.style.height = `${this.contentHeight}px`;

    const usableC = Math.max(1, this.contentHeight - 2 * pad);
    // Calculate Y positions with collapse - using effective baseN for repositioning
    const { desiredY } = this.state.calculateCollapsedPositions(hiddenIndices, pad, usableC);

    // Apply min gap only to visible markers
    const gapMultipliers: number[] = new Array(N).fill(1.0);
    const adjusted = this.applyMinGapWithHidden(
      desiredY,
      pad,
      pad + usableC,
      minGap,
      hiddenIndices,
      gapMultipliers,
    );
    this.yPositions = adjusted;

    for (let i = 0; i < N; i++) {
      if (hiddenIndices.has(i)) {
        this.normalizedPositions[i] = -1;
        continue;
      }
      const top = adjusted[i];
      const n = (top - pad) / usableC;
      this.normalizedPositions[i] = Math.max(0, Math.min(1, n));
      const dot = this.dots.get(this.markers[i].id);
      if (dot && !this.usePixelTop) {
        dot.style.setProperty('--n', String(this.normalizedPositions[i]));
      }
    }
    if (this._cssVarTopSupported === null) {
      this._cssVarTopSupported = this.detectCssVarTopSupport(pad, usableC);
      this.usePixelTop = !this._cssVarTopSupported;
    }
    this.updateSlider();
    const barH = this.ui.timelineBar.clientHeight || 0;
    this.sliderAlwaysVisible = this.contentHeight > barH + 1;
    if (this.sliderAlwaysVisible) this.showSlider();
  }

  /* Apply minimum gap between visible markers, skipping hidden ones */
  private applyMinGapWithHidden(
    positions: number[],
    minTop: number,
    maxTop: number,
    gap: number,
    hiddenIndices: Set<number>,
    gapMultipliers: number[],
  ): number[] {
    const n = positions.length;
    if (n === 0) return positions;

    const out = positions.slice();
    let prevVisibleIdx = -1;
    for (let i = 0; i < n; i++) {
      if (hiddenIndices.has(i)) continue;

      if (prevVisibleIdx === -1) {
        out[i] = Math.max(minTop, Math.min(positions[i], maxTop));
      } else {
        const currentGap = gap * gapMultipliers[i];
        const minAllowed = out[prevVisibleIdx] + currentGap;
        out[i] = Math.max(positions[i], minAllowed);
      }
      prevVisibleIdx = i;
    }
    let lastVisibleIdx = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (!hiddenIndices.has(i)) {
        lastVisibleIdx = i;
        break;
      }
    }

    if (lastVisibleIdx >= 0 && out[lastVisibleIdx] > maxTop) {
      out[lastVisibleIdx] = maxTop;

      let nextVisibleIdx = lastVisibleIdx;
      for (let i = lastVisibleIdx - 1; i >= 0; i--) {
        if (hiddenIndices.has(i)) continue;

        const currentGap = gap * gapMultipliers[nextVisibleIdx];
        const maxAllowed = out[nextVisibleIdx] - currentGap;
        out[i] = Math.min(out[i], maxAllowed);
        nextVisibleIdx = i;
      }
    }

    // Clamp all visible markers
    for (let i = 0; i < n; i++) {
      if (hiddenIndices.has(i)) continue;
      if (out[i] < minTop) out[i] = minTop;
      if (out[i] > maxTop) out[i] = maxTop;
    }

    return out;
  }

  private ensureRunnerRing(): void {
    if (!this.ui.trackContent) return;
    if (!this.runnerRing) {
      const ring = document.createElement('div');
      ring.className = 'timeline-runner-ring';
      Object.assign(ring.style, {
        position: 'absolute',
        left: '50%',
        top: '0',
        width: '20px',
        height: '20px',
        transform: 'translate3d(-50%, -10px, 0)',
        borderRadius: '9999px',
        boxShadow: '0 0 0 2px var(--timeline-dot-active-color), 0 0 12px rgba(59,130,246,.45)',
        background: 'transparent',
        pointerEvents: 'none',
        zIndex: '4',
        opacity: '0',
        transition: 'opacity 120ms ease',
        willChange: 'transform, opacity',
      } as CSSStyleDeclaration);
      this.ui.trackContent.appendChild(ring);
      this.runnerRing = ring;
    }
  }

  startRunner(fromIdx: number, toIdx: number, duration: number): void {
    this.ensureRunnerRing();
    if (!this.runnerRing) return;
    if (this.runnerRaf !== null) cancelAnimationFrame(this.runnerRaf);
    const animationGeneration = ++this.runnerAnimationGeneration;
    const y1 = Math.round(this.yPositions[fromIdx]);
    const y2 = Math.round(this.yPositions[toIdx]);
    const spring = getTimelineSpringProfile();
    const t0 =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    this.runnerRing.style.opacity = '1';
    const animate = () => {
      if (this.destroyed || animationGeneration !== this.runnerAnimationGeneration) {
        return;
      }
      const now =
        typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      const t = Math.min(1, (now - t0) / Math.max(1, duration));
      let eased: number;
      if (spring === 'snappy') eased = Math.min(1, t + 0.08 * Math.sin(t * 8));
      else if (spring === 'gentle') eased = t * t * (3 - 2 * t);
      else eased = t * t * (3 - 2 * t) * 0.85 + t * 0.15;
      const y = Math.round(y1 + (y2 - y1) * eased);
      if (this.runnerRing) {
        this.runnerRing.style.transform = `translate3d(-50%, ${y - 10}px, 0)`;
      }
      if (t < 1) {
        this.runnerRaf = requestAnimationFrame(animate);
      } else {
        if (this.runnerRing) {
          this.runnerRing.style.opacity = '0';
        }
      }
    };
    animate();
  }

  syncTimelineTrackToMain(): void {
    if (this.timelineStyle !== 'dots') return;
    if (this.sliderDragging) return;
    if (!this.ui.track || !this.scrollContainer || !this.contentHeight) return;
    const scrollTop = this.scrollContainer.scrollTop;
    const ref = scrollTop + this.scrollContainer.clientHeight * 0.45;
    const span = Math.max(1, this.contentSpanPx || 1);
    const r = Math.max(0, Math.min(1, (ref - (this.firstUserTurnOffset || 0)) / span));
    const maxScroll = Math.max(0, this.contentHeight - (this.ui.track.clientHeight || 0));
    const target = Math.round(r * maxScroll);
    if (Math.abs((this.ui.track.scrollTop || 0) - target) > 1) this.ui.track.scrollTop = target;
  }

  private lowerBound(arr: number[], x: number): number {
    let lo = 0,
      hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private upperBound(arr: number[], x: number): number {
    let lo = 0,
      hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  private getRulerFocusIndex(): number {
    const fallback = Math.max(0, this.getActiveIndex());
    if (
      !this.scrollContainer ||
      this.markerTops.length !== this.markers.length ||
      this.markerTops.length === 0
    ) {
      return fallback;
    }

    const focusTop =
      this.scrollContainer.scrollTop + Math.max(0, this.scrollContainer.clientHeight) * 0.45;
    const upperIndex = this.lowerBound(this.markerTops, focusTop);
    if (upperIndex <= 0) return 0;
    if (upperIndex >= this.markerTops.length) return this.markerTops.length - 1;

    const lowerIndex = upperIndex - 1;
    const lowerTop = this.markerTops[lowerIndex];
    const upperTop = this.markerTops[upperIndex];
    const progress = Math.max(
      0,
      Math.min(1, (focusTop - lowerTop) / Math.max(1, upperTop - lowerTop)),
    );
    return lowerIndex + progress;
  }

  /** Smooth Gaussian crest that travels through the ruler as the page scrolls. */
  private updateRulerWave(): void {
    if (this.timelineStyle !== 'ruler') {
      this.markers.forEach((marker) => {
        this.dots.get(marker.id)?.style.removeProperty('--gv-timeline-ruler-scale');
        this.dots.get(marker.id)?.style.removeProperty('--gv-timeline-ruler-opacity');
      });
      return;
    }

    const focusIndex = this.getRulerFocusIndex();
    const sigma = 1.2;
    const start = Math.max(0, this.visibleRange.start);
    const end =
      this.visibleRange.end >= start
        ? Math.min(this.visibleRange.end, this.markers.length - 1)
        : this.markers.length - 1;
    for (let index = start; index <= end; index++) {
      const marker = this.markers[index];
      if (!marker) continue;
      const dot = this.dots.get(marker.id);
      if (!dot) continue;
      const level = this.state.getMarkerLevel(marker.id);
      const baseScale = level === 3 ? 0.54 : level === 2 ? 0.42 : 0.29;
      const distance = Math.abs(index - focusIndex);
      const crest = Math.exp(-(distance * distance) / (2 * sigma * sigma));
      const scale = baseScale + (1 - baseScale) * crest;
      const opacity = 0.42 + 0.5 * crest;
      dot.style.setProperty('--gv-timeline-ruler-scale', scale.toFixed(3));
      dot.style.setProperty('--gv-timeline-ruler-opacity', opacity.toFixed(3));
    }
  }

  private buildCompactMarkerOffsets(hiddenIndices: ReadonlySet<number>): Map<number, number> {
    const visibleIndices: number[] = [];
    for (let index = 0; index < this.markers.length; index++) {
      if (!hiddenIndices.has(index)) visibleIndices.push(index);
    }

    const offsets = new Map<number, number>();
    const count = visibleIndices.length;
    if (count === 0) return offsets;
    const gap = count > 1 ? Math.min(8, 160 / (count - 1)) : 0;
    const center = (count - 1) / 2;
    visibleIndices.forEach((markerIndex, rank) => {
      offsets.set(markerIndex, (rank - center) * gap);
    });
    return offsets;
  }

  private applyDotPosition(dot: DotElement, index: number, compactOffset?: number): void {
    if (this.timelineStyle === 'compact' || this.timelineStyle === 'ruler') {
      const offset = compactOffset ?? 0;
      const operator = offset < 0 ? '-' : '+';
      dot.style.top = `calc(50% ${operator} ${Math.abs(offset)}px)`;
      dot.style.setProperty('--timeline-compact-offset', `${offset}px`);
      return;
    }

    dot.style.removeProperty('--timeline-compact-offset');
    dot.style.setProperty('--n', String(this.normalizedPositions[index] || 0));
    if (this.usePixelTop) {
      dot.style.top = `${Math.round(this.yPositions[index])}px`;
    } else {
      dot.style.removeProperty('top');
    }
  }

  updateSlider(): void {
    if (!this.ui.slider || !this.ui.sliderHandle) return;
    if (!this.contentHeight || !this.ui.timelineBar || !this.ui.track) return;
    const barRect = this.ui.timelineBar.getBoundingClientRect();
    const barH = barRect.height || 0;
    const pad = this.getTrackPadding();
    const innerH = Math.max(0, barH - 2 * pad);
    if (this.contentHeight <= barH + 1 || innerH <= 0) {
      this.sliderAlwaysVisible = false;
      this.sliderMaxTop = 0;
      this.sliderScrollRange = 1;
      this.ui.slider.classList.remove('visible');
      this.ui.slider.style.opacity = '';
      return;
    }
    this.sliderAlwaysVisible = true;
    const railLen = Math.max(120, Math.min(240, Math.floor(barH * 0.45)));
    const railTop = Math.round(barRect.top + pad + (innerH - railLen) / 2);
    const railLeftGap = 8;
    const sliderWidth = 12;
    // In RTL, bar is on the left side — position slider to its right instead
    const left = this.rtl
      ? Math.round(barRect.right + railLeftGap)
      : Math.round(barRect.left - railLeftGap - sliderWidth);
    this.ui.slider.style.left = `${left}px`;
    this.ui.slider.style.top = `${railTop}px`;
    this.ui.slider.style.height = `${railLen}px`;
    const handleH = 22;
    const maxTop = Math.max(0, railLen - handleH);
    const range = Math.max(1, this.contentHeight - barH);
    this.sliderMaxTop = maxTop;
    this.sliderScrollRange = range;
    this.ui.sliderHandle.style.height = `${handleH}px`;
    this.updateSliderPosition();
    this.ui.slider.classList.add('visible');
    this.ui.slider.style.opacity = '';
  }

  updateSliderPosition(): void {
    if (!this.ui.track || !this.ui.sliderHandle || !this.sliderAlwaysVisible) return;
    const st = this.ui.track.scrollTop || 0;
    const ratio = Math.max(0, Math.min(1, st / this.sliderScrollRange));
    const top = `${Math.round(ratio * this.sliderMaxTop)}px`;
    if (this.ui.sliderHandle.style.top !== top) this.ui.sliderHandle.style.top = top;
  }

  private showSlider(): void {
    if (!this.ui.slider) return;
    this.ui.slider.classList.add('visible');
    if (this.sliderFadeTimer) {
      clearTimeout(this.sliderFadeTimer);
      this.sliderFadeTimer = null;
    }
    this.updateSlider();
  }

  private hideSliderDeferred(): void {
    if (this.sliderDragging || this.sliderAlwaysVisible) return;
    if (this.sliderFadeTimer) clearTimeout(this.sliderFadeTimer);
    this.sliderFadeTimer = window.setTimeout(() => {
      this.sliderFadeTimer = null;
      this.ui.slider?.classList.remove('visible');
    }, this.sliderFadeDelay);
  }

  private handleSliderDrag(e: PointerEvent): void {
    if (!this.sliderDragging || !this.ui.timelineBar || !this.ui.track) return;
    const barRect = this.ui.timelineBar.getBoundingClientRect();
    const barH = barRect.height || 0;
    const railLen =
      parseFloat(this.ui.slider!.style.height || '0') ||
      Math.max(120, Math.min(240, Math.floor(barH * 0.45)));
    const handleH = this.ui.sliderHandle!.getBoundingClientRect().height || 22;
    const maxTop = Math.max(0, railLen - handleH);
    const delta = e.clientY - this.sliderStartClientY;
    let top = Math.max(
      0,
      Math.min(maxTop, this.sliderStartTop + delta - (parseFloat(this.ui.slider!.style.top) || 0)),
    );
    const r = maxTop > 0 ? top / maxTop : 0;
    const range = Math.max(1, this.contentHeight - barH);
    this.ui.track.scrollTop = Math.round(r * range);
    this.updateVirtualRangeAndRender();
    // showSlider() already refreshes slider geometry via updateSlider()
    this.showSlider();
  }

  private endSliderDrag(_e: PointerEvent): void {
    this.sliderDragging = false;
    try {
      if (this.onSliderMove) window.removeEventListener('pointermove', this.onSliderMove);
      if (this.onSliderUp) {
        window.removeEventListener('pointerup', this.onSliderUp);
        window.removeEventListener('pointercancel', this.onSliderUp);
      }
    } catch {}
    this.onSliderMove = null;
    this.onSliderUp = null;
    this.hideSliderDeferred();
  }

  toggleDraggable(enabled: boolean): void {
    this.draggable = enabled;
    // Cursor is managed dynamically by onBarCursorMove; just update the flag
    if (!this.ui.timelineBar) return;
    if (!this.draggable) {
      this.ui.timelineBar.style.cursor = '';
    }
  }

  private handleBarDrag(e: PointerEvent): void {
    if (!this.barDragging) return;
    const dx = e.clientX - this.barStartPos.x;
    const dy = e.clientY - this.barStartPos.y;
    const left = this.barStartOffset.x + dx;
    this.ui.timelineBar!.style.left = `${left}px`;
    this.ui.timelineBar!.style.top = `${this.barStartOffset.y + dy}px`;
    this.updateRulerDirection(left);
  }

  private endBarDrag(_e: PointerEvent): void {
    this.barDragging = false;
    this.savePosition();
    try {
      if (this.onBarPointerMove) window.removeEventListener('pointermove', this.onBarPointerMove);
      if (this.onBarPointerUp) {
        window.removeEventListener('pointerup', this.onBarPointerUp);
        window.removeEventListener('pointercancel', this.onBarPointerUp);
      }
    } catch {}
    this.onBarPointerMove = null;
    this.onBarPointerUp = null;
  }

  private savePosition(): void {
    if (!this.ui.timelineBar) return;
    const rect = this.ui.timelineBar.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Save position as percentage of viewport for responsive design
    const position = {
      version: 2,
      topPercent: (rect.top / viewportHeight) * 100,
      leftPercent: (rect.left / viewportWidth) * 100,
    };
    this.savedTimelinePosition = position;

    const g = globalThis as ExtGlobal;
    if (g.chrome?.storage?.sync?.set) {
      g.chrome.storage.sync.set({ geminiTimelinePosition: position });
    } else if (g.browser?.storage?.sync?.set) {
      g.browser.storage.sync.set({ geminiTimelinePosition: position });
    }
  }

  /**
   * Apply position with boundary checks to keep timeline visible
   */
  applyRTLUpdate(language?: string | null): void {
    const wasRTL = this.rtl;
    this.rtl = applyRTLClass(language);
    if (wasRTL !== this.rtl) {
      // Reset inline position so the CSS default for the new direction takes effect
      if (this.ui.timelineBar) {
        this.ui.timelineBar.style.top = '';
        this.ui.timelineBar.style.left = '';
      }
      this.updateRulerDirection();
      this.updateSlider();
      this.previewPanel?.reposition();
    }
  }

  applyPosition(top: number, left: number): void {
    if (!this.ui.timelineBar) return;

    const barWidth = this.ui.timelineBar.offsetWidth || 24; // fallback to default width
    const barHeight = this.ui.timelineBar.offsetHeight || 100;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Clamp to viewport bounds (with small padding)
    const padding = 10;
    const clampedTop = Math.max(padding, Math.min(top, viewportHeight - barHeight - padding));
    const clampedLeft = Math.max(padding, Math.min(left, viewportWidth - barWidth - padding));

    this.ui.timelineBar.style.top = `${clampedTop}px`;
    this.ui.timelineBar.style.left = `${clampedLeft}px`;
    this.updateRulerDirection(clampedLeft);
    this.previewPanel?.reposition();
  }

  /** Grow ruler ticks toward page content, including after the rail is dragged across the viewport. */
  updateRulerDirection(left?: number): void {
    const bar = this.ui.timelineBar;
    if (!bar) return;
    const barLeft = left ?? bar.getBoundingClientRect().left;
    const center = barLeft + (bar.offsetWidth || 24) / 2;
    bar.classList.toggle('gv-timeline-ruler-inward-right', center < window.innerWidth / 2);
  }

  /**
   * Reapply position after window resize. Uses the in-memory cache populated
   * during init/savePosition/onSyncSettingsChanged instead of a storage read,
   * so resizes never trigger storage IPC.
   */
  reapplyPosition(): void {
    if (!this.ui.timelineBar) return;

    const position = this.savedTimelinePosition;
    if (!position) return;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // v2 format: use percentage (responsive)
    if (
      position.version === 2 &&
      position.topPercent !== undefined &&
      position.leftPercent !== undefined
    ) {
      const top = (position.topPercent / 100) * viewportHeight;
      const left = (position.leftPercent / 100) * viewportWidth;
      this.applyPosition(top, left);
    }
    // v1 format: keep absolute position (no resize adjustment for legacy)
    else if (position.top !== undefined && position.left !== undefined) {
      this.applyPosition(position.top, position.left);
    }
  }

  /** Trailing-debounced handler shared by window and visualViewport resize. */
  private scheduleResizeWork(): void {
    if (this.resizeIdleTimer !== null) clearTimeout(this.resizeIdleTimer);
    this.resizeIdleTimer = window.setTimeout(() => {
      this.resizeIdleTimer = null;
      if (this.destroyed) return;
      this.options.onResize();
      this.updateTimelineGeometry();
      this.syncTimelineTrackToMain();
      this.updateVirtualRangeAndRender();
      this.updateSlider();
      // Reapply position for responsive design (v2 format only)
      this.reapplyPosition();
    }, this.resizeIdleDelay);
  }
}
