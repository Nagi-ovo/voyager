/**
 * Dynamic content-script registration helpers for the background worker.
 *
 * Chrome rejects the whole `unregisterContentScripts` call when any id in it
 * is unknown ("Nonexistent script ID"), and the `registerContentScripts` that
 * follows then fails on the duplicate id. Batching a never-registered
 * companion script (the Claude usage bridge, the embedded-frame script) into
 * one unregister call therefore froze the plugin registration on its first
 * result: enabling a plugin for a new site later changed nothing until the
 * extension restarted.
 */

export type ContentScriptRegistry = Pick<
  typeof chrome.scripting,
  'getRegisteredContentScripts' | 'unregisterContentScripts'
>;

/**
 * Unregister only the ids that are actually registered. Returns the ids that
 * were removed; a missing id is not an error.
 */
export async function unregisterRegisteredContentScripts(
  scripting: ContentScriptRegistry | undefined,
  ids: readonly string[],
): Promise<string[]> {
  if (!scripting?.unregisterContentScripts) return [];
  let registered: string[];
  try {
    const wanted = new Set(ids);
    registered = (await scripting.getRegisteredContentScripts())
      .map((script) => script.id)
      .filter((id) => wanted.has(id));
  } catch {
    // Listing failed: unregister one id at a time, so an absent id can only
    // fail its own call instead of the whole batch.
    const removed: string[] = [];
    for (const id of ids) {
      try {
        await scripting.unregisterContentScripts({ ids: [id] });
        removed.push(id);
      } catch {
        // Not registered.
      }
    }
    return removed;
  }
  if (!registered.length) return [];
  try {
    await scripting.unregisterContentScripts({ ids: registered });
    return registered;
  } catch (error) {
    console.warn('[Background] Failed to unregister content scripts', registered, error);
    return [];
  }
}
