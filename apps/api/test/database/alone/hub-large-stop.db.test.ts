// Runs alone: it hands over a stop of 1,000 parcels and reads the statistics counters of its own database's table, a weight and a measurement files beside it would disturb.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BUNDLE_IDS } from '../../../src/tools/seed/bundles.js';
import { submitHandover } from '../support/handed-over.js';
import { manifestDays, type ManifestDays } from '../support/manifest-days.js';
import { arrangeRun } from '../support/runs.js';
import { seedHubConfiguration } from '../support/seeded.js';
import { API, HUB_A, OPS, type Actor } from '../support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from '../support/vendor-routes.js';

/**
 * A vendor's stop of a thousand parcels reaches the hub and is finished in the time of a few hundred (Run E, migration `0109`; OB-S1-132). Before it, the handover of one stop took 5 s for 500
 * parcels and 296 s for 5,000 (the square of the number of parcels), because the guard of a door parcel numbered all the photos of the stop for each parcel it opened and the two deferred checks of an
 * intake each counted all its parcels again for each parcel that was made or changed. The measure is **the number of rows the transaction reads of `intake_parcel`** (the statistics the server keeps of
 * its own table, `seq_tup_read` and the `idx_tup_read` of its indexes), which for N parcels judged N times is about N squared and judged once is a few times N. It is not a time, so it holds on a
 * machine of any speed; what a stop of this size takes through the real routes and the real deadlines is in the plan (OB-S1-132). The checks themselves are held by `hub-parcels.db.test.ts`.
 */
const N = 1000;
/**
 * Rows read of the parcel table and the photo links for N parcels. Observed on 17 November 2026 for N = 1,000, across the parcel table and the photo links: 8,000 for the handover and 27,000 for the finish (eight and twenty-seven times N); the defect is N
 * squared, which is millions. The bound is far above the one and far below the other.
 */
const BOUND = 60 * N;
let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;
let receiver: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
  receiver = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

interface Counters {
  readonly reads: number;
  readonly inserted: number;
  readonly updated: number;
}
/** What the server has counted so far of the reads of the parcel table and of the photo links of the stop's count (the guard of a parcel numbered those), and of the inserts and updates of the parcel table, as it keeps its statistics (flushed by the backend that did the work, a little after its commit). */
async function counters(): Promise<Counters> {
  const [row] = await routes.rows<{ reads: string; inserted: string; updated: string }>(
    `select (coalesce((select sum(seq_tup_read) from pg_stat_user_tables where relname in ('intake_parcel', 'collection_parcel_photo')), 0)
            + coalesce((select sum(idx_tup_read) from pg_stat_user_indexes where relname in ('intake_parcel', 'collection_parcel_photo')), 0))::text as reads,
            coalesce((select n_tup_ins from pg_stat_user_tables where relname = 'intake_parcel'), 0)::text as inserted,
            coalesce((select n_tup_upd from pg_stat_user_tables where relname = 'intake_parcel'), 0)::text as updated`,
  );
  return {
    reads: Number(row?.reads ?? 0),
    inserted: Number(row?.inserted ?? 0),
    updated: Number(row?.updated ?? 0),
  };
}

/** The counters once the work has been flushed: the inserts or the updates say when the reads have arrived with them. */
async function settled(
  since: Counters,
  kind: 'inserted' | 'updated',
  rows: number,
): Promise<Counters> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const now = await counters();
    if (now[kind] - since[kind] >= rows) return now;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error('the statistics of the parcel table were not flushed in fifteen seconds');
}

/** `count` stored `PARCEL_PHOTO` records of a stop, made by one statement with the guards put aside (the operations would take a request for each). */
async function storedPhotos(riderId: string, stopId: string, count: number): Promise<string[]> {
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local session_replication_role = replica');
    const made = await routes.admin.query<{ id: string }>(
      `insert into evidence (id, owner_type, owner_id, purpose, captured_at, captured_by_actor, captured_by_principal_type, storage_ref, responsible_hub_id, vendor_organization_id,
                             access_rule, retention_policy, state, content_type, byte_size, checksum_sha256, upload_ttl_seconds, upload_expires_at, uploaded_at, validated_signature,
                             scanner, scanner_signature_version, scanned_at)
       select gen_random_uuid(), 'PICKUP_STOP', $1::uuid, 'PARCEL_PHOTO', now() - interval '1 minute', $2::uuid, 'RIDER',
              'ev/' || md5(random()::text || clock_timestamp()::text || n::text), $3::uuid, $4::uuid,
              'SUBJECT_READERS', 'PICKUP_STOP_EVIDENCE', 'STORED', 'image/jpeg', 12, repeat('a', 64), 900, now() + interval '15 minutes', now(), 'JPEG',
              'test', '1', now()
         from generate_series(1, $5::int) as n
       returning id`,
      [stopId, riderId, HUB_A, vendor.row.organizationId, count],
    );
    await routes.admin.query('commit');
    return made.rows.map((row) => row.id);
  } catch (error) {
    await routes.admin.query('rollback').catch(() => undefined);
    throw error;
  }
}

