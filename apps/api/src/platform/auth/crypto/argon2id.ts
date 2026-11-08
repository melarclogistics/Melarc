import { argon2 } from 'node:crypto';

import {
  ARGON2ID_TAG_BYTES,
  assertArgon2idParameters,
  type Argon2idParameters,
} from './argon2-parameters.js';

export interface Argon2idInput {
  /** The password: the UTF-8 bytes of a text the credential rule has already normalised. */
  readonly message: Uint8Array;
  readonly salt: Uint8Array;
  readonly parameters: Argon2idParameters;
  /** Argon2's secret value K (RFC 9106): the pepper, which is held outside the database and is not stored with the hash. */
  readonly pepper: Uint8Array;
  /** Argon2's associated data X (RFC 9106): what the hash is bound to besides the secret. Empty when nothing. */
  readonly associatedData: Uint8Array;
}

/** The shortest salt the algorithm allows. The hashes this service writes carry 16 bytes; a published vector may use fewer. */
const MIN_SALT_BYTES = 8;

/**
 * Argon2id through Node's built-in `crypto.argon2`: the one place the application calls it, and the place the limits of
 * `ARGON2ID_LIMITS` are applied before the library is reached. It runs on the libuv thread pool, so it is off the event loop
 * (SECURITY_DESIGN.md §13.4c: a synchronous hash on a request path is a defect), and it occupies one thread of that shared pool
 * for the length of the derivation.
 *
 * The qualification the plan asks for (S0.3a) is `argon2id.test.ts`: the RFC 9106 section 5.3 vector and the Argon2 reference
 * implementation's, against this function, on the pinned Node.
 */
export function argon2idTag(input: Argon2idInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    assertArgon2idParameters(input.parameters);
    if (input.salt.length < MIN_SALT_BYTES) {
      throw new RangeError('An Argon2id salt is at least 8 bytes.');
    }
    argon2(
      'argon2id',
      {
        message: input.message,
        nonce: input.salt,
        parallelism: input.parameters.parallelism,
        tagLength: ARGON2ID_TAG_BYTES,
        memory: input.parameters.memoryKiB,
        passes: input.parameters.passes,
        // An absent input and an empty one are the same to the algorithm, and the library asks for the first.
        ...(input.pepper.length === 0 ? {} : { secret: input.pepper }),
        ...(input.associatedData.length === 0 ? {} : { associatedData: input.associatedData }),
      },
      (error, tag) => {
        if (error === null) resolve(tag);
        else reject(error);
      },
    );
  });
}
