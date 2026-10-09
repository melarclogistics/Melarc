import { codePointCount, isWellFormedUnicode } from './unicode.js';

/** The bounds of a staff password, the bootstrap password and a vendor shared secret, in Unicode code points. */
export const CREDENTIAL_MIN_CODE_POINTS = 12;
export const CREDENTIAL_MAX_CODE_POINTS = 128;

/**
 * What the rule decided. A refusal names its reason and which count it was made on, and never carries the text: a credential
 * must not reach a log or a serialiser through a result (SECURITY_DESIGN.md §13.4a: `details.field` names the field and never
 * the value).
 */
export type CredentialCheck =
  | {
      readonly ok: true;
      /** The NFKC form: what is hashed, at set time and at verify time alike. */
      readonly credential: string;
    }
  | { readonly ok: false; readonly refusal: 'MALFORMED_UNICODE' }
  | {
      readonly ok: false;
      readonly refusal: 'TOO_SHORT' | 'TOO_LONG';
      /** Which of the two counts failed: the text as sent, or the text after NFKC. */
      readonly counted: 'AS_SENT' | 'AFTER_NFKC';
    };

/**
 * The credential rule of SECURITY_DESIGN.md §13.4a, for both places it applies.
 *
 * Length is counted in Unicode code points. NFKC is applied before hashing, the same at set time and at verify time, and nothing
 * is trimmed, truncated or case-folded: spaces count and are kept. A lone surrogate is refused. Two bounds apply and both are
 * real: the text as sent (the request schemas' `minLength` and `maxLength`, counted again here so that no caller depends on the
 * schema having run) and the text after NFKC. Normalisation is never moved ahead of the first, so four U+FB03 ligatures, which are
 * twelve letters once normalised, are 4 as sent and are refused.
 */
function check(raw: string, minimum: number): CredentialCheck {
  if (!isWellFormedUnicode(raw)) return { ok: false, refusal: 'MALFORMED_UNICODE' };

  const asSent = codePointCount(raw, CREDENTIAL_MAX_CODE_POINTS);
  if (asSent > CREDENTIAL_MAX_CODE_POINTS) {
    return { ok: false, refusal: 'TOO_LONG', counted: 'AS_SENT' };
  }
  if (asSent < minimum) return { ok: false, refusal: 'TOO_SHORT', counted: 'AS_SENT' };

  // At most 128 code points go in and a compatibility character expands to at most 18, so this is bounded work.
  const credential = raw.normalize('NFKC');
  const afterNfkc = codePointCount(credential, CREDENTIAL_MAX_CODE_POINTS);
  if (afterNfkc > CREDENTIAL_MAX_CODE_POINTS) {
    return { ok: false, refusal: 'TOO_LONG', counted: 'AFTER_NFKC' };
  }
  if (afterNfkc < minimum) return { ok: false, refusal: 'TOO_SHORT', counted: 'AFTER_NFKC' };

  return { ok: true, credential };
}

/**
 * A credential being established (setup, recovery completion): 12 to 128 code points as sent and after NFKC. There is no change
 * operation in Version 1, so these two places are the only ones that create a credential.
 */
export function normaliseNewCredential(raw: string): CredentialCheck {
  return check(raw, CREDENTIAL_MIN_CODE_POINTS);
}

/**
 * A credential presented at sign-in: bounded, not policed. There is no minimum (a short guess is a wrong credential, answered
 * like any other) and a value that expands past 128 after NFKC is refused here so that the caller answers it without hashing it
 * (SECURITY_DESIGN.md §13.4a): an attacker cannot buy an expensive hash with a long input.
 */
export function normalisePresentedCredential(raw: string): CredentialCheck {
  return check(raw, 0);
}
