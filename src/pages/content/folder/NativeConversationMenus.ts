import { extractRouteUserIdFromPath } from '@/core/services/AccountIsolationService';
import { getTranslationSyncUnsafe } from '@/utils/i18n';

import {
  MENU_PANEL_SELECTOR as CONVERSATION_MENU_PANEL_SELECTOR,
  type ConversationMenuContext,
  getConversationMenuContext,
  injectConversationMenuMoveToFolderButton,
} from '../export/conversationMenuInjection';
import {
  type NativeConversationInfo,
  type NativeSidebarReadContext,
  buildConversationUrlFromId,
  extractConversationInfoFromPage,
  extractFallbackTitle,
  extractNativeConversationId,
  extractNativeConversationTitle,
  extractNativeConversationUrl,
  findConversationElementForTrigger,
  normalizeConversationId,
  getCurrentConversationId,
  isConversationInDOM,
  findNativeConversationElement,
} from './nativeSidebarDom';

export interface NativeConversationMenuCallbacks {
  getContext: () => NativeSidebarReadContext & { storageKey: string };
  onMoveToFolder: (info: NativeConversationInfo) => void;
  onConfirmedDelete: (id: string) => void;
}

interface NativeDeleteScope {
  storageKey: string;
  routeUserId: string | null;
}

// Native menu contents render asynchronously after their panel appears.
const MOVE_MENU_INJECTION_RETRY_LIMIT = 8;
const MOVE_MENU_INJECTION_RETRY_DELAY_MS = 80;
const CONVERSATION_MENU_TRIGGER_SELECTOR =
  '[data-test-id="actions-menu-button"], [data-test-id="conversation-actions-menu-icon-button"]';
const VOYAGER_CONVERSATION_MENU_ACTION_SELECTOR =
  '.gv-export-conversation-menu-btn, .gv-export-response-menu-btn, .gv-move-to-folder-btn';
// Abandoned dialogs must not carry an old conversation into an unrelated action.
const NATIVE_DELETE_CANDIDATE_TIMEOUT_MS = 60_000;
// A bounded ~6 seconds lets route and sidebar settle; timeout preserves folder data.
const NATIVE_DELETE_SETTLE_CHECK_LIMIT = 20;
const NATIVE_ACTION_TIMING = {
  MENU_APPEAR_DELAY: 300,
  DIALOG_APPEAR_DELAY: 300,
  DELETION_COMPLETE_DELAY: 500,
  MAX_BUTTON_WAIT_TIME: 3000,
  BUTTON_CHECK_INTERVAL: 100,
} as const;

function debug(level: 'log' | 'warn', ...args: unknown[]): void {
  try {
    if (localStorage.getItem('gvFolderDebug') === '1') {
      console[level]('[FolderManager]', ...args);
    }
  } catch {
    // localStorage may be unavailable in private browsing.
  }
}

/** Owns native menu interaction and explicit deletion tracking across sidebar remounts. */
export class NativeConversationMenus {
  private nativeMenuObserver: MutationObserver | null = null;

  // Capture-phase listener that injects "Move to folder" when a conversation ⋮
  // menu trigger is clicked (belt-and-suspenders alongside nativeMenuObserver).
  private moveMenuTriggerHandler: ((event: Event) => void) | null = null;

  private moveMenuKeydownHandler: ((event: Event) => void) | null = null;

  private nativeDeleteCandidateId: string | null = null;

  private nativeDeleteCandidateScope: NativeDeleteScope | null = null;

  private nativeDeleteCandidateTimer: number | null = null;

  private nativeDeleteCandidateWasCurrent = false;

  private currentNativeDeletionChecks = new Set<string>();

  private pendingNativeDeletionScopes = new Map<string, NativeDeleteScope>();

  // Tracks the last input modality so menu-close focus handling stays a11y-safe:
  // pointer dismissals drop trigger focus, keyboard dismissals preserve it.
  private lastInputModality: 'pointer' | 'keyboard' = 'pointer';

  // Pending conversation removals with timer IDs.
  private pendingRemovals: Map<string, number> = new Map();

  // Delay (ms) before checking whether the native route and row have settled.
  private removalCheckDelay: number = 300;

  private menuTimers = new Set<number>();

  constructor(private readonly callbacks: NativeConversationMenuCallbacks) {}

  /** Sidebar-only remount: retain document tracking and pending delete confirmations. */
  disconnectPanels(): void {
    this.nativeMenuObserver?.disconnect();
    this.nativeMenuObserver = null;
  }

  /** Full mounted-runtime teardown; promise-based native action waits still settle normally. */
  stop(): void {
    this.disconnectPanels();
    this.teardownMoveMenuTriggerListener();
    this.pendingRemovals.forEach((timerId) => clearTimeout(timerId));
    this.pendingRemovals.clear();
    this.currentNativeDeletionChecks.clear();
    this.pendingNativeDeletionScopes.clear();
    this.menuTimers.forEach((timerId) => window.clearTimeout(timerId));
    this.menuTimers.clear();
  }

  private scheduleMenuTask(callback: () => void, delay: number): void {
    const timer = window.setTimeout(() => {
      this.menuTimers.delete(timer);
      callback();
    }, delay);
    this.menuTimers.add(timer);
  }

