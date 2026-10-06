/**
 * Removes secrets that travel inside free text (see redaction.ts for where this sits).
 *
 * Every pass reads the text once, left to right. The patterns are written as scanners and not as regular
 * expressions on purpose: a log line, an error message and a stack all pass through here, and some of what is
 * in them was typed by a caller. A pattern that backtracks (an unbounded run of key characters, then a secret
 * word, then another unbounded run) takes time cubic in the length of a string like `password-password-...`,
 * and the process answers nothing else while it does. Each scanner below does work proportional to the text.
 */

export const REDACTED = '[REDACTED]';

/** Words that make a key name a secret wherever they sit in it. */
const SECRET_WORD =
  /password|passwd|secret|token|api[_-]?key|signature|authorization|cookie|credential|session|csrf/i;

/** Keys that are secrets only as a whole: they sit inside ordinary words. */
const WHOLE_KEYS = new Set(['pin', 'otp', 'sig']);

const WHITESPACE = /\s/;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

const isDigit = (code: number): boolean => code >= 48 && code <= 57;
const isLetter = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
/** A character of a key: letters, digits, underscore and hyphen. */
const isKeyChar = (code: number): boolean =>
  isLetter(code) || isDigit(code) || code === 95 || code === 45;
/** What a regular expression calls a word character. Hyphen is a key character but not a word one. */
const isWordChar = (code: number): boolean => isKeyChar(code) && code !== 45;
const isSchemeChar = (code: number): boolean =>
  isLetter(code) || isDigit(code) || code === 43 || code === 46 || code === 45;

const isSpace = (text: string, at: number): boolean => WHITESPACE.test(text.charAt(at));

/** The index just past the run of key characters that starts at `from`. */
function endOfKey(text: string, from: number): number {
  let end = from;
  while (end < text.length && isKeyChar(text.charCodeAt(end))) end += 1;
  return end;
}

/**
 * Whether the name before an equals sign is a secret: it holds a secret word, or its last hyphenated part is a
 * whole key (`x-pin=1`, but not `x_pin=1`: a hyphen ends a word and an underscore does not).
 */
function isSecretPairKey(key: string): boolean {
  if (SECRET_WORD.test(key)) return true;
  return WHOLE_KEYS.has(key.slice(key.lastIndexOf('-') + 1).toLowerCase());
}

/** Whether the name between a JSON member's quotes is a secret: it holds a secret word, or is a whole key. */
function isSecretJsonKey(key: string): boolean {
  return SECRET_WORD.test(key) || WHOLE_KEYS.has(key.toLowerCase());
}

/** `scheme://user:password@host`: the user's password. The scheme and the host are left. */
function scrubUrlCredentials(text: string): string {
  let result = '';
  let copied = 0;
  for (
    let mark = text.indexOf('://');
    mark !== -1;
    mark = text.indexOf('://', Math.max(mark + 3, copied))
  ) {
    // The scheme is the run of scheme characters before the mark, and it must start on a word boundary.
    let start = mark;
    while (start > copied && isSchemeChar(text.charCodeAt(start - 1))) start -= 1;
    let boundary = false;
    for (let at = start; at < mark && !boundary; at += 1) {
      boundary =
        isLetter(text.charCodeAt(at)) && (at === 0 || !isWordChar(text.charCodeAt(at - 1)));
    }
    if (!boundary) continue;

    // user, a colon, the password, an at sign: the user stops at a colon, the password at neither a slash nor an @.
    const userFrom = mark + 3;
    let userEnd = userFrom;
    while (userEnd < text.length && !/[\s/@:]/.test(text.charAt(userEnd))) userEnd += 1;
    if (userEnd === userFrom || text.charAt(userEnd) !== ':') continue;
    let passwordEnd = userEnd + 1;
    while (passwordEnd < text.length && !/[\s/@]/.test(text.charAt(passwordEnd))) passwordEnd += 1;
    if (passwordEnd === userEnd + 1 || text.charAt(passwordEnd) !== '@') continue;

    result += `${text.slice(copied, userFrom)}${REDACTED}@`;
    copied = passwordEnd + 1;
  }
  return copied === 0 ? text : result + text.slice(copied);
}

/** `"password": "value"`: the value, when the name inside the quotes is a secret. An unterminated value goes to the end. */
function scrubJsonSecrets(text: string): string {
  let result = '';
  let copied = 0;
  // A member that was scrubbed is not scanned again: its closing quote is part of it.
  let scanned = 0;
  for (
    let quote = text.indexOf('"');
    quote !== -1;
    quote = text.indexOf('"', Math.max(quote + 1, scanned))
  ) {
    const keyEnd = endOfKey(text, quote + 1);
    if (text.charAt(keyEnd) !== '"' || !isSecretJsonKey(text.slice(quote + 1, keyEnd))) continue;

    let at = keyEnd + 1;
    while (at < text.length && isSpace(text, at)) at += 1;
    if (text.charAt(at) !== ':') continue;
    at += 1;
    while (at < text.length && isSpace(text, at)) at += 1;
    if (text.charAt(at) !== '"') continue;

    const valueFrom = at + 1;
    const valueEnd = text.indexOf('"', valueFrom);
    result += `${text.slice(copied, valueFrom)}${REDACTED}`;
    if (valueEnd === -1) return result;
    copied = valueEnd;
    scanned = valueEnd + 1;
  }
  return copied === 0 ? text : result + text.slice(copied);
}

/** `password=value`: the value, when the name before the equals sign is a secret. */
function scrubPairs(text: string): string {
  let result = '';
  let copied = 0;
  for (
    let equals = text.indexOf('=');
    equals !== -1;
    equals = text.indexOf('=', Math.max(equals + 1, copied))
  ) {
    let keyStart = equals;
    while (keyStart > copied && isKeyChar(text.charCodeAt(keyStart - 1))) keyStart -= 1;
    if (keyStart === equals || !isSecretPairKey(text.slice(keyStart, equals))) continue;

    let valueEnd = equals + 1;
    while (valueEnd < text.length && !/[&\s;,'"]/.test(text.charAt(valueEnd))) valueEnd += 1;
    if (valueEnd === equals + 1) continue;

    result += `${text.slice(copied, equals + 1)}${REDACTED}`;
    copied = valueEnd;
  }
  return copied === 0 ? text : result + text.slice(copied);
}

/** Removes secrets that travel inside text: URL credentials, bearer headers, JSON members and key=value pairs. */
export function scrubText(text: string): string {
  return scrubPairs(
    scrubJsonSecrets(scrubUrlCredentials(text).replace(AUTH_SCHEME, `$1 ${REDACTED}`)),
  );
}
