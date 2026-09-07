#!/usr/bin/env bun
/**
 * Contributor-facing checker for one plugin directory (plan §8).
 *
 * `bun run plugin:check` answers "will this plugin be accepted?" before a PR is
 * opened, with the same rules the publisher applies in
 * `scripts/build-plugin-catalog.ts` — both import them from
 * `scripts/lib/pluginChecks.ts`. The publisher aborts on the first violation
 * because its snapshot is expected to be clean; this reports every issue at
 * once, because an author fixing one at a time is the slow path.
 *
 * A plugin directory is
 *   src/features/plugins/catalog/sites/<site>/plugins/<id>/
 * and is checked for:
 *   1. a `plugin.json` that parses and passes `validateManifest` with its
 *      `contributes.styles[].file` inlined exactly as the build inlines it,
 *      every referenced CSS file passing `validateStyleCss`, and `format` 1;
 *   2. a sibling `../../site.json` that passes `validateSiteAdapterData`, whose
 *      `id` equals its directory name, and whose `matches` cover the plugin's
 *      (plan D18);
 *   3. only primitives this build ships, behind an `engine` floor ≥ their
 *      `sinceEngine` (plan §5);
 *   4. only semantic keys its own site defines;
 *   5. localized `name`/`description` (plus `changelog` and every setting
 *      `label` when present) for all nine non-English app locales — a missing
 *      one silently falls back to English in the popup, which is why it needs a
 *      checker rather than a review;
 *   6. a README.md, the only per-plugin documentation the catalog carries.
 *
 * Nothing here imports `catalog/sites/index.ts` or the verb/site registries:
 * they rely on `import.meta.glob` and content-script globals, neither of which
 * exists under Bun. Hence the disk walk, and the primitive list read from the
 * data-only `verbs/contracts.ts`.
 *
 * Usage: bun scripts/plugin-check.ts [<plugin dir>...]
 *        (no argument checks every plugin under the bundled catalog)
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateManifest, validateStyleCss } from '../src/features/plugins/manifest/validate';
import { resolveStyleFileContributions } from '../src/features/plugins/sources/styleFiles';
import type { PluginManifest } from '../src/features/plugins/types';
import {
  type CatalogSiteRef,
  checkManifestAgainstSite,
  formatIssues,
  listSubdirectories,
  loadSiteAdapter,
} from './lib/pluginChecks';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CATALOG_SITES_DIR = join(repoRoot, 'src/features/plugins/catalog/sites');

/**
 * App locales that need a translation. `en` is absent on purpose: the top-level
 * `name`/`description`/`changelog` and the setting `label`s ARE the English
 * copy, and `PluginLocalization` falls back to them per field.
 */
export const REQUIRED_PLUGIN_LOCALES = [
  'ar',
  'es',
  'fr',
  'ja',
  'ko',
  'pt',
  'ru',
  'zh',
  'zh_TW',
] as const;

export interface PluginCheckResult {
  /** Absolute path of the checked directory. */
  readonly dir: string;
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/** Repo-relative when it stays inside the repo, absolute otherwise. */
export function displayPath(target: string): string {
  const rel = relative(repoRoot, target);
  return rel && !rel.startsWith('..') ? rel : target;
}

/**
 * Read `plugin.json` and inline `contributes.styles[].file` the way the build
 * does, so `validateManifest` sees the manifest that would actually ship.
 * Returns null (with an issue) when the file cannot be turned into a manifest.
 */
async function readManifest(
  manifestPath: string,
  pluginDir: string,
  issues: string[],
): Promise<PluginManifest | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    issues.push(`plugin.json: not valid JSON (${(error as Error).message})`);
    return null;
  }

  // `resolveStyleFileContributions` re-runs `validateStyleCss` and throws on the
  // first bad file. Running it in the loader too costs nothing and collects
  // every file's issues; the throw is then already explained, so it is only
  // reported when it says something new (a missing or unreadable file).
  const before = issues.length;
  let resolved: unknown;
  try {
    resolved = await resolveStyleFileContributions(parsed, 'plugin.json', async (file) => {
      const cssPath = join(pluginDir, file);
      if (!existsSync(cssPath)) {
        throw new Error(`contributes.styles references a missing file: ${file}`);
      }
      const css = readFileSync(cssPath, 'utf8');
      for (const issue of validateStyleCss(css, file)) {
        issues.push(`${issue.path}: ${issue.message}`);
      }
      return css;
    });
  } catch (error) {
    if (issues.length === before) issues.push((error as Error).message);
    return null;
  }

  const result = validateManifest(resolved);
  if (!result.success) {
    issues.push(`invalid plugin manifest\n${formatIssues(result.error)}`);
    return null;
  }
  return result.data;
}

