import { describe, expect, it } from 'vitest';

import { validateHostCatalogFile } from './hostCatalogFile';

const VALID = {
  id: 'voyager.deepseek-reading-width',
  name: 'DeepSeek · Reading width',
  version: '1.1.0',
  description: 'd',
  author: 'voyager-official',
  category: 'readability',
  license: 'MIT',
  engine: '>=1.2.0',
  tier: 'declarative',
  matches: ['https://chat.deepseek.com/*'],
  contributes: { styles: [{ css: 'body{--x:1}', source: 'style.css' }] },
};

function file(plugins: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    format: 1,
    host: 'chat.deepseek.com',
    generatedAt: '2026-09-07T00:00:00.000Z',
    plugins,
    ...overrides,
  };
}

describe('validateHostCatalogFile', () => {
  it('accepts a well-formed file and returns validated manifests', () => {
    const result = validateHostCatalogFile(file([VALID]), 'chat.deepseek.com');
    expect(result).not.toBeNull();
    expect(result?.manifests.map((m) => m.id)).toEqual(['voyager.deepseek-reading-width']);
    expect(result?.issues).toEqual([]);
    expect(result?.generatedAt).toBe('2026-09-07T00:00:00.000Z');
  });

  it('matches the host case-insensitively but rejects a different host', () => {
    expect(validateHostCatalogFile(file([VALID]), 'Chat.DeepSeek.com')).not.toBeNull();
    expect(validateHostCatalogFile(file([VALID]), 'claude.ai')).toBeNull();
  });

  it('discards the whole file for an unknown format, a missing host or a non-array plugin list', () => {
    expect(validateHostCatalogFile(file([VALID], { format: 2 }), 'chat.deepseek.com')).toBeNull();
    expect(validateHostCatalogFile(file([VALID], { format: '1' }), 'chat.deepseek.com')).toBeNull();
    expect(
      validateHostCatalogFile(file([VALID], { host: undefined }), 'chat.deepseek.com'),
    ).toBeNull();
    expect(
      validateHostCatalogFile(file([], { plugins: { not: 'array' } }), 'chat.deepseek.com'),
    ).toBeNull();
    expect(validateHostCatalogFile(null, 'chat.deepseek.com')).toBeNull();
    expect(validateHostCatalogFile([VALID], 'chat.deepseek.com')).toBeNull();
  });

  it('skips invalid and duplicate entries individually and reports them', () => {
    const result = validateHostCatalogFile(
      file([VALID, { id: '' }, { ...VALID, name: 'dup' }]),
      'chat.deepseek.com',
    );
    expect(result?.manifests.map((m) => m.name)).toEqual(['DeepSeek · Reading width']);
    expect(result?.issues.some((issue) => issue.path.startsWith('plugins[1]'))).toBe(true);
    expect(result?.issues).toContainEqual({
      path: 'plugins[2].id',
      message: 'duplicate plugin id',
    });
  });

  it('rejects CSS the bundled validator would reject (remote CSS is untrusted)', () => {
    const remoteImport = {
      ...VALID,
      contributes: { styles: [{ css: '@import url("https://evil.example/x.css");' }] },
    };
    const result = validateHostCatalogFile(file([remoteImport]), 'chat.deepseek.com');
    expect(result?.manifests).toEqual([]);
    expect(result?.issues.length).toBeGreaterThan(0);
  });
});
