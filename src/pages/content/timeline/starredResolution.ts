/**
 * Display-time reconciliation between stored stars and mounted server turns.
 *
 * Legacy `u-<index>` ids are resolved only through the complete ordered
 * hNvQHb identity map. When that map is unavailable, the resolver suppresses
 * the legacy star instead of guessing from the current DOM window or text.
 */

export interface StarResolutionMarker {
  id: string;
}

export interface StarResolutionInput {
  markers: ReadonlyArray<StarResolutionMarker>;
  /** Turn ids exactly as stored. */
  starredIds: ReadonlySet<string>;
  /** Returns a canonical server id, an unchanged safe custom id, or null. */
  resolveCanonicalId: (storedId: string) => string | null;
}

export interface StarResolution {
  /** Marker id → forced display state. */
  displayByMarkerId: Map<string, boolean>;
  /** Marker id → every stored record that resolves to that marker. */
  storageIdsByMarkerId: Map<string, string[]>;
}

export function resolveStarredDisplay({
  markers,
  starredIds,
  resolveCanonicalId,
}: StarResolutionInput): StarResolution {
  const displayByMarkerId = new Map(markers.map((marker) => [marker.id, false]));
  const storageIdsByMarkerId = new Map<string, string[]>();
  if (starredIds.size === 0 || markers.length === 0) {
    return { displayByMarkerId, storageIdsByMarkerId };
  }

  const markerIds = new Set(markers.map((marker) => marker.id));
  starredIds.forEach((storedId) => {
    const canonicalId = resolveCanonicalId(storedId);
    if (!canonicalId || !markerIds.has(canonicalId)) return;
    displayByMarkerId.set(canonicalId, true);
    const storageIds = storageIdsByMarkerId.get(canonicalId) ?? [];
    storageIds.push(storedId);
    storageIdsByMarkerId.set(canonicalId, storageIds);
  });

  return { displayByMarkerId, storageIdsByMarkerId };
}
