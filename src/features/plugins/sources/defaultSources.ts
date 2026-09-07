import { logger } from '@/core/services/LoggerService';

import { PLUGIN_ENGINE_VERSION } from '../constants';
import { HostCatalogSource } from '../remote/HostCatalogSource';
import { engineSatisfied } from '../semver';
import { matchesAnyPattern } from '../sites/matchPattern';
import type { PluginManifest, PluginSource, PluginSourceContext } from '../types';
import { BuiltinPluginSource } from './BuiltinPluginSource';
import { BundledCatalogPluginSource } from './BundledCatalogPluginSource';

/**
 * Active sources, in tier order: first-party native plugins, the bundled
 * declarative snapshot, and the per-host remote catalog (read from the cache
 * the background refresher maintains; never fetched here).
 */
export function createDefaultPluginSources(): readonly PluginSource[] {
  return [new BuiltinPluginSource(), new BundledCatalogPluginSource(), new HostCatalogSource()];
}

/** A newer remote version exists but needs a newer engine than this build has. */
export interface BlockedPluginUpdate {
  readonly version: string;
  readonly engine: string;
}

export interface SourcedPluginManifest {
  readonly manifest: PluginManifest;
  /** Stable source identifier only; never contains a catalog URL. */
  readonly sourceId: string;
  /** Present when the bundled snapshot stays active because the remote update is incompatible (D6). */
  readonly blockedUpdate?: BlockedPluginUpdate;
}

export interface MergePluginRecordsInput {
  readonly builtin: readonly SourcedPluginManifest[];
  /** Bundled snapshot plus any source without a declared kind, in source order. */
  readonly snapshot: readonly SourcedPluginManifest[];
  readonly remote: readonly SourcedPluginManifest[];
  /** True when the remote list is the truth for `scopeUrl`'s host (kill switch). */
  readonly remoteAuthoritative: boolean;
  /** Page the listing is for; scopes the kill switch to plugins that target it. */
  readonly scopeUrl?: string;
  readonly engineVersion?: string;
}

/**
 * Merge rules (plan D6 / D20), per plugin id:
 *   - builtin ids always come from the builtin source; a remote entry with the
 *     same id is ignored (first-party code must not have its scope or settings
 *     rewritten remotely);
 *   - remote entry compatible with this engine → remote;
 *   - remote entry incompatible, snapshot compatible → snapshot, flagged with
 *     the blocked update so the popup can say "needs a newer Voyager";
 *   - both incompatible → remote (the status machine reports needs-engine);
 *   - remote authoritative for this host and a snapshot plugin targeting this
 *     page is absent from it → dropped (kill switch);
 *   - remote unavailable → snapshot as-is.
 */
export function mergePluginRecords(input: MergePluginRecordsInput): SourcedPluginManifest[] {
  const engineVersion = input.engineVersion ?? PLUGIN_ENGINE_VERSION;
  const seen = new Set<string>();
  const merged: SourcedPluginManifest[] = [];

  for (const record of input.builtin) {
    if (seen.has(record.manifest.id)) continue;
    seen.add(record.manifest.id);
    merged.push(record);
  }

  const remoteById = new Map<string, SourcedPluginManifest>();
  for (const record of input.remote) {
    const id = record.manifest.id;
    if (seen.has(id) || remoteById.has(id)) continue;
    remoteById.set(id, record);
  }

  for (const record of input.snapshot) {
    const id = record.manifest.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const remote = remoteById.get(id);
    remoteById.delete(id);
    if (remote) {
      if (engineSatisfied(remote.manifest.engine, engineVersion)) {
        merged.push(remote);
      } else if (engineSatisfied(record.manifest.engine, engineVersion)) {
        merged.push({
          ...record,
          blockedUpdate: { version: remote.manifest.version, engine: remote.manifest.engine },
        });
      } else {
        merged.push(remote);
      }
      continue;
    }
    const targetsScope =
      !!input.scopeUrl && matchesAnyPattern(input.scopeUrl, record.manifest.matches);
    if (input.remoteAuthoritative && targetsScope) continue;
    merged.push(record);
  }

  for (const record of remoteById.values()) {
    if (seen.has(record.manifest.id)) continue;
    seen.add(record.manifest.id);
    merged.push(record);
  }

  return merged;
}

async function listFromSource(
  source: PluginSource,
  context: PluginSourceContext | undefined,
): Promise<readonly PluginManifest[]> {
  try {
    return await source.list(context);
  } catch (error) {
    logger.warn('Plugin source failed to list', { source: source.id, error: String(error) });
    return [];
  }
}

export async function listPluginManifestsWithSources(
  sources: readonly PluginSource[] = createDefaultPluginSources(),
  context?: PluginSourceContext,
): Promise<readonly SourcedPluginManifest[]> {
  const builtin: SourcedPluginManifest[] = [];
  const snapshot: SourcedPluginManifest[] = [];
  const remote: SourcedPluginManifest[] = [];
  let remoteAuthoritative = false;

  for (const source of sources) {
    const records = (await listFromSource(source, context)).map((manifest) => ({
      manifest,
      sourceId: source.id,
    }));
    if (source.kind === 'builtin') {
      builtin.push(...records);
    } else if (source.kind === 'remote') {
      remote.push(...records);
      if (!remoteAuthoritative && source.isAuthoritative) {
        try {
          remoteAuthoritative = await source.isAuthoritative(context);
        } catch (error) {
          logger.warn('Plugin source authority check failed', {
            source: source.id,
            error: String(error),
          });
        }
      }
    } else {
      snapshot.push(...records);
    }
  }

  const scopeUrl = context?.url ?? (context?.host ? `https://${context.host}/` : undefined);
  return mergePluginRecords({ builtin, snapshot, remote, remoteAuthoritative, scopeUrl });
}

export async function listPluginManifests(
  sources: readonly PluginSource[] = createDefaultPluginSources(),
  context?: PluginSourceContext,
): Promise<readonly PluginManifest[]> {
  return (await listPluginManifestsWithSources(sources, context)).map(({ manifest }) => manifest);
}

/** Re-read every source (fresh instances; the remote cache may have changed). */
export async function refreshPluginManifests(
  context?: PluginSourceContext,
): Promise<readonly PluginManifest[]> {
  return listPluginManifests(createDefaultPluginSources(), context);
}

export async function refreshPluginManifestsWithSources(
  context?: PluginSourceContext,
): Promise<readonly SourcedPluginManifest[]> {
  return listPluginManifestsWithSources(createDefaultPluginSources(), context);
}

/** Merge manifest lists from multiple sources; first occurrence of an id wins. */
export function dedupeManifestsById(
  lists: readonly (readonly PluginManifest[])[],
): PluginManifest[] {
  const seen = new Set<string>();
  const merged: PluginManifest[] = [];
  for (const list of lists) {
    for (const manifest of list) {
      if (seen.has(manifest.id)) continue;
      seen.add(manifest.id);
      merged.push(manifest);
    }
  }
  return merged;
}
