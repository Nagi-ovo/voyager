import { StorageKeys, type TimelineStyle } from '@/core/types/common';
import { type Dispose, PluginScope } from '@/features/plugins/runtime/pluginScope';
import {
  CHATGPT_TURN_SHELL_SELECTOR,
  classifyChatGptScrollTarget,
  collectChatGptTurnShells,
  findChatGptChatScrollRoot,
  getChatGptRouteChange,
} from '@/features/plugins/sites/chatgptDom';
import type { PluginSettings } from '@/features/plugins/types';
import { StarredMessagesService } from '@/pages/content/timeline/StarredMessagesService';
import { TimelinePreviewPanel } from '@/pages/content/timeline/TimelinePreviewPanel';
import type { StarredMessage } from '@/pages/content/timeline/starredTypes';
import type { PreviewMarkerData } from '@/pages/content/timeline/types';
import { watchRouteChanges } from '@/pages/content/utils/routeWatcher';
import { initI18n } from '@/utils/i18n';

import { ChatGptTimelineMarkerInteractions } from './ChatGptTimelineMarkerInteractions';
import { CHATGPT_TIMELINE_TRACK_PADDING_PX, calculateChatGptTimelineGeometry } from './geometry';
import {
  buildChatGptTimelineConversationId,
  buildChatGptTimelineStarTurnId,
  extractChatGptTimelineStarTurnId,
  isChatGptDraftPromotion,
} from './identity';
import { ChatGptTimelineRegistry, type ChatGptTimelineTurn } from './registry';
import { CHATGPT_TIMELINE_CSS, CHATGPT_TIMELINE_ROOT_CLASS } from './styles';

const BAR_SELECTOR = '.gemini-timeline-bar[data-gv-chatgpt-timeline="true"]';
const OWN_UI_SELECTOR =
  '[data-gv-chatgpt-timeline="true"], #gv-chatgpt-timeline-tooltip, .timeline-preview-panel, .timeline-preview-toggle, .gv-timeline-preview-hover-bridge';
const COMPACT_VIEW_SETTING = 'compactView';
const REFRESH_DELAY_MS = 120;
const ROUTE_TRANSITION_REPLACEMENT_WINDOW_MS = 30_000;
const ACTIVE_ANCHOR = 0.45;
const COMPACT_MAX_SPAN_PX = 160;
const COMPACT_MAX_GAP_PX = 8;
const NAVIGATION_LOCK_MS = 900;
const NAVIGATION_TIMEOUT_MS = 8000;
const NAVIGATION_HOP_MS = 200;
const LONG_JUMP_VIEWPORTS = 3;
const ANCHOR_TOLERANCE_PX = 8;

type Dot = HTMLButtonElement & {
  dataset: DOMStringMap & { targetTurnId?: string; markerIndex?: string };
};

interface StarState {
  persistedTurnId: string;
  starredAt: number;
}

interface RouteTransition {
  readonly generation: number;
  readonly targetConversationId: string;
  readonly turnIdsByRoute: Map<string, Set<string>>;
  readonly sourceTurnIds: Set<string>;
  candidateTurnIds: string[] | null;
  acceptedTurnIds: Set<string> | null;
  userNavigated: boolean;
  readonly expiresAt: number;
}

export class ChatGptTimeline {
  private readonly registry = new ChatGptTimelineRegistry();
  private readonly dotsById = new Map<string, Dot>();
  private bar: HTMLElement | null = null;
  private track: HTMLElement | null = null;
  private trackContent: HTMLElement | null = null;
  private previewPanel: TimelinePreviewPanel | null = null;
  private markers: ChatGptTimelineTurn[] = [];
  private markerCenters: number[] = [];
  private timelineContentHeight = 0;
  private geometryScrollHeight = 0;
  private conversationId = '';
  private starsByTurnId = new Map<string, StarState>();
  private activeTurnId: string | null = null;
  private timelineStyle: TimelineStyle = 'dots';
  private stopRefreshTimer: Dispose | null = null;
  private scrollTarget: HTMLElement | null = null;
  private stopScrollListener: Dispose | null = null;
  private navigationLockUntil = 0;
  private pendingNavigationId: string | null = null;
  private pendingNavigationUntil = 0;
  private pendingNavigationLo = 0;
  private pendingNavigationHi = 0;
  private pendingNavigationProbed = false;
  private pendingNavigationStableHops = 0;
  private stopNavigationTimer: Dispose | null = null;
  private stopUserNavigationListeners: Dispose[] = [];
  private activeRouteId = '';
  private activeRouteHref = '';
  private routeGeneration = 0;
  private routeTransition: RouteTransition | null = null;

