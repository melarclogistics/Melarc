import { describe, expect, it } from 'vitest';

import { orderOf } from '../../test-support/orders-fixture';
import {
  amendPatchOf,
  amendSaveBodyOf,
  cedisText,
  destinationOf,
  EMPTY_ORDER_FORM,
  isEmptyPatch,
  payerProposalOf,
  previewBodyOf,
  problemsWith,
  saveBodyOf,
  valuesOf,
  type OrderFormValues,
} from './order-form-model';
import { parseOrder } from './orders-shape';

/**
 * What the form of an order holds and what is sent from it (S1.40). **The form sends no price, no total, no surcharge and no zone of its own**; money is whole pesewas and never a float; a member the officer did not
 * touch is not in a change; and the checks are the cheap ones the server makes first, in the floor's words. Each break named below is one these tests catch.
 */
const DOOR: OrderFormValues = {
  ...EMPTY_ORDER_FORM,
  name: ' Ama Mensah ',
  phone: ' 024 123 4567 ',
  address: ' 12 Madina Estate ',
  sizeClass: 'MEDIUM',
  destination: 'DOORSTEP',
};
const PARCEL = '01a20575-8ec0-7cc7-bfb7-f128f772179d';
const WAYBILL = '01a124d3-7400-7f0a-9b7d-02fbb58f252e';
const PHOTO = '01a124d3-7400-7293-be59-3c5a1a4d6c10';

const early = () => {
  const order = parseOrder(orderOf('early'));
  if (order === undefined) throw new Error('the captured order is not one the judge accepts');
  return order;
};

