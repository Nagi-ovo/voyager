import { afterEach, describe, expect, it } from 'vitest';

import { NATIVE_BUILTIN_PLUGIN_IDS } from '@/features/plugins/builtin';
import {
  getNativeHandler,
  resetNativeHandlersForTests,
} from '@/features/plugins/runtime/nativeHandlers';

import { NATIVE_HANDLER_BINDINGS, registerBuiltinNativeHandlers } from './pluginNativeRegistration';

afterEach(() => {
  resetNativeHandlersForTests();
});

describe('pluginNativeRegistration', () => {
  it('binding table keys exactly match the native builtin manifest ids', () => {
    // A BUILTIN_PLUGINS entry without a handler is a dead toggle; a handler
    // without a manifest is unreachable. Both directions must fail here, at
    // test time, not as a runtime log line.
    expect(Object.keys(NATIVE_HANDLER_BINDINGS).sort()).toEqual(
      [...NATIVE_BUILTIN_PLUGIN_IDS].sort(),
    );
  });

  it('registerBuiltinNativeHandlers registers a handler for every native id', () => {
    registerBuiltinNativeHandlers();
    for (const id of NATIVE_BUILTIN_PLUGIN_IDS) {
      expect(getNativeHandler(id)).toBeDefined();
    }
  });
});
