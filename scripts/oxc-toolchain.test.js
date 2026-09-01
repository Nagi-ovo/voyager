import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * These tests only cover toolchain breakage that `oxfmt --check` and `oxlint`
 * cannot report themselves.
 *
 * Both CI gates are blind to a config that stops doing its job: deleting a rule
 * from `.oxlintrc.json` still lints clean, and removing `sortImports` from
 * `.oxfmtrc.jsonc` still passes `--check`, because the committed files already
 * satisfy the weaker config. Drift that CI *does* catch — `printWidth`,
 * `singleQuote`, `ignoreCase` — is deliberately not asserted here; restating
 * those values would only duplicate the gate that already fails on them.
 */

const repositoryRoot = process.cwd();
const oxlintBin = resolve(repositoryRoot, 'node_modules/.bin/oxlint');
const oxfmtBin = resolve(repositoryRoot, 'node_modules/.bin/oxfmt');
const oxlintConfig = resolve(repositoryRoot, '.oxlintrc.json');
const oxfmtConfig = resolve(repositoryRoot, '.oxfmtrc.jsonc');

let workspace;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'voyager-oxc-'));
});

function writeFixture(name, source) {
  const filePath = join(workspace, name);
  writeFileSync(filePath, source, 'utf8');
  return filePath;
}

describe('oxlint enforces the rules carried over from the eslint flat config', () => {
  // Every rule below was enforced before the migration. A rule that silently
  // stops firing — renamed upstream, or its plugin dropped from `plugins`,
  // which replaces the default set rather than extending it — leaves the lint
  // job green, so the only way to notice is to lint code that violates it.
  const fixture = `import { useState } from 'react';

export function Probe({ flag }: { flag: boolean }) {
  if (flag) {
    useState(0);
  }
  const value = useState(0)[0];
  const loose: any = value;
  console.log('reported');
  console.warn('allowed');
  console.error('allowed');
  return <img src="x" />;
}
`;

  let diagnostics;

  beforeAll(() => {
    const filePath = writeFixture('probe.tsx', fixture);
    const result = spawnSync(oxlintBin, ['-c', oxlintConfig, '-f', 'json', filePath], {
      encoding: 'utf8',
    });
    const payload = JSON.parse(result.stdout);
    diagnostics = payload.diagnostics ?? payload;
  });

  function severityOf(code) {
    return diagnostics.filter((entry) => entry.code === code).map((entry) => entry.severity);
  }

  it('fails the build on conditionally called hooks', () => {
    // The only rule the flat config raised to `error`. Note the asymmetry
    // between the configured name and the reported one: `.oxlintrc.json` says
    // `react/rules-of-hooks`, oxlint reports `react-hooks(rules-of-hooks)`.
    expect(severityOf('react-hooks(rules-of-hooks)')).toEqual(['error']);
  });

  it('warns on any', () => {
    // `restriction` is off by default, so this fires only while the rule is
    // configured — same for no-console below.
    expect(severityOf('typescript(no-explicit-any)')).toEqual(['warning']);
  });

  it('allows console.warn and console.error but not console.log', () => {
    // Proves the rule's `allow` option survived, not merely the rule itself:
    // the fixture calls all three and only one may be reported.
    expect(severityOf('eslint(no-console)')).toEqual(['warning']);
  });

  it('keeps the jsx-a11y plugin enabled', () => {
    // jsx-a11y is off by default, so this fires only while `plugins` lists it.
    // It reports as an error because alt-text is a correctness rule.
    expect(severityOf('jsx-a11y(alt-text)')).toEqual(['error']);
  });
});

