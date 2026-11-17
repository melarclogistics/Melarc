/**
 * The largest whole number the platform holds in a count of parcels: a PostgreSQL `integer` (four bytes), which is what every count column is, what the API checks a count against (`maximum: 2147483647` in
 * the contract and the `range` refusal of the services) and so what a screen may read or send. **It is a limit of representation and not a business limit**: the platform sets none on the parcels of a pickup or
 * of an intake (OB-S1-97, the Product Owner, 15 November 2026), so a screen takes every count the server took, and a form refuses only what the server would refuse for its size alone.
 *
 * **One place holds it.** Every parser and every form of a count of parcels reads it from here, so that no screen invents a smaller limit than the API supports (the review of 17 November 2026 found
 * 1,000,000 in the custody parser and form, and 10,000,000 in the door-and-failure parser, against the API's 2,147,483,647). `test/count-range-one-place.test.ts` fails on a second copy of the number.
 */
export const MAX_COUNT = 2_147_483_647;

/**
 * A count a person typed: digits only (no sign, no space, no decimal point, no exponent), a safe integer, and no more than the platform can hold. Anything else is `undefined`, and the form says so in
 * its own words. Leading zeros are digits, and a text longer than any safe integer is refused by the value it makes and not by its length.
 */
export function countOfText(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const count = Number(trimmed);
  return Number.isSafeInteger(count) && count <= MAX_COUNT ? count : undefined;
}

/** Whether a value read from an answer is a count the platform can hold: a safe integer from `least` to the largest count. */
export function isCount(value: unknown, least = 0): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= least && value <= MAX_COUNT
  );
}
