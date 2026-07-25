import { type Mock, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PluginManifest, PluginSource } from '../types';
import { PluginHost } from './PluginHost';

function manifest(matches: string[], id = 'voyager.test'): PluginManifest {
  return {
    id,
    name: 'Test',
    version: '1.0.0',
    description: 'd',
    author: 'a',
    category: 'other',
    license: 'MIT',
    engine: '>=1.0.0',
    tier: 'declarative',
    matches,
    contributes: {
      domOps: [
        {
          op: 'addClass',
          target: { kind: 'css', selector: 'body' },
          className: 'gv-plugin-active',
        },
      ],
    },
  };
}

class StaticSource implements PluginSource {
  readonly id = 'static';
  constructor(private readonly plugins: readonly PluginManifest[]) {}
  async list(): Promise<readonly PluginManifest[]> {
    return this.plugins;
  }
}

function mockState(state: Record<string, { enabled: boolean; installedAt: number }>): void {
  (chrome.storage.local.get as unknown as Mock).mockResolvedValue({ gvPluginsState: state });
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.classList.remove('gv-plugin-active');
});

afterEach(() => {
  (chrome.storage.local.get as unknown as Mock).mockReset?.();
});

describe('PluginHost', () => {
  it('mounts an enabled plugin that matches the current URL', async () => {
    mockState({ 'voyager.test': { enabled: true, installedAt: 1 } });
    const host = new PluginHost({
      url: 'https://claude.ai/chat/1',
      sources: [new StaticSource([manifest(['https://claude.ai/*'])])],
      doc: document,
    });

    await host.start();
    expect(document.body.classList.contains('gv-plugin-active')).toBe(true);
  });

  it('does not mount a disabled plugin', async () => {
    mockState({ 'voyager.test': { enabled: false, installedAt: 1 } });
    const host = new PluginHost({
      url: 'https://claude.ai/chat/1',
      sources: [new StaticSource([manifest(['https://claude.ai/*'])])],
      doc: document,
    });

    await host.start();
    expect(document.body.classList.contains('gv-plugin-active')).toBe(false);
  });

  it('does not mount a plugin that does not match the URL', async () => {
    mockState({ 'voyager.test': { enabled: true, installedAt: 1 } });
    const host = new PluginHost({
      url: 'https://gemini.google.com/app',
      sources: [new StaticSource([manifest(['https://claude.ai/*'])])],
      doc: document,
    });

    await host.start();
    expect(document.body.classList.contains('gv-plugin-active')).toBe(false);
  });

  it('resolves the adapter for the current site', async () => {
    mockState({});
    const host = new PluginHost({
      url: 'https://chatgpt.com/x',
      sources: [new StaticSource([])],
      doc: document,
    });
    await host.start();
    expect(host.activeAdapter?.id).toBe('chatgpt');
  });

  it('stop() unmounts active plugins', async () => {
    mockState({ 'voyager.test': { enabled: true, installedAt: 1 } });
    const host = new PluginHost({
      url: 'https://claude.ai/chat/1',
      sources: [new StaticSource([manifest(['https://claude.ai/*'])])],
      doc: document,
    });

    await host.start();
    expect(document.body.classList.contains('gv-plugin-active')).toBe(true);

    host.stop();
    expect(document.body.classList.contains('gv-plugin-active')).toBe(false);
  });
});
