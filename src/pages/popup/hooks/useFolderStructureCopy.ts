import { useCallback, useEffect, useRef, useState } from 'react';

import browser from 'webextension-polyfill';

import type { ConversationReference, Folder } from '@/core/types/folder';

import type { AiStructureCopyStatus } from '../components/FolderSettingsCard';
import { formatFolderStructurePrompt } from '../utils/folderStructurePrompt';

export function useFolderStructureCopy(language: string, sourceTabId?: number) {
  const [status, setStatus] = useState<AiStructureCopyStatus>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const operation = useRef(0);

  const clearResetTimer = useCallback(() => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = null;
  }, []);

  useEffect(() => {
    setStatus('idle');
    return () => {
      operation.current += 1;
      clearResetTimer();
    };
  }, [sourceTabId, clearResetTimer]);

  const onCopy = useCallback(async () => {
    const currentOperation = ++operation.current;
    clearResetTimer();
    setStatus('loading');
    const finish = (next: AiStructureCopyStatus, resetAfter?: number) => {
      if (currentOperation !== operation.current) return;
      setStatus(next);
      if (resetAfter)
        resetTimer.current = setTimeout(() => {
          resetTimer.current = null;
          setStatus('idle');
        }, resetAfter);
    };
    try {
      const tabId =
        typeof sourceTabId === 'number'
          ? sourceTabId
          : (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      if (!tabId) {
        finish('error');
        return;
      }
      const response = (await browser.tabs.sendMessage(tabId, {
        type: 'gv.folders.getStructureForAI',
      })) as {
        ok: boolean;
        sidebarConversations: Array<{ id: string; title: string; url: string }>;
        folderData: { folders: Folder[]; folderContents: Record<string, ConversationReference[]> };
      };
      if (currentOperation !== operation.current) return;
      if (!response?.ok) {
        finish('error');
        return;
      }
      const { sidebarConversations, folderData } = response;
      if (!sidebarConversations?.length) {
        finish('empty', 4000);
        return;
      }
      await navigator.clipboard.writeText(
        formatFolderStructurePrompt(sidebarConversations, folderData, language),
      );
      finish('copied', 2000);
    } catch {
      finish('error', 2000);
    }
  }, [language, sourceTabId, clearResetTimer]);

  return { status, onCopy };
}
