import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CATALOG_SITES_DIR,
  REQUIRED_PLUGIN_LOCALES,
  checkPluginDir,
  findPluginDirs,
  formatResult,
} from '../plugin-check';

const tempRoots: string[] = [];

function makeTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-plugin-check-'));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

interface FixtureOverrides {
  /** Merged into the plugin manifest, so one knob per rule under test. */
  readonly manifest?: Record<string, unknown>;
  /** Merged into the site adapter's semantic selectors. */
  readonly selectors?: Record<string, string>;
  /** Skip writing README.md. */
  readonly omitReadme?: boolean;
  /** Skip writing plugin.json. */
  readonly omitManifest?: boolean;
  /** Replaces the whole site.json document. */
  readonly site?: Record<string, unknown> | null;
}

/** Localized name/description for every locale the checker demands. */
function fullI18n(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const i18n: Record<string, unknown> = {};
  for (const locale of REQUIRED_PLUGIN_LOCALES) {
    i18n[locale] = {
      name: `Widen (${locale})`,
      description: `A fixture plugin (${locale}).`,
      ...extra,
    };
  }
  return i18n;
}

/** One site with one plugin, so a rule can be exercised in isolation. */
function makeFixturePlugin(overrides: FixtureOverrides = {}): string {
  const siteDir = join(makeTempDir(), 'catalog', 'sites', 'demo');
  const pluginDir = join(siteDir, 'plugins', 'widen');
  mkdirSync(pluginDir, { recursive: true });

  if (overrides.site !== null) {
    writeJson(join(siteDir, 'site.json'), {
      id: 'demo',
      label: 'Demo',
      matches: ['https://demo.example/*'],
      selectors: { composer: 'textarea', ...overrides.selectors },
      theme: { hostSelector: 'html', lightSelector: 'html.light', darkSelector: 'html.dark' },
      capabilities: ['chat'],
      ...overrides.site,
    });
  }

  if (!overrides.omitManifest) {
    writeJson(join(pluginDir, 'plugin.json'), {
      id: 'demo.widen',
      name: 'Demo · Widen',
      version: '1.0.0',
      description: 'A fixture plugin.',
      author: 'voyager-official',
      category: 'readability',
      license: 'MIT',
      engine: '>=1.2.0',
      tier: 'declarative',
      matches: ['https://demo.example/*'],
      i18n: fullI18n(),
      contributes: { styles: [{ file: 'style.css' }] },
      ...overrides.manifest,
    });
  }
  writeFileSync(join(pluginDir, 'style.css'), 'body { color: red; }\n', 'utf8');
  if (!overrides.omitReadme) {
    writeFileSync(join(pluginDir, 'README.md'), '# Demo · Widen\n', 'utf8');
  }

  return pluginDir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('plugin-check', () => {
  it('passes every plugin in the bundled catalog', async () => {
    const dirs = findPluginDirs(DEFAULT_CATALOG_SITES_DIR);
    expect(dirs.length).toBeGreaterThan(0);

    for (const dir of dirs) {
      const result = await checkPluginDir(dir);
      expect(result.issues, formatResult(result)).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it('accepts a complete fixture plugin', async () => {
    const result = await checkPluginDir(makeFixturePlugin());
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('reports a missing README', async () => {
    const result = await checkPluginDir(makeFixturePlugin({ omitReadme: true }));
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(/README\.md is missing/);
  });

  it('reports a missing plugin.json without crashing on the rest', async () => {
    const result = await checkPluginDir(makeFixturePlugin({ omitManifest: true }));
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('plugin.json is missing');
  });

  it('reports a manifest the validator rejects', async () => {
    const result = await checkPluginDir(makeFixturePlugin({ manifest: { tier: 'wizard' } }));
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(/invalid plugin manifest[\s\S]*tier/);
  });

  it('reports a style file that fetches a remote resource', async () => {
    const pluginDir = makeFixturePlugin();
    writeFileSync(join(pluginDir, 'style.css'), "@import url('https://evil.example/x.css');\n");

    const result = await checkPluginDir(pluginDir);
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(/@import or external url\(\)/);
  });

  it('reports a match pattern the site does not cover (D18)', async () => {
    const result = await checkPluginDir(
      makeFixturePlugin({
        manifest: { matches: ['https://demo.example/*', 'https://elsewhere.example/*'] },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(
      /"https:\/\/elsewhere\.example\/\*" is not covered by site "demo"/,
    );
  });

  it('rejects a wildcard host or a wider scheme than the site, not just a foreign host (D18)', async () => {
    const wildcard = await checkPluginDir(
      makeFixturePlugin({ manifest: { matches: ['https://*.example/*'] } }),
    );
    expect(wildcard.ok).toBe(false);
    expect(wildcard.issues.join('\n')).toMatch(/"https:\/\/\*\.example\/\*" is not covered/);

    const scheme = await checkPluginDir(
      makeFixturePlugin({ manifest: { matches: ['*://demo.example/*'] } }),
    );
    expect(scheme.ok).toBe(false);
    expect(scheme.issues.join('\n')).toMatch(/"\*:\/\/demo\.example\/\*" is not covered/);
  });

  it('rejects a plugin directory outside <catalog>/sites/<site>/plugins/', async () => {
    const stray = join(makeTempDir(), 'catalog', 'other', 'demo', 'plugins', 'widen');
    mkdirSync(stray, { recursive: true });
    writeJson(join(stray, '..', '..', 'site.json'), { id: 'demo' });
    const result = await checkPluginDir(stray);
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatch(/sites\/<site>\/plugins\/<id>/);
  });

  it('reports a primitive this build does not ship', async () => {
    const result = await checkPluginDir(
      makeFixturePlugin({
        manifest: { engine: '>=1.3.0', requires: { handlers: ['teleport'] } },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(/unknown primitive handler "teleport"/);
  });

  it('reports an engine range that admits builds older than a primitive', async () => {
    const result = await checkPluginDir(
      makeFixturePlugin({
        manifest: {
          engine: '>=1.2.0',
          contributes: {
            styles: [{ file: 'style.css' }],
            domOps: [{ op: 'native', handler: 'formulaCopy', params: {} }],
          },
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(/admits builds older than 1\.3\.0.*"formulaCopy"/s);
  });

  it('reports a semantic key the site does not define', async () => {
    const result = await checkPluginDir(
      makeFixturePlugin({
        manifest: {
          contributes: {
            styles: [{ file: 'style.css' }],
            domOps: [
              {
                op: 'addClass',
                target: { kind: 'semantic', key: 'scrollContainer' },
                className: 'gv-plugin-demo',
              },
            ],
          },
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(/"scrollContainer".*not defined by site "demo"/);
  });

  it('accepts a semantic target once the site declares the key', async () => {
    const result = await checkPluginDir(
      makeFixturePlugin({
        selectors: { scrollContainer: 'main' },
        manifest: {
          contributes: {
            styles: [{ file: 'style.css' }],
            domOps: [
              {
                op: 'addClass',
                target: { kind: 'semantic', key: 'scrollContainer' },
                className: 'gv-plugin-demo',
              },
            ],
          },
        },
      }),
    );
    expect(result.issues).toEqual([]);
  });

  it('reports a site.json whose id does not match its directory', async () => {
    const result = await checkPluginDir(makeFixturePlugin({ site: { id: 'not-demo' } }));
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(/id "not-demo" must equal its directory name "demo"/);
  });

  it('reports a missing site.json', async () => {
    const result = await checkPluginDir(makeFixturePlugin({ site: null }));
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(/needs a site\.json/);
  });

  it('names every locale missing a translated name or description', async () => {
    const result = await checkPluginDir(
      makeFixturePlugin({ manifest: { i18n: { zh: { name: '仅有名称' } } } }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('i18n: missing zh.description');
    expect(result.issues).toContain('i18n: missing ja.name');
    // Every locale but zh is missing both fields; zh is missing only one.
    expect(result.issues.filter((issue) => issue.startsWith('i18n:'))).toHaveLength(
      REQUIRED_PLUGIN_LOCALES.length * 2 - 1,
    );
  });

  it('requires a translated changelog only when the manifest declares one', async () => {
    const withChangelog = await checkPluginDir(
      makeFixturePlugin({ manifest: { changelog: 'First release.' } }),
    );
    expect(withChangelog.issues).toContain('i18n: missing zh.changelog');
    expect(withChangelog.issues).toHaveLength(REQUIRED_PLUGIN_LOCALES.length);

    const translated = await checkPluginDir(
      makeFixturePlugin({
        manifest: { changelog: 'First release.', i18n: fullI18n({ changelog: '首个版本。' }) },
      }),
    );
    expect(translated.issues).toEqual([]);
  });

  it('requires a localized label for every declared setting', async () => {
    const settings = {
      settings: {
        width: { type: 'number', label: 'Reading width (px)', default: 768 },
      },
      styles: [{ file: 'style.css' }],
    };

    const untranslated = await checkPluginDir(
      makeFixturePlugin({ manifest: { contributes: settings } }),
    );
    expect(untranslated.issues).toContain('i18n: missing ko.settings.width.label');
    expect(untranslated.issues).toHaveLength(REQUIRED_PLUGIN_LOCALES.length);

    const translated = await checkPluginDir(
      makeFixturePlugin({
        manifest: {
          contributes: settings,
          i18n: fullI18n({ settings: { width: { label: '阅读宽度' } } }),
        },
      }),
    );
    expect(translated.issues).toEqual([]);
  });

  it('refuses a directory outside the sites/<site>/plugins/<id> layout', async () => {
    const stray = join(makeTempDir(), 'widen');
    mkdirSync(stray, { recursive: true });

    const result = await checkPluginDir(stray);
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(/<catalog>\/sites\/<site>\/plugins\/<id>/);
  });

  it('reports a directory that does not exist', async () => {
    const result = await checkPluginDir(join(makeTempDir(), 'nope'));
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(['directory does not exist']);
  });

  it('prints one line for a pass and indented issues for a failure', async () => {
    const passing = await checkPluginDir(makeFixturePlugin());
    expect(formatResult(passing).split('\n')).toHaveLength(1);
    expect(formatResult(passing)).toMatch(/^ok {2}/);

    const failing = await checkPluginDir(makeFixturePlugin({ omitReadme: true }));
    const lines = formatResult(failing).split('\n');
    expect(lines[0]).toMatch(/^FAIL /);
    expect(lines.slice(1).every((line) => line.startsWith('    '))).toBe(true);
  });
});
