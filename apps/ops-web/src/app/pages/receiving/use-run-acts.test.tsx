import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  errorResponse,
  installFakeApi,
  json,
  type FakeApi,
  type Handler,
} from '../../../test-support/fake-api';
import {
  KENTE_INTAKE_ID,
  PARCEL_KIND,
  PHOTO_KIND,
  RUN_ID,
  SHEA_INTAKE_ID,
  arrivedParcel,
  countsOf,
  parcelFixture,
  photoVendorFixture,
  runFixture,
  uuid,
} from '../../../test-support/receiving-fixture';
import { renderWithProviders } from '../../../test-support/render-providers';
import type { RunPageView } from '../../../platform/hub-receiving/receiving-shape';
import { useReceivingRun } from '../../../platform/hub-receiving/use-receiving-queries';
import { useRunActs, type RunActs } from './use-run-acts';

/**
 * The tap of the run's page (S1.35c): the first act on a vendor takes its lock and the next does not, **the API's answer is put into the page that was read** (twelve taps are twelve requests, not twenty-four),
 * **the taps of one vendor go one at a time in the order they were made** (the answer of a tap carries the vendor's counts at that moment), and a refusal is answered in the table's words, with the run read again
 * when it says the vendor is no longer as the officer saw it.
 */
let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const RUN_READ = `GET /receiving-runs/${RUN_ID}`;
const LOCK = `POST /hub-intakes/${KENTE_INTAKE_ID}/lock`;
const arrival = (n: number) => `PUT /intake-parcels/${parcelFixture(n).id}/arrival`;

let acts: RunActs | undefined;
let page: RunPageView | undefined;

function Probe() {
  const query = useReceivingRun(RUN_ID);
  acts = useRunActs(RUN_ID, query.refetch);
  page = query.data;
  return null;
}

/** The answer of a tap: the parcels as they are after it, the vendor's token and its counts. */
const answerFor = (parcels: ReturnType<typeof parcelFixture>[], at: number, version: string) =>
  json(200, {
    parcel: parcels[at],
    intake_etag: version,
    counts: { ...countsOf(parcels), received_count: null, count_variance: null },
  });

const lockAnswer = () => json(200, { ...photoVendorFixture(3), count_phase: 'CHECK_IN' });

function open(handlers: Record<string, Handler>) {
  api = installFakeApi({
    [RUN_READ]: () => json(200, runFixture([photoVendorFixture(3)])),
    [LOCK]: lockAnswer,
    ...handlers,
  });
  renderWithProviders(<Probe />, { signedIn: true });
}
const requests = (route: string) =>
  api.requests.filter(
    (request) =>
      `${request.method} ${new URL(request.url).pathname}` ===
      `${route.split(' ')[0] ?? ''} /api/v1${route.split(' ')[1] ?? ''}`,
  );
const loaded = () =>
  waitFor(() => {
    expect(page).toBeDefined();
    expect(acts).toBeDefined();
  });
const actsNow = (): RunActs => {
  if (acts === undefined) throw new Error('not mounted');
  return acts;
};

describe('the taps of two vendors', () => {
  const sheaParcels = [1, 2].map((n) =>
    parcelFixture(n, {
      id: uuid(PARCEL_KIND, 100 + n),
      photo_evidence_id: uuid(PHOTO_KIND, 100 + n),
    }),
  );
  const sheaVendor = photoVendorFixture(
    2,
    { intake_id: SHEA_INTAKE_ID, intake_etag: '"shea-1"', vendor_name: 'Shea Naturals' },
    sheaParcels,
  );

  // Break caught: the taps of each vendor kept in a line of their own, so that two taps made together are in flight together: each merges its answer into a page it read before the other was written, and the
  // later write is over the earlier. The taps of the page go one at a time, whichever vendor they are for.
  it('goes one at a time across the page, so that the tap on one vendor is never written over by another', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sheaArrived = [
      {
        ...sheaParcels[0],
        state: 'ARRIVED' as const,
        arrived_by_name: 'Ama Owusu',
        arrived_at: '2026-11-16T09:14:00Z',
      },
      sheaParcels[1],
    ];
    open({
      [RUN_READ]: () => json(200, runFixture([photoVendorFixture(3), sheaVendor])),
      [`POST /hub-intakes/${SHEA_INTAKE_ID}/lock`]: () =>
        json(200, { ...sheaVendor, id: SHEA_INTAKE_ID, count_phase: 'CHECK_IN' }),
      [arrival(1)]: async () => {
        await held;
        return answerFor([arrivedParcel(1), parcelFixture(2), parcelFixture(3)], 0, '"kente-2"');
      },
      [`PUT /intake-parcels/${sheaParcels[0]?.id ?? ''}/arrival`]: () =>
        json(200, {
          parcel: sheaArrived[0],
          intake_etag: '"shea-1"',
          counts: { ...countsOf(sheaArrived as never), received_count: null, count_variance: null },
        }),
    });
    await loaded();

    const first = actsNow().tap(KENTE_INTAKE_ID, parcelFixture(1).id, true);
    const second = actsNow().tap(SHEA_INTAKE_ID, sheaParcels[0]?.id ?? '', true);
    await waitFor(() => {
      expect(requests(arrival(1))).toHaveLength(1);
    });
    expect(requests(`PUT /intake-parcels/${sheaParcels[0]?.id ?? ''}/arrival`)).toHaveLength(0);

    release();
    await Promise.all([first, second]);
    await waitFor(() => {
      expect(page?.vendors[0]?.parcels[0]?.state).toBe('ARRIVED');
      expect(page?.vendors[1]?.parcels[0]?.state).toBe('ARRIVED');
    });
  });
});

