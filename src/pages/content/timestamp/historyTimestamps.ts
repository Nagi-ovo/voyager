/**
 * History timestamps — real server-side message times for the timeline.
 *
 * Gemini's conversation-load RPC (`hNvQHb` batchexecute) carries a
 * `[seconds, nanos]` server timestamp for every turn. The MAIN-world
 * `public/conversation-history-observer.js` captures those responses and
 * bridges them here via window.postMessage; this module parses them and the
 * TimelineManager matches the parsed turns to its markers so tooltips and
 * inline timestamps show when a message was actually sent — even for
 * conversations that happened on another device.
 *
 * Parsing is structural and defensive: Gemini's payload shape can change
 * without notice, so every access narrows `unknown` and any mismatch yields
 * an empty result (the feature silently falls back to first-seen recording).
 *
 * Observed turn shape (2026-07, see hNvQHb capture):
 * ```
 * [ [cid, rid],                         // ids; cid like "c_26dfc929fd75fe3d"
 *   [cid, rid, rcid],
 *   [[userText, ...], 2, null, 1, ...], // user query
 *   [[[rcid, [modelText], ...]]],       // model response candidates
 *   ...,
 *   [seconds, nanos] ]                  // ★ turn timestamp (a direct child)
 * ```
 */
import { StorageKeys } from '@/core/types/common';
import { decodeBatchExecute } from '@/core/utils/batchexecute';

import {
  getLegacyTurnIndex,
  isServerTurnId,
  makeServerTurnId,
  makeStableTurnId,
} from '../fork/turnId';

// Bridge to the MAIN-world conversation-history-observer (document_start).
// Must match the `source` strings in public/conversation-history-observer.js.
const OBS_SRC = 'gv-history-observer';
const OBS_CMD = 'gv-history-observer-cmd';

// Epoch-seconds sanity window for a turn timestamp: 2015..2096.
const MIN_EPOCH_SEC = 1_420_000_000;
const MAX_EPOCH_SEC = 4_000_000_000;
const MAX_NANOS = 1_000_000_000;

export interface HistoryTurnTimestamp {
  /** Stable response identity from Gemini's `[cid, rid]` tuple. */
  turnId: string;
  /** User query text as the server stored it (whitespace-collapsed). */
  userText: string;
  /** Turn creation time in ms since epoch. */
  timestampMs: number;
}

export interface HistoryTurnIdentity {
  /** Stable response identity from Gemini's `[cid, rid]` tuple. */
  turnId: string;
  /** User text is optional for identity; malformed text must not shift later indexes. */
  userText: string | null;
  /** Timestamp is optional for identity; malformed time must not shift later indexes. */
  timestampMs: number | null;
}

/** Collapse whitespace so DOM-derived and API-derived text compare equal. */
export function normalizeTurnText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isConversationCid(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('c_');
}

/** A turn's timestamp is a `[seconds, nanos]` pair among its direct children. */
function findTurnTimestampMs(turn: unknown[]): number | null {
  for (let i = turn.length - 1; i >= 0; i--) {
    const child = turn[i];
    if (!Array.isArray(child) || child.length < 2) continue;
    const [sec, nanos] = child;
    if (typeof sec !== 'number' || !Number.isInteger(sec)) continue;
    if (typeof nanos !== 'number' || nanos < 0 || nanos >= MAX_NANOS) continue;
    if (sec < MIN_EPOCH_SEC || sec > MAX_EPOCH_SEC) continue;
    return sec * 1000 + Math.round(nanos / 1_000_000);
  }
  return null;
}

/** User text sits at turn[2][0][0]. */
function findTurnUserText(turn: unknown[]): string | null {
  const query = turn[2];
  if (!Array.isArray(query)) return null;
  const textWrap = query[0];
  if (!Array.isArray(textWrap)) return null;
  const text = textWrap[0];
  return typeof text === 'string' && text.trim() ? normalizeTurnText(text) : null;
}

