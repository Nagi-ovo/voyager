export const PENDING_HANDOFF_KEY = 'gv-chatgpt-temporary-handoff-pending';
export const PENDING_HANDOFF_TAB_KEY = 'gv-chatgpt-temporary-handoff-tab';
export const PENDING_HANDOFF_STORAGE_PREFIX = `${PENDING_HANDOFF_KEY}:`;
export const PENDING_HANDOFF_TTL_MS = 60_000;

export const CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE = 'gv.chatgptTemporaryHandoff.scheduleExpiry';
export const CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE = 'gv.chatgptTemporaryHandoff.cancelExpiry';
export const CHATGPT_HANDOFF_GET_TAB_ID_MESSAGE = 'gv.chatgptTemporaryHandoff.getTabId';
export const CHATGPT_HANDOFF_EXPIRY_ALARM_PREFIX = 'gv-chatgpt-handoff-expiry:';

export function isPendingHandoffStorageKey(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(PENDING_HANDOFF_STORAGE_PREFIX)) return false;
  return /^[a-z0-9-]{4,80}$/i.test(value.slice(PENDING_HANDOFF_STORAGE_PREFIX.length));
}

export function pendingHandoffAlarmName(storageKey: string): string | null {
  if (!isPendingHandoffStorageKey(storageKey)) return null;
  return `${CHATGPT_HANDOFF_EXPIRY_ALARM_PREFIX}${storageKey.slice(PENDING_HANDOFF_STORAGE_PREFIX.length)}`;
}

export function pendingHandoffStorageKeyFromAlarm(alarmName: string): string | null {
  if (!alarmName.startsWith(CHATGPT_HANDOFF_EXPIRY_ALARM_PREFIX)) return null;
  const storageKey = `${PENDING_HANDOFF_STORAGE_PREFIX}${alarmName.slice(CHATGPT_HANDOFF_EXPIRY_ALARM_PREFIX.length)}`;
  return isPendingHandoffStorageKey(storageKey) ? storageKey : null;
}
