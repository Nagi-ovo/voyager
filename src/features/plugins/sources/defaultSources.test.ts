import { describe, expect, it } from 'vitest';

import type { PluginManifest, PluginSource, PluginSourceContext, PluginSourceKind } from '../types';
import {
  createDefaultPluginSources,
  listPluginManifests,
  listPluginManifestsWithSources,
  mergePluginRecords,
} from './defaultSources';

function manifest(id: string, name = id, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id,
    name,
    version: '1.0.0',
    description: 'test',
    author: 'test',
    category: 'other',
    license: 'MIT',
    engine: '>=1.0.0',
    tier: 'declarative',
    matches: ['https://example.com/*'],
    contributes: {},
    ...overrides,
  };
}

class StaticSource implements PluginSource {
  constructor(
    readonly id: string,
    private readonly manifests: readonly PluginManifest[],
    readonly kind?: PluginSourceKind,
    private readonly authoritative = false,
  ) {}

  async list(): Promise<readonly PluginManifest[]> {
    return this.manifests;
  }

  async isAuthoritative(): Promise<boolean> {
    return this.authoritative;
  }
}

const record = (m: PluginManifest, sourceId: string) => ({ manifest: m, sourceId });
const ENGINE = '1.2.0';
const SCOPE: PluginSourceContext = { url: 'https://example.com/chat', host: 'example.com' };

describe('default plugin sources', () => {
  it('serves native, then the bundled snapshot, then the per-host remote catalog', () => {
    expect(createDefaultPluginSources().map((source) => `${source.id}:${source.kind}`)).toEqual([
      'builtin:builtin',
      'bundled-catalog:bundled',
      'host-catalog:remote',
    ]);
  });

  it('dedupes untyped sources with the first source winning (legacy behaviour)', async () => {
    const result = await listPluginManifests([
      new StaticSource('builtin', [manifest('voyager.native')]),
      new StaticSource('bundled-catalog', [manifest('voyager.same', 'official')]),
      new StaticSource('marketplace', [
        manifest('voyager.same', 'remote'),
        manifest('voyager.remote'),
      ]),
    ]);

    expect(result.map((plugin) => `${plugin.id}:${plugin.name}`)).toEqual([
      'voyager.native:voyager.native',
      'voyager.same:official',
      'voyager.remote:voyager.remote',
    ]);
  });

  it('retains only the safe source id for diagnostics', async () => {
    const result = await listPluginManifestsWithSources([
      new StaticSource('builtin', [manifest('voyager.same', 'native')], 'builtin'),
      new StaticSource(
        'host-catalog',
        [manifest('voyager.same', 'remote duplicate'), manifest('voyager.remote')],
        'remote',
        true,
      ),
    ]);

    expect(result.map(({ manifest: plugin, sourceId }) => `${plugin.id}:${sourceId}`)).toEqual([
      'voyager.same:builtin',
      'voyager.remote:host-catalog',
    ]);
  });

  it('passes the listing context to every source and derives the kill-switch scope from it', async () => {
    const seen: (PluginSourceContext | undefined)[] = [];
    const spy: PluginSource = {
      id: 'spy',
      kind: 'remote',
      async list(context) {
        seen.push(context);
        return [];
      },
      async isAuthoritative() {
        return true;
      },
    };
    const result = await listPluginManifestsWithSources(
      [new StaticSource('bundled-catalog', [manifest('voyager.a')], 'bundled'), spy],
      { host: 'example.com' },
    );
    expect(seen).toEqual([{ host: 'example.com' }]);
    // Remote authoritative for example.com and silent about voyager.a → dropped.
    expect(result).toEqual([]);
  });
});

