import { describe, expect, it } from 'vitest';
import { globMatch } from '../src/glob.js';

describe('globMatch', () => {
  it.each([
    // pattern, subject, expected
    ['*', '', true],
    ['*', 'anything', true],
    ['hello', 'hello', true],
    ['hello', 'hellO', false],
    ['h?llo', 'hello', true],
    ['h?llo', 'hallo', true],
    ['h?llo', 'hllo', false],
    ['h*llo', 'hllo', true],
    ['h*llo', 'heeeello', true],
    ['h*llo', 'hllx', false],
    ['*llo', 'hello', true],
    ['he*', 'hello', true],
    ['he*', 'ha', false],
    ['h**llo', 'hello', true],
    ['a*b*c', 'axxbxxc', true],
    ['a*b*c', 'axxcxxb', false],
    ['h[ae]llo', 'hello', true],
    ['h[ae]llo', 'hallo', true],
    ['h[ae]llo', 'hillo', false],
    ['h[^e]llo', 'hallo', true],
    ['h[^e]llo', 'hello', false],
    ['h[a-c]llo', 'hbllo', true],
    ['h[a-c]llo', 'hdllo', false],
    ['h[c-a]llo', 'hbllo', true], // reversed ranges are normalized
    ['h\\*llo', 'h*llo', true],
    ['h\\*llo', 'hxllo', false],
    ['h\\?llo', 'h?llo', true],
    ['h[\\]]llo', 'h]llo', true],
    ['user:*', 'user:42', true],
    ['user:*', 'session:42', false],
    ['', '', true],
    ['', 'x', false],
    ['abc', 'ab', false],
    ['ab', 'abc', false],
  ])('globMatch(%j, %j) === %s', (pattern, subject, expected) => {
    expect(globMatch(pattern, subject)).toBe(expected);
  });

  it('treats an unterminated class opener as a literal character', () => {
    expect(globMatch('a[bc', 'a[bc')).toBe(true);
    expect(globMatch('a[bc', 'abc')).toBe(false);
    expect(globMatch('a[', 'a[')).toBe(true);
  });

  it('does not blow the stack on star-heavy patterns', () => {
    const pattern = `${'*a'.repeat(50)}*`;
    expect(globMatch(pattern, 'a'.repeat(100))).toBe(true);
  });
});
