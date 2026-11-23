import { describe, expect, it } from 'vitest';

import { EMPTY_ORDER_FORM } from '../../../platform/hub-orders/order-form-model';
import { parseTerms } from '../../../platform/hub-orders/orders-shape';
import { termsOf, TOKEN } from '../../../test-support/orders-fixture';
import { errorsOf } from './order-refusal-fields';
import { typedLineOf } from './order-typed';

/**
 * The two small pieces the one-step form (D-S7-2) is made of that are not a screen: the errors it draws, and the line of what was typed above the save. The screens' own tests hold what an officer sees; these hold
 * the rules the pieces keep alone.
 */
describe('the errors the form draws', () => {
  // Break caught: `{ ...fromServer, ...invalid }`. Changing a field leaves `undefined` for it in what the form found wrong, and a spread lets that hide the server's refusal of the same field, so that a price the
  // server refused to work out is told nowhere on the screen but "the fields marked say what to change".
  it('takes the server’s refusal of a field the officer has changed, and never hides it behind "no error"', () => {
    expect(errorsOf({ declaredValue: 'The server’s words' }, { declaredValue: undefined })).toEqual(
      {
        declaredValue: 'The server’s words',
      },
    );
  });

  it('keeps the form’s own error when both name a field, and the errors of fields only one names', () => {
    expect(
      errorsOf(
        { declaredValue: 'The server’s words', serial: 'Serial, from the server' },
        { declaredValue: 'Enter a value in cedis.', name: 'Enter the recipient’s name.' },
      ),
    ).toEqual({
      declaredValue: 'Enter a value in cedis.',
      serial: 'Serial, from the server',
      name: 'Enter the recipient’s name.',
    });
  });

  it('is nothing when nothing is wrong', () => {
    expect(errorsOf({}, {})).toEqual({});
    expect(errorsOf({}, { name: undefined })).toEqual({});
  });
});

describe('the line of what was typed, above the save', () => {
  const typed = {
    ...EMPTY_ORDER_FORM,
    name: ' Ama Mensah ',
    phone: '024 123 4567',
    address: '12 Madina Estate',
    landmark: 'near the market',
    sizeClass: 'MEDIUM' as const,
  };

  // Break caught: a line made from the price (it would say nothing while the price is being checked, and could say what the officer did not type), or one that keeps the stray spaces of the fields.
  it('is made of the entries alone: the recipient, the phone, the place, the size and who pays', () => {
    expect(typedLineOf(typed, undefined)).toBe(
      'Ama Mensah · 024 123 4567 · 12 Madina Estate, near the market · Medium · As booked',
    );
  });

  it('leaves out what is not entered yet', () => {
    expect(typedLineOf({ ...typed, phone: '', landmark: '', sizeClass: null }, undefined)).toBe(
      'Ama Mensah · 12 Madina Estate · As booked',
    );
  });

  // Break caught: "as booked" left as only the choice, when the server has said what the booking gives (the officer reads who pays before saving, in the words the price beside the form uses).
  it('says, for "as booked", what the booking gives once the server has said it', () => {
    const terms = parseTerms(termsOf({}, 3500, TOKEN));
    expect(terms).toBeDefined();
    if (terms === undefined) return;
    const line = typedLineOf(typed, terms);
    expect(line.startsWith('Ama Mensah · 024 123 4567')).toBe(true);
    expect(line).toMatch(/As booked: /);
  });

  // Break caught: a payer chosen by the officer replaced by the booking's, or by the server's word for the choice.
  it('says the payer the officer chose, as chosen, even when the server has given terms', () => {
    const terms = parseTerms(termsOf({}, 3500, TOKEN));
    const chosen = { ...typed, payer: 'RECIPIENT_PAYS' as const };
    expect(typedLineOf(chosen, undefined).endsWith('The recipient pays')).toBe(true);
    expect(typedLineOf(chosen, terms).endsWith('The recipient pays')).toBe(true);
  });
});
