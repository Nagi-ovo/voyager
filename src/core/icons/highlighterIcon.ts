import type { IconNode } from 'lucide-react';

import { createLucideIcon } from './lucideIcon';

/** Lucide Highlighter geometry from lucide-react v0.553.0. */
const HIGHLIGHTER_ICON_NODE = [
  ['path', { d: 'm9 11-6 6v3h9l3-3', key: '1a3l36' }],
  [
    'path',
    {
      d: 'm22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4',
      key: '14a9rk',
    },
  ],
] satisfies IconNode;

export function createHighlighterIcon(size = 16): SVGSVGElement {
  return createLucideIcon('highlighter', HIGHLIGHTER_ICON_NODE, size);
}
