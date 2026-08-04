import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { extractConvId, isNewChatPath, waitForElement } from '../index';

// Mock getTranslationSyncUnsafe used inside the module
vi.mock('@/utils/i18n', () => ({
  getTranslationSyncUnsafe: (key: string) => key,
}));

// Mock folderColors used inside the module
vi.mock('../../folder/folderColors', () => ({
  getFolderColor: () => '#4285f4',
  isDarkMode: () => false,
}));

// Track setInputText calls across tests. Declared outside the mock factory
// because vi.mock is hoisted above module-level variables.
const setInputTextCalls: Array<{ input: HTMLElement; text: string }> = [];
vi.mock('../../utils/inputHelper', () => ({
  setInputText: (input: HTMLElement, text: string) => {
    setInputTextCalls.push({ input, text });
    input.textContent = text;
  },
}));

// findChatInput returns whatever element has id="test-chat-input" in the DOM.
vi.mock('../../chatInput/index', () => ({
  findChatInput: () => document.querySelector<HTMLElement>('#test-chat-input'),
}));

// ============================================================================
// isNewChatPath
// ============================================================================

describe('isNewChatPath', () => {
  it('matches /app', () => {
    expect(isNewChatPath('/app')).toBe(true);
  });

  it('matches /app/', () => {
    expect(isNewChatPath('/app/')).toBe(true);
  });

  it('matches /u/0/app', () => {
    expect(isNewChatPath('/u/0/app')).toBe(true);
  });

  it('matches /u/1/app/', () => {
    expect(isNewChatPath('/u/1/app/')).toBe(true);
  });

  it('does NOT match /app/<convId>', () => {
    expect(isNewChatPath('/app/abc123')).toBe(false);
  });

  it('matches /gem/<gemId>', () => {
    expect(isNewChatPath('/gem/mygem')).toBe(true);
  });

  it('matches /gem/<gemId>/', () => {
    expect(isNewChatPath('/gem/mygem/')).toBe(true);
  });

  it('does NOT match /gem/<gemId>/<convId>', () => {
    expect(isNewChatPath('/gem/mygem/conv123')).toBe(false);
  });

  it('does NOT match other paths', () => {
    expect(isNewChatPath('/settings')).toBe(false);
    expect(isNewChatPath('/')).toBe(false);
  });
});

// ============================================================================
// extractConvId
// ============================================================================

describe('extractConvId', () => {
  it('extracts convId from /app/<id>', () => {
    expect(extractConvId('/app/abc123')).toBe('abc123');
  });

  it('extracts convId from /u/0/app/<id>', () => {
    expect(extractConvId('/u/0/app/xyz789')).toBe('xyz789');
  });

  it('returns null for /app (no convId)', () => {
    expect(extractConvId('/app')).toBeNull();
  });

  it('returns null for /app/', () => {
    expect(extractConvId('/app/')).toBeNull();
  });

  it('extracts convId from /gem/<gemId>/<convId>', () => {
    expect(extractConvId('/gem/mygem/conv123')).toBe('conv123');
  });

  it('returns null for /gem/<gemId> (no convId)', () => {
    expect(extractConvId('/gem/mygem')).toBeNull();
  });

  it('returns null for unrelated paths', () => {
    expect(extractConvId('/settings')).toBeNull();
  });
});

// ============================================================================
// waitForElement
// ============================================================================

describe('waitForElement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('resolves immediately when element already exists with nonzero height', async () => {
    document.body.innerHTML = '<div id="target" style="height:10px">hello</div>';
    const el = document.getElementById('target')!;
    // jsdom getBoundingClientRect returns 0 by default; mock it
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      height: 10,
    } as DOMRect);

    const promise = waitForElement('#target', 1000);
    // resolve animation frame
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe(el);
  });

  it('resolves null on timeout if element never appears', async () => {
    const promise = waitForElement('#nonexistent', 100);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBeNull();
  });
});

// ============================================================================
// startFolderProject — feature-off skip
// ============================================================================

