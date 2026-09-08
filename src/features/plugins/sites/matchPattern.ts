/**
 * Glob-style URL match patterns — a pragmatic subset of Chrome extension match
 * patterns, used for both site adapters and plugin `matches`.
 *
 * Supported forms (matched against the full URL string, case-insensitive):
 *   https://claude.ai/*
 *   *://claude.ai/*
 *   https://*.openai.com/*
 *   <all_urls>            (any http/https URL)
 *
 * `*` matches any run of characters (including `.` and `/`). This is deliberately
 * simpler than the full Chrome spec — no special `*.` subdomain semantics — so it
 * is easy to reason about and test. Authors list explicit patterns for each host
 * they support (e.g. both `https://chatgpt.com/*` and `https://chat.openai.com/*`).
 */

function patternToRegExp(pattern: string): RegExp {
  if (pattern === '<all_urls>') return /^https?:\/\//i;
  // Escape regex metacharacters EXCEPT `*`, then turn `*` into `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesUrl(url: string, pattern: string): boolean {
  try {
    return patternToRegExp(pattern).test(url);
  } catch {
    return false;
  }
}

export function matchesAnyPattern(url: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesUrl(url, pattern));
}

interface ParsedPattern {
  readonly scheme: 'https' | 'http' | '*';
  readonly host: string;
  readonly path: string;
}

function parsePattern(pattern: string): ParsedPattern | null {
  const match = /^(https?|\*):\/\/([^/]+)(\/.*)?$/i.exec(pattern.trim());
  if (!match) return null;
  return {
    scheme: match[1].toLowerCase() as ParsedPattern['scheme'],
    host: match[2].toLowerCase(),
    path: match[3] || '/',
  };
}

function hostWithin(inner: string, outer: string): boolean {
  if (outer === '*' || inner === outer) return true;
  if (outer.startsWith('*.')) {
    // Same contract as the runtime glob (`*.example.com` becomes `.*\.example\.com`):
    // a subdomain is required, so the apex host is NOT within the wildcard.
    const suffix = outer.slice(2);
    const bare = inner.startsWith('*.') ? inner.slice(2) : inner;
    return bare.endsWith(`.${suffix}`);
  }
  return false;
}

function pathWithin(inner: string, outer: string): boolean {
  if (outer === '/*' || inner === outer) return true;
  if (outer.endsWith('*')) return inner.startsWith(outer.slice(0, -1));
  return false;
}

/**
 * True when every URL `inner` can match is also matched by `outer` (plan D18:
 * a plugin may only target URLs its site adapter covers). Compares the parts,
 * not one probe URL: `https://*.example.com/*` is NOT within
 * `https://x.example.com/*`, and `*://example.com/*` is NOT within an
 * https-only site.
 */
export function patternWithin(inner: string, outer: string): boolean {
  if (outer.trim() === '<all_urls>') return true;
  if (inner.trim() === '<all_urls>') return false;
  const a = parsePattern(inner);
  const b = parsePattern(outer);
  if (!a || !b) return false;
  const schemeOk = b.scheme === '*' || a.scheme === b.scheme;
  return schemeOk && hostWithin(a.host, b.host) && pathWithin(a.path, b.path);
}

export function patternWithinAny(inner: string, outers: readonly string[]): boolean {
  return outers.some((outer) => patternWithin(inner, outer));
}
