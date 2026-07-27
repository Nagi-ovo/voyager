import type { SiteAdapter, SiteCapability } from '../../types';

/**
 * Claude.ai adapter. Best-effort selectors (see chatgpt.ts caveat).
 */
export const claudeAdapter: SiteAdapter = {
  id: 'claude',
  label: 'Claude',
  matches: ['https://claude.ai/*'],
  selectors: {
    userTurn: '[data-testid="user-message"]',
    assistantTurn: '.font-claude-message, [data-testid="assistant-message"]',
    composer: 'div[contenteditable="true"].ProseMirror',
    sidebar: 'nav[aria-label], [data-testid="menu-sidebar"]',
  },
  theme: {
    hostSelector: ':root',
    lightSelector: ':root:not(.dark)',
    darkSelector: ':root.dark',
  },
  brandColor: '#d97757', // Claude clay / terracotta
  capabilities: new Set<SiteCapability>(['chat', 'sidebar', 'composer', 'darkMode']),
};
