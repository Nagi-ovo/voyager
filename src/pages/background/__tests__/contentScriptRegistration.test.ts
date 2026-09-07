import { describe, expect, it, vi } from 'vitest';

import {
  type ContentScriptRegistry,
  unregisterRegisteredContentScripts,
} from '../contentScriptRegistration';

/** Mimics Chrome: one unknown id rejects the whole call and removes nothing. */
function fakeRegistry(initial: readonly string[]) {
  const registered = new Set(initial);
  const scripting: ContentScriptRegistry = {
    getRegisteredContentScripts: vi.fn(async () =>
      [...registered].map((id) => ({ id, js: [], matches: [] })),
    ) as unknown as ContentScriptRegistry['getRegisteredContentScripts'],
    unregisterContentScripts: vi.fn(async (filter?: { ids?: string[] }) => {
      const ids = filter?.ids ?? [];
      const missing = ids.find((id) => !registered.has(id));
      if (missing) throw new Error(`Nonexistent script ID '${missing}'`);
      for (const id of ids) registered.delete(id);
    }) as unknown as ContentScriptRegistry['unregisterContentScripts'],
  };
  return { scripting, registered };
}

describe('unregisterRegisteredContentScripts', () => {
  it('drops only the ids that exist so a never-registered companion cannot block the batch', async () => {
    const { scripting, registered } = fakeRegistry(['gv-plugin-content-script', 'gv-other']);

    const removed = await unregisterRegisteredContentScripts(scripting, [
      'gv-plugin-content-script',
      'gv-plugin-embedded-content-script',
      'gv-plugin-claude-usage-main',
    ]);

    expect(removed).toEqual(['gv-plugin-content-script']);
    expect([...registered]).toEqual(['gv-other']);
    expect(scripting.unregisterContentScripts).toHaveBeenCalledWith({
      ids: ['gv-plugin-content-script'],
    });
  });

  it('is a no-op when none of the ids are registered', async () => {
    const { scripting } = fakeRegistry(['gv-other']);
    await expect(
      unregisterRegisteredContentScripts(scripting, ['gv-plugin-content-script']),
    ).resolves.toEqual([]);
    expect(scripting.unregisterContentScripts).not.toHaveBeenCalled();
  });

  it('unregisters one id at a time when the registry cannot be listed, so an absent id blocks nothing', async () => {
    const { scripting, registered } = fakeRegistry(['gv-plugin-content-script']);
    (scripting.getRegisteredContentScripts as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('boom'),
    );

    await expect(
      unregisterRegisteredContentScripts(scripting, [
        'gv-plugin-content-script',
        'gv-plugin-embedded-content-script',
      ]),
    ).resolves.toEqual(['gv-plugin-content-script']);
    expect(registered.size).toBe(0);
  });
});
