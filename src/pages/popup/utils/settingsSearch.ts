import { TRANSLATIONS, type TranslationKey } from '@/utils/translations';

export interface SettingsSearchItem<Id extends string> {
  id: Id;
  keys: readonly TranslationKey[];
  aliases?: readonly string[];
}

export function normalizePersistedSettingsSearchQuery(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

function editDistanceWithin(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current[j] = next;
      rowMin = Math.min(rowMin, next);
    }
    if (rowMin > limit) return false;
    previous = current;
  }

  return previous[b.length] <= limit;
}

function tokenMatches(
  token: string,
  corpusTokens: readonly string[],
  compactCorpus: string,
): boolean {
  if (compactCorpus.includes(token)) return true;

  return corpusTokens.some((candidate) => {
    if (candidate.includes(token)) return true;
    if (token.length >= 3 && isSubsequence(token, candidate)) return true;
    if (token.length < 4 || candidate.length < 4) return false;
    const limit = token.length > 8 ? 2 : 1;
    return editDistanceWithin(token, candidate, limit);
  });
}

export function matchesFuzzySearch(corpus: string, query: string): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;

  const normalizedCorpus = normalizeSearchText(corpus);
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const compactCorpus = normalizedCorpus.replace(/\s+/g, '');
  if (normalizedCorpus.includes(normalizedQuery) || compactCorpus.includes(compactQuery)) {
    return true;
  }

  const corpusTokens = normalizedCorpus.split(/\s+/).filter(Boolean);
  return normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => tokenMatches(token, corpusTokens, compactCorpus));
}

export function buildSettingsSearchCorpus<Id extends string>(item: SettingsSearchItem<Id>): string {
  const localized = Object.values(TRANSLATIONS).flatMap((messages) =>
    item.keys.map((key) => messages[key]),
  );
  return [...localized, ...(item.aliases ?? [])].join(' ');
}

export function getSettingsSearchMatches<Id extends string>(
  items: readonly SettingsSearchItem<Id>[],
  query: string,
): Set<Id> {
  const matches = new Set<Id>();
  for (const item of items) {
    if (matchesFuzzySearch(buildSettingsSearchCorpus(item), query)) {
      matches.add(item.id);
    }
  }
  return matches;
}
