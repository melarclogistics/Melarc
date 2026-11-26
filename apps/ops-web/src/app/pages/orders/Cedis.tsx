import { MoneyAmount } from '../../../components/ui/money/MoneyAmount';
import type { MoneyView } from '../../../platform/pickup/pickup-shape';

/** An amount as the server gave it (`MoneyView`), drawn from its integer of pesewas: nothing is added, subtracted or compared. */
export function Cedis({ money }: { readonly money: MoneyView }) {
  return <MoneyAmount amountMinor={money.amount_minor} currency={money.currency} />;
}
