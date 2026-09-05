import { getTranslationSync } from '@/utils/i18n';

import { TimelineTooltip } from './TimelineTooltip';
import type { DotElement, MarkerLevel } from './types';

interface MarkerHierarchyState {
  level: MarkerLevel;
  collapsed: boolean;
  canCollapse: boolean;
}

interface TimelineMarkerInteractionOptions {
  navigate(index: number | undefined, turnId: string): void;
  toggleStar(turnId: string): void;
  getHierarchy(turnId: string): MarkerHierarchyState | null;
  setLevel(turnId: string, level: MarkerLevel): void;
  toggleCollapse(turnId: string): void;
}

/** Owns marker gestures and their menu for one mounted timeline bar. */
export class TimelineMarkerInteractions {
  private menu: { element: HTMLElement; turnId: string } | null = null;
  private pressTargetDot: DotElement | null = null;
  private pressStartPos: { x: number; y: number } | null = null;
  private longPressTimer: number | null = null;
  private suppressClickUntil = 0;
  private readonly longPressDuration = 550;
  private readonly longPressMoveTolerance = 6;

  constructor(
    private readonly bar: HTMLElement,
    private readonly tooltip: TimelineTooltip,
    private readonly options: TimelineMarkerInteractionOptions,
  ) {
    bar.addEventListener('click', this.onClick);
    bar.addEventListener('mouseover', this.onMouseOver);
    bar.addEventListener('mouseout', this.onMouseOut);
    bar.addEventListener('contextmenu', this.onContextMenu);
    bar.addEventListener('pointerdown', this.onPointerDown);
    bar.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
    window.addEventListener('pointerup', this.onPointerUp, { passive: true });
    window.addEventListener('pointercancel', this.onPointerUp, { passive: true });
    document.addEventListener('click', this.onDocumentClick);
  }

  destroy(): void {
    this.cancelLongPress();
    this.closeMenu();
    this.tooltip.hide(true);
    this.bar.removeEventListener('click', this.onClick);
    this.bar.removeEventListener('mouseover', this.onMouseOver);
    this.bar.removeEventListener('mouseout', this.onMouseOut);
    this.bar.removeEventListener('contextmenu', this.onContextMenu);
    this.bar.removeEventListener('pointerdown', this.onPointerDown);
    this.bar.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    document.removeEventListener('click', this.onDocumentClick);
  }

  closeMenu(): void {
    this.menu?.element.removeEventListener('click', this.onMenuClick);
    this.menu?.element.remove();
    this.menu = null;
  }

