import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { eventBus } from '../EventBus';
import { StarredMessagesService } from '../StarredMessagesService';
import { TimelineState } from '../TimelineState';
import type { StarredMessage, StarredMessagesData } from '../starredTypes';
import type { TimelineMarker } from '../types';

const CONVERSATION_ID = 'gemini:conv:abc';
const FIRST_ID = 's-1111111111111111';
const TAIL_ID = 's-6060606060606060';
const states: TimelineState[] = [];
function marker(id: string, summary: string): TimelineMarker {
  return {
    id,
    element: document.createElement('div'),
    summary,
    assistantSummary: '',
    baseN: 0,
    starred: false,
  };
}
function message(turnId: string, content: string): StarredMessage {
  return {
    turnId,
    content,
    conversationId: CONVERSATION_ID,
    conversationUrl: 'https://gemini.google.com/app/abc',
    starredAt: 1700000000000,
  };
}
async function setup(
  markers: TimelineMarker[],
  messages: StarredMessage[] = [],
  aliases = new Map<string, string>(),
) {
  const legacyByServer = new Map(Array.from(aliases, ([legacy, server]) => [server, legacy]));
  vi.spyOn(StarredMessagesService, 'getAllStarredMessages').mockResolvedValue({
    messages: { [CONVERSATION_ID]: messages },
  });
  const state = new TimelineState(vi.fn(), window.location.href, {
    resolveCanonicalTurnId: (_cid, id) => (id.startsWith('s-') ? id : (aliases.get(id) ?? null)),
    getTurnIdAliases: (_cid, id) => (legacyByServer.has(id) ? [id, legacyByServer.get(id)!] : [id]),
  });
  states.push(state);
  await state.init();
  state.replaceMarkers(markers);
  return state;
}
const storedStars = () =>
  JSON.parse(localStorage.getItem(`geminiTimelineStars:${CONVERSATION_ID}`) ?? '[]');

describe('TimelineState stars in a partially mounted conversation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    history.replaceState({}, '', '/app/abc');
    localStorage.clear();
    vi.restoreAllMocks();
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({}));
    vi.mocked(chrome.storage.local.set).mockResolvedValue();
  });
  afterEach(() => states.splice(0).forEach((state) => state.destroy()));
  it('does not paint legacy u-0 on the first mounted tail turn without a history map (#871)', async () => {
    const state = await setup(
      [marker(TAIL_ID, 'please continue')],
      [message('u-0', 'please continue')],
    );
    expect(state.markers[0].starred).toBe(false);
    expect(storedStars()).toEqual(['u-0']);
  });
  it('maps u-0 to its server turn even when only a later tail is mounted first', async () => {
    const state = await setup(
      [marker(TAIL_ID, 'please continue'), marker(FIRST_ID, 'please continue')],
      [message('u-0', 'please continue')],
      new Map([['u-0', FIRST_ID]]),
    );
    expect(state.markers.map((marker) => marker.starred)).toEqual([false, true]);
  });
  it('removes every verified stored alias when un-starring', async () => {
    const remove = vi.spyOn(StarredMessagesService, 'removeStarredMessage').mockResolvedValue();
    const state = await setup(
      [marker(FIRST_ID, 'first prompt')],
      [message('u-0', 'first prompt'), message(FIRST_ID, 'first prompt')],
      new Map([['u-0', FIRST_ID]]),
    );
    await state.toggleStar(FIRST_ID);
    expect(remove).toHaveBeenCalledWith(CONVERSATION_ID, 'u-0');
    expect(remove).toHaveBeenCalledWith(CONVERSATION_ID, FIRST_ID);
    expect(storedStars()).toEqual([]);
    expect(state.markers[0].starred).toBe(false);
  });
  it('does not save a star from an unverified mounted positional id', async () => {
    const add = vi.spyOn(StarredMessagesService, 'addStarredMessage').mockResolvedValue();
    const state = await setup([marker('u-0', 'mounted tail')]);
    const before = localStorage.getItem(`geminiTimelineStars:${CONVERSATION_ID}`);
    await state.toggleStar('u-0');
    expect(add).not.toHaveBeenCalled();
    expect(localStorage.getItem(`geminiTimelineStars:${CONVERSATION_ID}`)).toBe(before);
  });
  it('keeps a star mutation scoped to the conversation that owns its marker', async () => {
    const add = vi.spyOn(StarredMessagesService, 'addStarredMessage').mockResolvedValue();
    const state = await setup([marker(FIRST_ID, 'first prompt')]);
    history.replaceState({}, '', '/app/other');
    await state.toggleStar(FIRST_ID);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        conversationUrl: expect.stringContaining('/app/abc'),
      }),
    );
  });
  it('shares same-page star changes only with the live conversation owner', async () => {
    const previous = await setup([marker(FIRST_ID, 'first prompt')]);
    eventBus.emit('starred:added', { conversationId: 'gemini:conv:other', turnId: FIRST_ID });
    expect(previous.markers[0].starred).toBe(false);
    eventBus.emit('starred:added', { conversationId: CONVERSATION_ID, turnId: FIRST_ID });
    expect(previous.markers[0].starred).toBe(true);

    previous.destroy();
    const current = await setup([marker(FIRST_ID, 'first prompt')]);
    eventBus.emit('starred:added', { conversationId: CONVERSATION_ID, turnId: FIRST_ID });
    expect(current.markers[0].starred).toBe(true);
    eventBus.emit('starred:removed', { conversationId: CONVERSATION_ID, turnId: FIRST_ID });
    expect(current.markers[0].starred).toBe(false);
    expect(previous.markers[0].starred).toBe(true);
  });
  it('discards a pending initial star snapshot after the owner is destroyed', async () => {
    let resolveSnapshot!: (data: StarredMessagesData) => void;
    vi.spyOn(StarredMessagesService, 'getAllStarredMessages').mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const onChange = vi.fn();
    const state = new TimelineState(onChange);
    states.push(state);
    const init = state.init();
    state.destroy();
    localStorage.setItem(`geminiTimelineStars:${CONVERSATION_ID}`, JSON.stringify([TAIL_ID]));

    resolveSnapshot({ messages: { [CONVERSATION_ID]: [message(FIRST_ID, 'old snapshot')] } });
    await init;
    expect(storedStars()).toEqual([TAIL_ID]);
    expect(onChange).not.toHaveBeenCalled();
  });
});
