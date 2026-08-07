import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/core/services/LoggerService';

import {
  getNativeHandler,
  registerNativeHandler,
  resetNativeHandlersForTests,
  verifyNativeHandlerBindings,
} from './nativeHandlers';

afterEach(() => {
  resetNativeHandlersForTests();
});

describe('nativeHandlers registry', () => {
  it('returns undefined for an unregistered id', () => {
    expect(getNativeHandler('nope.absent')).toBeUndefined();
  });

  it('stores and retrieves a registered handler', () => {
    const handler = { start: vi.fn(), stop: vi.fn() };
    registerNativeHandler('test.handler', handler);
    expect(getNativeHandler('test.handler')).toBe(handler);
  });

  it('ignores a duplicate registration — first wins, and the bug is logged', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const a = { start: vi.fn() };
      const b = { start: vi.fn() };
      registerNativeHandler('test.dup', a);
      registerNativeHandler('test.dup', b);
      expect(getNativeHandler('test.dup')).toBe(a);
      expect(errorSpy).toHaveBeenCalledWith(
        'Duplicate native handler registration ignored',
        expect.objectContaining({ id: 'test.dup' }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('verifyNativeHandlerBindings', () => {
  it('passes when handlers exactly match the native id list', () => {
    registerNativeHandler('test.a', { start: vi.fn() });
    registerNativeHandler('test.b', { stop: vi.fn() });
    expect(verifyNativeHandlerBindings(['test.a', 'test.b'])).toEqual([]);
  });

  it('reports a native builtin with no handler (dead toggle)', () => {
    registerNativeHandler('test.a', { start: vi.fn() });
    const problems = verifyNativeHandlerBindings(['test.a', 'test.missing']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('test.missing');
  });

  it('reports a handler whose id is not a declared native builtin (typo)', () => {
    registerNativeHandler('test.typo', { start: vi.fn() });
    const problems = verifyNativeHandlerBindings([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('test.typo');
  });
});
