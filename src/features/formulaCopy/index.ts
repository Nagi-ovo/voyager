// Convenience function for backward compatibility
import type { PluginScope } from '@/features/plugins/runtime/pluginScope';

import { getFormulaCopyService } from './FormulaCopyService';

export { startNativeFormulaCopy } from './nativeFeature';
export type {
  FormulaCopyLifecycleService,
  NativeFormulaCopyController,
  StartNativeFormulaCopyOptions,
} from './nativeFeature';

/**
 * Formula Copy Feature Entry Point
 * Exports the service and provides a simple initialization function
 */

export { FormulaCopyService, getFormulaCopyService } from './FormulaCopyService';
export type { FormulaCopyConfig } from './FormulaCopyService';

let pluginActivationGeneration = 0;

export function stopFormulaCopy(): void {
  pluginActivationGeneration += 1;
  const service = getFormulaCopyService();
  service.dispose();
}

/**
 * Native lifecycle for the voyager.formula-copy builtin plugin
 * (Claude/ChatGPT). Gemini keeps the direct start/stop path above — the two
 * never overlap because the plugin's `matches` exclude Gemini hosts.
 */
export function activateFormulaCopy(scope: PluginScope): void {
  const activationGeneration = ++pluginActivationGeneration;
  scope.effect(async () => {
    const service = getFormulaCopyService();
    await service.prepare();
    if (scope.signal.aborted) {
      // A rapid remount may already be preparing/using the singleton. An old
      // scope is only allowed to release the generation it owns.
      if (activationGeneration === pluginActivationGeneration) service.dispose();
      return () => {};
    }
    if (activationGeneration !== pluginActivationGeneration) return () => {};
    service.initialize();
    return () => {
      if (activationGeneration === pluginActivationGeneration) service.dispose();
    };
  }, 'formula-copy');
}
