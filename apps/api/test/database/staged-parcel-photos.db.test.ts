import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { excusePhotos, parcelPhotosOf, photoOf } from './support/evidence-photo.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import { insertAdHocSender, insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { arrangeRun, arrangedRider, type ArrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * D-E1 (the Product Owner's decision of 17 November 2026; pickup-collection.md section 5.5; the plan's Stage 6b; migration `0108`): **the rider stages the parcel photos of a count that is
 * not yet made**, in batches of 1 to 500, and the count (`recordCollection`) attaches the staged photos with the ones it names. Against a real PostgreSQL and the real application, with the
 * photos made by the real operations of the evidence store (and, for the headline of 3,000 parcels, by direct inserts that only make the rows quickly).
 *
 * - **A batch**: stored photos of this rider and this stop, none attached, put aside in one statement; the answer is how many are staged, never a list; a photo staged twice is a no-op
 *   (a replay under the same key returns the stored answer, a repeat under another key the same set); one unusable photo refuses the whole batch with the one answer
 *   `EVIDENCE_NOT_STORED` and stages none of it.
 * - **The stop and the run** are judged as the count judges them, and **the count closes the staged set**: after the count's record, and for a stop Ops let through without photos, nothing
 *   is staged (`STATE_CONFLICT`, rules `collection_recorded` and `parcel_photo_exception`).
 * - **The count** attaches the staged photos and the named ones together (`staged + named = collected_count`), answers how many (`parcel_photo_count`) and the ones it named
 *   (`parcel_photo_ids`), refuses a photo both staged and named (`duplicate`) and any other number (`parcel_photo_count`), and a refused count leaves the staged set as it was.
 * - **The database holds the staged set for every writer** (`melarc.collection_parcel_photo_staged_guard`): never changed or removed, only for a stop that may still be counted, only a photo
 *   that may still be counted, and only the rider's own to read and write.
 * - **A collection of any size** (3,000 parcels in six batches and one small count): the old limit was the 2,624 identifiers one body could name.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let ops: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const STOP = (id: string) => `${API}/pickup-stops/${id}`;
const COLLECT = (id: string) => `${STOP(id)}/collect`;
const STAGE = (id: string) => `${STOP(id)}/parcel-photos`;
const EXCEPTION = (id: string) => `${STOP(id)}/parcel-photo-exception`;
const CONFIRM = 'pickup.collection.confirm';
const SHORT = { collected_count: 2, variance_reason_code: 'SOME_PARCELS_NOT_READY' } as const;

const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];
const ruleOf = (response: TestResponse): string | undefined =>
  (response.json() as { details?: { rule?: string } }).details?.rule;
const violationsOf = (response: TestResponse): { in: string; pointer: string; rule: string }[] =>
  (
    response.json() as {
      details?: { violations?: { in: string; pointer: string; rule: string }[] };
    }
  ).details?.violations ?? [];

/** A run in progress with two stops the rider has arrived at; each declares three packages (or as many as `packages` says). */
const run = (packages?: readonly number[]): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 2,
    stopStates: ['ARRIVED', 'ARRIVED'],
    ...(packages === undefined ? {} : { packages }),
  });
const stopAt = (arranged: ArrangedRun, index = 0): ArrangedRun['stops'][number] => {
  const stop = arranged.stops[index];
  if (stop === undefined) throw new Error('stop');
  return stop;
};

/** One batch of `stageParcelPhotos`, as the rider sends it. */
const stage = (
  rider: ArrangedRider,
  stopId: string,
  ids: readonly unknown[],
  key: string = randomUUID(),
): Promise<TestResponse> =>
  rider.client.post(
    STAGE(stopId),
    { parcel_photo_ids: ids },
    { headers: { 'Idempotency-Key': key } },
  );

/** The count of a stop, as the rider makes it, with whatever the test names. */
async function collect(
  rider: ArrangedRider,
  stopId: string,
  body: Record<string, unknown>,
  key: string = randomUUID(),
): Promise<TestResponse> {
  const etag = (await rider.client.get(STOP(stopId))).header('etag') ?? '';
  return rider.client.post(COLLECT(stopId), body, {
    headers: { 'If-Match': etag, 'Idempotency-Key': key },
  });
}

const authorise = (stopId: string): Promise<TestResponse> =>
  ops.client.post(
    EXCEPTION(stopId),
    { note: 'The camera does not work' },
    { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
  );

interface StagedRow {
  evidence_id: string;
  pickup_stop_id: string;
  responsible_hub_id: string;
  staged_by_rider: string;
  staged_at: Date;
}
const stagedOf = (stopId: string) =>
  routes.rows<StagedRow>(
    `select evidence_id, pickup_stop_id, responsible_hub_id, staged_by_rider, staged_at
       from collection_parcel_photo_staged where pickup_stop_id = $1 order by evidence_id`,
    [stopId],
  );
const stagedIdsOf = async (stopId: string): Promise<string[]> =>
  (await stagedOf(stopId)).map((row) => row.evidence_id);
const sorted = (ids: readonly string[]): string[] => [...ids].toSorted();

const recordsOf = (stopId: string) =>
  routes.rows<{ id: string; collected_count: number; variance: string }>(
    `select id, collected_count, variance from collection_record where pickup_stop_id = $1`,
    [stopId],
  );
const linksOf = (stopId: string) =>
  routes.rows<{
    evidence_id: string;
    collection_record_id: string;
    pickup_stop_id: string;
    responsible_hub_id: string;
    attached_by_rider: string;
    attached_at: Date;
  }>(`select * from collection_parcel_photo where pickup_stop_id = $1 order by evidence_id`, [
    stopId,
  ]);
const countEventsOf = (stopId: string) =>
  routes.rows<{ event_code: string }>(
    `select event_code from audit_event
      where event_code in ('pickup.collection.recorded', 'pickup.stop.collected', 'pickup.stop.partially_collected')
        and (object_id::text = $1 or related_ids ->> 'pickup_stop_id' = $1) order by event_code`,
    [stopId],
  );

/** Changes a stored fact of an evidence record, which the record's guard forbids to every writer: the guard and the version trigger are put aside for the one statement. */
async function arrangeEvidence(id: string, assignments: string): Promise<void> {
  await routes.admin.query('alter table evidence disable trigger evidence_guard');
  await routes.admin.query('alter table evidence disable trigger evidence_version');
  try {
    await routes.admin.query(`update evidence set ${assignments} where id = $1`, [id]);
  } finally {
    await routes.admin.query('alter table evidence enable trigger evidence_version');
    await routes.admin.query('alter table evidence enable trigger evidence_guard');
  }
}

/**
 * `count` stored `PARCEL_PHOTO` records of a stop, captured by the rider, made by one statement with the guards put aside (`session_replication_role = replica`, as the other
 * tests arrange a record the operations would make slowly): the columns are the ones the operations give a stored photo. For the tests of a collection too large to be photographed
 * through the HTTP stack one record at a time, and for a stop the evidence operations would not declare a record for (a run that is over).
 */
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
      [stopId, riderId, HUB_A, vendorA.row.organizationId, count],
    );
    await routes.admin.query('commit');
    return made.rows.map((row) => row.id);
  } catch (error) {
    await routes.admin.query('rollback').catch(() => undefined);
    throw error;
  }
}

