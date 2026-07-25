#!/usr/bin/env node
/**
 * Generate the sponsor board SVG with GitHub Sponsors, Afdian, and Tipping Friends.
 *
 * Usage:
 *   node scripts/generate-sponsors.cjs
 *
 * Environment variables:
 *   GITHUB_TOKEN - GitHub token for fetching sponsors
 *   AFDIAN_USER_ID - Afdian user ID
 *   AFDIAN_TOKEN - Afdian API token
 *   SPONSORS_STRICT - Set to "1" in automation to require every credential
 */
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const FRIENDS_PATH = path.join(ROOT, 'sponsorkit', 'sponsors.json');
const OUTPUT_DIR = path.join(ROOT, 'docs', 'public', 'assets');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'sponsors.svg');
const OUTPUT_PNG_PATH = path.join(OUTPUT_DIR, 'sponsors.png');
const SPONSORS_URL = 'https://github.com/sponsors/Nagi-ovo';
const OWNER_LOGIN = 'Nagi-ovo';
const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';
const AFDIAN_API = 'https://afdian.com/api/open/query-sponsor';
const FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'";

async function main() {
  const githubToken = process.env.GITHUB_TOKEN;
  const afdianUserId = process.env.AFDIAN_USER_ID;
  const afdianToken = process.env.AFDIAN_TOKEN;
  const strict = process.env.SPONSORS_STRICT === '1';
  validateCredentials({ githubToken, afdianUserId, afdianToken }, strict);

  const friends = await loadFriends(strict);
  await ensureDir(OUTPUT_DIR);

  const [githubSponsors, afdianSponsors] = await Promise.all([
    fetchGitHubSponsors(githubToken),
    fetchAfdianSponsors(afdianUserId, afdianToken),
  ]);

  const svgContent = await buildSvg({ githubSponsors, afdianSponsors, friends });
  await writeFileAtomic(OUTPUT_PATH, svgContent);
  console.log(
    `Generated ${path.relative(ROOT, OUTPUT_PATH)} with ${githubSponsors.length} GitHub sponsors, ${afdianSponsors.length} Afdian sponsors, and ${friends.length} tipping friends.`,
  );
}

function validateCredentials({ githubToken, afdianUserId, afdianToken }, strict) {
  if (!strict) return;

  const missing = [];
  if (!githubToken) missing.push('GITHUB_TOKEN');
  if (!afdianUserId) missing.push('AFDIAN_USER_ID');
  if (!afdianToken) missing.push('AFDIAN_TOKEN');

  if (missing.length > 0) {
    throw new Error(`Missing required sponsor credentials: ${missing.join(', ')}`);
  }
}

async function loadFriends(strict = false) {
  try {
    const raw = await fsp.readFile(FRIENDS_PATH, 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) {
      throw new Error(`Friend data must be an array in ${FRIENDS_PATH}`);
    }
    return list
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        return String(item.name || '').trim();
      })
      .filter(Boolean);
  } catch (e) {
    if (strict) {
      throw new Error(`Failed to load friends list: ${e.message}`);
    }
    console.warn('⚠️  Failed to load friends list:', e.message);
    return [];
  }
}

async function ensureDir(target) {
  await fsp.mkdir(target, { recursive: true });
}

async function writeFileAtomic(target, content) {
  const tempPath = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tempPath, content, 'utf8');
    await fsp.rename(tempPath, target);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function fetchGitHubSponsors(token, fetchImpl = fetch) {
  if (!token) {
    console.warn('⚠️  No GitHub token available, GitHub sponsors will be skipped.');
    return [];
  }

  const sponsors = [];
  let cursor = null;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'gemini-voyager-sponsor-bot',
  };

  while (true) {
    const body = {
      query: `
        query($login: String!, $cursor: String) {
          user(login: $login) {
            sponsorshipsAsMaintainer(first: 100, after: $cursor, includePrivate: false, activeOnly: true, orderBy: {field: CREATED_AT, direction: DESC}) {
              nodes {
                sponsorEntity {
                  ... on User {
                    login
                    name
                    avatarUrl
                    url
                  }
                  ... on Organization {
                    login
                    name
                    avatarUrl
                    url
                  }
                }
                tier {
                  monthlyPriceInDollars
                }
                createdAt
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `,
      variables: {
        login: OWNER_LOGIN,
        cursor,
      },
    };

    const res = await fetchImpl(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to fetch GitHub sponsors (${res.status}): ${text}`);
    }

    const payload = await res.json();
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      throw new Error(`GitHub Sponsors API error: ${JSON.stringify(payload.errors)}`);
    }
    const data = payload?.data?.user?.sponsorshipsAsMaintainer;
    if (!data || !Array.isArray(data.nodes) || !data.pageInfo) {
      throw new Error('Unexpected response from GitHub Sponsors API.');
    }

    for (const node of data.nodes || []) {
      const sponsor = node?.sponsorEntity;
      if (!sponsor?.login || !sponsor?.avatarUrl) continue;
      sponsors.push({
        login: sponsor.login,
        name: sponsor.name || sponsor.login,
        avatarUrl: sponsor.avatarUrl,
        url: sponsor.url || `https://github.com/${sponsor.login}`,
        amount: node?.tier?.monthlyPriceInDollars || 0,
        createdAt: node?.createdAt,
        provider: 'github',
      });
    }

    if (!data.pageInfo?.hasNextPage) {
      break;
    }
    cursor = data.pageInfo.endCursor;
  }

  sponsors.sort((a, b) => {
    if (b.amount !== a.amount) return b.amount - a.amount;
    if (a.createdAt && b.createdAt) {
      return new Date(a.createdAt) - new Date(b.createdAt);
    }
    return a.login.localeCompare(b.login);
  });

  return sponsors;
}

