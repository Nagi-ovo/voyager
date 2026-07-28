/**
 * Service for importing and exporting prompt configurations
 * Follows enterprise best practices with proper validation and error handling
 * Extracted from prompt manager to follow DRY principle
 */
import { AppError, ErrorCode } from '@/core/errors/AppError';
import { type Result, StorageKeys } from '@/core/types/common';
import { getPromptNameConflictIds } from '@/core/utils/promptName';
import { EXTENSION_VERSION } from '@/core/utils/version';

import type { PromptExportPayload, PromptItem } from '../types/backup';

const EXPORT_FORMAT = 'gemini-voyager.prompts.v1' as const;

function generatePromptId(): string {
  return `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const tag of tags) {
    const normalized = String(tag).trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function normalizePromptItem(value: unknown): PromptItem | null {
  if (!value || typeof value !== 'object') return null;

  const item = value as Record<string, unknown>;
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (!text) return null;

  const prompt: PromptItem = {
    id: typeof item.id === 'string' && item.id ? item.id : generatePromptId(),
    text,
    tags: normalizeTags(item.tags),
    createdAt:
      typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
        ? item.createdAt
        : Date.now(),
  };

  if (typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)) {
    prompt.updatedAt = item.updatedAt;
  }

  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (name) prompt.name = name;

  return prompt;
}

function hasChromePromptStorage(): boolean {
  return (
    typeof chrome !== 'undefined' && !!chrome.storage?.local?.get && !!chrome.storage.local.set
  );
}

/**
 * Service for handling prompt import/export operations
 */
export class PromptImportExportService {
  /**
   * Export prompt data to a JSON payload
   * Uses centralized version management to ensure consistency
   */
  static exportToPayload(items: PromptItem[]): PromptExportPayload {
    return {
      format: EXPORT_FORMAT,
      exportedAt: new Date().toISOString(),
      version: EXTENSION_VERSION,
      items,
    };
  }

  /**
   * Validate import payload format and structure
   */
  static validatePayload(payload: unknown): Result<PromptExportPayload> {
    let rawItems: unknown[] | null = null;

    if (Array.isArray(payload)) {
      rawItems = payload;
    } else if (payload && typeof payload === 'object') {
      const p = payload as Record<string, unknown>;
      if (p.format !== EXPORT_FORMAT && !Array.isArray(p.items)) {
        return {
          success: false,
          error: new AppError(
            ErrorCode.VALIDATION_ERROR,
            `Unsupported format: expected "${EXPORT_FORMAT}", got "${p.format}"`,
            { format: p.format },
          ),
        };
      }
      rawItems = Array.isArray(p.items) ? p.items : [];
    } else {
      return {
        success: false,
        error: new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid payload: expected an object', {
          payload,
        }),
      };
    }

    if (rawItems.length === 0) {
      return {
        success: false,
        error: new AppError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid "items" field: expected a non-empty array',
          { items: rawItems },
        ),
      };
    }

    const items = rawItems.map(normalizePromptItem).filter((item): item is PromptItem => !!item);
    if (items.length === 0) {
      return {
        success: false,
        error: new AppError(ErrorCode.VALIDATION_ERROR, 'Import file contains no valid prompts', {
          items: rawItems,
        }),
      };
    }

    return {
      success: true,
      data: this.exportToPayload(items),
    };
  }

  /**
   * Load prompts from localStorage
   */
  static async loadPrompts(): Promise<Result<PromptItem[]>> {
    try {
      if (!hasChromePromptStorage()) {
        const raw = localStorage.getItem(StorageKeys.PROMPT_ITEMS);
        if (raw === null) {
          return {
            success: true,
            data: [],
          };
        }

        const localItems = JSON.parse(raw) as PromptItem[];
        return {
          success: true,
          data: Array.isArray(localItems) ? localItems : [],
        };
      }

      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        chrome.storage.local.get([StorageKeys.PROMPT_ITEMS], (items) => {
          if (chrome.runtime?.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(items);
        });
      });

      const items = result[StorageKeys.PROMPT_ITEMS];
      return {
        success: true,
        data: Array.isArray(items) ? items : [],
      };
    } catch (error) {
      return {
        success: false,
        error: new AppError(
          ErrorCode.STORAGE_READ_FAILED,
          'Failed to load prompts from extension storage',
          { key: StorageKeys.PROMPT_ITEMS },
          error instanceof Error ? error : undefined,
        ),
      };
    }
  }

  /**
   * Save prompts to localStorage
   */
  static async savePrompts(items: PromptItem[]): Promise<Result<void>> {
    try {
      if (!hasChromePromptStorage()) {
        localStorage.setItem(StorageKeys.PROMPT_ITEMS, JSON.stringify(items));
        return {
          success: true,
          data: undefined,
        };
      }

      await new Promise<void>((resolve, reject) => {
        chrome.storage.local.set({ [StorageKeys.PROMPT_ITEMS]: items }, () => {
          if (chrome.runtime?.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      });

      return {
        success: true,
        data: undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: new AppError(
          ErrorCode.STORAGE_WRITE_FAILED,
          'Failed to save prompts to extension storage',
          { key: StorageKeys.PROMPT_ITEMS, itemCount: items.length },
          error instanceof Error ? error : undefined,
        ),
      };
    }
  }

  /**
   * Generate filename for export with timestamp
   */
  static generateExportFilename(): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    return `gemini-voyager-prompts-${y}${m}${day}-${hh}${mm}${ss}.json`;
  }

  /**
   * Export prompts to JSON string
   */
  static async exportToJSON(): Promise<Result<string>> {
    const result = await this.loadPrompts();
    if (!result.success) {
      return result;
    }

    const payload = this.exportToPayload(result.data);
    return {
      success: true,
      data: JSON.stringify(payload, null, 2),
    };
  }

  /**
   * Import prompts from payload
   * Merges with existing prompts (deduplicates by text)
   * @param payload - The import payload
   * @returns Result with import statistics
   */
  static async importFromPayload(payload: PromptExportPayload): Promise<
    Result<{
      imported: number;
      duplicates: number;
      nameConflicts: number;
      total: number;
    }>
  > {
    try {
      // Load existing prompts
      const loadResult = await this.loadPrompts();
      if (!loadResult.success) {
        return loadResult;
      }

      const mergedItems = [...loadResult.data];
      const importItems = payload.items;

      // Index one merge target per body without using the map as the final
      // collection. Historical stores may themselves contain duplicates and
      // must never be collapsed by a later import.
      const existingByText = new Map<string, PromptItem>();
      const existingById = new Map<string, PromptItem>();
      for (const item of mergedItems) {
        const key = item.text.toLowerCase();
        if (!existingByText.has(key)) existingByText.set(key, item);
        if (!existingById.has(item.id)) existingById.set(item.id, item);
      }

      let imported = 0;
      let duplicates = 0;

      for (const item of importItems) {
        const key = item.text.toLowerCase();
        const existingWithId = existingById.get(item.id);
        const existing = existingWithId ?? existingByText.get(key);
        if (existing) {
          // Merge tags if duplicate
          const mergedTags = Array.from(new Set([...(existing.tags || []), ...(item.tags || [])]));
          existing.tags = mergedTags;
          const incomingTime = item.updatedAt || item.createdAt || 0;
          const existingTime = existing.updatedAt || existing.createdAt || 0;
          const shouldApplySameIdUpdate =
            existingWithId === existing && incomingTime > existingTime;

          if (item.name && (shouldApplySameIdUpdate || !existing.name)) {
            existing.name = item.name;
          }

          if (shouldApplySameIdUpdate) {
            existing.text = item.text;
            existingByText.clear();
            for (const mergedItem of mergedItems) {
              const mergedKey = mergedItem.text.toLowerCase();
              if (!existingByText.has(mergedKey)) {
                existingByText.set(mergedKey, mergedItem);
              }
            }
          }
          existing.updatedAt = Date.now();
          duplicates++;
        } else {
          const importedItem = {
            ...item,
            createdAt: Date.now(),
          };
          existingByText.set(key, importedItem);
          existingById.set(importedItem.id, importedItem);
          mergedItems.push(importedItem);
          imported++;
        }
      }

      // Save merged results
      mergedItems.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const nameConflicts = getPromptNameConflictIds(mergedItems).size;

      const saveResult = await this.savePrompts(mergedItems);
      if (!saveResult.success) {
        return saveResult;
      }

      return {
        success: true,
        data: {
          imported,
          duplicates,
          nameConflicts,
          total: mergedItems.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: new AppError(
          ErrorCode.UNKNOWN_ERROR,
          'Failed to import prompts',
          { payload },
          error instanceof Error ? error : undefined,
        ),
      };
    }
  }

  /**
   * Download JSON file to user's computer
   */
  static downloadJSON(payload: PromptExportPayload, filename?: string): void {
    const data = JSON.stringify(payload, null, 2);
    const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || this.generateExportFilename();
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try {
        document.body.removeChild(a);
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(url);
    }, 0);
  }

  /**
   * Read and parse JSON file from user upload
   */
  static async readJSONFile(file: File): Promise<Result<unknown>> {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      return {
        success: true,
        data: parsed,
      };
    } catch (error) {
      return {
        success: false,
        error: new AppError(
          ErrorCode.VALIDATION_ERROR,
          'Failed to parse JSON file',
          { fileName: file.name },
          error instanceof Error ? error : undefined,
        ),
      };
    }
  }
}
