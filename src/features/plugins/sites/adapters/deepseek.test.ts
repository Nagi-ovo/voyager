import { afterEach, describe, expect, it } from 'vitest';

import { deepseekAdapter } from './deepseek';

afterEach(() => {
  document.body.innerHTML = '';
  document.body.removeAttribute('class');
});

describe('DeepSeek content markers', () => {
  it('distinguishes user, thinking-only, final and empty virtual turns', () => {
    document.body.innerHTML =
      '<div class="ds-message" id="user"><div class="ds-collapsible-text">Example</div></div>' +
      '<div class="ds-message" id="thinking"><div class="ds-think-content">Working</div></div>' +
      '<div class="ds-message" id="answer"><div class="ds-assistant-message-main-content">Answer</div></div>' +
      '<div class="ds-message" id="pending"></div>' +
      '<div class="ds-collapsible-text">Unrelated preview</div>';
    const ids = (selector: string) =>
      Array.from(document.querySelectorAll(selector), (el) => el.id);
    expect(ids(deepseekAdapter.selectors.userTurn)).toEqual(['user']);
    expect(ids(deepseekAdapter.selectors.assistantTurn)).toEqual(['thinking', 'answer']);
    document
      .querySelector('#thinking')
      ?.insertAdjacentHTML(
        'beforeend',
        '<div class="ds-assistant-message-main-content">Finished</div>',
      );
    expect(ids(deepseekAdapter.selectors.assistantTurn)).toEqual(['thinking', 'answer']);
    expect(ids(deepseekAdapter.selectors.userTurn)).toEqual(['user']);
  });

  it('finds the composer without matching unrelated editors', () => {
    document.body.innerHTML =
      '<textarea placeholder="Search"></textarea>' +
      '<textarea class="ds-scroll-area" placeholder="Message DeepSeek" id="composer"></textarea>' +
      '<div contenteditable="true"></div>';
    expect(document.querySelectorAll(deepseekAdapter.selectors.composer)).toHaveLength(1);
    expect(document.querySelector(deepseekAdapter.selectors.composer)?.id).toBe('composer');
  });

  it.each(['light', 'dark'])('recognizes the body %s theme', (theme) => {
    document.body.className = 'zh_CN ' + theme;
    expect(document.querySelector(deepseekAdapter.theme.hostSelector)).toBe(document.body);
    expect(document.querySelector(deepseekAdapter.theme.lightSelector) !== null).toBe(
      theme === 'light',
    );
    expect(document.querySelector(deepseekAdapter.theme.darkSelector) !== null).toBe(
      theme === 'dark',
    );
  });
});