function readTurn(value: unknown): { cid: string; turn: HistoryTurnIdentity } | null {
  if (!Array.isArray(value)) return null;
  const idTuple = value[0];
  if (!Array.isArray(idTuple) || !isConversationCid(idTuple[0])) return null;
  const turnId = typeof idTuple[1] === 'string' ? makeServerTurnId(idTuple[1]) : null;
  if (!turnId) return null;

  return {
    cid: idTuple[0],
    turn: {
      turnId,
      userText: findTurnUserText(value),
      timestampMs: findTurnTimestampMs(value),
    },
  };
}

/**
 * Extract the complete ordered turn list used for reliable legacy aliases.
 * Entries remain in place even when optional text/timestamp fields are absent.
 */
export function extractHistoryTurnIdentities(payload: unknown): Map<string, HistoryTurnIdentity[]> {
  const byCid = new Map<string, HistoryTurnIdentity[]>();
  if (!Array.isArray(payload)) return byCid;

  const turnList = payload.find(
    (candidate): candidate is unknown[] =>
      Array.isArray(candidate) && candidate.some((item) => readTurn(item) !== null),
  );
  if (!turnList) return byCid;

  turnList.forEach((item) => {
    const read = readTurn(item);
    if (!read) return;
    const existing = byCid.get(read.cid);
    if (existing) existing.push(read.turn);
    else byCid.set(read.cid, [read.turn]);
  });
  return byCid;
}

/**
 * Extract per-conversation turn timestamps from one decoded hNvQHb payload.
 * Each timestamp stays attached to the same server response id used by the DOM.
 */
export function extractHistoryTurns(payload: unknown): Map<string, HistoryTurnTimestamp[]> {
  const byCid = new Map<string, HistoryTurnTimestamp[]>();
  extractHistoryTurnIdentities(payload).forEach((turns, cid) => {
    const complete = turns.flatMap((turn): HistoryTurnTimestamp[] => {
      if (turn.userText == null || turn.timestampMs == null) return [];
      return [{ turnId: turn.turnId, userText: turn.userText, timestampMs: turn.timestampMs }];
    });
    if (complete.length > 0) byCid.set(cid, complete);
  });
  return byCid;
}

interface ObserverCapturePayload {
  id?: string;
  url?: string;
  body?: string;
}

type HistoryTimestampSubscriber = (cids: string[]) => void;

const MAX_CACHED_CONVERSATIONS = 16;
const MAX_PROCESSED_CAPTURE_IDS = 64;
const MAX_PERSISTED_IDENTITY_CONVERSATIONS = 32;

interface PersistedTurnIdentityConversation {
  turnIds: string[];
  updatedAt: number;
}

interface PersistedTurnIdentityCache {
  version: 1;
  conversations: Record<string, PersistedTurnIdentityConversation>;
}

function readPersistedIdentityConversation(
  value: unknown,
): PersistedTurnIdentityConversation | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { turnIds?: unknown; updatedAt?: unknown };
  if (!Array.isArray(candidate.turnIds) || candidate.turnIds.length === 0) return null;
  const turnIds = candidate.turnIds.map((turnId) => String(turnId));
  if (!turnIds.every(isServerTurnId) || new Set(turnIds).size !== turnIds.length) return null;
  if (typeof candidate.updatedAt !== 'number' || !Number.isFinite(candidate.updatedAt)) return null;
  return { turnIds, updatedAt: candidate.updatedAt };
}

/**
 * Receives observer captures and keeps parsed turns per conversation cid.
 * Later captures for the same conversation (pagination, revisits) merge in;
 * duplicates dedupe on text+time.
 */
