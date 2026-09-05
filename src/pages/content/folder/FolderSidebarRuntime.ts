import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';
import { getTranslationSyncUnsafe } from '@/utils/i18n';

import type { NativeConversationMenus } from './NativeConversationMenus';
import type { NativeSidebarObserver } from './NativeSidebarObserver';

export type FolderAnchor = 'above-recents' | 'above-notebooks';
export type FolderMountMode = 'sidebar' | 'floating';

export interface FolderSidebarRuntimeOptions {
  createPanel: () => HTMLElement;
  onPanelMount: (panel: HTMLElement, sidebar: HTMLElement) => void;
  onPanelUnmount: () => void;
  nativeSidebar: NativeSidebarObserver;
  nativeMenus: NativeConversationMenus;
  floating: {
    isOpen: () => boolean;
    open: (openPanel: boolean) => Promise<void>;
    close: () => void;
  };
}

const SIDEBAR_WAIT_TIMEOUT_MS = 10_000;
const SIDEBAR_WAIT_POLL_MS = 500;
const ANCHOR_MISSING_GRACE_MS = 6000;
const HIDDEN_PANEL_GRACE_MS = 1500;

/** Owns the folder panel's place in Gemini, including temporary floating fallback episodes. */
export class FolderSidebarRuntime {
  private sidebarElement: HTMLElement | null = null;
  private panelElement: HTMLElement | null = null;
  private anchorPreference: FolderAnchor = 'above-recents';
  private running = false;
  private mode: FolderMountMode = 'sidebar';
  private generation = 0;
  private mountPromise: Promise<void> | null = null;
  private remounting = false;
  private sidebarWaits = new Set<() => void>();
  private positionObserver: MutationObserver | null = null;
  private positionRaf: number | null = null;
  private visibilityObserver: MutationObserver | null = null;
  private notebooksButton: HTMLElement | null = null;
  private recoveryInterval: number | null = null;
  private recoveryDebounce: number | null = null;
  private recoveryHandler: (() => void) | null = null;
  private recoveryInFlight = false;
  private anchorMissingSince: number | null = null;
  private hiddenPanelSince: number | null = null;
  private fallbackActive = false;
  private floatingOpenPromise: Promise<void> | null = null;
  private floatingOpenPanel: boolean | null = null;

  constructor(private readonly options: FolderSidebarRuntimeOptions) {}

  get sidebar(): HTMLElement | null {
    return this.sidebarElement;
  }

  get panel(): HTMLElement | null {
    return this.panelElement;
  }

  get isFloatingMode(): boolean {
    return this.running && this.mode === 'floating';
  }

  get isFallbackActive(): boolean {
    return this.fallbackActive;
  }

  async loadAnchor(): Promise<void> {
    try {
      const raw = await browser.storage.local.get({
        [StorageKeys.FOLDERS_ANCHOR]: 'above-recents',
      });
      this.setAnchor(raw[StorageKeys.FOLDERS_ANCHOR]);
    } catch (error) {
      console.error('[FolderManager] Failed to load folder anchor preference:', error);
      this.setAnchor('above-recents');
    }
  }

  setAnchor(value: unknown): void {
    this.anchorPreference = value === 'above-notebooks' ? value : 'above-recents';
    this.refreshLanguage();
    this.enforcePosition();
  }

  async start(mode: FolderMountMode, openOnStart = true): Promise<void> {
    const wasRunning = this.running;
    const previousMode = this.mode;
    this.running = true;
    this.mode = mode;

    if (mode === 'floating') {
      if (wasRunning && previousMode === mode) return;
      this.invalidateMount();
      this.fallbackActive = false;
      this.anchorMissingSince = null;
      this.unmountPanel();
      this.startNativeMenus();
      const generation = this.generation;
      void this.waitForSidebar().then((sidebar) => {
        if (!sidebar || !this.isCurrent(generation) || this.mode !== 'floating') return;
        this.bindNativeSidebar(sidebar);
      });
      if (!openOnStart && this.options.floating.isOpen()) this.options.floating.close();
      await this.openFloating(openOnStart);
      return;
    }

    if (wasRunning && previousMode === 'floating') {
      this.invalidateMount();
      this.fallbackActive = false;
      this.options.floating.close();
    }
    this.ensureRecoveryWatchers();
    if (this.isMountedInCurrentSidebar()) {
      this.updateVisibility();
      return;
    }
    await this.mountPanel(wasRunning);
  }

