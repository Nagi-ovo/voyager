import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findChatInput: vi.fn<() => HTMLElement | null>(),
  getTranslationSync: vi.fn((key: string) => key),
  hasSlashEligiblePrompts: vi.fn((items: unknown[]) => items.length > 0),
  initI18n: vi.fn(async () => undefined),
  isGeminiSlashPromptSurface: vi.fn(() => true),
  promptStorageGet: vi.fn(),
  showCoachmark: vi.fn(async (_config: unknown) => 'dismissed'),
  storageGet: vi.fn(async (defaults?: Record<string, unknown>) => defaults ?? {}),
  storageSet: vi.fn(async () => undefined),
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      sync: {
        get: mocks.storageGet,
        set: mocks.storageSet,
      },
    },
  },
}));

vi.mock('@/core/services/StorageService', () => ({
  promptStorageService: {
    get: mocks.promptStorageGet,
  },
}));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: mocks.getTranslationSync,
  initI18n: mocks.initI18n,
}));

vi.mock('../../chatInput', () => ({
  findChatInput: mocks.findChatInput,
}));

vi.mock('../../coachmark', () => ({
  showCoachmark: mocks.showCoachmark,
}));

vi.mock('../slashPrompt', () => ({
  hasSlashEligiblePrompts: mocks.hasSlashEligiblePrompts,
  isGeminiSlashPromptSurface: mocks.isGeminiSlashPromptSurface,
}));

interface CapturedCoachmarkConfig {
  anchor: () => HTMLElement | null;
  focusOnOpen?: boolean;
  id: string;
  toggle: {
    initial: boolean;
    onChange: (enabled: boolean) => Promise<void>;
  };
}

describe('slash prompt coachmark', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '';
    mocks.isGeminiSlashPromptSurface.mockReturnValue(true);
    mocks.storageGet.mockImplementation(
      async (defaults?: Record<string, unknown>) => defaults ?? {},
    );
    mocks.promptStorageGet.mockResolvedValue({ success: true, data: [] });
    mocks.hasSlashEligiblePrompts.mockImplementation((items: unknown[]) => items.length > 0);
  });

  it('is eligible only when the setting is enabled and a usable Prompt exists', async () => {
    const { isSlashPromptCoachmarkEligible } = await import('../slashPromptCoachmark');

    expect(await isSlashPromptCoachmarkEligible()).toBe(false);

    mocks.promptStorageGet.mockResolvedValue({
      success: true,
      data: [{ id: 'prompt-1', name: 'Review', text: 'Review this', tags: [], createdAt: 1 }],
    });
    expect(await isSlashPromptCoachmarkEligible()).toBe(true);

    mocks.storageGet.mockResolvedValue({ gvSlashPromptEnabled: false });
    expect(await isSlashPromptCoachmarkEligible()).toBe(false);
  });

  it('anchors without changing the composer draft or focus', async () => {
    const composer = document.createElement('div');
    composer.contentEditable = 'true';
    composer.tabIndex = 0;
    composer.textContent = 'unfinished draft';
    document.body.appendChild(composer);
    composer.focus();
    mocks.findChatInput.mockReturnValue(composer);
    mocks.promptStorageGet.mockResolvedValue({
      success: true,
      data: [{ id: 'prompt-1', name: 'Review', text: 'Review this', tags: [], createdAt: 1 }],
    });

    const { maybeShowSlashPromptCoachmark } = await import('../slashPromptCoachmark');
    await maybeShowSlashPromptCoachmark();

    const config = mocks.showCoachmark.mock.calls[0]![0] as CapturedCoachmarkConfig;
    expect(config.id).toBe('slash-prompt-insertion-intro');
    expect(config.focusOnOpen).toBe(false);
    expect(config.anchor()).toBe(composer);
    expect(composer.textContent).toBe('unfinished draft');
    expect(document.activeElement).toBe(composer);
  });

  it('keeps the inline switch synchronized through the slash setting key', async () => {
    mocks.promptStorageGet.mockResolvedValue({
      success: true,
      data: [{ id: 'prompt-1', name: 'Review', text: 'Review this', tags: [], createdAt: 1 }],
    });
    const { maybeShowSlashPromptCoachmark } = await import('../slashPromptCoachmark');
    await maybeShowSlashPromptCoachmark();

    const config = mocks.showCoachmark.mock.calls[0]![0] as CapturedCoachmarkConfig;
    expect(config.toggle.initial).toBe(true);
    await config.toggle.onChange(false);
    expect(mocks.storageSet).toHaveBeenCalledWith({ gvSlashPromptEnabled: false });
  });

  it('can be forced by the debug event without an eligible Prompt', async () => {
    const { SLASH_PROMPT_COACHMARK_DEBUG_EVENT } = await import('../slashPromptCoachmark');

    document.dispatchEvent(new Event(SLASH_PROMPT_COACHMARK_DEBUG_EVENT));

    await vi.waitFor(() => expect(mocks.showCoachmark).toHaveBeenCalled());
  });

  it('skips outside Gemini without mounting or marking anything', async () => {
    mocks.isGeminiSlashPromptSurface.mockReturnValue(false);
    const { maybeShowSlashPromptCoachmark } = await import('../slashPromptCoachmark');

    expect(await maybeShowSlashPromptCoachmark({ force: true })).toBe('skipped');
    expect(mocks.showCoachmark).not.toHaveBeenCalled();
  });
});