/**
 * Every locale must carry `name` and `description`; a manifest with a
 * `changelog` needs it translated too, and every declared setting needs a
 * localized `label`. Anything missing falls back to English at runtime, which
 * reads as an untranslated plugin rather than as a bug.
 */
function checkLocalization(manifest: PluginManifest): readonly string[] {
  const issues: string[] = [];
  const i18n = manifest.i18n ?? {};
  const settingKeys = Object.keys(manifest.contributes.settings ?? {}).sort();

  for (const locale of REQUIRED_PLUGIN_LOCALES) {
    const entry = i18n[locale];
    const missing: string[] = [];
    if (!entry?.name) missing.push('name');
    if (!entry?.description) missing.push('description');
    if (manifest.changelog && !entry?.changelog) missing.push('changelog');
    for (const key of settingKeys) {
      if (!entry?.settings?.[key]?.label) missing.push(`settings.${key}.label`);
    }
    for (const field of missing) issues.push(`i18n: missing ${locale}.${field}`);
  }
  return issues;
}

/**
 * Run every rule over one plugin directory. Pure apart from reading that
 * directory and its site's `site.json`, so tests can point it at a fixture.
 */
export async function checkPluginDir(dir: string): Promise<PluginCheckResult> {
  const pluginDir = resolve(dir);
  const issues: string[] = [];

  if (!existsSync(pluginDir)) {
    return { dir: pluginDir, ok: false, issues: ['directory does not exist'] };
  }

  const pluginsRoot = dirname(pluginDir);
  const siteDir = dirname(pluginsRoot);
  // The no-argument run only scans <catalog>/sites/<site>/plugins/<id>; a
  // plugin that passes here from any other parent would silently drop out of
  // CI, so demand the same shape.
  if (basename(pluginsRoot) !== 'plugins' || basename(dirname(siteDir)) !== 'sites') {
    return {
      dir: pluginDir,
      ok: false,
      issues: [
        'a plugin must live at <catalog>/sites/<site>/plugins/<id>/ so its site.json can be found',
      ],
    };
  }

  const manifestPath = join(pluginDir, 'plugin.json');
  if (!existsSync(manifestPath)) {
    issues.push('plugin.json is missing');
  }
  if (!existsSync(join(pluginDir, 'README.md'))) {
    issues.push('README.md is missing — every catalog plugin documents itself');
  }

  const siteName = basename(siteDir);
  const siteLoad = loadSiteAdapter(
    join(siteDir, 'site.json'),
    siteName,
    displayPath(join(siteDir, 'site.json')),
  );
  issues.push(...siteLoad.issues);

  const manifest = existsSync(manifestPath)
    ? await readManifest(manifestPath, pluginDir, issues)
    : null;

  if (manifest) {
    issues.push(...checkLocalization(manifest));
    if (siteLoad.adapter) {
      const site: CatalogSiteRef = { dir: siteName, adapter: siteLoad.adapter };
      issues.push(...checkManifestAgainstSite(manifest, site, 'plugin.json'));
    }
  }

  return { dir: pluginDir, ok: issues.length === 0, issues };
}

/**
 * Every `sites/<site>/plugins/<id>/` under a catalog `sites/` directory. A
 * directory without a `plugin.json` is still returned so the check reports it
 * instead of silently ignoring a misnamed manifest.
 */
export function findPluginDirs(sitesDir: string): readonly string[] {
  const dirs: string[] = [];
  for (const site of listSubdirectories(sitesDir)) {
    const pluginsRoot = join(sitesDir, site, 'plugins');
    for (const plugin of listSubdirectories(pluginsRoot)) {
      dirs.push(join(pluginsRoot, plugin));
    }
  }
  return dirs;
}

export function formatResult(result: PluginCheckResult): string {
  const header = `${result.ok ? 'ok  ' : 'FAIL'} ${displayPath(result.dir)}`;
  if (result.ok) return header;
  const details = result.issues.map((issue) => `    - ${issue.replace(/\n/g, '\n    ')}`);
  return [header, ...details].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dirs =
    args.length > 0 ? args.map((arg) => resolve(arg)) : findPluginDirs(DEFAULT_CATALOG_SITES_DIR);

  if (dirs.length === 0) {
    console.error(`No plugin directories found under ${displayPath(DEFAULT_CATALOG_SITES_DIR)}`);
    process.exit(1);
  }

  let failed = 0;
  for (const dir of dirs) {
    const result = await checkPluginDir(dir);
    if (!result.ok) failed += 1;
    console.log(formatResult(result));
  }

  if (failed > 0) {
    console.error(`\n${failed} of ${dirs.length} plugin(s) failed.`);
    process.exit(1);
  }
  console.log(`\n${dirs.length} plugin(s) checked, all good.`);
}

if ((import.meta as unknown as { main?: boolean }).main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
