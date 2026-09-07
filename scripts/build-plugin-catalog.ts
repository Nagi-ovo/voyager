#!/usr/bin/env bun
/**
 * Publish the bundled plugin catalog as per-host JSON files for the docs site.
 *
 * VitePress copies `docs/public/` to the root of its dist, so the files this
 * writes are served as `https://voyager.nagi.fun/catalog/hosts/<host>.json` —
 * exactly what the background refresher fetches (see
 * `src/features/plugins/remote/config.ts` and `HostCatalogSource`).
 *
 * The build reads the same per-site layout as `BundledCatalogPluginSource`:
 *
 *   catalog/sites/<site>/site.json                 the adapter as data
 *   catalog/sites/<site>/plugins/<id>/plugin.json  a declarative plugin
 *   catalog/sites/<site>/plugins/<id>/*.css        its style files
 *
 * `src/features/plugins/catalog/sites/index.ts` discovers the same files with
 * `import.meta.glob`, which does not exist under Bun — hence the disk walk here
 * rather than an import. `marketplace.json` is an index for the docs plugin
 * store only and is deliberately not read.
 *
 * Every `site.json` passes `validateSiteAdapterData`, every `plugin.json` passes
 * `validateManifest` with its `contributes.styles[].file` inlined as `css`, and
 * a plugin may not target a URL its own site does not cover (plan D18). Any
 * violation aborts the build: the snapshot we ship is expected to be clean, and
 * a broken host file would be silently discarded by every client.
 *
 * Output is deterministic — sites, hosts and plugin ids are sorted — so a re-run
 * with the same `generatedAt` produces byte-identical files.
 *
 * Usage: bun scripts/build-plugin-catalog.ts [--out <dir>] [--now <ISO>]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ManifestIssue } from '../src/features/plugins/manifest/validate';
import { validateManifest } from '../src/features/plugins/manifest/validate';
import {
  HOST_CATALOG_FORMAT,
  validateHostCatalogFile,
} from '../src/features/plugins/remote/hostCatalogFile';
import { matchesAnyPattern } from '../src/features/plugins/sites/matchPattern';
import type { SiteAdapterData } from '../src/features/plugins/sites/siteAdapterData';
import {
  siteAdapterToData,
  validateSiteAdapterData,
} from '../src/features/plugins/sites/siteAdapterData';
import { resolveStyleFileContributions } from '../src/features/plugins/sources/styleFiles';
import type { PluginManifest, SiteAdapter } from '../src/features/plugins/types';

/** One published `hosts/<host>.json`. Consumed by `validateHostCatalogFile`. */
export interface HostCatalogFile {
  readonly format: typeof HOST_CATALOG_FORMAT;
  readonly host: string;
  readonly generatedAt: string;
  readonly site?: SiteAdapterData;
  readonly plugins: readonly PluginManifest[];
}

export interface BuildOptions {
  readonly catalogDir: string;
  readonly generatedAt: string;
}

export interface WriteOptions extends BuildOptions {
  readonly outDir: string;
}

