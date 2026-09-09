/**
 * Content hash shared by every historical turn-id format:
 * legacy `c-<mountIndex>-<hash>`, current `c-<hash>` and `c-<hash>~<n>`.
 */
export function extractTurnHash(turnId: string): string {
  const base = turnId.split('~')[0];
  const segments = base.split('-');
  return segments[segments.length - 1] || base;
}

/** Guard asynchronous reads without delaying the caller's existing promise chain. */
export class StarSnapshotLoader {
  private revision = 0;

  begin(isCurrent: () => boolean): () => boolean {
    const revision = ++this.revision;
    return () => revision === this.revision && isCurrent();
  }
}