async function fetchAfdianSponsors(userId, token, fetchImpl = fetch) {
  if (!userId || !token) {
    console.warn('⚠️  No Afdian credentials available, Afdian sponsors will be skipped.');
    return [];
  }

  const sponsors = [];
  let page = 1;

  while (true) {
    const ts = Math.floor(Date.now() / 1000);
    const params = JSON.stringify({ page });
    const sign = crypto
      .createHash('md5')
      .update(`${token}params${params}ts${ts}user_id${userId}`)
      .digest('hex');

    const res = await fetchImpl(AFDIAN_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        params,
        ts,
        sign,
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch Afdian sponsors (${res.status})`);
    }

    const payload = await res.json();
    if (payload.ec !== 200) {
      throw new Error(`Afdian API error: ${payload.em || 'unknown error'}`);
    }

    const list = payload.data?.list;
    if (!Array.isArray(list)) {
      throw new Error('Unexpected response from Afdian API.');
    }
    if (list.length === 0) break;

    for (const item of list) {
      const user = item.user;
      if (!user) continue;
      sponsors.push({
        login: user.user_id,
        name: user.name || '匿名用户',
        avatarUrl: user.avatar || 'https://pic1.afdiancdn.com/default/avatar/avatar-purple.png',
        url: `https://afdian.com/u/${user.user_id}`,
        amount: parseFloat(item.all_sum_amount) || 0,
        provider: 'afdian',
      });
    }

    if (list.length < 20) break;
    page++;
  }

  sponsors.sort((a, b) => b.amount - a.amount);
  return sponsors;
}

