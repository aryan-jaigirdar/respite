/**
 * Redis-style glob matching for KEYS and SCAN MATCH, a port of the semantics
 * of Redis' stringmatchlen:
 *
 *   *        any sequence, including empty
 *   ?        any single character
 *   [abc]    any listed character
 *   [^abc]   any character not listed
 *   [a-z]    any character in the range (reversed ranges are normalized)
 *   \x       literal x (escapes work inside classes too)
 *
 * Recursion only happens at `*`, so depth is bounded by the number of stars
 * in the pattern, not by input length.
 */

const STAR = 0x2a; // '*'
const QUESTION = 0x3f; // '?'
const LBRACKET = 0x5b; // '['
const RBRACKET = 0x5d; // ']'
const CARET = 0x5e; // '^'
const BACKSLASH = 0x5c; // '\'
const DASH = 0x2d; // '-'

export function globMatch(pattern: string, subject: string): boolean {
  return matchFrom(pattern, 0, subject, 0);
}

function matchFrom(pattern: string, pi: number, subject: string, si: number): boolean {
  while (pi < pattern.length) {
    const pc = pattern.charCodeAt(pi);

    if (pc === STAR) {
      while (pi + 1 < pattern.length && pattern.charCodeAt(pi + 1) === STAR) pi += 1;
      if (pi === pattern.length - 1) return true; // trailing * matches the rest
      for (let skip = si; skip <= subject.length; skip++) {
        if (matchFrom(pattern, pi + 1, subject, skip)) return true;
      }
      return false;
    }

    if (si >= subject.length) return false;
    const sc = subject.charCodeAt(si);

    if (pc === QUESTION) {
      pi += 1;
      si += 1;
      continue;
    }

    if (pc === LBRACKET) {
      const result = matchClass(pattern, pi, sc);
      if (result === null) {
        // Unterminated class: treat '[' as a literal character.
        if (sc !== LBRACKET) return false;
        pi += 1;
        si += 1;
        continue;
      }
      if (!result.matched) return false;
      pi = result.nextPi;
      si += 1;
      continue;
    }

    let literal = pc;
    if (pc === BACKSLASH && pi + 1 < pattern.length) {
      pi += 1;
      literal = pattern.charCodeAt(pi);
    }
    if (literal !== sc) return false;
    pi += 1;
    si += 1;
  }
  return si === subject.length;
}

/**
 * Matches one character against the class opening at pattern[pi] (a '[').
 * Returns null when the class is never closed.
 */
function matchClass(
  pattern: string,
  pi: number,
  charCode: number,
): { matched: boolean; nextPi: number } | null {
  let j = pi + 1;
  let negate = false;
  if (j < pattern.length && pattern.charCodeAt(j) === CARET) {
    negate = true;
    j += 1;
  }

  let matched = false;
  while (j < pattern.length && pattern.charCodeAt(j) !== RBRACKET) {
    const cj = pattern.charCodeAt(j);
    if (cj === BACKSLASH && j + 1 < pattern.length) {
      if (pattern.charCodeAt(j + 1) === charCode) matched = true;
      j += 2;
    } else if (
      j + 2 < pattern.length &&
      pattern.charCodeAt(j + 1) === DASH &&
      pattern.charCodeAt(j + 2) !== RBRACKET
    ) {
      let low = cj;
      let high = pattern.charCodeAt(j + 2);
      if (low > high) {
        const tmp = low;
        low = high;
        high = tmp;
      }
      if (charCode >= low && charCode <= high) matched = true;
      j += 3;
    } else {
      if (cj === charCode) matched = true;
      j += 1;
    }
  }

  if (j >= pattern.length) return null; // no closing ']'
  return { matched: negate ? !matched : matched, nextPi: j + 1 };
}
