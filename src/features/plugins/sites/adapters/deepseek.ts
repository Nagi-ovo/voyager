import type { SiteAdapter, SiteCapability } from '../../types';

/**
 * DeepSeek web app adapter (chat.deepseek.com).
 *
 * DeepSeek renders both user and assistant turns as ds-message elements.
 * Assistant turns expose ds-assistant-message-main-content; using that
 * stable semantic marker keeps the user selector independent of hashed classes.
 */
export const deepseekAdapter: SiteAdapter = {
  id: 'deepseek',
  label: 'DeepSeek',
  matches: ['https://chat.deepseek.com/*'],
  selectors: {
    userTurn: '.ds-message:not(:has(.ds-assistant-message-main-content))',
    assistantTurn: '.ds-message:has(.ds-assistant-message-main-content)',
    composer: 'textarea[placeholder*="DeepSeek"], textarea[placeholder*="Deepseek"]',
    sidebar: 'nav, aside',
  },
  theme: {
    hostSelector: 'body',
    lightSelector: 'body.light',
    darkSelector: 'body.dark',
  },
  brandColor: '#4d6bfe',
  capabilities: new Set<SiteCapability>(['chat', 'sidebar', 'composer', 'darkMode']),
};
