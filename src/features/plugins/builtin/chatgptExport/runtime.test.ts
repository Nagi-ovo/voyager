import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startChatGptExportPlugin, stopChatGptExportPlugin } from './runtime';

const mocks = vi.hoisted(() => ({
  startExportButton: vi.fn(),
}));

vi.mock('@/pages/content/export', () => ({
  startExportButton: mocks.startExportButton,
}));

describe('ChatGPT export builtin plugin lifecycle', () => {
  beforeEach(() => {
    stopChatGptExportPlugin();
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopChatGptExportPlugin();
  });

  it('retains the export entry cleanup while the plugin is mounted', async () => {
    const cleanup = vi.fn();
    mocks.startExportButton.mockResolvedValue(cleanup);

    startChatGptExportPlugin();

    await vi.waitFor(() => expect(mocks.startExportButton).toHaveBeenCalledOnce());
    const signal = mocks.startExportButton.mock.calls[0][0].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await vi.waitFor(() => expect(mocks.startExportButton).toHaveResolved());

    stopChatGptExportPlugin();
    expect(signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('aborts the stale lifecycle before starting a replacement', async () => {
    mocks.startExportButton.mockResolvedValue(vi.fn());

    startChatGptExportPlugin();
    await vi.waitFor(() => expect(mocks.startExportButton).toHaveBeenCalledTimes(1));
    const firstSignal = mocks.startExportButton.mock.calls[0][0].signal as AbortSignal;
    stopChatGptExportPlugin();
    startChatGptExportPlugin();
    await vi.waitFor(() => expect(mocks.startExportButton).toHaveBeenCalledTimes(2));

    expect(firstSignal.aborted).toBe(true);
    expect((mocks.startExportButton.mock.calls[1][0].signal as AbortSignal).aborted).toBe(false);
  });

  it('cleans up a late export mount when the plugin was already disabled', async () => {
    let resolveStart: (cleanup: () => void) => void = () => {
      throw new Error('Expected deferred export start resolver.');
    };
    const cleanup = vi.fn();
    mocks.startExportButton.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveStart = resolve;
      }),
    );

    startChatGptExportPlugin();
    stopChatGptExportPlugin();
    resolveStart(cleanup);

    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  });
});
