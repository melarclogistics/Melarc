/**
 * The credential rule a page can check for a person's convenience (contracts/openapi.yaml `CredentialSetup`; SECURITY_DESIGN section 13.4a;
 * AC-SLICE-000-87): a password is 12 to 128 characters, counted in Unicode code points, both as typed and after NFKC normalisation, and both
 * counts must hold. Spaces are allowed and nothing else is required: no mandatory case, digit or symbol. A password is never trimmed.
 *
 * This is a courtesy and not the rule: the server counts again before it hashes and answers `VALIDATION_FAILED` naming the field, so a page
 * that is looser than the server only costs a round trip, and one that is stricter would refuse a password the server accepts, which is why
 * this holds the two counts the contract names and no more. It never keeps or reports the value.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export type PasswordFault = 'too-short' | 'too-long';

/** Unicode code points: an astral character is one, a lone surrogate is one. `Array.from` walks a string by code point. */
const codePoints = (text: string): number => Array.from(text).length;

/** What is wrong with the length of a new password, or nothing when it is within the rule. */
export function passwordFault(password: string): PasswordFault | undefined {
  const typed = codePoints(password);
  const normalised = codePoints(password.normalize('NFKC'));
  if (typed < PASSWORD_MIN || normalised < PASSWORD_MIN) return 'too-short';
  if (typed > PASSWORD_MAX || normalised > PASSWORD_MAX) return 'too-long';
  return undefined;
}

/**
 * The one bound a sign-in has: the schema caps the password as sent at 128 so that a hash is never asked to chew an unbounded input, and
 * checks no minimum, because a short guess is simply a wrong password.
 */
export function signInPasswordTooLong(password: string): boolean {
  return codePoints(password) > PASSWORD_MAX;
}
