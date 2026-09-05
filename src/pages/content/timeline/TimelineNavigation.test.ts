import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  keyboardShortcutService,
  type ShortcutCallback,
} from '@/core/services/KeyboardShortcutService';

import { TimelineNavigation, type TimelineNavigationMarker } from './TimelineNavigation';

const owners: TimelineNavigation[] = [];

function fixture(count = 3) {
  const viewport = document.createElement('div');
  viewport.style.overflowY = 'auto';
  Object.defineProperty(viewport, 'clientHeight', { value: 400 });
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 50, 400, 400));
  document.body.appendChild(viewport);
  const markers: TimelineNavigationMarker[] = Array.from({ length: count }, (_, index) => {
    const element = document.createElement('div');
    element.dataset.turnId = `s-${index}`;
    viewport.appendChild(element);
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 50 + index * 200 - viewport.scrollTop, 300, 100),
    );
    return { id: `s-${index}`, element };
  });
  const tops = markers.map((_, index) => index * 200);
  const refreshMarkers = vi.fn(
    (_target: HTMLElement | null, _direction?: 'previous' | 'next') => false,
  );
  const onScroll = vi.fn();
  const onActiveChange = vi.fn<(id: string | null) => void>();
  const animateRunner = vi.fn();
  const navigation = new TimelineNavigation({
    getMarkers: () => markers,
    getMarkerTops: () => tops,
    getMarkerPositions: () => markers.map((_, index) => index * 50),
    getTrackHeight: () => 100,
    refreshMarkers,
    resolveStoredId: (id) => (id === 'u-1' ? 's-1' : id),
    onScroll,
    onActiveChange,
    animateRunner,
  });
  owners.push(navigation);
  navigation.setViewport(viewport);
  return {
    navigation,
    viewport,
    markers,
    tops,
    refreshMarkers,
    onScroll,
    onActiveChange,
    animateRunner,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem('geminiTimelineFlowDurationMs', '500');
  history.replaceState({}, '', '/app/a');
});

