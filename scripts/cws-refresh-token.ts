/**
 * One-time helper: mint a Chrome Web Store API refresh token for the Chrome
 * publish step in .github/workflows/release.yml.
 *
 * Run it locally — it never sends your client id/secret anywhere except
 * Google's own token endpoint, and prints the refresh token to your terminal.
 *
 *   # easiest: point it at the JSON you downloaded when creating the client
 *   bun run scripts/cws-refresh-token.ts ~/Downloads/client_secret_*.json
 *
 *   # or pass them explicitly
 *   CLIENT_ID=xxx CLIENT_SECRET=yyy bun run scripts/cws-refresh-token.ts
 *
 * The credentials come from the "Desktop app" OAuth client you create at
 * console.cloud.google.com (APIs & Services → Credentials). The script opens a
 * Google consent page using the loopback redirect that desktop clients allow;
 * after you approve, paste the printed token into the CHROME_REFRESH_TOKEN secret.
 */

/* oxlint-disable no-console -- one-off local CLI helper; printing to the terminal is its whole job */

let clientId = process.env.CLIENT_ID;
let clientSecret = process.env.CLIENT_SECRET;

const jsonPath = process.argv[2];
if (jsonPath) {
  const raw = (await Bun.file(jsonPath).json()) as Record<
    string,
    { client_id?: string; client_secret?: string }
  >;
  const cfg = raw.installed ?? raw.web ?? (raw as { client_id?: string; client_secret?: string });
  clientId = cfg.client_id ?? clientId;
  clientSecret = cfg.client_secret ?? clientSecret;
}

if (!clientId || !clientSecret) {
  console.error('Pass the client_secret JSON path, or set CLIENT_ID and CLIENT_SECRET env vars.');
  process.exit(1);
}

const PORT = 8976;
const redirectUri = `http://localhost:${PORT}`;
const scope = 'https://www.googleapis.com/auth/chromewebstore';

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
  }).toString();

console.log(
  "\nOpening your browser to authorize…\nIf it doesn't open, visit this URL:\n\n" + authUrl + '\n',
);
try {
  Bun.spawn(['open', authUrl]); // macOS; harmless if it fails
} catch {}

const code: string = await new Promise((resolve) => {
  const server = Bun.serve({
    port: PORT,
    fetch(req) {
      const c = new URL(req.url).searchParams.get('code');
      if (!c) return new Response('Waiting for Google authorization…');
      resolve(c);
      queueMicrotask(() => server.stop());
      return new Response('Authorized — close this tab and return to the terminal.');
    },
  });
});

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }).toString(),
});

const data = (await res.json()) as {
  refresh_token?: string;
  error?: string;
  error_description?: string;
};
if (!data.refresh_token) {
  console.error('\nNo refresh_token returned:', data);
  process.exit(1);
}

console.log(
  '\n✅ Refresh token — paste this into the CHROME_REFRESH_TOKEN GitHub secret:\n\n' +
    data.refresh_token +
    '\n',
);
process.exit(0);