export interface WrittenHostCatalog {
  readonly host: string;
  readonly pluginCount: number;
  readonly path: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CATALOG_DIR = join(repoRoot, 'src/features/plugins/catalog');
export const DEFAULT_OUT_DIR = join(repoRoot, 'docs/public/catalog');

/** `https://<host>/*` with a literal host — the only form that yields a file. */
const CONCRETE_HTTPS_MATCH = /^https:\/\/([^/*]+)\/\*$/i;
/** Plain domain labels; anything else (ports, credentials, `..`) is a mistake. */
const PLAIN_HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** A `sites/<dir>` entry: its validated adapter plus its validated plugins. */
interface CatalogSite {
  /** Directory name under `sites/`; equals the adapter id. */
  readonly dir: string;
  readonly adapter: SiteAdapter;
  readonly plugins: readonly PluginManifest[];
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function formatIssues(issues: readonly ManifestIssue[]): string {
  return issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n');
}

/** Directory names directly under `dir`, sorted; empty when `dir` is absent. */
function listSubdirectories(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareStrings);
}

/**
 * A URL that stands in for a match pattern, so one pattern can be tested
 * against another set of patterns: `https://*.example.com/*` becomes
 * `https://x.example.com/`. `<all_urls>` gets a host no site can claim, which
 * is the point — it escapes every site.
 */
function probeUrl(pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed === '<all_urls>') return 'https://all-urls.invalid/';
  return trimmed
    .replace(/^\*:\/\//, 'https://')
    .replace(/^(https?:\/\/)\*\./i, '$1x.')
    .replace(/\*$/, '');
}

/**
 * Plan D18: a plugin may only target URLs its own site adapter covers. Without
 * this a plugin filed under `sites/claude/` could quietly ship to chatgpt.com,
 * where its semantic selectors mean nothing.
 */
function assertMatchesStayInSite(
  manifest: PluginManifest,
  site: { readonly dir: string; readonly adapter: SiteAdapter },
  manifestPath: string,
): void {
  for (const pattern of manifest.matches) {
    if (matchesAnyPattern(probeUrl(pattern), site.adapter.matches)) continue;
    throw new Error(
      `${manifest.id} (${manifestPath}): match pattern "${pattern}" is not covered by site "${site.dir}" (${site.adapter.matches.join(', ')})`,
    );
  }
}

/** Read and validate `sites/<siteDir>/site.json`. Throws on anything unusable. */
function readSiteAdapter(catalogDir: string, siteDir: string): SiteAdapter {
  const sitePath = join(catalogDir, 'sites', siteDir, 'site.json');
  const relPath = relative(catalogDir, sitePath);
  if (!existsSync(sitePath)) {
    throw new Error(`${relPath}: every directory under sites/ needs a site.json`);
  }

  const result = validateSiteAdapterData(JSON.parse(readFileSync(sitePath, 'utf8')) as unknown);
  if (!result.success) {
    throw new Error(`${relPath}: invalid site.json\n${formatIssues(result.error)}`);
  }
  if (result.data.id !== siteDir) {
    throw new Error(
      `${relPath}: id "${result.data.id}" must equal its directory name "${siteDir}"`,
    );
  }
  return result.data;
}

/**
 * Read every `sites/<site>/plugins/<id>/plugin.json`, inline its CSS files and
 * validate it against both the manifest schema and its site.
 */
async function readSitePlugins(
  catalogDir: string,
  site: { readonly dir: string; readonly adapter: SiteAdapter },
): Promise<readonly PluginManifest[]> {
  const pluginsRoot = join(catalogDir, 'sites', site.dir, 'plugins');
  const manifests: PluginManifest[] = [];

  for (const pluginDir of listSubdirectories(pluginsRoot)) {
    const dir = join(pluginsRoot, pluginDir);
    const manifestPath = join(dir, 'plugin.json');
    if (!existsSync(manifestPath)) continue;
    const relPath = relative(catalogDir, manifestPath);

    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const resolved = await resolveStyleFileContributions(parsed, relPath, async (file) =>
      readFileSync(join(dir, file), 'utf8'),
    );
    const result = validateManifest(resolved);
    if (!result.success) {
      throw new Error(`${relPath}: invalid plugin manifest\n${formatIssues(result.error)}`);
    }
    assertMatchesStayInSite(result.data, site, relPath);
    manifests.push(result.data);
  }

  return manifests;
}

/** Walk `catalogDir/sites/` in directory order. Throws on the first problem. */
async function readCatalogSites(catalogDir: string): Promise<readonly CatalogSite[]> {
  const sitesRoot = join(catalogDir, 'sites');
  if (!existsSync(sitesRoot)) {
    throw new Error(`${sitesRoot}: the catalog has no sites/ directory`);
  }

  const sites: CatalogSite[] = [];
  for (const dir of listSubdirectories(sitesRoot)) {
    const adapter = readSiteAdapter(catalogDir, dir);
    const plugins = await readSitePlugins(catalogDir, { dir, adapter });
    sites.push({ dir, adapter, plugins });
  }
  return sites;
}

/**
 * Concrete hosts a manifest targets. Wildcard patterns such as
 * `https://*.frame.claudeusercontent.com/*` get no file — there is no single
 * host a client could derive from `location.host`.
 */
function concreteHosts(matches: readonly string[]): readonly string[] {
  const hosts = new Set<string>();
  for (const pattern of matches) {
    const match = CONCRETE_HTTPS_MATCH.exec(pattern.trim());
    if (!match) continue;
    const host = match[1].toLowerCase();
    if (!PLAIN_HOST.test(host)) {
      throw new Error(`Unsupported host "${host}" in match pattern "${pattern}"`);
    }
    hosts.add(host);
  }
  return [...hosts];
}

/**
 * Build every host file from a catalog directory. Pure: nothing is written and
 * nothing outside `catalogDir` is read.
 */
export async function buildHostCatalogs(
  options: BuildOptions,
): Promise<Map<string, HostCatalogFile>> {
  const sites = await readCatalogSites(options.catalogDir);

  const byHost = new Map<string, PluginManifest[]>();
  for (const site of sites) {
    for (const manifest of site.plugins) {
      for (const host of concreteHosts(manifest.matches)) {
        const bucket = byHost.get(host);
        if (bucket) bucket.push(manifest);
        else byHost.set(host, [manifest]);
      }
    }
  }

  const files = new Map<string, HostCatalogFile>();
  for (const host of [...byHost.keys()].sort(compareStrings)) {
    const plugins = [...(byHost.get(host) ?? [])].sort((a, b) => compareStrings(a.id, b.id));
    const site = sites.find((entry) =>
      matchesAnyPattern(`https://${host}/`, entry.adapter.matches),
    );
    // Every plugin lives under a site whose matches cover its own, so a host
    // without an adapter means the layout is broken, not that the site is
    // optional — publishing it would strip the selectors clients rely on.
    if (!site) {
      throw new Error(`${host}: no site.json under sites/ covers this host`);
    }
    files.set(host, {
      format: HOST_CATALOG_FORMAT,
      host,
      generatedAt: options.generatedAt,
      site: siteAdapterToData(site.adapter),
      plugins,
    });
  }
  return files;
}

/**
 * Build and write `<outDir>/hosts/<host>.json`, dropping stale host files that
 * this run no longer produces. Every file passes `validateHostCatalogFile`
 * before it lands, so a client-rejecting file fails the build instead of the
 * fetch.
 */
export async function writeHostCatalogs(
  options: WriteOptions,
): Promise<readonly WrittenHostCatalog[]> {
  const files = await buildHostCatalogs(options);
  const hostsDir = join(options.outDir, 'hosts');
  mkdirSync(hostsDir, { recursive: true });

  const written = new Set<string>();
  const results: WrittenHostCatalog[] = [];
  for (const [host, file] of files) {
    const json = `${JSON.stringify(file, null, 2)}\n`;
    // Validate what actually lands on disk, not the in-memory object: JSON
    // drops `undefined` fields and the client only ever sees the parsed form.
    const validation = validateHostCatalogFile(JSON.parse(json) as unknown, host);
    if (!validation) {
      throw new Error(`${host}: host catalog file was rejected by validateHostCatalogFile`);
    }
    if (validation.issues.length > 0) {
      throw new Error(`${host}: host catalog file has issues\n${formatIssues(validation.issues)}`);
    }
    if (validation.manifests.length !== file.plugins.length) {
      throw new Error(
        `${host}: ${file.plugins.length - validation.manifests.length} plugin(s) were dropped by validateHostCatalogFile`,
      );
    }

    const fileName = `${host}.json`;
    const filePath = join(hostsDir, fileName);
    writeFileSync(filePath, json, 'utf8');
    written.add(fileName);
    results.push({ host, pluginCount: file.plugins.length, path: filePath });
  }

  for (const name of readdirSync(hostsDir)) {
    if (!name.endsWith('.json') || written.has(name)) continue;
    rmSync(join(hostsDir, name), { force: true });
  }

  return results;
}

export interface CliOptions {
  readonly outDir: string;
  readonly now: string;
}

export function parseArgs(argv: readonly string[], defaults: CliOptions): CliOptions {
  let outDir = defaults.outDir;
  let now = defaults.now;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const readValue = (): string => {
      const value = eq === -1 ? argv[++index] : arg.slice(eq + 1);
      if (!value) throw new Error(`Missing value for ${flag}`);
      return value;
    };

    if (flag === '--out') outDir = resolve(readValue());
    else if (flag === '--now') now = readValue();
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return { outDir, now };
}

/** Repo-relative when it stays inside the repo, absolute otherwise. */
function displayPath(target: string): string {
  const rel = relative(repoRoot, target);
  return rel && !rel.startsWith('..') ? rel : target;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), {
    outDir: DEFAULT_OUT_DIR,
    now: new Date().toISOString(),
  });

  const results = await writeHostCatalogs({
    catalogDir: DEFAULT_CATALOG_DIR,
    outDir: options.outDir,
    generatedAt: options.now,
  });

  for (const result of results) {
    console.log(`  ${result.host} — ${result.pluginCount} plugin(s) → ${displayPath(result.path)}`);
  }
  console.log(`Wrote ${results.length} host catalog file(s) to ${displayPath(options.outDir)}`);
}

if ((import.meta as unknown as { main?: boolean }).main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
