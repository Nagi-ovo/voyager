import { useCallback, useEffect, useMemo, useState } from 'react';

import browser from 'webextension-polyfill';

import {
  type DiagnosticPluginInput,
  diagnosticPluginSourceFromId,
} from '@/core/services/DiagnosticsExportService';
import { subscribeHostCatalog } from '@/features/plugins/remote/hostCatalogCache';
import { catalogHostFromUrl } from '@/features/plugins/remote/hostCatalogPolicy';
import { loadSiteOverrideForHost } from '@/features/plugins/remote/siteOverride';
import {
  PLUGIN_CATALOG_REFRESH_MESSAGE,
  PLUGIN_STATUS_MESSAGE,
} from '@/features/plugins/runtime/messages';
import type { PluginStatus } from '@/features/plugins/runtime/pluginStatus';
import { matchesAnyPattern } from '@/features/plugins/sites/matchPattern';
import {
  type BlockedPluginUpdate,
  type SourcedPluginManifest,
  listPluginManifestsWithSources,
  refreshPluginManifestsWithSources,
} from '@/features/plugins/sources/defaultSources';
import {
  type PluginStateMap,
  loadPluginState,
  subscribePluginState,
} from '@/features/plugins/storage/pluginState';
import type { PluginManifest, SiteAdapter } from '@/features/plugins/types';

export interface PopupPluginsContext {
  activeUrl: string;
  activeTabId: number | null;
  activeTabContextLoaded: boolean;
}

