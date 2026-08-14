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

  it('includes the ChatGPT export native function plugin scoped to ChatGPT', () => {
    const exportPlugin = BUILTIN_PLUGINS.find((m) => m.id === 'voyager.chatgpt-export');
    expect(exportPlugin).toBeDefined();
    expect(exportPlugin?.matches).toEqual(['https://chatgpt.com/*', 'https://chat.openai.com/*']);
    expect(exportPlugin?.contributes.styles ?? []).toEqual([]);
    expect(exportPlugin?.contributes.domOps ?? []).toEqual([]);
    expect(exportPlugin?.i18n?.zh?.name).toBe('ChatGPT · 对话导出');
  });

  it('keeps temporary-chat handoff separate from conversation export', () => {
    const handoff = BUILTIN_PLUGINS.find(
      (plugin) => plugin.id === 'voyager.chatgpt-temporary-handoff',
    );
    expect(handoff).toBeDefined();
    expect(handoff?.matches).toEqual(['https://chatgpt.com/*', 'https://chat.openai.com/*']);
    expect(handoff?.contributes.styles ?? []).toEqual([]);
    expect(handoff?.contributes.domOps ?? []).toEqual([]);
    expect(handoff?.i18n?.zh?.name).toBe('ChatGPT · 临时对话反悔');
    expect(handoff?.i18n?.zh_TW?.name).toBe('ChatGPT · 暫時對話反悔');
    expect(handoff?.id).not.toBe('voyager.chatgpt-export');
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

  it('does not expose the retired Claude usage plugin', () => {
    const usage = BUILTIN_PLUGINS.find((m) => m.id === 'voyager.claude-usage');
    expect(usage).toBeUndefined();
  });
});
