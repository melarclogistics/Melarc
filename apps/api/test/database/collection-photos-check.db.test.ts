import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { excusePhotos, parcelPhotosOf, photoOf } from './support/evidence-photo.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { HUB_A } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * The end-of-transaction check of a count's photos (`melarc.collection_photos_check`: the number of the parcel photos, and the photo a short count's reason asks for), judged **as the
 * system and not as whoever wrote** (Run B, Part 1, item 2 of the review of Run A2; migration `0090`). Written as the runtime login, which row-level security applies to: every "every
 * writer" test of `parcel-photos.db.test.ts` writes as the administrator, who bypasses it.
 *
 * Until `0090` the check ran with the caller's rights, so it read the count, its photos and the exception of its stop as the context in force **at the commit**, and:
 *
 * - it returned quietly when that context could not see the count (`NOT FOUND`), so a writer that changed its context before `COMMIT` kept a count with no photos (**named: the first
 *   test, which fails on 809817b**);
 * - it judged a good count by what that context could see, so a count Ops had let through without photos was refused when the context at the commit could not read the exception
 *   (**the second test, which fails on 809817b**: the count is made under the key that counts, and the context at the commit is one that can read the count and not the exception).
 *
 * The check now asserts its own context for its own statements (the capability `collection_photo_check`, which no application context is opened under and no policy admits but to a
 * statement that runs as the owner), and restores the caller's context before it returns.
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

const riderContext = (riderId: string): SecurityContext => ({
  principalType: 'RIDER',
  principalId: riderId,
  sessionId: randomUUID(),
  surface: 'RIDER_ANDROID',
  riderId,
  authorizationKey: CONFIRM,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'collection-photos-check',
});

/** A count that matches (three of the three declared), as the rider's own counting key writes it. */
const insertCount = (stopId: string, riderId: string, id: string = randomUUID()) =>
  `insert into collection_record (id, pickup_stop_id, responsible_hub_id, declared_count, collected_count, variance, variance_reason_snapshot,
                                  office_notified_at, handshake_type, recorded_by)
   values ('${id}'::uuid, '${stopId}'::uuid, '${HUB_A}'::uuid, 3, 3, 'MATCH', null, null,
           'VENDOR_ENTERED_RIDER_DISPLAYED', '${riderId}'::uuid)`;
const link = (evidenceId: string, recordId: string) =>
  `insert into collection_parcel_photo (evidence_id, collection_record_id) values ('${evidenceId}'::uuid, '${recordId}'::uuid)`;
const setting = (name: string, value: string) =>
  `select pg_catalog.set_config('${name}', '${value}', true)`;

const recordsOf = (stopId: string) =>
  routes.rows<{ id: string }>(`select id from collection_record where pickup_stop_id = $1`, [
    stopId,
  ]);

/** The statements as the rider runs them in one transaction, which commits when they are done: what is refused at the end of it is the commit's. */
async function asTheRider(
  riderId: string,
  statements: readonly string[],
): Promise<{ readonly code: string | undefined; readonly constraint: string | undefined } | null> {
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

describe('the check judges the count as the system, whatever context the writer is in at the commit', () => {
  // Break caught (fails on 809817b: the count is kept): a writer that changes its context before COMMIT hides the count from a check that reads as the caller, which returned quietly.
  it.each([
    [
      'an authorization key that cannot read the count',
      setting('melarc.authorization_key', 'pickup.read'),
    ],
    ['another principal type', setting('melarc.principal_type', 'VENDOR')],
    ['no context at all', setting('melarc.principal_type', '')],
  ] as const)(
    'refuses a count with none of its photos when the writer takes %s before the commit',
    async (_what, change) => {
      const arranged = await run();
      const stop = stopAt(arranged);

      expect(
        await asTheRider(arranged.rider.id, [insertCount(stop.id, arranged.rider.id), change]),
      ).toEqual({
        code: '23514',
        constraint: 'collection_parcel_photo_count',
      });
      expect(await recordsOf(stop.id)).toEqual([]);
    },
  );

  // Break caught (fails on 809817b: the good count is refused): a count Ops let through without photos, judged by what the context at the commit can read. The key that runs a stop reads the
  // count and not the exception of the stop, so a check that reads as the caller found no exception and demanded three photos of a count that takes none.
  it('keeps a count Ops let through without photos when the context at the commit cannot read the exception', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    await excusePhotos(routes, stop.id);

    expect(
      await asTheRider(arranged.rider.id, [
        insertCount(stop.id, arranged.rider.id),
        setting('melarc.authorization_key', 'pickup.run.execute'),
      ]),
    ).toBeNull();
    expect(await recordsOf(stop.id)).toHaveLength(1);
  });

  // Break caught: a count whose photos are all attached read as having none because the context at the commit cannot read them (the check counting what the caller sees).
  it('keeps a count with the photos of every parcel when the context at the commit cannot read them', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 3);
    const recordId = randomUUID();

    expect(
      await asTheRider(arranged.rider.id, [
        insertCount(stop.id, arranged.rider.id, recordId),
        ...photos.map((photo) => link(photo, recordId)),
        setting('melarc.authorization_key', 'pickup.run.execute'),
      ]),
    ).toBeNull();
    expect(await recordsOf(stop.id)).toHaveLength(1);
  });

  // Break caught: the photo a short count's reason asks for judged by what the context at the commit can read (the failing context cannot read the evidence).
  it('judges the photo a reason asks for as the system: refused without it, kept with it, in the changed context', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    await excusePhotos(routes, stop.id);
    const left = await photoOf(routes, arranged.rider, stop.id);
    const reasonRow = (
      await routes.rows<{ code: string; label: string; attribution: string }>(
        `select code, label, attribution from reason_code where code = 'PARCEL_DAMAGED_OR_UNSAFE'`,
      )
    )[0];
    if (reasonRow === undefined) throw new Error('reason');
    const short = `insert into collection_record (id, pickup_stop_id, responsible_hub_id, declared_count, collected_count, variance, variance_reason_snapshot,
                                                    office_notified_at, handshake_type, recorded_by)
                   values ('${randomUUID()}'::uuid, '${stop.id}'::uuid, '${HUB_A}'::uuid, 3, 2, 'SHORT',
                           '${JSON.stringify({ reason_code: reasonRow.code, label: reasonRow.label, attribution: reasonRow.attribution })}'::jsonb,
                           clock_timestamp(), 'VENDOR_ENTERED_RIDER_DISPLAYED', '${arranged.rider.id}'::uuid)`;
    const attach = `insert into pickup_stop_evidence (evidence_id, pickup_stop_id) values ('${left.id}'::uuid, '${stop.id}'::uuid)`;
    const changed = setting('melarc.authorization_key', 'pickup.run.execute');

    expect(await asTheRider(arranged.rider.id, [short, changed])).toEqual({
      code: '23514',
      constraint: 'collection_record_reason_photo',
    });
    expect(await recordsOf(stop.id)).toEqual([]);
    expect(await asTheRider(arranged.rider.id, [short, attach, changed])).toBeNull();
    expect(await recordsOf(stop.id)).toHaveLength(1);
  });

  // Break caught (fails on 809817b: the commit succeeds): a count that cannot be read at the end of the transaction passed quietly. Nothing the application does deletes a count; the
  // administrator makes one and removes it in the same transaction, which leaves the deferred check an event for a row that is not there.
  it('refuses, and does not pass, a count it cannot find at the end of the transaction', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    await excusePhotos(routes, stop.id);
    const recordId = randomUUID();
    await routes.admin.query('begin');
    let refusal: { code?: string; constraint?: string } | undefined;
    try {
      await routes.admin.query(
        `insert into collection_record (id, pickup_stop_id, responsible_hub_id, declared_count, collected_count, variance, handshake_type, recorded_by)
         values ($1, $2, $3, 3, 3, 'MATCH', 'VENDOR_ENTERED_RIDER_DISPLAYED', $4)`,
        [recordId, stop.id, HUB_A, arranged.rider.id],
      );
      await routes.admin.query(`delete from collection_record where id = $1`, [recordId]);
      await routes.admin.query('commit');
    } catch (error) {
      await routes.admin.query('rollback').catch(() => undefined);
      const server = serverErrorIn(error);
      refusal = { code: server?.code, constraint: server?.constraint };
    }
    expect(refusal).toEqual({ code: '23514', constraint: 'collection_photos_check_record' });
  });
});

