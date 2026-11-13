import { randomInt } from 'node:crypto';

/**
 * The operational code of a record (S1.14; domain-model.md section 2, `MSC-DEC-202`; the pattern of the contract's `PickupRequest.code`):
 * `HUB-TT-XXXXXX`, example `ACC-PR-7K3M9Q`. The code is for people who read it aloud, so the alphabet leaves out the characters that are
 * heard or read wrongly: `0 O 1 I L`. It is an attribute, never an identifier or a path parameter (section 2): the record's id is.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;

/** The record types of a code. */
export const RECORD_TYPES = ['PR', 'MF', 'IN', 'OR', 'DR'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/**
 * The three-letter hub code of a hub: the first three letters of its name, capitalised (`Accra` gives `ACC`, the example the decision
 * gives). **The hub table holds an id and a name and no code**, so the code is derived from the name; a second hub whose name begins
 * with the same three letters shares the prefix, which is harmless because the six characters that follow make a code unique (the table
 * holds a unique index and the creation retries on a collision) and the prefix only tells a person which hub to look at. A hub whose
 * name has fewer than three letters cannot be given one until the hub table carries a code: that is refused, not padded.
 */
export function hubCodeOf(hubName: string): string {
  const letters = hubName
    .normalize('NFKD')
    .replaceAll(/[^A-Za-z]/g, '')
    .toUpperCase();
  if (letters.length < 3) {
    throw new RangeError('A hub code is made of the first three letters of the hub’s name');
  }
  return letters.slice(0, 3);
}

/**
 * A new operational code. `draw(bound)` answers an integer in `[0, bound)`; the default is the system's cryptographic generator. Each
 * character is drawn **uniformly by index** from the 31 symbols (a modulo of random bytes would favour the first ones). Uniqueness is
 * the table's: the caller inserts under a unique index and draws again on a collision.
 */
export function operationalCode(
  hubCode: string,
  type: RecordType,
  draw: (bound: number) => number = (bound) => randomInt(bound),
): string {
  if (!/^[A-Z]{3}$/.test(hubCode)) throw new RangeError('A hub code is three capital letters');
  if (!(RECORD_TYPES as readonly string[]).includes(type)) {
    throw new RangeError('A record type is one of PR, MF, IN, OR and DR');
  }
  let tail = '';
  for (let at = 0; at < CODE_LENGTH; at += 1)
    tail += CODE_ALPHABET.charAt(draw(CODE_ALPHABET.length));
  return `${hubCode}-${type}-${tail}`;
}
