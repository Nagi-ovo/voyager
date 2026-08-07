import { startInputVimMode } from '@/pages/content/chatInput/vimMode';

import type { PluginScope } from '../../runtime/pluginScope';

/**
 * Native lifecycle for the voyager.input-vim builtin plugin.
 *
 * The async startup registers as a single scope effect: if the plugin is
 * disabled (or the page unmounts) before `startInputVimMode` resolves, the
 * scope pays the late cleanup automatically — no generation counter needed.
 * A startup failure is logged by the scope under this effect's label.
 */
export function activateInputVimPlugin(scope: PluginScope): void {
  scope.effect(() => startInputVimMode({ forceEnabled: true }), 'input-vim');
}
