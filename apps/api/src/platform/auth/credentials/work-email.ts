import { isWellFormedUnicode } from './unicode.js';

export type CanonicalWorkEmail =
  | { readonly ok: true; readonly email: string }
  | { readonly ok: false; readonly refusal: 'MALFORMED_UNICODE' };

/**
 * The canonical form of a work email (domain-model.md §6.8, Product decision of 6 October 2026): the address is trimmed,
 * normalised to Unicode NFKC and lower-cased as a whole, in that order. It decides uniqueness (`WORK_EMAIL_IN_USE`) and is the key
 * of the staff sign-in rate limit, and the address itself is stored and displayed as entered. **No dot or plus-tag folding.**
 *
 * It canonicalises and judges nothing else. The address is canonicalised first and only then checked to be an email address
 * (`VALIDATION_FAILED`), so a padded or non-ASCII address is not refused before it can be canonicalised. Trimming is
 * `String.prototype.trim`: white space and line terminators. Lower-casing is the locale-independent Unicode mapping, so the
 * machine's language never changes who an address belongs to.
 *
 * A lone surrogate is refused rather than carried into a unique index, where the database driver would write U+FFFD for it and
 * two different malformed addresses would collide.
 */
export function canonicalWorkEmail(raw: string): CanonicalWorkEmail {
  if (!isWellFormedUnicode(raw)) return { ok: false, refusal: 'MALFORMED_UNICODE' };
  return { ok: true, email: raw.trim().normalize('NFKC').toLowerCase() };
}
