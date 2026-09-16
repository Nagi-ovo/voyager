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

/**
 * Both markdown rules must keep carrying the slider width, and both must stay
 * bound to a turn: `.md-content` is a plain class Gemini also renders outside
 * the thread (canvas, side panels), so an unscoped rule would hand those the
 * slider's width and clamp them whenever it sits narrower than they are.
 */
function expectMarkdownChildrenWidth(styleText: string, percent: number): void {
  const widthDeclaration = `max-width: ${percentToPixels(percent)}px !important;`;

  // Every selector that reaches `.md-content`, paired with the block it opens.
  // Comments are stripped before the split: a CSS comment may contain a comma.
  const markdownSelectors = styleText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .flatMap((block) => {
      const [selectors = '', body = ''] = block.split('{');
      return selectors
        .split(',')
        .map((selector) => selector.trim())
        .filter((selector) => selector.includes('.md-content'))
        .map((selector) => ({ selector, body }));
    });

  expect(markdownSelectors.map((rule) => rule.selector).sort()).toEqual([
    '.conversation-container .md-content > *',
    '.conversation-container .md-content > :not(#_)',
    '.enable-extended-and-xl-grid .conversation-container .md-content > *',
    '.enable-extended-and-xl-grid .conversation-container .md-content > :not(#_)',
  ]);

  // The list above is exhaustive, so an unscoped `.md-content` rule fails it.
  // Each of the two blocks must still carry the slider width itself.
  for (const { body } of markdownSelectors) {
    expect(body).toContain(widthDeclaration);
  }
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
    // Gemini declares the same variables on
    // `.enable-luminous-content-width-update[_nghost-…]`, which outranks a bare
    // class selector, so the slider only owns them with !important (#955)
    expect(styleText).toContain(
      `--bard-chat-window-content-width-default: ${expectedPx}px !important`,
    );
    expect(styleText).toContain(`--bard-chat-window-max-width-default: ${expectedPx}px !important`);
    expect(styleText).toContain('.enable-luminous-content-width-update');
    expect(styleText).toContain('.enable-extended-and-xl-grid .conversation-container user-query');
    expect(styleText).toContain(
      '.enable-extended-and-xl-grid .conversation-container message-actions',
    );
    expect(styleText).toContain('margin-inline: auto !important');
    expectMarkdownChildrenWidth(styleText, 70);
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
