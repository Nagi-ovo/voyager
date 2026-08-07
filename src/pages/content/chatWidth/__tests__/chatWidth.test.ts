import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STYLE_ID = 'gemini-voyager-chat-width';
const STORAGE_KEY = 'geminiChatWidth';
const MOCK_SCREEN_WIDTH = 1920;

type StorageChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
) => void;

function getInjectedStyle(): HTMLStyleElement {
  const style = document.getElementById(STYLE_ID);
  expect(style).not.toBeNull();
  return style as HTMLStyleElement;
}

function percentToPixels(percent: number): number {
  return Math.round((percent / 100) * MOCK_SCREEN_WIDTH);
}

function expectTableRuleWidth(styleText: string, percent: number): void {
  const px = percentToPixels(percent);
  const escapedWidth = px.toString();
  const tableRulePattern = new RegExp(
    String.raw`\/\* Gemini table containers \*\/[\s\S]*table-block,[\s\S]*\.table-block,[\s\S]*\.table-block \.table-content[\s\S]*\{[\s\S]*max-width: ${escapedWidth}px !important;[\s\S]*width: min\(100%, ${escapedWidth}px\) !important;`,
  );
  expect(styleText).toMatch(tableRulePattern);
}

function expectSingleTableScrollbarRules(styleText: string): void {
  expect(styleText).toContain('.table-block.has-scrollbar');
  expect(styleText).toContain('.table-block.new-table-style');
  expect(styleText).toContain('overflow-x: hidden !important;');
  expect(styleText).toContain('.table-block .table-content');
  expect(styleText).toContain('overflow-x: auto !important;');
}

