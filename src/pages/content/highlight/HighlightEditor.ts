import {
  HIGHLIGHT_LIMITS,
  type HighlightColor,
  type HighlightRecordV1,
  type HighlightUpdatePatch,
  areHighlightColorsEqual,
  getHighlightColorHex,
} from '@/core/types/highlight';

import { getSaveFailureMessage, translate } from './messages';

const NOTE_MAX_CHARS = 8 * 1024;

interface HighlightEditorActions {
  save(record: HighlightRecordV1, patch: HighlightUpdatePatch): Promise<void>;
  delete(record: HighlightRecordV1): Promise<void>;
  announce(message: string): void;
}

export class HighlightEditor {
  private popover: HTMLElement | null = null;
  private popoverReturnFocus: HTMLElement | null = null;
  private popoverFocusTimer: number | null = null;
  private readonly onOutsideClick = (event: MouseEvent): void => {
    const target = event.target instanceof Node ? event.target : null;
    if (target && !this.popover?.contains(target) && !this.popoverReturnFocus?.contains(target)) {
      this.close();
    }
  };
  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this.close(true);
  };
  private readonly onViewportChange = (event: Event): void => {
    const target = event.target instanceof Node ? event.target : null;
    if (!target || !this.popover?.contains(target)) this.close();
  };

  constructor(private readonly actions: HighlightEditorActions) {}

  open(
    record: HighlightRecordV1,
    anchorElement: HTMLElement,
    palette: readonly HighlightColor[],
  ): void {
    this.close();

    const popover = document.createElement('section');
    popover.className = 'gv-highlight-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-modal', 'false');
    popover.setAttribute(
      'aria-label',
      translate('highlightAriaLabel', 'Saved highlight annotation'),
    );
    popover.setAttribute('dir', 'auto');

    const quote = document.createElement('div');
    quote.className = 'gv-highlight-popover-quote';
    quote.textContent = record.anchor.quote.exact;

    const note = document.createElement('textarea');
    note.className = 'gv-highlight-note';
    note.maxLength = NOTE_MAX_CHARS;
    note.placeholder = translate('highlightNotePlaceholder', 'Add a note');
    note.value = record.note ?? '';
    note.setAttribute('aria-label', note.placeholder);

    const colorRow = document.createElement('div');
    colorRow.className = 'gv-highlight-color-row';
    colorRow.setAttribute('role', 'group');
    const colorLabel = document.createElement('span');
    colorLabel.className = 'gv-highlight-color-label';
    colorLabel.textContent = translate('highlightColor', 'Color');
    colorRow.setAttribute('aria-label', colorLabel.textContent);
    colorRow.appendChild(colorLabel);

    let selectedColor: HighlightColor = record.color;
    const updateColorSelection = (): void => {
      swatches.forEach((item, itemIndex) => {
        item.setAttribute(
          'aria-pressed',
          String(areHighlightColorsEqual(palette[itemIndex], selectedColor)),
        );
      });
    };
    const swatches = palette.map((color, index) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'gv-highlight-swatch';
      swatch.style.backgroundColor = getHighlightColorHex(color);
      swatch.setAttribute('aria-label', `${colorLabel.textContent} ${index + 1}`);
      swatch.setAttribute('aria-pressed', String(areHighlightColorsEqual(color, selectedColor)));
      swatch.addEventListener('click', () => {
        selectedColor = color;
        updateColorSelection();
      });
      colorRow.appendChild(swatch);
      return swatch;
    });

    const actions = document.createElement('div');
    actions.className = 'gv-highlight-popover-actions';
    const deleteButton = this.createPopoverButton(
      translate('pm_delete', 'Delete'),
      'gv-highlight-popover-button-danger',
    );
    const cancelButton = this.createPopoverButton(translate('pm_cancel', 'Cancel'));
    const saveButton = this.createPopoverButton(
      translate('pm_save', 'Save'),
      'gv-highlight-popover-button-primary',
    );
    actions.append(deleteButton, cancelButton, saveButton);
    popover.append(quote, note, colorRow, actions);
    document.body.appendChild(popover);
    this.popover = popover;
    this.popoverReturnFocus = anchorElement;
    document.addEventListener('click', this.onOutsideClick, true);
    document.addEventListener('keydown', this.onKeydown, true);
    window.addEventListener('resize', this.onViewportChange, { passive: true });
    document.addEventListener('scroll', this.onViewportChange, { capture: true, passive: true });

    const setBusy = (busy: boolean): void => {
      deleteButton.disabled = busy;
      cancelButton.disabled = busy;
      saveButton.disabled = busy;
      note.disabled = busy;
      swatches.forEach((swatch) => {
        swatch.disabled = busy;
      });
    };
    cancelButton.addEventListener('click', () => this.close(true));
    saveButton.addEventListener('click', async () => {
      const noteBytes = new TextEncoder().encode(note.value).byteLength;
      if (noteBytes > HIGHLIGHT_LIMITS.noteBytes) {
        const message = `${translate('highlightSaveFailed', 'Could not save the highlight.')} (${noteBytes} / ${HIGHLIGHT_LIMITS.noteBytes})`;
        note.setCustomValidity(message);
        note.reportValidity();
        this.actions.announce(message);
        return;
      }
      note.setCustomValidity('');
      setBusy(true);
      const patch: HighlightUpdatePatch = { note: note.value, color: selectedColor };
      try {
        await this.actions.save(record, patch);
        if (this.popover !== popover) return;
        this.close(true);
        this.actions.announce(translate('highlightSaved', 'Highlight saved.'));
      } catch (error) {
        if (this.popover !== popover) return;
        setBusy(false);
        this.actions.announce(getSaveFailureMessage(error));
      }
    });
    note.addEventListener('input', () => note.setCustomValidity(''));
    deleteButton.addEventListener('click', async () => {
      setBusy(true);
      try {
        await this.actions.delete(record);
        if (this.popover !== popover) return;
        this.close();
      } catch (error) {
        if (this.popover !== popover) return;
        setBusy(false);
        this.actions.announce(getSaveFailureMessage(error));
      }
    });

    this.positionPopover(popover, anchorElement);
    this.popoverFocusTimer = window.setTimeout(() => {
      this.popoverFocusTimer = null;
      if (note.isConnected) note.focus({ preventScroll: true });
    }, 0);
  }

  private createPopoverButton(label: string, extraClass = ''): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `gv-highlight-popover-button ${extraClass}`.trim();
    button.textContent = label;
    return button;
  }

  private positionPopover(popover: HTMLElement, anchorElement: HTMLElement): void {
    const anchorRect = anchorElement.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const edge = 12;
    const gap = 8;
    const desiredTop = anchorRect.bottom + gap;
    const fallbackTop = anchorRect.top - popoverRect.height - gap;
    const top =
      desiredTop + popoverRect.height <= window.innerHeight - edge ? desiredTop : fallbackTop;
    const left = anchorRect.left + anchorRect.width / 2 - popoverRect.width / 2;
    popover.style.top = `${Math.max(edge, Math.min(top, window.innerHeight - popoverRect.height - edge))}px`;
    popover.style.left = `${Math.max(edge, Math.min(left, window.innerWidth - popoverRect.width - edge))}px`;
  }

  close(restoreFocus = false): void {
    const returnFocus = this.popoverReturnFocus;
    document.removeEventListener('click', this.onOutsideClick, true);
    document.removeEventListener('keydown', this.onKeydown, true);
    window.removeEventListener('resize', this.onViewportChange);
    document.removeEventListener('scroll', this.onViewportChange, true);
    if (this.popoverFocusTimer !== null) {
      window.clearTimeout(this.popoverFocusTimer);
      this.popoverFocusTimer = null;
    }
    this.popover?.remove();
    this.popover = null;
    this.popoverReturnFocus = null;
    if (!restoreFocus || !returnFocus?.isConnected) return;
    try {
      returnFocus.focus({ preventScroll: true });
    } catch {
      returnFocus.focus();
    }
  }
}
