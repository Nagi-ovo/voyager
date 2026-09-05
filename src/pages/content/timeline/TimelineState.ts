import {
  type AccountScope,
  accountIsolationService,
  detectAccountContextFromDocument,
} from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';
import {
  buildConversationIdFromUrl,
  buildLegacyConversationIdFromUrl,
  buildRouteConversationIdFromUrl,
  extractConversationIdFromUrl,
} from '@/core/utils/conversationIdentity';

import { getLegacyTurnIndex } from '../fork/turnId';
import {
  type HistoryTimestampStore,
  historyTimestampStore as sharedHistoryTimestampStore,
} from '../timestamp/historyTimestamps';
import { eventBus } from './EventBus';
import { StarredMessagesService } from './StarredMessagesService';
import {
  getTimelineHierarchyStorageKey,
  getTimelineHierarchyStorageKeysToRead,
  resolveTimelineHierarchyDataForStorageScope,
} from './hierarchyStorage';
import {
  type TimelineHierarchyConversationData,
  getLegacyTimelineCollapsedStorageKey,
  getLegacyTimelineLevelsStorageKey,
} from './hierarchyTypes';
import { findMatchingStarredMessages } from './starredLookup';
import { resolveStarredDisplay } from './starredResolution';
import type { StarredMessage, StarredMessagesData } from './starredTypes';
import type { MarkerLevel, TimelineMarker } from './types';

/** Conversation-scoped stars and hierarchy. Rendering never writes storage. */
export class TimelineState {
  readonly conversationId: string;
  markers: TimelineMarker[] = [];
  readonly markerMap = new Map<string, TimelineMarker>();
  markerLevelEnabled = false;
  private destroyed = false;
  private starred = new Set<string>();
  private starDisplayOverride = new Map<string, boolean>();
  private starStorageIdsByMarkerId = new Map<string, string[]>();
  private markerLevels = new Map<string, MarkerLevel>();
  private collapsedMarkers = new Set<string>();
  private timelineHierarchyAccountScope: AccountScope | null = null;
  private timelineHierarchyStorageKey: string = StorageKeys.TIMELINE_HIERARCHY;
  private onStorage: ((e: StorageEvent) => void) | null = null;
  private onChromeStorageChanged:
    | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
    | null = null;
  private eventBusUnsubscribers: Array<() => void> = [];
  constructor(
    private readonly onChange: () => void,
    private readonly url = window.location.href,
    private readonly historyTimestampStore: Pick<
      HistoryTimestampStore,
      'getTurnIdAliases' | 'resolveCanonicalTurnId'
    > = sharedHistoryTimestampStore,
  ) {
    this.conversationId = buildConversationIdFromUrl(url);
  }
  async init(): Promise<void> {
    if (this.destroyed) return;
    this.listen();
    this.loadStars();
    await this.syncStarredFromService();
    if (this.destroyed) return;
    await this.loadTimelineHierarchyStorageContext();
    if (this.destroyed) return;
    if (this.timelineHierarchyStorageKey === StorageKeys.TIMELINE_HIERARCHY) {
      this.loadMarkerLevels();
      this.loadCollapsedMarkers();
    }
    await this.loadTimelineHierarchyFromExtensionStorage();
  }
  replaceMarkers(markers: TimelineMarker[]): void {
    this.markers = markers;
    this.markerMap.clear();
    for (const marker of markers) this.markerMap.set(marker.id, marker);
    this.recomputeStarredDisplay();
    for (const marker of markers) marker.starred = this.isMarkerStarred(marker.id);
  }
  private listen(): void {
    this.onStorage = (e: StorageEvent) => {
      if (!e || e.storageArea !== localStorage) return;
      const expectedKey = this.getStarsStorageKey();
      if (!expectedKey || e.key !== expectedKey) return;
      let nextArr: string[] = [];
      try {
        nextArr = JSON.parse(e.newValue || '[]') || [];
      } catch {
        nextArr = [];
      }
      const nextSet = new Set(nextArr.map(String));
      this.applyStarredIdSet(nextSet, false);
    };
    window.addEventListener('storage', this.onStorage);

    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      this.onChromeStorageChanged = (changes, areaName) => {
        if (areaName === 'local') {
          const starredChange = changes[StorageKeys.TIMELINE_STARRED_MESSAGES];
          if (starredChange) {
            this.applySharedStarredData(starredChange.newValue as StarredMessagesData | null);
          }

          const timelineHierarchyChange = changes[this.timelineHierarchyStorageKey];
          if (timelineHierarchyChange && this.conversationId) {
            const data = resolveTimelineHierarchyDataForStorageScope(
              {
                [this.timelineHierarchyStorageKey]: timelineHierarchyChange.newValue,
              },
              this.timelineHierarchyAccountScope?.accountKey,
              this.timelineHierarchyAccountScope?.routeUserId ?? null,
            );
            const conversationData = data.conversations[this.conversationId] || null;
            this.applyTimelineHierarchyConversationData(conversationData);
            if (this.timelineHierarchyStorageKey === StorageKeys.TIMELINE_HIERARCHY) {
              this.persistTimelineHierarchyToLegacyStorage();
            }
            this.onChange();
          }
        }
      };
      chrome.storage.onChanged.addListener(this.onChromeStorageChanged);
    }

