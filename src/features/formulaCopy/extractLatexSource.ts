/**
 * Extract LaTeX source from Gemini, AI Studio, or ChatGPT math markup.
 */
export function extractLatexSource(element: HTMLElement): string | null {
  const dataMath = element.getAttribute('data-math');
  if (dataMath) return dataMath;

  const dataMathSource = element.closest('[data-math-source]')?.getAttribute('data-math-source');
  if (dataMathSource?.trim()) return dataMathSource.trim();

  const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
  if (annotation?.textContent) return annotation.textContent.trim();

  const anyAnnotation = element.querySelector('annotation');
  if (anyAnnotation?.textContent) return anyAnnotation.textContent.trim();

  return null;
}