/** What the database refused, as the guards state it: the SQLSTATE, the reason (DETAIL) and the rule (HINT); `null` when nothing was refused. */
interface Refusal {
  readonly code: string | undefined;
  readonly detail: string | undefined;
  readonly hint: string | undefined;
}
async function refusedAs(work: () => Promise<unknown>): Promise<Refusal | null> {
  try {
    await work();
    return null;
  } catch (error) {
    const server = serverErrorIn(error);
    return { code: server?.code, detail: server?.detail, hint: server?.hint };
  }
}

const riderContext = (riderId: string, key: string = CONFIRM): SecurityContext => ({
  principalType: 'RIDER',
  principalId: riderId,
  sessionId: randomUUID(),
  surface: 'RIDER_ANDROID',
  riderId,
  authorizationKey: key,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'staged-parcel-photos',
});
const staffContext = (key: string): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  sessionId: randomUUID(),
  surface: 'OPS_PORTAL',
  authorizationKey: key,
  hubScopeMode: 'ALL',
  authorizedHubIds: [],
  correlationId: 'staged-parcel-photos',
});
const vendorContext = (key: string): SecurityContext => ({
  principalType: 'VENDOR',
  principalId: vendorA.row.accountId,
  sessionId: randomUUID(),
  surface: 'VENDOR_PWA',
  authorizationKey: key,
  vendorOrganizationId: vendorA.row.organizationId,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'staged-parcel-photos',
});

/** The rows a statement returns as a context (the runtime login, which row-level security applies to), or the refusal the database gave it. */
async function asContext(
  context: SecurityContext,
  text: string,
): Promise<{ readonly rows: unknown[] } | { readonly refusal: Refusal }> {
  try {
    const rows = await routes.built.service.transactionWithContext(
      context,
      async (tx) => (await tx.execute(sql.raw(text))).rows,
    );
    return { rows };
  } catch (error) {
    const server = serverErrorIn(error);
    return { refusal: { code: server?.code, detail: server?.detail, hint: server?.hint } };
  }
}

describe('stageParcelPhotos: a batch is put aside for the count that is not yet made', () => {
  // Break caught: a batch that stages nothing, answers a list or a wrong number, takes the stop, the hub, the rider or the moment from the writer, or touches the count, the photos or the link table.
  it('stages the batch, answers how many are staged and nothing else, and the database derives the stop, the hub, the rider and the moment of each row', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);

    const sentAt = Date.now();
    const response = await stage(arranged.rider, stop.id, photos);
    const answeredAt = Date.now();

    expect(response.status, response.text).toBe(200);
    expect(response.json()).toEqual({ pickup_stop_id: stop.id, staged_count: 2 });
    const rows = await stagedOf(stop.id);
    expect(sorted(rows.map((row) => row.evidence_id))).toEqual(sorted(photos));
    for (const row of rows) {
      expect(row).toMatchObject({
        pickup_stop_id: stop.id,
        responsible_hub_id: HUB_A,
        staged_by_rider: arranged.rider.id,
      });
      // The moment is the database's own, taken during the call.
      expect(row.staged_at.getTime()).toBeGreaterThanOrEqual(sentAt - 2000);
      expect(row.staged_at.getTime()).toBeLessThanOrEqual(answeredAt + 2000);
    }
    // Staging is no count: no record, no link, no event, and the photos are untouched.
    expect(await recordsOf(stop.id)).toEqual([]);
    expect(await linksOf(stop.id)).toEqual([]);
    expect(await countEventsOf(stop.id)).toEqual([]);
    const states = await routes.rows<{ state: string }>(
      `select state from evidence where id = any($1::uuid[])`,
      [photos],
    );
    expect(states.map((each) => each.state)).toEqual(['STORED', 'STORED']);
  });

  // Break caught: a second batch that replaces the first (the answer or the rows), or an answer that counts the batch and not the stop's staged set.
  it('accumulates: a second batch adds to the first, and the answer is the stop’s total; another stop’s staged photos are not counted', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const other = stopAt(arranged, 1);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 3);
    const elsewhere = await parcelPhotosOf(routes, arranged.rider, other.id, 1);

    expect((await stage(arranged.rider, other.id, elsewhere)).json()).toEqual({
      pickup_stop_id: other.id,
      staged_count: 1,
    });
    const first = await stage(arranged.rider, stop.id, photos.slice(0, 2));
    expect(first.json()).toEqual({ pickup_stop_id: stop.id, staged_count: 2 });
    const second = await stage(arranged.rider, stop.id, photos.slice(2));
    expect(second.json()).toEqual({ pickup_stop_id: stop.id, staged_count: 3 });
    expect(sorted(await stagedIdsOf(stop.id))).toEqual(sorted(photos));
    expect(await stagedIdsOf(other.id)).toEqual(elsewhere);
  });

  // Break caught: a photo staged twice that is an error, a second row or a changed row; an overlapping batch that is refused or that stages the photo again.
  it('is a no-op to stage a photo again, under another key or inside an overlapping batch: the set stays and the rows are never changed', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const [a, b, c] = await parcelPhotosOf(routes, arranged.rider, stop.id, 3);
    if (a === undefined || b === undefined || c === undefined) throw new Error('photos');

    expect((await stage(arranged.rider, stop.id, [a, b])).json()).toMatchObject({
      staged_count: 2,
    });
    const before = await stagedOf(stop.id);

    const again = await stage(arranged.rider, stop.id, [a, b], randomUUID());
    expect(again.status, again.text).toBe(200);
    expect(again.json()).toEqual({ pickup_stop_id: stop.id, staged_count: 2 });
    expect(await stagedOf(stop.id)).toEqual(before);

    const overlapping = await stage(arranged.rider, stop.id, [b, c], randomUUID());
    expect(overlapping.json()).toEqual({ pickup_stop_id: stop.id, staged_count: 3 });
    const after = await stagedOf(stop.id);
    expect(after).toHaveLength(3);
    // The rows of the first batch are as they were staged: the moment included.
    for (const row of before) expect(after).toContainEqual(row);
  });

  // Break caught: a replay that runs the batch again (and answers the stop's count as it is now), or another body under the same key accepted.
  it('replays the stored answer under the same key, and another batch under that key is a conflict', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const [a, b, c] = await parcelPhotosOf(routes, arranged.rider, stop.id, 3);
    if (a === undefined || b === undefined || c === undefined) throw new Error('photos');
    const key = randomUUID();

    const first = await stage(arranged.rider, stop.id, [a, b], key);
    expect(first.json()).toEqual({ pickup_stop_id: stop.id, staged_count: 2 });
    expect((await stage(arranged.rider, stop.id, [c])).json()).toMatchObject({ staged_count: 3 });

    // The answer of the first call as it was, not the count as it is now.
    const replayed = await stage(arranged.rider, stop.id, [a, b], key);
    expect(replayed.status, replayed.text).toBe(200);
    expect(replayed.json()).toEqual(first.json());
    expect(await stagedOf(stop.id)).toHaveLength(3);

    expect(outcome(await stage(arranged.rider, stop.id, [a], key))).toEqual([
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
    ]);
    expect(await stagedOf(stop.id)).toHaveLength(3);
  });

  // Break caught: an operation that needs no key, so that a retry cannot be told from a new batch.
  it('needs an Idempotency-Key, and a key that is not one is refused', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const [a] = await parcelPhotosOf(routes, arranged.rider, stop.id, 1);
    const none = await arranged.rider.client.post(STAGE(stop.id), { parcel_photo_ids: [a] });
    expect(outcome(none)).toEqual([400, 'VALIDATION_FAILED']);
    expect(outcome(await stage(arranged.rider, stop.id, [a], 'k'.repeat(129)))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect(await stagedOf(stop.id)).toEqual([]);
  });

  // Break caught: a batch of 501, none, an id twice or an id that is not one let through, or a refusal that stages the part of the batch it could read.
  it.each([
    ['501 identifiers', () => Array.from({ length: 501 }, () => randomUUID())],
    ['no identifier', () => []],
    ['a text that is not an identifier', () => [randomUUID(), 'not-a-uuid']],
    ['a number', () => [randomUUID(), 7]],
  ] as const)('refuses %s, with VALIDATION_FAILED, and stages nothing', async (_what, ids) => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const response = await stage(arranged.rider, stop.id, ids());
    expect(outcome(response)).toEqual([400, 'VALIDATION_FAILED']);
    expect(await stagedOf(stop.id)).toEqual([]);
  });

  it('refuses an identifier named twice in a batch, with the rule duplicate, and stages nothing of it', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const [a, b] = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);
    const response = await stage(arranged.rider, stop.id, [a, b, a]);
    expect(outcome(response)).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(response)).toEqual([
      { in: 'body', pointer: '/parcel_photo_ids', rule: 'duplicate' },
    ]);
    expect(await stagedOf(stop.id)).toEqual([]);
    // A body that is not the schema's (no list, a member the schema does not know) is refused as well.
    for (const body of [{}, { parcel_photo_ids: a }, { parcel_photo_ids: [a], extra: 1 }]) {
      const refused = await arranged.rider.client.post(STAGE(stop.id), body, {
        headers: { 'Idempotency-Key': randomUUID() },
      });
      expect(outcome(refused), JSON.stringify(body)).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(await stagedOf(stop.id)).toEqual([]);
  });
});

