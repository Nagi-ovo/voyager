import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineState } from '../TimelineState';
import { TimelineView } from '../TimelineView';

const views: TimelineView[] = [];

function fixture(count = 2) {
  const viewport = document.createElement('div');
  Object.defineProperty(viewport, 'clientHeight', { value: 400 });
  const state = new TimelineState(() => {});
  state.replaceMarkers(
    Array.from({ length: count }, (_, index) => ({
      id: `s-${index}`,
      element: document.createElement('div'),
      summary: `Turn ${index}`,
      assistantSummary: '',
      baseN: index / Math.max(1, count - 1),
      starred: false,
    })),
  );
  const view = new TimelineView(state, {
    getViewport: () => viewport,
    getActiveId: () => null,
    navigate: vi.fn(),
    search: vi.fn(),
    onStyleChange: vi.fn(),
    onResize: vi.fn(),
  });
  views.push(view);
  view.mount();
  const { timelineBar: bar, track, trackContent, sliderHandle: handle } = view.ui;
  Object.defineProperty(bar, 'clientHeight', { value: 400 });
  Object.defineProperty(track, 'clientHeight', { value: 400 });
  Object.defineProperty(bar, 'setPointerCapture', { value: vi.fn() });
  Object.defineProperty(handle, 'setPointerCapture', { value: vi.fn() });
  vi.spyOn(bar!, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 24, 400));
  view.contentSpanPx = 1000;
  view.render();
  return { view, viewport, bar: bar!, track: track!, trackContent: trackContent!, handle: handle! };
}

function pointer(type: string, clientX = 0, clientY = 0) {
  return new MouseEvent(type, { bubbles: true, clientX, clientY });
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
  vi.clearAllMocks();
});

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TimelineView', () => {
  it('starts with the thinnest visual bar width without a saved width', () => {
    const { view, bar } = fixture();
    view.applyContainerVisibility();
    expect(view.barWidth).toBe(view.barWidthMin);
    expect(bar.style.getPropertyValue('--timeline-bar-width')).toBe('4px');
  });

  it('moves the runner with a compositor transform and reads the spring profile once', () => {
    const { view, trackContent } = fixture();
    const getItem = vi.spyOn(localStorage, 'getItem').mockReturnValue('ios');
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');

    view.startRunner(0, 1, 600);
    const runner = trackContent.querySelector<HTMLElement>('.timeline-runner-ring')!;
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(runner.style.top).toBe('0px');
    expect(runner.style.transform).toMatch(/^translate3d\(-50%, /);
    expect(runner.style.willChange).toBe('transform, opacity');

    const start = runner.style.transform;
    vi.advanceTimersByTime(320);
    expect(runner.style.transform).not.toBe(start);
    expect(getItem).toHaveBeenCalledTimes(1);
  });

  it('updates the slider from scroll position without remeasuring geometry', () => {
    const { view, track, trackContent, handle } = fixture(80);
    const range = parseFloat(trackContent.style.height) - 400;
    track.scrollTop = range / 2;
    const measure = vi.spyOn(handle, 'getBoundingClientRect');
    view.updateSliderPosition();
    expect(measure).not.toHaveBeenCalled();
    expect(handle.style.top).toBe('79px');
  });

  it('ends bar-width resize on pointercancel and releases the move listener', () => {
    const { view, bar } = fixture();
    bar.dispatchEvent(pointer('pointerdown', 110));
    expect(bar.classList.contains('timeline-resizing')).toBe(true);
    window.dispatchEvent(pointer('pointermove', 122));
    expect(view.barWidth).toBe(20);

    window.dispatchEvent(pointer('pointercancel'));
    expect(bar.classList.contains('timeline-resizing')).toBe(false);
    window.dispatchEvent(pointer('pointermove', 100));
    expect(view.barWidth).toBe(20);
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ geminiTimelineBarWidth: 20 });
  });

  it('resumes scroll synchronization after a slider pointercancel', () => {
    const { view, viewport, track, handle } = fixture(80);
    handle.dispatchEvent(pointer('pointerdown', 0, 80));
    const heldTop = track.scrollTop;
    viewport.scrollTop = 700;
    view.syncTimelineTrackToMain();
    expect(track.scrollTop).toBe(heldTop);

    window.dispatchEvent(pointer('pointercancel'));
    view.syncTimelineTrackToMain();
    expect(track.scrollTop).toBeGreaterThan(heldTop);
    const releasedTop = track.scrollTop;
    window.dispatchEvent(pointer('pointermove', 0, 200));
    expect(track.scrollTop).toBe(releasedTop);
  });

  it('ends bar position drag on pointercancel and releases the move listener', () => {
    const { view, bar } = fixture();
    view.toggleDraggable(true);
    bar.dispatchEvent(pointer('pointerdown', 101, 50));
    window.dispatchEvent(pointer('pointermove', 131, 80));
    expect(bar.style.left).toBe('130px');
    expect(bar.style.top).toBe('80px');

    window.dispatchEvent(pointer('pointercancel'));
    window.dispatchEvent(pointer('pointermove', 141, 90));
    expect(bar.style.left).toBe('130px');
    expect(bar.style.top).toBe('80px');
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({
      geminiTimelinePosition: expect.objectContaining({ version: 2 }),
    });
  });

  it('reapplies the cached position without reading storage', () => {
    const { view, bar } = fixture();
    view.savedTimelinePosition = { version: 2, topPercent: 10, leftPercent: 20 };
    view.reapplyPosition();
    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
    expect(bar.style.top).toBe(`${window.innerHeight * 0.1}px`);
    expect(bar.style.left).toBe(`${window.innerWidth * 0.2}px`);
  });

  it('leaves the CSS position alone when no position is cached', () => {
    const { view, bar } = fixture();
    view.reapplyPosition();
    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
    expect(bar.style.top).toBe('');
    expect(bar.style.left).toBe('');
  });

  it('releases pointer listeners so detached controls cannot restart work after destroy', () => {
    const { view, bar, handle } = fixture();
    const slider = view.ui.slider!;
    view.toggleDraggable(true);
    view.destroy();
    expect(vi.getTimerCount()).toBe(0);
    const addListener = vi.spyOn(window, 'addEventListener');
    const oldPosition = bar.style.cssText;
    for (const element of [bar, slider, handle]) {
      element.dispatchEvent(pointer('pointerenter', 110, 50));
      element.dispatchEvent(pointer('pointerdown', 110, 50));
      element.dispatchEvent(pointer('pointermove', 122, 70));
      element.dispatchEvent(pointer('pointerleave', 122, 70));
    }
    window.dispatchEvent(pointer('pointermove', 140, 100));
    expect(addListener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(bar.style.cssText).toBe(oldPosition);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });
});
