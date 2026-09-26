import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCurrentLanguage } from '@/utils/i18n';
import { APP_LANGUAGES } from '@/utils/language';

import { PluginScope } from '../runtime/pluginScope';
import { getPrimitiveContract } from './contracts';
import { tableCopyPrimitive, type TableCopyParams } from './tableCopy';
import { TABLE_COPY_CLASS } from './tableCopy/controls';
import { TABLE_COPY_FIXTURES } from './tableCopy/fixtures';
import { TABLE_COPY_LABELS } from './tableCopy/i18n';
import type { PrimitiveContext } from './types';

vi.mock('@/utils/i18n', () => ({ getCurrentLanguage: vi.fn().mockResolvedValue('en') }));
const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>() };
const scopes: PluginScope[] = [];

async function flush() {
  await vi.advanceTimersByTimeAsync(100);
}

function hosts() {
  return Array.from(document.querySelectorAll<HTMLElement>('.' + TABLE_COPY_CLASS));
}
function button(format: string, host = hosts()[0]) {
  return host.shadowRoot!.querySelector<HTMLButtonElement>('[data-format="' + format + '"]')!;
}
function status(host = hosts()[0]) {
  return host.shadowRoot!.querySelector('[role="status"]')!;
}

async function activate(
  fixture: (typeof TABLE_COPY_FIXTURES)[number] = TABLE_COPY_FIXTURES[0],
  params: TableCopyParams = {},
) {
  const scope = new PluginScope();
  scopes.push(scope);
  let count = () => -1;
  const ctx: PrimitiveContext = {
    doc: document,
    adapter: fixture.adapter,
    pluginId: 'voyager.deepseek-table-copy',
    settings: {},
    setTargetCounter: (counter) => {
      count = counter;
    },
  };
  await tableCopyPrimitive.activate(scope, params, ctx);
  return { scope, count, ctx };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(getCurrentLanguage).mockReset().mockResolvedValue('en');
  clipboard.writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', Object.assign(Object.create(window.navigator), { clipboard }));
  document.body.innerHTML = TABLE_COPY_FIXTURES[0].html;
});

