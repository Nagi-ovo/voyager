/**
 * A class that manages and executes cleanup functions in code entrypoint.
 */
export class WillCleanUp {
  private cleanUps: Array<() => void> = [];

  constructor() {}

  /**
   * Register a cleanup function waited to be called.
   * @param arg A function that does cleanup operation when called.
   */
  it(arg: () => void): void {
    if (this.cleanUps.includes(arg)) return;
    this.cleanUps.push(arg);
  }

  /**
   * [debug] return a readonly list containing stored cleanup functions.
   */
  list(): Array<() => void> {
    return [...this.cleanUps] as const;
  }

  /**
   * Call all functions registered by `it` functions, and clear their references.
   */
  execute(): void {
    this.cleanUps.forEach((it) => {
      try {
        it();
      } catch (e) {
        console.error(`[Gemini Voyager] cleanup error: ${e}`);
      }
    });
    this.cleanUps = [];
  }
}
