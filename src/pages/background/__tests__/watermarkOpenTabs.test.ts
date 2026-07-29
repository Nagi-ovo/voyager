import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { injectWatermarkInterceptorIntoOpenTabs } from '../watermarkOpenTabs';

const originalScriptingDescriptor = Object.getOwnPropertyDescriptor(chrome, 'scripting');

describe('injectWatermarkInterceptorIntoOpenTabs', () => {
  const executeScript = vi.fn();
  const queryTabs = chrome.tabs.query as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executeScript.mockReset();
    queryTabs.mockReset();
    Object.defineProperty(chrome, 'scripting', {
      value: { executeScript },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalScriptingDescriptor) {
      Object.defineProperty(chrome, 'scripting', originalScriptingDescriptor);
    } else {
      Reflect.deleteProperty(chrome, 'scripting');
    }
  });

  it('injects the MAIN-world interceptor into every matching open tab', async () => {
    queryTabs.mockResolvedValue([{ id: 11 }, { id: 22 }, { url: 'https://gemini.google.com/app' }]);
    executeScript.mockResolvedValue([]);

    await injectWatermarkInterceptorIntoOpenTabs([
      'https://gemini.google.com/*',
      'https://aistudio.google.com/*',
    ]);

    expect(chrome.tabs.query).toHaveBeenCalledWith({
      url: ['https://gemini.google.com/*', 'https://aistudio.google.com/*'],
    });
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript).toHaveBeenNthCalledWith(1, {
      target: { tabId: 11 },
      files: ['fetchInterceptor.js'],
      world: 'MAIN',
    });
    expect(executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 22 },
      files: ['fetchInterceptor.js'],
      world: 'MAIN',
    });
  });

  it('ignores tabs that close or reject injection during the one-shot sync', async () => {
    queryTabs.mockResolvedValue([{ id: 11 }, { id: 22 }]);
    executeScript.mockRejectedValueOnce(new Error('tab closed')).mockResolvedValueOnce([]);

    await expect(
      injectWatermarkInterceptorIntoOpenTabs(['https://gemini.google.com/*']),
    ).resolves.toBeUndefined();
    expect(executeScript).toHaveBeenCalledTimes(2);
  });

  it('does nothing when matching tabs cannot be queried', async () => {
    queryTabs.mockRejectedValue(new Error('tabs unavailable'));

    await expect(
      injectWatermarkInterceptorIntoOpenTabs(['https://gemini.google.com/*']),
    ).resolves.toBeUndefined();
    expect(executeScript).not.toHaveBeenCalled();
  });
});
