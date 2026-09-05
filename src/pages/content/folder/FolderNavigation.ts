import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';

import { watchRouteChanges } from '../utils/routeWatcher';
import {
  buildConversationUrlFromId,
  findNativeConversationLinkById,
  getCurrentConversationId,
  getCurrentHexIdFromLocation,
  normalizeConversationId,
  resolveConversationRouteId,
  syncConversationTitleFromNative,
  triggerNativeConversationClick,
} from './nativeSidebarDom';
import type { ConversationReference } from './types';

const FOLDER_NAVIGATION_CONFIRM_DELAY_MS = 1200;

interface FolderNavigationOptions {
  getContext(): {
    container: HTMLElement | null;
    sidebar: HTMLElement | null;
    isDestroyed: boolean;
    accountIsolationEnabled: boolean;
  };
  onRouteChange(): void;
  onOpened(conversationId: string): void;
  onTitleChange(conversationId: string, title: string): void;
  onGemDetected(conversationId: string, gemId: string): void;
}

function debug(...args: unknown[]): void {
  try {
    if (localStorage.getItem('gvFolderDebug') === '1') console.log('[FolderManager]', ...args);
  } catch {
    /* Debugging must not affect navigation. */
  }
}

/** Owns native-first navigation and the listeners that track its active folder row. */
export class FolderNavigation {
  private activeFolderConversationKey: string | null = null;
  private folderNavigationConfirmTimer: number | null = null;
  private lastPathname: string | null = null;
  private routeChangeCleanup: (() => void) | null = null;
  private sidebarClickListener: ((event: Event) => void) | null = null;
  private boundSidebar: HTMLElement | null = null;
  private readonly timers = new Set<number>();

  constructor(private readonly options: FolderNavigationOptions) {}

  bind(): void {
    this.unbind();
    this.installRouteChangeListener();
    this.installSidebarClickListener();
  }

  /** A sidebar remount replaces listeners but keeps an in-progress navigation. */
  unbind(): void {
    try {
      this.routeChangeCleanup?.();
    } catch (error) {
      debug('Route change cleanup failed:', error);
    }
    this.routeChangeCleanup = null;
    if (this.sidebarClickListener) {
      this.boundSidebar?.removeEventListener('click', this.sidebarClickListener, true);
    }
    this.sidebarClickListener = null;
    this.boundSidebar = null;
  }

  /** Account changes invalidate both the fallback route and delayed page metadata. */
  cancel(): void {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    this.folderNavigationConfirmTimer = null;
    this.activeFolderConversationKey = null;
  }

  destroy(): void {
    this.unbind();
    this.cancel();
  }

