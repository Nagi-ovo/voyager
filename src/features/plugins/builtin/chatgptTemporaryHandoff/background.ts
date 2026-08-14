import { logger } from '@/core/services/LoggerService';

import {
  CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE,
  CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE,
  PENDING_HANDOFF_STORAGE_PREFIX,
  PENDING_HANDOFF_TTL_MS,
  isPendingHandoffStorageKey,
  pendingHandoffAlarmName,
  pendingHandoffStorageKeyFromAlarm,
} from './storage';

interface HandoffExpiryMessage {
  readonly type:
    | typeof CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE
    | typeof CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE;
  readonly payload?: {
    readonly storageKey?: unknown;
    readonly expiresAt?: unknown;
  };
}

export function isChatGptHandoffExpiryMessage(message: unknown): message is HandoffExpiryMessage {
  if (!message || typeof message !== 'object') return false;
  const type = (message as { type?: unknown }).type;
  return (
    type === CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE ||
    type === CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE
  );
}

async function removePendingStorageKey(storageKey: string): Promise<void> {
  await chrome.storage.local.remove(storageKey);
}

export async function handleChatGptHandoffExpiryMessage(
  message: HandoffExpiryMessage,
  now = Date.now(),
): Promise<{ ok: boolean }> {
  const storageKey = message.payload?.storageKey;
  if (!isPendingHandoffStorageKey(storageKey)) return { ok: false };
  const alarmName = pendingHandoffAlarmName(storageKey);
  if (!alarmName || !chrome.alarms?.clear) return { ok: false };

  if (message.type === CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE) {
    await chrome.alarms.clear(alarmName);
    return { ok: true };
  }

  const expiresAt = message.payload?.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return { ok: false };
  if (expiresAt <= now) {
    await removePendingStorageKey(storageKey);
    await chrome.alarms.clear(alarmName);
    return { ok: true };
  }
  if (!chrome.alarms.create) return { ok: false };
  await chrome.alarms.create(alarmName, { when: expiresAt });
  return { ok: true };
}

export async function reconcileChatGptHandoffExpiryAlarms(now = Date.now()): Promise<void> {
  if (!chrome.alarms?.create) return;
  const stored = await chrome.storage.local.get(null);
  for (const [storageKey, value] of Object.entries(stored)) {
    if (!storageKey.startsWith(PENDING_HANDOFF_STORAGE_PREFIX)) continue;
    if (!isPendingHandoffStorageKey(storageKey) || !value || typeof value !== 'object') {
      await removePendingStorageKey(storageKey);
      continue;
    }
    const storedAt = (value as { storedAt?: unknown }).storedAt;
    if (typeof storedAt !== 'number' || !Number.isFinite(storedAt)) {
      await removePendingStorageKey(storageKey);
      continue;
    }
    const expiresAt = storedAt + PENDING_HANDOFF_TTL_MS;
    if (expiresAt <= now || storedAt > now + 5_000) {
      await removePendingStorageKey(storageKey);
      continue;
    }
    const alarmName = pendingHandoffAlarmName(storageKey);
    if (alarmName) await chrome.alarms.create(alarmName, { when: expiresAt });
  }
}

export function startChatGptTemporaryHandoffBackgroundService(): void {
  void reconcileChatGptHandoffExpiryAlarms().catch((error) => {
    logger.warn('ChatGPT handoff expiry reconciliation failed', { error: String(error) });
  });
  chrome.alarms?.onAlarm?.addListener((alarm) => {
    const storageKey = pendingHandoffStorageKeyFromAlarm(alarm.name);
    if (!storageKey) return;
    void removePendingStorageKey(storageKey).catch(async (error) => {
      logger.warn('ChatGPT handoff expiry cleanup failed', { error: String(error) });
      try {
        await chrome.alarms.create(alarm.name, { delayInMinutes: 1 });
      } catch (retryError) {
        logger.warn('ChatGPT handoff expiry retry scheduling failed', {
          error: String(retryError),
        });
      }
    });
  });
}
