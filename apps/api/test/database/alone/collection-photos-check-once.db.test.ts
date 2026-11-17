// Runs alone: it writes 2,000 photos of one count in one transaction and reads the statistics counters of its own database's table, a weight and a measurement files beside it would disturb.
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../../src/platform/database/transaction-context.js';
import { parcelPhotosOf } from '../support/evidence-photo.js';
import { manifestDays, type ManifestDays } from '../support/manifest-days.js';
import { arrangeRun, type ArrangedRun } from '../support/runs.js';
import { seedHubConfiguration } from '../support/seeded.js';
import { HUB_A } from '../support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from '../support/vendor-routes.js';

/**
 * The deferred check of a count's photos (`melarc.collection_photos_check`), as migration `0108` restated it so that **a count is judged once in a transaction and not once for each of its
 * photos** (before it, a count of N photos cost N counts of N rows at the commit, which is quadratic: a collection of thousands of parcels could not be committed in the time the platform allows).
 *
 * - **It still refuses what it refused, for every writer** (the runtime login as the rider, and the administrator): too few photos, too many, none, a photo added to a count in a later
 *   transaction, a count judged early (`SET CONSTRAINTS ... IMMEDIATE`) that then takes one more photo in a later statement (the bypass the statement trigger
 *   `collection_parcel_photo_unchecked` closes: it puts the memory of the judgement back to empty on every statement that changes the photos), and every count of a transaction that makes
 *   several.
 * - **It judges once.** The measure is the number of rows the transaction reads of `collection_parcel_photo` (the statistics the server keeps of its own table, `seq_tup_read` and
 *   `idx_tup_read`), which a count of N photos judged N times would raise to about N squared and judged once raises to about N. A call counter is not the measure: the function is *called* for
 *   each of the photos, and the second and later calls return at its first lines. The measure is a count of rows and not a time, so that it holds on a machine of any speed.
 *
 * The runtime login's test that the check is judged as the system is `collection-photos-check.db.test.ts`; this file holds what the restatement of `0108` could have changed.
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

const CONFIRM = 'pickup.collection.confirm';
const COUNT_REFUSED = { code: '23514', constraint: 'collection_parcel_photo_count' } as const;

/** A run in progress with two stops the rider has arrived at, each declaring three packages unless `packages` says otherwise. */
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

const riderContext = (riderId: string): SecurityContext => ({
  principalType: 'RIDER',
  principalId: riderId,
  sessionId: randomUUID(),
  surface: 'RIDER_ANDROID',
  riderId,
  authorizationKey: CONFIRM,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'collection-photos-check-once',
});

/** A count that matches (`collected` of `collected` declared), as the rider's own counting key writes it. */
const insertCount = (stopId: string, riderId: string, id: string, collected = 3) =>
  `insert into collection_record (id, pickup_stop_id, responsible_hub_id, declared_count, collected_count, variance, variance_reason_snapshot,
                                  office_notified_at, handshake_type, recorded_by)
   values ('${id}'::uuid, '${stopId}'::uuid, '${HUB_A}'::uuid, ${String(collected)}, ${String(collected)}, 'MATCH', null, null,
           'VENDOR_ENTERED_RIDER_DISPLAYED', '${riderId}'::uuid)`;
const link = (evidenceId: string, recordId: string) =>
  `insert into collection_parcel_photo (evidence_id, collection_record_id) values ('${evidenceId}'::uuid, '${recordId}'::uuid)`;
const IMMEDIATE = 'set constraints all immediate';
const DEFERRED = 'set constraints all deferred';

const recordsOf = (stopId: string) =>
  routes.rows<{ id: string }>(`select id from collection_record where pickup_stop_id = $1`, [
    stopId,
  ]);
const linksOf = (stopId: string) =>
  routes.rows<{ evidence_id: string }>(
    `select evidence_id from collection_parcel_photo where pickup_stop_id = $1`,
    [stopId],
  );

interface Refusal {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
}

/** The writers of a count: the runtime login in the rider's context (row-level security applies), and the cluster administrator (it does not). */
const WRITERS = ['the rider (the runtime login)', 'the administrator'] as const;
type Writer = (typeof WRITERS)[number];

/** The statements as the writer runs them in one transaction, which commits when they are done: what is refused is refused by a statement or by the commit. */
async function write(
  writer: Writer,
  riderId: string,
  statements: readonly string[],
): Promise<Refusal | null> {
  if (writer === 'the administrator') {
    await routes.admin.query('begin');
    try {
      for (const statement of statements) await routes.admin.query(statement);
      await routes.admin.query('commit');
      return null;
    } catch (error) {
      await routes.admin.query('rollback').catch(() => undefined);
      const server = serverErrorIn(error);
      return { code: server?.code, constraint: server?.constraint };
    }
  }
  try {
    await routes.built.service.transactionWithContext(riderContext(riderId), async (tx) => {
      for (const statement of statements) await tx.execute(sql.raw(statement));
    });
    return null;
  } catch (error) {
    const server = serverErrorIn(error);
    return { code: server?.code, constraint: server?.constraint };
  }
}

