import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { activateFormulaCopy } from '@/features/formulaCopy';

import type { PluginManifest, PluginSource, SiteAdapter } from '../types';
import { PluginHost } from './PluginHost';
import type { PluginScope } from './pluginScope';

vi.mock('@/features/formulaCopy', () => ({
  activateFormulaCopy: vi.fn((scope: PluginScope) => {
    scope.effect(() => () => {}, 'formula-copy');
  }),
}));

const URL = 'https://chat.deepseek.com/a/chat/s/1';
const CATALOG_KEY = 'gvPluginHostCatalog:chat.deepseek.com';

const deepseek: SiteAdapter = {
  id: 'deepseek',
  label: 'DeepSeek',
  matches: ['https://chat.deepseek.com/*'],
  selectors: { userTurn: '.user-turn' },
  theme: { hostSelector: 'body', lightSelector: 'body.light', darkSelector: 'body.dark' },
  capabilities: new Set(['chat']),
};

function manifest(id: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: 'd',
    author: 'a',
    category: 'other',
    license: 'MIT',
    engine: '>=1.0.0',
    tier: 'declarative',
    matches: ['https://chat.deepseek.com/*'],
    contributes: {},
    ...overrides,
  };
}

function remoteSource(listed: { current: readonly PluginManifest[] }): PluginSource {
  return {
    id: 'host-catalog',
    kind: 'remote',
    async list() {
      return listed.current;
    },
    async isAuthoritative() {
      return true;
    },
    async siteOverride() {
      return deepseek;
    },
  };
}

function mockState(state: Record<string, { enabled: boolean; installedAt: number }>): void {
  (chrome.storage.local.get as unknown as Mock).mockResolvedValue({ gvPluginsState: state });
}

function fireCatalogChange(): void {
  const listeners = (chrome.storage.onChanged.addListener as unknown as Mock).mock.calls;
  for (const [listener] of listeners) {
    listener(
      {
        [CATALOG_KEY]: {
          oldValue: { status: 'ok', extensionVersion: 'x', manifests: [] },
          newValue: { status: 'ok', extensionVersion: 'x', manifests: [{ id: 'changed' }] },
        },
      },
      'local',
    );
  }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  (chrome.storage.local.get as unknown as Mock).mockReset?.();
  (chrome.storage.onChanged.addListener as unknown as Mock).mockClear?.();
  vi.mocked(activateFormulaCopy).mockClear();
});

