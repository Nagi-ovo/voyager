import type { ConversationSortMode } from '@/features/folder/model/folderData';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';

import type { FolderFeedback } from './FolderFeedback';
import type { FolderNavigation } from './FolderNavigation';
import type { FolderSidebarRuntime } from './FolderSidebarRuntime';
import type { FolderStore } from './FolderStore';
import type { NativeConversationMenus } from './NativeConversationMenus';
import {
  extractConversationData,
  extractConversationId,
  extractNativeDragTitle,
  getNativeConversationElements,
} from './nativeSidebarDom';
import type { ConversationReference, DragData, Folder } from './types';

const ROOT_CONVERSATIONS_ID = '__root_conversations__';
type ConversationReorderPlacement = 'above' | 'below';

interface ConversationReorderTarget {
  element: HTMLElement;
  placement: ConversationReorderPlacement;
}

interface FolderSelectionOptions {
  store: FolderStore;
  runtime: FolderSidebarRuntime;
  navigation: FolderNavigation;
  feedback: FolderFeedback;
  nativeMenus: NativeConversationMenus;
  getContext(): {
    sortMode: ConversationSortMode;
    accountIsolationEnabled: boolean;
    isDestroyed: boolean;
  };
}

function debug(level: 'log' | 'warn', ...args: unknown[]): void {
  try {
    if (localStorage.getItem('gvFolderDebug') === '1') console[level]('[FolderManager]', ...args);
  } catch {
    /* Debugging must not affect interaction. */
  }
}

/** Shares selection, drag state and batch actions across native and folder rows. */
export class FolderSelection {
  private selectedConversations: Set<string> = new Set();
  private isMultiSelectMode: boolean = false;
  private multiSelectSource: 'folder' | 'native' | null = null;
  private multiSelectFolderId: string | null = null;
  private longPressTimeout: number | null = null;
  private longPressThreshold: number = 500;
  private pendingConversationReorderTarget: ConversationReorderTarget | null = null;
  private activeConversationReorderTarget: ConversationReorderTarget | null = null;
  private conversationReorderRafId: number | null = null;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private readonly MAX_BATCH_DELETE_COUNT = 50;
  private batchDeleteInProgress = false;
  private readonly BATCH_DELETE_CONFIG = {
    DELAY_BETWEEN_DELETIONS: 500, // Delay between each deletion to avoid rate limiting
    PAGE_REFRESH_DELAY: 1500, // Delay before refreshing page after batch delete
  } as const;
  private multiSelectHostElement: HTMLElement | null = null;
  private readonly toolbarCleanups = new Map<HTMLElement, () => void>();
  private readonly timers = new Set<number>();
  private readonly dragImages = new Set<HTMLElement>();

  constructor(private readonly options: FolderSelectionOptions) {}

