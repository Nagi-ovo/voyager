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
    await vi.waitFor(() => expect(mocks.startExportButton).toHaveResolved());

    stopChatGptExportPlugin();
    expect(cleanup).toHaveBeenCalledOnce();
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