  /** Rebind transient DOM resources while keeping native deletion tracking and recovery alive. */
  remount(): Promise<void> {
    return this.mountPanel(true);
  }

  private mountPanel(remounting: boolean): Promise<void> {
    if (!this.running || this.mode !== 'sidebar') return Promise.resolve();
    if (this.mountPromise) return this.mountPromise;
    const generation = this.generation;
    this.remounting = remounting;
    this.unmountPanel();
    this.ensureRecoveryWatchers();
    this.startNativeMenus();

    const operation = this.waitForSidebar()
      .then((sidebar) => {
        if (!sidebar || !this.isCurrent(generation) || this.mode !== 'sidebar') return;
        this.sidebarElement = sidebar;
        const anchor = this.findAnchor(sidebar);
        const parent = anchor?.parentElement;
        if (!anchor || !parent) return;

        // Gemini can clone a panel unknown to us. Remove only direct Gemini folder siblings.
        for (const sibling of Array.from(parent.children)) {
          if (
            sibling instanceof HTMLElement &&
            sibling.classList.contains('gv-folder-container') &&
            !sibling.classList.contains('gv-aistudio') &&
            !sibling.classList.contains('gv-multi-select-floating-host')
          ) {
            sibling.remove();
          }
        }
        const panel = this.options.createPanel();
        this.panelElement = panel;
        parent.insertBefore(panel, anchor);
        this.options.onPanelMount(panel, sidebar);
        this.bindNativeSidebar(sidebar);
        this.observePosition();
        this.ensureNotebooksButton();
        this.observeVisibility();
        this.updateVisibility();
      })
      .catch((error) => {
        console.error('[FolderManager] Failed to initialize folder sidebar:', error);
      })
      .finally(() => {
        if (this.mountPromise === operation) {
          this.mountPromise = null;
          this.remounting = false;
        }
      });
    this.mountPromise = operation;
    return operation;
  }

  /** Disable/destroy ends every mounted-runtime timer, observer and pending sidebar wait. */
  stop(): void {
    this.running = false;
    this.floatingOpenPanel = null;
    this.invalidateMount();
    this.teardownRecoveryWatchers();
    this.unmountPanel();
    this.options.nativeSidebar.stop();
    this.options.nativeMenus.stop();
    this.fallbackActive = false;
    this.anchorMissingSince = null;
    this.hiddenPanelSince = null;
    this.recoveryInFlight = false;
    this.options.floating.close();
  }

  private isCurrent(generation: number): boolean {
    return this.running && this.generation === generation;
  }

  private invalidateMount(): void {
    this.generation += 1;
    this.sidebarWaits.forEach((cancel) => cancel());
    this.sidebarWaits.clear();
    this.mountPromise = null;
    this.remounting = false;
  }

  private startNativeMenus(): void {
    this.options.nativeMenus.startTracking();
    this.options.nativeMenus.observePanels();
  }

  private bindNativeSidebar(sidebar: HTMLElement): void {
    this.sidebarElement = sidebar;
    this.options.nativeSidebar.enqueueConversations(sidebar.isConnected ? sidebar : document);
    this.options.nativeSidebar.observe(sidebar);
  }

  private unmountPanel(): void {
    this.options.onPanelUnmount();
    this.options.nativeSidebar.disconnect();
    this.options.nativeMenus.disconnectPanels();
    this.positionObserver?.disconnect();
    this.positionObserver = null;
    if (this.positionRaf !== null) window.cancelAnimationFrame(this.positionRaf);
    this.positionRaf = null;
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    this.cleanupNotebooksButton();
    this.panelElement?.remove();
    this.panelElement = null;
    this.sidebarElement = null;
  }

