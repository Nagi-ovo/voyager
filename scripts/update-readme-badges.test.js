import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const hostedBadgeBase = 'https://voyager.nagi.fun/badges';
const badgeColor = '#5f8f55';
const badgeNames = ['stars', 'forks', 'release', 'downloads'];
const docsToolingPaths = [
  '.github/workflows/deploy-docs.yml',
  '.github/workflows/sponsors.yml',
  'scripts/generate-sponsors.cjs',
  'scripts/generate-sponsors.test.js',
  'scripts/update-readme-badges.mjs',
  'scripts/update-readme-badges.test.js',
  'sponsorkit/**',
];
const readmePathsInCi = ['README.md', '.github/README_*.md'];
const readmePaths = [
  'README.md',
  '.github/README_AR.md',
  '.github/README_ES.md',
  '.github/README_FR.md',
  '.github/README_JA.md',
  '.github/README_KO.md',
  '.github/README_PT.md',
  '.github/README_RU.md',
  '.github/README_ZH.md',
  '.github/README_ZH_TW.md',
];

function readRepositoryFile(path) {
  return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

describe('README badge publishing', () => {
  it('publishes generated badges through the docs deployment without committing them', () => {
    const workflow = readRepositoryFile('.github/workflows/deploy-docs.yml');

    expect(workflow).toContain("cron: '17 3 * * *'");
    expect(workflow).toContain('node scripts/update-readme-badges.mjs');
    expect(existsSync(resolve(repositoryRoot, '.github/workflows/update-readme-badges.yml'))).toBe(
      false,
    );
  });

  it.each(readmePaths)('%s uses the hosted badge source', (readmePath) => {
    const readme = readRepositoryFile(readmePath);

    for (const badgeName of badgeNames) {
      expect(readme).toContain(`${hostedBadgeBase}/github-${badgeName}.svg`);
    }
  });

  it('fetches metrics from the current repository slug', () => {
    const generator = readRepositoryFile('scripts/update-readme-badges.mjs');

    expect(generator).toContain("const repo = 'voyager';");
    expect(generator).not.toContain("const repo = 'gemini-voyager';");
  });

  it('uses the Voyager brand green for every generated badge', () => {
    const generator = readRepositoryFile('scripts/update-readme-badges.mjs');

    expect(generator).toContain(`const badgeColor = '${badgeColor}';`);
    expect(generator).not.toContain('#2ea44f');

    for (const badgeName of badgeNames) {
      const badge = readRepositoryFile(`docs/public/badges/github-${badgeName}.svg`);
      expect(badge).toContain(`fill="${badgeColor}"`);
    }
  });

  it('routes docs tooling away from full extension and native CI', () => {
    const workflow = readRepositoryFile('.github/workflows/ci.yml');
    const docsFilter = workflow.slice(
      workflow.indexOf('            docs:'),
      workflow.indexOf('            app:'),
    );
    const coreFilter = workflow.slice(
      workflow.indexOf('            core:'),
      workflow.indexOf('\n\n  # ── Format'),
    );

    for (const path of docsToolingPaths) {
      expect(docsFilter).toContain(`- '${path}'`);
      expect(coreFilter).toContain(`- '!${path}'`);
    }

    for (const path of readmePathsInCi) {
      expect(docsFilter).toContain(`- '${path}'`);
    }

    expect(workflow).toContain(
      'bun run test scripts/generate-sponsors.test.js scripts/update-readme-badges.test.js',
    );
    expect(workflow).toContain('node scripts/update-readme-badges.mjs --self-test');
  });
});