async function buildSvg({ githubSponsors, afdianSponsors, friends }) {
  const width = 800;
  const outerPadding = 40;
  const innerPadding = 32;
  const contentWidth = width - outerPadding * 2;

  // Embed avatar data
  await embedAvatarData(githubSponsors);
  await embedAvatarData(afdianSponsors);

  let cursorY = innerPadding;
  const defs = [];

  // GitHub Sponsors section
  const githubGrid = renderSponsorGrid({
    sponsors: githubSponsors,
    title: 'GitHub Sponsors',
    x: 0,
    y: cursorY,
    width: contentWidth,
    sponsorUrl: SPONSORS_URL,
  });
  defs.push(...githubGrid.defs);
  cursorY += githubGrid.height + 60;

  // Afdian Sponsors section
  const afdianGrid = renderSponsorGrid({
    sponsors: afdianSponsors,
    title: 'Afdian Sponsors',
    x: 0,
    y: cursorY,
    width: contentWidth,
    sponsorUrl: 'https://afdian.com/a/nagi',
  });
  defs.push(...afdianGrid.defs);
  cursorY += afdianGrid.height + 60;

  // Tipping Friends section
  const friendTable = renderFriendTable({
    friends,
    x: 0,
    y: cursorY,
    width: contentWidth,
  });
  cursorY += friendTable.height + innerPadding;

  const boardHeight = cursorY;
  const height = boardHeight + outerPadding * 2;

  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" role="img">
    <title>Voyager Sponsors</title>
    <defs>
      ${defs.join('\n')}
    </defs>
    <g transform="translate(${outerPadding}, ${outerPadding})" font-family="${FONT_FAMILY}">
      ${githubGrid.markup}
      ${afdianGrid.markup}
      ${friendTable.markup}
    </g>
  </svg>`;

  return svg;
}

async function avatarDataUri(url) {
  try {
    const sizedUrl = url.includes('?') ? `${url}&s=160` : `${url}?s=160`;
    const res = await fetch(sizedUrl);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/png';
    const buffer = Buffer.from(await res.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

async function embedAvatarData(sponsors) {
  const results = await Promise.allSettled(
    sponsors.map(async (sponsor) => {
      if (!sponsor.avatarUrl) return;
      sponsor.avatar = await avatarDataUri(sponsor.avatarUrl);
    }),
  );
}

function renderSponsorGrid({ sponsors, title, x, y, width, sponsorUrl }) {
  const avatarSize = 36;
  const baseGap = 36;
  const gapY = 24;
  let cols = Math.floor(width / (avatarSize + baseGap));
  const rows = Math.max(1, Math.ceil(sponsors.length / cols));
  let spacing = baseGap;
  if (cols > 1) {
    spacing = (width - cols * avatarSize) / (cols - 1);
    if (spacing < baseGap) {
      spacing = baseGap;
      cols = Math.max(1, Math.floor((width + baseGap) / (avatarSize + baseGap)));
    }
  }
  const gridWidth = sponsors.length ? cols * avatarSize + Math.max(0, cols - 1) * spacing : width;
  const gridHeight = sponsors.length ? rows * avatarSize + Math.max(0, rows - 1) * gapY : 80;
  const titleHeight = 36;
  const sectionHeight = titleHeight + 36 + gridHeight + 32;
  const centerX = width / 2;
  const offsetX = Math.max(0, (width - gridWidth) / 2);

  let markup = `
    <g transform="translate(${x}, ${y})">
      <text x="${centerX}" y="0" text-anchor="middle" font-size="24" font-weight="600" fill="#222222">${escapeText(title)} · ${sponsors.length}</text>
  `;
  const clipDefs = [];

  if (!sponsors.length) {
    markup += `
      <g transform="translate(0, 50)">
        <a xlink:href="${sponsorUrl}" target="_blank">
          <text x="${width / 2}" y="20" text-anchor="middle" font-size="16" fill="#666666">Become a Sponsor ❤️</text>
        </a>
      </g>
    </g>`;
    return { markup, height: sectionHeight, defs: [] };
  }

  markup += `<g transform="translate(0, 50)">`;

  sponsors.forEach((sponsor, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const avatarX = offsetX + col * (avatarSize + spacing);
    const avatarY = row * (avatarSize + gapY);
    const clipId = `cp-${sponsor.provider}-${index}`;
    clipDefs.push(
      `<clipPath id="${clipId}">
        <circle cx="${avatarSize / 2}" cy="${avatarSize / 2}" r="${avatarSize / 2}" />
      </clipPath>`,
    );
    markup += `
      <g transform="translate(${avatarX}, ${avatarY})">
        <a xlink:href="${escapeAttr(sponsor.url)}" target="_blank">
          ${
            sponsor.avatar
              ? `<image href="${sponsor.avatar}" x="0" y="0" width="${avatarSize}" height="${avatarSize}" clip-path="url(#${clipId})" />`
              : `<circle cx="${avatarSize / 2}" cy="${avatarSize / 2}" r="${avatarSize / 2}" fill="rgba(0,0,0,0.08)" />`
          }
          <text x="${avatarSize / 2}" y="${avatarSize + 18}" text-anchor="middle" font-size="11" fill="#555555">${escapeText(sponsor.name).slice(0, 12)}</text>
        </a>
      </g>
    `;
  });

  markup += '</g></g>';

  return {
    markup,
    height: sectionHeight,
    defs: clipDefs,
  };
}

function renderFriendTable({ friends, x, y, width }) {
  const tableTop = 44;
  const columns = 6;
  const colWidth = width / columns;
  const rowHeight = 28;
  const rows = Math.max(1, Math.ceil(friends.length / columns));
  const tableHeight = rows * rowHeight;
  const centerX = width / 2;

  let markup = `
    <g transform="translate(${x}, ${y})">
      <text x="${centerX}" y="0" text-anchor="middle" font-size="24" font-weight="600" fill="#222222">Tipping Friends · ${friends.length}</text>
      <g transform="translate(0, 44)">
  `;

  const orderedFriends = [...friends].reverse();
  orderedFriends.forEach((name, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const textX = col * colWidth + colWidth / 2;
    const textY = row * rowHeight + rowHeight / 2;
    markup += `<text x="${textX}" y="${textY}" text-anchor="middle" alignment-baseline="middle" font-size="13" fill="#555555">${escapeText(name)}</text>`;
  });

  markup += '</g></g>';

  return {
    markup,
    height: tableTop + tableHeight,
  };
}

function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, '&quot;');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchAfdianSponsors,
  fetchGitHubSponsors,
  validateCredentials,
  writeFileAtomic,
};