export class HistoryTimestampStore {
  private byCid = new Map<string, Map<string, HistoryTurnTimestamp>>();
  /** Complete ordered server ids from hNvQHb, including unmounted DOM turns. */
  private turnIdsByCid = new Map<string, string[]>();
  private turnIdentityUpdatedAt = new Map<string, number>();
  private cidRevisions = new Map<string, number>();
  private revisionCounter = 0;
  private processedCaptureIds = new Set<string>();
  private subscribers = new Set<HistoryTimestampSubscriber>();
  private handler: ((ev: MessageEvent) => void) | null = null;
  private identityCacheReady: Promise<void> | null = null;

  /**
   * Start the page-lifetime bridge and hydrate the durable identity cache.
   * Identity capture is always enabled; the timestamp setting only controls UI.
   */
  start(_legacyTimestampSetting?: boolean): Promise<void> {
    if (this.handler) {
      return this.ensureIdentityCacheLoaded();
    }

    this.handler = (ev: MessageEvent) => {
      if (ev.source !== window || ev.origin !== window.location.origin) return;
      const data = ev.data as { source?: string; type?: string; payload?: unknown } | null;
      if (!data || data.source !== OBS_SRC || data.type !== 'capture') return;
      this.consumeCapture(data.payload as ObserverCapturePayload);
    };
    window.addEventListener('message', this.handler);
    this.configureObserver(true);
    const ready = this.ensureIdentityCacheLoaded();
    void ready.finally(() => this.flushObserver());
    return ready;
  }

  /** @deprecated Identity capture no longer follows the timestamp UI toggle. */
  setEnabled(_enabled: boolean): void {}

