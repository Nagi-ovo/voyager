import { describe, expect, it } from 'vitest';

import {
  getLegacyTurnIndex,
  isServerTurnId,
  makeServerTurnId,
  makeStableTurnId,
  makeTurnId,
  normalizeTurnId,
  readServerTurnId,
} from '../turnId';

describe('turnId', () => {
  it('should create stable turn IDs from index', () => {
    expect(makeStableTurnId(0)).toBe('u-0');
    expect(makeStableTurnId(3)).toBe('u-3');
  });

  it('should normalize legacy hashed turn IDs', () => {
    expect(normalizeTurnId('u-0-abcd')).toBe('u-0');
    expect(normalizeTurnId('u-12-xyz')).toBe('u-12');
  });

  it('should keep non-user turn IDs unchanged', () => {
    expect(normalizeTurnId('custom-id')).toBe('custom-id');
  });

  it('derives a stable id from Gemini response containers', () => {
    const container = document.createElement('div');
    container.className = 'conversation-container';
    container.id = 'B6EB23222C6B10A2';
    const turn = document.createElement('div');
    container.appendChild(turn);

    expect(readServerTurnId(turn)).toBe('s-b6eb23222c6b10a2');
    expect(makeTurnId(turn, 60)).toBe('s-b6eb23222c6b10a2');
    expect(isServerTurnId('s-b6eb23222c6b10a2')).toBe(true);
  });

  it('normalizes response ids from either RPC or DOM form', () => {
    expect(makeServerTurnId('r_b6eb23222c6b10a2')).toBe('s-b6eb23222c6b10a2');
    expect(makeServerTurnId('b6eb23222c6b10a2')).toBe('s-b6eb23222c6b10a2');
    expect(makeServerTurnId('not-a-response-id')).toBeNull();
  });

  it('reads only legacy positional indexes and keeps a safe fallback', () => {
    expect(getLegacyTurnIndex('u-60')).toBe(60);
    expect(getLegacyTurnIndex('u-60-old-hash')).toBe(60);
    expect(getLegacyTurnIndex('u-60~ccontent-hash')).toBe(60);
    expect(getLegacyTurnIndex('s-b6eb23222c6b10a2')).toBeNull();
    expect(makeTurnId(document.createElement('div'), 60)).toBe('u-60');
  });
});
