import { vi } from 'vitest';
import browser from 'webextension-polyfill';

import { accountIsolationService } from '@/core/services/AccountIsolationService';

import { FolderFeedback } from '../FolderFeedback';
import { FolderNavigation } from '../FolderNavigation';
import { FolderSelection } from '../FolderSelection';
import { FolderSidebarRuntime } from '../FolderSidebarRuntime';
import { FolderStore, type FolderStoreChange } from '../FolderStore';
import { FolderTransferController } from '../FolderTransferController';
import { FolderTreeView } from '../FolderTreeView';
import { NativeConversationMenus } from '../NativeConversationMenus';
import { NativeSidebarObserver } from '../NativeSidebarObserver';
import { createFolderDialogs } from '../folderDialogs';
import { createFolderHeaderMenus } from '../headerMenus';
import type { IFolderStorageAdapter } from '../storage/FolderStorageAdapter';
import type { FolderData } from '../types';
import { mountSidebar, setLayout } from './sidebarRuntimeHarness';

/** Compose the production owners with memory storage; suites control browser mocks themselves. */
export async function createFolderViewHarness(data: FolderData) {
  let saved = structuredClone(data);
  let destroyed = false;
  const context = { enabled: true, hideArchivedConversations: false, isDestroyed: false };
  const adapter: IFolderStorageAdapter = {
    init: vi.fn(async () => {}),
    loadData: vi.fn(async () => structuredClone(saved)),
    saveData: vi.fn(async (_key, value) => {
      saved = structuredClone(value);
      return true;
    }),
    removeData: vi.fn(async () => {
      saved = { folders: [], folderContents: {} };
    }),
    getBackendName: () => 'test-memory',
  };
  let treeView: FolderTreeView;
  let runtime: FolderSidebarRuntime;
  let selection: FolderSelection;
  const onRefresh = vi.fn(() => {
    if (!runtime.panel) return;
    treeView.render();
    store.flushTitleUpdates();
  });
  const onChange = vi.fn((reason: FolderStoreChange) => {
    if (destroyed) return;
    treeView.updateAvailability();
    if (reason === 'account') {
      nativeSidebar.clearTitleSync();
      treeView.clearRenderContext();
      navigation.cancel();
      dialogs.closeAll();
      headerMenus.close();
      transfer.closeImportDialog();
      selection.reset();
      treeView.render();
    } else if (reason === 'data') {
      onRefresh();
    } else if (reason === 'title') {
      treeView.render();
    } else if (reason === 'activity' && treeView.viewMode === 'activity') {
      onRefresh();
    }
  });
  const store = new FolderStore(
    {
      getContext: () => ({
        sidebar: runtime.sidebar,
        sortMode: treeView.sortMode,
        enabled: context.enabled,
      }),
      onChange,
      onArchive: vi.fn(),
      onRecovery: vi.fn(),
    },
    adapter,
  );
  const dialogs = createFolderDialogs();
  const feedback = new FolderFeedback();
  const headerMenus = createFolderHeaderMenus();
  const navigation = new FolderNavigation({
    getContext: () => ({
      container: runtime.panel,
      sidebar: runtime.sidebar,
      isDestroyed: destroyed,
      accountIsolationEnabled: store.accountIsolationEnabled,
    }),
    onRouteChange: () => {},
    onOpened: (id) => store.markConversationAsRecentlyOpened(id),
    onTitleChange: (id, title) => store.updateConversationTitle(id, title),
    onGemDetected: (id, gemId) => store.updateConversationGem(id, gemId),
  });
  const nativeMenus = new NativeConversationMenus({
    getContext: () => ({
      sidebar: runtime.sidebar,
      storageKey: store.storageKey,
      accountIsolationEnabled: store.accountIsolationEnabled,
      isDestroyed: destroyed,
    }),
    onMoveToFolder: ({ id, title, url }) =>
      dialogs.openMove(store.data.folders, (folderId) =>
        store.addConversationToFolderFromNative(folderId, id, title, url),
      ),
    onConfirmedDelete: (id) => store.removeConversationFromAllFolders(id),
  });
  const nativeSidebar = new NativeSidebarObserver({
    isDestroyed: () => destroyed,
    enhanceConversation: (row) => selection.makeConversationDraggable(row),
    hasStoredConversations: () => store.hasStoredConversations(),
    onTitlesChanged: () => store.syncConversationTitlesFromNative(),
  });
  const floating = { isOpen: () => false, open: vi.fn(async () => {}), close: vi.fn() };
  runtime = new FolderSidebarRuntime({
    createPanel: () => {
      const panel = treeView.createPanel();
      setLayout(panel, 280, 200);
      return panel;
    },
    onPanelMount: () => {
      treeView.mount();
      selection.mount();
      navigation.highlightActiveConversation();
      navigation.bind();
    },
    onPanelUnmount: () => {
      treeView.unmount();
      selection.unmount();
      navigation.unbind();
      feedback.hideTooltip();
      dialogs.closeAll();
      headerMenus.close();
      transfer.closeImportDialog();
    },
    nativeSidebar,
    nativeMenus,
    floating,
  });
  selection = new FolderSelection({
    store,
    runtime,
    navigation,
    feedback,
    nativeMenus,
    getContext: () => ({
      sortMode: treeView.sortMode,
      accountIsolationEnabled: store.accountIsolationEnabled,
      isDestroyed: destroyed,
    }),
  });
  const transfer = new FolderTransferController({
    getContext: () => ({ session: store.session, activation: store.activation, data: store.data }),
    applyData: async (next) => {
      if (!store.canEdit) return false;
      store.data = next;
      return store.saveData();
    },
    refresh: () => onRefresh(),
    notify: (message, type) => feedback.showNotification(message, type),
  });
  const onRenameNative = vi.fn(async () => true);
  treeView = new FolderTreeView({
    store,
    runtime,
    selection,
    navigation,
    feedback,
    dialogs,
    transfer,
    headerMenus,
    getContext: () => context,
    onRefresh,
    onRenameNative,
    onSortModeChange: () => {},
  });
  vi.spyOn(accountIsolationService, 'isIsolationEnabled').mockResolvedValue(false);
  await store.init();
  await treeView.loadSettings();
  const sidebar = mountSidebar();
  await runtime.start('sidebar');
  onChange.mockClear();
  return {
    store,
    adapter,
    treeView,
    runtime,
    selection,
    navigation,
    dialogs,
    transfer,
    feedback,
    headerMenus,
    nativeMenus,
    nativeSidebar,
    onChange,
    onRefresh,
    onRenameNative,
    context,
    sidebar,
    get saved() {
      return saved;
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = context.isDestroyed = true;
      runtime.stop();
      selection.reset();
      navigation.destroy();
      dialogs.closeAll();
      transfer.closeImportDialog();
      headerMenus.close();
      feedback.destroy();
      store.destroy();
    },
  };
}

export function resetFolderViewBrowserMocks(): void {
  vi.mocked(browser.storage.sync.get).mockResolvedValue({});
  vi.mocked(browser.storage.sync.set).mockResolvedValue(undefined);
  vi.mocked(browser.storage.local.get).mockResolvedValue({});
  vi.mocked(browser.storage.local.set).mockResolvedValue(undefined);
}
