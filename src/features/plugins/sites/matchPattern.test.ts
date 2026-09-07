import { describe, expect, it } from 'vitest';

import { matchesAnyPattern, matchesUrl, patternWithin } from './matchPattern';

describe('matchPattern', () => {
  it('matches exact host + path wildcard', () => {
    expect(matchesUrl('https://claude.ai/chat/123', 'https://claude.ai/*')).toBe(true);
    expect(matchesUrl('https://claude.ai/', 'https://claude.ai/*')).toBe(true);
  });

  it('does not match a different host', () => {
    expect(matchesUrl('https://chatgpt.com/c/1', 'https://claude.ai/*')).toBe(false);
  });

  it('supports scheme wildcard', () => {
    expect(matchesUrl('http://claude.ai/x', '*://claude.ai/*')).toBe(true);
    expect(matchesUrl('https://claude.ai/x', '*://claude.ai/*')).toBe(true);
  });

  it('supports subdomain wildcard', () => {
    expect(matchesUrl('https://chat.openai.com/c/1', 'https://*.openai.com/*')).toBe(true);
    expect(matchesUrl('https://openai.com/c/1', 'https://*.openai.com/*')).toBe(false);
  });

  it('<all_urls> matches any http(s) url', () => {
    expect(matchesUrl('https://anything.example/x', '<all_urls>')).toBe(true);
    expect(matchesUrl('ftp://nope/x', '<all_urls>')).toBe(false);
  });

  it('does not let a wildcard host leak across domains', () => {
    // Ensure the `.` in the pattern is escaped (not treated as regex any-char).
    expect(matchesUrl('https://claudexai/x', 'https://claude.ai/*')).toBe(false);
  });

  it('matchesAnyPattern returns true if any pattern matches', () => {
    expect(
      matchesAnyPattern('https://chat.openai.com/c/1', [
        'https://chatgpt.com/*',
        'https://chat.openai.com/*',
      ]),
    ).toBe(true);
    expect(matchesAnyPattern('https://grok.com/', ['https://claude.ai/*'])).toBe(false);
  });
});

describe('patternWithin (plan D18 containment)', () => {
  it('accepts a plugin scope that is the site scope or narrower', () => {
    expect(patternWithin('https://claude.ai/*', 'https://claude.ai/*')).toBe(true);
    expect(patternWithin('https://claude.ai/chat/*', 'https://claude.ai/*')).toBe(true);
    expect(patternWithin('https://x.example.com/*', 'https://*.example.com/*')).toBe(true);
    expect(patternWithin('https://example.com/*', 'https://*.example.com/*')).toBe(true);
    expect(patternWithin('https://claude.ai/*', '*://claude.ai/*')).toBe(true);
    expect(patternWithin('https://claude.ai/chat/s/*', 'https://claude.ai/chat/*')).toBe(true);
    expect(patternWithin('https://anything.test/*', '<all_urls>')).toBe(true);
  });

  it('rejects a wildcard host, a wider scheme or a wider path than the site allows', () => {
    // One probe URL (x.example.com) would have passed this; y.example.com escapes.
    expect(patternWithin('https://*.example.com/*', 'https://x.example.com/*')).toBe(false);
    expect(patternWithin('*://example.com/*', 'https://example.com/*')).toBe(false);
    expect(patternWithin('https://claude.ai/*', 'https://claude.ai/chat/*')).toBe(false);
    expect(patternWithin('https://chatgpt.com/*', 'https://claude.ai/*')).toBe(false);
    expect(patternWithin('<all_urls>', 'https://claude.ai/*')).toBe(false);
    expect(patternWithin('garbage', 'https://claude.ai/*')).toBe(false);
  });
});
