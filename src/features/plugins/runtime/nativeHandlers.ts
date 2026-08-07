/**
 * Native handler registry for first-party "builtin function plugins".
 *
 * A declarative plugin ships only CSS+JSON and cannot run JS. Some first-party
 * features (e.g. formula copy) genuinely need JS but should still be managed by
 * the plugin lifecycle — visible + toggleable in the plugin list, scoped by the
 * manifest's `matches`. For such a builtin plugin the manifest carries no
 * executable code; instead the content script registers a native handler under
 * the SAME plugin id, and the declarative engine runs its `start`/`stop` in
 * lockstep with mount/unmount.
 *
 * The handler is ALWAYS first-party code bundled in the extension — never
 * plugin-authored or remotely fetched. Marketplace manifests cannot reach this:
 * only code we ship calls `registerNativeHandler`.
 */
import { logger } from '@/core/services/LoggerService';

import type { PluginSettings } from '../types';
import type { PluginScope } from './pluginScope';

export interface NativeHandler {
  /**
   * Scope-based lifecycle (preferred): runs when the plugin mounts, registers
   * every side effect through the scope, and needs NO stop — the engine
   * disposes the scope on unmount, which aborts `scope.signal`, awaits any
   * in-flight startup, and pays every registered effect in reverse order.
   * May be async. Mutually exclusive with `start`/`stop`.
   */
  readonly activate?: (scope: PluginScope, settings: PluginSettings) => void | Promise<void>;
  /** Legacy: run when the plugin mounts (URL matches + enabled). Idempotent. */
  readonly start?: (settings: PluginSettings) => void;
  /** Apply changed settings without tearing down the native feature. */
  readonly updateSettings?: (settings: PluginSettings) => void;
  /** Legacy: run when the plugin unmounts (disabled, or navigated away). */
  readonly stop?: () => void;
}

const registry = new Map<string, NativeHandler>();

/**
 * Bind a first-party start/stop pair to a builtin plugin id.
 *
 * Duplicate registration is a wiring bug (two features claiming one plugin
 * id). The first registration wins and the duplicate is reported, never
 * silently swapped in — a thrown error here would kill the whole content
 * script, so this fails safe instead.
 */
export function registerNativeHandler(pluginId: string, handler: NativeHandler): void {
  if (registry.has(pluginId)) {
    logger.error('Duplicate native handler registration ignored', { id: pluginId });
    return;
  }
  registry.set(pluginId, handler);
}

/** Look up the native handler for a plugin id, if one was registered. */
export function getNativeHandler(pluginId: string): NativeHandler | undefined {
  return registry.get(pluginId);
}

/**
 * Verify the manifest ↔ handler binding after all registrations and before
 * `startPluginHost()`. Scoped to the native builtin ids passed in — bundled
 * catalog (pure CSS/JSON) plugins have no handlers by design and must not be
 * checked. Returns the problems so tests can assert on them; logs each one so
 * a typo'd id surfaces as an error instead of a toggle that does nothing.
 */
export function verifyNativeHandlerBindings(nativeIds: readonly string[]): string[] {
  const problems: string[] = [];
  for (const id of nativeIds) {
    if (!registry.has(id)) problems.push(`native builtin "${id}" has no registered handler`);
  }
  const known = new Set(nativeIds);
  for (const id of registry.keys()) {
    if (!known.has(id)) problems.push(`handler "${id}" is not a declared native builtin`);
  }
  for (const problem of problems) {
    logger.error('Native handler binding mismatch', { problem });
  }
  return problems;
}

/** Test-only: wipe the registry between cases. */
export function resetNativeHandlersForTests(): void {
  registry.clear();
}
