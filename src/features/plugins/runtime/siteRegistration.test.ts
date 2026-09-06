import { describe, expect, it } from 'vitest';

import type { PluginManifest } from '../types';
import {
  partitionPluginOriginPatterns,
  pluginToOriginPatternsForActiveUrl,
  pluginsToOriginPatterns,
} from './siteRegistration';

function mk(matches: string[]): PluginManifest {
  return {
    id: 'x',
    name: 'x',
    version: '1.0.0',
    description: 'd',
    author: 'a',
    category: 'render-fix',
    license: 'MIT',
    engine: '>=1.0.0',
    tier: 'declarative',
    matches,
    contributes: {},
  };
}

describe('pluginsToOriginPatterns', () => {
  it('derives an origin pattern from a match pattern', () => {
    expect(pluginsToOriginPatterns([mk(['https://claude.ai/*'])])).toEqual(['https://claude.ai/*']);
  });

  it('dedupes and sorts origins across plugins', () => {
    const result = pluginsToOriginPatterns([
      mk(['https://claude.ai/*']),
      mk(['https://chatgpt.com/*', 'https://claude.ai/*']),
    ]);
    expect(result).toEqual(['https://chatgpt.com/*', 'https://claude.ai/*']);
  });

  it('normalizes a scheme wildcard to https', () => {
    expect(pluginsToOriginPatterns([mk(['*://claude.ai/*'])])).toEqual(['https://claude.ai/*']);
  });

  it('ignores <all_urls>', () => {
    expect(pluginsToOriginPatterns([mk(['<all_urls>'])])).toEqual([]);
  });
});

describe('pluginToOriginPatternsForActiveUrl', () => {
  const chatgptPlugin = mk(['https://chatgpt.com/*', 'https://chat.openai.com/*']);
  const deepseekPlugin = mk(['https://chat.deepseek.com/*', 'https://chat.deepseek.com/a/chat/*']);
  const claudeArtifactPlugin = mk([
    'https://claude.ai/*',
    'https://*.frame.claudeusercontent.com/*',
  ]);

  it('requests only the currently open ChatGPT origin', () => {
    expect(
      pluginToOriginPatternsForActiveUrl(
        chatgptPlugin,
        'https://chatgpt.com/c/current-conversation',
      ),
    ).toEqual(['https://chatgpt.com/*']);
  });

  it('keeps all declared origins outside the plugin site', () => {
    expect(
      pluginToOriginPatternsForActiveUrl(chatgptPlugin, 'https://gemini.google.com/app'),
    ).toEqual(['https://chat.openai.com/*', 'https://chatgpt.com/*']);
  });

  it('includes Claude artifact frames when enabling from the parent site', () => {
    expect(
      pluginToOriginPatternsForActiveUrl(
        claudeArtifactPlugin,
        'https://claude.ai/code/artifact/example',
      ),
    ).toEqual(['https://*.frame.claudeusercontent.com/*', 'https://claude.ai/*']);
  });

  it('requests only the DeepSeek chat origin from a DeepSeek page', () => {
    expect(
      pluginToOriginPatternsForActiveUrl(
        deepseekPlugin,
        'https://chat.deepseek.com/a/chat/s/current',
      ),
    ).toEqual(['https://chat.deepseek.com/*']);
  });

  it('does not expand DeepSeek permission scope for an unrelated active page', () => {
    expect(pluginToOriginPatternsForActiveUrl(deepseekPlugin, 'https://example.com/')).toEqual([
      'https://chat.deepseek.com/*',
    ]);
  });
});

describe('partitionPluginOriginPatterns', () => {
  it('limits child-frame injection to explicit companion origins', () => {
    expect(
      partitionPluginOriginPatterns([
        'https://claude.ai/*',
        'https://*.frame.claudeusercontent.com/*',
        'https://chatgpt.com/*',
      ]),
    ).toEqual({
      topFrameOrigins: ['https://claude.ai/*', 'https://chatgpt.com/*'],
      embeddedFrameOrigins: ['https://*.frame.claudeusercontent.com/*'],
    });
  });
});
