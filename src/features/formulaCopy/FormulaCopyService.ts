/**
 * Formula Copy Service
 * Handles copying LaTeX/MathJax formulas from Gemini chat conversations
 * Uses enterprise patterns: Singleton, Service Layer, Event Delegation
 */
import temml from 'temml';
import browser from 'webextension-polyfill';

import { logger } from '@/core';
import { StorageKeys } from '@/core/types/common';
import type { ILogger } from '@/core/types/common';
import { getTranslationSyncUnsafe } from '@/utils/i18n';

/**
 * Formula copy format options
 */
export type FormulaCopyFormat = 'latex' | 'unicodemath' | 'no-dollar' | 'notion';

/**
 * Configuration for the formula copy service
 */
export interface FormulaCopyConfig {
  toastDuration?: number;
  toastOffsetY?: number;
  maxTraversalDepth?: number;
  format?: FormulaCopyFormat;
}

/**
 * Service class for handling formula copy functionality
 * Implements Singleton pattern for single instance management
 */
export class FormulaCopyService {
  private static instance: FormulaCopyService | null = null;
  private static readonly MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
  private readonly logger: ILogger;
  private readonly config: Required<Omit<FormulaCopyConfig, 'format'>>;
  private currentFormat: FormulaCopyFormat = 'latex';

  // Storage change listener, extracted so it can be removed on destroy
  private readonly handleStorageChange: Parameters<
    typeof browser.storage.onChanged.addListener
  >[0] = (changes, areaName) => {
    if (areaName === 'sync' && changes[StorageKeys.FORMULA_COPY_FORMAT]) {
      const newFormat = changes[StorageKeys.FORMULA_COPY_FORMAT].newValue as FormulaCopyFormat;
      if (
        newFormat === 'latex' ||
        newFormat === 'unicodemath' ||
        newFormat === 'no-dollar' ||
        newFormat === 'notion'
      ) {
        this.currentFormat = newFormat;
        this.logger.debug('Formula format changed', { format: newFormat });
      }
    }
  };

  private isInitialized = false;
  private copyToast: HTMLDivElement | null = null;

  private constructor(config: FormulaCopyConfig = {}) {
    this.logger = logger.createChild('FormulaCopy');
    this.config = {
      toastDuration: config.toastDuration ?? 2000,
      toastOffsetY: config.toastOffsetY ?? 40,
      maxTraversalDepth: config.maxTraversalDepth ?? 10,
    };
    this.currentFormat = config.format ?? 'latex';
    this.loadFormatPreference();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(config?: FormulaCopyConfig): FormulaCopyService {
    if (!FormulaCopyService.instance) {
      FormulaCopyService.instance = new FormulaCopyService(config);
    }
    return FormulaCopyService.instance;
  }

  /**
   * Resolve a toast message in the user's selected in-extension language.
   *
   * Uses the custom translation layer (getTranslationSyncUnsafe), NOT
   * browser.i18n.getMessage — the latter follows the BROWSER UI locale, so an
   * English-browser user who picked Chinese in the popup would see an English
   * toast while the rest of Voyager's UI is Chinese. Resolving here (at toast
   * time) also guarantees initI18n() has populated the cached language by the
   * time the user actually clicks a formula.
   */
  private toastMessage(key: 'formula_copied' | 'formula_copy_failed'): string {
    return getTranslationSyncUnsafe(key);
  }

  /**
   * Load format preference from storage
   */
  private async loadFormatPreference(): Promise<void> {
    try {
      const result = await browser.storage.sync.get(StorageKeys.FORMULA_COPY_FORMAT);
      const format = result[StorageKeys.FORMULA_COPY_FORMAT] as FormulaCopyFormat | undefined;
      if (
        format === 'latex' ||
        format === 'unicodemath' ||
        format === 'no-dollar' ||
        format === 'notion'
      ) {
        this.currentFormat = format;
        this.logger.debug('Loaded formula format preference', { format });
      }
    } catch (error) {
      this.logger.warn('Failed to load format preference, using default', { error });
    }

    // Listen for format changes
    browser.storage.onChanged.addListener(this.handleStorageChange);
  }

  /**
   * Initialize the formula copy feature
   */
  public initialize(): void {
    if (this.isInitialized) {
      this.logger.warn('Service already initialized');
      return;
    }

    document.addEventListener('click', this.handleClick, true);
    this.isInitialized = true;
    this.logger.info('Formula copy service initialized');
  }

  /**
   * Clean up the service (for extension unloading)
   */
  public destroy(): void {
    // Always detach storage change listener
    try {
      browser.storage.onChanged.removeListener(this.handleStorageChange);
    } catch (error) {
      this.logger.warn('Failed to remove storage change listener', { error });
    }

    if (!this.isInitialized) {
      this.logger.warn('Service not initialized, cannot destroy');
      return;
    }

    document.removeEventListener('click', this.handleClick, true);
    this.removeCopyToast();
    this.isInitialized = false;
    this.logger.info('Formula copy service destroyed');
  }

  /**
   * Handle click events using event delegation
   */
  private handleClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    const mathElement = this.findMathElement(target);

    if (!mathElement) {
      return;
    }

    // Try to extract LaTeX: first from data-math (Gemini), then from annotation (AI Studio)
    const latexSource = FormulaCopyService.extractLatexSource(mathElement);
    if (!latexSource) {
      this.logger.warn('Math element found but no LaTeX source available');
      return;
    }

    // Wrap formula with delimiters based on display type
    const isDisplayMode = this.isDisplayMode(mathElement);
    const { text, html } = this.wrapFormula(latexSource, isDisplayMode);

    this.copyFormula(text, html, event.clientX, event.clientY);
    event.stopPropagation();
  };