/**
 * `count` stored `PARCEL_PHOTO` records of a stop, captured by the rider, made by one statement with the guards put aside (`session_replication_role = replica`): the columns are the ones the
 * operations give a stored photo. For a count too large to be photographed through the HTTP stack one record at a time.
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

interface Reads {
  readonly rows: number;
  readonly inserted: number;
}
/** What the server has counted so far of the reads and the inserts of the photo table, as the database keeps its statistics (flushed by the backend that did the work). */
async function readsOfPhotoTable(): Promise<Reads> {
  const [row] = await routes.rows<{ rows: string; inserted: string }>(
    `select (coalesce((select seq_tup_read from pg_stat_user_tables where relname = 'collection_parcel_photo'), 0)
             + coalesce((select sum(idx_tup_read) from pg_stat_user_indexes where relname = 'collection_parcel_photo'), 0))::text as rows,
            coalesce((select n_tup_ins from pg_stat_user_tables where relname = 'collection_parcel_photo'), 0)::text as inserted`,
  );
  return { rows: Number(row?.rows ?? 0), inserted: Number(row?.inserted ?? 0) };
}

/** The counters once the backend that wrote has flushed its statistics (it was asked to at its commit): they arrive together, so the inserts say when the reads have. */
async function readsOnceFlushed(since: Reads, inserts: number): Promise<Reads> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const now = await readsOfPhotoTable();
    if (now.inserted - since.inserted >= inserts) return now;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error('the statistics of the photo table were not flushed in ten seconds');
}

// The first test of the file, on purpose: the counters are the table's for the whole database, and every later test of this file writes photos.
describe('the check judges a count once in a transaction, not once for each of its photos', () => {
  const PHOTOS = 2000;

  // Break caught (the function of 0090, or one that remembers nothing): each of the 2,001 events judges the count by counting all its photos, so the transaction reads about 2,000 x 2,000 rows
  // of the table (4,000,000) and not about 2,000. The bounds are the judgement itself (at least once: a count of nothing read means the statistics were not counted, which fails here and
  // does not pass) and twenty times that (a few readings of the photos, none for each).
  it('reads the photos of a count about once when 2,000 of them are committed together, and keeps the count', async () => {
    const arranged = await run([PHOTOS, 3]);
    const stop = stopAt(arranged);
    const photos = await storedPhotos(arranged.rider.id, stop.id, PHOTOS);
    expect(photos).toHaveLength(PHOTOS);
    const recordId = randomUUID();
    const before = await readsOfPhotoTable();

    // The administrator's own session, which is asked to flush its statistics at its commit so that the counters are there to be read now and not after a rate limit of the server's.
    await routes.admin.query('begin');
    try {
      await routes.admin.query('select pg_stat_force_next_flush()');
      await routes.admin.query(insertCount(stop.id, arranged.rider.id, recordId, PHOTOS));
      await routes.admin.query(
        `insert into collection_parcel_photo (evidence_id, collection_record_id) select unnest($1::uuid[]), $2::uuid`,
        [photos, recordId],
      );
      await routes.admin.query('commit');
    } catch (error) {
      await routes.admin.query('rollback').catch(() => undefined);
      throw error;
    }

    const after = await readsOnceFlushed(before, PHOTOS);
    expect(after.inserted - before.inserted).toBe(PHOTOS);
    const read = after.rows - before.rows;
    expect(read).toBeGreaterThanOrEqual(PHOTOS);
    expect(read).toBeLessThan(20 * PHOTOS);
    // The count was judged and kept: its photos are its number.
    expect(await recordsOf(stop.id)).toHaveLength(1);
    expect(await linksOf(stop.id)).toHaveLength(PHOTOS);
  }, 180_000);
});

