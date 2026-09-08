/**
 * Regular expressions that reach the content script from data (a site.json,
 * a plugin param, a remote catalog) run on the page's main thread against the
 * URL path. Catastrophic backtracking there is a denial of service, so only a
 * conservative subset is accepted: no lookarounds, no backreferences, and no
 * unbounded repetition (`*`, `+`, `{…}`) of a group that itself contains a
 * quantifier or an alternation at any depth: `(a+)+`, `((a+))+`, `(a|aa)+`.
 * Such a group lets the engine split one input in exponentially many ways.
 * Adjacent quantified atoms (`a*a*a*…`) are only polynomial, but with the
 * quantifier count as the exponent, so their number is capped as well. The
 * bundled adapters and plugins stay within this subset.
 */
export const MAX_SAFE_REGEX_LENGTH = 200;
export const MAX_SAFE_REGEX_QUANTIFIERS = 8;

const LOOKAROUND_OR_BACKREF = /\(\?<?[=!]|\\[1-9]|\\k</;

/**
 * True when some group repeated with `*`, `+` or `{…}` holds a quantifier or
 * an alternation anywhere inside it, or when the pattern holds more than
 * `MAX_SAFE_REGEX_QUANTIFIERS` quantifiers. Escapes and character classes
 * are skipped, so `\(`, `\|` and `[+*]` never count. Lookarounds are
 * rejected before this runs, so a `(?` prefix is only `(?:` or a named group.
 */
function hasUnsafeRepetition(source: string): boolean {
  // One entry per open group: whether its body holds a quantifier or `|`.
  const groups: boolean[] = [];
  let inClass = false;
  let quantifiers = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    switch (ch) {
      case '[':
        inClass = true;
        break;
      case '(': {
        groups.push(false);
        if (source[i + 1] !== '?') break;
        // Skip `(?:` or `(?<name>` so its `?` is not read as a quantifier.
        const prefixEnd = source[i + 2] === '<' ? source.indexOf('>', i) : i + 2;
        if (prefixEnd < 0) return true;
        i = prefixEnd;
        break;
      }
      case ')': {
        const ambiguous = groups.pop() ?? false;
        const next = source[i + 1];
        if (next === '*' || next === '+' || next === '{') {
          if (ambiguous) return true;
          // A repeated group is itself a quantifier inside every enclosing group.
          groups.fill(true);
        } else if (ambiguous) {
          groups.fill(true);
        }
        break;
      }
      case '*':
      case '+':
      case '?':
      case '{':
        quantifiers += 1;
        groups.fill(true);
        break;
      case '|':
        groups.fill(true);
        break;
      default:
        break;
    }
  }
  return quantifiers > MAX_SAFE_REGEX_QUANTIFIERS;
}

export function isSafeRegexSource(source: string): boolean {
  if (source.length === 0 || source.length > MAX_SAFE_REGEX_LENGTH) return false;
  if (LOOKAROUND_OR_BACKREF.test(source) || hasUnsafeRepetition(source)) return false;
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/** Longest input the navigator will ever hand a data-supplied pattern. */
export const MAX_REGEX_INPUT_LENGTH = 2048;
