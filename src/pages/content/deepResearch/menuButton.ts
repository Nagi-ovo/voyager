/**
 * Menu button injection module for Deep Research export
 */
import { StorageKeys } from '@/core/types/common';
import { isSafari } from '@/core/utils/browser';
import { ConversationExportService } from '@/features/export/services/ConversationExportService';
import {
  getSavedImageExportWidth,
  saveImageExportWidth,
} from '@/features/export/services/ImageExportPreferenceService';
import type {
  ConversationMetadata,
  ChatTurn as ExportChatTurn,
  ExportFormat,
} from '@/features/export/types/export';
import { ExportDialog } from '@/features/export/ui/ExportDialog';
import { resolveExportErrorMessage } from '@/features/export/ui/ExportErrorMessage';
import { showExportToast } from '@/features/export/ui/ExportToast';
import { type AppLanguage, normalizeLanguage } from '@/utils/language';
import { extractMessageDictionary } from '@/utils/localeMessages';
import type { TranslationKey } from '@/utils/translations';

import {
  createMenuItemFromNativeTemplate,
  updateMenuItemTemplateLabel,
} from '../shared/nativeMenuItemTemplate';
import { downloadMarkdown } from './download';
import { extractThinkingPanels } from './extractor';
import { formatToMarkdown } from './formatter';
import { extractDeepResearchReportTitle, findDeepResearchReportRoot } from './reportExtractor';

type Dictionaries = Record<AppLanguage, Record<string, string>>;
const DOWNLOAD_BUTTON_CLASS = 'gv-deep-research-download';
const SAVE_REPORT_BUTTON_CLASS = 'gv-deep-research-save-report';
const INJECTED_BUTTON_CLASSES = [DOWNLOAD_BUTTON_CLASS, SAVE_REPORT_BUTTON_CLASS];
const TEMPLATE_EXCLUDED_CLASS_NAMES = [...INJECTED_BUTTON_CLASSES, 'share-button'];

/**
 * Wait for an element to appear in the DOM
 */