describe('what is wrong with the form, before anything is sent', () => {
  it('has nothing wrong with a complete order for the door', () => {
    expect(problemsWith(DOOR)).toEqual({});
  });

  // Break caught: a form that goes on with no size (a size is a judgement and nothing is chosen for the officer), or no destination.
  it('names each of the things an empty form lacks, in the floor’s words', () => {
    // The door is where almost every parcel goes and is the form's start; a size is a judgement, and none is chosen.
    expect(EMPTY_ORDER_FORM.destination).toBe('DOORSTEP');
    expect(EMPTY_ORDER_FORM.sizeClass).toBeNull();
    expect(problemsWith(EMPTY_ORDER_FORM)).toEqual({
      name: 'Enter the recipient’s name.',
      phone: 'Enter the recipient’s phone number.',
      address: 'Enter the delivery address.',
      sizeClass: 'Choose the size of the parcel.',
    });
    expect(problemsWith({ ...DOOR, destination: null })).toEqual({
      destination: 'Choose where the parcel goes.',
    });
  });

  it('counts a field of blanks as empty', () => {
    expect(problemsWith({ ...DOOR, name: '   ', address: '\t' })).toMatchObject({
      name: 'Enter the recipient’s name.',
      address: 'Enter the delivery address.',
    });
  });

  // Break caught: a carrier's charge accepted as typed text that is not an amount, or a parcel by carrier with no waybill behind the charge.
  it('asks for the carrier’s charge as an amount and the photo of its waybill, for a carrier alone', () => {
    const carrier: OrderFormValues = { ...DOOR, destination: 'CARRIER' };
    expect(problemsWith(carrier)).toMatchObject({
      carrierCost: 'Enter the carrier’s charge as an amount, for example 45.00.',
      waybill: 'Add a photo of the carrier’s waybill.',
    });
    expect(problemsWith({ ...carrier, carrierCost: '45.00', waybillEvidenceId: WAYBILL })).toEqual(
      {},
    );
    expect(
      problemsWith({ ...carrier, carrierCost: 'forty', waybillEvidenceId: WAYBILL }),
    ).toHaveProperty('carrierCost');
    // A door parcel is never asked for them, whatever is left in the fields.
    expect(problemsWith({ ...DOOR, carrierCost: 'forty' })).toEqual({});
  });

  it('accepts a declared value that is an amount, and an empty one, and refuses text', () => {
    expect(problemsWith({ ...DOOR, declaredValue: '' })).toEqual({});
    expect(problemsWith({ ...DOOR, declaredValue: '250.00' })).toEqual({});
    expect(problemsWith({ ...DOOR, declaredValue: '250' })).toEqual({});
    expect(problemsWith({ ...DOOR, declaredValue: 'a lot' })).toHaveProperty('declaredValue');
    expect(problemsWith({ ...DOOR, declaredValue: '-5' })).toHaveProperty('declaredValue');
  });

  it('asks for a photo of a high-value parcel and a serial number of serialized goods', () => {
    expect(problemsWith({ ...DOOR, highValue: true })).toEqual({
      evidence: 'A high-value parcel needs at least one photo.',
    });
    expect(problemsWith({ ...DOOR, highValue: true, evidenceIds: [PHOTO] })).toEqual({});
    expect(problemsWith({ ...DOOR, serialized: true })).toEqual({
      serial: 'Enter the serial number or IMEI.',
    });
    expect(problemsWith({ ...DOOR, serialized: true, serial: '  ' })).toHaveProperty('serial');
    expect(problemsWith({ ...DOOR, serialized: true, serial: '356938035643809' })).toEqual({});
  });

  // Break caught: a split accepted with no basis, an amount that is not money, or a percentage outside 0 to 100 (the server would refuse it, and the officer would not know where).
  it('asks how a split is shared, and holds the numbers to what the server takes', () => {
    const split: OrderFormValues = { ...DOOR, payer: 'SPLIT' };
    expect(problemsWith(split)).toEqual({ splitBasis: 'Choose how the delivery is split.' });
    expect(problemsWith({ ...split, splitBasis: 'FIXED_AMOUNT' })).toHaveProperty('splitAmount');
    expect(problemsWith({ ...split, splitBasis: 'FIXED_AMOUNT', splitAmount: '10.00' })).toEqual(
      {},
    );
    expect(problemsWith({ ...split, splitBasis: 'PERCENTAGE' })).toHaveProperty('splitPercentage');
    for (const good of ['0', '5', '05', '12.5', '12.50', '99.99', '100', '100.0', '100.00']) {
      expect(
        problemsWith({ ...split, splitBasis: 'PERCENTAGE', splitPercentage: good }),
        good,
      ).toEqual({});
    }
    for (const bad of ['100.01', '101', '12.345', '-1', 'abc', '', '1e2', '１０']) {
      expect(
        problemsWith({ ...split, splitBasis: 'PERCENTAGE', splitPercentage: bad }),
        bad,
      ).toHaveProperty('splitPercentage');
    }
  });

  it('asks for the zone and why it was chosen only when the server named several', () => {
    expect(problemsWith(DOOR)).toEqual({});
    expect(problemsWith(DOOR, { zoneNeeded: true })).toEqual({ zone: 'Choose the zone.' });
    expect(problemsWith({ ...DOOR, zoneId: 'zone-1' }, { zoneNeeded: true })).toEqual({
      zoneNote: 'Say why you chose this zone.',
    });
    expect(
      problemsWith(
        { ...DOOR, zoneId: 'zone-1', zoneNote: 'Next to the market' },
        { zoneNeeded: true },
      ),
    ).toEqual({});
  });

  it('asks for the reason of a change, and of a change alone', () => {
    expect(problemsWith(DOOR, { amendment: true })).toEqual({
      reason: 'Write why you are changing this order.',
    });
    expect(problemsWith({ ...DOOR, reason: ' Wrong size ' }, { amendment: true })).toEqual({});
    expect(problemsWith(DOOR)).toEqual({});
  });
});