  // Detect a freshly-opened conversation ⋮ menu and inject our "Move to folder"
  // item. Google's "lr26" UI overhaul replaced the old `.mat-mdc-menu-panel`
  // (rendered into `.cdk-overlay-container`) with a `<gem-menu>` element and
  // re-creates the overlay container, which silently broke the previous
  // observer. This mirrors the proven, robust export-button observer: it
  // watches `document.body`, matches both panel variants, and retries while
  // the menu items stream in asynchronously.
  observePanels(): void {
    if (this.nativeMenuObserver) {
      this.nativeMenuObserver.disconnect();
      this.nativeMenuObserver = null;
    }

    const observer = new MutationObserver((mutations) => {
      if (this.callbacks.getContext().isDestroyed) return;
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          // Cheap gate before the matches/querySelectorAll/closest triple:
          // menu panels only ever live inside a CDK overlay (or are a
          // <gem-menu> themselves), while the overwhelming majority of body
          // mutations are sidebar/chat re-renders that can't contain one.
          // Missed edge cases are covered by the click-tracking fallback in
          // startTracking.
          const className = typeof node.className === 'string' ? node.className : '';
          const mayHostMenuPanel =
            node.tagName === 'GEM-MENU' ||
            className.includes('mat-mdc-menu-panel') ||
            className.includes('cdk-overlay') ||
            node.parentElement?.closest('.cdk-overlay-container') != null;
          if (!mayHostMenuPanel) return;
          const panels = new Set<HTMLElement>();
          if (node.matches(CONVERSATION_MENU_PANEL_SELECTOR)) panels.add(node);
          node
            .querySelectorAll<HTMLElement>(CONVERSATION_MENU_PANEL_SELECTOR)
            .forEach((panel) => panels.add(panel));
          const closest = node.closest(CONVERSATION_MENU_PANEL_SELECTOR) as HTMLElement | null;
          if (closest) panels.add(closest);
          panels.forEach((panel) =>
            this.scheduleMenuTask(() => this.tryInjectMoveToFolderOnPanel(panel), 30),
          );
        });

        // When a conversation menu we injected into closes, mat-menu restores
        // focus to the ⋮ trigger, which keeps the row visually selected via
        // :focus-within. Drop that focus on pointer-driven dismissals so the
        // row reverts. See releaseTriggerFocusAfterPointerClose for guards.
        mutation.removedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          const wasInjectedConversationMenu =
            (node.matches?.(CONVERSATION_MENU_PANEL_SELECTOR) &&
              node.querySelector('.gv-move-to-folder-btn')) ||
            node.querySelector?.(`${CONVERSATION_MENU_PANEL_SELECTOR} .gv-move-to-folder-btn`) ||
            (node.querySelector?.(CONVERSATION_MENU_PANEL_SELECTOR) &&
              node.querySelector('.gv-move-to-folder-btn'));
          if (wasInjectedConversationMenu) {
            this.releaseTriggerFocusAfterPointerClose();
          }
        });
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    this.nativeMenuObserver = observer;

    // Catch any menu already open at setup time.
    document
      .querySelectorAll<HTMLElement>(CONVERSATION_MENU_PANEL_SELECTOR)
      .forEach((panel) =>
        this.scheduleMenuTask(() => this.tryInjectMoveToFolderOnPanel(panel), 30),
      );
  }

  // Inject the "Move to folder" item into a native conversation menu panel,
  // retrying while the menu content renders. Conversation info is resolved
  // lazily on click (from the menu trigger or the open page) so a transient
  // extraction miss never prevents the item from appearing.
  private tryInjectMoveToFolderOnPanel(
    panel: HTMLElement,
    retriesLeft: number = MOVE_MENU_INJECTION_RETRY_LIMIT,
  ): void {
    if (this.callbacks.getContext().isDestroyed || !panel.isConnected) return;

    const context = getConversationMenuContext(panel);
    if (!context) return; // not a conversation menu (e.g. model picker / response menu)

    const label = getTranslationSyncUnsafe('conversation_move_to_folder');
    const injected = injectConversationMenuMoveToFolderButton(panel, {
      label,
      tooltip: label,
      onClick: () => {
        const info = this.resolveConversationInfoForMenu(context);
        if (info) {
          this.callbacks.onMoveToFolder(info);
        } else {
          debug('warn', 'Move to folder: could not resolve conversation info on click');
        }
      },
    });

    if (!injected && retriesLeft > 0) {
      this.scheduleMenuTask(
        () => this.tryInjectMoveToFolderOnPanel(panel, retriesLeft - 1),
        MOVE_MENU_INJECTION_RETRY_DELAY_MS,
      );
    }
  }

  // Resolve the conversation a menu belongs to. Sidebar menus map back to their
  // list item via the trigger; the top-bar ⋮ menu maps to the open page.
  private resolveConversationInfoForMenu(
    context: ConversationMenuContext,
  ): { id: string; title: string; url: string } | null {
    const trigger = context.trigger;
    if (trigger) {
      const conversationEl = findConversationElementForTrigger(trigger);
      if (conversationEl) {
        const id = extractNativeConversationId(conversationEl);
        if (id) {
          const url =
            extractNativeConversationUrl(
              conversationEl,
              this.callbacks.getContext().accountIsolationEnabled,
            ) ||
            buildConversationUrlFromId(id, this.callbacks.getContext().accountIsolationEnabled);
          const title =
            extractNativeConversationTitle(conversationEl) ||
            extractFallbackTitle(conversationEl) ||
            'Untitled';
          if (url) {
            debug('log', 'resolveConversationInfoForMenu(sidebar):', { id, title, url });
            return { id, title, url };
          }
        }
      }
    }

    // Top-bar menus map to the current page. A sidebar resolution miss must
    // stay unresolved rather than accidentally targeting the open page.
    if (context.menuType === 'top') {
      const pageInfo = extractConversationInfoFromPage();
      if (pageInfo) {
        debug('log', 'resolveConversationInfoForMenu(page):', pageInfo);
        return pageInfo;
      }
    }
    return null;
  }

  // Belt-and-suspenders alongside nativeMenuObserver: when a conversation ⋮
  // trigger is clicked, resolve the panel it controls (via aria-controls/owns)
  // and retry injection while the menu renders. This covers cases where the
  // panel is re-used / re-rendered without a fresh childList mutation.
  startTracking(): void {
    if (this.moveMenuTriggerHandler) return; // already wired (idempotent across reinit)

    const handler = (event: Event) => {
      if (this.callbacks.getContext().isDestroyed) return;
      // Any pointerdown/click marks the modality; used to decide whether to drop
      // trigger focus on menu close (pointer) vs preserve it (keyboard a11y).
      this.lastInputModality = 'pointer';
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      if (event.type === 'click' && this.isNativeDeleteCancellationTarget(target)) {
        this.clearNativeDeleteCandidate();
        return;
      }

      if (event.type === 'click' && this.isNativeDeleteOverlayDismissalTarget(target)) {
        this.clearNativeDeleteCandidate();
        return;
      }

      if (event.type === 'click' && this.isNativeDeleteConfirmationTarget(target)) {
        const conversationId = this.nativeDeleteCandidateId;
        const deletionScope = this.nativeDeleteCandidateScope;
        if (conversationId && deletionScope && this.isNativeDeleteScopeCurrent(deletionScope)) {
          const wasCurrent = this.nativeDeleteCandidateWasCurrent;
          this.clearNativeDeleteCandidate();
          if (wasCurrent) this.currentNativeDeletionChecks.add(conversationId);
          this.pendingNativeDeletionScopes.set(conversationId, deletionScope);
          this.scheduleConversationRemovalCheck(conversationId);
        } else {
          this.clearNativeDeleteCandidate();
        }
        return;
      }

      if (event.type === 'click') {
        const conversationId = this.resolveNativeDeleteMenuActionConversationId(target);
        if (conversationId) {
          this.rememberNativeDeleteCandidate(conversationId);
          return;
        }
      }

      const trigger = target.closest(CONVERSATION_MENU_TRIGGER_SELECTOR) as HTMLElement | null;
      if (!trigger) return;

      this.clearNativeDeleteCandidate();

      const panelIds = this.parseMenuTriggerPanelIds(trigger);
      for (let attempt = 0; attempt <= MOVE_MENU_INJECTION_RETRY_LIMIT; attempt++) {
        this.scheduleMenuTask(() => {
          if (this.callbacks.getContext().isDestroyed) return;
          if (panelIds.length > 0) {
            panelIds.forEach((id) => {
              const panel = document.getElementById(id);
              if (panel instanceof HTMLElement && panel.matches(CONVERSATION_MENU_PANEL_SELECTOR)) {
                this.tryInjectMoveToFolderOnPanel(panel);
              }
            });
          } else {
            document
              .querySelectorAll<HTMLElement>(CONVERSATION_MENU_PANEL_SELECTOR)
              .forEach((panel) => this.tryInjectMoveToFolderOnPanel(panel));
          }
        }, attempt * MOVE_MENU_INJECTION_RETRY_DELAY_MS);
      }
    };

    document.addEventListener('click', handler, true);
    document.addEventListener('pointerdown', handler, true);
    this.moveMenuTriggerHandler = handler;

    const keyHandler = (event: Event) => {
      if (this.callbacks.getContext().isDestroyed) return;
      if (event instanceof KeyboardEvent && event.key === 'Escape') {
        this.clearNativeDeleteCandidate();
      }
      this.lastInputModality = 'keyboard';
    };
    document.addEventListener('keydown', keyHandler, true);
    this.moveMenuKeydownHandler = keyHandler;
  }

  private resolveNativeDeleteMenuActionConversationId(target: HTMLElement): string | null {
    const action = target.closest(
      '[data-test-id="delete-button"], button[role="menuitem"], [role="menuitem"], gem-menu-item',
    ) as HTMLElement | null;
    if (!action || action.matches(VOYAGER_CONVERSATION_MENU_ACTION_SELECTOR)) return null;

    const panel = action.closest(CONVERSATION_MENU_PANEL_SELECTOR) as HTMLElement | null;
    const context = panel ? getConversationMenuContext(panel) : null;
    if (!context) return null;

    let isDeleteAction = action.getAttribute('data-test-id') === 'delete-button';

    const icon = action.querySelector('mat-icon, .material-icons');
    const iconName =
      icon?.getAttribute('fonticon') ||
      icon?.getAttribute('data-mat-icon-name') ||
      icon?.textContent?.trim().toLowerCase();
    if (iconName === 'delete' || iconName === 'delete_forever' || iconName === 'delete_outline') {
      isDeleteAction = true;
    }

    const text = action.textContent?.trim().toLowerCase() || '';
    if (
      this.getDeleteKeywords().some(
        (keyword) => text === keyword || (text.includes(keyword) && text.length < 20),
      )
    ) {
      isDeleteAction = true;
    }
    if (!isDeleteAction) return null;

    const info = this.resolveConversationInfoForMenu(context);
    return normalizeConversationId(info?.id);
  }

  private isNativeDeleteConfirmationTarget(target: HTMLElement): boolean {
    if (!this.nativeDeleteCandidateId) return false;
    const button = target.closest('button, [role="button"]') as HTMLElement | null;
    if (!button) return false;
    const dialog = button.closest('[role="dialog"], .mat-mdc-dialog-container');
    if (!dialog) return false;

    const testId = button.getAttribute('data-test-id')?.toLowerCase() || '';
    if (testId.includes('cancel')) return false;
    if (testId.includes('confirm') || testId.includes('delete')) return true;

    const text = button.textContent?.trim().toLowerCase() || '';
    return this.getDeleteKeywords().some(
      (keyword) => text === keyword || (text.includes(keyword) && text.length < 20),
    );
  }

  private isNativeDeleteCancellationTarget(target: HTMLElement): boolean {
    if (!this.nativeDeleteCandidateId) return false;
    const button = target.closest('button, [role="button"]') as HTMLElement | null;
    if (!button?.closest('[role="dialog"], .mat-mdc-dialog-container')) return false;

    const testId = button.getAttribute('data-test-id')?.toLowerCase() || '';
    if (testId.includes('cancel')) return true;

    const text = button.textContent?.trim().toLowerCase() || '';
    const cancelLabel = getTranslationSyncUnsafe('pm_cancel').trim().toLowerCase();
    return text === 'cancel' || (!!cancelLabel && text === cancelLabel);
  }

  private isNativeDeleteOverlayDismissalTarget(target: HTMLElement): boolean {
    return !!this.nativeDeleteCandidateId && !!target.closest('.cdk-overlay-backdrop');
  }

  private rememberNativeDeleteCandidate(conversationId: string): void {
    const normalized = normalizeConversationId(conversationId);
    if (!normalized) return;
    this.clearNativeDeleteCandidate();
    this.nativeDeleteCandidateId = normalized;
    this.nativeDeleteCandidateScope = this.captureNativeDeleteScope();
    this.nativeDeleteCandidateWasCurrent =
      normalizeConversationId(getCurrentConversationId()) === normalized;

    this.nativeDeleteCandidateTimer = window.setTimeout(
      () => this.clearNativeDeleteCandidate(),
      NATIVE_DELETE_CANDIDATE_TIMEOUT_MS,
    );
  }

  private isNativeDeleteCompletionRoute(): boolean {
    try {
      const url = new URL(window.location.href);
      return (
        /^\/(?:u\/\d+\/)?app\/?$/.test(url.pathname) && url.searchParams.get('pageId') === 'none'
      );
    } catch {
      return false;
    }
  }

  private captureNativeDeleteScope(): NativeDeleteScope {
    return {
      storageKey: this.callbacks.getContext().storageKey,
      routeUserId: this.getNativeDeleteRouteUserId(),
    };
  }

  private isNativeDeleteScopeCurrent(scope: NativeDeleteScope): boolean {
    return (
      scope.storageKey === this.callbacks.getContext().storageKey &&
      scope.routeUserId === this.getNativeDeleteRouteUserId()
    );
  }

  /** Bare `/app` routes and `/u/0/app` both address Gemini's default account. */
  private getNativeDeleteRouteUserId(): string | null {
    const routeUserId = extractRouteUserIdFromPath(window.location.pathname);
    if (routeUserId !== null) return routeUserId;
    return /^\/app(?:\/|$)/.test(window.location.pathname) ? '0' : null;
  }

  private clearNativeDeleteCandidate(): void {
    if (this.nativeDeleteCandidateTimer !== null) {
      window.clearTimeout(this.nativeDeleteCandidateTimer);
      this.nativeDeleteCandidateTimer = null;
    }
    this.nativeDeleteCandidateId = null;
    this.nativeDeleteCandidateScope = null;
    this.nativeDeleteCandidateWasCurrent = false;
  }

  // After a conversation ⋮ menu we injected into closes, mat-menu restores DOM
  // focus to the trigger (Angular default), leaving the row highlighted via
  // :focus-within. Drop that focus — but ONLY for plain pointer dismissals, so
  // we never disturb keyboard navigation, the rename/delete flows, our
  // move-to-folder dialog, or any confirm dialog that takes focus.
  private releaseTriggerFocusAfterPointerClose(): void {
    if (this.lastInputModality !== 'pointer') return;
    this.scheduleMenuTask(() => {
      if (this.callbacks.getContext().isDestroyed) return;
      // Skip if another overlay/dialog grabbed the stage (delete confirm, our
      // move-to-folder dialog, any CDK dialog) — those manage their own focus.
      if (
        document.querySelector(
          '.cdk-overlay-backdrop, .mat-mdc-dialog-container, .gv-folder-dialog-overlay',
        )
      ) {
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      if (active && active.matches?.(CONVERSATION_MENU_TRIGGER_SELECTOR)) {
        active.blur();
      }
    }, 0);
  }

  private parseMenuTriggerPanelIds(trigger: HTMLElement): string[] {
    const raw = `${trigger.getAttribute('aria-controls') || ''} ${
      trigger.getAttribute('aria-owns') || ''
    }`;
    return raw
      .split(/\s+/)
      .map((id) => id.trim())
      .filter(Boolean);
  }

  private teardownMoveMenuTriggerListener(): void {
    if (this.moveMenuTriggerHandler) {
      document.removeEventListener('click', this.moveMenuTriggerHandler, true);
      document.removeEventListener('pointerdown', this.moveMenuTriggerHandler, true);
      this.moveMenuTriggerHandler = null;
    }
    if (this.moveMenuKeydownHandler) {
      document.removeEventListener('keydown', this.moveMenuKeydownHandler, true);
      this.moveMenuKeydownHandler = null;
    }
    this.clearNativeDeleteCandidate();
  }

  /**
   * Schedule a delayed check after an explicit native Delete action. DOM
   * disappearance alone never calls this method because the sidebar virtualizes
   * rows during normal scrolling.
   */
  private scheduleConversationRemovalCheck(
    conversationId: string,
    checksRemaining: number = NATIVE_DELETE_SETTLE_CHECK_LIMIT,
  ): void {
    const normalizedId = normalizeConversationId(conversationId);
    if (!normalizedId || this.callbacks.getContext().isDestroyed) return;
    const deletionScope =
      this.pendingNativeDeletionScopes.get(normalizedId) ?? this.captureNativeDeleteScope();
    this.pendingNativeDeletionScopes.set(normalizedId, deletionScope);

    // Cancel any existing timer for this conversation
    const existingTimer = this.pendingRemovals.get(normalizedId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      debug('log', `Cancelled previous removal timer for ${normalizedId}`);
    }

    // Schedule a new check after delay
    const timerId = window.setTimeout(() => {
      this.confirmConversationRemoval(normalizedId, checksRemaining, deletionScope);
    }, this.removalCheckDelay);

    this.pendingRemovals.set(normalizedId, timerId);
    debug(
      'log',
      `Scheduled removal check for ${normalizedId} (delay: ${this.removalCheckDelay}ms)`,
    );
  }

  /**
   * Confirm an explicit native deletion after the UI has settled. The current
   * URL / visible-row checks keep the folder entry if Gemini rejected or
   * cancelled the operation.
   */
  private confirmConversationRemoval(
    conversationId: string,
    checksRemaining: number,
    deletionScope: NativeDeleteScope,
  ): void {
    // Remove from pending list
    this.pendingRemovals.delete(conversationId);
    if (this.callbacks.getContext().isDestroyed) return;
    if (!this.isNativeDeleteScopeCurrent(deletionScope)) {
      this.currentNativeDeletionChecks.delete(conversationId);
      this.pendingNativeDeletionScopes.delete(conversationId);
      debug('log', `Discarded deletion check after account scope changed: ${conversationId}`);
      return;
    }

    debug('log', `\n═══ Confirming removal for conversation ${conversationId} ═══`);
    debug('log', `  Delay elapsed: ${this.removalCheckDelay}ms`);

    // Check 1: Is this the currently active conversation?
    const currentConvId = getCurrentConversationId();
    const currentUrl = window.location.href;

    if (normalizeConversationId(currentConvId) === conversationId) {
      debug('log', `  ✓ SKIPPED: Currently active conversation`);
      debug('log', `    Current URL: ${currentUrl}`);
      debug('log', `    Matched ID: ${currentConvId}`);
      debug('log', `════════════════════════════════════════════════\n`);
      this.retryConversationRemovalCheck(conversationId, checksRemaining);
      return;
    }

    // Check 2: Is conversation still visibly present in Gemini's native list?
    // The lr26 sidebar can retain hidden virtualized rows after a successful
    // current-chat deletion. Ignore those only when the explicit delete flow
    // was armed for the current route and Gemini reached its completion page.
    const ignoreHiddenRows =
      this.currentNativeDeletionChecks.has(conversationId) && this.isNativeDeleteCompletionRoute();
    if (
      isConversationInDOM(this.callbacks.getContext().sidebar, conversationId, ignoreHiddenRows)
    ) {
      debug('log', `  ✓ SKIPPED: Conversation still exists in DOM`);
      debug('log', `    Likely a UI refresh, not a deletion`);
      debug('log', `════════════════════════════════════════════════\n`);
      this.retryConversationRemovalCheck(conversationId, checksRemaining);
      return;
    }

    // Conversation is truly deleted - remove from folders
    debug('log', `  ✗ CONFIRMED DELETION: Removing from all folders`);
    debug('log', `    Reason: Not in current URL and not found in DOM`);
    debug('log', `    Current URL: ${currentUrl}`);
    debug('log', `════════════════════════════════════════════════\n`);

    this.callbacks.onConfirmedDelete(conversationId);
    this.currentNativeDeletionChecks.delete(conversationId);
    this.pendingNativeDeletionScopes.delete(conversationId);
  }

  private retryConversationRemovalCheck(conversationId: string, checksRemaining: number): void {
    if (checksRemaining <= 1) {
      debug('log', `Removal check timed out for ${conversationId}; preserving folder entry`);
      this.currentNativeDeletionChecks.delete(conversationId);
      this.pendingNativeDeletionScopes.delete(conversationId);
      return;
    }
    this.scheduleConversationRemovalCheck(conversationId, checksRemaining - 1);
  }

  /**
   * Trigger native delete for a single conversation by simulating UI interactions
   */
  async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      // Step 1: Find the conversation element in the sidebar.
      // The lr26 sidebar virtualizes rows — if the user has scrolled the list
      // since selecting, the target row may be unmounted entirely.
      const conversationEl = findNativeConversationElement(
        this.callbacks.getContext().sidebar,
        conversationId,
      );
      if (!conversationEl) {
        console.warn(
          `[FolderManager] Batch delete: conversation row not in DOM (likely virtualized out): ${conversationId}. ` +
            'Scroll the sidebar to bring it back into view, or split the batch into smaller chunks.',
        );
        return false;
      }

      const moreButton = await this.findAndClickMoreButton(conversationEl);
      if (!moreButton) {
        console.warn(
          `[FolderManager] Batch delete: actions menu button not found for ${conversationId}`,
        );
        return false;
      }

      await this.delay(NATIVE_ACTION_TIMING.MENU_APPEAR_DELAY);

      const deleteSuccess = await this.waitForDeleteButtonAndClick();
      if (!deleteSuccess) {
        console.warn(
          `[FolderManager] Batch delete: Delete menu item not found after ${NATIVE_ACTION_TIMING.MAX_BUTTON_WAIT_TIME}ms for ${conversationId}`,
        );
        this.clickBackdropToCloseMenu();
        return false;
      }

      await this.delay(NATIVE_ACTION_TIMING.DIALOG_APPEAR_DELAY);
      await this.confirmDeleteIfNeeded();
      await this.delay(NATIVE_ACTION_TIMING.DELETION_COMPLETE_DELAY);

      return true;
    } catch (error) {
      console.error(`[FolderManager] Error in triggerNativeDeleteForConversation:`, error);
      return false;
    }
  }

  /**
   * Find and click the more options button for a conversation.
   *
   * In Gemini's current sidebar layout the actions-menu-button is rendered
   * INSIDE the conversation host (<gem-nav-list-item data-test-id="conversation">),
   * so we look there first. The legacy sibling-container and ancestor-<li>
   * strategies are kept as fallbacks for older layouts but are no-ops in the
   * lr26 sidebar.
   *
   * The host is also virtualized — a row scrolled far off-screen may exist
   * only as an empty stub or be missing entirely. Scroll the host into view
   * before clicking so the trailing actions actually mount.
   */
  async findAndClickMoreButton(conversationEl: HTMLElement): Promise<HTMLElement | null> {
    const locate = (): HTMLElement | null => {
      // Primary: button is inside the conversation host (current lr26 layout).
      const inside = conversationEl.querySelector<HTMLElement>(
        '[data-test-id="actions-menu-button"]',
      );
      if (inside) return inside;

      // Fallback: legacy sibling .conversation-actions-container layout.
      const actionsContainer = conversationEl.parentElement?.querySelector(
        '.conversation-actions-container',
      );
      const sibling = actionsContainer?.querySelector<HTMLElement>(
        '[data-test-id="actions-menu-button"]',
      );
      if (sibling) return sibling;

      // Fallback: nearest <li> ancestor (very old layout).
      return (
        conversationEl
          .closest('li')
          ?.querySelector<HTMLElement>('[data-test-id="actions-menu-button"]') ?? null
      );
    };

    let moreButton = locate();

    // If the row was virtualized away from the viewport its trailing actions
    // may not have mounted yet. Scroll it back into view and poll briefly.
    if (!moreButton) {
      try {
        conversationEl.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      } catch {
        /* scrollIntoView may throw in some embedded contexts — ignore */
      }
      const maxWait = NATIVE_ACTION_TIMING.MAX_BUTTON_WAIT_TIME;
      const step = NATIVE_ACTION_TIMING.BUTTON_CHECK_INTERVAL;
      let waited = 0;
      while (waited < maxWait && !moreButton) {
        await this.delay(step);
        waited += step;
        moreButton = locate();
      }
    }

    if (moreButton) {
      moreButton.click();
      debug('log', 'Clicked more button');
      return moreButton;
    }

    console.warn(
      '[FolderManager] Could not locate actions-menu-button inside conversation host. ' +
        'Gemini sidebar DOM may have changed.',
      conversationEl,
    );
    return null;
  }

  resetNativeConversationMenuTrigger(moreButton: HTMLElement): void {
    moreButton.blur();
    const actionsContainer = moreButton.closest('.conversation-actions-container');
    if (actionsContainer instanceof HTMLElement) {
      actionsContainer.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    }
  }

  async waitForRenameButtonAndClick(): Promise<boolean> {
    const maxWaitTime = NATIVE_ACTION_TIMING.MAX_BUTTON_WAIT_TIME;
    const checkInterval = NATIVE_ACTION_TIMING.BUTTON_CHECK_INTERVAL;
    let elapsed = 0;

    while (elapsed < maxWaitTime) {
      const renameByTestId = document.querySelector(
        '[data-test-id="rename-button"]',
      ) as HTMLElement | null;
      if (renameByTestId && this.isVisibleElement(renameByTestId)) {
        renameByTestId.click();
        debug('log', 'Clicked rename button (by test-id)');
        return true;
      }

      const renameIcons = document.querySelectorAll(
        '.cdk-overlay-container mat-icon, .cdk-overlay-container .material-icons',
      );

      for (const icon of renameIcons) {
        const iconText = icon.textContent?.toLowerCase().trim() || '';
        if (iconText !== 'edit' && iconText !== 'edit_square') continue;

        const parentButton = icon.closest('button, [role="menuitem"]') as HTMLElement | null;
        if (parentButton && this.isVisibleElement(parentButton)) {
          parentButton.click();
          debug('log', 'Clicked rename button (by icon)');
          return true;
        }
      }

      await this.delay(checkInterval);
      elapsed += checkInterval;
    }

    return false;
  }

  /**
   * Wait for delete button to appear in the menu and click it
   * Uses multiple strategies to find the delete button for resilience to UI changes
   */
  private async waitForDeleteButtonAndClick(): Promise<boolean> {
    const maxWaitTime = NATIVE_ACTION_TIMING.MAX_BUTTON_WAIT_TIME;
    const checkInterval = NATIVE_ACTION_TIMING.BUTTON_CHECK_INTERVAL;
    let elapsed = 0;

    const keywords = this.getDeleteKeywords();

    // Track per-poll state so we can emit one summary diagnostic on timeout.
    let lastTestIdCount = 0;
    let lastVisibleTestIdCount = 0;
    let lastOverlayPanes = 0;
    let lastMenuPanels = 0;
    let lastMenuItemTexts: string[] = [];

    while (elapsed < maxWaitTime) {
      // Strategy 1: data-test-id (primary). Use querySelectorAll because some
      // layouts render hidden template copies that querySelector would lock
      // onto, never advancing past an invisible match.
      const deleteCandidates = Array.from(
        document.querySelectorAll<HTMLElement>('[data-test-id="delete-button"]'),
      );
      lastTestIdCount = deleteCandidates.length;
      const visibleByTestId = deleteCandidates.filter((el) => this.isVisibleElement(el));
      lastVisibleTestIdCount = visibleByTestId.length;
      // Prefer one that lives inside an open menu / overlay panel.
      const targetByTestId =
        visibleByTestId.find((el) => el.closest('.mat-mdc-menu-panel, .cdk-overlay-pane')) ??
        visibleByTestId[0];
      if (targetByTestId) {
        targetByTestId.click();
        debug('log', 'Clicked delete button (by test-id)');
        return true;
      }

      // Strategy 2: scan menu items for matching text (i18n-friendly).
      const menuItems = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.cdk-overlay-container button[role="menuitem"], ' +
            '.cdk-overlay-container [role="menuitem"], ' +
            '.mat-mdc-menu-content button, ' +
            '.mat-menu-content button',
        ),
      );
      lastMenuItemTexts = menuItems.map((el) => el.textContent?.trim().slice(0, 20) || '');

      for (const item of menuItems) {
        if (!this.isVisibleElement(item)) continue;
        const text = item.textContent?.toLowerCase().trim() || '';
        if (
          text &&
          keywords.some(
            (keyword: string) => text === keyword || (text.includes(keyword) && text.length < 20),
          )
        ) {
          item.click();
          debug('log', 'Clicked delete button (by text):', text);
          return true;
        }
      }

      // Strategy 3: by icon (mat-icon delete / delete_forever / delete_outline).
      const deleteIcons = document.querySelectorAll(
        '.cdk-overlay-container mat-icon, .cdk-overlay-container .material-icons',
      );
      for (const icon of deleteIcons) {
        const iconText = icon.textContent?.toLowerCase().trim() || '';
        const iconAttr = icon.getAttribute('fonticon') || '';
        if (
          iconText === 'delete' ||
          iconText === 'delete_forever' ||
          iconText === 'delete_outline' ||
          iconAttr === 'delete' ||
          iconAttr === 'delete_forever' ||
          iconAttr === 'delete_outline'
        ) {
          const parentButton = icon.closest('button, [role="menuitem"]') as HTMLElement | null;
          if (parentButton && this.isVisibleElement(parentButton)) {
            parentButton.click();
            debug('log', 'Clicked delete button (by icon)');
            return true;
          }
        }
      }

      lastOverlayPanes = document.querySelectorAll('.cdk-overlay-pane').length;
      lastMenuPanels = document.querySelectorAll('.mat-mdc-menu-panel').length;

      await this.delay(checkInterval);
      elapsed += checkInterval;
    }

    // Emit a SINGLE compact diagnostic on timeout so users can paste it
    // verbatim when reporting batch-delete failures.
    console.warn(
      '[FolderManager] Batch delete diagnostics on timeout: ' +
        JSON.stringify({
          deleteButtonsFound: lastTestIdCount,
          deleteButtonsVisible: lastVisibleTestIdCount,
          overlayPanes: lastOverlayPanes,
          menuPanels: lastMenuPanels,
          menuItemTexts: lastMenuItemTexts.slice(0, 10),
          keywordsTried: keywords,
        }),
    );
    return false;
  }

  /**
   * Check for and confirm the delete confirmation dialog if it appears
   */
  private async confirmDeleteIfNeeded(): Promise<void> {
    // Look for confirmation dialog buttons
    // Gemini typically uses a dialog with confirm/cancel buttons
    const maxWaitTime = NATIVE_ACTION_TIMING.MAX_BUTTON_WAIT_TIME;
    const checkInterval = NATIVE_ACTION_TIMING.BUTTON_CHECK_INTERVAL;
    let elapsed = 0;

    const keywords = this.getDeleteKeywords();

    while (elapsed < maxWaitTime) {
      // Strategy 1: Look for button with data-test-id containing "confirm" or "delete"
      const confirmByTestId = document.querySelector(
        '[data-test-id*="confirm"], [data-test-id*="delete"]:not([data-test-id="delete-button"])',
      ) as HTMLElement;
      if (confirmByTestId && this.isVisibleElement(confirmByTestId)) {
        confirmByTestId.click();
        debug('log', 'Clicked confirmation button (by test-id)');
        return;
      }

      // Strategy 2: Look for primary/action buttons in dialogs
      const primaryButtons = document.querySelectorAll(`
        .mat-mdc-dialog-container button.mat-primary,
        .mat-mdc-dialog-container button.mat-accent,
        .mat-mdc-dialog-container .mat-mdc-dialog-actions button:last-child,
        .cdk-overlay-container .mat-mdc-dialog-actions button:last-child,
        .cdk-overlay-container button[color="primary"],
        .cdk-overlay-container button[color="warn"]
      `);

      for (const btn of primaryButtons) {
        if (this.isVisibleElement(btn as HTMLElement)) {
          const text = btn.textContent?.toLowerCase().trim() || '';
          // Match keywords from i18n
          if (
            text &&
            keywords.some((keyword: string) => text.includes(keyword) || text === keyword)
          ) {
            (btn as HTMLElement).click();
            debug('log', 'Clicked confirmation button (primary button):', text);
            return;
          }
        }
      }

      // Strategy 3: Look for any button in overlay with delete/confirm text
      const allOverlayButtons = document.querySelectorAll(
        '.cdk-overlay-container button, .mat-mdc-dialog-container button',
      );

      for (const btn of allOverlayButtons) {
        if (!this.isVisibleElement(btn as HTMLElement)) continue;

        const text = btn.textContent?.toLowerCase().trim() || '';
        // Be more specific - look for exact match or simple inclusion for keywords
        if (text && keywords.some((keyword: string) => text === keyword)) {
          (btn as HTMLElement).click();
          debug('log', 'Clicked confirmation button (overlay button):', text);
          return;
        }
      }

      // Strategy 4: Look for the second/right button in a two-button dialog (usually the confirm button)
      const dialogActions = document.querySelector(
        '.mat-mdc-dialog-actions, .cdk-overlay-container .mat-dialog-actions',
      );
      if (dialogActions) {
        const buttons = dialogActions.querySelectorAll('button');
        if (buttons.length >= 2) {
          // The last button is typically the confirm/destructive action
          const confirmBtn = buttons[buttons.length - 1] as HTMLElement;
          if (this.isVisibleElement(confirmBtn)) {
            confirmBtn.click();
            debug('log', 'Clicked last button in dialog actions');
            return;
          }
        }
      }

      await this.delay(checkInterval);
      elapsed += checkInterval;
    }

    // No confirmation dialog found, which is fine
    debug('log', 'No confirmation dialog detected after', maxWaitTime, 'ms');
  }

  /**
   * Get delete/confirm keywords from i18n settings to avoid hardcoding
   */
  private getDeleteKeywords(): string[] {
    const rawPatterns = getTranslationSyncUnsafe('batch_delete_match_patterns') || '';
    // Split on both ASCII and CJK fullwidth commas (and a couple of common
    // separators) so locales authored with `，` / `、` / `；` don't end up as
    // one giant unsplittable string.
    return rawPatterns
      .split(/[,，、；;]+/)
      .map((s: string) => s.trim().toLowerCase())
      .filter((s: string) => s.length > 0);
  }

  /**
   * Check if an element is visible
   */
  private isVisibleElement(el: HTMLElement): boolean {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      el.offsetParent !== null
    );
  }

  /**
   * Click backdrop to close any open menu
   */
  private clickBackdropToCloseMenu(): void {
    const backdrop = document.querySelector('.cdk-overlay-backdrop') as HTMLElement;
    if (backdrop) {
      backdrop.click();
      debug('log', 'Clicked backdrop to close menu');
    }
  }

  /**
   * Helper function to create a delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
