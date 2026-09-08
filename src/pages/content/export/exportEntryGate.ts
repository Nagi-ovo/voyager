export interface ExportEntryGateOptions {
  /** Whether the current page can hold a conversation. Read on every check. */
  readonly isEligible: () => boolean;
  readonly mount: () => void;
  readonly unmount: () => void;
  /** SPA route watcher; returns its unsubscribe. */
  readonly watchRoute: (listener: () => void) => () => void;
  /** Subtree watched for a conversation that appears without a route change. */
  readonly root: Node;
  /** Quiet period after a DOM mutation before re-checking. */
  readonly settleMs?: number;
}

const DEFAULT_SETTLE_MS = 300;

/**
 * Keeps an export entry point mounted exactly while the page is eligible.
 *
 * Route changes are the usual trigger. DOM mutations are watched too because
 * a conversation can appear without one: a ChatGPT temporary chat stays on
 * `/?temporary-chat=true` while its turns render. Returns the teardown, which
 * also unmounts whatever is mounted.
 */
export function startExportEntryGate(options: ExportEntryGateOptions): () => void {
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  let mounted = false;
  let disposed = false;
  let settleTimer: number | null = null;

  const sync = (): void => {
    if (disposed) return;
    const wanted = options.isEligible();
    if (wanted && !mounted) {
      mounted = true;
      options.mount();
    } else if (!wanted && mounted) {
      mounted = false;
      options.unmount();
    }
  };

  sync();
  const stopRouteWatch = options.watchRoute(sync);
  const observer = new MutationObserver(() => {
    if (settleTimer !== null) return;
    settleTimer = window.setTimeout(() => {
      settleTimer = null;
      sync();
    }, settleMs);
  });
  observer.observe(options.root, { childList: true, subtree: true });

  return () => {
    if (disposed) return;
    disposed = true;
    stopRouteWatch();
    observer.disconnect();
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
    if (mounted) {
      mounted = false;
      options.unmount();
    }
  };
}
