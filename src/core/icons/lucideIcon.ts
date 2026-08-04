import type { IconNode } from 'lucide-react';

const LUCIDE_NAMESPACE = 'http://www.w3.org/2000/svg';

function toSvgAttributeName(attribute: string): string {
  if (attribute === 'className') return 'class';
  return attribute.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * Creates a Lucide icon for non-React content-script surfaces.
 *
 * Popup components use lucide-react directly. Injected Gemini controls are
 * plain DOM, so they share this factory instead of duplicating SVG markup.
 */
export function createLucideIcon(name: string, iconNode: IconNode, size = 16): SVGSVGElement {
  const svg = document.createElementNS(LUCIDE_NAMESPACE, 'svg');
  svg.setAttribute('xmlns', LUCIDE_NAMESPACE);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('lucide', `lucide-${name}`);

  for (const [elementName, attributes] of iconNode) {
    const child = document.createElementNS(LUCIDE_NAMESPACE, elementName);
    for (const [attribute, value] of Object.entries(attributes)) {
      if (attribute === 'key') continue;
      child.setAttribute(toSvgAttributeName(attribute), value);
    }
    svg.appendChild(child);
  }

  return svg;
}
