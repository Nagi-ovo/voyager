import { describe, expect, it } from 'vitest';

import {
  isValidSelectorSyntax,
  siteAdapterToData,
  validateSiteAdapterData,
} from './siteAdapterData';

const VALID = {
  id: 'deepseek',
  label: 'DeepSeek',
  matches: ['https://chat.deepseek.com/*'],
  selectors: {
    userTurn: '.ds-message.user',
    composer: 'textarea.ds-scroll-area',
  },
  theme: { hostSelector: 'body', lightSelector: 'body.light', darkSelector: 'body.dark' },
  brandColor: '#4d6bfe',
  capabilities: ['chat', 'composer', 'darkMode'],
  conversationIdPattern: '^/a/chat/s/([^/?#]+)',
};

function issuesOf(raw: unknown): string[] {
  const result = validateSiteAdapterData(raw);
  return result.success ? [] : result.error.map((issue) => issue.path);
}

describe('validateSiteAdapterData', () => {
  it('accepts a complete site.json and builds a SiteAdapter with a capability Set', () => {
    const result = validateSiteAdapterData(VALID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.id).toBe('deepseek');
    expect(result.data.capabilities).toEqual(new Set(['chat', 'composer', 'darkMode']));
    expect(result.data.selectors).toEqual(VALID.selectors);
    expect(result.data.conversationIdPattern).toBe('^/a/chat/s/([^/?#]+)');
  });

  it('round-trips through siteAdapterToData', () => {
    const result = validateSiteAdapterData(VALID);
    if (!result.success) throw new Error('fixture must validate');
    const data = siteAdapterToData(result.data);
    expect(data).toEqual({ ...VALID, capabilities: ['chat', 'composer', 'darkMode'] });
    expect(validateSiteAdapterData(data)).toEqual(result);
  });

  it('rejects selector keys outside the semantic vocabulary', () => {
    expect(issuesOf({ ...VALID, selectors: { ...VALID.selectors, messageBubble: '.x' } })).toEqual([
      'selectors.messageBubble',
    ]);
  });

  it('rejects malformed ids, labels, matches, colours, capabilities and patterns', () => {
    expect(issuesOf({ ...VALID, id: 'Deep Seek' })).toEqual(['id']);
    expect(issuesOf({ ...VALID, label: '' })).toEqual(['label']);
    expect(issuesOf({ ...VALID, matches: [] })).toEqual(['matches']);
    expect(issuesOf({ ...VALID, matches: ['chat.deepseek.com'] })).toEqual(['matches']);
    expect(issuesOf({ ...VALID, brandColor: 'blue' })).toEqual(['brandColor']);
    expect(issuesOf({ ...VALID, capabilities: ['chat', 'voice'] })).toEqual(['capabilities[1]']);
    expect(issuesOf({ ...VALID, conversationIdPattern: '(' })).toEqual(['conversationIdPattern']);
    expect(issuesOf({ ...VALID, conversationIdPattern: '^/(a+)+$' })).toEqual([
      'conversationIdPattern',
    ]);
    expect(issuesOf({ ...VALID, theme: { hostSelector: 'body' } })).toEqual([
      'theme.lightSelector',
      'theme.darkSelector',
    ]);
    expect(issuesOf(null)).toEqual(['']);
  });

  it('rejects selectors that do not parse instead of letting the engine skip them silently', () => {
    expect(issuesOf({ ...VALID, selectors: { ...VALID.selectors, userTurn: '[' } })).toEqual([
      'selectors.userTurn',
    ]);
    expect(issuesOf({ ...VALID, theme: { ...VALID.theme, darkSelector: 'body]' } })).toEqual([
      'theme.darkSelector',
    ]);
    expect(isValidSelectorSyntax('.ds-message:has(.x):not([data-a="b"])')).toBe(true);
    // Without a DOM the structural fallback still catches unbalanced input.
    const doc = globalThis.document;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: undefined });
    try {
      expect(isValidSelectorSyntax('div[data-x="a]"]')).toBe(true);
      expect(isValidSelectorSyntax('div[data-x')).toBe(false);
      expect(isValidSelectorSyntax('a:not(.b')).toBe(false);
      expect(isValidSelectorSyntax("a[title='x]")).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
    }
  });

  it('treats brandColor, capabilities and conversationIdPattern as optional', () => {
    const { brandColor, capabilities, conversationIdPattern, ...minimal } = VALID;
    void brandColor;
    void capabilities;
    void conversationIdPattern;
    const result = validateSiteAdapterData(minimal);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.brandColor).toBeUndefined();
    expect(result.data.capabilities.size).toBe(0);
    expect(result.data.conversationIdPattern).toBeUndefined();
  });
});