describe('startFolderProject — feature disabled', () => {
  beforeEach(() => {
    // Feature disabled in storage
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_defaults: Record<string, unknown>, callback: (result: Record<string, unknown>) => void) => {
        callback({ [StorageKeys.FOLDER_PROJECT_ENABLED]: false });
      },
    );
  });

  it('does not inject a picker when feature is disabled', async () => {
    document.body.innerHTML = '<rich-textarea></rich-textarea>';

    const { startFolderProject } = await import('../index');
    const mockManager = {
      getFolders: vi.fn().mockReturnValue([]),
      ensureDataLoaded: vi.fn().mockResolvedValue(undefined),
      addConversationToFolderFromNative: vi.fn(),
    };

    startFolderProject(mockManager as unknown as Parameters<typeof startFolderProject>[0]);

    // No picker should be injected
    expect(document.querySelector('.gv-fp-picker-container')).toBeNull();
  });
});

// ============================================================================
// waitForElement — model selector target
// ============================================================================

describe('waitForElement — model selector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('resolves when .input-area-switch-label exists with nonzero height', async () => {
    const btn = document.createElement('button');
    btn.className = 'input-area-switch-label';
    btn.textContent = 'Pro';
    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({ height: 20 } as DOMRect);
    document.body.appendChild(btn);

    const promise = waitForElement('.input-area-switch-label', 1000);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe(btn);
  });

  it('resolves null when model selector does not appear within timeout', async () => {
    const promise = waitForElement('.input-area-switch-label', 100);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBeNull();
  });
});

// ============================================================================
// startFolderProject — runtime toggle
// ============================================================================

