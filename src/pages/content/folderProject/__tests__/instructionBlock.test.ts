import { describe, expect, it } from 'vitest';

import {
  buildInstructionBlock,
  hasInstructionBlock,
  normalizeInstructionBlockText,
  stripInstructionBlock,
  stripInstructionBlockPreservingWhitespace,
} from '../instructionBlock';

describe('instructionBlock', () => {
  it('builds a system instruction block with project context', () => {
    const block = buildInstructionBlock('Research', 'Always cite sources.');

    expect(block).toContain('[System Instructions]');
    expect(block).toContain('Project: Research');
    expect(block).toContain('Always cite sources.');
    expect(block).toContain('[/System Instructions]');
  });

  it('strips a prepended instruction block while preserving user text', () => {
    const text = `${buildInstructionBlock('Research', 'Always cite sources.')}User prompt`;

    expect(stripInstructionBlock(text)).toBe('User prompt');
  });

  it('detects instruction blocks after Quill-style newline normalization', () => {
    const quillText = `${buildInstructionBlock('Research', 'Always cite sources.')}`.replace(
      /\n/g,
      '\n\n',
    );

    expect(normalizeInstructionBlockText(quillText)).toContain('[System Instructions]');
    expect(hasInstructionBlock(quillText)).toBe(true);
  });

  it('keeps the existing normalized strip semantics for folder and draft callers', () => {
    expect(stripInstructionBlock('First paragraph\n\nSecond paragraph')).toBe(
      'First paragraph\nSecond paragraph',
    );
  });

  it('strips the injected block without collapsing user blank paragraphs', () => {
    const userText = 'First paragraph\n\nSecond paragraph';

    expect(stripInstructionBlockPreservingWhitespace(userText)).toBe(userText);
    expect(
      stripInstructionBlockPreservingWhitespace(
        `${buildInstructionBlock('Research', 'Always cite sources.')}${userText}`,
      ),
    ).toBe(userText);
  });
});
