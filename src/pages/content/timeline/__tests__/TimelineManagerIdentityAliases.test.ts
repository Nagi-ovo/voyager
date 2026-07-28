import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineManager } from '../manager';

const PARENT_ID = 's-6060606060606060';
const CHILD_ID = 's-6161616161616161';

type MarkerLevel = 1 | 2 | 3;

type TimelineIdentityInternal = {
  historyTimestampStore: {
    getTurnIdAliases: (_conversationId: string, turnId: string) => string[];
  };
  markerLevelEnabled: boolean;
  markers: Array<{
    id: string;
    element: HTMLElement;
    summary: string;
    n: number;
    baseN: number;
    dotElement: null;
    starred: boolean;
  }>;
  markerLevels: Map<string, MarkerLevel>;
  collapsedMarkers: Set<string>;
  getMarkerLevel: (turnId: string) => MarkerLevel;
  getHiddenMarkerIndices: () => Set<number>;
  setMarkerLevel: (turnId: string, level: MarkerLevel) => void;
  toggleCollapse: (turnId: string) => void;
  saveMarkerLevels: () => void;
  saveCollapsedMarkers: () => void;
  updateTimelineGeometry: () => void;
  updateVirtualRangeAndRender: () => void;
  updateSlider: () => void;
};

function marker(id: string, n: number) {
  return {
    id,
    element: document.createElement('div'),
    summary: id,
    n,
    baseN: n,
    dotElement: null,
    starred: false,
  };
}

function setup(aliases: ReadonlyMap<string, string>): TimelineIdentityInternal {
  const internal = new TimelineManager() as unknown as TimelineIdentityInternal;
  internal.historyTimestampStore = {
    getTurnIdAliases: (_conversationId, turnId) => {
      const legacy = aliases.get(turnId);
      return legacy ? [turnId, legacy] : [turnId];
    },
  };
  internal.markerLevelEnabled = true;
  internal.markers = [marker(PARENT_ID, 0), marker(CHILD_ID, 1)];
  internal.markerLevels = new Map();
  internal.collapsedMarkers = new Set();
  internal.saveMarkerLevels = vi.fn();
  internal.saveCollapsedMarkers = vi.fn();
  internal.updateTimelineGeometry = vi.fn();
  internal.updateVirtualRangeAndRender = vi.fn();
  internal.updateSlider = vi.fn();
  return internal;
}

describe('TimelineManager identity aliases', () => {
  beforeEach(() => {
    history.replaceState({}, '', '/app/abc');
  });

  it('applies legacy hierarchy data by full conversation position to a mounted tail', () => {
    const internal = setup(
      new Map([
        [PARENT_ID, 'u-60'],
        [CHILD_ID, 'u-61'],
      ]),
    );
    internal.markerLevels.set('u-61', 2);
    internal.collapsedMarkers.add('u-60');

    expect(internal.getMarkerLevel(CHILD_ID)).toBe(2);
    expect(internal.getHiddenMarkerIndices()).toEqual(new Set([1]));
  });

  it('does not apply an unverified legacy position to the first mounted tail turn', () => {
    const internal = setup(new Map());
    internal.markerLevels.set('u-0', 2);
    internal.collapsedMarkers.add('u-0');

    expect(internal.getMarkerLevel(PARENT_ID)).toBe(1);
    expect(internal.getHiddenMarkerIndices()).toEqual(new Set());
  });

  it('does not persist actions from a mounted positional fallback', () => {
    const internal = setup(new Map([['u-0', 'u-0']]));

    internal.setMarkerLevel('u-0', 2);
    internal.toggleCollapse('u-0');

    expect(internal.markerLevels.size).toBe(0);
    expect(internal.collapsedMarkers.size).toBe(0);
    expect(internal.saveMarkerLevels).not.toHaveBeenCalled();
    expect(internal.saveCollapsedMarkers).not.toHaveBeenCalled();
  });

  it('converges verified legacy aliases to the server id when the user edits them', () => {
    const internal = setup(new Map([[CHILD_ID, 'u-61']]));
    internal.markerLevels.set('u-61', 2);

    internal.setMarkerLevel(CHILD_ID, 3);

    expect(internal.markerLevels.get('u-61')).toBeUndefined();
    expect(internal.markerLevels.get(CHILD_ID)).toBe(3);
    expect(internal.saveMarkerLevels).toHaveBeenCalledOnce();
  });

  it('removes the verified legacy collapse alias when expanding', () => {
    const internal = setup(new Map([[PARENT_ID, 'u-60']]));
    internal.collapsedMarkers.add('u-60');

    internal.toggleCollapse(PARENT_ID);

    expect(internal.collapsedMarkers.size).toBe(0);
    expect(internal.saveCollapsedMarkers).toHaveBeenCalledOnce();
  });
});
