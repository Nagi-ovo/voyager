import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type IStorageService,
  StorageFactory,
  storageService,
} from '@/core/services/StorageService';
import { type Result, type StorageKey, StorageKeys } from '@/core/types/common';
import { buildConversationIdFromUrl } from '@/core/utils/conversationIdentity';
import { hashString } from '@/core/utils/hash';

import { TimestampService } from '../../timestamp/TimestampService';
import {
  type HistoryTurnTimestamp,
  historyTimestampStore,
} from '../../timestamp/historyTimestamps';
import { TimelineTimestamps } from '../TimelineTimestamps';
import { TimelineTurns } from '../TimelineTurns';
import type { TimelineMarker } from '../types';

const SERVER_TURN_ID = 's-1111111111111111';
const SECOND_TURN_ID = 's-2222222222222222';
const THIRD_TURN_ID = 's-3333333333333333';
const STORED_TIME = new Date(2024, 0, 1, 0, 0, 1).getTime();
const SERVER_TIME = 1_783_370_737_000;
type Subscriber = Parameters<typeof historyTimestampStore.subscribe>[0];
type StorageChangeListener = Parameters<typeof chrome.storage.onChanged.addListener>[0];

function appendTurn(id: string, text: string, parent: HTMLElement = document.body): HTMLElement {
  const host = document.createElement('div');
  host.className = 'conversation-container';
  host.id = id.slice(2);
  const message = document.createElement('div');
  message.className = 'user';
  message.textContent = text;
  host.appendChild(message);
  parent.appendChild(host);
  return message;
}

