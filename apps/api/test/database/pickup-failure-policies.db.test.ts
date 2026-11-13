import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { guardReasonIn, serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { excusePhotos } from './support/evidence-photo.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, arrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { HUB_A, HUB_B } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.28: what the database holds for **every** writer of a failure report (migration `0072`; `AC-SLICE-001-30`, `-31`, `-32`; pickup-failure.md):
 *
 * - **One writer**: the assigned rider's key that reports a failure, for a stop of its own run that it has arrived at, on a run in progress, in its own name.
 *   The stop becomes FAILED with its fixed category and the snapshot of its reason, and nothing else of it changes (its place, its arrival, its claim).
 *   **The facts the application takes from the catalogue and the clock are the database's**: the reason is an active reason of the PICKUP_FAILURE catalogue as
 *   the catalogue holds it, in the shape the application builds, with what its metadata asks for (a note, a contact attempt, and a photo, which is evidence attached
 *   to the stop: migration 0083) and under the category the catalogue gives it; and the moment is the database's own, named by the snapshot.
 * - **A failed stop is frozen**, whoever writes, and a stop with a count is never failed (the rider's key reads its own record, so the trigger finds it).
 * - **The run is completed by the system under the key** when its last stop is terminal and nothing was collected, and under no other conditions.
 * - **The ledger** takes the failure's event and the completion's with the facts of the rows and no others.
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

const FAILURE = 'pickup.failure.report';
const CORRELATION = 'pickup-failure-policies';

const rider = (riderId: string, key: string = FAILURE): SecurityContext => ({
  principalType: 'RIDER',
  principalId: riderId,
  sessionId: randomUUID(),
  surface: 'RIDER_ANDROID',
  riderId,
  authorizationKey: key,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: CORRELATION,
});
const staff = (key: string): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  sessionId: randomUUID(),
  surface: 'OPS_PORTAL',
  authorizationKey: key,
  hubScopeMode: 'ALL',
  authorizedHubIds: [],
  correlationId: CORRELATION,
});
const vendor = (): SecurityContext => ({
  principalType: 'VENDOR',
  principalId: vendorA.row.accountId,
  sessionId: randomUUID(),
  surface: 'VENDOR_PWA',
  authorizationKey: FAILURE,
  vendorOrganizationId: vendorA.row.organizationId,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: CORRELATION,
});

interface Result {
  readonly rows?: unknown[];
  readonly code?: string;
  readonly reason?: string;
}

/** Several statements in one transaction: the rows of the last, or the SQLSTATE of the first that fails and the reason its guard states. */
async function attemptAll(context: SecurityContext, texts: readonly string[]): Promise<Result> {
  try {
    const rows = await routes.built.service.transactionWithContext(context, async (tx) => {
      let last: unknown[] = [];
      for (const text of texts) last = (await tx.execute(sql.raw(text))).rows;
      return last;
    });
    return { rows };
  } catch (error) {
    const reason = guardReasonIn(error);
    return {
      code: serverErrorIn(error)?.code ?? 'other',
      ...(reason === undefined ? {} : { reason }),
    };
  }
}
const attempt = (context: SecurityContext, text: string): Promise<Result> =>
  attemptAll(context, [text]);

/** The guard of the table (a BEFORE trigger, 23514) answers before the policy's check (42501): any of them refuses. */
const REFUSED = ['42501', '23514', '23503'] as const;
const refused = (result: Result): void => {
  expect(result.code, JSON.stringify(result)).toBeDefined();
  expect(REFUSED).toContain(result.code);
};
/** The statement matched no row the policy lets this context see. */
const hidden = (result: Result): void => {
  expect(result.rows, JSON.stringify(result)).toEqual([]);
};
const reached = (result: Result): void => {
  expect(result.code, JSON.stringify(result)).toBeUndefined();
  expect((result.rows ?? []).length, JSON.stringify(result)).toBe(1);
};

const run = (over: Partial<Parameters<typeof arrangeRun>[2]> = {}): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 2,
    stopStates: ['ARRIVED', 'PENDING'],
    ...over,
  });
const first = (arranged: ArrangedRun): ArrangedRun['stops'][number] => {
  const stop = arranged.stops[0];
  if (stop === undefined) throw new Error('stop');
  return stop;
};

const GOOD = {
  reason_code: 'PARCELS_NOT_PACKED',
  label: 'Parcels not packed',
  attribution: 'CUSTOMER',
  note: 'The parcels were not packed',
};
const MOMENT = '2026-11-04T10:00:00.000Z';

interface FailOver {
  readonly id: string;
  readonly state?: string;
  readonly category?: string | null;
  readonly snapshot?: Record<string, unknown> | string | null;
  /** More assignments in the same statement (a column the report must not write). */
  readonly also?: string;
  /** What the statement returns (default: the identifier). */
  readonly returning?: string;
}
const failSql = ({
  id,
  state = 'FAILED',
  category = 'PARCEL_NOT_READY',
  snapshot = GOOD,
  also,
  returning = 'id',
}: FailOver): string => {
  const json =
    snapshot === null
      ? 'null'
      : `'${typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot)}'::jsonb`;
  return `update pickup_stop set state = '${state}', failure_category = ${category === null ? 'null' : `'${category}'`},
            failure_reason_snapshot = ${json}${also === undefined ? '' : `, ${also}`}
          where id = '${id}' returning ${returning}`;
};
const completeSql = (manifestId: string, also?: string): string =>
  `update pickup_manifest set state = 'COMPLETED', completed_at = clock_timestamp()${also === undefined ? '' : `, ${also}`}
    where id = '${manifestId}' returning id`;

const stopOf = (id: string) =>
  routes
    .rows<{
      state: string;
      version: number;
      sequence: number;
      arrived_at: Date | null;
      resolved_at: Date | null;
      released_at: Date | null;
      failure_category: string | null;
      failure_reason_snapshot: Record<string, unknown> | null;
    }>(
      `select state, version, sequence, arrived_at, resolved_at, released_at, failure_category, failure_reason_snapshot from pickup_stop where id = $1`,
      [id],
    )
    .then((rows) => {
      const row = rows[0];
      if (row === undefined) throw new Error('no stop');
      return row;
    });
