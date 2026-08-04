import type { IconNode } from 'lucide-react';

import { createLucideIcon } from './lucideIcon';

/** Lucide Bell geometry from lucide-react v0.553.0. */
const BELL_ICON_NODE = [
  ['path', { d: 'M10.268 21a2 2 0 0 0 3.464 0', key: 'vwvbt9' }],
  [
    'path',
    {
      d: 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326',
      key: '11g9vi',
    },
  ],
] satisfies IconNode;

export function createBellIcon(size = 16): SVGSVGElement {
  return createLucideIcon('bell', BELL_ICON_NODE, size);
}
