/**
 * Export feature type definitions
 * Supports multiple export formats with extensible architecture
 */

/**
 * Canvas document content extracted from immersive-editor
 */
export interface CanvasDoc {
  /** Title of the Canvas document */
  title: string;
  /** Full markdown content of the Canvas document */
  content: string;
}

/**
 * File attached to a user message.
 * The export preserves context only; it does not bundle the original file.
 */
export interface ExportAttachment {
  name: string;
  type: string;
}

/**
 * Chat turn representing a user-assistant exchange
 */
export interface ChatTurn {
  user: string;
  assistant: string;
  starred: boolean;
  attachments?: ExportAttachment[];
  omitEmptySections?: boolean;
  // Optional DOM elements for rich content extraction
  userElement?: HTMLElement;
  assistantElement?: HTMLElement;
}

/**
 * Conversation metadata
 */
export interface ConversationMetadata {
  url: string;
  exportedAt: string;
  title?: string;
  count: number;
}

/**
 * Supported export formats
 */
export enum ExportFormat {
  JSON = 'json',
  MARKDOWN = 'markdown',
  PDF = 'pdf',
  IMAGE = 'image',
}

export type ExportLayout = 'conversation' | 'document';
export type ImageExportWidth = 620 | 960 | 1360;

export interface ExportSpeakerLabels {
  user: string;
  assistant: string;
}

export type ExportSpeakerLabelOverrides = Partial<ExportSpeakerLabels>;

export const DEFAULT_EXPORT_SPEAKER_LABELS: Readonly<ExportSpeakerLabels> = {
  user: 'User',
  assistant: 'Assistant',
};

function normalizeSpeakerLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim();
  return normalized || undefined;
}

export function normalizeSpeakerLabelOverrides(value: unknown): ExportSpeakerLabelOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const candidate = value as Record<string, unknown>;
  const user = normalizeSpeakerLabel(candidate.user);
  const assistant = normalizeSpeakerLabel(candidate.assistant);

  return {
    ...(user ? { user } : {}),
    ...(assistant ? { assistant } : {}),
  };
}

export function resolveExportSpeakerLabels(
  value: unknown,
  defaults: ExportSpeakerLabels,
): ExportSpeakerLabels {
  const overrides = normalizeSpeakerLabelOverrides(value);
  return {
    user: overrides.user ?? defaults.user,
    assistant: overrides.assistant ?? defaults.assistant,
  };
}

export const IMAGE_EXPORT_WIDTH_NARROW: ImageExportWidth = 620;
export const IMAGE_EXPORT_WIDTH_MEDIUM: ImageExportWidth = 960;
export const IMAGE_EXPORT_WIDTH_WIDE: ImageExportWidth = 1360;
export const DEFAULT_IMAGE_EXPORT_WIDTH: ImageExportWidth = IMAGE_EXPORT_WIDTH_NARROW;
export const IMAGE_EXPORT_WIDTH_OPTIONS: readonly ImageExportWidth[] = [
  IMAGE_EXPORT_WIDTH_NARROW,
  IMAGE_EXPORT_WIDTH_MEDIUM,
  IMAGE_EXPORT_WIDTH_WIDE,
];

export function isImageExportWidth(value: unknown): value is ImageExportWidth {
  return typeof value === 'number' && IMAGE_EXPORT_WIDTH_OPTIONS.some((width) => width === value);
}

export function normalizeImageExportWidth(value: unknown): ImageExportWidth {
  return isImageExportWidth(value) ? value : DEFAULT_IMAGE_EXPORT_WIDTH;
}

/**
 * Export format labels for UI
 */
export interface ExportFormatInfo {
  format: ExportFormat;
  label: string;
  description: string;
  extension: string;
  recommended?: boolean;
}

/**
 * Export options
 */
export interface ExportOptions {
  format: ExportFormat;
  layout?: ExportLayout;
  includeMetadata?: boolean;
  includeStarred?: boolean;
  filename?: string;
  // Image handling for markdown/pdf
  // - 'inline': try to inline images as data URLs when possible
  // - 'none': keep remote URLs as-is
  embedImages?: 'inline' | 'none';
  // Font size for PDF (pt) and Image (px) exports
  fontSize?: number;
  // Image width (px) for image exports
  imageWidth?: number;
  /** Whether to include image source attribution in markdown (default: true) */
  includeImageSource?: boolean;
  /** Put each user prompt in its turn heading and omit the duplicate User section. */
  usePromptAsTurnHeading?: boolean;
  /** Human-readable labels used by conversation exports; ignored by JSON and document layouts. */
  speakerLabels?: ExportSpeakerLabels;
}

export interface MarkdownFormatOptions {
  usePromptAsTurnHeading?: boolean;
  speakerLabels?: ExportSpeakerLabels;
}

/**
 * Base export payload
 */
export interface BaseExportPayload {
  format: string;
  url: string;
  exportedAt: string;
  count: number;
  /**
   * Optional human-readable conversation title
   * Added in a backward-compatible way for JSON/Markdown exports
   */
  title?: string;
}

/**
 * JSON export payload (existing format)
 */
export interface JSONExportPayload extends BaseExportPayload {
  format: 'gemini-voyager.chat.v1';
  items: ChatTurn[];
}

/**
 * Export result
 */
export interface ExportResult {
  success: boolean;
  format: ExportFormat;
  filename?: string;
  error?: string;
}