  private readonly interactions: ChatGptTimelineMarkerInteractions;

  constructor(private readonly scope: PluginScope) {
    this.interactions = new ChatGptTimelineMarkerInteractions(
      scope,
      (id) => {
        if (this.timelineStyle === 'compact') return null;
        const marker = this.registry.get(id);
        return marker?.summary
          ? `${this.starsByTurnId.has(id) ? '★ ' : ''}${marker.summary}`
          : null;
      },
      (id) => this.toggleStar(id),
    );
  }

  private get disposed(): boolean {
    return this.scope.isDisposed;
  }

  async start(settings: PluginSettings = {}): Promise<void> {
    this.updateSettings(settings);
    await initI18n().catch(() => {});
    if (this.disposed || !document.body) return;
    this.scope.style(CHATGPT_TIMELINE_CSS);
    this.scope.effect(() => {
      document.documentElement.classList.add(CHATGPT_TIMELINE_ROOT_CLASS);
      return () => document.documentElement.classList.remove(CHATGPT_TIMELINE_ROOT_CLASS);
    }, 'chatgpt-timeline-root-class');
    this.ensureUi();
    this.observe();
    this.scope.effect(
      () =>
        watchRouteChanges(({ previousHref, currentHref }) => {
          const change = getChatGptRouteChange(previousHref, currentHref);
          if (!change) return;
          const currentId = buildChatGptTimelineConversationId(currentHref);
          this.syncRoute(currentId);
          this.scheduleRefresh();
        }),
      'chatgpt-route-watch',
    );
    this.scope.on(window, 'resize', this.handleResize);
    this.scope.on(window, 'wheel', this.noteRouteTransitionUserNavigation, {
      capture: true,
      passive: true,
    });
    this.scope.on(window, 'touchmove', this.noteRouteTransitionUserNavigation, {
      capture: true,
      passive: true,
    });
    this.scope.on(window, 'pointerdown', this.noteRouteTransitionUserNavigation, {
      capture: true,
      passive: true,
    });
    this.scope.on(window, 'keydown', this.noteRouteTransitionUserNavigation, { capture: true });
    await this.refresh();
  }

  updateSettings(settings: PluginSettings): void {
    const nextStyle: TimelineStyle = settings[COMPACT_VIEW_SETTING] === true ? 'compact' : 'dots';
    const changed = nextStyle !== this.timelineStyle;
    this.timelineStyle = nextStyle;
    this.applyTimelineStyle();
    if (changed && this.markers.length) this.renderDots();
  }