function waitForElement(selector: string, timeout: number = 5000): Promise<Element | null> {
  return new Promise((resolve) => {
    const element = document.querySelector(selector);
    if (element) {
      return resolve(element);
    }

    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) {
        observer.disconnect();
        resolve(found);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}

/**
 * Load i18n dictionaries
 */
async function loadDictionaries(): Promise<Dictionaries> {
  try {
    const [enRaw, zhRaw, zhTWRaw, jaRaw, frRaw, esRaw, ptRaw, arRaw, ruRaw, koRaw] =
      await Promise.all([
        import(/* @vite-ignore */ '../../../locales/en/messages.json'),
        import(/* @vite-ignore */ '../../../locales/zh/messages.json'),
        import(/* @vite-ignore */ '../../../locales/zh_TW/messages.json'),
        import(/* @vite-ignore */ '../../../locales/ja/messages.json'),
        import(/* @vite-ignore */ '../../../locales/fr/messages.json'),
        import(/* @vite-ignore */ '../../../locales/es/messages.json'),
        import(/* @vite-ignore */ '../../../locales/pt/messages.json'),
        import(/* @vite-ignore */ '../../../locales/ar/messages.json'),
        import(/* @vite-ignore */ '../../../locales/ru/messages.json'),
        import(/* @vite-ignore */ '../../../locales/ko/messages.json'),
      ]);

    return {
      en: extractMessageDictionary(enRaw),
      zh: extractMessageDictionary(zhRaw),
      zh_TW: extractMessageDictionary(zhTWRaw),
      ja: extractMessageDictionary(jaRaw),
      fr: extractMessageDictionary(frRaw),
      es: extractMessageDictionary(esRaw),
      pt: extractMessageDictionary(ptRaw),
      ar: extractMessageDictionary(arRaw),
      ru: extractMessageDictionary(ruRaw),
      ko: extractMessageDictionary(koRaw),
    };
  } catch (error) {
    console.error('[Gemini Voyager] Error loading dictionaries:', error);
    return {
      en: {},
      zh: {},
      zh_TW: {},
      ja: {},
      fr: {},
      es: {},
      pt: {},
      ar: {},
      ru: {},
      ko: {},
    };
  }
}

export function applyDeepResearchDownloadButtonI18n(
  button: HTMLElement,
  dict: Dictionaries,
  lang: AppLanguage,
): void {
  const t = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;
  const text = t('deepResearchDownload');
  const tooltip = t('deepResearchDownloadTooltip');

  updateMenuItemTemplateLabel(button, text, tooltip);
}

export function applyDeepResearchSaveReportButtonI18n(
  button: HTMLElement,
  dict: Dictionaries,
  lang: AppLanguage,
): void {
  const t = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;
  const text = t('deepResearchSaveReport');
  const tooltip = t('deepResearchSaveReportTooltip');

  updateMenuItemTemplateLabel(button, text, tooltip);
}

/**
 * Get user language preference
 */
async function getLanguage(): Promise<AppLanguage> {
  try {
    const stored = await new Promise<unknown>((resolve) => {
      try {
        const w = window as Window & {
          chrome?: typeof chrome;
          browser?: { storage?: { sync?: { get: (key: string) => Promise<unknown> } } };
        };
        // Chrome uses callback-based API
        if (w.chrome?.storage?.sync?.get) {
          w.chrome.storage.sync.get(StorageKeys.LANGUAGE, resolve);
        }
        // Firefox uses Promise-based API
        else if (w.browser?.storage?.sync?.get) {
          w.browser.storage.sync
            .get(StorageKeys.LANGUAGE)
            .then(resolve)
            .catch(() => resolve({}));
        } else {
          resolve({});
        }
      } catch {
        resolve({});
      }
    });

    const rec = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
    const lang =
      typeof rec[StorageKeys.LANGUAGE] === 'string'
        ? (rec[StorageKeys.LANGUAGE] as string)
        : undefined;
    return normalizeLanguage(lang || navigator.language || 'en');
  } catch {
    return 'en';
  }
}

/**
 * Handle download button click
 */
async function handleDownload(): Promise<void> {
  try {
    console.log('[Gemini Voyager] Extracting Deep Research thinking content...');

    const content = extractThinkingPanels();
    if (!content) {
      console.warn('[Gemini Voyager] No thinking content found');
      return;
    }

    const markdown = await formatToMarkdown(content);
    downloadMarkdown(markdown);
  } catch (error) {
    console.error('[Gemini Voyager] Error handling download:', error);
  }
}

/**
 * Create menu button matching Material Design style
 */
function createMenuButtonFallback({
  text,
  tooltip,
  className,
  iconName,
  onClick,
}: {
  text: string;
  tooltip: string;
  className: string;
  iconName: string;
  onClick: () => void;
}): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = `mat-mdc-menu-item mat-focus-indicator menu-item-button ${className}`;
  button.setAttribute('mat-menu-item', '');
  button.setAttribute('role', 'menuitem');
  button.setAttribute('tabindex', '0');
  button.setAttribute('aria-disabled', 'false');
  button.setAttribute('aria-label', tooltip);
  button.title = tooltip;

  // Create icon
  const icon = document.createElement('mat-icon');
  icon.className =
    'mat-icon notranslate menu-icon google-symbols mat-ligature-font mat-icon-no-color';
  icon.setAttribute('role', 'img');
  icon.setAttribute('fonticon', iconName);
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '';

  // Create text span
  const span = document.createElement('span');
  span.className = 'mat-mdc-menu-item-text';
  span.textContent = text;

  // Create ripple effect
  const ripple = document.createElement('div');
  ripple.className = 'mat-ripple mat-mdc-menu-ripple';
  ripple.setAttribute('matripple', '');

  button.appendChild(icon);
  button.appendChild(span);
  button.appendChild(ripple);

  // Add click handler
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });

  return button;
}

function createMenuButton({
  text,
  tooltip,
  className,
  iconName,
  onClick,
  menuContent,
}: {
  text: string;
  tooltip: string;
  className: string;
  iconName: string;
  onClick: () => void;
  menuContent: HTMLElement;
}): HTMLElement {
  const button =
    createMenuItemFromNativeTemplate({
      menuContent,
      injectedClassName: className,
      iconName,
      label: text,
      tooltip,
      excludedClassNames: TEMPLATE_EXCLUDED_CLASS_NAMES,
    }) ??
    createMenuButtonFallback({
      text,
      tooltip,
      className,
      iconName,
      onClick: () => {},
    });

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });

  return button;
}

function createDownloadButton(
  text: string,
  tooltip: string,
  menuContent: HTMLElement,
): HTMLElement {
  return createMenuButton({
    text,
    tooltip,
    className: DOWNLOAD_BUTTON_CLASS,
    iconName: 'download',
    onClick: () => void handleDownload(),
    menuContent,
  });
}

function sanitizeFilenamePart(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/\.+$/g, '')
    .slice(0, 80);
  return cleaned || 'deep-research-report';
}

function buildReportFilename(format: ExportFormat, title: string): string {
  const base = sanitizeFilenamePart(title || 'deep-research-report');
  if (format === 'json') return `${base}.json`;
  if (format === 'markdown') return `${base}.md`;
  if (format === 'pdf') return `${base}.pdf`;
  return `${base}.png`;
}

