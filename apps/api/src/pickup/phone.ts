/**
 * The phone number of a pickup request and of an ad-hoc sender (S1.14; domain-model.md section 3.4: "E.164 plus as-entered"). A number is
 * the identity of an ad-hoc sender (section 29.7), so the normal form has to be one per number: the same number entered as `024 123 4567`,
 * `0241234567`, `233241234567` and `+233 24 123 4567` is `+233241234567`.
 *
 * **What is assumed, because the launch country is Ghana and nothing else is decided:** a number that starts with the trunk prefix `0`
 * and has ten digits is a Ghanaian national number, and one that starts with the country code `233` and has twelve is an international one
 * written without the plus. Any other number must be written with its country code (`+` and 7 to 14 digits, E.164's own bounds) or with the
 * international call prefix `00`. The as-entered form is kept beside the normal one by the caller.
 */
const E164 = /^\+[1-9]\d{6,14}$/;

/** The normal form of a phone number, or `undefined` when the text is not a number this function can place. */
export function normalisePhone(entered: string): string | undefined {
  // Spaces, hyphens, dots and brackets are how people write a number; anything else that is not a digit is not a number.
  const compact = entered.trim().replaceAll(/[\s\-.()]/g, '');
  if (compact === '') return undefined;
  const international = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;

  if (international.startsWith('+')) {
    if (!E164.test(international)) return undefined;
    // A Ghanaian number has nine digits after the country code; a shorter or longer one is a mistake, not another country's number.
    if (international.startsWith('+233') && international.length !== 13) return undefined;
    return international;
  }
  if (!/^\d+$/.test(international)) return undefined;
  if (/^0\d{9}$/.test(international)) return `+233${international.slice(1)}`;
  if (/^233\d{9}$/.test(international)) return `+${international}`;
  return undefined;
}
