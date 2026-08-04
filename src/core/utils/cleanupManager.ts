/**
 * A class that manages and executes cleanup functions in code entrypoint.
 */
export class CleanupManager {
  private cleanups: Array<Cleanup> = [];

  constructor() {}

  /**
   * Register a cleanup function waited to be called.
   * @param func A function that does cleanup operation when called.
   * @param pos A number (preferably defined by Enum) that indicates the position of the
   *            cleanup function. The lower the number, the earlier the function would be called.
   */
  registerCleanupFunction(func: () => void, pos: number = -1): void {
    if (this.cleanups.some((cleanup) => cleanup.func === func)) return;
    this.cleanups.push({
      pos: pos,
      func: func,
    });
  }

  /**
   * Register a cleanup function, and return the function as-is.
   * @param func
   * @param pos
   */
  registerCleanupFunctionAndReturnIt(func: () => void, pos: number = -1): () => void {
    this.registerCleanupFunction(func, pos);
    return func;
  }

  /**
   * [debug] return a readonly list containing stored cleanup functions.
   */
  list(): Array<Cleanup> {
    return [...this.cleanups] as const;
  }

  /**
   * Call all functions registered by `registerCleanupFunction` functions,
   * and clear their references.
   *
   * If any cleanup functions throws an error, other functions will execute normally.
   * Then, the last recorded error will be re-thrown.
   */
  executeCleanups(): void {
    let error: unknown = null;

    this.cleanups
      .sort((a, b) => {
        return a.pos - b.pos;
      })
      .forEach((it) => {
        try {
          it.func();
        } catch (e) {
          error = e;
        }
      });
    this.cleanups = [];

    if (error) throw error;
  }
}

interface Cleanup {
  pos: number;
  func: () => void;
}
