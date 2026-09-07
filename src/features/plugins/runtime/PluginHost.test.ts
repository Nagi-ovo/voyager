import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginManifest, PluginSource } from '../types';
import { PluginHost } from './PluginHost';
import { registerNativeHandler, resetNativeHandlersForTests } from './nativeHandlers';

function manifest(matches: string[], id = 'voyager.test'): PluginManifest {
  return {
    id,
    name: 'Test',
    version: '1.0.0',
    description: 'd',
    author: 'a',
    category: 'other',
    license: 'MIT',
    engine: '>=1.0.0',
    tier: 'declarative',
    matches,
    contributes: {
      domOps: [
        {
          op: 'addClass',
          target: { kind: 'css', selector: 'body' },
          className: 'gv-plugin-active',
        },
      ],
    },
  };
}

class StaticSource implements PluginSource {
  readonly id = 'static';
  constructor(private readonly plugins: readonly PluginManifest[]) {}
  async list(): Promise<readonly PluginManifest[]> {
    return this.plugins;
  }
}

function mockState(state: Record<string, { enabled: boolean; installedAt: number }>): void {
  (chrome.storage.local.get as unknown as Mock).mockResolvedValue({ gvPluginsState: state });
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.classList.remove('gv-plugin-active');
});

afterEach(() => {
  (chrome.storage.local.get as unknown as Mock).mockReset?.();
  (chrome.storage.onChanged.addListener as unknown as Mock).mockClear?.();
  resetNativeHandlersForTests();
});

