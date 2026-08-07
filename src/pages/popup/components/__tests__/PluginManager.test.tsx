import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginManifest } from '@/features/plugins/types';

import { PluginManager, platformBadge } from '../PluginManager';

// The slider-debounce behaviour under test lives in PluginManager; the storage
// layer is mocked so we can assert exactly how often (and with what value) the
// persistence call fires. `vi.hoisted` lets the (hoisted) vi.mock factory below
// reference these without a TDZ error.
const {
  setPluginEnabled,
  setPluginSetting,
  permissionContains,
  permissionRequest,
  runtimeSendMessage,
  permissionOrigins,
  pluginState,
  PLUGIN_ID,
  mockLanguage,
  supportsDynamicRegistration,
} = vi.hoisted(() => ({
  setPluginEnabled: vi.fn().mockResolvedValue(undefined),
  setPluginSetting: vi.fn().mockResolvedValue(undefined),
  permissionContains: vi.fn().mockResolvedValue(false),
  permissionRequest: vi.fn().mockResolvedValue(true),
  runtimeSendMessage: vi.fn().mockResolvedValue({ ok: true }),
  permissionOrigins: vi.fn().mockReturnValue([]),
  pluginState: { current: {} as Record<string, { enabled: boolean; installedAt: number }> },
  PLUGIN_ID: 'voyager.test-width',
  mockLanguage: { current: 'en' },
  supportsDynamicRegistration: vi.fn(() => true),
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    permissions: {
      contains: permissionContains,
      request: permissionRequest,
    },
    runtime: {
      sendMessage: runtimeSendMessage,
    },
  },
}));

vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: mockLanguage.current,
    setLanguage: vi.fn(),
    t: (key: string) => key,
  }),
}));

vi.mock('@/core/utils/browser', () => ({
  isFirefox: () => false,
  supportsDynamicContentScriptRegistration: () => supportsDynamicRegistration(),
  supportsOptionalHostPermissions: () => true,
}));

vi.mock('@/features/plugins/runtime/siteRegistration', () => ({
  pluginToOriginPatternsForActiveUrl: permissionOrigins,
}));

vi.mock('@/features/plugins/storage/pluginState', () => ({
  setPluginSetting,
  setPluginEnabled,
  setPluginCollapsed: vi.fn().mockResolvedValue(undefined),
  loadCollapsedPlugins: vi.fn().mockResolvedValue([]),
  loadPluginState: vi.fn().mockImplementation(async () => pluginState.current),
  subscribePluginState: vi.fn().mockReturnValue(() => {}),
}));

const widthPlugin: PluginManifest = {
  id: PLUGIN_ID,
  name: 'Test · Width',
  version: '1.0.0',
  description: 'Adjustable width',
  i18n: {
    zh: {
      name: '测试 · 宽度',
      description: '可调节宽度',
      settings: {
        width: {
          label: '阅读宽度（px）',
          minLabel: '更窄',
          maxLabel: '更宽',
        },
      },
    },
  },
  author: 'Test',
  category: 'readability',
  license: 'MIT',
  engine: '>=1.0.0',
  tier: 'declarative',
  matches: ['https://claude.ai/*'],
  contributes: {
    settings: {
      width: {
        type: 'number',
        label: 'Reading width (px)',
        minLabel: 'Narrower',
        maxLabel: 'Wider',
        default: 768,
        min: 600,
        max: 1600,
      },
    },
  },
};

const compactTimelinePlugin: PluginManifest = {
  ...widthPlugin,
  name: 'Claude · Timeline',
  description: 'Timeline with two visual styles',
  i18n: {
    zh: {
      settings: { compactView: { label: '使用紧凑索引' } },
    },
  },
  contributes: {
    settings: {
      compactView: {
        type: 'boolean',
        label: 'Use compact timeline',
        default: false,
      },
    },
  },
};

let container: HTMLElement;
let root: Root;

function nativeSetSliderValue(input: HTMLInputElement, value: number): void {
  // Bypass React's value tracker so the synthetic onChange fires.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function render(plugin: PluginManifest = widthPlugin): Promise<void> {
  await act(async () => {
    root.render(React.createElement(PluginManager, { manifests: [plugin] }));
  });
  // Let the async state hydration (loadPluginState) resolve so the plugin shows
  // as enabled and its settings slider is rendered.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  mockLanguage.current = 'en';
  pluginState.current = { [PLUGIN_ID]: { enabled: true, installedAt: 0 } };
  setPluginEnabled.mockClear();
  setPluginSetting.mockClear();
  permissionContains.mockReset().mockResolvedValue(false);
  permissionRequest.mockReset().mockResolvedValue(true);
  runtimeSendMessage.mockReset().mockResolvedValue({ ok: true });
  permissionOrigins.mockReset().mockReturnValue([]);
  supportsDynamicRegistration.mockReset().mockReturnValue(true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  // Some tests unmount mid-body to exercise the flush-on-close path; unmounting
  // again here is a no-op but guard it so React doesn't warn.
  try {
    act(() => root.unmount());
  } catch {
    /* already unmounted */
  }
  container.remove();
  vi.useRealTimers();
});

