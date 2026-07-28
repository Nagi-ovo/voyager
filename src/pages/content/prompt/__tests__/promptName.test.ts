import { describe, expect, it } from 'vitest';

import { getPromptNameConflictIds, isPromptNameTaken, normalizePromptName } from '../promptName';

describe('normalizePromptName', () => {
  it('trims a required prompt name', () => {
    expect(normalizePromptName('  Code review  ')).toBe('Code review');
  });

  it('rejects a blank prompt name', () => {
    expect(normalizePromptName('   ')).toBeNull();
  });

  it('treats trimmed, case-only, and Unicode-width variants as the same name', () => {
    const items = [{ id: 'one', name: 'Code Review' }];

    expect(isPromptNameTaken(items, '  code review  ')).toBe(true);
    expect(isPromptNameTaken([{ id: 'one', name: 'Ｐｒｏｍｐｔ' }], 'Prompt')).toBe(true);
  });

  it('excludes the prompt being edited and ignores legacy unnamed prompts', () => {
    const items = [
      { id: 'legacy' },
      { id: 'editing', name: 'Translator' },
      { id: 'other', name: 'Summarizer' },
    ];

    expect(isPromptNameTaken(items, 'Translator', 'editing')).toBe(false);
    expect(isPromptNameTaken(items, 'Summarizer', 'editing')).toBe(true);
  });

  it('allows a legacy duplicate-name item to keep its name while editing other fields', () => {
    const items = [
      { id: 'first', name: 'Translator' },
      { id: 'editing', name: 'Ｔｒａｎｓｌａｔｏｒ' },
      { id: 'other', name: 'Summarizer' },
    ];

    expect(isPromptNameTaken(items, 'translator', 'editing')).toBe(false);
    expect(isPromptNameTaken(items, 'Summarizer', 'editing')).toBe(true);
  });

  it('groups normalized duplicate names and clears conflicts after a unique rename', () => {
    const items = [
      { id: 'first', name: ' Translator ' },
      { id: 'second', name: 'Ｔｒａｎｓｌａｔｏｒ' },
      { id: 'unique', name: 'Summarizer' },
      { id: 'legacy' },
    ];

    expect(Array.from(getPromptNameConflictIds(items)).sort()).toEqual(['first', 'second']);

    items[1].name = 'Editor';

    expect(Array.from(getPromptNameConflictIds(items))).toEqual([]);
  });
});
