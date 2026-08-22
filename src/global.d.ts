declare module '*.svg' {
  import React = require('react');
  export const ReactComponent: React.SFC<React.SVGProps<SVGSVGElement>>;
  const src: string;
  export default src;
}

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.json' {
  const content: string;
  export default content;
}

/**
 * WaveDrom (wavedrom@3.x) ships CommonJS without bundled type declarations and
 * has no @types package. Only the render-to-string path is used by the Voyager
 * WaveDrom renderer: renderAny builds an onml tree, onml.stringify converts it
 * to an SVG string.
 */
declare module 'wavedrom' {
  /** WaveJSON source object: signal lanes, assign expressions, or register lanes. */
  export type WaveSource = {
    signal?: unknown[];
    assign?: unknown;
    reg?: unknown;
    config?: Record<string, unknown>;
    [key: string]: unknown;
  };
  /** A WaveDrom skin object: `{ default: {...} }`, `{ dark: {...} }`, … */
  export type WaveSkin = Record<string, Record<string, unknown>>;
  /** onml tree: `[tag, attrs?, ...children]`. */
  export type OnmlTree = [string, Record<string, unknown>?, ...unknown[]];

  export function renderAny(
    index: number,
    source: WaveSource,
    waveSkin?: WaveSkin,
    notFirstSignal?: boolean,
  ): OnmlTree;
  export const onml: {
    stringify: (tree: OnmlTree) => string;
  };
  const WaveDrom: {
    renderAny: typeof renderAny;
    onml: typeof onml;
  };
  export default WaveDrom;
}

declare module 'wavedrom/skins/default.js' {
  const skin: import('wavedrom').WaveSkin;
  export default skin;
}

declare module 'wavedrom/skins/dark.js' {
  const skin: import('wavedrom').WaveSkin;
  export default skin;
}

declare module 'wavedrom/render-any' {
  const renderAny: typeof import('wavedrom').renderAny;
  export default renderAny;
}

declare module 'onml/stringify.js' {
  const stringify: (tree: import('wavedrom').OnmlTree) => string;
  export default stringify;
}
