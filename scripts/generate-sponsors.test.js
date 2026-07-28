import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  fetchAfdianSponsors,
  fetchGitHubSponsors,
  validateCredentials,
  writeFileAtomic,
} = require('./generate-sponsors.cjs');

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

describe('sponsor generator safeguards', () => {
  it('requires every remote credential in strict automation mode', () => {
    expect(() =>
      validateCredentials(
        {
          githubToken: '',
          afdianUserId: 'user',
          afdianToken: '',
        },
        true,
      ),
    ).toThrow('GITHUB_TOKEN, AFDIAN_TOKEN');

    expect(() =>
      validateCredentials(
        {
          githubToken: '',
          afdianUserId: '',
          afdianToken: '',
        },
        false,
      ),
    ).not.toThrow();
  });

  it('fails on GitHub API errors in strict mode and remains fail-soft locally', async () => {
    const strictFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'bad credentials',
    });

    await expect(
      fetchGitHubSponsors('token', { fetchImpl: strictFetch, strict: true }),
    ).rejects.toThrow('Failed to fetch GitHub sponsors (401)');

    const localFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            user: {
              sponsorshipsAsMaintainer: {
                nodes: [
                  {
                    sponsorEntity: {
                      login: 'sponsor',
                      name: 'Sponsor',
                      avatarUrl: 'https://example.com/avatar.png',
                      url: 'https://github.com/sponsor',
                    },
                    tier: { monthlyPriceInDollars: 5 },
                    createdAt: '2026-01-01T00:00:00Z',
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: 'next' },
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'temporarily unavailable',
      });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(fetchGitHubSponsors('token', { fetchImpl: localFetch })).resolves.toEqual([
      expect.objectContaining({ login: 'sponsor' }),
    ]);
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to fetch GitHub sponsors (503): temporarily unavailable',
    );
  });

  it('fails on Afdian API errors in strict mode and remains fail-soft locally', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ec: 403, em: 'invalid signature' }),
    });

    await expect(fetchAfdianSponsors('user', 'token', { fetchImpl, strict: true })).rejects.toThrow(
      'Afdian API error: invalid signature',
    );

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(fetchAfdianSponsors('user', 'token', { fetchImpl })).resolves.toEqual([]);
    expect(consoleError).toHaveBeenCalledWith('Afdian API error: invalid signature');
  });

  it('replaces generated output without leaving a temporary file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voyager-sponsors-'));
    tempDirs.push(dir);
    const target = join(dir, 'sponsors.svg');
    await writeFile(target, 'old', 'utf8');

    await writeFileAtomic(target, 'new');

    expect(await readFile(target, 'utf8')).toBe('new');
    expect(await readdir(dir)).toEqual(['sponsors.svg']);
  });

  it('keeps the write job scoped to the canonical repository and enables strict mode', async () => {
    const workflow = await readFile(resolve('.github/workflows/sponsors.yml'), 'utf8');

    expect(workflow).toContain("if: github.repository == 'Nagi-ovo/voyager'");
    expect(workflow).toContain("SPONSORS_STRICT: '1'");
  });
});
