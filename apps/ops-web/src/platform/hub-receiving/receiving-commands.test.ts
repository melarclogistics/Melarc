import { createBrowserApiClient } from '@melarc/api-client/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import {
  KENTE_INTAKE_ID,
  RUN_ID,
  arrivedParcel,
  countsOf,
  extraParcel,
  parcelFixture,
  uuid,
} from '../../test-support/receiving-fixture';
import {
  acquireReceivingLock,
  addExtraParcel,
  correctIntakeCount,
  finishCheckIn,
  recordParcelArrival,
  recordParcelCondition,
} from './receiving-commands';

/**
 * The wire shape of the acts of the receiving screens of a run (S1.35c), read from the requests the real client puts on the wire: the method, the path, the headers each operation declares **and no other**, and
 * the body in the contract's names. A tap carries neither a key nor a version; the finish of a vendor carries both; an extra a key only. What each act answers is judged: an answer for another parcel or vendor, or one
 * that does not say what was asked, is an answer that is not the API's, which a confirmed command reads as an outcome that is not known (the act may have been done).
 */
const KEY = 'key-0001';
const VERSION = '"kente-3"';
const NEW_VERSION = '"kente-4"';

let api: FakeApi;
const client = () => createBrowserApiClient();

beforeEach(() => {
  document.cookie = 'melarc_csrf=csrf-token; path=/';
});
afterEach(() => {
  api.restore();
  document.cookie = 'melarc_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

const last = () => {
  const request = api.requests.at(-1);
  if (request === undefined) throw new Error('nothing was sent');
  return request;
};
const bodyOf = async (): Promise<unknown> => last().clone().json();

const parcels = [
  arrivedParcel(1),
  arrivedParcel(2),
  parcelFixture(3, { state: 'MISSING', missing_marked_at: '2026-11-14T09:30:00Z' }),
];
const record = (over: Record<string, unknown> = {}) => ({
  id: KENTE_INTAKE_ID,
  code: 'ACC-IN-3HN7WD',
  hub_id: uuid(0x33, 1),
  pickup_request_id: uuid(0x44, 1),
  pickup_manifest_id: RUN_ID,
  run_code: 'ACC-MF-7KQ2MZ',
  state: 'RECONCILIATION_REQUIRED',
  count_phase: 'CHECK_IN',
  receiving_mode: 'PHOTO_CHECK_IN',
  vendor_name: 'Kente Crafts',
  handed_over_by_name: 'Kofi Boateng',
  handed_over_at: '2026-11-14T09:00:00Z',
  rider_declared_count: 3,
  received_count: 2,
  count_variance: 'SHORT',
  count_difference: -1,
  counted_at: '2026-11-14T09:30:00Z',
  counted_by_name: 'Ama Owusu',
  lock: null,
  parcels,
  ...countsOf(parcels),
  condition: 'OK',
  condition_findings: [],
  ...over,
});
const counts = {
  parcels_expected: 3,
  arrived_count: 1,
  received_count: null,
  count_variance: null,
  missing_count: 0,
  extra_count: 0,
  damaged_count: 0,
};

describe('acquireReceivingLock', () => {
  it('posts to the lock with no body, no key and no version, and accepts the intake as the answer', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/lock`]: () => json(200, record()),
    });
    await acquireReceivingLock(client(), KENTE_INTAKE_ID);
    expect(last().method).toBe('POST');
    expect(last().headers.get('Idempotency-Key')).toBeNull();
    expect(last().headers.get('If-Match')).toBeNull();
    expect(await last().clone().text()).toBe('');
  });

  // Break caught: the lock of another intake taken as the lock of the one asked about.
  it('reads an answer for another intake as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/lock`]: () => json(200, record({ id: uuid(0x55, 9) })),
    });
    await expect(acquireReceivingLock(client(), KENTE_INTAKE_ID)).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
  });
});

