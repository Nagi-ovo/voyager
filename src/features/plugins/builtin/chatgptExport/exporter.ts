import { PDFPrintService } from '@/features/export/services/PDFPrintService';
import type { ConversationMetadata } from '@/features/export/types/export';

import {
  type ChatGptMessageSnapshot,
  buildChatTurns,
  extractSnapshotMarkdown,
} from './conversation';

export type ChatGptExportFormat = 'markdown' | 'json' | 'pdf';

export interface ChatGptExportRequest {
  readonly format: ChatGptExportFormat;
  readonly messages: readonly ChatGptMessageSnapshot[];
  readonly metadata: ConversationMetadata;
  readonly selected: boolean;
  readonly fontSize?: number;
}

function escapeMarkdownHeading(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!])/g, '\\$1');
}

function slugify(value: string): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s_-]+/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 72);
  return cleaned || 'conversation';
}

function dateStamp(iso: string): string {
  const date = new Date(iso);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function buildChatGptExportFilename(
  metadata: ConversationMetadata,
  format: ChatGptExportFormat,
  selected: boolean,
): string {
  const extension: Record<ChatGptExportFormat, string> = {
    markdown: 'md',
    json: 'json',
    pdf: 'pdf',
  };
  const subset = selected ? '-selected' : '';
  return `chatgpt-${slugify(metadata.title || 'conversation')}${subset}-${dateStamp(metadata.exportedAt)}.${extension[format]}`;
}

function downloadBlob(content: BlobPart, mime: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

export function formatChatGptMarkdown(
  messages: readonly ChatGptMessageSnapshot[],
  metadata: ConversationMetadata,
): string {
  const lines = [
    `# ${escapeMarkdownHeading(metadata.title || 'ChatGPT conversation')}`,
    '',
    `**Exported**: ${new Date(metadata.exportedAt).toLocaleString()}`,
    `**Messages**: ${messages.length}`,
    `**Source**: [ChatGPT](${metadata.url})`,
    '',
    '---',
    '',
  ];

  messages.forEach((message) => {
    lines.push(message.role === 'user' ? '## User' : '## ChatGPT', '');
    lines.push(extractSnapshotMarkdown(message) || '_No content_', '');
  });
  lines.push('---', '', '*Exported with Voyager*', '');
  return lines.join('\n');
}

function buildJsonPayload(request: ChatGptExportRequest): string {
  return JSON.stringify(
    {
      format: 'voyager.chatgpt.conversation.v1',
      url: request.metadata.url,
      title: request.metadata.title,
      exportedAt: request.metadata.exportedAt,
      selected: request.selected,
      count: request.messages.length,
      messages: request.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: extractSnapshotMarkdown(message),
      })),
    },
    null,
    2,
  );
}

export async function exportChatGptConversation(request: ChatGptExportRequest): Promise<string> {
  const filename = buildChatGptExportFilename(request.metadata, request.format, request.selected);
  switch (request.format) {
    case 'markdown':
      downloadBlob(
        formatChatGptMarkdown(request.messages, request.metadata),
        'text/markdown;charset=utf-8',
        filename,
      );
      break;
    case 'json':
      downloadBlob(buildJsonPayload(request), 'application/json;charset=utf-8', filename);
      break;
    case 'pdf':
      await PDFPrintService.export(buildChatTurns(request.messages), request.metadata, {
        fontSize: request.fontSize ?? 11,
        speakerLabels: { user: 'User', assistant: 'ChatGPT' },
        appearance: 'chatgpt',
      });
      break;
  }
  return filename;
}