export function showDeepResearchExportProgressOverlay(
  t: (key: TranslationKey) => string,
): () => void {
  const overlay = document.createElement('div');
  overlay.className = 'gv-export-progress-overlay';

  const card = document.createElement('div');
  card.className = 'gv-export-progress-card';

  const spinner = document.createElement('div');
  spinner.className = 'gv-export-progress-spinner';

  const title = document.createElement('div');
  title.className = 'gv-export-progress-title';
  title.textContent = `${t('pm_export')}...`;

  const desc = document.createElement('div');
  desc.className = 'gv-export-progress-desc';
  desc.textContent = t('loading');

  card.appendChild(spinner);
  card.appendChild(title);
  card.appendChild(desc);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  return () => {
    try {
      overlay.remove();
    } catch {}
  };
}

function handleSaveReport(dict: Dictionaries, lang: AppLanguage): void {
  void (async () => {
    const reportRoot = findDeepResearchReportRoot();
    if (!reportRoot) {
      console.warn('[Gemini Voyager] Report content root not found');
      return;
    }

    const reportTitle = extractDeepResearchReportTitle(reportRoot);
    const metadata: ConversationMetadata = {
      url: location.href,
      exportedAt: new Date().toISOString(),
      count: 1,
      title: reportTitle,
    };

    const turns: ExportChatTurn[] = [
      {
        user: '',
        assistant: '',
        starred: false,
        omitEmptySections: true,
        assistantElement: reportRoot,
      },
    ];

    const initialImageWidth = await getSavedImageExportWidth();
    const t = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;
    const dialog = new ExportDialog();
    dialog.show({
      onExport: async (format, fontSize, imageWidth) => {
        const hideProgress = showDeepResearchExportProgressOverlay(t);
        try {
          if (format === 'image') {
            await saveImageExportWidth(imageWidth);
          }
          const filename = buildReportFilename(format, reportTitle);
          const resultPromise = ConversationExportService.export(turns, metadata, {
            format,
            filename,
            layout: 'document',
            fontSize,
            imageWidth,
          });
          const minVisiblePromise = new Promise((resolve) => setTimeout(resolve, 420));
          const [result] = await Promise.all([resultPromise, minVisiblePromise]);
          if (!result.success) {
            alert(resolveExportErrorMessage(result.error, t));
          } else if (format === 'pdf' && isSafari()) {
            showExportToast(t('export_toast_safari_pdf_ready'), { autoDismissMs: 5000 });
          }
        } catch (error) {
          console.error('[Gemini Voyager] Report export error:', error);
          alert('Export error occurred.');
        } finally {
          hideProgress();
        }
      },
      onCancel: () => {},
      initialImageWidth,
      speakerLabelsEnabled: false,
      translations: {
        title: t('deepResearchSaveReport'),
        selectFormat: t('export_dialog_select'),
        warning: '',
        safariCmdpHint: t('export_dialog_safari_cmdp_hint'),
        safariMarkdownHint: t('export_dialog_safari_markdown_hint'),
        cancel: t('pm_cancel'),
        export: t('pm_export'),
        fontSizeLabel: t('export_fontsize_label'),
        fontSizePreview: t('export_fontsize_preview'),
        imageWidthLabel: t('export_image_width_label'),
        imageWidthNarrow: t('export_image_width_narrow'),
        imageWidthMedium: t('export_image_width_medium'),
        imageWidthWide: t('export_image_width_wide'),
        promptHeadingLabel: t('export_markdown_prompt_heading'),
        promptHeadingHint: t('export_markdown_prompt_heading_hint'),
        formatDescriptions: {
          json: t('export_format_json_description'),
          markdown: t('export_format_markdown_description'),
          pdf: t('export_format_pdf_description'),
          image: t('export_format_image_description'),
        },
      },
    });
  })().catch((error: unknown) => {
    console.error('[Gemini Voyager] Failed to open report export dialog:', error);
  });
}

function createSaveReportButton(
  text: string,
  tooltip: string,
  dict: Dictionaries,
  menuContent: HTMLElement,
): HTMLElement {
  return createMenuButton({
    text,
    tooltip,
    className: SAVE_REPORT_BUTTON_CLASS,
    iconName: 'description',
    onClick: () => {
      void getLanguage().then((currentLanguage) => {
        handleSaveReport(dict, currentLanguage);
      });
    },
    menuContent,
  });
}

type StorageChange = { newValue?: unknown };
type StorageChanges = Record<string, StorageChange>;