describe.each(WRITERS)('the check still refuses what it refused, for %s', (writer) => {
  // Break caught: a restated check that lets through a count with another number of photos than parcels, or refuses the right one, for either writer.
  it('keeps a count with exactly the photos of its parcels and refuses too few, too many and none, at the end of the transaction', async () => {
    for (const [made, kept] of [
      [3, true],
      [2, false],
      [4, false],
      [0, false],
    ] as const) {
      const arranged = await run();
      const stop = stopAt(arranged);
      const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, made);
      const id = randomUUID();

      const refusal = await write(writer, arranged.rider.id, [
        insertCount(stop.id, arranged.rider.id, id),
        ...photos.map((photo) => link(photo, id)),
      ]);

      expect(refusal, `${String(made)} photos for 3 parcels`).toEqual(kept ? null : COUNT_REFUSED);
      expect(await recordsOf(stop.id)).toHaveLength(kept ? 1 : 0);
      expect(await linksOf(stop.id)).toHaveLength(kept ? made : 0);
    }
  });

  // Break caught: the memory of a judgement kept beyond its transaction (a photo added to a count in a later transaction of the same connection passes because the count was judged before), or a
  // photo-only transaction that is not judged.
  it('refuses a photo added to a count in a later transaction, though the count was judged on the same connection before', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 4);
    const id = randomUUID();
    expect(
      await write(writer, arranged.rider.id, [
        insertCount(stop.id, arranged.rider.id, id),
        ...photos.slice(0, 3).map((photo) => link(photo, id)),
      ]),
    ).toBeNull();

    expect(await write(writer, arranged.rider.id, [link(photos[3] ?? '', id)])).toEqual(
      COUNT_REFUSED,
    );
    expect(await linksOf(stop.id)).toHaveLength(3);
  });

  // Break caught (the shortcut of the link guard, 0108): a photo staged for ANOTHER stop of the run, attached to this stop's count in the transaction that makes it. Taken as judged, its columns would
  // come from the staged row (the other stop) and the link would sit under the count of a stop it is not of, and the number of photos would be right. It is judged as 0088 judged it, and refused.
  it('does not take the shortcut for a photo staged for another stop: the link is refused by the guard, not by the number', async () => {
    // The first stop declares two parcels (the least a booking has), so that a count of two is the stop's own count and what is refused is the photo.
    const arranged = await run([2, 3]);
    const stop = stopAt(arranged);
    const other = stopAt(arranged, 1);
    const [theirs] = await storedPhotos(arranged.rider.id, other.id, 1);
    const [first, second] = await storedPhotos(arranged.rider.id, stop.id, 2);
    for (const staged of [theirs, first, second]) {
      await routes.admin.query(
        'insert into collection_parcel_photo_staged (evidence_id) values ($1)',
        [staged],
      );
    }
    const id = randomUUID();

    const refusal = await write(writer, arranged.rider.id, [
      insertCount(stop.id, arranged.rider.id, id, 2),
      link(theirs ?? '', id),
      link(first ?? '', id),
    ]);

    expect(refusal).toMatchObject({ code: '23514' });
    expect(refusal?.constraint).toBeUndefined();
    expect(await recordsOf(stop.id)).toEqual([]);
    expect(await linksOf(stop.id)).toEqual([]);
    expect(await linksOf(other.id)).toEqual([]);

    // The control: the two photos of this stop, staged, in the same transaction as the count, are kept.
    const own = randomUUID();
    expect(
      await write(writer, arranged.rider.id, [
        insertCount(stop.id, arranged.rider.id, own, 2),
        link(first ?? '', own),
        link(second ?? '', own),
      ]),
    ).toBeNull();
    expect(await linksOf(stop.id)).toHaveLength(2);
  });

  // Break caught (the setting believed alone, which any statement of a login can set): a photo added to the count of an EARLIER transaction, and the setting then put to that count before the commit
  // (the three reviewers of Run E found it), is kept with four photos for three parcels. The count's own row must be this transaction's for the shortcut to be taken.
  it('does not believe the setting alone: a photo added to a count of an earlier transaction is refused though the setting names the count', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 4);
    const id = randomUUID();
    expect(
      await write(writer, arranged.rider.id, [
        insertCount(stop.id, arranged.rider.id, id),
        ...photos.slice(0, 3).map((photo) => link(photo, id)),
      ]),
    ).toBeNull();

    expect(
      await write(writer, arranged.rider.id, [
        link(photos[3] ?? '', id),
        `select set_config('melarc.photos_checked', '${id}', true)`,
      ]),
    ).toEqual(COUNT_REFUSED);
    expect(await linksOf(stop.id)).toHaveLength(3);
  });

  // Break caught (the bypass the statement trigger closes: without it the memory of the first judgement stays and the photo of the later statement is never judged): a count judged by SET CONSTRAINTS ...
  // IMMEDIATE and then given one more photo by a later statement is kept with four photos for three parcels. The control is the same transaction without the extra photo, which is kept.
  it('judges the count again when a later statement adds a photo after SET CONSTRAINTS ... IMMEDIATE, deferred again or not', async () => {
    const control = await run();
    const controlStop = stopAt(control);
    const controlPhotos = await parcelPhotosOf(routes, control.rider, controlStop.id, 3);
    const controlId = randomUUID();
    expect(
      await write(writer, control.rider.id, [
        insertCount(controlStop.id, control.rider.id, controlId),
        ...controlPhotos.map((photo) => link(photo, controlId)),
        IMMEDIATE,
      ]),
    ).toBeNull();
    expect(await linksOf(controlStop.id)).toHaveLength(3);

    for (const [name, middle] of [
      ['constraints left immediate', [IMMEDIATE]],
      ['constraints deferred again', [IMMEDIATE, DEFERRED]],
    ] as const) {
      const arranged = await run();
      const stop = stopAt(arranged);
      const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 4);
      const id = randomUUID();

      const refusal = await write(writer, arranged.rider.id, [
        insertCount(stop.id, arranged.rider.id, id),
        ...photos.slice(0, 3).map((photo) => link(photo, id)),
        ...middle,
        link(photos[3] ?? '', id),
      ]);

      expect(refusal, name).toEqual(COUNT_REFUSED);
      expect(await recordsOf(stop.id), name).toEqual([]);
      expect(await linksOf(stop.id), name).toEqual([]);
    }
  });

  // Break caught: a check that remembers the one count it judged and takes the next count's photos for judged (a transaction of two counts that judges one), in either order.
  it('judges every count of a transaction: one right and one wrong is refused in either order, and two right are kept', async () => {
    for (const order of ['the wrong count last', 'the wrong count first'] as const) {
      const arranged = await run();
      const [right, wrong] = [stopAt(arranged), stopAt(arranged, 1)];
      const rightPhotos = await parcelPhotosOf(routes, arranged.rider, right.id, 3);
      const wrongPhotos = await parcelPhotosOf(routes, arranged.rider, wrong.id, 2);
      const [rightId, wrongId] = [randomUUID(), randomUUID()];
      const rightStatements = [
        insertCount(right.id, arranged.rider.id, rightId),
        ...rightPhotos.map((photo) => link(photo, rightId)),
      ];
      const wrongStatements = [
        insertCount(wrong.id, arranged.rider.id, wrongId),
        ...wrongPhotos.map((photo) => link(photo, wrongId)),
      ];

      const refusal = await write(
        writer,
        arranged.rider.id,
        order === 'the wrong count last'
          ? [...rightStatements, ...wrongStatements]
          : [...wrongStatements, ...rightStatements],
      );

      expect(refusal, order).toEqual(COUNT_REFUSED);
      expect(await recordsOf(right.id), order).toEqual([]);
      expect(await recordsOf(wrong.id), order).toEqual([]);
    }

    const both = await run();
    const [first, second] = [stopAt(both), stopAt(both, 1)];
    const firstPhotos = await parcelPhotosOf(routes, both.rider, first.id, 3);
    const secondPhotos = await parcelPhotosOf(routes, both.rider, second.id, 3);
    const [firstId, secondId] = [randomUUID(), randomUUID()];
    expect(
      await write(writer, both.rider.id, [
        insertCount(first.id, both.rider.id, firstId),
        ...firstPhotos.map((photo) => link(photo, firstId)),
        insertCount(second.id, both.rider.id, secondId),
        ...secondPhotos.map((photo) => link(photo, secondId)),
      ]),
    ).toBeNull();
    expect(await linksOf(first.id)).toHaveLength(3);
    expect(await linksOf(second.id)).toHaveLength(3);
  });

  // Break caught: a transaction that judges one count and then does not judge a photo added to another count that was kept earlier (the memory is of the count and not of the transaction).
  it('judges a photo added to an earlier count in a transaction that also makes and judges a count of its own', async () => {
    const arranged = await run();
    const [earlier, own] = [stopAt(arranged), stopAt(arranged, 1)];
    const earlierPhotos = await parcelPhotosOf(routes, arranged.rider, earlier.id, 4);
    const ownPhotos = await parcelPhotosOf(routes, arranged.rider, own.id, 3);
    const [earlierId, ownId] = [randomUUID(), randomUUID()];
    expect(
      await write(writer, arranged.rider.id, [
        insertCount(earlier.id, arranged.rider.id, earlierId),
        ...earlierPhotos.slice(0, 3).map((photo) => link(photo, earlierId)),
      ]),
    ).toBeNull();

    const refusal = await write(writer, arranged.rider.id, [
      insertCount(own.id, arranged.rider.id, ownId),
      ...ownPhotos.map((photo) => link(photo, ownId)),
      link(earlierPhotos[3] ?? '', earlierId),
    ]);

    expect(refusal).toEqual(COUNT_REFUSED);
    expect(await recordsOf(own.id)).toEqual([]);
    expect(await linksOf(earlier.id)).toHaveLength(3);
  });
});
