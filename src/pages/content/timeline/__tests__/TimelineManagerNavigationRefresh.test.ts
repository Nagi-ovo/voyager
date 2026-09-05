import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TimelineNavigation } from '../TimelineNavigation';
import type { TimelineState } from '../TimelineState';
import type { TimelineView } from '../TimelineView';
import { TimelineManager } from '../manager';

type TimelineOwners = {
  state: TimelineState;
  view: TimelineView;
  navigation: TimelineNavigation;
  conversationContainer: HTMLElement;
  userTurnSelector: string;
  mountUI(): void;
  recalculateAndRenderMarkers(): void;
};

const managers: TimelineManager[] = [];

function addTurn(parent: HTMLElement, index: number, viewport: HTMLElement): HTMLElement {
  const turn = document.createElement('div');
  turn.className = 'user';
  turn.dataset.turnId = `s-${index}`;
  turn.textContent = `Turn ${index}`;
  Object.defineProperty(turn, 'offsetTop', { value: index * 200 });
  vi.spyOn(turn, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, index * 200 - viewport.scrollTop, 300, 100),
  );
  parent.appendChild(turn);
  return turn;
}

function fixture() {
  const main = document.createElement('main');
  const viewport = document.createElement('div');
  viewport.style.overflowY = 'auto';
  Object.defineProperty(viewport, 'clientHeight', { value: 400 });
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 400));
  const turns = document.createElement('div');
  viewport.appendChild(turns);
  main.appendChild(viewport);
  document.body.appendChild(main);
  const targets = [addTurn(turns, 0, viewport), addTurn(turns, 1, viewport)];
  const manager = new TimelineManager();
  managers.push(manager);
  const owners = manager as unknown as TimelineOwners;
  owners.conversationContainer = turns;
  owners.userTurnSelector = '.user';
  owners.navigation.setViewport(viewport);
  owners.navigation.mode = 'jump';
  owners.mountUI();
  owners.recalculateAndRenderMarkers();
  return {
    main,
    viewport,
    targets,
    navigation: owners.navigation,
    state: owners.state,
    view: owners.view,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  managers.splice(0).forEach((manager) => manager.destroy());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TimelineManager navigation refresh', () => {
  it('rescans turns outside the old container when navigating beyond its last marker', async () => {
    const { viewport, state, navigation } = fixture();
    expect(state.markers).toHaveLength(2);
    expect(navigation.activeTurnId).toBe(state.markers[1].id);
    const next = addTurn(viewport, 2, viewport);

    await navigation.navigateToNextNode();
    expect(state.markers).toHaveLength(3);
    expect(state.markers[2].element).toBe(next);
    expect(navigation.activeTurnId).toBe(state.markers[2].id);
    expect(viewport.scrollTop).toBe(400);
  });

  it('does not start queued scrolling beyond either boundary when the document has no more turns', async () => {
    const { viewport, view, navigation } = fixture();
    await vi.advanceTimersByTimeAsync(900);
    navigation.mode = 'flow';
    const runner = vi.spyOn(view, 'startRunner');
    const scrollTop = viewport.scrollTop;
    for (const [activeId, direction] of [
      ['s-1', 'next'],
      ['s-0', 'previous'],
    ] as const) {
      navigation.activeTurnId = activeId;
      navigation.enqueueNavigation(direction);
      await vi.advanceTimersByTimeAsync(2000);
      expect(navigation.activeTurnId).toBe(activeId);
      expect(viewport.scrollTop).toBe(scrollTop);
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it('rebinds a connected stale viewport before shortcut navigation', async () => {
    const { viewport, targets, navigation } = fixture();
    const currentViewport = document.createElement('div');
    currentViewport.style.overflowY = 'scroll';
    currentViewport.append(...targets);
    viewport.appendChild(currentViewport);
    vi.spyOn(currentViewport, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 40, 400, 400),
    );
    vi.mocked(targets[0].getBoundingClientRect).mockImplementation(
      () => new DOMRect(0, 240 - currentViewport.scrollTop, 300, 100),
    );
    navigation.activeTurnId = 's-1';
    expect(viewport.contains(targets[0])).toBe(true);

    await navigation.navigateToPreviousNode();
    expect(navigation.viewport).toBe(currentViewport);
    expect(currentViewport.scrollTop).toBe(200);
    expect(viewport.scrollTop).toBe(0);
    expect(navigation.activeTurnId).toBe('s-0');
  });
});