describe('PluginHost status machine (plan §4.2)', () => {
  it('reports every reason instead of hiding incompatible plugins', async () => {
    mockState({
      'x.engine': { enabled: true, installedAt: 1 },
      'x.handler': { enabled: true, installedAt: 1 },
      'x.semantic': { enabled: true, installedAt: 1 },
      'x.mounted': { enabled: true, installedAt: 1 },
    });
    const listed = {
      current: [
        manifest('x.engine', { engine: '>=9.0.0' }),
        manifest('x.handler', {
          contributes: { domOps: [{ op: 'native', handler: 'turnNavigator', params: {} }] },
        }),
        manifest('x.semantic', {
          contributes: {
            domOps: [
              { op: 'addClass', target: { kind: 'semantic', key: 'sidePanel' }, className: 'c' },
            ],
          },
        }),
        manifest('x.ready'),
        manifest('x.mounted', {
          contributes: { domOps: [{ op: 'native', handler: 'formulaCopy', params: {} }] },
        }),
        manifest('x.elsewhere', { matches: ['https://claude.ai/*'] }),
      ],
    };
    const host = new PluginHost({
      url: URL,
      sources: [remoteSource(listed)],
      doc: document,
      requestCatalogRefresh: () => {},
      isTopFrame: true,
    });
    await host.start();

    const byId = Object.fromEntries(host.getStatuses().map((status) => [status.id, status]));
    expect(byId['x.engine']).toMatchObject({ kind: 'needs-engine', requiredEngine: '>=9.0.0' });
    expect(byId['x.handler']).toMatchObject({
      kind: 'needs-handler',
      missingHandlers: ['turnNavigator'],
    });
    expect(byId['x.semantic']).toMatchObject({
      kind: 'needs-semantic',
      missingSemantic: ['sidePanel'],
    });
    expect(byId['x.ready']).toMatchObject({ kind: 'ready' });
    expect(byId['x.mounted']).toMatchObject({ kind: 'mounted' });
    expect(byId['x.elsewhere']).toBeUndefined();
    // Incompatible plugins were never mounted even though they are enabled.
    expect(activateFormulaCopy).toHaveBeenCalledTimes(1);
    host.stop();
  });

  it('keeps a primitive-backed plugin on its mounted version until reload and reports the pending one', async () => {
    mockState({ 'x.formula': { enabled: true, installedAt: 1 } });
    const v1 = manifest('x.formula', {
      version: '1.0.0',
      contributes: { domOps: [{ op: 'native', handler: 'formulaCopy', params: {} }] },
    });
    const listed = { current: [v1] };
    const host = new PluginHost({
      url: URL,
      sources: [remoteSource(listed)],
      doc: document,
      requestCatalogRefresh: () => {},
      isTopFrame: true,
    });
    await host.start();
    expect(activateFormulaCopy).toHaveBeenCalledTimes(1);

    listed.current = [{ ...v1, version: '1.1.0', changelog: 'faster' }];
    fireCatalogChange();
    await flush();

    // Not re-activated: the page keeps 1.0.0 running (plan D7).
    expect(activateFormulaCopy).toHaveBeenCalledTimes(1);
    expect(host.getStatuses()).toEqual([
      expect.objectContaining({
        id: 'x.formula',
        version: '1.0.0',
        kind: 'mounted',
        pendingVersion: '1.1.0',
      }),
    ]);
    host.stop();
  });

  it('remounts a declarative plugin immediately on a catalog change', async () => {
    mockState({ 'x.css': { enabled: true, installedAt: 1 } });
    const v1 = manifest('x.css', {
      version: '1.0.0',
      contributes: {
        domOps: [{ op: 'addClass', target: { kind: 'css', selector: 'body' }, className: 'v1' }],
      },
    });
    const listed = { current: [v1] };
    const host = new PluginHost({
      url: URL,
      sources: [remoteSource(listed)],
      doc: document,
      requestCatalogRefresh: () => {},
      isTopFrame: true,
    });
    await host.start();
    expect(document.body.classList.contains('v1')).toBe(true);

    listed.current = [
      {
        ...v1,
        version: '1.1.0',
        contributes: {
          domOps: [{ op: 'addClass', target: { kind: 'css', selector: 'body' }, className: 'v2' }],
        },
      },
    ];
    fireCatalogChange();
    await flush();
    expect(document.body.classList.contains('v1')).toBe(false);
    expect(document.body.classList.contains('v2')).toBe(true);
    expect(host.getStatuses()[0]).toMatchObject({ version: '1.1.0', kind: 'mounted' });
    expect(host.getStatuses()[0].pendingVersion).toBeUndefined();
    host.stop();
  });

  it('unmounts plugins the refreshed catalog no longer lists, frozen primitives included', async () => {
    mockState({
      'x.css': { enabled: true, installedAt: 1 },
      'x.formula': { enabled: true, installedAt: 1 },
    });
    const css = manifest('x.css', {
      contributes: {
        domOps: [{ op: 'addClass', target: { kind: 'css', selector: 'body' }, className: 'v1' }],
      },
    });
    const formula = manifest('x.formula', {
      contributes: { domOps: [{ op: 'native', handler: 'formulaCopy', params: {} }] },
    });
    const listed = { current: [css, formula] };
    const host = new PluginHost({
      url: URL,
      sources: [remoteSource(listed)],
      doc: document,
      requestCatalogRefresh: () => {},
      isTopFrame: true,
    });
    await host.start();
    expect(document.body.classList.contains('v1')).toBe(true);
    const scope = vi.mocked(activateFormulaCopy).mock.calls[0][0];

    // A primitive update first freezes the plugin on its mounted version...
    listed.current = [css, { ...formula, version: '1.1.0' }];
    fireCatalogChange();
    await flush();
    expect(host.getStatuses().find((s) => s.id === 'x.formula')?.pendingVersion).toBe('1.1.0');

    // ...and delisting both (the kill switch) unmounts them right away.
    listed.current = [];
    fireCatalogChange();
    await flush();
    expect(document.body.classList.contains('v1')).toBe(false);
    expect(scope.isDisposed).toBe(true);
    expect(host.getStatuses()).toEqual([]);
    host.stop();
  });
});
