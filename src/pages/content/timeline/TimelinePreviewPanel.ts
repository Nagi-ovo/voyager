import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';
import { GV_RTL_CLASS, detectRTL } from '@/core/utils/rtl';

import { getTranslationSync } from '../../../utils/i18n';
import type { PreviewMarkerData } from './types';

const SEARCH_DEBOUNCE_MS = 200;
const RESIZE_DEBOUNCE_MS = 120;
const COMPACT_CLOSE_DELAY_MS = 160;
const LONG_PRESS_DURATION_MS = 550;
const LONG_PRESS_MOVE_TOLERANCE_PX = 6;
const LONG_PRESS_CLICK_SUPPRESSION_MS = 350;

const LIST_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;

export class TimelinePreviewPanel {
  private panelEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private toggleBtn: HTMLElement | null = null;
  private _isOpen = false;
  private _isPinned = false;
  private _isCompactMode = false;
  private markers: ReadonlyArray<PreviewMarkerData> = [];
  private filteredMarkers: ReadonlyArray<PreviewMarkerData> = [];
  private activeTurnId: string | null = null;
  private searchQuery = '';
  private searchDebounceTimer: number | null = null;
  private resizeDebounceTimer: number | null = null;
  private compactCloseTimer: number | null = null;
  private onNavigate: ((turnId: string, index: number) => void) | null = null;
  private onSearchChange: ((query: string) => void) | null = null;
  private onToggleStar: ((turnId: string) => void | Promise<void>) | null = null;
  private pressTargetItem: HTMLElement | null = null;
  private pressStartPosition: { x: number; y: number } | null = null;
  private longPressTimer: number | null = null;
  private longPressTriggeredTurnId: string | null = null;
  private suppressClickUntil = 0;
  private suppressClickTurnId: string | null = null;
  private onListPointerDown: ((event: PointerEvent) => void) | null = null;
  private onListPointerLeave: (() => void) | null = null;
  private onWindowPointerMove: ((event: PointerEvent) => void) | null = null;
  private onWindowPointerUp: (() => void) | null = null;
  private onWindowPointerCancel: (() => void) | null = null;
  private onDocumentPointerDown: ((e: PointerEvent) => void) | null = null;
  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private onWindowResize: (() => void) | null = null;
  private onAnchorMouseEnter: (() => void) | null = null;
  private onAnchorMouseLeave: (() => void) | null = null;
  private onPanelMouseEnter: (() => void) | null = null;
  private onPanelMouseLeave: (() => void) | null = null;
  private onAnchorFocusIn: (() => void) | null = null;
  private onAnchorFocusOut: (() => void) | null = null;
  private onAnchorKeyDown: ((event: KeyboardEvent) => void) | null = null;
  private onAnchorPointerDown: (() => void) | null = null;
  private onAnchorClick: ((event: MouseEvent) => void) | null = null;
  private anchorWasOpenOnPointerDown: boolean | null = null;
  private onStorageChanged:
    | ((changes: Record<string, browser.Storage.StorageChange>, areaName: string) => void)
    | null = null;

  constructor(private readonly anchorElement: HTMLElement) {}

  get isOpen(): boolean {
    return this._isOpen;
  }

  get isPinned(): boolean {
    return this._isPinned;
  }

  init(
    onNavigate: (turnId: string, index: number) => void,
    onSearchChange?: (query: string) => void,
    onToggleStar?: (turnId: string) => void | Promise<void>,
  ): void {
    this.onNavigate = onNavigate;
    this.onSearchChange = onSearchChange ?? null;
    this.onToggleStar = onToggleStar ?? null;
    this.createDOM();
    this.applyDirection();
    this.positionToggle();
    this.setupEventListeners();
  }

  updateMarkers(markers: ReadonlyArray<PreviewMarkerData>): void {
    if (this.markersEqual(markers)) return;
    this.markers = markers;
    this.applyFilter();
  }

  updateActiveTurn(turnId: string | null): void {
    if (this.activeTurnId === turnId) return;
    this.activeTurnId = turnId;
    if (!this._isOpen || !this.listEl) return;
    this.updateActiveHighlight();
    this.scrollActiveIntoView();
  }

  /** Reposition toggle and panel after layout changes (e.g. RTL switch, resize). */
  reposition(): void {
    this.applyDirection();
    this.positionToggle();
    if (this._isOpen) this.positionPanel();
  }

  setPinned(pinned: boolean): void {
    if (this._isPinned === pinned) return;
    this._isPinned = pinned;
  }

