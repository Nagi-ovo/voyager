import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { StarredMessagesService } from '../StarredMessagesService';
import { TimelineState } from '../TimelineState';
import {
  getLegacyTimelineCollapsedStorageKey,
  getLegacyTimelineLevelsStorageKey,
} from '../hierarchyTypes';
import type { MarkerLevel } from '../types';

const PARENT_ID = 's-6060606060606060';
const CHILD_ID = 's-6161616161616161';
const CONVERSATION_ID = 'gemini:conv:abc';
const levelsKey = getLegacyTimelineLevelsStorageKey(CONVERSATION_ID);
const collapsedKey = getLegacyTimelineCollapsedStorageKey(CONVERSATION_ID);
const states: TimelineState[] = [];

async function setup(
  aliases: ReadonlyMap<string, string>,
  levels: Record<string, MarkerLevel> = {},
  collapsed: string[] = [],
) {
  localStorage.setItem(levelsKey, JSON.stringify(levels));
  localStorage.setItem(collapsedKey, JSON.stringify(collapsed));
  const state = new TimelineState(vi.fn(), window.location.href, {
    getTurnIdAliases: (_conversationId, id) => [id, ...(aliases.has(id) ? [aliases.get(id)!] : [])],
    resolveCanonicalTurnId: (_conversationId, id) => (id.startsWith('u-') ? null : id),
  });
  states.push(state);
  await state.init();
  state.markerLevelEnabled = true;
  state.replaceMarkers(
    [PARENT_ID, CHILD_ID].map((id, index) => ({
      id,
      element: document.createElement('div'),
      summary: id,
      assistantSummary: '',
      baseN: index,
      starred: false,
    })),
  );
  vi.mocked(chrome.storage.local.set).mockClear();
  return state;
}

describe('TimelineState identity aliases', () => {
  beforeEach(() => {
    history.replaceState({}, '', '/app/abc');
    localStorage.clear();
    vi.restoreAllMocks();
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({}));
    vi.mocked(chrome.storage.local.set).mockResolvedValue();
    vi.spyOn(StarredMessagesService, 'getAllStarredMessages').mockResolvedValue({ messages: {} });
  });
  afterEach(() => {
    states.splice(0).forEach((state) => state.destroy());
  });

  it('applies legacy hierarchy data by full conversation position to a mounted tail', async () => {
    const state = await setup(
      new Map([
        [PARENT_ID, 'u-60'],
        [CHILD_ID, 'u-61'],
      ]),
      { 'u-61': 2 },
      ['u-60'],
    );
    expect(state.getMarkerLevel(CHILD_ID)).toBe(2);
    expect(state.getHiddenMarkerIndices()).toEqual(new Set([1]));
  });
  it('does not apply an unverified legacy position to the first mounted tail turn', async () => {
    const state = await setup(new Map(), { 'u-0': 2 }, ['u-0']);
    expect(state.getMarkerLevel(PARENT_ID)).toBe(1);
    expect(state.getHiddenMarkerIndices()).toEqual(new Set());
  });
  it('does not persist actions from a mounted positional fallback', async () => {
    const state = await setup(new Map([['u-0', 'u-0']]));
    state.setMarkerLevel('u-0', 2);
    state.toggleCollapse('u-0');
    expect(localStorage.getItem(levelsKey)).toBe('{}');
    expect(localStorage.getItem(collapsedKey)).toBe('[]');
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
  it('converges verified legacy aliases to the server id when the user edits them', async () => {
    const state = await setup(new Map([[CHILD_ID, 'u-61']]), { 'u-61': 2 });
    state.setMarkerLevel(CHILD_ID, 3);
    expect(state.getMarkerLevel(CHILD_ID)).toBe(3);
    expect(JSON.parse(localStorage.getItem(levelsKey)!)).toEqual({ [CHILD_ID]: 3 });
    state.setMarkerLevel(CHILD_ID, 1);
    expect(state.getMarkerLevel(CHILD_ID)).toBe(1);
    expect(JSON.parse(localStorage.getItem(levelsKey)!)).toEqual({});
  });
  it('removes the verified legacy collapse alias when expanding', async () => {
    const state = await setup(new Map([[PARENT_ID, 'u-60']]), {}, ['u-60']);
    state.toggleCollapse(PARENT_ID);
    expect(state.isMarkerCollapsed(PARENT_ID)).toBe(false);
    expect(localStorage.getItem(collapsedKey)).toBe('[]');
  });
  it('does not restore a late hierarchy snapshot after the owner is destroyed', async () => {
    let resolveSnapshot!: (data: Record<string, unknown>) => void;
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => {
      started();
      return new Promise<Record<string, unknown>>((resolve) => {
        resolveSnapshot = resolve;
      });
    });
    const state = new TimelineState(vi.fn());
    states.push(state);
    const init = state.init();
    await readStarted;
    state.destroy();
    localStorage.setItem(levelsKey, JSON.stringify({ [CHILD_ID]: 3 }));

    resolveSnapshot({
      [StorageKeys.TIMELINE_HIERARCHY]: {
        conversations: {
          [CONVERSATION_ID]: { levels: { [CHILD_ID]: 2 }, collapsed: [], updatedAt: 1 },
        },
      },
    });
    await init;
    expect(JSON.parse(localStorage.getItem(levelsKey)!)).toEqual({ [CHILD_ID]: 3 });
  });
});
