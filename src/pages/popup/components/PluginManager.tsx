import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import browser from 'webextension-polyfill';

import {
  isFirefox,
  supportsDynamicContentScriptRegistration,
  supportsOptionalHostPermissions,
} from '@/core/utils/browser';
import { pluginToOriginPatternsForActiveUrl } from '@/features/plugins/runtime/siteRegistration';
import { SiteRegistry } from '@/features/plugins/sites/registry';
import {
  loadCollapsedPlugins,
  loadPluginState,
  setPluginCollapsed,
  setPluginEnabled,
  setPluginSetting,
  subscribePluginState,
} from '@/features/plugins/storage/pluginState';
import type { PluginManifest, PluginSettingValue, SettingField } from '@/features/plugins/types';

import { Card, CardContent, CardTitle } from '../../../components/ui/card';
import { Switch } from '../../../components/ui/switch';
import { useLanguage } from '../../../contexts/LanguageContext';
import { IconChatGPT, IconClaude } from './WebsiteLogos';

type EnabledMap = Record<string, boolean>;
type SettingsMap = Record<string, Record<string, PluginSettingValue>>;

/** Logo + default accent per known site id. */
const SITE_BADGES: Record<string, { Icon: typeof IconClaude; color: string }> = {
  claude: { Icon: IconClaude, color: '#d97757' },
  chatgpt: { Icon: IconChatGPT, color: '#0ea5e9' },
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
): { icon: ReactNode; color: string } | null {
  const brand = plugin.theme?.brand;
  const current = currentSiteId ? SITE_BADGES[currentSiteId] : undefined;
  if (current) return { icon: <current.Icon />, color: brand ?? current.color };
  const host = plugin.matches
    .map((m) => m.replace(/^[a-z*]+:\/\//i, '').replace(/\/.*$/, ''))
    .join(' ');
  if (host.includes('claude.ai'))
    return { icon: <IconClaude />, color: brand ?? SITE_BADGES.claude.color };
  if (host.includes('chatgpt.com') || host.includes('openai.com'))
    return { icon: <IconChatGPT />, color: brand ?? SITE_BADGES.chatgpt.color };
  return null;
}

/** Strip a redundant "Claude · " / "ChatGPT · " platform prefix (the logo shows it). */
function displayName(name: string): string {
  return name.replace(/^(Claude|ChatGPT|Grok|Gemini|AI Studio)\s*[·:|]\s*/i, '');
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

function pickLocalized(
  plugin: PluginManifest,
  field: 'name' | 'description',
  lang: string,
): string {
  for (const locale of localeCandidates(lang)) {
    const value = plugin.i18n?.[locale]?.[field];
    if (value) return value;
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
}

export function PluginManager({
  manifests,
  loading = false,
  onRefresh,
  refreshing = false,
  activeUrl,
}: PluginManagerProps) {
  const { t, language } = useLanguage();
  // The site the popup is currently open on — the "active site" the badge needs
  // to pick the right logo for a multi-site plugin. Resolved via the shared
  // SiteRegistry (single source of truth for "which site is this URL").
  const currentSiteId = useMemo(
    () =>
      activeUrl
        ? (SiteRegistry.createDefault().resolveByUrl(activeUrl)?.id ?? undefined)
        : undefined,
    [activeUrl],
  );
  const [enabledMap, setEnabledMap] = useState<EnabledMap>({});
  const [settingsMap, setSettingsMap] = useState<SettingsMap>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [deniedId, setDeniedId] = useState<string | null>(null);
  const [unsupportedId, setUnsupportedId] = useState<string | null>(null);
  const [missingPermissionIds, setMissingPermissionIds] = useState<Set<string>>(new Set());

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
                // successful grant can be completed by the background
                // permissions.onAdded handler without another popup visit.
                setEnabledMap((prev) => ({ ...prev, [plugin.id]: true }));
                await setPluginEnabled(plugin.id, true);
                if (!(await browser.permissions.request({ origins }))) {
                  setEnabledMap((prev) => ({ ...prev, [plugin.id]: false }));
                  await setPluginEnabled(plugin.id, false);
                  setDeniedId(plugin.id);
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

  return (
    <Card className="p-4 transition-all hover:shadow-md">
      <div className="mb-4 flex items-center justify-between">
        <CardTitle>{t('pluginsTitle')}</CardTitle>
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
          const badge = platformBadge(plugin, currentSiteId);
          const localizedName = pickLocalized(plugin, 'name', language);
          const needsSiteAccess = enabled && missingPermissionIds.has(plugin.id);
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
                  </button>

                  {isOpen && (
                    <>
                      <p className="text-muted-foreground mt-1 text-xs leading-snug">
                        {pickLocalized(plugin, 'description', language)}
                      </p>
                      <div className="mt-1.5 flex items-center gap-2 text-[11px]">
                        {hosts && <span className="text-muted-foreground">{hosts}</span>}
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
                    </>
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
                    <div className="mt-2 space-y-2.5">
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
                  onChange={(e) => {
                    void handleToggle(plugin, e.target.checked);
                  }}
                  aria-label={localizedName}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
