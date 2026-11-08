import { describe, expect, it } from 'vitest';

import { decodePageToken, encodePageToken } from './staff-identity-page-token.js';

/**
 * The opaque `page_token` of `listStaffIdentities` (S0.35): the position after the last row of a page, in the order of the list
 * (the moment the record was created, then its id). It is a value the client sends back and the server reads as a position and
 * nothing else: whatever is not exactly a position is refused, so that a token is never a way to put anything into a statement.
 */
const POSITION = {
  createdAt: '2026-10-22 05:00:00.123456+00',
  id: '01a16207-68c5-7fd8-95cb-917caace6294',
};

describe('the page token of the staff list', () => {
  // Break caught: a token that does not come back as the position it was made from, or one that loses the microseconds the ordering
  // is made of (a page would then skip or repeat the rows that share a millisecond).
  it('reads back the position it was made from, microseconds included', () => {
    expect(decodePageToken(encodePageToken(POSITION))).toEqual(POSITION);
  });

  it('is URL-safe text, and shows no property of what it holds', () => {
    const token = encodePageToken(POSITION);

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  // Break caught: a token accepted that is not exactly a position: anything else would reach a statement as a value it was never
  // made as.
  it.each([
    ['text that is not base64url', 'not a token!'],
    ['an empty token', ''],
    ['JSON that is not a pair', Buffer.from('{"a":1}').toString('base64url')],
    ['a pair of numbers', Buffer.from('[1,2]').toString('base64url')],
    [
      'a position with a moment that is not a moment',
      Buffer.from(JSON.stringify(['yesterday', POSITION.id])).toString('base64url'),
    ],
    [
      'a position with an id that is not a UUID',
      Buffer.from(JSON.stringify([POSITION.createdAt, 'x'])).toString('base64url'),
    ],
    [
      'a position with a statement in the moment',
      Buffer.from(
        JSON.stringify([`${POSITION.createdAt}'; drop table x; --`, POSITION.id]),
      ).toString('base64url'),
    ],
    [
      'a pair with a third element',
      Buffer.from(JSON.stringify([POSITION.createdAt, POSITION.id, 'extra'])).toString('base64url'),
    ],
    ['a token of excessive length', 'A'.repeat(4096)],
  ])('refuses %s', (_name, token) => {
    expect(decodePageToken(token)).toBeUndefined();
  });

  // Break caught (F03 of the audit of 22 October 2026): a moment that has the shape of a timestamp and is none, accepted and sent to the
  // page query, which fails on it (a server error answered for a client's own text). Each case names the one thing that is wrong.
  const tokenOf = (createdAt: string): string =>
    Buffer.from(JSON.stringify([createdAt, POSITION.id])).toString('base64url');

  it.each([
    ['the forged moment of the audit', '2026-99-99 29:90:90+99'],
    ['a month 13', '2026-13-01 00:00:00+00'],
    ['a month 0', '2026-00-10 00:00:00+00'],
    ['a day 0', '2026-10-00 00:00:00+00'],
    ['a day 32', '2026-10-32 00:00:00+00'],
    ['a 31st of April', '2026-04-31 00:00:00+00'],
    ['a 30th of February', '2026-02-30 00:00:00+00'],
    ['a 29th of February of a common year', '2026-02-29 00:00:00+00'],
    ['a 29th of February of a century that is not a leap year', '1900-02-29 00:00:00+00'],
    ['year 0, which PostgreSQL does not have', '0000-06-15 00:00:00+00'],
    ['an hour 24', '2026-10-22 24:00:00+00'],
    ['a minute 60', '2026-10-22 05:60:00+00'],
    ['a second 60', '2026-10-22 05:00:60+00'],
    ['an offset of 16 hours', '2026-10-22 05:00:00+16'],
    ['an offset of 99 hours', '2026-10-22 05:00:00+99'],
    ['an offset of 60 minutes', '2026-10-22 05:00:00+01:60'],
  ])('refuses %s', (_name, createdAt) => {
    expect(decodePageToken(tokenOf(createdAt))).toBeUndefined();
  });

  // Break caught: the validation refusing a moment the database does print: a leap day (and the century that is a leap year), the last
  // second of a day with its last microsecond, the offsets PostgreSQL prints with minutes and the largest it admits. The text comes back as
  // it went in.
  it.each([
    ['a leap day', '2024-02-29 12:00:00+00'],
    ['a leap day of the century that is a leap year', '2000-02-29 12:00:00.5+00'],
    ['the last microsecond of a day', '2026-12-31 23:59:59.999999+00'],
    ['an offset with minutes, west', '2026-10-22 05:00:00.123456-08:30'],
    ['the largest offsets, east and west', '2026-10-22 05:00:00+15:59'],
    ['the largest offset west', '2026-10-22 05:00:00-15:59'],
    ['the first day PostgreSQL has', '0001-01-01 00:00:00+00'],
    ['microseconds that end in zeros', '2026-10-22 05:00:00.100000+00'],
  ])('reads %s back as it was written', (_name, createdAt) => {
    expect(decodePageToken(tokenOf(createdAt))).toEqual({
      createdAt,
      id: POSITION.id,
    });
  });

  // Break caught: the encoder making a token for a position the decoder would refuse.
  it('refuses to make a token of a position that is not one', () => {
    expect(() => encodePageToken({ createdAt: 'yesterday', id: POSITION.id })).toThrow(TypeError);
    expect(() => encodePageToken({ createdAt: POSITION.createdAt, id: 'x' })).toThrow(TypeError);
    expect(() => encodePageToken({ createdAt: '2026-99-99 29:90:90+99', id: POSITION.id })).toThrow(
      TypeError,
    );
  });
});
