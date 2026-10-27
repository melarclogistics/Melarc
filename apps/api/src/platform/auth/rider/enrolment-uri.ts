import { CHALLENGE_BYTES, CHALLENGE_CHARACTERS } from './rider-vocabulary.js';

/**
 * The version-1 enrolment URI the Ops Portal renders as a QR code for the rider's handset to scan (SECURITY_DESIGN.md section 13.6;
 * openapi.yaml `DeviceEnrolmentGrant.enrolment_uri`; Product decision, 8 October 2026):
 *
 * `melarc-rider://enrol/v1#token=<base64url-token>&challenge=<base64url-challenge>`
 *
 * The exact scheme, the host `enrol` and the path `v1`; exactly one `token` and one `challenge` in the fragment, the token first; each
 * the unpadded canonical base64url of 32 random bytes (43 characters), so the whole payload is exactly **127 ASCII characters**. The URI
 * never tells the app which host to call: there is no callback, no origin, no redirect, no port and no user-info in it, and a parser
 * refuses every one of them, and every other shape, without a network call. The token is the single-use grant; the challenge is the
 * single-use attestation challenge the handset binds into its key attestation after decoding it to its 32 bytes.
 *
 * This is a **transient credential**: it is built from a token that exists nowhere else, returned once (and replayed, sealed, for the one
 * operation that may), and is never logged, audited, cached or kept in a query cache.
 */
const PREFIX = 'melarc-rider://enrol/v1#token=';
const SEPARATOR = '&challenge=';

/** The length of the whole payload: the prefix, a 43-character token, the separator and a 43-character challenge. */
export const ENROLMENT_URI_LENGTH =
  PREFIX.length + CHALLENGE_CHARACTERS + SEPARATOR.length + CHALLENGE_CHARACTERS;

/**
 * The pattern the contract states for the shape (`DeviceEnrolmentGrant.enrolment_uri`): the shape only. A reader also refuses a value that
 * does not decode to 32 bytes and re-encode to itself, which a pattern cannot say (`parseEnrolmentUri`).
 */
export const ENROLMENT_URI_PATTERN =
  '^melarc-rider://enrol/v1#token=[A-Za-z0-9_-]{43}&challenge=[A-Za-z0-9_-]{43}$';

/**
 * The character class of unpadded base64url, and nothing else. The comparison with the re-encoding refuses every other character as well
 * (Node's decoder is lenient and its encoder is not), so this is no further refusal: it states the alphabet instead of leaving it to be
 * inferred from a decoder's behaviour.
 */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Whether `text` is the unpadded **canonical** base64url of exactly 32 bytes: 43 characters of the alphabet, which decode to 32 bytes and
 * re-encode to the same text. The last character of 32 bytes carries four bits and two that must be zero, so a text whose last
 * character does not (there are 16 that do) is another spelling of the same bytes and is refused: one value has one representation.
 */
export function isCanonicalBase64Url32(text: unknown): text is string {
  if (typeof text !== 'string' || text.length !== CHALLENGE_CHARACTERS || !BASE64URL.test(text)) {
    return false;
  }
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length === CHALLENGE_BYTES && bytes.toString('base64url') === text;
}

/** The URI for a grant token and its attestation challenge, both in the form `TokenService.issue` makes. A value that is not one is a defect. */
export function buildEnrolmentUri(token: string, challenge: string): string {
  if (!isCanonicalBase64Url32(token) || !isCanonicalBase64Url32(challenge)) {
    throw new TypeError('An enrolment URI is made of a token and a challenge of 32 bytes each');
  }
  return `${PREFIX}${token}${SEPARATOR}${challenge}`;
}

export interface ParsedEnrolmentUri {
  readonly token: string;
  readonly challenge: string;
}

/**
 * The strict reader of the URI, the one the Rider app implements and the published vectors hold both to: `null` for everything that is not
 * exactly the version-1 form (another scheme, host, path or version, a missing, duplicated, reordered, extra or empty parameter, padding,
 * the standard base64 alphabet, a value that does not decode to 32 bytes and re-encode to itself, whitespace, a query, a port,
 * user-info, a callback or a redirect, and any text before or after). It reads a string and calls nothing.
 */
export function parseEnrolmentUri(uri: unknown): ParsedEnrolmentUri | null {
  // The length is the contract's own statement (exactly 127 characters); the 43-character slices below could not accept a text of another
  // length, so this states the bound before any slice is made and refuses a long text without reading it.
  if (typeof uri !== 'string' || uri.length !== ENROLMENT_URI_LENGTH || !uri.startsWith(PREFIX)) {
    return null;
  }
  const token = uri.slice(PREFIX.length, PREFIX.length + CHALLENGE_CHARACTERS);
  const separator = uri.slice(
    PREFIX.length + CHALLENGE_CHARACTERS,
    PREFIX.length + CHALLENGE_CHARACTERS + SEPARATOR.length,
  );
  const challenge = uri.slice(PREFIX.length + CHALLENGE_CHARACTERS + SEPARATOR.length);
  if (
    separator !== SEPARATOR ||
    !isCanonicalBase64Url32(token) ||
    !isCanonicalBase64Url32(challenge)
  ) {
    return null;
  }
  return { token, challenge };
}
