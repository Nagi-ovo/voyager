import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { StarredMessagesService } from '../StarredMessagesService';
import { TimelineState } from '../TimelineState';
import { TimelineView } from '../TimelineView';
import type { StarredMessagesData } from '../starredTypes';
import type { TimelineMarker } from '../types';

const fixtures: Array<{ state: TimelineState; view: TimelineView }> = [];
function marker(index: number): TimelineMarker {
  return {
    id: `turn-${index}`,
    element: document.createElement('div'),
    summary: `Question ${index}`,
    assistantSummary: `Response ${index}`,
    baseN: index / 2,
    starred: false,
  };
}
function setup(markers = [marker(0), marker(1), marker(2)]) {
  const viewport = document.createElement('div');
  Object.defineProperty(viewport, 'clientHeight', { value: 100, configurable: true });
  const state = new TimelineState(() => {
    view.render();
    view.updatePreviewMarkers();
  });
  state.replaceMarkers(markers);
  const view = new TimelineView(state, {
    getViewport: () => viewport,
    getActiveId: () => null,
    navigate: vi.fn(),
    search: vi.fn(),
    onStyleChange: vi.fn(),
    onResize: vi.fn(),
  });
  fixtures.push({ state, view });
  view.mount();
  const bar = view.ui.timelineBar!;
  Object.defineProperties(bar, {
    clientHeight: { value: 200, configurable: true },
    offsetWidth: { value: 24, configurable: true },
    offsetHeight: { value: 100, configurable: true },
  });
  Object.defineProperty(view.ui.track!, 'clientHeight', { value: 200, configurable: true });
  view.render();
  return { state, view, viewport, bar };
}
const dots = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.timeline-dot'));
function fireStorage(data: StarredMessagesData) {
  for (const [listener] of vi.mocked(chrome.storage.onChanged.addListener).mock.calls) {
    listener({ [StorageKeys.TIMELINE_STARRED_MESSAGES]: { newValue: data } }, 'local');
  }
}

