import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PLUGIN_ENGINE_VERSION } from '../constants';
import { pluginsToOriginPatterns } from '../runtime/siteRegistration';
import { engineSatisfied } from '../semver';
import { BundledCatalogPluginSource } from './BundledCatalogPluginSource';

describe('BundledCatalogPluginSource', () => {
  it('loads the bundled official declarative plugins with resolved CSS', async () => {
    const manifests = await new BundledCatalogPluginSource().list();

    expect(manifests.map((plugin) => plugin.id)).toEqual([
      'voyager.claude-cjk-render-fix',
      'voyager.claude-reading-width',
      'voyager.chatgpt-reading-width',
    ]);

    for (const manifest of manifests) {
      expect(engineSatisfied(manifest.engine, PLUGIN_ENGINE_VERSION)).toBe(true);
      for (const style of manifest.contributes.styles ?? []) {
        expect(style.source).toBe('style.css');
        expect(typeof style.css).toBe('string');
        expect('file' in (style as unknown as Record<string, unknown>)).toBe(false);
      }
    }
  });

  it('keeps the bundled CSS source files non-empty', () => {
    for (const file of [
      '../catalog/plugins/claude-cjk-render-fix/style.css',
      '../catalog/plugins/claude-reading-width/style.css',
      '../catalog/plugins/chatgpt-reading-width/style.css',
    ]) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8').length).toBeGreaterThan(0);
    }
  });

  it('keeps ChatGPT footer structural wrapper full-width', () => {
    const file = '../catalog/plugins/chatgpt-reading-width/style.css';
    const css = readFileSync(new URL(file, import.meta.url), 'utf8');

    expect(css).not.toContain(':not(#thread-bottom-container)');
    expect(css).toMatch(
      /\.gv-plugin-chatgpt-readable \[class\*='--thread-content-max-width'\]\s*\{[\s\S]*max-width:\s*var\(--gv-plugin-reading-width, 768px\)\s*!important;/,
    );
    expect(css).toMatch(
      /#thread-bottom-container\s*\{[\s\S]*width:\s*100%\s*!important;[\s\S]*max-width:\s*none\s*!important;/,
    );
    expect(css).toContain("[data-gv-center-conversation='true']");
    expect(css).toContain("section[data-testid^='conversation-turn-']");
    expect(css).toContain("[data-message-author-role='user']");
    expect(css).toContain('align-items: center !important');
    expect(css).not.toContain('48rem');

    const regularWidthRule = css.indexOf(
      ".gv-plugin-chatgpt-readable [class*='--thread-content-max-width'] {",
    );
    const footerOverride = css.indexOf('.gv-plugin-chatgpt-readable #thread-bottom-container {');
    const centeredTurnRule = css.indexOf(
      ".gv-plugin-chatgpt-readable[data-gv-center-conversation='true']",
    );
    expect(regularWidthRule).toBeGreaterThanOrEqual(0);
    expect(footerOverride).toBeGreaterThan(regularWidthRule);
    expect(centeredTurnRule).toBeGreaterThan(footerOverride);
  });

  it('widens Claude document artifacts inside their cross-origin frame', async () => {
    const manifests = await new BundledCatalogPluginSource().list();
    const claudeWidth = manifests.find((plugin) => plugin.id === 'voyager.claude-reading-width');
    const file = '../catalog/plugins/claude-reading-width/style.css';
    const css = readFileSync(new URL(file, import.meta.url), 'utf8');

    expect(claudeWidth?.matches).toEqual([
      'https://claude.ai/*',
      'https://*.frame.claudeusercontent.com/*',
    ]);
    expect(css).toMatch(
      /body\.gv-plugin-claude-readable > \.wrap\s*\{[\s\S]*box-sizing:\s*border-box\s*!important;[\s\S]*max-width:\s*var\(--gv-plugin-reading-width, 768px\)\s*!important;/,
    );
  });

  it('offers an opt-in centered conversation mode without narrowing the reading width', async () => {
    const manifests = await new BundledCatalogPluginSource().list();
    const chatgptWidth = manifests.find((plugin) => plugin.id === 'voyager.chatgpt-reading-width');

    expect(chatgptWidth?.contributes.settings?.centerConversation).toEqual({
      type: 'boolean',
      label: 'Center conversation content',
      default: false,
    });
    expect(chatgptWidth?.i18n?.zh?.settings?.centerConversation).toEqual({
      label: '对话内容居中',
    });
    expect(chatgptWidth?.contributes.domOps).toContainEqual({
      op: 'setAttribute',
      target: { kind: 'css', selector: 'body' },
      name: 'data-gv-center-conversation',
      value: '{{centerConversation}}',
    });
  });

  it('keeps localized setting labels inside the plugin data layer', async () => {
    const manifests = await new BundledCatalogPluginSource().list();
    const claudeWidth = manifests.find((plugin) => plugin.id === 'voyager.claude-reading-width');

    expect(claudeWidth?.contributes.settings?.width.label).toBe('Reading width (px)');
    expect(claudeWidth?.i18n?.zh?.settings?.width).toEqual({
      label: '阅读宽度（px）',
      minLabel: '更窄',
      maxLabel: '更宽',
    });
  });

  it('exposes the origins needed by the bundled official plugins', async () => {
    const manifests = await new BundledCatalogPluginSource().list();

    expect(pluginsToOriginPatterns(manifests)).toEqual([
      'https://*.frame.claudeusercontent.com/*',
      'https://chat.openai.com/*',
      'https://chatgpt.com/*',
      'https://claude.ai/*',
    ]);
  });
});