describe('mergePluginRecords (plan D6 / D20)', () => {
  it('lets a compatible remote entry replace the bundled snapshot', () => {
    const merged = mergePluginRecords({
      builtin: [],
      snapshot: [record(manifest('voyager.a', 'snapshot'), 'bundled-catalog')],
      remote: [record(manifest('voyager.a', 'remote', { version: '1.1.0' }), 'host-catalog')],
      remoteAuthoritative: true,
      scopeUrl: SCOPE.url,
      engineVersion: ENGINE,
    });
    expect(merged).toEqual([
      record(manifest('voyager.a', 'remote', { version: '1.1.0' }), 'host-catalog'),
    ]);
  });

  it('keeps the compatible snapshot and flags the blocked update when the remote needs a newer engine', () => {
    const merged = mergePluginRecords({
      builtin: [],
      snapshot: [record(manifest('voyager.a', 'snapshot'), 'bundled-catalog')],
      remote: [
        record(
          manifest('voyager.a', 'remote', { version: '2.0.0', engine: '>=1.5.0' }),
          'host-catalog',
        ),
      ],
      remoteAuthoritative: true,
      scopeUrl: SCOPE.url,
      engineVersion: ENGINE,
    });
    expect(merged).toEqual([
      {
        ...record(manifest('voyager.a', 'snapshot'), 'bundled-catalog'),
        blockedUpdate: { version: '2.0.0', engine: '>=1.5.0' },
      },
    ]);
  });

  it('surfaces the remote entry when both versions are incompatible so the reason can be shown', () => {
    const merged = mergePluginRecords({
      builtin: [],
      snapshot: [
        record(manifest('voyager.a', 'snapshot', { engine: '>=1.4.0' }), 'bundled-catalog'),
      ],
      remote: [record(manifest('voyager.a', 'remote', { engine: '>=1.5.0' }), 'host-catalog')],
      remoteAuthoritative: true,
      scopeUrl: SCOPE.url,
      engineVersion: ENGINE,
    });
    expect(merged.map((r) => `${r.manifest.name}:${r.sourceId}`)).toEqual(['remote:host-catalog']);
  });

  it('drops a snapshot plugin for this page that an authoritative remote no longer lists (kill switch)', () => {
    const merged = mergePluginRecords({
      builtin: [],
      snapshot: [
        record(manifest('voyager.retired'), 'bundled-catalog'),
        record(
          manifest('voyager.other-site', 'other', { matches: ['https://claude.ai/*'] }),
          'bundled-catalog',
        ),
      ],
      remote: [record(manifest('voyager.new'), 'host-catalog')],
      remoteAuthoritative: true,
      scopeUrl: SCOPE.url,
      engineVersion: ENGINE,
    });
    expect(merged.map((r) => r.manifest.id)).toEqual(['voyager.other-site', 'voyager.new']);
  });

  it('keeps the snapshot untouched when the remote is not authoritative (offline, 404, other version)', () => {
    const merged = mergePluginRecords({
      builtin: [],
      snapshot: [record(manifest('voyager.a'), 'bundled-catalog')],
      remote: [],
      remoteAuthoritative: false,
      scopeUrl: SCOPE.url,
      engineVersion: ENGINE,
    });
    expect(merged).toEqual([record(manifest('voyager.a'), 'bundled-catalog')]);
  });

  it('never lets a remote entry override a builtin id, and drops that remote entry', () => {
    const merged = mergePluginRecords({
      builtin: [record(manifest('voyager.formula-copy', 'native'), 'builtin')],
      snapshot: [],
      remote: [
        record(
          manifest('voyager.formula-copy', 'hijack', { matches: ['https://*/*'] }),
          'host-catalog',
        ),
        record(manifest('voyager.new'), 'host-catalog'),
      ],
      remoteAuthoritative: true,
      scopeUrl: SCOPE.url,
      engineVersion: ENGINE,
    });
    expect(merged.map((r) => `${r.manifest.id}:${r.manifest.name}:${r.sourceId}`)).toEqual([
      'voyager.formula-copy:native:builtin',
      'voyager.new:voyager.new:host-catalog',
    ]);
  });

  it('does not apply the kill switch without a scope url', () => {
    const merged = mergePluginRecords({
      builtin: [],
      snapshot: [record(manifest('voyager.a'), 'bundled-catalog')],
      remote: [],
      remoteAuthoritative: true,
      engineVersion: ENGINE,
    });
    expect(merged.map((r) => r.manifest.id)).toEqual(['voyager.a']);
  });
});
