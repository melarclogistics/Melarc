import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import { excusePhotos, parcelPhotosOf, photoOf } from './support/evidence-photo.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, arrangedRider, type ArrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, codeOf } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * OB-S1-52, the photo a short count's reason asks for (`PARCEL_DAMAGED_OR_UNSAFE`; pickup-collection.md section 5.5; migration `0089`), against a real PostgreSQL and the real application.
 *
 * Run A2 gave `recordCollection` the photo in `evidence_ids`, but the guard of the record still refused every reason that asks for one, so such a count could never be recorded (the review of
 * Run A2, finding 1). **Named as the fix**: the counts below failed on the commit before it (`809817b`), where the guard raised `REASON_REQUIRED` at the insert for every writer.
 *
 * - **Through the operation**: a count of 2 of 3 with that reason and the photo of the parcel left behind is kept, and the photo is attached to the stop; the same count without the photo, or with
 *   a photo that cannot be counted, is refused and keeps nothing.
 * - **For every writer**: the record is not refused at the insert, and the database holds at the end of the transaction that a count whose reason asks for a photo has one attached to its stop (a
 *   stored `COLLECTION_PROOF` of this stop captured by the rider who counted). Written as the runtime login, which row-level security applies to, and not as the administrator.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const STOP = (id: string) => `${API}/pickup-stops/${id}`;
const COLLECT = (id: string) => `${STOP(id)}/collect`;
const CONFIRM = 'pickup.collection.confirm';
const REASON = 'PARCEL_DAMAGED_OR_UNSAFE';

const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];
const ruleOf = (response: TestResponse): string | undefined =>
  (response.json() as { details?: { rule?: string } }).details?.rule;

/** A run in progress with two stops the rider has arrived at; each declares three packages. */
const run = (): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 2,
    stopStates: ['ARRIVED', 'ARRIVED'],
  });
const stopAt = (arranged: ArrangedRun, index = 0): ArrangedRun['stops'][number] => {
  const stop = arranged.stops[index];
  if (stop === undefined) throw new Error('stop');
  return stop;
};

async function collect(
  rider: ArrangedRider,
  stopId: string,
  body: Record<string, unknown>,
): Promise<TestResponse> {
  const etag = (await rider.client.get(STOP(stopId))).header('etag') ?? '';
  return rider.client.post(COLLECT(stopId), body, {
    headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() },
  });
}

const recordsOf = (stopId: string) =>
  routes.rows<{
    id: string;
    collected_count: number;
    variance: string;
    variance_reason_snapshot: { reason_code?: string } | null;
  }>(
    `select id, collected_count, variance, variance_reason_snapshot from collection_record where pickup_stop_id = $1`,
    [stopId],
  );
const attachedTo = (stopId: string) =>
  routes.rows<{ evidence_id: string; attached_by_rider: string; responsible_hub_id: string }>(
    `select evidence_id, attached_by_rider, responsible_hub_id from pickup_stop_evidence where pickup_stop_id = $1 order by evidence_id`,
    [stopId],
  );
const parcelLinksOf = (stopId: string) =>
  routes.rows<{ evidence_id: string }>(
    `select evidence_id from collection_parcel_photo where pickup_stop_id = $1`,
    [stopId],
  );

