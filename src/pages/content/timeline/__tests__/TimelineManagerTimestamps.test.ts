import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildConversationIdFromUrl } from '@/core/utils/conversationIdentity';

import { TimestampService } from '../../timestamp/TimestampService';
import { TimelineManager } from '../manager';

const SERVER_TURN_ID = 's-1111111111111111';

function setElementTop(el: HTMLElement, top: number): void {
  Object.defineProperty(el, 'offsetTop', { value: top, configurable: true });
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: top,
    top,
    left: 0,
    right: 0,
    bottom: top,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

describe('TimelineManager message timestamps', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('records timestamps only for turns that appear after startup baseline', async () => {
    const main = document.createElement('main');
    document.body.appendChild(main);

    const scrollContainer = document.createElement('div');
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    scrollContainer.scrollTop = 0;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect);
    main.appendChild(scrollContainer);

    const container = document.createElement('div');
    scrollContainer.appendChild(container);

    const first = document.createElement('div');
    first.className = 'user conversation-container';
    first.id = '1111111111111111';
    first.textContent = 'A';
    setElementTop(first, 0);
    container.appendChild(first);

    const second = document.createElement('div');
    second.className = 'user conversation-container';
    second.id = '2222222222222222';
    second.textContent = 'B';
    setElementTop(second, 100);
    container.appendChild(second);

    const timelineBar = document.createElement('div');
    const trackContent = document.createElement('div');
    timelineBar.appendChild(trackContent);
    document.body.appendChild(timelineBar);

    const recordTimestamp = vi.fn().mockResolvedValue(undefined);
    const getTimestamp = vi.fn().mockReturnValue(null);
    const formatTimestamp = vi.fn().mockResolvedValue('');

    const manager = new TimelineManager();
    const internal = manager as unknown as {
      conversationContainer: HTMLElement | null;
      scrollContainer: HTMLElement | null;
      userTurnSelector: string | null;
      conversationId: string | null;
      timestampService: TimestampService | null;
      showMessageTimestampsEnabled: boolean;
      ui: { timelineBar: HTMLElement | null; trackContent: HTMLElement | null };
      activeTurnId: string | null;
      recalculateAndRenderMarkers: () => void;
      updateTimelineGeometry: () => void;
      updateIntersectionObserverTargetsFromMarkers: () => void;
      syncTimelineTrackToMain: () => void;
      updateVirtualRangeAndRender: () => void;
      updateActiveDotUI: () => void;
      scheduleScrollSync: () => void;
    };

    internal.conversationContainer = container;
    internal.scrollContainer = scrollContainer;
    internal.userTurnSelector = '.user';
    internal.conversationId = 'gemini:conv:test';
    internal.timestampService = {
      getTimestamp,
      recordTimestamp,
      formatTimestamp,
      formatAbsoluteTime: vi.fn(),
    } as unknown as TimestampService;
    internal.showMessageTimestampsEnabled = true;
    internal.ui.timelineBar = timelineBar;
    internal.ui.trackContent = trackContent;
    internal.activeTurnId = null;

    internal.updateTimelineGeometry = vi.fn();
    internal.updateIntersectionObserverTargetsFromMarkers = vi.fn();
    internal.syncTimelineTrackToMain = vi.fn();
    internal.updateVirtualRangeAndRender = vi.fn();
    internal.updateActiveDotUI = vi.fn();
    internal.scheduleScrollSync = vi.fn();

    internal.recalculateAndRenderMarkers();

    expect(recordTimestamp).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(801);

    const third = document.createElement('div');
    third.className = 'user conversation-container';
    third.id = '3333333333333333';
    third.textContent = 'C';
    setElementTop(third, 200);
    container.appendChild(third);

    internal.recalculateAndRenderMarkers();

    expect(recordTimestamp).toHaveBeenCalledTimes(1);
    expect(recordTimestamp).toHaveBeenCalledWith('gemini:conv:test', 's-3333333333333333');
  });

  it('does not record timestamps while the timestamps feature is disabled', () => {
    const recordTimestamp = vi.fn().mockResolvedValue(undefined);
    const getTimestamp = vi.fn().mockReturnValue(null);

    const manager = new TimelineManager();
    const internal = manager as unknown as {
      conversationId: string | null;
      timestampService: TimestampService | null;
      showMessageTimestampsEnabled: boolean;
      recordTimestampForTurn: (turnId: string) => void;
    };

    internal.conversationId = 'gemini:conv:test';
    internal.timestampService = {
      getTimestamp,
      recordTimestamp,
    } as unknown as TimestampService;
    internal.showMessageTimestampsEnabled = false;

    internal.recordTimestampForTurn(SERVER_TURN_ID);
    expect(recordTimestamp).not.toHaveBeenCalled();

    internal.showMessageTimestampsEnabled = true;
    internal.recordTimestampForTurn('u-1');
    expect(recordTimestamp).not.toHaveBeenCalled();
    internal.recordTimestampForTurn(SERVER_TURN_ID);
    expect(recordTimestamp).toHaveBeenCalledTimes(1);
  });

  it('reuses existing timestamp nodes on reinjection', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const message = document.createElement('div');
    message.className = 'user';
    message.textContent = 'hello';
    container.appendChild(message);

    const manager = new TimelineManager();
    const internal = manager as unknown as {
      conversationId: string | null;
      timestampService: TimestampService | null;
      showMessageTimestampsEnabled: boolean;
      markers: Array<{
        id: string;
        element: HTMLElement;
        summary: string;
        n: number;
        baseN: number;
        dotElement: null;
        starred: boolean;
      }>;
      injectMessageTimestamps: () => Promise<void>;
    };

    internal.conversationId = 'gemini:conv:test';
    internal.timestampService = {
      getTimestamp: vi.fn().mockReturnValue(1234),
      formatAbsoluteTime: vi.fn().mockReturnValue('2024-01-01 00:00:01'),
    } as unknown as TimestampService;
    internal.showMessageTimestampsEnabled = true;
    internal.markers = [
      {
        id: SERVER_TURN_ID,
        element: message,
        summary: 'hello',
        n: 0,
        baseN: 0,
        dotElement: null,
        starred: false,
      },
    ];

    await internal.injectMessageTimestamps();
    const firstTimestamp = document.querySelector('.gv-timestamp') as HTMLElement | null;

    expect(firstTimestamp).not.toBeNull();
    expect(firstTimestamp?.textContent).toBe('2024-01-01 00:00:01');
    expect(firstTimestamp?.classList.contains('gv-timestamp-user')).toBe(true);

    await internal.injectMessageTimestamps();
    const secondTimestamp = document.querySelector('.gv-timestamp') as HTMLElement | null;

    expect(secondTimestamp).toBe(firstTimestamp);
    expect(document.querySelectorAll('.gv-timestamp')).toHaveLength(1);
  });

  it('removes duplicate timestamp nodes with the same turn id', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const message = document.createElement('div');
    message.className = 'user';
    message.textContent = 'hello';
    container.appendChild(message);

    const firstDuplicate = document.createElement('div');
    firstDuplicate.className = 'gv-timestamp gv-timestamp-user';
    firstDuplicate.setAttribute('data-gv-turn-id', SERVER_TURN_ID);
    firstDuplicate.textContent = 'old';
    container.appendChild(firstDuplicate);

    const secondDuplicate = document.createElement('div');
    secondDuplicate.className = 'gv-timestamp gv-timestamp-user';
    secondDuplicate.setAttribute('data-gv-turn-id', SERVER_TURN_ID);
    secondDuplicate.textContent = 'old';
    container.appendChild(secondDuplicate);

    const manager = new TimelineManager();
    const internal = manager as unknown as {
      conversationId: string | null;
      timestampService: TimestampService | null;
      showMessageTimestampsEnabled: boolean;
      markers: Array<{
        id: string;
        element: HTMLElement;
        summary: string;
        n: number;
        baseN: number;
        dotElement: null;
        starred: boolean;
      }>;
      injectMessageTimestamps: () => Promise<void>;
    };

    internal.conversationId = 'gemini:conv:test';
    internal.timestampService = {
      getTimestamp: vi.fn().mockReturnValue(1234),
      formatAbsoluteTime: vi.fn().mockReturnValue('2024-01-01 00:00:01'),
    } as unknown as TimestampService;
    internal.showMessageTimestampsEnabled = true;
    internal.markers = [
      {
        id: SERVER_TURN_ID,
        element: message,
        summary: 'hello',
        n: 0,
        baseN: 0,
        dotElement: null,
        starred: false,
      },
    ];

    await internal.injectMessageTimestamps();

    const timestamps = document.querySelectorAll(
      `.gv-timestamp[data-gv-turn-id="${SERVER_TURN_ID}"]`,
    );
    expect(timestamps).toHaveLength(1);
    expect(timestamps[0]).toBe(firstDuplicate);
    expect(timestamps[0]?.textContent).toBe('2024-01-01 00:00:01');
  });

  it('renders one timestamp when duplicate markers share a turn id', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const firstMessage = document.createElement('div');
    firstMessage.className = 'user';
    firstMessage.textContent = 'hello';
    container.appendChild(firstMessage);

    const duplicateMessage = document.createElement('div');
    duplicateMessage.className = 'user';
    duplicateMessage.textContent = 'hello clone';
    container.appendChild(duplicateMessage);

    const manager = new TimelineManager();
    const internal = manager as unknown as {
      conversationId: string | null;
      timestampService: TimestampService | null;
      showMessageTimestampsEnabled: boolean;
      markers: Array<{
        id: string;
        element: HTMLElement;
        summary: string;
        n: number;
        baseN: number;
        dotElement: null;
        starred: boolean;
      }>;
      injectMessageTimestamps: () => Promise<void>;
    };

    internal.conversationId = 'gemini:conv:test';
    internal.timestampService = {
      getTimestamp: vi.fn().mockReturnValue(1234),
      formatAbsoluteTime: vi.fn().mockReturnValue('2024-01-01 00:00:01'),
    } as unknown as TimestampService;
    internal.showMessageTimestampsEnabled = true;
    internal.markers = [
      {
        id: SERVER_TURN_ID,
        element: firstMessage,
        summary: 'hello',
        n: 0,
        baseN: 0,
        dotElement: null,
        starred: false,
      },
      {
        id: SERVER_TURN_ID,
        element: duplicateMessage,
        summary: 'hello clone',
        n: 0.5,
        baseN: 0.5,
        dotElement: null,
        starred: false,
      },
    ];

    await internal.injectMessageTimestamps();

    expect(
      document.querySelectorAll(`.gv-timestamp[data-gv-turn-id="${SERVER_TURN_ID}"]`),
    ).toHaveLength(1);
  });

  it('keeps timestamp turn ids stable when Gemini replaces a rendered message element', async () => {
    const main = document.createElement('main');
    document.body.appendChild(main);

    const scrollContainer = document.createElement('div');
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    scrollContainer.scrollTop = 0;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect);
    main.appendChild(scrollContainer);

    const container = document.createElement('div');
    scrollContainer.appendChild(container);

    const serverContainer = document.createElement('div');
    serverContainer.className = 'conversation-container';
    serverContainer.id = '1111111111111111';
    container.appendChild(serverContainer);

    const message = document.createElement('div');
    message.className = 'user';
    message.textContent = 'raw $x^2$';
    setElementTop(message, 0);
    serverContainer.appendChild(message);

    const timelineBar = document.createElement('div');
    const trackContent = document.createElement('div');
    timelineBar.appendChild(trackContent);
    document.body.appendChild(timelineBar);

    const manager = new TimelineManager();
    const internal = manager as unknown as {
      conversationContainer: HTMLElement | null;
      scrollContainer: HTMLElement | null;
      userTurnSelector: string | null;
      conversationId: string | null;
      timestampService: TimestampService | null;
      showMessageTimestampsEnabled: boolean;
      markers: Array<{ id: string; element: HTMLElement }>;
      ui: { timelineBar: HTMLElement | null; trackContent: HTMLElement | null };
      activeTurnId: string | null;
      recalculateAndRenderMarkers: () => void;
      updateTimelineGeometry: () => void;
      updateIntersectionObserverTargetsFromMarkers: () => void;
      syncTimelineTrackToMain: () => void;
      updateVirtualRangeAndRender: () => void;
      updateActiveDotUI: () => void;
      scheduleScrollSync: () => void;
    };

    internal.conversationContainer = container;
    internal.scrollContainer = scrollContainer;
    internal.userTurnSelector = '.user';
    internal.conversationId = 'gemini:conv:test';
    internal.timestampService = {
      getTimestamp: vi.fn().mockReturnValue(1234),
      formatAbsoluteTime: vi.fn().mockReturnValue('2024-01-01 00:00:01'),
    } as unknown as TimestampService;
    internal.showMessageTimestampsEnabled = true;
    internal.ui.timelineBar = timelineBar;
    internal.ui.trackContent = trackContent;
    internal.activeTurnId = null;

    internal.updateTimelineGeometry = vi.fn();
    internal.updateIntersectionObserverTargetsFromMarkers = vi.fn();
    internal.syncTimelineTrackToMain = vi.fn();
    internal.updateVirtualRangeAndRender = vi.fn();
    internal.updateActiveDotUI = vi.fn();
    internal.scheduleScrollSync = vi.fn();

    internal.recalculateAndRenderMarkers();
    const firstTurnId = internal.markers[0]?.id;
    expect(firstTurnId).toBe(SERVER_TURN_ID);

    const rerendered = document.createElement('div');
    rerendered.className = 'user';
    rerendered.textContent = 'rendered x squared';
    setElementTop(rerendered, 0);
    message.replaceWith(rerendered);

    internal.recalculateAndRenderMarkers();

    expect(internal.markers[0]?.id).toBe(firstTurnId);
    expect(rerendered.dataset.turnId).toBe(firstTurnId);
    expect(document.querySelector('.gv-timestamp')?.getAttribute('data-gv-turn-id')).toBe(
      firstTurnId,
    );
    expect(document.querySelectorAll('.gv-timestamp')).toHaveLength(1);
  });

  it('adopts draft-route timestamps for the first turn after conversation creation', async () => {
    history.replaceState({}, '', '/app/abc123');

    const main = document.createElement('main');
    document.body.appendChild(main);

    const scrollContainer = document.createElement('div');
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    scrollContainer.scrollTop = 0;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect);
    main.appendChild(scrollContainer);

    const rowWrapper = document.createElement('div');
    rowWrapper.style.display = 'flex';
    rowWrapper.style.flexDirection = 'row';
    rowWrapper.style.justifyContent = 'flex-end';
    scrollContainer.appendChild(rowWrapper);

    const serverContainer = document.createElement('div');
    serverContainer.className = 'conversation-container';
    serverContainer.id = '1111111111111111';
    rowWrapper.appendChild(serverContainer);

    const message = document.createElement('div');
    message.className = 'user';
    message.textContent = 'first turn';
    setElementTop(message, 0);
    serverContainer.appendChild(message);

    const timelineBar = document.createElement('div');
    const trackContent = document.createElement('div');
    timelineBar.appendChild(trackContent);
    document.body.appendChild(timelineBar);

    const manager = new TimelineManager({ previousUrl: 'https://gemini.google.com/app' });
    const internal = manager as unknown as {
      conversationContainer: HTMLElement | null;
      scrollContainer: HTMLElement | null;
      userTurnSelector: string | null;
      conversationId: string | null;
      timestampService: TimestampService | null;
      showMessageTimestampsEnabled: boolean;
      ui: { timelineBar: HTMLElement | null; trackContent: HTMLElement | null };
      activeTurnId: string | null;
      buildTimestampConversationIdFromUrl: (input: string) => string;
      recalculateAndRenderMarkers: () => void;
      updateTimelineGeometry: () => void;
      updateIntersectionObserverTargetsFromMarkers: () => void;
      syncTimelineTrackToMain: () => void;
      updateVirtualRangeAndRender: () => void;
      updateActiveDotUI: () => void;
      scheduleScrollSync: () => void;
    };

    const draftConversationId = buildConversationIdFromUrl('https://gemini.google.com/app');
    const scopedDraftConversationId = internal.buildTimestampConversationIdFromUrl(
      'https://gemini.google.com/app',
    );
    const liveTimestamps = new Map<string, Map<string, number>>([
      [scopedDraftConversationId, new Map([[SERVER_TURN_ID, Date.now()]])],
    ]);

    const timestampServiceMock = {
      getTimestamp: vi.fn((conversationId: string, turnId: string) => {
        return liveTimestamps.get(conversationId)?.get(turnId) ?? null;
      }),
      formatAbsoluteTime: vi.fn(() => '2024-01-01 00:00:01'),
      getLatestTimestampForConversation: vi.fn((conversationId: string) => {
        const values = Array.from(liveTimestamps.get(conversationId)?.values() ?? []);
        return values.length > 0 ? Math.max(...values) : null;
      }),
      adoptTimestamps: vi.fn(async (sourceConversationId: string, targetConversationId: string) => {
        const source = liveTimestamps.get(sourceConversationId);
        if (!source) return;

        liveTimestamps.set(targetConversationId, new Map(source));
        liveTimestamps.delete(sourceConversationId);
      }),
    } as unknown as TimestampService;

    message.dataset.turnId = SERVER_TURN_ID;
    internal.conversationContainer = scrollContainer;
    internal.scrollContainer = scrollContainer;
    internal.userTurnSelector = '.user';
    internal.conversationId = 'gemini:conv:abc123';
    internal.timestampService = timestampServiceMock;
    internal.showMessageTimestampsEnabled = true;
    internal.ui.timelineBar = timelineBar;
    internal.ui.trackContent = trackContent;
    internal.activeTurnId = null;

    internal.updateTimelineGeometry = vi.fn();
    internal.updateIntersectionObserverTargetsFromMarkers = vi.fn();
    internal.syncTimelineTrackToMain = vi.fn();
    internal.updateVirtualRangeAndRender = vi.fn();
    internal.updateActiveDotUI = vi.fn();
    internal.scheduleScrollSync = vi.fn();

    internal.recalculateAndRenderMarkers();

    const timestampEl = document.querySelector('.gv-timestamp') as HTMLElement | null;
    expect(timestampEl?.textContent).toBe('2024-01-01 00:00:01');
    expect(
      (timestampServiceMock.adoptTimestamps as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
    ).toBe(scopedDraftConversationId);
    expect(scopedDraftConversationId).not.toBe(draftConversationId);
    expect(scopedDraftConversationId.startsWith(`${draftConversationId}:tab:`)).toBe(true);
  });

  it('does not adopt unscoped draft-route timestamps from another tab', async () => {
    history.replaceState({}, '', '/app/abc123');

    const main = document.createElement('main');
    document.body.appendChild(main);

    const scrollContainer = document.createElement('div');
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    scrollContainer.scrollTop = 0;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect);
    main.appendChild(scrollContainer);

    const rowWrapper = document.createElement('div');
    rowWrapper.style.display = 'flex';
    rowWrapper.style.flexDirection = 'row';
    rowWrapper.style.justifyContent = 'flex-end';
    scrollContainer.appendChild(rowWrapper);

    const serverContainer = document.createElement('div');
    serverContainer.className = 'conversation-container';
    serverContainer.id = '1111111111111111';
    rowWrapper.appendChild(serverContainer);

    const message = document.createElement('div');
    message.className = 'user';
    message.textContent = 'first turn';
    message.dataset.turnId = SERVER_TURN_ID;
    setElementTop(message, 0);
    serverContainer.appendChild(message);

    const timelineBar = document.createElement('div');
    const trackContent = document.createElement('div');
    timelineBar.appendChild(trackContent);
    document.body.appendChild(timelineBar);

    const draftConversationId = buildConversationIdFromUrl('https://gemini.google.com/app');
    const liveTimestamps = new Map<string, Map<string, number>>([
      [draftConversationId, new Map([[SERVER_TURN_ID, Date.now()]])],
    ]);

    const timestampServiceMock = {
      getTimestamp: vi.fn((conversationId: string, turnId: string) => {
        return liveTimestamps.get(conversationId)?.get(turnId) ?? null;
      }),
      formatAbsoluteTime: vi.fn(() => '2024-01-01 00:00:01'),
      getLatestTimestampForConversation: vi.fn((conversationId: string) => {
        const values = Array.from(liveTimestamps.get(conversationId)?.values() ?? []);
        return values.length > 0 ? Math.max(...values) : null;
      }),
      adoptTimestamps: vi.fn(async () => {}),
    } as unknown as TimestampService;

    const manager = new TimelineManager({ previousUrl: 'https://gemini.google.com/app' });
    const internal = manager as unknown as {
      conversationContainer: HTMLElement | null;
      scrollContainer: HTMLElement | null;
      userTurnSelector: string | null;
      conversationId: string | null;
      timestampService: TimestampService | null;
      showMessageTimestampsEnabled: boolean;
      ui: { timelineBar: HTMLElement | null; trackContent: HTMLElement | null };
      activeTurnId: string | null;
      recalculateAndRenderMarkers: () => void;
      updateTimelineGeometry: () => void;
      updateIntersectionObserverTargetsFromMarkers: () => void;
      syncTimelineTrackToMain: () => void;
      updateVirtualRangeAndRender: () => void;
      updateActiveDotUI: () => void;
      scheduleScrollSync: () => void;
    };

    internal.conversationContainer = scrollContainer;
    internal.scrollContainer = scrollContainer;
    internal.userTurnSelector = '.user';
    internal.conversationId = 'gemini:conv:abc123';
    internal.timestampService = timestampServiceMock;
    internal.showMessageTimestampsEnabled = true;
    internal.ui.timelineBar = timelineBar;
    internal.ui.trackContent = trackContent;
    internal.activeTurnId = null;

    internal.updateTimelineGeometry = vi.fn();
    internal.updateIntersectionObserverTargetsFromMarkers = vi.fn();
    internal.syncTimelineTrackToMain = vi.fn();
    internal.updateVirtualRangeAndRender = vi.fn();
    internal.updateActiveDotUI = vi.fn();
    internal.scheduleScrollSync = vi.fn();

    internal.recalculateAndRenderMarkers();

    expect(timestampServiceMock.adoptTimestamps as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(document.querySelector('.gv-timestamp')).toBeNull();
  });
});

