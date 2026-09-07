#!/usr/bin/env bun
/**
 * Publish the bundled plugin catalog as per-host JSON files for the docs site.
 *
 * VitePress copies `docs/public/` to the root of its dist, so the files this
 * writes are served as `https://voyager.nagi.fun/catalog/hosts/<host>.json` —
 * exactly what the background refresher fetches (see
 * `src/features/plugins/remote/config.ts` and `HostCatalogSource`).
 *
 * The build reads the same sources as `BundledCatalogPluginSource`
 * (marketplace.json -> plugin.json + its CSS files), inlines every
 * `contributes.styles[].file` as `css`, and validates each manifest with the
 * runtime's own `validateManifest`. An invalid bundled manifest aborts the
 * build: the snapshot we ship is expected to be clean, and a broken host file
 * would be silently discarded by every client.
 *
 * Output is deterministic — hosts and plugin ids are sorted — so a re-run with
 * the same `generatedAt` produces byte-identical files.
 *
 * Usage: bun scripts/build-plugin-catalog.ts [--out <dir>] [--now <ISO>]
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateManifest } from '../src/features/plugins/manifest/validate';
import {
  HOST_CATALOG_FORMAT,
  validateHostCatalogFile,
} from '../src/features/plugins/remote/hostCatalogFile';
import { matchesAnyPattern } from '../src/features/plugins/sites/matchPattern';
import { DEFAULT_ADAPTERS } from '../src/features/plugins/sites/registry';
import { resolveStyleFileContributions } from '../src/features/plugins/sources/styleFiles';
import type {
  PluginManifest,
  SiteAdapter,
  SiteCapability,
  SiteThemeDescriptor,
} from '../src/features/plugins/types';

/** The `site` section of a host file: `SiteAdapter` with its Set flattened. */
export interface HostCatalogSite {
  readonly id: string;
  readonly label: string;
  readonly matches: readonly string[];
  readonly selectors: Readonly<Record<string, string>>;
  readonly theme: SiteThemeDescriptor;
  readonly brandColor?: string;
  readonly capabilities: readonly SiteCapability[];
}

/** One published `hosts/<host>.json`. Consumed by `validateHostCatalogFile`. */
export interface HostCatalogFile {
  readonly format: typeof HOST_CATALOG_FORMAT;
  readonly host: string;
  readonly generatedAt: string;
  readonly site?: HostCatalogSite;
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

interface MarketplaceEntry {
  readonly name?: string;
  readonly source?: string;
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read every plugin listed in `marketplace.json`, inline its CSS files and
 * validate it. Throws on the first unusable entry.
 */
async function readCatalogManifests(catalogDir: string): Promise<readonly PluginManifest[]> {
  const marketplacePath = join(catalogDir, 'marketplace.json');
  const raw: unknown = JSON.parse(readFileSync(marketplacePath, 'utf8'));
  if (!isRecord(raw) || !Array.isArray(raw.plugins)) {
    throw new Error(`${marketplacePath}: expected an object with a "plugins" array`);
  }

  const manifests: PluginManifest[] = [];
  for (const entry of raw.plugins as readonly MarketplaceEntry[]) {
    const source = entry?.source;
    if (!source) continue;
    const name = entry.name ?? source;
    const manifestPath = join(catalogDir, source);
    const pluginDir = dirname(manifestPath);

    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const resolved = await resolveStyleFileContributions(parsed, name, async (file) =>
      readFileSync(join(pluginDir, file), 'utf8'),
    );
    const result = validateManifest(resolved);
    if (!result.success) {
      const issues = result.error.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n');
      throw new Error(`${name} (${manifestPath}): invalid plugin manifest\n${issues}`);
    }
    manifests.push(result.data);
  }
  return manifests;
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

function findAdapter(host: string): SiteAdapter | undefined {
  const url = `https://${host}/`;
  return DEFAULT_ADAPTERS.find((adapter) => matchesAnyPattern(url, adapter.matches));
}

function serializeSite(adapter: SiteAdapter): HostCatalogSite {
  return {
    id: adapter.id,
    label: adapter.label,
    matches: [...adapter.matches],
    selectors: { ...adapter.selectors },
    theme: {
      hostSelector: adapter.theme.hostSelector,
      lightSelector: adapter.theme.lightSelector,
      darkSelector: adapter.theme.darkSelector,
    },
    ...(adapter.brandColor ? { brandColor: adapter.brandColor } : {}),
    capabilities: [...adapter.capabilities].sort(compareStrings),
  };
}

/**
 * Build every host file from a catalog directory. Pure: nothing is written and
 * nothing outside `catalogDir` is read.
 */
export async function buildHostCatalogs(
  options: BuildOptions,
): Promise<Map<string, HostCatalogFile>> {
  const manifests = await readCatalogManifests(options.catalogDir);

  const byHost = new Map<string, PluginManifest[]>();
  for (const manifest of manifests) {
    for (const host of concreteHosts(manifest.matches)) {
      const bucket = byHost.get(host);
      if (bucket) bucket.push(manifest);
      else byHost.set(host, [manifest]);
    }
  }

  const files = new Map<string, HostCatalogFile>();
  for (const host of [...byHost.keys()].sort(compareStrings)) {
    const plugins = [...(byHost.get(host) ?? [])].sort((a, b) => compareStrings(a.id, b.id));
    const adapter = findAdapter(host);
    files.set(host, {
      format: HOST_CATALOG_FORMAT,
      host,
      generatedAt: options.generatedAt,
      ...(adapter ? { site: serializeSite(adapter) } : {}),
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
      const issues = validation.issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join('\n');
      throw new Error(`${host}: host catalog file has plugin issues\n${issues}`);
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
