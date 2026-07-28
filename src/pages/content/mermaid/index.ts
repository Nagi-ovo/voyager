/**
 * Lazily loaded Mermaid instance.
 * Mermaid is dynamically imported to reduce initial content script bundle size.
 * The library (~1 MB) is only loaded when a Mermaid code block is actually detected.
 */
let mermaidInstance: Awaited<typeof import('mermaid')>['default'] | null = null;
let mermaidLoadFailed = false;

type MermaidTheme = 'dark' | 'light';

let initializedMermaidTheme: MermaidTheme | null = null;

const MERMAID_LIGHT_EXPORT_TEMPLATE_CLASS = 'gv-mermaid-light-export';
const MERMAID_LIGHT_THEME_DIRECTIVE = '%%{init: {"theme":"default"}}%%';

/**
 * Reset internal loader state. Only for testing.
 * @internal
 */
export const _resetMermaidLoader = () => {
  mermaidInstance = null;
  mermaidLoadFailed = false;
  initializedMermaidTheme = null;
};

/**
 * Dynamically load the Mermaid library.
 * Returns the mermaid default export, or null if loading fails.
 * Once loaded (or failed), the result is cached.
 */
/**
 * @internal Exported for testing
 */
export const loadMermaid = async (): Promise<typeof mermaidInstance> => {
  if (mermaidInstance) return mermaidInstance;
  if (mermaidLoadFailed) return null;

  try {
    const mod = await import('mermaid');
    mermaidInstance = mod.default;
    return mermaidInstance;
  } catch (error) {
    mermaidLoadFailed = true;
    console.error('[Gemini Voyager] Failed to load Mermaid library:', error);
    return null;
  }
};

/**
 * Resolve the Mermaid theme from Gemini's explicit page state before falling
 * back to the browser's system preference.
 * @internal Exported for testing
 */
export function resolveMermaidTheme(doc: Document, prefersDark: boolean): 'dark' | 'default' {
  const body = doc.body;
  const root = doc.documentElement;

  if (doc.querySelector('.theme-host.dark-theme')) return 'dark';
  if (doc.querySelector('.theme-host.light-theme')) return 'default';

  const hasExplicitDarkTheme = Boolean(
    body.classList.contains('dark-theme') ||
      root.classList.contains('dark') ||
      body.getAttribute('data-theme') === 'dark',
  );
  if (hasExplicitDarkTheme) return 'dark';

  const hasExplicitLightTheme = Boolean(
    body.classList.contains('light-theme') ||
      root.classList.contains('light') ||
      body.getAttribute('data-theme') === 'light',
  );
  if (hasExplicitLightTheme) return 'default';

  return prefersDark ? 'dark' : 'default';
}

const getMermaidTheme = (): MermaidTheme =>
  resolveMermaidTheme(document, window.matchMedia('(prefers-color-scheme: dark)').matches) ===
  'dark'
    ? 'dark'
    : 'light';

/**
 * Initialize Mermaid configuration
 */
const initMermaid = async (): Promise<boolean> => {
  const mermaid = await loadMermaid();
  if (!mermaid) return false;

  const theme = getMermaidTheme();

  mermaid.initialize({
    startOnLoad: false,
    theme: theme === 'dark' ? 'dark' : 'default',
    securityLevel: 'loose',
    fontFamily: 'Google Sans, Roboto, sans-serif',
    logLevel: 5, // 5 = fatal, only log fatal errors (v9.x uses numbers)
  });
  initializedMermaidTheme = theme;

  return true;
};

/** @internal Exported for theme-marker testing. */
export const _initMermaidForTest = initMermaid;

/**
 * Check if a code block contains Mermaid syntax and appears complete enough to render
 * @internal Exported for testing
 */
