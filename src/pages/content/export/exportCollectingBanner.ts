/**
 * Wraps a long-running DOM collection task with a top-of-page banner.
 *
 * ChatGPT's virtual list unloads message content outside the viewport, so the
 * export pipeline scrolls and re-extracts each selected turn one by one. The
 * banner tells the user the page is intentionally scrolling, and is guaranteed
 * to be removed once collection finishes, fails, or yields no turns.
 */
export async function withExportCollectingBanner<T>(
  showBanner: () => () => void,
  task: () => Promise<T>,
): Promise<T> {
  const hideBanner = showBanner();
  try {
    return await task();
  } finally {
    hideBanner();
  }
}
