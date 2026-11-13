import { describe, expect, it } from 'vitest';

import { collectionRecordViewOf, type CollectionRecordRow } from './collection-record-view.js';

const ROW: CollectionRecordRow = {
  id: '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01',
  pickup_stop_id: '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e02',
  responsible_hub_id: '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e03',
  declared_count: 3,
  collected_count: 3,
  variance: 'MATCH',
  variance_reason_snapshot: null,
  office_notified_at: null,
  handshake_type: 'VENDOR_ENTERED_RIDER_DISPLAYED',
  captured_at: null,
  recorded_by: '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e04',
};

describe('the collection record as the contract states it (S1.26)', () => {
  // Break caught: a member the contract does not name reaching the wire (the hub, the rider, the direction of the handshake to come), or a member
  // of a clean count that is not there.
  it('states a clean count with the members it names and no other', () => {
    const view = collectionRecordViewOf(ROW);
    expect(view).toEqual({
      id: ROW.id,
      pickup_stop_id: ROW.pickup_stop_id,
      declared_count: 3,
      collected_count: 3,
      variance: 'MATCH',
      office_notified_at: null,
    });
    expect(Object.keys(view)).not.toContain('responsible_hub_id');
    expect(Object.keys(view)).not.toContain('recorded_by');
    expect(Object.keys(view)).not.toContain('handshake_type');
  });

  // Break caught: the reason's code, the note or the moments of a short count lost, the label or the attribution of the catalogue repeated to the
  // rider, or a moment printed in the form the database gave it.
  it('states a short count with its reason code, its note and its moments, and not the catalogue’s label', () => {
    const view = collectionRecordViewOf({
      ...ROW,
      collected_count: 2,
      variance: 'SHORT',
      variance_reason_snapshot: {
        reason_code: 'VENDOR_HELD_BACK_PARCELS',
        label: 'Vendor held back parcels',
        attribution: 'CUSTOMER',
        note: 'Two boxes are in the back',
      },
      office_notified_at: new Date('2026-11-03T08:15:01.250Z'),
      captured_at: '2026-11-03 08:15:00+00',
    });
    expect(view).toEqual({
      id: ROW.id,
      pickup_stop_id: ROW.pickup_stop_id,
      declared_count: 3,
      collected_count: 2,
      variance: 'SHORT',
      variance_reason_code: 'VENDOR_HELD_BACK_PARCELS',
      variance_note: 'Two boxes are in the back',
      captured_at: '2026-11-03T08:15:00.000Z',
      office_notified_at: '2026-11-03T08:15:01.250Z',
    });
    expect(JSON.stringify(view)).not.toContain('Vendor held back parcels');
    expect(JSON.stringify(view)).not.toContain('CUSTOMER');
  });

  // Break caught (Run B, Part 1, item 5): the photos a count attached left out of the answer that the contract declares them in (`CollectionRecord.parcel_photo_ids`), or named in
  // another order than the one the rider named them in.
  it('states the photos the count attached, in the order the rider named them', () => {
    const named = [
      '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e12',
      '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e11',
      '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e13',
    ];
    expect(collectionRecordViewOf(ROW, named).parcel_photo_ids).toEqual(named);
  });

  // Break caught: an empty list stated for a stop that Ops let through without photos, which would say that a count was made with photos and none were counted.
  it('leaves the photos out when the count attached none', () => {
    expect(Object.keys(collectionRecordViewOf(ROW))).not.toContain('parcel_photo_ids');
    expect(Object.keys(collectionRecordViewOf(ROW, []))).not.toContain('parcel_photo_ids');
  });

  // Break caught: a note that is absent written as an empty one.
  it('leaves out a note that was not given', () => {
    const view = collectionRecordViewOf({
      ...ROW,
      collected_count: 1,
      variance: 'SHORT',
      variance_reason_snapshot: {
        reason_code: 'SOME_PARCELS_NOT_READY',
        label: 'Some parcels not ready',
        attribution: 'CUSTOMER',
      },
      office_notified_at: '2026-11-03T08:15:01Z',
    });
    expect(Object.keys(view)).not.toContain('variance_note');
    expect(view.variance_reason_code).toBe('SOME_PARCELS_NOT_READY');
  });
});
