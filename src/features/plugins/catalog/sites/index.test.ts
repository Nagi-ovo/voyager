import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { patternWithinAny } from '../../sites/matchPattern';
import { SEMANTIC_SELECTOR_KEYS } from '../../sites/semanticKeys';
import { BundledCatalogPluginSource } from '../../sources/BundledCatalogPluginSource';
import {
  BUNDLED_SITE_ADAPTERS,
  listBundledPluginEntries,
  listBundledSiteEntries,
  requireBundledSiteAdapter,
} from './index';

describe('bundled catalog discovery', () => {
  it('finds one site.json per plugin platform, with ids equal to their directories', () => {
    const entries = listBundledSiteEntries();
    expect(entries.map((entry) => entry.siteDir)).toEqual(['chatgpt', 'claude', 'deepseek']);
    expect(BUNDLED_SITE_ADAPTERS.map((adapter) => adapter.id)).toEqual([
      'chatgpt',
      'claude',
      'deepseek',
    ]);
    for (const adapter of BUNDLED_SITE_ADAPTERS) {
      expect(requireBundledSiteAdapter(adapter.id)).toBe(adapter);
      expect(adapter.capabilities).toBeInstanceOf(Set);
      expect(adapter.brandColor).toMatch(/^#[0-9a-f]{6}$/i);
      for (const key of Object.keys(adapter.selectors)) {
        expect(SEMANTIC_SELECTOR_KEYS).toContain(key);
      }
    }
    expect(() => requireBundledSiteAdapter('nope')).toThrow(/missing or invalid/);
  });

  it('finds every plugin under its site and pairs it with its CSS files', () => {
    const entries = listBundledPluginEntries();
    expect(entries.map((entry) => entry.path)).toEqual([
      'sites/chatgpt/plugins/reading-width/plugin.json',
      'sites/claude/plugins/cjk-render-fix/plugin.json',
      'sites/claude/plugins/reading-width/plugin.json',
      'sites/deepseek/plugins/code-table/plugin.json',
      'sites/deepseek/plugins/formula-copy/plugin.json',
      'sites/deepseek/plugins/reading-width/plugin.json',
      'sites/deepseek/plugins/timeline/plugin.json',
      'sites/deepseek/plugins/vim-input/plugin.json',
    ]);
    for (const entry of entries) {
      // A primitive-only plugin ships no CSS; every CSS file found is real content.
      for (const [file, css] of Object.entries(entry.styles)) {
        expect(file).toMatch(/\.css$/);
        expect(css.length).toBeGreaterThan(0);
      }
      const declares = JSON.parse(entry.manifestJson).contributes?.styles?.length > 0;
      expect(Object.keys(entry.styles).length > 0).toBe(declares);
    }
  });

  it('keeps every plugin inside the match scope of its site (plan D18)', async () => {
    const manifests = await new BundledCatalogPluginSource().list();
    const entries = listBundledPluginEntries();
    expect(manifests).toHaveLength(entries.length);
    for (const entry of entries) {
      const manifest = manifests.find((m) => JSON.parse(entry.manifestJson).id === m.id);
      const site = requireBundledSiteAdapter(entry.siteDir);
      expect(manifest, entry.path).toBeDefined();
      for (const pattern of manifest!.matches) {
        expect(patternWithinAny(pattern, site.matches), `${entry.path}: ${pattern}`).toBe(true);
      }
    }
  });

  it('keeps marketplace.json (the docs plugin-store index) in sync with discovery', () => {
    const index = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src/features/plugins/catalog/marketplace.json'), 'utf8'),
    ) as { plugins: { name: string; source: string }[] };
    const discovered = listBundledPluginEntries().map((entry) => entry.path);
    expect(index.plugins.map((plugin) => plugin.source).sort()).toEqual([...discovered].sort());
  });
});
