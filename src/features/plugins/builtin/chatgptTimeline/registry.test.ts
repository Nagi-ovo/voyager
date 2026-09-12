import { describe, expect, it } from 'vitest';

import {
  CHATGPT_TURN_ID_ATTRIBUTE,
  collectChatGptTurnShells,
} from '@/features/plugins/sites/chatgptDom';

import { ChatGptTimelineRegistry } from './registry';

function shell(id: string, role?: 'user' | 'assistant', text = ''): HTMLElement {
  const container = document.createElement('article');
  container.setAttribute(CHATGPT_TURN_ID_ATTRIBUTE, id);
  if (role) {
    const message = document.createElement('div');
    message.dataset.messageAuthorRole = role;
    message.textContent = text;
    container.appendChild(message);
  }
  return container;
}

function collect(...containers: HTMLElement[]) {
  const root = document.createElement('main');
  root.append(...containers);
  return collectChatGptTurnShells(root);
}

describe('ChatGptTimelineRegistry', () => {
  it('uses stable shell ids and reconciles duplicate/remounted shells', () => {
    const registry = new ChatGptTimelineRegistry();
    const emptyDuplicate = shell('turn-1');
    const mountedDuplicate = shell('turn-1', 'user', 'stable prompt');

    registry.merge(collect(emptyDuplicate, mountedDuplicate), () => 100);

    expect(registry.size).toBe(1);
    expect(registry.get('turn-1')).toMatchObject({
      id: 'turn-1',
      role: 'user',
      summary: 'stable prompt',
      element: mountedDuplicate,
    });

    const remount = shell('turn-1', 'user', 'stable prompt updated');
    registry.merge(collect(remount), () => 120);
    expect(registry.size).toBe(1);
    expect(registry.get('turn-1')?.element).toBe(remount);
    expect(registry.get('turn-1')?.summary).toBe('stable prompt updated');
  });

  it('keeps a grow-only ordered registry across overlapping virtual windows', () => {
    const registry = new ChatGptTimelineRegistry();
    registry.merge(
      collect(shell('two', 'user', 'two'), shell('three', 'user', 'three')),
      (element) => (element.textContent === 'two' ? 200 : 300),
    );
    registry.merge(collect(shell('one', 'user', 'one'), shell('two', 'user', 'two')), (element) =>
      element.textContent === 'one' ? 100 : 200,
    );
    registry.merge(
      collect(shell('three', 'user', 'three'), shell('four', 'user', 'four')),
      (element) => (element.textContent === 'three' ? 300 : 400),
    );

    expect(registry.all().map((turn) => turn.id)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('preserves cached role and summary while a retained shell has unmounted inner content', () => {
    const registry = new ChatGptTimelineRegistry();
    registry.merge(collect(shell('user-1', 'user', 'cached prompt')), () => 100);
    const retainedShell = shell('user-1');

    registry.merge(collect(retainedShell), () => 140);

    expect(registry.get('user-1')).toMatchObject({
      role: 'user',
      summary: 'cached prompt',
      element: retainedShell,
      center: 140,
    });
    expect(registry.userTurns().map((turn) => turn.id)).toEqual(['user-1']);
  });

  it('tracks assistant and unknown shells without projecting them as timeline markers', () => {
    const registry = new ChatGptTimelineRegistry();
    registry.merge(
      collect(
        shell('user-1', 'user', 'prompt'),
        shell('assistant-1', 'assistant', 'answer'),
        shell('pending-1'),
      ),
      () => 0,
    );

    expect(registry.all().map((turn) => turn.role)).toEqual(['user', 'assistant', 'unknown']);
    expect(registry.userTurns().map((turn) => turn.id)).toEqual(['user-1']);
  });
});