describe('TimelineView rendering', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    document.body.innerHTML = '';
    localStorage.clear();
    history.replaceState({}, '', '/app/abc123');
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({}));
    vi.mocked(chrome.storage.local.set).mockResolvedValue();
    vi.spyOn(StarredMessagesService, 'getAllStarredMessages').mockResolvedValue({ messages: {} });
  });
  afterEach(() => {
    fixtures.splice(0).forEach(({ view, state }) => {
      view.destroy();
      state.destroy();
    });
    vi.unstubAllGlobals();
  });

  it('repositions the preview toggle and grows ruler ticks inward after moving the rail', () => {
    const { view, bar } = setup();
    const reposition = vi.spyOn(view.previewPanel!, 'reposition');
    view.applyPosition(120, 260);
    expect(bar.style.top).toBe('120px');
    expect(bar.style.left).toBe('260px');
    expect(bar.classList.contains('gv-timeline-ruler-inward-right')).toBe(true);
    expect(reposition).toHaveBeenCalledOnce();
    view.applyPosition(120, window.innerWidth - 40);
    expect(bar.classList.contains('gv-timeline-ruler-inward-right')).toBe(false);
  });

  it('applies classic, compact and ruler semantics to the actual rail and preview toggle', () => {
    const { view, bar } = setup();
    const toggle = document.querySelector<HTMLElement>('.timeline-preview-toggle')!;
    view.timelineStyle = 'compact';
    view.applyTimelineStyle();
    expect(bar.classList.contains('timeline-style-compact')).toBe(true);
    expect(view.ui.slider!.classList.contains('timeline-style-compact')).toBe(true);
    expect(view.ui.track!.getAttribute('aria-hidden')).toBe('true');
    expect(bar.getAttribute('role')).toBe('button');
    expect(toggle.classList.contains('timeline-preview-toggle-compact')).toBe(true);
    view.timelineStyle = 'dots';
    view.applyTimelineStyle();
    expect(bar.classList.contains('timeline-style-compact')).toBe(false);
    expect(view.ui.track!.hasAttribute('aria-hidden')).toBe(false);
    expect(bar.hasAttribute('role')).toBe(false);
    view.timelineStyle = 'ruler';
    view.applyTimelineStyle();
    expect(bar.classList.contains('gv-timeline-style-ruler')).toBe(true);
    expect(bar.classList.contains('timeline-style-compact')).toBe(false);
    expect(view.ui.track!.hasAttribute('aria-hidden')).toBe(false);
    expect(toggle.hidden).toBe(true);
    view.timelineStyle = 'compact';
    view.applyTimelineStyle();
    expect(bar.classList.contains('gv-timeline-style-ruler')).toBe(false);
  });

  it('clusters sparse compact markers around the center at a fixed gap', () => {
    const { view } = setup();
    view.timelineStyle = 'compact';
    view.applyTimelineStyle();
    expect(dots().map((dot) => dot.style.top)).toEqual([
      'calc(50% - 8px)',
      'calc(50% + 0px)',
      'calc(50% + 8px)',
    ]);
  });

  it('uses the same dense center cluster for ruler ticks', () => {
    const { view } = setup([marker(0), marker(1)]);
    view.timelineStyle = 'ruler';
    view.applyTimelineStyle();
    expect(dots().map((dot) => dot.style.top)).toEqual(['calc(50% - 4px)', 'calc(50% + 4px)']);
  });

  it('moves the longest ruler tick continuously with the scroll focus', () => {
    const { view, viewport } = setup();
    view.markerTops = [100, 200, 300];
    view.timelineStyle = 'ruler';
    const scales = () =>
      dots().map((dot) => Number(dot.style.getPropertyValue('--gv-timeline-ruler-scale')));
    viewport.scrollTop = 55;
    view.applyTimelineStyle();
    const first = scales();
    expect(first[0]).toBeGreaterThan(first[1]);
    expect(first[1]).toBeGreaterThan(first[2]);
    viewport.scrollTop = 105;
    view.updateVirtualRangeAndRender();
    expect(scales()[0]).toBeCloseTo(scales()[1], 3);
    viewport.scrollTop = 155;
    view.updateVirtualRangeAndRender();
    expect(scales()[1]).toBeGreaterThan(scales()[0]);
    expect(scales()[1]).toBeGreaterThan(scales()[2]);
  });

  it('reuses surviving dots after a DOM rescan and removes orphans', () => {
    const { state, view } = setup();
    const original = dots()[1];
    state.replaceMarkers([marker(1), marker(3)]);
    view.render();
    expect(dots()).toHaveLength(2);
    expect(document.querySelector('[data-target-turn-id="turn-1"]')).toBe(original);
    expect(document.querySelector('[data-target-turn-id="turn-0"]')).toBeNull();
    expect(original.dataset.markerIndex).toBe('0');
  });

  it('mounts only the visible range and removes all dots for an empty snapshot', () => {
    const { state, view } = setup(
      Array.from({ length: 100 }, (_, index) => ({ ...marker(index), baseN: index / 99 })),
    );
    expect(dots().length).toBeLessThan(100);
    view.ui.track!.scrollTop = 800;
    view.updateVirtualRangeAndRender();
    expect(document.querySelector('[data-target-turn-id="turn-0"]')).toBeNull();
    state.replaceMarkers([]);
    view.render();
    expect(dots()).toHaveLength(0);
  });

  it('pushes storage star changes into the preview panel immediately', async () => {
    const { state, view } = setup();
    await state.init();
    view.updatePreviewMarkers();
    const update = vi.spyOn(view.previewPanel!, 'updateMarkers');
    const star = {
      turnId: 'turn-1',
      content: 'Question 1',
      conversationId: 'gemini:conv:abc123',
      conversationUrl: 'https://gemini.google.com/app/abc123',
      starredAt: 1,
    };
    fireStorage({ messages: { 'gemini:conv:abc123': [star] } });
    expect(update.mock.lastCall?.[0][1].starred).toBe(true);
    expect(update.mock.lastCall?.[0][1]).not.toHaveProperty('starredAt');
    expect(
      document.querySelector('[data-target-turn-id="turn-1"]')!.classList.contains('starred'),
    ).toBe(true);
    fireStorage({ messages: { 'gemini:conv:abc123': [] } });
    expect(update.mock.lastCall?.[0][1].starred).toBe(false);
  });

  it('keeps stars under legacy conversation keys when another conversation changes', async () => {
    const { state, view } = setup([marker(0)]);
    await state.init();
    const update = vi.spyOn(view.previewPanel!, 'updateMarkers');
    fireStorage({
      messages: {
        'gemini:legacy-key': [
          {
            turnId: 'turn-0',
            content: 'first',
            conversationId: 'gemini:legacy-key',
            conversationUrl: 'https://gemini.google.com/app/abc123',
            starredAt: 100,
          },
        ],
        'gemini:conv:other': [
          {
            turnId: 'turn-9',
            content: 'other',
            conversationId: 'gemini:conv:other',
            conversationUrl: 'https://gemini.google.com/app/other',
            starredAt: 999,
          },
        ],
      },
    });
    expect(state.isMarkerStarred('turn-0')).toBe(true);
    expect(state.isMarkerStarred('turn-9')).toBe(false);
    expect(update.mock.lastCall?.[0][0].starred).toBe(true);
  });
});
