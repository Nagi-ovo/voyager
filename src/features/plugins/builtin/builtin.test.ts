import { describe, expect, it } from 'vitest';

import { validateManifest } from '../manifest/validate';
import { BUILTIN_PLUGINS } from './index';

describe('BUILTIN_PLUGINS', () => {
  it('every builtin manifest passes validation', () => {
    for (const m of BUILTIN_PLUGINS) {
      expect(validateManifest(m).success).toBe(true);
    }
  });

  it('includes the formula-copy native function plugin scoped to Claude/ChatGPT', () => {
    const fc = BUILTIN_PLUGINS.find((m) => m.id === 'voyager.formula-copy');
    expect(fc).toBeDefined();
    expect(fc?.matches).toEqual([
      'https://claude.ai/*',
      'https://chatgpt.com/*',
      'https://chat.openai.com/*',
    ]);
    // No declarative contributions — its behaviour comes from a native handler.
    expect(fc?.contributes.styles ?? []).toEqual([]);
    expect(fc?.contributes.domOps ?? []).toEqual([]);
    expect(fc?.i18n?.zh?.name).toBe('公式复制');
    expect(fc?.i18n?.ja?.description).toContain('LaTeX');
  });

  it('includes the input Vim native function plugin scoped to Claude/ChatGPT', () => {
    const vim = BUILTIN_PLUGINS.find((m) => m.id === 'voyager.input-vim');
    expect(vim).toBeDefined();
    expect(vim?.matches).toEqual([
      'https://claude.ai/*',
      'https://chatgpt.com/*',
      'https://chat.openai.com/*',
    ]);
    expect(vim?.contributes.styles ?? []).toEqual([]);
    expect(vim?.contributes.domOps ?? []).toEqual([]);
    expect(vim?.i18n?.zh?.name).toBe('Vim 输入');
  });

  it('includes the Claude timeline native function plugin', () => {
    const timeline = BUILTIN_PLUGINS.find((m) => m.id === 'voyager.claude-timeline');
    expect(timeline).toBeDefined();
    expect(timeline?.matches).toEqual(['https://claude.ai/*']);
    expect(timeline?.contributes.styles ?? []).toEqual([]);
    expect(timeline?.contributes.domOps ?? []).toEqual([]);
    expect(timeline?.contributes.settings?.compactView).toEqual({
      type: 'boolean',
      label: 'Use compact timeline',
      default: false,
    });
    expect(timeline?.i18n?.zh?.name).toBe('Claude · 时间线');
    expect(timeline?.i18n?.zh?.settings?.compactView?.label).toBe('使用紧凑索引');
  });

  it('includes the ChatGPT conversation export native function plugin', () => {
    const exporter = BUILTIN_PLUGINS.find((m) => m.id === 'voyager.chatgpt-export');
    expect(exporter).toBeDefined();
    expect(exporter?.matches).toEqual(['https://chatgpt.com/*', 'https://chat.openai.com/*']);
    expect(exporter?.contributes.styles ?? []).toEqual([]);
    expect(exporter?.contributes.domOps ?? []).toEqual([]);
    expect(exporter?.i18n?.zh?.name).toBe('ChatGPT 对话导出');
    expect(exporter?.description).not.toContain('PNG');
    expect(exporter?.i18n?.zh?.description).not.toContain('PNG');
  });

  it('does not expose the retired Claude usage plugin', () => {
    const usage = BUILTIN_PLUGINS.find((m) => m.id === 'voyager.claude-usage');
    expect(usage).toBeUndefined();
  });
});
