import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import { formatMinor } from '../../../components/ui/money/money-value';
import type { SummaryOrderView } from '../../../platform/hub-orders/orders-shape';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { areaText, commercialText } from './orders-presentation';

const S = WORDS.summary;

/**
 * One order of the summary as a card, which is what the list is where its columns do not fit (a tablet, a phone): **a card keeps every fact the table says** (the recipient, the area, the size, the price and who pays
 * where the price is shown, and where it stands). It was the recipient and where it stands alone, and the officer at 768 px lost the area, the size and the price (the review of 23 November 2026).
 */
export function SummaryOrderCard({
  order,
  showsPrices,
}: {
  readonly order: SummaryOrderView;
  /** Whether the reader's own pricing grant shows the price (OB-S1-155): where it does not, neither the price nor who pays is drawn. */
  readonly showsPrices: boolean;
}) {
  return (
    <CardFacts
      facts={[
        { label: S.columns.recipient, value: order.recipient_name },
        { label: S.columns.area, value: areaText(order.service_area) },
        {
          label: S.columns.size,
          value: order.size_class === null ? '' : WORDS.form.sizes[order.size_class],
        },
        ...(showsPrices && order.locked_price !== null
          ? [{ label: S.columns.price, value: formatMinor(order.locked_price.amount_minor, 'GHS') }]
          : []),
        ...(showsPrices && order.payer_allocation !== null
          ? [
              {
                label: S.columns.whoPays,
                value: S.whoPays(
                  formatMinor(order.payer_allocation.sender_minor, 'GHS'),
                  formatMinor(order.payer_allocation.recipient_minor, 'GHS'),
                ),
              },
            ]
          : []),
        {
          label: S.columns.standing,
          value: commercialText(order.commercial_state) ?? order.commercial_state,
        },
      ]}
    />
  );
}
