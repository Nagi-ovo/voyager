import type { CleanupPositions } from '@/core/types/cleanupPositions';
import type { CleanupManager } from '@/core/utils/cleanupManager';

/**
 * Lifecycle contract for Gemini / AI Studio native content modules.
 *
 * Two lifetimes are standardised here and nothing else:
 *
 * - **page teardown** — `start` hands back one `stop` that removes every
 *   listener, observer, timer, storage subscription and injected node the
 *   feature owns. `cleanupManager` runs it on unload at `position`.
 * - **popup toggle** — a feature with `toggle` is mounted and stopped while
 *   the page lives, without a reload, by `createNativeFeatureToggle`.
 *
 * Sidebar remounts and account changes are *not* covered: those lifetimes
 * differ per feature (see the folders/timeline regression notes) and stay
 * inside each module.
 *
 * `src/pages/content/__tests__/nativeFeatureLifecycle.test.ts` enforces the
 * contract for every entry of `NATIVE_FEATURE_LIST`.
 */

/** One call tears down everything the feature set up. Must be idempotent. */
export type StopNativeFeature = () => void;

export interface NativeFeatureToggle {
  /** Storage key (sync or local area) whose value decides whether the feature runs. */
  readonly key: string;
  readonly isEnabled: (value: unknown) => boolean;
}

export interface NativeFeature {
  readonly id: string;
  /** Where `stop` runs relative to the other cleanups on page teardown. */
  readonly position: CleanupPositions;
  readonly start: () => StopNativeFeature | Promise<StopNativeFeature>;
  /**
   * Set only when `start` legitimately registers nothing under the lifecycle
   * test's Gemini fixture (a browser-channel gate, a platform-only feature).
   * The test then skips its "did something" check but still requires a clean
   * teardown. Never use it to silence a real leak.
   */
  readonly inertReason?: string;
  /** Present when the popup can turn the feature on and off while the page lives. */
  readonly toggle?: NativeFeatureToggle;
}

/** Start the feature and register its stop at the feature's cleanup position. */
export async function mountNativeFeature(
  manager: CleanupManager,
  feature: NativeFeature,
): Promise<StopNativeFeature> {
  const stop = await feature.start();
  manager.registerCleanupFunction(stop, feature.position);
  return stop;
}

type StorageChanges = Record<string, { newValue?: unknown } | undefined>;

export interface NativeFeatureToggleController {
  /** Feed `chrome.storage.onChanged` events; unrelated keys and areas are ignored. */
  handleChange(changes: StorageChanges, areaName: string): void;
  /**
   * Apply the value read at startup. Ignored when a change already arrived,
   * so a toggle flipped while the startup read was in flight wins.
   */
  applyInitial(enabled: boolean): Promise<void>;
  isMounted(): boolean;
}

/**
 * Mount/stop a toggleable feature as its storage key flips. Requests are
 * applied strictly in order: a toggle that lands while an asynchronous start
 * is still running waits for it instead of racing it, and only the latest
 * requested state is applied after the queue drains.
 */
export function createNativeFeatureToggle(
  manager: CleanupManager,
  feature: NativeFeature,
): NativeFeatureToggleController {
  const toggle = feature.toggle;
  if (!toggle) throw new Error(`${feature.id}: createNativeFeatureToggle needs a toggle`);

  let stop: StopNativeFeature | null = null;
  let desired: boolean | null = null;
  let queue: Promise<void> = Promise.resolve();
  let sawChange = false;

  const settle = async (): Promise<void> => {
    if (desired === null) return;
    const enabled = desired;
    desired = null;
    if (enabled && !stop) {
      stop = await mountNativeFeature(manager, feature);
    } else if (!enabled && stop) {
      const current = stop;
      stop = null;
      current();
      manager.withdrawCleanupFunctionsByPositionNumber(feature.position);
    }
  };

  const request = (enabled: boolean): Promise<void> => {
    desired = enabled;
    queue = queue.then(settle, settle);
    return queue;
  };

  return {
    handleChange(changes, areaName) {
      if (areaName !== 'sync' && areaName !== 'local') return;
      const change = changes[toggle.key];
      if (!change) return;
      sawChange = true;
      void request(toggle.isEnabled(change.newValue));
    },
    applyInitial(enabled) {
      if (sawChange) return queue;
      return request(enabled);
    },
    isMounted() {
      return stop !== null;
    },
  };
}
