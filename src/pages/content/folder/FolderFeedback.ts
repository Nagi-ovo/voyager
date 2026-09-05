import { getTranslationSync, getTranslationSyncUnsafe } from '@/utils/i18n';

const NOTIFICATION_TIMEOUT_MS = 10000;

/** Owns folder feedback DOM and its finite display timers. */
export class FolderFeedback {
  private tooltipElement: HTMLElement | null = null;
  private tooltipTimeout: number | null = null;
  private batchDeleteProgressElement: HTMLElement | null = null;
  private readonly notifications = new Set<HTMLElement>();
  private readonly timers = new Set<number>();
  private destroyed = false;

  constructor() {
    this.createTooltip();
  }

  destroy(): void {
    this.destroyed = true;
    this.hideTooltip();
    this.tooltipElement?.remove();
    this.tooltipElement = null;
    this.hideBatchDeleteProgress();
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    for (const notification of this.notifications) notification.remove();
    this.notifications.clear();
  }

  private schedule(callback: () => void, delay: number): number {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delay);
    this.timers.add(timer);
    return timer;
  }

  showBatchDeleteProgress(current: number, total: number): void {
    if (this.destroyed) return;
    // Remove existing progress element if any
    this.hideBatchDeleteProgress();

    const progress = document.createElement('div');
    progress.className = 'gv-batch-delete-progress';
    progress.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: rgba(32, 33, 36, 0.95);
      color: #e8eaed;
      padding: 16px 24px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: 'Google Sans', Roboto, Arial, sans-serif;
      font-size: 14px;
    `;

    const spinner = document.createElement('div');
    spinner.style.cssText = `
      width: 20px;
      height: 20px;
      border: 2px solid #8ab4f8;
      border-top-color: transparent;
      border-radius: 50%;
      animation: gv-spin 1s linear infinite;
    `;

    // Add spinner animation if not already present
    if (!document.querySelector('#gv-batch-delete-styles')) {
      const style = document.createElement('style');
      style.id = 'gv-batch-delete-styles';
      style.textContent = `
        @keyframes gv-spin {
          to { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(style);
    }

    const text = document.createElement('span');
    text.className = 'gv-batch-delete-progress-text';
    text.textContent = getTranslationSyncUnsafe('batch_delete_in_progress')
      .replace('{current}', String(current))
      .replace('{total}', String(total));

    progress.appendChild(spinner);
    progress.appendChild(text);
    document.body.appendChild(progress);

    this.batchDeleteProgressElement = progress;
  }

  updateBatchDeleteProgress(current: number, total: number): void {
    if (this.batchDeleteProgressElement) {
      const textEl = this.batchDeleteProgressElement.querySelector(
        '.gv-batch-delete-progress-text',
      );
      if (textEl) {
        textEl.textContent = getTranslationSyncUnsafe('batch_delete_in_progress')
          .replace('{current}', String(current))
          .replace('{total}', String(total));
      }
    }
  }

  hideBatchDeleteProgress(): void {
    if (this.batchDeleteProgressElement) {
      this.batchDeleteProgressElement.remove();
      this.batchDeleteProgressElement = null;
    }
  }

  showDataLossNotification(): void {
    this.showNotificationByLevel(
      getTranslationSync('folderManager_dataLossWarning') ||
        'Warning: Failed to load folder data. Please check your browser console for details.',
      'error',
    );
  }

  showNotificationByLevel(message: string, level: 'info' | 'warning' | 'error' = 'error'): void {
    if (this.destroyed) return;
    try {
      // Color based on level
      const colors = {
        info: '#2196F3',
        warning: '#FF9800',
        error: '#f44336',
      };

      // Create a visible notification
      const notification = document.createElement('div');
      notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${colors[level]};
        color: white;
        padding: 16px 24px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        z-index: 10000;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 14px;
        max-width: 400px;
        line-height: 1.4;
      `;
      notification.textContent = message;
      document.body.appendChild(notification);
      this.notifications.add(notification);

      // Auto-remove after timeout (longer for errors/warnings)
      const timeout =
        level === 'info' ? 3000 : level === 'warning' ? 7000 : NOTIFICATION_TIMEOUT_MS;
      this.schedule(() => {
        try {
          document.body.removeChild(notification);
        } catch {
          // Ignore - notification may have already been removed
        }
        this.notifications.delete(notification);
      }, timeout);
    } catch (notificationError) {
      console.error('[FolderManager] Failed to show notification:', notificationError);
    }
  }

  showNotification(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
    if (this.destroyed) return;
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `gv-notification gv-notification-${type}`;
    notification.textContent = message;

    // Add to body
    document.body.appendChild(notification);
    this.notifications.add(notification);

    // Trigger animation
    this.schedule(() => notification.classList.add('show'), 10);

    // Remove after 3 seconds
    this.schedule(() => {
      notification.classList.remove('show');
      this.schedule(() => {
        notification.remove();
        this.notifications.delete(notification);
      }, 300);
    }, 3000);
  }

  private createTooltip(): void {
    this.tooltipElement = document.createElement('div');
    this.tooltipElement.className = 'gv-tooltip';
    document.body.appendChild(this.tooltipElement);
  }

  showTooltip(element: HTMLElement, text: string, showWhenNotTruncated = false): void {
    if (!this.tooltipElement) return;

    // Clear any existing timeout
    if (this.tooltipTimeout) {
      clearTimeout(this.tooltipTimeout);
      this.timers.delete(this.tooltipTimeout);
    }

    // Check if text is truncated
    const isTruncated = element.scrollWidth > element.clientWidth;
    if (!showWhenNotTruncated && !isTruncated) return;

    // Show tooltip after a short delay (200ms)
    this.tooltipTimeout = this.schedule(() => {
      this.tooltipTimeout = null;
      if (!this.tooltipElement) return;

      this.tooltipElement.textContent = text;

      // Position tooltip
      const rect = element.getBoundingClientRect();
      const tooltipRect = this.tooltipElement.getBoundingClientRect();

      let left = rect.left;
      let top = rect.bottom + 8;

      // Adjust if tooltip goes off screen
      if (left + tooltipRect.width > window.innerWidth) {
        left = window.innerWidth - tooltipRect.width - 10;
      }
      if (top + tooltipRect.height > window.innerHeight) {
        top = rect.top - tooltipRect.height - 8;
      }

      this.tooltipElement.style.left = `${left}px`;
      this.tooltipElement.style.top = `${top}px`;

      // Trigger reflow for animation
      // oxlint-disable-next-line no-unused-expressions -- reading offsetHeight flushes layout; the value is intentionally discarded
      this.tooltipElement.offsetHeight;
      this.tooltipElement.classList.add('show');
    }, 200);
  }

  hideTooltip(): void {
    if (this.tooltipTimeout) {
      clearTimeout(this.tooltipTimeout);
      this.timers.delete(this.tooltipTimeout);
      this.tooltipTimeout = null;
    }
    if (this.tooltipElement) {
      this.tooltipElement.classList.remove('show');
    }
  }
}
