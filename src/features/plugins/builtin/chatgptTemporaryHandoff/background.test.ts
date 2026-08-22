import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  chatGptHandoffTabIdResponse,
  handleChatGptHandoffExpiryMessage,
  reconcileChatGptHandoffExpiryAlarms,
  startChatGptTemporaryHandoffBackgroundService,
} from './background';
import {
  CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE,
  CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE,
  PENDING_HANDOFF_KEY,
  PENDING_HANDOFF_TTL_MS,
  pendingHandoffAlarmName,
} from './storage';

const NOW = Date.parse('2026-08-14T12:00:00Z');
const STORAGE_KEY = `${PENDING_HANDOFF_KEY}:test-tab-token`;

let stored: Record<string, unknown>;
let alarmListener: ((alarm: chrome.alarms.Alarm) => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  stored = {};
  alarmListener = undefined;
  (chrome.storage.local.get as unknown as Mock).mockImplementation(async () => ({ ...stored }));
  (chrome.storage.local.remove as unknown as Mock).mockImplementation(
    async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
    },
  );
  (chrome.alarms.create as unknown as Mock).mockResolvedValue(undefined);
  (chrome.alarms.clear as unknown as Mock).mockResolvedValue(true);
  (chrome.alarms.onAlarm.addListener as unknown as Mock).mockImplementation(
    (listener: (alarm: chrome.alarms.Alarm) => void) => {
      alarmListener = listener;
    },
  );
});

describe('ChatGPT temporary handoff expiry service', () => {
  it('returns only a validated sender tab ID for handoff ownership', () => {
    expect(chatGptHandoffTabIdResponse(42)).toEqual({ ok: true, tabId: 42 });
    expect(chatGptHandoffTabIdResponse(undefined)).toEqual({ ok: false });
    expect(chatGptHandoffTabIdResponse(-1)).toEqual({ ok: false });
  });

  it('schedules and cancels a one-time expiry alarm for a validated storage key', async () => {
    const expiresAt = NOW + PENDING_HANDOFF_TTL_MS;

    await expect(
      handleChatGptHandoffExpiryMessage(
        {
          type: CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE,
          payload: { storageKey: STORAGE_KEY, expiresAt },
        },
        NOW,
      ),
    ).resolves.toEqual({ ok: true });
    expect(chrome.alarms.create).toHaveBeenCalledWith(pendingHandoffAlarmName(STORAGE_KEY), {
      when: expiresAt,
    });

    await expect(
      handleChatGptHandoffExpiryMessage({
        type: CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE,
        payload: { storageKey: STORAGE_KEY },
      }),
    ).resolves.toEqual({ ok: true });
    expect(chrome.alarms.clear).toHaveBeenCalledWith(pendingHandoffAlarmName(STORAGE_KEY));
  });

  it('rejects malformed keys without touching alarms or storage', async () => {
    await expect(
      handleChatGptHandoffExpiryMessage({
        type: CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE,
        payload: { storageKey: 'other-feature:key', expiresAt: NOW + 1_000 },
      }),
    ).resolves.toEqual({ ok: false });

    expect(chrome.alarms.create).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  });

  it('reconciles fresh records and removes expired or malformed orphan records', async () => {
    const freshKey = STORAGE_KEY;
    const expiredKey = `${PENDING_HANDOFF_KEY}:expired-token`;
    const malformedKey = `${PENDING_HANDOFF_KEY}:malformed-token`;
    stored = {
      [freshKey]: { storedAt: NOW - 1_000 },
      [expiredKey]: { storedAt: NOW - PENDING_HANDOFF_TTL_MS - 1 },
      [malformedKey]: { storedAt: 'not-a-number' },
      unrelated: { storedAt: 0 },
    };

    await reconcileChatGptHandoffExpiryAlarms(NOW);

    expect(chrome.alarms.create).toHaveBeenCalledWith(pendingHandoffAlarmName(freshKey), {
      when: NOW - 1_000 + PENDING_HANDOFF_TTL_MS,
    });
    expect(stored).not.toHaveProperty(expiredKey);
    expect(stored).not.toHaveProperty(malformedKey);
    expect(stored).toHaveProperty('unrelated');
  });

  it('removes the matching pending record when its alarm fires', async () => {
    stored[STORAGE_KEY] = { storedAt: NOW };
    startChatGptTemporaryHandoffBackgroundService();

    expect(alarmListener).toBeTypeOf('function');
    alarmListener!({ name: pendingHandoffAlarmName(STORAGE_KEY)!, scheduledTime: NOW });

    await vi.waitFor(() => expect(stored).not.toHaveProperty(STORAGE_KEY));
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it('retries the expiry alarm when storage deletion fails', async () => {
    startChatGptTemporaryHandoffBackgroundService();
    (chrome.storage.local.remove as unknown as Mock).mockRejectedValueOnce(
      new Error('storage busy'),
    );

    alarmListener!({ name: pendingHandoffAlarmName(STORAGE_KEY)!, scheduledTime: NOW });

    await vi.waitFor(() =>
      expect(chrome.alarms.create).toHaveBeenCalledWith(pendingHandoffAlarmName(STORAGE_KEY), {
        delayInMinutes: 1,
      }),
    );
  });
});
