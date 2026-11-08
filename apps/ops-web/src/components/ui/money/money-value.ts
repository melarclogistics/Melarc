/**
 * Money as the contract carries it (domain-model.md section 3.2): a whole number of minor units with a currency code, `GHS` alone in Version 1,
 * never a float and never a decimal string. 2550 is GH₵25.50.
 *
 * Both directions are done on the digits as text and never by floating-point arithmetic, so no amount is ever off by a pesewa: a figure is
 * shown exactly as the server sent it, and what a person types is turned into the integer the contract wants, or refused (COMPONENT_PATTERNS
 * sections 7.8 and 24.1). Nothing here computes a price, a total or a share of one: that is the server's.
 */

/** The currencies an amount can be shown in, with the symbol each is written with. Version 1 has one. */
const SYMBOLS = { GHS: 'GH₵' } as const;

export type CurrencyCode = keyof typeof SYMBOLS;

/** A whole amount of minor units the page can hold without losing a digit. */
export function isMinorAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Thousands separated by commas, from the right, on digits that are already text. */
function grouped(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The text of an amount: the currency's symbol, the major units grouped by thousands, and always two places of minor units (`GH₵1,250.00`). A
 * negative amount carries a leading minus sign. An amount that is not a whole safe number is a defect of the page, so it throws.
 */
export function formatMinor(amountMinor: number, currency: CurrencyCode): string {
  if (!isMinorAmount(amountMinor)) {
    throw new RangeError('An amount is a whole number of minor units.');
  }
  const sign = amountMinor < 0 ? '-' : '';
  const digits = String(Math.abs(amountMinor)).padStart(3, '0');
  const major = digits.slice(0, -2).replace(/^0+(?=\d)/, '');
  const minor = digits.slice(-2);
  return `${sign}${SYMBOLS[currency]}${grouped(major)}.${minor}`;
}

/** Cedis as a person types them: digits with an optional comma every three, and at most two places after a point. */
const TYPED_CEDIS = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * The pesewas of an amount typed in cedis (`25.5`, `1,250.00`, `GH₵ 40`), or nothing when the text is not an amount: a sign, a third decimal
 * place, letters, or more than the page can hold. The cedi sign or `GHS` before it and spaces around it are allowed. The conversion is made on
 * the digits, so `0.1` is exactly 10 pesewas.
 */
export function pesewasFromCedis(text: string): number | undefined {
  const bare = text
    .trim()
    .replace(/^(?:GH₵|GHS)\s*/i, '')
    .trim();
  const match = TYPED_CEDIS.exec(bare);
  if (match === null) return undefined;
  const [whole = '', places = ''] = bare.replaceAll(',', '').split('.');
  const digits = `${whole}${places.padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
  const amount = Number(digits);
  return Number.isSafeInteger(amount) ? amount : undefined;
}
