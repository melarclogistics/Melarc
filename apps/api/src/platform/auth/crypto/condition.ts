/**
 * The conditions the cryptographic adapters raise, by the names their port descriptors give under `raises`
 * (`ports/port-descriptor.ts`): plain named conditions, not a hierarchy of error classes. A caller that needs to tell one from
 * another reads `condition`; most let them propagate, and a request that meets one is a failed request, never a refused
 * credential. `condition.test.ts` keeps this list and the four descriptors the same.
 */
export const CRYPTO_CONDITIONS = [
  'PEPPER_UNAVAILABLE',
  'HASH_MALFORMED',
  'HASH_PROFILE_UNSUPPORTED',
  'SEED_MALFORMED',
  'PURPOSE_KEY_ABSENT',
  'KEY_VERSION_UNKNOWN',
  'ENVELOPE_VERSION_UNSUPPORTED',
  'AUTHENTICATION_FAILED',
] as const;

export type CryptoCondition = (typeof CRYPTO_CONDITIONS)[number];

/**
 * Fixed text, built from nothing that was supplied: what failed to authenticate or parse may be a secret, and so may what it was
 * compared with. Why a sealed value failed to authenticate is deliberately not said.
 */
const MESSAGES: Readonly<Record<CryptoCondition, string>> = Object.freeze({
  PEPPER_UNAVAILABLE: 'The password pepper this operation needs is not held.',
  HASH_MALFORMED: 'The stored credential hash is not in a form this service writes.',
  HASH_PROFILE_UNSUPPORTED:
    'The stored credential hash was made at a cost profile this service does not support.',
  SEED_MALFORMED: 'The TOTP seed is not a seed this service makes.',
  PURPOSE_KEY_ABSENT: 'No key is held for the purpose of this operation.',
  KEY_VERSION_UNKNOWN: 'The key version of this sealed value is not held.',
  ENVELOPE_VERSION_UNSUPPORTED: 'The envelope version of this sealed value is not supported.',
  AUTHENTICATION_FAILED: 'The sealed value did not authenticate.',
});

export class CryptoConditionError extends Error {
  constructor(readonly condition: CryptoCondition) {
    super(MESSAGES[condition]);
    this.name = 'CryptoConditionError';
  }
}