afterEach(() => {
  for (const owner of owners.splice(0)) owner.destroy();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TimelineNavigation', () => {
  it('coalesces scroll work, rebinds the viewport, and releases it on destroy', () => {
    const { navigation, viewport, onScroll } = fixture();
    viewport.dispatchEvent(new Event('scroll'));
    viewport.dispatchEvent(new Event('scroll'));
    expect(onScroll).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(onScroll).toHaveBeenCalledTimes(1);

    const next = document.createElement('div');
    navigation.setViewport(next);
    viewport.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(16);
    expect(onScroll).toHaveBeenCalledTimes(1);
    next.dispatchEvent(new Event('scroll'));
    next.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(16);
    expect(onScroll).toHaveBeenCalledTimes(2);

    next.dispatchEvent(new Event('scroll'));
    navigation.destroy();
    next.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(200);
    expect(navigation.viewport).toBeNull();
    expect(onScroll).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('selects the scroll marker with cached geometry: %s', (cached) => {
    const { navigation, viewport, markers, tops, onActiveChange } = fixture();
    if (!cached) tops.length = 0;
    vi.advanceTimersByTime(120);
    viewport.scrollTop = 60;
    navigation.computeActiveByScroll();
    expect(navigation.activeTurnId).toBe('s-1');
    expect(onActiveChange).toHaveBeenLastCalledWith('s-1');
    for (const marker of markers) {
      if (cached) expect(marker.element.getBoundingClientRect).not.toHaveBeenCalled();
    }

    vi.advanceTimersByTime(30);
    viewport.scrollTop = 0;
    navigation.computeActiveByScroll();
    vi.advanceTimersByTime(20);
    viewport.scrollTop = 260;
    navigation.computeActiveByScroll();
    vi.advanceTimersByTime(69);
    expect(navigation.activeTurnId).toBe('s-1');
    vi.advanceTimersByTime(1);
    expect(navigation.activeTurnId).toBe('s-2');
  });

  it('measures a dot target before active/runner writes and commits after flow completes', () => {
    const { navigation, viewport, markers, onActiveChange, animateRunner } = fixture();
    navigation.activeTurnId = 's-0';
    const order: string[] = [];
    vi.mocked(markers[1].element.getBoundingClientRect).mockImplementation(() => {
      order.push('measure');
      return new DOMRect(0, 250 - viewport.scrollTop, 300, 100);
    });
    onActiveChange.mockImplementation((id) => {
      expect(navigation.activeTurnId).toBe(id);
      order.push('active');
    });
    animateRunner.mockImplementation(() => order.push('runner'));

    navigation.navigateToMarker('s-1', 1);
    expect(order).toEqual(['measure', 'active', 'runner']);
    expect(navigation.activeTurnId).toBeNull();
    expect(animateRunner).toHaveBeenCalledWith(0, 1, 300);
    vi.advanceTimersByTime(299);
    expect(navigation.activeTurnId).toBeNull();
    vi.advanceTimersByTime(1);
    expect(navigation.activeTurnId).toBe('s-1');
    vi.advanceTimersByTime(100);
    viewport.scrollTop = 0;
    navigation.computeActiveByScroll();
    expect(navigation.activeTurnId).toBe('s-1');
    vi.advanceTimersByTime(801);
    navigation.computeActiveByScroll();
    expect(navigation.activeTurnId).toBe('s-0');
  });

  it('keeps dot index compatibility, ID fallback and preview ID priority', () => {
    const { navigation, viewport } = fixture();
    navigation.mode = 'jump';
    for (const [id, index, source, expected] of [
      ['s-2', 0, 'dot', 0],
      ['s-2', -1, 'dot', 2],
      ['s-1', 0, 'preview', 1],
      ['', 2, 'dot', 2],
    ] as const) {
      navigation.navigateToMarker(id, index, source);
      vi.advanceTimersByTime(0);
      expect(viewport.scrollTop).toBe(expected * 200);
      expect(navigation.activeTurnId).toBe(`s-${expected}`);
    }
  });

  it.each(['keyboard', 'dot'])(
    'cancels a pending scroll highlight after %s navigation',
    async (source) => {
      const { navigation, viewport, onActiveChange } = fixture();
      navigation.activeTurnId = 's-0';
      viewport.scrollTop = 260;
      navigation.computeActiveByScroll();
      expect(onActiveChange).not.toHaveBeenCalled();
      navigation.mode = 'jump';
      if (source === 'keyboard') await navigation.navigateToNextNode();
      else navigation.navigateToMarker('s-1', 1);
      vi.advanceTimersByTime(0);
      expect(navigation.activeTurnId).toBe('s-1');
      vi.advanceTimersByTime(200);
      expect(onActiveChange).toHaveBeenCalledExactlyOnceWith('s-1');
    },
  );

  it('resolves the marker again after refresh hands over a replacement viewport', () => {
    const { navigation, markers, refreshMarkers, viewport } = fixture();
    const next = document.createElement('div');
    const target = document.createElement('div');
    next.appendChild(target);
    document.body.appendChild(next);
    vi.spyOn(next, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 40, 300, 400));
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 620, 300, 100));
    const oldTarget = markers[1].element;
    refreshMarkers.mockImplementationOnce((element) => {
      expect(element).toBe(oldTarget);
      markers[1] = { id: 's-1', element: target };
      navigation.setViewport(next);
      return true;
    });
    navigation.mode = 'jump';
    navigation.navigateToMarker('s-1', 1, 'preview');

    expect(navigation.viewport).toBe(next);
    expect(next.scrollTop).toBe(580);
    expect(viewport.scrollTop).toBe(0);
  });

  it.each([
    { repeat: false, expected: 4 },
    { repeat: true, expected: 2 },
  ])('limits queued keyboard navigation when repeat is $repeat', async ({ repeat, expected }) => {
    const { navigation, animateRunner } = fixture(8);
    navigation.activeTurnId = 's-0';
    navigation.enqueueNavigation('next');
    for (let index = 0; index < 8; index++) navigation.enqueueNavigation('next', repeat);
    await vi.advanceTimersByTimeAsync(2000);
    expect(navigation.activeTurnId).toBe(`s-${expected}`);
    expect(animateRunner).toHaveBeenCalledTimes(expected);
  });

  it('refreshes at a boundary and clears queued steps for first/last navigation', async () => {
    const { navigation, markers, refreshMarkers, animateRunner } = fixture(4);
    navigation.activeTurnId = 's-3';
    navigation.enqueueNavigation('next');
    expect(animateRunner).not.toHaveBeenCalled();
    expect(refreshMarkers).toHaveBeenCalledWith(null, 'next');

    const extra = { id: 's-4', element: document.createElement('div') };
    refreshMarkers.mockImplementationOnce((_target, direction) => {
      expect(direction).toBe('next');
      markers.push(extra);
      return true;
    });
    navigation.enqueueNavigation('next');
    navigation.enqueueNavigation('previous');
    const first = navigation.navigateToFirstNode();
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    expect(navigation.activeTurnId).toBe('s-0');
    expect(animateRunner).toHaveBeenCalledTimes(2);

    const last = navigation.navigateToLastNode();
    await vi.advanceTimersByTimeAsync(1000);
    await last;
    expect(navigation.activeTurnId).toBe('s-4');
  });

  it('subscribes once to all keyboard actions and unsubscribes on destroy', async () => {
    const { navigation } = fixture(5);
    let listener: ShortcutCallback | undefined;
    const unsubscribe = vi.fn();
    vi.spyOn(keyboardShortcutService, 'init').mockResolvedValue(undefined);
    const subscribe = vi.spyOn(keyboardShortcutService, 'on').mockImplementation((callback) => {
      listener = callback;
      return unsubscribe;
    });
    await Promise.all([navigation.initKeyboardShortcuts(), navigation.initKeyboardShortcuts()]);
    expect(subscribe).toHaveBeenCalledTimes(1);
    navigation.mode = 'jump';
    for (const [action, expected] of [
      ['timeline:previous', 's-1'],
      ['timeline:next', 's-3'],
      ['timeline:first', 's-0'],
      ['timeline:last', 's-4'],
    ] as const) {
      navigation.activeTurnId = 's-2';
      listener!(action, new KeyboardEvent('keydown'));
      await vi.advanceTimersByTimeAsync(0);
      expect(navigation.activeTurnId).toBe(expected);
    }
    navigation.destroy();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not subscribe when shortcut initialization finishes after destroy', async () => {
    const { navigation } = fixture();
    let finish!: () => void;
    vi.spyOn(keyboardShortcutService, 'init').mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const subscribe = vi.spyOn(keyboardShortcutService, 'on');
    const pending = navigation.initKeyboardShortcuts();
    navigation.destroy();
    finish();
    await pending;
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('cancels superseded animation frames and all pending work on destroy', async () => {
    const { navigation, viewport, markers, onActiveChange, onScroll } = fixture();
    const readProfile = vi.spyOn(localStorage, 'getItem');
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++nextId, callback);
      return nextId;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    navigation.smoothScrollTo(markers[1].element, 600);
    const firstFrame = frames.get(1)!;
    firstFrame(0);
    const staleFrame = frames.get(2)!;
    navigation.smoothScrollTo(markers[2].element, 600);
    expect(cancel).toHaveBeenCalledWith(2);
    const beforeStaleFrame = viewport.scrollTop;
    staleFrame(100);
    expect(viewport.scrollTop).toBe(beforeStaleFrame);
    expect(readProfile).toHaveBeenCalledTimes(2);

    navigation.activeTurnId = 's-0';
    const pending = navigation.navigateToNextNode();
    navigation.scheduleScrollSync();
    navigation.destroy();
    const beforeDestroyFrame = viewport.scrollTop;
    firstFrame(200);
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(viewport.scrollTop).toBe(beforeDestroyFrame);
    expect(onActiveChange).not.toHaveBeenCalled();
    expect(onScroll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves a stored alias after lazy mounting and clears only its own hash', () => {
    const { navigation, viewport, markers } = fixture();
    navigation.mode = 'jump';
    const mounted = markers.splice(0);
    history.replaceState({}, '', '/app/a#gv-turn-u-1');
    navigation.handleStarredMessageNavigation();
    vi.advanceTimersByTime(299);
    markers.push(...mounted);
    vi.advanceTimersByTime(101);
    expect(viewport.scrollTop).toBe(200);
    expect(window.location.hash).toBe('#gv-turn-u-1');
    vi.advanceTimersByTime(900);
    expect(window.location.pathname).toBe('/app/a');
    expect(window.location.hash).toBe('');
    expect(markers.map((marker) => marker.id)).toEqual(['s-0', 's-1', 's-2']);
  });

  it.each(['retry', 'scroll', 'hash cleanup'])(
    'cancels a pending starred %s on destroy',
    (phase) => {
      const { navigation, markers, viewport } = fixture();
      if (phase === 'retry') markers.length = 0;
      navigation.mode = 'jump';
      history.replaceState({}, '', '/app/a#gv-turn-s-1');
      navigation.handleStarredMessageNavigation();
      if (phase === 'hash cleanup') vi.advanceTimersByTime(100);
      navigation.destroy();
      const previousScroll = viewport.scrollTop;
      history.replaceState({}, '', '/u/1/app/b#gv-turn-s-new');
      vi.advanceTimersByTime(7000);
      expect(window.location.hash).toBe('#gv-turn-s-new');
      expect(viewport.scrollTop).toBe(previousScroll);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['retry', 'scroll', 'hash cleanup'])(
    'leaves a new route/hash untouched by the old starred %s',
    (phase) => {
      const { navigation, markers, viewport } = fixture();
      if (phase === 'retry') markers.length = 0;
      navigation.mode = 'jump';
      history.replaceState({}, '', '/app/a#gv-turn-s-1');
      navigation.handleStarredMessageNavigation();
      if (phase === 'hash cleanup') vi.advanceTimersByTime(100);
      const previousScroll = viewport.scrollTop;
      history.replaceState({}, '', '/app/a#gv-turn-s-new');
      vi.advanceTimersByTime(7000);
      expect(window.location.hash).toBe('#gv-turn-s-new');
      expect(viewport.scrollTop).toBe(previousScroll);
    },
  );
});
