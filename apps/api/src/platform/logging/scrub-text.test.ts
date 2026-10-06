import { describe, expect, it } from 'vitest';

import { REDACTED, scrubText } from './scrub-text.js';

/**
 * The scrubber as it was before it became a set of scanners: four regular expressions. They are kept here as the
 * statement of what is scrubbed, and `scrubText` has to give the same text on every input short enough for them to
 * handle. They do not handle long ones, which is why the scanners exist (below).
 *
 * One deliberate difference, and the reference carries it: a JSON member whose value has no closing quote is
 * scrubbed to the end of the text. A line that was cut in the middle of a value is no reason to print the value.
 */
const SECRET_WORDS =
  'password|passwd|secret|token|api[_-]?key|signature|authorization|cookie|credential|session|csrf';
const REFERENCE = {
  url: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
  auth: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  json: new RegExp(
    `("(?:[A-Za-z0-9_-]*(?:${SECRET_WORDS})[A-Za-z0-9_-]*|pin|otp|sig)"\\s*:\\s*")[^"]*("|$)`,
    'gi',
  ),
  pair: new RegExp(
    `\\b((?:[A-Za-z0-9_-]*(?:${SECRET_WORDS})[A-Za-z0-9_-]*)|pin|otp|sig)=([^&\\s;,'"]+)`,
    'gi',
  ),
};

function reference(text: string): string {
  return text
    .replace(REFERENCE.url, `$1${REDACTED}@`)
    .replace(REFERENCE.auth, `$1 ${REDACTED}`)
    .replace(REFERENCE.json, `$1${REDACTED}$2`)
    .replace(REFERENCE.pair, `$1=${REDACTED}`);
}

const PIECES = [
  'password',
  'Password',
  'passwd',
  'secret',
  'token',
  'TOKEN',
  'api-key',
  'api_key',
  'apikey',
  'signature',
  'authorization',
  'cookie',
  'credential',
  'session',
  'csrf',
  'pin',
  'otp',
  'sig',
  'shipping',
  'x',
  'user',
  'pw',
  'Bearer',
  'Basic',
  'http',
  'postgres',
  '-',
  '_',
  '.',
  '+',
  '=',
  '&',
  ';',
  ',',
  "'",
  '"',
  ':',
  '://',
  '/',
  '@',
  ' ',
  '\n',
  '\t',
  '1',
  '{',
  '}',
  'é',
];

/** A small deterministic generator, so a failure names an input that can be run again. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('scrubText: what is scrubbed', () => {
  it.each([
    [
      'a URL user and password',
      'connect postgres://app:hunter2@db.example/x failed',
      'connect postgres://[REDACTED]@db.example/x failed',
    ],
    ['a bearer token', 'sent Bearer abc.def-123 to', 'sent Bearer [REDACTED] to'],
    [
      'a JSON member',
      '{"password": "hunter2", "name": "a"}',
      '{"password": "[REDACTED]", "name": "a"}',
    ],
    ['a pair', 'a=1&session_token=abc123&b=2', 'a=1&session_token=[REDACTED]&b=2'],
    ['a short whole key after a hyphen', 'x-pin=1234 ', 'x-pin=[REDACTED] '],
    ['a short whole key, in capitals', 'OTP=123456;', 'OTP=[REDACTED];'],
  ])('scrubs %s', (_label, input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  it.each([
    ['a short word inside a longer name', 'shipping=express'],
    ['an underscore does not end a word', 'x_pin=1234'],
    ['a JSON name that only ends in a whole key', '{"x-pin": "1"}'],
    ['a pair with no value', 'password=&next=1'],
    ['a URL with no password', 'http://host/path and user@host'],
    ['no secret at all', 'listening on 127.0.0.1:3000'],
  ])('leaves alone %s', (_label, input) => {
    expect(scrubText(input)).toBe(input);
  });

  // Break caught: a line cut in the middle of a value printing the part of the value that is there.
  it('scrubs a JSON value that has no closing quote to the end of the text', () => {
    expect(scrubText('{"user":"a","password":"hunter2 and the rest')).toBe(
      '{"user":"a","password":"[REDACTED]',
    );
  });

  // The reason for the reference above: not one input where the scanners and the expressions differ.
  it('agrees with the regular expressions it replaced on 40 000 generated texts', () => {
    const next = generator(20_261_006);
    for (let index = 0; index < 40_000; index += 1) {
      const length = 1 + Math.floor(next() * 14);
      let text = '';
      for (let at = 0; at < length; at += 1) {
        text += PIECES[Math.floor(next() * PIECES.length)] ?? '';
      }
      expect(scrubText(text), JSON.stringify(text)).toBe(reference(text));
    }
  });
});

/**
 * Break caught: a pattern that backtracks. `password-password-...` took 20 seconds at 16 000 repetitions with the
 * expressions, and the process served nothing else meanwhile. A megabyte of each shape below has to finish in a
 * time no healthy machine misses by a factor of ten.
 */
describe('scrubText: hostile text', () => {
  const HALF_MEGABYTE = 500_000;
  const hostile: [string, string][] = [
    ['a repeated secret word and hyphen', 'password-'.repeat(HALF_MEGABYTE / 9)],
    ['a repeated word and hyphen with no end', 'csrf-'.repeat(HALF_MEGABYTE / 5)],
    ['a repeated letter and hyphen', 'a-'.repeat(HALF_MEGABYTE / 2)],
    ['a repeated letter and dot', 'a.'.repeat(HALF_MEGABYTE / 2)],
    ['a quote then a repeated secret word', `"${'csrf'.repeat(HALF_MEGABYTE / 4)}`],
    ['many quotes', '"'.repeat(HALF_MEGABYTE)],
    ['many equals signs', '='.repeat(HALF_MEGABYTE)],
    ['many scheme marks', '://'.repeat(HALF_MEGABYTE / 3)],
    ['a long scheme, then a mark', `${'a'.repeat(HALF_MEGABYTE)}://u:p`],
    ['a long password with no at sign', `x://u:${'p:'.repeat(HALF_MEGABYTE / 2)}`],
    ['a long run of spaces after a JSON name', `"password"${' '.repeat(HALF_MEGABYTE)}`],
    ['repeated JSON names with no value', '"password" '.repeat(HALF_MEGABYTE / 11)],
    ['a bearer word and a long run of spaces', `Bearer${' '.repeat(HALF_MEGABYTE)}!`],
    ['repeated bearer words', 'Bearer '.repeat(HALF_MEGABYTE / 7)],
    ['repeated pairs with a secret name and no value', 'token=&'.repeat(HALF_MEGABYTE / 7)],
  ];

  it.each(hostile)('finishes quickly on %s', (_label, text) => {
    const started = performance.now();
    scrubText(text);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
