import { Alert } from '../../../components/ui/alert/Alert';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { formatMinor } from '../../../components/ui/money/money-value';
import type { TermsView } from '../../../platform/hub-orders/orders-shape';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { serviceDateText } from '../pickup/pickup-presentation';
import { Cedis } from './Cedis';
import { componentText, GATE_WORDS, windowText } from './orders-presentation';
import { termsDifferences } from './use-order-flow';
import './orders-pages.css';

const R = WORDS.review;

/** One sentence for each part that changed, said with the figures the server gave before and now: never a figure worked out here. */
function differenceLines(before: TermsView, now: TermsView): readonly string[] {
  const lines: string[] = [];
  for (const difference of termsDifferences(before, now)) {
    switch (difference) {
      case 'price':
        lines.push(
          R.changed.price(
            formatMinor(before.total.amount_minor, 'GHS'),
            formatMinor(now.total.amount_minor, 'GHS'),
          ),
        );
        break;
      case 'date':
        lines.push(
          R.changed.date(
            serviceDateText(before.delivery.committed_date),
            serviceDateText(now.delivery.committed_date),
          ),
        );
        break;
      case 'payer':
        lines.push(R.changed.payer);
        break;
      case 'evidence':
        lines.push(R.changed.evidence);
        break;
      case 'zone':
        lines.push(R.changed.zone);
        break;
      case 'highValue':
        lines.push(R.changed.highValue);
        break;
      case 'other':
        lines.push(R.changed.other);
        break;
    }
  }
  return lines;
}

/**
 * What confirming would give, **as the server worked it out** (`previewOrder`, `previewOrderAmendment`), drawn and never calculated: the price and what it is made of, where the parcel goes and how that was found,
 * the delivery date and window, who pays and what that means for the order, and when the order is confirmed. **The estimate shown at booking, the price calculated now and the price an order was fixed at are
 * three different things**: this is the price calculated now, and the words say so; an order that waits for its parcel keeps its price as calculated until it is changed. When the terms are not the ones the
 * officer read, the earlier figures are shown beside the new ones and a second confirmation is asked for.
 */
export function OrderReview({
  terms,
  earlier,
}: {
  readonly terms: TermsView;
  readonly earlier: TermsView | undefined;
}) {
  const lines = earlier === undefined ? [] : differenceLines(earlier, terms);
  const asked = terms.delivery.requested_date;
  const window = windowText(terms.delivery.window_start, terms.delivery.window_end);
  const evidenceCount = terms.cited_evidence.high_value.length;
  return (
    <div className="orders-review">
      {earlier === undefined ? null : (
        <Alert variant="danger" announce>
          <p className="orders-review__changed-title">{R.changed.title}</p>
          <p>{R.changed.text}</p>
          {lines.length === 0 ? null : (
            <ul className="orders-review__changes">
              {lines.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      <section aria-labelledby="orders-review-price" className="orders-review__block">
        <h3 id="orders-review-price" className="orders-review__heading">
          {R.priceSection}
        </h3>
        <p className="orders-review__total">
          <Cedis money={terms.total} />
        </p>
        <DescriptionList
          items={terms.components.map((component) => ({
            label: componentText(component),
            value: <Cedis money={component.amount} />,
          }))}
        />
      </section>

      <section aria-labelledby="orders-review-zone" className="orders-review__block">
        <h3 id="orders-review-zone" className="orders-review__heading">
          {R.destinationSection}
        </h3>
        <DescriptionList
          items={
            terms.destination.outside_service_area
              ? [{ label: R.zone, value: R.outside }]
              : [
                  { label: R.zone, value: terms.destination.zone_name ?? '' },
                  { label: R.area, value: terms.destination.service_area ?? '' },
                  {
                    label: '',
                    value:
                      terms.destination.resolution === 'EXPLICITLY_AUTHORIZED'
                        ? R.chosen
                        : R.byAddress,
                  },
                ]
          }
        />
      </section>

      <section aria-labelledby="orders-review-delivery" className="orders-review__block">
        <h3 id="orders-review-delivery" className="orders-review__heading">
          {R.deliverySection}
        </h3>
        <DescriptionList
          items={[
            { label: R.committed, value: serviceDateText(terms.delivery.committed_date) },
            ...(asked === null ? [] : [{ label: R.asked, value: serviceDateText(asked) }]),
            { label: R.firstDay, value: serviceDateText(terms.delivery.default_date) },
            ...(window === undefined ? [] : [{ label: R.window, value: window }]),
          ]}
        />
      </section>

      <section aria-labelledby="orders-review-payer" className="orders-review__block">
        <h3 id="orders-review-payer" className="orders-review__heading">
          {R.payerSection}
        </h3>
        <DescriptionList
          items={[
            { label: R.senderPays, value: <Cedis money={terms.payer.sender} /> },
            { label: R.recipientPays, value: <Cedis money={terms.payer.recipient} /> },
            { label: '', value: terms.payer.source === 'ORDER' ? R.forThisOrder : R.asBooked },
          ]}
        />
      </section>

      <section aria-labelledby="orders-review-after" className="orders-review__block">
        <h3 id="orders-review-after" className="orders-review__heading">
          {R.afterSection}
        </h3>
        <p>{R.willConfirm[terms.will_confirm]}</p>
        <p>{GATE_WORDS[terms.payer.commercial_state_after_confirmation]}</p>
        {evidenceCount === 0 && terms.cited_evidence.carrier_waybill === null ? null : (
          <p>
            {evidenceCount === 0 ? '' : R.cited(evidenceCount)}
            {terms.cited_evidence.carrier_waybill === null ? '' : ` ${R.waybillCited}`}
          </p>
        )}
      </section>

      {terms.current === null ? null : (
        <section aria-labelledby="orders-review-before" className="orders-review__block">
          <h3 id="orders-review-before" className="orders-review__heading">
            {R.beforeAmend.title}
          </h3>
          <DescriptionList
            items={[
              { label: R.beforeAmend.total, value: <Cedis money={terms.current.total} /> },
              ...(terms.current.derived_delivery_date === null
                ? []
                : [
                    {
                      label: R.beforeAmend.date,
                      value: serviceDateText(terms.current.derived_delivery_date),
                    },
                  ]),
              {
                label: R.beforeAmend.highValue,
                value: terms.current.is_high_value ? R.beforeAmend.yes : R.beforeAmend.no,
              },
            ]}
          />
        </section>
      )}
    </div>
  );
}
