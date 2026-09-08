import React, { act, useEffect } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { useActivePopupTab } from '../useActivePopupTab';

vi.mock('webextension-polyfill', () => ({
  default: { tabs: { get: vi.fn(), query: vi.fn() } },
}));

type TabContext = ReturnType<typeof useActivePopupTab>;

function Harness({
  sourceTabId,
  capture,
}: {
  sourceTabId?: number;
  capture: (context: TabContext) => void;
}) {
  const context = useActivePopupTab(sourceTabId);
  useEffect(() => {
    capture(context);
  }, [capture, context]);
  return null;
}

function tab(id: number, url: string): browser.Tabs.Tab {
  return { id, url, index: 0, active: true, highlighted: true, pinned: false, incognito: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useActivePopupTab', () => {
  let container: HTMLDivElement;
  let root: Root;
  let context: TabContext;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    vi.mocked(browser.tabs.query).mockResolvedValue([]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (sourceTabId?: number) => {
    await act(async () => {
      root.render(<Harness sourceTabId={sourceTabId} capture={(next) => (context = next)} />);
    });
  };

  it('uses the supplied source tab even when another tab is active', async () => {
    const source = tab(12, 'https://aistudio.google.com/u/1/prompts/source');
    vi.mocked(browser.tabs.get).mockResolvedValue(source);
    vi.mocked(browser.tabs.query).mockResolvedValue([tab(99, 'https://chatgpt.com/c/active')]);
    await render(12);
    expect(context).toMatchObject({
      activeTabId: 12,
      activeUrl: source.url,
      activeAccountPlatform: 'aistudio',
      activeTabContextLoaded: true,
    });
    expect(browser.tabs.get).toHaveBeenCalledWith(12);
    expect(browser.tabs.query).not.toHaveBeenCalled();
  });

  it('falls back to the active tab when the source tab has closed', async () => {
    vi.mocked(browser.tabs.get).mockRejectedValue(new Error('No tab with id: 12'));
    const active = tab(99, 'https://chatgpt.com/c/active');
    vi.mocked(browser.tabs.query).mockResolvedValue([active]);
    await render(12);
    expect(context).toMatchObject({
      activeTabId: 99,
      activeUrl: active.url,
      activeAccountPlatform: 'gemini',
      activeTabContextLoaded: true,
    });
    expect(browser.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });

  it('ignores a late response for a previous source tab', async () => {
    const oldRequest = deferred<browser.Tabs.Tab>();
    const newRequest = deferred<browser.Tabs.Tab>();
    vi.mocked(browser.tabs.get)
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    await render(12);
    expect(context.activeTabContextLoaded).toBe(false);
    await render(24);
    const current = tab(24, 'https://gemini.google.com/u/1/app/current');
    await act(async () => newRequest.resolve(current));
    await act(async () => oldRequest.resolve(tab(12, 'https://aistudio.google.com/prompts/old')));
    expect(context).toMatchObject({
      activeTabId: 24,
      activeUrl: current.url,
      activeAccountPlatform: 'gemini',
      activeTabContextLoaded: true,
    });
  });

  it('keeps the last context if refreshing the active window fails', async () => {
    const current = tab(24, 'https://gemini.google.com/app/current');
    vi.mocked(browser.tabs.query).mockResolvedValueOnce([current]);
    await render();
    vi.mocked(browser.tabs.query).mockRejectedValueOnce(new Error('Window closed'));
    await act(async () => context.refreshActiveTabContext());
    expect(context.activeTabId).toBe(24);
    expect(context.activeUrl).toBe(current.url);
    expect(context.activeTabContextLoaded).toBe(true);
    expect(browser.tabs.get).not.toHaveBeenCalled();
  });
});
