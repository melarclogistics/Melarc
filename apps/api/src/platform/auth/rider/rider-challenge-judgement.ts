import { sameBinding } from './rider-challenge-binding.js';
import type { RiderChallengeForDecision } from './rider-challenge-store.js';
import { RIDER_CHALLENGE_PURPOSE } from './rider-vocabulary.js';

/** What a presented challenge is held to: the number it is presented with and the service that is asked. */
export interface PresentedChallenge {
  readonly phoneHash: Uint8Array;
  readonly audience: string;
}

/**
 * How the first step of the rider's sign-in judges the challenge (SECURITY_DESIGN.md section 13.4b, "the rider order"; rider-authentication.md
 * section 5.5):
 *
 * - `UNUSABLE`: unknown or consumed or ended, **or bound to something else**: another number (a number that matched no rider included, so the
 *   answer is the same for every number alike), another purpose or another service. Told before the time is, so a challenge carried to
 *   the wrong place is never "expired".
 * - `EXPIRED`: its time has passed.
 * - `LIVE`: anything else, and it is **ended by this presentation, pass or fail**.
 *
 * `end` says what to do to a challenge that is still `PENDING` and is not `LIVE`: a binding that does not hold finishes it (`UNUSABLE`), and a
 * lapse is recorded (`EXPIRED`); a challenge that is already terminal is left as it is.
 */
export interface ChallengeJudgement {
  readonly outcome: 'LIVE' | 'UNUSABLE' | 'EXPIRED';
  readonly end: 'UNUSABLE' | 'EXPIRED' | null;
}

const UNUSABLE_AS_IT_IS: ChallengeJudgement = Object.freeze({ outcome: 'UNUSABLE', end: null });

export function judgeChallenge(
  found: RiderChallengeForDecision | null,
  presented: PresentedChallenge,
): ChallengeJudgement {
  if (found === null) return UNUSABLE_AS_IT_IS;
  const { challenge, expired } = found;
  const bound =
    challenge.purpose === RIDER_CHALLENGE_PURPOSE &&
    challenge.audience === presented.audience &&
    sameBinding(challenge.phoneHash, presented.phoneHash);
  if (!bound) {
    return challenge.state === 'PENDING'
      ? { outcome: 'UNUSABLE', end: 'UNUSABLE' }
      : UNUSABLE_AS_IT_IS;
  }
  if (challenge.state === 'EXPIRED') return { outcome: 'EXPIRED', end: null };
  // Live is established and never assumed: only a PENDING challenge can be, so a consumed or ended one, and a state this code does not know,
  // is finished.
  if (challenge.state !== 'PENDING') return UNUSABLE_AS_IT_IS;
  if (expired) return { outcome: 'EXPIRED', end: 'EXPIRED' };
  return { outcome: 'LIVE', end: null };
}
