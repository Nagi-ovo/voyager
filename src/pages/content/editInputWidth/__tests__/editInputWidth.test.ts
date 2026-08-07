import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STYLE_ID = 'gemini-voyager-edit-input-width';
const STORAGE_KEY = 'geminiEditInputWidth';
const ENABLED_KEY = 'gvEditInputWidthEnabled';

function getInjectedStyle(): HTMLStyleElement {
  const style = document.getElementById(STYLE_ID);
  expect(style).not.toBeNull();
  return style as HTMLStyleElement;
}

describe('editInputWidth', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    document.head.innerHTML = '';
    document.body.innerHTML = '<main></main>';

    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_keys: string[], callback: (value: Record<string, unknown>) => void) => {
        callback({ [STORAGE_KEY]: 80, [ENABLED_KEY]: true });
      },
    );
  });

  afterEach(() => {
    window.dispatchEvent(new Event('beforeunload'));
  });

  it('applies the configured width to the main input area', async () => {
    const { startEditInputWidthAdjuster } = await import('../index');
    startEditInputWidthAdjuster();

    const styleText = getInjectedStyle().textContent ?? '';
    expect(styleText).toContain('max-width: 80vw !important');
    expect(styleText).toContain('width: min(100%, 80vw) !important');
  });

  it('widens the file-drop overlay to match the input area (#887)', async () => {
    const { startEditInputWidthAdjuster } = await import('../index');
    startEditInputWidthAdjuster();

    const styleText = getInjectedStyle().textContent ?? '';
    // Read the selector back out of the injected CSS so this test fails if the
    // shipped rule changes, instead of only checking a hardcoded copy of it
    const overlayRule = styleText.match(/(^|\n)\s*(file-drop-indicator[^{]+)\{([^}]+)\}/);
    expect(overlayRule).not.toBeNull();
    const selector = (overlayRule as RegExpMatchArray)[2].trim();
    const body = (overlayRule as RegExpMatchArray)[3];

    // Must stay less specific than chatWidth's input-container-prefixed overlay
    // rule so both-enabled sessions resolve the same way as the input-area rules
    expect(selector).toBe(
      'file-drop-indicator .overlay-container[data-filedrop-id="chat-window-input-container"]',
    );
    expect(body).toContain('max-width: 80vw !important');
    expect(body).toContain('width: min(100%, 80vw) !important');
    expect(body).toContain('margin-left: auto !important');
    expect(body).toContain('margin-right: auto !important');

    // Behavioral check against the real DOM shape: the chat overlay matches,
    // an overlay for a different drop target does not
    document.body.innerHTML = `
      <main>
        <input-container>
          <fieldset class="input-area-container">
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
    const matches = [...document.querySelectorAll(selector)];
    expect(matches.map((el) => el.getAttribute('data-filedrop-id'))).toEqual([
      'chat-window-input-container',
    ]);
  });
});
