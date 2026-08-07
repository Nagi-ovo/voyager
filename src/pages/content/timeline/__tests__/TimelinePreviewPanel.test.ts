import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GV_RTL_CLASS } from '@/core/utils/rtl';

import { TimelinePreviewPanel } from '../TimelinePreviewPanel';
import type { PreviewMarkerData } from '../types';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));

vi.mock('../../../../utils/i18n', () => ({
  getTranslationSync: (key: string) => {
    const map: Record<string, string> = {
      timelinePreviewSearch: 'Search...',
      timelinePreviewNoResults: 'No results',
      timelinePreviewNoMessages: 'No messages',
      timelineCompactOpenPreview: 'Open timeline preview',
    };
    return map[key] ?? key;
  },
}));

function makeMarkers(count: number): PreviewMarkerData[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `turn-${i}`,
    summary: `User message number ${i + 1}`,
    index: i,
    starred: i === 2,
  }));
}

describe('TimelinePreviewPanel', () => {
  let anchor: HTMLElement;
  let panel: TimelinePreviewPanel;
  let onNavigate: (turnId: string, index: number) => void;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.body.className = '';
    anchor = document.createElement('div');
    anchor.className = 'gemini-timeline-bar';
    document.body.appendChild(anchor);

    onNavigate = vi.fn();
    panel = new TimelinePreviewPanel(anchor);
    panel.init(onNavigate);
  });

  afterEach(() => {
    panel.destroy();
    document.body.innerHTML = '';
    document.body.className = '';
  });

  describe('DOM creation', () => {
    it('creates toggle button on the page', () => {
      const toggle = document.querySelector('.timeline-preview-toggle');
      expect(toggle).not.toBeNull();
      expect(toggle?.tagName).toBe('BUTTON');
    });

    it('creates panel with search and list', () => {
      const panelEl = document.querySelector('.timeline-preview-panel');
      expect(panelEl).not.toBeNull();
      expect(panelEl?.querySelector('.timeline-preview-search input')).not.toBeNull();
      expect(panelEl?.querySelector('.timeline-preview-list')).not.toBeNull();
    });
  });

  describe('toggle', () => {
    it('opens and closes panel', () => {
      const panelEl = document.querySelector('.timeline-preview-panel')!;
      expect(panelEl.classList.contains('visible')).toBe(false);
      expect(panel.isOpen).toBe(false);

      panel.toggle();
      expect(panelEl.classList.contains('visible')).toBe(true);
      expect(panel.isOpen).toBe(true);

      panel.toggle();
      expect(panelEl.classList.contains('visible')).toBe(false);
      expect(panel.isOpen).toBe(false);
    });

    it('toggle button click opens/closes panel', () => {
      const toggle = document.querySelector('.timeline-preview-toggle') as HTMLElement;
      toggle.click();
      expect(panel.isOpen).toBe(true);

      toggle.click();
      expect(panel.isOpen).toBe(false);
    });

    it('allows manual close and reopen while pinned', () => {
      panel.setPinned(true);
      expect(panel.isPinned).toBe(true);

      panel.toggle();
      expect(panel.isOpen).toBe(true);

      panel.toggle();
      expect(panel.isOpen).toBe(false);
      expect(panel.isPinned).toBe(true);

      panel.toggle();
      expect(panel.isOpen).toBe(true);
      expect(panel.isPinned).toBe(true);
    });
  });

  describe('compact mode', () => {
    it('turns the timeline rail into the accessible preview trigger', () => {
      panel.setCompactMode(true);

      const panelEl = document.querySelector('.timeline-preview-panel');
      const toggle = document.querySelector('.timeline-preview-toggle');
      expect(anchor.getAttribute('role')).toBe('button');
      expect(anchor.getAttribute('tabindex')).toBe('0');
      expect(anchor.getAttribute('aria-label')).toBe('Open timeline preview');
      expect(panelEl?.classList.contains('timeline-preview-panel-compact')).toBe(true);
      expect(toggle?.classList.contains('timeline-preview-toggle-compact')).toBe(true);
      expect((toggle as HTMLButtonElement | null)?.hidden).toBe(true);

      panel.setCompactMode(false);
      expect((toggle as HTMLButtonElement | null)?.hidden).toBe(false);
    });

    it('hides the floating toggle for a dense ruler without enabling compact panel behavior', () => {
      const toggle = document.querySelector('.timeline-preview-toggle') as HTMLButtonElement;

      panel.setFloatingToggleSuppressed(true);
      expect(toggle.hidden).toBe(true);
      expect(anchor.hasAttribute('role')).toBe(false);

      panel.setFloatingToggleSuppressed(false);
      expect(toggle.hidden).toBe(false);
    });

    it('opens on rail hover and closes after leaving the rail and panel', () => {
      vi.useFakeTimers();
      try {
        panel.setCompactMode(true);
        anchor.dispatchEvent(new MouseEvent('mouseenter'));
        expect(panel.isOpen).toBe(true);

        anchor.dispatchEvent(new MouseEvent('mouseleave'));
        vi.advanceTimersByTime(159);
        expect(panel.isOpen).toBe(true);
        vi.advanceTimersByTime(1);
        expect(panel.isOpen).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the panel open while the pointer crosses from rail to panel', () => {
      vi.useFakeTimers();
      try {
        panel.setCompactMode(true);
        anchor.dispatchEvent(new MouseEvent('mouseenter'));
        anchor.dispatchEvent(new MouseEvent('mouseleave'));

        const panelEl = document.querySelector('.timeline-preview-panel') as HTMLElement;
        panelEl.dispatchEvent(new MouseEvent('mouseenter'));
        vi.advanceTimersByTime(200);
        expect(panel.isOpen).toBe(true);

        panelEl.dispatchEvent(new MouseEvent('mouseleave'));
        vi.advanceTimersByTime(160);
        expect(panel.isOpen).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the panel open while the pointer pauses in the compact hover gap', () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(new DOMRect(900, 100, 24, 600));
        const panelEl = document.querySelector('.timeline-preview-panel') as HTMLElement;
        Object.defineProperty(panelEl, 'offsetHeight', { value: 240, configurable: true });

        panel.setCompactMode(true);
        anchor.dispatchEvent(new MouseEvent('mouseenter'));
        anchor.dispatchEvent(new MouseEvent('mouseleave'));

        const bridge = document.querySelector('.gv-timeline-preview-hover-bridge') as HTMLElement;
        expect(bridge.classList.contains('gv-timeline-preview-hover-bridge-visible')).toBe(true);
        expect(bridge.style.left).toBe('888px');
        expect(bridge.style.width).toBe('12px');

        bridge.dispatchEvent(new MouseEvent('mouseenter'));
        vi.advanceTimersByTime(400);
        expect(panel.isOpen).toBe(true);

        bridge.dispatchEvent(new MouseEvent('mouseleave'));
        vi.advanceTimersByTime(160);
        expect(panel.isOpen).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('treats the compact hover bridge as part of the preview interaction area', () => {
      vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(new DOMRect(900, 100, 24, 600));
      panel.setCompactMode(true);
      anchor.dispatchEvent(new MouseEvent('mouseenter'));
      expect(panel.isOpen).toBe(true);

      const bridge = document.querySelector('.gv-timeline-preview-hover-bridge') as HTMLElement;
      bridge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

      expect(panel.isOpen).toBe(true);
    });

    it('toggles the panel when the rail is clicked', () => {
      panel.setCompactMode(true);

      anchor.click();
      expect(panel.isOpen).toBe(true);
      expect(anchor.getAttribute('aria-expanded')).toBe('true');

      anchor.click();
      expect(panel.isOpen).toBe(false);
      expect(anchor.getAttribute('aria-expanded')).toBe('false');
    });

    it('stays open when pointer focus occurs between pointerdown and click', () => {
      panel.setCompactMode(true);

      anchor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(panel.isOpen).toBe(true);
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(panel.isOpen).toBe(true);
    });

    it('allows the hidden compact toggle to be closed manually while pinned', () => {
      panel.setCompactMode(true);
      panel.setPinned(true);
      panel.open();

      anchor.click();

      expect(panel.isOpen).toBe(false);
      expect(panel.isPinned).toBe(true);
    });
  });

  describe('updateMarkers', () => {
    it('repositions an open panel when lazy-loaded markers increase its height', () => {
      vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(new DOMRect(900, 100, 24, 600));
      const panelEl = document.querySelector('.timeline-preview-panel') as HTMLElement;

      Object.defineProperty(panelEl, 'offsetHeight', { value: 200, configurable: true });
      panel.updateMarkers(makeMarkers(3));
      panel.open();
      expect(panelEl.style.top).toBe('300px');

      Object.defineProperty(panelEl, 'offsetHeight', { value: 500, configurable: true });
      panel.updateMarkers(makeMarkers(30));

      expect(panelEl.style.top).toBe('150px');
    });

    it('renders correct number of items when open', () => {
      const markers = makeMarkers(5);
      panel.updateMarkers(markers);
      panel.open();

      const items = document.querySelectorAll('.timeline-preview-item');
      expect(items.length).toBe(5);
    });

    it('shows index numbers', () => {
      panel.updateMarkers(makeMarkers(3));
      panel.open();

      const indices = document.querySelectorAll('.timeline-preview-index');
      expect(indices[0]?.textContent).toBe('1');
      expect(indices[2]?.textContent).toBe('3');
    });

    it('marks starred items', () => {
      panel.updateMarkers(makeMarkers(5));
      panel.open();

      const items = document.querySelectorAll('.timeline-preview-item');
      expect(items[2]?.classList.contains('starred')).toBe(true);
      expect(items[0]?.classList.contains('starred')).toBe(false);
    });

    it('does not crowd starred items with bookmark timestamps', () => {
      panel.updateMarkers(makeMarkers(5));
      panel.open();

      expect(document.querySelector('.timeline-preview-starred-time')).toBeNull();
    });

    it('shows empty message when no markers', () => {
      panel.updateMarkers([]);
      panel.open();

      const empty = document.querySelector('.timeline-preview-empty');
      expect(empty).not.toBeNull();
      expect(empty?.textContent).toBe('No messages');
    });

    it('sets preview text direction to auto for bidi-safe rendering', () => {
      const markers: PreviewMarkerData[] = [
        {
          id: 'turn-ar',
          summary: 'مرحبا بكم في Gemini Voyager',
          index: 0,
          starred: false,
        },
      ];
      panel.updateMarkers(markers);
      panel.open();

      const text = document.querySelector('.timeline-preview-text') as HTMLElement | null;
      expect(text?.getAttribute('dir')).toBe('auto');
    });
  });

  describe('rtl adaptation', () => {
    it('applies rtl direction when body has gv-rtl class', () => {
      document.body.classList.add(GV_RTL_CLASS);
      panel.reposition();

      const panelEl = document.querySelector('.timeline-preview-panel');
      const listEl = document.querySelector('.timeline-preview-list');
      expect(panelEl?.getAttribute('dir')).toBe('rtl');
      expect(listEl?.getAttribute('dir')).toBe('rtl');
    });

    it('keeps toggle on left side of timeline in rtl with viewport clamp', () => {
      const rectSpy = vi
        .spyOn(anchor, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(15, 60, 24, 500));

      document.body.classList.add(GV_RTL_CLASS);
      panel.reposition();

      const toggle = document.querySelector('.timeline-preview-toggle') as HTMLElement | null;
      expect(toggle?.style.left).toBe('8px');
      rectSpy.mockRestore();
    });
  });

  describe('updateActiveTurn', () => {
    it('highlights the active item', () => {
      panel.updateMarkers(makeMarkers(5));
      panel.open();

      panel.updateActiveTurn('turn-1');

      const items = document.querySelectorAll('.timeline-preview-item');
      expect(items[1]?.classList.contains('active')).toBe(true);
      expect(items[0]?.classList.contains('active')).toBe(false);
    });

    it('switches active highlight on update', () => {
      panel.updateMarkers(makeMarkers(5));
      panel.open();

      panel.updateActiveTurn('turn-0');
      let items = document.querySelectorAll('.timeline-preview-item');
      expect(items[0]?.classList.contains('active')).toBe(true);

      panel.updateActiveTurn('turn-3');
      items = document.querySelectorAll('.timeline-preview-item');
      expect(items[0]?.classList.contains('active')).toBe(false);
      expect(items[3]?.classList.contains('active')).toBe(true);
    });
  });

  describe('search filtering', () => {
    it('filters by substring (case-insensitive)', async () => {
      panel.updateMarkers(makeMarkers(10));
      panel.open();

      const input = document.querySelector('.timeline-preview-search input') as HTMLInputElement;
      input.value = 'number 3';
      input.dispatchEvent(new Event('input'));

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 250));

      const items = document.querySelectorAll('.timeline-preview-item');
      expect(items.length).toBe(1);
      expect(items[0]?.querySelector('.timeline-preview-text')?.textContent).toContain('3');
    });

    it('shows all items when search is cleared', async () => {
      panel.updateMarkers(makeMarkers(5));
      panel.open();

      const input = document.querySelector('.timeline-preview-search input') as HTMLInputElement;
      input.value = 'number 1';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(document.querySelectorAll('.timeline-preview-item').length).toBe(1);

      input.value = '';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(document.querySelectorAll('.timeline-preview-item').length).toBe(5);
    });

    it('shows "No results" when search has no match', async () => {
      panel.updateMarkers(makeMarkers(3));
      panel.open();

      const input = document.querySelector('.timeline-preview-search input') as HTMLInputElement;
      input.value = 'zzzznonexistent';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 250));

      const empty = document.querySelector('.timeline-preview-empty');
      expect(empty?.textContent).toBe('No results');
    });
  });

  describe('navigation', () => {
    it('calls onNavigate when item is clicked', () => {
      panel.updateMarkers(makeMarkers(5));
      panel.open();

      const items = document.querySelectorAll('.timeline-preview-item');
      (items[2] as HTMLElement).click();

      expect(onNavigate).toHaveBeenCalledWith('turn-2', 2);
    });
  });

  describe('long press star', () => {
    let onToggleStar: Mock<(turnId: string) => void>;

    beforeEach(() => {
      vi.useFakeTimers();
      panel.destroy();
      onToggleStar = vi.fn<(turnId: string) => void>();
      panel = new TimelinePreviewPanel(anchor);
      panel.init(onNavigate, undefined, onToggleStar);
      panel.updateMarkers(makeMarkers(5));
      panel.open();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function getItem(index = 0): HTMLElement {
      const item = document.querySelectorAll<HTMLElement>('.timeline-preview-item')[index];
      if (!item) throw new Error(`Expected preview item ${index}`);
      return item;
    }

    function pointer(type: string, target: EventTarget, options: PointerEventInit = {}): void {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          clientX: 10,
          clientY: 10,
          isPrimary: true,
          pointerType: 'mouse',
          ...options,
        }),
      );
    }

    it('toggles the star after 550ms and suppresses the generated click', () => {
      const item = getItem(1);

      pointer('pointerdown', item);
      expect(item.classList.contains('holding')).toBe(true);
      vi.advanceTimersByTime(549);
      expect(onToggleStar).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onToggleStar).toHaveBeenCalledOnce();
      expect(onToggleStar).toHaveBeenCalledWith('turn-1');
      expect(item.classList.contains('holding')).toBe(false);

      pointer('pointerup', window);
      item.click();
      expect(onNavigate).not.toHaveBeenCalled();
    });

    it('supports touch long press', () => {
      const item = getItem(2);

      pointer('pointerdown', item, { pointerType: 'touch' });
      vi.advanceTimersByTime(550);

      expect(onToggleStar).toHaveBeenCalledWith('turn-2');
      pointer('pointerup', window, { pointerType: 'touch' });
      item.click();
      expect(onNavigate).not.toHaveBeenCalled();
    });

    it('suppresses navigation even when the user keeps holding after the star toggles', () => {
      const item = getItem(4);

      pointer('pointerdown', item);
      vi.advanceTimersByTime(550);
      expect(onToggleStar).toHaveBeenCalledWith('turn-4');

      vi.advanceTimersByTime(500);
      pointer('pointerup', window);
      item.click();

      expect(onNavigate).not.toHaveBeenCalled();
    });

    it('keeps short press navigation unchanged', () => {
      const item = getItem(3);

      pointer('pointerdown', item);
      vi.advanceTimersByTime(549);
      pointer('pointerup', window);
      item.click();

      expect(onToggleStar).not.toHaveBeenCalled();
      expect(onNavigate).toHaveBeenCalledWith('turn-3', 3);
      expect(item.classList.contains('holding')).toBe(false);
    });

    it('cancels when the pointer moves beyond the tolerance', () => {
      const item = getItem();

      pointer('pointerdown', item);
      pointer('pointermove', window, { clientX: 17 });
      vi.advanceTimersByTime(550);

      expect(onToggleStar).not.toHaveBeenCalled();
      expect(item.classList.contains('holding')).toBe(false);
    });

    it('cancels on pointercancel', () => {
      const item = getItem();

      pointer('pointerdown', item);
      pointer('pointercancel', window);
      vi.advanceTimersByTime(550);

      expect(onToggleStar).not.toHaveBeenCalled();
      expect(item.classList.contains('holding')).toBe(false);
    });

    it('cancels a pending press when the list rerenders or is destroyed', () => {
      pointer('pointerdown', getItem());
      const changedMarkers = makeMarkers(5);
      changedMarkers[0] = { ...changedMarkers[0], summary: 'Updated summary' };
      panel.updateMarkers(changedMarkers);
      vi.advanceTimersByTime(550);
      expect(onToggleStar).not.toHaveBeenCalled();

      pointer('pointerdown', getItem());
      panel.destroy();
      vi.advanceTimersByTime(550);
      expect(onToggleStar).not.toHaveBeenCalled();
    });
  });

  describe('close behavior', () => {
    it('closes on Escape key', () => {
      panel.open();
      expect(panel.isOpen).toBe(true);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(panel.isOpen).toBe(false);
    });

    it('closes on click outside', () => {
      panel.open();
      expect(panel.isOpen).toBe(true);

      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      expect(panel.isOpen).toBe(false);
    });

    it('does not close on click inside panel', () => {
      panel.updateMarkers(makeMarkers(3));
      panel.open();

      const panelEl = document.querySelector('.timeline-preview-panel')!;
      panelEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      expect(panel.isOpen).toBe(true);
    });

    it('ignores escape and outside click while pinned', () => {
      panel.setPinned(true);
      panel.open();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

      expect(panel.isOpen).toBe(true);
    });

    it('keeps current visibility when pinning is disabled', () => {
      panel.setPinned(true);
      panel.open();
      expect(panel.isOpen).toBe(true);

      panel.setPinned(false);
      expect(panel.isPinned).toBe(false);
      expect(panel.isOpen).toBe(true);
    });
  });

  describe('scroll isolation', () => {
    it('stops wheel event propagation on list', () => {
      panel.updateMarkers(makeMarkers(20));
      panel.open();

      const list = document.querySelector('.timeline-preview-list') as HTMLElement;
      const wheelEvent = new WheelEvent('wheel', { deltaY: 10, bubbles: true, cancelable: true });
      const stopSpy = vi.spyOn(wheelEvent, 'stopPropagation');
      list.dispatchEvent(wheelEvent);

      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it('removes all DOM elements', () => {
      panel.destroy();

      expect(document.querySelector('.timeline-preview-toggle')).toBeNull();
      expect(document.querySelector('.timeline-preview-panel')).toBeNull();
    });

    it('can be called multiple times safely', () => {
      panel.destroy();
      expect(() => panel.destroy()).not.toThrow();
    });
  });

  describe('resize debounce', () => {
    it('coalesces a resize burst into a single reposition', () => {
      vi.useFakeTimers();
      try {
        const spy = vi.spyOn(panel as unknown as { positionToggle: () => void }, 'positionToggle');

        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('resize'));
        expect(spy).not.toHaveBeenCalled();

        vi.advanceTimersByTime(200);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancels a pending resize reposition on destroy', () => {
      vi.useFakeTimers();
      try {
        const spy = vi.spyOn(panel as unknown as { positionToggle: () => void }, 'positionToggle');

        window.dispatchEvent(new Event('resize'));
        panel.destroy();
        vi.advanceTimersByTime(200);

        expect(spy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
