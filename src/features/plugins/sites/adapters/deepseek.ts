import type { SiteAdapter, SiteCapability } from '../../types';

/**
 * DeepSeek web app adapter (chat.deepseek.com).
 *
 * DeepSeek renders both user and assistant turns as ds-message elements.
 * Match positive content markers: an unfinished assistant turn must never
 * become a user turn simply because its final answer has not mounted yet.
 */
export const deepseekAdapter: SiteAdapter = {
  id: 'deepseek',
  label: 'DeepSeek',
  matches: ['https://chat.deepseek.com/*'],
  selectors: {
    userTurn:
      '.ds-message:has(.ds-collapsible-text):not(:has(.ds-assistant-message-main-content, .ds-think-content))',
    assistantTurn: '.ds-message:has(.ds-assistant-message-main-content, .ds-think-content)',
    composer: 'textarea.ds-scroll-area[placeholder*="DeepSeek" i]',
  },
  theme: {
    hostSelector: 'body',
    lightSelector: 'body.light',
    darkSelector: 'body.dark',
  },
  brandColor: '#4d6bfe',
  capabilities: new Set<SiteCapability>(['chat', 'composer', 'darkMode']),
};