describe('PluginManager setting slider', () => {
  it('renders localized range labels from the plugin i18n map', async () => {
    mockLanguage.current = 'zh';
    await render();

    expect(container.textContent).toContain('阅读宽度（px）');
    expect(container.textContent).toContain('768');
    expect(container.textContent).toContain('更窄');
    expect(container.textContent).toContain('更宽');
    expect(container.textContent).not.toContain('Reading width (px)');
  });

  it('debounces rapid drag changes into a single storage write with the final value', async () => {
    await render();
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider).toBeTruthy();

    act(() => {
      for (const v of [800, 900, 1000, 1100, 1300]) nativeSetSliderValue(slider, v);
    });

    // Mid-drag: nothing persisted yet.
    expect(setPluginSetting).not.toHaveBeenCalled();

    // After the debounce window: exactly one write, carrying the last value.
    act(() => vi.advanceTimersByTime(200));
    expect(setPluginSetting).toHaveBeenCalledTimes(1);
    expect(setPluginSetting).toHaveBeenCalledWith(PLUGIN_ID, 'width', 1300);
  });

  it('flushes a pending write when the popup unmounts mid-drag', async () => {
    await render();
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;

    act(() => nativeSetSliderValue(slider, 1024));
    expect(setPluginSetting).not.toHaveBeenCalled();

    act(() => root.unmount());

    expect(setPluginSetting).toHaveBeenCalledTimes(1);
    expect(setPluginSetting).toHaveBeenCalledWith(PLUGIN_ID, 'width', 1024);
  });
});

