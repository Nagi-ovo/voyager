import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const observerScript = readFileSync(
  resolve(process.cwd(), 'public/claude-usage-observer.js'),
  'utf-8',
);

type ClaudeUsageWindow = Window &
  typeof globalThis & {
    __gvClaudeUsageObserverInstalled?: boolean;
  };

function installObserver(): void {
  // oxlint-disable-next-line no-eval -- evaluating the observer under test is what this suite exercises
  (0, eval)(observerScript);
}

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function streamResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('claude-usage-observer', () => {
  beforeEach(() => {
    delete (window as ClaudeUsageWindow).__gvClaudeUsageObserverInstalled;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts message_limit payloads from Claude event streams', async () => {
    const payload = {
      windows: {
        '5h': { utilization: 0.12, resets_at: 1_782_642_600 },
        '7d': { utilization: 0.46, resets_at: 1_782_646_200 },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      streamResponse(
        `event: message_limit\ndata: ${JSON.stringify({
          type: 'message_limit',
          message_limit: payload,
        })}\n\n`,
      ),
    );
    Object.defineProperty(window, 'fetch', {
      value: fetchMock,
      writable: true,
      configurable: true,
    });
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);

    installObserver();
    await window.fetch('/api/organizations/org/chat_conversations/chat/completion', {
      method: 'POST',
    });
    await flushAsyncWork();

    expect(postSpy).toHaveBeenCalledWith(
      { source: 'gv-claude-usage-observer', type: 'message-limit', payload },
      location.origin,
    );
  });
});
