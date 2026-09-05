import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineMarkerInteractions } from '../TimelineMarkerInteractions';
import { TimelineTooltip } from '../TimelineTooltip';
import type { DotElement, MarkerLevel } from '../types';

vi.mock('@/utils/i18n', () => ({ getTranslationSync: (key: string) => key }));

describe('TimelineMarkerInteractions', () => {
  let interactions: TimelineMarkerInteractions;
  let tooltip: TimelineTooltip;
  let bar: HTMLElement;
  let dot: DotElement;
  let hierarchy: { level: MarkerLevel; collapsed: boolean; canCollapse: boolean } | null;
  const navigate = vi.fn();
  const toggleStar = vi.fn();
  const setLevel = vi.fn();
  const toggleCollapse = vi.fn();

  function createDot(id: string, index?: number): DotElement {
    const element = document.createElement('button') as DotElement;
    element.className = 'timeline-dot';
    element.dataset.targetTurnId = id;
    if (index !== undefined) element.dataset.markerIndex = String(index);
    element.innerHTML = '<span class="marker-content">Turn</span>';
    bar.appendChild(element);
    return element;
  }

  function pointer(target: EventTarget, type: string, x = 10, y = 10, button = 0): void {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button }));
  }

  function openMenu(target = dot, x = 10, y = 10): MouseEvent {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    });
    target.dispatchEvent(event);
    return event;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    bar = document.createElement('div');
    bar.className = 'gemini-timeline-bar';
    document.body.appendChild(bar);
    dot = createDot('s-first', 0);
    hierarchy = { level: 2, collapsed: false, canCollapse: false };
    tooltip = new TimelineTooltip(bar, {
      getContext: () => ({ style: 'dots', previewOpen: false }),
      getContent: (marker) => ({
        text: marker.dataset.targetTurnId!,
        summary: '',
        assistantSummary: '',
        starred: false,
      }),
    });
    interactions = new TimelineMarkerInteractions(bar, tooltip, {
      navigate,
      toggleStar,
      getHierarchy: () => hierarchy,
      setLevel,
      toggleCollapse,
    });
  });

  afterEach(() => {
    interactions.destroy();
    tooltip.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('passes marker identity and index from child clicks without resolving navigation itself', () => {
    dot.querySelector<HTMLElement>('span')!.click();
    createDot('s-second').click();
    bar.click();

    expect(navigate.mock.calls).toEqual([
      [0, 's-first'],
      [undefined, 's-second'],
    ]);
  });

  it('shows after a sustained hover and cancels a quick pointer pass', () => {
    dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(100);
    dot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    vi.advanceTimersByTime(300);
    const tip = document.querySelector('#gemini-timeline-tooltip')!;
    expect(tip.textContent).toBe('');

    dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(250);
    vi.advanceTimersToNextFrame();
    expect(tip.textContent).toBe('s-first');
    expect(tip.classList.contains('visible')).toBe(true);
  });

  it('keeps the hover intent while moving within a marker and replaces it between markers', () => {
    dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(150);
    const child = dot.querySelector<HTMLElement>('span')!;
    dot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: child }));
    child.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(100);
    expect(document.querySelector('#gemini-timeline-tooltip')?.textContent).toBe('s-first');

    const second = createDot('s-second', 1);
    dot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: second }));
    second.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(250);
    expect(document.querySelector('#gemini-timeline-tooltip')?.textContent).toBe('s-second');
  });

  it('stars after a long press and suppresses the following click for 350 ms', () => {
    pointer(dot, 'pointerdown');
    expect(dot.classList.contains('holding')).toBe(true);
    vi.advanceTimersByTime(549);
    expect(toggleStar).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(toggleStar).toHaveBeenCalledExactlyOnceWith('s-first');
    expect(dot.classList.contains('holding')).toBe(false);
    pointer(window, 'pointerup');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    dot.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(navigate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(350);
    dot.click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(0, 's-first');
  });

  it.each(['pointerup', 'pointercancel', 'pointerleave', 'movement'])(
    'cancels a pending long press on %s',
    (reason) => {
      pointer(dot, 'pointerdown');
      vi.advanceTimersByTime(300);
      if (reason === 'movement') pointer(window, 'pointermove', 17, 10);
      else pointer(reason === 'pointerleave' ? dot : window, reason);
      vi.advanceTimersByTime(600);

      expect(toggleStar).not.toHaveBeenCalled();
      expect(dot.classList.contains('holding')).toBe(false);
      dot.click();
      expect(navigate).toHaveBeenCalledOnce();
    },
  );

  it('allows small pointer movement and replaces a press when another marker is pressed', () => {
    pointer(dot, 'pointerdown');
    pointer(window, 'pointermove', 16, 10);
    vi.advanceTimersByTime(300);
    const second = createDot('s-second', 1);
    pointer(second, 'pointerdown');
    expect(dot.classList.contains('holding')).toBe(false);
    vi.advanceTimersByTime(550);

    expect(toggleStar).toHaveBeenCalledExactlyOnceWith('s-second');
  });

  it('ignores a non-primary press and leaves native context menus available when levels are off', () => {
    hierarchy = null;
    pointer(dot, 'pointerdown', 10, 10, 2);
    const event = openMenu();
    vi.advanceTimersByTime(600);

    expect(toggleStar).not.toHaveBeenCalled();
    expect(dot.classList.contains('holding')).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('.timeline-context-menu')).toBeNull();
  });

  it.each([1, 2, 3])(
    'selects level %s through a focusable menu button and closes the menu',
    (level) => {
      expect(openMenu().defaultPrevented).toBe(true);
      const menu = document.querySelector('.timeline-context-menu')!;
      expect(menu.querySelectorAll('button')).toHaveLength(3);
      expect(menu.querySelector('.active')?.getAttribute('data-level')).toBe('2');
      expect(menu.querySelector('.check-icon')?.textContent).toBe('✓');
      const button = menu.querySelector<HTMLButtonElement>(`button[data-level="${level}"]`)!;
      button.focus();
      expect(document.activeElement).toBe(button);
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));

      expect(setLevel).toHaveBeenCalledExactlyOnceWith('s-first', level);
      expect(toggleCollapse).not.toHaveBeenCalled();
      expect(document.querySelector('.timeline-context-menu')).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it.each([
    [true, false, 'timelineCollapse'],
    [false, true, 'timelineExpand'],
  ])(
    'offers the correct collapse action for canCollapse=%s collapsed=%s',
    (canCollapse, collapsed, label) => {
      hierarchy = { level: 2, canCollapse, collapsed };
      openMenu();
      const button = document.querySelector<HTMLButtonElement>('.collapse-item')!;
      expect(button.textContent).toContain(label);
      expect(document.querySelector('.timeline-context-menu-separator')).not.toBeNull();
      button.querySelector<HTMLElement>('span')!.click();

      expect(toggleCollapse).toHaveBeenCalledExactlyOnceWith('s-first');
      expect(setLevel).not.toHaveBeenCalled();
      expect(document.querySelector('.timeline-context-menu')).toBeNull();
    },
  );

  it('closes on outside click and makes a replaced menu inert', () => {
    openMenu();
    const previous = document.querySelector<HTMLButtonElement>('[data-level="1"]')!;
    openMenu(createDot('s-second', 1));
    previous.click();
    expect(setLevel).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('[data-level="3"]')!.click();
    expect(setLevel).toHaveBeenCalledExactlyOnceWith('s-second', 3);

    openMenu();
    document.body.click();
    expect(document.querySelector('.timeline-context-menu')).toBeNull();
  });

  it('cancels a pending long press and all marker/menu listeners on destroy', () => {
    openMenu();
    const oldButton = document.querySelector<HTMLButtonElement>('[data-level="1"]')!;
    pointer(dot, 'pointerdown');
    dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    interactions.destroy();
    vi.advanceTimersByTime(1000);
    oldButton.click();
    dot.click();
    pointer(dot, 'pointerdown');
    const event = openMenu();
    vi.advanceTimersByTime(600);

    expect(toggleStar).not.toHaveBeenCalled();
    expect(setLevel).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(dot.classList.contains('holding')).toBe(false);
    expect(document.querySelector('.timeline-context-menu')).toBeNull();
    expect(document.querySelector('#gemini-timeline-tooltip')?.classList.contains('visible')).toBe(
      false,
    );
  });
});
