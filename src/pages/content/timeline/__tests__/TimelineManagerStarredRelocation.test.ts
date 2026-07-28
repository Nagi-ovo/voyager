import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StarredMessagesService } from '../StarredMessagesService';
import { TimelineManager } from '../manager';
import type { StarredMessage, StarredMessagesData } from '../starredTypes';

type Marker = {
  id: string;
  element: HTMLElement;
  summary: string;
  n: number;
  baseN: number;
  dotElement: null;
  starred: boolean;
};

type IdentityStoreStub = {
  resolveCanonicalTurnId: (_conversationId: string, turnId: string) => string | null;
  getTurnIdAliases: (_conversationId: string, turnId: string) => string[];
};

type TimelineManagerInternal = {
  conversationId: string | null;
  historyTimestampStore: IdentityStoreStub | null;
  starred: Set<string>;
  markers: Marker[];
  markerMap: Map<string, Marker>;
  previewPanel: { updateMarkers: ReturnType<typeof vi.fn> } | null;
  saveStars: () => void;
  getConversationTitle: () => string;
  applySharedStarredData: (data?: StarredMessagesData | null) => void;
  toggleStar: (turnId: string) => Promise<void>;
};

const CONVERSATION_ID = 'gemini:conv:abc';
const FIRST_ID = 's-1111111111111111';
const TAIL_ID = 's-6060606060606060';

function createMarker(id: string, summary: string): Marker {
  return {
    id,
    element: document.createElement('div'),
    summary,
    n: 0,
    baseN: 0,
    dotElement: null,
    starred: false,
  };
}

function setupManager(markers: Marker[], legacyAliases = new Map<string, string>()) {
  const manager = new TimelineManager();
  const internal = manager as unknown as TimelineManagerInternal;
  const legacyByServer = new Map(Array.from(legacyAliases, ([legacy, server]) => [server, legacy]));

  internal.conversationId = CONVERSATION_ID;
  internal.historyTimestampStore = {
    resolveCanonicalTurnId: (_conversationId, turnId) => {
      if (turnId.startsWith('s-')) return turnId;
      return legacyAliases.get(turnId) ?? null;
    },
    getTurnIdAliases: (_conversationId, turnId) => {
      const canonical = turnId.startsWith('s-') ? turnId : legacyAliases.get(turnId);
      if (!canonical) return [];
      const legacy = legacyByServer.get(canonical);
      return legacy ? [canonical, legacy] : [canonical];
    },
  };
  internal.starred = new Set();
  internal.markers = markers;
  internal.markerMap = new Map(markers.map((marker) => [marker.id, marker]));
  internal.previewPanel = { updateMarkers: vi.fn() };
  internal.saveStars = vi.fn();
  internal.getConversationTitle = () => 'Long conversation';

  return internal;
}

function sharedData(messages: StarredMessage[]): StarredMessagesData {
  return { messages: { [CONVERSATION_ID]: messages } };
}

function starredMessage(turnId: string, content: string): StarredMessage {
  return {
    turnId,
    content,
    conversationId: CONVERSATION_ID,
    conversationUrl: 'https://gemini.google.com/app/abc',
    starredAt: 1_700_000_000_000,
  };
}

describe('TimelineManager legacy stars in a partially mounted conversation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/app/abc');
    vi.restoreAllMocks();
  });

  it('does not paint legacy u-0 on the first mounted tail turn without a history map (#871)', () => {
    const internal = setupManager([createMarker(TAIL_ID, 'please continue')]);

    internal.applySharedStarredData(sharedData([starredMessage('u-0', 'please continue')]));

    expect(internal.markers[0].starred).toBe(false);
    expect(internal.starred.has('u-0')).toBe(true);
  });

  it('maps u-0 to its server turn even when only a later tail is mounted first', () => {
    const internal = setupManager(
      [createMarker(TAIL_ID, 'please continue'), createMarker(FIRST_ID, 'please continue')],
      new Map([['u-0', FIRST_ID]]),
    );

    internal.applySharedStarredData(sharedData([starredMessage('u-0', 'please continue')]));

    expect(internal.markers.map((marker) => marker.starred)).toEqual([false, true]);
  });

  it('removes every verified stored alias when un-starring', async () => {
    const remove = vi
      .spyOn(StarredMessagesService, 'removeStarredMessage')
      .mockResolvedValue(undefined);
    const internal = setupManager(
      [createMarker(FIRST_ID, 'first prompt')],
      new Map([['u-0', FIRST_ID]]),
    );
    internal.applySharedStarredData(
      sharedData([starredMessage('u-0', 'first prompt'), starredMessage(FIRST_ID, 'first prompt')]),
    );

    await internal.toggleStar(FIRST_ID);

    expect(remove).toHaveBeenCalledWith(CONVERSATION_ID, 'u-0');
    expect(remove).toHaveBeenCalledWith(CONVERSATION_ID, FIRST_ID);
    expect(internal.starred.size).toBe(0);
    expect(internal.markers[0].starred).toBe(false);
  });

  it('does not save a star from an unverified mounted positional id', async () => {
    const add = vi.spyOn(StarredMessagesService, 'addStarredMessage').mockResolvedValue(undefined);
    const legacyMarker = createMarker('u-0', 'mounted tail');
    const internal = setupManager([legacyMarker]);

    await internal.toggleStar('u-0');

    expect(add).not.toHaveBeenCalled();
    expect(internal.starred.size).toBe(0);
    expect(internal.saveStars).not.toHaveBeenCalled();
  });
});
