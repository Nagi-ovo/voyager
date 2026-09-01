export interface RouteChange {
  previousHref: string;
  currentHref: string;
  trigger: 'poll' | 'popstate' | 'hashchange';
}

type RouteChangeListener = (change: RouteChange) => void;

const POLL_INTERVAL_MS = 400;
const listeners = new Set<RouteChangeListener>();

let lastHref = '';
let pollTimer: number | null = null;

function getCurrentHref(): string {
  return (
    window.location.href ||
    `${window.location.pathname}${window.location.search ?? ''}${window.location.hash ?? ''}`
  );
}

function checkRoute(event?: Event): void {
  const currentHref = getCurrentHref();
  if (currentHref === lastHref) return;

  const previousHref = lastHref;
  lastHref = currentHref;
  // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot: a listener may unsubscribe from inside its own callback
  for (const listener of [...listeners]) {
    try {
      listener({
        previousHref,
        currentHref,
        trigger:
          event?.type === 'popstate'
            ? 'popstate'
            : event?.type === 'hashchange'
              ? 'hashchange'
              : 'poll',
      });
    } catch (error) {
      console.error('[Voyager] Route change listener failed:', error);
    }
  }
}

function startWatcher(): void {
  if (pollTimer !== null) return;
  lastHref = getCurrentHref();
  window.addEventListener('popstate', checkRoute);
  window.addEventListener('hashchange', checkRoute);
  pollTimer = window.setInterval(checkRoute, POLL_INTERVAL_MS);
}

function stopWatcher(): void {
  if (pollTimer === null) return;
  window.clearInterval(pollTimer);
  pollTimer = null;
  window.removeEventListener('popstate', checkRoute);
  window.removeEventListener('hashchange', checkRoute);
}

/**
 * Subscribe to SPA route changes through one page-wide fallback poller.
 * Gemini's router runs in the page world, so isolated-world history patches
 * alone cannot reliably observe every navigation.
 */
export function watchRouteChanges(listener: RouteChangeListener): () => void {
  listeners.add(listener);
  startWatcher();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopWatcher();
  };
}
