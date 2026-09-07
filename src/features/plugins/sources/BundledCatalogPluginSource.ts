import { logger } from '@/core/services/LoggerService';

import { listBundledPluginEntries } from '../catalog/sites';
import { validateManifest } from '../manifest/validate';
import type { PluginManifest, PluginSource } from '../types';
import { resolveStyleFileContributions } from './styleFiles';

/**
 * Plugin source backed by the declarative plugins shipped inside the extension:
 * every `catalog/sites/<site>/plugins/<id>/plugin.json` discovered at build
 * time (see `catalog/sites/index.ts`), with `contributes.styles[].file`
 * inlined from the CSS next to it. This is the offline baseline the per-host
 * remote catalog (`remote/HostCatalogSource`) can update but never replace.
 */
export class BundledCatalogPluginSource implements PluginSource {
  readonly id = 'bundled-catalog';
  readonly kind = 'bundled' as const;

  async list(): Promise<readonly PluginManifest[]> {
    const manifests: PluginManifest[] = [];
    for (const entry of listBundledPluginEntries()) {
      try {
        const raw = JSON.parse(entry.manifestJson) as unknown;
        const resolved = await resolveStyleFileContributions(raw, entry.path, async (file) => {
          const css = entry.styles[file];
          if (css === undefined) throw new Error(`${entry.path}: missing bundled CSS ${file}`);
          return css;
        });
        const result = validateManifest(resolved);
        if (result.success) {
          manifests.push(result.data);
        } else {
          logger.warn('Skipping invalid bundled catalog plugin', {
            name: entry.path,
            issues: result.error,
          });
        }
      } catch (error) {
        logger.warn('Failed to load bundled catalog plugin', {
          name: entry.path,
          error: String(error),
        });
      }
    }
    return manifests;
  }
}
