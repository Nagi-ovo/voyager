import { useEffect, useState } from 'react';

import browser from 'webextension-polyfill';

import { isSafari, shouldShowSafariUpdateReminder } from '@/core/utils/browser';
import { shouldShowUpdateReminderForCurrentVersion } from '@/core/utils/updateReminder';
import { compareVersions } from '@/core/utils/version';

import {
  extractDmgDownloadUrl,
  extractLatestReleaseVersion,
  getCachedLatestVersion,
  getManifestUpdateUrl,
} from '../utils/latestVersion';

const LATEST_VERSION_CACHE_KEY = 'gvLatestVersionCache';
const LATEST_VERSION_MAX_AGE = 1000 * 60 * 60 * 6; // 6 hours
const SAFARI_DMG_RETRY_AGE = 1000 * 60 * 30; // 30 min — re-check for DMG if missing

const normalizeVersionString = (version?: string | null): string | null => {
  if (!version) return null;
  const trimmed = version.trim();
  return trimmed ? trimmed.replace(/^v/i, '') : null;
};

const toReleaseTag = (version?: string | null): string | null => {
  if (!version) return null;
  const trimmed = version.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
};

export function usePopupReleaseInfo(isSafariBrowser: boolean) {
  const [extVersion, setExtVersion] = useState<string | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [safariDmgUrl, setSafariDmgUrl] = useState<string | null>(null);
  useEffect(() => {
    try {
      const version = chrome?.runtime?.getManifest?.()?.version;
      if (version) {
        setExtVersion(version);
      }
    } catch (err) {
      console.error('[Gemini Voyager] Failed to get extension version:', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchLatestVersion = async () => {
      if (!extVersion) return;

      // Check for store installation (Chrome/Edge Web Store)
      // Store-installed extensions have an 'update_url' in the manifest.
      // We skip manual version checks for these users to rely on store auto-updates
      // and prevent confusing "new version" prompts when GitHub is ahead of the store.
      const manifest = chrome?.runtime?.getManifest?.();

      // For Safari: only skip update check if the feature is disabled (default)
      // If shouldShowSafariUpdateReminder() returns true, allow update checks
      if (isSafari() && !shouldShowSafariUpdateReminder()) {
        return;
      }

      // For other browsers: skip if they have update_url (store installation)
      if (!isSafari() && getManifestUpdateUrl(manifest)) {
        return;
      }

      try {
        const cache = await browser.storage.local.get(LATEST_VERSION_CACHE_KEY);
        const now = Date.now();

        const cachedEntry = cache?.[LATEST_VERSION_CACHE_KEY];
        let latest = getCachedLatestVersion(cachedEntry, now, LATEST_VERSION_MAX_AGE);
        let dmgUrl: string | null = null;

        if (latest && isSafari()) {
          // Try to read cached DMG URL
          if (
            typeof cachedEntry === 'object' &&
            cachedEntry !== null &&
            'dmgUrl' in cachedEntry &&
            typeof (cachedEntry as Record<string, unknown>).dmgUrl === 'string'
          ) {
            dmgUrl = (cachedEntry as Record<string, unknown>).dmgUrl as string;
          }
          // If DMG URL was not cached, re-fetch — but respect a 30 min cooldown
          // to avoid hitting GitHub API rate limits
          if (
            !dmgUrl &&
            typeof cachedEntry === 'object' &&
            cachedEntry !== null &&
            'fetchedAt' in cachedEntry &&
            typeof (cachedEntry as Record<string, unknown>).fetchedAt === 'number' &&
            now - ((cachedEntry as Record<string, unknown>).fetchedAt as number) >=
              SAFARI_DMG_RETRY_AGE
          ) {
            latest = null;
          }
        }

        if (!latest) {
          const resp = await fetch(
            'https://api.github.com/repos/Nagi-ovo/voyager/releases/latest',
            {
              headers: { Accept: 'application/vnd.github+json' },
            },
          );

          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
          }

          const data: unknown = await resp.json();
          const candidate = extractLatestReleaseVersion(data);

          if (candidate) {
            latest = candidate;
            const isSafariFetch = isSafari();
            if (isSafariFetch) {
              dmgUrl = extractDmgDownloadUrl(data);
            }
            await browser.storage.local.set({
              [LATEST_VERSION_CACHE_KEY]: {
                version: candidate,
                fetchedAt: now,
                ...(isSafariFetch ? { dmgUrl } : {}),
              },
            });
          }
        }

        if (cancelled || !latest) return;

        setLatestVersion(latest);
        if (isSafari()) {
          setSafariDmgUrl(dmgUrl);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('[Gemini Voyager] Failed to check latest version:', error);
        }
      }
    };

    fetchLatestVersion();

    return () => {
      cancelled = true;
    };
  }, [extVersion]);

  const normalizedCurrentVersion = normalizeVersionString(extVersion);
  const normalizedLatestVersion = normalizeVersionString(latestVersion);
  const safariUpdateReminderEnabled = isSafariBrowser && shouldShowSafariUpdateReminder();
  const shouldShowUpdateNotification = shouldShowUpdateReminderForCurrentVersion({
    currentVersion: normalizedCurrentVersion,
    isSafariBrowser,
    safariReminderEnabled: safariUpdateReminderEnabled,
  });
  const hasUpdate =
    shouldShowUpdateNotification && normalizedCurrentVersion && normalizedLatestVersion
      ? compareVersions(normalizedLatestVersion, normalizedCurrentVersion) > 0
      : false;
  const latestReleaseTag = toReleaseTag(latestVersion ?? normalizedLatestVersion ?? undefined);
  const latestReleaseUrl = latestReleaseTag
    ? `https://github.com/Nagi-ovo/voyager/releases/tag/${latestReleaseTag}`
    : 'https://github.com/Nagi-ovo/voyager/releases/latest';
  const currentReleaseTag = toReleaseTag(extVersion);
  const releaseUrl = extVersion
    ? `https://github.com/Nagi-ovo/voyager/releases/tag/${currentReleaseTag ?? `v${extVersion}`}`
    : 'https://github.com/Nagi-ovo/voyager/releases';

  return {
    extVersion,
    normalizedCurrentVersion,
    normalizedLatestVersion,
    safariDmgUrl,
    hasUpdate,
    latestReleaseUrl,
    releaseUrl,
  };
}
