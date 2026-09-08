/**
 * Mirror a settings patch into the popup's per-setting React state.
 *
 * Extracted settings cards report one changed key at a time as a partial
 * object; the popup still owns one `useState` per setting. This hands each
 * present key to its setter so the card and the persistence call share one
 * patch shape.
 */
export type SettingSetters<T extends object> = { [K in keyof T]: (value: T[K]) => void };

export function applySettingsPatch<T extends object>(
  setters: SettingSetters<T>,
  patch: Partial<T>,
): void {
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const value = patch[key];
    if (value === undefined) continue;
    // `patch[key]` is typed against the union of all values; the key picks the
    // matching setter at runtime, which the mapped type guarantees per key.
    (setters[key] as (next: T[keyof T]) => void)(value as T[keyof T]);
  }
}
