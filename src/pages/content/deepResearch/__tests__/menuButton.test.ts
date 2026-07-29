import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AppLanguage } from '@/utils/language';
import type { TranslationKey } from '@/utils/translations';

import {
  applyDeepResearchDownloadButtonI18n,
  applyDeepResearchSaveReportButtonI18n,
  injectDownloadButton,
  isDeepResearchReportMenuPanel,
  showDeepResearchExportProgressOverlay,
} from '../menuButton';

function createNativeMenuButton({
  testId,
  label,
  iconName,
  buttonClassName,
  iconClassName,
}: {
  testId: string;
  label: string;
  iconName: string;
  buttonClassName: string;
  iconClassName: string;
}): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = buttonClassName;
  button.setAttribute('role', 'menuitem');
  button.setAttribute('tabindex', '0');
  button.setAttribute('data-test-id', testId);

  const icon = document.createElement('mat-icon');
  icon.className = iconClassName;
  icon.setAttribute('fonticon', iconName);
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '';

  const text = document.createElement('span');
  text.className = 'mat-mdc-menu-item-text';
  text.textContent = label;

  const ripple = document.createElement('div');
  ripple.className = 'mat-ripple mat-mdc-menu-ripple';
  ripple.setAttribute('matripple', '');

  button.appendChild(icon);
  button.appendChild(text);
  button.appendChild(ripple);
  return button;
}

function createDeepResearchReportMenuPanel(
  shareMarker = 'share-button-tooltip-container',
): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'mat-mdc-menu-panel';
  panel.setAttribute('role', 'menu');

  const content = document.createElement('div');
  content.className = 'mat-mdc-menu-content';

  const shareContainer = document.createElement('div');
  shareContainer.setAttribute('data-test-id', shareMarker);
  const shareButtonWrapper = document.createElement('share-button');
  const shareButton = createNativeMenuButton({
    testId: 'share-button',
    label: 'Share',
    iconName: 'share',
    buttonClassName:
      'mat-mdc-menu-item mat-focus-indicator share-button menu-item-button ng-star-inserted',
    iconClassName:
      'mat-icon notranslate gds-icon-l google-symbols mat-ligature-font mat-icon-no-color',
  });
  shareButtonWrapper.appendChild(shareButton);
  shareContainer.appendChild(shareButtonWrapper);
  content.appendChild(shareContainer);

  const exportToDocs = document.createElement('export-to-docs-button');
  exportToDocs.setAttribute('data-test-id', 'export-to-docs-button');
  const docsButton = createNativeMenuButton({
    testId: 'export-to-docs-button',
    label: 'Export to Docs',
    iconName: 'docs',
    buttonClassName: 'mat-mdc-menu-item mat-focus-indicator menu-item-button ng-star-inserted',
    iconClassName:
      'mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color ng-star-inserted',
  });
  exportToDocs.appendChild(docsButton);
  content.appendChild(exportToDocs);

  const copyButton = document.createElement('copy-button');
  copyButton.setAttribute('data-test-id', 'copy-button');
  const nativeCopyButton = createNativeMenuButton({
    testId: 'copy-button',
    label: 'Copy contents',
    iconName: 'content_copy',
    buttonClassName:
      'mat-mdc-menu-item mat-focus-indicator copy-button menu-item-button ng-star-inserted',
    iconClassName: 'mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color',
  });
  copyButton.appendChild(nativeCopyButton);
  content.appendChild(copyButton);

  panel.appendChild(content);
  document.body.appendChild(panel);
  return panel;
}

