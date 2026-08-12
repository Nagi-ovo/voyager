import { startExportButton } from '@/pages/content/export';

let active = false;
let generation = 0;
let cleanup: (() => void) | null = null;
let lifecycleController: AbortController | null = null;

/** Native lifecycle bridge for the voyager.chatgpt-export builtin plugin. */
export function startChatGptExportPlugin(): void {
  if (active) return;

  active = true;
  const currentGeneration = ++generation;
  const controller = new AbortController();
  lifecycleController = controller;
  void startExportButton({ signal: controller.signal })
    .then((nextCleanup) => {
      if (!active || currentGeneration !== generation) {
        nextCleanup();
        return;
      }
      cleanup = nextCleanup;
    })
    .catch(() => {
      if (currentGeneration === generation) active = false;
    });
}

export function stopChatGptExportPlugin(): void {
  active = false;
  generation++;
  lifecycleController?.abort();
  lifecycleController = null;
  cleanup?.();
  cleanup = null;
}
