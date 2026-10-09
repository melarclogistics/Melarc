import type { PortDescriptor } from './port-descriptor.js';

/** What a hash protects: the three secrets Argon2id covers (SECURITY_DESIGN.md §13.4). */
export type HashedCredentialKind = 'STAFF_PASSWORD' | 'VENDOR_SECRET' | 'RIDER_PIN';

export interface HashVerdict {
  readonly matches: boolean;
  /**
   * The stored hash may be replaced on this success: the adapter's write profile or active pepper is a forward move from the one
   * the hash records, and neither is a step back (`crypto/rehash-policy.ts`). It is permission, not an instruction, and it is never
   * true for a hash the adapter would only be moving to an older cost or an older pepper.
   */
  readonly needsRehash: boolean;
}

/**
 * Asynchronous Argon2id with a versioned server-side pepper (SECURITY_DESIGN.md §13.4, §13.4c). Hashing runs off the request's
 * event loop and never holds a connection or a lock, so it is called outside any transaction and only after hash admission.
 * The secret it receives has already passed the credential rule (§13.4a); nothing here normalises it.
 */
export interface Hasher {
  hash(kind: HashedCredentialKind, secret: string): Promise<string>;
  verify(kind: HashedCredentialKind, secret: string, encodedHash: string): Promise<HashVerdict>;
  /**
   * One derivation against a fixed dummy hash at the current write profile, result discarded. A branch that reached no
   * credential, or a locked one, still does exactly one derivation. That bounds the work and makes the branches alike in kind; it
   * does not make them equal in cost while hashes made at an older profile are still being verified at the profile they were
   * made with, and equal timing stays a diagnostic and never the proof (SECURITY_DESIGN.md §13.4b).
   */
  verifyAgainstDummy(kind: HashedCredentialKind, secret: string): Promise<void>;
}

export const HASHER = Symbol('HASHER');

export const HASHER_DESCRIPTOR: PortDescriptor<Hasher> = {
  port: 'Hasher',
  owner: { kind: 'platform', area: 'auth/crypto' },
  operations: {
    hash: {
      inputs: 'the credential kind and the secret, already normalised and bounds-checked',
      outputs: 'an encoded Argon2id hash that carries its parameters and the pepper version',
      outcomes: 'none',
      raises: ['PEPPER_UNAVAILABLE'],
      transaction: 'outside-any-transaction',
    },
    verify: {
      inputs: 'the credential kind, the submitted secret and the stored encoded hash',
      outputs:
        'whether it matches, and whether the stored hash may be replaced on this success (forward only: never to an older cost or pepper)',
      outcomes: 'none',
      raises: ['PEPPER_UNAVAILABLE', 'HASH_MALFORMED', 'HASH_PROFILE_UNSUPPORTED'],
      transaction: 'outside-any-transaction',
    },
    verifyAgainstDummy: {
      inputs: 'the credential kind and the submitted secret',
      outputs: 'nothing: the work of one verification is done and the result discarded',
      outcomes: 'none',
      raises: ['PEPPER_UNAVAILABLE'],
      transaction: 'outside-any-transaction',
    },
  },
};
