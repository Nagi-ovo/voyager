import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { validateHostCatalogFile } from '@/features/plugins/remote/hostCatalogFile';

import { DEFAULT_CATALOG_DIR, parseArgs, writeHostCatalogs } from '../build-plugin-catalog';

const GENERATED_AT = '2026-01-02T03:04:05.000Z';

/** host -> adapter id the published `site` section must carry. */
const EXPECTED_SITES: Readonly<Record<string, string>> = {
  'claude.ai': 'claude',
  'chatgpt.com': 'chatgpt',
  'chat.openai.com': 'chatgpt',
  'chat.deepseek.com': 'deepseek',
};

const tempRoots: string[] = [];

function makeTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-catalog-'));
  tempRoots.push(root);
  return root;
}

function build(outDir: string, catalogDir = DEFAULT_CATALOG_DIR) {
  return writeHostCatalogs({ catalogDir, outDir, generatedAt: GENERATED_AT });
}

function readHostFile(outDir: string, host: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(outDir, 'hosts', `${host}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

interface FixtureOverrides {
  readonly matches?: readonly string[];
  /** Merged into the plugin manifest, so one knob per rule under test. */
  readonly manifest?: Record<string, unknown>;
  /** Merged into the site adapter's semantic selectors. */
  readonly selectors?: Record<string, string>;
}

/**
 * A minimal catalog with one site and one plugin, so a rule can be exercised
 * without touching the shipped snapshot.
 */
function makeFixtureCatalog(overrides: FixtureOverrides = {}): string {
  const catalogDir = join(makeTempDir(), 'catalog');
  const siteDir = join(catalogDir, 'sites', 'demo');
  const pluginDir = join(siteDir, 'plugins', 'widen');

  writeJson(join(siteDir, 'site.json'), {
    id: 'demo',
    label: 'Demo',
    matches: ['https://demo.example/*'],
    selectors: { composer: 'textarea', ...overrides.selectors },
    theme: { hostSelector: 'html', lightSelector: 'html.light', darkSelector: 'html.dark' },
    capabilities: ['chat'],
    conversationIdPattern: '^/c/([^/?#]+)',
  });
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
    matches: overrides.matches ?? ['https://demo.example/*'],
    contributes: { styles: [{ file: 'style.css' }] },
    ...overrides.manifest,
  });
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'style.css'), 'body { color: red; }\n', 'utf8');

  return catalogDir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('build-plugin-catalog', () => {
  it('publishes one file per concrete host in the bundled catalog', async () => {
    const outDir = makeTempDir();
    await build(outDir);

    const names = readdirSync(join(outDir, 'hosts')).sort();
    expect(names).toEqual(
      ['chat.deepseek.com', 'chat.openai.com', 'chatgpt.com', 'claude.ai'].map(
        (host) => `${host}.json`,
      ),
    );
    // Wildcard patterns (https://*.frame.claudeusercontent.com/*) have no host
    // a client could derive from location.host, so they publish nothing.
    expect(names.some((name) => name.includes('*'))).toBe(false);
  });

  it('writes files the runtime validator accepts, with the site adapter attached', async () => {
    const outDir = makeTempDir();
    await build(outDir);

    for (const [host, siteId] of Object.entries(EXPECTED_SITES)) {
      const file = readHostFile(outDir, host);
      expect(file.format).toBe(1);
      expect(file.host).toBe(host);
      expect(file.generatedAt).toBe(GENERATED_AT);

      const site = file.site as Record<string, unknown>;
      expect(site.id).toBe(siteId);
      expect(Array.isArray(site.capabilities)).toBe(true);
      expect((site.capabilities as unknown[]).length).toBeGreaterThan(0);
      // site.json owns the conversation-id regex; clients need it to tell one
      // conversation from another without a per-site branch.
      expect(typeof site.conversationIdPattern).toBe('string');
      expect(String(site.conversationIdPattern).length).toBeGreaterThan(0);

      const validation = validateHostCatalogFile(file, host);
      expect(validation, `${host} was rejected outright`).not.toBeNull();
      expect(validation?.issues).toEqual([]);
      expect(validation?.manifests.length).toBe((file.plugins as unknown[]).length);
      expect(validation?.site?.id).toBe(siteId);
    }
  });

  it('inlines every style file as css', async () => {
    const outDir = makeTempDir();
    await build(outDir);

    for (const host of Object.keys(EXPECTED_SITES)) {
      const plugins = readHostFile(outDir, host).plugins as readonly Record<string, unknown>[];
      expect(plugins.length).toBeGreaterThan(0);
      let styleCount = 0;
      for (const plugin of plugins) {
        const contributes = plugin.contributes as { styles?: Record<string, unknown>[] };
        // A primitive-backed plugin may contribute no CSS at all.
        for (const style of contributes.styles ?? []) {
          styleCount += 1;
          expect(typeof style.css).toBe('string');
          expect(String(style.css).length).toBeGreaterThan(0);
          expect(style).not.toHaveProperty('file');
        }
      }
      expect(styleCount, `${host} published no inlined style at all`).toBeGreaterThan(0);
    }
  });

  it('is byte-identical across runs with the same generatedAt', async () => {
    const outDir = makeTempDir();
    await build(outDir);
    const first = readdirSync(join(outDir, 'hosts')).map((name) => [
      name,
      readFileSync(join(outDir, 'hosts', name), 'utf8'),
    ]);

    await build(outDir);
    const second = readdirSync(join(outDir, 'hosts')).map((name) => [
      name,
      readFileSync(join(outDir, 'hosts', name), 'utf8'),
    ]);

    expect(second).toEqual(first);
  });

  it('removes host files it no longer produces', async () => {
    const outDir = makeTempDir();
    const hostsDir = join(outDir, 'hosts');
    mkdirSync(hostsDir, { recursive: true });
    const stale = join(hostsDir, 'old.example.json');
    writeFileSync(stale, '{"format":1,"host":"old.example","plugins":[]}\n');

    await build(outDir);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(hostsDir, 'claude.ai.json'))).toBe(true);
  });

  it('publishes a fixture plugin that stays inside its site', async () => {
    const outDir = makeTempDir();
    const catalogDir = makeFixtureCatalog();

    const written = await build(outDir, catalogDir);

    expect(written.map((entry) => entry.host)).toEqual(['demo.example']);
    const file = readHostFile(outDir, 'demo.example');
    expect((file.site as Record<string, unknown>).id).toBe('demo');
    expect(validateHostCatalogFile(file, 'demo.example')?.issues).toEqual([]);
  });

  it('fails the build when a plugin targets a host its site does not cover', async () => {
    const outDir = makeTempDir();
    const catalogDir = makeFixtureCatalog({
      matches: ['https://demo.example/*', 'https://elsewhere.example/*'],
    });

    await expect(build(outDir, catalogDir)).rejects.toThrow(
      /demo\.widen.*https:\/\/elsewhere\.example\/\*.*not covered by site "demo"/s,
    );
    expect(existsSync(join(outDir, 'hosts', 'demo.example.json'))).toBe(false);
  });

  it('publishes the DeepSeek formula-copy plugin with its requires and native op', async () => {
    const outDir = makeTempDir();
    await build(outDir);

    const plugins = readHostFile(outDir, 'chat.deepseek.com').plugins as readonly Record<
      string,
      unknown
    >[];
    // The exact count is the catalog's business, not this test's: it grows
    // whenever a plugin is added under sites/deepseek/.
    expect(plugins.length).toBeGreaterThanOrEqual(2);

    const formulaCopy = plugins.find((plugin) => plugin.id === 'voyager.deepseek-formula-copy');
    if (!formulaCopy) throw new Error('the formula-copy plugin was not published');
    expect(formulaCopy.requires).toEqual({ handlers: ['formulaCopy'] });
    expect(typeof formulaCopy.changelog).toBe('string');
    const contributes = formulaCopy.contributes as { domOps?: readonly Record<string, unknown>[] };
    expect(contributes.domOps).toEqual([{ op: 'native', handler: 'formulaCopy', params: {} }]);
    // The engine floor is what makes an old build say "update Voyager" instead
    // of reporting a missing handler (plan §5).
    expect(formulaCopy.engine).toBe('>=1.3.0');
  });

  it('fails the build when a plugin names a primitive this build does not ship', async () => {
    const outDir = makeTempDir();
    const catalogDir = makeFixtureCatalog({
      manifest: {
        engine: '>=1.3.0',
        requires: { handlers: ['teleport'] },
        contributes: { styles: [{ file: 'style.css' }] },
      },
    });

    await expect(build(outDir, catalogDir)).rejects.toThrow(
      /demo\.widen.*unknown primitive handler "teleport"/s,
    );
    expect(existsSync(join(outDir, 'hosts', 'demo.example.json'))).toBe(false);
  });

  it('fails the build when the engine range admits a build older than a primitive', async () => {
    const outDir = makeTempDir();
    const catalogDir = makeFixtureCatalog({
      manifest: {
        engine: '>=1.2.0',
        contributes: {
          styles: [{ file: 'style.css' }],
          domOps: [{ op: 'native', handler: 'formulaCopy', params: {} }],
        },
      },
    });

    await expect(build(outDir, catalogDir)).rejects.toThrow(
      /demo\.widen.*engine ">=1\.2\.0" admits builds older than 1\.3\.0.*"formulaCopy"/s,
    );
    expect(existsSync(join(outDir, 'hosts', 'demo.example.json'))).toBe(false);
  });

  it('fails the build when an open engine range is paired with a primitive', async () => {
    const outDir = makeTempDir();
    const catalogDir = makeFixtureCatalog({
      manifest: {
        engine: '*',
        contributes: {
          styles: [{ file: 'style.css' }],
          domOps: [{ op: 'native', handler: 'formulaCopy', params: {} }],
        },
      },
    });

    await expect(build(outDir, catalogDir)).rejects.toThrow(
      /demo\.widen.*engine "\*" admits any build.*at least 1\.3\.0/s,
    );
  });

  it('accepts a primitive whose sinceEngine the engine range clears', async () => {
    const outDir = makeTempDir();
    const catalogDir = makeFixtureCatalog({
      manifest: {
        engine: '>=1.3.0',
        requires: { handlers: ['formulaCopy'] },
        contributes: {
          styles: [{ file: 'style.css' }],
          domOps: [{ op: 'native', handler: 'formulaCopy', params: {} }],
        },
      },
    });

    await build(outDir, catalogDir);

    const plugins = readHostFile(outDir, 'demo.example').plugins as readonly Record<
      string,
      unknown
    >[];
    expect(plugins.map((plugin) => plugin.id)).toEqual(['demo.widen']);
  });

  it('fails the build when a plugin needs a semantic key its site does not define', async () => {
    const outDir = makeTempDir();
    const catalogDir = makeFixtureCatalog({
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
    });

    await expect(build(outDir, catalogDir)).rejects.toThrow(
      /demo\.widen.*"scrollContainer".*not defined by site "demo"/s,
    );
    expect(existsSync(join(outDir, 'hosts', 'demo.example.json'))).toBe(false);
  });

  it('accepts a semantic target once its site declares the key', async () => {
    const outDir = makeTempDir();
    const catalogDir = makeFixtureCatalog({
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
    });

    await build(outDir, catalogDir);

    expect(existsSync(join(outDir, 'hosts', 'demo.example.json'))).toBe(true);
  });

  it('parses --out and --now, and rejects unknown flags', () => {
    const defaults = { outDir: '/default/out', now: '2020-01-01T00:00:00.000Z' };

    expect(parseArgs([], defaults)).toEqual(defaults);
    expect(parseArgs(['--out', 'build/catalog', '--now', GENERATED_AT], defaults)).toEqual({
      outDir: resolve('build/catalog'),
      now: GENERATED_AT,
    });
    expect(parseArgs([`--out=build/catalog`, `--now=${GENERATED_AT}`], defaults)).toEqual({
      outDir: resolve('build/catalog'),
      now: GENERATED_AT,
    });
    expect(() => parseArgs(['--nope'], defaults)).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--out'], defaults)).toThrow(/Missing value/);
  });
});
