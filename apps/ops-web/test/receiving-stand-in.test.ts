import type { Route } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import {
  parseCheckIn,
  parseParcelAnswer,
  parseRunListPage,
  parseRunPage,
} from '../src/platform/hub-receiving/receiving-shape';
import { world, IDS } from './browser/support/receiving-api';
import {
  answerRuns,
  checkInWire,
  countsOf,
  parcelRow,
  runWire,
  summaryWire,
} from './browser/support/receiving-runs-api';

/**
 * The browser stand-in of the receiving screens of a run (`test/browser/support/receiving-runs-api.ts`) is held to the portal's own judges of the contract's answers, so that a stand-in that puts a malformed
 * identifier, a count that does not follow from the parcels or a number of the rider's where it never is, is a failure here (in a second, with the cause) and not a page that says "This run could not be loaded"
 * in a browser three minutes into a run. The judges are the ones the screens use, and `test/hub-receiving-contract.test.ts` holds them to the contract.
 */
/** What the world must hold, or the test cannot begin: a world that has lost its first run is a failure of its own. */
function held<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the stand-in's world holds no ${what}`);
  return value;
}
const w = world();
const waiting = held(w.runs[0], 'run that waits');
const decision = held(w.runs[1], 'run that was checked in');
const blind = held(
  waiting.vendors.find((vendor) => vendor.mode === 'BLIND_COUNT'),
  'vendor counted blind',
);
const photo = held(
  waiting.vendors.find((vendor) => vendor.mode === 'PHOTO_CHECK_IN'),
  'vendor with door photos',
);

describe('the stand-in’s answers, read by the portal’s own judges', () => {
  // Break caught: an identifier that is not one (a first group of nine characters), an enumeration the contract does not have, or a count that does not follow from the parcels.
  it.each([
    ['the run that waits', waiting],
    ['the run that was checked in, with a parcel missing', decision],
  ])('has the page of %s accepted', (_name, run) => {
    expect(parseRunPage(runWire(run, false))).toBeDefined();
  });

  it('has the queue’s rows accepted, with what is left to do', () => {
    const page = parseRunListPage({
      items: w.runs.map(summaryWire),
      next_page_token: null,
    });
    expect(page?.items).toHaveLength(2);
    expect(page?.items[0]?.vendors_waiting).toBe(3);
    expect(page?.items[1]?.vendors_needing_decision).toBe(1);
    expect(page?.items[1]?.missing_searching).toBe(1);
  });

  // Break caught (D-D3): a blind vendor's page with the rider's number in it, accepted: the judge must refuse the leak the stand-in plants when it is asked to.
  it('has the page of a vendor counted blind carry no parcel and none of the rider’s number, and refuses the leak', () => {
    const clean = parseRunPage(runWire(waiting, false));
    const vendor = clean?.vendors.find((candidate) => candidate.receiving_mode === 'BLIND_COUNT');
    expect(vendor?.parcels).toEqual([]);
    expect(vendor?.parcels_expected).toBeNull();
    expect(JSON.stringify(runWire(waiting, false))).not.toContain(String(blind.riderNumber));
    expect(JSON.stringify(runWire(waiting, true))).toContain(String(blind.riderNumber));
    expect(parseRunPage(runWire(waiting, true))).toBeUndefined();
  });

  it('has the vendor’s record as the finish answers it accepted', () => {
    expect(parseCheckIn(checkInWire(waiting, photo))).toBeDefined();
    expect(
      parseCheckIn(
        checkInWire(decision, held(decision.vendors[0], 'vendor of the run that was checked in')),
      ),
    ).toBeDefined();
  });

  it('has the answer of a tap accepted: the parcel, the token and the counts derived from the parcels', () => {
    const parcel = photo.parcels[0] ?? parcelRow(1, 1);
    expect(
      parseParcelAnswer({
        parcel: {
          id: parcel.id,
          ordinal: parcel.ordinal,
          origin: parcel.origin,
          state: parcel.state,
          photo_evidence_id: parcel.photo,
          arrived_by_name: null,
          arrived_at: null,
          missing_marked_at: null,
          condition: null,
        },
        intake_etag: '"r1"',
        counts: { ...countsOf(photo), received_count: null, count_variance: null },
      }),
    ).toBeDefined();
  });

  it('keeps the blind vendor of the run the one intake the blind count page reads', () => {
    expect(blind.id).toBe(IDS.waiting);
    expect(w.intakes.some((intake) => intake.id === blind.id)).toBe(true);
  });
});

/** The part of a route the runs' handler reads: the address of the request, and an answer it is given. */
const routeTo = (path: string): Route =>
  ({
    request: () => ({ url: () => `http://127.0.0.1${path}` }),
    fulfill: () => Promise.resolve(),
  }) as unknown as Route;
const context = {
  runs: w.runs,
  holds: () => true,
  leak: false,
  stored: () => false,
  me: IDS.me,
  pageSize: 100,
  note: () => undefined,
};
const post = (path: string) =>
  answerRuns(
    routeTo(path),
    { method: 'POST', path, ifMatch: undefined, idempotencyKey: undefined, body: {} },
    context,
  );

describe('what the runs’ handler leaves to the intake pages', () => {
  // Break caught: the run's lock taken for a vendor counted blind, which answers the blind count page with the wrong shape of record (found in a browser run: the count page never said it held the lock).
  it('answers the lock of a vendor with door photos and leaves the lock of a vendor counted blind to the intake’s own handler', async () => {
    expect(await post(`/api/v1/hub-intakes/${photo.id}/lock`)).toBe(true);
    expect(await post(`/api/v1/hub-intakes/${blind.id}/lock`)).toBe(false);
  });

  it('leaves the condition of a vendor counted blind to the intake’s own handler too', async () => {
    expect(await post(`/api/v1/hub-intakes/${blind.id}/condition`)).toBe(false);
  });

  it('leaves what is not its own: a request for an intake that is no vendor of a run', async () => {
    expect(await post('/api/v1/hub-intakes/60a2b153-8fa4-40c1-9243-5e6f708192a3/lock')).toBe(false);
  });
});
