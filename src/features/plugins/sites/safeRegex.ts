/**
 * Regular expressions that reach the content script from data (a site.json,
 * a plugin param, a remote catalog) run on the page's main thread against the
 * URL path. Catastrophic backtracking there is a denial of service, so only a
 * conservative subset is accepted: no lookarounds, no backreferences, and no
 * quantifier applied to a group that itself contains a quantifier (`(a+)+`).
 * The bundled adapters and plugins stay within this subset.
 */
export const MAX_SAFE_REGEX_LENGTH = 200;

const LOOKAROUND_OR_BACKREF = /\(\?<?[=!]|\\[1-9]|\\k</;
/** A quantified group whose body holds another quantifier. */
const NESTED_QUANTIFIER = /\([^()]*[*+?}][^()]*\)\s*[*+?{]/;

export function isSafeRegexSource(source: string): boolean {
  if (source.length === 0 || source.length > MAX_SAFE_REGEX_LENGTH) return false;
  if (LOOKAROUND_OR_BACKREF.test(source) || NESTED_QUANTIFIER.test(source)) return false;
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/** Longest input the navigator will ever hand a data-supplied pattern. */
export const MAX_REGEX_INPUT_LENGTH = 2048;
