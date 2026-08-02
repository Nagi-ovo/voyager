import type { IconNode } from 'lucide-react';

import { createLucideIcon } from './lucideIcon';

/** Lucide folder-control geometry from lucide-react v0.553.0. */
const CHEVRON_DOWN_ICON_NODE = [['path', { d: 'm6 9 6 6 6-6', key: 'qrunsl' }]] satisfies IconNode;

const CHEVRON_RIGHT_ICON_NODE = [
  ['path', { d: 'm9 18 6-6-6-6', key: 'mthhwq' }],
] satisfies IconNode;

const CLOUD_ICON_NODE = [
  ['path', { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z', key: 'p7xjir' }],
] satisfies IconNode;

const FOLDER_ICON_NODE = [
  [
    'path',
    {
      d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
      key: '1kt360',
    },
  ],
] satisfies IconNode;

const PLUS_ICON_NODE = [
  ['path', { d: 'M5 12h14', key: '1ays0h' }],
  ['path', { d: 'M12 5v14', key: 's699le' }],
] satisfies IconNode;

const SETTINGS_ICON_NODE = [
  [
    'path',
    {
      d: 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915',
      key: '1i5ecw',
    },
  ],
  ['circle', { cx: '12', cy: '12', r: '3', key: '1v7zrd' }],
] satisfies IconNode;

const STAR_ICON_NODE = [
  [
    'path',
    {
      d: 'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z',
      key: 'r04s7s',
    },
  ],
] satisfies IconNode;

const USER_ROUND_ICON_NODE = [
  ['circle', { cx: '12', cy: '8', r: '5', key: '1hypcn' }],
  ['path', { d: 'M20 21a8 8 0 0 0-16 0', key: 'rfgkzh' }],
] satisfies IconNode;

export function createChevronDownIcon(size = 16): SVGSVGElement {
  return createLucideIcon('chevron-down', CHEVRON_DOWN_ICON_NODE, size);
}

export function createChevronRightIcon(size = 16): SVGSVGElement {
  return createLucideIcon('chevron-right', CHEVRON_RIGHT_ICON_NODE, size);
}

export function createCloudIcon(size = 16): SVGSVGElement {
  return createLucideIcon('cloud', CLOUD_ICON_NODE, size);
}

export function createFolderIcon(size = 16): SVGSVGElement {
  return createLucideIcon('folder', FOLDER_ICON_NODE, size);
}

export function createPlusIcon(size = 16): SVGSVGElement {
  return createLucideIcon('plus', PLUS_ICON_NODE, size);
}

export function createSettingsIcon(size = 16): SVGSVGElement {
  return createLucideIcon('settings', SETTINGS_ICON_NODE, size);
}

export function createStarIcon(size = 16, filled = false): SVGSVGElement {
  const icon = createLucideIcon('star', STAR_ICON_NODE, size);
  if (filled) icon.setAttribute('fill', 'currentColor');
  return icon;
}

export function createUserRoundIcon(size = 16): SVGSVGElement {
  return createLucideIcon('user-round', USER_ROUND_ICON_NODE, size);
}
