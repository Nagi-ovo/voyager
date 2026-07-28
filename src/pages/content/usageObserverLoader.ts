/**
 * Usage/history observer bridge — an isolated-world content script that runs
 * at document_start, before Gemini captures its own fetch/XHR references.
 *
 * Both observers are always active. Conversation history also provides the
 * stable per-turn response ids used by bookmarks, hierarchy, forks, highlights
 * and exports, independently of whether timestamp labels are enabled.
 */
export {};

const HISTORY_OBSERVER_SOURCE = 'gv-history-observer';
const HISTORY_OBSERVER_COMMAND_SOURCE = 'gv-history-observer-cmd';

function postHistoryConfiguration(): void {
  try {
    window.postMessage(
      {
        source: HISTORY_OBSERVER_COMMAND_SOURCE,
        type: 'configure',
        payload: { enabled: true },
      },
      window.location.origin,
    );
  } catch {
    // Observer absent or the extension context was invalidated.
  }
}

const onHistoryObserverMessage = (event: MessageEvent): void => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as { source?: unknown; type?: unknown } | null;
  if (!data || data.source !== HISTORY_OBSERVER_SOURCE || data.type !== 'ready') return;
  postHistoryConfiguration();
};

window.addEventListener('message', onHistoryObserverMessage);
// The MAIN-world script can execute before this isolated-world listener. Send
// an eager configuration now and repeat it when the observer announces ready.
postHistoryConfiguration();

/** Firefox 115 lacks reliable manifest MAIN-world support, so retain its DOM fallback. */
export function injectObserverFallback(buildTarget: string): void {
  if (buildTarget !== 'firefox') return;
  for (const src of ['usage-observer.js', 'conversation-history-observer.js']) {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(src);
      script.async = false;
      (document.documentElement || document.head || document.body).appendChild(script);
      script.remove();
    } catch {
      // Usage falls back to DOM scraping; timestamps fall back to first-seen time.
    }
  }
}

injectObserverFallback(import.meta.env.VOYAGER_BUILD_TARGET);

window.addEventListener(
  'beforeunload',
  () => {
    window.removeEventListener('message', onHistoryObserverMessage);
  },
  { once: true },
);
