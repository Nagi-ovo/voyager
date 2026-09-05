import { StorageKeys, isTimelineStyle } from '@/core/types/common';
import { applyRTLClass } from '@/core/utils/rtl';
import { initI18n } from '@/utils/i18n';

import { TimelineMarkerInteractions } from './TimelineMarkerInteractions';
import { TimelineNavigation } from './TimelineNavigation';
import { TimelineState } from './TimelineState';
import { TimelineTimestamps } from './TimelineTimestamps';
import { TimelineTooltip } from './TimelineTooltip';
import { TimelineTurns } from './TimelineTurns';
import { TimelineView } from './TimelineView';
import type { DotElement, ExtGlobal, SyncSettingsListener, TimelinePositionData } from './types';
interface TimelineManagerOptions {
  previousUrl?: string | null;
}
/** Composes one conversation's DOM observation, state, navigation and timeline surfaces. */
export class TimelineManager {
  private conversationContainer: HTMLElement | null = null;
  private destroyed = false;
  private mutationObserver: MutationObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private zeroTurnsTimer: number | null = null;
  private zeroTurnsRetryCount = 0;
  private onSyncSettingsChanged: SyncSettingsListener | null = null;
  private userTurnSelector: string = '';
  private static readonly SEARCH_HIGHLIGHT_CLASS = 'timeline-search-highlight';
  private readonly state: TimelineState;
  private readonly timestamps: TimelineTimestamps;
  private readonly turns = new TimelineTurns();
  private readonly navigation: TimelineNavigation;
  private readonly view: TimelineView;
  private tooltip: TimelineTooltip | null = null;
  private interactions: TimelineMarkerInteractions | null = null;
  private readonly lifetime = new AbortController();
  private recalcTimer: number | null = null;
  constructor(options: TimelineManagerOptions = {}) {
    this.state = new TimelineState(() => this.onStateChange());
    this.navigation = new TimelineNavigation({
      getMarkers: () => this.state.markers,
      getMarkerTops: () => this.view.markerTops,
      getMarkerPositions: () => this.view.yPositions,
      getTrackHeight: () => this.view.ui.timelineBar?.clientHeight ?? 0,
      refreshMarkers: (target, direction) =>
        direction
          ? this.maybeRefreshMarkersForNavigation(direction)
          : this.maybeRefreshMarkersForInteraction(target),
      resolveStoredId: (id) => this.state.resolveMarkerIdForStorageId(id),
      onActiveChange: () => this.view.updateActiveDotUI(),
      onScroll: () => {
        this.view.syncTimelineTrackToMain();
        this.view.updateVirtualRangeAndRender();
        this.view.updateSliderPosition();
      },
      animateRunner: (from, to, duration) => this.view.startRunner(from, to, duration),
    });
    this.view = new TimelineView(this.state, {
      getViewport: () => this.navigation.viewport,
      getActiveId: () => this.navigation.activeTurnId,
      navigate: (id, index) => this.navigation.navigateToMarker(id, index, 'preview'),
      search: (query) => this.highlightSearchInDOM(query),
      onStyleChange: () => this.tooltip?.hide(true),
      onResize: () => this.tooltip?.refreshCurrent(),
    });
    this.timestamps = new TimelineTimestamps(
      {
        getMarkers: () => this.state.markers,
        getTurnText: (element) => this.turns.getTurnTextCached(element),
        getTurnAliases: (id) => this.state.getStoredTurnIdAliases(id),
        onIdentityChange: () => this.state.refreshStars(),
      },
      options,
    );
  }
  private mountUI(): void {
    this.view.mount();
    const bar = this.view.ui.timelineBar!;
    this.tooltip = new TimelineTooltip(bar, {
      getContext: () => ({
        style: this.view.timelineStyle,
        previewOpen: this.view.previewPanel?.isOpen ?? false,
      }),
      getContent: (dot) => {
        const id = dot.dataset.targetTurnId ?? '';
        const marker = this.state.markerMap.get(id);
        return {
          text: this.buildTooltipText(dot),
          summary: marker?.summary ?? dot.getAttribute('aria-label') ?? '',
          assistantSummary: marker?.assistantSummary ?? '',
          starred: this.state.isMarkerStarred(id),
        };
      },
    });
    this.interactions = new TimelineMarkerInteractions(bar, this.tooltip, {
      navigate: (index, id) => this.navigation.navigateToMarker(id, index),
      toggleStar: (id) => void this.state.toggleStar(id),
      getHierarchy: (id) =>
        this.state.markerLevelEnabled
          ? {
              level: this.state.getMarkerLevel(id),
              collapsed: this.state.isMarkerCollapsed(id),
              canCollapse: this.state.canCollapseMarker(id),
            }
          : null,
      setLevel: (id, level) => this.state.setMarkerLevel(id, level),
      toggleCollapse: (id) => this.state.toggleCollapse(id),
    });
  }
  private onStateChange(): void {
    if (this.destroyed) return;
    this.view.updateTimelineGeometry();
    this.view.updateVirtualRangeAndRender();
    this.view.updateSlider();
    this.view.updatePreviewMarkers();
    this.tooltip?.refreshCurrent();
  }
  private setMarkerLevelEnabled(enabled: boolean): void {
    this.state.markerLevelEnabled = enabled;
    if (!enabled) this.interactions?.closeMenu();
    this.onStateChange();
  }
  private debouncedRecalc = (): void => {
    if (this.destroyed) return;
    if (this.recalcTimer !== null) clearTimeout(this.recalcTimer);
    this.recalcTimer = window.setTimeout(() => {
      this.recalcTimer = null;
      this.recalculateAndRenderMarkers();
    }, 200);
  };
  private waitForAnyElement(
    selectors: string[],
    timeoutMs = 5000,
  ): Promise<{ element: Element; selector: string } | null> {
    const find = () => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) return { element, selector };
      }
      return null;
    };
    const found = find();
    if (found || this.destroyed) return Promise.resolve(found);
    return new Promise((resolve) => {
      const finish = (result: ReturnType<typeof find>) => {
        observer.disconnect();
        clearTimeout(timer);
        this.lifetime.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const observer = new MutationObserver(() => {
        const result = find();
        if (result) finish(result);
      });
      const onAbort = () => finish(null);
      const timer = window.setTimeout(() => finish(null), timeoutMs);
      observer.observe(document.body, { childList: true, subtree: true });
      this.lifetime.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lifetime.abort();
    this.unregisterSyncSettingsListener();
    this.mutationObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    if (this.recalcTimer !== null) clearTimeout(this.recalcTimer);
    if (this.zeroTurnsTimer !== null) clearTimeout(this.zeroTurnsTimer);
    this.navigation.destroy();
    this.interactions?.destroy();
    this.tooltip?.destroy();
    this.clearSearchHighlights();
    this.view.destroy();
    this.state.destroy();
    this.timestamps.destroy();
    this.conversationContainer = null;
  }
  async init(): Promise<void> {
    if (this.destroyed) return;
    await initI18n();
    if (this.destroyed) return;
    const ok = await this.findCriticalElements();
    if (!ok || this.destroyed) return;
    this.mountUI();
    this.setupObservers();
    await this.state.init();
    if (this.destroyed) return;
    await this.timestamps.init();
    if (this.destroyed) return;
    // Ensure initial render even when Gemini DOM is already stable (no mutations after observer attaches)
    this.recalculateAndRenderMarkers();
    // Handle URL hash for starred message navigation
    this.navigation.handleStarredMessageNavigation();
    // Initialize keyboard shortcuts
    await this.navigation.initKeyboardShortcuts();
    if (this.destroyed) return;
    try {
      const g = globalThis as ExtGlobal;
      const defaults = {
        geminiTimelineScrollMode: 'flow',
        [StorageKeys.TIMELINE_STYLE]: 'dots',
        geminiTimelineHideContainer: false,
        geminiTimelineBarWidth: null,
        geminiTimelineDraggable: false,
        geminiTimelineMarkerLevel: false,
        geminiTimelinePosition: null,
        [StorageKeys.TIMELINE_PREVIEW_PINNED]: false,
        [StorageKeys.LANGUAGE]: null,
      };

      let res: Record<string, unknown> | null = null;
      // prefer chrome.storage or browser.storage if available to sync with popup
      if (g.chrome?.storage?.sync || g.browser?.storage?.sync) {
        res = await new Promise((resolve) => {
          if (g.chrome?.storage?.sync?.get) {
            g.chrome.storage.sync.get(
              defaults as Record<string, unknown>,
              (items: Record<string, unknown>) => {
                if (g.chrome.runtime.lastError) {
                  console.error(
                    `[Timeline] chrome.storage.get failed: ${g.chrome.runtime.lastError.message}`,
                  );
                  resolve(null);
                } else {
                  resolve(items);
                }
              },
            );
          } else {
            g.browser?.storage?.sync
              ?.get(defaults)
              .then(resolve)
              .catch((error: Error) => {
                console.error(`[Timeline] browser.storage.get failed: ${error.message}`);
                resolve(null);
              });
          }
        });
      } else {
        // No extension storage available, try to load critical fallback from localStorage
        const saved = localStorage.getItem('geminiTimelineScrollMode');
        if (saved === 'flow' || saved === 'jump') res = { geminiTimelineScrollMode: saved };
      }
      if (this.destroyed) return;

      const m = res?.geminiTimelineScrollMode;
      if (m === 'flow' || m === 'jump') this.navigation.mode = m;
      const storedTimelineStyle = res?.[StorageKeys.TIMELINE_STYLE];
      if (isTimelineStyle(storedTimelineStyle)) {
        this.view.timelineStyle = storedTimelineStyle;
      }
      this.view.hideContainer = !!res?.geminiTimelineHideContainer;
      const storedWidth = res?.geminiTimelineBarWidth;
      if (
        typeof storedWidth === 'number' &&
        storedWidth >= this.view.barWidthMin &&
        storedWidth <= this.view.barWidthMax
      ) {
        this.view.barWidth = storedWidth;
      }
      this.view.applyContainerVisibility();
      this.view.applyTimelineStyle();
      this.view.toggleDraggable(!!res?.geminiTimelineDraggable);
      this.setMarkerLevelEnabled(!!res?.geminiTimelineMarkerLevel);
      this.view.previewPanel?.setPinned(res?.[StorageKeys.TIMELINE_PREVIEW_PINNED] === true);
      this.view.rtl = applyRTLClass(res?.[StorageKeys.LANGUAGE] as string | null | undefined);

      // Load position with auto-migration from v1 to v2
      const position = res?.geminiTimelinePosition as TimelinePositionData | undefined;
      this.view.savedTimelinePosition = position ?? null;
      if (position) {
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
          this.view.applyPosition(top, left);
        }
        // v1 format: migrate to v2 (auto-upgrade)
        else if (position.top !== undefined && position.left !== undefined) {
          // Apply old position first
          this.view.applyPosition(position.top, position.left);

          // Migrate to v2 format (percentage-based)
          const migratedPosition = {
            version: 2,
            topPercent: (position.top / viewportHeight) * 100,
            leftPercent: (position.left / viewportWidth) * 100,
          };
          this.view.savedTimelinePosition = migratedPosition;
          (g.chrome?.storage?.sync || g.browser?.storage?.sync)?.set?.({
            geminiTimelinePosition: migratedPosition,
          });
        }
      }
      this.view.updateRulerDirection();
      this.view.previewPanel?.reposition();

      // listen for changes from popup and update mode live
      this.registerSyncSettingsListener();
    } catch (err) {
      console.error('[Timeline] Init storage error:', err);
    }
  }

  /**
   * Listen for sync-storage changes from the popup and update settings live.
   * The listener is kept as a class field so destroy() can remove it — a new
   * TimelineManager is created on every SPA navigation and leaked listeners
   * would otherwise accumulate and retain detached DOM.
   */
  private registerSyncSettingsListener(): void {
    if (this.destroyed || this.onSyncSettingsChanged) return;
    try {
      const g = globalThis as ExtGlobal;
      const onChanged = g.chrome?.storage?.onChanged || g.browser?.storage?.onChanged;
      if (!onChanged) return;
      this.onSyncSettingsChanged = (
        changes: Record<string, { newValue: unknown }>,
        area: string,
      ) => {
        if (area !== 'sync') return;
        if (changes?.geminiTimelineScrollMode) {
          const n = changes.geminiTimelineScrollMode.newValue;
          if (n === 'flow' || n === 'jump') this.navigation.mode = n;
        }
        if (changes?.[StorageKeys.TIMELINE_STYLE]) {
          const nextStyle = changes[StorageKeys.TIMELINE_STYLE].newValue;
          if (isTimelineStyle(nextStyle)) {
            this.view.timelineStyle = nextStyle;
            this.view.applyTimelineStyle();
          }
        }
        if (changes?.geminiTimelineHideContainer) {
          this.view.hideContainer = !!changes.geminiTimelineHideContainer.newValue;
          this.view.applyContainerVisibility();
        }
        if (changes?.geminiTimelineBarWidth) {
          const w = changes.geminiTimelineBarWidth.newValue;
          if (typeof w === 'number' && w >= this.view.barWidthMin && w <= this.view.barWidthMax) {
            this.view.barWidth = w;
            this.view.applyContainerVisibility();
          }
        }
        if (changes?.geminiTimelineDraggable) {
          this.view.toggleDraggable(!!changes.geminiTimelineDraggable.newValue);
        }
        if (changes?.geminiTimelineMarkerLevel) {
          this.setMarkerLevelEnabled(!!changes.geminiTimelineMarkerLevel.newValue);
        }
        if (changes?.[StorageKeys.TIMELINE_PREVIEW_PINNED]) {
          this.view.previewPanel?.setPinned(
            changes[StorageKeys.TIMELINE_PREVIEW_PINNED].newValue === true,
          );
        }
        if (changes?.geminiTimelinePosition) {
          this.view.savedTimelinePosition =
            (changes.geminiTimelinePosition.newValue as TimelinePositionData | null) ?? null;
          if (!changes.geminiTimelinePosition.newValue) {
            if (this.view.ui.timelineBar) {
              this.view.ui.timelineBar.style.top = '';
              this.view.ui.timelineBar.style.left = '';
            }
            this.view.updateRulerDirection();
            this.view.previewPanel?.reposition();
          }
        }
        if (changes?.[StorageKeys.LANGUAGE]) {
          const newLang = changes[StorageKeys.LANGUAGE].newValue as string | null | undefined;
          this.view.applyRTLUpdate(newLang);
        }
      };
      onChanged.addListener(this.onSyncSettingsChanged);
    } catch {
      this.onSyncSettingsChanged = null;
    }
  }

  private unregisterSyncSettingsListener(): void {
    if (!this.onSyncSettingsChanged) return;
    try {
      const g = globalThis as ExtGlobal;
      g.chrome?.storage?.onChanged?.removeListener?.(this.onSyncSettingsChanged);
      g.browser?.storage?.onChanged?.removeListener?.(this.onSyncSettingsChanged);
    } catch {}
    this.onSyncSettingsChanged = null;
  }

  private computeElementTopsInScrollContainer(elements: HTMLElement[]): number[] {
    if (!this.navigation.viewport || elements.length === 0) return [];

    const containerRect = this.navigation.viewport.getBoundingClientRect();
    const scrollTop = this.navigation.viewport.scrollTop;

    const first = elements[0];
    const firstOffsetParent = first.offsetParent;
    const firstOffsetTop = first.offsetTop;
    const firstTop = first.getBoundingClientRect().top - containerRect.top + scrollTop;

    const sameOffsetParent =
      firstOffsetParent !== null && elements.every((el) => el.offsetParent === firstOffsetParent);

    const tops = elements.map((el) => {
      if (sameOffsetParent) {
        return firstTop + (el.offsetTop - firstOffsetTop);
      }
      return el.getBoundingClientRect().top - containerRect.top + scrollTop;
    });

    for (let i = 1; i < tops.length; i++) {
      if (tops[i] < tops[i - 1]) return [];
    }

    return tops;
  }

  private updateIntersectionObserverTargetsFromMarkers(): void {
    if (!this.intersectionObserver) return;
    this.intersectionObserver.disconnect();
    this.state.markers.forEach((m) => this.intersectionObserver!.observe(m.element));
  }

  private async findCriticalElements(): Promise<boolean> {
    let userOverride = '';
    let autoDetected = '';
    try {
      userOverride = localStorage.getItem('geminiTimelineUserTurnSelector') || '';
      autoDetected = localStorage.getItem('geminiTimelineUserTurnSelectorAuto') || '';
    } catch {}
    const defaultCandidates = [
      // Angular-based Gemini UI user bubble (primary)
      '.user-query-bubble-with-background',
      // Angular containers (fallbacks if bubble selector changes)
      '.user-query-bubble-container',
      '.user-query-container',
      'user-query-content .user-query-bubble-with-background',
      // Attribute-based fallbacks for other Gemini variants
      'div[aria-label="User message"]',
      'article[data-author="user"]',
      'article[data-turn="user"]',
      '[data-message-author-role="user"]',
      'div[role="listitem"][data-user="true"]',
    ];
    // Compatibility strategy:
    // - Keep explicit user override as highest priority.
    // - Prefer built-in defaults over auto-detected cache, so stale auto cache can self-heal after refresh.
    let candidates = [...defaultCandidates];
    if (userOverride.length) {
      candidates = [userOverride, ...defaultCandidates.filter((s) => s !== userOverride)];
    } else {
      const cached = autoDetected;
      if (cached && !candidates.includes(cached)) candidates.push(cached);
    }
    let firstTurn: Element | null = null;
    let matchedSelector = '';
    const found = await this.waitForAnyElement(candidates, 4000);
    if (found) {
      firstTurn = found.element;
      matchedSelector = found.selector;
      this.userTurnSelector = matchedSelector;
    }
    if (!firstTurn) {
      this.conversationContainer =
        (document.querySelector('main') as HTMLElement) || (document.body as HTMLElement);
      this.userTurnSelector = defaultCandidates.join(',');
    } else {
      // Scope selection/observers:
      // - Broad scope (main/body) if:
      //   a) user provided an explicit override, or
      //   b) auto-detected selector suggests Angular-based user query DOM (contains 'user-query')
      // - Otherwise, scope to the immediate parent for performance
      const looksAngularUserQuery = /user-query/i.test(matchedSelector || '');
      if ((userOverride && matchedSelector === userOverride) || looksAngularUserQuery) {
        this.conversationContainer =
          (document.querySelector('main') as HTMLElement) || (document.body as HTMLElement);
      } else {
        const parent = firstTurn.parentElement as HTMLElement | null;
        if (!parent) return false;
        this.conversationContainer = parent;
      }
      // Persist auto-detected selector for future sessions when no explicit user override exists
      if (!userOverride && matchedSelector) {
        try {
          localStorage.setItem('geminiTimelineUserTurnSelectorAuto', matchedSelector);
        } catch {}
      }
      // If a stale user override failed (matchedSelector differs), clear it so we don't keep retrying it
      if (userOverride && matchedSelector && matchedSelector !== userOverride) {
        try {
          localStorage.removeItem('geminiTimelineUserTurnSelector');
        } catch {}
      }
    }
    this.navigation.setViewport(
      this.getScrollContainerForElement((firstTurn as HTMLElement) || this.conversationContainer),
    );
    return true;
  }

  private recalculateAndRenderMarkers = (): void => {
    if (
      this.destroyed ||
      !this.conversationContainer ||
      !this.view.ui.timelineBar ||
      !this.navigation.viewport ||
      !this.userTurnSelector
    )
      return;
    const userTurnNodeList = this.conversationContainer.querySelectorAll(this.userTurnSelector);
    if (userTurnNodeList.length === 0) {
      this.timestamps.update([], []);
      if (!this.zeroTurnsTimer) {
        this.zeroTurnsRetryCount++;
        // Empty-page polling with backoff: 200ms for the first 30 attempts,
        // then doubling per attempt, capped at 2s (avoids an unbounded fast loop).
        const delay =
          this.zeroTurnsRetryCount > 30
            ? Math.min(2000, 200 * 2 ** (this.zeroTurnsRetryCount - 30))
            : 200;
        this.zeroTurnsTimer = window.setTimeout(() => {
          this.zeroTurnsTimer = null;
          this.recalculateAndRenderMarkers();
        }, delay);
      }
      return;
    }
    if (this.zeroTurnsTimer) {
      clearTimeout(this.zeroTurnsTimer);
      this.zeroTurnsTimer = null;
    }
    this.zeroTurnsRetryCount = 0;

    const previousMarkers = this.state.markers;

    const nextMarkers = this.turns.collect(
      this.conversationContainer,
      this.userTurnSelector,
      previousMarkers,
    );
    if (nextMarkers.length === 0) return;
    const elements = nextMarkers.map((marker) => marker.element);
    this.view.markerTops = this.computeElementTopsInScrollContainer(elements);
    this.view.firstUserTurnOffset = elements[0].offsetTop;
    this.view.contentSpanPx = Math.max(
      1,
      elements[elements.length - 1].offsetTop - elements[0].offsetTop,
    );
    this.state.replaceMarkers(nextMarkers);
    this.timestamps.update(previousMarkers, nextMarkers);
    this.view.updateTimelineGeometry();
    if (!this.navigation.activeTurnId && this.state.markers.length > 0)
      this.navigation.activeTurnId = this.state.markers[this.state.markers.length - 1].id;
    this.updateIntersectionObserverTargetsFromMarkers();
    this.view.syncTimelineTrackToMain();
    this.view.updateVirtualRangeAndRender();
    this.view.updateActiveDotUI();
    this.navigation.scheduleScrollSync();
    this.view.updatePreviewMarkers();
  };

  private setupObservers(): void {
    if (this.destroyed) return;
    this.mutationObserver = new MutationObserver((records) => {
      if (this.shouldIgnoreSelfInjectedMutations(records)) return;
      this.debouncedRecalc();
    });
    if (this.conversationContainer)
      this.mutationObserver.observe(this.conversationContainer, { childList: true, subtree: true });

    this.intersectionObserver = new IntersectionObserver(
      () => {
        this.navigation.scheduleScrollSync();
      },
      { root: this.navigation.viewport, threshold: 0.1, rootMargin: '-40% 0px -59% 0px' },
    );
  }

  private clearSearchHighlights(): void {
    const cls = TimelineManager.SEARCH_HIGHLIGHT_CLASS;
    const marks = this.conversationContainer?.querySelectorAll(`mark.${cls}`);
    if (!marks) return;
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
      parent.normalize();
    });
    this.discardSelfHighlightMutationRecords();
  }

  private highlightSearchInDOM(query: string): void {
    this.clearSearchHighlights();
    if (!query || !this.conversationContainer) return;
    const lowerQuery = query.toLowerCase();
    for (const marker of this.state.markers) {
      if (!marker.element) continue;
      const walker = document.createTreeWalker(marker.element, NodeFilter.SHOW_TEXT);
      const matches: { node: Text; index: number }[] = [];
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const idx = node.textContent?.toLowerCase().indexOf(lowerQuery) ?? -1;
        if (idx !== -1) matches.push({ node, index: idx });
      }
      // Process in reverse to keep offsets stable
      for (let i = matches.length - 1; i >= 0; i--) {
        const { node: textNode, index: matchIdx } = matches[i];
        const after = textNode.splitText(matchIdx + query.length);
        const matchText = textNode.splitText(matchIdx);
        const mark = document.createElement('mark');
        mark.className = TimelineManager.SEARCH_HIGHLIGHT_CLASS;
        mark.textContent = matchText.textContent;
        matchText.parentNode!.replaceChild(mark, matchText);
        // keep reference to 'after' to avoid TS unused warning
        void after;
      }
    }
    this.discardSelfHighlightMutationRecords();
  }

  private buildTooltipText(dot: DotElement): string {
    let fullText = (dot.getAttribute('aria-label') || '').trim();
    const id = dot.dataset.targetTurnId || '';
    if (id && this.state.isMarkerStarred(id)) fullText = `★ ${fullText}`;

    const timestamp = this.timestamps.formatTooltipTimestamp(id);
    if (timestamp) fullText = timestamp + '\n' + fullText;
    return fullText;
  }

  private shouldAttemptRefreshForNavigation(): boolean {
    if (!this.userTurnSelector) return false;

    const documentCount = document.querySelectorAll(this.userTurnSelector).length;
    const containersDisconnected =
      (this.conversationContainer ? !this.conversationContainer.isConnected : true) ||
      (this.navigation.viewport ? !this.navigation.viewport.isConnected : true);

    return containersDisconnected || documentCount > this.state.markers.length;
  }

  private getScrollContainerForElement(element: HTMLElement): HTMLElement {
    let p: HTMLElement | null = element;
    while (p && p !== document.body) {
      const st = getComputedStyle(p);
      if (st.overflowY === 'auto' || st.overflowY === 'scroll') {
        return p;
      }
      p = p.parentElement;
    }

    return (
      (document.scrollingElement as HTMLElement | null) ||
      (document.documentElement as HTMLElement | null) ||
      (document.body as unknown as HTMLElement)
    );
  }

  private shouldRefreshForInteraction(targetElement: HTMLElement | null): boolean {
    // Avoid the document-wide marker count scan on the common path, but still
    // validate the nearest scroll container. Gemini can insert a new viewport
    // inside the old one while both the marker and old viewport remain
    // connected; treating connectivity as freshness writes scrollTop to the
    // wrong element and makes clicks and shortcuts appear inert.
    if (
      targetElement?.isConnected &&
      this.conversationContainer?.isConnected &&
      this.navigation.viewport?.isConnected &&
      this.conversationContainer.contains(targetElement) &&
      this.navigation.viewport.contains(targetElement)
    ) {
      return this.getScrollContainerForElement(targetElement) !== this.navigation.viewport;
    }

    if (this.shouldAttemptRefreshForNavigation()) return true;

    if (targetElement && !targetElement.isConnected) return true;

    if (
      targetElement &&
      this.conversationContainer &&
      !this.conversationContainer.contains(targetElement)
    ) {
      return true;
    }

    if (!targetElement || !this.navigation.viewport) return false;

    const expectedScrollContainer = this.getScrollContainerForElement(targetElement);
    return expectedScrollContainer !== this.navigation.viewport;
  }

  private maybeRefreshMarkersForInteraction(targetElement: HTMLElement | null): boolean {
    if (!this.userTurnSelector) return false;
    if (!this.shouldRefreshForInteraction(targetElement)) return false;

    const refreshed = this.refreshCriticalElementsFromDocument();
    if (!refreshed) return false;

    this.recalculateAndRenderMarkers();
    return true;
  }

  private maybeRefreshMarkersForNavigation(direction: 'previous' | 'next'): boolean {
    if (!this.userTurnSelector) return false;

    const currentIndex = this.navigation.getActiveIndex();
    const isAtStart = currentIndex === 0;
    const isAtEnd = currentIndex >= 0 && currentIndex === this.state.markers.length - 1;

    const shouldAttemptRefresh =
      (direction === 'previous' && isAtStart) || (direction === 'next' && isAtEnd);
    if (!shouldAttemptRefresh) return false;

    if (!this.shouldAttemptRefreshForNavigation()) return false;

    const refreshed = this.refreshCriticalElementsFromDocument();
    if (!refreshed) return false;

    this.recalculateAndRenderMarkers();
    return true;
  }

  private refreshCriticalElementsFromDocument(): boolean {
    if (!this.userTurnSelector) return false;

    const firstTurn = document.querySelector(this.userTurnSelector) as HTMLElement | null;
    if (!firstTurn) return false;

    const nextConversationContainer =
      (document.querySelector('main') as HTMLElement | null) || (document.body as HTMLElement);
    this.conversationContainer = nextConversationContainer;

    const nextScrollContainer = this.getScrollContainerForElement(firstTurn);

    this.navigation.setViewport(nextScrollContainer);

    if (this.mutationObserver && this.conversationContainer) {
      try {
        this.mutationObserver.disconnect();
        this.mutationObserver.observe(this.conversationContainer, {
          childList: true,
          subtree: true,
        });
      } catch {}
    }

    if (this.intersectionObserver && this.navigation.viewport) {
      try {
        this.intersectionObserver.disconnect();
        this.intersectionObserver = new IntersectionObserver(
          () => {
            this.navigation.scheduleScrollSync();
          },
          { root: this.navigation.viewport, threshold: 0.1, rootMargin: '-40% 0px -59% 0px' },
        );
      } catch {}
    }

    return true;
  }

  /**
   * True when every record was caused by the timeline's own DOM injections
   * (message timestamps or search-highlight marks). Those mutations must not
   * re-trigger a full marker recalc.
   */
  private shouldIgnoreSelfInjectedMutations(records: MutationRecord[]): boolean {
    if (records.length === 0) return false;

    return records.every((record) => {
      if (record.type !== 'childList') return false;

      const changedNodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
      if (changedNodes.length === 0) return false;

      return changedNodes.every((node) => this.isSelfInjectedMutationNode(node));
    });
  }

  private isSelfInjectedMutationNode(node: Node): boolean {
    if (node instanceof HTMLElement) {
      return (
        node.classList.contains('gv-timestamp') ||
        node.classList.contains(TimelineManager.SEARCH_HIGHLIGHT_CLASS) ||
        !!node.closest(`.gv-timestamp, .${TimelineManager.SEARCH_HIGHLIGHT_CLASS}`)
      );
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return !!node.parentElement?.closest(
        `.gv-timestamp, .${TimelineManager.SEARCH_HIGHLIGHT_CLASS}`,
      );
    }

    return false;
  }

  /**
   * Flush mutation records queued synchronously by the timeline's own search
   * highlight edits so they never reach the observer callback. Highlighting
   * splits text nodes inside message elements, so plain text-node changes are
   * treated as self-inflicted within this synchronous window only. Any foreign
   * (element-level) record found is re-dispatched to the debounced recalc.
   */
  private discardSelfHighlightMutationRecords(): void {
    if (!this.mutationObserver) return;
    const records = this.mutationObserver.takeRecords();
    if (records.length === 0) return;
    const hasForeign = records.some((record) => {
      if (record.type !== 'childList') return true;
      const changedNodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
      return changedNodes.some(
        (node) => node.nodeType !== Node.TEXT_NODE && !this.isSelfInjectedMutationNode(node),
      );
    });
    if (hasForeign) this.debouncedRecalc();
  }
}
