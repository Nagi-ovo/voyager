import { TextDecoder, TextEncoder } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import manifestDev from '../../../../manifest.dev.json';
import manifestChrome from '../../../../manifest.json';

type ManifestPermissions = {
  action?: {
    default_icon?: Record<string, string>;
  };
  background?: {
    scripts?: string[];
  };
  permissions?: string[];
  optional_permissions?: string[];
  content_scripts?: Array<{
    js?: string[];
    run_at?: string;
    world?: string;
  }>;
  browser_specific_settings?: {
    safari?: { strict_min_version?: string };
  };
};

let chromeManifest: ManifestPermissions;
let firefoxManifest: ManifestPermissions;
let safariManifest: ManifestPermissions;

const originalTextEncoder = globalThis.TextEncoder;
const originalTextDecoder = globalThis.TextDecoder;
const originalUint8Array = globalThis.Uint8Array;

beforeAll(async () => {
  // Vite's esbuild dependency requires the host-realm Uint8Array returned by
  // Node's encoder. jsdom's encoder comes from a different realm.
  Object.defineProperty(globalThis, 'TextEncoder', {
    value: TextEncoder,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'TextDecoder', {
    value: TextDecoder,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'Uint8Array', {
    value: new TextEncoder().encode('').constructor,
    configurable: true,
  });

  const [chromeConfig, firefoxConfig, safariConfig] = await Promise.all([
    import('../../../../vite.config.chrome'),
    import('../../../../vite.config.firefox'),
    import('../../../../vite.config.safari'),
  ]);
  chromeManifest = chromeConfig.chromeManifest as unknown as ManifestPermissions;
  firefoxManifest = firefoxConfig.firefoxManifest as unknown as ManifestPermissions;
  safariManifest = safariConfig.safariManifest as unknown as ManifestPermissions;
});

afterAll(() => {
  Object.defineProperty(globalThis, 'TextEncoder', {
    value: originalTextEncoder,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'TextDecoder', {
    value: originalTextDecoder,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'Uint8Array', {
    value: originalUint8Array,
    configurable: true,
  });
});

describe('manifest permissions', () => {
  it('keeps all-site access optional', () => {
    expect(manifestChrome.host_permissions).not.toContain('<all_urls>');
    expect(manifestChrome.optional_host_permissions).toEqual([
      'https://chatgpt.com/*',
      '<all_urls>',
    ]);
    expect(manifestDev.optional_host_permissions).toEqual(manifestChrome.optional_host_permissions);
  });

  it('keeps ChatGPT host access opt-in', () => {
    expect(manifestChrome.host_permissions).not.toContain('https://chatgpt.com/*');
    expect(manifestChrome.optional_host_permissions).toEqual(
      expect.arrayContaining(['https://chatgpt.com/*']),
    );
    expect(
      manifestChrome.content_scripts.some((entry) =>
        entry.matches.includes('https://chatgpt.com/*'),
      ),
    ).toBe(false);
  });

  it('keeps unlimitedStorage out of the shared manifest', () => {
    expect(manifestChrome.permissions).not.toContain('unlimitedStorage');
    expect(manifestChrome.optional_permissions).not.toContain('unlimitedStorage');
  });

  it('adds warning-free required unlimitedStorage to Chrome and Edge builds', () => {
    // Edge packages are generated from the Chrome build manifest.
    expect(chromeManifest.permissions).toContain('unlimitedStorage');
    expect(chromeManifest.optional_permissions).not.toContain('unlimitedStorage');
  });

  it('runs Chrome and Edge usage bridges as native MAIN-world scripts', () => {
    const scripts = chromeManifest.content_scripts?.filter((entry) => entry.world === 'MAIN') ?? [];
    expect(scripts.map((entry) => entry.js?.[0])).toEqual([
      'public/usage-observer.js',
      'public/conversation-history-observer.js',
    ]);
    expect(scripts.every((entry) => entry.js?.length === 1)).toBe(true);
    expect(scripts.every((entry) => entry.run_at === 'document_start')).toBe(true);
  });

  it('adds Safari native messaging without restoring WebExtension notifications', () => {
    expect(safariManifest.permissions).not.toContain('unlimitedStorage');
    expect(safariManifest.permissions).not.toContain('identity');
    expect(safariManifest.permissions).toContain('nativeMessaging');
    expect(safariManifest.optional_permissions).toContain('unlimitedStorage');
    expect(safariManifest.optional_permissions).not.toContain('notifications');
  });

  it('adds required unlimitedStorage to Firefox without making it optional', () => {
    expect(firefoxManifest.permissions).toContain('unlimitedStorage');
    expect(firefoxManifest.optional_permissions).not.toContain('unlimitedStorage');
  });

  it('declares Safari 15.4 as the Manifest V3 compatibility floor', () => {
    expect(safariManifest.browser_specific_settings?.safari?.strict_min_version).toBe('15.4');
  });

  it('provides native-size Safari toolbar icons', () => {
    expect(safariManifest.action?.default_icon).toEqual({
      '16': 'icon-16-template.png',
      '19': 'icon-19-template.png',
      '32': 'icon-32-template.png',
      '38': 'icon-38-template.png',
    });
  });

  it('declares a Safari classic background entry', () => {
    expect(safariManifest.background).toEqual({
      scripts: ['src/pages/background/index.ts'],
    });
  });

  it('runs Safari page bridges as separate MAIN-world manifest scripts', () => {
    const scripts = safariManifest.content_scripts?.filter((entry) => entry.world === 'MAIN') ?? [];
    expect(scripts.map((entry) => entry.js?.[0])).toEqual([
      'public/fetchInterceptor.js',
      'public/usage-observer.js',
      'public/conversation-history-observer.js',
      'public/response-complete-observer.js',
      'public/prevent-auto-scroll.js',
      'public/katex-config.js',
    ]);
    expect(scripts.every((entry) => entry.js?.length === 1)).toBe(true);
    expect(scripts.every((entry) => entry.run_at === 'document_start')).toBe(true);
  });
});