describe('stageParcelPhotos: only a photo that can still be counted is staged, and the refusal is one answer', () => {
  type Bad = (arranged: ArrangedRun, stopId: string) => Promise<string>;
  const cases: readonly (readonly [string, Bad])[] = [
    [
      'a photo still pending its upload',
      async (arranged, stopId) =>
        (
          await photoOf(routes, arranged.rider, stopId, {
            purpose: 'PARCEL_PHOTO',
            complete: false,
          })
        ).id,
    ],
    [
      'a photo whose window ran out',
      async (arranged, stopId) => {
        const id = (await photoOf(routes, arranged.rider, stopId, { purpose: 'PARCEL_PHOTO' })).id;
        await arrangeEvidence(
          id,
          `state = 'EXPIRED', uploaded_at = null, validated_signature = null, scanner = null, scanner_signature_version = null, scanned_at = null`,
        );
        return id;
      },
    ],
    [
      "another rider's photo",
      async (arranged, stopId) => {
        const id = (await photoOf(routes, arranged.rider, stopId, { purpose: 'PARCEL_PHOTO' })).id;
        const other = await arrangedRider(routes.kit, routes.admin);
        await arrangeEvidence(id, `captured_by_actor = '${other.id}'`);
        return id;
      },
    ],
    [
      "another stop's photo",
      async (arranged) =>
        (
          await photoOf(routes, arranged.rider, stopAt(arranged, 1).id, {
            purpose: 'PARCEL_PHOTO',
          })
        ).id,
    ],
    [
      'the proof of a collection, which is not a parcel',
      async (arranged, stopId) => (await photoOf(routes, arranged.rider, stopId)).id,
    ],
    ['a record that does not exist', () => Promise.resolve(randomUUID())],
    [
      'a photo already attached to a count',
      async (arranged, stopId) => {
        const id = (await photoOf(routes, arranged.rider, stopId, { purpose: 'PARCEL_PHOTO' })).id;
        // Attached elsewhere: the count of the run's other stop (let through without photos so that it can be made), then the link made with the guards off.
        const other = stopAt(arranged, 1);
        await excusePhotos(routes, other.id);
        const counted = await collect(arranged.rider, other.id, { collected_count: 3 });
        expect(counted.status, counted.text).toBe(200);
        const [record] = await recordsOf(other.id);
        await routes.admin.query('begin');
        try {
          await routes.admin.query('set local session_replication_role = replica');
          await routes.admin.query(
            `insert into collection_parcel_photo (evidence_id, collection_record_id, pickup_stop_id, responsible_hub_id, attached_by_rider, attached_at)
             values ($1, $2, $3, $4, $5, now())`,
            [id, record?.id, other.id, HUB_A, arranged.rider.id],
          );
          await routes.admin.query('commit');
        } catch (error) {
          await routes.admin.query('rollback').catch(() => undefined);
          throw error;
        }
        return id;
      },
    ],
  ];

  // Break caught: a photo that cannot be counted staged (a pending one, an expired one, a stranger's, another stop's, the proof of a failure, one counted already), a refusal that stages the
  // good photos of the batch, or an answer that tells a rider about a record that is not its own (each refusal is the one EVIDENCE_NOT_STORED).
  it.each(cases)(
    'refuses a batch with %s, with the one answer EVIDENCE_NOT_STORED, and stages none of it',
    async (_name, bad) => {
      const arranged = await run();
      const stop = stopAt(arranged);
      const good = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);
      const unusable = await bad(arranged, stop.id);

      const response = await stage(arranged.rider, stop.id, [...good, unusable]);

      expect(outcome(response)).toEqual([422, 'EVIDENCE_NOT_STORED']);
      expect((response.json() as { message: string }).message).toBe(
        'A referenced evidence record is not stored',
      );
      expect(await stagedOf(stop.id)).toEqual([]);
      // The good photos are still good: the batch without the unusable one is staged.
      const staged = await stage(arranged.rider, stop.id, good);
      expect(staged.json()).toEqual({ pickup_stop_id: stop.id, staged_count: 2 });
    },
  );
});

