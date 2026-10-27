import { describe, expect, it } from 'vitest';

import { phoneBinding } from './rider-challenge-binding.js';
import { judgeChallenge } from './rider-challenge-judgement.js';
import type { RiderChallengeForDecision, StoredRiderChallenge } from './rider-challenge-store.js';
import type { RiderChallengeState } from './rider-vocabulary.js';

/**
 * How the first step of the rider's sign-in judges a presented challenge (SECURITY_DESIGN.md section 13.4b, "the rider order"): the binding is told
 * before the time, a terminal state is told as what it is, and a live challenge is `LIVE`. The database tests prove it against real rows; this is
 * the table of the rule, with each break it catches.
 */
const AUDIENCE = 'melarc-api/local';
const PHONE = '+99900000001';

function found(
  over: Partial<StoredRiderChallenge> = {},
  expired = false,
): RiderChallengeForDecision {
  return {
    expired,
    challenge: {
      id: '0198a0b0-0000-7000-8000-000000000001',
      riderIdentityId: null,
      issuedAt: new Date('2026-10-27T10:00:00Z'),
      expiresAt: new Date('2026-10-27T10:05:00Z'),
      state: 'PENDING',
      phoneHash: phoneBinding(PHONE),
      purpose: 'RIDER_SIGN_IN',
      audience: AUDIENCE,
      deviceContextHash: null,
      ...over,
    },
  };
}

const presented = { phoneHash: phoneBinding(PHONE), audience: AUDIENCE };

describe('judgeChallenge', () => {
  // Break caught: a challenge nobody issued accepted, or told as expired.
  it('is UNUSABLE for a challenge that is not there, with nothing to end', () => {
    expect(judgeChallenge(null, presented)).toEqual({ outcome: 'UNUSABLE', end: null });
  });

  // Break caught: a live challenge refused, or one judged live that is not.
  it('is LIVE for a PENDING challenge bound to what is presented and not past its time', () => {
    expect(judgeChallenge(found(), presented)).toEqual({ outcome: 'LIVE', end: null });
  });

  // Break caught: a terminal challenge accepted again (a replay), or a replay told as expired.
  it.each(['CONSUMED', 'UNUSABLE'] as const)(
    'is UNUSABLE for a %s challenge, with nothing to end',
    (state) => {
      expect(judgeChallenge(found({ state }), presented)).toEqual({
        outcome: 'UNUSABLE',
        end: null,
      });
    },
  );

  // Break caught: a lapse told as "unusable" (the rider is told to start again, not that the challenge is finished), a lapse not recorded, or
  // one recorded twice.
  it('is EXPIRED when the time has passed: recorded for a PENDING challenge and left alone once it is EXPIRED', () => {
    expect(judgeChallenge(found({}, true), presented)).toEqual({
      outcome: 'EXPIRED',
      end: 'EXPIRED',
    });
    expect(judgeChallenge(found({ state: 'EXPIRED' }, true), presented)).toEqual({
      outcome: 'EXPIRED',
      end: null,
    });
    expect(judgeChallenge(found({ state: 'EXPIRED' }), presented)).toEqual({
      outcome: 'EXPIRED',
      end: null,
    });
  });

  // Break caught: a terminal state overridden by the clock (a consumed challenge past its time told as expired, which would let a replay learn
  // that its first presentation was late).
  it('tells a consumed challenge past its time as UNUSABLE and not as expired', () => {
    expect(judgeChallenge(found({ state: 'CONSUMED' }, true), presented)).toEqual({
      outcome: 'UNUSABLE',
      end: null,
    });
  });

  // Break caught (13.4b: "bound to the phone number it was issued for … CHALLENGE_UNUSABLE for every number alike"): a challenge carried to
  // another number accepted, or told as expired, or left usable for the right number afterwards.
  it('is UNUSABLE, and ended, for another number, whatever the time says', () => {
    const other = { ...presented, phoneHash: phoneBinding('+99900000002') };

    expect(judgeChallenge(found(), other)).toEqual({ outcome: 'UNUSABLE', end: 'UNUSABLE' });
    expect(judgeChallenge(found({}, true), other)).toEqual({
      outcome: 'UNUSABLE',
      end: 'UNUSABLE',
    });
    // A challenge that is already finished has nothing left to end.
    expect(judgeChallenge(found({ state: 'CONSUMED' }), other)).toEqual({
      outcome: 'UNUSABLE',
      end: null,
    });
  });

  // Break caught: a challenge issued for another environment or service accepted.
  it('is UNUSABLE, and ended, for another service', () => {
    expect(judgeChallenge(found(), { ...presented, audience: 'melarc-api/production' })).toEqual({
      outcome: 'UNUSABLE',
      end: 'UNUSABLE',
    });
  });

  // Break caught (SECURITY_DESIGN 13.6: "sign-in and enrolment challenge namespaces stay separate"): a challenge of another purpose accepted.
  it('is UNUSABLE, and ended, for another purpose', () => {
    expect(judgeChallenge(found({ purpose: 'RIDER_DEVICE_ENROLMENT' }), presented)).toEqual({
      outcome: 'UNUSABLE',
      end: 'UNUSABLE',
    });
  });

  // Break caught: a state outside the four reaching the judgement as live.
  it('is never LIVE for a state it does not know', () => {
    const odd = found({ state: 'LOST' as RiderChallengeState });
    expect(judgeChallenge(odd, presented).outcome).not.toBe('LIVE');
  });
});
