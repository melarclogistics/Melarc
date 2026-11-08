import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { Clock } from '../ports/clock.port.js';
import type { TotpVerdict, TotpVerifier } from '../ports/totp-verifier.port.js';
import { CryptoConditionError } from './condition.js';
import { hotp } from './hotp.js';

/** "Six digits, computed on a 30-second step with SHA-1, and one step either side of the current one is accepted" (§13.5). */
const STEP_MILLISECONDS = 30_000;
const DIGITS = 6;
const SKEW_STEPS = 1;
/** 160 bits, the length of the SHA-1 output (RFC 4226 section 4, requirement R6). Every seed this service makes is this long. */
const SEED_BYTES = 20;
/** `^[0-9]{6}$`: the contract's pattern for a TOTP code. Without the `m` flag `$` matches only at the very end. */
const CODE_SHAPE = /^[0-9]{6}$/;

/**
 * RFC 6238 time-based one-time codes for the privileged MFA factor (SECURITY_DESIGN.md §13.5): HMAC-SHA-1, 30-second steps with
 * T0 at the Unix epoch, six digits, and the current step and the one either side accepted.
 *
 * **Time is the injected clock's.** It reads `Clock.now()`, the UTC wall clock, once for each verification, and nothing else
 * (SECURITY_DESIGN.md §13.3a); a test sets the time it wants. **A code is single use.** The caller keeps the last step it accepted
 * with the factor and passes it back; a matching step that is not newer than that one is `REPLAYED`, and the caller records an
 * accepted step in its own transaction, beside the other effects of the sign-in. **This primitive does not prevent a concurrent
 * replay by itself:** it judges the step it is given. The use case must read the last accepted step, verify, and record the new
 * one as one atomic conditional update on the factor (the new step is greater than the stored one), so that of two requests
 * presenting one code exactly one wins.
 *
 * If a code fits more than one step of the window (one chance in about 10^6) the **latest** is the step reported: recording an
 * earlier one would let the same code in again two steps later.
 *
 * The code is compared with the code of every step in the window, whichever one matches, so the work does not say which step
 * it belonged to. A code that is not six ASCII digits is rejected before anything is computed. The seed is encrypted for storage
 * by the `SecretCipher`, never here; this class keeps none.
 */
export class Rfc6238TotpVerifier implements TotpVerifier {
  readonly #clock: Pick<Clock, 'now'>;

  constructor(clock: Pick<Clock, 'now'>) {
    this.#clock = clock;
  }

  newSeed(): Uint8Array {
    return new Uint8Array(randomBytes(SEED_BYTES));
  }

  verify(seed: Uint8Array, code: string, lastAcceptedStep: number | null): TotpVerdict {
    // The seed and the step come from this service's own records: a wrong one is a fault, not a refused code.
    if (!(seed instanceof Uint8Array) || seed.length !== SEED_BYTES) {
      throw new CryptoConditionError('SEED_MALFORMED');
    }
    const last: unknown = lastAcceptedStep;
    if (last !== null && !(typeof last === 'number' && Number.isSafeInteger(last) && last >= 0)) {
      throw new RangeError('The last accepted step is a whole number of steps, or null.');
    }

    const submitted: unknown = code;
    if (typeof submitted !== 'string' || !CODE_SHAPE.test(submitted))
      return { outcome: 'REJECTED' };

    const milliseconds = this.#clock.now().getTime();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new RangeError('The clock gave no instant a TOTP step can be counted from.');
    }
    const current = Math.floor(milliseconds / STEP_MILLISECONDS);
    const offered = Buffer.from(submitted, 'ascii');

    // Every step of the window is worked out and compared, in time order, whichever one matches.
    const matching: number[] = [];
    for (let step = current - SKEW_STEPS; step <= current + SKEW_STEPS; step += 1) {
      if (step < 0) continue;
      if (timingSafeEqual(offered, Buffer.from(hotp(seed, step, DIGITS), 'ascii')))
        matching.push(step);
    }

    const latest = matching.at(-1);
    if (latest === undefined) return { outcome: 'REJECTED' };
    return last === null || latest > last
      ? { outcome: 'ACCEPTED', step: latest }
      : { outcome: 'REPLAYED', step: latest };
  }
}