describe('stageParcelPhotos: the stop, the run and the count close the staged set', () => {
  // Break caught: a batch accepted for a stop that is not the rider's, one that does not exist (told apart from the first), or by a caller that is not a rider.
  it('is the assigned rider’s: another rider and a stop that does not exist are one answer, and an officer and a caller with no session never reach it', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const [a] = await parcelPhotosOf(routes, arranged.rider, stop.id, 1);
    const other = await arrangedRider(routes.kit, routes.admin);

    expect(outcome(await stage(other, stop.id, [a]))).toEqual([422, 'NOT_ASSIGNED_RIDER']);
    expect(outcome(await stage(arranged.rider, randomUUID(), [a]))).toEqual([
      422,
      'NOT_ASSIGNED_RIDER',
    ]);
    const asOps = await ops.client.post(
      STAGE(stop.id),
      { parcel_photo_ids: [a] },
      { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
    );
    expect(asOps.status).toBeGreaterThanOrEqual(401);
    const anonymous = await routes.kit.client.post(
      STAGE(stop.id),
      { parcel_photo_ids: [a] },
      { headers: { 'Idempotency-Key': randomUUID() } },
    );
    expect(anonymous.status).toBe(401);
    expect(await stagedOf(stop.id)).toEqual([]);
  });

  // Break caught: a batch staged for a stop not yet arrived at or already worked, for a run not started or over, each told apart as the count tells them.
  it('refuses a stop not arrived at, a stop already worked, a run not started and a run that is over, with the answers of the count', async () => {
    // The stop and the run are judged before the photos, so the identifiers need not be photos of anything.
    const decoy = [randomUUID()];
    const early = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendorA.row.organizationId,
      serviceDate: days.today,
      state: 'IN_PROGRESS',
      stops: 2,
      stopStates: ['PENDING', 'SKIPPED'],
    });
    const notArrived = await stage(early.rider, stopAt(early).id, decoy);
    expect(outcome(notArrived)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(notArrived)).toBe('stop_not_arrived');
    const worked = await stage(early.rider, stopAt(early, 1).id, decoy);
    expect(outcome(worked)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(worked)).toBe('stop_resolved');

    const dispatched = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendorA.row.organizationId,
      serviceDate: days.today,
      state: 'DISPATCHED',
      stops: 1,
      stopStates: ['PENDING'],
    });
    expect(outcome(await stage(dispatched.rider, stopAt(dispatched).id, decoy))).toEqual([
      422,
      'MANIFEST_NOT_STARTED',
    ]);

    const over = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendorA.row.organizationId,
      serviceDate: days.today,
      state: 'COMPLETED',
      stops: 1,
      stopStates: ['ARRIVED'],
    });
    const finished = await stage(over.rider, stopAt(over).id, decoy);
    expect(outcome(finished)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(finished)).toBe('run_not_in_progress');

    for (const each of [early, dispatched, over]) {
      for (const stop of each.stops) expect(await stagedOf(stop.id)).toEqual([]);
    }
  });

  // Break caught: a stop Ops let through without photos that is still staged for, so that the set grows for a count that takes none.
  it('refuses a batch for a stop Ops let through without photos, with the rule parcel_photo_exception, and stages nothing', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);
    expect((await authorise(stop.id)).status).toBe(200);

    const response = await stage(arranged.rider, stop.id, photos);

    expect(outcome(response)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(response)).toBe('parcel_photo_exception');
    expect(await stagedOf(stop.id)).toEqual([]);
  });

  // Break caught: the staged set open after the count (a photo staged for a count that is made, which nothing would ever attach), or a refusal that changes the set.
  it('refuses a batch once the stop has its count, with the rule collection_recorded, and the staged set is as the count left it', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 3);
    expect((await stage(arranged.rider, stop.id, photos)).status).toBe(200);
    expect((await collect(arranged.rider, stop.id, { collected_count: 3 })).status).toBe(200);
    const before = await stagedOf(stop.id);
    expect(before).toHaveLength(3);

    const [late] = await parcelPhotosOf(routes, arranged.rider, stop.id, 1);
    const response = await stage(arranged.rider, stop.id, [late]);

    expect(outcome(response)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(response)).toBe('collection_recorded');
    expect(await stagedOf(stop.id)).toEqual(before);
    // The same refusal for the photos already staged: nothing is put aside twice for a stop that is counted.
    expect(ruleOf(await stage(arranged.rider, stop.id, photos))).toBe('collection_recorded');
  });
});

