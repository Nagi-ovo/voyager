import { getTranslationSync } from '@/utils/i18n';
import type { TranslationKey } from '@/utils/translations';

export function translate(key: TranslationKey, fallback: string): string {
  const translated = getTranslationSync(key);
  return translated === key ? fallback : translated;
}

export function translateWith(
  key: TranslationKey,
  fallback: string,
  replacements: Record<string, string>,
): string {
  let output = translate(key, fallback);
  Object.entries(replacements).forEach(([name, value]) => {
    output = output.replaceAll(`{${name}}`, value);
  });
  return output;
}

export function getSaveFailureMessage(error: unknown): string {
  const fallback = translate('highlightSaveFailed', 'Could not save the highlight.');
  if (!(error instanceof Error)) return fallback;
  const detail = error.message.trim();
  if (!detail || detail === 'Highlight operation failed') return fallback;
  return `${fallback} ${detail}`;
}
