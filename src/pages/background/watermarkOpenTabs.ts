/**
 * Install the MAIN-world watermark download interceptor into Gemini tabs that
 * are already open. Persistent content-script registration only applies on a
 * later navigation, so runtime enablement needs this one-shot companion step.
 */
export async function injectWatermarkInterceptorIntoOpenTabs(
  matches: readonly string[],
): Promise<void> {
  if (!chrome.scripting?.executeScript) return;

  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: [...matches] });
  } catch {
    return;
  }

  await Promise.all(
    tabs.map(async (tab) => {
      if (typeof tab.id !== 'number') return;

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['fetchInterceptor.js'],
          world: 'MAIN',
        });
      } catch {
        // A tab can close, navigate, or reject injection between query and
        // executeScript. Persistent registration covers its next navigation.
      }
    }),
  );
}