describe('recordCollection: the staged photos and the named ones make the count (D-E1)', () => {
  // Break caught: a count that ignores the staged photos, attaches them twice or to the wrong count, lists them in the answer, leaves the count of them out, or lets the writer choose the stop,
  // the hub, the rider or the moment of a link; the staged rows changed or removed by being counted.
  it('records a count whose every photo was staged, naming none: the answer says how many, the links are the staged photos, and the staged rows stay as they were', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 3);
    for (const photo of photos)
      expect((await stage(arranged.rider, stop.id, [photo])).status).toBe(200);
    const stagedBefore = await stagedOf(stop.id);

    const sentAt = Date.now();
    const response = await collect(arranged.rider, stop.id, { collected_count: 3 });
    expect(response.status, response.text).toBe(200);
    const answeredAt = Date.now();

    const [record, ...more] = await recordsOf(stop.id);
    expect(more).toEqual([]);
    expect(record).toMatchObject({ collected_count: 3, variance: 'MATCH' });
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      id: record?.id,
      pickup_stop_id: stop.id,
      collected_count: 3,
      parcel_photo_count: 3,
    });
    // The photos the request named are listed and the ones it did not are not: it named none, so the member is absent and is not an empty list.
    expect(Object.keys(body).toSorted()).toEqual(
      [
        'collected_count',
        'declared_count',
        'id',
        'office_notified_at',
        'parcel_photo_count',
        'pickup_stop_id',
        'variance',
      ].toSorted(),
    );

    const links = await linksOf(stop.id);
    expect(links.map((link) => link.evidence_id)).toEqual(sorted(photos));
    for (const link of links) {
      expect(link).toMatchObject({
        collection_record_id: record?.id,
        pickup_stop_id: stop.id,
        responsible_hub_id: HUB_A,
        attached_by_rider: arranged.rider.id,
      });
      expect(link.attached_at.getTime()).toBeGreaterThanOrEqual(sentAt - 2000);
      expect(link.attached_at.getTime()).toBeLessThanOrEqual(answeredAt + 2000);
    }
    // Staged rows are never changed or removed, by the count either.
    expect(await stagedOf(stop.id)).toEqual(stagedBefore);
    const states = await routes.rows<{ state: string }>(
      `select state from evidence where id = any($1::uuid[])`,
      [photos],
    );
    expect(states.map((each) => each.state)).toEqual(['STORED', 'STORED', 'STORED']);
  });

  // Break caught: a count that takes only the named photos or only the staged ones, an answer that lists the staged photos beside the named ones, a count of photos that is not the total, or a
  // staged photo of another stop taken into this count.
  it('records a count of staged and named photos together: the answer lists the named ones in the order named, counts all, and another stop’s staged photo is left alone', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const other = stopAt(arranged, 1);
    const staged = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);
    const [named] = await parcelPhotosOf(routes, arranged.rider, stop.id, 1);
    const [elsewhere] = await parcelPhotosOf(routes, arranged.rider, other.id, 1);
    if (named === undefined || elsewhere === undefined) throw new Error('photos');
    expect((await stage(arranged.rider, stop.id, staged)).status).toBe(200);
    expect((await stage(arranged.rider, other.id, [elsewhere])).status).toBe(200);

    const response = await collect(arranged.rider, stop.id, {
      collected_count: 3,
      parcel_photo_ids: [named],
    });

    expect(response.status, response.text).toBe(200);
    expect(response.json()).toMatchObject({
      pickup_stop_id: stop.id,
      collected_count: 3,
      parcel_photo_ids: [named],
      parcel_photo_count: 3,
    });
    expect((await linksOf(stop.id)).map((link) => link.evidence_id)).toEqual(
      sorted([...staged, named]),
    );
    // The other stop's staged photo is still staged and attached to nothing.
    expect(await stagedIdsOf(other.id)).toEqual([elsewhere]);
    expect(await linksOf(other.id)).toEqual([]);
  });

  // Break caught: the staged photos left out of the number (so that a count with all of them staged is refused), or a short count that takes the staged ones of the declared number.
  it('takes one photo for each parcel counted when the count is short, staged and named together', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const [a, b] = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);
    if (a === undefined || b === undefined) throw new Error('photos');
    expect((await stage(arranged.rider, stop.id, [a])).status).toBe(200);

    const response = await collect(arranged.rider, stop.id, { ...SHORT, parcel_photo_ids: [b] });

    expect(response.status, response.text).toBe(200);
    expect(response.json()).toMatchObject({ collected_count: 2, parcel_photo_count: 2 });
    expect(await recordsOf(stop.id)).toMatchObject([{ collected_count: 2, variance: 'SHORT' }]);
    expect((await linksOf(stop.id)).map((link) => link.evidence_id)).toEqual(sorted([a, b]));
  });

  // Break caught: a photo both staged and named counted twice (the number is right with one photo too few), or refused with another rule, or half attached.
  it('refuses a photo that is both staged and named, with the rule duplicate, and writes nothing', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const [a, b] = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);
    if (a === undefined || b === undefined) throw new Error('photos');
    expect((await stage(arranged.rider, stop.id, [a, b])).status).toBe(200);
    const before = await stagedOf(stop.id);

    // Two staged and the same photo named again makes three for a count of three: the number is right, the photo is counted twice.
    const response = await collect(arranged.rider, stop.id, {
      collected_count: 3,
      parcel_photo_ids: [b],
    });

    expect(outcome(response)).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(response)).toEqual([
      { in: 'body', pointer: '/parcel_photo_ids', rule: 'duplicate' },
    ]);
    expect(await recordsOf(stop.id)).toEqual([]);
    expect(await linksOf(stop.id)).toEqual([]);
    expect(await countEventsOf(stop.id)).toEqual([]);
    expect(await stagedOf(stop.id)).toEqual(before);
  });

  // Break caught: the number judged by the named photos alone, or by the staged ones alone, or left to the client; a refusal that changes the staged set or makes the record.
  it.each([
    // [what, photos made, staged of them (the first), named of them (the next), the count, the photos the right count names (from after the staged ones), the right count]
    [
      'fewer photos than parcels (staged only)',
      3,
      2,
      0,
      { collected_count: 3 },
      1,
      { collected_count: 3 },
    ],
    [
      'fewer photos than parcels (staged and named)',
      3,
      1,
      1,
      { collected_count: 3 },
      2,
      { collected_count: 3 },
    ],
    [
      'more photos than parcels (staged and named)',
      4,
      2,
      2,
      { collected_count: 3 },
      1,
      { collected_count: 3 },
    ],
    ['more staged photos than parcels counted', 3, 3, 0, { ...SHORT }, 0, { collected_count: 3 }],
    [
      'no photos at all for three parcels',
      3,
      0,
      0,
      { collected_count: 3 },
      3,
      { collected_count: 3 },
    ],
  ] as const)(
    'refuses a count with %s, with the rule parcel_photo_count, leaves the staged set as it was, and the right count then succeeds',
    async (_what, made, staged, named, body, rightNamed, rightBody) => {
      const arranged = await run();
      const stop = stopAt(arranged);
      const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, made);
      const stagedIds = photos.slice(0, staged);
      const namedIds = photos.slice(staged, staged + named);
      if (stagedIds.length > 0) {
        expect((await stage(arranged.rider, stop.id, stagedIds)).status).toBe(200);
      }
      const before = await stagedOf(stop.id);

      const refused = await collect(arranged.rider, stop.id, {
        ...body,
        ...(namedIds.length === 0 ? {} : { parcel_photo_ids: namedIds }),
      });

      expect(outcome(refused)).toEqual([400, 'VALIDATION_FAILED']);
      expect(violationsOf(refused)).toEqual([
        { in: 'body', pointer: '/parcel_photo_ids', rule: 'parcel_photo_count' },
      ]);
      expect(await recordsOf(stop.id)).toEqual([]);
      expect(await linksOf(stop.id)).toEqual([]);
      expect(await stagedOf(stop.id)).toEqual(before);

      // Fixing the number is all it takes: the staged photos are still there to be counted.
      const fixed = await collect(arranged.rider, stop.id, {
        ...rightBody,
        ...(rightNamed === 0
          ? {}
          : { parcel_photo_ids: photos.slice(staged, staged + rightNamed) }),
      });
      expect(fixed.status, fixed.text).toBe(200);
      expect(await recordsOf(stop.id)).toHaveLength(1);
      expect(await linksOf(stop.id)).toHaveLength(3);
      expect(await stagedOf(stop.id)).toEqual(before);
    },
  );

  // Break caught: the staged rows counted for a stop Ops let through without photos (a count with none refused for the photos it was never to take), or taken into it and attached.
  it('ignores the staged photos of a stop Ops let through without photos: the count takes none, and they stay staged and unattached', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);
    expect((await stage(arranged.rider, stop.id, photos)).status).toBe(200);
    const before = await stagedOf(stop.id);
    expect((await authorise(stop.id)).status).toBe(200);

    const response = await collect(arranged.rider, stop.id, { collected_count: 3 });

    expect(response.status, response.text).toBe(200);
    // The answer states no photos: neither member is there.
    expect(Object.keys(response.json() as object)).not.toContain('parcel_photo_ids');
    expect(Object.keys(response.json() as object)).not.toContain('parcel_photo_count');
    expect(await recordsOf(stop.id)).toHaveLength(1);
    expect(await linksOf(stop.id)).toEqual([]);
    expect(await stagedOf(stop.id)).toEqual(before);
  });

  // Break caught: a replay that runs the count again (a second set of links, a second record or event) or an answer that is not the original.
  it('replays the original answer under the same key, and makes no second record or link', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 3);
    expect((await stage(arranged.rider, stop.id, photos.slice(0, 2))).status).toBe(200);
    const key = randomUUID();
    const body = { collected_count: 3, parcel_photo_ids: photos.slice(2) };

    const first = await collect(arranged.rider, stop.id, body, key);
    expect(first.status, first.text).toBe(200);
    const again = await collect(arranged.rider, stop.id, body, key);
    expect(again.status, again.text).toBe(200);

    expect(again.json()).toEqual(first.json());
    expect(first.json()).toMatchObject({
      parcel_photo_ids: photos.slice(2),
      parcel_photo_count: 3,
    });
    expect(await recordsOf(stop.id)).toHaveLength(1);
    expect(await linksOf(stop.id)).toHaveLength(3);
    expect(await countEventsOf(stop.id)).toEqual([{ event_code: 'pickup.collection.recorded' }]);
  });

  // Break caught: the order of the refusals of the count changed by the staged photos: a short count with no reason is told its reason first, photos staged or not.
  it('judges the reason of a short count before its photos, whatever is staged', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);
    expect((await stage(arranged.rider, stop.id, photos)).status).toBe(200);
    const response = await collect(arranged.rider, stop.id, { collected_count: 2 });
    expect(outcome(response)).toEqual([422, 'REASON_REQUIRED']);
    const unknown = await collect(arranged.rider, stop.id, {
      collected_count: 2,
      variance_reason_code: 'NO_SUCH_REASON',
    });
    expect(outcome(unknown)).toEqual([422, 'REASON_NOT_ACTIVE']);
    expect(await recordsOf(stop.id)).toEqual([]);
    expect(await stagedIdsOf(stop.id)).toEqual(sorted(photos));
  });

  /** A run in progress whose only stop is the rider's arrived stop for an individual sender's request, as `pickup-collection.db.test.ts` arranges one. */
  async function individualSendersRun() {
    const rider = await arrangedRider(routes.kit, routes.admin);
    const sender = await insertAdHocSender(routes.admin, { state: 'PROVISIONAL' });
    const manifest = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, {
        state: 'IN_PROGRESS',
        serviceDate: days.today,
        assignedRiderId: rider.id,
      }),
    );
    const request = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendorA.row.organizationId, HUB_A, {
        vendorOrganizationId: null,
        adHocSenderId: sender.id,
        intent: 'ADHOC_SENDER',
        state: 'CONFIRMED',
        serviceDate: days.today,
      }),
    );
    await routes.admin.query(`update pickup_request set rider_assigned = true where id = $1`, [
      request.id,
    ]);
    const stop = await insertStop(
      routes.admin,
      stopRow(manifest, request.id, 1, {
        state: 'ARRIVED',
        pickupSummary: {
          reference: request.code,
          sender_display_name: 'Ama Walk-in',
          declared_package_count: 3,
          resolved_pickup_location: { address: 'Fixture stall' },
          location_note: null,
          contact_phone: null,
        },
      }),
    );
    return { rider, sender, stop };
  }
  const senderState = (id: string) =>
    routes
      .rows<{ state: string }>(`select state from ad_hoc_sender where id = $1`, [id])
      .then((rows) => rows[0]?.state);
  const promotionsOf = (senderId: string) =>
    routes.rows(
      `select id from audit_event where event_code = 'pickup.sender.promoted' and object_id = $1`,
      [senderId],
    );

  // Break caught: the attachment of the staged photos kept when the rest of the act fails (links of a count that was not made, a promotion, an event), or a staged set that a failed count changed; a
  // retry that cannot make the count. The ledger refuses the count's own event, which comes after the photos are attached.
  it('leaves no record, link, promotion or event when the act fails after the photos were attached, keeps the staged set, and the same key then makes the count', async () => {
    const individual = await individualSendersRun();
    const photos = await parcelPhotosOf(routes, individual.rider, individual.stop.id, 3);
    expect((await stage(individual.rider, individual.stop.id, photos)).status).toBe(200);
    const before = await stagedOf(individual.stop.id);
    const key = randomUUID();
    const body = { collected_count: 3 };
    await routes.admin.query(`
      create function fixture_refuse_event() returns trigger language plpgsql as $$
      begin
        if new.event_code = 'pickup.collection.recorded' then raise exception 'fixture: the ledger refuses this event'; end if;
        return new;
      end $$`);
    await routes.admin.query(`
      create trigger fixture_refuse_event before insert on audit_event
        for each row execute function fixture_refuse_event()`);
    try {
      const refused = await collect(individual.rider, individual.stop.id, body, key);
      expect(refused.status).toBe(500);
      expect(await recordsOf(individual.stop.id)).toEqual([]);
      expect(await linksOf(individual.stop.id)).toEqual([]);
      expect(await senderState(individual.sender.id)).toBe('PROVISIONAL');
      expect(await promotionsOf(individual.sender.id)).toEqual([]);
      expect(await countEventsOf(individual.stop.id)).toEqual([]);
      expect(await stagedOf(individual.stop.id)).toEqual(before);
    } finally {
      await routes.admin.query(`drop trigger fixture_refuse_event on audit_event`);
      await routes.admin.query(`drop function fixture_refuse_event()`);
    }
    // Nothing was kept of the failed attempt, so this is a first attempt: the staged photos are still there to be counted.
    const retried = await collect(individual.rider, individual.stop.id, body, key);
    expect(retried.status, retried.text).toBe(200);
    expect(retried.json()).toMatchObject({ parcel_photo_count: 3 });
    expect(await recordsOf(individual.stop.id)).toHaveLength(1);
    expect(await linksOf(individual.stop.id)).toHaveLength(3);
    expect(await senderState(individual.sender.id)).toBe('REUSABLE');
    expect(await promotionsOf(individual.sender.id)).toHaveLength(1);
    expect(await stagedOf(individual.stop.id)).toEqual(before);
  });
});

