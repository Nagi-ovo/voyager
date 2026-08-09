import { ConversationExportService } from '../../../features/export/services/ConversationExportService';
import type {
  ChatTurn,
  ConversationMetadata,
  ExportFormat,
  ExportSpeakerLabels,
} from '../../../features/export/types/export';

export const PENDING_EXPORT_SESSION_KEY = 'gv_export_pending';

export interface PendingExportState {
  format: ExportFormat;
  fontSize?: number;
  imageWidth?: number;
  usePromptAsTurnHeading?: boolean;
  speakerLabels?: ExportSpeakerLabels;
  initialSelectedMessageId?: string;
  attempt: number;
  url: string;
  status: 'clicking';
  timestamp: number;
}

type PendingExportStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'json' || value === 'markdown' || value === 'pdf' || value === 'image';
}

function parseSpeakerLabels(value: unknown): ExportSpeakerLabels | undefined {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    typeof (value as Record<string, unknown>).user !== 'string' ||
    typeof (value as Record<string, unknown>).assistant !== 'string'
  ) {
    return undefined;
  }

  return {
    user: (value as Record<string, string>).user,
    assistant: (value as Record<string, string>).assistant,
  };
}

export function createPendingExportState(
  format: ExportFormat,
  url: string,
  now: number,
  options: {
    fontSize?: number;
    imageWidth?: number;
    usePromptAsTurnHeading?: boolean;
    speakerLabels?: ExportSpeakerLabels;
    initialSelectedMessageId?: string;
  } = {},
): PendingExportState {
  return {
    format,
    ...options,
    attempt: 0,
    url,
    status: 'clicking',
    timestamp: now,
  };
}

export function advancePendingExportState(
  state: PendingExportState,
  now: number,
): PendingExportState {
  return {
    ...state,
    attempt: state.attempt + 1,
    timestamp: now,
  };
}

export function persistPendingExportState(
  storage: PendingExportStorage,
  state: PendingExportState,
  now: number,
): PendingExportState {
  const nextState = advancePendingExportState(state, now);
  storage.setItem(PENDING_EXPORT_SESSION_KEY, JSON.stringify(nextState));
  return nextState;
}

export function parsePendingExportState(raw: string): PendingExportState | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== 'object') return null;

    const parsed = value as Record<string, unknown>;
    if (
      !isExportFormat(parsed.format) ||
      typeof parsed.attempt !== 'number' ||
      typeof parsed.url !== 'string' ||
      parsed.status !== 'clicking' ||
      typeof parsed.timestamp !== 'number'
    ) {
      return null;
    }

    return {
      format: parsed.format,
      fontSize: typeof parsed.fontSize === 'number' ? parsed.fontSize : undefined,
      imageWidth: typeof parsed.imageWidth === 'number' ? parsed.imageWidth : undefined,
      usePromptAsTurnHeading: parsed.usePromptAsTurnHeading === true,
      speakerLabels: parseSpeakerLabels(parsed.speakerLabels),
      initialSelectedMessageId:
        typeof parsed.initialSelectedMessageId === 'string'
          ? parsed.initialSelectedMessageId
          : undefined,
      attempt: parsed.attempt,
      url: parsed.url,
      status: parsed.status,
      timestamp: parsed.timestamp,
    };
  } catch {
    return null;
  }
}

export function restorePendingExportState(
  storage: PendingExportStorage,
  currentUrl: string,
): PendingExportState | null {
  const raw = storage.getItem(PENDING_EXPORT_SESSION_KEY);
  if (!raw) return null;

  const state = parsePendingExportState(raw);
  if (!state || state.url !== currentUrl) {
    storage.removeItem(PENDING_EXPORT_SESSION_KEY);
    return null;
  }

  return state;
}

export function clearPendingExportState(storage: PendingExportStorage): void {
  storage.removeItem(PENDING_EXPORT_SESSION_KEY);
}

export function exportPendingConversation(
  state: PendingExportState,
  turns: ChatTurn[],
  metadata: ConversationMetadata,
  includeImageSource: boolean,
  signal?: AbortSignal,
) {
  return ConversationExportService.export(turns, metadata, {
    format: state.format,
    fontSize: state.fontSize,
    includeImageSource,
    imageWidth: state.imageWidth,
    usePromptAsTurnHeading: state.usePromptAsTurnHeading,
    speakerLabels: state.speakerLabels,
    signal,
  });
}
