/**
 * Cross-site injection helpers.
 *
 * The base content script is injected only on manifest-declared sites. To run
 * plugins on claude.ai / chatgpt.com / grok.com the extension must, at
 * install/enable time:
 *
 *   1. Request the OPTIONAL host permission for the plugin's origins. This MUST be
 *      driven by a user gesture (popup/options click), not the background worker.
 *      The manifest already declares `optional_host_permissions` for all https
 *      origins and the `scripting` permission, so NO manifest change is required.
 *   2. Register a content-script loader for those origins via
 *      `chrome.scripting.registerContentScripts(...)`.
 *
 * Platform notes:
 *   - Chrome/Edge/Firefox: supported. Firefox needs the same optional-permission
 *     grant; its `scripting.registerContentScripts` is compatible.
 *   - Safari 16.4+: dynamic registration is supported. Keep the popup gate
 *     capability-based so older Safari versions fail clearly.
 *
 * `pluginsToOriginPatterns` (pure) is unit-tested; background registration and
 * popup permission requests use the same derived origins.
 */
import { logger } from '@/core/services/LoggerService';

import { matchesAnyPattern } from '../sites/matchPattern';
import type { PluginManifest } from '../types';

const CLAUDE_ARTIFACT_FRAME_ORIGIN = 'https://*.frame.claudeusercontent.com/*';

const EMBEDDED_ORIGIN_PATTERNS_BY_PARENT_HOST: Readonly<Record<string, readonly string[]>> = {
  'claude.ai': [CLAUDE_ARTIFACT_FRAME_ORIGIN],
};

const EMBEDDED_PLUGIN_ORIGIN_PATTERNS = new Set<string>([CLAUDE_ARTIFACT_FRAME_ORIGIN]);

export interface PluginOriginPatternGroups {
  topFrameOrigins: string[];
  embeddedFrameOrigins: string[];
}

/**
 * Keep child-frame injection opt-in. Ordinary plugin match patterns are broad
 * enough to match same-origin iframes, but only explicitly registered companion
 * origins should receive the plugin runtime outside the top frame.
 */
export function partitionPluginOriginPatterns(
  origins: readonly string[],
): PluginOriginPatternGroups {
  const topFrameOrigins: string[] = [];
  const embeddedFrameOrigins: string[] = [];

  for (const origin of origins) {
    if (EMBEDDED_PLUGIN_ORIGIN_PATTERNS.has(origin)) {
      embeddedFrameOrigins.push(origin);
    } else {
      topFrameOrigins.push(origin);
    }
  }

  return { topFrameOrigins, embeddedFrameOrigins };
}

/**
 * Derive the set of `https://host/*` origin permission patterns required to run a
 * set of plugins. Strips path/scheme wildcards down to an origin grant suitable
 * for `permissions.request({ origins })`.
 */
export function pluginsToOriginPatterns(manifests: readonly PluginManifest[]): string[] {
  const origins = new Set<string>();
  for (const manifest of manifests) {
    for (const pattern of manifest.matches) {
      const origin = matchPatternToOrigin(pattern);
      if (origin) origins.add(origin);
    }
  }
  return [...origins].sort();
}

/**
 * Request only the origin of the site where the popup is currently open.
 * Multi-host plugins often retain legacy domains (for example chat.openai.com),
 * but enabling one on chatgpt.com must not trigger a second, unrelated grant.
 * Outside a matching site (for example the full plugin list on Gemini), fall
 * back to the complete declared origin set.
 */
export function pluginToOriginPatternsForActiveUrl(
  manifest: PluginManifest,
  activeUrl?: string,
): string[] {
  if (activeUrl && matchesAnyPattern(activeUrl, manifest.matches)) {
    try {
      const url = new URL(activeUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        const declaredOrigins = new Set(pluginsToOriginPatterns([manifest]));
        const selectedOrigins = new Set<string>([`${url.protocol}//${url.hostname}/*`]);
        for (const pattern of EMBEDDED_ORIGIN_PATTERNS_BY_PARENT_HOST[url.hostname] ?? []) {
          if (declaredOrigins.has(pattern)) selectedOrigins.add(pattern);
        }
        return [...selectedOrigins].sort();
      }
    } catch {
      // Fall back to all manifest origins below.
    }
  }
  return pluginsToOriginPatterns([manifest]);
}

function matchPatternToOrigin(pattern: string): string | null {
  if (pattern === '<all_urls>') return null;
  const match = /^(https?|\*):\/\/([^/]+)/i.exec(pattern);
  if (!match) return null;
  const scheme = match[1] === '*' ? 'https' : match[1];
  const host = match[2];
  return `${scheme}://${host}/*`;
}

/**
 * Register content-script loaders for the given origins. Inert + guarded: returns
 * false (does nothing) when `chrome.scripting` is unavailable. Caller is
 * responsible for having already obtained the host permissions via a user gesture.
 */
export async function registerContentScriptsForOrigins(
  origins: readonly string[],
): Promise<boolean> {
  const g = globalThis as { chrome?: { scripting?: typeof chrome.scripting } };
  const scripting = g.chrome?.scripting;
  if (!scripting?.registerContentScripts || origins.length === 0) return false;
  try {
    await scripting.registerContentScripts([
      {
        id: 'gv-plugin-host',
        matches: [...origins],
        js: ['src/pages/content/index.tsx'],
        runAt: 'document_idle',
      },
    ]);
    return true;
  } catch (error) {
    logger.warn('registerContentScriptsForOrigins failed', { error: String(error) });
    return false;
  }
}