describe('TimelineManager applyHistoryTimestamps', () => {
  interface HistoryInternal {
    conversationId: string | null;
    timestampService: TimestampService | null;
    showMessageTimestampsEnabled: boolean;
    historyTimestampMarkerRevision: number;
    lastHistoryTimestampMatch: unknown;
    markers: Array<{
      id: string;
      element: HTMLElement;
      summary: string;
      n: number;
      baseN: number;
      dotElement: null;
      starred: boolean;
    }>;
    historyTimestampStore: unknown;
    applyHistoryTimestamps: () => boolean;
  }

  function setupManager(options: { conversationId: string; urlPath: string; enabled?: boolean }): {
    internal: HistoryInternal;
    recordTimestamp: ReturnType<typeof vi.fn>;
    getTurns: ReturnType<typeof vi.fn>;
    setStoreRevision: (nextRevision: number) => void;
  } {
    history.replaceState({}, '', options.urlPath);

    const recordTimestamp = vi.fn().mockResolvedValue(undefined);
    const manager = new TimelineManager();
    const internal = manager as unknown as HistoryInternal;

    internal.conversationId = options.conversationId;
    internal.showMessageTimestampsEnabled = options.enabled ?? true;
    internal.timestampService = {
      getTimestamp: vi.fn().mockReturnValue(null),
      recordTimestamp,
    } as unknown as TimestampService;
    internal.markers = [
      {
        id: SERVER_TURN_ID,
        element: document.createElement('div'),
        summary: 'hello from this conversation',
        n: 0,
        baseN: 0,
        dotElement: null,
        starred: false,
      },
    ];
    let storeRevision = 1;
    const getTurns = vi.fn(() => [
      {
        turnId: SERVER_TURN_ID,
        userText: 'hello from this conversation',
        timestampMs: 1_783_370_737_000,
      },
    ]);
    internal.historyTimestampStore = {
      getRevision: vi.fn(() => storeRevision),
      getTurns,
    };

    return {
      internal,
      recordTimestamp,
      getTurns,
      setStoreRevision: (nextRevision: number) => {
        storeRevision = nextRevision;
      },
    };
  }

  it('skips the full match while store and marker inputs are unchanged', () => {
    const { internal, recordTimestamp, getTurns } = setupManager({
      conversationId: 'gemini:conv:convB',
      urlPath: '/app/convB',
    });

    expect(internal.applyHistoryTimestamps()).toBe(true);
    expect(internal.applyHistoryTimestamps()).toBe(false);
    expect(getTurns).toHaveBeenCalledTimes(1);
    expect(recordTimestamp).toHaveBeenCalledTimes(1);
  });

  it('re-runs matching when the store revision changes', () => {
    const { internal, getTurns, setStoreRevision } = setupManager({
      conversationId: 'gemini:conv:convB',
      urlPath: '/app/convB',
    });

    expect(internal.applyHistoryTimestamps()).toBe(true);
    setStoreRevision(2);
    expect(internal.applyHistoryTimestamps()).toBe(true);
    expect(getTurns).toHaveBeenCalledTimes(2);
  });

  it('does not copy or match turns before the store has data', () => {
    const { internal, getTurns, setStoreRevision } = setupManager({
      conversationId: 'gemini:conv:convB',
      urlPath: '/app/convB',
    });
    setStoreRevision(0);

    expect(internal.applyHistoryTimestamps()).toBe(false);
    expect(getTurns).not.toHaveBeenCalled();
  });

  it('remembers completed no-match inputs instead of rescanning them', () => {
    const { internal, recordTimestamp, getTurns } = setupManager({
      conversationId: 'gemini:conv:convB',
      urlPath: '/app/convB',
    });
    internal.markers[0].id = 's-2222222222222222';

    expect(internal.applyHistoryTimestamps()).toBe(false);
    expect(internal.applyHistoryTimestamps()).toBe(false);
    expect(getTurns).toHaveBeenCalledTimes(1);
    expect(recordTimestamp).not.toHaveBeenCalled();
  });

  it('keeps marker revision stable across unchanged recalculations and advances on summary change', () => {
    history.replaceState({}, '', '/app/convB');

    const main = document.createElement('main');
    const scrollContainer = document.createElement('div');
    const message = document.createElement('div');
    const timelineBar = document.createElement('div');
    const trackContent = document.createElement('div');

    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const serverContainer = document.createElement('div');
    serverContainer.className = 'conversation-container';
    serverContainer.id = '1111111111111111';
    scrollContainer.appendChild(serverContainer);

    message.className = 'user';
    message.textContent = 'hello from this conversation';
    setElementTop(message, 0);
    serverContainer.appendChild(message);
    main.appendChild(scrollContainer);
    timelineBar.appendChild(trackContent);
    document.body.append(main, timelineBar);

    const getTurns = vi.fn(() => [
      {
        turnId: SERVER_TURN_ID,
        userText: 'hello from this conversation',
        timestampMs: 1_783_370_737_000,
      },
    ]);
    const manager = new TimelineManager();
    const internal = manager as unknown as HistoryInternal & {
      conversationContainer: HTMLElement | null;
      scrollContainer: HTMLElement | null;
      userTurnSelector: string;
      timestampTrackingReady: boolean;
      ui: { timelineBar: HTMLElement | null; trackContent: HTMLElement | null };
      activeTurnId: string | null;
      recalculateAndRenderMarkers: () => void;
      updateTimelineGeometry: () => void;
      updateIntersectionObserverTargetsFromMarkers: () => void;
      syncTimelineTrackToMain: () => void;
      updateVirtualRangeAndRender: () => void;
      updateActiveDotUI: () => void;
      scheduleScrollSync: () => void;
    };

    internal.conversationContainer = scrollContainer;
    internal.scrollContainer = scrollContainer;
    internal.userTurnSelector = '.user';
    internal.conversationId = 'gemini:conv:convB';
    internal.timestampService = {
      getTimestamp: vi.fn().mockReturnValue(null),
      recordTimestamp: vi.fn().mockResolvedValue(undefined),
    } as unknown as TimestampService;
    internal.historyTimestampStore = {
      getRevision: vi.fn(() => 1),
      getTurns,
    };
    internal.showMessageTimestampsEnabled = true;
    internal.timestampTrackingReady = true;
    internal.ui.timelineBar = timelineBar;
    internal.ui.trackContent = trackContent;
    internal.activeTurnId = null;
    internal.updateTimelineGeometry = vi.fn();
    internal.updateIntersectionObserverTargetsFromMarkers = vi.fn();
    internal.syncTimelineTrackToMain = vi.fn();
    internal.updateVirtualRangeAndRender = vi.fn();
    internal.updateActiveDotUI = vi.fn();
    internal.scheduleScrollSync = vi.fn();

    internal.recalculateAndRenderMarkers();
    const firstMarkerRevision = internal.historyTimestampMarkerRevision;
    internal.recalculateAndRenderMarkers();

    expect(internal.historyTimestampMarkerRevision).toBe(firstMarkerRevision);
    expect(getTurns).toHaveBeenCalledTimes(1);

    message.textContent = 'edited conversation question';
    internal.recalculateAndRenderMarkers();

    expect(internal.historyTimestampMarkerRevision).toBe(firstMarkerRevision + 1);
    expect(getTurns).toHaveBeenCalledTimes(2);
  });

  it('does not write timestamps when the manager identity no longer matches the URL', () => {
    // SPA switch window: URL already points at conversation B while this
    // manager instance still holds conversation A. Marker ids are per-index
    // (`u-0`), so writing here would persist B's times under A's storage key.
    const { internal, recordTimestamp } = setupManager({
      conversationId: 'gemini:conv:convA',
      urlPath: '/app/convB',
    });

    expect(internal.applyHistoryTimestamps()).toBe(false);
    expect(recordTimestamp).not.toHaveBeenCalled();
  });

  it('writes matched timestamps when the manager identity matches the URL', () => {
    const { internal, recordTimestamp } = setupManager({
      conversationId: 'gemini:conv:convB',
      urlPath: '/app/convB',
    });

    expect(internal.applyHistoryTimestamps()).toBe(true);
    expect(recordTimestamp).toHaveBeenCalledTimes(1);
    expect(recordTimestamp).toHaveBeenCalledWith(
      'gemini:conv:convB',
      SERVER_TURN_ID,
      1_783_370_737_000,
    );
  });

  it('does not write timestamps while the feature toggle is off', () => {
    const { internal, recordTimestamp } = setupManager({
      conversationId: 'gemini:conv:convB',
      urlPath: '/app/convB',
      enabled: false,
    });

    expect(internal.applyHistoryTimestamps()).toBe(false);
    expect(recordTimestamp).not.toHaveBeenCalled();

    internal.showMessageTimestampsEnabled = true;
    expect(internal.applyHistoryTimestamps()).toBe(true);
    expect(recordTimestamp).toHaveBeenCalledTimes(1);
  });
});
