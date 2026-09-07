/**
 * Bundled catalog discovery (plan §3).
 *
 * Layout, one directory per plugin platform:
 *
 *   catalog/sites/<site>/site.json                 the adapter as data
 *   catalog/sites/<site>/plugins/<id>/plugin.json  a declarative plugin
 *   catalog/sites/<site>/plugins/<id>/*.css        its style files
 *
 * Everything is found with `import.meta.glob` at build time, so adding a site
 * or a plugin is adding files — there is no hand-maintained mapping table.
 * `marketplace.json` next to this folder is an index kept only for the docs
 * plugin store; a test keeps it in sync with what this module discovers.
 *
 * Vite-only: `import.meta.glob` is not available under Bun, so
 * `scripts/build-plugin-catalog.ts` reads the same files from disk instead of
 * importing this module.
 */
import { logger } from '@/core/services/LoggerService';

import { validateSiteAdapterData } from '../../sites/siteAdapterData';
import type { SiteAdapter } from '../../types';

const siteModules = import.meta.glob('./*/site.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const pluginModules = import.meta.glob('./*/plugins/*/plugin.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const styleModules = import.meta.glob('./*/plugins/*/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export interface BundledSiteEntry {
  /** Directory name under `sites/`; must equal `site.json`'s `id`. */
  readonly siteDir: string;
  readonly path: string;
  readonly siteJson: string;
}

export interface BundledPluginEntry {
  readonly siteDir: string;
  /** Directory name under `plugins/`. */
  readonly pluginDir: string;
  /** Catalog-relative path of the manifest, e.g. `sites/claude/plugins/reading-width/plugin.json`. */
  readonly path: string;
  readonly manifestJson: string;
  /** Style files next to the manifest, keyed by file name. */
  readonly styles: Readonly<Record<string, string>>;
}

const SITE_PATH = /^\.\/([^/]+)\/site\.json$/;
const PLUGIN_PATH = /^\.\/([^/]+)\/plugins\/([^/]+)\/plugin\.json$/;
const STYLE_PATH = /^\.\/([^/]+)\/plugins\/([^/]+)\/([^/]+\.css)$/;

function catalogRelative(globPath: string): string {
  return `sites/${globPath.replace(/^\.\//, '')}`;
}

export function listBundledSiteEntries(): readonly BundledSiteEntry[] {
  return Object.keys(siteModules)
    .sort()
    .flatMap((path) => {
      const match = SITE_PATH.exec(path);
      return match
        ? [{ siteDir: match[1], path: catalogRelative(path), siteJson: siteModules[path] }]
        : [];
    });
}

export function listBundledPluginEntries(): readonly BundledPluginEntry[] {
  const stylesByPlugin = new Map<string, Record<string, string>>();
  for (const [path, css] of Object.entries(styleModules)) {
    const match = STYLE_PATH.exec(path);
    if (!match) continue;
    const key = `${match[1]}/${match[2]}`;
    const styles = stylesByPlugin.get(key) ?? {};
    styles[match[3]] = css;
    stylesByPlugin.set(key, styles);
  }
  return Object.keys(pluginModules)
    .sort()
    .flatMap((path) => {
      const match = PLUGIN_PATH.exec(path);
      if (!match) return [];
      return [
        {
          siteDir: match[1],
          pluginDir: match[2],
          path: catalogRelative(path),
          manifestJson: pluginModules[path],
          styles: stylesByPlugin.get(`${match[1]}/${match[2]}`) ?? {},
        },
      ];
    });
}

function loadBundledSiteAdapters(): readonly SiteAdapter[] {
  const adapters: SiteAdapter[] = [];
  for (const entry of listBundledSiteEntries()) {
    try {
      const result = validateSiteAdapterData(JSON.parse(entry.siteJson) as unknown);
      if (!result.success) {
        logger.error('Invalid bundled site.json', { path: entry.path, issues: result.error });
        continue;
      }
      if (result.data.id !== entry.siteDir) {
        logger.error('Bundled site.json id must match its directory', {
          path: entry.path,
          id: result.data.id,
        });
        continue;
      }
      adapters.push(result.data);
    } catch (error) {
      logger.error('Failed to parse bundled site.json', { path: entry.path, error: String(error) });
    }
  }
  return adapters;
}

/** Validated adapters of every bundled plugin platform, in directory order. */
export const BUNDLED_SITE_ADAPTERS: readonly SiteAdapter[] = loadBundledSiteAdapters();

/**
 * The thin-shell adapters in `sites/adapters/` export these by id. A missing or
 * invalid site.json is a packaging error that must fail the test suite rather
 * than hand the runtime a silently different site.
 */
export function requireBundledSiteAdapter(id: string): SiteAdapter {
  const adapter = BUNDLED_SITE_ADAPTERS.find((entry) => entry.id === id);
  if (!adapter) throw new Error(`Bundled site adapter "${id}" is missing or invalid`);
  return adapter;
}
