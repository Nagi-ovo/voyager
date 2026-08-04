import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineManager } from '../manager';
import type { DotElement } from '../types';

type TimelineManagerInternal = {
  ui: { tooltip: HTMLElement | null };
  previewPanel: { isOpen: boolean } | null;
  starred: Set<string>;
  computePlacementInfo: (dot: HTMLElement) => { placement: 'left' | 'right'; width: number };
  truncateToThreeLines: (text: string, targetWidth: number) => { text: string; height: number };
  placeTooltipAt: (
    dot: HTMLElement,
    placement: 'left' | 'right',
    width: number,
    height: number,
  ) => void;
  timelineStyle: 'dots' | 'ruler' | 'compact';
  tooltipShowDelay: number;
  scheduleTooltipForDot: (dot: DotElement) => void;
  showTooltipForDot: (dot: DotElement) => void;
  cancelPendingTooltipShow: () => void;
};

function setupTooltipManager(): { manager: TimelineManager; internal: TimelineManagerInternal } {
  const manager = new TimelineManager();
  const internal = manager as unknown as TimelineManagerInternal;

  const tooltip = document.createElement('div');
  tooltip.className = 'timeline-tooltip';
  document.body.appendChild(tooltip);

  internal.ui.tooltip = tooltip;
  internal.previewPanel = null;
  internal.starred = new Set<string>();
  internal.tooltipShowDelay = 5;
  internal.computePlacementInfo = vi.fn(() => ({ placement: 'left' as const, width: 240 }));
  internal.truncateToThreeLines = vi.fn((text: string) => ({ text, height: 36 }));
  internal.placeTooltipAt = vi.fn();

  return { manager, internal };
}

function createDot(): DotElement {
  const dot = document.createElement('button') as DotElement;
  dot.className = 'timeline-dot';
  dot.setAttribute('aria-label', 'A long conversation preview');
  dot.dataset.targetTurnId = 'turn-1';
  document.body.appendChild(dot);
  return dot;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('TimelineManager tooltip hover intent', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not build tooltip content for a quick pass over a node', async () => {
    const { manager, internal } = setupTooltipManager();
    const dot = createDot();

    internal.scheduleTooltipForDot(dot);

    expect(internal.truncateToThreeLines).not.toHaveBeenCalled();

    internal.cancelPendingTooltipShow();
    await wait(10);

    expect(internal.truncateToThreeLines).not.toHaveBeenCalled();

    manager.destroy();
  });

  it('builds tooltip content after the hover intent delay', async () => {
    const { manager, internal } = setupTooltipManager();
    const dot = createDot();

    internal.scheduleTooltipForDot(dot);
    await wait(10);

    expect(internal.truncateToThreeLines).toHaveBeenCalledWith('A long conversation preview', 240);
    expect(internal.placeTooltipAt).toHaveBeenCalledWith(dot, 'left', 240, 36);

    manager.destroy();
  });

  it('shows ruler previews immediately without the node hover-intent delay', () => {
    const { manager, internal } = setupTooltipManager();
    const dot = createDot();
    internal.timelineStyle = 'ruler';
    internal.showTooltipForDot = vi.fn();

    internal.scheduleTooltipForDot(dot);

    expect(internal.showTooltipForDot).toHaveBeenCalledOnce();
    expect(internal.showTooltipForDot).toHaveBeenCalledWith(dot);
    manager.destroy();
  });
});