describe('TimelineTimestamps', () => {
  let stored: Record<string, unknown>;
  let storage: IStorageService;
  let historyRevision: number;
  let historyTurns: HistoryTurnTimestamp[];
  const owners = new Set<TimelineTimestamps>();
  const subscribers = new Set<Subscriber>();
  const settingsListeners = new Set<StorageChangeListener>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 5, 12));
    document.body.innerHTML = '';
    history.replaceState({}, '', '/app/test');
    stored = { [StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS]: true };
    storage = {
      async get<T>(key: StorageKey): Promise<Result<T>> {
        return { success: true, data: structuredClone(stored[key]) as T };
      },
      async set<T>(key: StorageKey, value: T): Promise<Result<void>> {
        stored[key] = structuredClone(value);
        return { success: true, data: undefined };
      },
      async remove(key: StorageKey): Promise<Result<void>> {
        delete stored[key];
        return { success: true, data: undefined };
      },
      async clear(): Promise<Result<void>> {
        stored = {};
        return { success: true, data: undefined };
      },
    };
    vi.spyOn(StorageFactory, 'create').mockReturnValue(storage);
    vi.spyOn(storageService, 'get').mockImplementation(storage.get);
    vi.spyOn(TimestampService.prototype, 'recordTimestamp');
    vi.spyOn(TimestampService.prototype, 'adoptTimestamps');
    historyRevision = 0;
    historyTurns = [];
    vi.spyOn(historyTimestampStore, 'start').mockResolvedValue();
    vi.spyOn(historyTimestampStore, 'subscribe').mockImplementation((subscriber) => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    });
    vi.spyOn(historyTimestampStore, 'getRevision').mockImplementation(() => historyRevision);
    vi.spyOn(historyTimestampStore, 'getTurns').mockImplementation(() =>
      historyTurns.length > 0 ? historyTurns : null,
    );
    vi.spyOn(historyTimestampStore, 'stop');
    vi.spyOn(chrome.storage.onChanged, 'addListener').mockImplementation((listener) => {
      settingsListeners.add(listener);
    });
    vi.spyOn(chrome.storage.onChanged, 'removeListener').mockImplementation((listener) => {
      settingsListeners.delete(listener);
    });
  });

  afterEach(async () => {
    owners.forEach((owner) => owner.destroy());
    owners.clear();
    subscribers.clear();
    settingsListeners.clear();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  async function createOwner(options: { previousUrl?: string } = {}) {
    const turns = new TimelineTurns();
    const aliases = new Map<string, string[]>();
    let markers: TimelineMarker[] = [];
    const onIdentityChange = vi.fn();
    const owner = new TimelineTimestamps(
      {
        getMarkers: () => markers,
        getTurnText: (element) => turns.getTurnTextCached(element),
        getTurnAliases: (id) => aliases.get(id) ?? [id],
        onIdentityChange,
      },
      options,
    );
    owners.add(owner);
    await owner.init();
    const update = (next: TimelineMarker[]) => {
      const previous = markers;
      markers = next;
      owner.update(previous, markers);
    };
    return {
      owner,
      aliases,
      onIdentityChange,
      update,
      collect: () => update(turns.collect(document.body, '.user', markers)),
      get markers() {
        return markers;
      },
    };
  }

  function seed(conversationId: string, timestamps: Record<string, number>): void {
    stored[StorageKeys.GV_MESSAGE_TIMESTAMPS] = {
      version: 2,
      conversations: { [conversationId]: timestamps },
    };
  }

  function captureHistory(): void {
    historyRevision = 1;
    historyTurns = [{ turnId: SERVER_TURN_ID, userText: 'hello', timestampMs: SERVER_TIME }];
  }

  function changeTimestampSetting(
    enabled: boolean,
    area: 'sync' | 'local' | 'session' = 'sync',
  ): void {
    stored[StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS] = enabled;
    settingsListeners.forEach((listener) =>
      listener({ [StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS]: { newValue: enabled } }, area),
    );
  }

  it('records timestamps only for turns that appear after startup baseline', async () => {
    const h = await createOwner();
    appendTurn(SERVER_TURN_ID, 'A');
    appendTurn(SECOND_TURN_ID, 'B');
    h.collect();
    expect(TimestampService.prototype.recordTimestamp).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(801);
    appendTurn(THIRD_TURN_ID, 'C');
    h.collect();

    expect(TimestampService.prototype.recordTimestamp).toHaveBeenCalledExactlyOnceWith(
      'gemini:conv:test',
      THIRD_TURN_ID,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(stored[StorageKeys.GV_MESSAGE_TIMESTAMPS]).toEqual({
      version: 2,
      conversations: { 'gemini:conv:test': { [THIRD_TURN_ID]: Date.now() } },
    });
  });

  it('does not record timestamps while the timestamps feature is disabled', async () => {
    stored[StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS] = false;
    const h = await createOwner();
    h.owner.update([], []);
    await vi.advanceTimersByTimeAsync(801);
    appendTurn(SERVER_TURN_ID, 'Disabled turn');
    h.collect();
    expect(TimestampService.prototype.recordTimestamp).not.toHaveBeenCalled();

    h.owner.setEnabled(true);
    const fallback = document.createElement('div');
    fallback.className = 'user';
    fallback.textContent = 'No server identity';
    document.body.appendChild(fallback);
    h.collect();
    expect(TimestampService.prototype.recordTimestamp).not.toHaveBeenCalled();

    appendTurn(SECOND_TURN_ID, 'Enabled turn');
    h.collect();
    expect(TimestampService.prototype.recordTimestamp).toHaveBeenCalledExactlyOnceWith(
      'gemini:conv:test',
      SECOND_TURN_ID,
    );
  });

  it('reuses existing timestamp nodes on reinjection', async () => {
    seed('gemini:conv:test', { [SERVER_TURN_ID]: STORED_TIME });
    const h = await createOwner();
    appendTurn(SERVER_TURN_ID, 'hello');
    h.collect();
    const timestamp = document.querySelector('.gv-timestamp');
    expect(timestamp?.textContent).toBe('2024-01-01 00:00:01');
    expect(timestamp?.classList).toContain('gv-timestamp-user');

    h.collect();
    expect(document.querySelector('.gv-timestamp')).toBe(timestamp);
    expect(document.querySelectorAll('.gv-timestamp')).toHaveLength(1);
    expect(h.owner.formatTooltipTimestamp(SERVER_TURN_ID)).toBe(timestamp?.textContent);
  });

  it('removes duplicate timestamp nodes with the same turn id', async () => {
    seed('gemini:conv:test', { [SERVER_TURN_ID]: STORED_TIME });
    const h = await createOwner();
    const message = appendTurn(SERVER_TURN_ID, 'hello');
    const first = document.createElement('div');
    first.className = 'gv-timestamp gv-timestamp-user';
    first.dataset.gvTurnId = SERVER_TURN_ID;
    first.textContent = 'old';
    document.body.append(first, first.cloneNode(true));

    h.collect();

    expect(document.querySelectorAll('.gv-timestamp')).toHaveLength(1);
    expect(document.querySelector('.gv-timestamp')).toBe(first);
    expect(first.textContent).toBe('2024-01-01 00:00:01');
    expect(first.nextElementSibling).toBe(message);
  });

  it('renders one timestamp when duplicate markers share a turn id', async () => {
    seed('gemini:conv:test', { [SERVER_TURN_ID]: STORED_TIME });
    const h = await createOwner();
    appendTurn(SERVER_TURN_ID, 'hello');
    h.collect();
    const duplicate = appendTurn(SERVER_TURN_ID, 'hello clone');
    h.update([...h.markers, { ...h.markers[0], element: duplicate }]);

    expect(document.querySelectorAll('.gv-timestamp')).toHaveLength(1);
  });

  it('keeps timestamp turn ids stable when Gemini replaces a rendered message element', async () => {
    seed('gemini:conv:test', { [SERVER_TURN_ID]: STORED_TIME });
    const h = await createOwner();
    const message = appendTurn(SERVER_TURN_ID, 'raw $x^2$');
    h.collect();
    const timestamp = document.querySelector('.gv-timestamp');
    expect(h.markers[0].id).toBe(SERVER_TURN_ID);

    const rerendered = document.createElement('div');
    rerendered.className = 'user';
    rerendered.textContent = 'rendered x squared';
    message.replaceWith(rerendered);
    h.collect();

    expect(h.markers[0].id).toBe(SERVER_TURN_ID);
    expect(rerendered.dataset.turnId).toBe(SERVER_TURN_ID);
    expect(document.querySelector('.gv-timestamp')).toBe(timestamp);
    expect(timestamp?.nextElementSibling).toBe(rerendered);
    expect(document.querySelectorAll('.gv-timestamp')).toHaveLength(1);
  });

  it('adopts draft-route timestamps for the first turn after conversation creation', async () => {
    history.replaceState({}, '', '/app');
    const previousUrl = window.location.href;
    const draft = await createOwner();
    draft.owner.update([], []);
    await vi.advanceTimersByTimeAsync(801);
    appendTurn(SERVER_TURN_ID, 'first turn');
    draft.collect();
    await vi.advanceTimersByTimeAsync(0);
    const draftId = vi.mocked(TimestampService.prototype.recordTimestamp).mock.calls[0][0];
    expect(draftId.startsWith(`${buildConversationIdFromUrl(previousUrl)}:tab:`)).toBe(true);
    draft.owner.destroy();
    document.body.innerHTML = '';

    history.replaceState({}, '', '/app/abc123');
    const h = await createOwner({ previousUrl });
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.flexDirection = 'row';
    document.body.appendChild(row);
    appendTurn(SERVER_TURN_ID, 'first turn', row);
    h.collect();

    expect(TimestampService.prototype.adoptTimestamps).toHaveBeenCalledExactlyOnceWith(
      draftId,
      'gemini:conv:abc123',
      [SERVER_TURN_ID],
    );
    const timestamp = document.querySelector('.gv-timestamp');
    expect(timestamp?.textContent).toBe(h.owner.formatTooltipTimestamp(SERVER_TURN_ID));
    expect(timestamp?.nextElementSibling).toBe(row);
    await vi.advanceTimersByTimeAsync(0);
    expect(stored[StorageKeys.GV_MESSAGE_TIMESTAMPS]).toEqual({
      version: 2,
      conversations: { 'gemini:conv:abc123': { [SERVER_TURN_ID]: Date.now() } },
    });
  });

  it('does not adopt unscoped draft-route timestamps from another tab', async () => {
    const previousUrl = new URL('/app', window.location.href).href;
    const draftId = buildConversationIdFromUrl(previousUrl);
    seed(draftId, { [SERVER_TURN_ID]: Date.now() });
    history.replaceState({}, '', '/app/abc123');
    const h = await createOwner({ previousUrl });
    appendTurn(SERVER_TURN_ID, 'first turn');
    h.collect();

    expect(TimestampService.prototype.adoptTimestamps).not.toHaveBeenCalled();
    expect(document.querySelector('.gv-timestamp')).toBeNull();
    expect(stored[StorageKeys.GV_MESSAGE_TIMESTAMPS]).toEqual({
      version: 2,
      conversations: { [draftId]: { [SERVER_TURN_ID]: Date.now() } },
    });
  });

  it('skips the full match while store and marker inputs are unchanged', async () => {
    captureHistory();
    const h = await createOwner();
    appendTurn(SERVER_TURN_ID, 'hello');
    h.collect();
    h.collect();
    h.collect();

    expect(historyTimestampStore.getTurns).toHaveBeenCalledTimes(1);
    expect(TimestampService.prototype.recordTimestamp).toHaveBeenCalledTimes(1);
  });

  it('re-runs matching when the store revision changes', async () => {
    captureHistory();
    const h = await createOwner();
    appendTurn(SERVER_TURN_ID, 'hello');
    h.collect();
    historyRevision = 2;
    historyTurns[0].timestampMs = SERVER_TIME + 1000;
    h.collect();

    expect(historyTimestampStore.getTurns).toHaveBeenCalledTimes(2);
    expect(TimestampService.prototype.recordTimestamp).toHaveBeenLastCalledWith(
      'gemini:conv:test',
      SERVER_TURN_ID,
      SERVER_TIME + 1000,
    );
  });

  it('does not copy or match turns before the store has data', async () => {
    const h = await createOwner();
    appendTurn(SERVER_TURN_ID, 'hello');
    h.collect();

    expect(historyTimestampStore.getTurns).not.toHaveBeenCalled();
    expect(TimestampService.prototype.recordTimestamp).not.toHaveBeenCalled();
  });

  it('remembers completed no-match inputs instead of rescanning them', async () => {
    captureHistory();
    const h = await createOwner();
    appendTurn(SECOND_TURN_ID, 'hello');
    h.collect();
    h.collect();

    expect(historyTimestampStore.getTurns).toHaveBeenCalledTimes(1);
    expect(TimestampService.prototype.recordTimestamp).not.toHaveBeenCalled();
  });

  it('keeps marker revision stable across unchanged recalculations and advances on summary change', async () => {
    captureHistory();
    const h = await createOwner();
    const message = appendTurn(SERVER_TURN_ID, 'hello');
    h.collect();
    h.collect();
    expect(historyTimestampStore.getTurns).toHaveBeenCalledTimes(1);

    message.textContent = 'edited conversation question';
    h.collect();

    expect(historyTimestampStore.getTurns).toHaveBeenCalledTimes(2);
    expect(TimestampService.prototype.recordTimestamp).toHaveBeenCalledTimes(1);
  });

  it('does not write timestamps when the owner identity no longer matches the URL', async () => {
    captureHistory();
    history.replaceState({}, '', '/app/convA');
    const h = await createOwner();
    history.replaceState({}, '', '/app/convB');
    appendTurn(SERVER_TURN_ID, 'hello');
    h.collect();
    subscribers.forEach((subscriber) => subscriber(['c_convA', 'c_convB']));

    expect(h.owner.conversationId).toBe('gemini:conv:convA');
    expect(h.onIdentityChange).not.toHaveBeenCalled();
    expect(TimestampService.prototype.recordTimestamp).not.toHaveBeenCalled();
  });

  it('writes matched timestamps when the owner identity matches the URL', async () => {
    captureHistory();
    history.replaceState({}, '', '/app/convB');
    const h = await createOwner();
    appendTurn(SERVER_TURN_ID, 'hello');
    h.collect();

    expect(TimestampService.prototype.recordTimestamp).toHaveBeenCalledExactlyOnceWith(
      'gemini:conv:convB',
      SERVER_TURN_ID,
      SERVER_TIME,
    );
  });

  it('does not write timestamps while the feature toggle is off', async () => {
    captureHistory();
    stored[StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS] = false;
    const h = await createOwner();
    appendTurn(SERVER_TURN_ID, 'hello');
    h.collect();
    expect(h.owner.enabled).toBe(false);
    expect(TimestampService.prototype.recordTimestamp).not.toHaveBeenCalled();

    h.owner.setEnabled(true);
    expect(TimestampService.prototype.recordTimestamp).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.gv-timestamp')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    const saved = structuredClone(stored[StorageKeys.GV_MESSAGE_TIMESTAMPS]);

    h.owner.setEnabled(false);
    expect(document.querySelector('.gv-timestamp')).toBeNull();
    expect(h.owner.formatTooltipTimestamp(SERVER_TURN_ID)).toBeNull();
    expect(stored[StorageKeys.GV_MESSAGE_TIMESTAMPS]).toEqual(saved);
    h.owner.setEnabled(true);
    expect(document.querySelector('.gv-timestamp')).not.toBeNull();
    expect(TimestampService.prototype.recordTimestamp).toHaveBeenCalledTimes(1);
  });

  it.each(['sync', 'local'] as const)(
    'applies %s settings changed while shared history initialization is pending',
    async (area) => {
      stored[StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS] = false;
      captureHistory();
      let finishStart = () => {};
      vi.mocked(historyTimestampStore.start).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishStart = resolve;
          }),
      );
      const initializing = createOwner();
      await vi.advanceTimersByTimeAsync(0);
      expect(historyTimestampStore.start).toHaveBeenCalledOnce();

      changeTimestampSetting(true, area);
      finishStart();
      const h = await initializing;
      appendTurn(SERVER_TURN_ID, 'hello');
      h.collect();

      expect(h.owner.enabled).toBe(true);
      expect(document.querySelector('.gv-timestamp')).not.toBeNull();
      expect(TimestampService.prototype.recordTimestamp).toHaveBeenCalledExactlyOnceWith(
        'gemini:conv:test',
        SERVER_TURN_ID,
        SERVER_TIME,
      );
      changeTimestampSetting(false, 'session');
      expect(h.owner.enabled).toBe(true);
      changeTimestampSetting(false, area);
      expect(h.owner.enabled).toBe(false);
      expect(document.querySelector('.gv-timestamp')).toBeNull();
    },
  );

  it('keeps a live settings change when the initial settings read resolves with an older value', async () => {
    captureHistory();
    let finishRead: (value: Result<unknown>) => void = () => {};
    vi.mocked(storageService.get).mockReturnValueOnce(
      new Promise<Result<unknown>>((resolve) => {
        finishRead = resolve;
      }),
    );
    const initializing = createOwner();
    await vi.advanceTimersByTimeAsync(0);
    expect(storageService.get).toHaveBeenCalledWith(StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS);
    changeTimestampSetting(true);
    finishRead({ success: true, data: false });
    const h = await initializing;
    appendTurn(SERVER_TURN_ID, 'hello');
    h.collect();

    expect(h.owner.enabled).toBe(true);
    expect(document.querySelector('.gv-timestamp')).not.toBeNull();
    expect(TimestampService.prototype.recordTimestamp).toHaveBeenCalledOnce();
  });

  it('looks up legacy content timestamps only through a proved full-turn index', async () => {
    const legacyId = `u-${hashString('hello|70')}`;
    seed('gemini:conv:test', { [legacyId]: STORED_TIME });
    const h = await createOwner();
    appendTurn(SERVER_TURN_ID, 'hello');
    h.collect();
    expect(h.owner.formatTooltipTimestamp(SERVER_TURN_ID)).toBeNull();
    expect(document.querySelector('.gv-timestamp')).toBeNull();

    h.aliases.set(SERVER_TURN_ID, [SERVER_TURN_ID, 'u-70']);
    h.collect();
    expect(h.owner.formatTooltipTimestamp(SERVER_TURN_ID)).toBe('2024-01-01 00:00:01');
    expect(document.querySelector('.gv-timestamp')?.textContent).toBe('2024-01-01 00:00:01');
    expect(TimestampService.prototype.recordTimestamp).not.toHaveBeenCalled();
  });

  it('refreshes current-conversation identities even with timestamps off and releases its subscription', async () => {
    stored[StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS] = false;
    const h = await createOwner();
    h.owner.update([], []);
    subscribers.forEach((subscriber) => subscriber(['c_other']));
    expect(h.onIdentityChange).not.toHaveBeenCalled();
    subscribers.forEach((subscriber) => subscriber(['c_test']));
    expect(h.onIdentityChange).toHaveBeenCalledOnce();
    expect(settingsListeners.size).toBe(1);

    h.owner.destroy();
    expect(subscribers.size).toBe(0);
    expect(settingsListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(historyTimestampStore.stop).not.toHaveBeenCalled();
  });

  it('does not subscribe after destruction while shared history initialization is pending', async () => {
    let finishStart = () => {};
    vi.mocked(historyTimestampStore.start).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    const owner = new TimelineTimestamps({
      getMarkers: () => [],
      getTurnText: () => '',
      getTurnAliases: (id) => [id],
      onIdentityChange: vi.fn(),
    });
    owners.add(owner);
    const initializing = owner.init();
    await vi.advanceTimersByTimeAsync(0);
    expect(historyTimestampStore.start).toHaveBeenCalledOnce();
    expect(settingsListeners.size).toBe(1);
    owner.destroy();
    expect(settingsListeners.size).toBe(0);
    finishStart();
    await initializing;

    expect(historyTimestampStore.subscribe).not.toHaveBeenCalled();
    expect(historyTimestampStore.stop).not.toHaveBeenCalled();
    expect(document.querySelector('.gv-timestamp')).toBeNull();
  });
});
