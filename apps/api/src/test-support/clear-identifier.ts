/**
 * Looks for identifiers in the text of a database row: the limiter's table must hold a keyed digest and no identifier
 * (SECURITY_DESIGN.md section 14.12), and a test asks the table for its rows as text and checks that none of the identifiers it signed in
 * with is there. Test support, excluded from the build.
 *
 * **An identifier is looked for as a whole word, never as a substring.** The row is mostly hexadecimal (a uuid and a keyed digest of 64
 * characters), and a short word made only of the letters a to f, such as "ada", turns up inside a random digest about once in 60 rows. A
 * substring check on such a word fails a run by chance and says nothing: the hosted run of 13 October 2026 failed its database job on a
 * digest that held "ada" and no identifier. A word that is a stored identifier is delimited by something that is not a letter or a digit
 * (a comma, a quote, a colon, an underscore, an at sign); a run of hexadecimal characters has no such delimiter inside it, so the word is
 * never found in one, and the check cannot be failed by chance.
 */

const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The first of `identifiers` that stands as a whole word in `row` (case ignored), or `undefined` when none does. Each identifier is taken
 * literally. A word is whole when no letter or digit comes before or after it.
 */
export function clearIdentifierIn(row: string, identifiers: readonly string[]): string | undefined {
  for (const identifier of identifiers) {
    const whole = new RegExp(`(?<![0-9a-z])${escapeForPattern(identifier)}(?![0-9a-z])`, 'i');
    if (whole.test(row)) return identifier;
  }
  return undefined;
}