afterEach(async () => {
  for (const scope of scopes.splice(0)) await scope.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('tableCopy actual primitive', () => {
  it('uses the real 1.5.0 contract and accepts only an optional table selector', () => {
    expect(tableCopyPrimitive.contract).toBe(getPrimitiveContract('tableCopy'));
    expect(tableCopyPrimitive.contract.sinceEngine).toBe('1.5.0');
    expect(tableCopyPrimitive.contract.params.table).toMatchObject({
      type: 'selector',
      required: false,
    });
    expect(tableCopyPrimitive.validateParams(undefined)).toEqual({ success: true, data: {} });
    expect(tableCopyPrimitive.validateParams({ table: 'table.answer' })).toEqual({
      success: true,
      data: { table: 'table.answer' },
    });
    for (const raw of [
      null,
      [],
      3,
      { table: 1 },
      { table: '' },
      { table: 'x'.repeat(2001) },
      { unknown: true },
    ]) {
      expect(tableCopyPrimitive.validateParams(raw).success).toBe(false);
    }
  });

  describe.each(TABLE_COPY_FIXTURES)('$name semantic fixture', (fixture) => {
    it('copies the chosen format only on click, retains empty cells, leaves content unchanged and disposes', async () => {
      document.body.innerHTML = fixture.html;
      const original = document.body.innerHTML;
      const source = document.querySelector<HTMLTableElement>('#answer-table')!;
      const originalTable = source.outerHTML;
      const { scope, count } = await activate(fixture);
      expect(hosts()).toHaveLength(1);
      expect(count()).toBe(1);
      expect(clipboard.writeText).not.toHaveBeenCalled();
      expect(button('markdown').getAttribute('aria-label')).toBe('Copy Markdown');
      button('markdown').click();
      expect(clipboard.writeText).toHaveBeenLastCalledWith(
        '| Name | Note | Empty |\n| --- | --- | --- |\n| Alpha \\| Beta | code<br>next |  |\n| =SUM(A1:A2) | "quoted" |  |',
      );
      await flush();
      expect(status().textContent).toBe('Copied');
      button('tsv').click();
      expect(clipboard.writeText).toHaveBeenLastCalledWith(
        'Name\tNote\tEmpty\nAlpha | Beta\tcode next\t\n\'=SUM(A1:A2)\t"""quoted"""\t',
      );
      await flush();
      expect(source.outerHTML).toBe(originalTable);
      const oldButton = button('markdown');
      await scope.dispose();
      expect(scope.getEffects()).toEqual([]);
      expect(count()).toBe(0);
      expect(document.body.innerHTML).toBe(original);
      oldButton.click();
      expect(clipboard.writeText).toHaveBeenCalledTimes(2);
    });

    it('discovers streamed tables, reads current cells and releases/recreates detached state', async () => {
      document.body.innerHTML = fixture.html;
      const { scope, count } = await activate(fixture);
      const container = document.querySelector('#answer')!;
      const table = document.querySelector<HTMLTableElement>('#answer-table')!;
      const oldHost = hosts()[0];
      const oldButton = button('tsv');
      table.remove();
      await flush();
      expect(hosts()).toHaveLength(0);
      expect(count()).toBe(0);
      oldButton.click();
      expect(clipboard.writeText).not.toHaveBeenCalled();
      container.appendChild(table);
      await flush();
      expect(hosts()).toHaveLength(1);
      expect(hosts()[0]).not.toBe(oldHost);
      table.rows[1].cells[0].textContent = 'Updated';
      button('tsv').click();
      expect(clipboard.writeText.mock.calls[0][0]).toContain('Updated\tcode next\t');
      await flush();
      expect(scope.getEffects().filter((label) => label.startsWith('timer'))).toHaveLength(0);
      container.insertAdjacentHTML('beforeend', '<table><tr><td>New</td></tr></table>');
      await flush();
      expect(hosts()).toHaveLength(2);
      expect(count()).toBe(2);
      await scope.dispose();
      container.insertAdjacentHTML('beforeend', '<table><tr><td>After disposal</td></tr></table>');
      await flush();
      expect(hosts()).toHaveLength(0);
    });

    it('never mounts hidden tables and responds to hidden ancestor changes', async () => {
      document.body.innerHTML = fixture.html;
      const table = document.querySelector<HTMLTableElement>('#answer-table')!;
      const answer = document.querySelector<HTMLElement>('#answer')!;
      table.hidden = true;
      const { count } = await activate(fixture);
      expect(hosts()).toHaveLength(0);
      expect(count()).toBe(0);

      table.hidden = false;
      await flush();
      expect(hosts()).toHaveLength(1);
      expect(count()).toBe(1);
      const oldButton = button('tsv');
      answer.setAttribute('aria-hidden', 'true');
      expect(count()).toBe(0);
      oldButton.click();
      expect(clipboard.writeText).not.toHaveBeenCalled();
      await flush();
      expect(hosts()).toHaveLength(0);

      answer.removeAttribute('aria-hidden');
      await flush();
      expect(hosts()).toHaveLength(1);
      answer.hidden = true;
      await flush();
      expect(hosts()).toHaveLength(0);
      answer.hidden = false;
      await flush();
      button('tsv').click();
      expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    });

    it('tracks CSS-hidden tables and ancestors while keeping offscreen tables eligible', async () => {
      document.body.innerHTML = fixture.html;
      const style = document.createElement('style');
      style.textContent =
        '.gv-test-gone { display: none } .gv-test-invisible { visibility: hidden }';
      document.head.appendChild(style);
      try {
        const table = document.querySelector<HTMLTableElement>('#answer-table')!;
        const answer = document.querySelector<HTMLElement>('#answer')!;
        table.classList.add('gv-test-gone');
        const { count } = await activate(fixture);
        expect(hosts()).toHaveLength(0);
        expect(count()).toBe(0);

        table.classList.remove('gv-test-gone');
        table.style.position = 'absolute';
        table.style.top = '-10000px';
        await flush();
        expect(hosts()).toHaveLength(1);
        expect(count()).toBe(1);
        const oldButton = button('tsv');
        answer.classList.add('gv-test-invisible');
        expect(count()).toBe(0);
        oldButton.click();
        expect(clipboard.writeText).not.toHaveBeenCalled();
        await flush();
        expect(hosts()).toHaveLength(0);

        answer.classList.remove('gv-test-invisible');
        await flush();
        answer.classList.add('gv-test-gone');
        await flush();
        expect(hosts()).toHaveLength(0);
        answer.classList.remove('gv-test-gone');
        await flush();
        table.classList.add('gv-test-invisible');
        await flush();
        expect(hosts()).toHaveLength(0);
        table.classList.remove('gv-test-invisible');
        await flush();
        button('tsv').click();
        expect(clipboard.writeText).toHaveBeenCalledTimes(1);
      } finally {
        style.remove();
      }
    });
  });

  it('ignores thinking blocks and tracks semantic marker changes', async () => {
    document
      .querySelector('#answer')!
      .insertAdjacentHTML(
        'afterbegin',
        '<div class="ds-think-content"><table><tr><td>Private reasoning</td></tr></table></div>',
      );
    const { count } = await activate();
    expect(count()).toBe(1);
    const answer = document.querySelector('#answer')!;
    answer.className = 'ds-think-content';
    await flush();
    expect(hosts()).toHaveLength(0);
    answer.className = 'ds-assistant-message-main-content';
    await flush();
    expect(count()).toBe(1);
  });

  it('constrains selector overrides to assistant tables and fails closed for invalid selectors', async () => {
    const first = await activate(undefined, { table: 'aside table' });
    expect(first.count()).toBe(0);
    await first.scope.dispose();
    const second = await activate(undefined, { table: '[' });
    expect(second.count()).toBe(0);
    expect(second.scope.getEffects()).toEqual([]);
    const third = await activate(undefined, { table: '#answer-table' });
    expect(third.count()).toBe(1);
  });

  it('reports clipboard rejection, retries only on click and handles unavailable/synchronous failure', async () => {
    await activate();
    clipboard.writeText.mockRejectedValueOnce(new Error('Denied'));
    button('markdown').click();
    await flush();
    expect(status().textContent).toBe(TABLE_COPY_LABELS.en.failed);
    expect(button('markdown').disabled).toBe(false);
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    button('markdown').click();
    await flush();
    expect(status().textContent).toBe('Copied');
    clipboard.writeText.mockImplementationOnce(() => {
      throw new Error('Unavailable');
    });
    button('tsv').click();
    expect(status().textContent).toBe(TABLE_COPY_LABELS.en.failed);
    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(window.navigator), { clipboard: undefined }),
    );
    button('tsv').click();
    expect(status().textContent).toBe(TABLE_COPY_LABELS.en.failed);
  });

  it.each(['resolve', 'reject'] as const)(
    'guards busy state and %s after disposal',
    async (settlement) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      clipboard.writeText.mockReturnValue(
        new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      );
      const { scope } = await activate();
      const oldHost = hosts()[0];
      const oldStatus = status();
      const oldButton = button('markdown');
      oldButton.click();
      expect(button('tsv').disabled).toBe(true);
      button('tsv').dispatchEvent(new MouseEvent('click'));
      expect(clipboard.writeText).toHaveBeenCalledTimes(1);
      await scope.dispose();
      if (settlement === 'resolve') resolve();
      else reject(new Error('late failure'));
      await flush();
      expect(oldHost.isConnected).toBe(false);
      expect(oldStatus.textContent).toBe('Copying...');
      oldButton.click();
      expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    },
  );

  it('does not update feedback or copy through a table detached before the observer runs', async () => {
    let resolve!: () => void;
    clipboard.writeText.mockReturnValue(
      new Promise<void>((yes) => {
        resolve = yes;
      }),
    );
    await activate();
    const feedback = status();
    button('tsv').click();
    document.querySelector('#answer-table')!.remove();
    resolve();
    await Promise.resolve();
    expect(feedback.textContent).toBe('Copying...');
    await flush();
    expect(hosts()).toHaveLength(0);
  });

  it('filters mutations inside its own shadow controls and coalesces discovery', async () => {
    const { scope } = await activate();
    const schedule = vi.spyOn(scope, 'timer');
    const host = hosts()[0];
    const child = document.createElement('span');
    host.shadowRoot!.appendChild(child);
    child.textContent = 'nested own UI';
    child.setAttribute('title', 'changed');
    button('tsv').click();
    await flush();
    expect(schedule).not.toHaveBeenCalled();
    host.remove();
    await flush();
    expect(hosts()).toHaveLength(1);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['<tr><td colspan="2">merged</td></tr>', 'unsupported'],
    ['<tr><td><table><tr><td>nested</td></tr></table></td></tr>', 'unsupported'],
    ['', 'empty'],
    ['<tr><td>x</td></tr>'.repeat(501), 'limit'],
  ] as const)('reports serialization errors without clipboard writes: %s', async (html, code) => {
    document.querySelector('#answer-table')!.innerHTML = html;
    await activate();
    expect(hosts()).toHaveLength(1);
    button('tsv').click();
    expect(status().textContent).toBe(TABLE_COPY_LABELS.en[code]);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it.each(APP_LANGUAGES)('localizes accessible buttons and feedback for %s', async (language) => {
    vi.mocked(getCurrentLanguage).mockResolvedValue(language);
    await activate();
    expect(button('markdown').getAttribute('aria-label')).toBe(
      TABLE_COPY_LABELS[language].markdown,
    );
    expect(button('tsv').textContent).toBe(TABLE_COPY_LABELS[language].tsv);
    button('tsv').click();
    await flush();
    expect(status().textContent).toBe(TABLE_COPY_LABELS[language].copied);
    expect(hosts()[0].dir).toBe(language === 'ar' ? 'rtl' : 'ltr');
  });

  it('falls back on invalid language data or language-read failure', async () => {
    vi.mocked(getCurrentLanguage).mockResolvedValueOnce(
      'invalid' as Awaited<ReturnType<typeof getCurrentLanguage>>,
    );
    const first = await activate();
    expect(button('markdown').textContent).toBe('Copy Markdown');
    await first.scope.dispose();
    vi.mocked(getCurrentLanguage).mockRejectedValueOnce(new Error('storage unavailable'));
    await activate();
    expect(button('markdown').textContent).toBe('Copy Markdown');
  });

  it('cannot mount after disposal during language lookup', async () => {
    let resolve!: (language: 'en') => void;
    vi.mocked(getCurrentLanguage).mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const scope = new PluginScope();
    scopes.push(scope);
    const activation = tableCopyPrimitive.activate(
      scope,
      {},
      {
        doc: document,
        adapter: TABLE_COPY_FIXTURES[0].adapter,
        pluginId: 'test',
        settings: {},
        setTargetCounter: () => {},
      },
    );
    await scope.dispose();
    resolve('en');
    await activation;
    expect(hosts()).toHaveLength(0);
    expect(scope.getEffects()).toEqual([]);
  });

  it('contains mounting failures and recovers on later DOM discovery', async () => {
    const insertion = vi.spyOn(Element.prototype, 'insertBefore').mockImplementationOnce(() => {
      throw new DOMException('host remount');
    });
    await expect(activate()).resolves.toBeDefined();
    expect(hosts()).toHaveLength(0);
    insertion.mockRestore();
    document.querySelector('#answer')!.appendChild(document.createElement('span'));
    await flush();
    expect(hosts()).toHaveLength(1);
  });
});
