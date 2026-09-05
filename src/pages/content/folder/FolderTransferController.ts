import browser from 'webextension-polyfill';

import {
  type AccountScope,
  accountIsolationService,
  detectAccountContextFromDocument,
} from '@/core/services/AccountIsolationService';
import type { PromptItem, SyncAccountScope } from '@/core/types/sync';
import { FolderImportExportService } from '@/features/folder/services/FolderImportExportService';
import type { ImportStrategy } from '@/features/folder/types/import-export';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';
import { mergeFolderData, mergePrompts, mergeTimelineHierarchy } from '@/utils/merge';

import {
  getTimelineHierarchyStorageKey,
  getTimelineHierarchyStorageKeysToRead,
  resolveTimelineHierarchyDataForStorageScope,
} from '../timeline/hierarchyStorage';
import type { TimelineHierarchyData } from '../timeline/hierarchyTypes';
import { type FolderDataSession, cloneFolderData } from './FolderDataSession';
import type { FolderData } from './types';

type TransferContext = {
  session: FolderDataSession | null;
  // A session may be retained across A -> B -> A; identity alone is insufficient.
  activation: number;
  data: FolderData;
};

interface FolderTransferHost {
  getContext(): TransferContext;
  applyData(data: FolderData): Promise<boolean>;
  refresh(): void;
  notify(message: string, type?: 'success' | 'error' | 'info'): void;
}

type ImportSource = { text: string } | { file: File | null };

/** Owns import UI and transfers; delayed results remain bound to their account activation. */
export class FolderTransferController {
  private importInProgress = false;
  private exportInProgress = false;
  private activeImportDialog: HTMLElement | null = null;

  constructor(private readonly host: FolderTransferHost) {}

  private isCurrent(context: TransferContext): boolean {
    const current = this.host.getContext();
    return current.session === context.session && current.activation === context.activation;
  }

  private debug(...args: unknown[]): void {
    try {
      if (localStorage.getItem('gvFolderDebug') === '1') console.log('[FolderTransfer]', ...args);
    } catch {
      // Debug storage may be unavailable in private browsing.
    }
  }

  async import(source: ImportSource, strategy: ImportStrategy): Promise<boolean> {
    const context = this.host.getContext();
    const { session } = context;
    if (!session?.ready) return false;
    if (this.importInProgress) {
      this.host.notify(t('folder_import_in_progress') || 'Import already in progress', 'info');
      return false;
    }

    this.importInProgress = true;
    try {
      let parsed: ReturnType<typeof FolderImportExportService.parseJSONText>;
      if ('text' in source) {
        parsed = FolderImportExportService.parseJSONText(source.text);
        if (!parsed.success) {
          this.host.notify(t('folder_import_invalid_format'), 'error');
          return false;
        }
        if (strategy === 'overwrite' && !window.confirm(t('folder_import_confirm_overwrite')))
          return false;
      } else {
        if (!source.file) {
          this.host.notify(t('folder_import_select_file'), 'error');
          return false;
        }
        if (strategy === 'overwrite' && !window.confirm(t('folder_import_confirm_overwrite')))
          return false;
        parsed = await FolderImportExportService.readJSONFile(source.file);
        if (!this.isCurrent(context)) return false;
        if (!parsed.success) {
          this.host.notify(t('folder_import_invalid_format'), 'error');
          return false;
        }
      }

      const validated = FolderImportExportService.validatePayload(parsed.data);
      if (!validated.success) {
        this.host.notify(
          `${t('folder_import_invalid_format')}: ${validated.error.message}`,
          'error',
        );
        return false;
      }
      const result = await FolderImportExportService.importFromPayload(
        validated.data,
        cloneFolderData(session.data),
        { strategy, createBackup: true },
      );
      if (!this.isCurrent(context)) return false;
      if (!result.success) {
        this.host.notify(
          t('folder_import_error').replace('{error}', String(result.error)),
          'error',
        );
        return false;
      }

      const saved = await this.host.applyData(result.data.data);
      if (!this.isCurrent(context)) return false;
      if (!saved) {
        this.host.notify(t('folder_save_error'), 'error');
        return false;
      }
      this.host.refresh();
      const stats = result.data.stats;
      const skipped =
        (stats.duplicatesFoldersSkipped || 0) + (stats.duplicatesConversationsSkipped || 0);
      const message = t(
        strategy === 'merge' && skipped > 0
          ? 'folder_import_success_skipped'
          : 'folder_import_success',
      )
        .replace('{folders}', String(stats.foldersImported))
        .replace('{conversations}', String(stats.conversationsImported))
        .replace('{skipped}', String(skipped));
      this.host.notify(message, 'success');
      return true;
    } catch (error) {
      console.error('[FolderTransfer] Import failed:', error);
      if (this.isCurrent(context)) {
        this.host.notify(t('folder_import_error').replace('{error}', String(error)), 'error');
      }
      return false;
    } finally {
      this.importInProgress = false;
    }
  }

