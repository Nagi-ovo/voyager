import { startExportButton } from '@/pages/content/export';

let active = false;
let generation = 0;
let cleanup: (() => void) | null = null;

/** Native lifecycle bridge for the voyager.chatgpt-export builtin plugin. */
export function startChatGptExportPlugin(): void {
  if (active) return;

  active = true;
  const currentGeneration = ++generation;
  void startExportButton()
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
  cleanup?.();
  cleanup = null;
}
