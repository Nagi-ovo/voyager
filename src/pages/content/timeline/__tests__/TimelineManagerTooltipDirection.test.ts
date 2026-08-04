import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineManager } from '../manager';
import type { DotElement } from '../types';

type TimelineManagerInternal = {
  ui: { tooltip: HTMLElement | null };
  previewPanel: { isOpen: boolean } | null;
  starred: Set<string>;
  timelineStyle: 'dots' | 'ruler' | 'compact';
  markerMap: Map<
    string,
    {
      id: string;
      element: HTMLElement;
      summary: string;
      assistantSummary: string;
      n: number;
      baseN: number;
      dotElement: DotElement | null;
      starred: boolean;
    }
  >;
  computePlacementInfo: (dot: HTMLElement) => { placement: 'left' | 'right'; width: number };
  truncateToThreeLines: (text: string, targetWidth: number) => { text: string; height: number };
  placeTooltipAt: (
    dot: HTMLElement,
    placement: 'left' | 'right',
    width: number,
    height: number,
  ) => void;
  showTooltipForDot: (dot: DotElement) => void;
};

describe('TimelineManager tooltip direction', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('sets tooltip dir to auto when showing preview text', () => {
    const manager = new TimelineManager();
    const internal = manager as unknown as TimelineManagerInternal;

    const tooltip = document.createElement('div');
    tooltip.className = 'timeline-tooltip';
    document.body.appendChild(tooltip);
    internal.ui.tooltip = tooltip;
    internal.previewPanel = null;
    internal.starred = new Set<string>();
    internal.computePlacementInfo = vi.fn(() => ({ placement: 'left' as const, width: 240 }));
    internal.truncateToThreeLines = vi.fn((text: string) => ({ text, height: 36 }));
    internal.placeTooltipAt = vi.fn();

    const dot = document.createElement('button') as DotElement;
    dot.className = 'timeline-dot';
    dot.setAttribute('aria-label', 'مرحبا بالعالم');
    dot.dataset.targetTurnId = 'turn-1';
    document.body.appendChild(dot);

    internal.showTooltipForDot(dot);

    expect(tooltip.getAttribute('dir')).toBe('auto');
    manager.destroy();
  });

  it('renders separate user and model typography in ruler previews', () => {
    const manager = new TimelineManager();
    const internal = manager as unknown as TimelineManagerInternal;
    const tooltip = document.createElement('div');
    tooltip.className = 'timeline-tooltip';
    document.body.appendChild(tooltip);
    internal.ui.tooltip = tooltip;
    internal.previewPanel = null;
    internal.starred = new Set<string>();
    internal.timelineStyle = 'ruler';
    internal.computePlacementInfo = vi.fn(() => ({ placement: 'left' as const, width: 280 }));
    internal.placeTooltipAt = vi.fn();

    const dot = document.createElement('button') as DotElement;
    dot.className = 'timeline-dot';
    dot.dataset.targetTurnId = 'turn-ruler';
    document.body.appendChild(dot);
    internal.markerMap = new Map([
      [
        'turn-ruler',
        {
          id: 'turn-ruler',
          element: document.createElement('div'),
          summary: 'Can Voyager create this effect?',
          assistantSummary: 'Yes. The ruler follows the current turn with a fluid wave.',
          n: 0,
          baseN: 0,
          dotElement: dot,
          starred: false,
        },
      ],
    ]);

    internal.showTooltipForDot(dot);

    expect(tooltip.classList.contains('gv-timeline-ruler-tooltip')).toBe(true);
    expect(tooltip.querySelector('.gv-timeline-ruler-prompt')?.textContent).toBe(
      'Can Voyager create this effect?',
    );
    expect(tooltip.querySelector('.gv-timeline-ruler-response')?.textContent).toBe(
      'Yes. The ruler follows the current turn with a fluid wave.',
    );
    manager.destroy();
  });
});
