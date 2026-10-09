import type { PortDescriptor } from './port-descriptor.js';

export interface IssuedToken {
  /** Shown once and never stored: 32 random bytes as 43 base64url characters (SECURITY_DESIGN.md §14.9). */
  readonly token: string;
  /** The SHA-256 of the token: the only form kept at rest. */
  readonly hash: Uint8Array;
}

/**
 * High-entropy opaque tokens, stored only as a SHA-256 hash and compared in constant time. It knows nothing of what a token
 * is for (a session, a grant, a recovery link): the purpose is a property of the record that holds the hash.
 */
export interface TokenService {
  issue(): IssuedToken;
  /** The hash to look a presented token up by, or null when it is not a well-formed token and so cannot match anything. */
  hash(token: string): Uint8Array | null;
  matches(token: string, storedHash: Uint8Array): boolean;
}

export const TOKEN_SERVICE = Symbol('TOKEN_SERVICE');

export const TOKEN_SERVICE_DESCRIPTOR: PortDescriptor<TokenService> = {
  port: 'TokenService',
  owner: { kind: 'platform', area: 'auth/crypto' },
  operations: {
    issue: {
      inputs: 'none',
      outputs: 'a new token to show once, and its SHA-256 hash to store',
      outcomes: 'none',
      raises: 'none',
      transaction: 'independent',
    },
    hash: {
      inputs: 'a submitted token',
      outputs:
        'its SHA-256 hash, for lookup by hash, or null when the text is not a well-formed token',
      outcomes: ['TOKEN_MALFORMED'],
      raises: 'none',
      transaction: 'independent',
    },
    matches: {
      inputs: 'a submitted token and a stored hash',
      outputs:
        'whether they agree, compared in constant time; a malformed token simply does not match',
      outcomes: 'none',
      raises: 'none',
      transaction: 'independent',
    },
  },
};
