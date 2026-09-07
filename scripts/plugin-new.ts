#!/usr/bin/env bun
/**
 * Scaffold a bundled official plugin directory (plan §8).
 *
 * Creates `catalog/sites/<site>/plugins/<id-segment>/` with a manifest, a
 * scoped placeholder stylesheet and a README skeleton, then appends the entry
 * `catalog/marketplace.json` needs so the docs plugin store lists it. Nothing
 * else registers a plugin: `catalog/sites/index.ts` discovers the files.
 *
 * The manifest copies `matches` straight from the site's `site.json`, so the
 * plugin starts inside its own site (plan D18), and pins `engine` to the engine
 * version this build ships, so a plugin that later calls a primitive already
 * declares a range no older than that primitive's `sinceEngine` (plan §5).
 *
 * The scaffold is a starting point, not an approval: fill in the copy, write
 * the real CSS or `domOps`, then run `bun run plugin:check <dir>`, which is the
 * gate for the manifest, the CSS, site containment, primitives, semantic keys,
 * the 10-locale metadata and the README.
 *
 * JSON is rendered at the formatter's print width so the generated files are
 * already `oxfmt`-clean: a value goes on one line when it fits, and breaks
 * otherwise.
 *
 * Usage: bun scripts/plugin-new.ts <id-segment> --site <site> [--dry-run]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLUGIN_ENGINE_VERSION } from '../src/features/plugins/constants';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CATALOG_DIR = join(repoRoot, 'src/features/plugins/catalog');

/**
 * Locales a manifest localizes. English is not here: it lives in the top-level
 * `name` / `description`, which makes ten in total (`.claude/rules/i18n.md`).
 */
export const PLUGIN_I18N_LOCALES = [
  'zh',
  'zh_TW',
  'ja',
  'ko',
  'fr',
  'es',
  'pt',
  'ru',
  'ar',
] as const;

/** Directory name and id suffix: lowercase words joined by single hyphens. */
const SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SEGMENT_LENGTH = 40;

const GITHUB_TREE_BASE =
  'https://github.com/Nagi-ovo/voyager/tree/main/src/features/plugins/catalog';

/** `oxfmt`'s print width; the JSON renderer below breaks a value past it. */
const PRINT_WIDTH = 100;

export interface ScaffoldOptions {
  /** Catalog root; defaults to the shipped `src/features/plugins/catalog`. */
  readonly catalogDir?: string;
  /** Directory name under `catalog/sites/`. */
  readonly site: string;
  /** Plugin directory name, kebab-case. */
  readonly segment: string;
  /** Print the plan and write nothing. */
  readonly dryRun?: boolean;
  /** Engine version the manifest requires; defaults to this build's. */
  readonly engineVersion?: string;
}

export interface ScaffoldedFile {
  readonly path: string;
  readonly contents: string;
}

export interface MarketplaceEntry {
  readonly name: string;
  readonly source: string;
  readonly official: true;
}

export interface ScaffoldResult {
  readonly id: string;
  readonly site: string;
  readonly segment: string;
  readonly pluginDir: string;
  readonly files: readonly ScaffoldedFile[];
  readonly marketplacePath: string;
  readonly marketplaceEntry: MarketplaceEntry;
  /** False when an entry with the same name was already there. */
  readonly marketplaceUpdated: boolean;
  readonly codeownersLine: string;
  /** False for a dry run. */
  readonly written: boolean;
}