describe('recordParcelArrival', () => {
  const answer = (parcel: unknown) => json(200, { parcel, intake_etag: NEW_VERSION, counts });

  it('puts the desired state with no key and no version, and answers the parcel as it now is', async () => {
    api = installFakeApi({
      [`PUT /intake-parcels/${arrivedParcel(1).id}/arrival`]: () => answer(arrivedParcel(1)),
    });
    const view = await recordParcelArrival(client(), arrivedParcel(1).id, true);
    expect(last().method).toBe('PUT');
    expect(last().headers.get('Idempotency-Key')).toBeNull();
    expect(last().headers.get('If-Match')).toBeNull();
    expect(await bodyOf()).toEqual({ arrived: true });
    expect(view.parcel.state).toBe('ARRIVED');
    expect(view.intake_etag).toBe(NEW_VERSION);
  });

  it('puts arrived false for a tap taken back', async () => {
    api = installFakeApi({
      [`PUT /intake-parcels/${parcelFixture(1).id}/arrival`]: () => answer(parcelFixture(1)),
    });
    const view = await recordParcelArrival(client(), parcelFixture(1).id, false);
    expect(await bodyOf()).toEqual({ arrived: false });
    expect(view.parcel.state).toBe('EXPECTED');
  });

  // Break caught: an answer that says the parcel is not in the state that was asked (a tap that did nothing) read as success; and the parcel of another tap taken as this one's.
  it('reads a parcel that is not in the state asked, or is another parcel, as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`PUT /intake-parcels/${arrivedParcel(1).id}/arrival`]: () => answer(parcelFixture(1)),
    });
    await expect(recordParcelArrival(client(), arrivedParcel(1).id, true)).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
    api.restore();
    api = installFakeApi({
      [`PUT /intake-parcels/${arrivedParcel(1).id}/arrival`]: () => answer(arrivedParcel(2)),
    });
    await expect(recordParcelArrival(client(), arrivedParcel(1).id, true)).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
  });
});

describe('finishCheckIn', () => {
  const finished = (over: Record<string, unknown> = {}) =>
    json(200, record(over), { ETag: NEW_VERSION });

  it('posts "All N here" with the number the officer counted, a key and the vendor’s version, and nothing else', async () => {
    const all = [arrivedParcel(1), arrivedParcel(2), arrivedParcel(3)];
    api = installFakeApi({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/check-in`]: () =>
        finished({
          state: 'READY_FOR_ITEMIZATION',
          parcels: all,
          ...countsOf(all),
          received_count: 3,
          count_variance: 'MATCH',
          count_difference: 0,
        }),
    });
    const result = await finishCheckIn(
      client(),
      KENTE_INTAKE_ID,
      { allArrived: true, confirmedCount: 3 },
      VERSION,
      KEY,
    );
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(last().headers.get('If-Match')).toBe(VERSION);
    expect(await bodyOf()).toEqual({ all_arrived: true, confirmed_count: 3 });
    expect(result.intake.state).toBe('READY_FOR_ITEMIZATION');
    expect(result.version).toBe(NEW_VERSION);
  });

  it('posts the finish as tapped with no number', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/check-in`]: () => finished(),
    });
    const result = await finishCheckIn(
      client(),
      KENTE_INTAKE_ID,
      { allArrived: false },
      VERSION,
      KEY,
    );
    expect(await bodyOf()).toEqual({ all_arrived: false });
    expect(result.intake.missing_count).toBe(1);
  });

  // Break caught: "All N here" answered with another number than the officer confirmed, a vendor still waiting, or a vendor that is not this one, taken as finished.
  it('reads an answer that is not this vendor, still waiting, or counted at another number as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/check-in`]: () => finished({ id: uuid(0x55, 9) }),
    });
    await expect(
      finishCheckIn(client(), KENTE_INTAKE_ID, { allArrived: false }, VERSION, KEY),
    ).rejects.toMatchObject({ kind: 'unexpected-response' });
    api.restore();
    api = installFakeApi({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/check-in`]: () =>
        finished({
          state: 'AWAITING_COUNT',
          received_count: null,
          count_variance: null,
          count_difference: null,
          counted_at: null,
          counted_by_name: null,
        }),
    });
    await expect(
      finishCheckIn(client(), KENTE_INTAKE_ID, { allArrived: false }, VERSION, KEY),
    ).rejects.toMatchObject({ kind: 'unexpected-response' });
    api.restore();
    api = installFakeApi({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/check-in`]: () => finished(),
    });
    await expect(
      finishCheckIn(
        client(),
        KENTE_INTAKE_ID,
        { allArrived: true, confirmedCount: 3 },
        VERSION,
        KEY,
      ),
    ).rejects.toMatchObject({ kind: 'unexpected-response' });
  });

  it('reads an answer without a version as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/check-in`]: () => json(200, record()),
    });
    await expect(
      finishCheckIn(client(), KENTE_INTAKE_ID, { allArrived: false }, VERSION, KEY),
    ).rejects.toMatchObject({ kind: 'unexpected-response' });
  });
});

