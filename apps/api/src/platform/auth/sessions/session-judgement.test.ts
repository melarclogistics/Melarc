import { describe, expect, it } from 'vitest';

import type { StoredSession } from '../ports/session-store.port.js';
import { judgeSession } from './session-judgement.js';

/**
 * The decision a request is accepted or refused on (SECURITY_DESIGN.md §13.3 and §13.3a; state-machines.md §14): taken once, on one
 * fresh database time, by arithmetic on the session's own record. Equality is expired, for the absolute bound and for the idle one.
 */
const ISSUED = new Date('2026-10-11T08:00:00.000Z');
const MINUTE = 60_000;

function session(
  overrides: Partial<StoredSession> = {},
): Pick<
  StoredSession,
  'state' | 'terminationReason' | 'expiresAt' | 'lastActivityAt' | 'principalType'
> {
  return {
    principalType: 'STAFF',
    state: 'ACTIVE',
    terminationReason: null,
    expiresAt: new Date(ISSUED.getTime() + 480 * MINUTE),
    lastActivityAt: ISSUED,
    ...overrides,
  };
}

const at = (minutes: number, extraMilliseconds = 0): Date =>
  new Date(ISSUED.getTime() + minutes * MINUTE + extraMilliseconds);

describe('an active session', () => {
  it('is accepted before its absolute end and inside its idle limit', () => {
    expect(judgeSession(session(), at(5), 15)).toEqual({ kind: 'ACTIVE' });
    expect(judgeSession(session(), at(14, 59_999), 15)).toEqual({ kind: 'ACTIVE' });
  });

  // Break caught (§13.3a): "valid means now < expires_at; equality is expired", read as less-or-equal.
  it('is expired at the absolute end exactly, and after it', () => {
    const ending = session({ expiresAt: at(30) });

    // An idle limit far beyond the absolute end, so that only the absolute bound is in play.
    const idle = 10_000;

    expect(judgeSession(ending, at(30, -1), idle)).toEqual({ kind: 'ACTIVE' });
    expect(judgeSession(ending, at(30), idle)).toEqual({ kind: 'EXPIRED', cause: 'ABSOLUTE' });
    expect(judgeSession(ending, at(31), idle)).toEqual({ kind: 'EXPIRED', cause: 'ABSOLUTE' });
  });

  // Break caught: the idle limit read as "more than" and not "at least" (state-machines.md §14: `now - last_activity_at >= idle`).
  it('is expired when a browser session has been idle for the limit exactly', () => {
    expect(judgeSession(session(), at(15, -1), 15)).toEqual({ kind: 'ACTIVE' });
    expect(judgeSession(session(), at(15), 15)).toEqual({ kind: 'EXPIRED', cause: 'IDLE' });
    expect(judgeSession(session(), at(16), 15)).toEqual({ kind: 'EXPIRED', cause: 'IDLE' });
  });

  it('measures idleness from the recorded activity, not from the issue', () => {
    const active = session({ lastActivityAt: at(100) });

    expect(judgeSession(active, at(100 + 14), 15)).toEqual({ kind: 'ACTIVE' });
    expect(judgeSession(active, at(100 + 15), 15)).toEqual({ kind: 'EXPIRED', cause: 'IDLE' });
  });

  // Break caught (domain-model.md §6.8: "rider sessions maintain the field and are never terminated by it"): an idle rider ended.
  it('never ends a rider session for idleness, whatever its recorded activity', () => {
    const rider = session({ principalType: 'RIDER', expiresAt: at(1_440) });

    expect(judgeSession(rider, at(1_000), null)).toEqual({ kind: 'ACTIVE' });
    expect(judgeSession(rider, at(1_440), null)).toEqual({ kind: 'EXPIRED', cause: 'ABSOLUTE' });
  });

  // Break caught: a vendor session treated as having no idle rule because it is not staff.
  it('holds a vendor session to the idle limit like any browser session', () => {
    const vendor = session({ principalType: 'VENDOR' });

    expect(judgeSession(vendor, at(30), 30)).toEqual({ kind: 'EXPIRED', cause: 'IDLE' });
  });

  // Break caught: the absolute end passing unnoticed because the idle check came first and the session happened to be fresh.
  it('names the absolute end when both bounds are passed', () => {
    const both = session({ expiresAt: at(20), lastActivityAt: ISSUED });

    expect(judgeSession(both, at(60), 15)).toEqual({ kind: 'EXPIRED', cause: 'ABSOLUTE' });
  });

  // Break caught: a database clock that stepped back making a session look idle for a negative time, or ending it.
  it('is not idle when the recorded activity is later than the time it is judged at', () => {
    expect(judgeSession(session({ lastActivityAt: at(10) }), at(5), 15)).toEqual({
      kind: 'ACTIVE',
    });
  });
});

describe('an ended session', () => {
  // Break caught: an ended session served because its time had not come, or its reason lost.
  it('is refused with the reason it ended, however long it has left', () => {
    const ended = session({ state: 'TERMINATED', terminationReason: 'ADMIN_REVOKED' });

    expect(judgeSession(ended, at(1), 15)).toEqual({ kind: 'TERMINATED', reason: 'ADMIN_REVOKED' });
  });

  it('is refused as ended and not as expired when it is both', () => {
    const ended = session({
      state: 'TERMINATED',
      terminationReason: 'SUPERSEDED_BY_NEW_LOGIN',
      expiresAt: at(10),
    });

    expect(judgeSession(ended, at(60), 15)).toEqual({
      kind: 'TERMINATED',
      reason: 'SUPERSEDED_BY_NEW_LOGIN',
    });
  });
});

describe('a limit that is not a limit', () => {
  // Break caught: a missing or nonsensical setting read as "no idle rule" for a browser session, which is the permissive way to fail.
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses an idle limit of %s',
    (limit) => {
      expect(() => judgeSession(session(), at(1), limit)).toThrow(RangeError);
    },
  );

  // Break caught: a browser session with no idle limit given, which would be accepted for ever and so be the permissive way to fail.
  it.each(['STAFF', 'VENDOR'] as const)(
    'refuses to judge a %s session with no idle limit',
    (principalType) => {
      expect(() => judgeSession(session({ principalType }), at(1), null)).toThrow(RangeError);
    },
  );

  it('gives a rider no idle limit, and ignores one it is given', () => {
    const rider = session({ principalType: 'RIDER' });

    expect(judgeSession(rider, at(100), null)).toEqual({ kind: 'ACTIVE' });
    expect(judgeSession(rider, at(100), 15)).toEqual({ kind: 'ACTIVE' });
  });
});