  exportFolders(): void {
    // Prevent concurrent exports
    if (this.exportInProgress) {
      this.host.notify(t('folder_export_in_progress') || 'Export already in progress', 'info');
      return;
    }

    this.exportInProgress = true;

    try {
      const payload = FolderImportExportService.exportToPayload(this.host.getContext().data);
      FolderImportExportService.downloadJSON(payload);
      this.host.notify(t('folder_export_success'), 'success');
      this.debug('Folders exported successfully');
    } catch (error) {
      console.error('[FolderTransfer] Export error:', error);
      this.host.notify(t('folder_import_error').replace('{error}', String(error)), 'error');
    } finally {
      // Always release the lock
      this.exportInProgress = false;
    }
  }

  showImportDialog(): void {
    if (this.activeImportDialog && !this.activeImportDialog.isConnected) {
      this.activeImportDialog = null;
    }

    // Prevent creating multiple import dialogs simultaneously
    if (this.activeImportDialog) return;

    // Create dialog overlay
    const overlay = document.createElement('div');
    overlay.className = 'gv-folder-dialog-overlay';

    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = 'gv-folder-import-dialog';

    // Dialog title
    const dialogTitle = document.createElement('div');
    dialogTitle.className = 'gv-folder-dialog-title';
    dialogTitle.textContent = t('folder_import_title');

    // Strategy selection
    const strategyContainer = document.createElement('div');
    strategyContainer.className = 'gv-folder-import-strategy';

    const strategyLabel = document.createElement('div');
    strategyLabel.className = 'gv-folder-import-strategy-label';
    strategyLabel.textContent = t('folder_import_strategy');

    const strategyOptions = document.createElement('div');
    strategyOptions.className = 'gv-folder-import-strategy-options';

    const mergeOption = this.createRadioOption('merge', t('folder_import_merge'), true);
    const overwriteOption = this.createRadioOption(
      'overwrite',
      t('folder_import_overwrite'),
      false,
    );

    strategyOptions.appendChild(mergeOption);
    strategyOptions.appendChild(overwriteOption);

    strategyContainer.appendChild(strategyLabel);
    strategyContainer.appendChild(strategyOptions);

    // File input
    const fileInputContainer = document.createElement('div');
    fileInputContainer.className = 'gv-folder-import-file-input';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';

    const fileButton = document.createElement('button');
    fileButton.className = 'gv-folder-import-file-button';
    fileButton.textContent = t('folder_import_select_file');
    fileButton.addEventListener('click', () => fileInput.click());

    const fileName = document.createElement('div');
    fileName.className = 'gv-folder-import-file-name';
    fileName.textContent = '';

    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        fileName.textContent = fileInput.files[0].name;
      }
    });

    fileInputContainer.appendChild(fileInput);
    fileInputContainer.appendChild(fileButton);
    fileInputContainer.appendChild(fileName);

    // Paste JSON section
    const pasteContainer = document.createElement('div');
    pasteContainer.className = 'gv-folder-import-paste-container';

    const pasteToggleBtn = document.createElement('button');
    pasteToggleBtn.className = 'gv-folder-import-paste-toggle';
    pasteToggleBtn.textContent = t('folder_import_paste_json');
    let pasteExpanded = false;

    const pasteArea = document.createElement('textarea');
    pasteArea.className = 'gv-folder-import-paste-area';
    pasteArea.placeholder = t('folder_import_paste_placeholder');
    pasteArea.style.display = 'none';

    pasteToggleBtn.addEventListener('click', () => {
      pasteExpanded = !pasteExpanded;
      pasteArea.style.display = pasteExpanded ? 'block' : 'none';
      pasteToggleBtn.classList.toggle('gv-folder-import-paste-toggle-active', pasteExpanded);
    });

    pasteContainer.appendChild(pasteToggleBtn);
    pasteContainer.appendChild(pasteArea);

    // Buttons
    const buttonsContainer = document.createElement('div');
    buttonsContainer.className = 'gv-folder-dialog-buttons';

    const importBtn = document.createElement('button');
    importBtn.className = 'gv-folder-dialog-btn gv-folder-dialog-btn-primary';
    importBtn.textContent = t('pm_import');
    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      const strategy = (mergeOption.querySelector('input') as HTMLInputElement).checked
        ? 'merge'
        : 'overwrite';
      const pasteText = pasteArea.value.trim();
      const saved = await this.import(
        pasteText ? { text: pasteText } : { file: fileInput.files?.[0] ?? null },
        strategy,
      );
      if (saved && this.activeImportDialog === overlay) this.closeImportDialog();
      else importBtn.disabled = false;
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'gv-folder-dialog-btn gv-folder-dialog-btn-secondary';
    cancelBtn.textContent = t('pm_cancel');
    cancelBtn.addEventListener('click', () => {
      this.closeImportDialog();
    });

    buttonsContainer.appendChild(cancelBtn);
    buttonsContainer.appendChild(importBtn);

    // Assemble dialog
    dialog.appendChild(dialogTitle);
    dialog.appendChild(strategyContainer);
    dialog.appendChild(fileInputContainer);
    dialog.appendChild(pasteContainer);
    dialog.appendChild(buttonsContainer);
    overlay.appendChild(dialog);

    // Add to body
    document.body.appendChild(overlay);

    // Track this dialog as the active one
    this.activeImportDialog = overlay;

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        this.closeImportDialog();
      }
    });
  }

  private createRadioOption(value: string, label: string, checked: boolean): HTMLElement {
    const container = document.createElement('label');
    container.className = 'gv-folder-import-radio-option';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'import-strategy';
    radio.value = value;
    radio.checked = checked;

    const labelText = document.createElement('span');
    labelText.textContent = label;

    container.appendChild(radio);
    container.appendChild(labelText);

    return container;
  }

  closeImportDialog(): void {
    if (this.activeImportDialog) {
      this.activeImportDialog.remove();
      this.activeImportDialog = null;
    }
  }

  async upload(): Promise<void> {
    const context = this.host.getContext();
    const { session } = context;
    if (!session?.ready) return;
    const accountScope = this.toSyncAccountScope(session.accountScope);
    const folders = cloneFolderData(session.data);
    try {
      this.host.notify(t('uploadInProgress'), 'info');
      const timelineHierarchyAccountScope = await this.resolveTimelineHierarchySyncScope();
      if (!this.isCurrent(context)) return;

      // Get prompts from storage
      let prompts: PromptItem[] = [];
      try {
        const storageResult = await chrome.storage.local.get(['gvPromptItems']);
        if (storageResult.gvPromptItems) {
          prompts = storageResult.gvPromptItems as PromptItem[];
        }
      } catch (err) {
        console.warn('[FolderTransfer] Could not get prompts for upload:', err);
      }
      if (!this.isCurrent(context)) return;

      this.debug(
        `Uploading - folders: ${folders.folders?.length || 0}, prompts: ${prompts.length}`,
      );

      // Send upload request to background script
      // Background script will also fetch starred messages for Gemini platform
      const response = (await browser.runtime.sendMessage({
        type: 'gv.sync.upload',
        payload: {
          folders,
          prompts,
          platform: 'gemini',
          accountScope,
          timelineHierarchyAccountScope,
        },
      })) as { ok?: boolean; error?: string } | undefined;

      if (response?.ok) {
        this.host.notify(t('uploadSuccess'), 'success');
      } else {
        const errorMsg = response?.error || 'Unknown error';
        this.host.notify(t('syncError').replace('{error}', errorMsg), 'error');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[FolderTransfer] Cloud upload failed:', error);
      this.host.notify(t('syncError').replace('{error}', errorMsg), 'error');
    }
  }

  async sync(): Promise<void> {
    const context = this.host.getContext();
    const { session } = context;
    if (!session?.ready) return;
    const accountScope = this.toSyncAccountScope(session.accountScope);
    try {
      this.host.notify(t('downloadInProgress'), 'info');
      const timelineHierarchyAccountScope = await this.resolveTimelineHierarchySyncScope();
      if (!this.isCurrent(context)) return;
      const timelineHierarchyStorageKey = getTimelineHierarchyStorageKey(
        timelineHierarchyAccountScope?.accountKey,
      );

      // Send download request to background script
      const response = (await browser.runtime.sendMessage({
        type: 'gv.sync.download',
        payload: {
          platform: 'gemini',
          accountScope,
          timelineHierarchyAccountScope,
        },
      })) as
        | {
            ok?: boolean;
            error?: string;
            highlights?: { synced?: boolean; count?: number; empty?: boolean };
            data?: {
              folders?: { data?: FolderData };
              prompts?: { items?: PromptItem[] };
              starred?: { data?: { messages: Record<string, unknown[]> } };
              timelineHierarchy?: { data?: TimelineHierarchyData };
            };
          }
        | undefined;

      if (!this.isCurrent(context)) return;
      if (!response?.ok) {
        const errorMsg = response?.error || 'Download failed';
        this.host.notify(t('syncError').replace('{error}', errorMsg), 'error');
        return;
      }

      if (!response.data) {
        if (response.highlights?.synced) {
          this.host.notify(t('syncSuccess'), 'success');
          return;
        }
        this.host.notify(t('syncNoData') || 'No data in cloud', 'info');
        return;
      }

      // Extract cloud data
      const cloudFoldersPayload = response.data?.folders;
      const cloudPromptsPayload = response.data?.prompts;
      const cloudStarredPayload = response.data?.starred;
      const cloudTimelineHierarchyPayload = response.data?.timelineHierarchy;
      const cloudFolderData = cloudFoldersPayload?.data || { folders: [], folderContents: {} };
      const cloudPromptItems = cloudPromptsPayload?.items || [];
      const cloudStarredData = cloudStarredPayload?.data || { messages: {} };
      const cloudTimelineHierarchyData = cloudTimelineHierarchyPayload?.data || {
        conversations: {},
      };

      this.debug(
        `Downloaded - folders: ${cloudFolderData.folders?.length || 0}, prompts: ${cloudPromptItems.length}, starred conversations: ${Object.keys(cloudStarredData.messages || {}).length}`,
      );

      // Get local prompts for merge
      let localPrompts: PromptItem[] = [];
      try {
        const storageResult = await chrome.storage.local.get(['gvPromptItems']);
        if (storageResult.gvPromptItems) {
          localPrompts = storageResult.gvPromptItems as PromptItem[];
        }
      } catch (err) {
        console.warn('[FolderTransfer] Could not get local prompts for merge:', err);
      }

      // Get local starred messages for merge
      let localStarred = { messages: {} as Record<string, unknown[]> };
      try {
        const starredResult = await chrome.storage.local.get(['geminiTimelineStarredMessages']);
        const starredData = starredResult.geminiTimelineStarredMessages;
        if (
          typeof starredData === 'object' &&
          starredData !== null &&
          'messages' in starredData &&
          typeof starredData.messages === 'object' &&
          starredData.messages !== null
        ) {
          localStarred = { messages: starredData.messages as Record<string, unknown[]> };
        }
      } catch (err) {
        console.warn('[FolderTransfer] Could not get local starred messages for merge:', err);
      }

      let localTimelineHierarchy: TimelineHierarchyData = { conversations: {} };
      try {
        const hierarchyResult = (await chrome.storage.local.get(
          getTimelineHierarchyStorageKeysToRead(timelineHierarchyAccountScope?.accountKey),
        )) as Record<string, unknown>;
        localTimelineHierarchy = resolveTimelineHierarchyDataForStorageScope(
          hierarchyResult,
          timelineHierarchyAccountScope?.accountKey,
          timelineHierarchyAccountScope?.routeUserId ?? null,
        );
      } catch (err) {
        console.warn('[FolderTransfer] Could not get local timeline hierarchy for merge:', err);
      }
      if (!this.isCurrent(context)) return;

      // Merge folder data
      const localFolders = this.host.getContext().data;
      const mergedFolders = mergeFolderData(localFolders, cloudFolderData);

      // Merge prompts (simple ID-based merge)
      const mergedPrompts = mergePrompts(localPrompts, cloudPromptItems);

      // Merge starred messages
      const mergedStarred = this.mergeStarredMessages(localStarred, cloudStarredData);
      const mergedTimelineHierarchy = mergeTimelineHierarchy(
        localTimelineHierarchy,
        cloudTimelineHierarchyData,
      );

      this.debug(
        `Merged - folders: ${mergedFolders.folders?.length || 0}, prompts: ${mergedPrompts.length}, starred conversations: ${Object.keys(mergedStarred.messages || {}).length}, hierarchy conversations: ${Object.keys(mergedTimelineHierarchy.conversations || {}).length}`,
      );

      // Apply merged folder data
      const saved = await this.host.applyData(mergedFolders);
      if (!this.isCurrent(context)) return;
      if (!saved) {
        this.host.notify(t('folder_save_error'), 'error');
        return;
      }

      // Save merged prompts and starred to storage
      await chrome.storage.local.set({
        gvPromptItems: mergedPrompts,
        geminiTimelineStarredMessages: mergedStarred,
        [timelineHierarchyStorageKey]: mergedTimelineHierarchy,
      });
      if (!this.isCurrent(context)) return;

      this.host.refresh();
      this.host.notify(t('downloadMergeSuccess'), 'success');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[FolderTransfer] Cloud sync failed:', error);
      if (this.isCurrent(context)) {
        this.host.notify(t('syncError').replace('{error}', errorMsg), 'error');
      }
    }
  }

  private mergeStarredMessages(
    local: { messages: Record<string, unknown[]> },
    cloud: { messages: Record<string, unknown[]> },
  ): { messages: Record<string, unknown[]> } {
    const localMessages = local?.messages || {};
    const cloudMessages = cloud?.messages || {};

    const allConversationIds = new Set([
      ...Object.keys(localMessages),
      ...Object.keys(cloudMessages),
    ]);

    const mergedMessages: Record<string, unknown[]> = {};

    allConversationIds.forEach((conversationId) => {
      const localConvoMessages = localMessages[conversationId] || [];
      const cloudConvoMessages = cloudMessages[conversationId] || [];

      type StarredMsg = { turnId?: string; starredAt?: number };
      const messageMap = new Map<string, unknown>();

      // Add cloud messages first
      cloudConvoMessages.forEach((m) => {
        const msg = m as StarredMsg;
        if (msg?.turnId) messageMap.set(msg.turnId, m);
      });

      // Merge local messages - prefer newer starredAt
      localConvoMessages.forEach((m) => {
        const localMsg = m as StarredMsg;
        if (!localMsg?.turnId) return;
        const existingMsg = messageMap.get(localMsg.turnId) as StarredMsg | undefined;
        if (!existingMsg) {
          messageMap.set(localMsg.turnId, m);
        } else if ((localMsg.starredAt || 0) >= (existingMsg.starredAt || 0)) {
          messageMap.set(localMsg.turnId, m);
        }
      });

      const mergedArray = Array.from(messageMap.values());
      if (mergedArray.length > 0) {
        mergedMessages[conversationId] = mergedArray;
      }
    });

    return { messages: mergedMessages };
  }

  async getUploadTooltip(): Promise<string> {
    try {
      const response = (await browser.runtime.sendMessage({ type: 'gv.sync.getState' })) as
        | { ok?: boolean; state?: { lastUploadTime?: number | null } }
        | undefined;
      if (response?.ok && response.state) {
        const lastUploadTime = response.state.lastUploadTime;
        const timeStr = this.formatRelativeTime(lastUploadTime ?? null);
        const baseTooltip = t('folder_cloud_upload');
        return lastUploadTime
          ? `${baseTooltip}\n${t('lastUploaded').replace('{time}', timeStr)}`
          : `${baseTooltip}\n${t('neverUploaded')}`;
      }
    } catch (e) {
      console.warn('[FolderTransfer] Failed to get sync state for tooltip:', e);
    }
    return t('folder_cloud_upload');
  }

  async getSyncTooltip(): Promise<string> {
    try {
      const response = (await browser.runtime.sendMessage({ type: 'gv.sync.getState' })) as
        | { ok?: boolean; state?: { lastSyncTime?: number | null } }
        | undefined;
      if (response?.ok && response.state) {
        const lastSyncTime = response.state.lastSyncTime;
        const timeStr = this.formatRelativeTime(lastSyncTime ?? null);
        const baseTooltip = t('folder_cloud_sync');
        return lastSyncTime
          ? `${baseTooltip}\n${t('lastSynced').replace('{time}', timeStr)}`
          : `${baseTooltip}\n${t('neverSynced')}`;
      }
    } catch (e) {
      console.warn('[FolderTransfer] Failed to get sync state for tooltip:', e);
    }
    return t('folder_cloud_sync');
  }

  private formatRelativeTime(timestamp: number | null): string {
    if (!timestamp) return '';
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) {
      return t('justNow');
    } else if (diffMins < 60) {
      return `${diffMins} ${t('minutesAgo')}`;
    } else if (diffHours < 24) {
      return `${diffHours} ${t('hoursAgo')}`;
    } else if (diffDays === 1) {
      return t('yesterday');
    } else {
      return new Date(timestamp).toLocaleDateString();
    }
  }

  private toSyncAccountScope(scope: AccountScope | null): SyncAccountScope | undefined {
    if (!scope) return undefined;
    return {
      accountKey: scope.accountKey,
      accountId: scope.accountId,
      routeUserId: scope.routeUserId,
    };
  }

  private async resolveTimelineHierarchySyncScope(): Promise<SyncAccountScope | undefined> {
    try {
      const context = detectAccountContextFromDocument(window.location.href, document);
      if (!context.routeUserId && !context.email) {
        return undefined;
      }

      const scope = await accountIsolationService.resolveAccountScope({
        pageUrl: window.location.href,
        routeUserId: context.routeUserId,
        email: context.email,
      });

      return this.toSyncAccountScope(scope);
    } catch (error) {
      console.warn('[FolderTransfer] Failed to resolve timeline hierarchy sync scope:', error);
      return undefined;
    }
  }
}
