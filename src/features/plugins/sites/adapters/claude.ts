import { requireBundledSiteAdapter } from '../../catalog/sites';
import type { SiteAdapter } from '../../types';

/**
 * Thin shell over `catalog/sites/claude/site.json` — the adapter is data
 * (plan §2 layer 1) so the published per-host catalog can update it without a
 * release. Edit the JSON, not this file.
 */
export const claudeAdapter: SiteAdapter = requireBundledSiteAdapter('claude');
