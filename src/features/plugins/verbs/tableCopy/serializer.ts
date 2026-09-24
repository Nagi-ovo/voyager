export type TableCopyFormat = 'markdown' | 'tsv';
export type TableCopyErrorCode = 'empty' | 'unsupported' | 'limit';

export class TableCopyError extends Error {
  constructor(public readonly code: TableCopyErrorCode) {
    super('tableCopy: ' + code);
    this.name = 'TableCopyError';
  }
}

export const TABLE_COPY_LIMITS = {
  rows: 500,
  columns: 100,
  cells: 10_000,
  characters: 1_000_000,
  nodes: 100_000,
  depth: 128,
} as const;

const OMIT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE']);
// Keep tabs/newlines until encoding; strip invisible controls without breaking emoji joins.
// eslint-disable-next-line no-control-regex -- Deliberately sanitize clipboard control characters.
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}]/gu;
// eslint-disable-next-line no-control-regex -- Per-code-point check for the bounded emoji path.
const CONTROL_CODEPOINT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}]/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_MODIFIER = /\uFE0F|\p{Emoji_Modifier}/u;

function hasHiddenMarker(element: Element): boolean {
  return (
    element.hasAttribute('hidden') || element.getAttribute('aria-hidden')?.toLowerCase() === 'true'
  );
}

function hasHiddenStyle(element: Element): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (
    style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse'
  );
}

export function isTableCopyHidden(element: Element, cache?: Map<Element, boolean>): boolean {
  const unchecked: Element[] = [];
  let ancestor: Element | null = element;
  let hidden = false;
  while (ancestor) {
    const cached = cache?.get(ancestor);
    if (cached !== undefined) {
      hidden = cached;
      break;
    }
    unchecked.push(ancestor);
    ancestor = ancestor.parentElement;
  }
  for (let index = unchecked.length - 1; index >= 0; index -= 1) {
    const current = unchecked[index];
    if (!hidden) hidden = hasHiddenMarker(current) || hasHiddenStyle(current);
    cache?.set(current, hidden);
  }
  return hidden;
}

function cleanControls(text: string): string {
  if (!text.includes('\u200D')) return text.replace(CONTROLS, '');
  const points = Array.from(text);
  return points
    .filter((point, index) => {
      if (point !== '\u200D') return !CONTROL_CODEPOINT.test(point);
      let previous = index - 1;
      while (previous >= 0 && EMOJI_MODIFIER.test(points[previous])) previous -= 1;
      return (
        previous >= 0 &&
        index + 1 < points.length &&
        PICTOGRAPHIC.test(points[previous]) &&
        PICTOGRAPHIC.test(points[index + 1])
      );
    })
    .join('');
}

interface ReadBudget {
  nodes: number;
  characters: number;
}

function readCell(cell: HTMLTableCellElement, budget: ReadBudget): string {
  const parts: string[] = [];
  let boundary = false;
  let endsWithNewline = false;
  function append(text: string) {
    if (!text) return;
    budget.characters += text.length;
    if (budget.characters > TABLE_COPY_LIMITS.characters) throw new TableCopyError('limit');
    if (boundary && parts.length && !endsWithNewline) parts.push('\n');
    boundary = false;
    parts.push(text);
    endsWithNewline = text.endsWith('\n');
  }
  function visit(node: Node, depth: number) {
    budget.nodes += 1;
    if (budget.nodes > TABLE_COPY_LIMITS.nodes || depth > TABLE_COPY_LIMITS.depth) {
      throw new TableCopyError('limit');
    }
    if (node.nodeType === 3) {
      append(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (OMIT_TAGS.has(element.tagName) || hasHiddenMarker(element) || hasHiddenStyle(element))
      return;
    if (element.tagName === 'BR') {
      append('\n');
      return;
    }
    const block = BLOCK_TAGS.has(element.tagName);
    if (block) boundary = true;
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, depth + 1);
    if (block) boundary = true;
  }
  for (let child = cell.firstChild; child; child = child.nextSibling) visit(child, 0);
  return cleanControls(parts.join('').replace(/\r\n?/g, '\n'));
}

function markdownCell(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/([*_[\]~])/g, '\\$1')
    .replace(/[\n\u2028\u2029]/g, '<br>')
    .replace(/\t/g, ' ');
}

function tsvCell(text: string): string {
  // Normalize in-cell separators so paste cannot create a second formula-bearing cell.
  let value = text.replace(/[\t\n\u2028\u2029]/g, ' ');
  if (/^\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u.test(value)) value = "'" + value;
  return value.includes('"') ? '"' + value.replace(/"/g, '""') + '"' : value;
}

/** Read fresh on the user's click; never mutate, truncate, or cache table contents. */
export function serializeTable(table: HTMLTableElement, format: TableCopyFormat): string {
  const visibilityCache = new Map<Element, boolean>();
  if (isTableCopyHidden(table, visibilityCache)) throw new TableCopyError('empty');
  if (table.parentElement?.closest('table') || table.querySelector('table')) {
    throw new TableCopyError('unsupported');
  }
  const rows = Array.from(table.rows).filter((row) => !isTableCopyHidden(row, visibilityCache));
  if (rows.length === 0) throw new TableCopyError('empty');
  if (rows.length > TABLE_COPY_LIMITS.rows) throw new TableCopyError('limit');
  const columns = rows[0].cells.length;
  if (columns === 0) throw new TableCopyError('empty');
  if (columns > TABLE_COPY_LIMITS.columns || rows.length * columns > TABLE_COPY_LIMITS.cells) {
    throw new TableCopyError('limit');
  }
  if (table.tHead && rows.filter((row) => row.parentElement === table.tHead).length > 1) {
    throw new TableCopyError('unsupported');
  }

  const budget: ReadBudget = { nodes: 0, characters: 0 };
  const data: string[][] = [];
  for (const row of rows) {
    if (row.cells.length !== columns) throw new TableCopyError('unsupported');
    const values: string[] = [];
    for (const cell of row.cells) {
      // rowspan=0 spans the remaining group, and is not an ordinary single cell.
      if (cell.rowSpan !== 1 || cell.colSpan !== 1) throw new TableCopyError('unsupported');
      values.push(isTableCopyHidden(cell, visibilityCache) ? '' : readCell(cell, budget));
    }
    data.push(values);
  }
  if (format === 'tsv') return data.map((row) => row.map(tsvCell).join('\t')).join('\n');

  const hasHeader =
    rows[0].parentElement === table.tHead ||
    Array.from(rows[0].cells).every((c) => c.tagName === 'TH');
  const header = hasHeader ? data[0] : Array<string>(columns).fill('');
  const body = hasHeader ? data.slice(1) : data;
  const line = (row: string[]) => '| ' + row.map(markdownCell).join(' | ') + ' |';
  return [
    line(header),
    '| ' + Array<string>(columns).fill('---').join(' | ') + ' |',
    ...body.map(line),
  ].join('\n');
}
