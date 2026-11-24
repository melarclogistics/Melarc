/**
 * Whether the free text of a note holds a **telephone number**, in any form a person in Ghana writes one (Run G1, Part 1, item 5; the Product Owner's decision of 24 November 2026).
 *
 * The audit log is append-only, so a number that reaches it cannot be taken out, and the screening it had recognised only international numbers with a plus. An officer naturally types "the right number is
 * 0244123456". The forms recognised, each possibly written in groups (`024 412 3456`, `024-412-3456`, `024.412.3456`, `(024) 412 3456`, `024/412/3456`, `024 - 412 - 3456`, with any dash), with full-width or
 * other scripts' digits and with characters that do not show between them:
 *
 * - the local number: ten digits that begin with `0`;
 * - the international number of Ghana: `233` and nine digits, with `+`, with `00` or with neither;
 * - any international number with a plus: `+` and eight to fifteen digits, the form the audit has always refused.
 *
 * **It looks at the digits a person wrote and nothing else**: a run of digits joined by at most three separators (space, dot, hyphen of any kind, slash, underscore, middle dot, bracket) is read as groups, and every stretch of whole groups is tried, so that two numbers
 * written one after the other with a single space (`0244123456 0201234567`) are found as well as one. A time (`10.30`), a date (`2026-11-24`), an amount (`1,000,000`, a comma ends a run), a count, the code of an order and
 * a number of any other length are not telephone numbers. Numbers written in words are not found: no text screening can say that, and the page tells the officer to leave the number out.
 *
 * It is for **notes**, the free text of a person. The facts of an event (identifiers, states, codes) keep the narrower screening: a hexadecimal identifier whose last segment happens to be all digits must never make the
 * ledger refuse an event.
 */
export function holdsPhoneNumber(text: string): boolean {
  const normalised = asciiDigits(
    text
      .normalize('NFKC')
      // What does not show (zero-width spaces and joiners, the soft hyphen) is no part of what a reader reads, and every dash is the hyphen.
      .replaceAll(/\p{Cf}/gu, '')
      .replaceAll(/[\p{Pd}\u2212]/gu, '-'),
  );
  // Digits joined by up to three separators: a space, a dot, a hyphen, a slash, an underscore, a middle dot or a bracket (" - " and " / " are three).
  for (const match of normalised.matchAll(/\+?\d(?:[\s().\-/_·]{0,3}\d)*/g)) {
    const run = match[0];
    const groups = run.match(/\d+/g) ?? [];
    for (let start = 0; start < groups.length; start += 1) {
      let digits = '';
      for (let end = start; end < groups.length; end += 1) {
        digits += groups[end] ?? '';
        if (digits.length > 15) break;
        // A number of another country is told by its plus, in front of the whole run.
        if (start === 0 && run.startsWith('+') && /^[1-9]\d{7,14}$/.test(digits)) return true;
        if (/^(?:00)?233\d{9}$/.test(digits) || /^0\d{9}$/.test(digits)) return true;
      }
    }
  }
  return false;
}

/** The decimal digits of any script as the digits 0 to 9: each script's ten digits are consecutive in Unicode, so a digit's value is its place in its run. */
function asciiDigits(text: string): string {
  return text.replaceAll(/\p{Nd}/gu, (digit) => {
    const point = digit.codePointAt(0) ?? 0;
    let first = point;
    while (/\p{Nd}/u.test(String.fromCodePoint(first - 1))) first -= 1;
    return String((point - first) % 10);
  });
}