type StorageOnChanged = {
  addListener: (fn: (changes: StorageChanges, area: string) => void) => void;
  removeListener: (fn: (changes: StorageChanges, area: string) => void) => void;
};

type ExtensionStorage = {
  onChanged?: StorageOnChanged;
};

function getExtensionStorage(): ExtensionStorage | null {
  const w = window as unknown as {
    chrome?: { storage?: ExtensionStorage };
    browser?: { storage?: ExtensionStorage };
  };
  return w.chrome?.storage ?? w.browser?.storage ?? null;
}

export function isDeepResearchReportMenuPanel(menuPanel: HTMLElement): boolean {
  if (!menuPanel.matches('.mat-mdc-menu-panel[role="menu"]')) return false;
  const menuContent = menuPanel.querySelector('.mat-mdc-menu-content');
  if (!(menuContent instanceof HTMLElement)) return false;

  const hasShareContainer = Boolean(
    menuContent.querySelector('[data-test-id="share-button-tooltip-container"]'),
  );
  const hasReportExportActions = Boolean(
    menuContent.querySelector('[data-test-id="export-to-docs-button"]') ||
      menuContent.querySelector('[data-test-id="copy-button"]'),
  );

  return hasShareContainer && hasReportExportActions;
}

/**
 * Inject download button into menu
 */
export async function injectDownloadButton(targetMenuPanel?: HTMLElement): Promise<void> {
  try {
    // Load i18n
    const dict = await loadDictionaries();
    const lang = await getLanguage();
    const t = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;

    const menuPanel = targetMenuPanel ?? (await waitForElement('.mat-mdc-menu-panel[role="menu"]'));
    if (!menuPanel) {
      console.log('[Gemini Voyager] Menu panel not found');
      return;
    }
    if (!(menuPanel instanceof HTMLElement)) return;
    if (!menuPanel.isConnected) return;
    if (!isDeepResearchReportMenuPanel(menuPanel)) return;

    // Find the menu content container
    const menuContent = menuPanel.querySelector('.mat-mdc-menu-content');
    if (!menuContent) {
      console.log('[Gemini Voyager] Menu content not found');
      return;
    }

    let downloadButton = menuPanel.querySelector(`.${DOWNLOAD_BUTTON_CLASS}`) as HTMLElement | null;
    if (!downloadButton) {
      downloadButton = createDownloadButton(
        t('deepResearchDownload'),
        t('deepResearchDownloadTooltip'),
        menuContent as HTMLElement,
      );
      menuContent.appendChild(downloadButton);
    }

    let saveReportButton = menuPanel.querySelector(
      `.${SAVE_REPORT_BUTTON_CLASS}`,
    ) as HTMLElement | null;
    if (!saveReportButton) {
      saveReportButton = createSaveReportButton(
        t('deepResearchSaveReport'),
        t('deepResearchSaveReportTooltip'),
        dict,
        menuContent as HTMLElement,
      );
      menuContent.appendChild(saveReportButton);
    }

    applyDeepResearchDownloadButtonI18n(downloadButton, dict, lang);
    applyDeepResearchSaveReportButtonI18n(saveReportButton, dict, lang);

    // Keep button text/tooltip in sync with runtime language changes
    const storage = getExtensionStorage();
    const onChanged = storage?.onChanged;
    if (onChanged?.addListener && onChanged?.removeListener) {
      let currentLang: AppLanguage = lang;
      const handler = (changes: StorageChanges, area: string) => {
        if (area !== 'sync') return;
        const nextRaw = changes?.[StorageKeys.LANGUAGE]?.newValue;
        if (typeof nextRaw !== 'string') return;
        currentLang = normalizeLanguage(nextRaw);
        applyDeepResearchDownloadButtonI18n(downloadButton, dict, currentLang);
        applyDeepResearchSaveReportButtonI18n(saveReportButton, dict, currentLang);
      };

      onChanged.addListener(handler);

      const cleanup = () => {
        try {
          onChanged.removeListener(handler);
        } catch {}
      };

      const observer = new MutationObserver(() => {
        if (typeof document === 'undefined') {
          cleanup();
          observer.disconnect();
          return;
        }
        const downloadDetached = !document.contains(downloadButton);
        const saveReportDetached = !document.contains(saveReportButton);
        if (downloadDetached && saveReportDetached) {
          cleanup();
          observer.disconnect();
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      window.addEventListener(
        'beforeunload',
        () => {
          cleanup();
          try {
            observer.disconnect();
          } catch {}
        },
        { once: true },
      );
    }

    console.log('[Gemini Voyager] Deep Research menu buttons injected successfully');
  } catch (error) {
    console.error('[Gemini Voyager] Error injecting Deep Research menu buttons:', error);
  }
}
