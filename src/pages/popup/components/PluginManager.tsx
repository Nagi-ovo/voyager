import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import browser from 'webextension-polyfill';

import {
  isFirefox,
  supportsDynamicContentScriptRegistration,
  supportsOptionalHostPermissions,
} from '@/core/utils/browser';
import {
  type HostCatalogCacheEntry,
  loadHostCatalogCache,
  subscribeHostCatalog,
} from '@/features/plugins/remote/hostCatalogCache';
import {
  PLUGIN_CATALOG_CHECK_INTERVALS,
  type PluginCatalogCheckInterval,
  normalizeCheckInterval,
} from '@/features/plugins/remote/hostCatalogPolicy';
import {
  DEFAULT_PLUGIN_CATALOG_SETTINGS,
  type PluginCatalogSettings,
  loadPluginCatalogSettings,
  savePluginCatalogSettings,
  subscribePluginCatalogSettings,
} from '@/features/plugins/remote/hostCatalogSettings';
import { PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE } from '@/features/plugins/runtime/messages';
import type { PluginStatus } from '@/features/plugins/runtime/pluginStatus';
import { pluginToOriginPatternsForActiveUrl } from '@/features/plugins/runtime/siteRegistration';
import { matchesAnyPattern } from '@/features/plugins/sites/matchPattern';
import { SiteRegistry } from '@/features/plugins/sites/registry';
import type { BlockedPluginUpdate } from '@/features/plugins/sources/defaultSources';
import {
  loadCollapsedPlugins,
  loadPluginState,
  loadSeenPluginVersions,
  markPluginVersionsSeen,
  setPluginCollapsed,
  setPluginEnabled,
  setPluginSetting,
  subscribePluginState,
} from '@/features/plugins/storage/pluginState';
import type { PluginManifest, PluginSettingValue, SettingField } from '@/features/plugins/types';
import type { TranslationKey } from '@/utils/translations';

import { Card, CardContent, CardTitle } from '../../../components/ui/card';
import { Switch } from '../../../components/ui/switch';
import { useLanguage } from '../../../contexts/LanguageContext';
import { IconChatGPT, IconClaude, IconDeepSeek } from './WebsiteLogos';

type EnabledMap = Record<string, boolean>;
type SettingsMap = Record<string, Record<string, PluginSettingValue>>;

/**
 * Ask the background service to reconcile dynamic plugin content scripts after
 * an optional host permission grant. This is best-effort because Chrome may
 * close the popup while displaying its permission prompt; the background
 * permissions listener remains the fallback in that case. Returns whether the
 * background confirmed that reconciliation completed.
 */
async function requestPluginContentScriptSync(): Promise<boolean> {
  try {
    const response = (await browser.runtime.sendMessage({
      type: PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE,
    })) as { ok?: unknown } | null;
    return response?.ok === true;
  } catch {
    // Chrome may close the popup while showing the optional-host prompt. The
    // background permissions.onAdded listener remains the fallback in that case.
    return false;
  }
}

/**
 * Where a listed plugin came from. Anything else (an unknown source id, or a
 * manifest the parent could not attribute) shows the version alone rather than
 * a made-up provenance label.
 */
const SOURCE_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
  builtin: 'pluginSourceBuiltin',
  'bundled-catalog': 'pluginSourceBundled',
  'host-catalog': 'pluginSourceOnline',
};

const CHECK_INTERVAL_LABEL_KEYS: Readonly<Record<PluginCatalogCheckInterval, TranslationKey>> = {
  '1h': 'pluginsIntervalHourly',
  '6h': 'pluginsIntervalSixHours',
  '24h': 'pluginsIntervalDaily',
  manual: 'pluginsIntervalManual',
};

/** Logo + default accent per known site id. */
const SITE_BADGES: Record<string, { Icon: typeof IconClaude; color: string }> = {
  claude: { Icon: IconClaude, color: '#d97757' },
  chatgpt: { Icon: IconChatGPT, color: '#0ea5e9' },
  deepseek: { Icon: IconDeepSeek, color: '#4d6bfe' },
};

/**
 * Platform logo + brand color for a plugin. Prefers the site the popup is
 * actually open on (`currentSiteId`) so a multi-site plugin (e.g. formula-copy
 * matching both Claude and ChatGPT) shows the CURRENT site's logo — not whichever
 * match string happens to be first. Falls back to inferring from the plugin's
 * match hosts. Colour prefers the plugin's declared `theme.brand`.
 */
