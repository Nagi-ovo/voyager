import { afterEach, describe, expect, it, vi } from 'vitest';

import { IMAGE_EXPORT_WIDTH_WIDE } from '../../types/export';
import { ExportDialog } from '../ExportDialog';

describe('ExportDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('does not autofocus the first (json) radio option', () => {
    vi.useFakeTimers();

    const dialog = new ExportDialog();
    dialog.show({
      onExport: () => {},
      onCancel: () => {},
      translations: {
        title: 'Export Chat',
        selectFormat: 'Select format',
        warning: 'Warning',
        safariCmdpHint: 'Safari tip',
        safariMarkdownHint: 'Safari markdown tip',
        cancel: 'Cancel',
        export: 'Export',
        fontSizeLabel: 'Font Size',
        fontSizePreview: 'The quick brown fox jumps over the lazy dog.',
        imageWidthLabel: 'Image Width',
        imageWidthNarrow: 'Narrow',
        imageWidthMedium: 'Medium',
        imageWidthWide: 'Wide',
        promptHeadingLabel: 'Use prompts as turn headings',
        promptHeadingHint: 'Put each prompt in its turn heading.',
        formatDescriptions: {
          json: 'JSON format',
          markdown: 'Markdown format',
          pdf: 'PDF format',
          image: 'Image format',
        },
      },
    });

    const firstRadio = document.querySelector(
      'input[name="export-format"][value="json"]',
    ) as HTMLInputElement | null;
    const wrapper = document.querySelector('.gv-export-dialog') as HTMLElement | null;
    expect(firstRadio).not.toBeNull();
    expect(wrapper).not.toBeNull();

    vi.advanceTimersByTime(120);

    expect(document.activeElement).toBe(wrapper);
    expect(document.activeElement).not.toBe(firstRadio);
    expect(
      (document.querySelector('.gv-export-prompt-heading-section') as HTMLElement | null)?.style
        .display,
    ).toBe('none');
  });

  it('does not render warning block when warning is empty', () => {
    const dialog = new ExportDialog();
    dialog.show({
      onExport: () => {},
      onCancel: () => {},
      translations: {
        title: 'Export',
        selectFormat: 'Select format',
        warning: '',
        safariCmdpHint: 'Safari tip',
        safariMarkdownHint: 'Safari markdown tip',
        cancel: 'Cancel',
        export: 'Export',
        fontSizeLabel: 'Font Size',
        fontSizePreview: 'The quick brown fox jumps over the lazy dog.',
        imageWidthLabel: 'Image Width',
        imageWidthNarrow: 'Narrow',
        imageWidthMedium: 'Medium',
        imageWidthWide: 'Wide',
        promptHeadingLabel: 'Use prompts as turn headings',
        promptHeadingHint: 'Put each prompt in its turn heading.',
        formatDescriptions: {
          json: 'JSON format',
          markdown: 'Markdown format',
          pdf: 'PDF format',
          image: 'Image format',
        },
      },
    });

    const warning = document.querySelector('.gv-export-dialog-warning') as HTMLElement | null;
    expect(warning).toBeNull();
  });

  it('uses the provided initial image width when exporting an image', () => {
    const onExport = vi.fn();
    const dialog = new ExportDialog();
    dialog.show({
      onExport,
      onCancel: () => {},
      initialImageWidth: IMAGE_EXPORT_WIDTH_WIDE,
      translations: {
        title: 'Export',
        selectFormat: 'Select format',
        warning: '',
        safariCmdpHint: 'Safari tip',
        safariMarkdownHint: 'Safari markdown tip',
        cancel: 'Cancel',
        export: 'Export',
        fontSizeLabel: 'Font Size',
        fontSizePreview: 'The quick brown fox jumps over the lazy dog.',
        imageWidthLabel: 'Image Width',
        imageWidthNarrow: 'Narrow',
        imageWidthMedium: 'Medium',
        imageWidthWide: 'Wide',
        promptHeadingLabel: 'Use prompts as turn headings',
        promptHeadingHint: 'Put each prompt in its turn heading.',
        formatDescriptions: {
          json: 'JSON format',
          markdown: 'Markdown format',
          pdf: 'PDF format',
          image: 'Image format',
        },
      },
    });

    const imageRadio = document.querySelector(
      'input[name="export-format"][value="image"]',
    ) as HTMLInputElement | null;
    if (imageRadio) {
      imageRadio.checked = true;
    }
    imageRadio?.dispatchEvent(new Event('change', { bubbles: true }));

    const activeWidth = document.querySelector(
      '.gv-export-width-btn.active',
    ) as HTMLButtonElement | null;
    expect(activeWidth?.textContent).toBe('Wide');

    const exportButton = document.querySelector(
      '.gv-export-dialog-btn-primary',
    ) as HTMLButtonElement | null;
    exportButton?.click();

    expect(onExport).toHaveBeenCalledWith('image', 20, IMAGE_EXPORT_WIDTH_WIDE, undefined);
  });

  it('offers prompt headings for Markdown exports when enabled', () => {
    const onExport = vi.fn();
    const dialog = new ExportDialog();
    dialog.show({
      onExport,
      onCancel: () => {},
      showPromptHeadingOption: true,
      translations: {
        title: 'Export',
        selectFormat: 'Select format',
        warning: '',
        safariCmdpHint: 'Safari tip',
        safariMarkdownHint: 'Safari markdown tip',
        cancel: 'Cancel',
        export: 'Export',
        fontSizeLabel: 'Font Size',
        fontSizePreview: 'The quick brown fox jumps over the lazy dog.',
        imageWidthLabel: 'Image Width',
        imageWidthNarrow: 'Narrow',
        imageWidthMedium: 'Medium',
        imageWidthWide: 'Wide',
        promptHeadingLabel: 'Use prompts as turn headings',
        promptHeadingHint: 'Put each prompt in its turn heading.',
        formatDescriptions: {
          json: 'JSON format',
          markdown: 'Markdown format',
          pdf: 'PDF format',
          image: 'Image format',
        },
      },
    });

    const section = document.querySelector(
      '.gv-export-prompt-heading-section',
    ) as HTMLElement | null;
    const toggle = section?.querySelector('[role="switch"]') as HTMLButtonElement | null;
    expect(section?.style.display).toBe('flex');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');

    toggle?.click();
    expect(toggle?.getAttribute('aria-checked')).toBe('true');

    const exportButton = document.querySelector(
      '.gv-export-dialog-btn-primary',
    ) as HTMLButtonElement | null;
    exportButton?.click();

    expect(onExport).toHaveBeenCalledWith('markdown', undefined, undefined, true);
  });

  it('hides the prompt heading switch for non-Markdown formats', () => {
    const dialog = new ExportDialog();
    dialog.show({
      onExport: () => {},
      onCancel: () => {},
      showPromptHeadingOption: true,
      translations: {
        title: 'Export',
        selectFormat: 'Select format',
        warning: '',
        safariCmdpHint: 'Safari tip',
        safariMarkdownHint: 'Safari markdown tip',
        cancel: 'Cancel',
        export: 'Export',
        fontSizeLabel: 'Font Size',
        fontSizePreview: 'The quick brown fox jumps over the lazy dog.',
        imageWidthLabel: 'Image Width',
        imageWidthNarrow: 'Narrow',
        imageWidthMedium: 'Medium',
        imageWidthWide: 'Wide',
        promptHeadingLabel: 'Use prompts as turn headings',
        promptHeadingHint: 'Put each prompt in its turn heading.',
        formatDescriptions: {
          json: 'JSON format',
          markdown: 'Markdown format',
          pdf: 'PDF format',
          image: 'Image format',
        },
      },
    });

    const jsonRadio = document.querySelector(
      'input[name="export-format"][value="json"]',
    ) as HTMLInputElement | null;
    if (jsonRadio) jsonRadio.checked = true;
    jsonRadio?.dispatchEvent(new Event('change', { bubbles: true }));

    const section = document.querySelector(
      '.gv-export-prompt-heading-section',
    ) as HTMLElement | null;
    expect(section?.style.display).toBe('none');
  });

  it('restores saved speaker labels with accessible field labels', () => {
    const dialog = new ExportDialog();
    dialog.show({
      onExport: () => {},
      onCancel: () => {},
      initialSpeakerLabelOverrides: { user: 'Erik', assistant: 'Nova' },
      speakerNames: {
        title: 'Speaker names',
        userLabel: 'User label',
        assistantLabel: 'AI label',
        userDefault: 'User',
        assistantDefault: 'Assistant',
      },
      translations: {
        title: 'Export',
        selectFormat: 'Select format',
        warning: '',
        safariCmdpHint: 'Safari tip',
        safariMarkdownHint: 'Safari markdown tip',
        cancel: 'Cancel',
        export: 'Export',
        fontSizeLabel: 'Font Size',
        fontSizePreview: 'The quick brown fox jumps over the lazy dog.',
        imageWidthLabel: 'Image Width',
        imageWidthNarrow: 'Narrow',
        imageWidthMedium: 'Medium',
        imageWidthWide: 'Wide',
        promptHeadingLabel: 'Use prompts as turn headings',
        promptHeadingHint: 'Put each prompt in its turn heading.',
        formatDescriptions: {
          json: 'JSON format',
          markdown: 'Markdown format',
          pdf: 'PDF format',
          image: 'Image format',
        },
      },
    });

    const userInput = document.querySelector('#gv-export-speaker-user') as HTMLInputElement | null;
    const assistantInput = document.querySelector(
      '#gv-export-speaker-assistant',
    ) as HTMLInputElement | null;
    expect(userInput?.value).toBe('Erik');
    expect(assistantInput?.value).toBe('Nova');
    expect(document.querySelector('label[for="gv-export-speaker-user"]')?.textContent).toBe(
      'User label',
    );
    expect(document.querySelector('label[for="gv-export-speaker-assistant"]')?.textContent).toBe(
      'AI label',
    );
  });

  it('preserves an untouched explicit override that matches the localized default', () => {
    const onExport = vi.fn();
    const dialog = new ExportDialog();
    dialog.show({
      onExport,
      onCancel: () => {},
      initialSpeakerLabelOverrides: { assistant: 'Utilisateur' },
      speakerNames: {
        title: 'Speaker names',
        userLabel: 'User label',
        assistantLabel: 'AI label',
        userDefault: 'Utilisateur',
        assistantDefault: 'Utilisateur',
      },
      translations: {
        title: 'Export',
        selectFormat: 'Select format',
        warning: '',
        safariCmdpHint: 'Safari tip',
        safariMarkdownHint: 'Safari markdown tip',
        cancel: 'Cancel',
        export: 'Export',
        fontSizeLabel: 'Font Size',
        fontSizePreview: 'Preview',
        imageWidthLabel: 'Image Width',
        imageWidthNarrow: 'Narrow',
        imageWidthMedium: 'Medium',
        imageWidthWide: 'Wide',
        promptHeadingLabel: 'Use prompts as turn headings',
        promptHeadingHint: 'Put each prompt in its turn heading.',
        formatDescriptions: {
          json: 'JSON format',
          markdown: 'Markdown format',
          pdf: 'PDF format',
          image: 'Image format',
        },
      },
    });

    (document.querySelector('.gv-export-dialog-btn-primary') as HTMLButtonElement | null)?.click();

    expect(onExport).toHaveBeenCalledWith(
      'markdown',
      undefined,
      undefined,
      false,
      {
        user: 'Utilisateur',
        assistant: 'Utilisateur',
      },
      { assistant: 'Utilisateur' },
    );
  });

  it('clears only the edited explicit override and falls back to its localized default', () => {
    const onExport = vi.fn();
    const dialog = new ExportDialog();
    dialog.show({
      onExport,
      onCancel: () => {},
      initialSpeakerLabelOverrides: { user: 'Erik', assistant: 'Nova' },
      speakerNames: {
        title: 'Speaker names',
        userLabel: 'User label',
        assistantLabel: 'AI label',
        userDefault: 'User',
        assistantDefault: 'Assistant',
      },
      translations: {
        title: 'Export',
        selectFormat: 'Select format',
        warning: '',
        safariCmdpHint: 'Safari tip',
        safariMarkdownHint: 'Safari markdown tip',
        cancel: 'Cancel',
        export: 'Export',
        fontSizeLabel: 'Font Size',
        fontSizePreview: 'Preview',
        imageWidthLabel: 'Image Width',
        imageWidthNarrow: 'Narrow',
        imageWidthMedium: 'Medium',
        imageWidthWide: 'Wide',
        promptHeadingLabel: 'Use prompts as turn headings',
        promptHeadingHint: 'Put each prompt in its turn heading.',
        formatDescriptions: {
          json: 'JSON format',
          markdown: 'Markdown format',
          pdf: 'PDF format',
          image: 'Image format',
        },
      },
    });

    const userInput = document.querySelector('#gv-export-speaker-user') as HTMLInputElement | null;
    if (userInput) userInput.value = ' User ';
    userInput?.dispatchEvent(new Event('input', { bubbles: true }));

    (document.querySelector('.gv-export-dialog-btn-primary') as HTMLButtonElement | null)?.click();

    expect(onExport).toHaveBeenCalledWith(
      'markdown',
      undefined,
      undefined,
      false,
      {
        user: 'User',
        assistant: 'Nova',
      },
      { assistant: 'Nova' },
    );
  });

  it('hides labels for JSON without clearing values and restores them for human-readable formats', () => {
    const onExport = vi.fn();
    const dialog = new ExportDialog();
    dialog.show({
      onExport,
      onCancel: () => {},
      showPromptHeadingOption: true,
      speakerNames: {
        title: 'Speaker names',
        userLabel: 'User label',
        assistantLabel: 'AI label',
        userDefault: 'User',
        assistantDefault: 'Assistant',
      },
      translations: {
        title: 'Export',
        selectFormat: 'Select format',
        warning: '',
        safariCmdpHint: 'Safari tip',
        safariMarkdownHint: 'Safari markdown tip',
        cancel: 'Cancel',
        export: 'Export',
        fontSizeLabel: 'Font Size',
        fontSizePreview: 'The quick brown fox jumps over the lazy dog.',
        imageWidthLabel: 'Image Width',
        imageWidthNarrow: 'Narrow',
        imageWidthMedium: 'Medium',
        imageWidthWide: 'Wide',
        promptHeadingLabel: 'Use prompts as turn headings',
        promptHeadingHint: 'Put each prompt in its turn heading.',
        formatDescriptions: {
          json: 'JSON format',
          markdown: 'Markdown format',
          pdf: 'PDF format',
          image: 'Image format',
        },
      },
    });

    const section = document.querySelector('.gv-export-speakers-section') as HTMLElement | null;
    const userInput = document.querySelector('#gv-export-speaker-user') as HTMLInputElement | null;
    const assistantInput = document.querySelector(
      '#gv-export-speaker-assistant',
    ) as HTMLInputElement | null;
    if (userInput) userInput.value = 'Erik';
    userInput?.dispatchEvent(new Event('input', { bubbles: true }));
    if (assistantInput) assistantInput.value = 'Nova';
    assistantInput?.dispatchEvent(new Event('input', { bubbles: true }));

    const jsonRadio = document.querySelector(
      'input[name="export-format"][value="json"]',
    ) as HTMLInputElement | null;
    if (jsonRadio) jsonRadio.checked = true;
    jsonRadio?.dispatchEvent(new Event('change', { bubbles: true }));
    expect(section?.style.display).toBe('none');

    const markdownRadio = document.querySelector(
      'input[name="export-format"][value="markdown"]',
    ) as HTMLInputElement | null;
    if (markdownRadio) markdownRadio.checked = true;
    markdownRadio?.dispatchEvent(new Event('change', { bubbles: true }));
    expect(section?.style.display).toBe('block');
    expect(userInput?.value).toBe('Erik');
    expect(assistantInput?.value).toBe('Nova');

    (
      document.querySelector(
        '.gv-export-prompt-heading-section [role="switch"]',
      ) as HTMLButtonElement | null
    )?.click();
    (document.querySelector('.gv-export-dialog-btn-primary') as HTMLButtonElement | null)?.click();
    expect(onExport).toHaveBeenCalledWith(
      'markdown',
      undefined,
      undefined,
      true,
      {
        user: 'Erik',
        assistant: 'Nova',
      },
      {
        user: 'Erik',
        assistant: 'Nova',
      },
    );
  });

  it('resolves blank values to localized defaults on export', () => {
    const onExport = vi.fn();
    const dialog = new ExportDialog();
    dialog.show({
      onExport,
      onCancel: () => {},
      speakerNames: {
        title: 'Speaker names',
        userLabel: 'User label',
        assistantLabel: 'AI label',
        userDefault: 'Utilisateur',
        assistantDefault: 'Assistant IA',
      },
      translations: {
        title: 'Export',
        selectFormat: 'Select format',
        warning: '',
        safariCmdpHint: 'Safari tip',
        safariMarkdownHint: 'Safari markdown tip',
        cancel: 'Cancel',
        export: 'Export',
        fontSizeLabel: 'Font Size',
        fontSizePreview: 'Preview',
        imageWidthLabel: 'Image Width',
        imageWidthNarrow: 'Narrow',
        imageWidthMedium: 'Medium',
        imageWidthWide: 'Wide',
        promptHeadingLabel: 'Use prompts as turn headings',
        promptHeadingHint: 'Put each prompt in its turn heading.',
        formatDescriptions: {
          json: 'JSON format',
          markdown: 'Markdown format',
          pdf: 'PDF format',
          image: 'Image format',
        },
      },
    });

    const userInput = document.querySelector('#gv-export-speaker-user') as HTMLInputElement | null;
    const assistantInput = document.querySelector(
      '#gv-export-speaker-assistant',
    ) as HTMLInputElement | null;
    if (userInput) userInput.value = '';
    userInput?.dispatchEvent(new Event('input', { bubbles: true }));
    if (assistantInput) assistantInput.value = '   ';
    assistantInput?.dispatchEvent(new Event('input', { bubbles: true }));

    (document.querySelector('.gv-export-dialog-btn-primary') as HTMLButtonElement | null)?.click();
    expect(onExport).toHaveBeenCalledWith(
      'markdown',
      undefined,
      undefined,
      false,
      {
        user: 'Utilisateur',
        assistant: 'Assistant IA',
      },
      {},
    );
  });

  it('does not render speaker controls for standalone document exports', () => {
    const dialog = new ExportDialog();
    dialog.show({
      onExport: () => {},
      onCancel: () => {},
      speakerLabelsEnabled: false,
      speakerNames: {
        title: 'Speaker names',
        userLabel: 'User label',
        assistantLabel: 'AI label',
        userDefault: 'User',
        assistantDefault: 'Assistant',
      },
      translations: {
        title: 'Save Report',
        selectFormat: 'Select format',
        warning: '',
        safariCmdpHint: 'Safari tip',
        safariMarkdownHint: 'Safari markdown tip',
        cancel: 'Cancel',
        export: 'Export',
        fontSizeLabel: 'Font Size',
        fontSizePreview: 'Preview',
        imageWidthLabel: 'Image Width',
        imageWidthNarrow: 'Narrow',
        imageWidthMedium: 'Medium',
        imageWidthWide: 'Wide',
        promptHeadingLabel: 'Use prompts as turn headings',
        promptHeadingHint: 'Put each prompt in its turn heading.',
        formatDescriptions: {
          json: 'JSON format',
          markdown: 'Markdown format',
          pdf: 'PDF format',
          image: 'Image format',
        },
      },
    });

    expect(document.querySelector('.gv-export-speakers-section')).toBeNull();
  });
});