interface SiteInfo {
  readonly dir: string;
  readonly label: string;
  readonly matches: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Directory names directly under `dir`, sorted; empty when `dir` is absent. */
function listSubdirectories(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

export function assertSegment(segment: string): void {
  if (!SEGMENT_PATTERN.test(segment)) {
    throw new Error(
      `Invalid plugin id segment "${segment}": use kebab-case, for example "reading-width".`,
    );
  }
  if (segment.length > MAX_SEGMENT_LENGTH) {
    throw new Error(
      `Plugin id segment "${segment}" is longer than ${MAX_SEGMENT_LENGTH} characters.`,
    );
  }
}

function readSite(catalogDir: string, site: string): SiteInfo {
  const sitesDir = join(catalogDir, 'sites');
  const available = listSubdirectories(sitesDir);
  if (!available.includes(site)) {
    const list = available.length > 0 ? available.join(', ') : '(none)';
    throw new Error(
      `Unknown site "${site}". Available sites under ${sitesDir}: ${list}. ` +
        'A new site needs its own site.json and an extension release (plan D16).',
    );
  }

  const sitePath = join(sitesDir, site, 'site.json');
  if (!existsSync(sitePath)) throw new Error(`Missing ${sitePath}`);
  const parsed: unknown = JSON.parse(readFileSync(sitePath, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${sitePath}: site adapter must be an object`);
  if (!nonEmptyString(parsed.label))
    throw new Error(`${sitePath}: label must be a non-empty string`);
  if (
    !Array.isArray(parsed.matches) ||
    parsed.matches.length === 0 ||
    !parsed.matches.every(nonEmptyString)
  ) {
    throw new Error(`${sitePath}: matches must be a non-empty array of strings`);
  }

  return { dir: site, label: parsed.label, matches: parsed.matches.slice() };
}

/** `reading-width` -> `Reading Width`. */
export function titleCase(segment: string): string {
  return segment
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** One-line JSON in the formatter's shape: padded braces, no padded brackets. */
function inlineJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.map((item) => inlineJson(item)).join(', ')}]`;
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  if (entries.length === 0) return '{}';
  const body = entries.map(([key, item]) => `${JSON.stringify(key)}: ${inlineJson(item)}`);
  return `{ ${body.join(', ')} }`;
}

/**
 * Render JSON the way the repository formatter would: keep a value on one line
 * while it fits inside the print width from where it starts, break it onto
 * indented lines otherwise.
 */
export function renderJson(value: unknown, startColumn = 0, indent = 0): string {
  const flat = inlineJson(value);
  // A primitive has no break points: a long string stays on its own line.
  if (startColumn + flat.length <= PRINT_WIDTH || value === null || typeof value !== 'object') {
    return flat;
  }

  const childIndent = indent + 2;
  const pad = ' '.repeat(childIndent);
  const closePad = ' '.repeat(indent);

  if (Array.isArray(value)) {
    const items = value.map((item) => `${pad}${renderJson(item, childIndent, childIndent)}`);
    return `[\n${items.join(',\n')}\n${closePad}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, item]) => item !== undefined,
  );
  const lines = entries.map(([key, item]) => {
    const prefix = `${JSON.stringify(key)}: `;
    return `${pad}${prefix}${renderJson(item, childIndent + prefix.length, childIndent)}`;
  });
  return `{\n${lines.join(',\n')}\n${closePad}}`;
}

function buildManifest(site: SiteInfo, segment: string, engineVersion: string): string {
  const id = `voyager.${site.dir}-${segment}`;
  const name = `${site.label} · ${titleCase(segment)}`;
  const description = `TODO: one sentence on what this changes for ${site.label} users.`;
  const i18n: Record<string, { name: string; description: string }> = {};
  for (const locale of PLUGIN_I18N_LOCALES) {
    // Placeholders equal to the English text: the shape is complete, so the
    // structural checks pass, and a reviewer still sees untranslated copy.
    i18n[locale] = { name, description };
  }

  const manifest = {
    id,
    name,
    version: '1.0.0',
    description,
    i18n,
    author: 'voyager-official',
    category: 'other',
    license: 'MIT',
    homepage: `${GITHUB_TREE_BASE}/sites/${site.dir}/plugins/${segment}`,
    engine: `>=${engineVersion}`,
    tier: 'declarative',
    matches: site.matches,
    contributes: {
      styles: [{ file: 'style.css' }],
      domOps: [{ op: 'addClass', target: 'body', className: `gv-plugin-${site.dir}-${segment}` }],
    },
  };

  return `${renderJson(manifest)}\n`;
}

function buildStyle(site: SiteInfo, segment: string): string {
  const className = `gv-plugin-${site.dir}-${segment}`;
  return [
    `/* ${site.label} · ${titleCase(segment)}`,
    ' *',
    ' * Everything this plugin changes stays under its own class, so disabling it',
    ' * restores the native page. Keep every selector prefixed with `gv-`, and do',
    ' * not reference remote fonts, images or stylesheets.',
    ' *',
    ' * TODO: replace the placeholder declaration below with the real rules.',
    ' */',
    `.${className} {`,
    `  --${className}-scaffold: 1;`,
    '}',
    '',
  ].join('\n');
}

function buildReadme(
  site: SiteInfo,
  segment: string,
  engineVersion: string,
  checkPath: string,
): string {
  const title = `${site.label} · ${titleCase(segment)}`;
  const matches = site.matches.map((pattern) => `  - ${pattern}`).join('\n');
  return `---
id: voyager.${site.dir}-${segment}
name: ${title}
category: other
version: 1.0.0
author: voyager-official
license: MIT
matches:
${matches}
engine: '>=${engineVersion}'
---

# ${site.label} - ${titleCase(segment)}

TODO: what the plugin does, in one paragraph. Name the problem on ${site.label}
and what the page looks like once the plugin is on. Say what disabling it
restores.

## How it works

TODO: the selectors or semantic keys it targets, the settings it exposes, and
anything it deliberately leaves native.

This is a declarative plugin: CSS and JSON interpreted by Voyager's bundled
plugin engine. It does not execute remote JavaScript or load external resources.

## Verification

Replace each line with what was actually measured. An unfilled line is a gap,
not a formality.

- Page: TODO the real conversation URL used, and roughly how long it was.
- Target match count: TODO how many elements the selectors hit on that page.
- Light theme: TODO screenshot or recording.
- Dark theme: TODO screenshot or recording.
- \`bun run plugin:check ${checkPath}\`: TODO the output.
- Popup health: TODO confirm the plugin is not flagged "no effect" on that page.
`;
}

/** Index of the `]` closing the `[` at `open`, skipping brackets inside strings. */
function findMatchingBracket(source: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error('unterminated array');
}

/**
 * Append one entry to `marketplace.json` by rewriting only its `plugins`
 * array, so the rest of the file keeps the formatting it was committed with.
 */
export function appendMarketplaceEntry(source: string, entry: MarketplaceEntry): string {
  const key = '"plugins"';
  const keyIndex = source.indexOf(key);
  if (keyIndex === -1) throw new Error('marketplace.json: no "plugins" key');
  const open = source.indexOf('[', keyIndex + key.length);
  if (open === -1) throw new Error('marketplace.json: "plugins" is not an array');
  const close = findMatchingBracket(source, open);

  const existing: unknown = JSON.parse(source.slice(open, close + 1));
  if (!Array.isArray(existing)) throw new Error('marketplace.json: "plugins" is not an array');

  const lineStart = source.lastIndexOf('\n', open) + 1;
  const line = source.slice(lineStart, open);
  const indent = line.length - line.trimStart().length;
  const rendered = renderJson([...existing, entry], open - lineStart, indent);
  return `${source.slice(0, open)}${rendered}${source.slice(close + 1)}`;
}

function listedNames(source: string): readonly string[] {
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
    throw new Error('marketplace.json: expected an object with a plugins array');
  }
  return parsed.plugins
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => (typeof entry.name === 'string' ? entry.name : ''));
}

/**
 * Create the plugin directory and register it in `marketplace.json`.
 *
 * Throws rather than overwriting: an existing directory means the id is taken.
 */
export function scaffoldPlugin(options: ScaffoldOptions): ScaffoldResult {
  const catalogDir = options.catalogDir ?? DEFAULT_CATALOG_DIR;
  const { segment } = options;
  assertSegment(segment);

  const site = readSite(catalogDir, options.site);
  const engineVersion = options.engineVersion ?? PLUGIN_ENGINE_VERSION;
  const pluginDir = join(catalogDir, 'sites', site.dir, 'plugins', segment);
  if (existsSync(pluginDir)) {
    throw new Error(`Refusing to overwrite ${pluginDir}: the directory already exists.`);
  }

  const source = `sites/${site.dir}/plugins/${segment}/plugin.json`;
  const checkPath = `src/features/plugins/catalog/${source.replace('/plugin.json', '')}`;
  const files: readonly ScaffoldedFile[] = [
    { path: join(pluginDir, 'plugin.json'), contents: buildManifest(site, segment, engineVersion) },
    { path: join(pluginDir, 'style.css'), contents: buildStyle(site, segment) },
    {
      path: join(pluginDir, 'README.md'),
      contents: buildReadme(site, segment, engineVersion, checkPath),
    },
  ];

  const marketplacePath = join(catalogDir, 'marketplace.json');
  const marketplaceEntry: MarketplaceEntry = {
    name: `${site.dir}-${segment}`,
    source,
    official: true,
  };
  const marketplaceSource = readFileSync(marketplacePath, 'utf8');
  const alreadyListed = listedNames(marketplaceSource).includes(marketplaceEntry.name);

  const result: ScaffoldResult = {
    id: `voyager.${site.dir}-${segment}`,
    site: site.dir,
    segment,
    pluginDir,
    files,
    marketplacePath,
    marketplaceEntry,
    marketplaceUpdated: !alreadyListed,
    codeownersLine: `/src/features/plugins/catalog/sites/${site.dir}/ @Nagi-ovo`,
    written: options.dryRun !== true,
  };

  if (options.dryRun === true) return result;

  mkdirSync(pluginDir, { recursive: true });
  for (const file of files) writeFileSync(file.path, file.contents, 'utf8');

  if (!alreadyListed) {
    writeFileSync(
      marketplacePath,
      appendMarketplaceEntry(marketplaceSource, marketplaceEntry),
      'utf8',
    );
  }

  return result;
}

export interface CliOptions {
  readonly segment: string;
  readonly site: string;
  readonly catalogDir: string;
  readonly dryRun: boolean;
}

const USAGE = 'Usage: bun scripts/plugin-new.ts <id-segment> --site <site> [--dry-run]';

export function parseArgs(argv: readonly string[], defaultCatalogDir: string): CliOptions {
  let segment: string | undefined;
  let site: string | undefined;
  let catalogDir = defaultCatalogDir;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      if (segment !== undefined) throw new Error(`Unexpected argument: ${arg}\n${USAGE}`);
      segment = arg;
      continue;
    }

    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const readValue = (): string => {
      const value = eq === -1 ? argv[++index] : arg.slice(eq + 1);
      if (!value) throw new Error(`Missing value for ${flag}`);
      return value;
    };

    if (flag === '--site') site = readValue();
    else if (flag === '--catalog') catalogDir = resolve(readValue());
    else if (flag === '--dry-run') dryRun = true;
    else throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }

