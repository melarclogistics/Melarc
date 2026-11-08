import type { PortDescriptor } from './port-descriptor.js';

export type TotpVerdict =
  | { readonly outcome: 'ACCEPTED'; readonly step: number }
  | { readonly outcome: 'REPLAYED'; readonly step: number }
  | { readonly outcome: 'REJECTED' };

/**
 * RFC 6238 time-based codes, six digits, one step either side of the present, on the injected UTC wall clock. A code is
 * single-use: the caller keeps the last accepted step with the factor and passes it back, so a step that is not newer is
 * `REPLAYED`. Recording the step happens in the caller's transaction, beside the other effects of the sign-in.
 */
export interface TotpVerifier {
  /** A new random seed for an enrolment. Sealing it for storage is the cipher's job. */
  newSeed(): Uint8Array;
  verify(seed: Uint8Array, code: string, lastAcceptedStep: number | null): TotpVerdict;
}

export const TOTP_VERIFIER = Symbol('TOTP_VERIFIER');

export const TOTP_VERIFIER_DESCRIPTOR: PortDescriptor<TotpVerifier> = {
  port: 'TotpVerifier',
  owner: { kind: 'platform', area: 'auth/crypto' },
  operations: {
    newSeed: {
      inputs: 'none',
      outputs: 'a new random TOTP seed',
      outcomes: 'none',
      raises: 'none',
      transaction: 'independent',
    },
    verify: {
      inputs: 'the seed, the submitted code and the last accepted step (null when none)',
      outputs:
        'ACCEPTED with the step to record, REPLAYED when the matching step is not newer than the last accepted one, or REJECTED',
      outcomes: ['REPLAYED', 'REJECTED'],
      raises: ['SEED_MALFORMED'],
      transaction: 'independent',
    },
  },
};
