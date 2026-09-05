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

function fixture(count = 2) {
  const main = document.createElement('main');
  const viewport = document.createElement('div');
  viewport.style.overflowY = 'auto';
  Object.defineProperty(viewport, 'clientHeight', { value: 400 });
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 50, 400, 400));
  main.appendChild(viewport);
  document.body.appendChild(main);
  const targets = Array.from({ length: count }, (_, index) => {
    const target = document.createElement('div');
    target.className = 'user';
    target.dataset.turnId = `s-${index}`;
    target.textContent = `Prompt ${index}`;
    Object.defineProperty(target, 'offsetTop', { value: index * 200 });
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 50 + index * 200 - viewport.scrollTop, 300, 100),
    );
    viewport.appendChild(target);
    return target;
  });
  const manager = new TimelineManager();
  managers.push(manager);
  const owners = manager as unknown as TimelineOwners;
  owners.conversationContainer = main;
  owners.userTurnSelector = '.user';
  owners.navigation.setViewport(viewport);
  owners.mountUI();
  Object.defineProperty(owners.view.ui.timelineBar, 'clientHeight', { value: 400 });
  Object.defineProperty(owners.view.ui.track, 'clientHeight', { value: 400 });
  owners.recalculateAndRenderMarkers();
  owners.navigation.activeTurnId = 's-0';
  owners.view.updateActiveDotUI();
  return {
    view: owners.view,
    state: owners.state,
    navigation: owners.navigation,
    viewport,
    targets,
    main,
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
  localStorage.setItem('geminiTimelineFlowDurationMs', '500');
  vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({}));
  vi.mocked(chrome.storage.local.set).mockResolvedValue();
});

afterEach(() => {
  managers.splice(0).forEach((manager) => manager.destroy());
  document.body.innerHTML = '';
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TimelineManager navigation surfaces', () => {
  it('preserves the manually scrolled rail when a marker level changes', () => {
    const { view, state, viewport } = fixture(100);
    state.markerLevelEnabled = true;
    view.ui.track!.scrollTop = 320;
    view.updateVirtualRangeAndRender();

    state.setMarkerLevel('s-50', 2);

    expect(state.getMarkerLevel('s-50')).toBe(2);
    expect(view.ui.track!.scrollTop).toBe(320);
    expect(viewport.scrollTop).toBe(0);
  });

  it('clears the previous dot during flow, then commits the clicked dot when scrolling ends', () => {
    const { view, navigation, targets, viewport } = fixture();
    const first = view.ui.timelineBar!.querySelector<HTMLElement>('[data-target-turn-id="s-0"]')!;
    const second = view.ui.timelineBar!.querySelector<HTMLElement>('[data-target-turn-id="s-1"]')!;
    expect(first.classList.contains('active')).toBe(true);
    const duration = navigation.computeFlowDuration(0, 1);
    const order: string[] = [];
    vi.mocked(targets[1].getBoundingClientRect).mockImplementation(() => {
      order.push('measure');
      return new DOMRect(0, 250 - viewport.scrollTop, 300, 100);
    });
    const updateActive = view.updateActiveDotUI.bind(view);
    vi.spyOn(view, 'updateActiveDotUI').mockImplementation(() => {
      order.push('active');
      updateActive();
    });
    const startRunner = view.startRunner.bind(view);
    vi.spyOn(view, 'startRunner').mockImplementation((...args) => {
      order.push('runner');
      startRunner(...args);
    });

    second.click();
    expect(order).toEqual(['measure', 'active', 'runner']);
    expect(navigation.activeTurnId).toBeNull();
    expect(first.classList.contains('active')).toBe(false);
    expect(second.classList.contains('active')).toBe(false);
    expect(view.ui.timelineBar!.querySelector('.timeline-runner-ring')).not.toBeNull();
    vi.advanceTimersByTime(duration - 1);
    expect(navigation.activeTurnId).toBeNull();
    vi.advanceTimersByTime(1);
    expect(navigation.activeTurnId).toBe('s-1');
    expect(second.classList.contains('active')).toBe(true);
    vi.advanceTimersByTime(32);
    expect(viewport.scrollTop).toBe(200);
  });

  it('rescans detached turns and scrolls the replacement target on a real dot click', () => {
    const { main, viewport, view, state, navigation } = fixture();
    navigation.mode = 'jump';
    const dot = view.ui.timelineBar!.querySelector<HTMLElement>('[data-target-turn-id="s-1"]')!;
    main.remove();
    const freshMain = document.createElement('main');
    const freshViewport = document.createElement('div');
    freshViewport.style.overflowY = 'auto';
    const freshTarget = document.createElement('div');
    freshTarget.className = 'user';
    freshTarget.dataset.turnId = 's-1';
    freshTarget.textContent = 'fresh second';
    freshViewport.appendChild(freshTarget);
    freshMain.appendChild(freshViewport);
    document.body.appendChild(freshMain);
    vi.spyOn(freshViewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 40, 400, 400));
    vi.spyOn(freshTarget, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 340, 300, 100));

    dot.click();
    vi.advanceTimersByTime(0);
    expect(state.markers).toHaveLength(1);
    expect(state.markers[0].element).toBe(freshTarget);
    expect(navigation.viewport).toBe(freshViewport);
    expect(navigation.activeTurnId).toBe('s-1');
    expect(freshViewport.scrollTop).toBe(300);
    expect(viewport.scrollTop).toBe(0);
  });

  it('skips document-wide scans after validating the connected target viewport', () => {
    const { view, navigation, viewport } = fixture();
    navigation.mode = 'jump';
    const dot = view.ui.timelineBar!.querySelector<HTMLElement>('[data-target-turn-id="s-1"]')!;
    const scan = vi.spyOn(document, 'querySelectorAll');
    const readStyle = vi.spyOn(window, 'getComputedStyle');
    dot.click();
    expect(scan).not.toHaveBeenCalled();
    expect(readStyle).toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(200);
  });

  it.each(['dot', 'preview'])(
    'rebinds a connected nested viewport before %s navigation',
    (source) => {
      const { view, navigation, viewport, targets } = fixture();
      navigation.mode = 'jump';
      const currentViewport = document.createElement('div');
      currentViewport.style.overflowY = 'scroll';
      vi.spyOn(currentViewport, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 50, 400, 400),
      );
      currentViewport.append(...targets);
      viewport.appendChild(currentViewport);
      expect(viewport.contains(targets[1])).toBe(true);

      if (source === 'dot') {
        view.ui.timelineBar!.querySelector<HTMLElement>('[data-target-turn-id="s-1"]')!.click();
      } else {
        view.previewPanel!.open();
        document.querySelectorAll<HTMLElement>('.timeline-preview-item')[1].click();
      }
      expect(navigation.viewport).toBe(currentViewport);
      expect(currentViewport.scrollTop).toBe(200);
      expect(viewport.scrollTop).toBe(0);
    },
  );
});
