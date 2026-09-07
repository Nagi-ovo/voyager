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

/**
 * An override is honoured only as a plain https origin + path: credentials, a
 * query string or a fragment would end up in front of the appended
 * `hosts/<host>.json` and the request would no longer target the per-host file.
 */
function parseCatalogBaseUrlOverride(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

/** Catalog base URL without a trailing slash. Only clean https overrides are honoured. */
export function resolvePluginCatalogBaseUrl(): string {
  const base = parseCatalogBaseUrlOverride(readCatalogUrlOverride()?.trim());
  return (base ?? DEFAULT_PLUGIN_CATALOG_BASE_URL).replace(/\/+$/, '');
}

/** False only for a build compiled with `VOYAGER_PLUGIN_CATALOG_REMOTE=off`. */
export function isRemotePluginCatalogEnabledAtBuild(): boolean {
  return readRemoteFlag()?.trim().toLowerCase() !== 'off';
}
