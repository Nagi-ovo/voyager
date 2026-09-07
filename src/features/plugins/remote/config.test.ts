import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PLUGIN_CATALOG_BASE_URL, resolvePluginCatalogBaseUrl } from './config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolvePluginCatalogBaseUrl', () => {
  it('honours a clean https override and trims the trailing slash', () => {
    vi.stubEnv('VOYAGER_PLUGIN_CATALOG_URL', 'https://preview.example/catalog/');
    expect(resolvePluginCatalogBaseUrl()).toBe('https://preview.example/catalog');
  });

  it('falls back to the default for http, credentials, a query string or a fragment', () => {
    for (const raw of [
      'http://preview.example/catalog',
      'https://user:pw@preview.example/catalog',
      'https://preview.example/catalog?channel=next',
      'https://preview.example/catalog#next',
      'not a url',
      '',
    ]) {
      vi.stubEnv('VOYAGER_PLUGIN_CATALOG_URL', raw);
      expect(resolvePluginCatalogBaseUrl(), raw).toBe(DEFAULT_PLUGIN_CATALOG_BASE_URL);
    }
  });
});
