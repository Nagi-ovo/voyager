import { describe, expect, it } from 'vitest';

import { validateManifest } from './validate';

const BASE = {
  id: 'voyager.native-test',
  name: 'Native',
  version: '1.0.0',
  description: 'd',
  author: 'a',
  category: 'productivity',
  license: 'MIT',
  engine: '>=1.3.0',
  tier: 'declarative',
  matches: ['https://chat.deepseek.com/*'],
  contributes: {},
};

function issuesOf(raw: unknown): string[] {
  const result = validateManifest(raw);
  return result.success ? [] : result.error.map((issue) => `${issue.path}: ${issue.message}`);
}

describe('validateManifest: native ops, requires, format, changelog (plan §5)', () => {
  it('normalises a native op with default params and keeps handler + params', () => {
    const result = validateManifest({
      ...BASE,
      contributes: {
        domOps: [
          { op: 'native', handler: 'formulaCopy' },
          { op: 'native', handler: 'turnNavigator', params: { position: 'right', depth: 2 } },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.contributes.domOps).toEqual([
      { op: 'native', handler: 'formulaCopy', params: {} },
      { op: 'native', handler: 'turnNavigator', params: { position: 'right', depth: 2 } },
    ]);
  });

  it('rejects malformed handler names and non-plain params', () => {
    expect(
      issuesOf({ ...BASE, contributes: { domOps: [{ op: 'native', handler: 'Formula Copy' }] } }),
    ).toEqual(['contributes.domOps[0].handler: must be a primitive name (camelCase)']);
    expect(
      issuesOf({
        ...BASE,
        contributes: { domOps: [{ op: 'native', handler: 'formulaCopy', params: 'x' }] },
      }),
    ).toEqual(['contributes.domOps[0].params: must be a plain JSON object of bounded size']);
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(
      issuesOf({
        ...BASE,
        contributes: { domOps: [{ op: 'native', handler: 'formulaCopy', params: deep }] },
      }),
    ).toHaveLength(1);
    expect(
      issuesOf({
        ...BASE,
        contributes: {
          domOps: [{ op: 'native', handler: 'formulaCopy', params: { __proto__: { x: 1 } } }],
        },
      }),
    ).toEqual([]);
    expect(
      issuesOf({
        ...BASE,
        contributes: {
          domOps: [
            {
              op: 'native',
              handler: 'formulaCopy',
              params: JSON.parse('{"__proto__": {"polluted": true}}'),
            },
          ],
        },
      }),
    ).toHaveLength(1);
  });

  it('normalises requires and rejects bad entries', () => {
    const ok = validateManifest({
      ...BASE,
      requires: { handlers: ['formulaCopy', 'formulaCopy'], semantic: ['userTurn'] },
    });
    expect(ok.success && ok.data.requires).toEqual({
      handlers: ['formulaCopy'],
      semantic: ['userTurn'],
    });
    expect(issuesOf({ ...BASE, requires: { handlers: ['not a name'] } })).toEqual([
      'requires.handlers: entries must be primitive names',
    ]);
    expect(issuesOf({ ...BASE, requires: 'formulaCopy' })).toEqual(['requires: must be an object']);
    const none = validateManifest({ ...BASE, requires: {} });
    expect(none.success && none.data.requires).toBeUndefined();
  });

  it('accepts format 1 only, and a bounded changelog with localized variants', () => {
    expect(issuesOf({ ...BASE, format: 1 })).toEqual([]);
    expect(issuesOf({ ...BASE, format: 2 })).toEqual([
      'format: unsupported manifest format (expected 1)',
    ]);
    const result = validateManifest({
      ...BASE,
      changelog: 'Supports the new virtual list',
      i18n: { zh: { changelog: '支持新版虚拟列表' }, ja: { name: '名前' } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.changelog).toBe('Supports the new virtual list');
    expect(result.data.i18n?.zh).toEqual({ changelog: '支持新版虚拟列表' });
    expect(result.data.i18n?.ja).toEqual({ name: '名前' });
    // A whitespace-only localized changelog is dropped rather than hiding the top-level one.
    const blank = validateManifest({
      ...BASE,
      changelog: 'Supports the new virtual list',
      i18n: { zh: { changelog: '   ' } },
    });
    expect(blank.success && blank.data.i18n?.zh).toBeUndefined();
    expect(issuesOf({ ...BASE, changelog: '' })).toHaveLength(1);
    expect(issuesOf({ ...BASE, changelog: 'x'.repeat(501) })).toHaveLength(1);
  });
});
