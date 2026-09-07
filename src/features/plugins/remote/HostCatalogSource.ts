/**
 * HostCatalogSource — the remote plugin source, read side only.
 *
 * `list({ host })` serves the cached per-host catalog written by the background
 * refresher (see hostCatalogRefresh.ts) and NEVER touches the network: page
 * loads, popup opens and catalog-change reloads all stay local. Refreshing is
 * a separate, explicitly triggered message so the two concerns cannot feed
 * into each other.
 *
 * The source is authoritative for a host only when the cached entry is a
 * successful fetch by the running extension version (D6): then its plugin set
 * is the truth and a bundled plugin it no longer lists is dropped. A 404
 * ("missing"), a failed-only history, or an entry from another version yield
 * nothing, and the bundled snapshot stays in force.
 */
import { EXTENSION_VERSION } from '@/core/utils/version';

import type {
  PluginManifest,
  PluginSource,
  PluginSourceContext,
  PluginSourceListing,
} from '../types';
import { isRemotePluginCatalogEnabledAtBuild } from './config';
import { type HostCatalogCacheEntry, loadHostCatalogCache } from './hostCatalogCache';
import { isEligibleCatalogHost, isHostCatalogEntryUsable } from './hostCatalogPolicy';

export const HOST_CATALOG_SOURCE_ID = 'host-catalog';

export interface HostCatalogSourceOptions {
  readonly extensionVersion?: string;
  /** Injectable for tests; defaults to the storage-backed cache. */
  readonly loadEntry?: (host: string) => Promise<HostCatalogCacheEntry | null>;
  /** Injectable for tests; defaults to the build-time flag. */
  readonly enabled?: boolean;
}

export class HostCatalogSource implements PluginSource {
  readonly id = HOST_CATALOG_SOURCE_ID;
  readonly kind = 'remote' as const;
  private readonly extensionVersion: string;
  private readonly loadEntry: (host: string) => Promise<HostCatalogCacheEntry | null>;
  private readonly enabled: boolean;

  constructor(options: HostCatalogSourceOptions = {}) {
    this.extensionVersion = options.extensionVersion ?? EXTENSION_VERSION;
    this.loadEntry = options.loadEntry ?? loadHostCatalogCache;
    this.enabled = options.enabled ?? isRemotePluginCatalogEnabledAtBuild();
  }

  async list(context?: PluginSourceContext): Promise<readonly PluginManifest[]> {
    const entry = await this.usableEntry(context);
    return entry ? entry.manifests : [];
  }

  async isAuthoritative(context?: PluginSourceContext): Promise<boolean> {
    return (await this.usableEntry(context)) !== null;
  }

  /** One cache read answers both questions; see `PluginSource.listWithAuthority`. */
  async listWithAuthority(context?: PluginSourceContext): Promise<PluginSourceListing> {
    const entry = await this.usableEntry(context);
    return entry
      ? { manifests: entry.manifests, authoritative: true }
      : { manifests: [], authoritative: false };
  }

  private async usableEntry(context?: PluginSourceContext): Promise<HostCatalogCacheEntry | null> {
    const host = context?.host;
    if (!this.enabled || !host || !isEligibleCatalogHost(host)) return null;
    const entry = await this.loadEntry(host);
    return isHostCatalogEntryUsable(entry, this.extensionVersion) ? entry : null;
  }
}
