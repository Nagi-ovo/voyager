import type { HighlightRecordV1 } from '@/core/types/highlight';

export function selectText(root: HTMLElement, exact: string): Range {
  const textNode = root.firstChild;
  if (!(textNode instanceof Text)) throw new Error('Expected a text node');
  const start = textNode.data.indexOf(exact);
  if (start < 0) throw new Error(`Could not find ${exact}`);
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, start + exact.length);
  return range;
}

export function makeRecord(
  anchor: HighlightRecordV1['anchor'],
  overrides: Partial<HighlightRecordV1> = {},
): HighlightRecordV1 {
  return {
    id: 'highlight-1',
    schemaVersion: 1,
    platform: 'gemini',
    accountHash: 'account-hash',
    conversationId: 'gemini:conv:test',
    conversationUrl: 'https://gemini.google.com/app/test',
    conversationTitle: 'Test',
    turnId: 's-1111111111111111',
    role: 'assistant',
    anchor,
    color: 'yellow',
    createdAt: 1,
    updatedAt: 1,
    revision: { counter: 1, deviceId: 'device-1' },
    ...overrides,
  };
}

export function installConversation(responseText = 'Alpha target Omega'): HTMLElement {
  document.body.innerHTML = `
    <main>
      <div class="conversation-container" id="1111111111111111">
        <div class="user-query-bubble-with-background">Question</div>
        <model-response><message-content id="response"></message-content></model-response>
      </div>
    </main>
    <div class="gemini-timeline-bar">
      <div class="timeline-track"><div class="timeline-track-content"></div></div>
    </div>
  `;
  const response = document.getElementById('response');
  if (!(response instanceof HTMLElement)) throw new Error('Expected response root');
  response.textContent = responseText;
  return response;
}
