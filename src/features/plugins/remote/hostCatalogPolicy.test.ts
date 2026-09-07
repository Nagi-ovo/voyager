import { describe, expect, it } from 'vitest';

import type { PluginManifest } from '../types';
import type { HostCatalogCacheEntry } from './hostCatalogCache';
import {
  catalogHostFromUrl,
  checkIntervalMs,
  decideHostCatalogRefresh,
  hasEnabledPluginForHost,
  hasEnabledPluginForUrl,
  patternTargetsHost,
  hostCatalogBackoffMs,
  hostCatalogFileUrl,
  isEligibleCatalogHost,
  isHostCatalogEntryUsable,
  normalizeCheckInterval,
} from './hostCatalogPolicy';

const HOUR = 60 * 60 * 1000;

function entry(overrides: Partial<HostCatalogCacheEntry> = {}): HostCatalogCacheEntry {
  return {
    host: 'chat.deepseek.com',
    status: 'ok',
    manifests: [],
    fetchedAt: 1_000,
    lastAttemptAt: 1_000,
    failureCount: 0,
    extensionVersion: '1.8.3',
    ...overrides,
  };
}

function manifest(id: string, matches: string[]): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: 'd',
    author: 'a',
    category: 'other',
    license: 'MIT',
    engine: '>=1.0.0',
    tier: 'declarative',
    matches,
    contributes: {},
  };
}

describe('isEligibleCatalogHost', () => {
  it('accepts plain hostnames and rejects wildcards, ports, paths and schemes', () => {
    expect(isEligibleCatalogHost('chat.deepseek.com')).toBe(true);
    expect(isEligibleCatalogHost('claude.ai')).toBe(true);
    expect(isEligibleCatalogHost('*.frame.claudeusercontent.com')).toBe(false);
    expect(isEligibleCatalogHost('localhost:3000')).toBe(false);
    expect(isEligibleCatalogHost('localhost')).toBe(false);
    expect(isEligibleCatalogHost('chat.deepseek.com/path')).toBe(false);
    expect(isEligibleCatalogHost('https://chat.deepseek.com')).toBe(false);
    expect(isEligibleCatalogHost('Chat.DeepSeek.com')).toBe(false);
    expect(isEligibleCatalogHost('')).toBe(false);
    expect(isEligibleCatalogHost('../hosts')).toBe(false);
  });
});

describe('catalogHostFromUrl', () => {
  it('derives the lowercase host of an https page and rejects everything else', () => {
    expect(catalogHostFromUrl('https://Chat.DeepSeek.com/a/chat/s/1')).toBe('chat.deepseek.com');
    expect(catalogHostFromUrl('https://abc123.frame.claudeusercontent.com/x')).toBe(
      'abc123.frame.claudeusercontent.com',
    );
    expect(catalogHostFromUrl('http://chat.deepseek.com/')).toBeUndefined();
    expect(catalogHostFromUrl('https://localhost:5173/')).toBeUndefined();
    expect(catalogHostFromUrl('chrome-extension://abc/popup.html')).toBeUndefined();
    expect(catalogHostFromUrl('')).toBeUndefined();
    expect(catalogHostFromUrl(undefined)).toBeUndefined();
  });
});

describe('hostCatalogFileUrl', () => {
  it('builds hosts/<host>.json below the base without doubling slashes', () => {
    expect(hostCatalogFileUrl('https://voyager.nagi.fun/catalog/', 'chat.deepseek.com')).toBe(
      'https://voyager.nagi.fun/catalog/hosts/chat.deepseek.com.json',
    );
  });
});

describe('check intervals and backoff', () => {
  it('maps the four user choices and falls back to 6h for unknown values', () => {
    expect(checkIntervalMs('1h')).toBe(HOUR);
    expect(checkIntervalMs('6h')).toBe(6 * HOUR);
    expect(checkIntervalMs('24h')).toBe(24 * HOUR);
    expect(checkIntervalMs('manual')).toBeNull();
    expect(normalizeCheckInterval('24h')).toBe('24h');
    expect(normalizeCheckInterval('weekly')).toBe('6h');
    expect(normalizeCheckInterval(undefined)).toBe('6h');
  });

  it('doubles from 30 minutes and caps at 24 hours', () => {
    expect(hostCatalogBackoffMs(0)).toBe(0);
    expect(hostCatalogBackoffMs(1)).toBe(30 * 60 * 1000);
    expect(hostCatalogBackoffMs(2)).toBe(60 * 60 * 1000);
    expect(hostCatalogBackoffMs(3)).toBe(2 * HOUR);
    expect(hostCatalogBackoffMs(20)).toBe(24 * HOUR);
  });
});

