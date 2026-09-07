import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PLUGIN_ENGINE_VERSION } from '@/features/plugins/constants';
import { validateManifest } from '@/features/plugins/manifest/validate';
import { resolveStyleFileContributions } from '@/features/plugins/sources/styleFiles';

import { DEFAULT_CATALOG_DIR, PLUGIN_I18N_LOCALES, parseArgs, scaffoldPlugin } from '../plugin-new';

const tempRoots: string[] = [];

/** A writable copy of the shipped catalog, so the real one is never touched. */
function makeCatalogCopy(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-plugin-new-'));
  tempRoots.push(root);
  const catalogDir = join(root, 'catalog');
  cpSync(DEFAULT_CATALOG_DIR, catalogDir, { recursive: true });
  return catalogDir;
}

function readManifest(pluginDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function marketplaceNames(catalogDir: string): readonly string[] {
  const parsed = JSON.parse(readFileSync(join(catalogDir, 'marketplace.json'), 'utf8')) as {
    plugins: readonly { name: string }[];
  };
  return parsed.plugins.map((entry) => entry.name);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('plugin:new scaffold', () => {
  it('creates a manifest that validates once its CSS file is inlined', async () => {
    const catalogDir = makeCatalogCopy();
    const result = scaffoldPlugin({ catalogDir, site: 'deepseek', segment: 'reading-guide' });

    expect(result.id).toBe('voyager.deepseek-reading-guide');
    expect(readdirSync(result.pluginDir).sort()).toEqual(['README.md', 'plugin.json', 'style.css']);

    const raw = readManifest(result.pluginDir);
    const inlined = await resolveStyleFileContributions(raw, 'scaffold', async (file) =>
      readFileSync(join(result.pluginDir, file), 'utf8'),
    );
    const validation = validateManifest(inlined);
    expect(validation.success ? [] : validation.error).toEqual([]);
  });

  it('copies the site matches, names the site class and pins the current engine', () => {
    const catalogDir = makeCatalogCopy();
    const result = scaffoldPlugin({ catalogDir, site: 'deepseek', segment: 'reading-guide' });

    const manifest = readManifest(result.pluginDir);
    const site = JSON.parse(
      readFileSync(join(catalogDir, 'sites', 'deepseek', 'site.json'), 'utf8'),
    ) as { matches: readonly string[] };

    expect(manifest.matches).toEqual(site.matches);
    expect(manifest.engine).toBe(`>=${PLUGIN_ENGINE_VERSION}`);
    expect(manifest.tier).toBe('declarative');
    expect(JSON.stringify(manifest.contributes)).toContain('gv-plugin-deepseek-reading-guide');
    expect(readFileSync(join(result.pluginDir, 'style.css'), 'utf8')).toContain(
      '.gv-plugin-deepseek-reading-guide',
    );
  });

  it('writes an i18n entry for every non-English locale', () => {
    const catalogDir = makeCatalogCopy();
    const result = scaffoldPlugin({ catalogDir, site: 'deepseek', segment: 'reading-guide' });

    const manifest = readManifest(result.pluginDir);
    const i18n = manifest.i18n as Record<string, { name: string; description: string }>;
    expect(Object.keys(i18n).sort()).toEqual([...PLUGIN_I18N_LOCALES].sort());
    for (const locale of PLUGIN_I18N_LOCALES) {
      expect(i18n[locale].name).toBe(manifest.name);
      expect(i18n[locale].description).toBe(manifest.description);
    }
  });

  it('appends the marketplace entry and leaves the existing ones untouched', () => {
    const catalogDir = makeCatalogCopy();
    const before = readFileSync(join(catalogDir, 'marketplace.json'), 'utf8');
    const beforeNames = marketplaceNames(catalogDir);

    const result = scaffoldPlugin({ catalogDir, site: 'deepseek', segment: 'reading-guide' });

    expect(result.marketplaceUpdated).toBe(true);
    expect(marketplaceNames(catalogDir)).toEqual([...beforeNames, 'deepseek-reading-guide']);

    const after = readFileSync(join(catalogDir, 'marketplace.json'), 'utf8');
    expect(after.endsWith('\n')).toBe(true);
    // Only the new entry is added; every other line survives byte for byte.
    const added = after
      .split('\n')
      .filter((line) => !before.split('\n').includes(line))
      .join('\n');
    expect(added).toContain('"name": "deepseek-reading-guide"');
    expect(added).toContain('"source": "sites/deepseek/plugins/reading-guide/plugin.json"');
    expect(added).not.toContain('"owner"');
  });

  it('writes the README with the plugin:check command for the new directory', () => {
    const catalogDir = makeCatalogCopy();
    const result = scaffoldPlugin({ catalogDir, site: 'deepseek', segment: 'reading-guide' });

    const readme = readFileSync(join(result.pluginDir, 'README.md'), 'utf8');
    // The command names the directory that was actually written, so a
    // --catalog run does not tell the contributor to check the default tree.
    expect(readme).toContain(
      `bun run plugin:check ${relative(process.cwd(), result.pluginDir).split(sep).join('/')}`,
    );
    expect(readme).toContain('sites/deepseek/plugins/reading-guide');
    expect(readme).toContain('Light theme');
    expect(readme).toContain('Dark theme');
    expect(readme).toContain('Target match count');
  });

  it('refuses to overwrite an existing plugin directory', () => {
    const catalogDir = makeCatalogCopy();
    const pluginDir = join(catalogDir, 'sites', 'deepseek', 'plugins', 'reading-width');
    const existing = readFileSync(join(pluginDir, 'plugin.json'), 'utf8');
    const before = readFileSync(join(catalogDir, 'marketplace.json'), 'utf8');

    expect(() =>
      scaffoldPlugin({ catalogDir, site: 'deepseek', segment: 'reading-width' }),
    ).toThrow(/already exists/);
    expect(readFileSync(join(pluginDir, 'plugin.json'), 'utf8')).toBe(existing);
    expect(readFileSync(join(catalogDir, 'marketplace.json'), 'utf8')).toBe(before);
  });

  it('rejects an unknown site and lists the ones that exist', () => {
    const catalogDir = makeCatalogCopy();
    expect(() => scaffoldPlugin({ catalogDir, site: 'gemini', segment: 'reading-guide' })).toThrow(
      /Unknown site "gemini".*chatgpt, claude, deepseek/s,
    );
  });

  it('rejects an id segment that is not kebab-case', () => {
    const catalogDir = makeCatalogCopy();
    for (const segment of ['ReadingGuide', 'reading_guide', 'reading--guide', '-guide', '']) {
      expect(() => scaffoldPlugin({ catalogDir, site: 'deepseek', segment })).toThrow(/kebab-case/);
    }
  });

  it('writes nothing for a dry run', () => {
    const catalogDir = makeCatalogCopy();
    const before = readFileSync(join(catalogDir, 'marketplace.json'), 'utf8');

    const result = scaffoldPlugin({
      catalogDir,
      site: 'deepseek',
      segment: 'reading-guide',
      dryRun: true,
    });

    expect(result.written).toBe(false);
    expect(result.files).toHaveLength(3);
    expect(existsSync(result.pluginDir)).toBe(false);
    expect(readFileSync(join(catalogDir, 'marketplace.json'), 'utf8')).toBe(before);
  });
});

describe('plugin:new arguments', () => {
  it('reads the segment, the site and the dry-run flag', () => {
    expect(parseArgs(['demo', '--site', 'deepseek', '--dry-run'], '/catalog')).toEqual({
      segment: 'demo',
      site: 'deepseek',
      catalogDir: '/catalog',
      dryRun: true,
    });
    expect(parseArgs(['--site=claude', 'demo'], '/catalog').site).toBe('claude');
  });

  it('requires both the segment and the site', () => {
    expect(() => parseArgs(['--site', 'deepseek'], '/catalog')).toThrow(/Missing <id-segment>/);
    expect(() => parseArgs(['demo'], '/catalog')).toThrow(/Missing --site/);
    expect(() => parseArgs(['demo', 'extra', '--site', 'x'], '/catalog')).toThrow(/Unexpected/);
    expect(() => parseArgs(['demo', '--site', 'x', '--nope'], '/catalog')).toThrow(/Unknown/);
  });
});