/** Plugin catalog, installed state and active-tab status for one popup lifetime. */
export function usePopupPlugins({
  activeUrl,
  activeTabId,
  activeTabContextLoaded,
}: PopupPluginsContext) {
  const [pluginManifests, setPluginManifests] = useState<readonly PluginManifest[]>([]);
  const [pluginSourceIds, setPluginSourceIds] = useState<Readonly<Record<string, string>>>({});
  const [pluginBlockedUpdates, setPluginBlockedUpdates] = useState<
    Readonly<Record<string, BlockedPluginUpdate>>
  >({});
  // Site adapter published for the active host through the remote catalog, if
  // any; it replaces the bundled adapter's label and brand colour.
  const [pluginSiteOverride, setPluginSiteOverride] = useState<SiteAdapter | null>(null);
  // Statuses computed by the active tab's PluginHost (plan §4.2); empty when
  // the tab has no content script, in which case the card infers locally.
  const [pluginStatuses, setPluginStatuses] = useState<readonly PluginStatus[]>([]);
  const [pluginState, setPluginState] = useState<PluginStateMap>({});
  const [pluginStateLoaded, setPluginStateLoaded] = useState(false);
  const [pluginsLoading, setPluginsLoading] = useState<boolean>(true);
  const [pluginsRefreshing, setPluginsRefreshing] = useState<boolean>(false);

  // Plugins whose match patterns cover the active tab's URL. A plugin only ever
  // shows on — and only affects — the site it targets, so Claude plugins appear
  // only on Claude, ChatGPT plugins only on ChatGPT, and neither on Gemini.
  const siteScopedManifests = useMemo(
    () => pluginManifests.filter((plugin) => matchesAnyPattern(activeUrl, plugin.matches)),
    [activeUrl, pluginManifests],
  );
  const diagnosticPlugins = useMemo<readonly DiagnosticPluginInput[]>(
    () =>
      pluginManifests.map((plugin) => {
        const state = pluginState[plugin.id];
        return {
          id: plugin.id,
          version: plugin.version,
          source: diagnosticPluginSourceFromId(pluginSourceIds[plugin.id]),
          enabled: state?.enabled ?? false,
          settingsSchema: plugin.contributes.settings,
          settings: state?.settings,
        };
      }),
    [pluginManifests, pluginSourceIds, pluginState],
  );
  // Host of the active tab for the per-host remote plugin catalog; undefined
  // until the tab is known and for hosts that can never have a catalog file.
  const pluginCatalogHost = useMemo(() => catalogHostFromUrl(activeUrl), [activeUrl]);

  const applyPluginRecords = useCallback((records: readonly SourcedPluginManifest[]) => {
    setPluginManifests(records.map(({ manifest }) => manifest));
    setPluginSourceIds(
      Object.fromEntries(records.map(({ manifest, sourceId }) => [manifest.id, sourceId])),
    );
    setPluginBlockedUpdates(
      Object.fromEntries(
        records.flatMap(({ manifest, blockedUpdate }) =>
          blockedUpdate ? [[manifest.id, blockedUpdate] as const] : [],
        ),
      ),
    );
  }, []);

  const refresh = useCallback(async () => {
    setPluginsRefreshing(true);
    try {
      // Manual check (plan D4): always allowed, bypasses the interval, the
      // online-update switch and any failure backoff. The background fetches;
      // the popup only re-reads the cache afterwards.
      if (pluginCatalogHost) {
        try {
          await browser.runtime.sendMessage({
            type: PLUGIN_CATALOG_REFRESH_MESSAGE,
            payload: { host: pluginCatalogHost, force: true },
          });
        } catch {
          // Background unavailable; fall through and re-read what is cached.
        }
      }
      applyPluginRecords(
        await refreshPluginManifestsWithSources({ url: activeUrl, host: pluginCatalogHost }),
      );
    } finally {
      setPluginsRefreshing(false);
    }
  }, [activeUrl, applyPluginRecords, pluginCatalogHost]);

  // Ask the active tab's PluginHost for plugin statuses (needs-engine,
  // needs-handler, mounted, no-effect, pending version …). The health verdict
  // arrives once the page has been quiet for a while, so poll once more
  // shortly after opening. A tab without a content script simply answers
  // nothing and the card falls back to local inference.
  const refreshPluginStatuses = useCallback(async () => {
    if (activeTabId === null) return;
    try {
      const response = (await browser.tabs.sendMessage(activeTabId, {
        type: PLUGIN_STATUS_MESSAGE,
      })) as { ok?: boolean; statuses?: readonly PluginStatus[] } | undefined;
      if (response?.ok && Array.isArray(response.statuses)) {
        setPluginStatuses(response.statuses);
      }
    } catch {
      // No content script in this tab (not a plugin site, or not injected yet).
    }
  }, [activeTabId]);

  useEffect(() => {
    void refreshPluginStatuses();
    const later = setTimeout(() => void refreshPluginStatuses(), 2500);
    return () => clearTimeout(later);
  }, [refreshPluginStatuses, pluginManifests, pluginState]);

  // Load plugin manifests: builtin + bundled snapshot + the cached remote
  // catalog for the active tab's host. Waits for the tab context so the remote
  // tier is read for the right host, and re-reads whenever the background
  // writes a CHANGED catalog for that host.
  useEffect(() => {
    if (!activeTabContextLoaded) return;
    let active = true;
    const context = { url: activeUrl, host: pluginCatalogHost };
    const load = (): void => {
      void listPluginManifestsWithSources(undefined, context)
        .then((records) => {
          if (active) applyPluginRecords(records);
        })
        .finally(() => {
          if (active) setPluginsLoading(false);
        });
      void loadSiteOverrideForHost(pluginCatalogHost).then((override) => {
        if (active) setPluginSiteOverride(override);
      });
    };
    load();
    const unsubscribe = pluginCatalogHost
      ? subscribeHostCatalog(pluginCatalogHost, load)
      : () => {};
    return () => {
      active = false;
      unsubscribe();
    };
  }, [activeTabContextLoaded, activeUrl, applyPluginRecords, pluginCatalogHost]);

  useEffect(() => {
    let active = true;
    void loadPluginState().then((state) => {
      if (active) {
        setPluginState(state);
        setPluginStateLoaded(true);
      }
    });
    const unsubscribe = subscribePluginState((state) => {
      if (active) setPluginState(state);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return {
    pluginManifests,
    pluginSourceIds,
    pluginBlockedUpdates,
    pluginSiteOverride,
    pluginStatuses,
    pluginState,
    pluginStateLoaded,
    pluginsLoading,
    pluginsRefreshing,
    pluginCatalogHost,
    siteScopedManifests,
    diagnosticPlugins,
    refresh,
  };
}
