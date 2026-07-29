import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConversationExportService } from '../../../../features/export/services/ConversationExportService';
import type { ChatTurn, ConversationMetadata } from '../../../../features/export/types/export';
import { ExportFormat } from '../../../../features/export/types/export';
import {
  PENDING_EXPORT_SESSION_KEY,
  advancePendingExportState,
  clearPendingExportState,
  createPendingExportState,
  exportPendingConversation,
  persistPendingExportState,
  restorePendingExportState,
} from '../pendingExportState';

const url = 'https://gemini.google.com/app/conversation';
const labels = { user: 'Erik', assistant: 'Nova' };
const metadata: ConversationMetadata = {
  title: 'Pending export',
  url,
  exportedAt: '2026-07-25T00:00:00.000Z',
  count: 1,
};
const turns: ChatTurn[] = [{ user: 'Hello', assistant: 'Hi', starred: false }];

function validSerializedState(speakerLabels: unknown = labels): string {
  return JSON.stringify({
    format: 'markdown',
    fontSize: 16,
    imageWidth: 960,
    usePromptAsTurnHeading: true,
    speakerLabels,
    initialSelectedMessageId: 'turn-1',
    attempt: 1,
    url,
    status: 'clicking',
    timestamp: 1001,
  });
}

describe('pendingExportState', () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('persists, restores, and delivers custom labels to the resumed export call', async () => {
    const state = createPendingExportState(ExportFormat.MARKDOWN, url, 1000, {
      fontSize: 16,
      imageWidth: 960,
      usePromptAsTurnHeading: true,
      speakerLabels: labels,
      initialSelectedMessageId: 'turn-1',
    });

    expect(state.speakerLabels).toEqual(labels);

    persistPendingExportState(sessionStorage, state, 1001);
    expect(JSON.parse(sessionStorage.getItem(PENDING_EXPORT_SESSION_KEY) ?? '{}')).toMatchObject({
      speakerLabels: labels,
      attempt: 1,
    });

    const restored = restorePendingExportState(sessionStorage, url);
    expect(restored?.speakerLabels).toEqual(labels);
    expect(restored?.usePromptAsTurnHeading).toBe(true);

    const exportSpy = vi
      .spyOn(ConversationExportService, 'export')
      .mockResolvedValue({ success: true, format: ExportFormat.MARKDOWN });
    await exportPendingConversation(restored!, turns, metadata, true);

    expect(exportSpy).toHaveBeenCalledWith(turns, metadata, {
      format: 'markdown',
      fontSize: 16,
      includeImageSource: true,
      imageWidth: 960,
      usePromptAsTurnHeading: true,
      speakerLabels: labels,
    });
  });

  it('preserves labels through recursive or delayed continuation', () => {
    const state = createPendingExportState(ExportFormat.IMAGE, url, 1000, {
      usePromptAsTurnHeading: true,
      speakerLabels: labels,
    });
    const delayed = advancePendingExportState(state, 2000);
    const recursive = advancePendingExportState(delayed, 3000);

    expect(recursive).toMatchObject({
      attempt: 2,
      timestamp: 3000,
      usePromptAsTurnHeading: true,
      speakerLabels: labels,
    });
  });

  it('restores legacy pending state without speaker labels', () => {
    const serialized = validSerializedState(undefined);
    const parsed = JSON.parse(serialized);
    delete parsed.speakerLabels;
    sessionStorage.setItem(PENDING_EXPORT_SESSION_KEY, JSON.stringify(parsed));

    expect(restorePendingExportState(sessionStorage, url)).toMatchObject({
      format: 'markdown',
      attempt: 1,
      speakerLabels: undefined,
    });
  });

  it.each([
    ['partial object', { user: 'Erik' }],
    ['non-string value', { user: 'Erik', assistant: 42 }],
    ['array', ['Erik', 'Nova']],
    ['null', null],
  ])('drops %s speaker labels without rejecting the pending export', async (_name, malformed) => {
    sessionStorage.setItem(PENDING_EXPORT_SESSION_KEY, validSerializedState(malformed));

    const restored = restorePendingExportState(sessionStorage, url);

    expect(restored).toMatchObject({
      format: 'markdown',
      fontSize: 16,
      imageWidth: 960,
      attempt: 1,
    });
    expect(restored?.speakerLabels).toBeUndefined();
    expect(sessionStorage.getItem(PENDING_EXPORT_SESSION_KEY)).not.toBeNull();

    const exportSpy = vi
      .spyOn(ConversationExportService, 'export')
      .mockResolvedValue({ success: true, format: ExportFormat.MARKDOWN });
    await expect(exportPendingConversation(restored!, turns, metadata, true)).resolves.toEqual({
      success: true,
      format: ExportFormat.MARKDOWN,
    });
    expect(exportSpy.mock.calls[0]?.[2].speakerLabels).toBeUndefined();
  });

  it('retains existing cleanup decisions for invalid, mismatched, and completed state', () => {
    sessionStorage.setItem(PENDING_EXPORT_SESSION_KEY, '{invalid');
    expect(restorePendingExportState(sessionStorage, url)).toBeNull();
    expect(sessionStorage.getItem(PENDING_EXPORT_SESSION_KEY)).toBeNull();

    sessionStorage.setItem(PENDING_EXPORT_SESSION_KEY, validSerializedState());
    expect(restorePendingExportState(sessionStorage, `${url}/other`)).toBeNull();
    expect(sessionStorage.getItem(PENDING_EXPORT_SESSION_KEY)).toBeNull();

    sessionStorage.setItem(PENDING_EXPORT_SESSION_KEY, validSerializedState());
    expect(restorePendingExportState(sessionStorage, url)).not.toBeNull();
    expect(sessionStorage.getItem(PENDING_EXPORT_SESSION_KEY)).not.toBeNull();
    clearPendingExportState(sessionStorage);
    expect(sessionStorage.getItem(PENDING_EXPORT_SESSION_KEY)).toBeNull();
  });

  it('keeps JSON pending state backward compatible and conversation-scoped', async () => {
    const state = createPendingExportState(ExportFormat.JSON, url, 1000);
    const exportSpy = vi
      .spyOn(ConversationExportService, 'export')
      .mockResolvedValue({ success: true, format: ExportFormat.JSON });

    await exportPendingConversation(state, turns, metadata, false);

    expect(exportSpy).toHaveBeenCalledWith(turns, metadata, {
      format: 'json',
      fontSize: undefined,
      includeImageSource: false,
      imageWidth: undefined,
      usePromptAsTurnHeading: undefined,
      speakerLabels: undefined,
    });
    expect(exportSpy.mock.calls[0]?.[2]).not.toHaveProperty('layout');
  });
});
