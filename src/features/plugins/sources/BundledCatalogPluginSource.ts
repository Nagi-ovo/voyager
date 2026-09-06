import { logger } from '@/core/services/LoggerService';

import marketplaceCatalog from '../catalog/marketplace.json?raw';
import chatgptReadingWidthManifest from '../catalog/plugins/chatgpt-reading-width/plugin.json?raw';
import chatgptReadingWidthStyle from '../catalog/plugins/chatgpt-reading-width/style.css?raw';
import claudeCjkRenderFixManifest from '../catalog/plugins/claude-cjk-render-fix/plugin.json?raw';
import claudeCjkRenderFixStyle from '../catalog/plugins/claude-cjk-render-fix/style.css?raw';
import claudeReadingWidthManifest from '../catalog/plugins/claude-reading-width/plugin.json?raw';
import claudeReadingWidthStyle from '../catalog/plugins/claude-reading-width/style.css?raw';
import deepseekReadingWidthManifest from '../catalog/plugins/deepseek-reading-width/plugin.json?raw';
import deepseekReadingWidthStyle from '../catalog/plugins/deepseek-reading-width/style.css?raw';
import { validateManifest } from '../manifest/validate';
import type { PluginManifest, PluginSource } from '../types';
import { resolveStyleFileContributions } from './styleFiles';

interface CatalogEntry {
  readonly name?: string;
  readonly source?: string;
}

interface BundledPluginFiles {
  readonly manifestJson: string;
  readonly styles: Readonly<Record<string, string>>;
}

interface BundledCatalogEntry {
  readonly name: string;
  readonly files: BundledPluginFiles;
}

const BUNDLED_PLUGIN_FILES: Readonly<Record<string, BundledPluginFiles>> = {
  'plugins/claude-cjk-render-fix/plugin.json': {
    manifestJson: claudeCjkRenderFixManifest,
    styles: { 'style.css': claudeCjkRenderFixStyle },
  },
  'plugins/claude-reading-width/plugin.json': {
    manifestJson: claudeReadingWidthManifest,
    styles: { 'style.css': claudeReadingWidthStyle },
  },
  'plugins/chatgpt-reading-width/plugin.json': {
    manifestJson: chatgptReadingWidthManifest,
    styles: { 'style.css': chatgptReadingWidthStyle },
  },
  'plugins/deepseek-reading-width/plugin.json': {
    manifestJson: deepseekReadingWidthManifest,
    styles: { 'style.css': deepseekReadingWidthStyle },
  },
};

export class BundledCatalogPluginSource implements PluginSource {
  readonly id = 'bundled-catalog';

  async list(): Promise<readonly PluginManifest[]> {
    const manifests: PluginManifest[] = [];
    for (const entry of readBundledCatalog()) {
      try {
        const raw = JSON.parse(entry.files.manifestJson) as unknown;
        const resolved = await resolveStyleFileContributions(raw, entry.name, async (file) => {
          const css = entry.files.styles[file];
          if (css === undefined) throw new Error(`${entry.name}: missing bundled CSS ${file}`);
          return css;
        });
        const result = validateManifest(resolved);
        if (result.success) {
          manifests.push(result.data);
        } else {
          logger.warn('Skipping invalid bundled catalog plugin', {
            name: entry.name,
            issues: result.error,
          });
        }
      } catch (error) {
        logger.warn('Failed to load bundled catalog plugin', {
          name: entry.name,
          error: String(error),
        });
      }
    }
    return manifests;
  }
}

function readBundledCatalog(): readonly BundledCatalogEntry[] {
  try {
    const raw = JSON.parse(marketplaceCatalog) as unknown;
    const entries =
      raw && typeof raw === 'object' && Array.isArray((raw as { plugins?: unknown }).plugins)
        ? ((raw as { plugins: CatalogEntry[] }).plugins ?? [])
        : [];
    return entries.flatMap((entry): BundledCatalogEntry[] => {
      if (!entry?.source) return [];
      const files = BUNDLED_PLUGIN_FILES[entry.source];
      if (!files) {
        logger.warn('Skipping bundled catalog entry without bundled files', {
          name: entry.name ?? entry.source,
          source: entry.source,
        });
        return [];
      }
      return [{ name: entry.name ?? entry.source, files }];
    });
  } catch (error) {
    logger.warn('Failed to parse bundled plugin catalog', { error: String(error) });
    return [];
  }
}
