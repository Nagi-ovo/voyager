/**
 * Export Dialog UI
 * Material Design styled format selection dialog
 */
import { isSafari } from '@/core/utils/browser';

import { ConversationExportService } from '../services/ConversationExportService';
import {
  DEFAULT_IMAGE_EXPORT_WIDTH,
  type ExportFormat,
  type ExportSpeakerLabelOverrides,
  type ExportSpeakerLabels,
  IMAGE_EXPORT_WIDTH_MEDIUM,
  IMAGE_EXPORT_WIDTH_NARROW,
  IMAGE_EXPORT_WIDTH_WIDE,
  type ImageExportWidth,
  normalizeImageExportWidth,
  normalizeSpeakerLabelOverrides,
} from '../types/export';

export interface ExportDialogOptions {
  onExport: (
    format: ExportFormat,
    fontSize?: number,
    imageWidth?: number,
    usePromptAsTurnHeading?: boolean,
    speakerLabels?: ExportSpeakerLabels,
    speakerLabelOverrides?: ExportSpeakerLabelOverrides,
  ) => void;
  onCancel: () => void;
  initialImageWidth?: ImageExportWidth;
  showPromptHeadingOption?: boolean;
  initialSpeakerLabelOverrides?: ExportSpeakerLabelOverrides;
  speakerLabelsEnabled?: boolean;
  speakerNames?: {
    title: string;
    userLabel: string;
    assistantLabel: string;
    userDefault: string;
    assistantDefault: string;
  };
  translations: {
    title: string;
    selectFormat: string;
    warning: string;
    safariCmdpHint: string;
    safariMarkdownHint: string;
    cancel: string;
    export: string;
    fontSizeLabel: string;
    fontSizePreview: string;
    imageWidthLabel: string;
    imageWidthNarrow: string;
    imageWidthMedium: string;
    imageWidthWide: string;
    promptHeadingLabel: string;
    promptHeadingHint: string;
    formatDescriptions: Record<ExportFormat, string>;
  };
}

/**
 * Export format selection dialog
 */
/** Default font sizes per format */
const PDF_DEFAULT_FONT_SIZE = 11;
const IMAGE_DEFAULT_FONT_SIZE = 20;
const PDF_MIN = 8;
const PDF_MAX = 16;
const IMAGE_MIN = 14;
const IMAGE_MAX = 28;

export class ExportDialog {
  private overlay: HTMLElement | null = null;
  private selectedFormat: ExportFormat = 'markdown' as ExportFormat;
  private fontSize: number = PDF_DEFAULT_FONT_SIZE;
  private imageWidth: ImageExportWidth = DEFAULT_IMAGE_EXPORT_WIDTH;
  private usePromptAsTurnHeading = false;
  private speakerLabelOverrides: ExportSpeakerLabelOverrides | null = null;

  /**
   * Show export dialog
   */
  show(options: ExportDialogOptions): void {
    this.imageWidth = normalizeImageExportWidth(options.initialImageWidth);
    this.usePromptAsTurnHeading = false;
    if (options.speakerNames && options.speakerLabelsEnabled !== false) {
      this.speakerLabelOverrides = normalizeSpeakerLabelOverrides(
        options.initialSpeakerLabelOverrides,
      );
    } else {
      this.speakerLabelOverrides = null;
    }
    this.overlay = this.createDialog(options);
    document.body.appendChild(this.overlay);

    // Keep initial focus on container to avoid showing a browser focus ring on JSON radio.
    const dialog = this.overlay.querySelector('.gv-export-dialog') as HTMLElement | null;
    dialog?.focus();
  }

