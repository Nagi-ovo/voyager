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

function makeTempOutDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-catalog-'));
  tempRoots.push(root);
  return root;
}

function build(outDir: string) {
  return writeHostCatalogs({
    catalogDir: DEFAULT_CATALOG_DIR,
    outDir,
    generatedAt: GENERATED_AT,
  });
}

function readHostFile(outDir: string, host: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(outDir, 'hosts', `${host}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('build-plugin-catalog', () => {
  it('publishes one file per concrete host in the bundled catalog', async () => {
    const outDir = makeTempOutDir();
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
    const outDir = makeTempOutDir();
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

      const validation = validateHostCatalogFile(file, host);
      expect(validation, `${host} was rejected outright`).not.toBeNull();
      expect(validation?.issues).toEqual([]);
      expect(validation?.manifests.length).toBe((file.plugins as unknown[]).length);
    }
  });

  it('inlines every style file as css', async () => {
    const outDir = makeTempOutDir();
    await build(outDir);

    for (const host of Object.keys(EXPECTED_SITES)) {
      const plugins = readHostFile(outDir, host).plugins as readonly Record<string, unknown>[];
      expect(plugins.length).toBeGreaterThan(0);
      for (const plugin of plugins) {
        const contributes = plugin.contributes as { styles?: Record<string, unknown>[] };
        const styles = contributes.styles ?? [];
        expect(styles.length).toBeGreaterThan(0);
        for (const style of styles) {
          expect(typeof style.css).toBe('string');
          expect(String(style.css).length).toBeGreaterThan(0);
          expect(style).not.toHaveProperty('file');
        }
      }
    }
  });

  it('is byte-identical across runs with the same generatedAt', async () => {
    const outDir = makeTempOutDir();
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
    const outDir = makeTempOutDir();
    const hostsDir = join(outDir, 'hosts');
    mkdirSync(hostsDir, { recursive: true });
    const stale = join(hostsDir, 'old.example.json');
    writeFileSync(stale, '{"format":1,"host":"old.example","plugins":[]}\n');

    await build(outDir);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(hostsDir, 'claude.ai.json'))).toBe(true);
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
