import type { SiteAdapter, SiteCapability } from '../../types';

/**
 * ChatGPT adapter (chatgpt.com + legacy chat.openai.com).
 *
 * NOTE: third-party site selectors are best-effort and may break when the site
 * redesigns — same caveat as Gemini. Keep selectors here so a break is a
 * one-file adapter fix, never a change across every plugin.
 */
export const chatgptAdapter: SiteAdapter = {
  id: 'chatgpt',
  label: 'ChatGPT',
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  selectors: {
    userTurn: '[data-message-author-role="user"]',
    assistantTurn: '[data-message-author-role="assistant"], [class*="group/imagegen-image"]',
    composer: '#prompt-textarea, div[contenteditable="true"]',
    sidebar: 'nav[aria-label], #stage-slideover-sidebar',
  },
  theme: {
    hostSelector: 'html',
    lightSelector: 'html.light',
    darkSelector: 'html.dark',
  },
  brandColor: '#0ea5e9', // ChatGPT sky blue
  capabilities: new Set<SiteCapability>(['chat', 'sidebar', 'composer', 'darkMode']),
};
