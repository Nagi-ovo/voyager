/**
 * Build-time configuration of the remote plugin catalog channel.
 *
 * Both values are injected through Vite `define` (see vite.config.base.ts):
 *   - `VOYAGER_PLUGIN_CATALOG_URL`   base URL of the published catalog, so a
 *                                    preview environment can point elsewhere;
 *   - `VOYAGER_PLUGIN_CATALOG_REMOTE` `'off'` ships a build that never contacts
 *                                    the catalog host (store-review fallback:
 *                                    the bundled snapshot is the only source).
 *
 * The accesses must stay static (`import.meta.env.NAME`) for the replacement
 * to apply; tests see the defaults.
 */
export const DEFAULT_PLUGIN_CATALOG_BASE_URL = 'https://voyager.nagi.fun/catalog';

function readCatalogUrlOverride(): string | undefined {
  try {
    const value: unknown = import.meta.env.VOYAGER_PLUGIN_CATALOG_URL;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function readRemoteFlag(): string | undefined {
  try {
    const value: unknown = import.meta.env.VOYAGER_PLUGIN_CATALOG_REMOTE;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Catalog base URL without a trailing slash. Only https overrides are honoured. */
export function resolvePluginCatalogBaseUrl(): string {
  const raw = readCatalogUrlOverride()?.trim();
  const base = raw && /^https:\/\/[^\s/]+/i.test(raw) ? raw : DEFAULT_PLUGIN_CATALOG_BASE_URL;
  return base.replace(/\/+$/, '');
}

/** False only for a build compiled with `VOYAGER_PLUGIN_CATALOG_REMOTE=off`. */
export function isRemotePluginCatalogEnabledAtBuild(): boolean {
  return readRemoteFlag()?.trim().toLowerCase() !== 'off';
}
