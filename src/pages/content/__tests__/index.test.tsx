import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pluginCleanup: vi.fn(),
}));

// The entrypoint IIFE calls these modules before its early returns. Mock them
// all to no-ops so the plugin-platform / custom-website entry paths can be
// exercised without mounting real features.
vi.mock('@/features/plugins', () => ({
  startPluginHost: () => mocks.pluginCleanup,
}));
vi.mock('@/features/formulaCopy', () => ({
  startFormulaCopy: () => {},
}));
vi.mock('@/utils/i18n', () => ({
  initI18n: async () => undefined,
}));
vi.mock('../visualEffects', () => ({
  startVisualEffects: () => {},
}));
vi.mock('../accountContext', () => ({
  startAccountContextBridge: () => () => {},
}));
vi.mock('../pluginNativeRegistration', () => ({
  registerBuiltinNativeHandlers: () => {},
}));
vi.mock('../platformTheme', () => ({
  startBrandTheme: () => () => {},
}));
vi.mock('../remoteAnnouncements/index', () => ({
  startRemoteAnnouncements: () => () => {},
}));
vi.mock('../storageQuotaWarning', () => ({
  startStorageQuotaWarningToast: () => () => {},
}));
vi.mock('../katexConfig', () => ({
  initKaTeXConfig: () => {},
}));
vi.mock('../prompt/index', () => ({
  startPromptManager: async () => ({ destroy: () => {} }),
}));
vi.mock('../prompt/slashPromptFeature', () => ({
  startSlashPromptFeature: async () => ({ destroy: () => {} }),
}));
vi.mock('../prompt/customSiteCoverage', () => ({
  createCustomSiteCoverageReconciler: () => ({
    handleChange: () => {},
    destroy: () => {},
  }),
}));

function mockUrl(url: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new URL(url),
  });
}

function mockCustomWebsites(hosts: string[]): void {
  (chrome.storage.sync.get as unknown as Mock).mockImplementation(
    (
      _keys: unknown,
      callback?: (result: Record<string, unknown>) => void,
    ): Promise<Record<string, unknown>> => {
      const result = { gvPromptCustomWebsites: hosts };
      if (typeof callback === 'function') callback(result);
      return Promise.resolve(result);
    },
  );
}

beforeEach(() => {
  vi.resetModules();
  mocks.pluginCleanup.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('content entrypoint beforeunload cleanup registration', () => {
  it('registers beforeunload cleanup on the plugin-platform early return', async () => {
    mockUrl('https://claude.ai/');
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    await import('../index');

    expect(addEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  }, 15_000);

  it('registers beforeunload cleanup on the custom-website entry', async () => {
    mockUrl('https://example.com/');
    mockCustomWebsites(['example.com']);
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    await import('../index');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(addEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  it('executes registered cleanups when beforeunload fires', async () => {
    mockUrl('https://claude.ai/');
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    await import('../index');

    const beforeunloadHandler = addEventListenerSpy.mock.calls.find(
      (call) => (call[0] as string) === 'beforeunload',
    )?.[1] as (() => void) | undefined;
    expect(beforeunloadHandler).toBeDefined();

    expect(() => beforeunloadHandler?.()).not.toThrow();
    expect(mocks.pluginCleanup).toHaveBeenCalledTimes(1);
  });
});