describe('recordCollection: the photo a short count’s reason asks for', () => {
  // Break caught (red on 809817b: 422 REASON_REQUIRED from the guard): a count with a photo-asking reason that can never be made, whatever photo it names.
  it('keeps a count of 2 of 3 with the reason that asks for a photo and the photo of the parcel left behind, and attaches the photo to the stop', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const parcels = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);
    const left = await photoOf(routes, arranged.rider, stop.id);

    const response = await collect(arranged.rider, stop.id, {
      collected_count: 2,
      variance_reason_code: REASON,
      evidence_ids: [left.id],
      parcel_photo_ids: parcels,
    });
    expect(response.status, response.text).toBe(200);

    const [record, ...more] = await recordsOf(stop.id);
    expect(more).toEqual([]);
    expect(record).toMatchObject({ collected_count: 2, variance: 'SHORT' });
    expect(record?.variance_reason_snapshot?.reason_code).toBe(REASON);
    // The photo of the parcel left behind is attached to the stop, as a failure's photo is, apart from the photo of each parcel counted.
    expect(await attachedTo(stop.id)).toEqual([
      { evidence_id: left.id, attached_by_rider: arranged.rider.id, responsible_hub_id: HUB_A },
    ]);
    expect((await parcelLinksOf(stop.id)).map((link) => link.evidence_id).toSorted()).toEqual(
      [...parcels].toSorted(),
    );
  });

  // Break caught: the photo not asked for once the guard stops refusing the reason (the service's own refusal removed).
  it('refuses the same count with no photo of the parcel left behind, and keeps nothing', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const parcels = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);

    for (const body of [
      { collected_count: 2, variance_reason_code: REASON, parcel_photo_ids: parcels },
      {
        collected_count: 2,
        variance_reason_code: REASON,
        parcel_photo_ids: parcels,
        evidence_ids: [],
      },
    ]) {
      const response = await collect(arranged.rider, stop.id, body);
      expect(outcome(response), response.text).toEqual([422, 'REASON_REQUIRED']);
      expect(ruleOf(response)).toBe('photo');
    }
    expect(await recordsOf(stop.id)).toEqual([]);
    expect(await attachedTo(stop.id)).toEqual([]);
    expect(await parcelLinksOf(stop.id)).toEqual([]);
  });

  // Break caught: the photo of a parcel counted taken for the photo of the parcel left behind (the two purposes confused), or a record that is not the rider's own.
  it('does not take the photo of a parcel counted, another rider’s record or one that is still pending for the photo of the parcel left behind', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const parcels = await parcelPhotosOf(routes, arranged.rider, stop.id, 3);
    const pending = await photoOf(routes, arranged.rider, stop.id, { complete: false });
    const photoOfAParcel = parcels[2];
    if (photoOfAParcel === undefined) throw new Error('parcel photo');

    for (const evidenceId of [photoOfAParcel, pending.id]) {
      const response = await collect(arranged.rider, stop.id, {
        collected_count: 2,
        variance_reason_code: REASON,
        evidence_ids: [evidenceId],
        parcel_photo_ids: parcels.slice(0, 2),
      });
      expect(outcome(response), response.text).toEqual([422, 'EVIDENCE_NOT_STORED']);
    }
    expect(await recordsOf(stop.id)).toEqual([]);
    expect(await attachedTo(stop.id)).toEqual([]);
  });
});