describe('what is sent to check or to save an order', () => {
  // Break caught: a price, a total, a surcharge or a zone of the page's own in the body (the price is the server's), or text not trimmed.
  it('sends only what the officer gave, trimmed, and nothing the server works out', () => {
    const body = previewBodyOf(DOOR, PARCEL);
    expect(body).toEqual({
      parcel_id: PARCEL,
      recipient: {
        name: 'Ama Mensah',
        phone: '024 123 4567',
        location: { address: '12 Madina Estate' },
      },
      size_class: 'MEDIUM',
      lane: 'DOORSTEP',
      is_high_value: false,
      is_serialized_goods: false,
    });
    for (const never of [
      'price',
      'total',
      'total_minor',
      'zone',
      'zone_id',
      'destination_zone_snapshot',
      'locked_price',
      'margin',
      'surcharge',
      'reviewed_terms',
    ]) {
      expect(body).not.toHaveProperty(never);
    }
  });

  it('leaves out the parcel of a vendor counted without photos, and the landmark nobody typed', () => {
    expect(previewBodyOf(DOOR, null)).not.toHaveProperty('parcel_id');
    expect(
      previewBodyOf({ ...DOOR, landmark: ' near the market ' }, null).recipient.location,
    ).toEqual({
      address: '12 Madina Estate',
      landmark: 'near the market',
    });
    expect(previewBodyOf(DOOR, null).recipient.location).not.toHaveProperty('landmark');
  });

  // Break caught: a station drop or a carrier sent under the wrong lane or mode (the price and the gate depend on it).
  it('tells each destination in the lane and the mode the contract keeps', () => {
    expect(previewBodyOf({ ...DOOR, destination: 'STATION_DROP' }, null)).toMatchObject({
      lane: 'THIRD_PARTY_HANDOFF',
      commercial_mode: 'STATION_DROP',
    });
    const carrier = previewBodyOf(
      { ...DOOR, destination: 'CARRIER', carrierCost: '45.50', waybillEvidenceId: WAYBILL },
      null,
    );
    expect(carrier).toMatchObject({
      lane: 'THIRD_PARTY_HANDOFF',
      commercial_mode: 'MELARC_COVERED_THIRD_PARTY_DELIVERY',
      carrier_cost: { amount_minor: 4550, currency: 'GHS' },
      carrier_waybill_evidence_id: WAYBILL,
    });
    // A charge or a waybill left in the form from before the officer chose another destination is not sent.
    const door = previewBodyOf({ ...DOOR, carrierCost: '45.50', waybillEvidenceId: WAYBILL }, null);
    expect(door).not.toHaveProperty('carrier_cost');
    expect(door).not.toHaveProperty('carrier_waybill_evidence_id');
    expect(door).not.toHaveProperty('commercial_mode');
  });

  // Break caught: money sent as a float or as text (an amount is whole pesewas), or a declared value that is lost.
  it('sends money as whole pesewas', () => {
    const body = previewBodyOf(
      { ...DOOR, declaredValue: '250.05', highValue: true, evidenceIds: [PHOTO] },
      null,
    );
    expect(body.declared_value_minor).toBe(25005);
    expect(Number.isInteger(body.declared_value_minor)).toBe(true);
    expect(body.is_high_value).toBe(true);
    expect(body.evidence_ids).toEqual([PHOTO]);
  });

  it('sends the serial number of serialized goods, and none for goods that are not', () => {
    expect(previewBodyOf({ ...DOOR, serialized: true, serial: ' 3569 ' }, null)).toMatchObject({
      is_serialized_goods: true,
      serial_imei: '3569',
    });
    expect(previewBodyOf({ ...DOOR, serialized: false, serial: '3569' }, null)).not.toHaveProperty(
      'serial_imei',
    );
  });

  // Break caught: a split sent as a portion of a price (the page works the money out) or a percentage sent as text.
  it('sends who pays as an intent, with the numbers that go with it and never a portion of the price', () => {
    expect(previewBodyOf(DOOR, null)).not.toHaveProperty('payer_override');
    expect(previewBodyOf({ ...DOOR, payer: 'RECIPIENT_PAYS' }, null).payer_override).toEqual({
      payer_intent: 'RECIPIENT_PAYS',
    });
    expect(
      previewBodyOf(
        { ...DOOR, payer: 'SPLIT', splitBasis: 'FIXED_AMOUNT', splitAmount: '10.00' },
        null,
      ).payer_override,
    ).toEqual({
      payer_intent: 'SPLIT',
      split_basis: 'FIXED_AMOUNT',
      split_sender_amount: { amount_minor: 1000, currency: 'GHS' },
    });
    expect(
      previewBodyOf(
        { ...DOOR, payer: 'SPLIT', splitBasis: 'PERCENTAGE', splitPercentage: ' 12.5 ' },
        null,
      ).payer_override,
    ).toEqual({
      payer_intent: 'SPLIT',
      split_basis: 'PERCENTAGE',
      split_sender_percentage: 12.5,
    });
  });

  it('sends the zone the officer chose, and why, only when one was chosen', () => {
    expect(previewBodyOf(DOOR, null)).not.toHaveProperty('destination_zone_authorization');
    expect(
      previewBodyOf({ ...DOOR, zoneId: 'zone-1', zoneNote: ' Next to the market ' }, null)
        .destination_zone_authorization,
    ).toEqual({
      zone_id: 'zone-1',
      note: 'Next to the market',
    });
  });

  // Break caught: a save that is not on the digest of the terms the officer read.
  it('saves on the digest of the terms that were read, and on the same facts', () => {
    const token = 'a'.repeat(64);
    expect(saveBodyOf(DOOR, PARCEL, token)).toEqual({
      ...previewBodyOf(DOOR, PARCEL),
      reviewed_terms: token,
    });
  });
});