  private schedule(callback: () => void, delay: number): number {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      if (!this.options.getContext().isDestroyed) callback();
    }, delay);
    this.timers.add(timer);
    return timer;
  }

  private clearTimer(timer: number): void {
    window.clearTimeout(timer);
    this.timers.delete(timer);
  }

  /** Remove listeners attached to the old toolbar during a sidebar remount. */
  unmount(): void {
    for (const cleanup of this.toolbarCleanups.values()) cleanup();
    this.toolbarCleanups.clear();
  }

  removeFloatingHost(): void {
    for (const [indicator, cleanup] of this.toolbarCleanups) {
      if (this.multiSelectHostElement?.contains(indicator)) {
        cleanup();
        this.toolbarCleanups.delete(indicator);
      }
    }
    this.multiSelectHostElement?.remove();
    this.multiSelectHostElement = null;
  }

  reset(): void {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    for (const image of this.dragImages) image.remove();
    this.dragImages.clear();
    if (this.longPressTimeout !== null) this.clearTimer(this.longPressTimeout);
    this.longPressTimeout = null;
    this.clearConversationReorderIndicator();
    this.exitMultiSelectMode();
    this.removeFloatingHost();
  }

  createMultiSelectIndicator(): HTMLElement {
    const indicator = document.createElement('div');
    indicator.className = 'gv-multi-select-indicator';
    indicator.dataset.multiSelectIndicator = 'true';

    // Apply floating styles
    Object.assign(indicator.style, {
      position: 'fixed',
      bottom: '24px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '9999', // Ensure it's above everything
      boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
      cursor: 'move', // Indicate it's draggable
      transition: 'opacity 0.2s ease, transform 0.1s ease', // Only animate non-position props for performance
      // Prevent text selection while dragging
      userSelect: 'none',
      // Ensure it has a background so IT covers content behind it
      backgroundColor: 'var(--gem-sys-color-surface-container, #f0f4f9)', // Fallback color
      borderRadius: '24px',
      padding: '8px 16px',
      alignItems: 'center',
      gap: '12px',
      border: '1px solid var(--gem-sys-color-outline-variant, rgba(0,0,0,0.1))',
    });

    // --- Draggable Logic Start ---
    let isDragging = false;
    let currentX: number;
    let currentY: number;
    let initialX: number;
    let initialY: number;
    let xOffset = 0;
    let yOffset = 0;

    // Document-level mousemove/mouseup are attached only while a drag is in
    // progress (mousedown → mouseup). Attaching them permanently leaked one
    // listener pair per floating-mode/sidebar-mode switch, because that switch
    // path rebuilds the indicator without running the cleanup task list.
    const drag = (e: MouseEvent) => {
      if (isDragging) {
        e.preventDefault();
        currentX = e.clientX - initialX;
        currentY = e.clientY - initialY;

        xOffset = currentX;
        yOffset = currentY;

        setTranslate(currentX, currentY, indicator);
      }
    };

    const dragEnd = () => {
      isDragging = false;
      indicator.style.cursor = 'move';
      document.removeEventListener('mousemove', drag);
      document.removeEventListener('mouseup', dragEnd);
    };

    const dragStart = (e: MouseEvent) => {
      // Ignore if clicking buttons inside the indicator
      if ((e.target as HTMLElement).closest('button')) return;

      initialX = e.clientX - xOffset;
      initialY = e.clientY - yOffset;

      if (e.target === indicator || indicator.contains(e.target as Node)) {
        isDragging = true;
        indicator.style.cursor = 'grabbing';
        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', dragEnd);
      }
    };

    const setTranslate = (xPos: number, yPos: number, el: HTMLElement) => {
      el.style.transform = `translate3d(calc(-50% + ${xPos}px), ${yPos}px, 0)`;
    };

    indicator.addEventListener('mousedown', dragStart);

    // Belt-and-suspenders: if the indicator is torn down mid-drag, make sure
    // the document-level listeners can't outlive it. removeEventListener is
    // idempotent, so this is safe even when no drag is active.
    this.toolbarCleanups.set(indicator, () => {
      indicator.removeEventListener('mousedown', dragStart);
      document.removeEventListener('mousemove', drag);
      document.removeEventListener('mouseup', dragEnd);
    });
    // --- Draggable Logic End ---

    const content = document.createElement('div');
    content.className = 'gv-multi-select-indicator-content';
    // Ensure content (text/icon) doesn't capture drag events aggressively
    content.style.pointerEvents = 'none';

    const icon = document.createElement('mat-icon');
    icon.className = 'mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color';
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'check_circle';

    const text = document.createElement('span');
    text.className = 'gv-multi-select-indicator-text';
    text.textContent = '0 selected';
    text.dataset.selectionCount = 'true';

    content.appendChild(icon);
    content.appendChild(text);
    indicator.appendChild(content);

    // Actions container (will be populated dynamically)
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'gv-multi-select-actions';
    actionsContainer.dataset.multiSelectActions = 'true';
    // Re-enable pointer events for buttons
    actionsContainer.style.pointerEvents = 'auto';
    indicator.appendChild(actionsContainer);

    return indicator;
  }

  private getMultiSelectHost(): HTMLElement | null {
    if (this.options.runtime.panel?.isConnected) {
      return this.options.runtime.panel;
    }

    if (!this.multiSelectHostElement?.isConnected) {
      const host = document.createElement('div');
      host.className = 'gv-folder-container gv-multi-select-floating-host';
      host.dataset.multiSelectFloatingHost = 'true';
      host.appendChild(this.createMultiSelectIndicator());
      document.body.appendChild(host);
      this.multiSelectHostElement = host;
    }

    return this.multiSelectHostElement;
  }

  private getExistingMultiSelectHost(): HTMLElement | null {
    if (this.options.runtime.panel?.isConnected) {
      return this.options.runtime.panel;
    }

    return this.multiSelectHostElement?.isConnected ? this.multiSelectHostElement : null;
  }

  setupDropZone(element: HTMLElement, folderId: string): void {
    element.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation(); // Prevent root drop zone from also highlighting
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      element.classList.add('gv-folder-dragover');
    });

    element.addEventListener('dragleave', (e) => {
      // Only remove highlight when cursor truly leaves the element (not just entering a child)
      const rect = element.getBoundingClientRect();
      const x = (e as DragEvent).clientX;
      const y = (e as DragEvent).clientY;

      if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
        element.classList.remove('gv-folder-dragover');
      }
    });

    element.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation(); // CRITICAL: Prevent event bubbling to root drop zone
      element.classList.remove('gv-folder-dragover');

      const data = e.dataTransfer?.getData('application/json');
      if (!data) return;

      try {
        const dragData: DragData = JSON.parse(data);

        if (
          this.options.getContext().sortMode === 'recent' &&
          dragData.type !== 'folder' &&
          dragData.sourceFolderId === folderId
        ) {
          this.options.feedback.showNotification(t('folder_sort_recent_drag_hint'), 'info');
          this.exitMultiSelectMode();
          return;
        }

        // Pre-cleanup: Restore opacity immediately before processing drop
        // This prevents visual artifacts if dragend doesn't fire properly
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '1';
        });

        // Handle different drag types
        if (dragData.type === 'folder') {
          // Handle folder drop
          debug('log', 'Dropping folder into folder:', dragData.title, '→', folderId);
          this.options.store.addFolderToFolder(folderId, dragData);
        } else {
          // Handle conversation drop - supports both single and multiple conversations
          if (dragData.conversations && dragData.conversations.length > 0) {
            // Multi-select drag
            debug('log', 'Dropping multiple conversations:', dragData.conversations.length);
            this.options.store.addConversationsToFolder(
              folderId,
              dragData.conversations,
              dragData.sourceFolderId,
            );
          } else {
            // Legacy single conversation drag (backward compatibility)
            this.options.store.addConversationToFolder(folderId, dragData);
          }
        }

        // Clear selection and exit multi-select mode after successful drop
        this.exitMultiSelectMode();
      } catch (error) {
        console.error('[FolderManager] Drop error:', error);
      }
    });
  }

  setupRootDropZone(element: HTMLElement): void {
    element.addEventListener('dragover', (e) => {
      // Allow both folder and conversation drops on the root zone
      const data = e.dataTransfer?.types.includes('application/json');
      if (!data) return;

      e.preventDefault();
      e.stopPropagation(); // Prevent parent handlers from firing
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      element.classList.add('gv-folder-list-dragover');
    });

    element.addEventListener('dragleave', (e) => {
      // Check if we're leaving this element (not just entering a child)
      const rect = element.getBoundingClientRect();
      const x = (e as DragEvent).clientX;
      const y = (e as DragEvent).clientY;

      if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
        element.classList.remove('gv-folder-list-dragover');
      }
    });

    element.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation(); // Prevent parent handlers from firing
      element.classList.remove('gv-folder-list-dragover');

      const data = e.dataTransfer?.getData('application/json');
      if (!data) return;

      try {
        const dragData: DragData = JSON.parse(data);

        if (
          this.options.getContext().sortMode === 'recent' &&
          dragData.type !== 'folder' &&
          dragData.sourceFolderId === ROOT_CONVERSATIONS_ID
        ) {
          this.options.feedback.showNotification(t('folder_sort_recent_drag_hint'), 'info');
          this.exitMultiSelectMode();
          return;
        }

        // Pre-cleanup: Restore opacity immediately before processing drop
        // This prevents visual artifacts if dragend doesn't fire properly
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '1';
        });

        // Handle different drag types at root level
        if (dragData.type === 'folder') {
          this.options.store.moveFolderToRoot(dragData);
        } else {
          // Handle conversation drop - supports both single and multiple conversations
          if (dragData.conversations && dragData.conversations.length > 0) {
            // Multi-select drag
            debug(
              'log',
              'Adding multiple conversations to root level:',
              dragData.conversations.length,
            );
            this.options.store.addConversationsToFolder(
              ROOT_CONVERSATIONS_ID,
              dragData.conversations,
              dragData.sourceFolderId,
            );
          } else {
            // Legacy single conversation drag (backward compatibility)
            debug('log', 'Adding conversation to root level:', dragData.title);
            this.options.store.addConversationToFolder(ROOT_CONVERSATIONS_ID, dragData);
          }
        }

        // Clear selection and exit multi-select mode after successful drop
        this.exitMultiSelectMode();
      } catch (error) {
        console.error('[FolderManager] Root drop error:', error);
      }
    });
  }

  private canFolderBeDragged(folder: Folder): boolean {
    return !folder.pinned;
  }

  applyFolderDraggableBehavior(element: HTMLElement, folder: Folder): void {
    if (this.canFolderBeDragged(folder)) {
      this.enableFolderDragging(element, folder);
    } else {
      this.disableFolderDragging(element);
    }
  }

  private enableFolderDragging(element: HTMLElement, folder: Folder): void {
    // Mark element as draggable
    element.draggable = true;
    element.style.cursor = 'grab';

    // Check if drag listeners are already attached
    if (element.dataset.dragListenersAttached === 'true') {
      debug('log', 'Drag listeners already attached for folder:', folder.name);
      return;
    }

    // Create named event handler functions for proper cleanup
    const handleDragStart = (e: Event) => {
      e.stopPropagation(); // Prevent parent folder from being dragged

      const dragData: DragData = {
        type: 'folder',
        folderId: folder.id,
        title: folder.name,
      };

      const dt = (e as DragEvent).dataTransfer;
      if (dt) dt.effectAllowed = 'move';
      dt?.setData('application/json', JSON.stringify(dragData));
      element.style.opacity = '0.5';

      debug(
        'log',
        'Folder drag start:',
        folder.name,
        'canBeDragged:',
        this.canFolderBeDragged(folder),
      );
    };

    const handleDragEnd = () => {
      element.style.opacity = '1';
    };

    // Store references for potential cleanup
    type DragEl = Element & {
      _dragStartHandler?: (e: Event) => void;
      _dragEndHandler?: () => void;
    };
    (element as DragEl)._dragStartHandler = handleDragStart;
    (element as DragEl)._dragEndHandler = handleDragEnd;

    // Add drag event listeners
    element.addEventListener('dragstart', handleDragStart);
    element.addEventListener('dragend', handleDragEnd);

    // Mark that listeners are attached
    element.dataset.dragListenersAttached = 'true';
  }

  private disableFolderDragging(element: HTMLElement): void {
    element.draggable = false;
    element.style.cursor = '';

    // Remove drag event listeners if they exist
    if (element.dataset.dragListenersAttached === 'true') {
      type DragEl = Element & {
        _dragStartHandler?: (e: Event) => void;
        _dragEndHandler?: () => void;
      };
      const dragStartHandler = (element as DragEl)._dragStartHandler;
      const dragEndHandler = (element as DragEl)._dragEndHandler;

      if (dragStartHandler) {
        element.removeEventListener('dragstart', dragStartHandler);
        delete (element as DragEl)._dragStartHandler;
      }

      if (dragEndHandler) {
        element.removeEventListener('dragend', dragEndHandler);
        delete (element as DragEl)._dragEndHandler;
      }

      delete element.dataset.dragListenersAttached;
    }
  }

  makeConversationDraggable(element: HTMLElement): void {
    // Idempotency guard — the method can legitimately be called more than once
    // per element (e.g. sidebar success path + document sweep on fallback,
    // MutationObserver re-entry, route change re-scans). Without this guard
    // we'd stack duplicate mousedown / dragstart listeners on every call.
    if (element.dataset.gvConvDragAttached === 'true') return;
    element.dataset.gvConvDragAttached = 'true';

    element.draggable = true;
    element.style.cursor = 'grab';

    // Long-press detection for entering multi-select mode
    let longPressTriggered = false;
    let longPressTimeoutId: number | null = null;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // Only left mouse button
      longPressTriggered = false;

      const conversationId = extractConversationId(element);

      longPressTimeoutId = this.schedule(() => {
        longPressTriggered = true;
        this.enterMultiSelectMode(conversationId, 'native');
        // Add visual feedback to this element
        element.classList.add('gv-conversation-selected');
      }, this.longPressThreshold);
    };

    const handleMouseUp = () => {
      if (longPressTimeoutId) {
        this.clearTimer(longPressTimeoutId);
        longPressTimeoutId = null;
      }
    };

    const handleMouseLeave = () => {
      if (longPressTimeoutId) {
        this.clearTimer(longPressTimeoutId);
        longPressTimeoutId = null;
      }
    };

    // Add event listeners
    element.addEventListener('mousedown', handleMouseDown);
    element.addEventListener('mouseup', handleMouseUp);
    element.addEventListener('mouseleave', handleMouseLeave);

    // Click handler for multi-select mode
    element.addEventListener(
      'click',
      (e) => {
        // Never swallow clicks on the trailing ⋮ menu button — those need to
        // open the per-row actions menu (rename / delete / move / etc.).
        // Without this guard, our capture-phase stopPropagation below silently
        // kills the menu trigger during programmatic batch-delete (the
        // moreButton.click() never reaches Material's menu, so the menu never
        // opens and waitForDeleteButtonAndClick times out at 3s every row).
        if (
          e.target instanceof Element &&
          e.target.closest(
            '[data-test-id="actions-menu-button"], [data-test-id="conversation-actions-menu-icon-button"]',
          )
        ) {
          return;
        }

        // Programmatic batch delete drives Gemini's own menu via .click() — let
        // every click through unimpeded for the duration of the batch.
        if (this.batchDeleteInProgress) {
          return;
        }

        // Prevent navigation if long-press was triggered
        if (longPressTriggered) {
          e.preventDefault();
          e.stopPropagation();
          longPressTriggered = false;
          return;
        }

        if (this.isMultiSelectMode) {
          // Multi-select mode: toggle selection
          e.preventDefault();
          e.stopPropagation();
          const conversationId = extractConversationId(element);
          this.toggleConversationSelection(conversationId);

          // Update visual state
          if (this.selectedConversations.has(conversationId)) {
            element.classList.add('gv-conversation-selected');
          } else {
            element.classList.remove('gv-conversation-selected');
          }

          this.updateConversationSelectionUI();
          return;
        }
      },
      true,
    ); // Use capture phase to intercept before navigation

    element.addEventListener('dragstart', (e) => {
      const conversationId = extractConversationId(element);
      const title = extractNativeDragTitle(element, conversationId);

      // Extract URL and conversation metadata together
      const conversationData = extractConversationData(
        element,
        this.options.getContext().accountIsolationEnabled,
      );

      // Restrict to move-only to prevent Chrome from triggering split-screen/tab tiling
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';

      // If this conversation is not selected, select it exclusively
      if (!this.selectedConversations.has(conversationId)) {
        this.clearSelection();
        this.selectConversation(conversationId);
        element.classList.add('gv-conversation-selected');
        this.updateConversationSelectionUI();
      }

      // Cancel long press if drag starts
      if (longPressTimeoutId) {
        this.clearTimer(longPressTimeoutId);
        longPressTimeoutId = null;
      }

      // Check if we have multiple selections
      if (this.selectedConversations.size > 1) {
        // Multi-select drag - collect all selected conversations
        const selectedConvs: ConversationReference[] = [];

        this.selectedConversations.forEach((id) => {
          const convEl = this.findConversationElement(id);
          if (convEl) {
            const convTitle = extractNativeDragTitle(convEl, id);
            const convData = extractConversationData(
              convEl,
              this.options.getContext().accountIsolationEnabled,
            );

            selectedConvs.push({
              conversationId: id,
              title: convTitle,
              url: convData.url,
              addedAt: Date.now(),
              isGem: convData.isGem,
              gemId: convData.gemId,
            });
          }
        });

        const dragData: DragData = {
          type: 'conversation',
          title: `${selectedConvs.length} conversations`,
          conversations: selectedConvs,
        };

        e.dataTransfer?.setData('application/json', JSON.stringify(dragData));
        this.setLightweightDragImage(e, `${selectedConvs.length} conversations`);

        // Apply opacity to all selected conversations
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '0.5';
        });
      } else {
        // Single conversation drag (legacy behavior)
        debug('log', 'Drag start:', {
          title,
          isGem: conversationData.isGem,
          gemId: conversationData.gemId,
          url: conversationData.url,
        });

        const dragData: DragData = {
          type: 'conversation',
          conversationId,
          title,
          url: conversationData.url,
          isGem: conversationData.isGem,
          gemId: conversationData.gemId,
        };

        e.dataTransfer?.setData('application/json', JSON.stringify(dragData));
        this.setLightweightDragImage(e, title);
        element.style.opacity = '0.5';
      }
    });

    element.addEventListener('dragend', () => {
      // Restore opacity for all selected conversations
      if (this.selectedConversations.size > 1) {
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '1';
        });
      } else {
        element.style.opacity = '1';
      }

      // If we are not in multi-select mode, clear the temporary selection
      if (!this.isMultiSelectMode) {
        this.clearSelection();
        this.cleanupSelectionArtifacts();
      }
      this.clearConversationReorderIndicator();
    });
  }

  private findConversationElement(conversationId: string): HTMLElement | null {
    // Check in folder conversations
    const folderConv = this.options.runtime.panel?.querySelector(
      `[data-conversation-id="${conversationId}"]`,
    ) as HTMLElement;
    if (folderConv) return folderConv;

    // Check in native conversations (Recent section)
    const nativeConvs = getNativeConversationElements(this.options.runtime.sidebar);
    for (const conv of Array.from(nativeConvs)) {
      const id = extractConversationId(conv as HTMLElement);
      if (id === conversationId) {
        return conv as HTMLElement;
      }
    }

    return null;
  }

  setupConversationReorderZone(convEl: HTMLElement, folderId: string, groupIndex: number): void {
    convEl.addEventListener('dragover', (event) => {
      if (this.options.getContext().sortMode !== 'manual') return;
      if (!event.dataTransfer?.types.includes('application/json')) return;

      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      this.scheduleConversationReorderIndicator(
        convEl,
        this.getConversationReorderPlacement(convEl, event.clientY),
      );
    });

    convEl.addEventListener('dragleave', (event) => {
      const related = event.relatedTarget as Node | null;
      if (!related || !convEl.contains(related)) {
        this.clearConversationReorderIndicator(convEl);
      }
    });

    convEl.addEventListener('drop', (event) => {
      if (this.options.getContext().sortMode !== 'manual') return;

      event.preventDefault();
      event.stopPropagation();

      const placement = this.getConversationReorderDropPlacement(
        convEl,
        this.getConversationReorderPlacement(convEl, event.clientY),
      );
      this.clearConversationReorderIndicator();

      const rawData = event.dataTransfer?.getData('application/json');
      if (!rawData) return;

      try {
        const dragData: DragData = JSON.parse(rawData);
        if (dragData.type !== 'conversation') return;

        this.selectedConversations.forEach((id) => {
          const element = this.findConversationElement(id);
          if (element) element.style.opacity = '1';
        });

        const insertIndex = placement === 'above' ? groupIndex : groupIndex + 1;
        const conversations = dragData.conversations ?? [];
        const sourceFolderId = dragData.sourceFolderId;

        if (!sourceFolderId) {
          this.options.store.ensureConversationsInFolder(folderId, dragData);
        }

        const effectiveSource = sourceFolderId ?? folderId;
        if (conversations.length > 0) {
          this.options.store.reorderOrMoveConversations(
            conversations.map((conversation) => conversation.conversationId),
            effectiveSource,
            folderId,
            insertIndex,
          );
        } else if (dragData.conversationId) {
          this.options.store.reorderOrMoveConversations(
            [dragData.conversationId],
            effectiveSource,
            folderId,
            insertIndex,
          );
        }

        this.exitMultiSelectMode();
      } catch (error) {
        console.error('[FolderManager] Conversation reorder drop error:', error);
      }
    });
  }

  private getConversationReorderPlacement(
    convEl: HTMLElement,
    clientY: number,
  ): ConversationReorderPlacement {
    const rect = convEl.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2 ? 'above' : 'below';
  }

  private getConversationReorderDropPlacement(
    convEl: HTMLElement,
    fallback: ConversationReorderPlacement,
  ): ConversationReorderPlacement {
    if (this.pendingConversationReorderTarget?.element === convEl) {
      return this.pendingConversationReorderTarget.placement;
    }
    if (this.activeConversationReorderTarget?.element === convEl) {
      return this.activeConversationReorderTarget.placement;
    }
    return fallback;
  }

  private scheduleConversationReorderIndicator(
    element: HTMLElement,
    placement: ConversationReorderPlacement,
  ): void {
    this.pendingConversationReorderTarget = { element, placement };
    if (this.conversationReorderRafId !== null) return;

    this.conversationReorderRafId = window.requestAnimationFrame(() => {
      this.conversationReorderRafId = null;
      const target = this.pendingConversationReorderTarget;
      this.pendingConversationReorderTarget = null;
      if (target) this.applyConversationReorderIndicator(target);
    });
  }

  private applyConversationReorderIndicator(target: ConversationReorderTarget): void {
    if (!target.element.isConnected) {
      this.clearConversationReorderIndicator(target.element);
      return;
    }

    const active = this.activeConversationReorderTarget;
    if (active && (active.element !== target.element || active.placement !== target.placement)) {
      active.element.classList.remove('gv-reorder-above', 'gv-reorder-below');
    }

    target.element.classList.toggle('gv-reorder-above', target.placement === 'above');
    target.element.classList.toggle('gv-reorder-below', target.placement === 'below');
    this.activeConversationReorderTarget = target;
  }

  clearConversationReorderIndicator(element?: HTMLElement): void {
    if (!element) {
      if (this.conversationReorderRafId !== null) {
        window.cancelAnimationFrame(this.conversationReorderRafId);
        this.conversationReorderRafId = null;
      }
      this.pendingConversationReorderTarget = null;
    } else if (this.pendingConversationReorderTarget?.element === element) {
      this.pendingConversationReorderTarget = null;
      if (this.conversationReorderRafId !== null) {
        window.cancelAnimationFrame(this.conversationReorderRafId);
        this.conversationReorderRafId = null;
      }
    }

    if (!element || this.activeConversationReorderTarget?.element === element) {
      this.activeConversationReorderTarget?.element.classList.remove(
        'gv-reorder-above',
        'gv-reorder-below',
      );
      this.activeConversationReorderTarget = null;
    }
  }

  private setLightweightDragImage(event: DragEvent, label: string): void {
    const transfer = event.dataTransfer;
    if (!transfer || typeof transfer.setDragImage !== 'function') return;

    const dragImage = document.createElement('div');
    dragImage.className = 'gv-folder-drag-image';
    dragImage.textContent = label;
    document.body.appendChild(dragImage);

    try {
      transfer.setDragImage(dragImage, 12, 12);
    } catch {
      dragImage.remove();
      return;
    }

    this.dragImages.add(dragImage);
    this.schedule(() => {
      dragImage.remove();
      this.dragImages.delete(dragImage);
    }, 0);
  }

  createReorderGap(
    parentId: string,
    itemType: 'folder' | 'conversation',
    insertIndex: number,
  ): HTMLElement {
    const gap = document.createElement('div');
    gap.className = 'gv-reorder-gap';
    gap.dataset.parentId = parentId;
    gap.dataset.itemType = itemType;
    gap.dataset.insertIndex = insertIndex.toString();

    gap.addEventListener('dragover', (e) => {
      const data = e.dataTransfer?.types.includes('application/json');
      if (!data) return;

      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      gap.classList.add('gv-reorder-gap-active');
    });

    gap.addEventListener('dragleave', () => {
      gap.classList.remove('gv-reorder-gap-active');
    });

    gap.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      gap.classList.remove('gv-reorder-gap-active');

      const rawData = e.dataTransfer?.getData('application/json');
      if (!rawData) return;

      try {
        const dragData: DragData = JSON.parse(rawData);

        // Restore opacity for selected conversations
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '1';
        });

        if (itemType === 'folder' && dragData.type === 'folder' && dragData.folderId) {
          this.options.store.reorderFolder(dragData.folderId, parentId, insertIndex);
        } else if (itemType === 'conversation' && dragData.type === 'conversation') {
          const convs = dragData.conversations ?? [];
          const singleId = dragData.conversationId;
          const sourceFolderId = dragData.sourceFolderId;

          // If from outside any folder, add to folder data first
          if (!sourceFolderId) {
            this.options.store.ensureConversationsInFolder(parentId, dragData);
          }

          const effectiveSource = sourceFolderId ?? parentId;

          if (convs.length > 0) {
            this.options.store.reorderOrMoveConversations(
              convs.map((c) => c.conversationId),
              effectiveSource,
              parentId,
              insertIndex,
            );
          } else if (singleId) {
            this.options.store.reorderOrMoveConversations(
              [singleId],
              effectiveSource,
              parentId,
              insertIndex,
            );
          }
        }

        this.exitMultiSelectMode();
      } catch (error) {
        console.error('[FolderManager] Reorder drop error:', error);
      }
    });

    return gap;
  }

  private batchDeleteConversations(): void {
    if (!this.multiSelectFolderId || this.selectedConversations.size === 0) return;

    const count = this.selectedConversations.size;
    const confirmed = confirm(
      `Delete ${count} selected conversation${count > 1 ? 's' : ''} from this folder?`,
    );

    if (!confirmed) return;

    // Remove all selected conversations from the folder
    const folderId = this.multiSelectFolderId;
    if (!this.options.store.data.folderContents[folderId]) return;

    this.options.store.removeConversationsFromFolder(folderId, this.selectedConversations);

    // Exit multi-select mode and refresh
    this.exitMultiSelectMode();
    debug('log', `Batch deleted ${count} conversations from folder ${folderId}`);
  }

  private async batchDeleteNativeConversations(): Promise<void> {
    if (this.batchDeleteInProgress) {
      debug('log', 'Batch delete already in progress');
      return;
    }

    const count = this.selectedConversations.size;
    if (count === 0) return;

    // Show confirmation dialog
    const confirmMessage = t('batch_delete_confirm').replace('{count}', String(count));
    const confirmed = confirm(confirmMessage);
    if (!confirmed) return;

    this.batchDeleteInProgress = true;
    const conversationIds = Array.from(this.selectedConversations);
    let successCount = 0;
    let failedCount = 0;

    try {
      // Show progress indicator
      this.options.feedback.showBatchDeleteProgress(0, count);

      for (let i = 0; i < conversationIds.length; i++) {
        const conversationId = conversationIds[i];
        debug('log', `Deleting conversation ${i + 1}/${count}: ${conversationId}`);

        // Update progress
        this.options.feedback.updateBatchDeleteProgress(i + 1, count);

        try {
          const success = await this.options.nativeMenus.deleteConversation(conversationId);
          if (success) {
            successCount++;
          } else {
            failedCount++;
            debug('warn', `Failed to delete conversation: ${conversationId}`);
          }
        } catch (error) {
          failedCount++;
          console.error(`[FolderManager] Error deleting conversation ${conversationId}:`, error);
        }

        // Add delay between deletions to avoid rate limiting
        if (i < conversationIds.length - 1) {
          await this.delay(this.BATCH_DELETE_CONFIG.DELAY_BETWEEN_DELETIONS);
        }
      }

      // Hide progress indicator
      this.options.feedback.hideBatchDeleteProgress();

      // Show result summary
      if (failedCount === 0) {
        const successMessage = t('batch_delete_success').replace('{count}', String(successCount));
        this.options.feedback.showNotification(successMessage, 'success');
      } else {
        const partialMessage = t('batch_delete_partial')
          .replace('{success}', String(successCount))
          .replace('{failed}', String(failedCount));
        this.options.feedback.showNotification(partialMessage, 'info');
      }

      // Exit multi-select mode
      this.exitMultiSelectMode();

      // Refresh page after deletion
      if (successCount > 0) {
        debug('log', 'Refreshing page after batch delete');
        this.schedule(() => {
          window.location.reload();
        }, this.BATCH_DELETE_CONFIG.PAGE_REFRESH_DELAY);
      }
    } finally {
      this.batchDeleteInProgress = false;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private clearSelection(): void {
    this.selectedConversations.clear();
  }

  private selectConversation(conversationId: string): void {
    this.selectedConversations.add(conversationId);
  }

  private toggleConversationSelection(conversationId: string): void {
    if (this.selectedConversations.has(conversationId)) {
      this.selectedConversations.delete(conversationId);

      // Auto-exit multi-select mode when all selections are cleared
      if (this.selectedConversations.size === 0 && this.isMultiSelectMode) {
        this.exitMultiSelectMode();
        return;
      }
    } else {
      // Check if we've reached the maximum selection limit
      if (this.selectedConversations.size >= this.MAX_BATCH_DELETE_COUNT) {
        const message = t('batch_delete_limit_reached').replace(
          '{max}',
          String(this.MAX_BATCH_DELETE_COUNT),
        );
        this.options.feedback.showNotification(message, 'info');
        return;
      }
      this.selectedConversations.add(conversationId);
    }
  }

  private updateConversationSelectionUI(): void {
    // Only update UI for the source where multi-select was initiated
    if (this.multiSelectSource === 'folder') {
      // Only update folder conversation elements
      const allConvEls = this.options.runtime.panel?.querySelectorAll('.gv-folder-conversation');
      allConvEls?.forEach((el) => {
        const convId = (el as HTMLElement).dataset.conversationId;
        const elFolderId = (el as HTMLElement).dataset.folderId;

        // Only update conversations in the same folder where multi-select started
        if (convId && (!this.multiSelectFolderId || elFolderId === this.multiSelectFolderId)) {
          if (this.selectedConversations.has(convId)) {
            el.classList.add('gv-folder-conversation-selected');
          } else {
            el.classList.remove('gv-folder-conversation-selected');
          }
        }
      });
    } else if (this.multiSelectSource === 'native') {
      // Only update native conversation elements (Recent section)
      const nativeConvs = getNativeConversationElements(this.options.runtime.sidebar);
      nativeConvs.forEach((el) => {
        const convId = extractConversationId(el as HTMLElement);
        if (convId) {
          if (this.selectedConversations.has(convId)) {
            el.classList.add('gv-conversation-selected');
          } else {
            el.classList.remove('gv-conversation-selected');
          }
        }
      });
    }

    // Update the selection count
    this.updateMultiSelectModeUI();
  }

  private enterMultiSelectMode(
    initialConversationId?: string,
    source: 'folder' | 'native' = 'native',
    folderId?: string,
  ): void {
    debug('log', 'Entering multi-select mode', { source, folderId });
    this.isMultiSelectMode = true;
    this.multiSelectSource = source;
    this.multiSelectFolderId = folderId || null;

    // Select the conversation that triggered the long-press
    if (initialConversationId) {
      this.selectConversation(initialConversationId);
    }

    this.updateMultiSelectModeUI();
    this.updateConversationSelectionUI();

    // Add visual feedback (vibration on mobile)
    if ('vibrate' in navigator) {
      navigator.vibrate(50);
    }

    // Add click-outside listener to exit multi-select mode
    this.setupOutsideClickHandler();
  }

  private exitMultiSelectMode(): void {
    debug('log', 'Exiting multi-select mode');
    this.isMultiSelectMode = false;
    this.multiSelectSource = null;
    this.multiSelectFolderId = null;

    // Remove click-outside listener
    this.removeOutsideClickHandler();

    // First update UI to remove selection styles
    this.updateConversationSelectionUI();

    // Then clear the selection set
    this.clearSelection();

    // Update mode UI
    this.updateMultiSelectModeUI();

    // Force cleanup of any remaining visual artifacts
    this.cleanupSelectionArtifacts();
  }

  private setupOutsideClickHandler(): void {
    // Remove any existing handler first
    this.removeOutsideClickHandler();

    this.outsideClickHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Check if click is inside the sidebar or folder container
      const isInsideSidebar =
        this.options.runtime.sidebar?.contains(target) ||
        !!target.closest('[data-test-id="overflow-container"]');
      const isInsideFolderContainer = this.options.runtime.panel?.contains(target);
      const isInsideMultiSelectHost = this.multiSelectHostElement?.contains(target);

      // Check if click is on an overlay (menus, dialogs, etc.)
      const isOnOverlay = target.closest('.cdk-overlay-container, .mat-mdc-dialog-container');

      // If click is outside all relevant areas, exit multi-select mode
      if (
        !isInsideSidebar &&
        !isInsideFolderContainer &&
        !isInsideMultiSelectHost &&
        !isOnOverlay
      ) {
        debug('log', 'Click outside sidebar detected, exiting multi-select mode');
        this.exitMultiSelectMode();
      }
    };

    // Use setTimeout to avoid the current click event from triggering the handler
    this.schedule(() => {
      document.addEventListener('click', this.outsideClickHandler!, true);
    }, 0);
  }

  private removeOutsideClickHandler(): void {
    if (this.outsideClickHandler) {
      document.removeEventListener('click', this.outsideClickHandler, true);
      this.outsideClickHandler = null;
    }
  }

  private cleanupSelectionArtifacts(): void {
    // Remove selection classes from all native conversations
    const nativeConvs = getNativeConversationElements(this.options.runtime.sidebar);
    nativeConvs.forEach((el) => {
      (el as HTMLElement).classList.remove('gv-conversation-selected');
      (el as HTMLElement).style.opacity = '1';
    });
    // Remove selection classes from all folder conversations
    const folderConvs = this.options.runtime.panel?.querySelectorAll('.gv-folder-conversation');
    folderConvs?.forEach((el) => {
      (el as HTMLElement).classList.remove('gv-folder-conversation-selected');
      (el as HTMLElement).style.opacity = '1';
    });

    // Restore active conversation highlight in folders
    // This ensures that the currently active conversation remains highlighted
    // after drag-and-drop or multi-select operations
    this.options.navigation.highlightActiveConversation();
  }

  private showInvalidSelectionFeedback(element: HTMLElement): void {
    // Remove existing class (if any) to allow animation restart on rapid clicks
    element.classList.remove('gv-invalid-selection');

    // Force reflow to ensure animation restarts (see: CSS Triggers)
    void element.offsetWidth;

    // Add invalid selection class to trigger animation
    element.classList.add('gv-invalid-selection');

    // Listen for animation end to clean up the class automatically
    // Using { once: true } ensures the listener is removed after first invocation
    element.addEventListener(
      'animationend',
      () => {
        element.classList.remove('gv-invalid-selection');
      },
      { once: true },
    );

    // Optional: Haptic feedback on mobile devices
    if ('vibrate' in navigator) {
      navigator.vibrate([30, 20, 30]); // Two short vibrations
    }
  }

  private updateMultiSelectModeUI(): void {
    const multiSelectHost = this.isMultiSelectMode
      ? this.getMultiSelectHost()
      : this.getExistingMultiSelectHost();

    // Add or remove multi-select mode class from container
    if (this.isMultiSelectMode) {
      multiSelectHost?.classList.add('gv-multi-select-mode');
    } else {
      multiSelectHost?.classList.remove('gv-multi-select-mode');
    }

    // Update selection count in indicator
    const countElement = multiSelectHost?.querySelector('[data-selection-count="true"]');
    if (countElement) {
      const count = this.selectedConversations.size;
      countElement.textContent = `${count} selected`;
    }

    // Update action buttons based on source
    const actionsContainer = multiSelectHost?.querySelector('[data-multi-select-actions="true"]');
    if (actionsContainer && this.isMultiSelectMode) {
      actionsContainer.innerHTML = ''; // Clear existing buttons

      if (this.multiSelectSource === 'folder') {
        // Delete button for folder multi-select (removes from folder only)
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'gv-multi-select-action-btn gv-multi-select-delete-btn';
        deleteBtn.innerHTML =
          '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">delete</mat-icon>';
        deleteBtn.title = t('batch_delete_button');
        deleteBtn.addEventListener('click', () => this.batchDeleteConversations());
        actionsContainer.appendChild(deleteBtn);
      } else if (this.multiSelectSource === 'native') {
        // Delete button for native multi-select (deletes from Gemini)
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'gv-multi-select-action-btn gv-multi-select-delete-btn';
        deleteBtn.innerHTML =
          '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">delete</mat-icon>';
        deleteBtn.title = t('batch_delete_button');
        deleteBtn.addEventListener('click', () => this.batchDeleteNativeConversations());
        actionsContainer.appendChild(deleteBtn);
      }

      // Exit button (always present)
      const exitBtn = document.createElement('button');
      exitBtn.className = 'gv-multi-select-action-btn gv-multi-select-exit-btn';
      exitBtn.innerHTML =
        '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">close</mat-icon>';
      exitBtn.title = 'Exit multi-select mode';
      exitBtn.addEventListener('click', () => this.exitMultiSelectMode());
      actionsContainer.appendChild(exitBtn);
    } else if (actionsContainer) {
      actionsContainer.innerHTML = ''; // Clear buttons when exiting
    }
  }

  private getSelectedConversationsData(): ConversationReference[] {
    const result: ConversationReference[] = [];
    const seen = new Set<string>();

    // Collect from all folders since selection can span folders
    for (const fId in this.options.store.data.folderContents) {
      const conversations = this.options.store.data.folderContents[fId];
      conversations.forEach((conv) => {
        if (this.selectedConversations.has(conv.conversationId) && !seen.has(conv.conversationId)) {
          seen.add(conv.conversationId);
          result.push(conv);
        }
      });
    }

    return result;
  }

  bindFolderConversation(
    convEl: HTMLElement,
    link: HTMLAnchorElement,
    conv: ConversationReference,
    folderId: string,
    displayTitle: string,
  ): void {
    // Make conversation draggable within folders
    convEl.draggable = true;
    convEl.addEventListener('dragstart', (e) => {
      e.stopPropagation();

      // If this conversation is not selected, select it exclusively
      if (!this.selectedConversations.has(conv.conversationId)) {
        this.clearSelection();
        this.selectConversation(conv.conversationId);
        this.updateConversationSelectionUI();
      }

      // Cancel long press if drag starts
      if (this.longPressTimeout) {
        this.clearTimer(this.longPressTimeout);
        this.longPressTimeout = null;
      }

      // Include all selected conversations in the drag data
      const selectedConvs = this.getSelectedConversationsData();
      const dragData = {
        type: 'conversation',
        conversations: selectedConvs,
        sourceFolderId: folderId, // Track where they're being dragged from
      };
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('application/json', JSON.stringify(dragData));
      this.setLightweightDragImage(
        e,
        selectedConvs.length > 1 ? `${selectedConvs.length} conversations` : displayTitle,
      );

      // Apply opacity to all selected conversations
      this.selectedConversations.forEach((id) => {
        const el = this.options.runtime.panel?.querySelector(
          `[data-conversation-id="${id}"]`,
        ) as HTMLElement;
        if (el) el.style.opacity = '0.5';
      });
    });

    convEl.addEventListener('dragend', () => {
      // Restore opacity for all selected conversations
      this.selectedConversations.forEach((id) => {
        const el = this.options.runtime.panel?.querySelector(
          `[data-conversation-id="${id}"]`,
        ) as HTMLElement;
        if (el) el.style.opacity = '1';
      });

      // If we are not in multi-select mode, clear the temporary selection
      if (!this.isMultiSelectMode) {
        this.clearSelection();
        this.cleanupSelectionArtifacts();
      }
      this.clearConversationReorderIndicator();
    });

    // Long-press detection for entering multi-select mode
    let longPressTriggered = false;

    convEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Only left mouse button
      longPressTriggered = false;

      this.longPressTimeout = this.schedule(() => {
        longPressTriggered = true;
        this.enterMultiSelectMode(conv.conversationId, 'folder', folderId);
      }, this.longPressThreshold);
    });

    convEl.addEventListener('mouseup', () => {
      if (this.longPressTimeout) {
        this.clearTimer(this.longPressTimeout);
        this.longPressTimeout = null;
      }
    });

    convEl.addEventListener('mouseleave', () => {
      if (this.longPressTimeout) {
        this.clearTimer(this.longPressTimeout);
        this.longPressTimeout = null;
      }
    });

    // Plain left clicks keep the existing SPA navigation path. Modified clicks,
    // middle clicks, and context-menu actions stay native because the row
    // contains a real anchor.
    link.addEventListener('click', (e) => {
      // Prevent navigation if long-press was triggered
      if (longPressTriggered) {
        e.preventDefault();
        longPressTriggered = false;
        return;
      }

      if (this.isMultiSelectMode) {
        // Multi-select mode: validate folder before toggling selection
        e.preventDefault();
        e.stopPropagation();

        // Prevent cross-folder selection
        if (
          this.multiSelectSource === 'folder' &&
          this.multiSelectFolderId &&
          this.multiSelectFolderId !== folderId
        ) {
          // Provide visual feedback for invalid selection attempt
          this.showInvalidSelectionFeedback(convEl);
          return;
        }

        this.toggleConversationSelection(conv.conversationId);
        this.updateConversationSelectionUI();
      } else {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();

        // Normal mode: navigate to conversation
        const latest = this.options.store.data.folderContents[folderId]?.find(
          (item) => item.conversationId === conv.conversationId,
        );
        if (latest) this.options.navigation.navigate(latest, folderId);
      }
    });
  }
}