export const isMermaidCode = (code: string): boolean => {
  const codeTrimmed = code.trim();

  // Minimum length to avoid parsing incomplete/streaming content
  if (codeTrimmed.length < 50) return false;

  // Keywords aligned with mermaid's own detector regexes.
  // Order matters: longer/more-specific prefixes should come before shorter ones
  // so that e.g. "flowchart-elk" isn't matched by "flowchart" and missed.
  const keywords = [
    // Core diagram types (v9+)
    'graph',
    'flowchart',
    'sequenceDiagram',
    'classDiagram',
    'stateDiagram',
    'erDiagram',
    'gantt',
    'pie',
    'gitGraph',
    'journey',
    'mindmap',
    'timeline',
    'zenuml',
    'quadrantChart',
    'requirementDiagram',
    'requirement', // v11: requirement(Diagram)? — shorter form
    'sankey-beta',
    'sankey', // v11: sankey(-beta)?
    // C4 diagrams (v9+, often overlooked)
    'C4Context',
    'C4Container',
    'C4Component',
    'C4Dynamic',
    'C4Deployment',
    // New diagram types (v10+/v11+, Chrome/Safari)
    'xychart-beta',
    'xychart', // v11: xychart(-beta)?
    'block-beta',
    'block', // v11: block(-beta)?
    'packet-beta',
    'packet', // v11: packet(-beta)?
    'architecture-beta',
    'architecture', // v11: architecture(-beta)?
    'kanban',
    'radar-beta', // v11
    'treemap', // v11
  ];

  const startsWithKeyword =
    codeTrimmed.startsWith('%%') ||
    keywords.some((keyword) => codeTrimmed.toLowerCase().startsWith(keyword.toLowerCase()));

  if (!startsWithKeyword) return false;

  // Check if code looks complete (has multiple lines and doesn't end mid-statement)
  const lines = codeTrimmed.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 3) return false;

  // Check last line doesn't look incomplete (ending with operators or open brackets)
  const lastLine = lines[lines.length - 1].trim();
  const incompleteEndings = ['-->', '---', '-.', '==>', ':::', '[', '(', '{', '|', '&', ','];
  if (incompleteEndings.some((ending) => lastLine.endsWith(ending))) return false;

  return true;
};

/**
 * Create styles for mermaid components and fullscreen viewer
 */
