import type { FactoryProvider } from '@nestjs/common';

import { CLOCK, type Clock } from '../ports/clock.port.js';
import { SECRET_CIPHER, type SecretCipher } from '../ports/secret-cipher.port.js';
import { MfaChallengeStore } from './mfa-challenge-store.js';
import { MfaFactorStore } from './mfa-factor-store.js';

/** The injection token of the store of MFA factors, which the credential and sign-in operations of the tasks after S0.29 ask for. */
export const MFA_FACTOR_STORE = Symbol('MFA_FACTOR_STORE');

/** The injection token of the store of MFA challenges, which the staff sign-in operations (S0.32, S0.33) ask for. */
export const MFA_CHALLENGE_STORE = Symbol('MFA_CHALLENGE_STORE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The store, built from the ports the composition root bound (S0.29) and `undefined` where one is missing: without the secret cipher
 * there is nothing to seal a seed with, so there is no store and an operation that asks for one fails closed. Nothing falls back to a
 * stand-in that stores a seed in the clear.
 */
export const mfaProviders: readonly FactoryProvider[] = [
  {
    provide: MFA_FACTOR_STORE,
    useFactory: (
      cipher: SecretCipher | undefined,
      clock: Clock | undefined,
    ): MfaFactorStore | undefined =>
      cipher === undefined || clock === undefined
        ? undefined
        : new MfaFactorStore({ cipher, clock }),
    inject: [optional(SECRET_CIPHER), optional(CLOCK)],
  },
  {
    // A challenge holds no secret, so it needs no cipher: only the clock that makes its identifier.
    provide: MFA_CHALLENGE_STORE,
    useFactory: (clock: Clock | undefined): MfaChallengeStore | undefined =>
      clock === undefined ? undefined : new MfaChallengeStore({ clock }),
    inject: [optional(CLOCK)],
  },
];