describe('applyDeepResearchDownloadButtonI18n', () => {
  it('identifies deep research report share/export menu panel', () => {
    const panel = document.createElement('div');
    panel.className = 'mat-mdc-menu-panel';
    panel.setAttribute('role', 'menu');

    const content = document.createElement('div');
    content.className = 'mat-mdc-menu-content';

    const shareContainer = document.createElement('div');
    shareContainer.setAttribute('data-test-id', 'share-button-tooltip-container');
    content.appendChild(shareContainer);

    const exportToDocs = document.createElement('export-to-docs-button');
    exportToDocs.setAttribute('data-test-id', 'export-to-docs-button');
    content.appendChild(exportToDocs);

    const copyButton = document.createElement('copy-button');
    copyButton.setAttribute('data-test-id', 'copy-button');
    content.appendChild(copyButton);

    panel.appendChild(content);

    expect(isDeepResearchReportMenuPanel(panel)).toBe(true);
  });

  it.each([
    ['share-drive-button', 'export-to-docs-button'],
    ['share-classroom-button', 'copy-button'],
  ])('identifies report menu with %s and %s', (shareTestId, exportTestId) => {
    const panel = document.createElement('div');
    panel.className = 'mat-mdc-menu-panel';
    panel.setAttribute('role', 'menu');

    const content = document.createElement('div');
    content.className = 'mat-mdc-menu-content';

    for (const testId of [shareTestId, exportTestId]) {
      const action = document.createElement('button');
      action.setAttribute('data-test-id', testId);
      content.appendChild(action);
    }

    panel.appendChild(content);

    expect(isDeepResearchReportMenuPanel(panel)).toBe(true);
  });

  it('rejects report share actions without an export action', () => {
    const panel = document.createElement('div');
    panel.className = 'mat-mdc-menu-panel';
    panel.setAttribute('role', 'menu');

    const content = document.createElement('div');
    content.className = 'mat-mdc-menu-content';

    const shareAction = document.createElement('button');
    shareAction.setAttribute('data-test-id', 'share-drive-button');
    content.appendChild(shareAction);
    panel.appendChild(content);

    expect(isDeepResearchReportMenuPanel(panel)).toBe(false);
  });

  it('rejects generic export menu without deep research share actions', () => {
    const panel = document.createElement('div');
    panel.className = 'mat-mdc-menu-panel';
    panel.setAttribute('role', 'menu');

    const content = document.createElement('div');
    content.className = 'mat-mdc-menu-content';

    for (const testId of ['export-to-docs-button', 'copy-button']) {
      const action = document.createElement('button');
      action.setAttribute('data-test-id', testId);
      content.appendChild(action);
    }

    panel.appendChild(content);

    expect(isDeepResearchReportMenuPanel(panel)).toBe(false);
  });

  it('rejects sidebar conversation menu panel for deep research injection', () => {
    const panel = document.createElement('div');
    panel.className = 'mat-mdc-menu-panel';
    panel.setAttribute('role', 'menu');

    const content = document.createElement('div');
    content.className = 'mat-mdc-menu-content';

    const pin = document.createElement('button');
    pin.setAttribute('data-test-id', 'pin-button');
    content.appendChild(pin);

    const rename = document.createElement('button');
    rename.setAttribute('data-test-id', 'rename-button');
    content.appendChild(rename);

    panel.appendChild(content);

    expect(isDeepResearchReportMenuPanel(panel)).toBe(false);
  });

  it('updates label and tooltip according to language', () => {
    const button = document.createElement('button');
    const span = document.createElement('span');
    span.className = 'mat-mdc-menu-item-text';
    span.textContent = ' placeholder';
    button.appendChild(span);

    const dict: Record<AppLanguage, Record<string, string>> = {
      en: { deepResearchDownload: 'Download', deepResearchDownloadTooltip: 'Download (MD)' },
      zh: { deepResearchDownload: '下载', deepResearchDownloadTooltip: '下载（MD）' },
      zh_TW: { deepResearchDownload: '下載', deepResearchDownloadTooltip: '下載（MD）' },
      ja: {
        deepResearchDownload: 'ダウンロード',
        deepResearchDownloadTooltip: 'ダウンロード（MD）',
      },
      fr: { deepResearchDownload: 'Télécharger', deepResearchDownloadTooltip: 'Télécharger (MD)' },
      es: { deepResearchDownload: 'Descargar', deepResearchDownloadTooltip: 'Descargar (MD)' },
      pt: { deepResearchDownload: 'Baixar', deepResearchDownloadTooltip: 'Baixar (MD)' },
      ar: { deepResearchDownload: 'تحميل', deepResearchDownloadTooltip: 'تحميل (MD)' },
      ru: { deepResearchDownload: 'Скачать', deepResearchDownloadTooltip: 'Скачать (MD)' },
      ko: { deepResearchDownload: '다운로드', deepResearchDownloadTooltip: '다운로드 (MD)' },
    };

    applyDeepResearchDownloadButtonI18n(button, dict, 'ja');

    expect(button.title).toBe('ダウンロード（MD）');
    expect(button.getAttribute('aria-label')).toBe('ダウンロード（MD）');
    expect(span.textContent).toBe('ダウンロード');
  });

  it('updates save report label and tooltip according to language', () => {
    const button = document.createElement('button');
    const span = document.createElement('span');
    span.className = 'mat-mdc-menu-item-text';
    span.textContent = ' placeholder';
    button.appendChild(span);

    const dict: Record<AppLanguage, Record<string, string>> = {
      en: { deepResearchSaveReport: 'Save report', deepResearchSaveReportTooltip: 'Save report' },
      zh: { deepResearchSaveReport: '保存报告', deepResearchSaveReportTooltip: '保存报告' },
      zh_TW: { deepResearchSaveReport: '儲存報告', deepResearchSaveReportTooltip: '儲存報告' },
      ja: {
        deepResearchSaveReport: 'レポートを保存',
        deepResearchSaveReportTooltip: 'レポートを保存',
      },
      fr: {
        deepResearchSaveReport: 'Enregistrer le rapport',
        deepResearchSaveReportTooltip: 'Enregistrer le rapport',
      },
      es: {
        deepResearchSaveReport: 'Guardar informe',
        deepResearchSaveReportTooltip: 'Guardar informe',
      },
      pt: {
        deepResearchSaveReport: 'Salvar relatório',
        deepResearchSaveReportTooltip: 'Salvar relatório',
      },
      ar: { deepResearchSaveReport: 'حفظ التقرير', deepResearchSaveReportTooltip: 'حفظ التقرير' },
      ru: {
        deepResearchSaveReport: 'Сохранить отчет',
        deepResearchSaveReportTooltip: 'Сохранить отчет',
      },
      ko: {
        deepResearchSaveReport: '보고서 저장',
        deepResearchSaveReportTooltip: '보고서 저장',
      },
    };

    applyDeepResearchSaveReportButtonI18n(button, dict, 'zh');

    expect(button.title).toBe('保存报告');
    expect(button.getAttribute('aria-label')).toBe('保存报告');
    expect(span.textContent).toBe('保存报告');
  });

  it('injects deep research export buttons using native menu item style baseline', async () => {
    const w = window as unknown as {
      chrome?: {
        storage?: {
          sync?: {
            get: (key: string, cb: (result: Record<string, unknown>) => void) => void;
          };
          onChanged?: {
            addListener: (fn: (...args: unknown[]) => void) => void;
            removeListener: (fn: (...args: unknown[]) => void) => void;
          };
        };
      };
    };
    w.chrome = {
      storage: {
        sync: {
          get: (_key, cb) => cb({}),
        },
        onChanged: {
          addListener: () => {},
          removeListener: () => {},
        },
      },
    };

    const panel = createDeepResearchReportMenuPanel();
    const templateButton = panel.querySelector(
      'export-to-docs-button button.mat-mdc-menu-item',
    ) as HTMLElement;
    const templateIcon = templateButton.querySelector('mat-icon') as HTMLElement;
    const templateText = templateButton.querySelector('.mat-mdc-menu-item-text') as HTMLElement;

    await injectDownloadButton(panel);

    const download = panel.querySelector('.gv-deep-research-download') as HTMLElement | null;
    const saveReport = panel.querySelector('.gv-deep-research-save-report') as HTMLElement | null;
    expect(download).toBeTruthy();
    expect(saveReport).toBeTruthy();

    const downloadIcon = download?.querySelector('mat-icon') as HTMLElement | null;
    const saveReportIcon = saveReport?.querySelector('mat-icon') as HTMLElement | null;
    const downloadText = download?.querySelector('.mat-mdc-menu-item-text') as HTMLElement | null;
    const saveReportText = saveReport?.querySelector(
      '.mat-mdc-menu-item-text',
    ) as HTMLElement | null;

    expect(downloadIcon?.className).toBe(templateIcon.className);
    expect(saveReportIcon?.className).toBe(templateIcon.className);
    expect(downloadText?.className).toBe(templateText?.className);
    expect(saveReportText?.className).toBe(templateText?.className);
    expect(saveReport?.textContent?.toLowerCase()).not.toContain('description');
  });

  it('injects both export actions into a report menu with direct share actions', async () => {
    const w = window as unknown as {
      chrome?: {
        storage?: {
          sync?: {
            get: (key: string, cb: (result: Record<string, unknown>) => void) => void;
          };
        };
      };
    };
    w.chrome = {
      storage: {
        sync: {
          get: (_key, cb) => cb({}),
        },
      },
    };

    const panel = createDeepResearchReportMenuPanel('share-drive-button');

    await injectDownloadButton(panel);

    expect(panel.querySelector('.gv-deep-research-download')).toBeTruthy();
    expect(panel.querySelector('.gv-deep-research-save-report')).toBeTruthy();
  });

  it('renders and removes deep research export progress overlay', () => {
    const dict: Record<AppLanguage, Record<string, string>> = {
      en: { pm_export: 'Export', loading: 'Loading' },
      zh: { pm_export: '导出', loading: '加载中' },
      zh_TW: { pm_export: '匯出', loading: '載入中' },
      ja: { pm_export: 'エクスポート', loading: '読み込み中' },
      fr: { pm_export: 'Exporter', loading: 'Chargement' },
      es: { pm_export: 'Exportar', loading: 'Cargando' },
      pt: { pm_export: 'Exportar', loading: 'Carregando' },
      ar: { pm_export: 'تصدير', loading: 'جارٍ التحميل' },
      ru: { pm_export: 'Экспорт', loading: 'Загрузка' },
      ko: { pm_export: '내보내기', loading: '로딩 중' },
    };

    const t = (key: TranslationKey): string => {
      if (key === 'pm_export' || key === 'loading') {
        return dict.en[key];
      }
      return '';
    };
    const hide = showDeepResearchExportProgressOverlay(t);

    const overlay = document.querySelector('.gv-export-progress-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay?.textContent).toContain('Export...');
    expect(overlay?.textContent).toContain('Loading');

    hide();

    expect(document.querySelector('.gv-export-progress-overlay')).toBeNull();
  });

  it('wires Safari PDF report export success to runtime toast guidance', () => {
    const code = readFileSync(
      resolve(process.cwd(), 'src/pages/content/deepResearch/menuButton.ts'),
      'utf8',
    );

    expect(code).toContain("format === 'pdf'");
    expect(code).toContain('isSafari()');
    expect(code).toContain('showExportToast(');
    expect(code).toContain("t('export_toast_safari_pdf_ready')");
  });
});
