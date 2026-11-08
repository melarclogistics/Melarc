import { formatMinor, type CurrencyCode } from './money-value';
import './money.css';

export interface MoneyAmountProps {
  /** The amount in minor units (pesewas), exactly as the server gave it. */
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

/**
 * An amount of money, shown from the integer the server sent (COMPONENT_PATTERNS section 24.1): `2550` GHS is `GH₵25.50`. It computes nothing
 * and decides nothing: what the amount is (an estimate, a charge as applied) is said by the words around it, which are the screen's. The figures
 * are set in one width, so amounts in a column line up.
 */
export function MoneyAmount({ amountMinor, currency }: MoneyAmountProps) {
  return <span className="ui-money">{formatMinor(amountMinor, currency)}</span>;
}
