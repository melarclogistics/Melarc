import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { ACCESS_DETAIL_KEY, type AccessDetail } from '../../routes/access-declaration.js';
import { setupTokenLimit } from '../staff/staff-setup-limit.js';
import { RiderEnrolmentController } from './rider-enrolment.controller.js';
import { MAX_PHONE_BYTES, RIDER_PHONE_LIMIT } from './rider-sign-in-limit.js';
import { RiderSignInController } from './rider-sign-in.controller.js';

const TOKEN = 'A'.repeat(43);

/** What a route declares about its limit and its client: read from the handler of the controller's method, as the guards read it. */
function declared(controller: { readonly prototype: object }, method: string): AccessDetail {
  const handler = (controller.prototype as Record<string, object | undefined>)[method];
  if (handler === undefined) throw new Error(`The controller has no method ${method}`);
  const detail = Reflect.getMetadata(ACCESS_DETAIL_KEY, handler) as AccessDetail | undefined;
  if (detail === undefined) throw new Error('The route declares nothing');
  return detail;
}

describe('how the rider’s three pre-session routes are limited and who they serve', () => {
  // Break caught: the rider's enrolment taking another operation's key space (the vendor browser's, the staff member's) or none of its own,
  // so that a token tried there spends an allowance somewhere else. `staff-setup-limit.test.ts` holds the six key spaces apart; this holds the
  // controller to the one that is its own.
  it('limits the enrolment by the digest of the token it presents, in the key space of a rider’s device', () => {
    const { limit, client } = declared(RiderEnrolmentController, 'completeRiderDeviceEnrolment');

    expect(limit?.bucket).toBe('rate_limit_recovery');
    expect(limit?.identifier).toEqual({ field: 'setup_token', maxBytes: 128 });
    expect(limit?.canonical(TOKEN)).toBe(
      setupTokenLimit('RIDER_DEVICE_ENROLMENT').canonical(TOKEN),
    );
    for (const other of [
      'STAFF_CREDENTIAL_SETUP',
      'MFA_ENROLMENT',
      'MFA_REENROLMENT',
      'VENDOR_CREDENTIAL_SETUP',
      'VENDOR_DEVICE_ENROLMENT',
    ] as const) {
      expect(limit?.canonical(TOKEN)).not.toBe(setupTokenLimit(other).canonical(TOKEN));
    }
    expect(client).toEqual({ kind: 'native' });
  });

  // Break caught: the two sign-in operations in buckets of their own (a rider who is asked for a challenge would then have twenty more
  // attempts at the sign-in), or keyed on anything but the number.
  it('draws the challenge and the sign-in on the one bucket, keyed on the number of the body', () => {
    for (const method of ['requestChallenge', 'signIn']) {
      const { limit, client } = declared(RiderSignInController, method);

      expect(limit?.bucket).toBe('rate_limit_rider_challenge');
      expect(limit?.identifier).toEqual({ field: 'phone', maxBytes: MAX_PHONE_BYTES });
      expect(limit?.canonical('+233201234567')).toBe('+233201234567');
      expect(client).toEqual({ kind: 'native' });
    }
    expect(RIDER_PHONE_LIMIT.bucket).toBe('rate_limit_rider_challenge');
  });

  it('holds the identifier to the longest E.164 number, a plus sign and fifteen digits', () => {
    expect(MAX_PHONE_BYTES).toBe(16);
    expect('+233201234567890'.length).toBe(MAX_PHONE_BYTES);
  });

  // Break caught: a number folded, trimmed or completed on its way to a key, which would give one rider two keys (or two riders one), and a
  // text that is not a number taking a key and spending the allowance of a number that is.
  it('keys on the number exactly as it is written when it is E.164, and takes no key for any other text', () => {
    const { canonical } = RIDER_PHONE_LIMIT;

    expect(canonical('+233201234567')).toBe('+233201234567');
    // The edges of the form: eight digits to fifteen, the first not a zero.
    expect(canonical('+23320123')).toBe('+23320123');
    expect(canonical('+233201234567890')).toBe('+233201234567890');
    for (const text of [
      '+2332012',
      '+2332012345678901',
      '+0233201234567',
      ' +233201234567',
      '+233201234567 ',
      '+233201234567\n',
      '233201234567',
      '+233 20 123 4567',
      '+233-20-123-4567',
      '+٢٣٣201234567',
      '',
      'x',
    ]) {
      expect(canonical(text), JSON.stringify(text)).toBeUndefined();
    }
  });
});
