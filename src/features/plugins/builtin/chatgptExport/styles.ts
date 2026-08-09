export const CHATGPT_EXPORT_CSS = `
  .gv-chatgpt-export-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 36px;
    min-width: 36px;
    gap: 7px;
    padding: 0 12px;
    border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
    border-radius: 999px;
    color: inherit;
    background: color-mix(in srgb, Canvas 82%, transparent);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    font: 500 14px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
  }
  .gv-chatgpt-export-button:hover {
    border-color: color-mix(in srgb, currentColor 24%, transparent);
    background: color-mix(in srgb, currentColor 9%, Canvas);
  }
  .gv-chatgpt-export-button:active { transform: translateY(1px); }
  .gv-chatgpt-export-button:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
  .gv-chatgpt-export-button-icon { width: 17px; height: 17px; flex: none; }
  .gv-chatgpt-export-button-label { display: inline-block; }
  .gv-chatgpt-export-button--floating {
    position: fixed;
    top: 12px;
    right: 58px;
    z-index: 2147483000;
    color: #1f2937;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 2px 14px rgba(0, 0, 0, 0.14);
    backdrop-filter: blur(10px);
  }
  .gv-chatgpt-export-menu {
    position: fixed;
    z-index: 2147483002;
    width: min(280px, calc(100vw - 24px));
    padding: 7px;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 14px;
    color: #171717;
    background: #fff;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.18);
  }
  .gv-chatgpt-export-menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 12px;
    border: 0;
    border-radius: 9px;
    color: inherit;
    background: transparent;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }
  .gv-chatgpt-export-menu-item:hover,
  .gv-chatgpt-export-menu-item:focus-visible { background: #f2f2f2; outline: none; }
  .gv-chatgpt-export-menu-icon { flex: none; width: 19px; height: 19px; }
  .gv-chatgpt-export-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483003;
    display: grid;
    place-items: center;
    padding: 18px;
    background: rgba(0, 0, 0, 0.48);
    backdrop-filter: blur(3px);
  }
  .gv-chatgpt-export-dialog {
    width: min(640px, 100%);
    max-height: min(82vh, 760px);
    overflow: auto;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 18px;
    color: #171717;
    background: #fff;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.26);
  }
  .gv-chatgpt-export-dialog-header { position: relative; padding: 22px 24px 12px; }
  .gv-chatgpt-export-dialog-title { margin: 0; font-size: 20px; line-height: 1.3; }
  .gv-chatgpt-export-dialog-hint { margin: 8px 0 0; color: #6b7280; font-size: 13px; line-height: 1.5; }
  .gv-chatgpt-export-attribution {
    position: absolute;
    top: 20px;
    right: 24px;
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 3px 9px;
    border: 1px solid rgba(107, 114, 128, 0.22);
    border-radius: 999px;
    color: #6b7280;
    background: rgba(107, 114, 128, 0.06);
    font: 500 11px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    text-decoration: none;
    opacity: 0.72;
    transition: opacity 120ms ease, border-color 120ms ease, background-color 120ms ease;
  }
  .gv-chatgpt-export-attribution:hover {
    border-color: rgba(107, 114, 128, 0.38);
    background: rgba(107, 114, 128, 0.11);
    opacity: 1;
  }
  .gv-chatgpt-export-attribution:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
    opacity: 1;
  }
  .gv-chatgpt-export-dialog-body { padding: 10px 24px 20px; }
  .gv-chatgpt-export-dialog-footer {
    position: sticky;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 9px;
    padding: 14px 24px;
    border-top: 1px solid rgba(0, 0, 0, 0.09);
    background: inherit;
  }
  .gv-chatgpt-export-btn {
    min-height: 38px;
    padding: 8px 15px;
    border: 1px solid rgba(0, 0, 0, 0.13);
    border-radius: 10px;
    color: inherit;
    background: transparent;
    font: inherit;
    cursor: pointer;
  }
  .gv-chatgpt-export-btn:hover { background: #f3f4f6; }
  .gv-chatgpt-export-btn--primary { border-color: #111; color: #fff; background: #111; }
  .gv-chatgpt-export-btn--primary:hover { background: #292929; }
  .gv-chatgpt-export-btn:disabled { opacity: 0.5; cursor: default; }
  .gv-chatgpt-export-progress { display: grid; justify-items: center; gap: 14px; padding: 32px 0; }
  .gv-chatgpt-export-spinner {
    width: 30px;
    height: 30px;
    border: 3px solid #d1d5db;
    border-top-color: #111;
    border-radius: 50%;
    animation: gv-chatgpt-export-spin 0.8s linear infinite;
  }
  @keyframes gv-chatgpt-export-spin { to { transform: rotate(360deg); } }
  .gv-chatgpt-export-pick-active {
    --gv-chatgpt-export-pick-accent: #8b5cf6;
    --gv-chatgpt-export-pick-accent-strong: #7c3aed;
  }
  .gv-chatgpt-export-pick-host { position: relative !important; }
  .gv-chatgpt-export-pick-host--selected {
    outline: 2px solid var(--gv-chatgpt-export-pick-accent, #8b5cf6);
    outline-offset: 2px;
    border-radius: 12px;
  }
  .gv-chatgpt-export-pick-checkbox {
    position: absolute;
    top: 6px;
    left: 6px;
    z-index: 30;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 2px solid var(--gv-chatgpt-export-pick-accent, #8b5cf6);
    border-radius: 8px;
    color: #fff;
    background: var(--main-surface-primary, var(--sidebar-surface-primary, #fff));
    box-shadow: 0 2px 8px rgba(124, 58, 237, 0.35);
    cursor: pointer;
    opacity: 0.92;
    transition: opacity 120ms ease, transform 120ms ease, background-color 120ms ease;
  }
  .gv-chatgpt-export-pick-checkbox:hover { opacity: 1; transform: scale(1.08); }
  .gv-chatgpt-export-pick-checkbox::after {
    content: '';
    width: 13px;
    height: 7px;
    border-left: 2.5px solid currentColor;
    border-bottom: 2.5px solid currentColor;
    transform: translateY(-1px) rotate(-45deg) scale(0);
    transition: transform 120ms ease;
  }
  .gv-chatgpt-export-pick-checkbox[data-selected='true'] {
    opacity: 1;
    border-color: var(--gv-chatgpt-export-pick-accent-strong, #7c3aed);
    background: var(--gv-chatgpt-export-pick-accent, #8b5cf6);
  }
  .gv-chatgpt-export-pick-checkbox[data-selected='true']::after {
    transform: translateY(-1px) rotate(-45deg) scale(1);
  }
  .gv-chatgpt-export-pick-bar {
    position: fixed;
    top: 12px;
    left: 50%;
    z-index: 2147483001;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: calc(100vw - 24px);
    padding: 8px 12px;
    overflow-x: auto;
    border: 1px solid var(--border-medium, rgba(127, 127, 127, 0.3));
    border-radius: 12px;
    color: var(--text-primary, #171717);
    background: var(--main-surface-primary, #fff);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
    font: 14px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    transform: translateX(-50%);
  }
  .gv-chatgpt-export-pick-bar__title { flex: none; margin-right: 2px; font-weight: 650; white-space: nowrap; }
  .gv-chatgpt-export-pick-bar__count { flex: none; padding: 0 4px; white-space: nowrap; opacity: 0.78; }
  .gv-chatgpt-export-pick-bar__btn {
    flex: none;
    padding: 6px 10px;
    border: 1px solid var(--border-medium, rgba(127, 127, 127, 0.35));
    border-radius: 8px;
    color: inherit;
    background: transparent;
    font: inherit;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
  }
  .gv-chatgpt-export-pick-bar__btn:hover {
    background: var(--main-surface-secondary, rgba(127, 127, 127, 0.12));
  }
  .gv-chatgpt-export-pick-bar__btn:disabled { opacity: 0.45; cursor: default; }
  .gv-chatgpt-export-pick-bar__btn--primary {
    border-color: var(--gv-chatgpt-export-pick-accent, #8b5cf6);
    color: #fff;
    background: var(--gv-chatgpt-export-pick-accent, #8b5cf6);
    box-shadow: 0 2px 10px rgba(124, 58, 237, 0.4);
    font-weight: 650;
  }
  .gv-chatgpt-export-pick-bar__btn--primary:not(:disabled):hover {
    border-color: var(--gv-chatgpt-export-pick-accent-strong, #7c3aed);
    background: var(--gv-chatgpt-export-pick-accent-strong, #7c3aed);
  }
  .gv-chatgpt-export-pick-bar__btn--ghost { border-color: transparent; opacity: 0.8; }
  .gv-chatgpt-export-format-list { display: grid; gap: 9px; }
  .gv-chatgpt-export-format-option {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 11px;
    padding: 13px;
    border: 1px solid rgba(0, 0, 0, 0.11);
    border-radius: 12px;
    cursor: pointer;
  }
  .gv-chatgpt-export-format-option:has(input:checked) { border-color: #111; background: #f7f7f7; }
  .gv-chatgpt-export-format-label { font-weight: 700; }
  .gv-chatgpt-export-format-description { margin-top: 3px; color: #6b7280; font-size: 12px; }
  .gv-chatgpt-export-options { display: grid; gap: 12px; margin-top: 16px; }
  .gv-chatgpt-export-control { display: grid; grid-template-columns: 130px 1fr 52px; gap: 10px; align-items: center; }
  .gv-chatgpt-export-control output { text-align: right; color: #6b7280; font-size: 12px; }
  .gv-chatgpt-export-error { margin: 10px 0 0; color: #b91c1c; font-size: 13px; }
  .gv-chatgpt-export-toast {
    position: fixed;
    left: 50%;
    bottom: 28px;
    z-index: 2147483004;
    transform: translateX(-50%);
    max-width: min(560px, calc(100vw - 28px));
    padding: 11px 15px;
    border-radius: 11px;
    color: #fff;
    background: #202020;
    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.25);
    font-size: 13px;
  }
  .gv-chatgpt-export-toast--error { background: #991b1b; }
  html.dark .gv-chatgpt-export-menu,
  html.dark .gv-chatgpt-export-dialog,
  body.dark .gv-chatgpt-export-menu,
  body.dark .gv-chatgpt-export-dialog,
  [data-theme='dark'] .gv-chatgpt-export-menu,
  [data-theme='dark'] .gv-chatgpt-export-dialog {
    border-color: rgba(255, 255, 255, 0.14);
    color: #f5f5f5;
    background: #212121;
  }
  html.dark .gv-chatgpt-export-menu-item:hover,
  html.dark .gv-chatgpt-export-menu-item:focus-visible,
  html.dark .gv-chatgpt-export-btn:hover,
  html.dark .gv-chatgpt-export-format-option:has(input:checked),
  body.dark .gv-chatgpt-export-menu-item:hover,
  body.dark .gv-chatgpt-export-menu-item:focus-visible,
  body.dark .gv-chatgpt-export-btn:hover,
  body.dark .gv-chatgpt-export-format-option:has(input:checked),
  [data-theme='dark'] .gv-chatgpt-export-menu-item:hover,
  [data-theme='dark'] .gv-chatgpt-export-menu-item:focus-visible,
  [data-theme='dark'] .gv-chatgpt-export-btn:hover,
  [data-theme='dark'] .gv-chatgpt-export-format-option:has(input:checked) { background: #303030; }
  html.dark .gv-chatgpt-export-attribution,
  body.dark .gv-chatgpt-export-attribution,
  [data-theme='dark'] .gv-chatgpt-export-attribution {
    border-color: rgba(209, 213, 219, 0.2);
    color: #9ca3af;
    background: rgba(209, 213, 219, 0.06);
  }
  html.dark .gv-chatgpt-export-pick-bar,
  body.dark .gv-chatgpt-export-pick-bar,
  [data-theme='dark'] .gv-chatgpt-export-pick-bar {
    color: #f5f5f5;
    background: var(--main-surface-primary, #212121);
  }
  html.dark .gv-chatgpt-export-button--floating,
  body.dark .gv-chatgpt-export-button--floating,
  [data-theme='dark'] .gv-chatgpt-export-button--floating { color: #f5f5f5; background: rgba(33, 33, 33, 0.94); }
  @media (max-width: 520px) {
    .gv-chatgpt-export-button { width: 36px; padding: 0; }
    .gv-chatgpt-export-button-label { display: none; }
    .gv-chatgpt-export-dialog { border-radius: 14px; }
    .gv-chatgpt-export-dialog-header, .gv-chatgpt-export-dialog-body { padding-left: 16px; padding-right: 16px; }
    .gv-chatgpt-export-attribution {
      position: static;
      width: fit-content;
      margin-top: 12px;
    }
    .gv-chatgpt-export-dialog-footer { padding-left: 16px; padding-right: 16px; }
    .gv-chatgpt-export-pick-bar__title { display: none; }
  }
`;
