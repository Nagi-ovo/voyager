import { describe, expect, it } from 'vitest';

import { isPluginPopupSite } from './siteMode';

describe('isPluginPopupSite', () => {
  it('treats known plugin platforms as plugin popup sites without marketplace manifests', () => {
    expect(isPluginPopupSite('https://chatgpt.com/c/abc', [])).toBe(true);
    expect(isPluginPopupSite('https://chat.openai.com/c/abc', [])).toBe(true);
    expect(isPluginPopupSite('https://claude.ai/chat/abc', [])).toBe(true);
    expect(isPluginPopupSite('https://grok.com/', [])).toBe(true);
    expect(isPluginPopupSite('https://chat.deepseek.com/a/chat/s/abc', [])).toBe(true);
  });

  it('keeps native sites on the full popup even if manifests target them', () => {
    expect(isPluginPopupSite('https://gemini.google.com/app', [])).toBe(false);
    expect(isPluginPopupSite('https://aistudio.google.com/', [])).toBe(false);
    expect(isPluginPopupSite('https://gemini.google.com/app', [{}])).toBe(false);
  });

  it('treats arbitrary third-party web pages as plugin-only popup sites', () => {
    expect(isPluginPopupSite('https://deepseek.com/', [])).toBe(true);
    expect(isPluginPopupSite('https://example.com/', [])).toBe(true);
    expect(isPluginPopupSite('http://localhost:3000/', [])).toBe(true);
  });

  it('does not switch browser or extension pages into plugin popup mode', () => {
    expect(isPluginPopupSite('', [])).toBe(false);
    expect(isPluginPopupSite('chrome://extensions/', [])).toBe(false);
    expect(isPluginPopupSite('chrome-extension://abc/popup.html', [])).toBe(false);
  });
});
