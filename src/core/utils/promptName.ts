export interface NamedPrompt {
  id: string;
  name?: string;
}

/** Returns the normalized name stored by Prompt Manager. */
export function normalizePromptName(value: string): string | null {
  const name = value.trim();
  return name ? name : null;
}

export function getPromptNameComparisonKey(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

/**
 * Returns the IDs of every prompt in a duplicate normalized-name group.
 * Duplicate names remain valid stored data, but none of the group members can
 * be addressed unambiguously by slash completion until the names are unique.
 */
export function getPromptNameConflictIds(items: readonly NamedPrompt[]): Set<string> {
  const idsByName = new Map<string, string[]>();

  for (const item of items) {
    if (typeof item.name !== 'string' || item.name.trim() === '') continue;
    const key = getPromptNameComparisonKey(item.name);
    const ids = idsByName.get(key);
    if (ids) ids.push(item.id);
    else idsByName.set(key, [item.id]);
  }

  const conflicts = new Set<string>();
  for (const ids of idsByName.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) conflicts.add(id);
  }
  return conflicts;
}

/**
 * Checks whether a prompt name is already used.
 *
 * When editing a legacy member of an existing duplicate-name group, keeping
 * that same semantic name is allowed. A real rename must still be unique.
 */
export function isPromptNameTaken(
  items: readonly NamedPrompt[],
  candidate: string,
  editingId?: string | null,
): boolean {
  const candidateKey = getPromptNameComparisonKey(candidate);
  const editingItem = editingId ? items.find((item) => item.id === editingId) : undefined;
  if (
    editingItem &&
    typeof editingItem.name === 'string' &&
    getPromptNameComparisonKey(editingItem.name) === candidateKey
  ) {
    return false;
  }

  return items.some(
    (item) =>
      item.id !== editingId &&
      typeof item.name === 'string' &&
      getPromptNameComparisonKey(item.name) === candidateKey,
  );
}
