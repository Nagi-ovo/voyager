import { StorageKeys, type TimelineStyle } from '@/core/types/common';
import { hashString } from '@/core/utils/hash';
import { type Dispose, PluginScope } from '@/features/plugins/runtime/pluginScope';
import { setPluginSetting } from '@/features/plugins/storage/pluginState';
import type { PluginSettings } from '@/features/plugins/types';
import { StarredMessagesService } from '@/pages/content/timeline/StarredMessagesService';
import { TimelinePreviewPanel } from '@/pages/content/timeline/TimelinePreviewPanel';
import type { StarredMessage } from '@/pages/content/timeline/starredTypes';
import { showTimelineStyleCoachmark } from '@/pages/content/timeline/timelineStyleCoachmark';
import type { PreviewMarkerData } from '@/pages/content/timeline/types';
import { initI18n } from '@/utils/i18n';

// ponytail: one stable Claude selector; add fallbacks only when Claude actually breaks it.
const USER_MESSAGE_SELECTOR = '[data-testid="user-message"]';
const BAR_SELECTOR = '.gemini-timeline-bar[data-gv-claude-timeline="true"]';
const REFRESH_DELAY_MS = 120;
const LONG_PRESS_MS = 550;
const ACTIVE_ANCHOR = 0.45;
const NAVIGATION_ACTIVE_LOCK_MS = 900;
const TOOLTIP_DELAY_MS = 150;
const PENDING_NAVIGATION_TIMEOUT_MS = 8000;
const PENDING_NAVIGATION_HOP_MS = 200;
const LONG_JUMP_VIEWPORTS = 3;
const CLAUDE_TIMELINE_PLUGIN_ID = 'voyager.claude-timeline';
const CLAUDE_TIMELINE_COACHMARK_ID = 'claude-timeline-compact-style-intro-v1';
const COMPACT_VIEW_SETTING = 'compactView';

type Dot = HTMLButtonElement & {
  dataset: DOMStringMap & { targetTurnId?: string; markerIndex?: string };
};

// Claude virtualizes long conversations: only a sliding window of turns is
// mounted at any time, so the DOM is never the full conversation. Markers are
// therefore ACCUMULATED across refreshes (ids keyed by content hash, not mount
// index) and stitched into order via turns shared between overlapping windows.
interface Marker {
  id: string;
  hash: string;
  summary: string;
  starred: boolean;
  starredAt?: number;
  /** Last-seen element; disconnected once Claude virtualizes the turn out. */
  element: HTMLElement;
  /** Last-known center offset within the scroll target; reused while unmounted. */
  center: number;
  dotElement: Dot | null;
}