describe('chatWidth', () => {
  let storageChangeListeners: StorageChangeListener[];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    document.head.innerHTML = '';
    document.body.innerHTML = '<main></main>';

    // Mock screen dimensions for deterministic tests
    Object.defineProperty(window, 'screen', {
      value: { availWidth: MOCK_SCREEN_WIDTH, width: MOCK_SCREEN_WIDTH },
      writable: true,
      configurable: true,
    });

    storageChangeListeners = [];

    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_defaults: Record<string, unknown>, callback: (value: Record<string, unknown>) => void) => {
        callback({ [STORAGE_KEY]: 85, gvChatWidthEnabled: true });
      },
    );

    (
      chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((listener: StorageChangeListener) => {
      storageChangeListeners.push(listener);
    });
  });

  afterEach(() => {
    window.dispatchEvent(new Event('beforeunload'));
  });

  it('applies widescreen rules to Gemini table blocks', async () => {
    const { startChatWidthAdjuster } = await import('../index');
    startChatWidthAdjuster();

    const styleText = getInjectedStyle().textContent ?? '';

    expectTableRuleWidth(styleText, 85);
    expect(styleText).toContain('table-block .table-block');
    expect(styleText).toContain('.table-block.has-scrollbar');
    expect(styleText).toContain('.table-block.new-table-style');
    expect(styleText).toContain('.table-block .table-content');
    expect(styleText).toContain('.table-block-component');
    expect(styleText).toContain('.horizontal-scroll-wrapper');
    expectSingleTableScrollbarRules(styleText);
  });

  it('updates table widescreen rules when width setting changes', async () => {
    const { startChatWidthAdjuster } = await import('../index');
    startChatWidthAdjuster();

    expect(storageChangeListeners.length).toBeGreaterThan(0);

    storageChangeListeners[0]({ [STORAGE_KEY]: { oldValue: 85, newValue: 92 } }, 'sync');

    const styleText = getInjectedStyle().textContent ?? '';
    expectTableRuleWidth(styleText, 92);
    expect(styleText).toContain('table-block .table-content');
    expectSingleTableScrollbarRules(styleText);
  });

  it('adapts width for narrow viewports (split-screen behavior)', async () => {
    // Simulate: user sets 70% on a 1920px screen → 1344px max-width
    // In split-screen (960px viewport), min(100%, 1344px) fills the viewport
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_defaults: Record<string, unknown>, callback: (value: Record<string, unknown>) => void) => {
        callback({ [STORAGE_KEY]: 70, gvChatWidthEnabled: true });
      },
    );

    const { startChatWidthAdjuster } = await import('../index');
    startChatWidthAdjuster();

    const styleText = getInjectedStyle().textContent ?? '';
    const expectedPx = percentToPixels(70); // 1344
    expect(styleText).toContain(`max-width: ${expectedPx}px !important`);
    expect(styleText).toContain(`width: min(100%, ${expectedPx}px) !important`);
  });

  it('excludes the header logo pill wrapper from the sparkle width rule (#875)', async () => {
    const { startChatWidthAdjuster } = await import('../index');
    startChatWidthAdjuster();

    const styleText = getInjectedStyle().textContent ?? '';
    // Read the selector back out of the injected CSS so this test fails if the
    // shipped rule changes, instead of only checking a hardcoded copy of it
    const sparkleSelector = styleText.match(/main > div:has\(img\[src\*="sparkle"\]\)[^{]*/)?.[0];
    expect(sparkleSelector).toBeDefined();
    expect(sparkleSelector?.trim()).toBe(
      'main > div:has(img[src*="sparkle"]):not(:has(chat-app-side-nav-menu-button))',
    );

    // Behavioral check on the shipped selector: it must match sparkle content
    // wrappers but never the Gemini logo pill wrapper, whose stretched
    // transparent hit box blocked the header buttons (#875)
    document.body.innerHTML = `
      <main>
        <div class="side-nav-menu-button">
          <chat-app-side-nav-menu-button>
            <img src="https://www.gstatic.com/lamda/images/gemini_sparkle_aurora.svg" />
          </chat-app-side-nav-menu-button>
        </div>
        <div class="loading-wrapper">
          <img src="https://www.gstatic.com/lamda/images/gemini_sparkle_loading.svg" />
        </div>
      </main>
    `;
    const matches = [...document.querySelectorAll(sparkleSelector as string)];
    expect(matches.map((el) => el.className)).toEqual(['loading-wrapper']);
  });

  it('widens the file-drop overlay to match the input area (#887)', async () => {
    const { startChatWidthAdjuster } = await import('../index');
    startChatWidthAdjuster();

    const styleText = getInjectedStyle().textContent ?? '';
    // Read the selector back out of the injected CSS so this test fails if the
    // shipped rule changes, instead of only checking a hardcoded copy of it
    const overlayRule = styleText.match(/(input-container file-drop-indicator[^{]+)\{([^}]+)\}/);
    expect(overlayRule).not.toBeNull();
    const [, selector, body] = overlayRule as RegExpMatchArray;

    const expectedPx = percentToPixels(85);
    expect(body).toContain(`max-width: ${expectedPx}px !important`);
    expect(body).toContain(`width: min(100%, ${expectedPx}px) !important`);
    expect(body).toContain('margin-left: auto !important');
    expect(body).toContain('margin-right: auto !important');

    // Behavioral check against the real DOM shape: the overlay Gemini renders
    // while dragging must match; an overlay with a different filedrop id
    // (a non-chat drop target) must not
    document.body.innerHTML = `
      <main>
        <input-container>
          <fieldset class="input-area-container">
            <input-area-v2></input-area-v2>
            <file-drop-indicator>
              <div class="overlay-container" data-filedrop-id="chat-window-input-container"></div>
            </file-drop-indicator>
          </fieldset>
        </input-container>
        <file-drop-indicator>
          <div class="overlay-container" data-filedrop-id="some-other-target"></div>
        </file-drop-indicator>
      </main>
    `;
    const matches = [...document.querySelectorAll(selector.trim())];
    expect(matches.map((el) => el.getAttribute('data-filedrop-id'))).toEqual([
      'chat-window-input-container',
    ]);
  });
});
