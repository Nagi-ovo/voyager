import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TimelineStyle } from '@/core/types/common';

import { TimelineTooltip, type TimelineTooltipContent } from '../TimelineTooltip';
import type { DotElement } from '../types';

describe('TimelineTooltip', () => {
  let tooltip: TimelineTooltip;
  let bar: HTMLElement;
  let dot: DotElement;
  let element: HTMLElement;
  let context: { style: TimelineStyle; previewOpen: boolean };
  let content: TimelineTooltipContent;
  let getContent: ReturnType<typeof vi.fn<(dot: DotElement) => TimelineTooltipContent>>;

  function createDot(id: string, left = 960, top = 300): DotElement {
    const marker = document.createElement('button') as DotElement;
    marker.className = 'timeline-dot';
    marker.dataset.targetTurnId = id;
    marker.setAttribute('aria-label', `Prompt ${id}`);
    marker.getBoundingClientRect = () => ({
      x: left,
      y: top,
      left,
      top,
      width: 12,
      height: 12,
      right: left + 12,
      bottom: top + 12,
      toJSON: () => ({}),
    });
    bar.appendChild(marker);
    return marker;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('innerWidth', 1024);
    vi.stubGlobal('innerHeight', 768);
    bar = document.createElement('div');
    bar.className = 'gemini-timeline-bar';
    document.body.appendChild(bar);
    dot = createDot('first');
    context = { style: 'dots', previewOpen: false };
    content = {
      text: '2026-09-05\n★  A long   conversation preview',
      summary: 'A long conversation preview',
      assistantSummary: 'A model response',
      starred: true,
    };
    getContent = vi.fn(() => content);
    tooltip = new TimelineTooltip(bar, { getContext: () => context, getContent });
    element = document.querySelector<HTMLElement>('#gemini-timeline-tooltip')!;
  });

  afterEach(() => {
    tooltip.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not read or measure content for a quick pass over a marker', () => {
    tooltip.schedule(dot);
    vi.advanceTimersByTime(200);
    tooltip.cancelPending();
    vi.advanceTimersByTime(100);

    expect(getContent).not.toHaveBeenCalled();
    expect(element.textContent).toBe('');
    expect(element.classList.contains('visible')).toBe(false);
  });

  it('waits for hover intent and preserves timestamp lines and automatic text direction', () => {
    tooltip.schedule(dot);
    vi.advanceTimersByTime(249);
    expect(getContent).not.toHaveBeenCalled();
    tooltip.schedule(dot);
    vi.advanceTimersByTime(1);
    expect(getContent).toHaveBeenCalledExactlyOnceWith(dot);
    expect(element.textContent).toBe('2026-09-05\n★ A long conversation preview');
    expect(element.getAttribute('role')).toBe('tooltip');
    expect(element.getAttribute('dir')).toBe('auto');
    expect(element.classList.contains('visible')).toBe(false);
    vi.advanceTimersToNextFrame();
    expect(element.classList.contains('visible')).toBe(true);
    expect(element.getAttribute('aria-hidden')).toBe('false');
  });

  it('keeps only the latest marker pending and ignores a detached marker', () => {
    const second = createDot('second');
    tooltip.schedule(dot);
    vi.advanceTimersByTime(150);
    tooltip.schedule(second);
    vi.advanceTimersByTime(150);
    expect(getContent).not.toHaveBeenCalled();
    second.remove();
    vi.advanceTimersByTime(100);
    expect(getContent).not.toHaveBeenCalled();

    tooltip.schedule(dot);
    vi.advanceTimersByTime(250);
    expect(getContent).toHaveBeenCalledExactlyOnceWith(dot);
  });

  it('does not show while the preview panel is open, including during a pending hover', () => {
    context.previewOpen = true;
    tooltip.schedule(dot);
    tooltip.show(dot);
    vi.advanceTimersByTime(300);
    expect(getContent).not.toHaveBeenCalled();

    context.previewOpen = false;
    tooltip.schedule(dot);
    context.previewOpen = true;
    vi.advanceTimersByTime(300);
    expect(getContent).not.toHaveBeenCalled();
    expect(element.classList.contains('visible')).toBe(false);
  });

  it('renders ruler prompt and response immediately with separate typography and direction', () => {
    context.style = 'ruler';
    content.summary = 'مرحبا بالعالم';
    content.assistantSummary = '  A ruler preview response.  ';
    tooltip.schedule(dot);

    expect(getContent).toHaveBeenCalledExactlyOnceWith(dot);
    expect(element.classList.contains('gv-timeline-ruler-tooltip')).toBe(true);
    const prompt = element.querySelector('.gv-timeline-ruler-prompt');
    const response = element.querySelector('.gv-timeline-ruler-response');
    expect(prompt?.textContent).toBe('★ مرحبا بالعالم');
    expect(response?.textContent).toBe('A ruler preview response.');
    expect(prompt?.getAttribute('dir')).toBe('auto');
    expect(response?.getAttribute('dir')).toBe('auto');
    expect(element.getAttribute('aria-label')).toBe('★ مرحبا بالعالم\nA ruler preview response.');
    vi.advanceTimersToNextFrame();
    expect(element.classList.contains('visible')).toBe(true);
  });

  it('uses the marker label when a ruler summary is missing and omits an empty response', () => {
    context.style = 'ruler';
    content.summary = '';
    content.assistantSummary = '  ';
    content.starred = false;
    tooltip.show(dot);

    expect(element.querySelector('.gv-timeline-ruler-prompt')?.textContent).toBe('Prompt first');
    expect(element.querySelector('.gv-timeline-ruler-response')).toBeNull();
    expect(element.getAttribute('aria-label')).toBe('Prompt first');
  });

  it('preserves Arabic preview text and direction in the node style', () => {
    content.text = 'مرحبا بالعالم';
    tooltip.show(dot);

    expect(element.textContent).toBe('مرحبا بالعالم');
    expect(element.getAttribute('dir')).toBe('auto');
    expect(element.classList.contains('gv-timeline-ruler-tooltip')).toBe(false);
  });

  it.each([
    [960, 'left', '654px'],
    [20, 'right', '58px'],
  ])(
    'places the preview inside the viewport for a marker at x=%s',
    (left, placement, expectedLeft) => {
      const marker = createDot('positioned', left, 0);
      tooltip.show(marker);

      expect(element.getAttribute('data-placement')).toBe(placement);
      expect(element.style.width).toBe('280px');
      expect(element.style.left).toBe(expectedLeft);
      expect(element.style.top).toBe('8px');
    },
  );

  it('fits long text into three measured lines without removing the timestamp newline', () => {
    const measure = document.querySelector<HTMLElement>('[style*="-9999px"]')!;
    Object.defineProperty(measure, 'offsetHeight', {
      get: () => (measure.textContent!.length > 30 ? 90 : 54),
    });
    tooltip.show(dot);

    expect(element.textContent).toMatch(/^2026-09-05\n★ /);
    expect(element.textContent?.endsWith('…')).toBe(true);
    expect(element.textContent!.length).toBeLessThanOrEqual(30);
    expect(measure.textContent).toBe(element.textContent);
    expect(measure.style.whiteSpace).toBe('pre-line');
    expect(measure.style.pointerEvents).toBe('none');
    expect(measure.getAttribute('aria-hidden')).toBe('true');
  });

  it('refreshes current content only for a visible tooltip and a hovered or focused marker', () => {
    dot.focus();
    tooltip.refreshCurrent();
    expect(getContent).not.toHaveBeenCalled();
    tooltip.show(dot);
    vi.advanceTimersToNextFrame();
    content.text = 'Updated current title';
    tooltip.refreshCurrent();
    expect(element.textContent).toBe('Updated current title');
    expect(element.classList.contains('visible')).toBe(true);
  });

  it('cancels a deferred hide when the same marker is shown again', () => {
    tooltip.show(dot);
    vi.advanceTimersToNextFrame();
    tooltip.hide();
    vi.advanceTimersByTime(50);
    tooltip.show(dot);
    vi.advanceTimersByTime(100);
    expect(element.classList.contains('visible')).toBe(true);
  });

  it('does not revive a tooltip on an already queued animation frame after immediate hide', () => {
    tooltip.show(dot);
    tooltip.hide(true);
    vi.advanceTimersToNextFrame();

    expect(element.classList.contains('visible')).toBe(false);
    expect(element.getAttribute('aria-hidden')).toBe('true');
  });

  it('does not let an old hide timer close a tooltip shown after an immediate hide', () => {
    tooltip.show(dot);
    vi.advanceTimersToNextFrame();
    tooltip.hide();
    vi.advanceTimersByTime(50);
    tooltip.hide(true);
    const second = createDot('second');
    tooltip.show(second);
    vi.advanceTimersByTime(100);

    expect(element.classList.contains('visible')).toBe(true);
    expect(element.getAttribute('aria-hidden')).toBe('false');
  });

  it.each(['hover', 'frame', 'hide'])(
    'removes surfaces and pending %s work on destroy',
    (pending) => {
      if (pending === 'hover') tooltip.schedule(dot);
      else tooltip.show(dot);
      if (pending === 'hide') {
        vi.advanceTimersToNextFrame();
        tooltip.hide();
      }
      tooltip.destroy();
      getContent.mockClear();
      vi.advanceTimersByTime(1000);
      tooltip.schedule(dot);
      tooltip.refreshCurrent();

      expect(document.querySelector('#gemini-timeline-tooltip')).toBeNull();
      expect(document.querySelector('[style*="-9999px"]')).toBeNull();
      expect(getContent).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