  /**
   * Hide and cleanup dialog
   */
  hide(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  /**
   * Create dialog element
   */
  private createDialog(options: ExportDialogOptions): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = 'gv-export-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'gv-export-dialog';
    dialog.tabIndex = -1;

    // Title
    const title = document.createElement('div');
    title.className = 'gv-export-dialog-title';
    title.textContent = options.translations.title;

    // Subtitle
    const subtitle = document.createElement('div');
    subtitle.className = 'gv-export-dialog-subtitle';
    subtitle.textContent = options.translations.selectFormat;

    // Format options
    const formatsList = document.createElement('div');
    formatsList.className = 'gv-export-format-list';

    const formats = ConversationExportService.getAvailableFormats();
    formats.forEach((formatInfo) => {
      const localizedDescription =
        options.translations.formatDescriptions[formatInfo.format] || formatInfo.description;

      const option = this.createFormatOption(
        { ...formatInfo, description: localizedDescription },
        options.translations.safariCmdpHint,
        options.translations.safariMarkdownHint,
      );
      formatsList.appendChild(option);
    });

    // Font size section (visible only for PDF/Image)
    const fontSizeSection = this.createFontSizeSection(options);

    // Image width section (visible only for Image)
    const imageWidthSection = this.createImageWidthSection(options);

    // Prompt heading section (visible only for chat Markdown exports)
    const promptHeadingSection = this.createPromptHeadingSection(options);
    const speakerNamesSection = this.createSpeakerNamesSection(options);

    // Buttons
    const buttons = document.createElement('div');
    buttons.className = 'gv-export-dialog-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'gv-export-dialog-btn gv-export-dialog-btn-secondary';
    cancelBtn.textContent = options.translations.cancel;
    cancelBtn.addEventListener('click', () => {
      options.onCancel();
      this.hide();
    });

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'gv-export-dialog-btn gv-export-dialog-btn-primary';
    exportBtn.textContent = options.translations.export;
    exportBtn.addEventListener('click', () => {
      const isPdf = this.selectedFormat === ('pdf' as ExportFormat);
      const isImage = this.selectedFormat === ('image' as ExportFormat);
      const isMarkdown = this.selectedFormat === ('markdown' as ExportFormat);
      const fontSize = isPdf || isImage ? this.fontSize : undefined;
      const imageWidth = isImage ? this.imageWidth : undefined;
      const usePromptAsTurnHeading = isMarkdown ? this.usePromptAsTurnHeading : undefined;
      if (
        this.selectedFormat !== ('json' as ExportFormat) &&
        this.speakerLabelOverrides &&
        options.speakerNames
      ) {
        const speakerLabelOverrides = { ...this.speakerLabelOverrides };
        const speakerLabels: ExportSpeakerLabels = {
          user: speakerLabelOverrides.user ?? options.speakerNames.userDefault,
          assistant: speakerLabelOverrides.assistant ?? options.speakerNames.assistantDefault,
        };
        options.onExport(
          this.selectedFormat,
          fontSize,
          imageWidth,
          usePromptAsTurnHeading,
          speakerLabels,
          speakerLabelOverrides,
        );
      } else {
        options.onExport(this.selectedFormat, fontSize, imageWidth, usePromptAsTurnHeading);
      }
      this.hide();
    });

    buttons.appendChild(cancelBtn);
    buttons.appendChild(exportBtn);

    // Assemble dialog
    dialog.appendChild(title);
    dialog.appendChild(subtitle);
    if (options.translations.warning.trim()) {
      const warning = document.createElement('div');
      warning.className = 'gv-export-dialog-warning';
      warning.textContent = options.translations.warning;
      dialog.appendChild(warning);
    }
    dialog.appendChild(formatsList);
    dialog.appendChild(promptHeadingSection);
    if (speakerNamesSection) {
      dialog.appendChild(speakerNamesSection);
    }
    dialog.appendChild(fontSizeSection);
    dialog.appendChild(imageWidthSection);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        options.onCancel();
        this.hide();
      }
    });

    // Close on Escape key
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        options.onCancel();
        this.hide();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);

    return overlay;
  }

  private createSpeakerNamesSection(options: ExportDialogOptions): HTMLElement | null {
    const speakerNames = options.speakerNames;
    const speakerLabelOverrides = this.speakerLabelOverrides;
    if (!speakerNames || options.speakerLabelsEnabled === false || !speakerLabelOverrides) {
      return null;
    }

    const section = document.createElement('div');
    section.className = 'gv-export-speakers-section';

    const title = document.createElement('div');
    title.className = 'gv-export-speakers-title';
    title.textContent = speakerNames.title;

    const fields = document.createElement('div');
    fields.className = 'gv-export-speakers-fields';

    const createField = (
      id: string,
      labelText: string,
      key: keyof ExportSpeakerLabels,
    ): HTMLElement => {
      const field = document.createElement('div');
      field.className = 'gv-export-speaker-field';

      const label = document.createElement('label');
      label.className = 'gv-export-speaker-label';
      label.htmlFor = id;
      label.textContent = labelText;

      const input = document.createElement('input');
      input.id = id;
      input.type = 'text';
      input.className = 'gv-export-speaker-input';
      input.autocomplete = 'off';
      const defaultValue =
        key === 'user' ? speakerNames.userDefault : speakerNames.assistantDefault;
      input.value = speakerLabelOverrides[key] ?? defaultValue;
      input.addEventListener('input', () => {
        const normalized = input.value.trim();
        if (!normalized || normalized === defaultValue) {
          delete speakerLabelOverrides[key];
        } else {
          speakerLabelOverrides[key] = normalized;
        }
      });

      field.appendChild(label);
      field.appendChild(input);
      return field;
    };

    fields.appendChild(createField('gv-export-speaker-user', speakerNames.userLabel, 'user'));
    fields.appendChild(
      createField('gv-export-speaker-assistant', speakerNames.assistantLabel, 'assistant'),
    );

    section.appendChild(title);
    section.appendChild(fields);
    return section;
  }

  /**
   * Create format option radio button
   */
  private createFormatOption(
    formatInfo: {
      format: ExportFormat;
      label: string;
      description: string;
      recommended?: boolean;
    },
    safariCmdpHint: string,
    safariMarkdownHint: string,
  ): HTMLElement {
    const option = document.createElement('label');
    option.className = 'gv-export-format-option';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'export-format';
    radio.value = formatInfo.format;
    radio.checked = formatInfo.format === 'markdown';

    if (radio.checked) {
      this.selectedFormat = formatInfo.format;
    }

    radio.addEventListener('change', () => {
      if (radio.checked) {
        this.selectedFormat = formatInfo.format;
        this.updateOptionalSections();
      }
    });

    const content = document.createElement('div');
    content.className = 'gv-export-format-content';

    const labelDiv = document.createElement('div');
    labelDiv.className = 'gv-export-format-label';
    labelDiv.textContent = formatInfo.label;

    if (formatInfo.recommended) {
      const badge = document.createElement('span');
      badge.className = 'gv-export-format-badge';
      badge.textContent = 'Recommended';
      labelDiv.appendChild(badge);
    }

    const desc = document.createElement('div');
    desc.className = 'gv-export-format-description';
    let hintText = formatInfo.description;

    if (isSafari()) {
      if (formatInfo.format === ('pdf' as ExportFormat)) {
        hintText = `${formatInfo.description} ${safariCmdpHint}`;
      } else if (
        formatInfo.format === ('markdown' as ExportFormat) ||
        formatInfo.format === ('image' as ExportFormat)
      ) {
        hintText = `${formatInfo.description} ${safariMarkdownHint}`;
      }
    }

    desc.textContent = hintText;

    content.appendChild(labelDiv);
    content.appendChild(desc);

    option.appendChild(radio);
    option.appendChild(content);

    return option;
  }

  /**
   * Create font size control section with slider and preview
   */
  private createFontSizeSection(options: ExportDialogOptions): HTMLElement {
    const section = document.createElement('div');
    section.className = 'gv-export-fontsize-section';
    // Hidden by default since markdown is initially selected
    section.style.display = 'none';

    // Header row: label + value
    const header = document.createElement('div');
    header.className = 'gv-export-fontsize-header';

    const label = document.createElement('span');
    label.className = 'gv-export-fontsize-label';
    label.textContent = options.translations.fontSizeLabel;

    const value = document.createElement('span');
    value.className = 'gv-export-fontsize-value';
    value.textContent = `${this.fontSize}pt`;

    header.appendChild(label);
    header.appendChild(value);

    // Slider
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'gv-export-fontsize-slider';
    slider.min = String(PDF_MIN);
    slider.max = String(PDF_MAX);
    slider.step = '1';
    slider.value = String(this.fontSize);

    // Preview text
    const preview = document.createElement('div');
    preview.className = 'gv-export-fontsize-preview';
    preview.textContent = options.translations.fontSizePreview;
    preview.style.fontSize = `${this.fontSize}pt`;

    slider.addEventListener('input', () => {
      this.fontSize = Number(slider.value);
      const unit = this.selectedFormat === ('image' as ExportFormat) ? 'px' : 'pt';
      value.textContent = `${this.fontSize}${unit}`;
      preview.style.fontSize = `${this.fontSize}${unit}`;
    });

    section.appendChild(header);
    section.appendChild(slider);
    section.appendChild(preview);

    return section;
  }

  /**
   * Create image width selection section
   */
  private createImageWidthSection(options: ExportDialogOptions): HTMLElement {
    const section = document.createElement('div');
    section.className = 'gv-export-imagewidth-section';
    section.style.display = 'none';

    const label = document.createElement('div');
    label.className = 'gv-export-fontsize-label';
    label.style.marginBottom = '8px';
    label.textContent = options.translations.imageWidthLabel;

    const group = document.createElement('div');
    group.className = 'gv-export-width-group';
    group.style.display = 'flex';
    group.style.gap = '8px';

    const widths = [
      {
        value: IMAGE_EXPORT_WIDTH_NARROW,
        label: options.translations.imageWidthNarrow,
      },
      {
        value: IMAGE_EXPORT_WIDTH_MEDIUM,
        label: options.translations.imageWidthMedium,
      },
      { value: IMAGE_EXPORT_WIDTH_WIDE, label: options.translations.imageWidthWide },
    ];

    widths.forEach((w) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gv-export-width-btn';
      btn.textContent = w.label;
      if (w.value === this.imageWidth) {
        btn.classList.add('active');
      }

      btn.addEventListener('click', () => {
        this.imageWidth = w.value;
        group.querySelectorAll('.gv-export-width-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });

      group.appendChild(btn);
    });

    section.appendChild(label);
    section.appendChild(group);

    return section;
  }

  private createPromptHeadingSection(options: ExportDialogOptions): HTMLElement {
    const section = document.createElement('div');
    section.className = 'gv-export-prompt-heading-section';
    section.dataset.enabled = options.showPromptHeadingOption ? 'true' : 'false';
    section.style.display = options.showPromptHeadingOption ? 'flex' : 'none';

    const copy = document.createElement('div');
    copy.className = 'gv-export-prompt-heading-copy';

    const label = document.createElement('div');
    label.className = 'gv-export-fontsize-label gv-export-prompt-heading-label';
    label.textContent = options.translations.promptHeadingLabel;

    const hint = document.createElement('div');
    hint.className = 'gv-export-format-description gv-export-prompt-heading-hint';
    hint.textContent = options.translations.promptHeadingHint;

    copy.appendChild(label);
    copy.appendChild(hint);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'gv-coach-switch gv-export-prompt-heading-switch';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', options.translations.promptHeadingLabel);
    toggle.setAttribute('aria-checked', 'false');

    const knob = document.createElement('span');
    knob.className = 'gv-coach-knob';
    toggle.appendChild(knob);

    toggle.addEventListener('click', () => {
      this.usePromptAsTurnHeading = !this.usePromptAsTurnHeading;
      toggle.setAttribute('aria-checked', this.usePromptAsTurnHeading ? 'true' : 'false');
    });

    section.appendChild(copy);
    section.appendChild(toggle);
    return section;
  }

  /**
   * Update optional sections visibility and slider range based on selected format
   */
  private updateOptionalSections(): void {
    if (!this.overlay) return;

    const fontSizeSection = this.overlay.querySelector(
      '.gv-export-fontsize-section',
    ) as HTMLElement | null;
    const imageWidthSection = this.overlay.querySelector(
      '.gv-export-imagewidth-section',
    ) as HTMLElement | null;
    const promptHeadingSection = this.overlay.querySelector(
      '.gv-export-prompt-heading-section',
    ) as HTMLElement | null;
    const speakerNamesSection = this.overlay.querySelector(
      '.gv-export-speakers-section',
    ) as HTMLElement | null;

    if (!fontSizeSection || !imageWidthSection || !promptHeadingSection) return;

    const isPdf = this.selectedFormat === ('pdf' as ExportFormat);
    const isImage = this.selectedFormat === ('image' as ExportFormat);
    const isMarkdown = this.selectedFormat === ('markdown' as ExportFormat);

    fontSizeSection.style.display = isPdf || isImage ? 'block' : 'none';
    imageWidthSection.style.display = isImage ? 'block' : 'none';
    promptHeadingSection.style.display =
      isMarkdown && promptHeadingSection.dataset.enabled === 'true' ? 'flex' : 'none';
    if (speakerNamesSection) {
      speakerNamesSection.style.display =
        this.selectedFormat === ('json' as ExportFormat) ? 'none' : 'block';
    }

    if (isPdf || isImage) {
      const slider = fontSizeSection.querySelector(
        '.gv-export-fontsize-slider',
      ) as HTMLInputElement | null;
      const value = fontSizeSection.querySelector(
        '.gv-export-fontsize-value',
      ) as HTMLElement | null;
      const preview = fontSizeSection.querySelector(
        '.gv-export-fontsize-preview',
      ) as HTMLElement | null;

      if (isPdf) {
        this.fontSize = PDF_DEFAULT_FONT_SIZE;
        if (slider) {
          slider.min = String(PDF_MIN);
          slider.max = String(PDF_MAX);
          slider.value = String(this.fontSize);
        }
        if (value) value.textContent = `${this.fontSize}pt`;
        if (preview) preview.style.fontSize = `${this.fontSize}pt`;
      } else {
        this.fontSize = IMAGE_DEFAULT_FONT_SIZE;
        if (slider) {
          slider.min = String(IMAGE_MIN);
          slider.max = String(IMAGE_MAX);
          slider.value = String(this.fontSize);
        }
        if (value) value.textContent = `${this.fontSize}px`;
        if (preview) preview.style.fontSize = `${this.fontSize}px`;
      }
    }
  }
}
