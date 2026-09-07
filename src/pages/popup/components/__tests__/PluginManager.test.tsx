import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enMessages from '@locales/en/messages.json';

import type { PluginManifest } from '@/features/plugins/types';

import { PluginManager, type PluginManagerProps, platformBadge } from '../PluginManager';
import { IconDeepSeek } from '../WebsiteLogos';

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
  mockMessages,
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
  // Translations resolve to their key by default (so assertions stay readable);
  // a test that exercises a placeholder loads the real English template here.
  mockMessages: { current: {} as Record<string, string> },
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
    t: (key: string) => mockMessages.current[key] ?? key,
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

/** Let queued storage reads (plugin state, catalog settings, catalog cache) settle. */
async function flushEffects(rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
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

async function renderManager(props: Partial<PluginManagerProps> = {}): Promise<void> {
  await act(async () => {
    root.render(React.createElement(PluginManager, { manifests: [widthPlugin], ...props }));
  });
  await flushEffects();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  mockLanguage.current = 'en';
  mockMessages.current = {};
  (chrome.storage.sync.get as unknown as Mock).mockReset().mockResolvedValue({});
  (chrome.storage.sync.set as unknown as Mock).mockReset().mockResolvedValue(undefined);
  (chrome.storage.local.get as unknown as Mock).mockReset().mockResolvedValue({});
  (chrome.storage.onChanged.addListener as unknown as Mock).mockReset();
  (chrome.storage.onChanged.removeListener as unknown as Mock).mockReset();
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

describe('PluginManager accessible plugin identity', () => {
  it('keeps the complete localized platform name on collapsed headers', async () => {
    mockLanguage.current = 'zh';
    const plugin: PluginManifest = {
      ...widthPlugin,
      name: 'Claude · Reading width',
      i18n: { zh: { name: 'Claude · 阅读宽度' } },
    };
    await render(plugin);
    const header = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    expect(header?.getAttribute('aria-label')).toBe('Claude · 阅读宽度');
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    act(() => header?.click());
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(header?.getAttribute('aria-label')).toBe('Claude · 阅读宽度');
  });

  it('groups identically named controls under their owning plugins', async () => {
    const second: PluginManifest = {
      ...widthPlugin,
      id: 'voyager.second-width',
      name: 'ChatGPT · Width',
      matches: ['https://chatgpt.com/*'],
    };
    pluginState.current[second.id] = { enabled: true, installedAt: 0 };
    await act(async () => {
      root.render(React.createElement(PluginManager, { manifests: [widthPlugin, second] }));
    });
    const groups = Array.from(container.querySelectorAll('[role="group"]'));
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'Test · Width',
      'ChatGPT · Width',
    ]);
    for (const group of groups) {
      expect(group.querySelector('input[type="range"]')?.getAttribute('aria-label')).toBe(
        'Reading width (px)',
      );
    }
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

  it('uses the bundled DeepSeek icon and accent for the active platform', () => {
    const plugin = {
      ...formulaCopy,
      matches: [...formulaCopy.matches, 'https://chat.deepseek.com/*'],
    };
    const badge = platformBadge(plugin, 'deepseek');
    expect(badge?.color).toBe('#4d6bfe');
    expect(React.isValidElement(badge?.icon) && badge.icon.type).toBe(IconDeepSeek);
  });

  it('does not use the active DeepSeek badge for a plugin that excludes DeepSeek', () => {
    const badge = platformBadge(
      { ...formulaCopy, matches: ['https://claude.ai/*'] },
      'deepseek',
      'https://chat.deepseek.com/a/chat/s/current',
    );
    expect(badge).toBeNull();
  });

  it('recognizes a DeepSeek-only plugin before a site adapter is available', () => {
    const badge = platformBadge({ ...formulaCopy, matches: ['https://chat.deepseek.com/*'] });
    expect(badge?.color).toBe('#4d6bfe');
    expect(React.isValidElement(badge?.icon) && badge.icon.type).toBe(IconDeepSeek);
  });

  it('preserves a DeepSeek plugin custom accent', () => {
    const plugin = {
      ...formulaCopy,
      matches: ['https://chat.deepseek.com/*'],
      theme: { brand: '#123456' },
    };
    expect(platformBadge(plugin)?.color).toBe('#123456');
    expect(platformBadge(plugin, 'deepseek')?.color).toBe('#123456');
  });

  it.each(['https://chat.deepseek.com.example.org/*', 'https://example.org/chat.deepseek.com/*'])(
    'does not mislabel unrelated matches %s as DeepSeek',
    (pattern) => expect(platformBadge({ ...formulaCopy, matches: [pattern] })).toBeNull(),
  );

  it('prefers the plugin-declared theme.brand over the site default', () => {
    // Existing platforms retain their own fallback colour.
    const themed = { ...formulaCopy, theme: { brand: '#123456' } };
    expect(platformBadge(themed, 'chatgpt')?.color).toBe('#123456');
  });

  it.each([
    'https://notclaude.ai/*',
    'https://claude.ai.example.org/*',
    'https://notchatgpt.com/*',
    'https://chat.openai.com.example.org/*',
    'https://api.openai.com/*',
    'https://example.org/claude.ai/*',
  ])('does not infer an official chat platform from %s', (pattern) => {
    expect(platformBadge({ ...formulaCopy, matches: [pattern] })).toBeNull();
  });

  it.each([
    ['https://claude.ai/*', '#d97757'],
    ['https://chatgpt.com/*', '#0ea5e9'],
    ['https://chat.openai.com/*', '#0ea5e9'],
    ['*://chatgpt.com/*', '#0ea5e9'],
    ['http://chat.deepseek.com/*', '#4d6bfe'],
    ['*://chat.deepseek.com/*', '#4d6bfe'],
  ])('recognizes the exact chat host in %s', (pattern, color) => {
    expect(platformBadge({ ...formulaCopy, matches: [pattern] })?.color).toBe(color);
  });

  it('falls back to the first matched host when the current site is unknown', () => {
    // No currentSiteId → infer from matches (claude is listed first).
    expect(platformBadge(formulaCopy, undefined)?.color).toBe('#d97757');
  });
});

describe('PluginManager platform name display', () => {
  it('removes the DeepSeek prefix when the platform badge is shown', async () => {
    const plugin: PluginManifest = {
      ...widthPlugin,
      name: 'DeepSeek · Comfortable Reading Width',
      matches: ['https://chat.deepseek.com/*'],
    };
    await render(plugin);
    const header = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    expect(header?.textContent).toContain('Comfortable Reading Width');
    expect(header?.textContent).not.toContain('DeepSeek ·');
  });
});

describe('PluginManager plugin provenance', () => {
  it.each([
    ['builtin', 'pluginSourceBuiltin'],
    ['bundled-catalog', 'pluginSourceBundled'],
    ['host-catalog', 'pluginSourceOnline'],
  ])('shows the version and the %s source label', async (sourceId, labelKey) => {
    await renderManager({ sourceIds: { [PLUGIN_ID]: sourceId } });

    expect(container.textContent).toContain(`v${widthPlugin.version} · ${labelKey}`);
  });

  it('shows the version alone when the plugin has no known source', async () => {
    await renderManager({ sourceIds: { [PLUGIN_ID]: 'some-future-source' } });

    expect(container.textContent).toContain(`v${widthPlugin.version}`);
    expect(container.textContent).not.toContain(`v${widthPlugin.version} ·`);
  });

  it('names the held-back version when an update needs a newer Voyager', async () => {
    mockMessages.current = {
      pluginUpdateNeedsNewerVoyager: enMessages.pluginUpdateNeedsNewerVoyager.message,
    };
    await renderManager({
      blockedUpdates: { [PLUGIN_ID]: { version: '2.4.0', engine: '>=9.0.0' } },
    });

    expect(container.textContent).toContain('2.4.0');
    expect(container.textContent).not.toContain('{version}');
  });

  it('says nothing about updates when none are held back', async () => {
    mockMessages.current = {
      pluginUpdateNeedsNewerVoyager: enMessages.pluginUpdateNeedsNewerVoyager.message,
    };
    await renderManager({ blockedUpdates: {} });

    expect(container.textContent).not.toContain('needs a newer Voyager');
  });
});

describe('PluginManager online catalog controls', () => {
  const CATALOG_HOST = 'claude.ai';
  const CACHE_KEY = `gvPluginHostCatalog:${CATALOG_HOST}`;

  function cachedCatalog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      host: CATALOG_HOST,
      status: 'ok',
      manifests: [],
      fetchedAt: 0,
      lastAttemptAt: 0,
      failureCount: 0,
      extensionVersion: '1.0.0',
      ...overrides,
    };
  }

  function onlineUpdatesToggle(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="pluginsOnlineUpdates"]',
    );
    if (!input) throw new Error('Expected the online-updates switch');
    return input;
  }

  function chooseInterval(value: string): void {
    const select = container.querySelector('select');
    if (!select) throw new Error('Expected the check-interval select');
    // Bypass React's value tracker so the synthetic onChange fires.
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('reflects the stored settings and hides the interval while updates are off', async () => {
    (chrome.storage.sync.get as unknown as Mock).mockResolvedValue({
      gvPluginOnlineUpdatesEnabled: false,
      gvPluginCatalogCheckInterval: '24h',
    });

    await renderManager({ catalogHost: CATALOG_HOST });

    expect(onlineUpdatesToggle().checked).toBe(false);
    expect(container.querySelector('select')).toBeNull();
  });

  it('persists the online-updates switch', async () => {
    await renderManager({ catalogHost: CATALOG_HOST });
    const toggle = onlineUpdatesToggle();
    expect(toggle.checked).toBe(true);

    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });

    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ gvPluginOnlineUpdatesEnabled: false });
    expect(onlineUpdatesToggle().checked).toBe(false);
    expect(container.querySelector('select')).toBeNull();
  });

  it('persists the chosen check interval', async () => {
    (chrome.storage.sync.get as unknown as Mock).mockResolvedValue({
      gvPluginOnlineUpdatesEnabled: true,
      gvPluginCatalogCheckInterval: '6h',
    });
    await renderManager({ catalogHost: CATALOG_HOST });

    await act(async () => {
      chooseInterval('1h');
      await Promise.resolve();
    });

    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ gvPluginCatalogCheckInterval: '1h' });
    expect(container.querySelector<HTMLSelectElement>('select')?.value).toBe('1h');
  });

  it('omits the whole block on a host that can never have a catalog', async () => {
    await renderManager({});

    expect(container.querySelector('input[aria-label="pluginsOnlineUpdates"]')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
    expect(container.textContent).not.toContain('pluginsOnlineUpdatesHint');
    expect(container.textContent).not.toContain('pluginsNeverChecked');
  });

  it('reports that no check has run yet when nothing is cached', async () => {
    await renderManager({ catalogHost: CATALOG_HOST });

    expect(container.textContent).toContain('pluginsNeverChecked');
  });

  it('reports the localized time of the last attempt', async () => {
    const lastAttemptAt = Date.UTC(2026, 1, 3, 4, 5, 6);
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      [CACHE_KEY]: cachedCatalog({ lastAttemptAt, fetchedAt: lastAttemptAt }),
    });
    mockMessages.current = { pluginsLastChecked: enMessages.pluginsLastChecked.message };

    await renderManager({ catalogHost: CATALOG_HOST });

    expect(container.textContent).toContain(new Date(lastAttemptAt).toLocaleString());
    expect(container.textContent).not.toContain('{time}');
    expect(container.textContent).not.toContain('pluginsNeverChecked');
  });

  it('says the site has no online catalog instead of dating a 404', async () => {
    const lastAttemptAt = Date.UTC(2026, 1, 3, 4, 5, 6);
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      [CACHE_KEY]: cachedCatalog({ status: 'missing', lastAttemptAt, fetchedAt: lastAttemptAt }),
    });
    mockMessages.current = { pluginsLastChecked: enMessages.pluginsLastChecked.message };

    await renderManager({ catalogHost: CATALOG_HOST });

    expect(container.textContent).toContain('pluginsNoOnlineCatalog');
    expect(container.textContent).not.toContain(new Date(lastAttemptAt).toLocaleString());
  });

  it('re-reads the cache once a manual check finishes', async () => {
    await renderManager({ catalogHost: CATALOG_HOST, refreshing: true });
    expect(container.textContent).toContain('pluginsNeverChecked');

    const lastAttemptAt = Date.UTC(2026, 1, 3, 4, 5, 6);
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      [CACHE_KEY]: cachedCatalog({ lastAttemptAt, fetchedAt: lastAttemptAt }),
    });
    mockMessages.current = { pluginsLastChecked: enMessages.pluginsLastChecked.message };

    await renderManager({ catalogHost: CATALOG_HOST, refreshing: false });

    expect(container.textContent).toContain(new Date(lastAttemptAt).toLocaleString());
  });
});
