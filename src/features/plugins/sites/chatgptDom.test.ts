import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHATGPT_TURN_ID_ATTRIBUTE,
  classifyChatGptScrollTarget,
  collectChatGptTurnShells,
  findChatGptChatScrollRoot,
  getChatGptRouteChange,
  getChatGptTurnId,
  getChatGptTurnRole,
  parseChatGptRoute,
} from './chatgptDom';

function turnShell(id: string, role?: 'user' | 'assistant'): HTMLElement {
  const shell = document.createElement('article');
  shell.setAttribute(CHATGPT_TURN_ID_ATTRIBUTE, id);
  if (role) {
    const message = document.createElement('div');
    message.dataset.messageAuthorRole = role;
    shell.appendChild(message);
  }
  return shell;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('ChatGPT timeline route contract', () => {
  it.each([
    ['https://chatgpt.com/c/first', null, null, 'first', 'conversation'],
    ['https://chatgpt.com/u/7/c/first', '7', null, 'first', 'conversation'],
    [
      'https://chatgpt.com/u/team%201/g/g-example/c/turn%202',
      'team 1',
      'g-example',
      'turn 2',
      'conversation',
    ],
    ['https://chat.openai.com/u/12/', '12', null, null, 'home'],
    ['https://chatgpt.com/g/g-example', null, 'g-example', null, 'gpt'],
    ['https://chatgpt.com/settings', null, null, null, 'other'],
  ])('parses %s', (url, workspaceId, gptId, conversationId, kind) => {
    expect(parseChatGptRoute(url!)).toMatchObject({
      workspaceId,
      gptId,
      conversationId,
      kind,
    });
  });

  it('rejects foreign hosts and non-HTTPS URLs, but tolerates malformed escape sequences', () => {
    expect(parseChatGptRoute('https://example.com/c/not-chatgpt')).toBeNull();
    expect(parseChatGptRoute('http://chatgpt.com/c/insecure')).toBeNull();
    expect(parseChatGptRoute('https://chatgpt.com/c/%ZZ')?.conversationId).toBe('%ZZ');
  });

  it('reports SPA and workspace changes while ignoring hash-only navigation', () => {
    expect(
      getChatGptRouteChange(
        'https://chatgpt.com/c/first#top',
        'https://chatgpt.com/c/first#bottom',
      ),
    ).toBeNull();
    expect(
      getChatGptRouteChange('https://chatgpt.com/c/first', 'https://chatgpt.com/u/7/c/first')
        ?.current,
    ).toMatchObject({ workspaceId: '7', conversationId: 'first' });
    expect(
      getChatGptRouteChange(
        'https://chatgpt.com/c/first',
        'https://chatgpt.com/c/second?model=auto',
      )?.current.routeKey,
    ).toBe('https://chatgpt.com/c/second?model=auto');
  });
});

describe('ChatGPT retained turn shells', () => {
  it('collects stable IDs in DOM order and excludes native bookkeeping roots', () => {
    document.body.append(
      turnShell(' turn-a ', 'user'),
      turnShell('client-created-root', 'assistant'),
      turnShell('paginated-root:conversation-a', 'assistant'),
      turnShell('turn-b', 'assistant'),
      turnShell(''),
    );
    expect(
      collectChatGptTurnShells().map(({ id, sequence, role }) => ({
        id,
        sequence,
        role,
      })),
    ).toEqual([
      { id: 'turn-a', sequence: 0, role: 'user' },
      { id: 'turn-b', sequence: 1, role: 'assistant' },
    ]);
  });

  it('reconciles a mounted duplicate without changing first-seen order', () => {
    const emptyFirst = turnShell('turn-a');
    const secondTurn = turnShell('turn-b', 'user');
    const mountedDuplicate = turnShell('turn-a', 'assistant');
    document.body.append(emptyFirst, secondTurn, mountedDuplicate, turnShell('turn-a'));
    const shells = collectChatGptTurnShells();
    expect(shells.map(({ id, sequence }) => ({ id, sequence }))).toEqual([
      { id: 'turn-a', sequence: 0 },
      { id: 'turn-b', sequence: 1 },
    ]);
    expect(shells[0]).toMatchObject({
      role: 'assistant',
      container: mountedDuplicate,
    });
  });

  it('discovers native message roles, retained frame roles and image-only assistants', () => {
    const user = turnShell(' user-id ', 'user');
    const image = turnShell('image-id');
    image.innerHTML = '<div class="group/imagegen-image-v2"><img></div>';
    const frame = turnShell('frame-id');
    frame.innerHTML = '<section data-turn="assistant"></section>';
    expect(getChatGptTurnId(user)).toBe('user-id');
    expect(getChatGptTurnRole(user)).toBe('user');
    expect(getChatGptTurnRole(image)).toBe('assistant');
    expect(getChatGptTurnRole(frame)).toBe('assistant');
    expect(getChatGptTurnRole(frame.firstElementChild!)).toBe('assistant');
    expect(getChatGptTurnRole(turnShell('unknown'))).toBe('unknown');
    expect(getChatGptTurnId(document.createElement('div'))).toBeNull();
  });

  it('handles detached fragments and inner-content unmount/remount without changing native IDs', () => {
    const fragment = document.createDocumentFragment();
    const shell = turnShell('retained', 'user');
    fragment.appendChild(shell);
    expect(shell.isConnected).toBe(false);
    expect(collectChatGptTurnShells(fragment)[0]).toMatchObject({
      id: 'retained',
      role: 'user',
    });
    shell.replaceChildren();
    expect(collectChatGptTurnShells(fragment)[0]).toMatchObject({
      id: 'retained',
      role: 'unknown',
      container: shell,
    });
    shell.innerHTML = '<div data-message-author-role="user">Remounted text</div>';
    expect(collectChatGptTurnShells(fragment)[0]).toMatchObject({
      id: 'retained',
      role: 'user',
    });
  });
});

describe('ChatGPT sidebar and chat scroll classification', () => {
  it('finds the nearest chat viewport and does not confuse sidebar interaction with chat scrolling', () => {
    document.body.innerHTML =
      '<nav aria-label="Chat history"><a href="/c/first"><span>Conversation</span></a></nav><main style="overflow-y:auto"><section></section></main><aside></aside>';
    const viewport = document.querySelector('main')!;
    Object.defineProperties(viewport, {
      clientHeight: { value: 500 },
      scrollHeight: { value: 1500 },
    });
    const shell = turnShell('turn-a', 'user');
    viewport.querySelector('section')!.appendChild(shell);
    const scroll = vi.spyOn(window, 'scrollTo');
    expect(findChatGptChatScrollRoot()).toBe(viewport);
    expect(findChatGptChatScrollRoot(shell)).toBe(viewport);
    expect(classifyChatGptScrollTarget(document.querySelector('nav span'))).toBe('sidebar');
    expect(classifyChatGptScrollTarget(viewport)).toBe('chat');
    expect(classifyChatGptScrollTarget(shell.firstElementChild)).toBe('chat');
    expect(classifyChatGptScrollTarget(document.querySelector('aside'))).toBe('other');
    expect(classifyChatGptScrollTarget(null)).toBe('other');
    expect(scroll).not.toHaveBeenCalled();
  });

  it('classifies the native slideover sidebar and safely falls back on an empty conversation', () => {
    document.body.innerHTML = '<div id="stage-slideover-sidebar"><div></div></div>';
    expect(
      classifyChatGptScrollTarget(document.querySelector('#stage-slideover-sidebar div')),
    ).toBe('sidebar');
    expect(findChatGptChatScrollRoot()).toBe(document.scrollingElement ?? document.documentElement);
    expect(classifyChatGptScrollTarget(window)).toBe('chat');
    expect(classifyChatGptScrollTarget(document)).toBe('chat');
  });
});