const createStyles = () => {
  if (document.getElementById('gv-mermaid-styles')) return;

  const style = document.createElement('style');
  style.id = 'gv-mermaid-styles';
  style.textContent = `
    .gv-mermaid-wrapper {
      position: relative;
    }
    
    .gv-mermaid-toggle {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 10;
      display: flex;
      align-items: center; /* Center items vertically */
      gap: 4px;
      background: var(--gemini-surface-container, rgba(0,0,0,0.05));
      border-radius: 8px;
      padding: 2px;
      border: 1px solid var(--gemini-outline-variant, rgba(0,0,0,0.1));
    }
    
    .gv-mermaid-toggle button {
      padding: 4px 10px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-family: 'Google Sans', sans-serif;
      transition: all 0.2s ease;
      background: transparent;
      color: var(--gemini-on-surface-variant, #666);
    }
    
    .gv-mermaid-toggle button:hover {
      background: var(--gemini-surface-container-high, rgba(0,0,0,0.08));
    }
    
    .gv-mermaid-toggle button.active {
      background: var(--gemini-primary, #1a73e8);
      color: white;
    }
    
    .gv-mermaid-diagram {
      padding: 16px;
      text-align: center;
      overflow-x: auto;
      min-height: 100px;
      cursor: zoom-in;
    }
    
    .gv-mermaid-diagram svg {
      max-width: 100%;
      height: auto;
    }
    
    /* Fullscreen Modal */
    .gv-mermaid-modal {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.9);
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    
    .gv-mermaid-modal.visible {
      opacity: 1;
    }
    
    .gv-mermaid-modal-toolbar {
      position: fixed;
      top: 16px;
      right: 16px;
      display: flex;
      gap: 8px;
      z-index: 1000000;
    }
    
    .gv-mermaid-modal-toolbar button {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: none;
      background: rgba(255, 255, 255, 0.2);
      color: white;
      font-size: 18px;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .gv-mermaid-modal-toolbar button:hover {
      background: rgba(255, 255, 255, 0.3);
      transform: scale(1.1);
    }
    
    .gv-mermaid-modal-content {
      position: relative;
      cursor: grab;
      user-select: none;
    }
    
    .gv-mermaid-modal-content.dragging {
      cursor: grabbing;
    }
    
    .gv-mermaid-modal-content svg {
      max-width: none;
      max-height: none;
    }
    
    .gv-mermaid-modal-hint {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      color: rgba(255, 255, 255, 0.6);
      font-size: 14px;
      font-family: 'Google Sans', sans-serif;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
};

/**
 * Fullscreen viewer state
 */
let currentModal: HTMLElement | null = null;
let scale = 1;
let translateX = 0;
let translateY = 0;
let isDragging = false;
let startX = 0;
let startY = 0;

/**
 * Open fullscreen viewer for SVG
 */
const openFullscreen = (svgHtml: string) => {
  if (currentModal) return;

  // Reset state
  scale = 1;
  translateX = 0;
  translateY = 0;

  // Create modal
  const modal = document.createElement('div');
  modal.className = 'gv-mermaid-modal';

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'gv-mermaid-modal-toolbar';

  const zoomInBtn = document.createElement('button');
  zoomInBtn.innerHTML = '+';
  zoomInBtn.title = 'Zoom In';

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.innerHTML = '−';
  zoomOutBtn.title = 'Zoom Out';

  const resetBtn = document.createElement('button');
  resetBtn.innerHTML = '⊙';
  resetBtn.title = 'Reset';

  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '✕';
  closeBtn.title = 'Close (ESC)';

  toolbar.appendChild(zoomInBtn);
  toolbar.appendChild(zoomOutBtn);
  toolbar.appendChild(resetBtn);
  toolbar.appendChild(closeBtn);

  // Content container
  const content = document.createElement('div');
  content.className = 'gv-mermaid-modal-content';
  content.innerHTML = svgHtml;

  // Hint
  const hint = document.createElement('div');
  hint.className = 'gv-mermaid-modal-hint';
  hint.textContent = 'Scroll to zoom • Drag to pan • ESC to close';

  modal.appendChild(toolbar);
  modal.appendChild(content);
  modal.appendChild(hint);
  document.body.appendChild(modal);
  currentModal = modal;

  // Initial fit scale (updated after auto-fit calculation)
  let initialScale = 1;

  // Apply transform
  const applyTransform = () => {
    content.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  };

  // Zoom functions
  const zoomIn = () => {
    scale = Math.min(scale * 1.2, 10);
    applyTransform();
  };

  const zoomOut = () => {
    scale = Math.max(scale / 1.2, 0.1);
    applyTransform();
  };

  const resetView = () => {
    scale = initialScale;
    translateX = 0;
    translateY = 0;
    applyTransform();
  };

  let closing = false;
  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    translateX = e.clientX - startX;
    translateY = e.clientY - startY;
    applyTransform();
  };
  const handleMouseUp = () => {
    isDragging = false;
    content.classList.remove('dragging');
  };
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeModal();
  };
  const removeDocumentListeners = () => {
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };
  const closeModal = () => {
    if (closing) return;
    closing = true;
    removeDocumentListeners();
    handleMouseUp();
    modal.classList.remove('visible');
    setTimeout(() => {
      modal.remove();
      currentModal = null;
    }, 300);
  };

  // Event listeners
  zoomInBtn.addEventListener('click', zoomIn);
  zoomOutBtn.addEventListener('click', zoomOut);
  resetBtn.addEventListener('click', resetView);
  closeBtn.addEventListener('click', closeModal);

  // Click backdrop to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // ESC to close
  document.addEventListener('keydown', handleKeyDown);

  // Mouse wheel zoom
  modal.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        scale = Math.min(scale * 1.1, 10);
      } else {
        scale = Math.max(scale / 1.1, 0.1);
      }
      applyTransform();
    },
    { passive: false },
  );

  // Drag to pan
  content.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX - translateX;
    startY = e.clientY - translateY;
    content.classList.add('dragging');
  });

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);

  // Auto-fit SVG to viewport
  const svgElement = content.querySelector('svg');
  if (svgElement) {
    const padding = 80; // px padding from viewport edges
    const viewportWidth = window.innerWidth - padding * 2;
    const viewportHeight = window.innerHeight - padding * 2;
    const svgWidth = svgElement.scrollWidth || svgElement.clientWidth;
    const svgHeight = svgElement.scrollHeight || svgElement.clientHeight;

    if (svgWidth > 0 && svgHeight > 0) {
      const fitScale = Math.min(viewportWidth / svgWidth, viewportHeight / svgHeight);
      // Scale to fit viewport: scale down if too large, scale up if too small
      scale = Math.min(Math.max(fitScale, 0.1), 10);
      initialScale = scale;
      applyTransform();
    }
  }

  // Show modal with animation
  requestAnimationFrame(() => {
    modal.classList.add('visible');
  });
};

/** @internal Exported for lifecycle testing. */
export const _openFullscreenForTest = openFullscreen;

/**
 * Normalize whitespace characters in Mermaid code
 * Replaces non-breaking spaces (NBSP \u00A0) and other special whitespace
 * with standard spaces to prevent Mermaid parsing errors.
 *
 * Common problematic characters:
 * - \u00A0 (NBSP): From web pages, Word, Notion, WeChat, etc.
 * - \u2003 (Em Space)
 * - \u2002 (En Space)
 * - \u2009 (Thin Space)
 * - \u200B (Zero-width Space)
 * - \u3000 (Ideographic Space - CJK full-width space)
 */
/**
 * @internal Exported for testing
 */
export const normalizeWhitespace = (code: string): string => {
  return (
    code
      // Replace various special space characters with standard space
      .replace(/[\u00A0\u2002\u2003\u2009\u3000]/g, ' ')
      // Remove zero-width characters that can cause issues
      .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
  );
};

/**
 * Repair a small set of unambiguous Mermaid mistakes commonly produced by
 * models. Keep these rules narrow so valid diagram text is not rewritten.
 *
 * @internal Exported for testing
 */
export const normalizeMermaidCode = (code: string): string => {
  const lines = normalizeWhitespace(code).split('\n');
  const hasActivationParticipant = lines.some((line) =>
    /^\s*(?:actor|participant)\s+激活(?:\s+as\b|\s*$)/i.test(line),
  );
  const lastDeactivationByParticipant = new Map<string, number>();

  lines.forEach((line, index) => {
    const match = line.match(/^\s*deactivate\s+(\S+)\s*$/i);
    if (match) lastDeactivationByParticipant.set(match[1], index);
  });

  return lines
    .flatMap((line, index) => {
      const activationMatch = line.match(/^(\s*)激活\s*->>\s*([^:\s]+)\s*:\s*$/);
      if (
        activationMatch &&
        !hasActivationParticipant &&
        (lastDeactivationByParticipant.get(activationMatch[2]) ?? -1) > index
      ) {
        return [`${activationMatch[1]}activate ${activationMatch[2]}`];
      }

      const subgraphMatch = line.match(
        /^(\s*subgraph\s+)([^"[\]\r\n]*\([^"[\]\r\n]*\)[^"[\]\r\n]*)\s*$/i,
      );
      if (subgraphMatch) {
        return [`${subgraphMatch[1]}"${subgraphMatch[2].trim()}"`];
      }

      const trailingCommentMatch = line.match(
        /^(\s*)((?:classDef|class|style|linkStyle)\b.*?;\s*)%%(.*)$/i,
      );
      if (!trailingCommentMatch) return [line];

      const [, indent, statement, comment] = trailingCommentMatch;
      return [`${indent}${statement.trimEnd()}`, `${indent}%%${comment}`];
    })
    .join('\n');
};

/**
 * Render Mermaid diagram for a code block
 */
const renderMermaid = async (codeBlock: HTMLElement, code: string) => {
  // Normalize common copy/paste and model-output issues before processing.
  const normalizedCode = normalizeMermaidCode(code);
  if (codeBlock.dataset.mermaidCode === normalizedCode) return;
  if (codeBlock.dataset.mermaidProcessing === 'true') return;

  codeBlock.dataset.mermaidProcessing = 'true';

  try {
    const codeBlockHost = codeBlock.closest('code-block') as HTMLElement;
    if (!codeBlockHost) {
      codeBlock.dataset.mermaidProcessing = 'false';
      return;
    }

    // Ensure Mermaid is loaded before rendering
    const mermaid = await loadMermaid();
    if (!mermaid) {
      // Mermaid failed to load — gracefully degrade by showing raw code
      codeBlock.dataset.mermaidProcessing = 'false';
      return;
    }

    // First, try to render to validate the code
    const uniqueId = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
    let svg: string;
    let renderedDiagram = false;

    try {
      // v9.x render returns string directly, v10.x returns {svg: string}
      const result = await mermaid.render(uniqueId, normalizedCode);
      svg = typeof result === 'string' ? result : (result as { svg: string }).svg;
      renderedDiagram = true;
    } catch (renderError) {
      // Mermaid failed - likely incomplete or invalid syntax

      // Clean up any error SVGs mermaid may have created
      const errorSvg = document.getElementById(uniqueId);
      if (errorSvg) errorSvg.remove();

      // Also clean up any floating error containers mermaid creates
      document.querySelectorAll('[id^="d"]').forEach((el) => {
        if (el.textContent?.includes('Syntax error') || el.querySelector('.error-icon')) {
          el.remove();
        }
      });

      // Create a friendly error message
      const errorMsg = renderError instanceof Error ? renderError.message : 'Unknown error';
      const shortError = errorMsg.length > 100 ? errorMsg.substring(0, 100) + '...' : errorMsg;
      svg = `
                <div style="padding: 24px; text-align: center; color: var(--gemini-on-surface-variant, #666);">
                    <div style="font-size: 32px; margin-bottom: 12px;">⚠️</div>
                    <div style="font-weight: 500; margin-bottom: 8px;">Mermaid Syntax Error</div>
                    <div style="font-size: 12px; opacity: 0.7; font-family: monospace; max-width: 400px; margin: 0 auto; word-break: break-word;">${shortError}</div>
                    <div style="margin-top: 12px; font-size: 13px;">Click <b>"&lt;/&gt; Code"</b> to view source</div>
                </div>
            `;
    }

    let lightExportSvg: string | null = null;
    if (renderedDiagram && initializedMermaidTheme === 'dark') {
      const exportId = `${uniqueId}-export`;
      try {
        const exportResult = await mermaid.render(
          exportId,
          `${normalizedCode}\n${MERMAID_LIGHT_THEME_DIRECTIVE}`,
        );
        lightExportSvg =
          typeof exportResult === 'string' ? exportResult : (exportResult as { svg: string }).svg;
      } catch {
        document.getElementById(exportId)?.remove();
      }
    }

    // Rendering succeeded! Now create or update the UI
    let wrapper = codeBlockHost.parentElement;
    if (!wrapper?.classList.contains('gv-mermaid-wrapper')) {
      wrapper = document.createElement('div');
      wrapper.className = 'gv-mermaid-wrapper';
      codeBlockHost.parentElement?.insertBefore(wrapper, codeBlockHost);
      wrapper.appendChild(codeBlockHost);

      // Toggle buttons
      const toggleContainer = document.createElement('div');
      toggleContainer.className = 'gv-mermaid-toggle';

      // Try to find and move the native copy button to our toolbar
      // This prevents overlap/covering issues and keeps the UI clean
      // We look for .buttons container (newer Gemini) or .copy-button class
      const parentElement = wrapper?.parentElement || codeBlockHost.parentElement;
      const nativeCopyBtn =
        parentElement?.querySelector('.buttons') || parentElement?.querySelector('.copy-button');

      // Only move if it looks like the right button (close to the code block)
      if (nativeCopyBtn) {
        // Reset positioning that might conflict
        (nativeCopyBtn as HTMLElement).style.position = 'static';
        (nativeCopyBtn as HTMLElement).style.top = 'auto';
        (nativeCopyBtn as HTMLElement).style.right = 'auto';
        (nativeCopyBtn as HTMLElement).style.marginTop = '0';
        toggleContainer.appendChild(nativeCopyBtn);
      }

      const diagramBtn = document.createElement('button');
      diagramBtn.textContent = '📊 Diagram';
      diagramBtn.className = 'active';
      diagramBtn.dataset.view = 'diagram';

      const codeBtn = document.createElement('button');
      codeBtn.textContent = '</> Code';
      codeBtn.dataset.view = 'code';

      toggleContainer.appendChild(diagramBtn);
      toggleContainer.appendChild(codeBtn);
      wrapper.appendChild(toggleContainer);

      // Diagram container
      const diagramContainer = document.createElement('div');
      diagramContainer.className = 'gv-mermaid-diagram';
      wrapper.appendChild(diagramContainer);

      codeBlockHost.style.display = 'none';

      const updateView = (view: 'diagram' | 'code') => {
        if (view === 'diagram') {
          codeBlockHost.style.display = 'none';
          diagramContainer.style.display = 'block';
          diagramBtn.classList.add('active');
          codeBtn.classList.remove('active');
        } else {
          codeBlockHost.style.display = '';
          diagramContainer.style.display = 'none';
          diagramBtn.classList.remove('active');
          codeBtn.classList.add('active');
        }
      };

      diagramBtn.addEventListener('click', () => updateView('diagram'));
      codeBtn.addEventListener('click', () => updateView('code'));

      // Click diagram to fullscreen (only if it's a valid SVG, not error)
      diagramContainer.addEventListener('click', () => {
        const svgElement = diagramContainer.querySelector('svg');
        if (svgElement) {
          openFullscreen(diagramContainer.innerHTML);
        }
      });
    }

    if (initializedMermaidTheme) {
      wrapper.dataset.gvMermaidTheme = initializedMermaidTheme;
    }

    const existingLightExport = wrapper.querySelector<HTMLTemplateElement>(
      `template.${MERMAID_LIGHT_EXPORT_TEMPLATE_CLASS}`,
    );
    if (lightExportSvg) {
      const lightExport = existingLightExport ?? document.createElement('template');
      lightExport.className = MERMAID_LIGHT_EXPORT_TEMPLATE_CLASS;
      lightExport.innerHTML = lightExportSvg;
      if (!existingLightExport) wrapper.appendChild(lightExport);
    } else {
      existingLightExport?.remove();
    }

    const diagramContainer = wrapper.querySelector('.gv-mermaid-diagram') as HTMLElement;
    if (!diagramContainer) {
      codeBlock.dataset.mermaidProcessing = 'false';
      return;
    }

    // Insert the successfully rendered SVG
    diagramContainer.innerHTML = svg;

    codeBlock.dataset.mermaidCode = normalizedCode;
    codeBlock.dataset.mermaidProcessing = 'false';
    console.log('[Gemini Voyager] Mermaid diagram rendered:', uniqueId);
  } catch {
    codeBlock.dataset.mermaidProcessing = 'false';

    const codeBlockHost = codeBlock.closest('code-block') as HTMLElement;
    if (codeBlockHost) {
      codeBlockHost.style.display = '';
    }
  }
};

/** @internal Exported for theme-marker testing. */
export const _renderMermaidForTest = renderMermaid;

/**
 * Get the language label from a code block's header decoration
 * Returns the language name (lowercase) or null if not found
 */
const getCodeBlockLanguage = (codeEl: Element): string | null => {
  // Navigate up to find the code-block container
  const codeBlock = codeEl.closest('.code-block, code-block');
  if (!codeBlock) return null;

  // Look for the language label in the header decoration
  // Gemini uses: <div class="code-block-decoration"><span>Language</span>...</div>
  const decoration = codeBlock.querySelector('.code-block-decoration');
  if (!decoration) return null;

  // The first span child typically contains the language name
  const langSpan = decoration.querySelector(':scope > span');
  if (!langSpan) return null;

  const language = langSpan.textContent?.trim().toLowerCase();
  return language || null;
};

/**
 * Generic/non-specific language labels that should still allow Mermaid detection
 * These are labels that don't represent a specific programming language
 */
const GENERIC_LANGUAGE_LABELS = new Set([
  // Arabic
  'مقتطف الرمز',
  // Spanish
  'fragmento de código',
  // French
  'extrait de code',
  // Korean
  '코드 스니펫',
  // Portuguese
  'snippet de código',
  // Russian
  'фрагмент кода',
  // Simplified Chinese
  '代码段',
  '代码',
  '代码块',
  '示例',
  '示例代码',
  // Traditional Chinese
  '程式碼片段',
  // Japanese
  'コード スニペット',
  // English
  'code',
  'code snippet',
  'snippet',
  'example',
  'code example',
  'sample',
  // Common generic terms
  'text',
  'plain',
  'plaintext',
  'raw',
  'output',
  'result',
]);

/**
 * Check if a language label is generic (not a specific programming language)
 */
/**
 * @internal Exported for testing
 */
export const isGenericLanguageLabel = (language: string | null): boolean => {
  if (!language) return true; // No label = generic
  return GENERIC_LANGUAGE_LABELS.has(language.toLowerCase());
};

/**
 * Find and process code blocks
 */
const processCodeBlocks = () => {
  const codeElements = document.querySelectorAll('code[data-test-id="code-content"]');

  codeElements.forEach((codeEl) => {
    const codeText = codeEl.textContent || '';

    // Check the language label from Gemini's code block header
    const language = getCodeBlockLanguage(codeEl);

    // Case 1: Language is explicitly "mermaid" - always render
    if (language === 'mermaid') {
      renderMermaid(codeEl as HTMLElement, codeText);
      return;
    }

    // Case 2: Language is a specific programming language (not generic) - skip rendering
    // This prevents false positives for MATLAB (%% comments), Python, etc.
    if (language && !isGenericLanguageLabel(language)) {
      return;
    }

    // Case 3: No language label or generic label - use content detection
    if (isMermaidCode(codeText)) {
      renderMermaid(codeEl as HTMLElement, codeText);
    }
  });
};

/**
 * Track whether Mermaid is enabled
 */
let mermaidEnabled = true;
let observer: MutationObserver | null = null;

/**
 * Start Mermaid feature
 */
export const startMermaid = () => {
  // Check if Mermaid rendering is enabled in settings
  chrome.storage?.sync?.get({ gvMermaidEnabled: true }, (result) => {
    mermaidEnabled = result?.gvMermaidEnabled !== false;

    if (mermaidEnabled) {
      initializeMermaid();
    } else {
      console.log('[Gemini Voyager] Mermaid rendering is disabled');
    }
  });

  // Listen for setting changes
  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.gvMermaidEnabled) {
      mermaidEnabled = changes.gvMermaidEnabled.newValue !== false;
      if (mermaidEnabled) {
        initializeMermaid();
        console.log('[Gemini Voyager] Mermaid rendering enabled');
      } else {
        // Stop observing when disabled
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        console.log('[Gemini Voyager] Mermaid rendering disabled');
      }
    }
  });
};

/**
 * Initialize Mermaid rendering
 */
const initializeMermaid = async () => {
  createStyles();

  const loaded = await initMermaid();
  if (!loaded) {
    console.warn('[Gemini Voyager] Mermaid library failed to load, diagrams will show as code');
    return;
  }

  processCodeBlocks();

  // Only create observer if not already exists
  if (!observer) {
    let timeout: ReturnType<typeof setTimeout>;
    const debouncedProcess = () => {
      if (!mermaidEnabled) return;
      clearTimeout(timeout);
      timeout = setTimeout(processCodeBlocks, 1000);
    };

    observer = new MutationObserver(() => {
      debouncedProcess();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  console.log('[Gemini Voyager] Mermaid integration started');
};
