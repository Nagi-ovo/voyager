export const CHATGPT_TEMPORARY_HANDOFF_CSS = `
  .gv-chatgpt-handoff-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 36px;
    gap: 7px;
    padding: 0 12px;
    border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
    border-radius: 999px;
    color: inherit;
    background: color-mix(in srgb, Canvas 82%, transparent);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    font: 500 14px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    white-space: nowrap;
    cursor: pointer;
  }
  .gv-chatgpt-handoff-button:hover {
    border-color: color-mix(in srgb, currentColor 26%, transparent);
    background: color-mix(in srgb, currentColor 9%, Canvas);
  }
  .gv-chatgpt-handoff-button:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
  .gv-chatgpt-handoff-button:disabled { opacity: 0.58; cursor: wait; }
  .gv-chatgpt-handoff-button--floating {
    position: fixed;
    top: 60px;
    right: 16px;
    z-index: 2147483000;
    color: #1f2937;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 3px 16px rgba(0, 0, 0, 0.15);
    backdrop-filter: blur(10px);
  }
  .gv-chatgpt-handoff-button-icon { width: 17px; height: 17px; flex: none; }

  .gv-chatgpt-handoff-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483003;
    display: grid;
    place-items: center;
    padding: 18px;
    background: rgba(0, 0, 0, 0.48);
    backdrop-filter: blur(3px);
  }
  .gv-chatgpt-handoff-dialog {
    width: min(520px, 100%);
    overflow: hidden;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 18px;
    color: #171717;
    background: #fff;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.26);
  }
  .gv-chatgpt-handoff-dialog-title {
    margin: 0;
    padding: 22px 24px 10px;
    font: 650 20px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .gv-chatgpt-handoff-dialog-body {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 24px 22px;
    color: #6b7280;
    font: 14px/1.55 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .gv-chatgpt-handoff-dialog-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 9px;
    padding: 14px 24px;
    border-top: 1px solid rgba(0, 0, 0, 0.09);
  }
  .gv-chatgpt-handoff-dialog-attribution {
    min-width: 0;
    margin-inline-end: auto;
    overflow: hidden;
    color: #6b7280;
    font: 400 11px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gv-chatgpt-handoff-dialog-attribution:hover { color: #4b5563; }
  .gv-chatgpt-handoff-dialog-attribution:focus-visible {
    border-radius: 3px;
    outline: 1px solid currentColor;
    outline-offset: 3px;
  }
  .gv-chatgpt-handoff-dialog-button {
    flex: none;
    min-height: 38px;
    padding: 8px 15px;
    border: 1px solid rgba(0, 0, 0, 0.13);
    border-radius: 10px;
    color: inherit;
    background: transparent;
    font: inherit;
    white-space: nowrap;
    cursor: pointer;
  }
  .gv-chatgpt-handoff-dialog-button:hover { background: #f3f4f6; }
  .gv-chatgpt-handoff-dialog-button--primary {
    border-color: #111;
    color: #fff;
    background: #111;
  }
  .gv-chatgpt-handoff-dialog-button--primary:hover { background: #292929; }
  .gv-chatgpt-handoff-spinner {
    width: 24px;
    height: 24px;
    flex: none;
    border: 3px solid #d1d5db;
    border-top-color: #111;
    border-radius: 50%;
    animation: gv-chatgpt-handoff-spin 0.8s linear infinite;
  }
  @keyframes gv-chatgpt-handoff-spin { to { transform: rotate(360deg); } }

  .gv-chatgpt-handoff-toast {
    position: fixed;
    left: 50%;
    bottom: 28px;
    z-index: 2147483004;
    max-width: min(560px, calc(100vw - 28px));
    padding: 11px 15px;
    border-radius: 11px;
    color: #fff;
    background: #202020;
    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.25);
    font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    transform: translateX(-50%);
  }
  .gv-chatgpt-handoff-toast--error { background: #991b1b; }

  html.dark .gv-chatgpt-handoff-dialog,
  html.dark-theme .gv-chatgpt-handoff-dialog,
  body.dark-theme .gv-chatgpt-handoff-dialog,
  [data-theme='dark'] .gv-chatgpt-handoff-dialog {
    border-color: rgba(255, 255, 255, 0.14);
    color: #f5f5f5;
    background: #212121;
  }
  html.dark .gv-chatgpt-handoff-dialog-body,
  html.dark-theme .gv-chatgpt-handoff-dialog-body,
  body.dark-theme .gv-chatgpt-handoff-dialog-body,
  [data-theme='dark'] .gv-chatgpt-handoff-dialog-body { color: #a3a3a3; }
  html.dark .gv-chatgpt-handoff-dialog-attribution,
  html.dark-theme .gv-chatgpt-handoff-dialog-attribution,
  body.dark-theme .gv-chatgpt-handoff-dialog-attribution,
  [data-theme='dark'] .gv-chatgpt-handoff-dialog-attribution { color: #8b8b8b; }
  html.dark .gv-chatgpt-handoff-dialog-attribution:hover,
  html.dark-theme .gv-chatgpt-handoff-dialog-attribution:hover,
  body.dark-theme .gv-chatgpt-handoff-dialog-attribution:hover,
  [data-theme='dark'] .gv-chatgpt-handoff-dialog-attribution:hover { color: #d4d4d4; }
  html.dark .gv-chatgpt-handoff-dialog-footer,
  html.dark-theme .gv-chatgpt-handoff-dialog-footer,
  body.dark-theme .gv-chatgpt-handoff-dialog-footer,
  [data-theme='dark'] .gv-chatgpt-handoff-dialog-footer {
    border-top-color: rgba(255, 255, 255, 0.1);
  }
  html.dark .gv-chatgpt-handoff-dialog-button:not(.gv-chatgpt-handoff-dialog-button--primary),
  html.dark-theme .gv-chatgpt-handoff-dialog-button:not(.gv-chatgpt-handoff-dialog-button--primary),
  body.dark-theme .gv-chatgpt-handoff-dialog-button:not(.gv-chatgpt-handoff-dialog-button--primary),
  [data-theme='dark']
    .gv-chatgpt-handoff-dialog-button:not(.gv-chatgpt-handoff-dialog-button--primary) {
    border-color: rgba(255, 255, 255, 0.14);
  }
  html.dark .gv-chatgpt-handoff-dialog-button:hover,
  html.dark-theme .gv-chatgpt-handoff-dialog-button:hover,
  body.dark-theme .gv-chatgpt-handoff-dialog-button:hover,
  [data-theme='dark'] .gv-chatgpt-handoff-dialog-button:hover { background: #303030; }
  html.dark .gv-chatgpt-handoff-button--floating,
  html.dark-theme .gv-chatgpt-handoff-button--floating,
  body.dark-theme .gv-chatgpt-handoff-button--floating,
  [data-theme='dark'] .gv-chatgpt-handoff-button--floating {
    color: #f5f5f5;
    background: rgba(33, 33, 33, 0.94);
  }
  body.gv-rtl .gv-chatgpt-handoff-button--floating { right: auto; left: 16px; }

  @media (max-width: 520px) {
    .gv-chatgpt-handoff-button { width: 36px; padding: 0; }
    .gv-chatgpt-handoff-button-label { display: none; }
    .gv-chatgpt-handoff-dialog-title { padding: 18px 18px 8px; }
    .gv-chatgpt-handoff-dialog-body { padding: 0 18px 18px; }
    .gv-chatgpt-handoff-dialog-footer { flex-wrap: wrap; padding: 12px 18px; }
    .gv-chatgpt-handoff-dialog-attribution { font-size: 10px; }
    .gv-chatgpt-handoff-dialog-attribution-prefix { display: none; }
  }
  @media (max-width: 400px) {
    .gv-chatgpt-handoff-dialog-attribution {
      flex-basis: 100%;
      margin-inline-end: 0;
    }
  }
`;
