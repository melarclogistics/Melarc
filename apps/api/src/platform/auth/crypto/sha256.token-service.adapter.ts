import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { IssuedToken, TokenService } from '../ports/token-service.port.js';
import { decodeBase64Url32 } from './canonical-base64url.js';

const HASH_BYTES = 32;

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(bytes).digest());

/**
 * High-entropy opaque tokens, kept only as a SHA-256 hash and compared in constant time (SECURITY_DESIGN.md §13.1, §14.9). A
 * session, a setup grant, a recovery token, a CSRF token and a device secret are all this: 32 random bytes from the platform's
 * cryptographically secure generator, shown as 43 characters of unpadded base64url. Human-password cost buys nothing for them and
 * would be paid on every request, so the hash is one fast SHA-256.
 *
 * **The hash is of the 32 bytes the token spells**, and not of its 43 characters. The canonical form (`decodeBase64Url32`) makes
 * the two a one-to-one pair, so nothing is lost; what is fixed is that one definition is used by every task that stores or
 * looks up a hash, through this port: no store, query or lookup hashes the displayed token text itself.
 * `sha256.token-service.adapter.test.ts` pins it with a published value.
 *
 * It knows nothing of what a token is for: the purpose belongs to the record that holds the hash. It keeps no state and no
 * token. A presented value is judged by shape before it is hashed (`hash` returns null), so a malformed value costs one pattern
 * test and is not told apart from an unknown token.
 */
export class Sha256TokenService implements TokenService {
  issue(): IssuedToken {
    const bytes = randomBytes(HASH_BYTES);
    return { token: bytes.toString('base64url'), hash: sha256(bytes) };
  }

  hash(token: string): Uint8Array | null {
    const bytes = decodeBase64Url32(token);
    return bytes === undefined ? null : sha256(bytes);
  }

  matches(token: string, storedHash: Uint8Array): boolean {
    const presented = this.hash(token);
    // A stored value of the wrong length is a corrupt row, which reads as "does not match": `timingSafeEqual` would throw.
    if (
      presented === null ||
      !(storedHash instanceof Uint8Array) ||
      storedHash.length !== HASH_BYTES
    ) {
      return false;
    }
    return timingSafeEqual(presented, storedHash);
  }
}
