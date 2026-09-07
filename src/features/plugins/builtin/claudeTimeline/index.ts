/**
 * Claude timeline builtin — a thin shell over the `turnNavigator` primitive's
 * engine (`verbs/turnNavigator/TurnNavigator.ts`) with Claude's configuration.
 * The manifest in `builtin/index.ts` invokes the primitive through a `native`
 * op; these exports keep the historical ids, helpers and the standalone
 * start/stop wrappers that tests and non-engine callers use.
 */
import { PluginScope } from '@/features/plugins/runtime/pluginScope';
import type { PluginSettings } from '@/features/plugins/types';

import {
  TIMELINE_STYLE_COACHMARK_ID,
  type TurnNavigatorConfig,
  activateTurnNavigator,
  buildConversationId,
  buildTurnId,
  extractTurnHash,
} from '../../verbs/turnNavigator/TurnNavigator';
import type { PrimitiveHandle } from '../../verbs/types';

const CLAUDE_TIMELINE_PLUGIN_ID = 'voyager.claude-timeline';

/** Claude's own turn marker; add fallbacks only when Claude actually breaks it. */
export const CLAUDE_USER_MESSAGE_SELECTOR = '[data-testid="user-message"]';

export const CLAUDE_TURN_NAVIGATOR_CONFIG: TurnNavigatorConfig = {
  siteId: 'claude',
  siteLabel: 'Claude',
  turnSelector: CLAUDE_USER_MESSAGE_SELECTOR,
  conversationIdPattern: '^/chat/([^/?#]+)',
  // Never open a scrimmed guide over an active artifact: the panel is part of
  // the top document view. Skipping does not burn the once-per-user seen
  // state, so the guide simply shows on a later artifact-free page load.
  yieldWhenSelector: 'iframe[src*="claudeusercontent.com"]',
  position: 'right',
  pluginId: CLAUDE_TIMELINE_PLUGIN_ID,
  coachmarkId: TIMELINE_STYLE_COACHMARK_ID,
};

export function buildClaudeConversationId(input = location.href): string {
  return buildConversationId(CLAUDE_TURN_NAVIGATOR_CONFIG, input);
}

export const buildClaudeTurnId = buildTurnId;
export const extractClaudeTurnHash = extractTurnHash;

/** Claude renders artifacts in a sandboxed claudeusercontent.com iframe. */
export function hasOpenClaudeArtifact(doc: Document = document): boolean {
  return !!doc.querySelector('iframe[src*="claudeusercontent.com"]');
}

let handle: PrimitiveHandle | null = null;
/** Scope owned by the legacy start/stop wrappers (tests + non-engine callers). */
let standaloneScope: PluginScope | null = null;

/** Native lifecycle for the voyager.claude-timeline builtin plugin. */
export function activateClaudeTimeline(scope: PluginScope, settings: PluginSettings = {}): void {
  const current = activateTurnNavigator(scope, CLAUDE_TURN_NAVIGATOR_CONFIG, settings);
  handle = current;
  scope.effect(() => {
    return () => {
      if (handle === current) handle = null;
    };
  }, 'instance');
}

/** Fine-grained settings path — keeps grow-only markers and rail DOM intact. */
export function updateClaudeTimelineSettings(settings: PluginSettings): void {
  handle?.updateSettings?.(settings);
}

export function startClaudeTimeline(settings: PluginSettings = {}): void {
  if (handle) {
    handle.updateSettings?.(settings);
    return;
  }
  standaloneScope = new PluginScope();
  activateClaudeTimeline(standaloneScope, settings);
}

export function stopClaudeTimeline(): Promise<void> {
  const disposal = standaloneScope?.dispose() ?? Promise.resolve();
  standaloneScope = null;
  return disposal;
}