  private waitForSidebar(): Promise<HTMLElement | null> {
    try {
      if (localStorage.getItem('gv-force-folder-fail') === '1') return Promise.resolve(null);
    } catch {
      // Debug flag is optional when localStorage is unavailable.
    }
    return new Promise((resolve) => {
      const deadline = Date.now() + SIDEBAR_WAIT_TIMEOUT_MS;
      let timer: number | null = null;
      const finish = (sidebar: HTMLElement | null) => {
        if (timer !== null) window.clearTimeout(timer);
        this.sidebarWaits.delete(cancel);
        resolve(sidebar);
      };
      const cancel = () => finish(null);
      const check = () => {
        const sidebar = this.findSidebar();
        if (sidebar || Date.now() >= deadline || !this.running) {
          finish(sidebar);
        } else {
          timer = window.setTimeout(check, SIDEBAR_WAIT_POLL_MS);
        }
      };
      this.sidebarWaits.add(cancel);
      check();
    });
  }

  private findSidebar(): HTMLElement | null {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('[data-test-id="overflow-container"]'),
    );
    return (
      candidates.find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }) ??
      candidates[0] ??
      null
    );
  }

  private findNotebooks(sidebar = this.sidebarElement): HTMLElement | null {
    return (
      sidebar?.querySelector<HTMLElement>(
        'expandable-section[data-test-id="notebooks-expandable-section"]',
      ) ?? null
    );
  }

  private findAnchor(sidebar: HTMLElement): HTMLElement | null {
    if (this.anchorPreference === 'above-notebooks') {
      const notebooks = this.findNotebooks(sidebar);
      if (notebooks) return notebooks;
    }
    const promote = (element: Element | null): Element | null =>
      element ? (element.closest('expandable-section') ?? element) : null;
    const firstConversation = sidebar.querySelector('[data-test-id="conversation"]');
    const candidate =
      sidebar.querySelector('expandable-section[data-test-id="chats-expandable-section"]') ??
      promote(sidebar.querySelector('[data-test-id="all-conversations"]')) ??
      promote(sidebar.querySelector('.chat-history')) ??
      firstConversation?.closest('expandable-section') ??
      firstConversation?.closest('.chat-history, [class*="conversation"]');
    return candidate instanceof HTMLElement ? candidate : null;
  }

  private isMountedInCurrentSidebar(sidebar = this.findSidebar()): boolean {
    return !!(
      this.panelElement &&
      document.body.contains(this.panelElement) &&
      sidebar &&
      document.body.contains(sidebar) &&
      sidebar.contains(this.panelElement) &&
      this.findAnchor(sidebar)
    );
  }

  private enforcePosition(): void {
    if (!this.running || this.mode !== 'sidebar' || !this.panelElement?.isConnected) return;
    const anchor = this.sidebarElement && this.findAnchor(this.sidebarElement);
    const parent = anchor?.parentElement;
    if (!anchor || !parent) return;
    this.ensureNotebooksButton();
    if (
      this.panelElement.parentElement !== parent ||
      this.panelElement.nextElementSibling !== anchor
    ) {
      parent.insertBefore(this.panelElement, anchor);
    }
  }

  private observePosition(): void {
    this.positionObserver?.disconnect();
    const target =
      (this.sidebarElement && this.findAnchor(this.sidebarElement)?.parentElement) ??
      this.sidebarElement;
    if (!target) return;
    this.positionObserver = new MutationObserver(() => {
      if (this.positionRaf !== null) return;
      this.positionRaf = window.requestAnimationFrame(() => {
        this.positionRaf = null;
        this.enforcePosition();
      });
    });
    this.positionObserver.observe(target, { childList: true });
  }

  private isSidebarOpen(): boolean {
    if (document.querySelector('chat-app.side-nav-open, #app-root.side-nav-open')) return true;
    const sidebar = document.querySelector('bard-sidenav, side-nav');
    return sidebar instanceof HTMLElement && sidebar.offsetWidth > 120;
  }

  private isPanelUsable(): boolean {
    const panel = this.panelElement;
    if (!panel?.isConnected) return false;
    if (!this.isSidebarOpen() || panel.classList.contains('gv-sidebar-section-hidden')) return true;
    return panel.offsetParent !== null && panel.getBoundingClientRect().height > 0;
  }

  private observeVisibility(): void {
    this.visibilityObserver?.disconnect();
    const host = document.querySelector('chat-app') ?? document.querySelector('#app-root');
    if (!host) return;
    this.visibilityObserver = new MutationObserver(() => this.updateVisibility());
    this.visibilityObserver.observe(host, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  private updateVisibility(): void {
    if (!this.running || this.mode !== 'sidebar') return;
    if (!this.isMountedInCurrentSidebar()) {
      if (this.isSidebarOpen()) void this.remount();
      return;
    }
    if (this.panelElement) this.panelElement.style.display = this.isSidebarOpen() ? '' : 'none';
  }

  private ensureRecoveryWatchers(): void {
    if (!this.recoveryHandler) {
      this.recoveryHandler = () => {
        if (this.recoveryDebounce !== null) window.clearTimeout(this.recoveryDebounce);
        this.recoveryDebounce = window.setTimeout(() => {
          this.recoveryDebounce = null;
          if (!this.running || this.mode !== 'sidebar') return;
          if (!this.isMountedInCurrentSidebar() && this.isSidebarOpen()) void this.remount();
        }, 800);
      };
      window.addEventListener('resize', this.recoveryHandler);
      window.addEventListener('gv-print-cleanup', this.recoveryHandler);
      window.addEventListener('afterprint', this.recoveryHandler);
    }
    if (this.recoveryInterval === null) {
      this.recoveryInterval = window.setInterval(() => void this.recover(), 2000);
    }
  }

  private teardownRecoveryWatchers(): void {
    if (this.recoveryDebounce !== null) window.clearTimeout(this.recoveryDebounce);
    this.recoveryDebounce = null;
    if (this.recoveryHandler) {
      window.removeEventListener('resize', this.recoveryHandler);
      window.removeEventListener('gv-print-cleanup', this.recoveryHandler);
      window.removeEventListener('afterprint', this.recoveryHandler);
      this.recoveryHandler = null;
    }
    if (this.recoveryInterval !== null) window.clearInterval(this.recoveryInterval);
    this.recoveryInterval = null;
  }

  private async recover(): Promise<void> {
    if (!this.running || this.mode !== 'sidebar' || this.remounting || this.recoveryInFlight)
      return;
    const sidebar = this.findSidebar();
    const anchor = sidebar && this.findAnchor(sidebar);
    if (this.isMountedInCurrentSidebar(sidebar)) {
      this.anchorMissingSince = null;
      if (sidebar && this.sidebarElement !== sidebar) {
        this.bindNativeSidebar(sidebar);
        this.observePosition();
      }
      if (!this.isPanelUsable()) {
        const now = Date.now();
        this.hiddenPanelSince ??= now;
        if (now - this.hiddenPanelSince < HIDDEN_PANEL_GRACE_MS) return;
        this.hiddenPanelSince = null;
        this.panelElement?.style.removeProperty('display');
        this.updateVisibility();
        if (this.isPanelUsable()) return;
        await this.openFallback();
        return;
      }
      this.hiddenPanelSince = null;
      this.retireFallback();
      this.enforcePosition();
      return;
    }
    this.hiddenPanelSince = null;
    if (anchor) {
      this.anchorMissingSince = null;
      this.retireFallback();
      void this.remount();
      return;
    }
    const now = Date.now();
    this.anchorMissingSince ??= now;
    if (now - this.anchorMissingSince >= ANCHOR_MISSING_GRACE_MS) await this.openFallback();
  }

  private async openFallback(): Promise<void> {
    if (this.fallbackActive || this.options.floating.isOpen()) return;
    this.fallbackActive = true;
    this.recoveryInFlight = true;
    try {
      await this.openFloating(true);
    } catch (error) {
      this.fallbackActive = false;
      console.error('[FolderManager] Failed to mount floating folder fallback:', error);
    } finally {
      this.recoveryInFlight = false;
    }
  }

  private openFloating(openPanel: boolean): Promise<void> {
    const previous = this.floatingOpenPromise;
    if (previous && this.floatingOpenPanel === openPanel) return previous;
    let operation: Promise<void>;
    const openAfterPrevious = () => {
      if (
        this.floatingOpenPromise !== operation ||
        this.floatingOpenPanel !== openPanel ||
        !this.running ||
        (this.mode === 'sidebar' && !this.fallbackActive)
      )
        return;
      // Retire the old request before opening its replacement, so a late
      // completion cannot close or overwrite the newly requested view.
      this.options.floating.close();
      return this.options.floating.open(openPanel);
    };
    operation = (
      previous
        ? previous.catch(() => {}).then(openAfterPrevious)
        : this.options.floating.open(openPanel)
    ).finally(() => {
      if (this.floatingOpenPromise === operation) {
        this.floatingOpenPromise = null;
        this.floatingOpenPanel = null;
      }
      if (!this.running || (this.mode === 'sidebar' && !this.fallbackActive)) {
        this.options.floating.close();
      }
    });
    this.floatingOpenPromise = operation;
    this.floatingOpenPanel = openPanel;
    return operation;
  }

  private retireFallback(): void {
    if (!this.fallbackActive) return;
    this.fallbackActive = false;
    this.anchorMissingSince = null;
    this.options.floating.close();
  }

  private ensureNotebooksButton(): void {
    if (!this.running || this.mode !== 'sidebar') {
      this.cleanupNotebooksButton();
      return;
    }
    const notebooks = this.findNotebooks();
    if (!notebooks) {
      if (this.notebooksButton && !this.notebooksButton.isConnected) this.notebooksButton = null;
      return;
    }
    if (this.notebooksButton?.parentElement === notebooks) {
      this.refreshLanguage();
      return;
    }
    this.notebooksButton?.remove();
    notebooks.classList.add('gv-folders-anchor-host');
    const button = document.createElement('span');
    button.className = 'gv-folders-anchor-toggle';
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M320-440v-287L217-624l-57-56 200-200 200 200-57 56-103-103v287h-80Zm320 280L440-360l57-56 103 103v-287h80v287l103-103 57 56-200 200Z"/></svg>`;
    const toggle = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
      event.stopPropagation();
      event.preventDefault();
      this.setAnchor(
        this.anchorPreference === 'above-notebooks' ? 'above-recents' : 'above-notebooks',
      );
      void browser.storage.local
        .set({ [StorageKeys.FOLDERS_ANCHOR]: this.anchorPreference })
        .catch((error) =>
          console.error('[FolderManager] Failed to persist folder anchor preference:', error),
        );
    };
    button.addEventListener('click', toggle);
    button.addEventListener('keydown', toggle);
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    button.addEventListener('mousedown', (event) => event.stopPropagation());
    notebooks.appendChild(button);
    this.notebooksButton = button;
    this.refreshLanguage();
  }

  private cleanupNotebooksButton(): void {
    this.notebooksButton?.remove();
    this.notebooksButton = null;
    document
      .querySelectorAll('expandable-section.gv-folders-anchor-host')
      .forEach((element) => element.classList.remove('gv-folders-anchor-host'));
  }

  refreshLanguage(): void {
    const button = this.notebooksButton;
    if (!button) return;
    const aboveNotebooks = this.anchorPreference === 'above-notebooks';
    const label = getTranslationSyncUnsafe(
      aboveNotebooks ? 'folder_anchor_move_above_recents' : 'folder_anchor_move_above_notebooks',
    );
    button.title = label;
    button.setAttribute('aria-label', label);
    button.classList.toggle('gv-anchor-above-notebooks', aboveNotebooks);
  }
}
