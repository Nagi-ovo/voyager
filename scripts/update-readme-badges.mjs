#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const owner = 'Nagi-ovo';
const repo = 'voyager';
const badgeColor = '#5f8f55';
const outDirs = [new URL('../docs/public/badges/', import.meta.url)];
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'voyager-readme-badges',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;',
    }[char];
  });
}

function formatCount(value) {
  if (value < 1000) return String(value);

  const unit = value < 1000000 ? 'k' : 'M';
  const divisor = value < 1000000 ? 1000 : 1000000;
  const scaled = value / divisor;
  const rounded = scaled >= 10 ? Math.round(scaled) : Number(scaled.toFixed(1));

  return `${String(rounded).replace(/\.0$/, '')}${unit}`;
}

// ponytail: approximate widths are fine for README badges; use badge-maker if pixel-perfect layout matters.
function textWidth(text) {
  return text.length * 7 + 10;
}

function renderBadge(label, message, color) {
  const safeLabel = escapeXml(label);
  const safeMessage = escapeXml(message);
  const labelWidth = textWidth(label);
  const messageWidth = textWidth(message);
  const width = labelWidth + messageWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${safeLabel}: ${safeMessage}">
  <title>${safeLabel}: ${safeMessage}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${color}"/>
    <rect width="${width}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="${labelWidth * 5}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">${safeLabel}</text>
    <text x="${labelWidth * 5}" y="140" transform="scale(.1)">${safeLabel}</text>
    <text aria-hidden="true" x="${labelWidth * 10 + messageWidth * 5}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">${safeMessage}</text>
    <text x="${labelWidth * 10 + messageWidth * 5}" y="140" transform="scale(.1)">${safeMessage}</text>
  </g>
</svg>
`;
}

async function requestGitHub(pathname) {
  const response = await fetch(`https://api.github.com${pathname}`, { headers });
  if (!response.ok) {
    const hint = !token && response.status === 403 ? ' (set GITHUB_TOKEN or GH_TOKEN)' : '';
    throw new Error(`GitHub API ${response.status}: ${pathname}${hint}`);
  }

  return response.json();
}

async function writeIfChanged(file, content) {
  try {
    if ((await readFile(file, 'utf8')) === content) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await writeFile(file, content);
}

async function getAllReleases() {
  const releases = [];

  for (let page = 1; ; page += 1) {
    const batch = await requestGitHub(`/repos/${owner}/${repo}/releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) break;
  }

  return releases;
}

async function getLatestRelease() {
  try {
    return await requestGitHub(`/repos/${owner}/${repo}/releases/latest`);
  } catch (error) {
    if (!String(error.message).includes('GitHub API 404')) throw error;
    return null;
  }
}

async function main() {
  const [repository, latestRelease, releases] = await Promise.all([
    requestGitHub(`/repos/${owner}/${repo}`),
    getLatestRelease(),
    getAllReleases(),
  ]);

  const downloads = releases.reduce((sum, release) => {
    return sum + release.assets.reduce((assetSum, asset) => assetSum + asset.download_count, 0);
  }, 0);

  const badges = {
    'github-stars.svg': renderBadge('stars', formatCount(repository.stargazers_count), badgeColor),
    'github-forks.svg': renderBadge('forks', formatCount(repository.forks_count), badgeColor),
    'github-release.svg': renderBadge('release', latestRelease?.tag_name || 'none', badgeColor),
    'github-downloads.svg': renderBadge('downloads', formatCount(downloads), badgeColor),
  };

  await Promise.all(outDirs.map((outDir) => mkdir(outDir, { recursive: true })));
  await Promise.all(
    outDirs.flatMap((outDir) =>
      Object.entries(badges).map(([filename, svg]) =>
        writeIfChanged(new URL(filename, outDir), svg),
      ),
    ),
  );
}

function selfTest() {
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1200), '1.2k');
  assert.equal(formatCount(12345), '12k');
  assert.equal(formatCount(1234567), '1.2M');
  assert.match(renderBadge('stars', '1.2k', badgeColor), /aria-label="stars: 1\.2k"/);
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  await main();
}
