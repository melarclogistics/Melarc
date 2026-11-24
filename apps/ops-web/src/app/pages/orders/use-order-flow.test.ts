import { describe, expect, it } from 'vitest';

import { parseTerms, type TermsView } from '../../../platform/hub-orders/orders-shape';
import { termsOf } from '../../../test-support/orders-fixture';
import { termsDifferences } from './use-order-flow';

const terms = (overrides: Record<string, unknown> = {}, total = 3500): TermsView => {
  const read = parseTerms(termsOf(overrides, total));
  if (read === undefined) throw new Error('not terms');
  return read;
};
const withPayer = (change: Record<string, unknown>, total = 3500): TermsView => {
  const base = termsOf({}, total) as { payer: Record<string, unknown> };
  return terms({ payer: { ...base.payer, ...change } }, total);
};

/**
 * What differs between the price the officer read and the price now, **read off the two answers and never worked out** (Run G1, Part 2, item 11): a price that moved is a price that moved, and the portions of who
 * pays move with it without anyone having changed who pays.
 */
describe('what differs between two prices', () => {
  // Break caught: "Who pays has changed" told beside every price that moved, because the sender's and the recipient's portions are amounts and move with the total.
  it('says only that the price changed when it moved and nobody changed who pays', () => {
    expect(termsDifferences(terms({}, 3500), terms({}, 4000))).toEqual(['price']);
  });

  // Break caught: a change of who pays that is not told (the officer saves at a price that is shared differently), by the intent, by where it comes from, or by what the order becomes once it is confirmed.
  it.each([
    ['the intent', { payer_intent: 'SENDER_PAYS' }],
    ['where the arrangement comes from', { source: 'ORDER' }],
    [
      'the state the order takes once it is confirmed',
      { commercial_state_after_confirmation: 'PAYMENT_REQUIRED' },
    ],
  ])('says who pays has changed when %s changed', (_name, change) => {
    expect(termsDifferences(terms({}, 3500), withPayer(change, 3500))).toContain('payer');
    expect(termsDifferences(terms({}, 3500), withPayer(change, 4000))).toEqual(
      expect.arrayContaining(['price', 'payer']),
    );
  });

  // Break caught: a split that moved while the price did not (the portions are the only thing that says it) not told.
  it('says who pays has changed when the portions moved and the price did not', () => {
    expect(
      termsDifferences(
        terms({}, 3500),
        withPayer({
          sender: { amount_minor: 1000, currency: 'GHS' },
          recipient: { amount_minor: 2500, currency: 'GHS' },
        }),
      ),
    ).toEqual(['payer']);
  });

  it('says nothing for two prices that are the same', () => {
    expect(termsDifferences(terms({}, 3500), terms({}, 3500))).toEqual([]);
  });
});
