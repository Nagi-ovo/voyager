import { describe, expect, it } from 'vitest';

import { NATIVE_SITE_IDS, SiteRegistry, resolvePluginPlatformId } from './registry';

describe('SiteRegistry.resolveByUrl', () => {
  const registry = SiteRegistry.createDefault();

  it('resolves the first-party adapters by URL', () => {
    expect(registry.resolveByUrl('https://gemini.google.com/app')?.id).toBe('gemini');
    expect(registry.resolveByUrl('https://aistudio.google.com/')?.id).toBe('aistudio');
    expect(registry.resolveByUrl('https://chatgpt.com/c/abc')?.id).toBe('chatgpt');
    expect(registry.resolveByUrl('https://chat.openai.com/c/abc')?.id).toBe('chatgpt');
    expect(registry.resolveByUrl('https://claude.ai/chat/abc')?.id).toBe('claude');
  });

  it('returns null for sites with no adapter', () => {
    expect(registry.resolveByUrl('https://example.com/')).toBeNull();
  });
});

describe('resolvePluginPlatformId', () => {
  it('returns the platform id for third-party plugin platforms', () => {
    expect(resolvePluginPlatformId('https://chatgpt.com/c/abc')).toBe('chatgpt');
    expect(resolvePluginPlatformId('https://chat.openai.com/')).toBe('chatgpt');
    expect(resolvePluginPlatformId('https://claude.ai/chat/abc')).toBe('claude');
    expect(resolvePluginPlatformId('https://grok.com/')).toBe('grok');
  });

  it('returns null for native Voyager sites (full feature set runs there)', () => {
    expect(resolvePluginPlatformId('https://gemini.google.com/app')).toBeNull();
    expect(resolvePluginPlatformId('https://aistudio.google.com/')).toBeNull();
    for (const id of NATIVE_SITE_IDS) {
      expect(['gemini', 'aistudio']).toContain(id);
    }
  });

  it('returns null for sites Voyager ships no adapter for', () => {
    expect(resolvePluginPlatformId('https://example.com/')).toBeNull();
    expect(resolvePluginPlatformId('https://deepseek.com/')).toBeNull();
  });
});