describe('decideHostCatalogRefresh', () => {
  const base = {
    onlineUpdatesEnabled: true,
    interval: '6h' as const,
    extensionVersion: '1.8.3',
  };

  it('never refreshes automatically when the switch is off or the interval is manual', () => {
    expect(
      decideHostCatalogRefresh({ ...base, entry: null, now: 0, onlineUpdatesEnabled: false }),
    ).toEqual({ refresh: false, reason: 'disabled' });
    expect(decideHostCatalogRefresh({ ...base, entry: null, now: 0, interval: 'manual' })).toEqual({
      refresh: false,
      reason: 'manual-only',
    });
  });

  it('refreshes a host with no entry yet', () => {
    expect(decideHostCatalogRefresh({ ...base, entry: null, now: 0 })).toEqual({ refresh: true });
  });

  it('counts the interval from the last ATTEMPT, not the last success', () => {
    const failedRecently = entry({ fetchedAt: 0, lastAttemptAt: 10 * HOUR, failureCount: 0 });
    expect(decideHostCatalogRefresh({ ...base, entry: failedRecently, now: 12 * HOUR })).toEqual({
      refresh: false,
      reason: 'fresh',
    });
    expect(decideHostCatalogRefresh({ ...base, entry: failedRecently, now: 16 * HOUR })).toEqual({
      refresh: true,
    });
  });

  it('applies exponential backoff after failures even when the interval has elapsed', () => {
    // 3 failures → 2 h backoff, longer than the 1 h interval: backoff wins.
    const failing = entry({ lastAttemptAt: 0, failureCount: 3, extensionVersion: '1.8.3' });
    const hourly = { ...base, interval: '1h' as const };
    expect(decideHostCatalogRefresh({ ...hourly, entry: failing, now: 1.5 * HOUR })).toEqual({
      refresh: false,
      reason: 'backoff',
    });
    expect(decideHostCatalogRefresh({ ...hourly, entry: failing, now: 2 * HOUR })).toEqual({
      refresh: true,
    });
    // A short backoff never makes checks MORE frequent than the interval.
    const once = entry({ lastAttemptAt: 0, failureCount: 1 });
    expect(decideHostCatalogRefresh({ ...base, entry: once, now: 2 * HOUR })).toEqual({
      refresh: false,
      reason: 'fresh',
    });
  });

  it('treats an entry written by another extension version as due immediately', () => {
    const stale = entry({ lastAttemptAt: 100 * HOUR, extensionVersion: '1.8.2' });
    expect(decideHostCatalogRefresh({ ...base, entry: stale, now: 100 * HOUR + 1 })).toEqual({
      refresh: true,
    });
  });
});

describe('isHostCatalogEntryUsable', () => {
  it('accepts only a successful fetch by the running extension version', () => {
    expect(isHostCatalogEntryUsable(entry(), '1.8.3')).toBe(true);
    expect(isHostCatalogEntryUsable(entry({ status: 'missing' }), '1.8.3')).toBe(false);
    expect(isHostCatalogEntryUsable(entry({ status: 'unknown' }), '1.8.3')).toBe(false);
    expect(isHostCatalogEntryUsable(entry({ extensionVersion: '1.8.2' }), '1.8.3')).toBe(false);
    expect(isHostCatalogEntryUsable(null, '1.8.3')).toBe(false);
  });
});

describe('hasEnabledPluginForUrl', () => {
  const manifests = [
    manifest('voyager.deepseek', ['https://chat.deepseek.com/*']),
    manifest('voyager.claude', ['https://claude.ai/*']),
  ];

  it('is true only when an ENABLED plugin targets the page', () => {
    const url = 'https://chat.deepseek.com/a/chat/s/1';
    expect(hasEnabledPluginForUrl(manifests, {}, url)).toBe(false);
    expect(
      hasEnabledPluginForUrl(
        manifests,
        { 'voyager.deepseek': { enabled: false, installedAt: 1 } },
        url,
      ),
    ).toBe(false);
    expect(
      hasEnabledPluginForUrl(
        manifests,
        { 'voyager.claude': { enabled: true, installedAt: 1 } },
        url,
      ),
    ).toBe(false);
    expect(
      hasEnabledPluginForUrl(
        manifests,
        { 'voyager.deepseek': { enabled: true, installedAt: 1 } },
        url,
      ),
    ).toBe(true);
  });

  it('is never true on Gemini, which no plugin targets', () => {
    const everythingOn = {
      'voyager.deepseek': { enabled: true, installedAt: 1 },
      'voyager.claude': { enabled: true, installedAt: 1 },
    };
    expect(hasEnabledPluginForUrl(manifests, everythingOn, 'https://gemini.google.com/app')).toBe(
      false,
    );
  });
});

describe('hasEnabledPluginForHost (background side of D4)', () => {
  it('matches on the host part of a pattern, so a path-scoped plugin still qualifies', () => {
    const scoped = [manifest('voyager.deepseek-chat', ['https://chat.deepseek.com/chat/*'])];
    const on = { 'voyager.deepseek-chat': { enabled: true, installedAt: 1 } };
    // The bare origin never matches a path-scoped pattern...
    expect(hasEnabledPluginForUrl(scoped, on, 'https://chat.deepseek.com/')).toBe(false);
    // ...but the host is what the refresh request carries.
    expect(hasEnabledPluginForHost(scoped, on, 'chat.deepseek.com')).toBe(true);
    expect(hasEnabledPluginForHost(scoped, {}, 'chat.deepseek.com')).toBe(false);
    expect(hasEnabledPluginForHost(scoped, on, 'claude.ai')).toBe(false);
  });

  it('understands the subdomain wildcard and rejects unrelated hosts', () => {
    expect(
      patternTargetsHost(
        'https://*.frame.claudeusercontent.com/*',
        'abc.frame.claudeusercontent.com',
      ),
    ).toBe(true);
    expect(patternTargetsHost('https://*.example.com/*', 'example.com')).toBe(true);
    expect(patternTargetsHost('https://*.example.com/*', 'notexample.com')).toBe(false);
    expect(patternTargetsHost('*://claude.ai/*', 'CLAUDE.AI')).toBe(true);
    expect(patternTargetsHost('<all_urls>', 'anything.test')).toBe(true);
    expect(patternTargetsHost('garbage', 'claude.ai')).toBe(false);
  });
});