const manifestOf = (id: string) =>
  routes
    .rows<{ state: string; completed_at: Date | null; started_at: Date | null }>(
      `select state, completed_at, started_at from pickup_manifest where id = $1`,
      [id],
    )
    .then((rows) => rows[0]);
const eventsOf = (code: string, objectId: string) =>
  routes.rows<{ id: string }>(
    `select id from audit_event where event_code = $1 and object_id = $2`,
    [code, objectId],
  );

describe('the report of a failure: the one writer', () => {
  // Break caught: a key that cannot fail its own arrived stop; a moment the writer chooses; a snapshot that does not name the database's moment.
  it('fails the rider’s own arrived stop under the key; the moment is the database’s, whatever the writer gave, and the snapshot names it', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const before = await stopOf(stop.id);
    reached(
      await attempt(
        rider(arranged.rider.id),
        failSql({ id: stop.id, also: `resolved_at = '2001-01-01T00:00:00Z'` }),
      ),
    );
    const after = await stopOf(stop.id);
    expect(after).toMatchObject({
      state: 'FAILED',
      failure_category: 'PARCEL_NOT_READY',
      sequence: before.sequence,
      released_at: null,
      version: before.version + 1,
    });
    expect(after.arrived_at).toEqual(before.arrived_at);
    expect(after.resolved_at?.getFullYear()).not.toBe(2001);
    const stamped = after.failure_reason_snapshot ?? {};
    expect(stamped).toMatchObject(GOOD);
    expect(new Date(String(stamped.reported_at)).getTime()).toBe(after.resolved_at?.getTime());
    // The moment is a whole number of milliseconds, so the snapshot and the column name the very same instant.
    const rest = await routes.rows<{ rest: string }>(
      `select (extract(microseconds from resolved_at)::bigint % 1000)::text as rest from pickup_stop where id = $1`,
      [stop.id],
    );
    expect(rest[0]?.rest).toBe('0');
    // To the millisecond, in UTC, as the application states it.
    expect(String(stamped.reported_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  // Break caught: the moment taken when the transaction began (or at the writer's choosing) instead of when the stop's lock is held, so that a writer that waited
  // for the lock is stamped before the writer it waited for.
  it('takes the moment when the stop is written, not when the transaction began', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const result = await attemptAll(rider(arranged.rider.id), [
      'select pg_sleep(0.4)',
      failSql({ id: stop.id, returning: 'id, (extract(epoch from now()) * 1000)::text as began' }),
    ]);
    reached(result);
    const began = Number(((result.rows ?? [])[0] as { began: string }).began);
    const resolved = (await stopOf(stop.id)).resolved_at?.getTime() ?? 0;
    expect(resolved - began).toBeGreaterThanOrEqual(300);
  });

  // Break caught: any other principal or key let into the stop; another rider's stop reached.
  it.each([
    ['another rider under the same key', 'otherRider', FAILURE],
    ['the same rider under the key of the arrival', 'rider', 'pickup.run.execute'],
    ['the same rider under the key of the count', 'rider', 'pickup.collection.confirm'],
    ['a member of staff under the key of the skip', 'staff', 'pickup.stop.skip'],
    ['a member of staff presenting the rider’s key', 'staff', FAILURE],
    ['a vendor presenting the rider’s key', 'vendor', FAILURE],
  ] as const)('does not let %s fail the stop', async (_who, who, key) => {
    const arranged = await run();
    const stop = first(arranged);
    const other = await arrangedRider(routes.kit, routes.admin);
    const context =
      who === 'rider'
        ? rider(arranged.rider.id, key)
        : who === 'otherRider'
          ? rider(other.id, key)
          : who === 'staff'
            ? staff(key)
            : vendor();
    const result = await attempt(context, failSql({ id: stop.id }));
    if (result.code === undefined) hidden(result);
    else refused(result);
    expect((await stopOf(stop.id)).state).toBe('ARRIVED');
  });

  // Break caught: a failure statement that carries another column with it (the claim released, the place moved, the arrival rewritten, the summary changed).
  it.each([
    ['moves the place', 'sequence = sequence + 5'],
    ['releases the claim', 'released_at = clock_timestamp()'],
    ['rewrites the arrival', `arrived_at = arrived_at + interval '1 minute'`],
    ['rewrites the summary', `pickup_summary = null`],
    ['writes a skip beside the failure', `skip_snapshot = '{}'::jsonb`],
  ] as const)('keeps the stop as it is: a failure that %s is refused', async (_what, also) => {
    const arranged = await run();
    const stop = first(arranged);
    const before = await stopOf(stop.id);
    refused(await attempt(rider(arranged.rider.id), failSql({ id: stop.id, also })));
    expect(await stopOf(stop.id)).toEqual(before);
  });

  // Break caught: a stop that is not arrived, or whose run is not in progress, failed; a stop already resolved failed again.
  it('fails only a stop that has been arrived at, on a run in progress', async () => {
    const arranged = await run({
      stops: 4,
      stopStates: ['PENDING', 'COLLECTED', 'SKIPPED', 'ARRIVED'],
    });
    const [pending, collected, skipped, arrived] = arranged.stops;
    for (const stop of [pending, collected, skipped]) {
      refused(await attempt(rider(arranged.rider.id), failSql({ id: stop?.id ?? '' })));
    }
    // A run that has only been dispatched, whose stop the fixture has arrived at.
    const dispatched = await run({ state: 'DISPATCHED', stopStates: ['ARRIVED', 'PENDING'] });
    refused(await attempt(rider(dispatched.rider.id), failSql({ id: first(dispatched).id })));
    expect((await stopOf(first(dispatched).id)).state).toBe('ARRIVED');
    // And the one arrived stop is failed once.
    reached(await attempt(rider(arranged.rider.id), failSql({ id: arrived?.id ?? '' })));
    refused(await attempt(rider(arranged.rider.id), failSql({ id: arrived?.id ?? '' })));
  });

  // Break caught: a category the table does not hold, or none on a FAILED stop (the facts of a failure are set exactly when the stop is FAILED).
  it.each([
    ['no category', null],
    ['a category outside the four', 'CLOSED'],
  ] as const)('refuses %s', async (_what, category) => {
    const arranged = await run();
    refused(await attempt(rider(arranged.rider.id), failSql({ id: first(arranged).id, category })));
    expect((await stopOf(first(arranged).id)).state).toBe('ARRIVED');
  });

  // Break caught (AC-SLICE-001-32): a failed stop that moves back, changes its category or its reason, or is released and changed in the same breath.
  it('is frozen once failed, for the rider’s key and for the administrator', async () => {
    const arranged = await run();
    const stop = first(arranged);
    reached(await attempt(rider(arranged.rider.id), failSql({ id: stop.id })));
    const frozen = await stopOf(stop.id);
    for (const text of [
      failSql({ id: stop.id, state: 'ARRIVED', category: null, snapshot: null }),
      failSql({ id: stop.id, state: 'COLLECTED', category: null, snapshot: null }),
      failSql({ id: stop.id, category: 'ACCESS_DENIED' }),
      failSql({ id: stop.id, snapshot: { ...GOOD, note: 'Changed' } }),
    ]) {
      refused(await attempt(rider(arranged.rider.id), text));
      await expect(
        routes.admin.query(text.replace(/ returning id$/, '')),
        text,
      ).rejects.toMatchObject({
        code: '23514',
      });
    }
    expect(await stopOf(stop.id)).toEqual(frozen);
  });

  // Break caught: the rider's key unable to read its own count, so that the trigger and the application both pass a failure of a stop whose parcels were taken
  // at the door (found by the tests of this task).
  it('never fails a stop that has a count: the key reads the rider’s own record, so the trigger finds it', async () => {
    const arranged = await run();
    const stop = first(arranged);
    // The test is about a failure of a counted stop, not the photos (D-A10): the stop is let through without them.
    await excusePhotos(routes, stop.id);
    const token =
      (await arranged.rider.client.get(`/api/v1/pickup-stops/${stop.id}`)).header('etag') ?? '';
    const counted = await arranged.rider.client.post(
      `/api/v1/pickup-stops/${stop.id}/collect`,
      { collected_count: 3 },
      { headers: { 'If-Match': token, 'Idempotency-Key': randomUUID() } },
    );
    expect(counted.status).toBe(200);
    refused(await attempt(rider(arranged.rider.id), failSql({ id: stop.id })));
    expect((await stopOf(stop.id)).state).toBe('ARRIVED');
  });

  // Break caught: the key's reading of the catalogue widened to other domains, or to other principals.
  it('reads the failure reasons and no others, as the rider’s key and no one else’s', async () => {
    const arranged = await run();
    const ctx = rider(arranged.rider.id);
    const domains = await attempt(ctx, `select distinct domain from reason_code order by domain`);
    expect((domains.rows as { domain: string }[]).map((row) => row.domain)).toEqual([
      'PICKUP_FAILURE',
    ]);
    for (const other of [
      rider(arranged.rider.id, 'pickup.run.execute'),
      rider(arranged.rider.id, 'pickup.stop.skip'),
      vendor(),
    ]) {
      hidden(await attempt(other, `select code from reason_code where domain = 'PICKUP_FAILURE'`));
    }
  });
});

describe('the door wait is held by the guard for every writer (migration 0073)', () => {
  const UNAVAILABLE = {
    reason_code: 'VENDOR_NOT_AT_LOCATION',
    label: 'Vendor not at location',
    attribution: 'CUSTOMER',
    note: 'The vendor was not there',
    contact_attempts: [{ method: 'PHONE_CALL', attempted_at: MOMENT, outcome: 'No answer' }],
  };
  const arrivedAgo = (stopId: string, interval: string) =>
    routes.admin.query(
      `update pickup_stop set arrived_at = clock_timestamp() - $2::interval where id = $1`,
      [stopId, interval],
    );

  // Break caught: the wait left to the application, so that a statement of the rider's key finds no wait; or held for the wrong category; or measured in a way that lets the
  // first second through.
  it('refuses a vendor-unavailable failure before the wait, accepts it after, and holds no other category', async () => {
    const arranged = await run({
      stops: 4,
      stopStates: ['ARRIVED', 'ARRIVED', 'ARRIVED', 'ARRIVED'],
    });
    const [early, boundary, late, other] = arranged.stops;
    await arrivedAgo(early?.id ?? '', '30 seconds');
    await arrivedAgo(boundary?.id ?? '', '9 minutes 30 seconds');
    await arrivedAgo(late?.id ?? '', '10 minutes 1 second');
    await arrivedAgo(other?.id ?? '', '1 second');
    const context = rider(arranged.rider.id);

    for (const each of [early, boundary]) {
      const result = await attempt(
        context,
        failSql({ id: each?.id ?? '', category: 'VENDOR_UNAVAILABLE', snapshot: UNAVAILABLE }),
      );
      expect({ code: result.code, reason: result.reason }).toEqual({
        code: '23514',
        reason: 'PICKUP_DOOR_WAIT_NOT_ELAPSED',
      });
      expect((await stopOf(each?.id ?? '')).state).toBe('ARRIVED');
    }
    reached(
      await attempt(
        context,
        failSql({ id: late?.id ?? '', category: 'VENDOR_UNAVAILABLE', snapshot: UNAVAILABLE }),
      ),
    );
    // Another category is not held, whatever its reason.
    reached(await attempt(context, failSql({ id: other?.id ?? '', category: 'PARCEL_NOT_READY' })));
  });

  // Break caught: the setting readable by anything but the rider's failure key, read for the wrong hub, or a value that is not a whole number of minutes taken as one.
  it('reads the wait of the hub for the rider’s failure key only, and refuses a value that is not a whole number of minutes', async () => {
    const arranged = await run();
    const ask = (hub: string) => `select melarc.rider_door_wait_minutes('${hub}'::uuid) as minutes`;
    const key = rider(arranged.rider.id);

    expect(await attempt(key, ask(HUB_A))).toEqual({ rows: [{ minutes: 10 }] });
    // Another hub's value is never used for this one: a hub with no setting has none.
    const missing = await attempt(key, ask(HUB_B));
    expect({ code: missing.code, reason: missing.reason }).toEqual({
      code: '23514',
      reason: 'SETTING_MISSING',
    });
    // Nobody else reads it: another key of the rider, a vendor, staff, and a context with no key.
    for (const other of [
      rider(arranged.rider.id, 'pickup.run.execute'),
      rider(arranged.rider.id, 'pickup.collection.confirm'),
      vendor(),
      staff('pickup.stop.skip'),
    ]) {
      expect((await attempt(other, ask(HUB_A))).code, other.principalType).toBe('42501');
    }

    // A value that is not a whole number of minutes from one to a day is a setting that cannot be used: no wait is invented in its place.
    for (const value of ['0', '1441', '10.5', '"10"', 'null', 'true', '-5']) {
      const hub = randomUUID();
      await routes.admin.query(
        `insert into hub (id, name) values ($1::uuid, 'Fixture ' || $1::uuid::text)`,
        [hub],
      );
      await routes.admin.query(
        `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
         values (gen_random_uuid(), $1, 'rider_door_wait_minutes', '', 1, $2::jsonb, 'minutes', clock_timestamp() - interval '1 hour', gen_random_uuid())`,
        [hub, value],
      );
      const result = await attempt(key, ask(hub));
      expect({ value, code: result.code, reason: result.reason }).toEqual({
        value,
        code: '23514',
        reason: 'SETTING_MISSING',
      });
    }
    // The version in force is the latest that has taken effect, and one not yet in force is not read.
    const hub = randomUUID();
    await routes.admin.query(
      `insert into hub (id, name) values ($1::uuid, 'Fixture ' || $1::uuid::text)`,
      [hub],
    );
    await routes.admin.query(
      `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by) values
         (gen_random_uuid(), $1, 'rider_door_wait_minutes', '', 1, '12'::jsonb, 'minutes', clock_timestamp() - interval '2 hours', gen_random_uuid()),
         (gen_random_uuid(), $1, 'rider_door_wait_minutes', '', 2, '20'::jsonb, 'minutes', clock_timestamp() - interval '1 hour', gen_random_uuid()),
         (gen_random_uuid(), $1, 'rider_door_wait_minutes', '', 3, '99'::jsonb, 'minutes', clock_timestamp() + interval '1 hour', gen_random_uuid())`,
      [hub],
    );
    expect(await attempt(key, ask(hub))).toEqual({ rows: [{ minutes: 20 }] });
  });

  // Break caught (the review of 5 November 2026): the arrival taken from the writer, so that the wait, which is measured from it, is a wait the writer chose: a statement
  // under the arrival key that gives an hour ago would have the report accepted the moment after.
  it('stamps the arrival itself: a statement under the rider’s key that gives another moment gets the database’s own, and the wait runs from it', async () => {
    const arranged = await run({ stops: 2, stopStates: ['PENDING', 'PENDING'] });
    const stop = first(arranged);

    reached(
      await attempt(
        rider(arranged.rider.id, 'pickup.run.execute'),
        `update pickup_stop set state = 'ARRIVED', arrived_at = clock_timestamp() - interval '1 hour' where id = '${stop.id}' returning id`,
      ),
    );

    const age = await routes.admin.query<{ seconds: string }>(
      `select extract(epoch from (clock_timestamp() - arrived_at)) as seconds from pickup_stop where id = $1`,
      [stop.id],
    );
    const seconds = Number(age.rows[0]?.seconds);
    expect(seconds).toBeGreaterThanOrEqual(0);
    expect(seconds).toBeLessThan(60);
    const failed = await attempt(
      rider(arranged.rider.id),
      failSql({ id: stop.id, category: 'VENDOR_UNAVAILABLE', snapshot: UNAVAILABLE }),
    );
    expect({ code: failed.code, reason: failed.reason }).toEqual({
      code: '23514',
      reason: 'PICKUP_DOOR_WAIT_NOT_ELAPSED',
    });
  });
});

describe('the snapshot is held to the catalogue', () => {
  // The category the catalogue gives the two reasons these cases name besides PARCELS_NOT_PACKED (D-A4: the guard refuses a snapshot written under another category, and the pairing
  // itself is held, for all eight reasons, in pickup-stop-evidence-policies.db.test.ts).
  const CATEGORY_OF: Readonly<Record<string, string>> = {
    VENDOR_NOT_AT_LOCATION: 'VENDOR_UNAVAILABLE',
    LOCATION_CLOSED: 'ACCESS_DENIED',
  };
  const categoryOfSnapshot = (snapshot: unknown): string => {
    const code =
      typeof snapshot === 'object' && snapshot !== null
        ? (snapshot as { reason_code?: unknown }).reason_code
        : undefined;
    return (typeof code === 'string' ? CATEGORY_OF[code] : undefined) ?? 'PARCEL_NOT_READY';
  };
  const ATTEMPT = { method: 'PHONE_CALL', attempted_at: MOMENT, outcome: 'No answer' };
  const WITH_ATTEMPTS = {
    ...GOOD,
    reason_code: 'VENDOR_NOT_AT_LOCATION',
    label: 'Vendor not at location',
  };
  const NOT_ACTIVE = 'REASON_NOT_ACTIVE';
  const REQUIRED = 'REASON_REQUIRED';
  const ELEVEN = Array.from({ length: 11 }, () => ATTEMPT);

  // Break caught: a snapshot the guard passes that the catalogue does not bear out, or one in a shape the application does not write.
  it.each([
    ['no reason at all', null, REQUIRED],
    ['a snapshot that is not an object', '"x"', NOT_ACTIVE],
    ['a member the application does not write', { ...GOOD, by: 'rider' }, NOT_ACTIVE],
    ['a moment of the writer’s', { ...GOOD, reported_at: MOMENT }, NOT_ACTIVE],
    ['a label the catalogue does not hold', { ...GOOD, label: 'Stale label' }, NOT_ACTIVE],
    [
      'no label',
      { reason_code: GOOD.reason_code, attribution: GOOD.attribution, note: GOOD.note },
      NOT_ACTIVE,
    ],
    ['an attribution the catalogue does not hold', { ...GOOD, attribution: 'MELARC' }, NOT_ACTIVE],
    ['a code the catalogue does not hold', { ...GOOD, reason_code: 'NO_SUCH_REASON' }, NOT_ACTIVE],
    [
      'a code of another domain',
      {
        reason_code: 'SOME_PARCELS_NOT_READY',
        label: 'Some parcels not ready',
        attribution: 'CUSTOMER',
        note: 'x',
      },
      NOT_ACTIVE,
    ],
    ['no note where the reason asks for one', { ...GOOD, note: undefined }, REQUIRED],
    ['a blank note', { ...GOOD, note: '   ' }, REQUIRED],
    ['a note too long', { ...GOOD, note: 'x'.repeat(1001) }, NOT_ACTIVE],
    ['a note that is not text', { ...GOOD, note: 5 }, NOT_ACTIVE],
    ['no contact attempt where the reason asks for one', WITH_ATTEMPTS, REQUIRED],
    [
      'an empty list where the reason asks for an attempt',
      { ...WITH_ATTEMPTS, contact_attempts: [] },
      REQUIRED,
    ],
    [
      'a photo the reason asks for, with none attached to the stop',
      {
        ...GOOD,
        reason_code: 'LOCATION_CLOSED',
        label: 'Location closed',
        attribution: 'EXTERNAL',
      },
      REQUIRED,
    ],
    ['contact attempts that are not a list', { ...GOOD, contact_attempts: {} }, NOT_ACTIVE],
    ['contact attempts that are null', { ...GOOD, contact_attempts: null }, NOT_ACTIVE],
    ['eleven contact attempts', { ...GOOD, contact_attempts: ELEVEN }, NOT_ACTIVE],
    ['an attempt that is not an object', { ...GOOD, contact_attempts: [1] }, NOT_ACTIVE],
    [
      'an attempt with no outcome',
      { ...GOOD, contact_attempts: [{ method: 'SMS', attempted_at: MOMENT }] },
      NOT_ACTIVE,
    ],
    [
      'an attempt with no moment',
      { ...GOOD, contact_attempts: [{ method: 'SMS', outcome: 'x' }] },
      NOT_ACTIVE,
    ],
    [
      'an attempt with no method',
      { ...GOOD, contact_attempts: [{ attempted_at: MOMENT, outcome: 'x' }] },
      NOT_ACTIVE,
    ],
    [
      'an attempt with a method outside the three',
      { ...GOOD, contact_attempts: [{ ...ATTEMPT, method: 'CALL' }] },
      NOT_ACTIVE,
    ],
    [
      'an attempt whose method is not text',
      { ...GOOD, contact_attempts: [{ ...ATTEMPT, method: 5 }] },
      NOT_ACTIVE,
    ],
    [
      'an attempt with a member of its own (a wait of its own)',
      { ...GOOD, contact_attempts: [{ ...ATTEMPT, wait_minutes: 12 }] },
      NOT_ACTIVE,
    ],
    [
      'an attempt with a note that is not text',
      { ...GOOD, contact_attempts: [{ ...ATTEMPT, note: 5 }] },
      NOT_ACTIVE,
    ],
    [
      'an attempt with a note that is null',
      { ...GOOD, contact_attempts: [{ ...ATTEMPT, note: null }] },
      NOT_ACTIVE,
    ],
    [
      'an attempt with a blank note',
      { ...GOOD, contact_attempts: [{ ...ATTEMPT, note: '  ' }] },
      NOT_ACTIVE,
    ],
    // Blank is judged as the application judges it, by any white space and not by the space alone (the review of 5 November 2026).
    [
      'an attempt with a note of only a line break',
      { ...GOOD, contact_attempts: [{ ...ATTEMPT, note: '\n' }] },
      NOT_ACTIVE,
    ],
    [
      'an attempt with an outcome of only a tab and a line break',
      { ...GOOD, contact_attempts: [{ ...ATTEMPT, outcome: '\t\n' }] },
      NOT_ACTIVE,
    ],
    [
      'a reason that asks for a note, given a note of only white space',
      { ...GOOD, note: '\t\n' },
      REQUIRED,
    ],
    [
      'an attempt with a note too long',
      { ...GOOD, contact_attempts: [{ ...ATTEMPT, note: 'x'.repeat(1001) }] },
      NOT_ACTIVE,
    ],
    [
      'an attempt moment with an offset',
      {
        ...GOOD,
        contact_attempts: [
          { ...ATTEMPT, attempted_at: '2026-11-04T10:00:00.000+00:00', outcome: 'x' },
        ],
      },
      NOT_ACTIVE,
    ],
    [
      'an attempt moment without milliseconds',
      {
        ...GOOD,
        contact_attempts: [{ ...ATTEMPT, attempted_at: '2026-11-04T10:00:00Z', outcome: 'x' }],
      },
      NOT_ACTIVE,
    ],
    [
      'an attempt with a blank outcome',
      { ...GOOD, contact_attempts: [{ ...ATTEMPT, outcome: ' ' }] },
      NOT_ACTIVE,
    ],
    [
      'an attempt with an outcome too long',
      { ...GOOD, contact_attempts: [{ ...ATTEMPT, outcome: 'x'.repeat(1001) }] },
      NOT_ACTIVE,
    ],
  ] as const)('refuses %s, and says which rule', async (_what, snapshot, reason) => {
    const arranged = await run();
    const stop = first(arranged);
    const text = failSql({
      id: stop.id,
      category: categoryOfSnapshot(snapshot),
      snapshot: JSON.parse(JSON.stringify(snapshot)) as never,
    });
    const result = await attempt(rider(arranged.rider.id), text);
    expect({ code: result.code, reason: result.reason }).toEqual({ code: '23514', reason });
    expect((await stopOf(stop.id)).state).toBe('ARRIVED');
  });

  // Break caught: the bounds off by one (ten attempts, a note of a thousand characters), or a reason that asks for an attempt refused when it has them.
  it.each([
    [
      'ten contact attempts',
      { ...GOOD, contact_attempts: Array.from({ length: 10 }, () => ATTEMPT) },
    ],
    ['a note of exactly the bound', { ...GOOD, note: 'x'.repeat(1000) }],
    [
      'an outcome of exactly the bound',
      { ...GOOD, contact_attempts: [{ ...ATTEMPT, outcome: 'x'.repeat(1000) }] },
    ],
    [
      'a note on an attempt of exactly the bound, and each of the three methods',
      {
        ...GOOD,
        contact_attempts: [
          { ...ATTEMPT, note: 'x'.repeat(1000) },
          { ...ATTEMPT, method: 'SMS' },
          { ...ATTEMPT, method: 'IN_PERSON' },
        ],
      },
    ],
    [
      'a reason that asks for an attempt, with one',
      { ...WITH_ATTEMPTS, contact_attempts: [ATTEMPT] },
    ],
    ['a snapshot with no attempts where none is asked for', GOOD],
  ] as const)('keeps %s', async (_what, snapshot) => {
    const arranged = await run();
    const stop = first(arranged);
    reached(
      await attempt(
        rider(arranged.rider.id),
        failSql({
          id: stop.id,
          category: categoryOfSnapshot(snapshot),
          snapshot: JSON.parse(JSON.stringify(snapshot)) as never,
        }),
      ),
    );
    const kept = (await stopOf(stop.id)).failure_reason_snapshot ?? {};
    expect(kept).toMatchObject(JSON.parse(JSON.stringify(snapshot)) as object);
  });

  // Break caught: a reason that the catalogue has retired, or whose requirements have changed, still accepted from a snapshot read earlier.
  it('follows the catalogue as it stands at the write: a retired reason, and a requirement added since the reading', async () => {
    const arranged = await run({ stops: 2, stopStates: ['ARRIVED', 'ARRIVED'] });
    const [one, two] = arranged.stops;
    try {
      await routes.admin.query(
        `update reason_code set active = false where code = 'PARCELS_NOT_PACKED'`,
      );
      const retired = await attempt(rider(arranged.rider.id), failSql({ id: one?.id ?? '' }));
      expect({ code: retired.code, reason: retired.reason }).toEqual({
        code: '23514',
        reason: 'REASON_NOT_ACTIVE',
      });
      await routes.admin.query(
        `update reason_code set active = true where code = 'PARCELS_NOT_PACKED'`,
      );
      await routes.admin.query(
        `update reason_code set requires_contact_attempt = true where code = 'PARCELS_NOT_PACKED'`,
      );
      const asks = await attempt(rider(arranged.rider.id), failSql({ id: two?.id ?? '' }));
      expect({ code: asks.code, reason: asks.reason }).toEqual({
        code: '23514',
        reason: 'REASON_REQUIRED',
      });
      await routes.admin.query(
        `update reason_code set requires_contact_attempt = false, requires_note = false where code = 'PARCELS_NOT_PACKED'`,
      );
      reached(
        await attempt(
          rider(arranged.rider.id),
          failSql({ id: two?.id ?? '', snapshot: { ...GOOD, note: undefined } }),
        ),
      );
    } finally {
      await routes.admin.query(
        `update reason_code set active = true, requires_contact_attempt = false, requires_note = true where code = 'PARCELS_NOT_PACKED'`,
      );
    }
  });
});

describe('the run is completed by the system under the key', () => {
  const pendingHandover = (arranged: ArrangedRun): Promise<unknown> =>
    routes.admin.query(
      `insert into run_custody_handover (id, manifest_id, responsible_hub_id, from_rider_id, to_hub_id, state, initiation_note, initiated_by)
       values (gen_random_uuid(), $1, $2, $3, $2, 'PENDING', 'Fixture handover to the hub', gen_random_uuid())`,
      [arranged.manifest.id, HUB_A, arranged.rider.id],
    );

  // Break caught: a run whose last stop failed with nothing collected that the key cannot complete.
  it('completes the run in the transaction of the last failure when nothing was collected', async () => {
    const arranged = await run({ stops: 1, stopStates: ['ARRIVED'] });
    reached(
      await attemptAll(rider(arranged.rider.id), [
        failSql({ id: first(arranged).id }),
        completeSql(arranged.manifest.id),
      ]),
    );
    expect((await manifestOf(arranged.manifest.id))?.state).toBe('COMPLETED');
    expect((await manifestOf(arranged.manifest.id))?.completed_at).not.toBeNull();
  });

  // Break caught: the completion of a run with a stop still to be worked, with something collected, with a custody handover pending, or with more changed.
  it.each([
    [
      'a stop still to be worked',
      { stops: 2, stopStates: ['ARRIVED', 'PENDING'] },
      undefined,
      false,
    ],
    ['something collected', { stops: 2, stopStates: ['ARRIVED', 'COLLECTED'] }, undefined, false],
    [
      'more than the state and its moment',
      { stops: 1, stopStates: ['ARRIVED'] },
      `started_at = started_at + interval '1 minute'`,
      false,
    ],
    ['a custody handover pending', { stops: 1, stopStates: ['ARRIVED'] }, undefined, true],
  ] as const)('refuses the completion of a run with %s', async (_what, over, also, handover) => {
    const arranged = await run({ ...over });
    if (handover) await pendingHandover(arranged);
    const before = await manifestOf(arranged.manifest.id);
    refused(
      await attemptAll(rider(arranged.rider.id), [
        failSql({ id: first(arranged).id }),
        completeSql(arranged.manifest.id, also),
      ]),
    );
    // The whole transaction is undone: the manifest is as it was and the stop is still arrived.
    expect(await manifestOf(arranged.manifest.id)).toEqual(before);
    expect((await stopOf(first(arranged).id)).state).toBe('ARRIVED');
  });

  // Break caught: the key completing a run that is another rider's, a run with an unresolved stop for another key, or a run of another rider's under its own.
  it.each([
    ['another rider’s run under the same key', 'otherRider', FAILURE],
    ['the rider’s own run under the key of the arrival', 'rider', 'pickup.run.execute'],
    ['the rider’s own run under the key of the count', 'rider', 'pickup.collection.confirm'],
  ] as const)('does not let %s be completed', async (_what, who, key) => {
    const arranged = await run({ stops: 1, stopStates: ['COLLECTED'] });
    const other = await arrangedRider(routes.kit, routes.admin);
    const context = who === 'rider' ? rider(arranged.rider.id, key) : rider(other.id, key);
    const result = await attempt(context, completeSql(arranged.manifest.id));
    if (result.code === undefined) hidden(result);
    else refused(result);
    expect((await manifestOf(arranged.manifest.id))?.state).toBe('IN_PROGRESS');
  });
});

describe('the ledger takes the events of the report with the facts of the rows and no others', () => {
  interface Over {
    readonly code?: string;
    readonly type?: string;
    readonly object?: string;
    readonly hub?: string;
    readonly previous?: string;
    readonly next?: string;
    readonly reasonCode?: string | null;
    readonly reasonLabel?: string | null;
    readonly related?: Record<string, unknown> | null;
    readonly detail?: Record<string, unknown> | null;
    readonly note?: string | null;
    readonly enhanced?: boolean;
    readonly actor?: string;
    readonly surface?: string;
    readonly correlation?: string;
    readonly diff?: Record<string, unknown> | null;
    readonly device?: Record<string, unknown> | null;
    readonly bundle?: string | null;
    readonly organization?: string | null;
    readonly approval?: string | null;
  }
  const literal = (value: string | null): string => (value === null ? 'null' : `'${value}'`);
  const jsonb = (value: Record<string, unknown> | null): string =>
    value === null ? 'null' : `'${JSON.stringify(value)}'::jsonb`;
  const eventSql = (o: Required<Pick<Over, 'object' | 'actor'>> & Over): string =>
    `insert into audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, responsible_hub_id, object_type, object_id,
                              correlation_id, previous_state, resulting_state, outcome, enhanced, reason_code, reason_label, related_ids, detail, note,
                              before_after, device_context, actor_bundle, vendor_organization_id, approval_id, serialisation_version)
     values (gen_random_uuid(), '${o.code ?? 'pickup.stop.failed'}', now(), 'RIDER', '${o.actor}'::uuid, '${o.surface ?? 'RIDER_ANDROID'}',
             '${o.hub ?? HUB_A}'::uuid, '${o.type ?? 'PickupStop'}', '${o.object}'::uuid, '${o.correlation ?? CORRELATION}', '${o.previous ?? 'ARRIVED'}',
             '${o.next ?? 'FAILED'}', 'SUCCEEDED', ${String(o.enhanced ?? false)}, ${literal(o.reasonCode === undefined ? 'PARCELS_NOT_PACKED' : o.reasonCode)},
             ${literal(o.reasonLabel === undefined ? 'Parcels not packed' : o.reasonLabel)}, ${jsonb(o.related ?? null)}, ${jsonb(o.detail ?? null)},
             ${literal(o.note ?? null)}, ${jsonb(o.diff ?? null)}, ${jsonb(o.device ?? null)}, ${literal(o.bundle ?? null)},
             ${o.organization == null ? 'null' : `'${o.organization}'::uuid`}, ${o.approval == null ? 'null' : `'${o.approval}'::uuid`}, 1)`;

  /** The genuine event of a failure of the first stop of an arranged run. */
  const genuine = (arranged: ArrangedRun, over: Over = {}): string => {
    const stop = first(arranged);
    return eventSql({
      object: stop.id,
      actor: arranged.rider.id,
      related: {
        pickup_manifest_id: arranged.manifest.id,
        pickup_request_id: stop.requestId,
        rider_id: arranged.rider.id,
      },
      detail: { failure_category: 'PARCEL_NOT_READY', contact_attempts: 0 },
      ...over,
    });
  };

  // Break caught: the event of a failure that the ledger refuses when every member agrees with the stored stop.
  it('takes the event of a failure written in the transaction that failed the stop', async () => {
    const arranged = await run();
    const stop = first(arranged);
    reached(
      await attemptAll(rider(arranged.rider.id), [
        failSql({ id: stop.id }),
        genuine(arranged),
        'select 1 as id',
      ]),
    );
    expect(await eventsOf('pickup.stop.failed', stop.id)).toHaveLength(1);
  });

  // Break caught: an event the stored stop does not bear out (another reason, another run, another count, another rider, a note, a diff, another tier, another
  // moment of state), or one written on a stop that is not the rider's.
  type Make = (arranged: ArrangedRun) => Over;
  const TAMPERED: readonly (readonly [string, Make])[] = [
    ['another reason code', () => ({ reasonCode: 'LOCATION_CLOSED' })],
    ['another reason label', () => ({ reasonLabel: 'Something else' })],
    ['no reason', () => ({ reasonCode: null, reasonLabel: null })],
    [
      'another category in the detail',
      () => ({ detail: { failure_category: 'ACCESS_DENIED', contact_attempts: 0 } }),
    ],
    [
      'another number of contact attempts',
      () => ({ detail: { failure_category: 'PARCEL_NOT_READY', contact_attempts: 1 } }),
    ],
    [
      'a member of its own in the detail',
      () => ({ detail: { failure_category: 'PARCEL_NOT_READY', contact_attempts: 0, why: 'x' } }),
    ],
    ['no detail', () => ({ detail: null })],
    ['no related identifiers', () => ({ related: null })],
    [
      'another rider among the related identifiers',
      (arranged) => ({
        related: {
          pickup_manifest_id: arranged.manifest.id,
          pickup_request_id: first(arranged).requestId,
          rider_id: randomUUID(),
        },
      }),
    ],
    [
      'another run among the related identifiers',
      (arranged) => ({
        related: {
          pickup_manifest_id: randomUUID(),
          pickup_request_id: first(arranged).requestId,
          rider_id: arranged.rider.id,
        },
      }),
    ],
    [
      'another request among the related identifiers',
      (arranged) => ({
        related: {
          pickup_manifest_id: arranged.manifest.id,
          pickup_request_id: randomUUID(),
          rider_id: arranged.rider.id,
        },
      }),
    ],
    ['a note', () => ({ note: 'The rider note' })],
    ['a diff', () => ({ diff: { state: { before: 'ARRIVED', after: 'FAILED' } } })],
    ['the enhanced tier', () => ({ enhanced: true })],
    ['another state before', () => ({ previous: 'PENDING' })],
    ['another state after', () => ({ next: 'COLLECTED' })],
    ['another hub', () => ({ hub: HUB_B })],
    ['another correlation', () => ({ correlation: 'somewhere-else' })],
    ['another surface', () => ({ surface: 'OPS_PORTAL' })],
    ['another event code for the same facts', () => ({ code: 'pickup.stop.skipped' })],
    ['the object of another type', () => ({ type: 'PickupRequest' })],
    ['a device context', () => ({ device: { model: 'x' } })],
    ['an actor bundle', () => ({ bundle: 'some-bundle' })],
    ['a vendor organization', () => ({ organization: vendorA.row.organizationId })],
    ['an approval', () => ({ approval: randomUUID() })],
  ];
  it.each(TAMPERED)('refuses an event with %s', async (_what, make) => {
    const arranged = await run();
    const stop = first(arranged);
    const result = await attemptAll(rider(arranged.rider.id), [
      failSql({ id: stop.id }),
      genuine(arranged, make(arranged)),
    ]);
    expect(result.code, JSON.stringify(result)).toBe('42501');
    expect((await stopOf(stop.id)).state).toBe('ARRIVED');
    expect(await eventsOf('pickup.stop.failed', stop.id)).toEqual([]);
  });

  // Break caught: the state of the stop left out of the binding, so that an event with every member a stop that has not failed would bear out (no reason, no
  // category) is taken for a failure that did not happen.
  it('refuses the event of a failure for a stop that has not failed, even with the facts such a stop bears out', async () => {
    const arranged = await run();
    const result = await attempt(
      rider(arranged.rider.id),
      genuine(arranged, {
        reasonCode: null,
        reasonLabel: null,
        detail: { failure_category: null, contact_attempts: 0 },
      }),
    );
    expect(result.code).toBe('42501');
    expect(await eventsOf('pickup.stop.failed', first(arranged).id)).toEqual([]);
  });

  // Break caught: an event for a stop that has not failed, one for another rider's stop, and one under the key of another act, each of them for a stop that is
  // genuinely failed when the second is written.
  it('refuses the event of a failure that did not happen, of another rider’s stop, or written under another key', async () => {
    const arranged = await run();
    const stop = first(arranged);
    // The stop is still arrived: nothing failed.
    expect((await attempt(rider(arranged.rider.id), genuine(arranged))).code).toBe('42501');

    // Another rider's stop, failed by that rider and committed; this rider cites it as its own.
    const other = await run();
    const theirs = first(other);
    reached(await attempt(rider(other.rider.id), failSql({ id: theirs.id })));
    const cited = eventSql({
      object: theirs.id,
      actor: arranged.rider.id,
      related: {
        pickup_manifest_id: other.manifest.id,
        pickup_request_id: theirs.requestId,
        rider_id: arranged.rider.id,
      },
      detail: { failure_category: 'PARCEL_NOT_READY', contact_attempts: 0 },
    });
    expect((await attempt(rider(arranged.rider.id), cited)).code).toBe('42501');

    // This rider's own stop, failed and committed: under the key of the arrival, which holds no such event, the genuine event is refused; under its own key it is taken.
    reached(await attempt(rider(arranged.rider.id), failSql({ id: stop.id })));
    expect(
      (await attemptAll(rider(arranged.rider.id, 'pickup.run.execute'), [genuine(arranged)])).code,
    ).toBe('42501');
    expect(
      (await attemptAll(rider(arranged.rider.id, 'pickup.collection.confirm'), [genuine(arranged)]))
        .code,
    ).toBe('42501');
    expect(await eventsOf('pickup.stop.failed', stop.id)).toEqual([]);
    reached(await attemptAll(rider(arranged.rider.id), [genuine(arranged), `select 1 as id`]));
    expect(await eventsOf('pickup.stop.failed', stop.id)).toHaveLength(1);
  });

  // Break caught: the completion's event accepted for a run that is not completed, another cause, another rider, or with more in it.
  it('takes the completion’s event bound to the completed run and its cause, and refuses the rest', async () => {
    const arranged = await run({ stops: 1, stopStates: ['ARRIVED'] });
    const manifest = arranged.manifest.id;
    const completion = (over: Over = {}): string =>
      eventSql({
        code: 'pickup.manifest.completed',
        type: 'PickupManifest',
        object: manifest,
        actor: arranged.rider.id,
        previous: 'IN_PROGRESS',
        next: 'COMPLETED',
        reasonCode: null,
        reasonLabel: null,
        related: { rider_id: arranged.rider.id },
        detail: { completed_by: 'SYSTEM', cause: 'LAST_STOP_FAILED' },
        ...over,
      });
    const both = (event: string): string[] => [
      failSql({ id: first(arranged).id }),
      completeSql(manifest),
      event,
    ];
    for (const [what, event] of [
      [
        'another cause',
        completion({ detail: { completed_by: 'SYSTEM', cause: 'LAST_STOP_SKIPPED' } }),
      ],
      [
        'another author',
        completion({ detail: { completed_by: 'RIDER', cause: 'LAST_STOP_FAILED' } }),
      ],
      ['another rider', completion({ related: { rider_id: randomUUID() } })],
      ['no related rider', completion({ related: null })],
      ['a note', completion({ note: 'x' })],
      [
        'a reason',
        completion({ reasonCode: 'PARCELS_NOT_PACKED', reasonLabel: 'Parcels not packed' }),
      ],
      ['the enhanced tier', completion({ enhanced: true })],
      ['another hub', completion({ hub: HUB_B })],
      ['a diff', completion({ diff: { state: { before: 'IN_PROGRESS', after: 'COMPLETED' } } })],
      ['a device context', completion({ device: { model: 'x' } })],
      ['an actor bundle', completion({ bundle: 'some-bundle' })],
      ['a vendor organization', completion({ organization: vendorA.row.organizationId })],
      ['an approval', completion({ approval: randomUUID() })],
    ] as const) {
      const result = await attemptAll(rider(arranged.rider.id), both(event));
      expect(result.code, what).toBe('42501');
    }
    // Written while the run is still in progress.
    const early = await attemptAll(rider(arranged.rider.id), [
      failSql({ id: first(arranged).id }),
      completion(),
    ]);
    expect(early.code).toBe('42501');
    expect((await manifestOf(manifest))?.state).toBe('IN_PROGRESS');
    // The genuine pair.
    reached(await attemptAll(rider(arranged.rider.id), [...both(completion()), `select 1 as id`]));
    expect(await eventsOf('pickup.manifest.completed', manifest)).toHaveLength(1);
  });
});