describe('PluginHost', () => {
  it('mounts an enabled plugin that matches the current URL', async () => {
    mockState({ 'voyager.test': { enabled: true, installedAt: 1 } });
    const host = new PluginHost({
      url: 'https://claude.ai/chat/1',
      sources: [new StaticSource([manifest(['https://claude.ai/*'])])],
      doc: document,
    });

    await host.start();
    expect(document.body.classList.contains('gv-plugin-active')).toBe(true);
  });

  it('does not mount a disabled plugin', async () => {
    mockState({ 'voyager.test': { enabled: false, installedAt: 1 } });
    const host = new PluginHost({
      url: 'https://claude.ai/chat/1',
      sources: [new StaticSource([manifest(['https://claude.ai/*'])])],
      doc: document,
    });

    await host.start();
    expect(document.body.classList.contains('gv-plugin-active')).toBe(false);
  });

  it('does not mount a plugin that does not match the URL', async () => {
    mockState({ 'voyager.test': { enabled: true, installedAt: 1 } });
    const host = new PluginHost({
      url: 'https://gemini.google.com/app',
      sources: [new StaticSource([manifest(['https://claude.ai/*'])])],
      doc: document,
    });

    await host.start();
    expect(document.body.classList.contains('gv-plugin-active')).toBe(false);
  });

  it('resolves the adapter for the current site', async () => {
    mockState({});
    const host = new PluginHost({
      url: 'https://chatgpt.com/x',
      sources: [new StaticSource([])],
      doc: document,
    });
    await host.start();
    expect(host.activeAdapter?.id).toBe('chatgpt');
  });

  it('stop() unmounts active plugins', async () => {
    mockState({ 'voyager.test': { enabled: true, installedAt: 1 } });
    const host = new PluginHost({
      url: 'https://claude.ai/chat/1',
      sources: [new StaticSource([manifest(['https://claude.ai/*'])])],
      doc: document,
    });

    await host.start();
    expect(document.body.classList.contains('gv-plugin-active')).toBe(true);

    host.stop();
    expect(document.body.classList.contains('gv-plugin-active')).toBe(false);
  });

  it('pushes settings only to the plugin whose settings actually changed', async () => {
    const settingsSchema = {
      flag: { type: 'boolean' as const, label: 'Flag', default: false },
    };
    const a: PluginManifest = {
      ...manifest(['https://claude.ai/*'], 'voyager.native-a'),
      contributes: { settings: settingsSchema },
    };
    const b: PluginManifest = {
      ...manifest(['https://claude.ai/*'], 'voyager.native-b'),
      contributes: { settings: settingsSchema },
    };
    const updateA = vi.fn();
    const updateB = vi.fn();
    registerNativeHandler('voyager.native-a', { updateSettings: updateA });
    registerNativeHandler('voyager.native-b', { updateSettings: updateB });

    const enabled = { enabled: true, installedAt: 1 };
    mockState({ 'voyager.native-a': enabled, 'voyager.native-b': enabled });
    const host = new PluginHost({
      url: 'https://claude.ai/chat/1',
      sources: [new StaticSource([a, b])],
      doc: document,
    });
    await host.start();

    fireStateChange({
      'voyager.native-a': { ...enabled, settings: { flag: true } },
      'voyager.native-b': enabled,
    });
    await flush();

    expect(updateA).toHaveBeenCalledTimes(1);
    expect(updateA).toHaveBeenCalledWith({ flag: true });
    expect(updateB).not.toHaveBeenCalled();
    host.stop();
  });

  it('serializes reconcile passes: a disable landing mid-pass wins', async () => {
    // An enable kicks off a reconcile pass that blocks on the entitlement
    // await; while it is blocked, the user disables the plugin. The blocked
    // pass then mounts from its stale pre-disable decision, and only because
    // passes are serialized does the follow-up pass run after it and correct
    // the outcome. Interleaved passes would leave the plugin mounted while
    // disabled.
    let releaseBlockedPass!: () => void;
    const gate = new Promise<void>((r) => (releaseBlockedPass = r));
    let calls = 0;
    const entitlement = {
      getState: vi.fn(async () => {
        calls += 1;
        if (calls === 1) await gate;
        return 'free' as const;
      }),
    };

    mockState({ 'voyager.test': { enabled: false, installedAt: 1 } });
    const host = new PluginHost({
      url: 'https://claude.ai/chat/1',
      sources: [new StaticSource([manifest(['https://claude.ai/*'])])],
      entitlement,
      doc: document,
    });
    await host.start();

    fireStateChange({ 'voyager.test': { enabled: true, installedAt: 1 } });
    await vi.waitFor(() => expect(entitlement.getState).toHaveBeenCalledTimes(1));
    fireStateChange({ 'voyager.test': { enabled: false, installedAt: 1 } });
    releaseBlockedPass();
    await flush();

    expect(document.body.classList.contains('gv-plugin-active')).toBe(false);
    host.stop();
  });

  it('a pass blocked across stop()→start() cannot mount into the new generation', async () => {
    // Generation ABA: pass 1 (gen 1) decides "mount" then blocks on
    // entitlement; the host is stopped and restarted (plugin now disabled).
    // When pass 1 resumes, a bare `started` boolean reads true again — only
    // the generation check stops it from mounting its stale decision into
    // the restarted engine.
    let releaseBlockedPass!: () => void;
    const gate = new Promise<void>((r) => (releaseBlockedPass = r));
    let calls = 0;
    const entitlement = {
      getState: vi.fn(async () => {
        calls += 1;
        if (calls === 1) await gate;
        return 'free' as const;
      }),
    };

    mockState({ 'voyager.test': { enabled: true, installedAt: 1 } });
    const host = new PluginHost({
      url: 'https://claude.ai/chat/1',
      sources: [new StaticSource([manifest(['https://claude.ai/*'])])],
      entitlement,
      doc: document,
    });

    const firstStart = host.start();
    await vi.waitFor(() => expect(entitlement.getState).toHaveBeenCalledTimes(1));

    host.stop();
    mockState({ 'voyager.test': { enabled: false, installedAt: 1 } });
    const secondStart = host.start();

    releaseBlockedPass();
    await Promise.all([firstStart, secondStart]);
    await flush();

    expect(document.body.classList.contains('gv-plugin-active')).toBe(false);
    // The stale gen-1 start must NOT resume past its awaits and install a
    // second set of subscriptions over gen-3's (zombie listeners + clobbered
    // unsubscribe handles). Exactly one start's worth remains: state+catalog.
    const listenerCalls = (chrome.storage.onChanged.addListener as unknown as Mock).mock.calls;
    expect(listenerCalls.length).toBe(2);
    host.stop();
  });
});

