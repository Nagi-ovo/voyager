import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  startChatGptExportPlugin,
  stopChatGptExportPlugin,
} from '@/features/plugins/builtin/chatgptExport';

const mocks = vi.hoisted(() => ({
  startChatGptExport: vi.fn(),
  stopChatGptExport: vi.fn(),
}));

vi.mock('@/pages/content/export', () => ({
  startChatGptExport: mocks.startChatGptExport,
  stopChatGptExport: mocks.stopChatGptExport,
}));

describe('ChatGPT export builtin plugin lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopChatGptExportPlugin();
  });

  it('starts the ChatGPT export runtime through the plugin lifecycle', async () => {
    mocks.startChatGptExport.mockResolvedValue(undefined);

    startChatGptExportPlugin();

    await vi.waitFor(() => expect(mocks.startChatGptExport).toHaveBeenCalledOnce());
  });

  it('stops the ChatGPT export runtime when the plugin unmounts', () => {
    stopChatGptExportPlugin();

    expect(mocks.stopChatGptExport).toHaveBeenCalledOnce();
  });
});
