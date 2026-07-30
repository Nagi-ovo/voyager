import { requestSafariNativeImageCopy } from '@/core/utils/safariNativeClipboard';
import { ImageExportService } from '@/features/export/services/ImageExportService';
import { renderElementToImageBlob } from '@/features/export/services/ImageRenderService';
import { getSavedSpeakerLabelOverrides } from '@/features/export/services/SpeakerLabelPreferenceService';
import {
  type ChatTurn,
  type ConversationMetadata,
  type ExportSpeakerLabels,
  resolveExportSpeakerLabels,
} from '@/features/export/types/export';

type ClipboardWriteLike = Pick<Clipboard, 'write'>;
type ClipboardItemLike = new (items: Record<string, Blob>) => ClipboardItem;

export type CopyElementAsImageOptions = {
  clipboard?: ClipboardWriteLike | null;
  ClipboardItemCtor?: ClipboardItemLike | null;
};

export type RenderResponseImageBlobOptions = {
  imageWidth: number;
  speakerDefaults: ExportSpeakerLabels;
};

export async function renderResponseImageBlob(
  turns: ChatTurn[],
  metadata: ConversationMetadata,
  options: RenderResponseImageBlobOptions,
): Promise<Blob> {
  const savedOverrides = await getSavedSpeakerLabelOverrides(options.speakerDefaults);
  const speakerLabels = resolveExportSpeakerLabels(savedOverrides, options.speakerDefaults);

  return await ImageExportService.renderConversationBlob(turns, metadata, {
    imageWidth: options.imageWidth,
    speakerLabels,
  });
}

function resolveClipboardDependencies(options?: CopyElementAsImageOptions): {
  clipboard: ClipboardWriteLike | null;
  ClipboardItemCtor: ClipboardItemLike | null;
} {
  const clipboard = options?.clipboard ?? navigator.clipboard ?? null;
  const globalClipboardItem = (globalThis as unknown as { ClipboardItem?: ClipboardItemLike })
    .ClipboardItem;
  const ClipboardItemCtor = options?.ClipboardItemCtor ?? globalClipboardItem ?? null;

  return { clipboard, ClipboardItemCtor };
}

export async function copyImageBlobToClipboard(
  blob: Blob,
  options?: CopyElementAsImageOptions,
): Promise<void> {
  const { clipboard, ClipboardItemCtor } = resolveClipboardDependencies(options);
  if (!clipboard?.write || !ClipboardItemCtor) {
    throw new Error('Clipboard image copy is not supported in this browser');
  }

  const item = new ClipboardItemCtor({ [blob.type || 'image/png']: blob });
  await clipboard.write([item]);
}

async function blobToBase64(blob: Blob): Promise<string | null> {
  return await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const commaIndex = dataUrl.indexOf(',');
      resolve(commaIndex < 0 ? null : dataUrl.substring(commaIndex + 1));
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

export type SafariNativeCopyOptions = {
  request?: (pngBase64: string) => Promise<boolean>;
};

/**
 * Safari-only fallback: `navigator.clipboard.write` for images frequently
 * fails there, but the native app can write NSPasteboard unconditionally.
 * Returns false (never throws) when the bridge is unavailable so callers can
 * continue to the download fallback.
 */
export async function copyImageBlobViaSafariNativePasteboard(
  blob: Blob,
  options?: SafariNativeCopyOptions,
): Promise<boolean> {
  try {
    const pngBase64 = await blobToBase64(blob);
    if (!pngBase64) return false;
    const request = options?.request ?? requestSafariNativeImageCopy;
    return await request(pngBase64);
  } catch {
    return false;
  }
}

export function downloadImageBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.toLowerCase().endsWith('.png') ? filename : `${filename}.png`;
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    try {
      document.body.removeChild(anchor);
    } catch {
      /* ignore */
    }
    URL.revokeObjectURL(url);
  }, 0);
}

export async function copyElementAsImageToClipboard(
  target: HTMLElement,
  options?: CopyElementAsImageOptions,
): Promise<void> {
  const blob = await renderElementToImageBlob(target, {
    enableSanitizedFallback: true,
  });
  await copyImageBlobToClipboard(blob, options);
}
