import { storageService } from '@/core/services/StorageService';
import { StorageKeys, type TurnId } from '@/core/types/common';
import {
  buildConversationIdFromUrl,
  extractConversationIdFromUrl,
} from '@/core/utils/conversationIdentity';
import { hashString } from '@/core/utils/hash';

import { getLegacyTurnIndex } from '../fork/turnId';
import { TimestampService } from '../timestamp/TimestampService';
import { type HistoryTimestampStore, historyTimestampStore } from '../timestamp/historyTimestamps';
import type { ExtGlobal, SyncSettingsListener, TimelineMarker } from './types';

let timestampDraftTabId: string | null = null;

function getTimestampDraftTabId(): string {
  if (timestampDraftTabId) return timestampDraftTabId;

  try {
    const randomUUID = globalThis.crypto?.randomUUID?.();
    if (randomUUID) {
      timestampDraftTabId = randomUUID;
      return timestampDraftTabId;
    }
  } catch {}

  timestampDraftTabId = hashString(
    `${Date.now()}|${Math.random()}|${globalThis.location?.href ?? ''}`,
  );
  return timestampDraftTabId;
}

interface HistoryTimestampMatchKey {
  nativeConversationId: string;
  timestampConversationId: string;
  storeRevision: number;
  markerRevision: number;
}

interface TimelineTimestampsContext {
  getMarkers(): readonly TimelineMarker[];
  getTurnText(element: HTMLElement): string;
  getTurnAliases(turnId: string): readonly string[];
  onIdentityChange(): void;
}

interface TimelineTimestampsOptions {
  previousUrl?: string | null;
}

function buildTimestampConversationId(url: string): string {
  const conversationId = buildConversationIdFromUrl(url);
  return conversationId.startsWith('gemini:conv:')
    ? conversationId
    : `${conversationId}:tab:${getTimestampDraftTabId()}`;
}

/** Owns one conversation's timestamp tracking, history subscription and message labels. */
export class TimelineTimestamps {
  readonly url = window.location.href;
  readonly conversationId = buildConversationIdFromUrl(this.url);
  private readonly nativeConversationId = extractConversationIdFromUrl(this.url);
  private readonly timestampConversationId = buildTimestampConversationId(this.url);
  private timestampService: TimestampService | null = null;
  private historyTimestampStore: HistoryTimestampStore | null = null;
  private historyTimestampUnsubscribe: (() => void) | null = null;
  private historyTimestampMarkerRevision = 0;
  private lastHistoryTimestampMatch: HistoryTimestampMatchKey | null = null;
  private removeSettingsListener: (() => void) | null = null;
  private enabledValue = false;
  private destroyed = false;
  private readonly initialTimestampSnapshotDelay = 800;
  private readonly draftTimestampAdoptionWindowMs = 5 * 60 * 1000;
  private timestampTrackingReady = false;
  private timestampStartupTimer: number | null = null;
  private readonly seenTurnIds = new Set<string>();
  private pendingDraftTimestampSourceConversationId: string | null;

  constructor(
    private readonly context: TimelineTimestampsContext,
    options: TimelineTimestampsOptions = {},
  ) {
    const previousUrl = options.previousUrl;
    this.pendingDraftTimestampSourceConversationId =
      previousUrl && !extractConversationIdFromUrl(previousUrl) && this.nativeConversationId
        ? buildTimestampConversationId(previousUrl)
        : null;
  }

