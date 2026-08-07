import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineManager } from '../manager';

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

type TimelineMarker = {
  id: string;
  summary: string;
  assistantSummary: string;
};

type TimelineManagerInternal = {
  conversationContainer: HTMLElement | null;
  scrollContainer: HTMLElement | null;
  userTurnSelector: string | null;
  ui: { timelineBar: HTMLElement | null; trackContent: HTMLElement | null };
  markers: TimelineMarker[];
  recalculateAndRenderMarkers: () => void;
  updateTimelineGeometry: () => void;
  updateIntersectionObserverTargetsFromMarkers: () => void;
  syncTimelineTrackToMain: () => void;
  updateVirtualRangeAndRender: () => void;
  updateActiveDotUI: () => void;
  scheduleScrollSync: () => void;
};

function setupForRecalc(container: HTMLElement): {
  manager: TimelineManager;
  internal: TimelineManagerInternal;
} {
  const scrollContainer = document.createElement('div');
  scrollContainer.scrollTop = 0;
  Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
  vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 400,
    width: 300,
    height: 400,
    toJSON: () => ({}),
  } as DOMRect);
  scrollContainer.appendChild(container);
  document.body.appendChild(scrollContainer);

  const timelineBar = document.createElement('div');
  const trackContent = document.createElement('div');
  timelineBar.appendChild(trackContent);
  document.body.appendChild(timelineBar);

  const manager = new TimelineManager();
  const internal = manager as unknown as TimelineManagerInternal;
  internal.conversationContainer = container;
  internal.scrollContainer = scrollContainer;
  internal.userTurnSelector = '.user-query-bubble-with-background';
  internal.ui.timelineBar = timelineBar;
  internal.ui.trackContent = trackContent;
  internal.updateTimelineGeometry = vi.fn();
  internal.updateIntersectionObserverTargetsFromMarkers = vi.fn();
  internal.syncTimelineTrackToMain = vi.fn();
  internal.updateVirtualRangeAndRender = vi.fn();
  internal.updateActiveDotUI = vi.fn();
  internal.scheduleScrollSync = vi.fn();
  return { manager, internal };
}

describe('TimelineManager summary extraction', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('excludes cdk-visually-hidden text from marker summary', () => {
    const container = document.createElement('div');
    const turn = document.createElement('span');
    turn.className = 'user-query-bubble-with-background';
    turn.innerHTML = `
      <span class="horizontal-container">
        <div role="heading" aria-level="2" class="query-text gds-body-l" dir="ltr">
          <span class="cdk-visually-hidden">你說了</span>
          <p class="query-text-line"> 嗯嗯！ </p>
        </div>
      </span>
    `;
    setElementTop(turn, 0);
    container.appendChild(turn);

    const { manager, internal } = setupForRecalc(container);
    internal.recalculateAndRenderMarkers();

    expect(internal.markers).toHaveLength(1);
    expect(internal.markers[0]?.summary).toBe('嗯嗯！');
    manager.destroy();
  });

  it('excludes .gv-fork-btn button text from marker summary', () => {
    const container = document.createElement('div');
    const turn = document.createElement('span');
    turn.className = 'user-query-bubble-with-background';
    turn.innerHTML = `
      <p class="query-text-line">Hello world</p>
      <button class="gv-fork-btn"><span>Fork</span></button>
    `;
    setElementTop(turn, 0);
    container.appendChild(turn);

    const { manager, internal } = setupForRecalc(container);
    internal.recalculateAndRenderMarkers();

    expect(internal.markers).toHaveLength(1);
    expect(internal.markers[0]?.summary).toBe('Hello world');
    expect(internal.markers[0]?.summary).not.toContain('Fork');
    manager.destroy();
  });

  it('assigns unique marker IDs to turns with identical text at different positions', () => {
    const container = document.createElement('div');

    const first = document.createElement('div');
    first.className = 'user-query-bubble-with-background';
    first.innerHTML = '<p>好的，继续执行下一步</p>';
    setElementTop(first, 0);

    const second = document.createElement('div');
    second.className = 'user-query-bubble-with-background';
    second.innerHTML = '<p>好的，继续执行下一步</p>';
    setElementTop(second, 200);

    container.appendChild(first);
    container.appendChild(second);

    const { manager, internal } = setupForRecalc(container);
    internal.recalculateAndRenderMarkers();

    expect(internal.markers).toHaveLength(2);
    expect(internal.markers[0]?.id).not.toBe(internal.markers[1]?.id);
    expect(internal.markers[0]?.summary).toBe('好的，继续执行下一步');
    expect(internal.markers[1]?.summary).toBe('好的，继续执行下一步');
    manager.destroy();
  });

  it('pairs each user question with the model response before the next turn', () => {
    const container = document.createElement('div');

    const first = document.createElement('div');
    first.className = 'user-query-bubble-with-background';
    first.textContent = 'Can Voyager make this interaction?';
    setElementTop(first, 0);

    const firstResponse = document.createElement('model-response');
    firstResponse.innerHTML = `
      <model-thoughts>Hidden reasoning</model-thoughts>
      <message-content>Yes. The ruler can follow the active turn smoothly.</message-content>
    `;

    const second = document.createElement('div');
    second.className = 'user-query-bubble-with-background';
    second.textContent = 'Will the preview include both roles?';
    setElementTop(second, 200);

    const secondResponse = document.createElement('model-response');
    secondResponse.innerHTML =
      '<message-content>Yes, with a quieter model-response style.</message-content>';

    container.append(first, firstResponse, second, secondResponse);

    const { manager, internal } = setupForRecalc(container);
    internal.recalculateAndRenderMarkers();

    expect(internal.markers).toHaveLength(2);
    expect(internal.markers[0]?.assistantSummary).toBe(
      'Yes. The ruler can follow the active turn smoothly.',
    );
    expect(internal.markers[0]?.assistantSummary).not.toContain('Hidden reasoning');
    expect(internal.markers[1]?.assistantSummary).toBe('Yes, with a quieter model-response style.');
    manager.destroy();
  });

  it('deduplicates turns by visible text when visually-hidden labels differ', () => {
    const container = document.createElement('div');
    const first = document.createElement('div');
    first.className = 'user-query-bubble-with-background';
    first.innerHTML = '<span class="cdk-visually-hidden">你說了</span><p>same content</p>';
    setElementTop(first, 0);

    const second = document.createElement('div');
    second.className = 'user-query-bubble-with-background';
    second.innerHTML = '<span class="visually-hidden">you said</span><p>same content</p>';
    setElementTop(second, 0);

    container.appendChild(first);
    container.appendChild(second);

    const { manager, internal } = setupForRecalc(container);
    internal.recalculateAndRenderMarkers();

    expect(internal.markers).toHaveLength(1);
    expect(internal.markers[0]?.summary).toBe('same content');
    manager.destroy();
  });
});
