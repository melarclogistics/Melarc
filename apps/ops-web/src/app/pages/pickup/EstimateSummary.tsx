import { useId } from 'react';

import { MoneyAmount } from '../../../components/ui/money/MoneyAmount';
import type { EstimateView } from '../../../platform/pickup/pickup-shape';
import { ESTIMATE_UNAVAILABLE, estimateExclusions, estimatePartLabel } from './pickup-presentation';

/**
 * The booking estimate (MSC-DEC-211; AC-SLICE-001-01) as the server computed it: **an indicative estimate, labelled provisional**, never a price
 * and never a total. The figure is the server's, shown from its pesewas; the parts are the inputs the server listed, each with its own amount,
 * and nothing is added up here. When the server gives no figure the reason is said in plain words and no number is shown. The authoritative
 * price is set at itemization, when the size class is chosen; the words say so.
 */
export function EstimateSummary({ estimate }: { readonly estimate: EstimateView }) {
  const headingId = useId();
  const exclusions = estimateExclusions(estimate);
  return (
    <section className="pickup-estimate" aria-labelledby={headingId}>
      <h2 id={headingId} className="pickup-estimate__heading">
        Indicative estimate (provisional)
      </h2>
      {estimate.status === 'AVAILABLE' && estimate.total !== null ? (
        <>
          <p className="pickup-estimate__figure">
            About{' '}
            <MoneyAmount
              amountMinor={estimate.total.amount_minor}
              currency={estimate.total.currency}
            />
          </p>
          {estimate.components.length > 0 ? (
            <ul className="pickup-estimate__parts" aria-label="What the estimate is made of">
              {estimate.components.map((part, index) => (
                // The parts are the server's list, in its order, and nothing else tells two of them apart.
                <li key={`${String(index)}-${part.kind}`}>
                  {estimatePartLabel(part)}:{' '}
                  <MoneyAmount
                    amountMinor={part.amount.amount_minor}
                    currency={part.amount.currency}
                  />
                </li>
              ))}
            </ul>
          ) : null}
          <p>
            {estimate.assumesSizeClass === 'SMALL'
              ? 'It assumes small parcels delivered within the service area. '
              : ''}
            {exclusions === undefined ? '' : `${exclusions} `}
            It is not a quote and nothing is charged now: the price is set when the parcels are
            itemized at the hub.
          </p>
        </>
      ) : (
        <p>
          {estimate.status === 'AVAILABLE'
            ? 'No estimate was given.'
            : ESTIMATE_UNAVAILABLE[estimate.status]}
        </p>
      )}
    </section>
  );
}