describe('the cedis of a pesewa amount, on the digits', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [50, '0.50'],
    [100, '1.00'],
    [3500, '35.00'],
    [25005, '250.05'],
    [123456, '1234.56'],
    [99999999999, '999999999.99'],
  ])('writes %d as %s', (pesewas, text) => {
    expect(cedisText(pesewas)).toBe(text);
  });
});

describe('an order read back into the form, and what a change of it sends', () => {
  it('reads the order’s facts as the officer wrote them, and where it goes as the officer chose it', () => {
    const values = valuesOf(early());
    expect(values).toMatchObject({
      name: 'Ama Mensah',
      sizeClass: 'SMALL',
      destination: 'DOORSTEP',
      payer: 'AS_BOOKED',
      serialized: false,
      reason: '',
    });
    expect(values.address).toBe('12 Madina Estate, near the market');
    expect(destinationOf(early())).toBe('DOORSTEP');
  });

  // Break caught: a change that sends what the officer did not touch (a member not named is kept, and one sent is overwritten).
  it('has an empty change when nothing was touched, and says so', () => {
    const initial = valuesOf(early());
    const patch = amendPatchOf(initial, { ...initial });
    expect(patch).toEqual({});
    expect(isEmptyPatch(patch)).toBe(true);
    // A reason alone is not a change.
    expect(isEmptyPatch(amendPatchOf(initial, { ...initial, reason: 'Just looking' }))).toBe(true);
  });

  it('sends the size alone when only the size changed', () => {
    const initial = valuesOf(early());
    expect(amendPatchOf(initial, { ...initial, sizeClass: 'MEDIUM' })).toEqual({
      size_class: 'MEDIUM',
    });
  });

  // Break caught: the recipient sent in parts (the contract takes it whole), so a change of the address would clear the name.
  it('sends the recipient whole when any part of it changed', () => {
    const initial = valuesOf(early());
    const patch = amendPatchOf(initial, { ...initial, address: ' 14 Madina Estate ' });
    expect(Object.keys(patch)).toEqual(['recipient']);
    expect(patch.recipient).toEqual({
      name: 'Ama Mensah',
      phone: initial.phone,
      location: { address: '14 Madina Estate' },
    });
  });

  it('sends where it goes with its mode, and clears the carrier’s charge when it no longer goes by a carrier', () => {
    const initial = valuesOf(early());
    expect(amendPatchOf(initial, { ...initial, destination: 'STATION_DROP' })).toEqual({
      lane: 'THIRD_PARTY_HANDOFF',
      commercial_mode: 'STATION_DROP',
    });
    const carrier = {
      ...initial,
      destination: 'CARRIER' as const,
      carrierCost: '45.00',
      waybillEvidenceId: WAYBILL,
    };
    expect(amendPatchOf(initial, carrier)).toEqual({
      lane: 'THIRD_PARTY_HANDOFF',
      commercial_mode: 'MELARC_COVERED_THIRD_PARTY_DELIVERY',
      carrier_cost: { amount_minor: 4500, currency: 'GHS' },
      carrier_waybill_evidence_id: WAYBILL,
    });
    // Back from a carrier to the door: the charge and the waybill are cleared, not left as they were.
    expect(
      amendPatchOf(carrier, {
        ...carrier,
        destination: 'DOORSTEP',
        carrierCost: '',
        waybillEvidenceId: null,
      }),
    ).toEqual({
      lane: 'DOORSTEP',
      commercial_mode: null,
      carrier_cost: null,
      carrier_waybill_evidence_id: null,
    });
  });

  it('clears a declared value with null, and sends the serial number with its flag', () => {
    const initial = {
      ...valuesOf(early()),
      declaredValue: '250.00',
      serialized: true,
      serial: '3569',
    };
    expect(amendPatchOf(initial, { ...initial, declaredValue: '' })).toEqual({
      declared_value_minor: null,
    });
    expect(amendPatchOf(initial, { ...initial, declaredValue: '300.00' })).toEqual({
      declared_value_minor: 30000,
    });
    expect(amendPatchOf(initial, { ...initial, serialized: false })).toEqual({
      is_serialized_goods: false,
      serial_imei: null,
    });
    expect(amendPatchOf(initial, { ...initial, serial: '9999' })).toEqual({ serial_imei: '9999' });
  });

  // Break caught: a payer set back to "as booked" that is not told to the server (null clears the arrangement).
  it('sends a change of who pays, and null when it is set back to as booked', () => {
    const initial = valuesOf(early());
    const split = {
      ...initial,
      payer: 'SPLIT' as const,
      splitBasis: 'PERCENTAGE' as const,
      splitPercentage: '40',
    };
    expect(amendPatchOf(initial, split)).toEqual({
      payer_override: {
        payer_intent: 'SPLIT',
        split_basis: 'PERCENTAGE',
        split_sender_percentage: 40,
      },
    });
    expect(
      amendPatchOf(split, { ...split, payer: 'AS_BOOKED', splitBasis: null, splitPercentage: '' }),
    ).toEqual({ payer_override: null });
  });

  it('sends the zone the officer chose, and the photos only when the set changed', () => {
    const initial = { ...valuesOf(early()), evidenceIds: [PHOTO] };
    expect(
      amendPatchOf(initial, { ...initial, zoneId: 'zone-1', zoneNote: ' Next to the market ' }),
    ).toEqual({
      destination_zone_authorization: { zone_id: 'zone-1', note: 'Next to the market' },
    });
    expect(amendPatchOf(initial, { ...initial, evidenceIds: [PHOTO] })).toEqual({});
    expect(amendPatchOf(initial, { ...initial, evidenceIds: [] })).toEqual({ evidence_ids: [] });
    expect(amendPatchOf(initial, { ...initial, evidenceIds: [PHOTO, WAYBILL] })).toEqual({
      evidence_ids: [PHOTO, WAYBILL],
    });
  });

  // Break caught: a change saved with the reason untrimmed or without the digest of the terms read.
  it('saves a change with its reason, trimmed, on the digest of the terms read', () => {
    const token = 'b'.repeat(64);
    expect(amendSaveBodyOf({ size_class: 'LARGE' }, '  Bigger than it looked  ', token)).toEqual({
      size_class: 'LARGE',
      note: 'Bigger than it looked',
      reviewed_terms: token,
    });
  });
});