describe('a tap on the run’s page', () => {
  // Break caught: the lock taken by every tap, or by none: the first act on a vendor takes it and the second does not ask again.
  it('takes the vendor’s lock on the first tap and not again on the second', async () => {
    const taps = [arrivedParcel(1), arrivedParcel(2), parcelFixture(3)];
    open({
      [arrival(1)]: () =>
        answerFor([arrivedParcel(1), parcelFixture(2), parcelFixture(3)], 0, '"kente-2"'),
      [arrival(2)]: () => answerFor(taps, 1, '"kente-2"'),
    });
    await loaded();
    expect(requests(LOCK)).toHaveLength(0);

    await actsNow().tap(KENTE_INTAKE_ID, parcelFixture(1).id, true);
    await actsNow().tap(KENTE_INTAKE_ID, parcelFixture(2).id, true);

    expect(requests(LOCK)).toHaveLength(1);
    expect(requests(arrival(1))).toHaveLength(1);
    expect(requests(arrival(2))).toHaveLength(1);
  });

  // Break caught: a tap that reads the whole run again, which is twice the requests of the officer's work (and a flicker), or one whose answer is not put into the page.
  it('puts the answer into the page that was read and does not read the run again', async () => {
    open({
      [arrival(1)]: () =>
        answerFor([arrivedParcel(1), parcelFixture(2), parcelFixture(3)], 0, '"kente-2"'),
    });
    await loaded();
    expect(page?.vendors[0]?.parcels[0]?.state).toBe('EXPECTED');

    const result = await actsNow().tap(KENTE_INTAKE_ID, parcelFixture(1).id, true);

    expect(result).toEqual({});
    await waitFor(() => {
      expect(page?.vendors[0]?.parcels[0]?.state).toBe('ARRIVED');
    });
    expect(page?.vendors[0]?.arrived_count).toBe(1);
    expect(page?.vendors[0]?.intake_etag).toBe('"kente-2"');
    expect(requests(RUN_READ)).toHaveLength(1);
  });

  // Break caught: two taps in flight answered in the other order, so that the page keeps the counts of the first after the second was done.
  it('sends the taps of one vendor one at a time, in the order they were made', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    open({
      [arrival(1)]: async () => {
        await held;
        return answerFor([arrivedParcel(1), parcelFixture(2), parcelFixture(3)], 0, '"kente-2"');
      },
      [arrival(2)]: () =>
        answerFor([arrivedParcel(1), arrivedParcel(2), parcelFixture(3)], 1, '"kente-2"'),
    });
    await loaded();

    const first = actsNow().tap(KENTE_INTAKE_ID, parcelFixture(1).id, true);
    const second = actsNow().tap(KENTE_INTAKE_ID, parcelFixture(2).id, true);
    await waitFor(() => {
      expect(requests(arrival(1))).toHaveLength(1);
    });
    // The second tap waits for the first: nothing of it has been sent while the first is on its way.
    expect(requests(arrival(2))).toHaveLength(0);

    release();
    await Promise.all([first, second]);
    expect(requests(arrival(2))).toHaveLength(1);
    await waitFor(() => {
      expect(page?.vendors[0]?.arrived_count).toBe(2);
    });
  });

  // Break caught: a refusal that is a generic failure (or the server's text), and one that says the vendor changed but leaves the page as it was read.
  it('says why in the table’s words, and reads the run again when the vendor is no longer as it was seen', async () => {
    open({
      [arrival(1)]: () => errorResponse(409, 'STATE_CONFLICT', { rule: 'check_in_finished' }),
    });
    await loaded();

    const result = await actsNow().tap(KENTE_INTAKE_ID, parcelFixture(1).id, true);

    expect(result.problem?.message).toMatch(/was finished already, so nothing was changed/);
    await waitFor(() => {
      expect(requests(RUN_READ)).toHaveLength(2);
    });
  });

  it('says it in words and does not read the run again for a refusal that does not say the vendor changed', async () => {
    open({
      [arrival(1)]: () => errorResponse(403, 'PERMISSION_DENIED'),
    });
    await loaded();

    const result = await actsNow().tap(KENTE_INTAKE_ID, parcelFixture(1).id, true);

    expect(result.problem?.message).toMatch(
      /Your account can’t count the parcels received at a hub/,
    );
    expect(requests(RUN_READ)).toHaveLength(1);
    expect(page?.vendors[0]?.parcels[0]?.state).toBe('EXPECTED');
  });

  // Break caught: a lock that refuses the officer (its words) stopping the tap: the lock is advisory.
  it('goes on with the tap when the lock could not be taken', async () => {
    open({
      [LOCK]: () => errorResponse(500, 'INTERNAL_ERROR'),
      [arrival(1)]: () =>
        answerFor([arrivedParcel(1), parcelFixture(2), parcelFixture(3)], 0, '"kente-2"'),
    });
    await loaded();

    const result = await actsNow().tap(KENTE_INTAKE_ID, parcelFixture(1).id, true);

    expect(result).toEqual({});
    await waitFor(() => {
      expect(actsNow().lockStatus(KENTE_INTAKE_ID)).toBe('cannot-check');
    });
  });
});
