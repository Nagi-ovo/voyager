import { afterEach, describe, expect, it } from 'vitest';

import { DeclarativeEngine } from '../runtime/declarativeEngine';
import { deepseekAdapter } from '../sites/adapters/deepseek';
import { BundledCatalogPluginSource } from './BundledCatalogPluginSource';

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
  document.body.removeAttribute('class');
});

describe('DeepSeek reading width lifecycle', () => {
  it('updates settings and restores host state through repeated mount cycles', async () => {
    const manifest = (await new BundledCatalogPluginSource().list()).find(
      (entry) => entry.id === 'voyager.deepseek-reading-width',
    );
    if (!manifest) throw new Error('Missing bundled DeepSeek plugin');
    document.body.className = 'zh_CN light';
    document.body.style.setProperty('--message-list-max-width', '840px');
    document.body.style.setProperty('--gv-plugin-reading-width', '900px');
    const engine = new DeclarativeEngine({ doc: document, adapter: deepseekAdapter });
    try {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        engine.mount(manifest, { width: 1100 });
        expect(document.body.classList.contains('gv-plugin-deepseek-readable')).toBe(true);
        expect(document.body.style.getPropertyValue('--gv-plugin-reading-width')).toBe('1100px');
        engine.updateSettings(manifest.id, { width: 600 });
        expect(document.body.style.getPropertyValue('--gv-plugin-reading-width')).toBe('600px');
        expect(document.body.style.getPropertyValue('--message-list-max-width')).toBe('840px');
        engine.unmount(manifest.id);
        expect(document.body.className).toBe('zh_CN light');
        expect(document.body.style.getPropertyValue('--gv-plugin-reading-width')).toBe('900px');
        expect(document.getElementById('gv-plugin-style-' + manifest.id)).toBeNull();
      }
    } finally {
      engine.unmount(manifest.id);
    }
  });
});