  /**
   * Extract LaTeX source from a math element
   * Supports both Gemini (data-math attribute) and AI Studio (annotation element)
   */
  public static extractLatexSource(element: HTMLElement): string | null {
    // 1. Try Gemini's data-math attribute
    const dataMath = element.getAttribute('data-math');
    if (dataMath) {
      return dataMath;
    }

    // 2. ChatGPT's client-side KaTeX layout omits the MathML annotation and
    // keeps the original TeX on the semantic wrapper around .katex-display.
    const dataMathSource = element.closest('[data-math-source]')?.getAttribute('data-math-source');
    if (dataMathSource?.trim()) {
      return dataMathSource.trim();
    }

    // 3. Try AI Studio's annotation element with encoding="application/x-tex"
    const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
    if (annotation?.textContent) {
      return annotation.textContent.trim();
    }

    // 4. Fallback: try any annotation element
    const anyAnnotation = element.querySelector('annotation');
    if (anyAnnotation?.textContent) {
      return anyAnnotation.textContent.trim();
    }

    return null;
  }

  /**
   * Copy formula to clipboard and show notification
   */
  private async copyFormula(
    text: string,
    html: string | undefined,
    x: number,
    y: number,
  ): Promise<void> {
    try {
      const success = await this.copyToClipboard(text, html);

      if (success) {
        this.showToast(this.toastMessage('formula_copied'), x, y, true);
        this.logger.debug('Formula copied successfully', { length: text.length, hasHtml: !!html });
      } else {
        this.showToast(this.toastMessage('formula_copy_failed'), x, y, false);
        this.logger.error('Failed to copy formula');
      }
    } catch (error) {
      this.showToast(this.toastMessage('formula_copy_failed'), x, y, false);
      this.logger.error('Error copying formula', { error });
    }
  }