describe('a collection of any size: 3,000 parcels staged in six batches and counted by one small request', () => {
  // Break caught: a limit on the pickup (the old one was the 2,624 identifiers one body could name), a batch of 500 refused, a count that needs the photos named again, an answer that lists them,
  // links that are not the staged photos or are not derived, and the order in which a count's photos are read.
  it('stages 3,000 photos in batches of 500 and counts them with a request and an answer of a few hundred bytes', async () => {
    const arranged = await run([3000, 3]);
    const stop = stopAt(arranged);
    const photos = await storedPhotos(arranged.rider.id, stop.id, 3000);
    expect(photos).toHaveLength(3000);

    for (let batch = 0; batch < 6; batch += 1) {
      const response = await stage(
        arranged.rider,
        stop.id,
        photos.slice(batch * 500, batch * 500 + 500),
      );
      expect(response.status, response.text).toBe(200);
      expect(response.json()).toEqual({
        pickup_stop_id: stop.id,
        staged_count: (batch + 1) * 500,
      });
    }
    expect(await stagedOf(stop.id)).toHaveLength(3000);
    expect(await recordsOf(stop.id)).toEqual([]);

    const request = { collected_count: 3000 };
    expect(JSON.stringify(request).length).toBeLessThan(200);
    const response = await collect(arranged.rider, stop.id, request);

    expect(response.status, response.text).toBe(200);
    expect(response.text.length).toBeLessThan(1000);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      pickup_stop_id: stop.id,
      declared_count: 3000,
      collected_count: 3000,
      variance: 'MATCH',
      parcel_photo_count: 3000,
    });
    expect(Object.keys(body)).not.toContain('parcel_photo_ids');

    const [record] = await recordsOf(stop.id);
    expect(record).toMatchObject({ id: body.id, collected_count: 3000 });
    const [totals] = await routes.rows<{
      links: number;
      distinct_links: number;
      staged_and_linked: number;
      wrong: number;
    }>(
      `select count(*)::int as links,
              count(distinct l.evidence_id)::int as distinct_links,
              count(s.evidence_id)::int as staged_and_linked,
              count(*) filter (where l.collection_record_id <> $2 or l.attached_by_rider <> $3 or l.responsible_hub_id <> $4 or l.pickup_stop_id <> $1)::int as wrong
         from collection_parcel_photo l left join collection_parcel_photo_staged s on s.evidence_id = l.evidence_id
        where l.pickup_stop_id = $1`,
      [stop.id, record?.id, arranged.rider.id, HUB_A],
    );
    expect(totals).toEqual({
      links: 3000,
      distinct_links: 3000,
      staged_and_linked: 3000,
      wrong: 0,
    });

    // The order is not significant (D-E3), and the moments are in milliseconds, so the order of the links read by (attached_at, evidence_id) is only the staging order up to a millisecond. What
    // holds is that the count attached the photos walking the staged set in its order (by the moment staged, then the identifier): the moments of attachment never go back along it.
    const along = await routes.rows<{ attached_at: Date }>(
      `select l.attached_at from collection_parcel_photo l join collection_parcel_photo_staged s on s.evidence_id = l.evidence_id
        where l.pickup_stop_id = $1 order by s.staged_at, s.evidence_id`,
      [stop.id],
    );
    expect(along).toHaveLength(3000);
    for (let at = 1; at < along.length; at += 1) {
      expect(along[at]?.attached_at.getTime() ?? 0).toBeGreaterThanOrEqual(
        along[at - 1]?.attached_at.getTime() ?? 0,
      );
    }
    expect(await stagedOf(stop.id)).toHaveLength(3000);
  }, 180_000);
});

