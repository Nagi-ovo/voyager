import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HIGHLIGHT_LIMITS,
  type HighlightColor,
  type HighlightRecordV1,
  type HighlightUpdatePatch,
} from '@/core/types/highlight';

import { HighlightEditor } from '../HighlightEditor';
import { makeRecord } from './fixtures';

const palette: HighlightColor[] = ['yellow', 'green', 'blue', 'pink', '#123456'];
const record = makeRecord({
  quote: { exact: 'target', prefix: 'Before ', suffix: ' after' },
  position: { start: 7, end: 13 },
  sourceTextHash: 'source',
});

function controls() {
  const popover = document.querySelector<HTMLElement>('.gv-highlight-popover')!;
  return {
    popover,
    note: popover.querySelector<HTMLTextAreaElement>('.gv-highlight-note')!,
    swatches: popover.querySelectorAll<HTMLButtonElement>('.gv-highlight-swatch'),
    save: popover.querySelector<HTMLButtonElement>('.gv-highlight-popover-button-primary')!,
    delete: popover.querySelector<HTMLButtonElement>('.gv-highlight-popover-button-danger')!,
    cancel: popover.querySelectorAll<HTMLButtonElement>('.gv-highlight-popover-button')[1],
  };
}

describe('HighlightEditor', () => {
  let editor: HighlightEditor;
  let anchor: HTMLButtonElement;
  const actions = {
    save: vi.fn<(record: HighlightRecordV1, patch: HighlightUpdatePatch) => Promise<void>>(),
    delete: vi.fn<(record: HighlightRecordV1) => Promise<void>>(),
    announce: vi.fn<(message: string) => void>(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    actions.save.mockReset().mockResolvedValue();
    actions.delete.mockReset().mockResolvedValue();
    actions.announce.mockReset();
    editor = new HighlightEditor(actions);
    document.body.innerHTML =
      '<button id="highlight">Highlight</button><button id="outside">Outside</button>';
    anchor = document.querySelector<HTMLButtonElement>('#highlight')!;
  });

  afterEach(() => {
    editor.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('saves the edited note and color once, disables controls while saving, and restores focus', async () => {
    let finishSave = () => {};
    actions.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    editor.open(record, anchor, palette);
    const ui = controls();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).toBe(ui.note);

    ui.note.value = 'A useful note';
    ui.note.dispatchEvent(new Event('input', { bubbles: true }));
    ui.swatches[4].click();
    ui.save.click();
    ui.save.click();

    expect(actions.save).toHaveBeenCalledExactlyOnceWith(record, {
      note: 'A useful note',
      color: '#123456',
    });
    expect(
      Array.from(ui.popover.querySelectorAll('button, textarea')).every(
        (element) => (element as HTMLButtonElement | HTMLTextAreaElement).disabled,
      ),
    ).toBe(true);

    finishSave();
    await vi.advanceTimersByTimeAsync(0);

    expect(ui.popover.isConnected).toBe(false);
    expect(document.activeElement).toBe(anchor);
    expect(actions.announce).toHaveBeenCalledOnce();
  });

  it('deletes the opened record and closes without returning focus to its mark', async () => {
    editor.open(record, anchor, palette);
    const ui = controls();
    await vi.advanceTimersByTimeAsync(0);

    ui.delete.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(actions.delete).toHaveBeenCalledExactlyOnceWith(record);
    expect(actions.save).not.toHaveBeenCalled();
    expect(ui.popover.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(anchor);
  });

  it('keeps an unsaved draft usable after failure and allows retry', async () => {
    actions.save.mockRejectedValueOnce(new Error('Storage unavailable'));
    editor.open(record, anchor, palette);
    const ui = controls();
    ui.note.value = 'Keep this draft';
    ui.save.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(ui.popover.isConnected).toBe(true);
    expect(ui.note.value).toBe('Keep this draft');
    expect(ui.note.disabled).toBe(false);
    expect(ui.save.disabled).toBe(false);
    expect(actions.announce).toHaveBeenCalledWith(expect.stringContaining('Storage unavailable'));

    ui.save.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.popover.isConnected).toBe(false);
    expect(actions.save).toHaveBeenCalledTimes(2);
  });

  it('enforces the UTF-8 note limit and clears validation when the draft changes', async () => {
    editor.open(record, anchor, palette);
    const ui = controls();
    ui.note.value = '界'.repeat(Math.floor(HIGHLIGHT_LIMITS.noteBytes / 3) + 1);
    ui.save.click();

    expect(actions.save).not.toHaveBeenCalled();
    expect(ui.note.validity.customError).toBe(true);
    expect(ui.popover.isConnected).toBe(true);

    ui.note.value = 'A shorter note';
    ui.note.dispatchEvent(new Event('input', { bubbles: true }));
    expect(ui.note.validity.customError).toBe(false);
    ui.save.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(actions.save).toHaveBeenCalledWith(record, {
      note: 'A shorter note',
      color: record.color,
    });
  });

  it.each(['Escape', 'Cancel'])(
    'restores focus on %s and releases the Escape listener',
    async (action) => {
      editor.open(record, anchor, palette);
      const ui = controls();
      await vi.advanceTimersByTimeAsync(0);

      if (action === 'Escape') {
        ui.note.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      } else {
        ui.cancel.click();
      }

      expect(ui.popover.isConnected).toBe(false);
      expect(document.activeElement).toBe(anchor);
      expect(actions.save).not.toHaveBeenCalled();
      expect(actions.delete).not.toHaveBeenCalled();
      const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      document.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(false);
    },
  );

  it('does not move focus after closing before the initial focus timer runs', async () => {
    editor.open(record, anchor, palette);
    const ui = controls();
    editor.close(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(ui.popover.isConnected).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });

  it('keeps internal scrolling open and closes on page scroll, resize, or an outside click', () => {
    editor.open(record, anchor, palette);
    const ui = controls();
    ui.note.dispatchEvent(new Event('scroll'));
    expect(ui.popover.isConnected).toBe(true);

    document.body.dispatchEvent(new Event('scroll'));
    expect(ui.popover.isConnected).toBe(false);

    editor.open(record, anchor, palette);
    window.dispatchEvent(new Event('resize'));
    expect(document.querySelector('.gv-highlight-popover')).toBeNull();

    editor.open(record, anchor, palette);
    document.querySelector<HTMLButtonElement>('#outside')!.click();
    expect(document.querySelector('.gv-highlight-popover')).toBeNull();
  });

  it('lets a closed editor finish saving without closing or focusing its replacement', async () => {
    let finishSave = () => {};
    actions.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    editor.open(record, anchor, palette);
    controls().save.click();
    editor.close();
    const nextRecord = { ...record, id: 'highlight-2', note: 'Second draft' };
    editor.open(nextRecord, anchor, palette);
    const next = controls();
    await vi.advanceTimersByTimeAsync(0);

    finishSave();
    await vi.advanceTimersByTimeAsync(0);

    expect(next.popover.isConnected).toBe(true);
    expect(next.note.value).toBe('Second draft');
    expect(document.activeElement).toBe(next.note);
    expect(actions.announce).not.toHaveBeenCalled();
  });
});