describe('PluginHost remote catalog', () => {
  const CATALOG_KEY = 'gvPluginHostCatalog:claude.ai';

  function catalogEntry(ids: string[], extensionVersion = '1.0.0') {
    return {
      host: 'claude.ai',
      status: 'ok',
      manifests: ids.map((id) => manifest(['https://claude.ai/*'], id)),
      fetchedAt: 1,
      lastAttemptAt: 1,
      failureCount: 0,
      extensionVersion,
    };
  }

  function fireCatalogChange(oldValue: unknown, newValue: unknown): void {
    const listeners = (chrome.storage.onChanged.addListener as unknown as Mock).mock.calls;
    for (const [listener] of listeners) {
      listener({ [CATALOG_KEY]: { oldValue, newValue } }, 'local');
    }
  }

  it('asks the background to check the catalog when an enabled plugin targets the page', async () => {
    mockState({ 'voyager.test': { enabled: true, installedAt: 1 } });
    const requestCatalogRefresh = vi.fn();
    const host = new PluginHost({
      url: 'https://claude.ai/chat/1',
      sources: [new StaticSource([manifest(['https://claude.ai/*'])])],
      doc: document,
      requestCatalogRefresh,
      isTopFrame: true,
    });

    await host.start();
    expect(requestCatalogRefresh).toHaveBeenCalledTimes(1);
    expect(requestCatalogRefresh).toHaveBeenCalledWith('claude.ai');
    host.stop();
  });

  it('never asks on Gemini, on a page whose plugins are all disabled, or from an embedded frame', async () => {
    const claudePlugin = manifest(['https://claude.ai/*']);

    mockState({ 'voyager.test': { enabled: true, installedAt: 1 } });
    const gemini = vi.fn();
    const onGemini = new PluginHost({
      url: 'https://gemini.google.com/app',
      sources: [new StaticSource([claudePlugin])],
      doc: document,
      requestCatalogRefresh: gemini,
      isTopFrame: true,
    });
    await onGemini.start();
    expect(gemini).not.toHaveBeenCalled();
    onGemini.stop();

    mockState({ 'voyager.test': { enabled: false, installedAt: 1 } });
    const disabled = vi.fn();
    const onClaudeDisabled = new PluginHost({
      url: 'https://claude.ai/chat/1',
      sources: [new StaticSource([claudePlugin])],
      doc: document,
      requestCatalogRefresh: disabled,
      isTopFrame: true,
    });
    await onClaudeDisabled.start();
    expect(disabled).not.toHaveBeenCalled();
    onClaudeDisabled.stop();

    mockState({ 'voyager.test': { enabled: true, installedAt: 1 } });
    const framed = vi.fn();
    const inFrame = new PluginHost({
      url: 'https://claude.ai/chat/1',
      sources: [new StaticSource([claudePlugin])],
      doc: document,
      requestCatalogRefresh: framed,
      isTopFrame: false,
    });
    await inFrame.start();
    expect(framed).not.toHaveBeenCalled();
    inFrame.stop();
  });

  it("reloads its sources when this host's cached catalog changes content, not on bookkeeping writes", async () => {
    mockState({ 'voyager.test': { enabled: true, installedAt: 1 } });
    const list = vi.fn(async () => [manifest(['https://claude.ai/*'])]);
    const host = new PluginHost({
      url: 'https://claude.ai/chat/1',
      sources: [{ id: 'spy', list }],
      doc: document,
      requestCatalogRefresh: () => {},
      isTopFrame: true,
    });
    await host.start();
    expect(list).toHaveBeenCalledTimes(1);

    // Same plugin set, only attempt bookkeeping differs → no reload.
    fireCatalogChange(catalogEntry(['voyager.remote']), {
      ...catalogEntry(['voyager.remote']),
      lastAttemptAt: 99,
      failureCount: 2,
    });
    await flush();
    expect(list).toHaveBeenCalledTimes(1);

    // A different plugin set → reload + reconcile.
    fireCatalogChange(catalogEntry(['voyager.remote']), catalogEntry(['voyager.remote', 'x']));
    await flush();
    expect(list).toHaveBeenCalledTimes(2);

    // Another host's catalog → ignored.
    const listeners = (chrome.storage.onChanged.addListener as unknown as Mock).mock.calls;
    for (const [listener] of listeners) {
      listener({ 'gvPluginHostCatalog:chatgpt.com': { newValue: catalogEntry(['y']) } }, 'local');
    }
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
    host.stop();
  });
});

/** Deliver a plugin-state change to every storage.onChanged subscriber. */
function fireStateChange(state: Record<string, unknown>): void {
  const listeners = (chrome.storage.onChanged.addListener as unknown as Mock).mock.calls;
  for (const [listener] of listeners) {
    listener({ gvPluginsState: { newValue: state } }, 'local');
  }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}