  /**
   * Copy text to clipboard using modern API with fallback
   */
  private async copyToClipboard(text: string, html?: string): Promise<boolean> {
    // Try modern Clipboard API first (supports MIME types)
    if (navigator.clipboard?.write) {
      const items: Record<string, Blob> = {
        'text/plain': new Blob([text], { type: 'text/plain' }),
      };

      if (html) {
        items['text/html'] = new Blob([html], { type: 'text/html' });
        if (html.includes(`xmlns:mml="${FormulaCopyService.MATHML_NS}"`)) {
          items['application/mathml+xml'] = new Blob([text], { type: 'application/mathml+xml' });
        }
      }

      try {
        await navigator.clipboard.write([new ClipboardItem(items)]);
        return true;
      } catch (error) {
        if (this.isMathMLClipboardUnsupported(error)) {
          return this.copyToClipboardLegacy(text);
        }

        this.logger.error('Clipboard API failed, trying fallback', { error });
        return this.copyToClipboardLegacy(text);
      }
    }

    // Fallback: If only writeText is available (no MIME support)
    if (navigator.clipboard?.writeText && !html) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        this.logger.error('Clipboard API failed, trying fallback', { error });
        return this.copyToClipboardLegacy(text);
      }
    }

    // Fallback to execCommand for older browsers (text only)
    return this.copyToClipboardLegacy(text);
  }

  /**
   * Legacy clipboard copy method using execCommand
   */
  private copyToClipboardLegacy(text: string): boolean {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';

      document.body.appendChild(textarea);
      textarea.select();

      const success = document.execCommand('copy');
      document.body.removeChild(textarea);

      return success;
    } catch (error) {
      this.logger.error('Legacy clipboard copy failed', { error });
      return false;
    }
  }

  private isMathMLClipboardUnsupported(error: unknown): boolean {
    const name = this.getErrorName(error);
    const nameMatches = name === 'notallowederror' || name === 'notsupportederror';
    if (!nameMatches) {
      return false;
    }

    const message = this.getErrorMessage(error);
    if (!message) {
      return true;
    }

    const lowerMessage = message.toLowerCase();
    return lowerMessage.includes('mathml') || lowerMessage.includes('application/mathml+xml');
  }

  private getErrorMessage(error: unknown): string | null {
    if (error instanceof Error) {
      return error.message;
    }

    return typeof error === 'string' ? error : null;
  }

  private getErrorName(error: unknown): string | null {
    if (error instanceof DOMException) {
      return error.name.toLowerCase();
    }

    if (error instanceof Error) {
      return error.name.toLowerCase();
    }

    return null;
  }

  /**
   * Find the nearest math element in the DOM tree
   * Supports both Gemini (data-math attribute) and AI Studio (ms-katex container)
   */
  private findMathElement(target: HTMLElement): HTMLElement | null {
    // 1. Try Gemini's data-math attribute (direct)
    const direct = target.closest('[data-math]');
    if (direct instanceof HTMLElement) {
      return direct;
    }

    // 2. Try Gemini's .math-inline, .math-block containers
    const geminiContainer = target.closest('.math-inline, .math-block');
    if (geminiContainer instanceof HTMLElement) {
      return this.findDataMathInSubtree(geminiContainer);
    }

    // 3. Try AI Studio's ms-katex container
    const aiStudioContainer = target.closest('ms-katex');
    if (aiStudioContainer instanceof HTMLElement) {
      return aiStudioContainer;
    }

    // 4. Generic KaTeX (AI Studio, ChatGPT, Claude) — clicked inside .katex
    const katexElement = target.closest('.katex');
    if (katexElement instanceof HTMLElement) {
      // AI Studio wraps .katex in an <ms-katex> container; prefer it when present.
      const parentMsKatex = katexElement.closest('ms-katex');
      if (parentMsKatex instanceof HTMLElement) {
        return parentMsKatex;
      }
      // ChatGPT / Claude: a block formula is wrapped in .katex-display. Return the
      // wrapper so isDisplayMode() can detect it; inline math returns the .katex.
      const displayWrapper = katexElement.closest('.katex-display');
      return displayWrapper instanceof HTMLElement ? displayWrapper : katexElement;
    }

    // 5. ChatGPT / Claude: clicked on the .katex-display padding around a block
    //    formula (outside the inner .katex).
    const displayContainer = target.closest('.katex-display');
    if (displayContainer instanceof HTMLElement) {
      return displayContainer;
    }

    return null;
  }

  /**
   * Check if element is a math container
   */
  private isMathContainer(element: HTMLElement): boolean {
    return element.classList.contains('math-inline') || element.classList.contains('math-block');
  }

  /**
   * Check if formula is in display mode (block formula)
   * Supports both Gemini (.math-block class) and AI Studio (math display="block" attribute)
   */
  private isDisplayMode(element: HTMLElement): boolean {
    // 1. Gemini: check for .math-block container
    if (element.closest('.math-block') !== null) {
      return true;
    }

    // 2. ChatGPT / Claude: block KaTeX uses a .katex-display wrapper. Current
    // ChatGPT markup no longer includes the MathML node checked below.
    if (element.closest('.katex-display') !== null) {
      return true;
    }

    // 3. AI Studio: check for math element with display="block" attribute
    const mathElement = element.querySelector('math[display="block"]');
    if (mathElement) {
      return true;
    }

    // 4. AI Studio: check if ms-katex container has block-like styling
    // (display formulas are typically block-level in AI Studio)
    if (element.tagName.toLowerCase() === 'ms-katex') {
      const style = window.getComputedStyle(element);
      if (style.display === 'block' || style.display === 'flex') {
        return true;
      }
    }

    return false;
  }

  /**
   * Wrap formula with appropriate delimiters based on format
   * @param formula - Raw LaTeX formula
   * @param isDisplayMode - Whether formula is in display mode
   * @returns Object containing text and optional html
   */
  private wrapFormula(formula: string, isDisplayMode: boolean): { text: string; html?: string } {
    if (this.currentFormat === 'unicodemath') {
      // Convert to Word-friendly MathML (replaces previous UnicodeMath)
      try {
        const strippedFormula = this.stripMathDelimiters(formula);
        const rawMathML = temml.renderToString(strippedFormula, {
          displayMode: isDisplayMode,
          xml: true,
          annotate: false,
          throwOnError: true,
          colorIsTextColor: true,
          trust: false,
        });
        const sanitizedMathML = this.stripMathMLAnnotations(rawMathML);
        const namespacedMathML = this.ensureMathMLNamespace(sanitizedMathML);
        const wordMathML = this.toWordMathML(namespacedMathML);
        const htmlWrapped = this.wrapMathMLForWordHtml(wordMathML);

        return { text: wordMathML, html: htmlWrapped };
      } catch (error) {
        this.logger.error('MathML conversion failed', { error });
        return { text: formula };
      }
    }

    if (this.currentFormat === 'no-dollar') {
      return { text: formula };
    }

    if (this.currentFormat === 'notion') {
      // Notion format: always use $$ for both inline and display formulas
      const wrapped = `$$${formula}$$`;
      return { text: wrapped };
    }

    // Default: LaTeX format with delimiters
    const wrapped = isDisplayMode ? `$$${formula}$$` : `$${formula}$`;
    return { text: wrapped };
  }

  private ensureMathMLNamespace(mathML: string): string {
    if (mathML.includes('xmlns=')) {
      return mathML;
    }

    return mathML.replace('<math', `<math xmlns="${FormulaCopyService.MATHML_NS}"`);
  }

  private toWordMathML(mathML: string): string {
    const parsed = new DOMParser().parseFromString(mathML, 'application/xml');
    if (parsed.getElementsByTagName('parsererror').length > 0) {
      return this.stripMathMLAnnotations(mathML);
    }

    const root = parsed.documentElement;
    if (root.localName !== 'math') {
      return this.stripMathMLAnnotations(mathML);
    }

    // Remove annotations (<annotation> and <annotation-xml>)
    for (const annotation of Array.from(root.getElementsByTagName('annotation'))) {
      annotation.parentNode?.removeChild(annotation);
    }
    for (const annotationXml of Array.from(root.getElementsByTagName('annotation-xml'))) {
      annotationXml.parentNode?.removeChild(annotationXml);
    }

    // Unwrap <semantics> if present at root
    const semantics = Array.from(root.getElementsByTagName('semantics')).find(
      (node) => node.parentElement === root,
    );
    if (semantics) {
      const presentation = semantics.firstElementChild;
      if (presentation) {
        while (root.firstChild) {
          root.removeChild(root.firstChild);
        }
        root.appendChild(presentation);
      }
    }

    this.stripPresentationAttributes(root);

    const output = document.implementation.createDocument(
      FormulaCopyService.MATHML_NS,
      'mml:math',
      null,
    );
    const outputRoot = output.documentElement;

    // Copy root attributes (display, etc.), excluding namespace declarations
    for (const attr of Array.from(root.attributes)) {
      if (attr.name.startsWith('xmlns')) {
        continue;
      }
      outputRoot.setAttribute(attr.name, attr.value);
    }

    for (const child of Array.from(root.childNodes)) {
      outputRoot.appendChild(this.cloneNodeWithMathMLPrefix(output, child));
    }

    return new XMLSerializer().serializeToString(outputRoot);
  }

  private cloneNodeWithMathMLPrefix(targetDocument: Document, sourceNode: Node): Node {
    if (sourceNode.nodeType === Node.TEXT_NODE) {
      return targetDocument.createTextNode(sourceNode.nodeValue ?? '');
    }

    if (sourceNode.nodeType !== Node.ELEMENT_NODE) {
      return targetDocument.importNode(sourceNode, true);
    }

    const sourceElement = sourceNode as Element;
    const namespaceUri = sourceElement.namespaceURI;
    const localName = sourceElement.localName;

    const isMathMl = namespaceUri === FormulaCopyService.MATHML_NS || namespaceUri === null;
    const qualifiedName = isMathMl ? `mml:${localName}` : sourceElement.tagName;
    const element = isMathMl
      ? targetDocument.createElementNS(FormulaCopyService.MATHML_NS, qualifiedName)
      : targetDocument.createElement(qualifiedName);

    for (const attr of Array.from(sourceElement.attributes)) {
      if (attr.name.startsWith('xmlns')) {
        continue;
      }
      element.setAttribute(attr.name, attr.value);
    }

    for (const child of Array.from(sourceElement.childNodes)) {
      element.appendChild(this.cloneNodeWithMathMLPrefix(targetDocument, child));
    }

    return element;
  }

  private wrapMathMLForWordHtml(mathML: string): string {
    // Word's HTML importer is sensitive to fragments; include Start/End markers.
    return [
      `<html xmlns:mml="${FormulaCopyService.MATHML_NS}">`,
      '<head><meta charset="utf-8"></head>',
      '<body><!--StartFragment-->',
      mathML,
      '<!--EndFragment--></body></html>',
    ].join('');
  }

  private stripMathMLAnnotations(mathML: string): string {
    return mathML
      .replace(/<annotation(?:-xml)?[\s\S]*?<\/annotation(?:-xml)?>/g, '')
      .replace(/<semantics>\s*([\s\S]*?)\s*<\/semantics>/g, '$1');
  }

  private stripPresentationAttributes(root: Element): void {
    if (root.hasAttribute('class')) {
      root.removeAttribute('class');
    }
    if (root.hasAttribute('style')) {
      root.removeAttribute('style');
    }

    for (const element of Array.from(root.getElementsByTagName('*'))) {
      if (element.hasAttribute('class')) {
        element.removeAttribute('class');
      }
      if (element.hasAttribute('style')) {
        element.removeAttribute('style');
      }
    }
  }

  private stripMathDelimiters(formula: string): string {
    const trimmed = formula.trim();

    if (trimmed.startsWith('$$') && trimmed.endsWith('$$')) {
      return trimmed.slice(2, -2);
    }

    if (trimmed.startsWith('\\[') && trimmed.endsWith('\\]')) {
      return trimmed.slice(2, -2);
    }

    if (trimmed.startsWith('\\(') && trimmed.endsWith('\\)')) {
      return trimmed.slice(2, -2);
    }

    if (trimmed.startsWith('$') && trimmed.endsWith('$')) {
      return trimmed.slice(1, -1);
    }

    return formula;
  }

  /**
   * Search for data-math attribute in element subtree
   */
  private findDataMathInSubtree(root: HTMLElement): HTMLElement | null {
    const direct = root.querySelector('[data-math]');
    return direct instanceof HTMLElement ? direct : null;
  }

  /**
   * Show toast notification
   */
  private showToast(message: string, x: number, y: number, isSuccess: boolean): void {
    if (!this.copyToast) {
      this.copyToast = this.createCopyToast();
    }

    this.copyToast.textContent = message;
    this.copyToast.style.left = `${x}px`;
    this.copyToast.style.top = `${y - this.config.toastOffsetY}px`;

    // Update toast style based on success/failure
    if (isSuccess) {
      this.copyToast.classList.remove('gv-copy-toast-error');
      this.copyToast.classList.add('gv-copy-toast-success');
    } else {
      this.copyToast.classList.remove('gv-copy-toast-success');
      this.copyToast.classList.add('gv-copy-toast-error');
    }

    this.copyToast.classList.add('gv-copy-toast-show');

    setTimeout(() => {
      this.copyToast?.classList.remove('gv-copy-toast-show');
    }, this.config.toastDuration);
  }

  /**
   * Create toast element
   */
  private createCopyToast(): HTMLDivElement {
    const toast = document.createElement('div');
    toast.className = 'gv-copy-toast';
    document.body.appendChild(toast);
    return toast;
  }

  /**
   * Remove toast element from DOM
   */
  private removeCopyToast(): void {
    if (this.copyToast?.parentElement) {
      this.copyToast.parentElement.removeChild(this.copyToast);
      this.copyToast = null;
    }
  }

  /**
   * Check if service is initialized
   */
  public isServiceInitialized(): boolean {
    return this.isInitialized;
  }
}

// Export singleton instance getter
export const getFormulaCopyService = (config?: FormulaCopyConfig) =>
  FormulaCopyService.getInstance(config);
