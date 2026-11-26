import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import type { TestResponse } from '../../../src/test-support/test-client.js';

import { excusePhotos, parcelPhotosOf } from './evidence-photo.js';
import type { ManifestDays } from './manifest-days.js';
import { arrangeRun, type ArrangedRun } from './runs.js';
import { API, HUB_A, OPS, type Actor } from './staff-routes.js';
import type { ArrangedVendor, VendorRoutes } from './vendor-routes.js';

/**
 * Runs that have been **handed over to the hub through the real route** (`submitHubHandover`, S1.31), for the tests of what the receiving side does with the intakes it opens (S1.32
 * onward): a run in progress of the hub with a collected stop for each count given, handed over by its rider with the numbers it declares, so that one intake for each stop is open at
 * `AWAITING_COUNT`, exactly as the rider's act leaves them. Nothing here writes an intake: the arrangement is the run (as the administrator, as `arrangeRun` is) and the act is the route.
 */
export interface HandedOverIntake {
  readonly id: string;
  readonly code: string;
  readonly state: string;
  readonly hub_id: string;
  readonly pickup_request_id: string;
  readonly pickup_manifest_id: string;
  readonly handed_over_by: string;
  readonly handed_over_at: string;
  readonly declaration_captured_at: string;
  readonly active_receiver_id: string | null;
  readonly lock_acquired_at: string | null;
  readonly count_phase: string;
}

export interface HandedOver {
  readonly run: ArrangedRun;
  /** The intakes the handover opened, in the order of its rows (the order of the run's stops). */
  readonly intakes: readonly HandedOverIntake[];
  /** What the rider declared for each, in the same order: the number a receiver must not be shown. */
  readonly declared: readonly number[];
  /** The ids of the parcel photos of each stop, where the run was made with `photos`: what a receiver must not be shown before the count. */
  readonly photoIds: readonly string[];
}

export interface HandOverOptions {
  /** What each collected stop was counted at by the rider (one stop each). Default three stops counted at 3. */
  readonly collected?: readonly number[];
  /** What the rider declares for each row, where it is not the number counted. */
  readonly declared?: readonly (number | undefined)[];
  readonly hubId?: string;
  /**
   * Whether the rider's count of each stop has the photo of every parcel it counted, as the real operations make them (D-A10), for a test about what the receiving side must not show
   * of them. Otherwise Ops lets each stop through without photos, which the count of a test about something else need not make.
   */
  readonly photos?: boolean;
  /**
   * With `photos`: the photos are made by one statement with the guards put aside (as `staged-parcel-photos` does) and not one at a time through the rider's real operations, for a collection too large
   * to be photographed through the HTTP stack (the review of 20 November 2026: an intake of more than a hundred parcels must stay workable).
   */
  readonly bulkPhotos?: boolean;
}

/** `count` stored `PARCEL_PHOTO` records of a stop, as the rider's operations make them, by one statement with the guards put aside. */
async function bulkParcelPhotos(
  routes: VendorRoutes,
  vendor: ArrangedVendor,
  riderId: string,
  stopId: string,
  hubId: string,
  count: number,
): Promise<string[]> {
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
      [stopId, riderId, hubId, vendor.row.organizationId, count],
    );
    await routes.admin.query('commit');
    return made.rows.map((row) => row.id);
  } catch (error) {
    await routes.admin.query('rollback').catch(() => undefined);
    throw error;
  }
}