describe('oxlint fails the build on the correctness category', () => {
  it('reports a rule the config never names as an error, not a warning', () => {
    // no-unreachable is absent from `rules`, so its severity comes entirely from
    // `categories`. Drop that key and every correctness rule silently falls back
    // to a warning: the lint job keeps exiting 0 and stops guarding anything.
    const filePath = writeFixture(
      'correctness.ts',
      'export function dead(): number {\n  return 1;\n  console.warn("unreachable");\n}\n',
    );

    const result = spawnSync(oxlintBin, ['-c', oxlintConfig, '-f', 'json', filePath], {
      encoding: 'utf8',
    });
    const payload = JSON.parse(result.stdout);
    const unreachable = (payload.diagnostics ?? payload).filter(
      (entry) => entry.code === 'eslint(no-unreachable)',
    );

    expect(unreachable.map((entry) => entry.severity)).toEqual(['error']);
    // An error has to be a non-zero exit, or CI would never notice it.
    expect(result.status).not.toBe(0);
  });

  it('fails on an unused binding, which an explicit severity can silently exempt', () => {
    // no-unused-vars carries options, so it has to name a severity, and that
    // severity outranks the category. Written as "warn" it drops out of the gate
    // without anything else changing -- which is how a five-function dead chain
    // survived in export/index.ts.
    const filePath = writeFixture(
      'unused.ts',
      'export function keep(): number {\n  const unused = 1;\n  const _ignored = 2;\n  return 3;\n}\n',
    );

    const result = spawnSync(oxlintBin, ['-c', oxlintConfig, '-f', 'json', filePath], {
      encoding: 'utf8',
    });
    const payload = JSON.parse(result.stdout);
    const unused = (payload.diagnostics ?? payload).filter(
      (entry) => entry.code === 'eslint(no-unused-vars)',
    );

    // Only the plain binding: the _-prefixed one stays exempt.
    expect(unused).toHaveLength(1);
    expect(unused[0].severity).toBe('error');
    expect(result.status).not.toBe(0);
  });
});

describe('oxfmt reproduces the prettier import ordering', () => {
  it('groups imports by the project path aliases', () => {
    // Replaces @trivago/prettier-plugin-sort-imports. `sortImports` is off by
    // default, so dropping the block leaves imports wherever they were written
    // while `--check` still passes over the already-sorted tree.
    const filePath = writeFixture(
      'imports.ts',
      [
        "import { z } from './local';",
        "import { a } from '@core/a';",
        "import { m } from 'marked';",
        "import { p } from '@pages/p';",
        "import { useState } from 'react';",
        "import { f } from '@features/f';",
        '',
      ].join('\n'),
    );

    spawnSync(oxfmtBin, ['-c', oxfmtConfig, filePath], { encoding: 'utf8' });

    const sources = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('import'))
      // Quote style is `oxfmt --check`'s business, so accept either one here.
      .map((line) => line.match(/from ['"](.+)['"]/)[1]);

    expect(sources).toEqual(['react', 'marked', '@core/a', '@features/f', '@pages/p', './local']);
  });
});

describe('the pre-commit hook survives an all-ignored staged set', () => {
  it('runs oxfmt with flags that tolerate zero matched files', () => {
    // Staging only ignored paths (CLAUDE.md, a changelog note) leaves oxfmt
    // with no target file, which it treats as an error. Without the flag the
    // hook would reject an otherwise valid commit, and no CI job would ever
    // see it. Run the hook's own invocation rather than grepping for the flag.
    const hook = readFileSync(resolve(repositoryRoot, '.githooks/pre-commit'), 'utf8');
    const invocation = hook.match(/bun x oxfmt([^"]*)/);
    expect(invocation).not.toBeNull();

    const hookFlags = invocation[1].trim().split(/\s+/).filter(Boolean);
    // A path that cannot exist, so the assertion can never rewrite the tree.
    const missing = join(workspace, 'nested', 'never-created.ts');

    expect(spawnSync(oxfmtBin, [...hookFlags, missing]).status).toBe(0);
    // The flag is load-bearing, not decorative.
    expect(spawnSync(oxfmtBin, [missing]).status).not.toBe(0);
  });
});
