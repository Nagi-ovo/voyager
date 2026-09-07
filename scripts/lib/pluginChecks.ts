/**
 * Per-plugin catalog checks shared by the publisher and the contributor CLI.
 *
 * `scripts/build-plugin-catalog.ts` runs these before it writes a host file and
 * aborts on the first violation; `scripts/plugin-check.ts` runs the same rules
 * over one directory and reports every issue at once. Keeping them here means a
 * plugin that passes `bun run plugin:check` cannot fail the publish for a reason
 * the author never saw.
 *
 * Every function returns human-readable issue strings instead of throwing, so a
 * caller decides whether one problem is fatal. Nothing here imports the site or
 * verb registries — those pull in `import.meta.glob` and content-script code,
 * neither of which exists under Bun. The primitive list is read from
 * `verbs/contracts.ts` (data only) so a newly added primitive is picked up
 * without touching this file.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import type { ManifestIssue } from '../../src/features/plugins/manifest/validate';
import {
  requiredHandlers,
  requiredSemanticKeys,
} from '../../src/features/plugins/runtime/pluginStatus';
import { engineSatisfied, parseSemver } from '../../src/features/plugins/semver';
import { matchesAnyPattern } from '../../src/features/plugins/sites/matchPattern';
import { validateSiteAdapterData } from '../../src/features/plugins/sites/siteAdapterData';
import type { PluginManifest, SiteAdapter } from '../../src/features/plugins/types';
import type { PrimitiveContract } from '../../src/features/plugins/verbs/contracts';
import { getPrimitiveContract } from '../../src/features/plugins/verbs/contracts';

/** A `sites/<dir>` entry: the directory name plus its validated adapter. */
export interface CatalogSiteRef {
  /** Directory name under `sites/`; equals the adapter id. */
  readonly dir: string;
  readonly adapter: SiteAdapter;
}

export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function formatIssues(issues: readonly ManifestIssue[]): string {
  return issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n');
}

/** Directory names directly under `dir`, sorted; empty when `dir` is absent. */
export function listSubdirectories(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareStrings);
}

/**
 * A URL that stands in for a match pattern, so one pattern can be tested
 * against another set of patterns: `https://*.example.com/*` becomes
 * `https://x.example.com/`. `<all_urls>` gets a host no site can claim, which
 * is the point — it escapes every site.
 */
export function probeUrl(pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed === '<all_urls>') return 'https://all-urls.invalid/';
  return trimmed
    .replace(/^\*:\/\//, 'https://')
    .replace(/^(https?:\/\/)\*\./i, '$1x.')
    .replace(/\*$/, '');
}

/**
 * Plan D18: a plugin may only target URLs its own site adapter covers. Without
 * this a plugin filed under `sites/claude/` could quietly ship to chatgpt.com,
 * where its semantic selectors mean nothing.
 */
export function checkMatchesStayInSite(
  manifest: PluginManifest,
  site: CatalogSiteRef,
  manifestPath: string,
): readonly string[] {
  const issues: string[] = [];
  for (const pattern of manifest.matches) {
    if (matchesAnyPattern(probeUrl(pattern), site.adapter.matches)) continue;
    issues.push(
      `${manifest.id} (${manifestPath}): match pattern "${pattern}" is not covered by site "${site.dir}" (${site.adapter.matches.join(', ')})`,
    );
  }
  return issues;
}

/**
 * The lowest engine version a range admits, or null when it admits every
 * version (`*`, empty) or cannot be parsed. Ranges are `*`, an exact `x.y.z`,
 * or `>=x.y.z` — see `semver.ts`.
 */
export function engineRangeMinimum(range: string): string | null {
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') return null;
  const minimum = parseSemver(trimmed.startsWith('>=') ? trimmed.slice(2) : trimmed);
  if (!minimum) return null;
  return `${minimum.major}.${minimum.minor}.${minimum.patch}`;
}

/** The later of two versions; used to name the primitive that sets the floor. */
function laterVersion(a: string, b: string): string {
  return engineSatisfied(`>=${b}`, a) ? a : b;
}

/**
 * Plan §5 / §8: a plugin may only invoke primitives this build ships, and its
 * `engine` range must exclude every build that predates them. Getting the range
 * right is what makes an old Voyager report `needs-engine` ("update Voyager")
 * instead of `needs-handler`, which is meant to mean a configuration mistake.
 */