  private schedule(callback: () => void, delay: number): number {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      if (!this.options.getContext().isDestroyed) callback();
    }, delay);
    this.timers.add(timer);
    return timer;
  }

  private checkGem(conversationId: string): void {
    this.schedule(() => {
      const gemId = window.location.pathname.match(/\/gem\/([^/]+)/)?.[1];
      if (gemId) this.options.onGemDetected(conversationId, gemId);
    }, 500);
  }

  getConversationHref(conversation: ConversationReference): string {
    const routeId = resolveConversationRouteId(conversation.url, conversation.conversationId);

    try {
      const storedUrl = new URL(conversation.url, window.location.origin);

      if (this.options.getContext().accountIsolationEnabled && routeId) {
        const currentUserMatch = window.location.pathname.match(/\/u\/(\d+)\//);
        const accountPrefix = currentUserMatch ? `/u/${currentUserMatch[1]}` : '';
        return `${storedUrl.origin}${accountPrefix}/app/${routeId}${storedUrl.search}`;
      }

      return storedUrl.toString();
    } catch (error) {
      debug('Failed to build folder conversation href:', error);
    }

    return routeId
      ? buildConversationUrlFromId(routeId, this.options.getContext().accountIsolationEnabled)
      : window.location.href;
  }

  private getInstanceKey(folderId: string, conversationId: string): string {
    return `${folderId}:${conversationId}`;
  }

  highlightActiveConversation(): void {
    const container = this.options.getContext().container;
    if (!container) return;
    const hex = getCurrentHexIdFromLocation();
    const currentId = normalizeConversationId(hex);
    const rows = Array.from(container.querySelectorAll<HTMLElement>('.gv-folder-conversation'));

    rows.forEach((row) => row.classList.remove('gv-folder-conversation-selected'));
    if (!currentId) return;

    const matches = rows.filter((row) => {
      const link = row.querySelector<HTMLAnchorElement>('a.gv-folder-conversation-link[href]');
      return resolveConversationRouteId(link?.href, row.dataset.conversationId) === currentId;
    });
    const activeRow =
      matches.find(
        (row) =>
          row.dataset.folderId &&
          row.dataset.conversationId &&
          this.getInstanceKey(row.dataset.folderId, row.dataset.conversationId) ===
            this.activeFolderConversationKey,
      ) ?? matches[0];

    activeRow?.classList.add('gv-folder-conversation-selected');
  }

  createNewChatInFolder(folderId: string): void {
    const navigate = () => {
      const userPrefix = window.location.pathname.match(/^\/u\/\d+/)?.[0] ?? '';
      const targetPath = `${userPrefix}/app`;
      if (
        window.location.pathname === targetPath ||
        window.location.pathname === `${targetPath}/`
      ) {
        // Already on the new-chat page. The Folder-as-Project picker only
        // consumes the pending folder id when it (re)injects, and its URL
        // watcher cannot observe a same-URL pushState, so an SPA "navigation"
        // here would be a silent no-op. A full reload is the only way to
        // re-run picker injection — accepted as the explicit reload exception
        // to the no-full-refresh navigation rule.
        window.location.reload();
        return;
      }
      // Preferred path: SPA route change (History API + popstate), same helper
      // the folder conversation navigation uses. folderProject's URL watcher
      // picks this up, re-injects the picker, and applies the pending folder.
      if (this.navigateWithSpaRoute(`${window.location.origin}${targetPath}`)) {
        return;
      }
      // Last-resort fallback: the History API path failed (pushState threw).
      // A full page load is acceptable here because the alternative is a dead
      // menu item — this mirrors the rule's History-API-then-fallback order.
      window.location.href = `${window.location.origin}${targetPath}`;
    };

    browser.storage.local
      .set({ [StorageKeys.FOLDER_PROJECT_PENDING_FOLDER_ID]: folderId })
      .then(navigate)
      .catch((error) => {
        if (isExtensionContextInvalidatedError(error)) return;
        // storage failed — still navigate so the user isn't stranded; they can pick the folder manually
        console.warn('[folder] failed to set pending folder ID', error);
        navigate();
      });
  }

  private navigateWithSpaRoute(url: string): boolean {
    try {
      const targetUrl = new URL(url, window.location.origin);
      window.history.pushState({}, '', `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`);
      const event =
        typeof PopStateEvent === 'function'
          ? new PopStateEvent('popstate', { state: window.history.state })
          : new Event('popstate');
      window.dispatchEvent(event);
      return true;
    } catch (error) {
      debug('SPA route navigation failed:', error);
      return false;
    }
  }

  private clearConfirmation(): void {
    if (this.folderNavigationConfirmTimer === null) return;
    window.clearTimeout(this.folderNavigationConfirmTimer);
    this.timers.delete(this.folderNavigationConfirmTimer);
    this.folderNavigationConfirmTimer = null;
  }

  navigate(conversation: ConversationReference, folderId?: string): void {
    const url = conversation.url;
    if (folderId !== undefined) {
      this.activeFolderConversationKey = this.getInstanceKey(folderId, conversation.conversationId);
    }
    // A newer folder click supersedes any delayed fallback from an older one.
    this.clearConfirmation();

    // Use History API to navigate without page reload (SPA-style)
    // This mimics how Gemini's original conversation links work
    try {
      const targetUrl = new URL(url);
      const hexId = resolveConversationRouteId(targetUrl.toString(), conversation?.conversationId);
      const currentConversationId = getCurrentConversationId();

      let effectivePath: string | null = null;
      let effectiveUrl: string | null = null;

      if (this.options.getContext().accountIsolationEnabled && hexId) {
        // In hard isolation mode, build a navigation URL that matches the
        // current account context:
        // - If the current path contains /u/{num}/, reuse that {num}
        // - Otherwise navigate to /app/{hexId} directly
        // This prevents us from reusing stale /u/{num} segments from previously
        // saved URLs when the active account index has changed.
        const currentPath = window.location.pathname;
        const currentUserMatch = currentPath.match(/\/u\/(\d+)\//);
        if (currentUserMatch) {
          effectivePath = `/u/${currentUserMatch[1]}/app/${hexId}`;
        } else {
          effectivePath = `/app/${hexId}`;
        }
        effectiveUrl = `${window.location.origin}${effectivePath}${targetUrl.search}`;
      }

      const navigationUrl =
        this.options.getContext().accountIsolationEnabled && effectiveUrl ? effectiveUrl : url;
      const finishNavigation = () => {
        this.highlightActiveConversation();

        // After navigation, sync title and check for gem updates
        this.schedule(() => {
          if (conversation && hexId) {
            const syncedTitle = syncConversationTitleFromNative(hexId);
            if (syncedTitle && syncedTitle !== conversation.title) {
              this.options.onTitleChange(hexId, syncedTitle);
              debug('Updated conversation title after navigation:', syncedTitle);
            }
          }

          if (conversation && hexId && !conversation.gemId) {
            this.checkGem(hexId);
          } else if (conversation?.gemId) {
            debug('Known gem conversation:', conversation.gemId);
          }
        }, 300);
      };
      const spaNavigate = () => {
        if (hexId) {
          this.options.onOpened(hexId);
        }

        if (this.navigateWithSpaRoute(navigationUrl)) {
          finishNavigation();
        }
      };

      if (hexId && currentConversationId === hexId) {
        this.highlightActiveConversation();
        return;
      }

      const sidebarLink = hexId ? findNativeConversationLinkById(hexId) : null;
      if (!sidebarLink) {
        debug('Sidebar link not found, falling back to SPA route navigation');
        spaNavigate();
        return;
      }

      triggerNativeConversationClick(sidebarLink);
      debug('Triggered native sidebar link click');

      this.folderNavigationConfirmTimer = this.schedule(() => {
        this.folderNavigationConfirmTimer = null;
        if (!hexId || getCurrentConversationId() === hexId) {
          finishNavigation();
          return;
        }

        debug('Native sidebar click did not navigate, falling back to SPA route navigation');
        spaNavigate();
      }, FOLDER_NAVIGATION_CONFIRM_DELAY_MS);
    } catch (error) {
      console.error('[FolderManager] Navigation error:', error);
    }
  }

  private installRouteChangeListener(): void {
    const update = () => {
      if (this.options.getContext().isDestroyed) return;
      this.schedule(() => {
        void this.options.onRouteChange();
        this.highlightActiveConversation();
        const currentConversationId = getCurrentConversationId();
        if (currentConversationId) {
          this.options.onOpened(currentConversationId);
        }
      }, 0);
    };

    const cleanupFns: (() => void)[] = [];

    try {
      window.addEventListener('popstate', update);
      cleanupFns.push(() => window.removeEventListener('popstate', update));
    } catch (e) {
      debug('Failed to add popstate listener:', e);
    }

    try {
      const hist = history as History & Record<string, unknown>;
      const originalPushState = hist.pushState;
      const originalReplaceState = hist.replaceState;

      const wrap = (
        method: 'pushState' | 'replaceState',
        original: (...args: unknown[]) => unknown,
      ) => {
        hist[method] = function (...args: unknown[]) {
          const ret = original.apply(this, args);
          try {
            update();
          } catch {
            /* Ignore - update is non-critical */
          }
          return ret;
        };
      };
      wrap('pushState', originalPushState as (...args: unknown[]) => unknown);
      wrap('replaceState', originalReplaceState as (...args: unknown[]) => unknown);

      cleanupFns.push(() => {
        hist.pushState = originalPushState;
        hist.replaceState = originalReplaceState;
      });
    } catch (e) {
      debug('Failed to wrap history methods:', e);
    }

    // Shared fallback for routers/flows that don't emit events.
    try {
      this.lastPathname = window.location.pathname;
      cleanupFns.push(
        watchRouteChanges(() => {
          if (this.options.getContext().isDestroyed) return;
          const now = window.location.pathname;
          if (now !== this.lastPathname) {
            this.lastPathname = now;
            update();
          }
        }),
      );
    } catch (e) {
      debug('Failed to setup navigation watcher:', e);
    }

    this.routeChangeCleanup = () => {
      cleanupFns.forEach((fn) => fn());
    };
  }

  private installSidebarClickListener(): void {
    // Capture clicks in Gemini's native sidebar and update highlight after navigation happens
    const root = this.options.getContext().sidebar;
    if (!root) return;

    this.sidebarClickListener = (e: Event) => {
      if (this.options.getContext().isDestroyed) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const a = target.closest('a[href*="/app/"], a[href*="/gem/"]') as HTMLAnchorElement | null;
      if (a) {
        this.schedule(() => this.highlightActiveConversation(), 0);
      }
    };

    this.boundSidebar = root;
    try {
      root.addEventListener('click', this.sidebarClickListener, true);
    } catch (e) {
      debug('Failed to add sidebar click listener:', e);
    }
  }
}