describe('the database holds the staged set for every writer (migration 0108)', () => {
  const insertStaged = (evidenceId: string) =>
    routes.admin.query(`insert into collection_parcel_photo_staged (evidence_id) values ($1)`, [
      evidenceId,
    ]);

  // Break caught: a staged row that a writer can change (to move it to another stop or rider) or remove (to un-stage a photo), whoever writes.
  it('keeps a staged row as it was staged: never changed and never removed', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);
    expect((await stage(arranged.rider, stop.id, photos)).status).toBe(200);
    const before = await stagedOf(stop.id);

    expect(
      await refusedAs(() =>
        routes.admin.query(
          `update collection_parcel_photo_staged set staged_at = now() where evidence_id = $1`,
          [photos[0]],
        ),
      ),
    ).toMatchObject({ code: '23514' });
    expect(
      await refusedAs(() =>
        routes.admin.query(
          `update collection_parcel_photo_staged set pickup_stop_id = $2 where evidence_id = $1`,
          [photos[0], stopAt(arranged, 1).id],
        ),
      ),
    ).toMatchObject({ code: '23514' });
    expect(
      await refusedAs(() =>
        routes.admin.query(`delete from collection_parcel_photo_staged where evidence_id = $1`, [
          photos[0],
        ]),
      ),
    ).toMatchObject({ code: '23514' });
    expect(await stagedOf(stop.id)).toEqual(before);
  });

  // Break caught: the stop, the hub, the rider and the moment of a row taken from the writer, and a stop the writer names that is not the photo's.
  it('derives the stop, the hub, the rider and the moment of a row from the photo, whatever the writer names', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const other = stopAt(arranged, 1);
    const [photo] = await storedPhotos(arranged.rider.id, stop.id, 1);
    if (photo === undefined) throw new Error('photo');
    const stranger = await arrangedRider(routes.kit, routes.admin);

    await routes.admin.query(
      `insert into collection_parcel_photo_staged (evidence_id, pickup_stop_id, responsible_hub_id, staged_by_rider, staged_at)
       values ($1, $2, $3, $4, '2020-01-01T00:00:00Z')`,
      [photo, other.id, '00000000-0000-4000-8000-000000000001', stranger.id],
    );

    const [row] = await stagedOf(stop.id);
    expect(row).toMatchObject({
      evidence_id: photo,
      pickup_stop_id: stop.id,
      responsible_hub_id: HUB_A,
      staged_by_rider: arranged.rider.id,
    });
    expect(row?.staged_at.getUTCFullYear()).toBeGreaterThanOrEqual(2026);
    expect(await stagedOf(other.id)).toEqual([]);
  });

  // Break caught: a row staged for a stop whose count is made or that Ops let through without photos, whoever writes (the service's refusal held by the application alone).
  it('refuses a row for a stop that has its count and for a stop Ops let through without photos, with the reason and the rule', async () => {
    const counted = await run();
    const countedStop = stopAt(counted);
    const photos = await parcelPhotosOf(routes, counted.rider, countedStop.id, 3);
    const [late] = await parcelPhotosOf(routes, counted.rider, countedStop.id, 1);
    expect(
      (
        await collect(counted.rider, countedStop.id, {
          collected_count: 3,
          parcel_photo_ids: photos,
        })
      ).status,
    ).toBe(200);
    expect(await refusedAs(() => insertStaged(late ?? ''))).toEqual({
      code: '23514',
      detail: 'reason=STATE_CONFLICT',
      hint: 'rule=collection_recorded',
    });

    const excused = await run();
    const excusedStop = stopAt(excused);
    const [mine] = await parcelPhotosOf(routes, excused.rider, excusedStop.id, 1);
    await excusePhotos(routes, excusedStop.id);
    expect(await refusedAs(() => insertStaged(mine ?? ''))).toEqual({
      code: '23514',
      detail: 'reason=STATE_CONFLICT',
      hint: 'rule=parcel_photo_exception',
    });
    expect(await stagedOf(countedStop.id)).toEqual([]);
    expect(await stagedOf(excusedStop.id)).toEqual([]);
  });

  // Break caught: a row staged for a stop whose run is over or whose rider is not the photo's, which the count would then refuse to attach.
  it('refuses a row for a stop on a run that is over, and for a photo of a rider the run is not assigned to', async () => {
    const over = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendorA.row.organizationId,
      serviceDate: days.today,
      state: 'COMPLETED',
      stops: 1,
      stopStates: ['ARRIVED'],
    });
    const [photo] = await storedPhotos(over.rider.id, stopAt(over).id, 1);
    expect(await refusedAs(() => insertStaged(photo ?? ''))).toEqual({
      code: '23514',
      detail: 'reason=STATE_CONFLICT',
      hint: 'rule=stop_not_arrived',
    });

    const arranged = await run();
    const stop = stopAt(arranged);
    const stranger = await arrangedRider(routes.kit, routes.admin);
    const [theirs] = await storedPhotos(stranger.id, stop.id, 1);
    expect(await refusedAs(() => insertStaged(theirs ?? ''))).toEqual({
      code: '23514',
      detail: 'reason=STATE_CONFLICT',
      hint: 'rule=stop_not_arrived',
    });
    expect(await stagedOf(stopAt(over).id)).toEqual([]);
    expect(await stagedOf(stop.id)).toEqual([]);
  });

  // Break caught (found by mutating the guard, Run E): a row staged for a stop that is not ARRIVED, on a run that is still in progress and assigned to the rider (the one thing the run's own
  // state does not say): a stop not yet arrived at, and a stop already worked or skipped, which the service refuses before it asks and the database must refuse for every writer.
  it.each(['PENDING', 'SKIPPED', 'FAILED', 'COLLECTED'] as const)(
    'refuses a row for a stop that is %s on a run in progress, with the rule stop_not_arrived',
    async (state) => {
      const arranged = await arrangeRun(routes.kit, routes.admin, {
        vendorOrganizationId: vendorA.row.organizationId,
        serviceDate: days.today,
        state: 'IN_PROGRESS',
        stops: 1,
        stopStates: [state],
      });
      const stop = stopAt(arranged);
      const [photo] = await storedPhotos(arranged.rider.id, stop.id, 1);
      expect(await refusedAs(() => insertStaged(photo ?? ''))).toEqual({
        code: '23514',
        detail: 'reason=STATE_CONFLICT',
        hint: 'rule=stop_not_arrived',
      });
      expect(await stagedOf(stop.id)).toEqual([]);
    },
  );

  // Break caught: a photo staged that could not be attached (not stored, not a parcel's, not there, or one a count has attached): the same single reason for each.
  it('refuses a photo that is pending, expired, not a parcel’s, not there, or attached to a count, with the reason EVIDENCE_NOT_STORED', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const pending = (
      await photoOf(routes, arranged.rider, stop.id, { purpose: 'PARCEL_PHOTO', complete: false })
    ).id;
    const proof = (await photoOf(routes, arranged.rider, stop.id)).id;
    const [expired] = await parcelPhotosOf(routes, arranged.rider, stop.id, 1);
    await arrangeEvidence(
      expired ?? '',
      `state = 'EXPIRED', uploaded_at = null, validated_signature = null, scanner = null, scanner_signature_version = null, scanned_at = null`,
    );
    // A photo of this stop attached to the count of the run's other stop, with the guards off.
    const [attached] = await storedPhotos(arranged.rider.id, stop.id, 1);
    const other = stopAt(arranged, 1);
    await excusePhotos(routes, other.id);
    expect((await collect(arranged.rider, other.id, { collected_count: 3 })).status).toBe(200);
    const [record] = await recordsOf(other.id);
    await routes.admin.query('begin');
    try {
      await routes.admin.query('set local session_replication_role = replica');
      await routes.admin.query(
        `insert into collection_parcel_photo (evidence_id, collection_record_id, pickup_stop_id, responsible_hub_id, attached_by_rider, attached_at)
         values ($1, $2, $3, $4, $5, now())`,
        [attached, record?.id, other.id, HUB_A, arranged.rider.id],
      );
      await routes.admin.query('commit');
    } catch (error) {
      await routes.admin.query('rollback').catch(() => undefined);
      throw error;
    }

    for (const [name, id] of [
      ['pending', pending],
      ['the proof of a collection', proof],
      ['expired', expired],
      ['attached to a count', attached],
      ['not there', randomUUID()],
    ] as const) {
      expect(await refusedAs(() => insertStaged(id ?? '')), name).toEqual({
        code: '23514',
        detail: 'reason=EVIDENCE_NOT_STORED',
        hint: undefined,
      });
    }
    expect(await stagedOf(stop.id)).toEqual([]);
  });

  // Break caught: a staged row another rider (or staff, or a vendor) can read, a key other than the count's that reads or writes it, a column other than the photo's that the rider can name,
  // or a rider's right to change or remove what it staged.
  it('shows a staged row to the rider that staged it under the key of the count, to nobody else, and lets the rider name nothing but the photo', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const [first, second] = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);
    if (first === undefined || second === undefined) throw new Error('photos');
    expect((await stage(arranged.rider, stop.id, [first])).status).toBe(200);
    const stranger = await arrangedRider(routes.kit, routes.admin);
    const read = `select evidence_id from collection_parcel_photo_staged where pickup_stop_id = '${stop.id}'`;

    expect(await asContext(riderContext(arranged.rider.id), read)).toEqual({
      rows: [{ evidence_id: first }],
    });
    // The rows are there for the rider, and for nobody else.
    for (const [who, context] of [
      ['the rider under another key', riderContext(arranged.rider.id, 'pickup.run.execute')],
      ['another rider under the same key', riderContext(stranger.id)],
      ['staff under the key of the count', staffContext(CONFIRM)],
      ['staff under a read key', staffContext('pickup.read')],
      ['a vendor', vendorContext(CONFIRM)],
    ] as const) {
      expect(await asContext(context, read), who).toEqual({ rows: [] });
    }

    // The rider stages the photo and names nothing else: the other columns are the guard's.
    const named = await asContext(
      riderContext(arranged.rider.id),
      `insert into collection_parcel_photo_staged (evidence_id, staged_by_rider) values ('${second}', '${stranger.id}')`,
    );
    expect('refusal' in named && named.refusal.code).toBe('42501');
    // Nobody else writes one, and the rider changes and removes none.
    for (const [who, context] of [
      ['staff', staffContext(CONFIRM)],
      ['a vendor', vendorContext(CONFIRM)],
      ['another rider', riderContext(stranger.id)],
      ['the rider under another key', riderContext(arranged.rider.id, 'pickup.run.execute')],
    ] as const) {
      const written = await asContext(
        context,
        `insert into collection_parcel_photo_staged (evidence_id) values ('${second}')`,
      );
      expect(
        'refusal' in written && ['23514', '42501'].includes(written.refusal.code ?? ''),
        who,
      ).toBe(true);
    }
    for (const statement of [
      `update collection_parcel_photo_staged set staged_at = now() where evidence_id = '${first}'`,
      `delete from collection_parcel_photo_staged where evidence_id = '${first}'`,
    ]) {
      const changed = await asContext(riderContext(arranged.rider.id), statement);
      expect('refusal' in changed && changed.refusal.code, statement).toBe('42501');
    }
    expect(await stagedIdsOf(stop.id)).toEqual([first]);

    // And the rider's own insert, which is what the operation does, works.
    const own = await asContext(
      riderContext(arranged.rider.id),
      `insert into collection_parcel_photo_staged (evidence_id) values ('${second}') returning pickup_stop_id, staged_by_rider`,
    );
    expect(own).toEqual({
      rows: [{ pickup_stop_id: stop.id, staged_by_rider: arranged.rider.id }],
    });
    expect(sorted(await stagedIdsOf(stop.id))).toEqual(sorted([first, second]));
  });
});
