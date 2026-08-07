import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineManager } from '../manager';
import type { DotElement, MarkerLevel } from '../types';

type RulerMarker = {
  id: string;
  element: HTMLElement;
  summary: string;
  assistantSummary: string;
  n: number;
  baseN: number;
  dotElement: DotElement;
  starred: boolean;
};

type TimelineManagerInternal = {
  timelineStyle: 'dots' | 'ruler' | 'compact';
  scrollContainer: HTMLElement | null;
  markerTops: number[];
  markers: RulerMarker[];
  getMarkerLevel: (turnId: string) => MarkerLevel;
  updateRulerWave: () => void;
};

function makeMarker(index: number): RulerMarker {
  const dot = document.createElement('button') as DotElement;
  dot.className = 'timeline-dot';
  document.body.appendChild(dot);
  return {
    id: `turn-${index}`,
    element: document.createElement('div'),
    summary: `Question ${index}`,
    assistantSummary: `Response ${index}`,
    n: index / 2,
    baseN: index / 2,
    dotElement: dot,
    starred: false,
  };
}

describe('TimelineManager ruler wave', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('moves the longest tick continuously with the scroll focus', () => {
    const manager = new TimelineManager();
    const internal = manager as unknown as TimelineManagerInternal;
    const scrollContainer = document.createElement('div');
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 100, configurable: true });

    internal.timelineStyle = 'ruler';
    internal.scrollContainer = scrollContainer;
    internal.markerTops = [100, 200, 300];
    internal.markers = [makeMarker(0), makeMarker(1), makeMarker(2)];
    internal.getMarkerLevel = vi.fn((): MarkerLevel => 1);

    scrollContainer.scrollTop = 55;
    internal.updateRulerWave();
    const atFirst = internal.markers.map((marker) =>
      Number(marker.dotElement.style.getPropertyValue('--gv-timeline-ruler-scale')),
    );
    expect(atFirst[0]).toBeGreaterThan(atFirst[1]);
    expect(atFirst[1]).toBeGreaterThan(atFirst[2]);

    scrollContainer.scrollTop = 105;
    internal.updateRulerWave();
    const betweenTurns = internal.markers.map((marker) =>
      Number(marker.dotElement.style.getPropertyValue('--gv-timeline-ruler-scale')),
    );
    expect(betweenTurns[0]).toBeCloseTo(betweenTurns[1], 3);

    scrollContainer.scrollTop = 155;
    internal.updateRulerWave();
    const atSecond = internal.markers.map((marker) =>
      Number(marker.dotElement.style.getPropertyValue('--gv-timeline-ruler-scale')),
    );
    expect(atSecond[1]).toBeGreaterThan(atSecond[0]);
    expect(atSecond[1]).toBeGreaterThan(atSecond[2]);

    manager.destroy();
  });
});