describe('the database holds the photo of a count whose reason asks for one, for every writer', () => {
  const riderContext = (riderId: string): SecurityContext => ({
    principalType: 'RIDER',
    principalId: riderId,
    sessionId: randomUUID(),
    surface: 'RIDER_ANDROID',
    riderId,
    authorizationKey: CONFIRM,
    hubScopeMode: 'SET',
    authorizedHubIds: [],
    correlationId: 'collection-reason-photo',
  });

  /** The reason as the catalogue holds it now, which is what the record's snapshot has to say. */
  async function snapshotOf(code: string): Promise<string> {
    const row = (
      await routes.rows<{ code: string; label: string; attribution: string }>(
        `select code, label, attribution from reason_code where code = $1 and domain = 'PICKUP_SHORT_COUNT'`,
        [code],
      )
    )[0];
    if (row === undefined) throw new Error(`The catalogue holds no reason ${code}`);
    return JSON.stringify({
      reason_code: row.code,
      label: row.label,
      attribution: row.attribution,
    });
  }

  const insertRecord = (stopId: string, riderId: string, reason: string, recordedBy = riderId) =>
    `insert into collection_record (id, pickup_stop_id, responsible_hub_id, declared_count, collected_count, variance, variance_reason_snapshot,
                                    office_notified_at, handshake_type, recorded_by)
     values ('${randomUUID()}'::uuid, '${stopId}'::uuid, '${HUB_A}'::uuid, 3, 2, 'SHORT', '${reason}'::jsonb, clock_timestamp(),
             'VENDOR_ENTERED_RIDER_DISPLAYED', '${recordedBy}'::uuid)`;
  const attach = (evidenceId: string, stopId: string) =>
    `insert into pickup_stop_evidence (evidence_id, pickup_stop_id) values ('${evidenceId}'::uuid, '${stopId}'::uuid)`;

  /** The statements as the rider's own counting key runs them in one transaction, which commits when they are done: what is refused at the end of it is the commit's. */
  async function asTheRider(riderId: string, statements: readonly string[]): Promise<void> {
    await routes.built.service.transactionWithContext(riderContext(riderId), async (tx) => {
      for (const statement of statements) await tx.execute(sql.raw(statement));
    });
  }
  const refusal = async (work: Promise<void>) => {
    try {
      await work;
      return undefined;
    } catch (error) {
      const server = serverErrorIn(error);
      return { code: server?.code, constraint: server?.constraint };
    }
  };

  // Break caught: the rule held by the application alone, so that a count with a photo-asking reason and no photo is kept by any other writer (red on 809817b: the guard refused the insert
  // itself, with no constraint named, so neither this refusal nor the acceptance below was possible).
  it('refuses at the end of the transaction a count whose reason asks for a photo and has none attached, and keeps it with the photo attached in the same transaction', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    await excusePhotos(routes, stop.id);
    const left = await photoOf(routes, arranged.rider, stop.id);
    const reason = await snapshotOf(REASON);

    expect(
      await refusal(
        asTheRider(arranged.rider.id, [insertRecord(stop.id, arranged.rider.id, reason)]),
      ),
    ).toEqual({ code: '23514', constraint: 'collection_record_reason_photo' });
    expect(await recordsOf(stop.id)).toEqual([]);

    expect(
      await refusal(
        asTheRider(arranged.rider.id, [
          insertRecord(stop.id, arranged.rider.id, reason),
          attach(left.id, stop.id),
        ]),
      ),
    ).toBeUndefined();
    expect(await recordsOf(stop.id)).toHaveLength(1);
    expect((await attachedTo(stop.id)).map((each) => each.evidence_id)).toEqual([left.id]);
  });

  // Break caught: the rule judged at the moment of the insert, so that a photo the rider attached to the stop before the count (its own transaction) is not seen, or one that is not there is.
  it('judges the photos attached to the stop by the end of the transaction, whichever transaction attached them', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    await excusePhotos(routes, stop.id);
    const left = await photoOf(routes, arranged.rider, stop.id);
    const reason = await snapshotOf(REASON);

    // The count is refused whole, then the photo is attached alone, then the same count is made: the photo is on the stop by the end of the transaction, so the count is kept.
    expect(
      await refusal(
        asTheRider(arranged.rider.id, [insertRecord(stop.id, arranged.rider.id, reason)]),
      ),
    ).toMatchObject({ constraint: 'collection_record_reason_photo' });
    await asTheRider(arranged.rider.id, [attach(left.id, stop.id)]);
    expect(
      await refusal(
        asTheRider(arranged.rider.id, [insertRecord(stop.id, arranged.rider.id, reason)]),
      ),
    ).toBeUndefined();
    expect(await recordsOf(stop.id)).toHaveLength(1);
  });

  // Break caught: a count whose reason asks for no photo made to wait for one, or the catalogue's flag left out of the judgement.
  it('asks nothing of a count whose reason asks for no photo, or of a count that matches', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    await excusePhotos(routes, stop.id);
    expect(
      await refusal(
        asTheRider(arranged.rider.id, [
          insertRecord(stop.id, arranged.rider.id, await snapshotOf('SOME_PARCELS_NOT_READY')),
        ]),
      ),
    ).toBeUndefined();
    expect(await recordsOf(stop.id)).toHaveLength(1);
  });

  // Break caught: the photo of another rider (the rider who counted is not the one who captured it) read as the count's own, which the database holds for a writer that names another rider.
  it('does not take as the count’s photo a record that another rider captured', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    await excusePhotos(routes, stop.id);
    const left = await photoOf(routes, arranged.rider, stop.id);
    const reason = await snapshotOf(REASON);
    const other = await arrangedRider(routes.kit, routes.admin);
    // The administrator writes the count in the other rider's name (the policies do not bind an administrator, the guards and the rule do) with the photo the first rider captured attached.
    await routes.admin.query('begin');
    await routes.admin.query(attach(left.id, stop.id));
    let refused: { code?: string; constraint?: string } | undefined;
    try {
      await routes.admin.query(insertRecord(stop.id, arranged.rider.id, reason, other.id));
      await routes.admin.query('commit');
    } catch (error) {
      await routes.admin.query('rollback').catch(() => undefined);
      const server = serverErrorIn(error);
      refused = { code: server?.code, constraint: server?.constraint };
    }
    expect(refused).toEqual({ code: '23514', constraint: 'collection_record_reason_photo' });
    expect(await recordsOf(stop.id)).toEqual([]);
  });

  // Break caught: the photos of any stop read as the count's own (the rule not tied to the stop of the count).
  it('does not take as the count’s photo a record attached to another stop', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const other = stopAt(arranged, 1);
    await excusePhotos(routes, stop.id);
    await excusePhotos(routes, other.id);
    const elsewhere = await photoOf(routes, arranged.rider, other.id);
    const reason = await snapshotOf(REASON);

    expect(
      await refusal(
        asTheRider(arranged.rider.id, [
          attach(elsewhere.id, other.id),
          insertRecord(stop.id, arranged.rider.id, reason),
        ]),
      ),
    ).toEqual({ code: '23514', constraint: 'collection_record_reason_photo' });
    expect(await recordsOf(stop.id)).toEqual([]);
    expect(await attachedTo(other.id)).toEqual([]);
  });
});