describe('the proposal of a change of who pays', () => {
  it('is an intent and the numbers that go with it, and nothing for as booked or for a split not yet shared', () => {
    expect(
      payerProposalOf({
        payer: 'AS_BOOKED',
        splitBasis: null,
        splitAmount: '',
        splitPercentage: '',
      }),
    ).toBeUndefined();
    expect(
      payerProposalOf({
        payer: 'SENDER_PAYS_FULL',
        splitBasis: null,
        splitAmount: '',
        splitPercentage: '',
      }),
    ).toEqual({
      payer_intent: 'SENDER_PAYS_FULL',
    });
    expect(
      payerProposalOf({ payer: 'SPLIT', splitBasis: null, splitAmount: '', splitPercentage: '' }),
    ).toBeUndefined();
    expect(
      payerProposalOf({
        payer: 'SPLIT',
        splitBasis: 'FIXED_AMOUNT',
        splitAmount: 'ten',
        splitPercentage: '',
      }),
    ).toBeUndefined();
    expect(
      payerProposalOf({
        payer: 'SPLIT',
        splitBasis: 'FIXED_AMOUNT',
        splitAmount: '10.00',
        splitPercentage: '',
      }),
    ).toEqual({
      payer_intent: 'SPLIT',
      split_basis: 'FIXED_AMOUNT',
      split_sender_amount: { amount_minor: 1000, currency: 'GHS' },
    });
  });
});
