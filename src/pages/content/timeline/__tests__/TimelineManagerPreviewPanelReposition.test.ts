import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineManager } from '../manager';

type PreviewPanelLike = {
  reposition: () => void;
  setCompactMode: (compact: boolean) => void;
  setFloatingToggleSuppressed: (suppressed: boolean) => void;
  destroy: () => void;
};

type TimelineManagerInternal = {
  ui: {
    timelineBar: HTMLElement | null;
    tooltip?: HTMLElement | null;
    track?: HTMLElement | null;
    slider?: HTMLElement | null;
  };
  previewPanel: PreviewPanelLike | null;
  markers: Array<Record<string, unknown>>;
  timelineStyle: 'dots' | 'ruler' | 'compact';
  applyPosition: (top: number, left: number) => void;
  applyTimelineStyle: () => void;
  buildCompactMarkerOffsets: (hiddenIndices: ReadonlySet<number>) => Map<number, number>;
  applyDotPosition: (dot: HTMLElement, index: number, compactOffset?: number) => void;
};

describe('TimelineManager preview panel reposition', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('repositions preview toggle when timeline position is applied', () => {
    const manager = new TimelineManager();
    const internal = manager as unknown as TimelineManagerInternal;

    const timelineBar = document.createElement('div');
    Object.defineProperty(timelineBar, 'offsetWidth', { value: 24, configurable: true });
    Object.defineProperty(timelineBar, 'offsetHeight', { value: 100, configurable: true });
    document.body.appendChild(timelineBar);
    internal.ui.timelineBar = timelineBar;

    const reposition = vi.fn();
    internal.previewPanel = {
      reposition,
      setCompactMode: vi.fn(),
      setFloatingToggleSuppressed: vi.fn(),
      destroy: vi.fn(),
    };

    internal.applyPosition(120, 260);

    expect(timelineBar.style.top).toBe('120px');
    expect(timelineBar.style.left).toBe('260px');
    expect(timelineBar.classList.contains('gv-timeline-ruler-inward-right')).toBe(true);
    expect(reposition).toHaveBeenCalledTimes(1);

    internal.applyPosition(120, window.innerWidth - 40);
    expect(timelineBar.classList.contains('gv-timeline-ruler-inward-right')).toBe(false);

    manager.destroy();
  });

  it('applies compact rail semantics and preview interaction mode', () => {
    const manager = new TimelineManager();
    const internal = manager as unknown as TimelineManagerInternal;
    const timelineBar = document.createElement('div');
    const track = document.createElement('div');
    const slider = document.createElement('div');
    timelineBar.appendChild(track);
    document.body.append(timelineBar, slider);

    const setCompactMode = vi.fn();
    const setFloatingToggleSuppressed = vi.fn();
    internal.ui.timelineBar = timelineBar;
    internal.ui.track = track;
    internal.ui.slider = slider;
    internal.previewPanel = {
      reposition: vi.fn(),
      setCompactMode,
      setFloatingToggleSuppressed,
      destroy: vi.fn(),
    };
    internal.timelineStyle = 'compact';

    internal.applyTimelineStyle();

    expect(timelineBar.classList.contains('timeline-style-compact')).toBe(true);
    expect(slider.classList.contains('timeline-style-compact')).toBe(true);
    expect(track.getAttribute('aria-hidden')).toBe('true');
    expect(setCompactMode).toHaveBeenCalledWith(true);
    expect(setFloatingToggleSuppressed).toHaveBeenLastCalledWith(false);

    internal.timelineStyle = 'dots';
    internal.applyTimelineStyle();
    expect(timelineBar.classList.contains('timeline-style-compact')).toBe(false);
    expect(track.hasAttribute('aria-hidden')).toBe(false);
    expect(setCompactMode).toHaveBeenLastCalledWith(false);
    expect(setFloatingToggleSuppressed).toHaveBeenLastCalledWith(false);

    internal.timelineStyle = 'ruler';
    internal.applyTimelineStyle();
    expect(timelineBar.classList.contains('gv-timeline-style-ruler')).toBe(true);
    expect(timelineBar.classList.contains('timeline-style-compact')).toBe(false);
    expect(slider.classList.contains('timeline-style-compact')).toBe(true);
    expect(track.hasAttribute('aria-hidden')).toBe(false);
    expect(setCompactMode).toHaveBeenLastCalledWith(false);
    expect(setFloatingToggleSuppressed).toHaveBeenLastCalledWith(true);

    internal.timelineStyle = 'compact';
    internal.applyTimelineStyle();
    expect(timelineBar.classList.contains('gv-timeline-style-ruler')).toBe(false);

    manager.destroy();
  });

  it('clusters sparse markers around the center at a fixed compact gap', () => {
    const manager = new TimelineManager();
    const internal = manager as unknown as TimelineManagerInternal;
    internal.markers = [{}, {}, {}];

    const offsets = internal.buildCompactMarkerOffsets(new Set());

    expect(offsets.get(0)).toBe(-8);
    expect(offsets.get(1)).toBe(0);
    expect(offsets.get(2)).toBe(8);

    manager.destroy();
  });

  it('uses the same dense center cluster for ruler ticks instead of full-height positions', () => {
    const manager = new TimelineManager();
    const internal = manager as unknown as TimelineManagerInternal;
    internal.timelineStyle = 'ruler';
    internal.markers = [{ n: 0 }, { n: 1 }];
    const offsets = internal.buildCompactMarkerOffsets(new Set());
    const first = document.createElement('button');
    const second = document.createElement('button');

    internal.applyDotPosition(first, 0, offsets.get(0));
    internal.applyDotPosition(second, 1, offsets.get(1));

    expect(first.style.top).toBe('calc(50% - 4px)');
    expect(second.style.top).toBe('calc(50% + 4px)');
    manager.destroy();
  });
});
