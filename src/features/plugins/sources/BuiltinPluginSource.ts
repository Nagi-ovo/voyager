import { BUILTIN_PLUGINS } from '../builtin';
import type { PluginManifest, PluginSource } from '../types';

/**
 * Plugin source backed by bundled first-party native plugins. Declarative
 * official CSS+JSON plugins live in `BundledCatalogPluginSource`; per-host
 * remote CSS+JSON plugins live in `remote/HostCatalogSource`.
 */
export class BuiltinPluginSource implements PluginSource {
  readonly id = 'builtin';
  readonly kind = 'builtin' as const;

  async list(): Promise<readonly PluginManifest[]> {
    return BUILTIN_PLUGINS;
  }
}
