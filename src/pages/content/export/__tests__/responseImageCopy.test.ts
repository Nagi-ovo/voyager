import { toBlob } from 'html-to-image';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageExportService } from '@/features/export/services/ImageExportService';
import type { ChatTurn, ConversationMetadata } from '@/features/export/types/export';

import {
  copyElementAsImageToClipboard,
  copyImageBlobToClipboard,
  copyImageBlobViaSafariNativePasteboard,
  downloadImageBlob,
  renderResponseImageBlob,
} from '../responseImageCopy';

const { storageGetMock } = vi.hoisted(() => ({
  storageGetMock: vi.fn(),
}));

vi.mock('html-to-image', () => ({
  toBlob: vi.fn(),
}));

vi.mock('@/core/services/StorageService', () => ({
  storageService: {
    get: storageGetMock,
    remove: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock('@/core/utils/safariNativeClipboard', () => ({
  requestSafariNativeImageCopy: vi.fn(),
}));

class MockClipboardItem {
  data: Record<string, Blob>;

  constructor(data: Record<string, Blob>) {
    this.data = data;
  }
}

describe('responseImageCopy', () => {
  const responseTurn: ChatTurn[] = [
    {
      user: '',
      assistant: 'Selected reply',
      starred: false,
      omitEmptySections: true,
    },
  ];
  const metadata: ConversationMetadata = {
    url: 'https://gemini.google.com/app/test',
    exportedAt: '2026-07-30T00:00:00.000Z',
    count: 1,
    title: 'Selected reply',
  };
  const speakerDefaults = {
    user: 'User',
    assistant: 'Assistant',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storageGetMock.mockResolvedValue({ success: true, data: undefined });
  });

  it('renders a single reply with saved custom speaker labels', async () => {
    storageGetMock.mockResolvedValue({
      success: true,
      data: { user: 'Erik', assistant: 'Nova' },
    });
    let renderedTarget: HTMLElement | null = null;
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (node: HTMLElement) => {
        renderedTarget = node;
        return new Blob(['img'], { type: 'image/png' });
      },
    );
    const renderSpy = vi.spyOn(ImageExportService, 'renderConversationBlob');

    try {
      await renderResponseImageBlob(responseTurn, metadata, {
        imageWidth: 960,
        speakerDefaults,
      });

      expect(renderSpy).toHaveBeenCalledWith(responseTurn, metadata, {
        imageWidth: 960,
        speakerLabels: { user: 'Erik', assistant: 'Nova' },
      });
      const target = renderedTarget as HTMLElement | null;
      expect(
        Array.from(target?.querySelectorAll('.gv-image-export-label') ?? []).map(
          (label) => label.textContent,
        ),
      ).toEqual(['Nova']);
    } finally {
      renderSpy.mockRestore();
    }
  });

  it('renders a single reply with default labels when no override is saved', async () => {
    const localizedSpeakerDefaults = {
      user: 'Question',
      assistant: 'AI response',
    };
    let renderedTarget: HTMLElement | null = null;
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (node: HTMLElement) => {
        renderedTarget = node;
        return new Blob(['img'], { type: 'image/png' });
      },
    );

    await renderResponseImageBlob(responseTurn, metadata, {
      imageWidth: 720,
      speakerDefaults: localizedSpeakerDefaults,
    });

    const target = renderedTarget as HTMLElement | null;
    expect(
      Array.from(target?.querySelectorAll('.gv-image-export-label') ?? []).map(
        (label) => label.textContent,
      ),
    ).toEqual(['AI response']);
  });

  it('writes rendered png blob to clipboard', async () => {
    const target = document.createElement('div');
    const blob = new Blob(['img'], { type: 'image/png' });
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(blob);

    const clipboardWrite = vi.fn().mockResolvedValue(undefined);

    await copyElementAsImageToClipboard(target, {
      clipboard: { write: clipboardWrite },
      ClipboardItemCtor: MockClipboardItem as unknown as typeof ClipboardItem,
    });

    expect(toBlob).toHaveBeenCalledOnce();
    expect(clipboardWrite).toHaveBeenCalledOnce();

    const [items] = clipboardWrite.mock.calls[0] as [MockClipboardItem[]];
    expect(items).toHaveLength(1);
    expect(items[0].data['image/png']).toBe(blob);
  });

  it('writes provided image blob to clipboard directly', async () => {
    const blob = new Blob(['img'], { type: 'image/png' });
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);

    await copyImageBlobToClipboard(blob, {
      clipboard: { write: clipboardWrite },
      ClipboardItemCtor: MockClipboardItem as unknown as typeof ClipboardItem,
    });

    expect(clipboardWrite).toHaveBeenCalledOnce();
    const [items] = clipboardWrite.mock.calls[0] as [MockClipboardItem[]];
    expect(items[0].data['image/png']).toBe(blob);
  });

  it('throws when render returns null blob', async () => {
    const target = document.createElement('div');
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      copyElementAsImageToClipboard(target, {
        clipboard: { write: vi.fn() },
        ClipboardItemCtor: MockClipboardItem as unknown as typeof ClipboardItem,
      }),
    ).rejects.toThrow('Image render failed');
  });

  it('throws when clipboard image API is unavailable', async () => {
    const target = document.createElement('div');
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Blob(['img'], { type: 'image/png' }),
    );

    await expect(
      copyElementAsImageToClipboard(target, {
        clipboard: null,
        ClipboardItemCtor: MockClipboardItem as unknown as typeof ClipboardItem,
      }),
    ).rejects.toThrow('Clipboard image copy is not supported');
  });

  it('falls back to a sanitized clone when first render fails on external resources', async () => {
    const target = document.createElement('div');
    const img = document.createElement('img');
    img.src = 'https://example.com/blocked.png';
    target.appendChild(img);
    document.body.appendChild(target);

    const blob = new Blob(['img'], { type: 'image/png' });
    (toBlob as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Failed to fetch resource'))
      .mockResolvedValueOnce(blob);

    const clipboardWrite = vi.fn().mockResolvedValue(undefined);

    await copyElementAsImageToClipboard(target, {
      clipboard: { write: clipboardWrite },
      ClipboardItemCtor: MockClipboardItem as unknown as typeof ClipboardItem,
    });

    expect(toBlob).toHaveBeenCalledTimes(2);

    const secondCallTarget = (toBlob as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
    expect(secondCallTarget).not.toBe(target);
    expect((secondCallTarget as HTMLElement).querySelector('img')).toBeNull();
    expect(clipboardWrite).toHaveBeenCalledOnce();
  });

  it('falls back when primary render returns null blob', async () => {
    const target = document.createElement('div');
    target.textContent = 'content';
    document.body.appendChild(target);

    const blob = new Blob(['img'], { type: 'image/png' });
    (toBlob as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(blob);

    const clipboardWrite = vi.fn().mockResolvedValue(undefined);

    await copyElementAsImageToClipboard(target, {
      clipboard: { write: clipboardWrite },
      ClipboardItemCtor: MockClipboardItem as unknown as typeof ClipboardItem,
    });

    expect(toBlob).toHaveBeenCalledTimes(2);
    expect(clipboardWrite).toHaveBeenCalledOnce();
  });

  it('copies through the Safari native pasteboard bridge as base64 png', async () => {
    const request = vi.fn().mockResolvedValue(true);
    const blob = new Blob(['img'], { type: 'image/png' });

    await expect(copyImageBlobViaSafariNativePasteboard(blob, { request })).resolves.toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('aW1n');
  });

  it('returns false instead of throwing when the native pasteboard bridge fails', async () => {
    const request = vi.fn().mockRejectedValue(new Error('no bridge'));
    const blob = new Blob(['img'], { type: 'image/png' });

    await expect(copyImageBlobViaSafariNativePasteboard(blob, { request })).resolves.toBe(false);
  });

  it('downloads image blob via object URL and revokes it', () => {
    vi.useFakeTimers();
    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const removeSpy = vi.spyOn(document.body, 'removeChild');
    const clickSpy = vi.fn();
    const nativeCreateElement = document.createElement.bind(document);
    const anchor = nativeCreateElement('a');
    anchor.click = clickSpy;
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      if (tagName.toLowerCase() === 'a') return anchor;
      return nativeCreateElement(tagName);
    });

    const blob = new Blob(['img'], { type: 'image/png' });
    downloadImageBlob(blob, 'reply-image.png');

    expect(createObjectURLSpy).toHaveBeenCalledOnce();
    expect(anchor.href).toContain('blob:test');
    expect(anchor.download).toBe('reply-image.png');
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(appendSpy).toHaveBeenCalled();

    vi.runAllTimers();
    expect(removeSpy).toHaveBeenCalled();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:test');

    createElementSpy.mockRestore();
    vi.useRealTimers();
  });
});
