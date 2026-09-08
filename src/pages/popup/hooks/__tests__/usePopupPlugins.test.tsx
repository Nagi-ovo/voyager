import React, { act, useEffect } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { subscribeHostCatalog } from '@/features/plugins/remote/hostCatalogCache';
import { loadSiteOverrideForHost } from '@/features/plugins/remote/siteOverride';
import { PLUGIN_CATALOG_REFRESH_MESSAGE } from '@/features/plugins/runtime/messages';
import {
  type SourcedPluginManifest,
  listPluginManifestsWithSources,
  refreshPluginManifestsWithSources,
} from '@/features/plugins/sources/defaultSources';
import {
  type PluginStateMap,
  loadPluginState,
  subscribePluginState,
} from '@/features/plugins/storage/pluginState';
import type { SiteAdapter } from '@/features/plugins/types';

import { type PopupPluginsContext, usePopupPlugins } from '../usePopupPlugins';

vi.mock('webextension-polyfill', () => ({
  default: { tabs: { sendMessage: vi.fn() }, runtime: { sendMessage: vi.fn() } },
}));
vi.mock('@/features/plugins/remote/hostCatalogCache', () => ({ subscribeHostCatalog: vi.fn() }));
vi.mock('@/features/plugins/remote/siteOverride', () => ({ loadSiteOverrideForHost: vi.fn() }));
vi.mock('@/features/plugins/sources/defaultSources', () => ({
  listPluginManifestsWithSources: vi.fn(),
  refreshPluginManifestsWithSources: vi.fn(),
}));
vi.mock('@/features/plugins/storage/pluginState', () => ({
  loadPluginState: vi.fn(),
  subscribePluginState: vi.fn(),
}));

type PopupPlugins = ReturnType<typeof usePopupPlugins>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function record(id: string, host = 'claude.ai'): SourcedPluginManifest {
  return {
    sourceId: 'bundled-catalog',
    manifest: {
      id,
      name: id,
      description: 'Popup plugin fixture',
      author: 'Voyager',
      version: '1.0.0',
      engine: '>=1.0.0',
      category: 'readability',
      license: 'MIT',
      tier: 'free',
      matches: [`https://${host}/*`],
      contributes: {},
    },
  };
}

const context: PopupPluginsContext = {
  activeUrl: 'https://claude.ai/chat/example',
  activeTabId: 7,
  activeTabContextLoaded: true,
};

function Harness({
  capture,
  ...props
}: PopupPluginsContext & { capture: (value: PopupPlugins) => void }) {
  const plugins = usePopupPlugins(props);
  useEffect(() => capture(plugins), [capture, plugins]);
  return null;
}

