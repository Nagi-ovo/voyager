import temml from 'temml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { setCachedLanguage } from '@/utils/i18n';

import { FormulaCopyService } from './FormulaCopyService';

// Mock dependencies
const storageMocks = vi.hoisted(() => ({
  get: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      sync: {
        get: storageMocks.get,
      },
      onChanged: {
        addListener: storageMocks.addListener,
        removeListener: storageMocks.removeListener,
      },
    },
    i18n: {
      getMessage: vi.fn((key) => key),
    },
  },
}));

vi.mock('temml', () => ({
  default: {
    renderToString: vi.fn(),
  },
}));

describe('FormulaCopyService', () => {
  let service: FormulaCopyService;

  // Mock clipboard API
  const writeMock = vi.fn();
  const writeTextMock = vi.fn();

  const originalBlob = globalThis.Blob;

  class TestBlob {
    private readonly parts: string[];

    constructor(parts: BlobPart[], _options?: BlobPropertyBag) {
      this.parts = parts.map((part) => (typeof part === 'string' ? part : String(part)));
    }

    public async text(): Promise<string> {
      return this.parts.join('');
    }
  }

  class TestClipboardItem {
    public readonly dataByType: Record<string, Blob>;

    constructor(dataByType: Record<string, Blob>) {
      this.dataByType = dataByType;
    }
  }

  function resetSingleton(): void {
    (FormulaCopyService as unknown as { instance: FormulaCopyService | null }).instance = null;
  }

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    writeMock.mockReset().mockResolvedValue(undefined);
    writeTextMock.mockReset().mockResolvedValue(undefined);
    storageMocks.get.mockResolvedValue({});

    // Mock navigator.clipboard
    Object.assign(navigator, {
      clipboard: {
        write: writeMock,
        writeText: writeTextMock,
      },
    });

    // Mock ClipboardItem
    (globalThis as unknown as { ClipboardItem: typeof TestClipboardItem }).ClipboardItem =
      TestClipboardItem;
    (globalThis as unknown as { Blob: typeof TestBlob }).Blob = TestBlob;

    resetSingleton();
    service = FormulaCopyService.getInstance({ observeGeminiArrows: true });
  });

  afterEach(() => {
    if (service) {
      service.dispose();
    }
    document.body.innerHTML = '';
    (globalThis as unknown as { Blob: typeof originalBlob }).Blob = originalBlob;
    vi.clearAllMocks();
  });

  it('should initialize correctly and retain its active CSS marker', async () => {
    service.initialize();
    expect(service.isServiceInitialized()).toBe(true);
    expect(document.documentElement.classList.contains('gv-formula-copy-enabled')).toBe(true);

    document.documentElement.classList.remove('gv-formula-copy-enabled');
    await Promise.resolve();
    expect(document.documentElement.classList.contains('gv-formula-copy-enabled')).toBe(true);

    service.destroy();
    expect(document.documentElement.classList.contains('gv-formula-copy-enabled')).toBe(false);
  });

  it.each(['\\rightarrow', '→'])(
    'ignores the demonstrated Gemini inline arrow source before first hover: %s',
    async (arrowSource) => {
      const wrapper = document.createElement('span');
      wrapper.classList.add('math-inline');
      const mathElement = document.createElement('span');
      mathElement.setAttribute('data-math', arrowSource);
      wrapper.appendChild(mathElement);
      document.body.appendChild(wrapper);
      const pageClick = vi.fn();
      mathElement.addEventListener('click', pageClick);

      service.initialize();
      // Initial scan marks both the real Gemini outer wrapper and inner source,
      // so formula padding/cursor rules never apply to this ordinary arrow.
      expect(mathElement.classList.contains('gv-formula-copy-ignored')).toBe(true);
      expect(wrapper.classList.contains('gv-formula-copy-ignored')).toBe(true);
      const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
      mathElement.dispatchEvent(clickEvent);
      await Promise.resolve();

      expect(writeMock).not.toHaveBeenCalled();
      expect(writeTextMock).not.toHaveBeenCalled();
      expect(document.querySelector('.gv-copy-toast')).toBeNull();
      expect(pageClick).toHaveBeenCalledTimes(1);
      expect(clickEvent.defaultPrevented).toBe(false);

      service.destroy();
      expect(mathElement.classList.contains('gv-formula-copy-ignored')).toBe(false);
      expect(wrapper.classList.contains('gv-formula-copy-ignored')).toBe(false);
    },
  );

  it.each([
    {
      platform: 'AI Studio',
      createFixture: () => {
        const root = document.createElement('ms-katex');
        root.innerHTML =
          '<span class="katex"><annotation encoding="application/x-tex">\\rightarrow</annotation></span>';
        return { root, target: root.querySelector<HTMLElement>('.katex')! };
      },
    },
    {
      platform: 'Claude / legacy ChatGPT',
      createFixture: () => {
        const root = document.createElement('span');
        root.className = 'katex';
        root.innerHTML = '<annotation encoding="application/x-tex">\\rightarrow</annotation>';
        return { root, target: root };
      },
    },
    {
      platform: 'current ChatGPT',
      createFixture: () => {
        const root = document.createElement('span');
        root.setAttribute('data-math-source', '\\rightarrow');
        root.innerHTML = '<span class="katex"><span class="katex-html">→</span></span>';
        return { root, target: root.querySelector<HTMLElement>('.katex-html')! };
      },
    },
  ])(
    'keeps an explicit arrow-only math source copyable on $platform',
    async ({ createFixture }) => {
      const clipboard = navigator.clipboard as unknown as { write?: unknown };
      clipboard.write = undefined;
      const { root, target } = createFixture();
      document.body.appendChild(root);

      service.initialize();
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();

      expect(writeMock).not.toHaveBeenCalled();
      expect(writeTextMock).toHaveBeenCalledWith('$\\rightarrow$');
      expect(root.classList.contains('gv-formula-copy-ignored')).toBe(false);
      expect(root.querySelector('.gv-formula-copy-ignored')).toBeNull();
    },
  );

  it('keeps a Gemini display arrow formula copyable', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;
    const wrapper = document.createElement('div');
    wrapper.className = 'math-block';
    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', '\\rightarrow');
    wrapper.appendChild(mathElement);
    document.body.appendChild(wrapper);

    service.initialize();
    expect(mathElement.classList.contains('gv-formula-copy-ignored')).toBe(false);
    mathElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenCalledWith('$$\\rightarrow$$');
  });

  it('marks a dynamically-rendered Gemini inline arrow without waiting for hover', async () => {
    service.initialize();
    const wrapper = document.createElement('span');
    wrapper.className = 'math-inline';
    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', '\\rightarrow');
    wrapper.appendChild(mathElement);
    document.body.appendChild(wrapper);

    await Promise.resolve();

    expect(mathElement.classList.contains('gv-formula-copy-ignored')).toBe(true);
    expect(wrapper.classList.contains('gv-formula-copy-ignored')).toBe(true);
  });

  it('coalesces same-wrapper arrow refreshes within one mutation batch', async () => {
    const wrapper = document.createElement('span');
    wrapper.className = 'math-inline';
    document.body.appendChild(wrapper);
    service.initialize();
    const refreshSpy = vi.spyOn(
      service as unknown as { refreshArrowExclusions(root: ParentNode): void },
      'refreshArrowExclusions',
    );

    const firstArrow = document.createElement('span');
    firstArrow.setAttribute('data-math', '\\rightarrow');
    const secondArrow = document.createElement('span');
    secondArrow.setAttribute('data-math', '→');
    wrapper.append(firstArrow, secondArrow);
    await Promise.resolve();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith(wrapper);
  });

  it('does not rescan a streaming root when a whole ignored response subtree is removed', async () => {
    const streamingRoot = document.createElement('main');
    const response = document.createElement('article');
    const wrapper = document.createElement('span');
    wrapper.className = 'math-inline';
    const arrow = document.createElement('span');
    arrow.setAttribute('data-math', '\\rightarrow');
    wrapper.appendChild(arrow);
    response.appendChild(wrapper);
    streamingRoot.appendChild(response);
    document.body.appendChild(streamingRoot);
    service.initialize();
    expect(wrapper.classList.contains('gv-formula-copy-ignored')).toBe(true);
    const refreshSpy = vi.spyOn(
      service as unknown as { refreshArrowExclusions(root: ParentNode): void },
      'refreshArrowExclusions',
    );

    response.remove();
    await Promise.resolve();

    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('keeps explicitly delimited and non-inline Gemini arrows copyable', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;
    const explicitInline = document.createElement('span');
    explicitInline.className = 'math-inline';
    explicitInline.setAttribute('data-math', '$\\rightarrow$');
    const display = document.createElement('div');
    display.className = 'math-display';
    const displayArrow = document.createElement('span');
    displayArrow.setAttribute('data-math', '\\rightarrow');
    display.appendChild(displayArrow);
    document.body.append(explicitInline, display);

    service.initialize();
    expect(explicitInline.classList.contains('gv-formula-copy-ignored')).toBe(false);
    expect(displayArrow.classList.contains('gv-formula-copy-ignored')).toBe(false);

    explicitInline.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    displayArrow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    expect(writeTextMock).toHaveBeenCalledTimes(2);
    expect(writeTextMock.mock.calls[0]?.[0]).toContain('\\rightarrow');
    expect(writeTextMock).toHaveBeenNthCalledWith(2, '$$\\rightarrow$$');
  });

  it('clears ignored arrow state when Gemini reuses or removes the DOM', async () => {
    const wrapper = document.createElement('span');
    wrapper.className = 'math-inline';
    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', '\\rightarrow');
    wrapper.appendChild(mathElement);
    document.body.appendChild(wrapper);
    service.initialize();
    expect(wrapper.classList.contains('gv-formula-copy-ignored')).toBe(true);

    mathElement.setAttribute('data-math', 'x^2');
    await Promise.resolve();
    expect(mathElement.classList.contains('gv-formula-copy-ignored')).toBe(false);
    expect(wrapper.classList.contains('gv-formula-copy-ignored')).toBe(false);

    mathElement.setAttribute('data-math', '\\rightarrow');
    await Promise.resolve();
    mathElement.removeAttribute('data-math');
    await Promise.resolve();
    expect(mathElement.classList.contains('gv-formula-copy-ignored')).toBe(false);
    expect(wrapper.classList.contains('gv-formula-copy-ignored')).toBe(false);

    mathElement.setAttribute('data-math', '\\rightarrow');
    await Promise.resolve();
    mathElement.remove();
    await Promise.resolve();
    expect(wrapper.classList.contains('gv-formula-copy-ignored')).toBe(false);
  });

  it('uses the mouseover fallback when an inline wrapper later becomes display math', async () => {
    const wrapper = document.createElement('span');
    wrapper.className = 'math-inline';
    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', '\\rightarrow');
    wrapper.appendChild(mathElement);
    document.body.appendChild(wrapper);
    service.initialize();
    expect(wrapper.classList.contains('gv-formula-copy-ignored')).toBe(true);

    wrapper.className = 'math-block';
    mathElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    expect(wrapper.classList.contains('gv-formula-copy-ignored')).toBe(false);
    expect(mathElement.classList.contains('gv-formula-copy-ignored')).toBe(false);
  });

  it('does not let an arrow candidate hide a real formula in a shared inline wrapper', () => {
    const wrapper = document.createElement('span');
    wrapper.className = 'math-inline';
    const arrow = document.createElement('span');
    arrow.setAttribute('data-math', '\\rightarrow');
    const formula = document.createElement('span');
    formula.setAttribute('data-math', 'x^2');
    wrapper.append(arrow, formula);
    document.body.appendChild(wrapper);

    service.initialize();

    expect(arrow.classList.contains('gv-formula-copy-ignored')).toBe(true);
    expect(formula.classList.contains('gv-formula-copy-ignored')).toBe(false);
    expect(wrapper.classList.contains('gv-formula-copy-ignored')).toBe(false);
  });

  it('ignores a shared inline wrapper after its last real formula is removed', async () => {
    const wrapper = document.createElement('span');
    wrapper.className = 'math-inline';
    const arrow = document.createElement('span');
    arrow.setAttribute('data-math', '\\rightarrow');
    const formula = document.createElement('span');
    formula.setAttribute('data-math', 'x^2');
    wrapper.append(arrow, formula);
    document.body.appendChild(wrapper);
    service.initialize();
    expect(wrapper.classList.contains('gv-formula-copy-ignored')).toBe(false);

    formula.remove();
    await Promise.resolve();

    expect(arrow.classList.contains('gv-formula-copy-ignored')).toBe(true);
    expect(wrapper.classList.contains('gv-formula-copy-ignored')).toBe(true);
  });

  it('stops observing while disabled and scans again when re-enabled', async () => {
    service.initialize();
    service.destroy();
    const wrapper = document.createElement('span');
    wrapper.className = 'math-inline';
    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', '\\rightarrow');
    wrapper.appendChild(mathElement);
    document.body.appendChild(wrapper);
    await Promise.resolve();
    expect(mathElement.classList.contains('gv-formula-copy-ignored')).toBe(false);

    service.initialize();
    expect(mathElement.classList.contains('gv-formula-copy-ignored')).toBe(true);
    expect(wrapper.classList.contains('gv-formula-copy-ignored')).toBe(true);
  });

  it('keeps a real formula containing an arrow copyable', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;
    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', 'A \\rightarrow B');
    mathElement.classList.add('math-inline');
    document.body.appendChild(mathElement);

    service.initialize();
    mathElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(mathElement.classList.contains('gv-formula-copy-ignored')).toBe(false);
    mathElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenCalledWith('$A \\rightarrow B$');
  });

  it.each([
    ['ordinary text and arrow', 'plain-arrow'],
    ['ordinary text containing a host math-wrapped arrow', 'wrapped-arrow'],
    ['ordinary text and a real formula', 'formula'],
  ])('does not intercept native copy events for %s', (_label, fixtureKind) => {
    const selection = document.createElement('p');
    if (fixtureKind === 'wrapped-arrow') {
      selection.append('A ');
      const wrapper = document.createElement('span');
      wrapper.className = 'math-inline';
      const arrow = document.createElement('span');
      arrow.setAttribute('data-math', '\\rightarrow');
      arrow.textContent = '→';
      wrapper.appendChild(arrow);
      selection.append(wrapper, ' B');
    } else if (fixtureKind === 'formula') {
      selection.append('Result: ');
      const formula = document.createElement('span');
      formula.className = 'math-inline';
      formula.setAttribute('data-math', 'x^2');
      formula.textContent = 'x²';
      selection.append(formula);
    } else {
      selection.textContent = 'A → B';
    }
    document.body.appendChild(selection);
    const range = document.createRange();
    range.selectNodeContents(selection);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const setData = vi.fn();
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, 'clipboardData', { value: { setData } });

    service.initialize();
    selection.dispatchEvent(copyEvent);

    expect(copyEvent.defaultPrevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
    expect(writeTextMock).not.toHaveBeenCalled();
    window.getSelection()?.removeAllRanges();
  });

  it('leaves right-click behavior native and only copies on a later left click', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;
    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', 'x^2');
    document.body.appendChild(mathElement);

    service.initialize();
    const contextMenuEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    mathElement.dispatchEvent(contextMenuEvent);

    expect(contextMenuEvent.defaultPrevented).toBe(false);
    expect(writeTextMock).not.toHaveBeenCalled();

    mathElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    expect(writeTextMock).toHaveBeenCalledWith('$x^2$');
  });

  it('becomes fully inert after destroy without clearing the selected format', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;
    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', 'x^2');
    document.body.appendChild(mathElement);
    const pageClick = vi.fn();
    mathElement.addEventListener('click', pageClick);

    service.initialize();
    const formatListener = storageMocks.addListener.mock.calls.at(-1)?.[0] as Parameters<
      typeof browser.storage.onChanged.addListener
    >[0];
    formatListener({ gvFormulaCopyFormat: { oldValue: 'latex', newValue: 'notion' } }, 'sync');
    mathElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeTextMock).toHaveBeenCalledWith('$$x^2$$');
    expect(document.querySelector('.gv-copy-toast')).not.toBeNull();
    expect(pageClick).not.toHaveBeenCalled();

    service.destroy();
    writeTextMock.mockClear();
    expect(document.querySelector('.gv-copy-toast')).toBeNull();
    expect(document.documentElement.classList.contains('gv-formula-copy-enabled')).toBe(false);

    const disabledClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    mathElement.dispatchEvent(disabledClick);
    await Promise.resolve();

    expect(writeMock).not.toHaveBeenCalled();
    expect(writeTextMock).not.toHaveBeenCalled();
    expect(pageClick).toHaveBeenCalledTimes(1);
    expect(disabledClick.defaultPrevented).toBe(false);

    service.initialize();
    mathElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    expect(writeTextMock).toHaveBeenCalledWith('$$x^2$$');
  });

  it('keeps format preference updates live while disabled', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;
    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', 'x');
    document.body.appendChild(mathElement);

    service.initialize();
    const firstListener = storageMocks.addListener.mock.calls.at(-1)?.[0] as Parameters<
      typeof browser.storage.onChanged.addListener
    >[0];
    firstListener({ gvFormulaCopyFormat: { oldValue: 'latex', newValue: 'notion' } }, 'sync');
    mathElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    expect(writeTextMock).toHaveBeenLastCalledWith('$$x$$');

    service.destroy();
    firstListener({ gvFormulaCopyFormat: { oldValue: 'notion', newValue: 'no-dollar' } }, 'sync');
    service.initialize();
    mathElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenLastCalledWith('x');
    expect(storageMocks.addListener).toHaveBeenCalledTimes(1);
    expect(storageMocks.removeListener).not.toHaveBeenCalled();

    service.dispose();
    expect(storageMocks.removeListener).toHaveBeenCalledWith(firstListener);
  });

  it('loads the latest format before a caller activates click handling', async () => {
    let resolveFormatRead!: (value: Record<string, unknown>) => void;
    storageMocks.get.mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveFormatRead = resolve;
        }),
    );
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;
    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', 'x');
    document.body.appendChild(mathElement);

    const preparing = service.prepare();
    expect(service.isServiceInitialized()).toBe(false);
    resolveFormatRead({ gvFormulaCopyFormat: 'notion' });
    await preparing;
    service.initialize();
    mathElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenCalledWith('$$x$$');
  });

  it('does not let a stale format read override a newer live format change', async () => {
    let resolveFormatRead!: (value: Record<string, unknown>) => void;
    storageMocks.get.mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveFormatRead = resolve;
        }),
    );
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;
    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', 'x');
    document.body.appendChild(mathElement);

    service.initialize();
    const formatListener = storageMocks.addListener.mock.calls.at(-1)?.[0] as Parameters<
      typeof browser.storage.onChanged.addListener
    >[0];
    formatListener({ gvFormulaCopyFormat: { oldValue: 'latex', newValue: 'notion' } }, 'sync');
    resolveFormatRead({ gvFormulaCopyFormat: 'latex' });
    await Promise.resolve();

    mathElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    expect(writeTextMock).toHaveBeenCalledWith('$$x$$');
  });

  it('does not show a late toast after the service is disabled', async () => {
    let resolveClipboardWrite!: () => void;
    writeTextMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveClipboardWrite = resolve;
        }),
    );
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;
    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', 'x');
    document.body.appendChild(mathElement);

    service.initialize();
    mathElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    service.destroy();
    resolveClipboardWrite();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector('.gv-copy-toast')).toBeNull();
  });

  it('does not let a pre-disable timer hide a toast created after re-enable', async () => {
    vi.useFakeTimers();
    try {
      const mathElement = document.createElement('span');
      mathElement.setAttribute('data-math', 'x');
      document.body.appendChild(mathElement);

      service.initialize();
      mathElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      expect(document.querySelector('.gv-copy-toast-show')).not.toBeNull();

      service.destroy();
      vi.advanceTimersByTime(1000);
      service.initialize();
      mathElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      expect(document.querySelector('.gv-copy-toast-show')).not.toBeNull();

      vi.advanceTimersByTime(1000);
      expect(document.querySelector('.gv-copy-toast-show')).not.toBeNull();
      vi.advanceTimersByTime(1000);
      expect(document.querySelector('.gv-copy-toast-show')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the success toast in the user-selected language, not the browser UI locale', async () => {
    // Pick Chinese the way the popup language switcher does (custom i18n layer),
    // independent of browser.i18n / the browser UI locale.
    setCachedLanguage('zh');
    resetSingleton();
    service = FormulaCopyService.getInstance({ format: 'latex' });

    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', 'x^2');
    mathElement.classList.add('math-inline');
    document.body.appendChild(mathElement);

    service.initialize();
    mathElement.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const toast = document.querySelector('.gv-copy-toast');
    expect(toast?.textContent).toBe('✓ 公式已复制');

    setCachedLanguage('en');
  });

  it('should generate MathML when format is unicodemath (now mapped to MathML)', async () => {
    // Setup
    vi.mocked(temml.renderToString).mockReturnValue(
      '<math xmlns="http://www.w3.org/1998/Math/MathML" class="tml-display" style="display:block math;"><semantics><mrow><mtext class="tml-text">Result</mtext></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math>',
    );

    // Reset instance first
    resetSingleton();
    service = FormulaCopyService.getInstance({ format: 'unicodemath' });

    // Create a mock event and element
    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', 'x^2');
    mathElement.classList.add('math-inline');
    document.body.appendChild(mathElement);

    const clickEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
    });

    // Dispatch click on the element
    service.initialize();
    mathElement.dispatchEvent(clickEvent);
    await Promise.resolve();

    // Assertions
    expect(temml.renderToString).toHaveBeenCalledWith(
      'x^2',
      expect.objectContaining({
        annotate: false,
        colorIsTextColor: true,
        displayMode: false,
        throwOnError: true,
        trust: false,
        xml: true,
      }),
    );

    // Verify clipboard write was called with rich content
    expect(writeMock).toHaveBeenCalled();
    const writtenItemsUnknown = writeMock.mock.calls[0]?.[0] as unknown;
    expect(Array.isArray(writtenItemsUnknown)).toBe(true);
    const writtenItems = writtenItemsUnknown as TestClipboardItem[];
    expect(writtenItems.length).toBeGreaterThan(0);

    const clipboardItem = writtenItems[0];

    expect(clipboardItem.dataByType['text/html']).toBeDefined();
    expect(clipboardItem.dataByType['text/plain']).toBeDefined();
    expect(clipboardItem.dataByType['application/mathml+xml']).toBeDefined();

    const htmlContent = await clipboardItem.dataByType['text/html'].text();
    const textContent = await clipboardItem.dataByType['text/plain'].text();
    const mathmlContent = await clipboardItem.dataByType['application/mathml+xml'].text();

    // Word-friendly MathML should be prefixed and must not include KaTeX <annotation> TeX payloads.
    expect(htmlContent).toContain('xmlns:mml="http://www.w3.org/1998/Math/MathML"');
    expect(htmlContent).toContain('<!--StartFragment-->');
    expect(htmlContent).toContain('<mml:math');
    expect(htmlContent).not.toContain('<annotation');
    expect(htmlContent).not.toContain('class=');
    expect(htmlContent).not.toContain('style=');
    expect(textContent).toContain('<mml:math');
    expect(mathmlContent).toContain('<mml:math');

    // Cleanup
    document.body.removeChild(mathElement);
  });

  it('should fall back to legacy copy when MathML MIME is rejected', async () => {
    vi.mocked(temml.renderToString).mockReturnValue(
      '<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mtext>Result</mtext></mrow></math>',
    );

    const originalExecCommand = document.execCommand;
    Object.assign(document, {
      execCommand: vi.fn().mockReturnValue(true),
    });

    const unsupportedError =
      typeof DOMException === 'function'
        ? new DOMException('Type application/mathml+xml not supported on write.', 'NotAllowedError')
        : Object.assign(new Error('Type application/mathml+xml not supported on write.'), {
            name: 'NotAllowedError',
          });

    writeMock.mockRejectedValueOnce(unsupportedError).mockResolvedValueOnce(undefined);

    resetSingleton();
    service = FormulaCopyService.getInstance({ format: 'unicodemath' });

    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', 'x^2');
    mathElement.classList.add('math-inline');
    document.body.appendChild(mathElement);

    service.initialize();
    mathElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeMock).toHaveBeenCalledTimes(1);

    const firstItemsUnknown = writeMock.mock.calls[0]?.[0] as unknown;
    const firstItems = firstItemsUnknown as TestClipboardItem[];
    const firstClipboardItem = firstItems[0];
    expect(firstClipboardItem.dataByType['application/mathml+xml']).toBeDefined();
    expect(
      (document.execCommand as unknown as { mock?: { calls: unknown[] } }).mock?.calls.length,
    ).toBeGreaterThan(0);

    document.body.removeChild(mathElement);
    Object.assign(document, {
      execCommand: originalExecCommand,
    });
  });

  it('should fall back to writeText if write is not available', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;

    resetSingleton();
    service = FormulaCopyService.getInstance({ format: 'latex' });

    const mathElement = document.createElement('span');
    mathElement.setAttribute('data-math', 'x^2');
    document.body.appendChild(mathElement);

    service.initialize();
    mathElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenCalledWith('$x^2$');

    document.body.removeChild(mathElement);
  });

  it('should find data-math inside math container subtree', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;

    resetSingleton();
    service = FormulaCopyService.getInstance({ format: 'latex' });

    const container = document.createElement('span');
    container.classList.add('math-inline');

    const inner = document.createElement('span');
    inner.setAttribute('data-math', 'x^2');
    inner.textContent = 'x²';
    container.appendChild(inner);
    document.body.appendChild(container);

    service.initialize();
    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenCalledWith('$x^2$');

    document.body.removeChild(container);
  });

  it('should copy when clicking deep descendant inside math container', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;

    resetSingleton();
    service = FormulaCopyService.getInstance({ format: 'latex' });

    const container = document.createElement('span');
    container.classList.add('math-inline');

    const dataMathEl = document.createElement('span');
    dataMathEl.setAttribute('data-math', 'x^2');
    container.appendChild(dataMathEl);

    let deepest: HTMLElement = dataMathEl;
    for (let i = 0; i < 25; i += 1) {
      const next = document.createElement('span');
      next.textContent = `d${i}`;
      deepest.appendChild(next);
      deepest = next;
    }

    document.body.appendChild(container);

    service.initialize();
    deepest.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenCalledWith('$x^2$');

    document.body.removeChild(container);
  });

  it('should copy formula from AI Studio ms-katex container with annotation', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;

    resetSingleton();
    service = FormulaCopyService.getInstance({ format: 'latex' });

    // Create AI Studio ms-katex structure based on the real DOM
    const msKatex = document.createElement('ms-katex');
    msKatex.classList.add('inline', 'ng-star-inserted');

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.classList.add('rendered');

    const katexSpan = document.createElement('span');
    katexSpan.classList.add('katex');

    // Create the katex-mathml part with annotation
    const katexMathml = document.createElement('span');
    katexMathml.classList.add('katex-mathml');

    const math = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'math');
    const semantics = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'semantics');

    const mrow = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'mrow');
    const msub = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'msub');
    const mi1 = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'mi');
    mi1.textContent = 'π';
    const mi2 = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'mi');
    mi2.textContent = 'θ';
    msub.appendChild(mi1);
    msub.appendChild(mi2);
    mrow.appendChild(msub);

    const annotation = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'annotation');
    annotation.setAttribute('encoding', 'application/x-tex');
    annotation.textContent = '\\pi_\\theta';

    semantics.appendChild(mrow);
    semantics.appendChild(annotation);
    math.appendChild(semantics);
    katexMathml.appendChild(math);

    // Create the katex-html part (visual rendering)
    const katexHtml = document.createElement('span');
    katexHtml.classList.add('katex-html');
    katexHtml.setAttribute('aria-hidden', 'true');
    katexHtml.innerHTML = '<span class="base"><span class="mord">π<sub>θ</sub></span></span>';

    katexSpan.appendChild(katexMathml);
    katexSpan.appendChild(katexHtml);
    code.appendChild(katexSpan);
    pre.appendChild(code);
    msKatex.appendChild(pre);
    document.body.appendChild(msKatex);

    service.initialize();

    // Click on the katex-html part (where users typically click)
    katexHtml.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenCalledWith('$\\pi_\\theta$');

    document.body.removeChild(msKatex);
  });

  it('should detect display mode for AI Studio block formulas', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;

    resetSingleton();
    service = FormulaCopyService.getInstance({ format: 'latex' });

    // Create AI Studio ms-katex structure with display="block"
    const msKatex = document.createElement('ms-katex');
    msKatex.classList.add('block');

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.classList.add('rendered');

    const katexSpan = document.createElement('span');
    katexSpan.classList.add('katex');

    const katexMathml = document.createElement('span');
    katexMathml.classList.add('katex-mathml');

    // Math element with display="block" attribute
    const math = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'math');
    math.setAttribute('display', 'block');

    const semantics = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'semantics');
    const mrow = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'mrow');
    const mi = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'mi');
    mi.textContent = 'E';
    mrow.appendChild(mi);

    const annotation = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'annotation');
    annotation.setAttribute('encoding', 'application/x-tex');
    annotation.textContent = 'E = mc^2';

    semantics.appendChild(mrow);
    semantics.appendChild(annotation);
    math.appendChild(semantics);
    katexMathml.appendChild(math);

    katexSpan.appendChild(katexMathml);
    code.appendChild(katexSpan);
    pre.appendChild(code);
    msKatex.appendChild(pre);
    document.body.appendChild(msKatex);

    service.initialize();
    msKatex.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    // Display mode should use $$ delimiters
    expect(writeTextMock).toHaveBeenCalledWith('$$E = mc^2$$');

    document.body.removeChild(msKatex);
  });

  it('should wrap both inline and display formulas with double dollar signs in notion format', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;

    resetSingleton();
    service = FormulaCopyService.getInstance({ format: 'notion' });

    const inlineMath = document.createElement('span');
    inlineMath.setAttribute('data-math', 'x^2');
    inlineMath.classList.add('math-inline');

    const displayMath = document.createElement('span');
    displayMath.setAttribute('data-math', 'E = mc^2');
    displayMath.classList.add('math-block');

    document.body.appendChild(inlineMath);
    document.body.appendChild(displayMath);

    service.initialize();

    inlineMath.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    displayMath.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenNthCalledWith(1, '$$x^2$$');
    expect(writeTextMock).toHaveBeenNthCalledWith(2, '$$E = mc^2$$');

    document.body.removeChild(inlineMath);
    document.body.removeChild(displayMath);
  });

  // Claude and older ChatGPT markup render standard KaTeX with a MathML
  // annotation. Keep this fixture to preserve compatibility with that shape.
  function makeKatex(latex: string, opts: { display: boolean }): HTMLElement {
    const katex = document.createElement('span');
    katex.className = 'katex';
    const mathml = document.createElement('span');
    mathml.className = 'katex-mathml';
    const displayAttr = opts.display ? ' display="block"' : '';
    mathml.innerHTML = `<math xmlns="http://www.w3.org/1998/Math/MathML"${displayAttr}><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">${latex}</annotation></semantics></math>`;
    const html = document.createElement('span');
    html.className = 'katex-html';
    html.textContent = 'rendered';
    katex.appendChild(mathml);
    katex.appendChild(html);
    if (!opts.display) return katex;
    const wrapper = document.createElement('span');
    wrapper.className = 'katex-display';
    wrapper.appendChild(katex);
    return wrapper;
  }

  it('should copy ChatGPT/Claude inline KaTeX as $...$', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;

    resetSingleton();
    service = FormulaCopyService.getInstance({ format: 'latex' });

    const inline = makeKatex('E = mc^2', { display: false });
    document.body.appendChild(inline);

    service.initialize();
    // Click the inner rendered span, mimicking a real click inside .katex.
    inline.querySelector('.katex-html')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenCalledWith('$E = mc^2$');

    document.body.removeChild(inline);
  });

  it('should copy ChatGPT/Claude block KaTeX as $$...$$', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;

    resetSingleton();
    service = FormulaCopyService.getInstance({ format: 'latex' });

    const block = makeKatex('p(\\theta \\mid D) = \\frac{p(D \\mid \\theta)p(\\theta)}{p(D)}', {
      display: true,
    });
    document.body.appendChild(block);

    service.initialize();
    block.querySelector('.katex-html')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenCalledWith(
      '$$p(\\theta \\mid D) = \\frac{p(D \\mid \\theta)p(\\theta)}{p(D)}$$',
    );

    document.body.removeChild(block);
  });

  it('should copy block KaTeX when clicking the .katex-display padding', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;

    resetSingleton();
    service = FormulaCopyService.getInstance({ format: 'latex' });

    const block = makeKatex('a^2 + b^2 = c^2', { display: true });
    document.body.appendChild(block);

    service.initialize();
    // Click the .katex-display wrapper itself (not the inner .katex).
    block.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenCalledWith('$$a^2 + b^2 = c^2$$');

    document.body.removeChild(block);
  });

  function makeCurrentChatGptKatex(latex: string, display: boolean): HTMLElement {
    const semanticWrapper = document.createElement('span');
    semanticWrapper.setAttribute('role', 'math');
    semanticWrapper.setAttribute('aria-label', latex);
    semanticWrapper.setAttribute('data-math-source', latex);

    const katex = document.createElement('span');
    katex.className = 'katex';
    const html = document.createElement('span');
    html.className = 'katex-html';
    html.setAttribute('aria-hidden', 'true');
    html.textContent = 'rendered';
    katex.appendChild(html);

    if (display) {
      const displayWrapper = document.createElement('span');
      displayWrapper.className = 'katex-display';
      displayWrapper.appendChild(katex);
      semanticWrapper.appendChild(displayWrapper);
    } else {
      semanticWrapper.appendChild(katex);
    }

    return semanticWrapper;
  }

  it('copies current ChatGPT block KaTeX from data-math-source without MathML', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;

    resetSingleton();
    service = FormulaCopyService.getInstance({ format: 'latex' });

    const block = makeCurrentChatGptKatex('C = B\\log_2\\left(1+\\frac{S}{N}\\right)', true);
    document.body.appendChild(block);

    service.initialize();
    block.querySelector('.katex-html')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenCalledWith('$$C = B\\log_2\\left(1+\\frac{S}{N}\\right)$$');
  });

  it('copies current ChatGPT inline KaTeX from data-math-source as inline LaTeX', async () => {
    const clipboard = navigator.clipboard as unknown as { write?: unknown };
    clipboard.write = undefined;

    resetSingleton();
    service = FormulaCopyService.getInstance({ format: 'latex' });

    const inline = makeCurrentChatGptKatex('E = mc^2', false);
    document.body.appendChild(inline);

    service.initialize();
    inline.querySelector('.katex-html')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenCalledWith('$E = mc^2$');
  });
});
