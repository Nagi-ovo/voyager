import { useCallback, useState } from 'react';

import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';
import { isFirefox, supportsOptionalHostPermissions } from '@/core/utils/browser';
import {
  customWebsiteOriginPatterns,
  normalizeCustomWebsite,
  sanitizeCustomWebsites,
} from '@/core/utils/customWebsites';
import { matchesAnyPattern } from '@/features/plugins/sites/matchPattern';
import type { PluginManifest } from '@/features/plugins/types';
import type { TranslationKey } from '@/utils/translations';

export interface CustomWebsitesOptions {
  t: (key: TranslationKey) => string;
  /** The complete catalog, including disabled plugins and plugins on other sites. */
  pluginManifests: readonly Pick<PluginManifest, 'matches'>[];
  refreshActiveTabContext: () => Promise<void>;
  writeSyncStorage: (payload: Record<string, unknown>) => Promise<void>;
}

function originPatternsForDomain(domain: string): string[] | null {
  try {
    return customWebsiteOriginPatterns(domain);
  } catch {
    return null;
  }
}

/** Prompt Manager website coverage and its shared optional host permissions. */
export function useCustomWebsites({
  t,
  pluginManifests,
  refreshActiveTabContext,
  writeSyncStorage,
}: CustomWebsitesOptions) {
  const [customWebsites, setCustomWebsites] = useState<string[]>([]);
  const [newWebsiteInput, setNewWebsiteInput] = useState('');
  const [websiteError, setWebsiteError] = useState('');

  const hydrateFromStorage = useCallback(
    (raw: Record<string, unknown>): void => {
      const storedWebsites = raw[StorageKeys.PROMPT_CUSTOM_WEBSITES];
      const rawWebsites: unknown[] = Array.isArray(storedWebsites) ? storedWebsites : [];
      const loaded = sanitizeCustomWebsites(rawWebsites);
      setCustomWebsites(loaded);
      if (
        rawWebsites.length !== loaded.length ||
        rawWebsites.some((website, index) => website !== loaded[index])
      ) {
        void writeSyncStorage({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: loaded });
      }

      // A denied prompt may close the popup before its optimistic write is rolled back.
      void (async () => {
        if (!loaded.length || !browser.permissions?.contains) return;
        const hasAnyPermission = async (domain: string) => {
          try {
            const origins = customWebsiteOriginPatterns(domain);
            if (!origins) return false;
            for (const origin of origins) {
              if (await browser.permissions.contains({ origins: [origin] })) return true;
            }
            return false;
          } catch {
            return true; // Avoid destructive cleanup on unexpected permission API errors.
          }
        };
        const filtered = (
          await Promise.all(
            loaded.map(async (domain) => ({ domain, ok: await hasAnyPermission(domain) })),
          )
        )
          .filter((item) => item.ok)
          .map((item) => item.domain);
        if (filtered.length !== loaded.length) {
          setCustomWebsites(filtered);
          await writeSyncStorage({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: filtered });
        }
      })();
    },
    [writeSyncStorage],
  );

  const requestCustomWebsitePermission = useCallback(
    async (domain: string): Promise<boolean> => {
      const origins = originPatternsForDomain(domain);
      if (!origins) {
        setWebsiteError(t('invalidUrl'));
        return false;
      }
      if (!browser.permissions?.request || !browser.permissions?.contains) {
        setWebsiteError(t('permissionRequestFailed'));
        return false;
      }
      if (!supportsOptionalHostPermissions()) {
        setWebsiteError(t('pluginUnsupportedPlatform'));
        return false;
      }
      try {
        // Firefox must request directly in the user gesture, before any awaited API.
        if (!isFirefox()) {
          const alreadyGranted = await browser.permissions.contains({ origins });
          if (alreadyGranted) {
            await refreshActiveTabContext();
            return true;
          }
        }
        const granted = await browser.permissions.request({ origins });
        if (!granted) setWebsiteError(t('permissionDenied'));
        else await refreshActiveTabContext();
        return granted;
      } catch (error) {
        console.error('[Gemini Voyager] Failed to request permissions for custom website:', error);
        setWebsiteError(t('permissionRequestFailed'));
        return false;
      }
    },
    [refreshActiveTabContext, t],
  );

  const revokeCustomWebsitePermission = useCallback(
    async (domain: string): Promise<void> => {
      const origins = originPatternsForDomain(domain);
      if (!origins || !browser.permissions?.remove) return;
      const normalized = domain
        .trim()
        .toLowerCase()
        .replace(/^www\./, '');
      // Shared domains keep their grant even if the matching plugin is disabled.
      if (
        normalized &&
        pluginManifests.some((plugin) =>
          matchesAnyPattern(`https://${normalized}/`, plugin.matches),
        )
      )
        return;
      try {
        await browser.permissions.remove({ origins });
      } catch (error) {
        console.warn('[Gemini Voyager] Failed to revoke permission for', domain, error);
      }
    },
    [pluginManifests],
  );

  const onWebsiteInputChange = useCallback((value: string): void => {
    setNewWebsiteInput(value);
    setWebsiteError('');
  }, []);

  const handleAddWebsite = useCallback(async (): Promise<void> => {
    setWebsiteError('');
    if (!newWebsiteInput.trim()) return;
    const normalized = normalizeCustomWebsite(newWebsiteInput);
    if (!normalized || customWebsites.includes(normalized)) {
      setWebsiteError(t('invalidUrl'));
      return;
    }
    if (isFirefox()) {
      const granted = await requestCustomWebsitePermission(normalized);
      if (!granted) return;
      const updated = [...customWebsites, normalized];
      setCustomWebsites(updated);
      await writeSyncStorage({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: updated });
      setNewWebsiteInput('');
      return;
    }

    // Other browsers persist first because the permission prompt may close the popup.
    const updated = [...customWebsites, normalized];
    setCustomWebsites(updated);
    await writeSyncStorage({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: updated });
    setNewWebsiteInput('');
    const granted = await requestCustomWebsitePermission(normalized);
    if (!granted) {
      setCustomWebsites(customWebsites);
      await writeSyncStorage({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: customWebsites });
    }
  }, [newWebsiteInput, customWebsites, t, requestCustomWebsitePermission, writeSyncStorage]);

  const handleRemoveWebsite = useCallback(
    async (website: string): Promise<void> => {
      const updated = customWebsites.filter((entry) => entry !== website);
      setCustomWebsites(updated);
      await writeSyncStorage({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: updated });
      await revokeCustomWebsitePermission(website);
    },
    [customWebsites, revokeCustomWebsitePermission, writeSyncStorage],
  );

  const toggleQuickWebsite = useCallback(
    async (domain: string, isEnabled: boolean): Promise<void> => {
      if (isEnabled) {
        const updated = customWebsites.filter((entry) => entry !== domain);
        setCustomWebsites(updated);
        await writeSyncStorage({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: updated });
        await revokeCustomWebsitePermission(domain);
        return;
      }
      if (isFirefox()) {
        const granted = await requestCustomWebsitePermission(domain);
        if (!granted) return;
        const updated = [...customWebsites, domain];
        setCustomWebsites(updated);
        await writeSyncStorage({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: updated });
        return;
      }
      const updated = [...customWebsites, domain];
      setCustomWebsites(updated);
      await writeSyncStorage({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: updated });
      const granted = await requestCustomWebsitePermission(domain);
      if (!granted) {
        setCustomWebsites(customWebsites);
        await writeSyncStorage({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: customWebsites });
      }
    },
    [
      customWebsites,
      requestCustomWebsitePermission,
      revokeCustomWebsitePermission,
      writeSyncStorage,
    ],
  );

  return {
    customWebsites,
    newWebsiteInput,
    websiteError,
    hydrateFromStorage,
    onWebsiteInputChange,
    handleAddWebsite,
    handleRemoveWebsite,
    toggleQuickWebsite,
  };
}