  /** Subscribe a TimelineManager; destroying one manager only removes its callback. */
  subscribe(subscriber: HistoryTimestampSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Stop the page-lifetime bridge (page unload and isolated unit tests only). */
  stop(): void {
    if (this.handler) {
      window.removeEventListener('message', this.handler);
      this.handler = null;
    }
    this.configureObserver(false);
    this.byCid.clear();
    this.turnIdsByCid.clear();
    this.turnIdentityUpdatedAt.clear();
    this.cidRevisions.clear();
    this.processedCaptureIds.clear();
    this.subscribers.clear();
    this.identityCacheReady = null;
  }

  /** Backward-compatible test/helper alias. TimelineManager must not call this on SPA switches. */
  dispose(): void {
    this.stop();
  }

  /**
   * Turns for a conversation, by the native id from the URL
   * (e.g. `26dfc929fd75fe3d` for cid `c_26dfc929fd75fe3d`).
   */
  getTurns(nativeConversationId: string): HistoryTurnTimestamp[] | null {
    const cid = `c_${nativeConversationId}`;
    const turns = this.byCid.get(cid);
    if (!turns || turns.size === 0) return null;
    // Map insertion order doubles as a compact LRU for parsed conversations.
    this.byCid.delete(cid);
    this.byCid.set(cid, turns);
    return Array.from(turns.values());
  }

  /** Latest real server-side turn time available for one conversation. */
  getLatestTurnTimestamp(nativeConversationId: string): number | null {
    const turns = this.getTurns(nativeConversationId);
    if (!turns) return null;

    let latest = -Infinity;
    turns.forEach(({ timestampMs }) => {
      if (timestampMs > latest) latest = timestampMs;
    });
    return Number.isFinite(latest) ? latest : null;
  }

  /** Monotonic version of the parsed inputs for one native conversation. */
  getRevision(nativeConversationId: string): number {
    return this.cidRevisions.get(`c_${nativeConversationId}`) ?? 0;
  }

  /** Whether a complete ordered hNvQHb identity list is available. */
  hasTurnIdentityMap(nativeConversationId: string): boolean {
    return (this.turnIdsByCid.get(`c_${nativeConversationId}`)?.length ?? 0) > 0;
  }

  /** Resolve either an old positional id or a server id to the canonical server id. */
  resolveCanonicalTurnId(nativeConversationId: string, turnId: string): string | null {
    const trimmed = turnId.trim();
    if (!trimmed) return null;
    if (isServerTurnId(trimmed)) return trimmed.toLowerCase();

    const legacyIndex = getLegacyTurnIndex(trimmed);
    if (legacyIndex === null) return trimmed;
    return this.turnIdsByCid.get(`c_${nativeConversationId}`)?.[legacyIndex] ?? null;
  }

  /** Reliable positional alias for a server id, never derived from mounted DOM order. */
  getLegacyTurnId(nativeConversationId: string, serverTurnId: string): string | null {
    if (!isServerTurnId(serverTurnId)) return null;
    const turnIds = this.turnIdsByCid.get(`c_${nativeConversationId}`);
    if (!turnIds) return null;
    const index = turnIds.indexOf(serverTurnId.toLowerCase());
    return index < 0 ? null : makeStableTurnId(index);
  }

  /** Canonical id first, followed by a verified legacy alias when one exists. */
  getTurnIdAliases(nativeConversationId: string, turnId: string): string[] {
    const canonical = this.resolveCanonicalTurnId(nativeConversationId, turnId);
    if (!canonical) return [];
    const aliases = [canonical];
    const legacy = this.getLegacyTurnId(nativeConversationId, canonical);
    if (legacy && legacy !== canonical) aliases.push(legacy);
    return aliases;
  }

  private postCommand(type: 'configure' | 'flush' | 'ack', payload?: unknown): void {
    try {
      window.postMessage({ source: OBS_CMD, type, payload }, window.location.origin);
    } catch {
      // Observer absent (injection blocked or extension context invalidated).
    }
  }

  private configureObserver(enabled: boolean): void {
    this.postCommand('configure', { enabled });
  }

  private flushObserver(): void {
    this.postCommand('flush');
  }

  private acknowledgeCapture(id: string): void {
    this.postCommand('ack', { id });
  }

  private rememberCapture(id: string): boolean {
    if (this.processedCaptureIds.has(id)) return false;
    this.processedCaptureIds.add(id);
    while (this.processedCaptureIds.size > MAX_PROCESSED_CAPTURE_IDS) {
      const oldest = this.processedCaptureIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.processedCaptureIds.delete(oldest);
    }
    return true;
  }

  private touchConversation(
    cid: string,
    turns?: Map<string, HistoryTurnTimestamp>,
  ): Map<string, HistoryTurnTimestamp> {
    const existing = turns ?? this.byCid.get(cid) ?? new Map<string, HistoryTurnTimestamp>();
    this.byCid.delete(cid);
    this.byCid.set(cid, existing);
    while (this.byCid.size > MAX_CACHED_CONVERSATIONS) {
      const oldest = this.byCid.keys().next().value as string | undefined;
      if (!oldest) break;
      this.byCid.delete(oldest);
      this.cidRevisions.delete(oldest);
    }
    return existing;
  }

  private ensureIdentityCacheLoaded(): Promise<void> {
    if (this.identityCacheReady) return this.identityCacheReady;
    this.identityCacheReady = (async () => {
      try {
        const result = await chrome.storage.local.get({
          [StorageKeys.GV_TURN_IDENTITY_CACHE]: null,
        });
        const raw = result?.[StorageKeys.GV_TURN_IDENTITY_CACHE] as
          | { version?: unknown; conversations?: unknown }
          | null
          | undefined;
        if (raw?.version !== 1 || !raw.conversations || typeof raw.conversations !== 'object') {
          return;
        }

        Object.entries(raw.conversations as Record<string, unknown>).forEach(([cid, value]) => {
          if (!isConversationCid(cid)) return;
          const parsed = readPersistedIdentityConversation(value);
          if (!parsed) return;
          const currentUpdatedAt = this.turnIdentityUpdatedAt.get(cid) ?? 0;
          if (currentUpdatedAt > parsed.updatedAt) return;
          this.turnIdsByCid.set(cid, parsed.turnIds);
          this.turnIdentityUpdatedAt.set(cid, parsed.updatedAt);
        });
        this.pruneIdentityCache();
      } catch {
        // Cache is an optimization; live captures and server ids still work.
      }
    })();
    return this.identityCacheReady;
  }

  private pruneIdentityCache(): void {
    const ordered = Array.from(this.turnIdentityUpdatedAt.entries()).sort((a, b) => b[1] - a[1]);
    ordered.slice(MAX_PERSISTED_IDENTITY_CONVERSATIONS).forEach(([cid]) => {
      this.turnIdentityUpdatedAt.delete(cid);
      this.turnIdsByCid.delete(cid);
    });
  }

  private async persistIdentityCache(): Promise<void> {
    // A live SPA capture can arrive while the initial storage read is still in
    // flight. Merge that cache first so writing one conversation never drops
    // aliases already saved for other conversations.
    await this.ensureIdentityCacheLoaded();
    this.pruneIdentityCache();
    const conversations: Record<string, PersistedTurnIdentityConversation> = {};
    this.turnIdsByCid.forEach((turnIds, cid) => {
      conversations[cid] = {
        turnIds: [...turnIds],
        updatedAt: this.turnIdentityUpdatedAt.get(cid) ?? Date.now(),
      };
    });
    const cache: PersistedTurnIdentityCache = { version: 1, conversations };
    try {
      await chrome.storage.local.set({ [StorageKeys.GV_TURN_IDENTITY_CACHE]: cache });
    } catch {
      // Do not block live identity resolution when durable caching is unavailable.
    }
  }

  private notifySubscribers(cids: string[]): void {
    if (cids.length === 0) return;
    this.subscribers.forEach((subscriber) => {
      try {
        subscriber(cids);
      } catch {
        // One stale UI subscriber must not block the shared store.
      }
    });
  }

  private consumeCapture(payload: ObserverCapturePayload | null): void {
    const id = payload?.id;
    if (typeof id !== 'string' || !id) return;

    try {
      if (!this.rememberCapture(id)) return;
      const body = payload?.body;
      if (typeof body !== 'string' || !body) return;
      this.ingest(body);
    } finally {
      // ACK malformed and disabled captures too; otherwise they replay forever.
      this.acknowledgeCapture(id);
    }
  }

  private ingest(body: string): void {
    const updatedCids = new Set<string>();
    let identityChanged = false;
    decodeBatchExecute(body).forEach(({ payload: rpcPayload }) => {
      extractHistoryTurnIdentities(rpcPayload).forEach((identityTurns, cid) => {
        const turnIds = identityTurns.map((turn) => turn.turnId);
        if (turnIds.length === 0 || new Set(turnIds).size !== turnIds.length) return;

        const previousIds = this.turnIdsByCid.get(cid);
        if (!previousIds || previousIds.join('|') !== turnIds.join('|')) {
          this.turnIdsByCid.set(cid, turnIds);
          this.turnIdentityUpdatedAt.set(cid, Date.now());
          identityChanged = true;
          updatedCids.add(cid);
        }

        const turns = identityTurns.flatMap((turn): HistoryTurnTimestamp[] => {
          if (turn.userText == null || turn.timestampMs == null) return [];
          return [{ turnId: turn.turnId, userText: turn.userText, timestampMs: turn.timestampMs }];
        });
        let existing = this.byCid.get(cid);
        if (!existing) {
          existing = this.touchConversation(cid);
        } else {
          this.touchConversation(cid, existing);
        }
        let changed = false;
        turns.forEach((turn) => {
          if (existing!.has(turn.turnId)) return;
          existing!.set(turn.turnId, turn);
          changed = true;
        });
        if (changed) {
          this.cidRevisions.set(cid, ++this.revisionCounter);
          updatedCids.add(cid);
        }
      });
    });

    if (identityChanged) void this.persistIdentityCache();
    this.notifySubscribers(Array.from(updatedCids));
  }
}

/** One parsed-data store per document; TimelineManager instances only subscribe to it. */
export const historyTimestampStore = new HistoryTimestampStore();
