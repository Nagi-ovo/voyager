import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOMContentExtractor } from '@/features/export/services/DOMContentExtractor';

import {
  buildChatGptTurnsForSelection,
  chatgptCollectTurnContainers,
  resolveChatGptSelectionRoles,
} from '../chatgpt';
import type { ExportPlatformAdapter } from '../platformAdapters';

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

beforeEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  DOMContentExtractor.setExportAdapter({
    extractUserImage: (element: HTMLElement) => element.querySelectorAll('img'),
    extractUserText: (
      _lines: NodeListOf<HTMLElement>,
      textParts: string[],
      element: HTMLElement,
    ) => {
      const text = DOMContentExtractor.normalizeText(element.textContent || '');
      if (text) textParts.push(text);
    },
    getUserAttachmentCandidates: () => [],
    extractAssistantImage: () => undefined,
    extractFormula: () => undefined,
    extractCodeBlock: () => undefined,
    extractInlineFormula: () => undefined,
  } as unknown as ExportPlatformAdapter);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: originalScrollIntoView,
    });
  } else {
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

describe('chatgptCollectTurnContainers', () => {
  it('keeps only the first container for each stable turn id', () => {
    document.body.innerHTML = `
      <div data-turn-id-container="user-1">
        <div data-message-author-role="user">你好</div>
      </div>
      <div data-turn-id-container="user-1">
        <div data-message-author-role="user">你好</div>
      </div>
      <div data-turn-id-container="assistant-1">
        <div data-message-author-role="assistant">你好！</div>
      </div>
      <div data-turn-id-container="assistant-1">
        <div data-message-author-role="assistant">你好！</div>
      </div>
    `;

    const turns = chatgptCollectTurnContainers();

    expect(turns.map((turn) => turn.id)).toEqual(['user-1', 'assistant-1']);
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(turns.map((turn) => turn.sequence)).toEqual([0, 1]);
  });

  it('uses a mounted duplicate when the first container is an empty virtualized shell', () => {
    document.body.innerHTML = `
      <div data-turn-id-container="assistant-1"></div>
      <div data-turn-id-container="assistant-1">
        <div data-message-author-role="assistant">已加载回复</div>
      </div>
    `;

    const [turn] = chatgptCollectTurnContainers();

    expect(turn.role).toBe('assistant');
    expect(turn.container.textContent).toContain('已加载回复');
    expect(turn.sequence).toBe(0);
  });

  it('uses the zero-wait path for already mounted messages', async () => {
    document.body.innerHTML = `
      <div data-turn-id-container="user-1">
        <div data-message-author-role="user">First prompt</div>
      </div>
      <div data-turn-id-container="assistant-1">
        <div data-message-author-role="assistant">First answer</div>
      </div>
    `;

    const turns = await buildChatGptTurnsForSelection(new Set(['user-1', 'assistant-1']));

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ user: 'First prompt', assistant: 'First answer' });
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('does not pair non-adjacent selected messages', async () => {
    document.body.innerHTML = `
      <div data-turn-id-container="user-1"><div data-message-author-role="user">U1</div></div>
      <div data-turn-id-container="assistant-1"><div data-message-author-role="assistant">A1</div></div>
      <div data-turn-id-container="user-2"><div data-message-author-role="user">U2</div></div>
      <div data-turn-id-container="assistant-2"><div data-message-author-role="assistant">A2</div></div>
    `;

    const turns = await buildChatGptTurnsForSelection(new Set(['user-1', 'assistant-2']));

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ user: 'U1', assistant: '' });
    expect(turns[1]).toMatchObject({ user: '', assistant: 'A2' });
  });

  it('fails instead of silently exporting a partial selection', async () => {
    document.body.innerHTML = `
      <div data-turn-id-container="user-1"><div data-message-author-role="user">U1</div></div>
    `;

    await expect(
      buildChatGptTurnsForSelection(new Set(['user-1', 'missing-assistant'])),
    ).rejects.toThrow('chatgpt_export_messages_missing:missing-assistant');
  });

  it('fails when a selected virtual shell never mounts', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div data-turn-id-container="assistant-1"></div>`;

    const exportPromise = buildChatGptTurnsForSelection(new Set(['assistant-1']));
    const assertion = expect(exportPromise).rejects.toThrow(
      'chatgpt_export_message_unavailable:assistant-1',
    );
    await vi.advanceTimersByTimeAsync(3200);
    await assertion;
  });

  it('refuses to snapshot a response that is still streaming', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div data-turn-id-container="assistant-1" data-message-streaming="true">
        <div data-message-author-role="assistant">Partial answer</div>
      </div>
    `;

    const exportPromise = buildChatGptTurnsForSelection(new Set(['assistant-1']));
    const assertion = expect(exportPromise).rejects.toThrow(
      'chatgpt_export_response_still_generating',
    );
    await vi.advanceTimersByTimeAsync(3200);
    await assertion;
  });

  it('resolves all mounted roles used by role-only selection', async () => {
    document.body.innerHTML = `
      <div data-turn-id-container="user-1"><div data-message-author-role="user">U1</div></div>
      <div data-turn-id-container="assistant-1"><div data-message-author-role="assistant">A1</div></div>
    `;

    const roles = await resolveChatGptSelectionRoles(new Set(['user-1', 'assistant-1']));

    expect(Object.fromEntries(roles)).toEqual({ 'user-1': 'user', 'assistant-1': 'assistant' });
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('honors cancellation before collection starts', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      buildChatGptTurnsForSelection(new Set(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