  if (!segment) throw new Error(`Missing <id-segment>.\n${USAGE}`);
  if (!site) throw new Error(`Missing --site <site>.\n${USAGE}`);
  return { segment, site, catalogDir, dryRun };
}

/** Repo-relative when it stays inside the repo, absolute otherwise. */
function displayPath(target: string): string {
  const rel = relative(repoRoot, target);
  return rel && !rel.startsWith('..') ? rel : target;
}

function report(result: ScaffoldResult, dryRun: boolean): void {
  const verb = dryRun ? 'Would create' : 'Created';
  console.log(`${verb} ${displayPath(result.pluginDir)} (${result.id})`);
  for (const file of result.files) {
    const lines = file.contents.split('\n').length - 1;
    console.log(`  ${displayPath(file.path)} (${lines} lines)`);
  }

  const entry = inlineJson(result.marketplaceEntry);
  if (!result.marketplaceUpdated) {
    console.log(`  ${displayPath(result.marketplacePath)} already lists this plugin`);
  } else {
    const marketplaceVerb = dryRun ? 'Would append' : 'Appended';
    console.log(`${marketplaceVerb} to ${displayPath(result.marketplacePath)}: ${entry}`);
  }

  const dir = displayPath(result.pluginDir);
  console.log('');
  console.log('Next:');
  console.log('  1. Read .agents/skills/create-voyager-plugin/SKILL.md before editing.');
  console.log('  2. Write the English name and description, then the 9 other locales.');
  console.log('  3. Replace the placeholder CSS and DOM ops with the real ones.');
  console.log(`  4. bun run plugin:check ${dir}`);
  console.log('  5. bun run test src/features/plugins && bun run catalog:build');
  console.log('  6. Collect evidence: light and dark screenshots on a real conversation,');
  console.log('     the target match count, and the plugin:check output.');
  console.log('  7. .github/CODEOWNERS takes one line per site; add this if it has none:');
  console.log(`     ${result.codeownersLine}`);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2), DEFAULT_CATALOG_DIR);
  const result = scaffoldPlugin({
    catalogDir: options.catalogDir,
    site: options.site,
    segment: options.segment,
    dryRun: options.dryRun,
  });
  report(result, options.dryRun);
}

if ((import.meta as unknown as { main?: boolean }).main) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
