import type { IconNode } from 'lucide-react';

import { createLucideIcon } from './lucideIcon';

/** Lucide Prompt Manager geometry from lucide-react v0.553.0. */
const ARROW_LEFT_ICON_NODE = [
  ['path', { d: 'm12 19-7-7 7-7', key: '1l729n' }],
  ['path', { d: 'M19 12H5', key: 'x3x0zl' }],
] satisfies IconNode;

const BRACES_ICON_NODE = [
  [
    'path',
    {
      d: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1',
      key: 'ezmyqa',
    },
  ],
  [
    'path',
    {
      d: 'M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1',
      key: 'e1hn23',
    },
  ],
] satisfies IconNode;

const DOWNLOAD_ICON_NODE = [
  ['path', { d: 'M12 15V3', key: 'm9g1x1' }],
  ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', key: 'ih7n3h' }],
  ['path', { d: 'm7 10 5 5 5-5', key: 'brsn70' }],
] satisfies IconNode;

const FILE_TEXT_ICON_NODE = [
  [
    'path',
    {
      d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
      key: '1oefj6',
    },
  ],
  ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5', key: 'wfsgrz' }],
  ['path', { d: 'M10 9H8', key: 'b1mrlr' }],
  ['path', { d: 'M16 13H8', key: 't4e002' }],
  ['path', { d: 'M16 17H8', key: 'z1uh3a' }],
] satisfies IconNode;

const LAYOUT_GRID_ICON_NODE = [
  ['rect', { width: '7', height: '7', x: '3', y: '3', rx: '1', key: '1g98yp' }],
  ['rect', { width: '7', height: '7', x: '14', y: '3', rx: '1', key: '6d4xhi' }],
  ['rect', { width: '7', height: '7', x: '14', y: '14', rx: '1', key: 'nxv5o0' }],
  ['rect', { width: '7', height: '7', x: '3', y: '14', rx: '1', key: '1bb6yr' }],
] satisfies IconNode;

const LIST_ICON_NODE = [
  ['path', { d: 'M3 5h.01', key: '18ugdj' }],
  ['path', { d: 'M3 12h.01', key: 'nlz23k' }],
  ['path', { d: 'M3 19h.01', key: 'noohij' }],
  ['path', { d: 'M8 5h13', key: '1pao27' }],
  ['path', { d: 'M8 12h13', key: '1za7za' }],
  ['path', { d: 'M8 19h13', key: 'm83p4d' }],
] satisfies IconNode;

const LOCK_ICON_NODE = [
  ['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2', key: '1w4ew1' }],
  ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4', key: 'fwvmzm' }],
] satisfies IconNode;

const LOCK_OPEN_ICON_NODE = [
  ['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2', key: '1w4ew1' }],
  ['path', { d: 'M7 11V7a5 5 0 0 1 9.9-1', key: '1mm8w8' }],
] satisfies IconNode;

const MOON_ICON_NODE = [
  [
    'path',
    {
      d: 'M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401',
      key: 'kfwtm',
    },
  ],
] satisfies IconNode;

const SUN_ICON_NODE = [
  ['circle', { cx: '12', cy: '12', r: '4', key: '4exip2' }],
  ['path', { d: 'M12 2v2', key: 'tus03m' }],
  ['path', { d: 'M12 20v2', key: '1lh1kg' }],
  ['path', { d: 'm4.93 4.93 1.41 1.41', key: '149t6j' }],
  ['path', { d: 'm17.66 17.66 1.41 1.41', key: 'ptbguv' }],
  ['path', { d: 'M2 12h2', key: '1t8f8n' }],
  ['path', { d: 'M20 12h2', key: '1q8mjw' }],
  ['path', { d: 'm6.34 17.66-1.41 1.41', key: '1m8zz5' }],
  ['path', { d: 'm19.07 4.93-1.41 1.41', key: '1shlcs' }],
] satisfies IconNode;

export function createBracesIcon(size = 16): SVGSVGElement {
  return createLucideIcon('braces', BRACES_ICON_NODE, size);
}

export function createArrowLeftIcon(size = 16): SVGSVGElement {
  return createLucideIcon('arrow-left', ARROW_LEFT_ICON_NODE, size);
}

export function createDownloadIcon(size = 16): SVGSVGElement {
  return createLucideIcon('download', DOWNLOAD_ICON_NODE, size);
}

export function createFileTextIcon(size = 16): SVGSVGElement {
  return createLucideIcon('file-text', FILE_TEXT_ICON_NODE, size);
}

export function createLayoutGridIcon(size = 16): SVGSVGElement {
  return createLucideIcon('layout-grid', LAYOUT_GRID_ICON_NODE, size);
}

export function createListIcon(size = 16): SVGSVGElement {
  return createLucideIcon('list', LIST_ICON_NODE, size);
}

export function createLockIcon(size = 16): SVGSVGElement {
  return createLucideIcon('lock', LOCK_ICON_NODE, size);
}

export function createLockOpenIcon(size = 16): SVGSVGElement {
  return createLucideIcon('lock-open', LOCK_OPEN_ICON_NODE, size);
}

export function createMoonIcon(size = 16): SVGSVGElement {
  return createLucideIcon('moon', MOON_ICON_NODE, size);
}

export function createSunIcon(size = 16): SVGSVGElement {
  return createLucideIcon('sun', SUN_ICON_NODE, size);
}
