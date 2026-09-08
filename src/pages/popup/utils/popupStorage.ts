import browser from 'webextension-polyfill';

/** Preserve the popup's polyfill-first storage path and callback API fallback. */
export async function writePopupSyncStorage(payload: Record<string, unknown>): Promise<void> {
  try {
    await browser.storage.sync.set(payload);
    return;
  } catch {
    // The polyfill may be unavailable in this extension-page context.
  }
  await new Promise<void>((resolve) => {
    try {
      chrome.storage?.sync?.set(payload, () => resolve());
    } catch {
      resolve();
    }
  });
}
