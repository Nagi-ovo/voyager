import { StorageKeys } from '@/core/types/common';
import { customWebsitesIncludeHost } from '@/core/utils/customWebsites';

export interface PromptManagerInstance {
  destroy: () => void;
}

export interface CustomSiteCoverageOptions {
  /** Lowercased `location.host` of the page this content script runs in. */
  host: string;
  /** Mounts the Prompt Manager. Called only when coverage turns on. */
  start: () => Promise<PromptManagerInstance>;
  /**
   * An instance already mounted when the reconciler is created, if any.
   * Prefer `applyInitial()`: create the reconciler first, register its
   * listener, then feed it the startup read, so a toggle that lands while
   * that read is in flight is not lost.
   */
  initial?: PromptManagerInstance | null;
}

export interface CustomSiteCoverageReconciler {
  /** `chrome.storage.onChanged` listener. */
  handleChange: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;
  /**
   * Feed the startup coverage read. Ignored when a storage change has already
   * been handled: that change is newer than the read.
   */
  applyInitial: (covered: boolean) => void;
  /** Resolves once every change queued so far has been applied. */
  settled: () => Promise<void>;
  /** Tears down whatever is currently mounted. */
  destroy: () => void;
}

/**
 * Keeps the Prompt Manager in sync with the stored custom-website list while the
 * page stays open.
 *
 * Unregistering a dynamic content script only affects future navigations, so a
 * site toggled off in the popup would otherwise keep its Prompt Manager until
 * the user reloaded. Mounting and destroying are serialized on one queue: a
 * rapid off/on must not interleave two `start()` calls and leave two instances
 * mounted.
 */
export function createCustomSiteCoverageReconciler({
  host,
  start,
  initial,
}: CustomSiteCoverageOptions): CustomSiteCoverageReconciler {
  let instance: PromptManagerInstance | null = initial ?? null;
  let queue: Promise<void> = Promise.resolve();
  let sawChange = false;
  let destroyed = false;

  const apply = (covered: boolean): void => {
    queue = queue
      .then(async () => {
        // Read coverage at apply time, not at enqueue time, so a no-op change
        // never remounts an already-mounted instance.
        if (destroyed || covered === (instance !== null)) return;
        if (covered) {
          instance = await start();
          return;
        }
        instance?.destroy();
        instance = null;
      })
      .catch(() => {});
  };

  const handleChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'sync') return;
    const change = changes[StorageKeys.PROMPT_CUSTOM_WEBSITES];
    if (!change) return;
    sawChange = true;
    apply(customWebsitesIncludeHost(change.newValue, host));
  };

  return {
    handleChange,
    applyInitial: (covered) => {
      if (!sawChange) apply(covered);
    },
    settled: () => queue,
    destroy: () => {
      destroyed = true;
      instance?.destroy();
      instance = null;
      // A mount still in flight assigns its instance after this call returns:
      // tear that down too, behind whatever the queue is still running.
      queue = queue
        .then(() => {
          instance?.destroy();
          instance = null;
        })
        .catch(() => {});
    },
  };
}
