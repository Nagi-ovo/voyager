import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';
import { type NativeFormulaCopyController, startNativeFormulaCopy } from '@/features/formulaCopy';

interface StartNativeFormulaCopyForContentOptions {
  registerCleanup: (cleanup: () => void) => void;
  start?: () => Promise<NativeFormulaCopyController>;
  reportError?: (error: unknown) => void;
}

/**
 * Start the optional formula-copy feature without blocking unrelated content
 * features when its own setup fails.
 */
export async function startNativeFormulaCopyForContent({
  registerCleanup,
  start = startNativeFormulaCopy,
  reportError = (error) =>
    console.error('[Gemini Voyager] Formula copy initialization error:', error),
}: StartNativeFormulaCopyForContentOptions): Promise<void> {
  let controller: NativeFormulaCopyController | null = null;

  try {
    controller = await start();
    registerCleanup(controller.destroy);
  } catch (error) {
    controller?.destroy();
    if (isExtensionContextInvalidatedError(error)) throw error;
    reportError(error);
  }
}
