import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createSlashPromptLifecycle } from '../slashPrompt';

describe('prompt manager lifecycle', () => {
  it('drives slash completion only from its independent sync setting', () => {
    const slashFeatureCode = readFileSync(
      resolve(process.cwd(), 'src/pages/content/prompt/slashPromptFeature.ts'),
      'utf8',
    );
    const promptManagerCode = readFileSync(
      resolve(process.cwd(), 'src/pages/content/prompt/index.ts'),
      'utf8',
    );

    expect(slashFeatureCode).toContain('StorageKeys.SLASH_PROMPT_ENABLED');
    expect(slashFeatureCode).not.toContain('gvHidePromptManager');
    expect(slashFeatureCode).not.toContain('HIDE_PROMPT_MANAGER');
    expect(promptManagerCode).not.toContain('SLASH_PROMPT_ENABLED');
    expect(promptManagerCode).not.toContain('setSlashPromptEnabled');
  });

  it('marks duplicate-name prompts with a persistent non-blocking badge', () => {
    const code = readFileSync(resolve(process.cwd(), 'src/pages/content/prompt/index.ts'), 'utf8');

    expect(code).toContain('const nameConflictIds = getPromptNameConflictIds(items);');
    expect(code).toContain("createEl('span', 'gv-pm-chip gv-pm-name-conflict')");
    expect(code).toContain("i18n.t('pm_name_conflict_badge')");
  });

  it('destroys slash completion while hidden and starts one fresh controller when restored', async () => {
    const firstDestroy = vi.fn();
    const secondDestroy = vi.fn();
    const start = vi
      .fn()
      .mockResolvedValueOnce({ destroy: firstDestroy })
      .mockResolvedValueOnce({ destroy: secondDestroy });
    const lifecycle = createSlashPromptLifecycle(start);

    await lifecycle.setEnabled(true);
    await lifecycle.setEnabled(true);
    expect(start).toHaveBeenCalledTimes(1);

    await lifecycle.setEnabled(false);
    expect(firstDestroy).toHaveBeenCalledTimes(1);

    await lifecycle.setEnabled(true);
    expect(start).toHaveBeenCalledTimes(2);

    lifecycle.destroy();
    expect(secondDestroy).toHaveBeenCalledTimes(1);
  });

  it('destroys a controller that finishes starting after the feature was hidden', async () => {
    let resolveStart!: (controller: { destroy: () => void }) => void;
    const pendingController = new Promise<{ destroy: () => void }>((resolve) => {
      resolveStart = resolve;
    });
    const destroy = vi.fn();
    const start = vi.fn(() => pendingController);
    const lifecycle = createSlashPromptLifecycle(start);

    const enabling = lifecycle.setEnabled(true);
    await lifecycle.setEnabled(false);
    resolveStart({ destroy });
    await enabling;

    expect(start).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