  setCompactMode(compact: boolean): void {
    if (this._isCompactMode === compact) return;
    this._isCompactMode = compact;
    this.cancelCompactClose();
    this.toggleBtn?.classList.toggle('timeline-preview-toggle-compact', compact);
    this.panelEl?.classList.toggle('timeline-preview-panel-compact', compact);

    if (compact) {
      this.anchorElement.tabIndex = 0;
      this.anchorElement.setAttribute('role', 'button');
      this.anchorElement.setAttribute(
        'aria-label',
        getTranslationSync('timelineCompactOpenPreview'),
      );
      this.anchorElement.setAttribute('aria-expanded', this._isOpen ? 'true' : 'false');
    } else {
      this.anchorElement.removeAttribute('tabindex');
      this.anchorElement.removeAttribute('role');
      this.anchorElement.removeAttribute('aria-label');
      this.anchorElement.removeAttribute('aria-expanded');
      if (this._isOpen && !this._isPinned) this.close();
    }
  }

  toggle(): void {
    if (this._isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open(): void {
    if (this._isOpen || !this.panelEl) return;
    this._isOpen = true;
    this.renderList();
    this.positionPanel();
    this.panelEl.classList.add('visible');
    this.toggleBtn?.classList.add('active');
    this.toggleBtn?.setAttribute('aria-pressed', 'true');
    if (this._isCompactMode) this.anchorElement.setAttribute('aria-expanded', 'true');
    this.scrollActiveIntoView();
  }

  close(): void {
    if (!this._isOpen || !this.panelEl) return;
    this.cancelLongPress();
    this.longPressTriggeredTurnId = null;
    this.suppressClickTurnId = null;
    this.suppressClickUntil = 0;
    this._isOpen = false;
    this.panelEl.classList.remove('visible');
    this.toggleBtn?.classList.remove('active');
    this.toggleBtn?.setAttribute('aria-pressed', 'false');
    if (this._isCompactMode) this.anchorElement.setAttribute('aria-expanded', 'false');
    if (this.searchInput) {
      this.searchInput.value = '';
      this.searchQuery = '';
      this.filteredMarkers = this.markers;
    }
    this.onSearchChange?.('');
  }

  destroy(): void {
    this.cancelLongPress();
    this.longPressTriggeredTurnId = null;
    this.suppressClickTurnId = null;
    this.suppressClickUntil = 0;
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    if (this.resizeDebounceTimer !== null) {
      clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }
    this.cancelCompactClose();
    if (this.onDocumentPointerDown) {
      document.removeEventListener('pointerdown', this.onDocumentPointerDown);
      this.onDocumentPointerDown = null;
    }
    if (this.onKeyDown) {
      document.removeEventListener('keydown', this.onKeyDown);
      this.onKeyDown = null;
    }
    if (this.onWindowResize) {
      window.removeEventListener('resize', this.onWindowResize);
      this.onWindowResize = null;
    }
    if (this.onListPointerDown) {
      this.listEl?.removeEventListener('pointerdown', this.onListPointerDown);
      this.onListPointerDown = null;
    }
    if (this.onListPointerLeave) {
      this.listEl?.removeEventListener('pointerleave', this.onListPointerLeave);
      this.onListPointerLeave = null;
    }
    if (this.onWindowPointerMove) {
      window.removeEventListener('pointermove', this.onWindowPointerMove);
      this.onWindowPointerMove = null;
    }
    if (this.onWindowPointerUp) {
      window.removeEventListener('pointerup', this.onWindowPointerUp);
      this.onWindowPointerUp = null;
    }
    if (this.onWindowPointerCancel) {
      window.removeEventListener('pointercancel', this.onWindowPointerCancel);
      this.onWindowPointerCancel = null;
    }
    if (this.onAnchorMouseEnter) {
      this.anchorElement.removeEventListener('mouseenter', this.onAnchorMouseEnter);
      this.onAnchorMouseEnter = null;
    }
    if (this.onAnchorMouseLeave) {
      this.anchorElement.removeEventListener('mouseleave', this.onAnchorMouseLeave);
      this.onAnchorMouseLeave = null;
    }
    if (this.onPanelMouseEnter && this.panelEl) {
      this.panelEl.removeEventListener('mouseenter', this.onPanelMouseEnter);
      this.onPanelMouseEnter = null;
    }
    if (this.onPanelMouseLeave && this.panelEl) {
      this.panelEl.removeEventListener('mouseleave', this.onPanelMouseLeave);
      this.onPanelMouseLeave = null;
    }
    if (this.onAnchorFocusIn) {
      this.anchorElement.removeEventListener('focusin', this.onAnchorFocusIn);
      this.onAnchorFocusIn = null;
    }
    if (this.onAnchorFocusOut) {
      this.anchorElement.removeEventListener('focusout', this.onAnchorFocusOut);
      this.onAnchorFocusOut = null;
    }
    if (this.onAnchorKeyDown) {
      this.anchorElement.removeEventListener('keydown', this.onAnchorKeyDown);
      this.onAnchorKeyDown = null;
    }
    if (this.onAnchorPointerDown) {
      this.anchorElement.removeEventListener('pointerdown', this.onAnchorPointerDown);
      this.onAnchorPointerDown = null;
    }
    if (this.onAnchorClick) {
      this.anchorElement.removeEventListener('click', this.onAnchorClick);
      this.onAnchorClick = null;
    }
    this.anchorWasOpenOnPointerDown = null;
    if (this.onStorageChanged) {
      browser.storage.onChanged.removeListener(this.onStorageChanged);
      this.onStorageChanged = null;
    }
    this.toggleBtn?.remove();
    this.panelEl?.remove();
    this.toggleBtn = null;
    this.panelEl = null;
    this.listEl = null;
    this.searchInput = null;
    this.onSearchChange?.('');
    this.onNavigate = null;
    this.onSearchChange = null;
    this.onToggleStar = null;
    this.markers = [];
    this.filteredMarkers = [];
    this.anchorElement.removeAttribute('tabindex');
    this.anchorElement.removeAttribute('role');
    this.anchorElement.removeAttribute('aria-label');
    this.anchorElement.removeAttribute('aria-expanded');
  }

  private createDOM(): void {
    // Toggle button — fixed position to the left of the timeline bar
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'timeline-preview-toggle';
    this.toggleBtn.setAttribute('aria-label', 'Toggle preview panel');
    this.toggleBtn.setAttribute('aria-pressed', 'false');
    this.toggleBtn.innerHTML = LIST_ICON_SVG;
    this.toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    document.body.appendChild(this.toggleBtn);

    // Panel
    this.panelEl = document.createElement('div');
    this.panelEl.className = 'timeline-preview-panel';

    // Search section
    const searchWrapper = document.createElement('div');
    searchWrapper.className = 'timeline-preview-search';
    this.searchInput = document.createElement('input');
    this.searchInput.type = 'text';
    this.searchInput.setAttribute('dir', 'auto');
    this.searchInput.placeholder = getTranslationSync('timelinePreviewSearch');
    this.searchInput.addEventListener('input', () => {
      this.handleSearchInput();
    });
    searchWrapper.appendChild(this.searchInput);
    this.panelEl.appendChild(searchWrapper);

    // List
    this.listEl = document.createElement('div');
    this.listEl.className = 'timeline-preview-list';
    this.setupScrollIsolation();
    this.panelEl.appendChild(this.listEl);

    document.body.appendChild(this.panelEl);
  }

  private setupEventListeners(): void {
    // Click outside to close
    this.onDocumentPointerDown = (e: PointerEvent) => {
      if (!this._isOpen) return;
      if (this._isPinned) return;
      const target = e.target as Node;
      if (
        this.panelEl?.contains(target) ||
        this.toggleBtn?.contains(target) ||
        this.anchorElement.contains(target)
      )
        return;
      this.close();
    };
    document.addEventListener('pointerdown', this.onDocumentPointerDown);

    // Escape to close
    this.onKeyDown = (e: KeyboardEvent) => {
      if (!this._isOpen) return;
      if (this._isPinned) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    };
    document.addEventListener('keydown', this.onKeyDown);

    this.onListPointerDown = (event: PointerEvent) => {
      if (!this.onToggleStar || event.isPrimary === false) return;
      if (typeof event.button === 'number' && event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const item = target.closest<HTMLElement>('.timeline-preview-item');
      if (!item || !this.listEl?.contains(item)) return;

      this.cancelLongPress();
      this.longPressTriggeredTurnId = null;
      this.pressTargetItem = item;
      this.pressStartPosition = { x: event.clientX, y: event.clientY };
      item.classList.add('holding');
      this.longPressTimer = window.setTimeout(() => {
        const pressedItem = this.pressTargetItem;
        const turnId = pressedItem?.dataset.turnId;
        this.longPressTimer = null;
        this.pressTargetItem = null;
        this.pressStartPosition = null;
        pressedItem?.classList.remove('holding');
        if (!turnId || !this.onToggleStar) return;

        this.longPressTriggeredTurnId = turnId;
        try {
          void Promise.resolve(this.onToggleStar(turnId)).catch((error) => {
            console.error('[TimelinePreviewPanel] Failed to toggle star:', error);
          });
        } catch (error) {
          console.error('[TimelinePreviewPanel] Failed to toggle star:', error);
        }
      }, LONG_PRESS_DURATION_MS);
    };
    this.onListPointerLeave = () => this.cancelLongPress();
    this.onWindowPointerMove = (event: PointerEvent) => {
      if (!this.pressTargetItem || !this.pressStartPosition) return;
      const dx = event.clientX - this.pressStartPosition.x;
      const dy = event.clientY - this.pressStartPosition.y;
      if (dx * dx + dy * dy > LONG_PRESS_MOVE_TOLERANCE_PX * LONG_PRESS_MOVE_TOLERANCE_PX) {
        this.cancelLongPress();
      }
    };
    this.onWindowPointerUp = () => {
      if (this.longPressTriggeredTurnId) {
        this.suppressClickTurnId = this.longPressTriggeredTurnId;
        this.suppressClickUntil = Date.now() + LONG_PRESS_CLICK_SUPPRESSION_MS;
        this.longPressTriggeredTurnId = null;
      }
      this.cancelLongPress();
    };
    this.onWindowPointerCancel = () => {
      this.longPressTriggeredTurnId = null;
      this.cancelLongPress();
    };
    this.listEl?.addEventListener('pointerdown', this.onListPointerDown);
    this.listEl?.addEventListener('pointerleave', this.onListPointerLeave);
    window.addEventListener('pointermove', this.onWindowPointerMove, { passive: true });
    window.addEventListener('pointerup', this.onWindowPointerUp, { passive: true });
    window.addEventListener('pointercancel', this.onWindowPointerCancel, { passive: true });

    // Reposition on resize (debounced: positionPanel reads offsetHeight after
    // writing styles, which forces layout — avoid doing that per resize event)
    this.onWindowResize = () => {
      if (this.resizeDebounceTimer !== null) clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = window.setTimeout(() => {
        this.resizeDebounceTimer = null;
        this.positionToggle();
        if (this._isOpen) this.positionPanel();
      }, RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener('resize', this.onWindowResize);

    this.onAnchorMouseEnter = () => {
      if (!this._isCompactMode) return;
      this.cancelCompactClose();
      this.open();
    };
    this.onAnchorMouseLeave = () => this.scheduleCompactClose();
    this.onPanelMouseEnter = () => {
      if (!this._isCompactMode) return;
      this.cancelCompactClose();
    };
    this.onPanelMouseLeave = () => this.scheduleCompactClose();
    this.onAnchorFocusIn = () => {
      if (!this._isCompactMode) return;
      this.cancelCompactClose();
      this.open();
    };
    this.onAnchorFocusOut = () => this.scheduleCompactClose();
    this.onAnchorKeyDown = (event: KeyboardEvent) => {
      if (!this._isCompactMode || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      event.stopPropagation();
      this.toggle();
    };
    this.onAnchorPointerDown = () => {
      if (!this._isCompactMode) return;
      // Pointer focus can open the panel before the subsequent click fires.
      // Preserve the pre-click state so a closed rail still opens on touch.
      this.anchorWasOpenOnPointerDown = this._isOpen;
    };
    this.onAnchorClick = (event: MouseEvent) => {
      if (!this._isCompactMode) return;
      event.stopPropagation();
      const wasOpen = this.anchorWasOpenOnPointerDown ?? this._isOpen;
      this.anchorWasOpenOnPointerDown = null;
      if (wasOpen) this.close();
      else this.open();
    };
    this.anchorElement.addEventListener('mouseenter', this.onAnchorMouseEnter);
    this.anchorElement.addEventListener('mouseleave', this.onAnchorMouseLeave);
    this.panelEl?.addEventListener('mouseenter', this.onPanelMouseEnter);
    this.panelEl?.addEventListener('mouseleave', this.onPanelMouseLeave);
    this.anchorElement.addEventListener('focusin', this.onAnchorFocusIn);
    this.anchorElement.addEventListener('focusout', this.onAnchorFocusOut);
    this.anchorElement.addEventListener('keydown', this.onAnchorKeyDown);
    this.anchorElement.addEventListener('pointerdown', this.onAnchorPointerDown);
    this.anchorElement.addEventListener('click', this.onAnchorClick);

    // Re-render translated text on language change
    this.onStorageChanged = (changes, areaName) => {
      if ((areaName === 'sync' || areaName === 'local') && changes[StorageKeys.LANGUAGE]) {
        this.updateTranslatedText();
      }
    };
    browser.storage.onChanged.addListener(this.onStorageChanged);
  }

  private updateTranslatedText(): void {
    this.applyDirection();
    if (this.searchInput) {
      this.searchInput.placeholder = getTranslationSync('timelinePreviewSearch');
    }
    if (this._isCompactMode) {
      this.anchorElement.setAttribute(
        'aria-label',
        getTranslationSync('timelineCompactOpenPreview'),
      );
    }
    if (this._isOpen) {
      this.renderList();
    }
  }

  private scheduleCompactClose(): void {
    if (!this._isCompactMode || this._isPinned) return;
    this.cancelCompactClose();
    this.compactCloseTimer = window.setTimeout(() => {
      this.compactCloseTimer = null;
      if (!this._isCompactMode || this._isPinned) return;
      this.close();
    }, COMPACT_CLOSE_DELAY_MS);
  }

  private cancelCompactClose(): void {
    if (this.compactCloseTimer === null) return;
    clearTimeout(this.compactCloseTimer);
    this.compactCloseTimer = null;
  }

  private isRTLContext(): boolean {
    return document.body.classList.contains(GV_RTL_CLASS) || detectRTL();
  }

  private applyDirection(): void {
    const dir = this.isRTLContext() ? 'rtl' : 'ltr';
    this.panelEl?.setAttribute('dir', dir);
    this.listEl?.setAttribute('dir', dir);
    this.toggleBtn?.setAttribute('dir', dir);
  }

  private setupScrollIsolation(): void {
    if (!this.listEl) return;

    this.listEl.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        e.stopPropagation();
        const { scrollTop, scrollHeight, clientHeight } = this.listEl!;
        const atTop = scrollTop <= 0 && e.deltaY < 0;
        const atBottom = scrollTop + clientHeight >= scrollHeight - 1 && e.deltaY > 0;
        if (atTop || atBottom) {
          e.preventDefault();
        }
      },
      { passive: false },
    );
  }

  /** Position the toggle button beside the timeline bar, vertically centered.
   *  Keep it on the bar's left side and clamp within viewport bounds. */
  private positionToggle(): void {
    if (!this.toggleBtn) return;
    const barRect = this.anchorElement.getBoundingClientRect();
    const btnSize = 24;
    const gap = 4;
    const minLeft = 8;
    const maxLeft = Math.max(minLeft, window.innerWidth - btnSize - 8);
    const leftPx = Math.max(minLeft, Math.min(Math.round(barRect.left - btnSize - gap), maxLeft));
    this.toggleBtn.style.left = `${leftPx}px`;
    this.toggleBtn.style.top = `${Math.round(barRect.top + barRect.height / 2 - btnSize / 2)}px`;
  }

  private positionPanel(): void {
    if (!this.panelEl) return;
    const barRect = this.anchorElement.getBoundingClientRect();
    const panelWidth = 320;
    const gap = 12;
    const maxHeight = this._isCompactMode
      ? Math.min(700, window.innerHeight * 0.82)
      : Math.min(500, window.innerHeight * 0.7);
    const barCenterY = barRect.top + barRect.height / 2;
    const isRTL = this.isRTLContext();

    let left: number;
    if (isRTL) {
      // In RTL, bar is on the left — place panel to its right
      left = barRect.right + gap;
      if (left + panelWidth > window.innerWidth - 8) {
        left = window.innerWidth - panelWidth - 8;
      }
    } else {
      // In LTR, bar is on the right — place panel to its left
      left = barRect.left - panelWidth - gap;
      if (left < 8) left = 8;
    }

    this.panelEl.style.maxHeight = `${Math.round(maxHeight)}px`;
    this.panelEl.style.left = `${Math.round(left)}px`;

    // Measure actual rendered height to center properly (works for both few and many items)
    const panelHeight = this.panelEl.offsetHeight || maxHeight;
    let top = barCenterY - panelHeight / 2;
    top = Math.max(8, Math.min(top, window.innerHeight - panelHeight - 8));

    this.panelEl.style.top = `${Math.round(top)}px`;
  }

  private applyFilter(): void {
    if (!this.searchQuery) {
      this.filteredMarkers = this.markers;
    } else {
      const q = this.searchQuery.toLowerCase();
      this.filteredMarkers = this.markers.filter((m) => m.summary.toLowerCase().includes(q));
    }
    if (this._isOpen) {
      this.renderList();
      // Lazy-loaded history can grow the list after the panel has already been
      // positioned. Re-measure it so the old top offset cannot push the newly
      // taller panel below the viewport.
      this.positionPanel();
    }
    this.onSearchChange?.(this.searchQuery);
  }

  private handleSearchInput(): void {
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    this.searchDebounceTimer = window.setTimeout(() => {
      this.searchDebounceTimer = null;
      this.searchQuery = this.searchInput?.value.trim() ?? '';
      this.applyFilter();
    }, SEARCH_DEBOUNCE_MS);
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.cancelLongPress();
    this.listEl.textContent = '';

    if (this.filteredMarkers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'timeline-preview-empty';
      empty.textContent = this.searchQuery
        ? getTranslationSync('timelinePreviewNoResults')
        : getTranslationSync('timelinePreviewNoMessages');
      this.listEl.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const marker of this.filteredMarkers) {
      fragment.appendChild(this.createItem(marker));
    }
    this.listEl.appendChild(fragment);
  }

  private createItem(marker: PreviewMarkerData): HTMLElement {
    const item = document.createElement('div');
    item.className = 'timeline-preview-item';
    item.dataset.turnId = marker.id;

    if (marker.starred) {
      item.classList.add('starred');
    }
    if (marker.id === this.activeTurnId) {
      item.classList.add('active');
    }

    const indexLabel = document.createElement('span');
    indexLabel.className = 'timeline-preview-index';
    indexLabel.textContent = `${marker.index + 1}`;
    item.appendChild(indexLabel);

    const text = document.createElement('span');
    text.className = 'timeline-preview-text';
    text.setAttribute('dir', 'auto');
    const displayText = this.truncateText(marker.summary, 80);
    if (this.searchQuery) {
      this.appendHighlighted(text, displayText, this.searchQuery);
    } else {
      text.textContent = displayText;
    }
    item.appendChild(text);

    item.addEventListener('click', (event) => {
      if (this.suppressClickTurnId === marker.id && Date.now() < this.suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        this.suppressClickTurnId = null;
        this.suppressClickUntil = 0;
        return;
      }
      this.onNavigate?.(marker.id, marker.index);
    });

    return item;
  }

  private cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.pressTargetItem?.classList.remove('holding');
    this.pressTargetItem = null;
    this.pressStartPosition = null;
  }

  /** Split text around case-insensitive query matches and wrap each match in <mark>. */
  private appendHighlighted(container: HTMLElement, text: string, query: string): void {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let cursor = 0;
    let idx = lowerText.indexOf(lowerQuery, cursor);
    while (idx !== -1) {
      if (idx > cursor) {
        container.appendChild(document.createTextNode(text.slice(cursor, idx)));
      }
      const mark = document.createElement('mark');
      mark.className = 'timeline-preview-highlight';
      mark.textContent = text.slice(idx, idx + query.length);
      container.appendChild(mark);
      cursor = idx + query.length;
      idx = lowerText.indexOf(lowerQuery, cursor);
    }
    if (cursor < text.length) {
      container.appendChild(document.createTextNode(text.slice(cursor)));
    }
  }

  private truncateText(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1) + '\u2026';
  }

  private updateActiveHighlight(): void {
    if (!this.listEl) return;
    const items = this.listEl.querySelectorAll('.timeline-preview-item');
    items.forEach((item) => {
      const el = item as HTMLElement;
      el.classList.toggle('active', el.dataset.turnId === this.activeTurnId);
    });
  }

  private scrollActiveIntoView(): void {
    if (!this.listEl || !this.activeTurnId) return;
    const activeItem = this.listEl.querySelector(
      '.timeline-preview-item.active',
    ) as HTMLElement | null;
    activeItem?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }

  private markersEqual(newMarkers: ReadonlyArray<PreviewMarkerData>): boolean {
    if (newMarkers.length !== this.markers.length) return false;
    for (let i = 0; i < newMarkers.length; i++) {
      const a = this.markers[i];
      const b = newMarkers[i];
      if (a.id !== b.id || a.summary !== b.summary || a.starred !== b.starred) return false;
    }
    return true;
  }
}
