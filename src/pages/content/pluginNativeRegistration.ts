/**
 * The single wiring table between builtin plugin manifests (BUILTIN_PLUGINS)
 * and their first-party native handlers. Kept as data so a test can compare
 * its keys against NATIVE_BUILTIN_PLUGIN_IDS — adding a manifest without a
 * handler (or vice versa) fails the suite instead of shipping a dead toggle.
 */
import { activateFormulaCopy } from '@/features/formulaCopy';
import { NATIVE_BUILTIN_PLUGIN_IDS } from '@/features/plugins/builtin';
import {
  startChatGptExportPlugin,
  stopChatGptExportPlugin,
} from '@/features/plugins/builtin/chatgptExport/runtime';
import { activateChatGptTemporaryHandoff } from '@/features/plugins/builtin/chatgptTemporaryHandoff';
import {
  activateClaudeTimeline,
  updateClaudeTimelineSettings,
} from '@/features/plugins/builtin/claudeTimeline';
import { activateInputVimPlugin } from '@/features/plugins/builtin/inputVim';
import {
  type NativeHandler,
  registerNativeHandler,
  verifyNativeHandlerBindings,
} from '@/features/plugins/runtime/nativeHandlers';

export const NATIVE_HANDLER_BINDINGS: Readonly<Record<string, NativeHandler>> = {
  'voyager.formula-copy': {
    activate: activateFormulaCopy,
  },
  'voyager.input-vim': {
    activate: activateInputVimPlugin,
  },
  'voyager.claude-timeline': {
    activate: activateClaudeTimeline,
    updateSettings: updateClaudeTimelineSettings,
  },
  'voyager.chatgpt-export': {
    start: startChatGptExportPlugin,
    stop: stopChatGptExportPlugin,
  },
  'voyager.chatgpt-temporary-handoff': {
    activate: activateChatGptTemporaryHandoff,
  },
};

/**
 * Register every builtin native handler and verify the two-way manifest ↔
 * handler binding. Must run unconditionally, before `startPluginHost()`.
 */
export function registerBuiltinNativeHandlers(): void {
  for (const [id, handler] of Object.entries(NATIVE_HANDLER_BINDINGS)) {
    registerNativeHandler(id, handler);
  }
  verifyNativeHandlerBindings(NATIVE_BUILTIN_PLUGIN_IDS);
}
