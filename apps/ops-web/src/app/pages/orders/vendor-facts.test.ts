import { describe, expect, it } from 'vitest';

import type { IntakeRecordView } from '../../../platform/hub-receiving/use-intake-record';
import { parseIntake } from '../../../platform/hub-intake/hub-intake-shape';
import { parseCheckIn } from '../../../platform/hub-receiving/receiving-shape';
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
