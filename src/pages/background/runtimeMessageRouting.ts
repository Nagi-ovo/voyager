import {
  CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE,
  CHATGPT_HANDOFF_GET_TAB_ID_MESSAGE,
  CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE,
} from '@/features/plugins/builtin/chatgptTemporaryHandoff/storage';
import { PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE } from '@/features/plugins/runtime/messages';

const HANDLED_BACKGROUND_MESSAGE_TYPES = new Set([
  'gv.fetchImage',
  'gv.fetchImageViaPage',
  'gv.generatedUi.ensureCapturePermission',
  'gv.generatedUi.captureVisibleTab',
  PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE,
  CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE,
  CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE,
  CHATGPT_HANDOFF_GET_TAB_ID_MESSAGE,
  'gv.account.resolve',
  'gv.responseComplete.notify',
  'gv.responseComplete.requestNativePermission',
  'gv.clipboard.copyImagePng',
  'gv.remoteAnnouncement.getPending',
  'gv.remoteAnnouncement.ack',
  'gv.remoteAnnouncement.dismiss',
  'gv.highlight.listAll',
  'gv.highlight.list',
  'gv.highlight.create',
  'gv.highlight.update',
  'gv.highlight.updateStored',
  'gv.highlight.delete',
  'gv.highlight.deleteStored',
  'gv.highlight.export',
  'gv.highlight.import',
  'gv.highlight.clearAll',
  'gv.highlight.clearAllAccounts',
  'gv.starred.add',
  'gv.starred.remove',
  'gv.starred.getAll',
  'gv.starred.getForConversation',
  'gv.starred.isStarred',
  'gv.starred.reconcileConversationIds',
  'gv.fork.add',
  'gv.fork.remove',
  'gv.fork.getAll',
  'gv.fork.getForConversation',
  'gv.fork.getGroup',
  'gv.sync.authenticate',
  'gv.sync.signOut',
  'gv.sync.upload',
  'gv.sync.download',
  'gv.sync.pullPromptsMerge',
  'gv.sync.pushPromptsMerge',
  'gv.sync.getState',
  'gv.sync.setMode',
  'gv.sync.setProvider',
  'gv.openPopup',
  'gv.syncToIDE',
  'gv.checkSyncStatus',
]);

export function isHandledBackgroundRuntimeMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' && HANDLED_BACKGROUND_MESSAGE_TYPES.has(type);
}