/** A collected stop of `n` parcels with the photo of each, as the rider's count leaves it, ready to be handed over. */
async function collectedStop(n: number) {
  const run = await arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendor.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 1,
    stopStates: ['ARRIVED'],
    packages: [n],
    hubId: HUB_A,
  });
  const stop = run.stops[0];
  if (stop === undefined) throw new Error('stop');
  const photos = await storedPhotos(run.rider.id, stop.id, n);
  const recordId = randomUUID();
  await routes.admin.query('begin');
  try {
    await routes.admin.query(
      `insert into collection_record (id, pickup_stop_id, responsible_hub_id, declared_count, collected_count, variance, variance_reason_snapshot, handshake_type, recorded_by)
       values ($1, $2, $3, $4, $4, 'MATCH', null, 'VENDOR_ENTERED_RIDER_DISPLAYED', $5)`,
      [recordId, stop.id, HUB_A, n, run.rider.id],
    );
    await routes.admin.query(
      'insert into collection_parcel_photo (evidence_id, collection_record_id) select unnest($1::uuid[]), $2::uuid',
      [photos, recordId],
    );
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback').catch(() => undefined);
    throw error;
  }
  await routes.admin.query(
    `update pickup_stop set state = 'COLLECTED', resolved_at = now() where id = $1`,
    [stop.id],
  );
  return { run, stop };
}

describe(`a stop of ${String(N)} parcels at the hub`, () => {
  // Break caught (the guard that numbered the photos of the stop for each parcel, and the deferred set check that judged the set again for each parcel): the handover of N parcels reads the parcel
  // table about N squared times (millions of rows for a thousand parcels) and not a few times N.
  it('is handed over reading its parcels a few times each, not once for each of them', async () => {
    const { run, stop } = await collectedStop(N);
    const before = await counters();

    const intakes = await submitHandover(run, [{ requestId: stop.requestId, declared: N }]);

    const after = await settled(before, 'inserted', N);
    const reads = after.reads - before.reads;
    expect(intakes).toHaveLength(1);
    expect(after.inserted - before.inserted).toBe(N);
    expect(reads).toBeGreaterThanOrEqual(N);
    expect(reads).toBeLessThan(BOUND);
    // The parcels are all there, one for each photo, each in its own place.
    const [counted] = await routes.rows<{ parcels: string; ordinals: string }>(
      `select count(*)::text as parcels, count(distinct ordinal)::text as ordinals from intake_parcel where pickup_intake_id = $1`,
      [intakes[0]?.id],
    );
    expect(counted).toEqual({ parcels: String(N), ordinals: String(N) });
  }, 300_000);

  // Break caught (the count check that counted the parcels of the intake for each parcel that changed): "All N here" changes N parcels in one act, and reads the table about N squared times.
  it('is finished with one confirmation reading its parcels a few times each', async () => {
    const { run, stop } = await collectedStop(N);
    const [intake] = await submitHandover(run, [{ requestId: stop.requestId, declared: N }]);
    const ONE = `${API}/hub-intakes/${intake?.id ?? ''}`;
    const etag = (await receiver.client.get(ONE)).header('etag') ?? '';
    const before = await counters();

    const finished = await receiver.client.post(
      `${ONE}/check-in`,
      { all_arrived: true, confirmed_count: N },
      { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
    );

    expect(finished.status).toBe(200);
    const after = await settled(before, 'updated', N);
    const reads = after.reads - before.reads;
    expect(reads).toBeGreaterThanOrEqual(N);
    expect(reads).toBeLessThan(BOUND);
    const [arrived] = await routes.rows<{ arrived: string }>(
      `select count(*)::text as arrived from intake_parcel where pickup_intake_id = $1 and state = 'ARRIVED'`,
      [intake?.id],
    );
    expect(arrived).toEqual({ arrived: String(N) });
  }, 300_000);
});