export function platformBadge(
  plugin: PluginManifest,
  currentSiteId?: string,
  activeUrl?: string,
): { icon: ReactNode; color: string } | null {
  const brand = plugin.theme?.brand;
  if (activeUrl && !matchesAnyPattern(activeUrl, plugin.matches)) return null;
  const current = currentSiteId ? SITE_BADGES[currentSiteId] : undefined;
  if (current) return { icon: <current.Icon />, color: brand ?? current.color };
  const hosts = plugin.matches.flatMap((pattern) => {
    const match = /^(?:https?|\*):\/\/([^/]+)\//i.exec(pattern);
    return match ? [match[1]] : [];
  });
  if (hosts.includes('claude.ai'))
    return { icon: <IconClaude />, color: brand ?? SITE_BADGES.claude.color };
  if (hosts.includes('chatgpt.com') || hosts.includes('chat.openai.com'))
    return { icon: <IconChatGPT />, color: brand ?? SITE_BADGES.chatgpt.color };
  if (hosts.includes('chat.deepseek.com'))
    return { icon: <IconDeepSeek />, color: brand ?? SITE_BADGES.deepseek.color };
  return null;
}

/** Strip a redundant "Claude · " / "ChatGPT · " platform prefix (the logo shows it). */
function displayName(name: string): string {
  return name.replace(/^(Claude|ChatGPT|Gemini|AI Studio|DeepSeek)\s*[·:|]\s*/i, '');
}

/**
 * Localized field for the current UI language, falling back to the manifest's
 * top-level English. Plugins should use Voyager language keys (`zh`, `zh_TW`,
 * `ja`, …), but we accept common locale variants so cached or third-party
 * manifests do not leak English when the app is already localized.
 */
function localeCandidates(lang: string): string[] {
  const normalized = lang.replace('-', '_');
  const lower = normalized.toLowerCase();
  const candidates = [lang, normalized];

  if (lower === 'zh_tw' || lower === 'zh_hk' || lower.includes('hant')) {
    candidates.push('zh_TW');
  }
  if (lower.startsWith('zh')) candidates.push('zh');

  const base = normalized.split('_')[0];
  if (base) candidates.push(base);
  candidates.push('en');

  return Array.from(new Set(candidates));
}

function pickLocalized(plugin: PluginManifest, field: 'name' | 'description', lang: string): string;
function pickLocalized(
  plugin: PluginManifest,
  field: 'changelog',
  lang: string,
): string | undefined;
function pickLocalized(
  plugin: PluginManifest,
  field: 'name' | 'description' | 'changelog',
  lang: string,
): string | undefined {
  for (const locale of localeCandidates(lang)) {
    const value = plugin.i18n?.[locale]?.[field];
    // A blank localized string must not shadow the base value.
    if (value?.trim()) return value;
  }
  return plugin[field];
}

function pickLocalizedSetting(
  plugin: PluginManifest,
  key: string,
  field: SettingField,
  lang: string,
): { label: string; minLabel?: string; maxLabel?: string } {
  const pick = (name: 'label' | 'minLabel' | 'maxLabel'): string | undefined => {
    for (const locale of localeCandidates(lang)) {
      const value = plugin.i18n?.[locale]?.settings?.[key]?.[name];
      if (value) return value;
    }
    return undefined;
  };
  return {
    label: pick('label') ?? field.label,
    minLabel: pick('minLabel') ?? field.minLabel,
    maxLabel: pick('maxLabel') ?? field.maxLabel,
  };
}

