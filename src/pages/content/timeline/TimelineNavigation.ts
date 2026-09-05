import { keyboardShortcutService } from '@/core/services/KeyboardShortcutService';

export interface TimelineNavigationMarker {
  id: string;
  element: HTMLElement;
}

type Direction = 'previous' | 'next';
type TimelineSpringProfile = 'ios' | 'snappy' | 'gentle';

interface TimelineNavigationOptions {
  getMarkers(): readonly TimelineNavigationMarker[];
  getMarkerTops(): readonly number[];
  getMarkerPositions(): readonly number[];
  getTrackHeight(): number;
  /** Refresh an interaction target, or check for new turns at a navigation boundary. */
  refreshMarkers(target: HTMLElement | null, direction?: Direction): boolean;
  resolveStoredId(storedId: string): string;
  onActiveChange(id: string | null): void;
  onScroll(): void;
  animateRunner(fromIndex: number, toIndex: number, duration: number): void;
}

export function getTimelineSpringProfile(): TimelineSpringProfile {
  try {
    const value = localStorage.getItem('geminiTimelineSpring');
    if (value === 'snappy' || value === 'gentle') return value;
  } catch {}
  return 'ios';
}

function easeScroll(
  t: number,
  start: number,
  distance: number,
  duration: number,
  spring: TimelineSpringProfile,
): number {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const progress = clamp(t / duration);
  if (spring === 'snappy') {
    const overshoot = 1.15;
    const value = progress < 0.6 ? progress / 0.6 : 1 + (0.6 - progress) * 0.15;
    return start + distance * clamp(value * overshoot - (overshoot - 1));
  }
  if (spring === 'gentle') {
    return (
      start +
      distance *
        (progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 3) / 2)
    );
  }
  const smooth = progress * progress * (3 - 2 * progress);
  const shaped = (Math.pow(progress, 0.42) + Math.pow(progress, 0.58)) * 0.075 + smooth * 0.85;
  return start + distance * clamp(shaped);
}

/** Owns navigation for one conversation, including its viewport and pending work. */
export class TimelineNavigation {
  activeTurnId: string | null = null;
  mode: 'jump' | 'flow' = 'flow';
  private scrollContainer: HTMLElement | null = null;
  private destroyed = false;
  private isScrolling = false;
  private scrollAnimationGeneration = 0;
  private animationRaf: number | null = null;
  private scrollRaf: number | null = null;
  private lastActiveChangeTime = 0;
  private pendingActiveId: string | null = null;
  private activeChangeTimer: number | null = null;
  private navigationCommitTimer: number | null = null;
  private navigationActiveLockUntil = 0;
  private navigationQueue: Direction[] = [];
  private isNavigating = false;
  private navigationWaits = new Map<number, () => void>();
  private shortcutUnsubscribe: (() => void) | null = null;
  private shortcutInit: Promise<void> | null = null;
  private starredNavigationTimer: number | null = null;
  private readonly onViewportScroll = () => this.scheduleScrollSync();

  constructor(private readonly options: TimelineNavigationOptions) {}

  get viewport(): HTMLElement | null {
    return this.scrollContainer;
  }

  setViewport(viewport: HTMLElement | null): void {
    if (this.destroyed || viewport === this.scrollContainer) return;
    this.scrollContainer?.removeEventListener('scroll', this.onViewportScroll);
    this.cancelScrollAnimation();
    this.scrollContainer = viewport;
    viewport?.addEventListener('scroll', this.onViewportScroll, { passive: true });
  }

  getActiveIndex(): number {
    if (!this.activeTurnId) return -1;
    return this.options.getMarkers().findIndex((marker) => marker.id === this.activeTurnId);
  }