export function buildClaudeConversationId(input = location.href): string {
  try {
    const url = new URL(input, location.origin);
    const chatId = url.pathname.match(/^\/chat\/([^/?#]+)/)?.[1];
    return chatId
      ? `claude:conv:${chatId}`
      : `claude:${hashString(`${url.origin}${url.pathname}`)}`;
  } catch {
    return `claude:${hashString(String(input || ''))}`;
  }
}

export function buildClaudeTurnId(text: string): string {
  return `c-${hashString(text)}`;
}

/**
 * Content hash shared by every historical turn-id format:
 * legacy `c-<mountIndex>-<hash>`, current `c-<hash>` and `c-<hash>~<n>`.
 */
export function extractClaudeTurnHash(turnId: string): string {
  const base = turnId.split('~')[0];
  const segments = base.split('-');
  return segments[segments.length - 1] || base;
}

class ClaudeTimeline {
  private bar: HTMLElement | null = null;
  private trackContent: HTMLElement | null = null;
  private tooltip: HTMLElement | null = null;
  private previewPanel: TimelinePreviewPanel | null = null;
  private observing = false;
  private markers: Marker[] = [];
  private markerCenters: number[] = [];
  private conversationId = '';
  private starredByHash = new Map<string, { turnId: string; starredAt: number }>();
  private stopRefreshTimer: Dispose | null = null;
  private stopLongPressTimer: Dispose | null = null;
  private stopTooltipTimer: Dispose | null = null;
  private longPressDot: Dot | null = null;
  private suppressClickUntil = 0;
  private activeTurnId: string | null = null;
  private timelineStyle: TimelineStyle = 'dots';
  private navigationActiveLockUntil = 0;
  private pendingNavigationId: string | null = null;
  private pendingNavigationUntil = 0;
  private stopPendingNavigationTimer: Dispose | null = null;
  private stopUserScrollListeners: Dispose[] = [];
  private pendingNavigationLo = 0;
  private pendingNavigationHi = 0;
  private pendingNavigationProbed = false;
  private lastHandledHash: string | null = null;
  private scrollTarget: HTMLElement | Window | null = null;
  private stopScrollListener: Dispose | null = null;

  constructor(private readonly scope: PluginScope) {}

  private get disposed(): boolean {
    return this.scope.isDisposed;
  }

  async start(settings: PluginSettings = {}): Promise<void> {
    this.updateSettings(settings);
    // Markers stamp `data-gv-claude-turn-id` onto Claude's own turn nodes;
    // roll every stamp back when the plugin unmounts.
    this.scope.effect(
      () => () =>
        document
          .querySelectorAll('[data-gv-claude-turn-id]')
          .forEach((element) => element.removeAttribute('data-gv-claude-turn-id')),
      'turn-id-attrs',
    );
    await initI18n().catch(() => {});
    if (this.disposed) return;
    this.ensureUi();
    await this.refresh();
    if (this.disposed) return;
    this.observe();
    this.scope.on(window, 'hashchange', this.handleHash);
    this.scope.on(window, 'resize', this.handleResize);
    this.maybeShowStyleCoachmark();
  }

  updateSettings(settings: PluginSettings): void {
    const nextStyle: TimelineStyle = settings[COMPACT_VIEW_SETTING] === true ? 'compact' : 'dots';
    const changed = this.timelineStyle !== nextStyle;
    this.timelineStyle = nextStyle;
    this.applyTimelineStyle();
    if (changed && this.markers.length > 0) this.renderDots();
  }

  private maybeShowStyleCoachmark(): void {
    if (this.disposed || this.timelineStyle === 'compact') return;
    void showTimelineStyleCoachmark({
      id: CLAUDE_TIMELINE_COACHMARK_ID,
      enabled: false,
      // A disposed scope aborts the signal, closing an in-flight guide.
      signal: this.scope.signal,
      onStyleChange: async (compact) => {
        if (this.disposed) return;
        this.updateSettings({ [COMPACT_VIEW_SETTING]: compact });
        await setPluginSetting(CLAUDE_TIMELINE_PLUGIN_ID, COMPACT_VIEW_SETTING, compact);
      },
    });
  }

  private observe(): void {
    if (!document.body || this.observing) return;
    this.observing = true;
    this.scope.observe(document.body, { childList: true, subtree: true }, (records) => {
      if (!records.some((record) => this.shouldRefreshForMutation(record))) return;
      this.scheduleRefresh();
    });

    if (chrome.storage?.onChanged) {
      this.scope.onChromeEvent(
        chrome.storage.onChanged,
        (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
          if (areaName !== 'local' || !changes[StorageKeys.TIMELINE_STARRED_MESSAGES]) return;
          void this.loadStars(true).then(() => this.applyStarredState());
        },
      );
    }
  }

  private isOwnMutation(record: MutationRecord): boolean {
    const nodes = [
      record.target,
      ...Array.from(record.addedNodes),
      ...Array.from(record.removedNodes),
    ];
    return nodes.every((node) => {
      const element =
        node instanceof window.Element
          ? node
          : node.parentElement instanceof window.Element
            ? node.parentElement
            : null;
      return !!element?.closest(
        '[data-gv-claude-timeline="true"], .timeline-preview-panel, .timeline-preview-toggle',
      );
    });
  }

  private shouldRefreshForMutation(record: MutationRecord): boolean {
    if (this.isOwnMutation(record)) return false;
    return (
      !!this.toElement(record.target)?.closest(USER_MESSAGE_SELECTOR) ||
      [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some((node) =>
        this.touchesTurn(node),
      )
    );
  }

  private touchesTurn(node: Node): boolean {
    const element = this.toElement(node);
    return !!(
      element?.closest(USER_MESSAGE_SELECTOR) || element?.querySelector?.(USER_MESSAGE_SELECTOR)
    );
  }

  private toElement(node: Node): Element | null {
    return node instanceof window.Element
      ? node
      : node.parentElement instanceof window.Element
        ? node.parentElement
        : null;
  }

  private ensureUi(): void {
    let bar = document.querySelector(BAR_SELECTOR) as HTMLElement | null;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'gemini-timeline-bar';
      bar.dataset.gvClaudeTimeline = 'true';
      const track = document.createElement('div');
      track.className = 'timeline-track';
      const content = document.createElement('div');
      content.className = 'timeline-track-content';
      track.appendChild(content);
      bar.appendChild(track);
      this.scope.mount(bar, document.body);
    }
    this.bar = bar;
    this.trackContent = bar.querySelector('.timeline-track-content') as HTMLElement | null;
    if (!this.tooltip) {
      const tooltip = document.createElement('div');
      tooltip.id = 'claude-timeline-tooltip';
      tooltip.className = 'timeline-tooltip';
      tooltip.setAttribute('aria-hidden', 'true');
      const text = document.createElement('div');
      text.className = 'claude-timeline-tooltip-text';
      tooltip.appendChild(text);
      this.scope.mount(tooltip, document.body);
      this.tooltip = tooltip;
    }
    if (!this.previewPanel) {
      this.previewPanel = new TimelinePreviewPanel(bar);
      this.previewPanel.init(
        (turnId) => this.navigateTo(turnId),
        undefined,
        (turnId) => this.toggleStar(turnId),
      );
      // The panel manages its own timers/listeners/DOM; adopt its destroy().
      this.scope.child(this.previewPanel, 'preview-panel');
    }
    this.applyTimelineStyle();
  }

  private applyTimelineStyle(): void {
    if (!this.bar) return;
    const compact = this.timelineStyle === 'compact';
    this.bar.classList.toggle('timeline-style-compact', compact);
    const track = this.trackContent?.parentElement;
    if (compact) {
      track?.setAttribute('aria-hidden', 'true');
      this.hideTooltip();
    } else {
      track?.removeAttribute('aria-hidden');
    }
    this.previewPanel?.setCompactMode(compact);
  }

  private scheduleRefresh(): void {
    if (this.disposed) return;
    void this.stopRefreshTimer?.();
    this.stopRefreshTimer = this.scope.timer(() => {
      this.stopRefreshTimer = null;
      void this.refresh();
    }, REFRESH_DELAY_MS);
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    this.ensureUi();
    if (buildClaudeConversationId() !== this.conversationId) this.resetConversationState();
    await this.loadStars();
    if (this.disposed) return;
    const previousIds = this.markers.map((marker) => marker.id);
    const turns = Array.from(document.querySelectorAll<HTMLElement>(USER_MESSAGE_SELECTOR));
    if (turns[0]) this.setScrollTarget(this.getScrollTarget(turns[0]));
    this.markers = this.mergeMountedTurns(turns);
    this.markerCenters = this.computeMarkerCenters();
    const sameMarkers =
      previousIds.length === this.markers.length &&
      previousIds.every((id, index) => id === this.markers[index]?.id);
    if (!sameMarkers || this.markers.some((marker) => !marker.dotElement)) this.renderDots();
    this.applyStarredState();
    this.refreshActive();
    this.handleHash();
  }

  private resetConversationState(): void {
    this.markers = [];
    this.markerCenters = [];
    this.activeTurnId = null;
    this.clearPendingNavigation();
    this.lastHandledHash = null;
    if (this.trackContent) this.trackContent.textContent = '';
  }

  /**
   * Stitch the currently mounted turns into the accumulated marker list.
   * Mounted turns are anchored to known markers by content hash (order
   * preserving) and new turns are woven in next to their anchors. Known turns
   * are NEVER dropped: Claude's virtualization can mount sparse,
   * non-contiguous windows mid-transition (old and new window briefly
   * coexisting), so a missing turn only means "not mounted right now", not
   * "deleted" — mirroring the Gemini timeline's grow-only behaviour.
   */
  private mergeMountedTurns(turns: HTMLElement[]): Marker[] {
    const known = this.markers;
    const mounted = turns.map((element) => {
      const summary = this.extractText(element);
      return { element, summary, hash: hashString(summary) };
    });
    if (!mounted.length) return known;

    const matchedKnownIndex = new Array<number>(mounted.length).fill(-1);
    let searchFrom = 0;
    for (let i = 0; i < mounted.length; i++) {
      for (let j = searchFrom; j < known.length; j++) {
        if (known[j].hash === mounted[i].hash) {
          matchedKnownIndex[i] = j;
          searchFrom = j + 1;
          break;
        }
      }
    }

    const usedIds = new Set(known.map((marker) => marker.id));
    const createMarker = (entry: (typeof mounted)[number]): Marker => {
      const id = this.claimTurnId(entry.hash, usedIds);
      entry.element.dataset.gvClaudeTurnId = id;
      return {
        id,
        hash: entry.hash,
        summary: entry.summary,
        starred: false,
        element: entry.element,
        center: this.computeElementCenter(entry.element),
        dotElement: null,
      };
    };

    const firstMatch = matchedKnownIndex.findIndex((index) => index >= 0);
    if (firstMatch === -1) {
      // Jumped into an unexplored region: place the whole block by its
      // vertical position relative to the accumulated turns.
      const fresh = mounted.map(createMarker);
      const insertAt = known.findIndex((marker) => marker.center > fresh[0].center);
      return insertAt === -1
        ? [...known, ...fresh]
        : [...known.slice(0, insertAt), ...fresh, ...known.slice(insertAt)];
    }

    const beforeFirstAnchor: Marker[] = [];
    const afterKnownIndex = new Map<number, Marker[]>();
    let lastAnchor = -1;
    for (let i = 0; i < mounted.length; i++) {
      const knownIndex = matchedKnownIndex[i];
      if (knownIndex >= 0) {
        const survivor = known[knownIndex];
        survivor.element = mounted[i].element;
        survivor.summary = mounted[i].summary;
        mounted[i].element.dataset.gvClaudeTurnId = survivor.id;
        lastAnchor = knownIndex;
        continue;
      }
      const marker = createMarker(mounted[i]);
      if (lastAnchor === -1) {
        beforeFirstAnchor.push(marker);
      } else {
        const bucket = afterKnownIndex.get(lastAnchor);
        if (bucket) bucket.push(marker);
        else afterKnownIndex.set(lastAnchor, [marker]);
      }
    }

    const firstAnchorKnownIndex = matchedKnownIndex[firstMatch];
    const result: Marker[] = [];
    known.forEach((marker, index) => {
      if (index === firstAnchorKnownIndex) result.push(...beforeFirstAnchor);
      result.push(marker);
      const extras = afterKnownIndex.get(index);
      if (extras) result.push(...extras);
    });
    return result;
  }

  private claimTurnId(hash: string, usedIds: Set<string>): string {
    const base = `c-${hash}`;
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}~${n}`;
    usedIds.add(id);
    return id;
  }

  private async loadStars(force = false): Promise<void> {
    const nextConversationId = buildClaudeConversationId();
    if (!force && nextConversationId === this.conversationId) return;
    this.conversationId = nextConversationId;
    const messages = await StarredMessagesService.getStarredMessagesForConversation(
      this.conversationId,
    );
    this.starredByHash = new Map(
      messages.map((message) => [
        extractClaudeTurnHash(message.turnId),
        { turnId: message.turnId, starredAt: message.starredAt },
      ]),
    );
  }

  private renderDots(): void {
    if (!this.trackContent) return;
    this.trackContent.textContent = '';
    const last = Math.max(1, this.markers.length - 1);
    const compactOffsets = this.buildCompactMarkerOffsets();
    this.markers.forEach((marker, index) => {
      const dot = document.createElement('button') as Dot;
      dot.className = 'timeline-dot';
      dot.type = 'button';
      dot.dataset.targetTurnId = marker.id;
      dot.dataset.markerIndex = String(index);
      if (this.timelineStyle === 'compact') {
        dot.style.setProperty('--timeline-compact-offset', `${compactOffsets[index] ?? 0}px`);
      } else {
        dot.style.setProperty('--n', String(this.markers.length === 1 ? 0.5 : index / last));
      }
      dot.setAttribute('aria-label', marker.summary || `Message ${index + 1}`);
      dot.setAttribute('aria-pressed', marker.starred ? 'true' : 'false');
      dot.setAttribute('aria-current', marker.id === this.activeTurnId ? 'true' : 'false');
      dot.classList.toggle('starred', marker.starred);
      dot.classList.toggle('active', marker.id === this.activeTurnId);
      dot.addEventListener('click', (event) => {
        if (Date.now() < this.suppressClickUntil) {
          event.preventDefault();
          return;
        }
        this.navigateTo(marker.id);
      });
      dot.addEventListener('pointerdown', () => this.startLongPress(dot));
      dot.addEventListener('pointerup', () => this.cancelLongPress());
      dot.addEventListener('pointercancel', () => this.cancelLongPress());
      dot.addEventListener('pointerenter', () => this.scheduleTooltip(dot));
      dot.addEventListener('pointerleave', () => {
        this.cancelLongPress();
        this.hideTooltip();
      });
      dot.addEventListener('focus', () => this.showTooltip(dot));
      dot.addEventListener('blur', () => this.hideTooltip());
      marker.dotElement = dot;
      this.trackContent!.appendChild(dot);
    });
  }

  private buildCompactMarkerOffsets(): number[] {
    const count = this.markers.length;
    if (count === 0) return [];
    const gap = count > 1 ? Math.min(10, 240 / (count - 1)) : 0;
    const center = (count - 1) / 2;
    return this.markers.map((_, index) => (index - center) * gap);
  }

  private startLongPress(dot: Dot): void {
    this.cancelLongPress();
    if (this.disposed) return;
    this.longPressDot = dot;
    dot.classList.add('holding');
    this.stopLongPressTimer = this.scope.timer(() => {
      this.stopLongPressTimer = null;
      this.suppressClickUntil = Date.now() + 350;
      const id = dot.dataset.targetTurnId;
      if (id) void this.toggleStar(id);
      this.cancelLongPress();
    }, LONG_PRESS_MS);
  }

  private cancelLongPress(): void {
    void this.stopLongPressTimer?.();
    this.stopLongPressTimer = null;
    this.longPressDot?.classList.remove('holding');
    this.longPressDot = null;
  }

  private async toggleStar(turnId: string): Promise<void> {
    const marker = this.markers.find((item) => item.id === turnId);
    if (!marker) return;
    const existing = this.starredByHash.get(marker.hash);
    if (existing) {
      this.starredByHash.delete(marker.hash);
      // Remove by the stored id, which may still be in the legacy format.
      await StarredMessagesService.removeStarredMessage(this.conversationId, existing.turnId);
    } else {
      const starredAt = Date.now();
      this.starredByHash.set(marker.hash, { turnId: marker.id, starredAt });
      const message: StarredMessage = {
        turnId: marker.id,
        content: marker.summary,
        conversationId: this.conversationId,
        conversationUrl: location.href.split('#')[0],
        conversationTitle: this.getTitle(),
        starredAt,
      };
      await StarredMessagesService.addStarredMessage(message);
    }
    this.applyStarredState();
  }

  private applyStarredState(): void {
    this.markers.forEach((marker) => {
      const entry = this.starredByHash.get(marker.hash);
      marker.starred = !!entry;
      marker.starredAt = entry?.starredAt;
      marker.dotElement?.classList.toggle('starred', marker.starred);
      marker.dotElement?.setAttribute('aria-pressed', marker.starred ? 'true' : 'false');
    });
    this.updatePreview();
  }

  private updatePreview(): void {
    const previewMarkers: PreviewMarkerData[] = this.markers.map((marker, index) => ({
      id: marker.id,
      summary: marker.summary,
      index,
      starred: marker.starred,
      starredAt: marker.starredAt,
    }));
    this.previewPanel?.updateMarkers(previewMarkers);
    this.previewPanel?.updateActiveTurn(this.activeTurnId);
  }

  private setActiveTurn(turnId: string | null): void {
    if (this.activeTurnId === turnId) return;
    const previousTurnId = this.activeTurnId;
    this.activeTurnId = turnId;
    this.updateDotActive(previousTurnId, false);
    this.updateDotActive(turnId, true);
    this.previewPanel?.updateActiveTurn(turnId);
  }

  private updateDotActive(turnId: string | null, active: boolean): void {
    const dot = this.markers.find((marker) => marker.id === turnId)?.dotElement;
    dot?.classList.toggle('active', active);
    dot?.setAttribute('aria-current', active ? 'true' : 'false');
  }

  private scheduleTooltip(dot: Dot): void {
    if (this.disposed) return;
    void this.stopTooltipTimer?.();
    this.stopTooltipTimer = this.scope.timer(() => {
      this.stopTooltipTimer = null;
      this.showTooltip(dot);
    }, TOOLTIP_DELAY_MS);
  }

  private showTooltip(dot: Dot): void {
    if (!this.tooltip || !dot.isConnected) return;
    const marker = this.markers.find((item) => item.id === dot.dataset.targetTurnId);
    if (!marker?.summary) return;

    this.getTooltipTextElement().textContent = `${marker.starred ? '★ ' : ''}${marker.summary}`;
    this.tooltip.setAttribute('dir', 'auto');
    this.tooltip.setAttribute('aria-hidden', 'false');
    this.tooltip.style.width = 'min(288px, calc(100vw - 32px))';

    const rect = dot.getBoundingClientRect();
    const gap = 18;
    const tooltipWidth = this.tooltip.offsetWidth || 288;
    const tooltipHeight = this.tooltip.offsetHeight || 78;
    const leftPlacement = rect.left > window.innerWidth / 2;
    const left = leftPlacement ? rect.left - gap - tooltipWidth : rect.right + gap;
    const top = Math.max(
      8,
      Math.min(
        window.innerHeight - tooltipHeight - 8,
        rect.top + rect.height / 2 - tooltipHeight / 2,
      ),
    );
    this.tooltip.style.left = `${Math.max(8, Math.round(left))}px`;
    this.tooltip.style.top = `${Math.round(top)}px`;
    this.tooltip.setAttribute('data-placement', leftPlacement ? 'left' : 'right');
    this.tooltip.classList.add('visible');
  }

  private hideTooltip(): void {
    void this.stopTooltipTimer?.();
    this.stopTooltipTimer = null;
    this.tooltip?.classList.remove('visible');
    this.tooltip?.setAttribute('aria-hidden', 'true');
  }

  private getTooltipTextElement(): HTMLElement {
    return (this.tooltip?.firstElementChild as HTMLElement | null) ?? this.tooltip!;
  }

  private refreshActive(): void {
    if (this.activeTurnId && this.markers.some((marker) => marker.id === this.activeTurnId)) {
      this.updateDotActive(this.activeTurnId, true);
      return;
    }
    this.updateActiveFromScroll();
  }

  private updateActiveFromScroll = (): void => {
    if (!this.markers.length) {
      this.setActiveTurn(null);
      return;
    }
    if (Date.now() < this.navigationActiveLockUntil) return;
    if (this.isAtScrollBottom()) {
      this.setActiveTurn(this.markers[this.markers.length - 1]?.id ?? null);
      return;
    }
    const ref = this.getScrollTop() + this.getViewportHeight() * ACTIVE_ANCHOR;
    let low = 0;
    let high = this.markerCenters.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.markerCenters[mid] <= ref) low = mid + 1;
      else high = mid;
    }
    const previous = Math.max(0, low - 1);
    const next = Math.min(this.markerCenters.length - 1, low);
    const index =
      Math.abs(this.markerCenters[next] - ref) < Math.abs(this.markerCenters[previous] - ref)
        ? next
        : previous;
    this.setActiveTurn(this.markers[index]?.id ?? null);
  };

  private setScrollTarget(target: HTMLElement | Window | null): void {
    if (this.scrollTarget === target) return;
    void this.stopScrollListener?.();
    this.stopScrollListener = null;
    this.scrollTarget = target;
    if (target && !this.disposed) {
      this.stopScrollListener = this.scope.on(target, 'scroll', this.updateActiveFromScroll, {
        passive: true,
      });
    }
  }

  private findMarker(turnId: string): Marker | undefined {
    return (
      this.markers.find((item) => item.id === turnId) ??
      this.markers.find((item) => item.hash === extractClaudeTurnHash(turnId))
    );
  }

  private navigateTo(turnId: string): void {
    const marker = this.findMarker(turnId);
    if (!marker) return;
    this.navigationActiveLockUntil = Date.now() + NAVIGATION_ACTIVE_LOCK_MS;
    this.setActiveTurn(marker.id);
    if (marker.element.isConnected) {
      const center = this.computeElementCenter(marker.element);
      const anchorOffset = this.getViewportHeight() * ACTIVE_ANCHOR;
      const distance = Math.abs(center - (this.getScrollTop() + anchorOffset));
      if (distance <= this.getViewportHeight() * LONG_JUMP_VIEWPORTS) {
        this.clearPendingNavigation();
        this.scrollMarkerIntoView(marker.element);
        return;
      }
      // Long jump to a mounted turn: smooth-scrolling across a virtualized
      // conversation drifts as Claude re-measures content mid-flight — jump
      // instantly, then let the homing loop fine-aim once the region settles.
      this.beginPendingNavigation(marker);
      this.pendingNavigationProbed = true;
      this.scrollToOffset(center, 'auto');
      this.schedulePendingNavigationHop();
      return;
    }
    // Virtualized out: the remembered offset is only an estimate (Claude
    // re-measures content as it mounts), so home in iteratively instead of
    // trusting a single jump.
    this.beginPendingNavigation(marker);
    this.homePendingNavigation();
  }

  private beginPendingNavigation(marker: Marker): void {
    this.clearPendingNavigation();
    this.pendingNavigationId = marker.id;
    this.pendingNavigationUntil = Date.now() + PENDING_NAVIGATION_TIMEOUT_MS;
    this.pendingNavigationLo = 0;
    this.pendingNavigationHi = Math.max(
      this.getScrollHeight(),
      marker.center + this.getViewportHeight(),
    );
    this.pendingNavigationProbed = false;
    if (this.disposed) return;
    this.stopUserScrollListeners = [
      this.scope.on(window, 'wheel', this.cancelPendingNavigationOnUserScroll, { passive: true }),
      this.scope.on(window, 'touchmove', this.cancelPendingNavigationOnUserScroll, {
        passive: true,
      }),
    ];
  }

  private clearPendingNavigation(): void {
    this.pendingNavigationId = null;
    void this.stopPendingNavigationTimer?.();
    this.stopPendingNavigationTimer = null;
    for (const stop of this.stopUserScrollListeners.splice(0)) void stop();
  }

  private cancelPendingNavigationOnUserScroll = (): void => {
    this.clearPendingNavigation();
  };

  /**
   * One homing step toward a virtualized-out turn: bisect on the target's
   * position (bounds tightened from which side of the mounted window the turn
   * sits on), jump instantly, and let Claude mount content at the landing
   * point. Once the turn's element is back in the DOM, aim precisely.
   */
  private homePendingNavigation = (): void => {
    this.stopPendingNavigationTimer = null;
    if (!this.pendingNavigationId || this.disposed) return;
    if (Date.now() > this.pendingNavigationUntil) {
      this.clearPendingNavigation();
      return;
    }
    const marker = this.markers.find((item) => item.id === this.pendingNavigationId);
    if (!marker) {
      this.clearPendingNavigation();
      return;
    }
    this.navigationActiveLockUntil = Date.now() + NAVIGATION_ACTIVE_LOCK_MS;
    if (marker.element.isConnected) {
      this.clearPendingNavigation();
      this.scrollMarkerIntoView(marker.element);
      return;
    }
    const mountedIndexes = this.markers.reduce<number[]>((acc, item, index) => {
      if (item.element.isConnected) acc.push(index);
      return acc;
    }, []);
    if (mountedIndexes.length) {
      // Direction info is only trustworthy once the mounted window has caught
      // up with the last jump; otherwise wait a tick instead of moving.
      const windowCurrent = mountedIndexes.some((index) =>
        this.isElementInViewport(this.markers[index].element),
      );
      if (!windowCurrent) {
        this.schedulePendingNavigationHop();
        return;
      }
      const targetIndex = this.markers.indexOf(marker);
      const firstMounted = mountedIndexes[0];
      const lastMounted = mountedIndexes[mountedIndexes.length - 1];
      if (targetIndex < firstMounted) {
        this.pendingNavigationHi = Math.min(this.pendingNavigationHi, this.getScrollTop());
      } else if (targetIndex > lastMounted) {
        this.pendingNavigationLo = Math.max(
          this.pendingNavigationLo,
          this.getScrollTop() + this.getViewportHeight(),
        );
      } else {
        // Inside a virtualization gap: bracket the target between its nearest
        // mounted neighbours. (A truly deleted turn collapses the bracket and
        // ends the search below.)
        let beforeIndex = -1;
        let afterIndex = -1;
        for (const index of mountedIndexes) {
          if (index < targetIndex) beforeIndex = index;
          else if (index > targetIndex) {
            afterIndex = index;
            break;
          }
        }
        if (beforeIndex >= 0) {
          this.pendingNavigationLo = Math.max(
            this.pendingNavigationLo,
            this.computeElementCenter(this.markers[beforeIndex].element),
          );
        }
        if (afterIndex >= 0) {
          this.pendingNavigationHi = Math.min(
            this.pendingNavigationHi,
            this.computeElementCenter(this.markers[afterIndex].element),
          );
        }
      }
    }
    if (this.pendingNavigationHi - this.pendingNavigationLo < 1) {
      this.clearPendingNavigation();
      return;
    }
    const staleCenterUsable =
      !this.pendingNavigationProbed &&
      marker.center > this.pendingNavigationLo &&
      marker.center < this.pendingNavigationHi;
    const probe = staleCenterUsable
      ? marker.center
      : (this.pendingNavigationLo + this.pendingNavigationHi) / 2;
    this.pendingNavigationProbed = true;
    this.scrollToOffset(probe, 'auto');
    this.schedulePendingNavigationHop();
  };

  private schedulePendingNavigationHop(): void {
    if (this.stopPendingNavigationTimer !== null || this.disposed) return;
    this.stopPendingNavigationTimer = this.scope.timer(
      this.homePendingNavigation,
      PENDING_NAVIGATION_HOP_MS,
    );
  }

  private isElementInViewport(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const top = this.getViewportTop();
    const bottom = top + this.getViewportHeight();
    return rect.bottom >= top && rect.top <= bottom;
  }

  private handleHash = (): void => {
    const hash = location.hash;
    if (!hash.startsWith('#gv-turn-') || hash === this.lastHandledHash) return;
    const turnId = decodeURIComponent(hash.slice('#gv-turn-'.length));
    if (!turnId) return;
    const marker = this.findMarker(turnId);
    // Not discovered yet (virtualized out and never mounted): leave the hash
    // unconsumed so later refreshes retry once the turn appears.
    if (!marker) return;
    this.lastHandledHash = hash;
    this.navigateTo(marker.id);
  };

  private handleResize = (): void => {
    this.scheduleRefresh();
    this.previewPanel?.reposition();
  };

  private extractText(element: HTMLElement): string {
    return (element.textContent || '').replace(/\s+/g, ' ').trim();
  }

  private getTitle(): string {
    const title = document.title.replace(/\s*[|-]\s*Claude.*$/i, '').trim();
    return title || this.markers[0]?.summary.slice(0, 50) || 'Claude conversation';
  }

  private getScrollTarget(element: HTMLElement): HTMLElement | Window {
    for (let parent = element.parentElement; parent && parent !== document.body; ) {
      const style = getComputedStyle(parent);
      if (
        /(auto|scroll|overlay)/.test(style.overflowY) &&
        parent.scrollHeight > parent.clientHeight
      )
        return parent;
      parent = parent.parentElement;
    }
    return window;
  }

  private computeMarkerCenters(): number[] {
    const scrollTop = this.getScrollTop();
    const viewportTop = this.getViewportTop();
    const centers: number[] = [];
    for (const marker of this.markers) {
      if (marker.element.isConnected) {
        marker.center = this.computeElementCenter(marker.element, scrollTop, viewportTop);
      }
      // Keep the array monotonic for the active-turn binary search: stale
      // centers of virtualized-out turns can lag behind re-measured neighbours.
      const previous = centers[centers.length - 1];
      centers.push(previous !== undefined && marker.center < previous ? previous : marker.center);
    }
    return centers;
  }

  private computeElementCenter(
    element: HTMLElement,
    scrollTop = this.getScrollTop(),
    viewportTop = this.getViewportTop(),
  ): number {
    const rect = element.getBoundingClientRect();
    return scrollTop + rect.top - viewportTop + rect.height / 2;
  }

  private getViewportTop(): number {
    return this.scrollTarget && this.scrollTarget !== window
      ? (this.scrollTarget as HTMLElement).getBoundingClientRect().top
      : 0;
  }

  private getScrollTop(): number {
    return this.scrollTarget && this.scrollTarget !== window
      ? (this.scrollTarget as HTMLElement).scrollTop
      : window.scrollY || document.documentElement.scrollTop || 0;
  }

  private getViewportHeight(): number {
    return this.scrollTarget && this.scrollTarget !== window
      ? (this.scrollTarget as HTMLElement).clientHeight
      : window.innerHeight || document.documentElement.clientHeight || 0;
  }

  private getScrollHeight(): number {
    return this.scrollTarget && this.scrollTarget !== window
      ? (this.scrollTarget as HTMLElement).scrollHeight
      : (document.scrollingElement || document.documentElement).scrollHeight;
  }

  private isAtScrollBottom(): boolean {
    const viewportHeight = this.getViewportHeight();
    const scrollHeight = this.getScrollHeight();
    return (
      scrollHeight > viewportHeight && this.getScrollTop() + viewportHeight >= scrollHeight - 2
    );
  }

  private scrollToOffset(center: number, behavior: ScrollBehavior = 'smooth'): void {
    const top = Math.max(0, center - this.getViewportHeight() * ACTIVE_ANCHOR);
    const target = this.scrollTarget;
    if (!target || target === window) {
      window.scrollTo({ top, behavior });
      return;
    }
    const container = target as HTMLElement;
    if (container.scrollTo) container.scrollTo({ top, behavior });
    else container.scrollTop = top;
  }

  private scrollMarkerIntoView(element: HTMLElement): void {
    const target = this.getScrollTarget(element);
    const rect = element.getBoundingClientRect();
    if (target === window) {
      const top =
        this.getScrollTop() + rect.top + rect.height / 2 - this.getViewportHeight() * ACTIVE_ANCHOR;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      return;
    }
    const container = target as HTMLElement;
    const containerRect = container.getBoundingClientRect();
    const top =
      container.scrollTop +
      rect.top -
      containerRect.top -
      container.clientHeight * ACTIVE_ANCHOR +
      rect.height / 2;
    if (container.scrollTo) container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    else container.scrollTop = Math.max(0, top);
  }
}

let instance: ClaudeTimeline | null = null;
/** Scope owned by the legacy start/stop wrappers (tests + non-engine callers). */
let standaloneScope: PluginScope | null = null;

/** Native lifecycle for the voyager.claude-timeline builtin plugin. */
export function activateClaudeTimeline(scope: PluginScope, settings: PluginSettings = {}): void {
  const timeline = new ClaudeTimeline(scope);
  instance = timeline;
  scope.effect(() => {
    return () => {
      if (instance === timeline) instance = null;
    };
  }, 'instance');
  // Startup registers as a pending effect: dispose() barriers on it, and a
  // mid-startup unmount is handled by the scope instead of a destroyed flag.
  scope.effect(() => timeline.start(settings).then(() => () => {}), 'claude-timeline-start');
}

/** Fine-grained settings path — keeps grow-only markers and rail DOM intact. */
export function updateClaudeTimelineSettings(settings: PluginSettings): void {
  instance?.updateSettings(settings);
}

export function startClaudeTimeline(settings: PluginSettings = {}): void {
  if (instance) {
    instance.updateSettings(settings);
    return;
  }
  standaloneScope = new PluginScope();
  activateClaudeTimeline(standaloneScope, settings);
}

export function stopClaudeTimeline(): Promise<void> {
  const disposal = standaloneScope?.dispose() ?? Promise.resolve();
  standaloneScope = null;
  return disposal;
}