describe('startFolderProject — runtime toggle', () => {
  let storageListeners: Array<
    (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
  >;

  beforeEach(() => {
    vi.resetModules();
    storageListeners = [];
    document.body.innerHTML = '';

    // Capture onChanged listeners registered by startFolderProject
    (
      chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(
      (listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => {
        storageListeners.push(listener);
      },
    );
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('does not initialize when toggled on in non-sync area', async () => {
    // Feature starts disabled
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_defaults: Record<string, unknown>, callback: (result: Record<string, unknown>) => void) => {
        callback({ [StorageKeys.FOLDER_PROJECT_ENABLED]: false });
      },
    );

    const { startFolderProject } = await import('../index');
    const mockManager = {
      getFolders: vi.fn().mockReturnValue([]),
      ensureDataLoaded: vi.fn().mockResolvedValue(undefined),
      addConversationToFolderFromNative: vi.fn(),
    };
    startFolderProject(mockManager as unknown as Parameters<typeof startFolderProject>[0]);

    // Simulate toggle in 'local' area (not 'sync') — should be ignored
    for (const listener of storageListeners) {
      listener(
        { [StorageKeys.FOLDER_PROJECT_ENABLED]: { newValue: true, oldValue: false } },
        'local',
      );
    }

    expect(document.querySelector('.gv-fp-picker-container')).toBeNull();
  });

  it('removes picker when feature is toggled off', async () => {
    // Feature starts enabled
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_defaults: Record<string, unknown>, callback: (result: Record<string, unknown>) => void) => {
        callback({ [StorageKeys.FOLDER_PROJECT_ENABLED]: true });
      },
    );

    const { startFolderProject } = await import('../index');
    const mockManager = {
      getFolders: vi.fn().mockReturnValue([]),
      ensureDataLoaded: vi.fn().mockResolvedValue(undefined),
      addConversationToFolderFromNative: vi.fn(),
    };
    startFolderProject(mockManager as unknown as Parameters<typeof startFolderProject>[0]);

    // Simulate toggle off
    for (const listener of storageListeners) {
      listener(
        { [StorageKeys.FOLDER_PROJECT_ENABLED]: { newValue: false, oldValue: true } },
        'sync',
      );
    }

    expect(document.querySelector('.gv-fp-picker-container')).toBeNull();
  });

  it('does not inject the picker when the feature is disabled during a slow page load (L9)', async () => {
    vi.useFakeTimers();
    window.history.pushState({}, '', '/app');

    try {
      // Feature starts enabled
      (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (
          _defaults: Record<string, unknown>,
          callback: (result: Record<string, unknown>) => void,
        ) => {
          callback({ [StorageKeys.FOLDER_PROJECT_ENABLED]: true });
        },
      );

      const { startFolderProject } = await import('../index');
      const mockManager = {
        getFolders: vi.fn().mockReturnValue([]),
        ensureDataLoaded: vi.fn().mockResolvedValue(undefined),
        addConversationToFolderFromNative: vi.fn(),
      };
      // injectPicker starts awaiting .model-picker-container (not in DOM yet).
      startFolderProject(mockManager as unknown as Parameters<typeof startFolderProject>[0]);

      // Feature is toggled off while injectPicker is still waiting.
      for (const listener of storageListeners) {
        listener(
          { [StorageKeys.FOLDER_PROJECT_ENABLED]: { newValue: false, oldValue: true } },
          'sync',
        );
      }

      // The slow page finally renders the anchor element.
      const modelPicker = document.createElement('div');
      modelPicker.className = 'model-picker-container';
      vi.spyOn(modelPicker, 'getBoundingClientRect').mockReturnValue({ height: 20 } as DOMRect);
      document.body.appendChild(modelPicker);

      await vi.runAllTimersAsync();

      // Nothing may be injected after the disable — nobody would clean it up.
      expect(document.querySelector('.gv-fp-picker-container')).toBeNull();
    } finally {
      vi.useRealTimers();
      window.history.pushState({}, '', '/');
    }
  });
});

// ============================================================================
// applyPendingFolderSelection
// ============================================================================

describe('applyPendingFolderSelection', () => {
  const mockFolders = [
    { id: 'folder-1', name: 'Work', instructions: 'Be professional', parentId: null },
    { id: 'folder-2', name: 'Personal', instructions: null, parentId: null },
  ];

  let chip: HTMLButtonElement;

  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '';
    chip = document.createElement('button');
    chip.className = 'gv-fp-chip';
    chip.textContent = 'Select folder…';
    // Clear call history on local storage mocks
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockClear();
    (chrome.storage.local.remove as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-selects folder when pending ID exists in storage', async () => {
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      [StorageKeys.FOLDER_PROJECT_PENDING_FOLDER_ID]: 'folder-1',
    });
    (chrome.storage.local.remove as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    const { applyPendingFolderSelection } = await import('../index');
    const mockManager = {
      getFolders: vi.fn().mockReturnValue(mockFolders),
      ensureDataLoaded: vi.fn().mockResolvedValue(undefined),
      addConversationToFolderFromNative: vi.fn(),
    };

    await applyPendingFolderSelection(
      mockManager as unknown as Parameters<typeof applyPendingFolderSelection>[0],
      chip,
    );

    expect(chip.textContent).toBe('📁 Work');
    expect(chip.dataset.selected).toBe('folder-1');
    expect(chrome.storage.local.remove).toHaveBeenCalledWith([
      StorageKeys.FOLDER_PROJECT_PENDING_FOLDER_ID,
    ]);
  });

  it('does nothing when no pending folder ID exists', async () => {
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const { applyPendingFolderSelection } = await import('../index');
    const mockManager = {
      getFolders: vi.fn().mockReturnValue(mockFolders),
      ensureDataLoaded: vi.fn().mockResolvedValue(undefined),
      addConversationToFolderFromNative: vi.fn(),
    };

    await applyPendingFolderSelection(
      mockManager as unknown as Parameters<typeof applyPendingFolderSelection>[0],
      chip,
    );

    expect(chip.textContent).toBe('Select folder…');
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  });

  it('clears pending ID even when folder ID does not match any folder', async () => {
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      [StorageKeys.FOLDER_PROJECT_PENDING_FOLDER_ID]: 'nonexistent',
    });
    (chrome.storage.local.remove as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    const { applyPendingFolderSelection } = await import('../index');
    const mockManager = {
      getFolders: vi.fn().mockReturnValue(mockFolders),
      ensureDataLoaded: vi.fn().mockResolvedValue(undefined),
      addConversationToFolderFromNative: vi.fn(),
    };

    await applyPendingFolderSelection(
      mockManager as unknown as Parameters<typeof applyPendingFolderSelection>[0],
      chip,
    );

    expect(chip.textContent).toBe('Select folder…');
    expect(chrome.storage.local.remove).toHaveBeenCalledWith([
      StorageKeys.FOLDER_PROJECT_PENDING_FOLDER_ID,
    ]);
  });
});
// ============================================================================
// Regression: follow-up message should not re-inject instructions when the
// pendingSend timer fires before the URL change is detected (slow responses).
// See: fix/folder-project-followup-injection
// ============================================================================