  scheduleScrollSync(): void {
    if (this.destroyed || this.scrollRaf !== null) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = null;
      if (this.destroyed) return;
      this.options.onScroll();
      this.computeActiveByScroll();
    });
  }

  computeActiveByScroll(): void {
    const viewport = this.scrollContainer;
    const markers = this.options.getMarkers();
    if (this.destroyed || this.isScrolling || !viewport || markers.length === 0) return;
    if (Date.now() < this.navigationActiveLockUntil) return;
    const scrollTop = viewport.scrollTop;
    const reference = scrollTop + viewport.clientHeight * 0.45;
    const tops = this.options.getMarkerTops();
    let activeId = markers[0].id;
    if (tops.length === markers.length) {
      let low = 0;
      let high = tops.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (tops[middle] <= reference) low = middle + 1;
        else high = middle;
      }
      activeId = markers[Math.max(0, low - 1)].id;
    } else {
      const viewportRect = viewport.getBoundingClientRect();
      for (const marker of markers) {
        const top = marker.element.getBoundingClientRect().top - viewportRect.top + scrollTop;
        if (top > reference) break;
        activeId = marker.id;
      }
    }
    if (this.activeTurnId === activeId) return;
    const now = performance.now();
    const elapsed = now - this.lastActiveChangeTime;
    if (elapsed < 120) {
      this.pendingActiveId = activeId;
      if (this.activeChangeTimer === null) {
        this.activeChangeTimer = window.setTimeout(() => {
          this.activeChangeTimer = null;
          if (this.pendingActiveId && this.pendingActiveId !== this.activeTurnId) {
            this.setActive(this.pendingActiveId);
            this.lastActiveChangeTime = performance.now();
          }
          this.pendingActiveId = null;
        }, 120 - elapsed);
      }
    } else {
      this.setActive(activeId);
      this.lastActiveChangeTime = now;
    }
  }

  computeFlowDuration(fromIndex: number, toIndex: number): number {
    let base = 650;
    try {
      const stored = parseInt(localStorage.getItem('geminiTimelineFlowDurationMs') || '650', 10);
      base = Math.max(300, Math.min(1800, Number.isFinite(stored) ? stored : 650));
    } catch {}
    if (fromIndex < 0 || toIndex < 0) return base;
    const positions = this.options.getMarkerPositions();
    const span = Math.abs(positions[toIndex] - positions[fromIndex]);
    const height = Math.max(1, this.options.getTrackHeight() || 1);
    return Math.round(base * Math.max(0.6, Math.min(1.6, span / height)));
  }

  smoothScrollTo(target: HTMLElement, duration = 600): void {
    const viewport = this.scrollContainer;
    if (this.destroyed || !viewport) return;
    this.cancelScrollAnimation();
    const generation = this.scrollAnimationGeneration;
    const viewportRect = viewport.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const destination = targetRect.top - viewportRect.top + viewport.scrollTop;
    const start = viewport.scrollTop;
    const distance = destination - start;
    if (this.mode === 'jump' || duration <= 0) {
      viewport.scrollTop = destination;
      return;
    }
    const spring = getTimelineSpringProfile();
    let startTime: number | null = null;
    this.isScrolling = true;
    const animate = (time: number) => {
      if (this.destroyed || generation !== this.scrollAnimationGeneration) return;
      this.animationRaf = null;
      startTime ??= time;
      const elapsed = time - startTime;
      viewport.scrollTop = easeScroll(elapsed, start, distance, duration, spring);
      if (elapsed < duration) {
        this.animationRaf = requestAnimationFrame(animate);
      } else {
        viewport.scrollTop = destination;
        this.isScrolling = false;
      }
    };
    this.animationRaf = requestAnimationFrame(animate);
  }

  navigateToMarker(turnId: string, index = -1, source: 'dot' | 'preview' = 'dot'): void {
    if (this.destroyed) return;
    const resolveTarget = () => {
      const markers = this.options.getMarkers();
      const idIndex = markers.findIndex((marker) => marker.id === turnId);
      const targetIndex =
        source === 'preview' ? (idIndex >= 0 ? idIndex : index) : markers[index] ? index : idIndex;
      return { marker: markers[targetIndex], targetIndex };
    };
    let target = resolveTarget();
    if (this.options.refreshMarkers(target.marker?.element ?? null)) target = resolveTarget();
    if (!target.marker) return;
    const fromIndex = this.getActiveIndex();
    const duration = this.computeFlowDuration(fromIndex, target.targetIndex);
    // Read scroll geometry before active/runner writes on a dot click.
    if (source === 'dot') this.smoothScrollTo(target.marker.element, duration);
    if (
      this.mode === 'flow' &&
      fromIndex >= 0 &&
      target.targetIndex >= 0 &&
      fromIndex !== target.targetIndex
    ) {
      this.setActive(null);
      this.options.animateRunner(fromIndex, target.targetIndex, duration);
    }
    if (source === 'preview') this.smoothScrollTo(target.marker.element, duration);
    this.commitActiveMarkerAfterNavigation(target.marker.id, duration);
  }

  initKeyboardShortcuts(): Promise<void> {
    if (this.destroyed || this.shortcutUnsubscribe) return Promise.resolve();
    if (this.shortcutInit) return this.shortcutInit;
    this.shortcutInit = (async () => {
      try {
        await keyboardShortcutService.init();
        if (this.destroyed) return;
        this.shortcutUnsubscribe = keyboardShortcutService.on((action, event) => {
          if (action === 'timeline:previous') this.enqueueNavigation('previous', event.repeat);
          else if (action === 'timeline:next') this.enqueueNavigation('next', event.repeat);
          else if (action === 'timeline:first') void this.navigateToFirstNode();
          else if (action === 'timeline:last') void this.navigateToLastNode();
        });
      } catch (error) {
        console.warn('[Timeline] Failed to initialize keyboard shortcuts:', error);
      }
    })().finally(() => {
      this.shortcutInit = null;
    });
    return this.shortcutInit;
  }

  enqueueNavigation(direction: Direction, isRepeat = false): void {
    if (
      this.destroyed ||
      (isRepeat && this.navigationQueue.length > 0) ||
      this.navigationQueue.length >= 3
    )
      return;
    const markers = this.options.getMarkers();
    if (markers.length === 0) return;
    const currentIndex = this.getActiveIndex();
    const blocked =
      (direction === 'previous' && currentIndex === 0) ||
      (direction === 'next' && currentIndex === markers.length - 1);
    if (blocked && !this.options.refreshMarkers(null, direction)) return;
    this.navigationQueue.push(direction);
    void this.processNavigationQueue();
  }

  async navigateToPreviousNode(): Promise<void> {
    if (this.destroyed || this.options.getMarkers().length === 0) return;
    this.maybeRefreshMarkersForNavigation('previous');
    const currentIndex = this.getActiveIndex();
    await this.performNodeNavigation(currentIndex <= 0 ? 0 : currentIndex - 1, currentIndex);
  }

  async navigateToNextNode(): Promise<void> {
    if (this.destroyed || this.options.getMarkers().length === 0) return;
    this.maybeRefreshMarkersForNavigation('next');
    const currentIndex = this.getActiveIndex();
    await this.performNodeNavigation(
      currentIndex < 0 ? 0 : Math.min(currentIndex + 1, this.options.getMarkers().length - 1),
      currentIndex,
    );
  }

  async navigateToFirstNode(): Promise<void> {
    if (this.destroyed || this.options.getMarkers().length === 0) return;
    this.maybeRefreshMarkersForNavigation('previous');
    this.navigationQueue.length = 0;
    await this.performNodeNavigation(0, this.getActiveIndex());
  }

  async navigateToLastNode(): Promise<void> {
    if (this.destroyed || this.options.getMarkers().length === 0) return;
    this.maybeRefreshMarkersForNavigation('next');
    this.navigationQueue.length = 0;
    await this.performNodeNavigation(this.options.getMarkers().length - 1, this.getActiveIndex());
  }

  handleStarredMessageNavigation(): void {
    if (this.destroyed) return;
    this.clearStarredNavigationTimer();
    const url = window.location.href;
    const hash = window.location.hash;
    if (!hash.startsWith('#gv-turn-')) return;
    const turnId = hash.slice('#gv-turn-'.length);
    if (!turnId) return;
    const isCurrent = () => !this.destroyed && window.location.href === url;
    const clearHash = () => {
      if (isCurrent())
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
    };
    const schedule = (callback: () => void, delay: number) => {
      this.starredNavigationTimer = window.setTimeout(() => {
        this.starredNavigationTimer = null;
        if (isCurrent()) callback();
      }, delay);
    };
    const checkAndScroll = () => {
      const id = this.options.resolveStoredId(turnId);
      const marker = this.options.getMarkers().find((item) => item.id === id);
      if (!marker) return false;
      schedule(() => {
        this.smoothScrollTo(marker.element, 800);
        schedule(clearHash, 900);
      }, 100);
      return true;
    };
    let attempts = 0;
    const retry = () => {
      if (checkAndScroll()) return;
      if (++attempts >= 20) {
        clearHash();
        return;
      }
      schedule(retry, Math.min(attempts * 100, 300));
    };
    if (!checkAndScroll()) schedule(retry, 200);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.setViewport(null);
    this.destroyed = true;
    this.shortcutUnsubscribe?.();
    this.shortcutUnsubscribe = null;
    this.navigationQueue.length = 0;
    for (const [timer, resolve] of this.navigationWaits) {
      window.clearTimeout(timer);
      resolve();
    }
    this.navigationWaits.clear();
    this.clearActiveChange();
    this.clearPendingNavigationCommit();
    this.clearStarredNavigationTimer();
    if (this.scrollRaf !== null) cancelAnimationFrame(this.scrollRaf);
    this.scrollRaf = null;
    this.activeTurnId = null;
  }

  private setActive(id: string | null): void {
    this.activeTurnId = id;
    this.options.onActiveChange(id);
  }

  private cancelScrollAnimation(): void {
    this.scrollAnimationGeneration++;
    if (this.animationRaf !== null) cancelAnimationFrame(this.animationRaf);
    this.animationRaf = null;
    this.isScrolling = false;
  }

  private clearActiveChange(): void {
    if (this.activeChangeTimer !== null) window.clearTimeout(this.activeChangeTimer);
    this.activeChangeTimer = null;
    this.pendingActiveId = null;
  }

  private clearPendingNavigationCommit(): void {
    if (this.navigationCommitTimer !== null) window.clearTimeout(this.navigationCommitTimer);
    this.navigationCommitTimer = null;
  }

  private clearStarredNavigationTimer(): void {
    if (this.starredNavigationTimer !== null) window.clearTimeout(this.starredNavigationTimer);
    this.starredNavigationTimer = null;
  }

  private commitActiveMarkerAfterNavigation(targetId: string, duration: number): void {
    this.clearPendingNavigationCommit();
    this.navigationCommitTimer = window.setTimeout(
      () => {
        this.navigationCommitTimer = null;
        if (!this.options.getMarkers().some((marker) => marker.id === targetId)) return;
        this.clearActiveChange();
        this.navigationActiveLockUntil = Date.now() + 900;
        this.setActive(targetId);
        this.scheduleScrollSync();
      },
      this.mode === 'jump' ? 0 : Math.max(0, duration),
    );
  }

  private maybeRefreshMarkersForNavigation(direction: Direction): void {
    const currentIndex = this.getActiveIndex();
    if (
      (direction === 'previous' && currentIndex === 0) ||
      (direction === 'next' &&
        currentIndex >= 0 &&
        currentIndex === this.options.getMarkers().length - 1)
    ) {
      this.options.refreshMarkers(null, direction);
    }
  }

  private async processNavigationQueue(): Promise<void> {
    if (this.destroyed || this.isNavigating) return;
    this.isNavigating = true;
    try {
      while (!this.destroyed && this.navigationQueue.length > 0) {
        const direction = this.navigationQueue.shift()!;
        if (direction === 'previous') await this.navigateToPreviousNode();
        else await this.navigateToNextNode();
      }
    } finally {
      this.isNavigating = false;
    }
  }

  private async performNodeNavigation(targetIndex: number, currentIndex: number): Promise<void> {
    this.clearPendingNavigationCommit();
    this.options.refreshMarkers(this.options.getMarkers()[targetIndex]?.element ?? null);
    const marker = this.options.getMarkers()[targetIndex];
    if (!marker) return;
    this.clearActiveChange();
    if (this.mode === 'flow' && currentIndex >= 0) {
      const duration = this.computeFlowDuration(currentIndex, targetIndex);
      this.options.animateRunner(currentIndex, targetIndex, duration);
      this.smoothScrollTo(marker.element, duration);
      const generation = this.scrollAnimationGeneration;
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(() => {
          this.navigationWaits.delete(timer);
          resolve();
        }, duration);
        this.navigationWaits.set(timer, resolve);
      });
      if (this.destroyed || generation !== this.scrollAnimationGeneration) return;
    } else {
      this.smoothScrollTo(marker.element, 0);
    }
    if (this.destroyed) return;
    this.navigationActiveLockUntil = Date.now() + 900;
    this.setActive(marker.id);
  }
}
