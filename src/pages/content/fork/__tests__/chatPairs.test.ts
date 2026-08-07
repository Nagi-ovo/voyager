import { describe, expect, it } from 'vitest';

import { DOMContentExtractor } from '@/features/export/services/DOMContentExtractor';
import { resolveExportAdapter } from '@/pages/content/export/adapter/platformAdapters';

import { collectForkChatPairs } from '../chatPairs';

DOMContentExtractor.setExportAdapter(resolveExportAdapter());

describe('collectForkChatPairs', () => {
  it('should collect user and assistant pairs from chat DOM', () => {
    document.body.innerHTML = `
      <main>
        <div class="user-query-container">
          <div class="user-query-bubble-with-background">user-1</div>
        </div>
        <div class="response-container">
          <div class="markdown-main-panel">assistant-1</div>
        </div>
        <div class="user-query-container">
          <div class="user-query-bubble-with-background">user-2</div>
        </div>
        <div class="response-container">
          <div class="markdown-main-panel">assistant-2</div>
        </div>
      </main>
    `;

    const userContainers = document.querySelectorAll<HTMLElement>('.user-query-container');
    const responseContainers = document.querySelectorAll<HTMLElement>('.response-container');
    Object.defineProperty(userContainers[0], 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(responseContainers[0], 'offsetTop', { value: 100, configurable: true });
    Object.defineProperty(userContainers[1], 'offsetTop', { value: 200, configurable: true });
    Object.defineProperty(responseContainers[1], 'offsetTop', { value: 300, configurable: true });

    const pairs = collectForkChatPairs();
    expect(pairs).toHaveLength(2);
    expect(pairs[0].user).toContain('user-1');
    expect(pairs[0].assistant).toContain('assistant-1');
    expect(pairs[1].user).toContain('user-2');
    expect(pairs[1].assistant).toContain('assistant-2');
    expect(pairs[0].turnId).toBe('u-0');
    expect(pairs[1].turnId).toBe('u-1');
  });
});