  private observe(): void {
    if (!document.body) return;
    this.scope.observe(document.body, { childList: true, subtree: true }, (records) => {
      if (records.some((record) => this.shouldRefreshForMutation(record))) this.scheduleRefresh();
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

  private shouldRefreshForMutation(record: MutationRecord): boolean {
    if (this.isOwnMutation(record)) return false;
    const nodes = [
      record.target,
      ...Array.from(record.addedNodes),
      ...Array.from(record.removedNodes),
    ];
    return nodes.some((node) => {
      const element = this.toElement(node);
      return !!(
        element?.closest(CHATGPT_TURN_SHELL_SELECTOR) ||
        element?.querySelector?.(CHATGPT_TURN_SHELL_SELECTOR)
      );
    });
  }

  private isOwnMutation(record: MutationRecord): boolean {
    const nodes = [
      record.target,
      ...Array.from(record.addedNodes),
      ...Array.from(record.removedNodes),
    ];
    return nodes.every((node) => !!this.toElement(node)?.closest(OWN_UI_SELECTOR));
  }

  private toElement(node: Node): Element | null {
    return node instanceof window.Element
      ? node
      : node.parentElement instanceof window.Element
        ? node.parentElement
        : null;
  }

  private ensureUi(): void {
    let bar = document.querySelector<HTMLElement>(BAR_SELECTOR);
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'gemini-timeline-bar';
      bar.dataset.gvChatgptTimeline = 'true';
      // Opt into shared compact tick hit-testing without using hash-based navigation.
      bar.dataset.gvTurnNavigator = 'chatgpt';
      const track = document.createElement('div');
      track.className = 'timeline-track';
      const content = document.createElement('div');
      content.className = 'timeline-track-content';
      track.appendChild(content);
      bar.appendChild(track);
      this.scope.mount(bar, document.body);
    }
    this.bar = bar;
    this.track = bar.querySelector<HTMLElement>('.timeline-track');
    this.trackContent = bar.querySelector<HTMLElement>('.timeline-track-content');
    this.interactions.mount();
    if (!this.previewPanel) {
      this.previewPanel = new TimelinePreviewPanel(bar);
      this.previewPanel.init(
        (turnId) => this.navigateTo(turnId),
        undefined,
        (turnId) => this.toggleStar(turnId),
      );
      this.scope.child(this.previewPanel, 'chatgpt-timeline-preview');
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
      this.interactions.hide();
    } else track?.removeAttribute('aria-hidden');
    this.previewPanel?.setCompactMode(compact);
    this.updateTimelineGeometry();
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
    const nextConversationId = buildChatGptTimelineConversationId();
    this.syncRoute(nextConversationId);
    const routeGeneration = this.routeGeneration;
    await this.loadStars();
    if (
      this.disposed ||
      routeGeneration !== this.routeGeneration ||
      nextConversationId !== this.activeRouteId ||
      nextConversationId !== buildChatGptTimelineConversationId()
    ) {
      return;
    }
    const previousIds = this.markers.map((marker) => marker.id);
    if (!this.mergeMountedShells()) return;
    this.markers = this.registry.userTurns();
    this.markerCenters = this.computeMarkerCenters();
    const sameIds =
      previousIds.length === this.markers.length &&
      previousIds.every((id, index) => id === this.markers[index]?.id);
    if (!sameIds || this.markers.some((marker) => !this.dotsById.has(marker.id))) {
      this.renderDots();
    } else {
      this.updateTimelineGeometry();
    }
    this.applyStarredState();
    this.updateActiveFromScroll();
  }

  private mergeMountedShells(): boolean {
    const shells = collectChatGptTurnShells();
    const firstShell = shells[0]?.container;
    if (firstShell) this.setScrollTarget(findChatGptChatScrollRoot(firstShell));
    if (!this.acceptRouteTransitionShells(shells.map((shell) => shell.id))) return false;
    this.registry.merge(shells, (element) => this.computeElementCenter(element));
    this.rememberTransitionRouteTurns(
      this.activeRouteId,
      this.registry.all().map((turn) => turn.id),
    );
    return true;
  }

  private syncRoute(nextConversationId: string): void {
    if (!this.activeRouteId) {
      this.activeRouteId = nextConversationId;
      this.activeRouteHref = location.href;
      return;
    }
    if (nextConversationId === this.activeRouteId) return;
    this.beginConversationTransition(nextConversationId);
  }

  private beginConversationTransition(nextConversationId: string): void {
    const draftPromotion = isChatGptDraftPromotion(this.activeRouteHref, location.href);
    const turnIdsByRoute = new Map<string, Set<string>>();
    for (const [routeId, turnIds] of this.routeTransition?.turnIdsByRoute ?? []) {
      turnIdsByRoute.set(routeId, new Set(turnIds));
    }
    this.addRouteTurnIds(
      turnIdsByRoute,
      this.activeRouteId,
      this.registry.all().map((turn) => turn.id),
    );
    this.addRouteTurnIds(
      turnIdsByRoute,
      this.activeRouteId,
      this.routeTransition?.candidateTurnIds ?? [],
    );
    this.addRouteTurnIds(
      turnIdsByRoute,
      this.activeRouteId,
      this.routeTransition?.acceptedTurnIds ?? [],
    );
    const sourceTurnIds = new Set<string>();
    for (const [routeId, turnIds] of turnIdsByRoute) {
      if (routeId === nextConversationId) continue;
      // Draft shells can belong to the newly saved conversation. Still require
      // the normal stable candidate passes and allow replacement by a new set.
      if (draftPromotion && routeId === this.activeRouteId) continue;
      for (const id of turnIds) sourceTurnIds.add(id);
    }

    this.routeGeneration += 1;
    this.activeRouteId = nextConversationId;
    this.activeRouteHref = location.href;
    this.routeTransition = {
      generation: this.routeGeneration,
      targetConversationId: nextConversationId,
      turnIdsByRoute,
      sourceTurnIds,
      candidateTurnIds: null,
      acceptedTurnIds: null,
      userNavigated: false,
      expiresAt: Date.now() + ROUTE_TRANSITION_REPLACEMENT_WINDOW_MS,
    };
    this.resetConversationState();
  }

  private acceptRouteTransitionShells(turnIds: string[]): boolean {
    const transition = this.routeTransition;
    if (!transition) return true;
    if (
      transition.generation !== this.routeGeneration ||
      transition.targetConversationId !== this.activeRouteId
    ) {
      return false;
    }
    if (Date.now() > transition.expiresAt) {
      this.routeTransition = null;
      return true;
    }
    if (!turnIds.length) return false;

    if (turnIds.some((id) => transition.sourceTurnIds.has(id))) {
      transition.candidateTurnIds = null;
      return false;
    }

    const accepted = transition.acceptedTurnIds;
    if (accepted) {
      const acceptedIdDisappeared = Array.from(accepted).some((id) => !turnIds.includes(id));
      if (!transition.userNavigated && acceptedIdDisappeared) {
        this.clearTurnRegistry();
        transition.acceptedTurnIds = null;
        transition.candidateTurnIds = turnIds;
        this.scheduleRefresh();
        return false;
      }
      if (turnIds.some((id) => accepted.has(id))) {
        for (const id of turnIds) accepted.add(id);
        return true;
      }
      if (transition.userNavigated) {
        // A disjoint mounted window after direct user input is expected when
        // ChatGPT virtualizes a long destination conversation. Known source ids
        // remain quarantined above while destination ids stay grow-only.
        for (const id of turnIds) accepted.add(id);
        return true;
      }

      // Until the user navigates the destination, a wholly disjoint shell set
      // is more likely to be route reconciliation than virtual scrolling.
      this.clearTurnRegistry();
      transition.acceptedTurnIds = null;
      transition.candidateTurnIds = turnIds;
      this.scheduleRefresh();
      return false;
    }

    if (!this.sameTurnIds(transition.candidateTurnIds, turnIds)) {
      transition.candidateTurnIds = turnIds;
      this.scheduleRefresh();
      return false;
    }

    transition.acceptedTurnIds = new Set(turnIds);
    return true;
  }

  private sameTurnIds(left: readonly string[] | null, right: readonly string[]): boolean {
    return (
      left !== null &&
      left.length === right.length &&
      left.every((id, index) => id === right[index])
    );
  }

  private addRouteTurnIds(
    routeTurnIds: Map<string, Set<string>>,
    routeId: string,
    turnIds: Iterable<string>,
  ): void {
    if (!routeId) return;
    const remembered = routeTurnIds.get(routeId) ?? new Set<string>();
    for (const id of turnIds) remembered.add(id);
    if (remembered.size) routeTurnIds.set(routeId, remembered);
  }

  private rememberTransitionRouteTurns(routeId: string, turnIds: Iterable<string>): void {
    if (!this.routeTransition) return;
    this.addRouteTurnIds(this.routeTransition.turnIdsByRoute, routeId, turnIds);
  }

  private clearTurnRegistry(): void {
    this.interactions.cancelLongPress();
    this.interactions.hide();
    this.registry.reset();
    this.markers = [];
    this.markerCenters = [];
    this.setActiveTurn(null);
    this.clearPendingNavigation();
    this.dotsById.clear();
    if (this.trackContent) this.trackContent.textContent = '';
    this.timelineContentHeight = 0;
    this.updateTimelineGeometry();
    this.updatePreview();
  }

  private resetConversationState(): void {
    this.clearTurnRegistry();
    this.conversationId = '';
    this.starsByTurnId.clear();
  }

  private async loadStars(force = false): Promise<void> {
    const requestedId = buildChatGptTimelineConversationId();
    if (!force && requestedId === this.conversationId) return;
    this.conversationId = requestedId;
    const messages = await StarredMessagesService.getStarredMessagesForConversation(requestedId);
    if (this.disposed || requestedId !== this.conversationId) return;
    const next = new Map<string, StarState>();
    for (const message of messages) {
      const rawTurnId = extractChatGptTimelineStarTurnId(message.turnId);
      if (rawTurnId) {
        next.set(rawTurnId, {
          persistedTurnId: message.turnId,
          starredAt: message.starredAt,
        });
      }
    }
    this.starsByTurnId = next;
  }

  private renderDots(): void {
    if (!this.trackContent) return;
    this.interactions.cancelLongPress();
    this.interactions.hide();
    this.trackContent.textContent = '';
    this.dotsById.clear();
    this.markers.forEach((marker, index) => {
      const dot = document.createElement('button') as Dot;
      dot.className = 'timeline-dot';
      dot.type = 'button';
      dot.dataset.targetTurnId = marker.id;
      dot.dataset.markerIndex = String(index);
      dot.setAttribute('aria-label', marker.summary || `Message ${index + 1}`);
      dot.setAttribute('aria-current', marker.id === this.activeTurnId ? 'true' : 'false');
      dot.setAttribute('aria-pressed', this.starsByTurnId.has(marker.id) ? 'true' : 'false');
      dot.classList.toggle('active', marker.id === this.activeTurnId);
      dot.classList.toggle('starred', this.starsByTurnId.has(marker.id));
      dot.addEventListener('click', (event) => {
        // The compact rail also opens preview; a tick should only navigate.
        event.stopPropagation();
        if (Date.now() < this.interactions.suppressClickUntil) event.preventDefault();
        else this.navigateTo(marker.id);
      });
      dot.addEventListener('pointerdown', () => this.interactions.startLongPress(dot));
      dot.addEventListener('pointerup', () => this.interactions.cancelLongPress());
      dot.addEventListener('pointercancel', () => this.interactions.cancelLongPress());
      dot.addEventListener('pointerenter', () => this.interactions.schedule(dot));
      dot.addEventListener('pointerleave', () => {
        this.interactions.cancelLongPress();
        this.interactions.hide();
      });
      dot.addEventListener('focus', () => this.interactions.show(dot));
      dot.addEventListener('blur', () => this.interactions.hide());
      this.dotsById.set(marker.id, dot);
      this.trackContent!.appendChild(dot);
    });
    this.updateTimelineGeometry();
    this.updatePreview();
  }

  private buildCompactMarkerOffsets(): number[] {
    const count = this.markers.length;
    if (!count) return [];
    const gap = count > 1 ? Math.min(COMPACT_MAX_GAP_PX, COMPACT_MAX_SPAN_PX / (count - 1)) : 0;
    const center = (count - 1) / 2;
    return this.markers.map((_, index) => (index - center) * gap);
  }

  private updateTimelineGeometry(): void {
    if (!this.bar || !this.track || !this.trackContent) return;
    const railHeight = Math.max(
      1,
      this.bar.clientHeight || this.track.clientHeight || this.getViewportHeight(),
    );

    if (this.timelineStyle === 'compact') {
      this.timelineContentHeight = railHeight;
      this.geometryScrollHeight = this.getScrollHeight();
      this.trackContent.style.height = '100%';
      this.track.scrollTop = 0;
      const offsets = this.buildCompactMarkerOffsets();
      this.markers.forEach((marker, index) => {
        const dot = this.dotsById.get(marker.id);
        if (!dot) return;
        dot.style.removeProperty('top');
        dot.style.removeProperty('--n');
        dot.style.setProperty('--timeline-compact-offset', `${offsets[index] ?? 0}px`);
      });
      return;
    }

    this.geometryScrollHeight = this.getScrollHeight();
    const geometry = calculateChatGptTimelineGeometry(
      this.markerCenters,
      this.geometryScrollHeight,
      railHeight,
    );
    this.timelineContentHeight = geometry.contentHeight;
    this.trackContent.style.height = `${Math.ceil(geometry.contentHeight)}px`;
    const usableHeight = Math.max(
      1,
      geometry.contentHeight - CHATGPT_TIMELINE_TRACK_PADDING_PX * 2,
    );
    this.markers.forEach((marker, index) => {
      const dot = this.dotsById.get(marker.id);
      const top = geometry.markerTops[index];
      if (!dot || top === undefined) return;
      dot.style.removeProperty('--timeline-compact-offset');
      dot.style.setProperty(
        '--n',
        String((top - CHATGPT_TIMELINE_TRACK_PADDING_PX) / usableHeight),
      );
      // Explicit pixels avoid relying on CSS typed multiplication support.
      dot.style.top = `${Math.round(top)}px`;
    });
    this.syncTimelineTrackToChat();
  }

  private syncTimelineTrackToChat(): void {
    if (!this.track) return;
    if (this.timelineStyle === 'compact') {
      this.track.scrollTop = 0;
      return;
    }
    const trackViewportHeight =
      this.track.clientHeight || this.bar?.clientHeight || this.getViewportHeight();
    const timelineRange = Math.max(0, this.timelineContentHeight - trackViewportHeight);
    const chatRange = Math.max(0, this.getScrollHeight() - this.getViewportHeight());
    this.track.scrollTop = chatRange > 0 ? (this.getScrollTop() / chatRange) * timelineRange : 0;
  }

  private async toggleStar(turnId: string): Promise<void> {
    const marker = this.registry.get(turnId);
    if (!marker || marker.role !== 'user') return;
    const existing = this.starsByTurnId.get(turnId);
    if (existing) {
      this.starsByTurnId.delete(turnId);
      await StarredMessagesService.removeStarredMessage(
        this.conversationId,
        existing.persistedTurnId,
      );
    } else {
      const starredAt = Date.now();
      const persistedTurnId = buildChatGptTimelineStarTurnId(turnId);
      this.starsByTurnId.set(turnId, { persistedTurnId, starredAt });
      const message: StarredMessage = {
        turnId: persistedTurnId,
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
    this.markers.forEach((marker, index) => {
      const starred = this.starsByTurnId.has(marker.id);
      const dot = this.dotsById.get(marker.id);
      dot?.classList.toggle('starred', starred);
      dot?.setAttribute('aria-pressed', starred ? 'true' : 'false');
      dot?.setAttribute('aria-label', marker.summary || `Message ${index + 1}`);
    });
    this.updatePreview();
  }

  private updatePreview(): void {
    const previewMarkers: PreviewMarkerData[] = this.markers.map((marker, index) => ({
      id: marker.id,
      summary: marker.summary || `Message ${index + 1}`,
      index,
      starred: this.starsByTurnId.has(marker.id),
      starredAt: this.starsByTurnId.get(marker.id)?.starredAt,
    }));
    this.previewPanel?.updateMarkers(previewMarkers);
    this.previewPanel?.updateActiveTurn(this.activeTurnId);
  }

  private setActiveTurn(turnId: string | null): void {
    if (this.activeTurnId === turnId) return;
    this.dotsById.get(this.activeTurnId ?? '')?.classList.remove('active');
    this.dotsById.get(this.activeTurnId ?? '')?.setAttribute('aria-current', 'false');
    this.activeTurnId = turnId;
    this.dotsById.get(turnId ?? '')?.classList.add('active');
    this.dotsById.get(turnId ?? '')?.setAttribute('aria-current', 'true');
    this.previewPanel?.updateActiveTurn(turnId);
  }

  private updateActiveFromScroll = (): void => {
    this.interactions.hide();
    this.syncTimelineTrackToChat();
    if (!this.markers.length) {
      this.setActiveTurn(null);
      return;
    }
    if (Date.now() < this.navigationLockUntil) return;
    const nextCenters = this.computeMarkerCenters();
    const geometryChanged =
      nextCenters.length !== this.markerCenters.length ||
      nextCenters.some(
        (center, index) => Math.abs(center - (this.markerCenters[index] ?? 0)) > 1,
      ) ||
      Math.abs(this.getScrollHeight() - this.geometryScrollHeight) > 1;
    this.markerCenters = nextCenters;
    if (geometryChanged) this.updateTimelineGeometry();
    if (this.isAtScrollBottom()) {
      this.setActiveTurn(this.markers[this.markers.length - 1]?.id ?? null);
      return;
    }
    const reference = this.getScrollTop() + this.getViewportHeight() * ACTIVE_ANCHOR;
    let low = 0;
    let high = this.markerCenters.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.markerCenters[middle] <= reference) low = middle + 1;
      else high = middle;
    }
    const previous = Math.max(0, low - 1);
    const next = Math.min(this.markerCenters.length - 1, low);
    const index =
      Math.abs(this.markerCenters[next] - reference) <
      Math.abs(this.markerCenters[previous] - reference)
        ? next
        : previous;
    this.setActiveTurn(this.markers[index]?.id ?? null);
  };

  private setScrollTarget(target: HTMLElement | null): void {
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

  private noteRouteTransitionUserNavigation = (event: Event): void => {
    const transition = this.routeTransition;
    if (!transition) return;
    const region = classifyChatGptScrollTarget(event.target, document);
    const target = event.target instanceof Element ? event.target : null;
    if (
      region === 'chat' ||
      (region !== 'sidebar' && target?.closest('main') && !target.closest(OWN_UI_SELECTOR))
    ) {
      transition.userNavigated = true;
    }
  };

  private navigateTo(turnId: string): void {
    const marker = this.registry.get(turnId);
    if (!marker || marker.role !== 'user') return;
    this.interactions.hide();
    if (this.routeTransition) this.routeTransition.userNavigated = true;
    this.navigationLockUntil = Date.now() + NAVIGATION_LOCK_MS;
    this.setActiveTurn(turnId);
    this.beginPendingNavigation(marker);
    this.mergeMountedShells();
    this.markerCenters = this.computeMarkerCenters();
    this.updateTimelineGeometry();
    const current = this.registry.get(turnId);
    if (current?.element.isConnected) {
      current.center = this.computeElementCenter(current.element);
      const distance = Math.abs(
        current.center - (this.getScrollTop() + this.getViewportHeight() * ACTIVE_ANCHOR),
      );
      this.scrollToCenter(
        current.center,
        distance <= this.getViewportHeight() * LONG_JUMP_VIEWPORTS ? 'smooth' : 'auto',
      );
      this.scheduleNavigationHop();
    } else {
      this.homePendingNavigation();
    }
  }

  private beginPendingNavigation(marker: ChatGptTimelineTurn): void {
    this.clearPendingNavigation();
    this.pendingNavigationId = marker.id;
    this.pendingNavigationUntil = Date.now() + NAVIGATION_TIMEOUT_MS;
    this.pendingNavigationLo = 0;
    this.pendingNavigationHi = Math.max(
      this.getScrollHeight(),
      marker.center + this.getViewportHeight(),
    );
    this.pendingNavigationProbed = false;
    this.pendingNavigationStableHops = 0;
    if (this.disposed) return;
    this.stopUserNavigationListeners = [
      this.scope.on(window, 'wheel', this.cancelPendingNavigationOnUserInput, { passive: true }),
      this.scope.on(window, 'touchmove', this.cancelPendingNavigationOnUserInput, {
        passive: true,
      }),
    ];
    if (this.scrollTarget) {
      this.stopUserNavigationListeners.push(
        this.scope.on(this.scrollTarget, 'pointerdown', this.cancelPendingNavigationOnUserInput, {
          passive: true,
        }),
      );
    }
  }

  private clearPendingNavigation(): void {
    this.pendingNavigationId = null;
    void this.stopNavigationTimer?.();
    this.stopNavigationTimer = null;
    for (const stop of this.stopUserNavigationListeners.splice(0)) void stop();
  }

  private cancelPendingNavigationOnUserInput = (): void => {
    this.clearPendingNavigation();
    this.navigationLockUntil = 0;
    this.updateActiveFromScroll();
  };

  private homePendingNavigation = (): void => {
    this.stopNavigationTimer = null;
    const turnId = this.pendingNavigationId;
    if (!turnId || this.disposed) return;
    if (Date.now() > this.pendingNavigationUntil) {
      this.clearPendingNavigation();
      return;
    }
    this.mergeMountedShells();
    this.markerCenters = this.computeMarkerCenters();
    this.updateTimelineGeometry();
    const marker = this.registry.get(turnId);
    if (!marker) {
      this.clearPendingNavigation();
      return;
    }
    this.navigationLockUntil = Date.now() + NAVIGATION_LOCK_MS;
    if (marker.element.isConnected) {
      marker.center = this.computeElementCenter(marker.element);
      const targetCenter = this.getScrollTop() + this.getViewportHeight() * ACTIVE_ANCHOR;
      if (Math.abs(marker.center - targetCenter) > ANCHOR_TOLERANCE_PX) {
        this.pendingNavigationStableHops = 0;
        this.scrollToCenter(marker.center, 'auto');
      } else {
        this.pendingNavigationStableHops += 1;
        if (this.pendingNavigationStableHops >= 2) {
          this.clearPendingNavigation();
          return;
        }
      }
      this.scheduleNavigationHop();
      return;
    }

    const allTurns = this.registry.all();
    const targetIndex = allTurns.indexOf(marker);
    const mountedIndexes = allTurns.flatMap((turn, index) =>
      turn.element.isConnected ? [index] : [],
    );
    if (mountedIndexes.length) {
      const firstMounted = mountedIndexes[0];
      const lastMounted = mountedIndexes[mountedIndexes.length - 1];
      if (targetIndex < firstMounted)
        this.pendingNavigationHi = Math.min(this.pendingNavigationHi, this.getScrollTop());
      else if (targetIndex > lastMounted) {
        this.pendingNavigationLo = Math.max(
          this.pendingNavigationLo,
          this.getScrollTop() + this.getViewportHeight(),
        );
      }
    }
    if (this.pendingNavigationHi - this.pendingNavigationLo < 1) {
      this.clearPendingNavigation();
      return;
    }
    const useCachedCenter =
      !this.pendingNavigationProbed &&
      marker.center > this.pendingNavigationLo &&
      marker.center < this.pendingNavigationHi;
    const probe = useCachedCenter
      ? marker.center
      : (this.pendingNavigationLo + this.pendingNavigationHi) / 2;
    this.pendingNavigationProbed = true;
    this.scrollToCenter(probe, 'auto');
    this.scheduleNavigationHop();
  };

  private scheduleNavigationHop(): void {
    if (this.stopNavigationTimer || this.disposed) return;
    this.stopNavigationTimer = this.scope.timer(this.homePendingNavigation, NAVIGATION_HOP_MS);
  }

  private computeMarkerCenters(): number[] {
    const centers: number[] = [];
    for (const marker of this.markers) {
      if (marker.element.isConnected) marker.center = this.computeElementCenter(marker.element);
      const previous = centers[centers.length - 1];
      centers.push(previous !== undefined && marker.center < previous ? previous : marker.center);
    }
    return centers;
  }

  private computeElementCenter(element: HTMLElement): number {
    const rect = element.getBoundingClientRect();
    const viewportTop = this.scrollTarget?.getBoundingClientRect().top ?? 0;
    return this.getScrollTop() + rect.top - viewportTop + rect.height / 2;
  }

  private getScrollTop(): number {
    return (
      this.scrollTarget?.scrollTop ?? window.scrollY ?? document.documentElement.scrollTop ?? 0
    );
  }

  private getViewportHeight(): number {
    return (
      this.scrollTarget?.clientHeight ||
      window.innerHeight ||
      document.documentElement.clientHeight ||
      0
    );
  }

  private getScrollHeight(): number {
    return (
      this.scrollTarget?.scrollHeight ||
      document.scrollingElement?.scrollHeight ||
      document.documentElement.scrollHeight
    );
  }

  private isAtScrollBottom(): boolean {
    const viewportHeight = this.getViewportHeight();
    return (
      this.getScrollHeight() > viewportHeight &&
      this.getScrollTop() + viewportHeight >= this.getScrollHeight() - 2
    );
  }

  private scrollToCenter(center: number, behavior: ScrollBehavior): void {
    const top = Math.max(0, center - this.getViewportHeight() * ACTIVE_ANCHOR);
    if (this.scrollTarget?.scrollTo) this.scrollTarget.scrollTo({ top, behavior });
    else if (this.scrollTarget) this.scrollTarget.scrollTop = top;
    else window.scrollTo({ top, behavior });
  }

  private getTitle(): string {
    const title = document.title.replace(/\s*[|-]\s*ChatGPT.*$/i, '').trim();
    return title || this.markers[0]?.summary.slice(0, 50) || 'ChatGPT conversation';
  }

  private handleResize = (): void => {
    this.scheduleRefresh();
    this.previewPanel?.reposition();
  };
}
