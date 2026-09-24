import { marked } from 'marked';
import { afterEach, describe, expect, it } from 'vitest';

import { TABLE_COPY_LIMITS, TableCopyError, serializeTable } from './serializer';

function table(html: string): HTMLTableElement {
  document.body.innerHTML = '<table>' + html + '</table>';
  return document.querySelector('table')!;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('tableCopy serialization', () => {
  it('escapes Markdown syntax and HTML while preserving blank cells and line boundaries', () => {
    const source = table(
      '<thead><tr><th>A</th><th></th></tr></thead>' +
        '<tbody><tr><td></td><td></td></tr><tr><td></td><td><code>pipe|tick&#96;\\</code><br>' +
        '&lt;img src=x onerror=alert(1)&gt; &amp; <strong>*bold*</strong></td></tr></tbody>',
    );
    const before = source.outerHTML;
    const result = serializeTable(source, 'markdown');
    expect(result).toContain('|  |  |');
    expect(result).toContain('pipe\\|tick\\' + String.fromCharCode(96) + '\\\\<br>');
    expect(result).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; \\*bold\\*');
    const rendered = document.createElement('div');
    rendered.innerHTML = marked.parse(result) as string;
    expect(rendered.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(rendered.querySelectorAll('tbody tr')[1].querySelectorAll('td')).toHaveLength(2);
    expect(rendered.querySelector('img')).toBeNull();
    expect(source.outerHTML).toBe(before);
  });

  it('inserts an empty Markdown header without consuming the first data row', () => {
    expect(serializeTable(table('<tr><td>data</td><td></td></tr>'), 'markdown')).toBe(
      '|  |  |\n| --- | --- |\n| data |  |',
    );
  });

  it('preserves block and br boundaries and excludes executable/hidden markup', () => {
    const source = table(
      '<tr><td><div>one</div><div>two</div>three<br>four' +
        '<script>bad()</script><style>.bad{}</style><span hidden>secret</span>' +
        '<span aria-hidden="true">duplicate</span></td></tr>',
    );
    expect(serializeTable(source, 'tsv')).toBe('one two three four');
    expect(serializeTable(source, 'markdown')).toContain('one<br>two<br>three<br>four');
  });

  it('omits hidden rows and sections while keeping hidden cells as empty columns', () => {
    const source = table(
      '<thead><tr hidden><th>old</th><th>secret</th></tr>' +
        '<tr><th>Key</th><th>Value</th></tr></thead>' +
        '<tbody><tr><td>visible</td><td aria-hidden="TRUE">secret cell</td></tr>' +
        '<tr hidden><td>hidden row</td><td>secret</td></tr>' +
        '<tr><td>second</td><td>shown</td></tr></tbody>' +
        '<tbody aria-hidden="true"><tr><td>hidden section</td><td>secret</td></tr></tbody>',
    );
    expect(serializeTable(source, 'tsv')).toBe('Key\tValue\nvisible\t\nsecond\tshown');
    const markdown = serializeTable(source, 'markdown');
    expect(markdown).toBe('| Key | Value |\n| --- | --- |\n| visible |  |\n| second | shown |');
    const rendered = document.createElement('div');
    rendered.innerHTML = marked.parse(markdown) as string;
    expect(
      Array.from(rendered.querySelectorAll('tbody tr'), (row) =>
        Array.from(row.querySelectorAll('td'), (cell) => cell.textContent?.trim()),
      ),
    ).toEqual([
      ['visible', ''],
      ['second', 'shown'],
    ]);
  });

  it('does not serialize a table hidden by itself or an ancestor', () => {
    const source = table('<tr><td>secret</td></tr>');
    const wrapper = document.createElement('div');
    source.before(wrapper);
    wrapper.append(source);
    for (const element of [source, wrapper]) {
      element.setAttribute('hidden', '');
      for (const format of ['markdown', 'tsv'] as const) {
        expect(() => serializeTable(source, format)).toThrow(new TableCopyError('empty'));
      }
      element.removeAttribute('hidden');
    }
    wrapper.setAttribute('aria-hidden', 'true');
    expect(() => serializeTable(source, 'tsv')).toThrow(new TableCopyError('empty'));
  });

  it('omits CSS-hidden rows and cells while preserving visible columns and text', () => {
    const source = table(
      '<thead><tr><th>Key</th><th>Value</th><th>Detail</th></tr></thead>' +
        '<tbody><tr><td>visible</td><td style="visibility:hidden">secret cell</td>' +
        '<td><span style="display:none">secret text</span>shown</td></tr>' +
        '<tr style="display:none"><td>hidden row</td><td>secret</td><td>secret</td></tr>' +
        '<tr style="visibility:hidden"><td>invisible row</td><td>secret</td><td>secret</td></tr>' +
        '<tr><td>second</td><td style="display:none">secret cell</td><td>shown</td></tr></tbody>' +
        '<tbody style="display:none"><tr><td>hidden section</td><td>secret</td><td>secret</td></tr></tbody>',
    );
    expect(serializeTable(source, 'tsv')).toBe(
      'Key\tValue\tDetail\nvisible\t\tshown\nsecond\t\tshown',
    );
    expect(serializeTable(source, 'markdown')).toBe(
      '| Key | Value | Detail |\n| --- | --- | --- |\n| visible |  | shown |\n| second |  | shown |',
    );
  });

  it('rejects CSS-hidden tables and ancestors but accepts offscreen visible tables', () => {
    const source = table('<tr><td>visible</td></tr>');
    const wrapper = document.createElement('div');
    source.before(wrapper);
    wrapper.append(source);
    for (const element of [source, wrapper]) {
      for (const [property, value] of [
        ['display', 'none'],
        ['visibility', 'hidden'],
      ] as const) {
        element.style.setProperty(property, value);
        for (const format of ['markdown', 'tsv'] as const) {
          expect(() => serializeTable(source, format)).toThrow(new TableCopyError('empty'));
        }
        element.style.removeProperty(property);
      }
    }
    wrapper.style.position = 'absolute';
    wrapper.style.top = '-10000px';
    expect(serializeTable(source, 'tsv')).toBe('visible');
  });

  it('does not consume data as a header when thead is empty', () => {
    expect(
      serializeTable(table('<thead></thead><tbody><tr><td>first</td></tr></tbody>'), 'markdown'),
    ).toBe('|  |\n| --- |\n| first |');
  });

  it('normalizes TSV separators, escapes quotes and preserves empty cells including trailing ones', () => {
    const source = table('<tr><td></td><td>say "hello"\tthen\nbye</td><td></td></tr>');
    expect(serializeTable(source, 'tsv')).toBe('\t"say ""hello"" then bye"\t');
  });

  it('keeps emoji joiners but removes stray joiners before formula detection', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const flag = '\u{1F3F3}\uFE0F\u200D\u{1F308}';
    const source = table('<tr><td></td><td></td></tr>');
    source.rows[0].cells[0].textContent = family + ' ' + flag;
    source.rows[0].cells[1].textContent = '\u200D\u200B\uFEFF =SUM(A1)';
    expect(serializeTable(source, 'tsv')).toBe(family + ' ' + flag + "\t' =SUM(A1)");
    const markdown = serializeTable(source, 'markdown');
    expect(markdown).toContain(family + ' ' + flag);
    expect(markdown).not.toContain('\u200D =SUM');
  });

  it('escapes literal tildes instead of rendering GFM strikethrough', () => {
    const source = table('<tr><td>~~sale~~</td></tr>');
    const markdown = serializeTable(source, 'markdown');
    expect(markdown).toContain('\\~\\~sale\\~\\~');
    const rendered = document.createElement('div');
    rendered.innerHTML = marked.parse(markdown) as string;
    expect(rendered.querySelector('del')).toBeNull();
    expect(rendered.querySelector('tbody td')?.textContent).toBe('~~sale~~');
  });

  it.each([
    '=1+1',
    '+SUM(A1)',
    '-1',
    '@SUM(A1)',
    '\t\r\n =1',
    '\u0000=1',
    '\u001F+1',
    '\u007F-1',
    '\u0085@x',
    '\uFEFF=1',
    '\u200B=1',
    '\u202E=1',
    '＝1',
    '＋1',
    '－1',
    '＠x',
  ])('neutralizes spreadsheet formulas after controls/whitespace: %j', (value) => {
    const source = table('<tr><td></td></tr>');
    source.rows[0].cells[0].textContent = value;
    const result = serializeTable(source, 'tsv');
    expect(result.startsWith("'")).toBe(true);
    // eslint-disable-next-line no-control-regex -- Assert control character sanitization.
    expect(result).not.toMatch(/[\t\r\n\u0000-\u001F\u007F-\u009F\p{Cf}]/u);
  });

  it.each([
    '<tr><td><table><tr><td>nested</td></tr></table></td></tr>',
    '<tr><td rowspan="2">merged</td></tr><tr><td>x</td></tr>',
    '<tr><td rowspan="0">merged</td></tr>',
    '<tr><td colspan="2">merged</td></tr>',
    '<tr><td>a</td><td>b</td></tr><tr><td>short</td></tr>',
    '<thead><tr><th>a</th></tr><tr><th>b</th></tr></thead>',
  ])('rejects unsupported structure rather than flattening it: %s', (html) => {
    const source = table(html);
    for (const format of ['markdown', 'tsv'] as const) {
      expect(() => serializeTable(source, format)).toThrow(new TableCopyError('unsupported'));
    }
  });

  it('rejects an inner table even when directly selected', () => {
    const source = table('<tr><td><table><tr><td>nested</td></tr></table></td></tr>');
    expect(() => serializeTable(source.querySelector('table')!, 'tsv')).toThrow(
      new TableCopyError('unsupported'),
    );
  });

  it('rejects empty tables and empty rows', () => {
    for (const html of ['', '<tr></tr>']) {
      expect(() => serializeTable(table(html), 'tsv')).toThrow(new TableCopyError('empty'));
    }
  });

  it('enforces row, column, total cell and text limits without partial output', () => {
    const cases = [
      '<tr><td>x</td></tr>'.repeat(TABLE_COPY_LIMITS.rows + 1),
      '<tr>' + '<td>x</td>'.repeat(TABLE_COPY_LIMITS.columns + 1) + '</tr>',
      ('<tr>' + '<td>x</td>'.repeat(100) + '</tr>').repeat(101),
      '<tr><td>' + 'x'.repeat(TABLE_COPY_LIMITS.characters + 1) + '</td></tr>',
    ];
    for (const html of cases) {
      expect(() => serializeTable(table(html), 'tsv')).toThrow(new TableCopyError('limit'));
    }
  });

  it('bounds deeply nested cell traversal', () => {
    const source = table(
      '<tr><td>' + '<span>'.repeat(130) + 'x' + '</span>'.repeat(130) + '</td></tr>',
    );
    expect(() => serializeTable(source, 'markdown')).toThrow(new TableCopyError('limit'));
  });
});
