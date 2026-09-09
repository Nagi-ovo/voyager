export const CODE_COLLAPSE_STYLES = `
.gv-code-collapse-toggle, .gv-code-collapse-toolbar button {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; padding: 6px; margin: 2px; border: 1px solid currentColor;
  border-radius: 4px; color: inherit; background: transparent; cursor: pointer;
  vertical-align: middle; flex: 0 0 32px;
}
.gv-code-collapse-toggle svg, .gv-code-collapse-toolbar svg {
  width: 18px; height: 18px; pointer-events: none;
}
.gv-code-collapse-toggle:hover, .gv-code-collapse-toolbar button:hover {
  background: color-mix(in srgb, currentColor 12%, transparent);
}
.gv-code-collapse-toggle:focus-visible, .gv-code-collapse-toolbar button:focus-visible {
  outline: 2px solid currentColor; outline-offset: 2px;
}
.gv-code-collapse-toolbar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
  position: static; width: fit-content; max-width: 100%; margin-block: 4px;
}
.gv-code-collapse-toolbar button:disabled { opacity: .45; cursor: default; }
`;
