import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineManager } from '../manager';
import type { DotElement } from '../types';

type TimelineMarker = {
  id: string;
  element: HTMLElement;
  summary: string;
  n: number;
  baseN: number;
  dotElement: DotElement | null;
  starred: boolean;
};

describe('TimelineManager flow click highlight behavior', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('clears previous active highlight immediately when clicking another node in flow mode', () => {
    const manager = new TimelineManager();
    const timelineBar = document.createElement('div');
    document.body.appendChild(timelineBar);

    const scrollContainer = document.createElement('div');
    document.body.appendChild(scrollContainer);

    const firstTarget = document.createElement('div');
    const secondTarget = document.createElement('div');

    const firstDot = document.createElement('button') as DotElement;
    firstDot.className = 'timeline-dot';
    firstDot.dataset.targetTurnId = 'm0';
    firstDot.dataset.markerIndex = '0';

    const secondDot = document.createElement('button') as DotElement;
    secondDot.className = 'timeline-dot';
    secondDot.dataset.targetTurnId = 'm1';
    secondDot.dataset.markerIndex = '1';
    timelineBar.appendChild(secondDot);

    const markers: TimelineMarker[] = [
      {
        id: 'm0',
        element: firstTarget,
        summary: 'first',
        n: 0,
        baseN: 0,
        dotElement: firstDot,
        starred: false,
      },
      {
        id: 'm1',
        element: secondTarget,
        summary: 'second',
        n: 1,
        baseN: 1,
        dotElement: secondDot,
        starred: false,
      },
    ];

    const internal = manager as unknown as {
      ui: {
        timelineBar: HTMLElement | null;
        tooltip: HTMLElement | null;
        trackContent?: HTMLElement | null;
        slider: HTMLElement | null;
        sliderHandle: HTMLElement | null;
      };
      scrollContainer: HTMLElement | null;
      conversationContainer: HTMLElement | null;
      scrollMode: 'flow' | 'jump';
      markers: TimelineMarker[];
      activeTurnId: string | null;
      setupEventListeners: () => void;
      updateActiveDotUI: () => void;
      startRunner: (fromIdx: number, toIdx: number, duration: number) => void;
      smoothScrollTo: (targetElement: HTMLElement, duration: number) => void;
      computeFlowDuration: (fromIdx: number, toIdx: number) => number;
      userTurnSelector: string;
      recalculateAndRenderMarkers: () => void;
    };

    internal.ui.timelineBar = timelineBar;
    internal.ui.tooltip = null;
    internal.ui.slider = null;
    internal.ui.sliderHandle = null;
    internal.scrollContainer = scrollContainer;
    internal.conversationContainer = document.body;
    internal.scrollMode = 'flow';
    internal.markers = markers;
    internal.activeTurnId = 'm0';
    internal.updateActiveDotUI();

    expect(firstDot.classList.contains('active')).toBe(true);

    const callOrder: string[] = [];
    const updateActiveDotUI = internal.updateActiveDotUI.bind(manager);
    internal.updateActiveDotUI = vi.fn(() => {
      callOrder.push('active');
      updateActiveDotUI();
    });
    const startRunnerSpy = vi.fn(() => callOrder.push('runner'));
    const smoothScrollSpy = vi.fn(() => callOrder.push('scroll'));
    const flowDurationSpy = vi.fn(() => 520);
    internal.startRunner = startRunnerSpy;
    internal.smoothScrollTo = smoothScrollSpy;
    internal.computeFlowDuration = flowDurationSpy;

    internal.setupEventListeners();
    secondDot.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(internal.activeTurnId).toBeNull();
    expect(firstDot.classList.contains('active')).toBe(false);
    expect(startRunnerSpy).toHaveBeenCalledWith(0, 1, 520);
    expect(smoothScrollSpy).toHaveBeenCalledWith(secondTarget, 520);
    expect(callOrder).toEqual(['scroll', 'active', 'runner']);

    manager.destroy();
  });

  it('commits the clicked node as active after flow scrolling finishes', () => {
    vi.useFakeTimers();

    const manager = new TimelineManager();
    const timelineBar = document.createElement('div');
    document.body.appendChild(timelineBar);

    const scrollContainer = document.createElement('div');
    document.body.appendChild(scrollContainer);

    const firstTarget = document.createElement('div');
    const secondTarget = document.createElement('div');

    const firstDot = document.createElement('button') as DotElement;
    firstDot.className = 'timeline-dot';
    firstDot.dataset.targetTurnId = 'm0';
    firstDot.dataset.markerIndex = '0';

    const secondDot = document.createElement('button') as DotElement;
    secondDot.className = 'timeline-dot';
    secondDot.dataset.targetTurnId = 'm1';
    secondDot.dataset.markerIndex = '1';
    timelineBar.appendChild(secondDot);

    const markers: TimelineMarker[] = [
      {
        id: 'm0',
        element: firstTarget,
        summary: 'first',
        n: 0,
        baseN: 0,
        dotElement: firstDot,
        starred: false,
      },
      {
        id: 'm1',
        element: secondTarget,
        summary: 'second',
        n: 1,
        baseN: 1,
        dotElement: secondDot,
        starred: false,
      },
    ];

    const internal = manager as unknown as {
      ui: {
        timelineBar: HTMLElement | null;
        tooltip: HTMLElement | null;
        slider: HTMLElement | null;
        sliderHandle: HTMLElement | null;
      };
      scrollContainer: HTMLElement | null;
      conversationContainer: HTMLElement | null;
      scrollMode: 'flow' | 'jump';
      markers: TimelineMarker[];
      activeTurnId: string | null;
      setupEventListeners: () => void;
      updateActiveDotUI: () => void;
      startRunner: (fromIdx: number, toIdx: number, duration: number) => void;
      smoothScrollTo: (targetElement: HTMLElement, duration: number) => void;
      computeFlowDuration: (fromIdx: number, toIdx: number) => number;
      scheduleScrollSync: () => void;
    };

    internal.ui.timelineBar = timelineBar;
    internal.ui.tooltip = null;
    internal.ui.slider = null;
    internal.ui.sliderHandle = null;
    internal.scrollContainer = scrollContainer;
    internal.conversationContainer = document.body;
    internal.scrollMode = 'flow';
    internal.markers = markers;
    internal.activeTurnId = 'm0';
    internal.updateActiveDotUI();

    internal.startRunner = vi.fn();
    internal.smoothScrollTo = vi.fn();
    internal.computeFlowDuration = vi.fn(() => 520);
    internal.scheduleScrollSync = vi.fn();

    internal.setupEventListeners();
    secondDot.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(internal.activeTurnId).toBeNull();
    expect(secondDot.classList.contains('active')).toBe(false);

    vi.advanceTimersByTime(519);
    expect(internal.activeTurnId).toBeNull();

    vi.advanceTimersByTime(1);
    expect(internal.activeTurnId).toBe('m1');
    expect(secondDot.classList.contains('active')).toBe(true);
    expect(internal.scheduleScrollSync).toHaveBeenCalledTimes(1);

    manager.destroy();
    vi.useRealTimers();
  });

  it('refreshes stale markers before click navigation when target element is detached', () => {
    const manager = new TimelineManager();

    const timelineBar = document.createElement('div');
    const trackContent = document.createElement('div');
    timelineBar.appendChild(trackContent);
    document.body.appendChild(timelineBar);

    const staleScrollContainer = document.createElement('div');
    const staleConversationContainer = document.createElement('div');

    const main = document.createElement('main');
    const freshScrollContainer = document.createElement('div');
    freshScrollContainer.style.overflowY = 'auto';
    main.appendChild(freshScrollContainer);

    const freshTarget = document.createElement('div');
    freshTarget.className = 'user';
    freshTarget.dataset.turnId = 'm1';
    freshTarget.textContent = 'fresh target';
    freshScrollContainer.appendChild(freshTarget);
    document.body.appendChild(main);

    const staleTarget = document.createElement('div');
    staleTarget.dataset.turnId = 'm1';

    const dot = document.createElement('button') as DotElement;
    dot.className = 'timeline-dot';
    dot.dataset.targetTurnId = 'm1';
    dot.dataset.markerIndex = '0';
    timelineBar.appendChild(dot);

    const internal = manager as unknown as {
      ui: {
        timelineBar: HTMLElement | null;
        tooltip: HTMLElement | null;
        trackContent?: HTMLElement | null;
        slider: HTMLElement | null;
        sliderHandle: HTMLElement | null;
      };
      scrollContainer: HTMLElement | null;
      conversationContainer: HTMLElement | null;
      scrollMode: 'flow' | 'jump';
      markers: TimelineMarker[];
      activeTurnId: string | null;
      setupEventListeners: () => void;
      updateActiveDotUI: () => void;
      smoothScrollTo: (targetElement: HTMLElement, duration: number) => void;
      computeFlowDuration: (fromIdx: number, toIdx: number) => number;
      userTurnSelector: string;
      recalculateAndRenderMarkers: () => void;
    };

    internal.ui.timelineBar = timelineBar;
    internal.ui.tooltip = null;
    internal.ui.trackContent = trackContent;
    internal.ui.slider = null;
    internal.ui.sliderHandle = null;
    internal.scrollContainer = staleScrollContainer;
    internal.conversationContainer = staleConversationContainer;
    internal.scrollMode = 'jump';
    internal.userTurnSelector = '.user';
    internal.markers = [
      {
        id: 'm1',
        element: staleTarget,
        summary: 'stale',
        n: 0,
        baseN: 0,
        dotElement: dot,
        starred: false,
      },
    ];
    internal.activeTurnId = 'm1';
    internal.updateActiveDotUI();

    const smoothScrollSpy = vi.fn();
    const flowDurationSpy = vi.fn(() => 0);
    internal.smoothScrollTo = smoothScrollSpy;
    internal.computeFlowDuration = flowDurationSpy;

    const recalcSpy = vi.fn(() => {
      internal.markers = [
        {
          id: 'm1',
          element: freshTarget,
          summary: 'fresh',
          n: 0,
          baseN: 0,
          dotElement: dot,
          starred: false,
        },
      ];
    });
    internal.recalculateAndRenderMarkers = recalcSpy;

    internal.setupEventListeners();
    dot.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(recalcSpy).toHaveBeenCalledTimes(1);
    expect(smoothScrollSpy).toHaveBeenCalledWith(freshTarget, 0);

    manager.destroy();
  });

  it('skips document scans after validating the connected target scroll container', () => {
    const manager = new TimelineManager();
    const scrollContainer = document.createElement('div');
    scrollContainer.style.overflowY = 'auto';
    const target = document.createElement('div');
    target.className = 'user';
    scrollContainer.appendChild(target);
    document.body.appendChild(scrollContainer);

    const internal = manager as unknown as {
      scrollContainer: HTMLElement | null;
      conversationContainer: HTMLElement | null;
      userTurnSelector: string;
      markers: TimelineMarker[];
      shouldRefreshForInteraction: (targetElement: HTMLElement | null) => boolean;
    };
    internal.scrollContainer = scrollContainer;
    internal.conversationContainer = scrollContainer;
    internal.userTurnSelector = '.user';
    internal.markers = [
      {
        id: 'm0',
        element: target,
        summary: 'current',
        n: 0,
        baseN: 0,
        dotElement: null,
        starred: false,
      },
    ];

    const querySelectorAll = vi.spyOn(document, 'querySelectorAll');
    const getComputedStyle = vi.spyOn(window, 'getComputedStyle');

    expect(internal.shouldRefreshForInteraction(target)).toBe(false);
    expect(querySelectorAll).not.toHaveBeenCalled();
    expect(getComputedStyle).toHaveBeenCalled();

    manager.destroy();
  });

  it('refreshes connected markers when Gemini inserts a new scroll viewport', () => {
    const manager = new TimelineManager();
    const staleScrollContainer = document.createElement('div');
    staleScrollContainer.style.overflowY = 'auto';
    const currentScrollContainer = document.createElement('div');
    currentScrollContainer.style.overflowY = 'scroll';
    const target = document.createElement('div');
    target.className = 'user';
    currentScrollContainer.appendChild(target);
    staleScrollContainer.appendChild(currentScrollContainer);
    document.body.appendChild(staleScrollContainer);

    const internal = manager as unknown as {
      scrollContainer: HTMLElement | null;
      conversationContainer: HTMLElement | null;
      userTurnSelector: string;
      markers: TimelineMarker[];
      shouldRefreshForInteraction: (targetElement: HTMLElement | null) => boolean;
    };
    internal.scrollContainer = staleScrollContainer;
    internal.conversationContainer = staleScrollContainer;
    internal.userTurnSelector = '.user';
    internal.markers = [
      {
        id: 'm0',
        element: target,
        summary: 'current',
        n: 0,
        baseN: 0,
        dotElement: null,
        starred: false,
      },
    ];

    expect(target.isConnected).toBe(true);
    expect(staleScrollContainer.contains(target)).toBe(true);
    expect(internal.shouldRefreshForInteraction(target)).toBe(true);

    manager.destroy();
  });

  it('refreshes the scroll viewport before preview-panel navigation', () => {
    const manager = new TimelineManager();
    const main = document.createElement('main');
    const staleScrollContainer = document.createElement('div');
    staleScrollContainer.style.overflowY = 'auto';
    const currentScrollContainer = document.createElement('div');
    currentScrollContainer.style.overflowY = 'scroll';
    const target = document.createElement('div');
    target.className = 'user';
    target.textContent = 'fresh target';
    currentScrollContainer.appendChild(target);
    staleScrollContainer.appendChild(currentScrollContainer);
    main.appendChild(staleScrollContainer);
    document.body.appendChild(main);

    const internal = manager as unknown as {
      ui: { timelineBar: HTMLElement | null };
      scrollContainer: HTMLElement | null;
      conversationContainer: HTMLElement | null;
      scrollMode: 'flow' | 'jump';
      userTurnSelector: string;
      markers: TimelineMarker[];
      activeTurnId: string | null;
      previewPanel: {
        updateMarkers: (
          markers: Array<{ id: string; summary: string; index: number; starred: boolean }>,
        ) => void;
        open: () => void;
      } | null;
      injectTimelineUI: () => void;
      smoothScrollTo: (targetElement: HTMLElement, duration: number) => void;
    };
    internal.scrollContainer = staleScrollContainer;
    internal.conversationContainer = main;
    internal.scrollMode = 'jump';
    internal.userTurnSelector = '.user';
    internal.activeTurnId = 'm0';
    internal.markers = [
      {
        id: 'm0',
        element: target,
        summary: 'fresh target',
        n: 0,
        baseN: 0,
        dotElement: null,
        starred: false,
      },
    ];

    const smoothScrollTo = vi.fn();
    internal.smoothScrollTo = smoothScrollTo;
    internal.injectTimelineUI();
    internal.previewPanel?.updateMarkers([
      { id: 'm0', summary: 'fresh target', index: 0, starred: false },
    ]);
    internal.previewPanel?.open();

    const item = document.querySelector('.timeline-preview-item');
    expect(item).not.toBeNull();
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(internal.scrollContainer).toBe(currentScrollContainer);
    expect(smoothScrollTo).toHaveBeenCalledWith(target, expect.any(Number));

    manager.destroy();
  });

  it('moves the runner with a compositor transform and reads the spring profile once', () => {
    const manager = new TimelineManager();
    const trackContent = document.createElement('div');
    document.body.appendChild(trackContent);

    const internal = manager as unknown as {
      ui: { trackContent?: HTMLElement | null };
      yPositions: number[];
      runnerRing: HTMLElement | null;
      startRunner: (fromIdx: number, toIdx: number, duration: number) => void;
    };
    internal.ui.trackContent = trackContent;
    internal.yPositions = [20, 120];

    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1);
    const getItem = vi.spyOn(localStorage, 'getItem').mockReturnValue('ios');

    internal.startRunner(0, 1, 600);

    expect(getItem).toHaveBeenCalledTimes(1);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(internal.runnerRing?.style.top).toBe('0px');
    expect(internal.runnerRing?.style.transform).toMatch(/^translate3d\(-50%, /);
    expect(internal.runnerRing?.style.willChange).toBe('transform, opacity');

    manager.destroy();
  });

  it('updates slider position during scrolling without remeasuring geometry', () => {
    const manager = new TimelineManager();
    const track = document.createElement('div');
    const sliderHandle = document.createElement('div');

    track.scrollTop = 500;
    const internal = manager as unknown as {
      ui: {
        track?: HTMLElement | null;
        sliderHandle?: HTMLElement | null;
      };
      sliderAlwaysVisible: boolean;
      sliderMaxTop: number;
      sliderScrollRange: number;
      updateSliderPosition: () => void;
    };
    internal.ui.track = track;
    internal.ui.sliderHandle = sliderHandle;
    internal.sliderAlwaysVisible = true;
    internal.sliderMaxTop = 100;
    internal.sliderScrollRange = 1_000;

    const getBoundingClientRect = vi.spyOn(sliderHandle, 'getBoundingClientRect');
    internal.updateSliderPosition();

    expect(getBoundingClientRect).not.toHaveBeenCalled();
    expect(sliderHandle.style.top).toBe('50px');

    manager.destroy();
  });

  it('stops an older scroll animation when a newer timeline click takes over', () => {
    const manager = new TimelineManager();
    const scrollContainer = document.createElement('div');
    const firstTarget = document.createElement('div');
    const secondTarget = document.createElement('div');
    scrollContainer.append(firstTarget, secondTarget);
    document.body.appendChild(scrollContainer);

    const rectAt = (top: number) =>
      ({
        x: 0,
        y: top,
        top,
        left: 0,
        right: 0,
        bottom: top,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue(rectAt(0));
    vi.spyOn(firstTarget, 'getBoundingClientRect').mockReturnValue(rectAt(100));
    vi.spyOn(secondTarget, 'getBoundingClientRect').mockReturnValue(rectAt(200));

    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const getItem = vi.spyOn(localStorage, 'getItem').mockReturnValue('ios');

    const internal = manager as unknown as {
      scrollContainer: HTMLElement | null;
      scrollMode: 'flow' | 'jump';
      smoothScrollTo: (targetElement: HTMLElement, duration: number) => void;
    };
    internal.scrollContainer = scrollContainer;
    internal.scrollMode = 'flow';

    internal.smoothScrollTo(firstTarget, 600);
    callbacks.shift()?.(0);
    expect(callbacks).toHaveLength(1);

    internal.smoothScrollTo(secondTarget, 600);
    expect(callbacks).toHaveLength(2);

    const scrollTopBeforeStaleFrame = scrollContainer.scrollTop;
    callbacks.shift()?.(100);
    expect(scrollContainer.scrollTop).toBe(scrollTopBeforeStaleFrame);
    expect(callbacks).toHaveLength(1);

    callbacks.shift()?.(100);
    expect(callbacks).toHaveLength(1);
    expect(getItem).toHaveBeenCalledTimes(2);

    manager.destroy();
  });
});