describe('PluginManager boolean setting', () => {
  it('renders a localized switch and persists changes immediately', async () => {
    mockLanguage.current = 'zh';
    await render(compactTimelinePlugin);

    const input = container.querySelector('input[aria-label="使用紧凑索引"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.checked).toBe(false);

    act(() => input.click());

    expect(input.checked).toBe(true);
    expect(setPluginSetting).toHaveBeenCalledOnce();
    expect(setPluginSetting).toHaveBeenCalledWith(PLUGIN_ID, 'compactView', true);
  });
});

describe('PluginManager host permission flow', () => {
  beforeEach(() => {
    pluginState.current = { [PLUGIN_ID]: { enabled: false, installedAt: 0 } };
    permissionOrigins.mockReturnValue(['https://chatgpt.com/*']);
  });

  it('reuses an existing site grant without requesting permission again', async () => {
    permissionContains.mockResolvedValue(true);
    await act(async () => {
      root.render(
        React.createElement(PluginManager, {
          manifests: [widthPlugin],
          activeUrl: 'https://chatgpt.com/c/current',
        }),
      );
      await Promise.resolve();
    });

    const toggle = container.querySelector<HTMLInputElement>('input[aria-label="Test · Width"]');
    if (!toggle) throw new Error('Expected plugin toggle');
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });

    expect(permissionContains).toHaveBeenCalledWith({ origins: ['https://chatgpt.com/*'] });
    expect(permissionRequest).not.toHaveBeenCalled();
    expect(setPluginEnabled).toHaveBeenCalledWith(PLUGIN_ID, true);
  });

  it('persists enable intent and explicitly reconciles after the host grant resolves', async () => {
    let resolvePermission: (granted: boolean) => void = () => {};
    permissionRequest.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolvePermission = resolve;
      }),
    );
    await act(async () => {
      root.render(
        React.createElement(PluginManager, {
          manifests: [widthPlugin],
          activeUrl: 'https://chatgpt.com/c/current',
        }),
      );
      await Promise.resolve();
    });

    const toggle = container.querySelector<HTMLInputElement>('input[aria-label="Test · Width"]');
    if (!toggle) throw new Error('Expected plugin toggle');
    await act(async () => {
      toggle.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setPluginEnabled).toHaveBeenCalledWith(PLUGIN_ID, true);
    expect(permissionRequest).toHaveBeenCalledWith({ origins: ['https://chatgpt.com/*'] });
    expect(setPluginEnabled.mock.invocationCallOrder[0]).toBeLessThan(
      permissionRequest.mock.invocationCallOrder[0],
    );

    await act(async () => {
      resolvePermission(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runtimeSendMessage).toHaveBeenCalledWith({ type: 'gv.plugins.syncContentScripts' });
    expect(permissionRequest.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeSendMessage.mock.invocationCallOrder[0],
    );
  });

  it('refuses the host grant when dynamic registration is unavailable', async () => {
    supportsDynamicRegistration.mockReturnValue(false);
    await act(async () => {
      root.render(
        React.createElement(PluginManager, {
          manifests: [widthPlugin],
          activeUrl: 'https://chatgpt.com/c/current',
        }),
      );
      await Promise.resolve();
    });

    const toggle = container.querySelector<HTMLInputElement>('input[aria-label="Test · Width"]');
    if (!toggle) throw new Error('Expected plugin toggle');
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });

    expect(permissionRequest).not.toHaveBeenCalled();
    expect(setPluginEnabled).not.toHaveBeenCalledWith(PLUGIN_ID, true);
  });

  it('repairs a missing companion-origin grant for an already-enabled plugin', async () => {
    pluginState.current = { [PLUGIN_ID]: { enabled: true, installedAt: 0 } };
    permissionOrigins.mockReturnValue([
      'https://claude.ai/*',
      'https://*.frame.claudeusercontent.com/*',
    ]);
    permissionContains.mockResolvedValue(false);

    await act(async () => {
      root.render(
        React.createElement(PluginManager, {
          manifests: [widthPlugin],
          activeUrl: 'https://claude.ai/code/artifact/example',
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const repairButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'pluginGrantRequiredAccess',
    );
    if (!repairButton) throw new Error('Expected permission repair button');
    expect(container.querySelector('input[type="range"]')).not.toBeNull();

    await act(async () => {
      repairButton.click();
      await Promise.resolve();
    });

    expect(permissionRequest).toHaveBeenCalledWith({
      origins: ['https://claude.ai/*', 'https://*.frame.claudeusercontent.com/*'],
    });
    expect(runtimeSendMessage).toHaveBeenCalledWith({ type: 'gv.plugins.syncContentScripts' });
    expect(container.textContent).not.toContain('pluginGrantRequiredAccess');
    expect(container.querySelector('input[type="range"]')).not.toBeNull();
  });

  it('keeps the permission repair available when content-script sync fails', async () => {
    pluginState.current = { [PLUGIN_ID]: { enabled: true, installedAt: 0 } };
    permissionOrigins.mockReturnValue([
      'https://claude.ai/*',
      'https://*.frame.claudeusercontent.com/*',
    ]);
    permissionContains.mockResolvedValue(false);
    runtimeSendMessage.mockRejectedValue(new Error('background unavailable'));

    await act(async () => {
      root.render(
        React.createElement(PluginManager, {
          manifests: [widthPlugin],
          activeUrl: 'https://claude.ai/code/artifact/example',
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const repairButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'pluginGrantRequiredAccess',
    );
    if (!repairButton) throw new Error('Expected permission repair button');

    await act(async () => {
      repairButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runtimeSendMessage).toHaveBeenCalledWith({ type: 'gv.plugins.syncContentScripts' });
    expect(container.textContent).toContain('pluginGrantRequiredAccess');
  });
});

describe('platformBadge', () => {
  const formulaCopy: PluginManifest = {
    id: 'voyager.formula-copy',
    name: 'Formula Copy',
    version: '1.0.0',
    description: 'd',
    author: 'a',
    category: 'productivity',
    license: 'MIT',
    engine: '>=1.0.0',
    tier: 'declarative',
    matches: ['https://claude.ai/*', 'https://chatgpt.com/*', 'https://chat.openai.com/*'],
    contributes: {},
  };

  it('uses the CURRENT site colour for a multi-site plugin', () => {
    expect(platformBadge(formulaCopy, 'chatgpt')?.color).toBe('#0ea5e9');
    expect(platformBadge(formulaCopy, 'claude')?.color).toBe('#d97757');
  });

  it('prefers the plugin-declared theme.brand over the site default', () => {
    const themed = { ...formulaCopy, theme: { brand: '#123456' } };
    expect(platformBadge(themed, 'chatgpt')?.color).toBe('#123456');
  });

  it('falls back to the first matched host when the current site is unknown', () => {
    // No currentSiteId → infer from matches (claude is listed first).
    expect(platformBadge(formulaCopy, undefined)?.color).toBe('#d97757');
  });
});
