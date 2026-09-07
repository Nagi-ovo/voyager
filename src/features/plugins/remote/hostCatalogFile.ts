/**
 * The per-host catalog file published at `<base>/hosts/<host>.json`.
 *
 * Produced by `scripts/build-plugin-catalog.ts` from the bundled catalog on
 * every merge to `main`, consumed by the background refresher. It is UNTRUSTED
 * input at runtime: every plugin passes `validateManifest` (the same guard the
 * bundled snapshot uses), and a file whose `format` major or `host` does not
 * match is discarded as a whole.
 *
 * Shape:
 *   { format: 1, host: "chat.deepseek.com", generatedAt: "<ISO>",
 *     site?: <adapter data, ignored until P2>,
 *     plugins: [<raw manifest with CSS inlined as contributes.styles[].css>] }
 */
import { type ManifestIssue, validateManifest } from '../manifest/validate';
import type { PluginManifest } from '../types';

export const HOST_CATALOG_FORMAT = 1;

/** Upper bound on plugins per host file; protects the validator from abuse. */
export const MAX_HOST_CATALOG_PLUGINS = 200;

export interface HostCatalogFileValidation {
  readonly manifests: readonly PluginManifest[];
  /** Per-plugin problems for entries that were skipped (logged, never fatal). */
  readonly issues: readonly ManifestIssue[];
  readonly generatedAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one host catalog file. Returns null when the file cannot be used
 * at all (wrong shape, unknown format, host mismatch); otherwise the accepted
 * manifests plus the issues of rejected ones.
 */
export function validateHostCatalogFile(
  raw: unknown,
  expectedHost: string,
): HostCatalogFileValidation | null {
  if (!isRecord(raw)) return null;
  if (raw.format !== HOST_CATALOG_FORMAT) return null;
  if (typeof raw.host !== 'string' || raw.host.toLowerCase() !== expectedHost.toLowerCase()) {
    return null;
  }
  if (!Array.isArray(raw.plugins)) return null;

  const manifests: PluginManifest[] = [];
  const issues: ManifestIssue[] = [];
  const seen = new Set<string>();
  raw.plugins.slice(0, MAX_HOST_CATALOG_PLUGINS).forEach((entry, index) => {
    const result = validateManifest(entry);
    if (!result.success) {
      issues.push(
        ...result.error.map((issue) => ({
          path: `plugins[${index}].${issue.path}`,
          message: issue.message,
        })),
      );
      return;
    }
    if (seen.has(result.data.id)) {
      issues.push({ path: `plugins[${index}].id`, message: 'duplicate plugin id' });
      return;
    }
    seen.add(result.data.id);
    manifests.push(result.data);
  });

  return {
    manifests,
    issues,
    ...(typeof raw.generatedAt === 'string' ? { generatedAt: raw.generatedAt } : {}),
  };
}
