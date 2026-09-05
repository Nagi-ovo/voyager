import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { FolderNavigation } from '../FolderNavigation';

const { mockBrowserStorage } = vi.hoisted(() => ({
  mockBrowserStorage: {
    local: { set: vi.fn(), get: vi.fn(), remove: vi.fn() },
    sync: { get: vi.fn(), set: vi.fn() },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    storage: mockBrowserStorage,
  },
}));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

interface LocationMock {
  pathname: string;
  origin: string;
  href: string;
  reload: ReturnType<typeof vi.fn>;
}

describe('createNewChatInFolder', () => {
  let navigation: FolderNavigation;
  let locationMock: LocationMock;
  let originalLocation: Location;
  let pushStateSpy: MockInstance<typeof window.history.pushState>;

  beforeEach(() => {
    navigation = new FolderNavigation({
      getContext: () => ({
        container: null,
        sidebar: null,
        isDestroyed: false,
        accountIsolationEnabled: false,
      }),
      onRouteChange: vi.fn(),
      onOpened: vi.fn(),
      onTitleChange: vi.fn(),
      onGemDetected: vi.fn(),
    });
    originalLocation = window.location;
    locationMock = {
      pathname: '/app',
      origin: 'https://gemini.google.com',
      href: '',
      reload: vi.fn(),
    };
    Object.defineProperty(window, 'location', {
      value: locationMock,
      writable: true,
      configurable: true,
    });
    pushStateSpy = vi.spyOn(window.history, 'pushState');
    mockBrowserStorage.local.set.mockReset();
    mockBrowserStorage.local.set.mockResolvedValue(undefined);
    mockBrowserStorage.sync.get.mockResolvedValue({});
    mockBrowserStorage.local.get.mockResolvedValue({});
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
    navigation.destroy();
    vi.restoreAllMocks();
  });

  it('writes the pending folder ID to storage.local', async () => {
    navigation.createNewChatInFolder('folder-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockBrowserStorage.local.set).toHaveBeenCalledWith({
      [StorageKeys.FOLDER_PROJECT_PENDING_FOLDER_ID]: 'folder-1',
    });
  });

  it('reloads when already on /app', async () => {
    locationMock.pathname = '/app';

    navigation.createNewChatInFolder('folder-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(locationMock.reload).toHaveBeenCalledTimes(1);
    expect(locationMock.href).toBe('');
  });

  it('navigates to /app via SPA route (no full page load) from a conversation page', async () => {
    locationMock.pathname = '/app/abc123def456';

    navigation.createNewChatInFolder('folder-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/app');
    expect(locationMock.href).toBe('');
    expect(locationMock.reload).not.toHaveBeenCalled();
  });

  it('preserves the multi-account user prefix (/u/N/app)', async () => {
    locationMock.pathname = '/u/2/c/abc';

    navigation.createNewChatInFolder('folder-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/u/2/app');
    expect(locationMock.href).toBe('');
  });

  it('falls back to a hard navigation when the History API path fails', async () => {
    locationMock.pathname = '/app/abc123def456';
    pushStateSpy.mockImplementation(() => {
      throw new Error('pushState blocked');
    });

    navigation.createNewChatInFolder('folder-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(locationMock.href).toBe('https://gemini.google.com/app');
    expect(locationMock.reload).not.toHaveBeenCalled();
  });

  it('still navigates (SPA) when storage.set rejects with a generic error', async () => {
    mockBrowserStorage.local.set.mockRejectedValue(new Error('quota exceeded'));
    locationMock.pathname = '/app/abc';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    navigation.createNewChatInFolder('folder-1');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/app');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not navigate when extension context is invalidated', async () => {
    mockBrowserStorage.local.set.mockRejectedValue(new Error('Extension context invalidated.'));
    locationMock.pathname = '/app/abc';

    navigation.createNewChatInFolder('folder-1');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(locationMock.href).toBe('');
    expect(locationMock.reload).not.toHaveBeenCalled();
  });
});