  async init(): Promise<void> {
    if (this.destroyed) return;
    let settingChanged = false;
    try {
      const g = globalThis as ExtGlobal;
      const onChanged = g.chrome?.storage?.onChanged || g.browser?.storage?.onChanged;
      if (onChanged) {
        const listener: SyncSettingsListener = (changes, area) => {
          if (area !== 'sync' && area !== 'local') return;
          const change = changes[StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS];
          if (!change) return;
          settingChanged = true;
          this.setEnabled(change.newValue === true);
        };
        onChanged.addListener(listener);
        this.removeSettingsListener = () => onChanged.removeListener?.(listener);
      }
    } catch {}
    this.timestampService = new TimestampService();
    await this.timestampService.initialize();
    if (this.destroyed) return;
    const setting = await storageService.get<boolean>(StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS);
    if (this.destroyed) return;
    // A live change can arrive while either initial storage read is pending.
    if (!settingChanged) this.enabledValue = setting.success && setting.data === true;
    this.historyTimestampStore = historyTimestampStore;
    await this.historyTimestampStore.start();
    if (this.destroyed) return;
    this.historyTimestampUnsubscribe = this.historyTimestampStore.subscribe((updatedCids) => {
      if (
        this.destroyed ||
        this.conversationId !== buildConversationIdFromUrl(window.location.href)
      )
        return;
      if (!this.nativeConversationId || !updatedCids.includes(`c_${this.nativeConversationId}`))
        return;
      this.context.onIdentityChange();
      if (this.applyHistoryTimestamps()) this.render();
    });
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  setEnabled(enabled: boolean): void {
    if (this.destroyed) return;
    this.enabledValue = enabled;
    this.lastHistoryTimestampMatch = null;
    if (enabled) this.applyHistoryTimestamps();
    this.render();
  }

  update(previousMarkers: readonly TimelineMarker[], nextMarkers: readonly TimelineMarker[]): void {
    if (this.destroyed) return;
    if (nextMarkers.length === 0) {
      this.updateTimestampTracking([]);
      return;
    }
    if (this.didHistoryTimestampMarkerInputsChange(previousMarkers, nextMarkers)) {
      this.historyTimestampMarkerRevision++;
    }
    const markerIds = nextMarkers.map((marker) => marker.id);
    this.maybeAdoptDraftRouteTimestamps(markerIds);
    this.updateTimestampTracking(markerIds);
    // History writes update TimestampService memory synchronously, so this pass renders them.
    this.applyHistoryTimestamps();
    this.render();
  }

  formatTooltipTimestamp(turnId: string): string | null {
    if (!this.enabledValue || !this.timestampService || !turnId) return null;
    const marker = this.context.getMarkers().find((item) => item.id === turnId);
    const timestamp = marker
      ? this.getTimestampForMarker(marker)
      : this.timestampService.getTimestamp(this.timestampConversationId, turnId as TurnId);
    return timestamp == null ? null : this.timestampService.formatAbsoluteTime(timestamp);
  }

  private getTimestampForMarker(marker: TimelineMarker): number | null {
    if (!this.timestampService) return null;

    const aliases = this.context.getTurnAliases(marker.id);
    for (const alias of aliases) {
      const timestamp = this.timestampService.getTimestamp(
        this.timestampConversationId,
        alias as TurnId,
      );
      if (timestamp != null) return timestamp;
    }

    // Versions before positional ids used a content+full-index hash. Rebuild it
    // only when hNvQHb proves the full index; never use the mounted-window index.
    const legacyIndex = aliases.map(getLegacyTurnIndex).find((value) => value !== null);
    if (legacyIndex === undefined) return null;
    const basis = this.context.getTurnText(marker.element) || `user-${legacyIndex}`;
    const legacyContentId = `u-${hashString(basis + '|' + legacyIndex)}`;
    return this.timestampService.getTimestamp(
      this.timestampConversationId,
      legacyContentId as TurnId,
    );
  }

  private render(): void {
    if (!this.timestampService) return;
    const timestampService = this.timestampService;
    if (!this.enabledValue) {
      // Remove any existing timestamps if feature is disabled
      document.querySelectorAll('.gv-timestamp').forEach((el) => el.remove());
      return;
    }

    const activeTurnIds = new Set<string>();
    const existingTimestampEls = new Map<string, HTMLElement>();
    document.querySelectorAll<HTMLElement>('.gv-timestamp[data-gv-turn-id]').forEach((el) => {
      const turnId = el.getAttribute('data-gv-turn-id') || '';
      if (!turnId) {
        el.remove();
        return;
      }

      if (existingTimestampEls.has(turnId)) {
        el.remove();
        return;
      }

      existingTimestampEls.set(turnId, el);
    });

    // Use markers instead of querying DOM - markers already have the correct elements
    const renderedTurnIds = new Set<string>();
    this.context.getMarkers().forEach((marker) => {
      activeTurnIds.add(marker.id);
      if (renderedTurnIds.has(marker.id)) {
        return;
      }
      renderedTurnIds.add(marker.id);

      const msgEl = marker.element;
      const parent = msgEl.parentElement;
      if (!parent) {
        existingTimestampEls.get(marker.id)?.remove();
        existingTimestampEls.delete(marker.id);
        return;
      }

      let insertionParent: HTMLElement | null = parent;
      let insertionAnchor: HTMLElement = msgEl;
      const alignClass = 'gv-timestamp-user';
      const existingTimestampEl = existingTimestampEls.get(marker.id) ?? null;
      try {
        // Walk up to find the nearest horizontal row wrapper (avatar + bubble).
        // Then insert timestamp before that row so it is always above the whole message row.
        let rowWrapper: HTMLElement | null = null;
        let cursor: HTMLElement | null = parent;
        for (let i = 0; i < 4 && cursor; i++) {
          const style = getComputedStyle(cursor);
          if (style.display.includes('flex') && style.flexDirection.startsWith('row')) {
            rowWrapper = cursor;
            break;
          }
          cursor = cursor.parentElement;
        }
        if (rowWrapper && rowWrapper.parentElement) {
          insertionParent = rowWrapper.parentElement as HTMLElement;
          insertionAnchor = rowWrapper;
        }
      } catch {}
      if (!insertionParent) {
        return;
      }

      const timestamp = this.getTimestampForMarker(marker);
      if (timestamp == null) {
        existingTimestampEls.get(marker.id)?.remove();
        existingTimestampEls.delete(marker.id);
        return;
      }

      const formattedTime = timestampService.formatAbsoluteTime(timestamp);
      const desiredClassName = `gv-timestamp ${alignClass}`;
      const timestampEl = existingTimestampEl ?? document.createElement('div');
      timestampEl.setAttribute('data-gv-turn-id', marker.id);
      if (timestampEl.className !== desiredClassName) {
        timestampEl.className = desiredClassName;
      }
      if (timestampEl.textContent !== formattedTime) {
        timestampEl.textContent = formattedTime;
      }

      if (
        timestampEl.parentElement !== insertionParent ||
        timestampEl.nextSibling !== insertionAnchor
      ) {
        // Render timestamp above the message container (outside the bubble)
        insertionParent.insertBefore(timestampEl, insertionAnchor);
      }

      existingTimestampEls.delete(marker.id);
    });

    existingTimestampEls.forEach((el, turnId) => {
      if (!activeTurnIds.has(turnId)) {
        el.remove();
      }
    });
  }

  private updateTimestampTracking(markerIds: string[]): void {
    if (!this.timestampTrackingReady) {
      markerIds.forEach((markerId) => this.seenTurnIds.add(markerId));
      const shouldResetDelay = markerIds.length > 0 || this.seenTurnIds.size > 0;
      this.scheduleTimestampTrackingReady(shouldResetDelay);
      return;
    }

    markerIds.forEach((markerId) => {
      if (this.seenTurnIds.has(markerId)) return;
      this.seenTurnIds.add(markerId);
      this.recordTimestampForTurn(markerId);
    });
  }

  private scheduleTimestampTrackingReady(resetDelay: boolean): void {
    if (this.timestampTrackingReady) return;

    if (resetDelay && this.timestampStartupTimer !== null) {
      clearTimeout(this.timestampStartupTimer);
      this.timestampStartupTimer = null;
    }

    if (this.timestampStartupTimer !== null) return;

    this.timestampStartupTimer = window.setTimeout(() => {
      this.timestampTrackingReady = true;
      this.timestampStartupTimer = null;
    }, this.initialTimestampSnapshotDelay);
  }

  private recordTimestampForTurn(turnId: string): void {
    // Only record while the message-timestamps feature is enabled; existing
    // stored timestamps are kept untouched (backward compatibility).
    if (!this.enabledValue) return;
    if (getLegacyTurnIndex(turnId) !== null) return;
    const timestampConversationId = this.timestampConversationId;
    if (!this.timestampService) return;
    if (this.timestampService.getTimestamp(timestampConversationId, turnId as TurnId) !== null)
      return;

    this.timestampService
      .recordTimestamp(timestampConversationId, turnId as TurnId)
      .catch(() => {});
  }

  private didHistoryTimestampMarkerInputsChange(
    previousMarkers: readonly TimelineMarker[],
    nextMarkers: readonly TimelineMarker[],
  ): boolean {
    if (previousMarkers.length !== nextMarkers.length) return true;

    for (let index = 0; index < nextMarkers.length; index++) {
      const previous = previousMarkers[index];
      const next = nextMarkers[index];
      if (previous.id !== next.id || previous.summary !== next.summary) return true;
    }

    return false;
  }

  /**
   * Overwrite first-seen timestamps with real server-side times captured from
   * Gemini's conversation-load RPC. Matching uses the same server turn id as
   * Timeline identity, so duplicate or edited prompt text is irrelevant.
   * Returns whether any stored timestamp changed.
   */
  private applyHistoryTimestamps(): boolean {
    const store = this.historyTimestampStore;
    const timestampService = this.timestampService;
    const markers = this.context.getMarkers();
    if (!store || !timestampService || markers.length === 0) return false;
    // Recording is opt-in via the feature toggle, same as recordTimestampForTurn.
    if (!this.enabledValue) return false;

    const nativeConversationId = this.nativeConversationId;
    if (!nativeConversationId) return false;
    // Stale-manager guard: during an SPA conversation switch there is a window
    // where the URL already points at the next conversation while this instance
    // (and its markers) still belongs to the previous one.
    if (this.conversationId !== buildConversationIdFromUrl(window.location.href)) return false;
    const timestampConversationId = this.timestampConversationId;

    const storeRevision = store.getRevision(nativeConversationId);
    if (storeRevision === 0) return false;

    const matchKey: HistoryTimestampMatchKey = {
      nativeConversationId,
      timestampConversationId,
      storeRevision,
      markerRevision: this.historyTimestampMarkerRevision,
    };
    const previousMatch = this.lastHistoryTimestampMatch;
    if (
      previousMatch?.nativeConversationId === matchKey.nativeConversationId &&
      previousMatch.timestampConversationId === matchKey.timestampConversationId &&
      previousMatch.storeRevision === matchKey.storeRevision &&
      previousMatch.markerRevision === matchKey.markerRevision
    ) {
      return false;
    }

    const turns = store.getTurns(nativeConversationId);
    if (!turns) return false;

    const mountedTurnIds = new Set(markers.map((marker) => marker.id));
    this.lastHistoryTimestampMatch = matchKey;

    let changed = false;
    turns.forEach(({ turnId, timestampMs }) => {
      if (!turnId) return;
      if (!mountedTurnIds.has(turnId)) return;
      if (
        timestampService.getTimestamp(timestampConversationId, turnId as TurnId) === timestampMs
      ) {
        return;
      }
      changed = true;
      timestampService
        .recordTimestamp(timestampConversationId, turnId as TurnId, timestampMs)
        .catch(() => {});
    });
    return changed;
  }

  private maybeAdoptDraftRouteTimestamps(markerIds: string[]): void {
    if (
      !this.timestampService ||
      !this.pendingDraftTimestampSourceConversationId ||
      markerIds.length === 0
    ) {
      return;
    }

    const sourceConversationId = this.pendingDraftTimestampSourceConversationId;
    const targetConversationId = this.timestampConversationId;

    const latestDraftTimestamp =
      this.timestampService.getLatestTimestampForConversation(sourceConversationId);

    this.pendingDraftTimestampSourceConversationId = null;

    if (
      latestDraftTimestamp == null ||
      Date.now() - latestDraftTimestamp > this.draftTimestampAdoptionWindowMs
    ) {
      return;
    }

    this.timestampService
      .adoptTimestamps(
        sourceConversationId,
        targetConversationId,
        markerIds.map((markerId) => markerId as TurnId),
      )
      .catch(() => {});
  }

  destroy(): void {
    this.destroyed = true;
    try {
      this.removeSettingsListener?.();
    } catch {}
    this.removeSettingsListener = null;
    if (this.timestampStartupTimer !== null) clearTimeout(this.timestampStartupTimer);
    this.timestampStartupTimer = null;
    this.historyTimestampUnsubscribe?.();
    this.historyTimestampUnsubscribe = null;
    this.historyTimestampStore = null;
  }
}
