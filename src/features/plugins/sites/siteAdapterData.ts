/**
 * `site.json` — the data form of a SiteAdapter (plan §2 layer 1).
 *
 * The same shape is read from three places, so one validator covers them all:
 *   - the bundled snapshot `catalog/sites/<site>/site.json` (thin-shell adapters
 *     in `sites/adapters/` export the validated result);
 *   - the `site` section of a published per-host catalog file, which can
 *     override the bundled adapter at runtime (remote override, plan §3);
 *   - `scripts/build-plugin-catalog.ts`, which validates before publishing.
 *
 * Remote input is UNTRUSTED: every field is shape-checked, selector keys must
 * belong to the semantic vocabulary, colours must be hex literals (they are
 * concatenated into `color-mix(...)`), and sizes are capped. No schema library
 * by design (D17) — hand-written guards like `manifest/validate.ts`.
 */
import type { Result } from '@/core/types/common';

import type { ManifestIssue } from '../manifest/validate';
import type { SiteAdapter, SiteCapability, SiteThemeDescriptor } from '../types';
import { isSemanticSelectorKey } from './semanticKeys';

/** JSON-serializable adapter: `capabilities` is an array instead of a Set. */
export interface SiteAdapterData {
  readonly id: string;
  readonly label: string;
  readonly matches: readonly string[];
  readonly selectors: Readonly<Record<string, string>>;
  readonly theme: SiteThemeDescriptor;
  readonly brandColor?: string;
  readonly capabilities: readonly SiteCapability[];
  readonly conversationIdPattern?: string;
}

const SITE_CAPABILITIES = ['chat', 'sidebar', 'composer', 'darkMode'] as const;
const SITE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_LABEL_LENGTH = 60;
const MAX_MATCHES = 20;
const MAX_SELECTOR_LENGTH = 2_000;
const MAX_PATTERN_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isHexColor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)
  );
}

/** `https://host/*`-style match pattern with a concrete or `*.` host. */
function isMatchPattern(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_PATTERN_LENGTH &&
    /^(?:https?|\*):\/\/(?:\*\.)?[a-z0-9.-]+\/.*$/i.test(value)
  );
}

function isSiteCapability(value: unknown): value is SiteCapability {
  return typeof value === 'string' && (SITE_CAPABILITIES as readonly string[]).includes(value);
}

function readTheme(raw: unknown, issues: ManifestIssue[]): SiteThemeDescriptor | null {
  if (!isRecord(raw)) {
    issues.push({ path: 'theme', message: 'must be an object' });
    return null;
  }
  const keys = ['hostSelector', 'lightSelector', 'darkSelector'] as const;
  let ok = true;
  for (const key of keys) {
    const value = raw[key];
    if (!nonEmptyString(value) || value.length > MAX_SELECTOR_LENGTH) {
      issues.push({ path: `theme.${key}`, message: 'required non-empty selector' });
      ok = false;
    }
  }
  if (!ok) return null;
  return {
    hostSelector: raw.hostSelector as string,
    lightSelector: raw.lightSelector as string,
    darkSelector: raw.darkSelector as string,
  };
}

function readSelectors(raw: unknown, issues: ManifestIssue[]): Record<string, string> {
  const selectors: Record<string, string> = {};
  if (raw === undefined) return selectors;
  if (!isRecord(raw)) {
    issues.push({ path: 'selectors', message: 'must be an object' });
    return selectors;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!isSemanticSelectorKey(key)) {
      issues.push({ path: `selectors.${key}`, message: 'unknown semantic selector key' });
      continue;
    }
    if (!nonEmptyString(value) || value.length > MAX_SELECTOR_LENGTH) {
      issues.push({ path: `selectors.${key}`, message: 'must be a non-empty selector' });
      continue;
    }
    selectors[key] = value;
  }
  return selectors;
}

/**
 * Validate a `site.json` document. Selector keys outside the vocabulary and
 * malformed fields are reported as issues; the result is usable only when the
 * issue list is empty (a partially valid adapter must never mask a typo).
 */
export function validateSiteAdapterData(input: unknown): Result<SiteAdapter, ManifestIssue[]> {
  if (!isRecord(input)) {
    return { success: false, error: [{ path: '', message: 'site must be an object' }] };
  }
  const issues: ManifestIssue[] = [];

  if (!nonEmptyString(input.id) || !SITE_ID_PATTERN.test(input.id)) {
    issues.push({ path: 'id', message: 'must match ^[a-z][a-z0-9-]*$' });
  }
  if (!nonEmptyString(input.label) || input.label.length > MAX_LABEL_LENGTH) {
    issues.push({ path: 'label', message: `required, up to ${MAX_LABEL_LENGTH} chars` });
  }
  if (
    !Array.isArray(input.matches) ||
    input.matches.length === 0 ||
    input.matches.length > MAX_MATCHES ||
    !input.matches.every(isMatchPattern)
  ) {
    issues.push({ path: 'matches', message: 'must be a non-empty array of match patterns' });
  }

  const selectors = readSelectors(input.selectors, issues);
  const theme = readTheme(input.theme, issues);

  if (input.brandColor !== undefined && !isHexColor(input.brandColor)) {
    issues.push({ path: 'brandColor', message: 'must be a hex colour' });
  }

  const capabilities = new Set<SiteCapability>();
  if (input.capabilities !== undefined) {
    if (!Array.isArray(input.capabilities)) {
      issues.push({ path: 'capabilities', message: 'must be an array' });
    } else {
      input.capabilities.forEach((value, index) => {
        if (isSiteCapability(value)) capabilities.add(value);
        else issues.push({ path: `capabilities[${index}]`, message: 'unknown capability' });
      });
    }
  }

  if (input.conversationIdPattern !== undefined) {
    if (
      !nonEmptyString(input.conversationIdPattern) ||
      input.conversationIdPattern.length > MAX_PATTERN_LENGTH
    ) {
      issues.push({ path: 'conversationIdPattern', message: 'must be a non-empty string' });
    } else {
      try {
        new RegExp(input.conversationIdPattern);
      } catch {
        issues.push({
          path: 'conversationIdPattern',
          message: 'must be a valid regular expression',
        });
      }
    }
  }

  if (issues.length > 0 || !theme) return { success: false, error: issues };

  return {
    success: true,
    data: {
      id: input.id as string,
      label: input.label as string,
      matches: (input.matches as string[]).slice(),
      selectors,
      theme,
      ...(typeof input.brandColor === 'string' ? { brandColor: input.brandColor } : {}),
      capabilities,
      ...(typeof input.conversationIdPattern === 'string'
        ? { conversationIdPattern: input.conversationIdPattern }
        : {}),
    },
  };
}

/** Inverse of `validateSiteAdapterData` for publishing and caching. */
export function siteAdapterToData(adapter: SiteAdapter): SiteAdapterData {
  return {
    id: adapter.id,
    label: adapter.label,
    matches: [...adapter.matches],
    selectors: { ...adapter.selectors },
    theme: { ...adapter.theme },
    ...(adapter.brandColor ? { brandColor: adapter.brandColor } : {}),
    capabilities: [...adapter.capabilities].sort(),
    ...(adapter.conversationIdPattern
      ? { conversationIdPattern: adapter.conversationIdPattern }
      : {}),
  };
}
