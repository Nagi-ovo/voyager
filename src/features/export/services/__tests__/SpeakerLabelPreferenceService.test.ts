import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import type { ExportSpeakerLabels } from '../../types/export';
import {
  getSavedSpeakerLabelOverrides,
  normalizeSpeakerLabelOverrides,
  resolveExportSpeakerLabels,
  saveSpeakerLabelOverrides,
} from '../SpeakerLabelPreferenceService';

const { getMock, removeMock, setMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  removeMock: vi.fn(),
  setMock: vi.fn(),
}));

vi.mock('@/core/services/StorageService', () => ({
  storageService: {
    get: getMock,
    remove: removeMock,
    set: setMock,
  },
}));

describe('SpeakerLabelPreferenceService', () => {
  const defaults: ExportSpeakerLabels = {
    user: 'User',
    assistant: 'Assistant',
  };

  beforeEach(() => {
    getMock.mockReset();
    removeMock.mockReset();
    setMock.mockReset();
  });

  it.each([
    [{ user: '', assistant: '   ' }, {}],
    [{ user: ' User ', assistant: 'Assistant' }, {}],
    [
      { user: ' Erik ', assistant: '  Nova  ' },
      { user: 'Erik', assistant: 'Nova' },
    ],
    [{ user: 'Erik' }, { user: 'Erik' }],
    [null, {}],
    ['invalid', {}],
    [{ user: 42, assistant: ['Nova'] }, {}],
  ])('normalizes stored overrides defensively', (value, expected) => {
    expect(normalizeSpeakerLabelOverrides(value, defaults)).toEqual(expected);
  });

  it('resolves blank and whitespace-only values to localized defaults', () => {
    expect(resolveExportSpeakerLabels({ user: '', assistant: '   ' }, defaults)).toEqual(defaults);
  });

  it('restores valid saved overrides and ignores malformed fields', async () => {
    getMock.mockResolvedValue({
      success: true,
      data: { user: 'Erik', assistant: 42 },
    });

    await expect(getSavedSpeakerLabelOverrides(defaults)).resolves.toEqual({ user: 'Erik' });
    expect(getMock).toHaveBeenCalledWith(StorageKeys.EXPORT_SPEAKER_LABELS);
  });

  it('falls back safely when reading storage fails or throws', async () => {
    getMock.mockResolvedValueOnce({ success: false, error: new Error('read failed') });
    await expect(getSavedSpeakerLabelOverrides(defaults)).resolves.toEqual({});

    getMock.mockRejectedValueOnce(new Error('context invalidated'));
    await expect(getSavedSpeakerLabelOverrides(defaults)).resolves.toEqual({});
  });

  it('stores only normalized custom overrides', async () => {
    setMock.mockResolvedValue({ success: true, data: undefined });

    await expect(
      saveSpeakerLabelOverrides({ user: ' Erik ', assistant: 'Nova' }, defaults),
    ).resolves.toBe(true);

    expect(setMock).toHaveBeenCalledWith(StorageKeys.EXPORT_SPEAKER_LABELS, {
      user: 'Erik',
      assistant: 'Nova',
    });
  });

  it('removes saved overrides when both fields return to defaults', async () => {
    removeMock.mockResolvedValue({ success: true, data: undefined });

    await expect(
      saveSpeakerLabelOverrides({ user: ' ', assistant: 'Assistant' }, defaults),
    ).resolves.toBe(true);

    expect(removeMock).toHaveBeenCalledWith(StorageKeys.EXPORT_SPEAKER_LABELS);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('reports failed writes without throwing', async () => {
    setMock.mockResolvedValue({ success: false, error: new Error('write failed') });

    await expect(
      saveSpeakerLabelOverrides({ user: 'Erik', assistant: 'Nova' }, defaults),
    ).resolves.toBe(false);
  });

  it('reports failed removals without throwing', async () => {
    removeMock.mockResolvedValue({ success: false, error: new Error('remove failed') });

    await expect(saveSpeakerLabelOverrides({}, defaults)).resolves.toBe(false);
  });

  it('contains thrown storage failures and keeps export callers unblocked', async () => {
    setMock.mockRejectedValue(new Error('context invalidated'));

    await expect(saveSpeakerLabelOverrides({ user: 'Erik' }, defaults)).resolves.toBe(false);
  });
});