describe('the check leaves no context behind, and the label alone reaches nothing', () => {
  // Break caught: the check asserting the system's context and not putting the caller's back, which would run the rest of the writer's transaction as the system the moment the check
  // is made to run (SET CONSTRAINTS ... IMMEDIATE fires it in the middle of a transaction).
  it('gives the caller’s own context back when it is made to run in the middle of a transaction', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    await excusePhotos(routes, stop.id);
    let seen: { type: string; capability: string; key: string } | undefined;
    await routes.built.service.transactionWithContext(
      riderContext(arranged.rider.id),
      async (tx) => {
        await tx.execute(sql.raw(insertCount(stop.id, arranged.rider.id)));
        await tx.execute(sql.raw('set constraints all immediate'));
        const rows = (
          await tx.execute(
            sql.raw(
              `select pg_catalog.current_setting('melarc.principal_type', true) as type,
                    coalesce(pg_catalog.current_setting('melarc.task_capability', true), '') as capability,
                    pg_catalog.current_setting('melarc.authorization_key', true) as key`,
            ),
          )
        ).rows;
        seen = rows[0] as typeof seen;
      },
    );
    expect(seen).toEqual({ type: 'RIDER', capability: '', key: CONFIRM });
  });

  // Break caught: a policy that admits the capability's reads without the owner, so that the label asserted by a statement of the runtime login would read what only the check may read.
  it('lets a context under the capability read none of the six tables when it is opened by the runtime login', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const other = stopAt(arranged, 1);
    // One stop is let through without parcel photos and counted. The other is counted with the photo of each parcel and has a photo attached as the photo of a parcel left behind:
    // every one of the six tables holds a row, so that a policy that admits the label without the owner is seen.
    await excusePhotos(routes, stop.id);
    expect(
      await asTheRider(arranged.rider.id, [insertCount(stop.id, arranged.rider.id)]),
    ).toBeNull();
    const parcels = await parcelPhotosOf(routes, arranged.rider, other.id, 3);
    const left = await photoOf(routes, arranged.rider, other.id);
    const recordId = randomUUID();
    expect(
      await asTheRider(arranged.rider.id, [
        insertCount(other.id, arranged.rider.id, recordId),
        ...parcels.map((photo) => link(photo, recordId)),
        `insert into pickup_stop_evidence (evidence_id, pickup_stop_id) values ('${left.id}'::uuid, '${other.id}'::uuid)`,
      ]),
    ).toBeNull();
    const tables = [
      'collection_record',
      'collection_parcel_photo',
      'parcel_photo_exception',
      'pickup_stop_evidence',
      'evidence',
      'reason_code',
    ];
    // The rows are there for someone who may read them.
    for (const table of tables) {
      const [counted] = await routes.rows<{ n: number }>(`select count(*)::int as n from ${table}`);
      expect(counted?.n, table).toBeGreaterThan(0);
    }
    const asLabel: SecurityContext = {
      principalType: 'SYSTEM',
      principalId: randomUUID(),
      surface: 'SYSTEM',
      taskCapability: 'collection_photo_check',
      correlationId: 'collection-photos-check',
    };
    const counts = await routes.built.service.transactionWithContext(asLabel, async (tx) => {
      const found: Record<string, number> = {};
      for (const table of tables) {
        const rows = (await tx.execute(sql.raw(`select count(*)::int as n from ${table}`))).rows;
        found[table] = (rows[0] as { n: number }).n;
      }
      return found;
    });
    expect(counts).toEqual(Object.fromEntries(tables.map((table) => [table, 0])));
  });
});
