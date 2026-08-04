/**
 * A class that manages and executes cleanup functions in code entrypoint.
 */
export class CleanupManager {
  private cleanups: Array<() => void> = [];

  constructor() {}

  /**
   * Register a cleanup function waited to be called.
   * @param func A function that does cleanup operation when called.
   */
  registerCleanupFunction(func: () => void): void {
    if (this.cleanups.includes(func)) return;
    this.cleanups.push(func);
  }

  /**
   * [debug] return a readonly list containing stored cleanup functions.
   */
  list(): Array<() => void> {
    return [...this.cleanups] as const;
  }

  /**
   * Call all functions registered by `registerCleanupFunction` functions,
   * and clear their references.
   */
  executeCleanups(): void {
    this.cleanups.forEach((it) => {
      try {
        it();
      } catch (e) {
        console.error(`[Gemini Voyager] cleanup error: ${e}`);
      }
    });
    this.cleanups = [];
  }
}