describe('addExtraParcel', () => {
  it('posts the photo taken at the hub with a key and no version, and answers the extra', async () => {
    const extra = extraParcel(4);
    api = installFakeApi({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/extra-parcels`]: () =>
        json(200, { parcel: extra, intake_etag: VERSION, counts }),
    });
    const view = await addExtraParcel(
      client(),
      KENTE_INTAKE_ID,
      extra.photo_evidence_id,
      undefined,
      KEY,
    );
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(last().headers.get('If-Match')).toBeNull();
    expect(await bodyOf()).toEqual({ photo_evidence_id: extra.photo_evidence_id });
    expect(view.parcel.origin).toBe('HUB_EXTRA');
  });

  // Break caught: a parcel that is not an extra, or is not drawn from the photo that was sent, taken as the extra that was added.
  it('reads an answer that is not an extra with that photo as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/extra-parcels`]: () =>
        json(200, { parcel: arrivedParcel(1), intake_etag: VERSION, counts }),
    });
    await expect(
      addExtraParcel(
        client(),
        KENTE_INTAKE_ID,
        extraParcel(4).photo_evidence_id,
        'on the shelf',
        KEY,
      ),
    ).rejects.toMatchObject({ kind: 'unexpected-response' });
    expect(await bodyOf()).toEqual({
      photo_evidence_id: extraParcel(4).photo_evidence_id,
      note: 'on the shelf',
    });
  });
});

describe('recordParcelCondition', () => {
  const damaged = {
    condition: 'DAMAGED',
    note: 'Crushed at one corner.',
    evidence_ids: [uuid(0xe0, 1)],
    recorded_by_name: 'Ama Owusu',
    recorded_at: '2026-11-14T09:20:00Z',
  };

  it('names the parcel in the body and sends a key and the vendor’s version', async () => {
    const hurt = [
      arrivedParcel(1, { condition: damaged as never }),
      arrivedParcel(2),
      parcelFixture(3),
    ];
    api = installFakeApi({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/condition`]: () =>
        json(
          200,
          record({
            parcels: hurt,
            ...countsOf(hurt),
            state: 'AWAITING_COUNT',
            received_count: null,
            count_variance: null,
            count_difference: null,
            counted_at: null,
            counted_by_name: null,
          }),
          { ETag: NEW_VERSION },
        ),
    });
    const result = await recordParcelCondition(
      client(),
      KENTE_INTAKE_ID,
      {
        parcelId: arrivedParcel(1).id,
        condition: 'DAMAGED',
        note: 'Crushed at one corner.',
        evidenceIds: [uuid(0xe0, 1)],
      },
      VERSION,
      KEY,
    );
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(last().headers.get('If-Match')).toBe(VERSION);
    expect(await bodyOf()).toEqual({
      condition: 'DAMAGED',
      parcel_id: arrivedParcel(1).id,
      note: 'Crushed at one corner.',
      evidence_ids: [uuid(0xe0, 1)],
    });
    expect(result.version).toBe(NEW_VERSION);
  });

  // Break caught: an answer in which the parcel does not carry the condition that was recorded read as recorded.
  it('reads an answer in which the parcel carries no such condition as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/condition`]: () =>
        json(200, record(), { ETag: NEW_VERSION }),
    });
    await expect(
      recordParcelCondition(
        client(),
        KENTE_INTAKE_ID,
        { parcelId: arrivedParcel(1).id, condition: 'DAMAGED', evidenceIds: [uuid(0xe0, 1)] },
        VERSION,
        KEY,
      ),
    ).rejects.toMatchObject({ kind: 'unexpected-response' });
  });
});

describe('correctIntakeCount', () => {
  it('posts a photo intake’s parcel changes with a reason, a key and the version, and answers the vendor’s record', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/correction`]: () =>
        json(200, record(), { ETag: NEW_VERSION }),
    });
    const result = await correctIntakeCount(
      client(),
      KENTE_INTAKE_ID,
      {
        reason: 'The third parcel was under the table.',
        parcelChanges: [{ parcelId: parcels[2]?.id ?? '', state: 'ARRIVED' }],
      },
      VERSION,
      KEY,
    );
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(last().headers.get('If-Match')).toBe(VERSION);
    expect(await bodyOf()).toEqual({
      reason: 'The third parcel was under the table.',
      parcel_changes: [{ parcel_id: parcels[2]?.id, state: 'ARRIVED' }],
    });
    expect(result.checkIn?.id).toBe(KENTE_INTAKE_ID);
  });

  // Break caught: a photo intake’s correction answered with a counted intake, or a blind-count correction answered with another number than the one corrected to.
  it('reads an answer of the other mode, or at another number, as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/correction`]: () =>
        json(200, record(), { ETag: NEW_VERSION }),
    });
    await expect(
      correctIntakeCount(
        client(),
        KENTE_INTAKE_ID,
        { reason: 'Recounted.', physicalCount: 5 },
        VERSION,
        KEY,
      ),
    ).rejects.toMatchObject({ kind: 'unexpected-response' });
    expect(await bodyOf()).toEqual({ reason: 'Recounted.', physical_count: 5 });
  });
});