/** Human-readable host list from a plugin's match patterns (e.g. "claude.ai"). */
function siteHostsFromMatches(matches: readonly string[]): string {
  const hosts = matches
    .map((pattern) =>
      pattern
        .replace(/^[a-z*]+:\/\//i, '')
        .replace(/\/.*$/, '')
        .replace(/^\*\./, ''),
    )
    .filter(Boolean);
  return Array.from(new Set(hosts)).join(', ');
}

function readState(
  state: Record<string, { enabled: boolean; settings?: Record<string, PluginSettingValue> }>,
): {
  enabled: EnabledMap;
  settings: SettingsMap;
} {
  const enabled: EnabledMap = {};
  const settings: SettingsMap = {};
  for (const [id, entry] of Object.entries(state)) {
    enabled[id] = entry.enabled === true;
    if (entry.settings) settings[id] = { ...entry.settings };
  }
  return { enabled, settings };
}

/** GitHub mark — links to the plugin's repo path. */
function GitHubIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export interface PluginManagerProps {
  /** Plugin manifests from bundled and remote sources (loaded by the parent). */
  readonly manifests: readonly PluginManifest[];
  /** True while the manifest list is still loading. */
  readonly loading?: boolean;
  /** Force-refresh the remote marketplace and re-read bundled manifests. */
  readonly onRefresh?: () => void;
  /** True while a manual refresh is in flight. */
  readonly refreshing?: boolean;
  /** URL of the active tab — selects which platform logo each plugin shows. */
  readonly activeUrl?: string;
  /**
   * Source id per plugin id: `builtin` (first-party JS), `bundled-catalog`
   * (snapshot shipped with this build) or `host-catalog` (fetched from the
   * remote catalog for the active host). Drives the per-plugin source label.
   */
  readonly sourceIds?: Readonly<Record<string, string>>;
  /** Remote updates held back because they need a newer engine than this build (plan D6). */
  readonly blockedUpdates?: Readonly<Record<string, BlockedPluginUpdate>>;
  /** Host whose remote catalog this popup reads; undefined on hosts that can never have one. */
  readonly catalogHost?: string;
  /**
   * Per-plugin status reported by the active tab's PluginHost (plan §4.2):
   * needs-engine / needs-handler / needs-semantic disable the toggle with a
   * reason, no-effect shows the health warning, pendingVersion says the update
   * applies after a page reload. Empty when the tab reported nothing.
   */
  readonly statuses?: readonly PluginStatus[];
}

/**
 * Render the popup's plugin catalog and manage each plugin's enabled state,
 * optional host access, platform-specific settings, and refresh lifecycle.
 */
export function PluginManager({
  manifests,
  loading = false,
  onRefresh,
  refreshing = false,
  activeUrl,
  sourceIds,
  blockedUpdates,
  catalogHost,
  statuses,
}: PluginManagerProps) {
  const { t, language } = useLanguage();
  // The site the popup is currently open on — the "active site" the badge needs
  // to pick the right logo for a multi-site plugin. Resolved via the shared
  // SiteRegistry (single source of truth for "which site is this URL").
  const currentSite = useMemo(
    () => (activeUrl ? SiteRegistry.createDefault().resolveByUrl(activeUrl) : null),
    [activeUrl],
  );
  const currentSiteId = currentSite?.id ?? undefined;
  // Human name for the active site, used by the needs-semantic reason. The
  // adapter's own label is the friendly one; without an adapter the bare host
  // is still more informative than a blank.
  const currentSiteLabel = useMemo(() => {
    if (currentSite) return currentSite.label;
    if (!activeUrl) return undefined;
    try {
      return new URL(activeUrl).hostname;
    } catch {
      return undefined;
    }
  }, [activeUrl, currentSite]);
  // Status per plugin id. A plugin the tab said nothing about keeps today's
  // behaviour (enabled toggle, no note).
  const statusById = useMemo(() => {
    const map = new Map<string, PluginStatus>();
    for (const status of statuses ?? []) map.set(status.id, status);
    return map;
  }, [statuses]);
  const [enabledMap, setEnabledMap] = useState<EnabledMap>({});
  const [settingsMap, setSettingsMap] = useState<SettingsMap>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [deniedId, setDeniedId] = useState<string | null>(null);
  const [unsupportedId, setUnsupportedId] = useState<string | null>(null);
  const [missingPermissionIds, setMissingPermissionIds] = useState<Set<string>>(new Set());
  const [catalogSettings, setCatalogSettings] = useState<PluginCatalogSettings>(
    DEFAULT_PLUGIN_CATALOG_SETTINGS,
  );
  const [catalogEntry, setCatalogEntry] = useState<HostCatalogCacheEntry | null>(null);
  // Previous `refreshing` value, so a manual check that only moved the attempt
  // timestamp still refreshes the status line: subscribeHostCatalog
  // deliberately stays quiet for bookkeeping-only writes.
  const wasRefreshing = useRef(false);
  // "Updated" badges (plan D11). The seen-version snapshot is read once per
  // popup session and never refreshed from storage afterwards, so the versions
  // can be marked seen immediately while the chips stay on screen for as long
  // as this popup is open.
  const seenVersions = useRef<Readonly<Record<string, string>>>({});
  const [seenVersionsLoaded, setSeenVersionsLoaded] = useState(false);
  const [updatedIds, setUpdatedIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  // Coalesced persistence for setting sliders (see handleSetting). Keyed by
  // `${pluginId}:${settingKey}` so independent sliders keep independent timers.
  const settingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingSettings = useRef(
    new Map<string, { id: string; key: string; value: PluginSettingValue }>(),
  );

  useEffect(() => {
    let active = true;
    void loadPluginState().then((state) => {
      if (!active) return;
      const { enabled, settings } = readState(state);
      setEnabledMap(enabled);
      setSettingsMap(settings);
    });
    void loadCollapsedPlugins().then((ids) => {
      if (active) setCollapsed(new Set(ids));
    });
    const unsubscribe = subscribePluginState((state) => {
      const { enabled, settings } = readState(state);
      setEnabledMap(enabled);
      setSettingsMap(settings);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void loadSeenPluginVersions().then((versions) => {
      if (!active) return;
      seenVersions.current = versions;
      setSeenVersionsLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  // Compare the listed manifests against the snapshot, then record what this
  // popup showed. A plugin seen here for the FIRST time is new, not updated, so
  // it gets no chip — only a version that differs from a recorded one does.
  useEffect(() => {
    if (!seenVersionsLoaded || manifests.length === 0) return;
    const seen = seenVersions.current;
    const changed = manifests
      .filter((plugin) => {
        const previous = seen[plugin.id];
        return previous !== undefined && previous !== plugin.version;
      })
      .map((plugin) => plugin.id);
    if (changed.length > 0) {
      setUpdatedIds((previous) => {
        if (changed.every((id) => previous.has(id))) return previous;
        return new Set([...previous, ...changed]);
      });
    }
    const versions: Record<string, string> = {};
    for (const plugin of manifests) versions[plugin.id] = plugin.version;
    void markPluginVersionsSeen(versions);
  }, [manifests, seenVersionsLoaded]);

  // Plugin updates can add a narrowly-scoped companion origin after a user has
  // already enabled the plugin. Chrome cannot grant that new optional origin in
  // the background, so surface an explicit user-gesture repair instead of
  // silently leaving the new surface inactive.
  useEffect(() => {
    let active = true;
    if (!browser.permissions?.contains) return;

    const enabledPlugins = manifests.filter((plugin) => enabledMap[plugin.id] === true);
    void Promise.all(
      enabledPlugins.map(async (plugin): Promise<string | null> => {
        const origins = pluginToOriginPatternsForActiveUrl(plugin, activeUrl);
        if (!origins.length) return null;
        try {
          return (await browser.permissions.contains({ origins })) ? null : plugin.id;
        } catch {
          return null;
        }
      }),
    ).then((missingIds) => {
      if (active) setMissingPermissionIds(new Set(missingIds.filter((id): id is string => !!id)));
    });

    return () => {
      active = false;
    };
  }, [activeUrl, enabledMap, manifests]);

  // The two catalog controls live in sync storage, so another window (or the
  // settings backup restoring them) must be reflected here while the popup is
  // open. Only hosts that can have a catalog show the block, so skip the read
  // entirely elsewhere.
  useEffect(() => {
    if (!catalogHost) return;
    let active = true;
    void loadPluginCatalogSettings().then((settings) => {
      if (active) setCatalogSettings(settings);
    });
    const unsubscribe = subscribePluginCatalogSettings((settings) => {
      if (active) setCatalogSettings(settings);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [catalogHost]);

  useEffect(() => {
    if (!catalogHost) {
      setCatalogEntry(null);
      return;
    }
    let active = true;
    const read = (): void => {
      void loadHostCatalogCache(catalogHost).then((entry) => {
        if (active) setCatalogEntry(entry);
      });
    };
    read();
    // Bookkeeping-only writes (an automatic attempt that found nothing new)
    // still move "last checked", so this view listens to every write.
    const unsubscribe = subscribeHostCatalog(catalogHost, read, { includeBookkeeping: true });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [catalogHost]);

  useEffect(() => {
    const justFinished = wasRefreshing.current && !refreshing;
    wasRefreshing.current = refreshing;
    if (!catalogHost || !justFinished) return;
    let active = true;
    void loadHostCatalogCache(catalogHost).then((entry) => {
      if (active) setCatalogEntry(entry);
    });
    return () => {
      active = false;
    };
  }, [catalogHost, refreshing]);

  const handleOnlineUpdatesToggle = useCallback((next: boolean) => {
    setCatalogSettings((previous) => ({ ...previous, onlineUpdatesEnabled: next }));
    void savePluginCatalogSettings({ onlineUpdatesEnabled: next });
  }, []);

  const handleCheckIntervalChange = useCallback((value: string) => {
    const interval = normalizeCheckInterval(value);
    setCatalogSettings((previous) => ({ ...previous, checkInterval: interval }));
    void savePluginCatalogSettings({ checkInterval: interval });
  }, []);

  const handleToggle = useCallback(
    async (plugin: PluginManifest, next: boolean) => {
      setDeniedId(null);
      setUnsupportedId(null);
      if (next) {
        const origins = pluginToOriginPatternsForActiveUrl(plugin, activeUrl);
        if (origins.length > 0) {
          // This plugin needs host access on a site Voyager reaches only via dynamic
          // content-script registration. If the platform can't grant or inject that
          // (an old Safari/build without the required APIs, or Firefox < 128 which
          // ignores optional_host_permissions), enabling would be a silent no-op —
          // so refuse and explain, instead of a misleading toggle.
          if (
            !browser.permissions?.request ||
            !supportsOptionalHostPermissions() ||
            !supportsDynamicContentScriptRegistration()
          ) {
            setUnsupportedId(plugin.id);
            return;
          }
          try {
            // Firefox requires permissions.request to be the first await in the
            // user gesture, so skip the contains() pre-check there.
            if (!isFirefox() && browser.permissions.contains) {
              const alreadyGranted = await browser.permissions.contains({ origins });
              if (!alreadyGranted) {
                // Chrome closes extension popups while showing an optional-host
                // prompt. Persist the user's intent BEFORE opening it so a
                // successful grant can be completed by the background even if
                // the popup is closed before permissions.request resolves.
                setEnabledMap((prev) => ({ ...prev, [plugin.id]: true }));
                await setPluginEnabled(plugin.id, true);
                const granted = await browser.permissions.request({ origins });
                if (!granted) {
                  setEnabledMap((prev) => ({ ...prev, [plugin.id]: false }));
                  await setPluginEnabled(plugin.id, false);
                  setDeniedId(plugin.id);
                } else {
                  // Edge can resolve the request without reliably delivering the
                  // permissions.onAdded event that normally performs registration.
                  // Reconcile explicitly while retaining onAdded as Chrome's
                  // popup-close fallback.
                  await requestPluginContentScriptSync();
                }
                return;
              }
            } else if (!(await browser.permissions.request({ origins }))) {
              setDeniedId(plugin.id);
              return;
            }
          } catch {
            setEnabledMap((prev) => ({ ...prev, [plugin.id]: false }));
            await setPluginEnabled(plugin.id, false);
            setDeniedId(plugin.id);
            return;
          }
        }
      }
      setEnabledMap((prev) => ({ ...prev, [plugin.id]: next }));
      await setPluginEnabled(plugin.id, next);
    },
    [activeUrl],
  );

  const handleSetting = useCallback((id: string, key: string, value: PluginSettingValue) => {
    // Keep the visible slider value instant via local state, but DEBOUNCE the
    // storage write. A range drag fires onChange on every step; each persist is
    // a read-modify-write of chrome.storage.local that, via storage.onChanged,
    // makes the content script re-render the plugin CSS and reflow the (wide)
    // thread. Writing per-tick would fire dozens of those round-trips + reflows
    // per drag (and the concurrent read-modify-writes could race). We coalesce
    // to the last value ~200ms after the user stops moving.
    setSettingsMap((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }));
    const mapKey = `${id}:${key}`;
    pendingSettings.current.set(mapKey, { id, key, value });
    const existing = settingTimers.current.get(mapKey);
    if (existing) clearTimeout(existing);
    settingTimers.current.set(
      mapKey,
      setTimeout(() => {
        settingTimers.current.delete(mapKey);
        const pending = pendingSettings.current.get(mapKey);
        if (!pending) return;
        pendingSettings.current.delete(mapKey);
        void setPluginSetting(pending.id, pending.key, pending.value);
      }, 200),
    );
  }, []);

  const handleImmediateSetting = useCallback(
    (id: string, key: string, value: PluginSettingValue) => {
      setSettingsMap((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }));
      void setPluginSetting(id, key, value);
    },
    [],
  );

  const handleGrantRequiredAccess = useCallback(
    async (plugin: PluginManifest) => {
      setDeniedId(null);
      setUnsupportedId(null);
      const origins = pluginToOriginPatternsForActiveUrl(plugin, activeUrl);
      if (!origins.length) {
        setMissingPermissionIds((previous) => {
          const next = new Set(previous);
          next.delete(plugin.id);
          return next;
        });
        return;
      }
      if (
        !browser.permissions?.request ||
        !supportsOptionalHostPermissions() ||
        !supportsDynamicContentScriptRegistration()
      ) {
        setUnsupportedId(plugin.id);
        return;
      }
      try {
        if (!(await browser.permissions.request({ origins }))) {
          setDeniedId(plugin.id);
          return;
        }
        if (!(await requestPluginContentScriptSync())) return;
        setMissingPermissionIds((previous) => {
          const next = new Set(previous);
          next.delete(plugin.id);
          return next;
        });
      } catch {
        setDeniedId(plugin.id);
      }
    },
    [activeUrl],
  );

  // Flush any pending setting write if the popup closes mid-drag, so the user's
  // final value is never lost to the debounce window.
  useEffect(() => {
    const timers = settingTimers.current;
    const pending = pendingSettings.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const { id, key, value } of pending.values()) void setPluginSetting(id, key, value);
      pending.clear();
    };
  }, []);

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      const willCollapse = !prev.has(id);
      if (willCollapse) next.add(id);
      else next.delete(id);
      // Persist so the expanded/collapsed choice survives reopening the popup.
      void setPluginCollapsed(id, willCollapse);
      return next;
    });
  }, []);

  const hasUpdatedPlugins = manifests.some((plugin) => updatedIds.has(plugin.id));

  /**
   * One line describing the online catalog for this host: a 404 is a settled
   * answer ("this site has no catalog"), so it replaces the timestamp rather
   * than reading as a stale successful check.
   */
  const catalogStatusText = ((): string => {
    if (catalogEntry?.status === 'missing') return t('pluginsNoOnlineCatalog');
    if (!catalogEntry?.lastAttemptAt) return t('pluginsNeverChecked');
    return t('pluginsLastChecked').replace(
      '{time}',
      new Date(catalogEntry.lastAttemptAt).toLocaleString(),
    );
  })();

  return (
    <Card className="p-4 transition-all hover:shadow-md">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <CardTitle>{t('pluginsTitle')}</CardTitle>
          {hasUpdatedPlugins && (
            <span
              data-testid="plugin-updates-dot"
              className="bg-primary inline-block h-1.5 w-1.5 rounded-full"
              aria-hidden="true"
            />
          )}
        </div>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            title={t('pluginsRefresh')}
            aria-label={t('pluginsRefresh')}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={refreshing ? 'animate-spin' : ''}
              aria-hidden="true"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
            </svg>
          </button>
        )}
      </div>
      <CardContent className="space-y-3 p-0">
        <p className="text-muted-foreground text-xs">{t('pluginsDescription')}</p>

        {manifests.length === 0 && (
          <p className="text-muted-foreground text-xs">
            {loading ? t('pluginsLoading') : t('pluginsEmpty')}
          </p>
        )}

        {manifests.map((plugin) => {
          const enabled = enabledMap[plugin.id] === true;
          const isOpen = !collapsed.has(plugin.id);
          const hosts = siteHostsFromMatches(plugin.matches);
          const settingsSchema = plugin.contributes.settings;
          const badge = platformBadge(plugin, currentSiteId, activeUrl);
          const localizedName = pickLocalized(plugin, 'name', language);
          const needsSiteAccess = enabled && missingPermissionIds.has(plugin.id);
          const sourceLabelKey = SOURCE_LABEL_KEYS[sourceIds?.[plugin.id] ?? ''];
          const provenance = sourceLabelKey
            ? `v${plugin.version} · ${t(sourceLabelKey)}`
            : `v${plugin.version}`;
          const blockedUpdate = blockedUpdates?.[plugin.id];
          const changelog = pickLocalized(plugin, 'changelog', language);
          const isUpdated = updatedIds.has(plugin.id);
          const status = statusById.get(plugin.id);
          // Only the three incompatibility kinds block the toggle; `no-effect`
          // stays enabled because the plugin did run, it just found no targets.
          const blockedReason = ((): string | null => {
            switch (status?.kind) {
              case 'needs-engine':
                return t('pluginNeedsNewerVoyager').replace(
                  '{engine}',
                  status.requiredEngine ?? plugin.engine,
                );
              case 'needs-handler':
                return t('pluginNeedsVoyagerUpdate');
              case 'needs-semantic':
                return t('pluginNeedsSiteAdapterUpdate').replace(
                  '{site}',
                  currentSiteLabel ?? hosts,
                );
              default:
                return null;
            }
          })();
          return (
            <div key={plugin.id} className="border-border/60 rounded-lg border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {/* Header: click to expand/collapse */}
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(plugin.id)}
                    className="group flex w-full items-start gap-1.5 text-left"
                    aria-expanded={isOpen}
                    aria-label={localizedName}
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`text-muted-foreground mt-0.5 shrink-0 transition-transform ${isOpen ? '' : '-rotate-90'}`}
                      aria-hidden="true"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                    {badge && (
                      <span
                        className="mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
                        style={{ color: badge.color }}
                        aria-hidden="true"
                      >
                        {badge.icon}
                      </span>
                    )}
                    <span className="text-sm leading-snug font-medium break-words">
                      {displayName(localizedName)}
                    </span>
                    {isUpdated && (
                      <span className="bg-primary/10 text-primary mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase">
                        {t('pluginUpdatedBadge')}
                      </span>
                    )}
                  </button>

                  {isOpen && (
                    <>
                      <p className="text-muted-foreground mt-1 text-xs leading-snug">
                        {pickLocalized(plugin, 'description', language)}
                      </p>
                      {changelog && (
                        <p
                          className="text-muted-foreground mt-1 truncate text-[11px] leading-snug"
                          title={changelog}
                        >
                          <span className="font-medium">{t('pluginChangelogLabel')}</span>{' '}
                          {changelog}
                        </p>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                        {hosts && <span className="text-muted-foreground">{hosts}</span>}
                        <span className="text-muted-foreground tabular-nums">{provenance}</span>
                        {plugin.homepage && (
                          <a
                            href={plugin.homepage}
                            target="_blank"
                            rel="noreferrer"
                            className="text-muted-foreground hover:text-foreground inline-flex items-center transition-colors"
                            title={t('pluginViewSource')}
                            aria-label={t('pluginViewSource')}
                          >
                            <GitHubIcon />
                          </a>
                        )}
                      </div>
                      {blockedUpdate && (
                        <p className="text-muted-foreground mt-1 text-[11px] leading-snug">
                          {t('pluginUpdateNeedsNewerVoyager').replace(
                            '{version}',
                            blockedUpdate.version,
                          )}
                        </p>
                      )}
                    </>
                  )}

                  {/* Status notes stay visible while the card is collapsed —
                      they explain a toggle the user cannot move. */}
                  {blockedReason && (
                    <p className="mt-1 text-[11px] leading-snug text-red-500/80">{blockedReason}</p>
                  )}

                  {status?.kind === 'no-effect' && (
                    <p className="mt-1 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                      {t('pluginNoEffectOnPage')}
                    </p>
                  )}

                  {status?.pendingVersion && (
                    <p className="text-muted-foreground mt-1 text-[11px] leading-snug">
                      {t('pluginUpdateAfterReload').replace('{version}', status.pendingVersion)}
                    </p>
                  )}

                  {needsSiteAccess && (
                    <button
                      type="button"
                      onClick={() => void handleGrantRequiredAccess(plugin)}
                      className="border-primary/25 bg-primary/5 text-primary hover:bg-primary/10 mt-2 flex w-full items-center justify-center rounded-md border px-2.5 py-2 text-xs font-medium transition-colors"
                    >
                      {t('pluginGrantRequiredAccess')}
                    </button>
                  )}

                  {/* Settings stay visible even when the description is collapsed, so a
                      slider-based plugin (e.g. reading width) is always adjustable. A missing
                      companion-frame grant must not disable settings that still affect the
                      already-authorized parent page. */}
                  {enabled && settingsSchema && (
                    <div className="mt-2 space-y-2.5" role="group" aria-label={localizedName}>
                      {Object.entries(settingsSchema).map(([key, field]) => {
                        const rawValue = settingsMap[plugin.id]?.[key] ?? field.default;
                        const settingText = pickLocalizedSetting(plugin, key, field, language);

                        if (field.type === 'boolean') {
                          const checked = rawValue === true;
                          return (
                            <div key={key} className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground text-[11px]">
                                {settingText.label}
                              </span>
                              <Switch
                                checked={checked}
                                aria-label={settingText.label}
                                onChange={(event) =>
                                  handleImmediateSetting(plugin.id, key, event.target.checked)
                                }
                              />
                            </div>
                          );
                        }

                        if (field.type !== 'number') return null;
                        const value = Number(rawValue);
                        return (
                          <div key={key} title={`${settingText.label}: ${value}`}>
                            <div className="text-muted-foreground mb-1 flex items-center justify-between gap-2 text-[11px]">
                              <span className="min-w-0 truncate">{settingText.label}</span>
                              <span className="shrink-0 tabular-nums">{value}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {settingText.minLabel && (
                                <span className="text-muted-foreground shrink-0 text-[10px]">
                                  {settingText.minLabel}
                                </span>
                              )}
                              <input
                                type="range"
                                min={field.min ?? 0}
                                max={field.max ?? 100}
                                value={value}
                                aria-label={settingText.label}
                                onChange={(e) =>
                                  handleSetting(plugin.id, key, Number(e.target.value))
                                }
                                className="accent-primary h-1.5 flex-1 cursor-pointer"
                              />
                              {settingText.maxLabel && (
                                <span className="text-muted-foreground shrink-0 text-[10px]">
                                  {settingText.maxLabel}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {deniedId === plugin.id && (
                    <p className="mt-1 text-[11px] text-red-500">{t('pluginPermissionDenied')}</p>
                  )}

                  {unsupportedId === plugin.id && (
                    <p className="mt-1 text-[11px] text-red-500">
                      {t('pluginUnsupportedPlatform')}
                    </p>
                  )}
                </div>
                <Switch
                  checked={enabled}
                  disabled={!enabled && blockedReason !== null}
                  onChange={(e) => {
                    void handleToggle(plugin, e.target.checked);
                  }}
                  aria-label={localizedName}
                />
              </div>
            </div>
          );
        })}

        {/* Online-catalog controls. Hidden on hosts that can never have a
            catalog (Gemini, AI Studio, anything with a port or wildcard), where
            the switch would promise a check that never runs. */}
        {catalogHost && (
          <div className="border-border/60 space-y-2 border-t pt-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium">{t('pluginsOnlineUpdates')}</span>
              <Switch
                checked={catalogSettings.onlineUpdatesEnabled}
                aria-label={t('pluginsOnlineUpdates')}
                onChange={(event) => handleOnlineUpdatesToggle(event.target.checked)}
              />
            </div>
            <p className="text-muted-foreground text-[11px] leading-snug">
              {t('pluginsOnlineUpdatesHint')}
            </p>
            {catalogSettings.onlineUpdatesEnabled && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground text-[11px]">
                  {t('pluginsCheckInterval')}
                </span>
                <select
                  value={catalogSettings.checkInterval}
                  aria-label={t('pluginsCheckInterval')}
                  onChange={(event) => handleCheckIntervalChange(event.target.value)}
                  className="bg-background border-border focus:ring-primary/50 rounded-md border px-2 py-1 text-[11px] transition-all focus:ring-2 focus:outline-none"
                >
                  {PLUGIN_CATALOG_CHECK_INTERVALS.map((interval) => (
                    <option key={interval} value={interval}>
                      {t(CHECK_INTERVAL_LABEL_KEYS[interval])}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <p className="text-muted-foreground text-[11px]">{catalogStatusText}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
