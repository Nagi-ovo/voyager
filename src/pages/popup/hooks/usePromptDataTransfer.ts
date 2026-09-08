import { type ChangeEvent, type RefObject, useCallback, useRef, useState } from 'react';

import { PromptImportExportService } from '@/features/backup/services/PromptImportExportService';
import type { TranslationKey } from '@/utils/translations';

export interface PromptDataTransferController {
  status: { kind: 'ok' | 'warn' | 'err'; text: string } | null;
  busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onExport: () => Promise<void>;
  onImport: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  onCloudPull: () => Promise<void>;
  onCloudPush: () => Promise<void>;
}

function isEmptyPromptImportPayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (!value || typeof value !== 'object') return false;
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) && items.length === 0;
}

/** Keep this in the popup so a hidden panel retains pending operations and their status. */
export function usePromptDataTransfer(
  t: (key: TranslationKey) => string,
): PromptDataTransferController {
  const [status, setStatus] = useState<PromptDataTransferController['status']>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onExport = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    try {
      const result = await PromptImportExportService.loadPrompts();
      if (!result.success) throw result.error;

      const prompts = result.data;
      PromptImportExportService.downloadJSON(PromptImportExportService.exportToPayload(prompts));
      setStatus({
        kind: 'ok',
        text: t('promptExportSuccess').replace('{count}', String(prompts.length)),
      });
    } catch (error) {
      console.error('[Gemini Voyager] Failed to export prompts:', error);
      setStatus({ kind: 'err', text: t('promptExportError') });
    } finally {
      setBusy(false);
    }
  }, [t]);

  const onImport = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      setBusy(true);
      setStatus(null);
      try {
        const readResult = await PromptImportExportService.readJSONFile(file);
        if (!readResult.success) throw readResult.error;

        const payloadResult = PromptImportExportService.validatePayload(readResult.data);
        if (!payloadResult.success) {
          setStatus({
            kind: 'err',
            text: isEmptyPromptImportPayload(readResult.data)
              ? t('pm_import_empty')
              : t('pm_import_invalid'),
          });
          return;
        }

        const importResult = await PromptImportExportService.importFromPayload(payloadResult.data);
        if (!importResult.success) throw importResult.error;

        const processed = importResult.data.imported + importResult.data.duplicates;
        setStatus({
          kind: importResult.data.nameConflicts > 0 ? 'warn' : 'ok',
          text:
            importResult.data.nameConflicts > 0
              ? t('promptNameConflictsDetected').replace(
                  '{count}',
                  String(importResult.data.nameConflicts),
                )
              : t('pm_import_success').replace('{count}', String(processed)),
        });
      } catch (error) {
        console.error('[Gemini Voyager] Failed to import prompts:', error);
        setStatus({ kind: 'err', text: t('promptImportError') });
      } finally {
        event.target.value = '';
        setBusy(false);
      }
    },
    [t],
  );

  // The background owns the whole prompts-only Drive merge so opening the
  // Google account picker can close the popup without abandoning the operation.
  const onCloudPull = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'gv.sync.pullPromptsMerge',
        payload: { interactive: true },
      })) as
        | {
            ok?: boolean;
            empty?: boolean;
            imported?: number;
            duplicates?: number;
            nameConflicts?: number;
          }
        | undefined;

      if (!response?.ok) {
        setStatus({ kind: 'err', text: t('promptCloudError') });
        return;
      }
      if (response.empty) {
        setStatus({ kind: 'ok', text: t('promptCloudPullEmpty') });
        return;
      }

      const processed = (response.imported ?? 0) + (response.duplicates ?? 0);
      setStatus({
        kind: (response.nameConflicts ?? 0) > 0 ? 'warn' : 'ok',
        text:
          (response.nameConflicts ?? 0) > 0
            ? t('promptNameConflictsDetected').replace(
                '{count}',
                String(response.nameConflicts ?? 0),
              )
            : t('promptCloudPullSuccess').replace('{count}', String(processed)),
      });
    } catch (error) {
      console.error('[Gemini Voyager] Failed to pull prompts from cloud:', error);
      setStatus({ kind: 'err', text: t('promptCloudError') });
    } finally {
      setBusy(false);
    }
  }, [t]);

  const onCloudPush = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'gv.sync.pushPromptsMerge',
        payload: { interactive: true },
      })) as { ok?: boolean; count?: number; nameConflicts?: number } | undefined;

      if (!response?.ok) {
        setStatus({ kind: 'err', text: t('promptCloudError') });
        return;
      }
      setStatus({
        kind: (response.nameConflicts ?? 0) > 0 ? 'warn' : 'ok',
        text:
          (response.nameConflicts ?? 0) > 0
            ? t('promptNameConflictsDetected').replace(
                '{count}',
                String(response.nameConflicts ?? 0),
              )
            : t('promptCloudPushSuccess').replace('{count}', String(response.count ?? 0)),
      });
    } catch (error) {
      console.error('[Gemini Voyager] Failed to push prompts to cloud:', error);
      setStatus({ kind: 'err', text: t('promptCloudError') });
    } finally {
      setBusy(false);
    }
  }, [t]);

  return { status, busy, inputRef, onExport, onImport, onCloudPull, onCloudPush };
}
