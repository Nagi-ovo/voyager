import React, { act, useEffect } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { useFolderStructureCopy } from '../useFolderStructureCopy';

vi.mock('webextension-polyfill', () => ({
  default: { tabs: { query: vi.fn(), sendMessage: vi.fn() } },
}));

type StructureCopy = ReturnType<typeof useFolderStructureCopy>;

function Harness({
  sourceTabId,
  capture,
}: {
  sourceTabId?: number;
  capture: (copy: StructureCopy) => void;
}) {
  const copy = useFolderStructureCopy('zh', sourceTabId);
  useEffect(() => {
    capture(copy);
  }, [capture, copy]);
  return null;
}

function structure(title: string) {
  return {
    ok: true,
    sidebarConversations: [
      { id: 'conversation-1', title, url: 'https://gemini.google.com/u/1/app/conversation-1' },
    ],
    folderData: { folders: [], folderContents: {} },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useFolderStructureCopy', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let copy: StructureCopy;
  let clipboardDescriptor: PropertyDescriptor | undefined;
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    vi.useFakeTimers();
    writeText.mockResolvedValue(undefined);
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    else Reflect.deleteProperty(navigator, 'clipboard');
    vi.useRealTimers();
  });

  const render = (sourceTabId = 12) => {
    act(() => {
      root?.render(<Harness sourceTabId={sourceTabId} capture={(next) => (copy = next)} />);
    });
  };

  it('copies the supplied tab structure with the selected language and original account URL', async () => {
    vi.mocked(browser.tabs.sendMessage).mockResolvedValue(structure('Research notes'));
    render();
    await act(async () => copy.onCopy());

    expect(browser.tabs.query).not.toHaveBeenCalled();
    expect(browser.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(12, {
      type: 'gv.folders.getStructureForAI',
    });
    expect(writeText).toHaveBeenCalledOnce();
    const text = writeText.mock.calls[0][0];
    expect(text).toContain('Research notes');
    expect(text).toContain('https://gemini.google.com/u/1/app/conversation-1');
    expect(text).toContain('Please respond in **中文**');
    expect(copy.status).toBe('copied');
    act(() => vi.advanceTimersByTime(1999));
    expect(copy.status).toBe('copied');
    act(() => vi.advanceTimersByTime(1));
    expect(copy.status).toBe('idle');
  });

  it('reports an empty sidebar without replacing the clipboard', async () => {
    vi.mocked(browser.tabs.sendMessage).mockResolvedValue({
      ...structure('unused'),
      sidebarConversations: [],
    });
    render();
    await act(async () => copy.onCopy());
    expect(copy.status).toBe('empty');
    expect(writeText).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(3999));
    expect(copy.status).toBe('empty');
    act(() => vi.advanceTimersByTime(1));
    expect(copy.status).toBe('idle');
  });

  it('copies only the latest request when responses arrive out of order', async () => {
    const oldRequest = deferred<ReturnType<typeof structure>>();
    vi.mocked(browser.tabs.sendMessage)
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce(structure('Current result'));
    render();
    let oldCopy!: Promise<void>;
    act(() => {
      oldCopy = copy.onCopy();
    });
    expect(copy.status).toBe('loading');
    await act(async () => copy.onCopy());
    await act(async () => {
      oldRequest.resolve(structure('Obsolete result'));
      await oldCopy;
    });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0]).toContain('Current result');
    expect(writeText.mock.calls[0][0]).not.toContain('Obsolete result');
    expect(copy.status).toBe('copied');
  });

  it('discards a response when the source tab changes or the popup unmounts', async () => {
    const oldRequest = deferred<ReturnType<typeof structure>>();
    const closingRequest = deferred<ReturnType<typeof structure>>();
    vi.mocked(browser.tabs.sendMessage)
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(closingRequest.promise);
    render();
    let oldCopy!: Promise<void>;
    act(() => {
      oldCopy = copy.onCopy();
    });
    render(24);
    await act(async () => {
      oldRequest.resolve(structure('Old tab'));
      await oldCopy;
    });
    expect(copy.status).toBe('idle');
    expect(writeText).not.toHaveBeenCalled();

    let closingCopy!: Promise<void>;
    act(() => {
      closingCopy = copy.onCopy();
    });
    act(() => root?.unmount());
    root = null;
    await act(async () => {
      closingRequest.resolve(structure('Closed popup'));
      await closingCopy;
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an earlier reset while copying again and clears the final reset on unmount', async () => {
    const nextRequest = deferred<ReturnType<typeof structure>>();
    vi.mocked(browser.tabs.sendMessage)
      .mockResolvedValueOnce(structure('First result'))
      .mockReturnValueOnce(nextRequest.promise);
    render();
    await act(async () => copy.onCopy());
    act(() => vi.advanceTimersByTime(1000));
    let nextCopy!: Promise<void>;
    act(() => {
      nextCopy = copy.onCopy();
    });
    act(() => vi.advanceTimersByTime(2000));
    expect(copy.status).toBe('loading');
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      nextRequest.resolve(structure('Next result'));
      await nextCopy;
    });
    expect(copy.status).toBe('copied');
    expect(vi.getTimerCount()).toBe(1);
    act(() => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });
});