describe('follow-up injection regression', () => {
  let originalPathname: string;
  let storageListeners: Array<
    (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
  >;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    document.body.innerHTML = '';
    setInputTextCalls.length = 0;
    storageListeners = [];

    // Capture any onChanged listener registered by startFolderProject so we
    // can invoke the module's own teardown path in afterEach. Without this,
    // document/window event listeners and the 500ms URL-watcher interval
    // leak across tests and can cause cross-test flakiness.
    (chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockImplementation(
        (
          listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void,
        ) => {
          storageListeners.push(listener);
        },
      );

    // Default: feature on, Ctrl+Enter off
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_defaults: Record<string, unknown>, callback: (result: Record<string, unknown>) => void) => {
        callback({
          [StorageKeys.FOLDER_PROJECT_ENABLED]: true,
          [StorageKeys.CTRL_ENTER_SEND]: false,
        });
      },
    );

    // Start on /app
    originalPathname = window.location.pathname;
    window.history.pushState({}, '', '/app');
  });

  afterEach(() => {
    // Trigger the module's own disable path so stopURLWatcher() +
    // teardownSendDetection() remove document/window listeners and clear
    // the URL polling interval before the next test runs.
    for (const listener of storageListeners) {
      listener(
        { [StorageKeys.FOLDER_PROJECT_ENABLED]: { newValue: false, oldValue: true } },
        'sync',
      );
    }
    window.history.pushState({}, '', originalPathname);
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('does not re-inject instructions on follow-up when URL change is delayed past the 60s pendingSend timeout', async () => {
    // Chat input that findChatInput() can locate
    const chatInput = document.createElement('div');
    chatInput.id = 'test-chat-input';
    chatInput.setAttribute('contenteditable', 'true');
    chatInput.setAttribute('role', 'textbox');
    document.body.appendChild(chatInput);

    // .model-picker-container (needed by injectPicker)
    const modelPicker = document.createElement('div');
    modelPicker.className = 'model-picker-container';
    const modelBtn = document.createElement('button');
    modelPicker.appendChild(modelBtn);
    document.body.appendChild(modelPicker);
    vi.spyOn(modelPicker, 'getBoundingClientRect').mockReturnValue({ height: 40 } as DOMRect);

    const mockManager = {
      getFolders: vi.fn().mockReturnValue([
        {
          id: 'f1',
          name: 'TestFolder',
          parentId: null,
          isExpanded: false,
          createdAt: 0,
          updatedAt: 0,
          instructions: 'Be concise.',
        },
      ]),
      ensureDataLoaded: vi.fn().mockResolvedValue(undefined),
      addConversationToFolderFromNative: vi.fn(),
    };

    const { startFolderProject } = await import('../index');
    startFolderProject(mockManager as unknown as Parameters<typeof startFolderProject>[0]);

    // Let the picker inject (waitForElement resolves immediately because the
    // model-picker-container already exists with height > 0). A short advance
    // flushes the pending microtasks without entering the 500ms URL polling.
    await vi.advanceTimersByTimeAsync(50);

    // Open the dropdown and select the folder
    const chip = document.querySelector<HTMLButtonElement>('.gv-fp-chip');
    expect(chip).not.toBeNull();
    chip!.click();
    await vi.advanceTimersByTimeAsync(50);

    const folderItem = Array.from(document.querySelectorAll<HTMLElement>('.gv-fp-item')).find(
      (el) => el.textContent?.includes('TestFolder'),
    );
    expect(folderItem).toBeDefined();
    folderItem!.click();

    // User types a message and presses Enter — capture-phase listener injects instructions
    chatInput.textContent = 'summarize this paper';
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(enterEvent, 'target', { value: chatInput, configurable: true });
    document.dispatchEvent(enterEvent);

    const firstInjections = setInputTextCalls.filter((c) =>
      c.text.includes('[System Instructions]'),
    );
    expect(firstInjections).toHaveLength(1);

    // Very slow response: 60s pendingSend timer fires before URL change.
    // Must exceed PENDING_SEND_TIMEOUT_MS in the production code.
    await vi.advanceTimersByTimeAsync(61_000);

    // URL finally changes to the new conversation
    window.history.pushState({}, '', '/app/conv1');

    // Let the URL watcher (500ms poll) detect the change
    await vi.advanceTimersByTimeAsync(700);

    // Follow-up Enter on the conversation page
    const followUpEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(followUpEvent, 'target', { value: chatInput, configurable: true });
    document.dispatchEvent(followUpEvent);

    // The fix: selectedFolder* must be cleared in handleNavigation's else branch,
    // so the follow-up keydown must NOT prepend the instruction block again.
    const allInjections = setInputTextCalls.filter((c) => c.text.includes('[System Instructions]'));
    expect(allInjections).toHaveLength(1);
  });

  it('does not auto-assign the clicked conversation when user clicks sidebar link after sending', async () => {
    const chatInput = document.createElement('div');
    chatInput.id = 'test-chat-input';
    chatInput.setAttribute('contenteditable', 'true');
    chatInput.setAttribute('role', 'textbox');
    document.body.appendChild(chatInput);

    const modelPicker = document.createElement('div');
    modelPicker.className = 'model-picker-container';
    modelPicker.appendChild(document.createElement('button'));
    document.body.appendChild(modelPicker);
    vi.spyOn(modelPicker, 'getBoundingClientRect').mockReturnValue({ height: 40 } as DOMRect);

    const mockManager = {
      getFolders: vi.fn().mockReturnValue([
        {
          id: 'f1',
          name: 'TestFolder',
          parentId: null,
          isExpanded: false,
          createdAt: 0,
          updatedAt: 0,
          instructions: 'Be concise.',
        },
      ]),
      ensureDataLoaded: vi.fn().mockResolvedValue(undefined),
      addConversationToFolderFromNative: vi.fn(),
    };

    const { startFolderProject } = await import('../index');
    startFolderProject(mockManager as unknown as Parameters<typeof startFolderProject>[0]);
    await vi.advanceTimersByTimeAsync(50);

    // Select a folder
    const chip = document.querySelector<HTMLButtonElement>('.gv-fp-chip');
    chip!.click();
    await vi.advanceTimersByTimeAsync(50);
    const folderItem = Array.from(document.querySelectorAll<HTMLElement>('.gv-fp-item')).find(
      (el) => el.textContent?.includes('TestFolder'),
    );
    folderItem!.click();

    // User types and presses Enter — pendingSend=true
    chatInput.textContent = 'a real prompt';
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(enterEvent, 'target', { value: chatInput, configurable: true });
    document.dispatchEvent(enterEvent);

    // Instead of waiting for the response, user clicks an existing sidebar
    // conversation link. This must cancel the pending send claim so the
    // subsequent URL change is NOT attributed to the folder assignment.
    const sidebarLink = document.createElement('a');
    sidebarLink.href = '/app/existing-conv-42';
    sidebarLink.textContent = 'Yesterday chat';
    document.body.appendChild(sidebarLink);
    sidebarLink.click();

    // Simulate the URL change triggered by the sidebar click
    window.history.pushState({}, '', '/app/existing-conv-42');
    await vi.advanceTimersByTimeAsync(700);

    // Critical: the clicked (existing) conversation must NOT be added to the
    // folder. The capture-phase sidebar listener should have cleared
    // pendingSend before handleNavigation ran.
    expect(mockManager.addConversationToFolderFromNative).not.toHaveBeenCalled();
  });

  it('does NOT cancel pendingSend when the user middle-clicks, Ctrl-clicks, or Cmd-clicks a sidebar link (opens in new tab)', async () => {
    const chatInput = document.createElement('div');
    chatInput.id = 'test-chat-input';
    chatInput.setAttribute('contenteditable', 'true');
    chatInput.setAttribute('role', 'textbox');
    document.body.appendChild(chatInput);

    const modelPicker = document.createElement('div');
    modelPicker.className = 'model-picker-container';
    modelPicker.appendChild(document.createElement('button'));
    document.body.appendChild(modelPicker);
    vi.spyOn(modelPicker, 'getBoundingClientRect').mockReturnValue({ height: 40 } as DOMRect);

    const mockManager = {
      getFolders: vi.fn().mockReturnValue([
        {
          id: 'f1',
          name: 'TestFolder',
          parentId: null,
          isExpanded: false,
          createdAt: 0,
          updatedAt: 0,
          instructions: 'Be concise.',
        },
      ]),
      ensureDataLoaded: vi.fn().mockResolvedValue(undefined),
      addConversationToFolderFromNative: vi.fn(),
    };

    const { startFolderProject } = await import('../index');
    startFolderProject(mockManager as unknown as Parameters<typeof startFolderProject>[0]);
    await vi.advanceTimersByTimeAsync(50);

    // Select a folder
    document.querySelector<HTMLButtonElement>('.gv-fp-chip')!.click();
    await vi.advanceTimersByTimeAsync(50);
    Array.from(document.querySelectorAll<HTMLElement>('.gv-fp-item'))
      .find((el) => el.textContent?.includes('TestFolder'))!
      .click();

    // Send (with actual user text)
    chatInput.textContent = 'a real prompt';
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(enterEvent, 'target', { value: chatInput, configurable: true });
    document.dispatchEvent(enterEvent);

    // User middle-clicks AND Ctrl-clicks a sidebar link to open in new
    // tabs/windows — the current tab's URL will NOT change in either case,
    // so pendingSend must stay true. If it gets wrongly cleared here, the
    // subsequent (legitimate) URL change from Gemini's send would be skipped
    // and the new conversation wouldn't be assigned.
    const sidebarLink = document.createElement('a');
    sidebarLink.href = '/app/existing-conv-42';
    document.body.appendChild(sidebarLink);

    const middleClick = new MouseEvent('click', {
      bubbles: true,
      button: 1, // middle mouse button
    });
    sidebarLink.dispatchEvent(middleClick);

    const ctrlClick = new MouseEvent('click', {
      bubbles: true,
      button: 0,
      ctrlKey: true,
    });
    sidebarLink.dispatchEvent(ctrlClick);

    const metaClick = new MouseEvent('click', {
      bubbles: true,
      button: 0,
      metaKey: true, // Cmd-click on macOS
    });
    sidebarLink.dispatchEvent(metaClick);

    // Now the legitimate URL change from the actual send completes
    window.history.pushState({}, '', '/app/real-new-conv');
    await vi.advanceTimersByTimeAsync(700);

    // The real new conversation MUST be assigned to the folder.
    expect(mockManager.addConversationToFolderFromNative).toHaveBeenCalledTimes(1);
    expect(mockManager.addConversationToFolderFromNative).toHaveBeenCalledWith(
      'f1',
      'real-new-conv',
      expect.any(String),
      expect.any(String),
      false,
      undefined,
      expect.any(Number),
    );
  });

  it('cancels pendingSend when user presses browser back button (popstate), preventing misassignment to the previously viewed conversation', async () => {
    const chatInput = document.createElement('div');
    chatInput.id = 'test-chat-input';
    chatInput.setAttribute('contenteditable', 'true');
    chatInput.setAttribute('role', 'textbox');
    document.body.appendChild(chatInput);

    const modelPicker = document.createElement('div');
    modelPicker.className = 'model-picker-container';
    modelPicker.appendChild(document.createElement('button'));
    document.body.appendChild(modelPicker);
    vi.spyOn(modelPicker, 'getBoundingClientRect').mockReturnValue({ height: 40 } as DOMRect);

    const mockManager = {
      getFolders: vi.fn().mockReturnValue([
        {
          id: 'f1',
          name: 'TestFolder',
          parentId: null,
          isExpanded: false,
          createdAt: 0,
          updatedAt: 0,
          instructions: 'Be concise.',
        },
      ]),
      ensureDataLoaded: vi.fn().mockResolvedValue(undefined),
      addConversationToFolderFromNative: vi.fn(),
    };

    const { startFolderProject } = await import('../index');
    startFolderProject(mockManager as unknown as Parameters<typeof startFolderProject>[0]);
    await vi.advanceTimersByTimeAsync(50);

    // Select folder, send on /app
    document.querySelector<HTMLButtonElement>('.gv-fp-chip')!.click();
    await vi.advanceTimersByTimeAsync(50);
    Array.from(document.querySelectorAll<HTMLElement>('.gv-fp-item'))
      .find((el) => el.textContent?.includes('TestFolder'))!
      .click();

    chatInput.textContent = 'a real prompt';
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(enterEvent, 'target', { value: chatInput, configurable: true });
    document.dispatchEvent(enterEvent);

    // User hits browser Back. This updates the URL and fires popstate.
    // Without the fix, pendingSend stays true and handleNavigation would
    // wrongly add the conversation the user went *back* to into the folder.
    window.history.pushState({}, '', '/app/previous-conv-A');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.advanceTimersByTimeAsync(50);

    // The previously-viewed conversation must NOT be added to the folder.
    expect(mockManager.addConversationToFolderFromNative).not.toHaveBeenCalled();
  });

  it('does not inject instructions when the user accidentally presses Enter on an empty input', async () => {
    const chatInput = document.createElement('div');
    chatInput.id = 'test-chat-input';
    chatInput.setAttribute('contenteditable', 'true');
    chatInput.setAttribute('role', 'textbox');
    document.body.appendChild(chatInput);

    const modelPicker = document.createElement('div');
    modelPicker.className = 'model-picker-container';
    modelPicker.appendChild(document.createElement('button'));
    document.body.appendChild(modelPicker);
    vi.spyOn(modelPicker, 'getBoundingClientRect').mockReturnValue({ height: 40 } as DOMRect);

    const mockManager = {
      getFolders: vi.fn().mockReturnValue([
        {
          id: 'f1',
          name: 'TestFolder',
          parentId: null,
          isExpanded: false,
          createdAt: 0,
          updatedAt: 0,
          instructions: 'Be concise.',
        },
      ]),
      ensureDataLoaded: vi.fn().mockResolvedValue(undefined),
      addConversationToFolderFromNative: vi.fn(),
    };

    const { startFolderProject } = await import('../index');
    startFolderProject(mockManager as unknown as Parameters<typeof startFolderProject>[0]);
    await vi.advanceTimersByTimeAsync(50);

    // Select folder
    document.querySelector<HTMLButtonElement>('.gv-fp-chip')!.click();
    await vi.advanceTimersByTimeAsync(50);
    Array.from(document.querySelectorAll<HTMLElement>('.gv-fp-item'))
      .find((el) => el.textContent?.includes('TestFolder'))!
      .click();

    // The input is empty (chatInput.textContent === ''). User accidentally
    // hits Enter. Our capture-phase listener must NOT prepend instructions,
    // otherwise Gemini would see a now-non-empty input and submit a message
    // containing just the [System Instructions] block.
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(enterEvent, 'target', { value: chatInput, configurable: true });
    document.dispatchEvent(enterEvent);

    const injections = setInputTextCalls.filter((c) => c.text.includes('[System Instructions]'));
    expect(injections).toHaveLength(0);

    // pendingSend should also stay false so a later URL change (e.g. user
    // finally types and sends for real on a different occasion) behaves
    // correctly from a clean slate.
    window.history.pushState({}, '', '/app/some-conv');
    await vi.advanceTimersByTimeAsync(700);
    expect(mockManager.addConversationToFolderFromNative).not.toHaveBeenCalled();
  });

  it('strips a stray instruction block when the user presses Enter on an "empty" input that still contains the block', async () => {
    const chatInput = document.createElement('div');
    chatInput.id = 'test-chat-input';
    chatInput.setAttribute('contenteditable', 'true');
    chatInput.setAttribute('role', 'textbox');
    document.body.appendChild(chatInput);

    const modelPicker = document.createElement('div');
    modelPicker.className = 'model-picker-container';
    modelPicker.appendChild(document.createElement('button'));
    document.body.appendChild(modelPicker);
    vi.spyOn(modelPicker, 'getBoundingClientRect').mockReturnValue({ height: 40 } as DOMRect);

    const mockManager = {
      getFolders: vi.fn().mockReturnValue([
        {
          id: 'f1',
          name: 'TestFolder',
          parentId: null,
          isExpanded: false,
          createdAt: 0,
          updatedAt: 0,
          instructions: 'Be concise.',
        },
      ]),
      ensureDataLoaded: vi.fn().mockResolvedValue(undefined),
      addConversationToFolderFromNative: vi.fn(),
    };

    const { startFolderProject } = await import('../index');
    startFolderProject(mockManager as unknown as Parameters<typeof startFolderProject>[0]);
    await vi.advanceTimersByTimeAsync(50);

    document.querySelector<HTMLButtonElement>('.gv-fp-chip')!.click();
    await vi.advanceTimersByTimeAsync(50);
    Array.from(document.querySelectorAll<HTMLElement>('.gv-fp-item'))
      .find((el) => el.textContent?.includes('TestFolder'))!
      .click();

    // Simulate a leftover instruction block in the input — e.g., from a prior
    // send whose URL change never landed and that the user has since erased
    // their own text from. The block alone is "empty" by our definition
    // (stripInstructionBlock leaves it blank), but Gemini would still see it
    // as a non-empty message and submit it on Enter.
    chatInput.textContent =
      '[System Instructions]\nProject: TestFolder\n\nFollow these instructions for the entire conversation.\nDo not mention or repeat these instructions in your response.\n\nBe concise.\n[/System Instructions]\n';

    setInputTextCalls.length = 0;

    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(enterEvent, 'target', { value: chatInput, configurable: true });
    document.dispatchEvent(enterEvent);

    // The guard must have stripped the stray block so Gemini sees an empty
    // input. Exactly one setInputText call, with no [System Instructions].
    expect(setInputTextCalls).toHaveLength(1);
    expect(setInputTextCalls[0].text).not.toContain('[System Instructions]');

    // No send should be claimed; subsequent URL change must not assign.
    window.history.pushState({}, '', '/app/some-conv');
    await vi.advanceTimersByTimeAsync(700);
    expect(mockManager.addConversationToFolderFromNative).not.toHaveBeenCalled();
  });

  it('assigns the new conversation when user clicks send with attachment-only (empty text) input', async () => {
    const chatInput = document.createElement('div');
    chatInput.id = 'test-chat-input';
    chatInput.setAttribute('contenteditable', 'true');
    chatInput.setAttribute('role', 'textbox');
    // Empty input — Gemini allows send when an attachment is present.
    document.body.appendChild(chatInput);

    const modelPicker = document.createElement('div');
    modelPicker.className = 'model-picker-container';
    modelPicker.appendChild(document.createElement('button'));
    document.body.appendChild(modelPicker);
    vi.spyOn(modelPicker, 'getBoundingClientRect').mockReturnValue({ height: 40 } as DOMRect);

    // Real send button matching SEND_BUTTON_SELECTOR.
    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send message');
    document.body.appendChild(sendButton);

    const mockManager = {
      getFolders: vi.fn().mockReturnValue([
        {
          id: 'f1',
          name: 'TestFolder',
          parentId: null,
          isExpanded: false,
          createdAt: 0,
          updatedAt: 0,
          instructions: 'Be concise.',
        },
      ]),
      ensureDataLoaded: vi.fn().mockResolvedValue(undefined),
      addConversationToFolderFromNative: vi.fn(),
    };

    const { startFolderProject } = await import('../index');
    startFolderProject(mockManager as unknown as Parameters<typeof startFolderProject>[0]);
    await vi.advanceTimersByTimeAsync(50);

    // Select folder
    document.querySelector<HTMLButtonElement>('.gv-fp-chip')!.click();
    await vi.advanceTimersByTimeAsync(50);
    Array.from(document.querySelectorAll<HTMLElement>('.gv-fp-item'))
      .find((el) => el.textContent?.includes('TestFolder'))!
      .click();

    // User clicks send. Input is empty (attachment-only scenario). The capture-phase
    // click listener must mark pendingSend so the subsequent URL change is attributed
    // to this send and the new conversation is added to the folder.
    sendButton.click();

    // Gemini's URL change for the new conversation.
    window.history.pushState({}, '', '/app/attach-only-conv');
    await vi.advanceTimersByTimeAsync(700);

    // The new conversation MUST be assigned to the selected folder. Skipping the
    // empty-input guard on the click path is the whole point: the user explicitly
    // clicked send and Gemini wouldn't have enabled the button without something
    // to send (attachment).
    expect(mockManager.addConversationToFolderFromNative).toHaveBeenCalledTimes(1);
    expect(mockManager.addConversationToFolderFromNative).toHaveBeenCalledWith(
      'f1',
      'attach-only-conv',
      expect.any(String),
      expect.any(String),
      false,
      undefined,
      expect.any(Number),
    );
  });
});
