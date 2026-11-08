/**
 * The ETag of a record version, and the `If-Match` that sends it back (openapi.yaml, rule 3: every mutation is optimistically
 * concurrent; a mismatch is 409 `STATE_CONFLICT`). The contract calls the ETag an "opaque record version" and does not fix its
 * form; this is the form, so every read writes it and every mutation reads it the same way: the record's version number, a
 * non-negative integer, as a **strong** validator in quotes (`"7"`).
 *
 * `If-Match` is read strictly. It names exactly one version in this form. A weak validator (`W/"7"`), a list, `*`, an unquoted
 * number, a number with a leading zero or a sign, whitespace and anything beyond a safe integer are not a version, and a
 * precondition that is not a version does not match: a mutation never goes ahead on a header it could not read. The mapping of
 * a missing or unreadable header to its error (`VALIDATION_FAILED` or `STATE_CONFLICT`) is the pipeline's, so this reports
 * `undefined` and nothing more.
 *
 * A record's version changes when anything its read returns changes, and for nothing else (domain-model.md §6.8): that rule is
 * the owner of each record's task, not of this module.
 */
const IF_MATCH = /^"(0|[1-9][0-9]{0,15})"$/;

/** The ETag for a version. */
export function etagOf(version: number): string {
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new RangeError('A record version is a non-negative safe integer');
  }
  return `"${String(version)}"`;
}

/** The version an `If-Match` header names, or `undefined` if it is not exactly one strong quoted decimal. */
export function ifMatchVersion(header: string | undefined): number | undefined {
  if (typeof header !== 'string' || !IF_MATCH.test(header)) return undefined;
  const version = Number(header.slice(1, -1));
  return Number.isSafeInteger(version) ? version : undefined;
}

/** Whether the header names exactly the current version. Missing, unreadable and different all answer `false`. */
export function versionMatches(header: string | undefined, current: number): boolean {
  const named = ifMatchVersion(header);
  return named !== undefined && named === current;
}
