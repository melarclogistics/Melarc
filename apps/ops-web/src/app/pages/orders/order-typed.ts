import type { OrderFormValues } from '../../../platform/hub-orders/order-form-model';
import type { TermsView } from '../../../platform/hub-orders/orders-shape';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';

const F = WORDS.form;

/** Who pays, as it reads on the line: what was chosen, and for "as booked" what the server says the booking gives once it has said it (the price beside the form). */
function payerText(values: OrderFormValues, terms: TermsView | undefined): string {
  const chosen = F.payers[values.payer].label;
  if (values.payer !== 'AS_BOOKED' || terms === undefined) return chosen;
  const said = (F.payers as Readonly<Record<string, { readonly label: string }>>)[
    terms.payer.payer_intent
  ];
  return said === undefined ? chosen : `${chosen}: ${said.label.toLowerCase()}`;
}

/**
 * What the officer typed, in one short line above the save (D-S7-2): the recipient, the phone, the address, the size and who pays. It is drawn from the entries and never from the price, so that it says what is
 * about to be saved even while the price is being checked; only *as booked* takes what the server said it gives.
 */
export function typedLineOf(values: OrderFormValues, terms: TermsView | undefined): string {
  const place = [values.address.trim(), values.landmark.trim()].filter((part) => part !== '');
  return [
    values.name.trim(),
    values.phone.trim(),
    place.join(', '),
    values.sizeClass === null ? '' : F.sizes[values.sizeClass],
    payerText(values, terms),
  ]
    .filter((part) => part !== '')
    .join(' · ');
}
