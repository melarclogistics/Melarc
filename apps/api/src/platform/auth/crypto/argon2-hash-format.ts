import {
  ARGON2ID_SALT_BYTES,
  ARGON2ID_TAG_BYTES,
  isValidArgon2idParameters,
  type Argon2idParameters,
} from './argon2-parameters.js';

/** What a stored credential hash holds. */
export interface Argon2idHash {
  readonly parameters: Argon2idParameters;
  /** The version of the pepper the hash was made under (`pepper_version`, SECURITY_DESIGN.md §14.9). */
  readonly pepperVersion: number;
  readonly salt: Uint8Array;
  readonly tag: Uint8Array;
}

/** The largest pepper version a configuration can name (`KEY_*_ACTIVE_VERSION` is 1 to 999999). */
export const MAX_PEPPER_VERSION = 999_999;

/**
 * The PHC string format with one parameter of this service's own:
 *
 *     $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>,pv=<pepper version>$<salt>$<tag>
 *
 * Salt and tag are unpadded standard base64. `pv` is the pepper version, which the design requires every credential hash to
 * record so that rotation is additive: an old hash verifies under its own version and is rehashed on a successful sign-in. Another
 * Argon2 implementation cannot verify these strings, and could not in any case: the pepper is a secret it does not hold.
 *
 * The format is exact. The parameters come in this order, numbers carry no sign and no leading zero, the salt and tag are
 * canonical (the spare bits of the last character are clear) and of the one length each has, and nothing precedes or follows.
 * Anything else is not a hash this service wrote (see `decodeArgon2idHash`).
 */
const SHAPE =
  /^\$argon2id\$v=19\$m=([1-9]\d{0,9}),t=([1-9]\d{0,9}),p=([1-9]\d{0,9}),pv=([1-9]\d{0,5})\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;

/** The longest string the format can write is under 100 characters; a longer one is refused before anything reads it. */
const LONGEST = 200;

const unpadded = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64').replace(/=+$/, '');

/** The bytes of canonical unpadded base64 of the given length, or undefined for any other spelling. */
function bytesOf(text: string, length: number): Buffer | undefined {
  const bytes = Buffer.from(text, 'base64');
  return bytes.length === length && unpadded(bytes) === text ? bytes : undefined;
}

export function encodeArgon2idHash(hash: Argon2idHash): string {
  if (
    !isValidArgon2idParameters(hash.parameters) ||
    !Number.isSafeInteger(hash.pepperVersion) ||
    hash.pepperVersion < 1 ||
    hash.pepperVersion > MAX_PEPPER_VERSION ||
    hash.salt.length !== ARGON2ID_SALT_BYTES ||
    hash.tag.length !== ARGON2ID_TAG_BYTES
  ) {
    throw new RangeError('This is not an Argon2id hash this service can write.');
  }
  const { memoryKiB, passes, parallelism } = hash.parameters;
  return `$argon2id$v=19$m=${String(memoryKiB)},t=${String(passes)},p=${String(parallelism)},pv=${String(hash.pepperVersion)}$${unpadded(hash.salt)}$${unpadded(hash.tag)}`;
}

/**
 * Reads what `encodeArgon2idHash` wrote, or returns undefined. The value comes from a database column and is not trusted to be
 * what this service wrote, so it is read before anything is hashed and must not be able to ask for unbounded memory or time:
 * the parameters are held to the limits of `ARGON2ID_LIMITS` here, and an old hash at an older cost is still read.
 */
export function decodeArgon2idHash(text: unknown): Argon2idHash | undefined {
  if (typeof text !== 'string' || text.length > LONGEST) return undefined;
  const match = SHAPE.exec(text);
  if (match === null) return undefined;
  const [, memory = '', passes = '', lanes = '', pepper = '', saltText = '', tagText = ''] = match;

  const parameters = {
    memoryKiB: Number(memory),
    passes: Number(passes),
    parallelism: Number(lanes),
  };
  const salt = bytesOf(saltText, ARGON2ID_SALT_BYTES);
  const tag = bytesOf(tagText, ARGON2ID_TAG_BYTES);
  if (!isValidArgon2idParameters(parameters) || salt === undefined || tag === undefined) {
    return undefined;
  }
  return { parameters, pepperVersion: Number(pepper), salt, tag };
}
