import { describe, expect, it, vi } from 'vitest';

import { startNativeFormulaCopyForContent } from './formulaCopyStartup';

describe('formula copy content startup', () => {
  it('registers cleanup after a successful start', async () => {
    const destroy = vi.fn();
    const registerCleanup = vi.fn();

    await startNativeFormulaCopyForContent({
      start: vi.fn().mockResolvedValue({ destroy }),
      registerCleanup,
    });

    expect(registerCleanup).toHaveBeenCalledWith(destroy);
  });

  it('reports an isolated startup failure without rejecting', async () => {
    const error = new Error('formula copy setup failed');
    const reportError = vi.fn();
    const registerCleanup = vi.fn();

    await expect(
      startNativeFormulaCopyForContent({
        start: vi.fn().mockRejectedValue(error),
        registerCleanup,
        reportError,
      }),
    ).resolves.toBeUndefined();

    expect(reportError).toHaveBeenCalledWith(error);
    expect(registerCleanup).not.toHaveBeenCalled();
  });

  it('preserves the outer shutdown path when the extension context is invalidated', async () => {
    const error = new Error('Extension context invalidated.');
    const reportError = vi.fn();

    await expect(
      startNativeFormulaCopyForContent({
        start: vi.fn().mockRejectedValue(error),
        registerCleanup: vi.fn(),
        reportError,
      }),
    ).rejects.toBe(error);

    expect(reportError).not.toHaveBeenCalled();
  });

  it('destroys a started controller if cleanup registration fails', async () => {
    const destroy = vi.fn();
    const error = new Error('cleanup registration failed');
    const reportError = vi.fn();

    await startNativeFormulaCopyForContent({
      start: vi.fn().mockResolvedValue({ destroy }),
      registerCleanup: () => {
        throw error;
      },
      reportError,
    });

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(error);
  });
});
