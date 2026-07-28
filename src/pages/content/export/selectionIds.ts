import { hashString } from '@/core/utils/hash';

import { makeStableTurnId, readServerTurnId } from '../fork/turnId';

function readOrCreateTurnId(element: HTMLElement, index: number): string {
  return readServerTurnId(element) ?? (element.dataset.turnId?.trim() || makeStableTurnId(index));
}

function normalizeTurnText(element: HTMLElement, index: number): string {
  return (
    String(element.textContent || '')
      .replace(/\s+/g, ' ')
      .trim() || `user-${index}`
  );
}

function ownsActiveExportSelector(element: HTMLElement, turnId: string): boolean {
  return Array.from(element.querySelectorAll<HTMLElement>('.gv-export-msg-selector')).some(
    (selector) => selector.dataset.gvExportMessageId === `${turnId}:u`,
  );
}

/**
 * Resolves a unique export id for every user turn without trusting Gemini's
 * data-turn-id values to be unique. Lazy-loaded history can be numbered in
 * separate batches, producing repeated ids such as u-0 ... u-9.
 *
 * When selection mode is already active, the element that owns the existing
 * checkbox keeps the colliding id so its selection state does not jump to an
 * older message after history is prepended.
 */
export function resolveUniqueExportTurnIds(elements: HTMLElement[]): string[] {
  const ownersById = new Map<string, HTMLElement[]>();

  elements.forEach((element, index) => {
    const id = readOrCreateTurnId(element, index);
    if (!id) return;
    const owners = ownersById.get(id) ?? [];
    owners.push(element);
    ownersById.set(id, owners);
  });

  const preferredOwnerById = new Map<string, HTMLElement>();
  ownersById.forEach((owners, id) => {
    const activeOwner = owners.find((owner) => ownsActiveExportSelector(owner, id));
    preferredOwnerById.set(id, activeOwner ?? owners[0]);
  });

  const reservedExistingIds = new Set(preferredOwnerById.keys());
  const usedIds = new Set<string>();

  return elements.map((element, index) => {
    const existingId = readOrCreateTurnId(element, index);
    if (existingId && preferredOwnerById.get(existingId) === element && !usedIds.has(existingId)) {
      usedIds.add(existingId);
      return existingId;
    }

    const base = `u-${hashString(normalizeTurnText(element, index))}`;
    let candidate = base;
    let suffix = 1;
    while (usedIds.has(candidate) || reservedExistingIds.has(candidate)) {
      suffix += 1;
      candidate = `${base}~${suffix}`;
    }

    usedIds.add(candidate);
    return candidate;
  });
}
