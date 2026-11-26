import { describe, expect, it } from 'vitest';

import type { IntakeRecordView } from '../../../platform/hub-receiving/use-intake-record';
import { parseIntake } from '../../../platform/hub-intake/hub-intake-shape';
import { parseCheckIn } from '../../../platform/hub-receiving/receiving-shape';
import { preCountFixture } from '../../../test-support/hub-intake-fixture';
import { captured, PARCELS } from '../../../test-support/orders-fixture';
import { checkInFixture } from '../../../test-support/receiving-fixture';
import { vendorFactsOf } from './vendor-facts';

const blindRecord = (answer: unknown): IntakeRecordView => {
  const intake = parseIntake(answer);
  if (intake === undefined) throw new Error('not an intake');
  return { kind: 'blind', intake, etag: '"v1"' };
};

/**
 * What the order screens know of a vendor's record, whichever way it was received (Run G1, Part 2, item 9): **its name is the vendor's own, for a vendor checked in against its photos and for one counted without
 * them**, so that no order screen calls a vendor by its code alone where the API names it.
 */
describe('the facts of a vendor, for the order screens', () => {
  // Break caught: a vendor counted without photos named by nothing on the order screens, or a vendor checked in against photos losing its name.
  it('names the vendor the record names, in both ways a vendor is received', () => {
    const view = parseCheckIn(checkInFixture(PARCELS));
    if (view === undefined) throw new Error('not a check-in');
    expect(vendorFactsOf({ kind: 'check-in', view, etag: '"v1"' }).name).toBe('Kente Crafts');
    expect(vendorFactsOf(blindRecord(captured('intake-blind-named'))).name).toBe('Fixture Sender');
  });

  it('has no name for a vendor the API does not name', () => {
    expect(
      vendorFactsOf(blindRecord({ ...captured('intake-blind-named'), vendor_name: null })).name,
    ).toBeNull();
  });
});

/**
 * Where a vendor's check-in stands, for the early orders (Run G2, Part 2, item 1; D-D6, D-S7-4): **a vendor checked in against its photos whose check-in is open** may have orders made for the parcels that are not
 * here yet, a vendor counted without photos has no photo to order from and is never this, and the parcels a senior officer wrote off are told, so that the order of one that was not received is said so.
 */
describe('where a vendor’s check-in stands, for the early orders', () => {
  const checkIn = (overrides: Record<string, unknown> = {}) => {
    const view = parseCheckIn(checkInFixture(PARCELS, overrides));
    if (view === undefined) throw new Error('not a check-in');
    return vendorFactsOf({ kind: 'check-in', view, etag: '"v1"' });
  };
  const WRITTEN_OFF = {
    id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    kind: 'ADJUDICATION',
    intake_parcel_id: null,
    condition: null,
    outcome: 'WRITTEN_OFF',
    note: 'The parcel did not come.',
    evidence_ids: [],
    recorded_by_name: 'Kojo Mensah',
    recorded_at: '2026-11-14T11:00:00Z',
  };

  // Break caught: a vendor whose check-in is open treated as cleared (an arrived parcel offered an order the database refuses), or one that is cleared treated as still being checked in (the early way offered for ever).
  it('is checking in while the check-in is open, and only then', () => {
    expect(checkIn({ state: 'AWAITING_COUNT' })).toMatchObject({
      checkingIn: true,
      cleared: false,
    });
    for (const state of [
      'READY_FOR_ITEMIZATION',
      'ITEMIZING',
      'RECONCILIATION_REQUIRED',
      'CLOSED',
    ]) {
      expect(checkIn({ state }).checkingIn).toBe(false);
    }
  });

  // Break caught: a vendor counted without photos offered the early way (it has no photo to make an order from).
  it('is never checking in for a vendor counted without photos', () => {
    // A vendor counted without photos that is awaiting its count (the pre-count shape of the blind-count screens).
    expect(vendorFactsOf(blindRecord(preCountFixture())).checkingIn).toBe(false);
  });

  // Break caught: the parcels written off told as not written off (an order of a parcel that was not received said to wait for it), or told as written off with no decision made.
  it('tells whether the missing parcels were written off', () => {
    expect(checkIn({ condition_findings: [WRITTEN_OFF] }).writtenOff).toBe(true);
    expect(checkIn({ condition_findings: [] }).writtenOff).toBe(false);
    expect(
      checkIn({ condition_findings: [{ ...WRITTEN_OFF, outcome: 'ESCALATED' }] }).writtenOff,
    ).toBe(false);
    expect(vendorFactsOf(blindRecord(captured('intake-blind-named'))).writtenOff).toBe(false);
  });
});
