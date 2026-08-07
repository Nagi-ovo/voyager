import { describe, expect, it, vi } from 'vitest';

import { PluginScope } from '../../runtime/pluginScope';
import { activateInputVimPlugin } from './index';

const mocks = vi.hoisted(() => ({
  startInputVimMode: vi.fn(),
}));

vi.mock('@/pages/content/chatInput/vimMode', () => ({
  startInputVimMode: mocks.startInputVimMode,
}));

describe('input Vim builtin plugin lifecycle', () => {
  it('forces Vim on while the plugin is mounted and cleans up on scope disposal', async () => {
    const cleanup = vi.fn();
    mocks.startInputVimMode.mockResolvedValue(cleanup);

    const scope = new PluginScope();
    activateInputVimPlugin(scope);

    expect(mocks.startInputVimMode).toHaveBeenCalledOnce();
    expect(mocks.startInputVimMode).toHaveBeenCalledWith({ forceEnabled: true });

    await scope.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('cleans up a late async start when the scope was already disposed', async () => {
    let resolveStart!: (cleanup: () => void) => void;
    const cleanup = vi.fn();
    mocks.startInputVimMode.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveStart = resolve;
      }),
    );

    const scope = new PluginScope();
    activateInputVimPlugin(scope);
    const disposal = scope.dispose();
    resolveStart(cleanup);

    await disposal;
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
