import { describe, expect, it } from 'vitest';

import { isSafeRegexSource } from './safeRegex';

describe('isSafeRegexSource', () => {
  it('accepts the anchored capture patterns site files use', () => {
    expect(isSafeRegexSource('^/chat/([^/?#]+)')).toBe(true);
    expect(isSafeRegexSource('^/a/chat/s/([^/?#]+)')).toBe(true);
    expect(isSafeRegexSource('^/c/([0-9a-f-]{36})')).toBe(true);
  });

  it('rejects lookarounds, backreferences, nested quantifiers, junk and oversized sources', () => {
    expect(isSafeRegexSource('^(?=/chat)/chat/(.*)')).toBe(false);
    expect(isSafeRegexSource('^/(\\w+)/\\1')).toBe(false);
    expect(isSafeRegexSource('^/(a+)+$')).toBe(false);
    expect(isSafeRegexSource('^/(\\w*)*$')).toBe(false);
    expect(isSafeRegexSource('(')).toBe(false);
    expect(isSafeRegexSource('')).toBe(false);
    expect(isSafeRegexSource('a'.repeat(201))).toBe(false);
  });
});