export function checkPrimitivesAreShippable(
  manifest: PluginManifest,
  manifestPath: string,
): readonly string[] {
  const issues: string[] = [];
  const contracts: PrimitiveContract[] = [];
  for (const handler of requiredHandlers(manifest)) {
    const contract = getPrimitiveContract(handler);
    if (!contract) {
      issues.push(
        `${manifest.id} (${manifestPath}): unknown primitive handler "${handler}" — no contract in verbs/contracts.ts`,
      );
      continue;
    }
    contracts.push(contract);
  }
  if (issues.length > 0 || contracts.length === 0) return issues;

  const floor = contracts.reduce(
    (highest, contract) => laterVersion(highest, contract.sinceEngine),
    contracts[0].sinceEngine,
  );
  const minimum = engineRangeMinimum(manifest.engine);
  if (minimum === null) {
    issues.push(
      `${manifest.id} (${manifestPath}): engine "${manifest.engine}" admits any build, but the plugin uses primitives that need at least ${floor} — set engine to ">=${floor}"`,
    );
    return issues;
  }
  if (!engineSatisfied(`>=${floor}`, minimum)) {
    const source = contracts.find((contract) => contract.sinceEngine === floor);
    issues.push(
      `${manifest.id} (${manifestPath}): engine "${manifest.engine}" admits builds older than ${floor}, the sinceEngine of primitive "${source?.name ?? floor}" — set engine to ">=${floor}"`,
    );
  }
  return issues;
}

/**
 * Plan §5 / §8: every semantic key the plugin relies on — declared, targeted by
 * a `semantic` op, or read by one of its primitives — must be defined by the
 * site it ships under. Publishing without the key would only produce a
 * `needs-semantic` plugin on every client.
 */
export function checkSemanticKeysExist(
  manifest: PluginManifest,
  site: CatalogSiteRef,
  manifestPath: string,
): readonly string[] {
  const selectors = site.adapter.selectors;
  const missing = requiredSemanticKeys(manifest).filter((key) => !selectors[key]);
  if (missing.length === 0) return [];
  return [
    `${manifest.id} (${manifestPath}): semantic key(s) ${missing.map((key) => `"${key}"`).join(', ')} are not defined by site "${site.dir}" (has ${Object.keys(selectors).sort(compareStrings).join(', ')})`,
  ];
}

/**
 * Every rule that relates a validated manifest to the site it ships under, in
 * the order the publisher applies them.
 */
export function checkManifestAgainstSite(
  manifest: PluginManifest,
  site: CatalogSiteRef,
  manifestPath: string,
): readonly string[] {
  return [
    ...checkMatchesStayInSite(manifest, site, manifestPath),
    ...checkPrimitivesAreShippable(manifest, manifestPath),
    ...checkSemanticKeysExist(manifest, site, manifestPath),
  ];
}

export interface SiteAdapterLoad {
  /** null when the file is missing or unusable; `issues` then says why. */
  readonly adapter: SiteAdapter | null;
  readonly issues: readonly string[];
}

/**
 * Read and validate a `site.json`. `displayPath` prefixes every message so the
 * publisher can stay catalog-relative while the CLI prints a repo-relative path.
 */
export function loadSiteAdapter(
  sitePath: string,
  siteDir: string,
  displayPath: string,
): SiteAdapterLoad {
  if (!existsSync(sitePath)) {
    return {
      adapter: null,
      issues: [`${displayPath}: every directory under sites/ needs a site.json`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sitePath, 'utf8')) as unknown;
  } catch (error) {
    return {
      adapter: null,
      issues: [`${displayPath}: not valid JSON (${(error as Error).message})`],
    };
  }

  const result = validateSiteAdapterData(parsed);
  if (!result.success) {
    return {
      adapter: null,
      issues: [`${displayPath}: invalid site.json\n${formatIssues(result.error)}`],
    };
  }
  if (result.data.id !== siteDir) {
    return {
      adapter: null,
      issues: [`${displayPath}: id "${result.data.id}" must equal its directory name "${siteDir}"`],
    };
  }
  return { adapter: result.data, issues: [] };
}
