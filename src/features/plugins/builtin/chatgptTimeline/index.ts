import { PluginScope } from '@/features/plugins/runtime/pluginScope';
import type { PluginSettings } from '@/features/plugins/types';

import { ChatGptTimeline } from './ChatGptTimeline';
export {
  buildChatGptTimelineConversationId,
  buildChatGptTimelineStarTurnId,
  extractChatGptTimelineStarTurnId,
} from './identity';

let instance: ChatGptTimeline | null = null;
let standaloneScope: PluginScope | null = null;

/** Native lifecycle for the voyager.chatgpt-timeline builtin plugin. */
export function activateChatGptTimeline(scope: PluginScope, settings: PluginSettings = {}): void {
  const timeline = new ChatGptTimeline(scope);
  instance = timeline;
  scope.effect(
    () => () => {
      if (instance === timeline) instance = null;
    },
    'chatgpt-timeline-instance',
  );
  scope.effect(() => timeline.start(settings).then(() => () => {}), 'chatgpt-timeline-start');
}

export function updateChatGptTimelineSettings(settings: PluginSettings): void {
  instance?.updateSettings(settings);
}

export function startChatGptTimeline(settings: PluginSettings = {}): void {
  if (instance) {
    instance.updateSettings(settings);
    return;
  }
  standaloneScope = new PluginScope();
  activateChatGptTimeline(standaloneScope, settings);
}

export function stopChatGptTimeline(): Promise<void> {
  const disposal = standaloneScope?.dispose() ?? Promise.resolve();
  standaloneScope = null;
  return disposal;
}