    // Subscribe to EventBus for cross-component starred state synchronization
    this.eventBusUnsubscribers.push(
      eventBus.on('starred:removed', ({ conversationId, turnId }) => {
        // Only handle events for current conversation
        if (conversationId !== this.conversationId) return;

        // Update local starred set
        if (this.starred.has(turnId)) {
          this.starred.delete(turnId);
          this.saveStars();
          this.refreshStars();
        }
      }),
    );

    this.eventBusUnsubscribers.push(
      eventBus.on('starred:added', ({ conversationId, turnId }) => {
        // Only handle events for current conversation
        if (conversationId !== this.conversationId) return;

        // Update local starred set
        if (!this.starred.has(turnId)) {
          this.starred.add(turnId);
          this.saveStars();
          this.refreshStars();
        }
      }),
    );
  }
  destroy(): void {
    this.destroyed = true;
    if (this.onStorage) window.removeEventListener('storage', this.onStorage);
    if (this.onChromeStorageChanged)
      chrome.storage.onChanged.removeListener(this.onChromeStorageChanged);
    this.eventBusUnsubscribers.forEach((unsubscribe) => unsubscribe());
    this.eventBusUnsubscribers = [];
  }
  private getStarsStorageKey(): string | null {
    return this.conversationId ? `geminiTimelineStars:${this.conversationId}` : null;
  }

  private getLegacyStarsStorageKey(): string | null {
    const legacyConversationId = buildLegacyConversationIdFromUrl(this.url);
    return legacyConversationId ? `geminiTimelineStars:${legacyConversationId}` : null;
  }

  private getRouteStarsStorageKey(): string | null {
    const routeConversationId = buildRouteConversationIdFromUrl(this.url);
    return routeConversationId ? `geminiTimelineStars:${routeConversationId}` : null;
  }

  private safeLocalStorageGet(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.warn('[Timeline] Failed to read from localStorage:', error);
      return null;
    }
  }

  private safeLocalStorageSet(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      console.warn('[Timeline] Failed to write to localStorage:', error);
    }
  }

  private areStarredSetsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const value of a) {
      if (!b.has(value)) return false;
    }
    return true;
  }

  /**
   * Recompute which mounted turn each stored star belongs to. Cheap enough to
   * run on every star/marker change; never touches storage.
   */
  private recomputeStarredDisplay(): void {
    const { displayByMarkerId, storageIdsByMarkerId } = resolveStarredDisplay({
      markers: this.markers,
      starredIds: this.starred,
      resolveCanonicalId: (storedId) => this.resolveCanonicalTurnId(storedId),
    });
    this.starDisplayOverride = displayByMarkerId;
    this.starStorageIdsByMarkerId = storageIdsByMarkerId;
  }

  isMarkerStarred(markerId: string): boolean {
    const override = this.starDisplayOverride.get(markerId);
    if (override !== undefined) return override;
    return this.starred.has(markerId);
  }

  private getStarStorageIds(markerId: string): string[] {
    return this.starStorageIdsByMarkerId.get(markerId) ?? [markerId];
  }

  private resolveCanonicalTurnId(turnId: string): string | null {
    const nativeConversationId = extractConversationIdFromUrl(this.url);
    if (nativeConversationId) {
      return this.historyTimestampStore.resolveCanonicalTurnId(nativeConversationId, turnId);
    }
    return getLegacyTurnIndex(turnId) === null ? turnId : null;
  }

  /** Recompute star ownership and repaint every marker to match. */
  refreshStars(): void {
    this.recomputeStarredDisplay();
    for (const marker of this.markers) {
      const want = this.isMarkerStarred(marker.id);
      if (marker.starred !== want) {
        marker.starred = want;
      }
    }
    this.onChange();
  }

  private applyStarredIdSet(nextSet: Set<string>, persistLocal = true): void {
    if (this.areStarredSetsEqual(this.starred, nextSet)) {
      this.refreshStars();
      return;
    }

    this.starred = new Set(nextSet);

    if (persistLocal) this.saveStars();

    this.refreshStars();
  }

  private applySharedStarredData(data?: StarredMessagesData | null): void {
    if (!this.conversationId) return;

    // Use the same matching rules as syncStarredFromService (init path): stars
    // may live under a legacy/route conversation-id key, and a direct-key-only
    // lookup would wrongly clear this conversation's stars whenever a star
    // changes in another conversation.
    const normalized: StarredMessagesData = { messages: data?.messages ?? {} };
    const matched = findMatchingStarredMessages(normalized, this.conversationId, this.url);
    const nextSet = new Set(matched.messages.map((message) => String(message.turnId)));

    this.applyStarredIdSet(nextSet);
  }

  private async syncStarredFromService(): Promise<void> {
    if (!this.conversationId) return;
    try {
      const data = await StarredMessagesService.getAllStarredMessages();
      if (this.destroyed) return;
      const matched = findMatchingStarredMessages(data, this.conversationId, this.url);

      let messages = matched.messages;
      const needsReconcile = matched.sourceConversationIds.some(
        (sourceConversationId) => sourceConversationId !== this.conversationId,
      );

      if (needsReconcile) {
        const reconciled = await StarredMessagesService.reconcileConversationIds(
          this.conversationId,
          matched.sourceConversationIds,
          this.url,
        );
        if (this.destroyed) return;
        if (reconciled.length > 0) {
          messages = reconciled;
        }
      }

      const nextSet = new Set(messages.map((message) => String(message.turnId)));

      this.applyStarredIdSet(nextSet);
    } catch (error) {
      console.warn('[Timeline] Failed to sync starred messages from shared storage:', error);
    }
  }

  private getConversationTitle(): string {
    const selected = document
      .querySelector('.gv-folder-conversation-selected .gv-conversation-title')
      ?.textContent?.trim();
    if (selected) return selected;
    const title = document.querySelector('title')?.textContent?.trim();
    if (
      title &&
      !['Gemini', 'Google Gemini', 'Google AI Studio'].includes(title) &&
      !title.startsWith('Gemini -') &&
      !title.startsWith('Google AI Studio -')
    )
      return title;
    for (const selector of [
      'mat-list-item.mdc-list-item--activated [mat-line]',
      'mat-list-item[aria-current="page"] [mat-line]',
      '.conversation-list-item.active .conversation-title',
      '.active-conversation .title',
    ]) {
      const text = document.querySelector(selector)?.textContent?.trim();
      if (text && text !== 'New chat') return text;
    }
    const summary = this.markers[0]?.summary;
    if (summary) return summary.length > 50 ? `${summary.slice(0, 50)}...` : summary;
    const id = new URL(this.url).pathname.match(/\/app\/([a-zA-Z0-9_-]+)/)?.[1];
    return id ? `Conversation ${id.slice(0, 8)}...` : 'Untitled Conversation';
  }

  async toggleStar(turnId: string): Promise<void> {
    const id = String(turnId || '');
    if (!id) return;
    // A mounted `u-N` is only the current DOM-window index. Even when a cache
    // exists, it is not evidence that this node is full-conversation turn N.
    if (getLegacyTurnIndex(id) !== null) return;

    const wasStarred = this.isMarkerStarred(id);
    const marker = this.markerMap.get(id);
    // A stable marker may represent both its current server-id record and an
    // older verified positional alias. Removing the star clears both records.
    const storageIds = wasStarred ? this.getStarStorageIds(id) : [id];

    if (wasStarred) {
      storageIds.forEach((storageId) => {
        this.starred.delete(storageId);
      });
    } else {
      this.starred.add(id);
    }

    this.saveStars();

    // Update global starred messages service
    if (wasStarred) {
      await Promise.all(
        storageIds.map((storageId) =>
          StarredMessagesService.removeStarredMessage(this.conversationId!, storageId),
        ),
      );
    } else {
      // Add to global storage with full message info
      if (marker) {
        const conversationTitle = this.getConversationTitle();
        const now = Date.now();
        const message: StarredMessage = {
          turnId: id,
          content: marker.summary,
          conversationId: this.conversationId!,
          conversationUrl: this.url,
          conversationTitle,
          starredAt: now,
        };
        await StarredMessagesService.addStarredMessage(message);
      }
    }

    this.refreshStars();
  }

  /**
   * Resolve which mounted marker currently carries a stored star. Used by
   * `#gv-turn-<id>` deep links, whose ids come from storage and may have been
   * relocated onto a different index.
   */
  resolveMarkerIdForStorageId(storageId: string): string {
    for (const [markerId, ids] of this.starStorageIdsByMarkerId) {
      if (ids.includes(storageId)) return markerId;
    }
    return storageId;
  }

  private saveStars(): void {
    const key = this.getStarsStorageKey();
    if (!key) return;
    this.safeLocalStorageSet(key, JSON.stringify(Array.from(this.starred)));
  }

  private loadStars(): void {
    this.starred.clear();
    const key = this.getStarsStorageKey();
    if (!key) return;

    const fallbackKeys = [this.getRouteStarsStorageKey(), this.getLegacyStarsStorageKey()].filter(
      (candidate): candidate is string => Boolean(candidate && candidate !== key),
    );

    let raw = this.safeLocalStorageGet(key);
    if (!raw) {
      for (const fallbackKey of fallbackKeys) {
        raw = this.safeLocalStorageGet(fallbackKey);
        if (raw) {
          this.safeLocalStorageSet(key, raw);
          break;
        }
      }
    }
    if (!raw) return;

    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr.forEach((id: unknown) => this.starred.add(String(id)));
      }
    } catch (error) {
      console.warn('[Timeline] Failed to parse starred messages:', error);
    }
  }

  // ===== Marker Level Methods =====

  private getLevelsStorageKey(): string | null {
    return this.conversationId ? getLegacyTimelineLevelsStorageKey(this.conversationId) : null;
  }

  /* Load marker levels from legacy localStorage */
  private loadMarkerLevels(): void {
    this.markerLevels.clear();
    const key = this.getLevelsStorageKey();
    if (!key) return;

    const raw = this.safeLocalStorageGet(key);
    if (!raw) return;

    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      Object.entries(obj).forEach(([turnId, level]) => {
        if (level === 1 || level === 2 || level === 3) {
          this.markerLevels.set(turnId, level);
        }
      });
    } catch (error) {
      console.warn('[Timeline] Failed to parse marker levels:', error);
    }
  }

  /* Save marker levels to legacy localStorage and mirrored extension storage */
  private saveHierarchy(): void {
    if (this.timelineHierarchyStorageKey === StorageKeys.TIMELINE_HIERARCHY) {
      this.persistTimelineHierarchyToLegacyStorage();
    }
    void this.persistTimelineHierarchyToExtensionStorage();
  }

  // ===== Collapsed Markers Methods =====

  private getCollapsedStorageKey(): string | null {
    return this.conversationId ? getLegacyTimelineCollapsedStorageKey(this.conversationId) : null;
  }

  private loadCollapsedMarkers(): void {
    this.collapsedMarkers.clear();
    const key = this.getCollapsedStorageKey();
    if (!key) return;

    const raw = this.safeLocalStorageGet(key);
    if (!raw) return;

    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr.forEach((id: unknown) => this.collapsedMarkers.add(String(id)));
      }
    } catch (error) {
      console.warn('[Timeline] Failed to parse collapsed markers:', error);
    }
  }

  private hasTimelineHierarchyData(): boolean {
    return this.markerLevels.size > 0 || this.collapsedMarkers.size > 0;
  }

  private buildTimelineHierarchyConversationData(): TimelineHierarchyConversationData | null {
    if (!this.conversationId || !this.hasTimelineHierarchyData()) {
      return null;
    }

    const levels: Record<string, MarkerLevel> = {};
    this.markerLevels.forEach((level, turnId) => {
      levels[turnId] = level;
    });

    return {
      conversationUrl: this.url,
      levels,
      collapsed: Array.from(this.collapsedMarkers),
      updatedAt: Date.now(),
    };
  }

  private buildLegacyTimelineHierarchyConversationData(): TimelineHierarchyConversationData | null {
    if (!this.conversationId) {
      return null;
    }

    const levels: Record<string, MarkerLevel> = {};
    const levelsKey = this.getLevelsStorageKey();
    if (levelsKey) {
      const rawLevels = this.safeLocalStorageGet(levelsKey);
      if (rawLevels) {
        try {
          const parsedLevels = JSON.parse(rawLevels) as Record<string, unknown>;
          Object.entries(parsedLevels).forEach(([turnId, level]) => {
            if (level === 1 || level === 2 || level === 3) {
              levels[turnId] = level;
            }
          });
        } catch (error) {
          console.warn('[Timeline] Failed to parse legacy marker levels:', error);
        }
      }
    }

    let collapsed: string[] = [];
    const collapsedKey = this.getCollapsedStorageKey();
    if (collapsedKey) {
      const rawCollapsed = this.safeLocalStorageGet(collapsedKey);
      if (rawCollapsed) {
        try {
          const parsedCollapsed = JSON.parse(rawCollapsed);
          if (Array.isArray(parsedCollapsed)) {
            collapsed = parsedCollapsed.map((turnId: unknown) => String(turnId));
          }
        } catch (error) {
          console.warn('[Timeline] Failed to parse legacy collapsed markers:', error);
        }
      }
    }

    if (Object.keys(levels).length === 0 && collapsed.length === 0) {
      return null;
    }

    return {
      conversationUrl: this.url,
      levels,
      collapsed,
      updatedAt: Date.now(),
    };
  }

  private applyTimelineHierarchyConversationData(
    conversationData: TimelineHierarchyConversationData | null,
  ): void {
    this.markerLevels.clear();
    this.collapsedMarkers.clear();

    if (!conversationData) {
      return;
    }

    Object.entries(conversationData.levels).forEach(([turnId, level]) => {
      this.markerLevels.set(turnId, level);
    });
    conversationData.collapsed.forEach((turnId) => this.collapsedMarkers.add(turnId));
  }

  private async loadTimelineHierarchyStorageContext(): Promise<void> {
    this.timelineHierarchyAccountScope = null;
    this.timelineHierarchyStorageKey = StorageKeys.TIMELINE_HIERARCHY;

    try {
      const context = detectAccountContextFromDocument(this.url, document);
      if (!context.routeUserId && !context.email) {
        return;
      }
      const scope = await accountIsolationService.resolveAccountScope({
        pageUrl: this.url,
        routeUserId: context.routeUserId,
        email: context.email,
      });

      this.timelineHierarchyAccountScope = scope;
      this.timelineHierarchyStorageKey = getTimelineHierarchyStorageKey(scope.accountKey);
    } catch (error) {
      console.warn('[Timeline] Failed to resolve timeline hierarchy storage scope:', error);
      this.timelineHierarchyAccountScope = null;
      this.timelineHierarchyStorageKey = StorageKeys.TIMELINE_HIERARCHY;
    }
  }

  private persistTimelineHierarchyToLegacyStorage(): void {
    const levelsKey = this.getLevelsStorageKey();
    if (levelsKey) {
      const levels: Record<string, MarkerLevel> = {};
      this.markerLevels.forEach((level, turnId) => {
        levels[turnId] = level;
      });
      this.safeLocalStorageSet(levelsKey, JSON.stringify(levels));
    }

    const collapsedKey = this.getCollapsedStorageKey();
    if (collapsedKey) {
      this.safeLocalStorageSet(collapsedKey, JSON.stringify(Array.from(this.collapsedMarkers)));
    }
  }

  private async loadTimelineHierarchyFromExtensionStorage(): Promise<void> {
    if (!this.conversationId || typeof chrome === 'undefined' || !chrome.storage?.local?.get) {
      return;
    }

    try {
      const storageValues = (await chrome.storage.local.get(
        getTimelineHierarchyStorageKeysToRead(this.timelineHierarchyAccountScope?.accountKey),
      )) as Record<string, unknown>;
      if (this.destroyed) return;
      const data = resolveTimelineHierarchyDataForStorageScope(
        storageValues,
        this.timelineHierarchyAccountScope?.accountKey,
        this.timelineHierarchyAccountScope?.routeUserId ?? null,
      );
      const conversationData = data.conversations[this.conversationId] || null;

      if (conversationData) {
        this.applyTimelineHierarchyConversationData(conversationData);
        if (this.timelineHierarchyStorageKey === StorageKeys.TIMELINE_HIERARCHY) {
          this.persistTimelineHierarchyToLegacyStorage();
        }
        return;
      }

      if (this.timelineHierarchyStorageKey !== StorageKeys.TIMELINE_HIERARCHY) {
        const legacyConversationData = this.buildLegacyTimelineHierarchyConversationData();
        if (legacyConversationData) {
          this.applyTimelineHierarchyConversationData(legacyConversationData);
          await this.persistTimelineHierarchyToExtensionStorage();
          return;
        }
      }

      if (this.hasTimelineHierarchyData()) {
        await this.persistTimelineHierarchyToExtensionStorage();
      }
    } catch (error) {
      console.warn('[Timeline] Failed to load timeline hierarchy from extension storage:', error);
    }
  }

  private async persistTimelineHierarchyToExtensionStorage(): Promise<void> {
    if (!this.conversationId || typeof chrome === 'undefined' || !chrome.storage?.local?.get) {
      return;
    }

    try {
      const storageValues = (await chrome.storage.local.get(
        getTimelineHierarchyStorageKeysToRead(this.timelineHierarchyAccountScope?.accountKey),
      )) as Record<string, unknown>;
      const existing = resolveTimelineHierarchyDataForStorageScope(
        storageValues,
        this.timelineHierarchyAccountScope?.accountKey,
        this.timelineHierarchyAccountScope?.routeUserId ?? null,
      );
      const conversations = { ...existing.conversations };
      const currentConversationData = this.buildTimelineHierarchyConversationData();

      if (currentConversationData) {
        conversations[this.conversationId] = currentConversationData;
      } else {
        delete conversations[this.conversationId];
      }

      await chrome.storage.local.set({
        [this.timelineHierarchyStorageKey]: { conversations },
      });
    } catch (error) {
      console.warn('[Timeline] Failed to persist timeline hierarchy to extension storage:', error);
    }
  }

  isMarkerCollapsed(turnId: string): boolean {
    return this.getStoredTurnIdAliases(turnId).some((alias) => this.collapsedMarkers.has(alias));
  }

  /** Current id plus a legacy alias proved by the complete hNvQHb list. */
  getStoredTurnIdAliases(turnId: string): string[] {
    // This method receives a mounted marker id. Never reinterpret its fallback
    // DOM-window position as a stored full-conversation position.
    if (getLegacyTurnIndex(turnId) !== null) return [];
    const nativeConversationId = extractConversationIdFromUrl(this.url);
    if (!nativeConversationId) return [turnId];
    const aliases = this.historyTimestampStore.getTurnIdAliases(nativeConversationId, turnId);
    if (aliases.length > 0) return aliases;
    return [turnId];
  }

  toggleCollapse(turnId: string): void {
    const aliases = this.getStoredTurnIdAliases(turnId);
    if (aliases.length === 0) return;
    if (aliases.some((alias) => this.collapsedMarkers.has(alias))) {
      aliases.forEach((alias) => this.collapsedMarkers.delete(alias));
    } else {
      this.collapsedMarkers.add(turnId);
    }
    this.saveHierarchy();
    this.onChange();
  }

  getHiddenMarkerIndices(): Set<number> {
    const hidden = new Set<number>();

    // If marker level feature is disabled, no markers are hidden
    if (!this.markerLevelEnabled) {
      return hidden;
    }

    for (let i = 0; i < this.markers.length; i++) {
      // Skip markers that are already hidden by a parent collapse
      if (hidden.has(i)) continue;

      const marker = this.markers[i];
      const level = this.getMarkerLevel(marker.id);

      // If this marker is collapsed, hide all subsequent lower-level markers
      if (this.isMarkerCollapsed(marker.id)) {
        for (let j = i + 1; j < this.markers.length; j++) {
          const nextMarker = this.markers[j];
          const nextLevel = this.getMarkerLevel(nextMarker.id);

          // Stop when we reach a marker of same or higher level (lower number)
          if (nextLevel <= level) {
            break;
          }

          // Hide this marker (only direct descendants of this collapsed parent)
          hidden.add(j);
        }
      }
    }

    return hidden;
  }

  private calculateEffectiveBaseN(markerIndex: number): number {
    const marker = this.markers[markerIndex];
    if (!marker) return 0;

    const baseN = marker.baseN;

    // If this marker is not collapsed, just return its baseN
    if (!this.isMarkerCollapsed(marker.id)) {
      return baseN;
    }

    // Find the range of hidden children
    const level = this.getMarkerLevel(marker.id);
    let childContribution = 0;

    for (let j = markerIndex + 1; j < this.markers.length; j++) {
      const nextMarker = this.markers[j];
      const nextLevel = this.getMarkerLevel(nextMarker.id);

      // Stop when we reach a marker of same or higher level
      if (nextLevel <= level) {
        break;
      }

      // Add half of child's contribution based on level difference
      const childBaseN = nextMarker.baseN;
      const prevBaseN = j > 0 ? this.markers[j - 1].baseN : 0;
      const childLength = childBaseN - prevBaseN;
      const levelDiff = nextLevel - level;
      childContribution += childLength * Math.pow(0.5, levelDiff);
    }

    return baseN + childContribution;
  }

  calculateCollapsedPositions(
    hiddenIndices: Set<number>,
    pad: number,
    usableC: number,
  ): { desiredY: number[]; effectiveBaseNs: number[] } {
    const N = this.markers.length;
    const desiredY: number[] = new Array(N).fill(-1);
    const effectiveBaseNs: number[] = new Array(N).fill(0);

    // First pass: calculate effective baseN for all visible markers
    const visibleMarkers: { index: number; effectiveN: number }[] = [];

    for (let i = 0; i < N; i++) {
      if (hiddenIndices.has(i)) continue;

      const effectiveN = this.calculateEffectiveBaseN(i);
      effectiveBaseNs[i] = effectiveN;
      visibleMarkers.push({ index: i, effectiveN });
    }

    // Sort visible markers by their effective baseN (maintains relative order based on length)
    visibleMarkers.sort((a, b) => a.effectiveN - b.effectiveN);

    // Calculate total effective range
    if (visibleMarkers.length === 0) {
      return { desiredY, effectiveBaseNs };
    }

    const minEffectiveN = visibleMarkers[0].effectiveN;
    const maxEffectiveN = visibleMarkers[visibleMarkers.length - 1].effectiveN;
    const effectiveRange = maxEffectiveN - minEffectiveN;

    // Distribute positions proportionally
    for (const vm of visibleMarkers) {
      let normalizedN: number;
      if (effectiveRange > 0) {
        normalizedN = (vm.effectiveN - minEffectiveN) / effectiveRange;
      } else {
        normalizedN = visibleMarkers.indexOf(vm) / Math.max(1, visibleMarkers.length - 1);
      }

      desiredY[vm.index] = pad + normalizedN * usableC;
    }

    return { desiredY, effectiveBaseNs };
  }

  /**
   * Check if a marker can be collapsed (has lower-level children)
   */
  canCollapseMarker(turnId: string): boolean {
    const markerIndex = this.markers.findIndex((m) => m.id === turnId);
    if (markerIndex < 0 || markerIndex >= this.markers.length - 1) return false;

    const level = this.getMarkerLevel(turnId);

    const nextMarker = this.markers[markerIndex + 1];
    if (!nextMarker) return false;

    const nextLevel = this.getMarkerLevel(nextMarker.id);
    return nextLevel > level;
  }

  getMarkerLevel(turnId: string): MarkerLevel {
    for (const alias of this.getStoredTurnIdAliases(turnId)) {
      const level = this.markerLevels.get(alias);
      if (level) return level;
    }
    return 1;
  }

  setMarkerLevel(turnId: string, level: MarkerLevel): void {
    // A user edit is a safe point to converge a verified legacy alias onto the
    // canonical server id. Delete every known representation first so reset to
    // level 1 cannot be shadowed by an old u-N entry.
    const aliases = this.getStoredTurnIdAliases(turnId);
    if (aliases.length === 0) return;
    aliases.forEach((alias) => this.markerLevels.delete(alias));
    if (level !== 1) {
      this.markerLevels.set(turnId, level);
    }
    this.saveHierarchy();
    this.onChange();
  }
}