describe('usePopupPlugins', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let plugins: PopupPlugins;
  let catalogs: Map<string, () => void>;
  let stateListeners: Set<(state: PluginStateMap) => void>;
  const capture = (value: PopupPlugins) => {
    plugins = value;
  };
  const render = async (props: PopupPluginsContext = context) => {
    await act(async () => {
      root!.render(<Harness {...props} capture={capture} />);
    });
  };
  const unmount = () => {
    act(() => root!.unmount());
    root = null;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.resetAllMocks();
    catalogs = new Map();
    stateListeners = new Set();
    vi.mocked(subscribeHostCatalog).mockImplementation((host, listener) => {
      catalogs.set(host, listener);
      return () => {
        catalogs.delete(host);
      };
    });
    vi.mocked(subscribePluginState).mockImplementation((listener) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    });
    vi.mocked(listPluginManifestsWithSources).mockResolvedValue([]);
    vi.mocked(refreshPluginManifestsWithSources).mockResolvedValue([]);
    vi.mocked(loadSiteOverrideForHost).mockResolvedValue(null);
    vi.mocked(loadPluginState).mockResolvedValue({});
    vi.mocked(browser.tabs.sendMessage).mockResolvedValue({ ok: true, statuses: [] });
    vi.mocked(browser.runtime.sendMessage).mockResolvedValue({ ok: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) unmount();
    container.remove();
    vi.useRealTimers();
  });

  it('waits for tab context and keeps complete records separate from site-visible plugins', async () => {
    const records = deferred<readonly SourcedPluginManifest[]>();
    const state = deferred<PluginStateMap>();
    const claude = {
      ...record('claude-tools'),
      blockedUpdate: { version: '2.0.0', engine: '>=2' },
    };
    const chatgpt = record('chatgpt-tools', 'chatgpt.com');
    vi.mocked(listPluginManifestsWithSources).mockReturnValue(records.promise);
    vi.mocked(loadPluginState).mockReturnValue(state.promise);

    await render({ ...context, activeTabContextLoaded: false });
    expect(listPluginManifestsWithSources).not.toHaveBeenCalled();
    expect(plugins.pluginsLoading).toBe(true);
    expect(plugins.pluginStateLoaded).toBe(false);

    await act(async () => state.resolve({ 'chatgpt-tools': { enabled: true, installedAt: 1 } }));
    expect(plugins.pluginStateLoaded).toBe(true);
    await render();
    expect(listPluginManifestsWithSources).toHaveBeenCalledWith(undefined, {
      url: context.activeUrl,
      host: 'claude.ai',
    });
    await act(async () => records.resolve([claude, chatgpt]));

    expect(plugins.pluginsLoading).toBe(false);
    expect(plugins.pluginManifests).toEqual([claude.manifest, chatgpt.manifest]);
    expect(plugins.siteScopedManifests).toEqual([claude.manifest]);
    expect(plugins.pluginSourceIds).toEqual({
      'claude-tools': 'bundled-catalog',
      'chatgpt-tools': 'bundled-catalog',
    });
    expect(plugins.pluginBlockedUpdates).toEqual({ 'claude-tools': claude.blockedUpdate });
    expect(plugins.diagnosticPlugins).toEqual([
      expect.objectContaining({ id: 'claude-tools', enabled: false, source: 'bundled-catalog' }),
      expect.objectContaining({ id: 'chatgpt-tools', enabled: true, source: 'bundled-catalog' }),
    ]);

    await act(async () => {
      for (const listener of stateListeners)
        listener({ 'claude-tools': { enabled: true, installedAt: 2 } });
    });
    expect(plugins.pluginState['claude-tools'].enabled).toBe(true);
    expect(plugins.diagnosticPlugins[0].enabled).toBe(true);
  });

  it('follows the new host catalog and ignores the previous host load after its cleanup', async () => {
    const oldRecords = deferred<readonly SourcedPluginManifest[]>();
    const oldOverride = deferred<SiteAdapter | null>();
    const current = record('chatgpt-tools', 'chatgpt.com');
    vi.mocked(listPluginManifestsWithSources)
      .mockReturnValueOnce(oldRecords.promise)
      .mockResolvedValue([current]);
    vi.mocked(loadSiteOverrideForHost).mockReturnValueOnce(oldOverride.promise);
    await render();
    expect([...catalogs.keys()]).toEqual(['claude.ai']);

    await render({ ...context, activeUrl: 'https://chatgpt.com/c/example', activeTabId: 8 });
    expect([...catalogs.keys()]).toEqual(['chatgpt.com']);
    expect(plugins.pluginCatalogHost).toBe('chatgpt.com');
    expect(plugins.siteScopedManifests).toEqual([current.manifest]);
    await act(async () => {
      oldRecords.resolve([record('stale-claude')]);
      oldOverride.resolve({
        id: 'claude',
        label: 'Old host',
        matches: [],
        selectors: {},
        theme: { hostSelector: 'body', lightSelector: '.light', darkSelector: '.dark' },
        capabilities: new Set(),
      });
    });
    expect(plugins.pluginManifests).toEqual([current.manifest]);
    expect(plugins.pluginSiteOverride).toBeNull();

    const updated = { ...current, manifest: { ...current.manifest, version: '1.1.0' } };
    vi.mocked(listPluginManifestsWithSources).mockResolvedValue([updated]);
    await act(async () => catalogs.get('chatgpt.com')!());
    expect(plugins.pluginManifests[0].version).toBe('1.1.0');
  });

  it('receives the delayed status verdict and removes subscriptions and pending polling on unmount', async () => {
    const status = { id: 'claude-tools', version: '1.0.0', kind: 'mounted' };
    await render();
    expect(plugins.pluginStatuses).toEqual([]);
    vi.mocked(browser.tabs.sendMessage).mockResolvedValue({ ok: true, statuses: [status] });
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(plugins.pluginStatuses).toEqual([status]);

    await act(async () => {
      for (const listener of stateListeners) listener({});
    });
    const calls = vi.mocked(browser.tabs.sendMessage).mock.calls.length;
    unmount();
    expect(catalogs.size).toBe(0);
    expect(stateListeners.size).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(calls);
  });

  it('re-reads the cached catalog after a manual background refresh fails', async () => {
    const refreshed = deferred<readonly SourcedPluginManifest[]>();
    const latest = record('cached-tools');
    vi.mocked(browser.runtime.sendMessage).mockRejectedValue(new Error('background unavailable'));
    vi.mocked(refreshPluginManifestsWithSources).mockReturnValue(refreshed.promise);
    await render();
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = plugins.refresh();
    });
    expect(plugins.pluginsRefreshing).toBe(true);
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: PLUGIN_CATALOG_REFRESH_MESSAGE,
      payload: { host: 'claude.ai', force: true },
    });
    await act(async () => {
      refreshed.resolve([latest]);
      await refresh;
    });
    expect(plugins.pluginManifests).toEqual([latest.manifest]);
    expect(plugins.pluginsRefreshing).toBe(false);
  });
});
