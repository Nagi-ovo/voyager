import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { isHandledBackgroundRuntimeMessage } from '../runtimeMessageRouting';

describe('background runtime message routing', () => {
  it('keeps the async channel open only for exact handled message types', () => {
    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.account.resolve' })).toBe(true);
    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.highlight.list' })).toBe(true);
    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.sync.upload' })).toBe(true);

    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.highlight.unknown' })).toBe(false);
    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.storageQuota.ready' })).toBe(false);
    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.unhandled' })).toBe(false);
    expect(isHandledBackgroundRuntimeMessage(null)).toBe(false);
  });

  it('uploads the complete prompt union even when duplicate names remain', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/background/index.ts'), 'utf8');
    const pushBranch =
      source.match(
        /case 'gv\.sync\.pushPromptsMerge': \{[\s\S]*?case 'gv\.sync\.getState': \{/,
      )?.[0] ?? '';

    expect(pushBranch).toContain('googleDriveSyncService.uploadPromptsOnly');
    expect(pushBranch).toContain('nameConflicts: getPromptNameConflictIds(localPrompts).size');
    expect(pushBranch).not.toContain('if (merged.data.nameConflicts > 0)');
    expect(pushBranch).not.toContain('skipped: true');
  });
});
