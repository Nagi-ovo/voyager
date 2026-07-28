interface MermaidExportStyleOptions {
  containerMargin?: string;
  containerMaxWidth?: boolean;
  avoidContainerBreak?: boolean;
  diagramSelector?: 'svg' | '> img';
  diagramMargin?: string;
  importantDisplay?: boolean;
  avoidDiagramBreak?: boolean;
  diagramMaxHeight?: string;
  preservePrintBackground?: boolean;
}

export function buildMermaidExportStyles(
  scope: string,
  options: MermaidExportStyleOptions = {},
): string {
  const diagramSelector = options.diagramSelector ?? 'svg';
  const diagramMargin = options.diagramMargin ?? '0 auto';
  const displayImportant = options.importantDisplay ? ' !important' : '';
  const containerMargin = options.containerMargin
    ? `
        margin: ${options.containerMargin};`
    : '';
  const containerMaxWidth = options.containerMaxWidth
    ? `
        max-width: 100%;`
    : '';
  const containerBreakStyles = options.avoidContainerBreak
    ? `
        break-inside: avoid;
        page-break-inside: avoid;`
    : '';
  const diagramBreakStyles = options.avoidDiagramBreak
    ? `
        break-inside: avoid;
        page-break-inside: avoid;`
    : '';
  const diagramMaxHeight = options.diagramMaxHeight
    ? `
        max-height: ${options.diagramMaxHeight};
        object-fit: contain;`
    : '';
  const printBackgroundStyles = options.preservePrintBackground
    ? `
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;`
    : '';

  return `
      ${scope} .gv-export-mermaid {${containerMargin}${containerMaxWidth}
        text-align: center;${containerBreakStyles}${printBackgroundStyles}
      }

      ${scope} .gv-export-mermaid ${diagramSelector} {
        display: block${displayImportant};
        max-width: 100%;
        height: auto;
        margin: ${diagramMargin};${diagramBreakStyles}${diagramMaxHeight}
      }

  `;
}
