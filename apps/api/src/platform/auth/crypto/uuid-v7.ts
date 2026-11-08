import { randomBytes } from 'node:crypto';

import type { Clock } from '../ports/clock.port.js';

/** 48 bits of Unix milliseconds: the last instant a UUIDv7 can name is in the year 10889. */
const MAX_MILLISECONDS = 0xffff_ffff_ffff;

/**
 * The layout of RFC 9562 section 5.7, made from a time and 16 random bytes: the 48-bit big-endian Unix millisecond timestamp,
 * then the version 7, then 74 bits of the random input around the variant `10`. The version and variant bits are set over
 * whatever the random input holds there, and the caller's buffer is not changed.
 *
 * This is the deterministic core, kept apart so that the published example of RFC 9562 Appendix A.6 can be reproduced exactly.
 * Identifiers are made by `randomUUIDv7`.
 */
export function uuidV7From(milliseconds: number, random: Uint8Array): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > MAX_MILLISECONDS) {
    throw new RangeError('A UUIDv7 holds a whole number of milliseconds from 0 to 2^48 - 1.');
  }
  if (random.length !== 16) throw new RangeError('A UUIDv7 is made from 16 random bytes.');

  const bytes = Buffer.from(random);
  bytes.writeUIntBE(milliseconds, 0, 6);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A new UUIDv7: the primary identifier of every record (domain-model.md §3), "non-guessable ... and time-ordered so it indexes
 * well as a primary key".
 *
 * **The time is the injected clock's.** Identity code reads a clock only through the injected clock or the database
 * (SECURITY_DESIGN.md §13.3a), so a test that fixes the clock fixes the identifiers' time too, and nothing here reads the
 * machine's. Node's own `crypto.randomUUIDv7` reads it, and so is not used.
 *
 * The 74 random bits are fully random from a cryptographically secure generator. Two identifiers made in the same millisecond are
 * not ordered between themselves, and nothing orders identifiers across a clock that steps backwards: nothing here keeps a counter
 * or a high-water mark, and no rule of the design needs strict ordering. The identifier is time-ordered to the millisecond of the
 * clock it is given, no more.
 */
export function randomUUIDv7(clock: Pick<Clock, 'now'>): string {
  return uuidV7From(clock.now().getTime(), randomBytes(16));
}