  private readonly onClick = (event: MouseEvent): void => {
    const dot = (event.target as HTMLElement).closest<DotElement>('.timeline-dot');
    if (!dot) return;
    if (Date.now() < this.suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const index = dot.dataset.markerIndex;
    this.options.navigate(index ? parseInt(index, 10) : undefined, dot.dataset.targetTurnId || '');
  };

  private readonly onMouseOver = (event: MouseEvent): void => {
    const dot = (event.target as HTMLElement).closest<DotElement>('.timeline-dot');
    if (dot) this.tooltip.schedule(dot);
  };

  private readonly onMouseOut = (event: MouseEvent): void => {
    const fromDot = (event.target as HTMLElement).closest('.timeline-dot');
    const toDot = (event.relatedTarget as HTMLElement | null)?.closest?.('.timeline-dot');
    if (fromDot && !toDot) {
      this.tooltip.cancelPending();
      if (!this.bar.querySelector('.timeline-dot:hover')) this.tooltip.hide();
    }
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    const dot = (event.target as HTMLElement).closest<DotElement>('.timeline-dot');
    const turnId = dot?.dataset.targetTurnId;
    if (!turnId) return;
    const state = this.options.getHierarchy(turnId);
    if (!state) return;
    event.preventDefault();
    event.stopPropagation();
    this.openMenu(turnId, state, event.clientX, event.clientY);
  };

  private readonly onDocumentClick = (event: MouseEvent): void => {
    if (this.menu && !this.menu.element.contains(event.target as Node)) this.closeMenu();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    const dot = (event.target as HTMLElement).closest<DotElement>('.timeline-dot');
    if (!dot || (typeof event.button === 'number' && event.button !== 0)) return;
    this.cancelLongPress();
    this.pressTargetDot = dot;
    this.pressStartPos = { x: event.clientX, y: event.clientY };
    dot.classList.add('holding');
    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = null;
      if (!this.pressTargetDot) return;
      this.options.toggleStar(this.pressTargetDot.dataset.targetTurnId!);
      this.suppressClickUntil = Date.now() + 350;
      this.tooltip.refresh(this.pressTargetDot);
      this.pressTargetDot.classList.remove('holding');
    }, this.longPressDuration);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.pressTargetDot || !this.pressStartPos) return;
    const dx = event.clientX - this.pressStartPos.x;
    const dy = event.clientY - this.pressStartPos.y;
    if (dx * dx + dy * dy > this.longPressMoveTolerance * this.longPressMoveTolerance)
      this.cancelLongPress();
  };

  private readonly onPointerUp = (): void => this.cancelLongPress();

  private readonly onPointerLeave = (event: PointerEvent): void => {
    const dot = (event.target as HTMLElement).closest<DotElement>('.timeline-dot');
    if (dot && dot === this.pressTargetDot) this.cancelLongPress();
  };

  private cancelLongPress(): void {
    if (this.longPressTimer !== null) clearTimeout(this.longPressTimer);
    this.longPressTimer = null;
    this.pressTargetDot?.classList.remove('holding');
    this.pressTargetDot = null;
    this.pressStartPos = null;
  }

  private readonly onMenuClick = (event: MouseEvent): void => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button || !this.menu) return;
    event.preventDefault();
    event.stopPropagation();
    if (button.dataset.level) {
      this.options.setLevel(this.menu.turnId, Number(button.dataset.level) as MarkerLevel);
    } else {
      this.options.toggleCollapse(this.menu.turnId);
    }
    this.closeMenu();
  };

  private openMenu(turnId: string, state: MarkerHierarchyState, x: number, y: number): void {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.className = 'timeline-context-menu';
    const title = document.createElement('div');
    title.className = 'timeline-context-menu-title';
    title.textContent = getTranslationSync('timelineLevelTitle');
    menu.appendChild(title);

    const levels: { level: MarkerLevel; label: string }[] = [
      { level: 1, label: getTranslationSync('timelineLevel1') },
      { level: 2, label: getTranslationSync('timelineLevel2') },
      { level: 3, label: getTranslationSync('timelineLevel3') },
    ];
    levels.forEach(({ level, label }) => {
      const item = document.createElement('button');
      item.className = 'timeline-context-menu-item';
      if (level === state.level) item.classList.add('active');
      item.setAttribute('data-level', String(level));

      const indicator = document.createElement('span');
      indicator.className = 'level-indicator';
      const dot = document.createElement('span');
      dot.className = 'level-dot';
      indicator.appendChild(dot);
      item.appendChild(indicator);
      const labelSpan = document.createElement('span');
      labelSpan.textContent = label;
      item.appendChild(labelSpan);
      if (level === state.level) {
        const check = document.createElement('span');
        check.className = 'check-icon';
        check.textContent = '✓';
        item.appendChild(check);
      }
      menu.appendChild(item);
    });

    if (state.canCollapse || state.collapsed) {
      const separator = document.createElement('div');
      separator.className = 'timeline-context-menu-separator';
      menu.appendChild(separator);
      const item = document.createElement('button');
      item.className = 'timeline-context-menu-item collapse-item';
      const icon = document.createElement('span');
      icon.className = 'collapse-icon';
      icon.textContent = state.collapsed ? '▶' : '▼';
      item.appendChild(icon);
      const label = document.createElement('span');
      label.textContent = state.collapsed
        ? getTranslationSync('timelineExpand')
        : getTranslationSync('timelineCollapse');
      item.appendChild(label);
      menu.appendChild(item);
    }

    menu.addEventListener('click', this.onMenuClick);
    document.body.appendChild(menu);
    this.menu = { element: menu, turnId };
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = x + width > window.innerWidth - 10 ? window.innerWidth - width - 10 : x;
    const top = y + height > window.innerHeight - 10 ? window.innerHeight - height - 10 : y;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }
}
