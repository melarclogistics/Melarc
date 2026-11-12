import { canonicalAccountIdentifier } from '../auth/vendor/vendor-vocabulary.js';
import type { LookupQuery } from '../domain-ports/record-lookup.port.js';
import { destinationHint } from '../notifications/notification-lane.js';
import { normalisePhone } from './normalise-phone.js';

/**
 * What the text of a lookup is (`features/operations/global-lookup.md` section 5; `AC-LOOKUP-01` to `-04`): the length it may have, and which
 * of the three questions it asks. Pure: no database, no session. **The contract counts the text as sent** (2 to 64 characters, refused before
 * the handler runs); this is the handler's own check after that, and it counts the text once trimmed and each run of white space is one space,
 * so that spaces are never what makes a text long enough. The maximum cannot fire after the contract's (folding only shortens); it stays so
 * that the function is right on its own.
 */
export const LOOKUP_MIN_LENGTH = 2;
export const LOOKUP_MAX_LENGTH = 64;

/** `HUB-TT-XXXXXX`: three letters, two letters (the record type) and six letters or digits (operational-code.ts); case does not matter. */
const OPERATIONAL_CODE = /^([A-Za-z]{3})-([A-Za-z]{2})-([A-Za-z0-9]{6})$/;

/** The query the text is, or `undefined` when it is not a text of 2 to 64 characters once trimmed, or holds a NUL (`VALIDATION_FAILED` naming `q`). */
export function lookupQueryOf(raw: unknown): LookupQuery | undefined {
  if (typeof raw !== 'string') return undefined;
  // A NUL character is in no name, and the database refuses it in a text (a read that failed with a 500 for a caller's input).
  if (raw.includes('\u0000')) return undefined;
  const text = raw.trim().replaceAll(/\s+/g, ' ');
  const length = Array.from(text).length;
  if (length < LOOKUP_MIN_LENGTH || length > LOOKUP_MAX_LENGTH) return undefined;

  const code = OPERATIONAL_CODE.exec(text);
  // A text of the shape of a code cannot be a number (a letter in it), so the number is only asked of the rest.
  const phone = code === null ? normalisePhone(text) : undefined;
  const accountIdentifier = canonicalAccountIdentifier(text);
  return {
    text,
    ...(code === null ? {} : { code: text.toUpperCase(), codeType: (code[2] ?? '').toUpperCase() }),
    ...(phone === undefined ? {} : { phone }),
    ...(accountIdentifier === undefined ? {} : { accountIdentifier }),
  };
}

/**
 * The one question a source asks of a query, in the order the feature gives: a code first (and nothing else is asked), then a phone number
 * typed in full (and nothing else), else the name. A vendor's account identifier is not a question of its own: it is matched besides the name.
 */
export function strategyOf(query: LookupQuery): 'code' | 'phone' | 'name' {
  if (query.code !== undefined) return 'code';
  if (query.phone !== undefined) return 'phone';
  return 'name';
}

/** The text with what a `LIKE` pattern reads (`%`, `_` and the escape itself) made plain, to be used with `escape '\'`. */
export function likeLiteral(text: string): string {
  return text.replaceAll(/[\\%_]/g, '\\$&');
}

/**
 * The two patterns of a word-prefix search, for `name ilike $1 escape '\' or name ilike $2 escape '\'`: the text at the start of the name, or at
 * the start of any word of it (words are separated by spaces). The inside of a word never matches.
 */
export function wordPrefixPatterns(text: string): readonly [string, string] {
  const literal = likeLiteral(text);
  return [`${literal}%`, `% ${literal}%`];
}

/** A phone number as a result shows it: the platform's own mask of a number it shows (the country part and the last three digits). */
export function maskedPhone(phone: string): string {
  return destinationHint(phone);
}
