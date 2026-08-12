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
  /** Test/embedding override; production defaults to Gemini host detection. */
  observeGeminiArrows?: boolean;
}

/**
 * Service class for handling formula copy functionality
 * Implements Singleton pattern for single instance management
 */
export class FormulaCopyService {
  private static instance: FormulaCopyService | null = null;
  private static readonly MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
  private static readonly ACTIVE_ROOT_CLASS = 'gv-formula-copy-enabled';
  private static readonly IGNORED_INTERACTION_CLASS = 'gv-formula-copy-ignored';
  // Issue #902 only demonstrates Gemini turning an ordinary right arrow into
  // an inline data-math formula. Keep this intentionally narrow so explicit
  // KaTeX/MathML arrows on other sites and display equations remain copyable.
  private static readonly PRESENTATIONAL_INLINE_ARROW_SOURCES = new Set(['\\rightarrow', '→']);
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
        this.formatPreferenceChangeVersion += 1;
        this.currentFormat = newFormat;
        this.logger.debug('Formula format changed', { format: newFormat });
      }
    }
  };

  private isInitialized = false;
  private isFormatChangeListenerAttached = false;
  private formatPreferenceLoadGeneration = 0;
  private formatPreferenceChangeVersion = 0;
  private lifecycleGeneration = 0;
  private copyToast: HTMLDivElement | null = null;
  private copyToastHideTimer: ReturnType<typeof setTimeout> | null = null;
  private arrowExclusionObserver: MutationObserver | null = null;
  private activeRootObserver: MutationObserver | null = null;

  private constructor(config: FormulaCopyConfig = {}) {
    this.logger = logger.createChild('FormulaCopy');
    this.config = {
      toastDuration: config.toastDuration ?? 2000,
      toastOffsetY: config.toastOffsetY ?? 40,
      maxTraversalDepth: config.maxTraversalDepth ?? 10,
      observeGeminiArrows:
        config.observeGeminiArrows ??
        (window.location.hostname === 'gemini.google.com' ||
          window.location.hostname === 'business.gemini.google'),
    };
    this.currentFormat = config.format ?? 'latex';
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
  private async loadFormatPreference(
    loadGeneration: number,
    changeVersionAtStart: number,
  ): Promise<void> {
    try {
      const result = await browser.storage.sync.get(StorageKeys.FORMULA_COPY_FORMAT);
      if (
        loadGeneration !== this.formatPreferenceLoadGeneration ||
        changeVersionAtStart !== this.formatPreferenceChangeVersion
      )
        return;

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
      if (loadGeneration === this.formatPreferenceLoadGeneration) {
        this.logger.warn('Failed to load format preference, using default', { error });
      }
    }
  }

  private startFormatPreferenceSync(): Promise<void> {
    const loadGeneration = ++this.formatPreferenceLoadGeneration;
    if (!this.isFormatChangeListenerAttached) {
      try {
        browser.storage.onChanged.addListener(this.handleStorageChange);
        this.isFormatChangeListenerAttached = true;
      } catch (error) {
        this.logger.warn('Failed to listen for formula format changes', { error });
      }
    }

    return this.loadFormatPreference(loadGeneration, this.formatPreferenceChangeVersion);
  }

  private stopFormatPreferenceSync(): void {
    this.formatPreferenceLoadGeneration += 1;
    if (!this.isFormatChangeListenerAttached) return;

    try {
      browser.storage.onChanged.removeListener(this.handleStorageChange);
    } catch (error) {
      this.logger.warn('Failed to remove storage change listener', { error });
    } finally {
      this.isFormatChangeListenerAttached = false;
    }
  }

  /**
   * Resolve the current format before click handling becomes active. The
   * storage listener stays attached while the interaction feature is toggled
   * off, so an off -> on transition cannot briefly copy with a stale format.
   */
  public prepare(): Promise<void> {
    return this.startFormatPreferenceSync();
  }

  /**
   * Initialize the formula copy feature
   */
  public initialize(): void {
    if (this.isInitialized) {
      this.logger.warn('Service already initialized');
      return;
    }

    // Production entry points await prepare(); keep direct callers and older
    // integrations compatible while still subscribing synchronously here.
    if (!this.isFormatChangeListenerAttached) void this.prepare();

    this.startArrowExclusionObserver();
    document.addEventListener('click', this.handleClick, true);
    document.addEventListener('mouseover', this.handleMouseOver, true);
    this.isInitialized = true;
    this.lifecycleGeneration += 1;
    document.documentElement.classList.add(FormulaCopyService.ACTIVE_ROOT_CLASS);
    this.startActiveRootObserver();
    this.logger.info('Formula copy service initialized');
  }

  /**
   * Clean up the service (for extension unloading)
   */
  public destroy(): void {
    if (!this.isInitialized) {
      document.documentElement.classList.remove(FormulaCopyService.ACTIVE_ROOT_CLASS);
      return;
    }

    this.stopActiveRootObserver();
    document.documentElement.classList.remove(FormulaCopyService.ACTIVE_ROOT_CLASS);
    document.removeEventListener('click', this.handleClick, true);
    document.removeEventListener('mouseover', this.handleMouseOver, true);
    this.stopArrowExclusionObserver();
    for (const element of document.querySelectorAll(
      `.${FormulaCopyService.IGNORED_INTERACTION_CLASS}`,
    )) {
      element.classList.remove(FormulaCopyService.IGNORED_INTERACTION_CLASS);
    }
    this.removeCopyToast();
    this.isInitialized = false;
    this.lifecycleGeneration += 1;
    this.logger.info('Formula copy service destroyed');
  }

  /** Fully release long-lived preference synchronization on page teardown. */
  public dispose(): void {
    this.destroy();
    this.stopFormatPreferenceSync();
  }

  /**
   * Handle click events using event delegation
   */
  private handleClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const mathElement = this.findMathElement(target);

    if (!mathElement) {
      return;
    }

    // Try to extract LaTeX: first from data-math (Gemini), then from annotation (AI Studio)
    const latexSource = this.extractLatexSource(mathElement);
    if (!latexSource) {
      this.logger.warn('Math element found but no LaTeX source available');
      return;
    }

    const isPresentationalArrow = this.isPresentationalInlineArrow(mathElement, latexSource);
    this.setInteractionIgnored(mathElement, isPresentationalArrow);
    if (isPresentationalArrow) {
      this.logger.debug('Ignoring presentational inline arrow rendered as Gemini math', {
        latexSource,
      });
      return;
    }

    // Wrap formula with delimiters based on display type
    const isDisplayMode = this.isDisplayMode(mathElement);
    const { text, html } = this.wrapFormula(latexSource, isDisplayMode);

    void this.copyFormula(text, html, event.clientX, event.clientY, this.lifecycleGeneration);
    event.stopPropagation();
  };

  /**
   * Mouseover fallback for host DOM that is assembled in an unusual order after
   * the initial scan/observer pass.
   */
  private handleMouseOver = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const mathElement = this.findMathElement(target);
    if (!mathElement) return;
    const latexSource = this.extractLatexSource(mathElement);
    if (!latexSource) return;

    this.setInteractionIgnored(
      mathElement,
      this.isPresentationalInlineArrow(mathElement, latexSource),
    );
  };

  /**
   * Mark existing and newly-rendered Gemini arrows before the active CSS can
   * give them formula padding/cursor affordances. Mouseover remains a fallback
   * for host DOM that mutates in an unusual order.
   */
  private startArrowExclusionObserver(): void {
    if (!this.config.observeGeminiArrows) return;
    this.refreshArrowExclusions(document);
    if (this.arrowExclusionObserver || !document.documentElement) return;

    this.arrowExclusionObserver = new MutationObserver((records) => {
      const refreshRoots = new Set<ParentNode>();

      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target instanceof HTMLElement) {
            refreshRoots.add(record.target.closest<HTMLElement>('.math-inline') ?? record.target);
          }
          continue;
        }

        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement || node instanceof DocumentFragment) {
            if (this.containsMathSource(node)) {
              refreshRoots.add(
                node instanceof HTMLElement
                  ? (node.closest<HTMLElement>('.math-inline') ?? node)
                  : node,
              );
            }
          }
        }

        const inlineContainer =
          record.target instanceof HTMLElement
            ? record.target.closest<HTMLElement>('.math-inline')
            : null;
        if (inlineContainer) {
          const removedRelevantMath = Array.from(record.removedNodes).some(
            (node) =>
              this.containsMathSource(node) ||
              (node instanceof HTMLElement &&
                (node.classList.contains(FormulaCopyService.IGNORED_INTERACTION_CLASS) ||
                  node.querySelector(`.${FormulaCopyService.IGNORED_INTERACTION_CLASS}`) !== null)),
          );
          if (removedRelevantMath) refreshRoots.add(inlineContainer);
        }
      }

      for (const root of refreshRoots) this.refreshArrowExclusions(root);
    });
    this.arrowExclusionObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-math'],
      childList: true,
      subtree: true,
    });
  }

  private containsMathSource(node: Node): boolean {
    if (!(node instanceof HTMLElement || node instanceof DocumentFragment)) return false;
    return (
      (node instanceof HTMLElement && node.matches('[data-math]')) ||
      node.querySelector('[data-math]') !== null
    );
  }

  private stopArrowExclusionObserver(): void {
    this.arrowExclusionObserver?.disconnect();
    this.arrowExclusionObserver = null;
  }

  private startActiveRootObserver(): void {
    if (this.activeRootObserver) return;
    this.activeRootObserver = new MutationObserver(() => {
      if (
        this.isInitialized &&
        !document.documentElement.classList.contains(FormulaCopyService.ACTIVE_ROOT_CLASS)
      ) {
        document.documentElement.classList.add(FormulaCopyService.ACTIVE_ROOT_CLASS);
      }
    });
    this.activeRootObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  private stopActiveRootObserver(): void {
    this.activeRootObserver?.disconnect();
    this.activeRootObserver = null;
  }

  private refreshArrowExclusions(root: ParentNode): void {
    const inlineContainer =
      root instanceof HTMLElement ? root.closest<HTMLElement>('.math-inline') : null;
    const scanRoot: ParentNode = inlineContainer ?? root;

    if (
      scanRoot instanceof HTMLElement &&
      scanRoot.classList.contains(FormulaCopyService.IGNORED_INTERACTION_CLASS)
    ) {
      scanRoot.classList.remove(FormulaCopyService.IGNORED_INTERACTION_CLASS);
    }
    for (const ignored of scanRoot.querySelectorAll<HTMLElement>(
      `.${FormulaCopyService.IGNORED_INTERACTION_CLASS}`,
    )) {
      ignored.classList.remove(FormulaCopyService.IGNORED_INTERACTION_CLASS);
    }

    const candidates: HTMLElement[] = [];
    if (scanRoot instanceof HTMLElement && scanRoot.matches('[data-math]')) {
      candidates.push(scanRoot);
    }
    candidates.push(...scanRoot.querySelectorAll<HTMLElement>('[data-math]'));

    for (const candidate of candidates) {
      const latexSource = candidate.getAttribute('data-math');
      if (!latexSource) continue;
      this.setInteractionIgnored(
        candidate,
        this.isPresentationalInlineArrow(candidate, latexSource),
      );
    }
  }

  private setInteractionIgnored(mathElement: HTMLElement, ignored: boolean): void {
    const exactElements = new Set<HTMLElement>([mathElement]);
    const presentationContainer = mathElement.closest(
      '.math-inline, .math-display, .math-block, ms-katex, .katex, .katex-display',
    );

    for (const katexElement of mathElement.querySelectorAll<HTMLElement>('.katex')) {
      exactElements.add(katexElement);
    }

    for (const element of exactElements) {
      element.classList.toggle(FormulaCopyService.IGNORED_INTERACTION_CLASS, ignored);
    }

    if (presentationContainer instanceof HTMLElement) {
      const sources = presentationContainer.matches('[data-math]')
        ? [presentationContainer]
        : [...presentationContainer.querySelectorAll<HTMLElement>('[data-math]')];
      const containerIsOnlyPresentationalArrows =
        sources.length > 0 &&
        sources.every((source) => {
          const formula = source.getAttribute('data-math');
          return formula !== null && this.isPresentationalInlineArrow(source, formula);
        });
      presentationContainer.classList.toggle(
        FormulaCopyService.IGNORED_INTERACTION_CLASS,
        containerIsOnlyPresentationalArrows,
      );
    }
  }

  /**
   * Extract LaTeX source from a math element
   * Supports both Gemini (data-math attribute) and AI Studio (annotation element)
   */
  private extractLatexSource(element: HTMLElement): string | null {
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
    lifecycleGeneration: number,
  ): Promise<void> {
    try {
      const success = await this.copyToClipboard(text, html);
      if (!this.isInitialized || lifecycleGeneration !== this.lifecycleGeneration) return;

      if (success) {
        this.showToast(this.toastMessage('formula_copied'), x, y, true);
        this.logger.debug('Formula copied successfully', { length: text.length, hasHtml: !!html });
      } else {
        this.showToast(this.toastMessage('formula_copy_failed'), x, y, false);
        this.logger.error('Failed to copy formula');
      }
    } catch (error) {
      if (!this.isInitialized || lifecycleGeneration !== this.lifecycleGeneration) return;
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
  private findMathElement(target: Element): HTMLElement | null {
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
    // 1. Gemini: check for a block/display container
    if (element.closest('.math-block, .math-display') !== null) {
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

  private isPresentationalInlineArrow(element: HTMLElement, formula: string): boolean {
    if (
      !this.config.observeGeminiArrows ||
      !element.hasAttribute('data-math') ||
      element.closest('.math-inline') === null ||
      this.isDisplayMode(element)
    )
      return false;
    // Explicit delimiters are evidence that this is an intentional formula,
    // even when its entire mathematical content is an arrow.
    const normalized = formula.trim();
    return FormulaCopyService.PRESENTATIONAL_INLINE_ARROW_SOURCES.has(normalized);
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

    if (this.copyToastHideTimer !== null) clearTimeout(this.copyToastHideTimer);
    const toast = this.copyToast;
    this.copyToastHideTimer = setTimeout(() => {
      if (this.copyToast === toast) toast.classList.remove('gv-copy-toast-show');
      this.copyToastHideTimer = null;
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
    if (this.copyToastHideTimer !== null) {
      clearTimeout(this.copyToastHideTimer);
      this.copyToastHideTimer = null;
    }
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
