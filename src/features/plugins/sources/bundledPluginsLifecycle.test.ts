import { afterEach, describe, expect, it } from 'vitest';

import { DeclarativeEngine } from '../runtime/declarativeEngine';
import { matchesAnyPattern } from '../sites/matchPattern';
import { DEFAULT_ADAPTERS } from '../sites/registry';
import type { PluginManifest, PluginSettingValue, SiteAdapter } from '../types';
import { BundledCatalogPluginSource } from './BundledCatalogPluginSource';

/**
 * Plan §8 / P2 acceptance: every bundled declarative plugin must mount, accept
 * a settings change and unmount without leaving a trace on the host document.
 * The checks are generic on purpose so a new plugin is covered the moment its
 * files land under `catalog/sites/<site>/plugins/<id>/`.
 */

function probeUrl(pattern: string): string {
  return pattern.replace(/^(\w+):\/\/\*\./, '$1://x.').replace(/\*$/, '');
}

function adapterFor(manifest: PluginManifest): SiteAdapter {
  const adapter = DEFAULT_ADAPTERS.find((candidate) =>
    manifest.matches.some((pattern) => matchesAnyPattern(probeUrl(pattern), candidate.matches)),
  );
  if (!adapter) throw new Error(`${manifest.id}: no bundled site adapter covers its matches`);
  return adapter;
}

function defaultSettings(manifest: PluginManifest): Record<string, PluginSettingValue> {
  return Object.fromEntries(
    Object.entries(manifest.contributes.settings ?? {}).map(([key, field]) => [key, field.default]),
  );
}

/** A value different from the default for every declared setting. */
function changedSettings(manifest: PluginManifest): Record<string, PluginSettingValue> {
  return Object.fromEntries(
    Object.entries(manifest.contributes.settings ?? {}).map(([key, field]) => {
      if (field.type === 'boolean') return [key, field.default !== true];
      if (field.type === 'number') {
        const current = Number(field.default);
        const next =
          current === field.min ? (field.max ?? current + 1) : (field.min ?? current - 1);
        return [key, next];
      }
      return [key, `${String(field.default)}-changed`];
    }),
  );
}

/** Head markup minus the engine's one-time base stylesheet, which persists by design. */
function headWithoutBaseStyle(): string {
  const clone = document.head.cloneNode(true) as HTMLElement;
  clone.querySelector('#gv-plugin-base-style')?.remove();
  return clone.innerHTML;
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
  document.body.removeAttribute('class');
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('class');
});

describe('bundled plugin lifecycle (parametric)', async () => {
  const manifests = await new BundledCatalogPluginSource().list();
  expect(manifests.length).toBeGreaterThan(0);

  for (const manifest of manifests) {
    it(`${manifest.id}: mount → updateSettings → unmount restores the host`, () => {
      document.body.className = 'host-class';
      document.body.setAttribute('style', '--host-var: 1px;');
      // Semantic answer operations need real target markup, not an empty body.
      document.body.innerHTML =
        '<div class="ds-message"><div class="ds-assistant-message-main-content"><pre><code>sample</code></pre></div></div>';
      const before = {
        head: headWithoutBaseStyle(),
        body: document.body.outerHTML,
        root: document.documentElement.getAttribute('class'),
      };
      const engine = new DeclarativeEngine({ doc: document, adapter: adapterFor(manifest) });

      engine.mount(manifest, defaultSettings(manifest));
      expect(engine.isActive(manifest.id)).toBe(true);
      const styles = manifest.contributes.styles ?? [];
      const styleEl = document.getElementById(`gv-plugin-style-${manifest.id}`);
      if (styles.length > 0) {
        expect(styleEl).not.toBeNull();
        expect(styleEl?.textContent?.length ?? 0).toBeGreaterThan(0);
      }
      // Only ops that address page elements change the host markup; a
      // primitive-only plugin (`native` op) runs code instead.
      if (manifest.contributes.domOps?.some((op) => op.op !== 'native')) {
        expect(document.body.outerHTML).not.toBe(before.body);
      }

      engine.updateSettings(manifest.id, changedSettings(manifest));
      expect(engine.isActive(manifest.id)).toBe(true);

      engine.unmount(manifest.id);
      expect(engine.isActive(manifest.id)).toBe(false);
      expect(headWithoutBaseStyle()).toBe(before.head);
      expect(document.body.outerHTML).toBe(before.body);
      expect(document.documentElement.getAttribute('class')).toBe(before.root);
    });

    it(`${manifest.id}: every semantic target resolves on its site adapter`, () => {
      const adapter = adapterFor(manifest);
      for (const op of manifest.contributes.domOps ?? []) {
        if (op.op === 'native') continue;
        if (op.target.kind === 'semantic') {
          expect(adapter.selectors[op.target.key], `${manifest.id}: ${op.target.key}`).toBeTruthy();
        }
      }
    });
  }
});