/** The run's collected stops are arranged as the rider's count leaves them (a collection record, the stop closed), and the rider hands the run over. */
export async function handOver(
  routes: VendorRoutes,
  vendor: ArrangedVendor,
  days: ManifestDays,
  options: HandOverOptions = {},
): Promise<HandedOver> {
  const collected = options.collected ?? [3, 3, 3];
  const hubId = options.hubId ?? HUB_A;
  const run = await arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendor.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: collected.length,
    stopStates: collected.map(() => 'ARRIVED' as const),
    // The request declares three parcels, or what the rider counted where that is more (a request of many parcels declares them).
    packages: collected.map((counted) => Math.max(3, counted)),
    hubId,
  });
  const photoIds: string[] = [];
  for (const [at, stop] of run.stops.entries()) {
    const counted = collected[at] ?? 3;
    // Each parcel's photo is a stored record the rider made through the real operations; the count that attaches them and the links are one transaction, as the database holds the number of
    // photos of a count at the end of its transaction. Without photos, Ops lets the stop through without them.
    const photos =
      options.photos !== true
        ? []
        : options.bulkPhotos === true
          ? await bulkParcelPhotos(routes, vendor, run.rider.id, stop.id, hubId, counted)
          : await parcelPhotosOf(routes, run.rider, stop.id, counted);
    if (options.photos !== true) await excusePhotos(routes, stop.id);
    photoIds.push(...photos);
    const recordId = randomUUID();
    await routes.admin.query('begin');
    try {
      await routes.admin.query(
        `insert into collection_record (id, pickup_stop_id, responsible_hub_id, declared_count, collected_count, variance, variance_reason_snapshot, handshake_type, recorded_by)
         values ($1, $2, $3, $8, $4, $5, $6::jsonb, 'VENDOR_ENTERED_RIDER_DISPLAYED', $7)`,
        [
          recordId,
          stop.id,
          hubId,
          counted,
          counted < 3 ? 'SHORT' : 'MATCH',
          counted < 3
            ? JSON.stringify({
                reason_code: 'SOME_PARCELS_NOT_READY',
                label: 'Some parcels not ready',
                attribution: 'CUSTOMER',
              })
            : null,
          run.rider.id,
          // What the vendor declared at the door: three, or the count where that is more (a large count matches its own declaration).
          Math.max(3, counted),
        ],
      );
      for (const photo of photos) {
        await routes.admin.query(
          `insert into collection_parcel_photo (evidence_id, collection_record_id) values ($1, $2)`,
          [photo, recordId],
        );
      }
      await routes.admin.query('commit');
    } catch (error) {
      await routes.admin.query('rollback').catch(() => undefined);
      throw error;
    }
    await routes.admin.query(
      `update pickup_stop set state = 'COLLECTED', resolved_at = now() where id = $1`,
      [stop.id],
    );
  }
  const declared = run.stops.map((_, at) => options.declared?.[at] ?? collected[at] ?? 0);
  const intakes = await submitHandover(
    run,
    run.stops.map((stop, at) => ({ requestId: stop.requestId, declared: declared[at] ?? 0 })),
  );
  return { run, intakes, declared, photoIds };
}

/**
 * The custody holder hands a run over through the real route (`submitHubHandover`), with one row for each request the run collected and the number the rider declares for it. The run's
 * stops are all closed; the handover completes the run and opens its intakes in one transaction, which is how a run that collected parcels is completed (the database holds that its
 * intakes are exactly its collected requests, migration 0092), so a test that needs such a run completed does it here and not with a statement of its own.
 */
export async function submitHandover(
  run: ArrangedRun,
  rows: readonly { readonly requestId: string; readonly declared: number }[],
): Promise<HandedOverIntake[]> {
  const manifest = `${API}/pickup-manifests/${run.manifest.id}`;
  const read = await run.rider.client.get(manifest);
  expect(read.status).toBe(200);
  const response = await run.rider.client.post(
    `${manifest}/hub-handover`,
    {
      rows: rows.map((row) => ({
        pickup_request_id: row.requestId,
        declared_count: row.declared,
      })),
      captured_at: new Date(Date.now() - 60_000).toISOString(),
    },
    { headers: { 'If-Match': read.header('etag') ?? '', 'Idempotency-Key': randomUUID() } },
  );
  expect(response.status).toBe(201);
  return response.json() as HandedOverIntake[];
}

/**
 * An intake as the count of S1.33 leaves it, arranged as the administrator through the state machine of the guard (the count is the next task's operation; what a read does with a counted
 * intake is this task's). The comparison is the one the numbers say.
 */
export async function arrangeCounted(
  routes: VendorRoutes,
  intakeId: string,
  physicalCount: number,
  declared: number,
): Promise<void> {
  // `declared` is the number the rider declared, which the comparison is made against (the database holds it; the arrangement is told it only to say the variance).
  const difference = physicalCount - declared;
  await routes.admin.query(
    `update pickup_intake
        set state = 'COUNTED', physical_count = $2::integer, counted_at = now(), counted_by = gen_random_uuid(),
            count_variance = case when $3::integer = 0 then 'MATCH' when $3::integer < 0 then 'SHORT' else 'OVER' end, count_difference = $3::integer
      where id = $1`,
    [intakeId, physicalCount, difference],
  );
}

/**
 * A receiver counts an intake through the real route (`submitBlindCount`): it reads the intake for its ETag, and commits the physical count with a key of its own. The answer is the
 * response of the route, so that a test of what follows a count (a condition, an adjudication, a read) arranges it as the application does.
 */
export async function countIntake(
  actor: Actor,
  intakeId: string,
  physicalCount: number,
): Promise<TestResponse> {
  const intake = `${API}/hub-intakes/${intakeId}`;
  const read = await actor.client.get(intake);
  expect(read.status).toBe(200);
  return actor.client.post(
    `${intake}/count`,
    { physical_count: physicalCount },
    {
      origin: OPS,
      headers: { 'If-Match': read.header('etag') ?? '', 'Idempotency-Key': randomUUID() },
    },
  );
}
