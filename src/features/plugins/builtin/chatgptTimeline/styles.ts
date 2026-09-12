export const CHATGPT_TIMELINE_ROOT_CLASS = 'gv-chatgpt-timeline-enabled';

/** ChatGPT-only contrast overrides layered on Voyager's shared Timeline styles. */
export const CHATGPT_TIMELINE_CSS = `
  html.${CHATGPT_TIMELINE_ROOT_CLASS} {
    --timeline-dot-color: #64748b;
    --timeline-dot-active-color: var(--gv-pm-brand, #5f8f55);
    --timeline-dot-active-glow: rgba(100, 116, 139, 0.55);
    --timeline-bar-bg: #cbd5e1;
    --gv-chatgpt-timeline-edge: #64748b;
    --gv-chatgpt-timeline-halo: #ffffff;
    --timeline-tooltip-bg: #ffffff;
    --timeline-tooltip-text: #0f172a;
    --timeline-tooltip-border: #cbd5e1;
    --timeline-search-bg: rgba(15, 23, 42, 0.06);
  }

  html.${CHATGPT_TIMELINE_ROOT_CLASS}.dark,
  html.${CHATGPT_TIMELINE_ROOT_CLASS}.dark-theme,
  html.${CHATGPT_TIMELINE_ROOT_CLASS}[data-theme='dark'],
  html.${CHATGPT_TIMELINE_ROOT_CLASS}[data-color-scheme='dark'],
  html.${CHATGPT_TIMELINE_ROOT_CLASS} body.dark-theme {
    --timeline-dot-color: #e2e8f0;
    --timeline-dot-active-color: var(--gv-pm-brand, #a7c080);
    --timeline-bar-bg: #64748b;
    --gv-chatgpt-timeline-edge: #94a3b8;
    --gv-chatgpt-timeline-halo: #111827;
    --timeline-tooltip-bg: #111827;
    --timeline-tooltip-text: #f1f5f9;
    --timeline-tooltip-border: #475569;
    --timeline-search-bg: rgba(255, 255, 255, 0.08);
  }

  html.${CHATGPT_TIMELINE_ROOT_CLASS}
    .gemini-timeline-bar[data-gv-chatgpt-timeline='true'] {
    --timeline-bar-width: 5px;
  }

  html.${CHATGPT_TIMELINE_ROOT_CLASS}
    .gemini-timeline-bar[data-gv-chatgpt-timeline='true']::before {
    /* Visibility must not depend on color-mix or GPU backdrop compositing. */
    background-color: var(--timeline-bar-bg, #cbd5e1);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    box-shadow:
      0 0 0 1px var(--gv-chatgpt-timeline-edge, #64748b),
      0 2px 12px rgba(0, 0, 0, 0.14);
  }

  html.${CHATGPT_TIMELINE_ROOT_CLASS}
    .gemini-timeline-bar[data-gv-chatgpt-timeline='true']
    .timeline-track {
    scrollbar-width: none;
  }

  html.${CHATGPT_TIMELINE_ROOT_CLASS}
    .gemini-timeline-bar[data-gv-chatgpt-timeline='true']
    .timeline-track::-webkit-scrollbar {
    display: none;
  }

  html.${CHATGPT_TIMELINE_ROOT_CLASS}
    .gemini-timeline-bar[data-gv-chatgpt-timeline='true']
    .timeline-dot:not(.active):not(.starred)::after {
    background-color: var(--timeline-dot-color, #64748b);
    box-shadow: 0 0 0 1px var(--gv-chatgpt-timeline-halo, #ffffff);
  }

  html.${CHATGPT_TIMELINE_ROOT_CLASS}
    .gemini-timeline-bar[data-gv-chatgpt-timeline='true']
    .timeline-dot:not(.active):not(.starred):hover::after {
    background-color: var(--timeline-dot-active-color, #5f8f55);
    box-shadow: 0 0 0 2px var(--gv-chatgpt-timeline-edge, #64748b);
  }

  html.${CHATGPT_TIMELINE_ROOT_CLASS}
    .gemini-timeline-bar[data-gv-chatgpt-timeline='true']
    .timeline-dot.active::after {
    background-color: var(--timeline-dot-active-color, #5f8f55);
  }

  html.${CHATGPT_TIMELINE_ROOT_CLASS}
    .gemini-timeline-bar[data-gv-chatgpt-timeline='true']:not(.timeline-style-compact)
    .timeline-dot.active::after {
    box-shadow:
      0 0 0 var(--timeline-active-ring, 3px) var(--timeline-dot-active-color, #5f8f55),
      0 0 0 4px var(--gv-chatgpt-timeline-edge, #64748b),
      0 0 14px var(--timeline-dot-active-glow, rgba(100, 116, 139, 0.55));
  }

  html.${CHATGPT_TIMELINE_ROOT_CLASS}
    .gemini-timeline-bar[data-gv-chatgpt-timeline='true']
    .timeline-dot.starred::after {
    background-color: var(--timeline-star-color, #f59e0b);
  }

  html.${CHATGPT_TIMELINE_ROOT_CLASS}
    .gemini-timeline-bar[data-gv-chatgpt-timeline='true'].timeline-style-compact
    .timeline-dot::after {
    /* Retain compact ticks and the hidden rail, without translucent tick fills. */
    opacity: 1;
  }

  html.${CHATGPT_TIMELINE_ROOT_CLASS} .timeline-preview-panel {
    background-color: #ffffff;
    color: #0f172a;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  html.${CHATGPT_TIMELINE_ROOT_CLASS}.dark .timeline-preview-panel,
  html.${CHATGPT_TIMELINE_ROOT_CLASS}.dark-theme .timeline-preview-panel,
  html.${CHATGPT_TIMELINE_ROOT_CLASS}[data-theme='dark'] .timeline-preview-panel,
  html.${CHATGPT_TIMELINE_ROOT_CLASS}[data-color-scheme='dark'] .timeline-preview-panel,
  html.${CHATGPT_TIMELINE_ROOT_CLASS} body.dark-theme .timeline-preview-panel {
    background-color: #111827;
    color: #f1f5f9;
  }

  html.${CHATGPT_TIMELINE_ROOT_CLASS} #gv-chatgpt-timeline-tooltip {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }
`;
