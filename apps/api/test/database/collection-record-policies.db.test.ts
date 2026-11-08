import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildAuditRecord } from '../../src/platform/audit/audit-record.js';
import { guardReasonIn, serverErrorIn } from '../../src/platform/database/database-failures.js';
import {
  toContextSettings,
  type SecurityContext,
} from '../../src/platform/database/transaction-context.js';
import { waitUntilBlockedBy } from './support/lock-wait.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertAdHocSender, insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { arrangeRun, arrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { HUB_A, HUB_B } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.26: what the database holds for **every** writer of a collection record (migrations `0068` and `0069`; `AC-SLICE-001-20`, `-21`, `-28`):
 *
 * - **One writer**: the assigned rider's key that records a count, for a stop of its own run that it has arrived at, in its own name. The record is
 *   made once with the count the stop declared, never empty, with a variance that is the comparison of the counts and nothing else, a reason and the
 *   office flag exactly when it is short, and no handshake outcome; it is then frozen (the handshake alone sets its three columns, once). **The facts
 *   the application takes from the catalogue and the clock are the database's** (OB-S1-60): the reason is an active reason of the catalogue as the
 *   catalogue holds it, and the recording and the flag are the database's instants, taken after the stop's lock.
 * - **Reads are by party**: the rider that counted, and the staff of the hub under the keys of the pickup and fleet domains; a vendor none.
 * - **The rider's key reaches only what it needs**: the lock of its own stop (and no change of it), the short-count reasons, the request of the stop
 *   it has arrived at, and the one individual sender of that request, in one direction.
 * - **A stop with a record is never skipped or failed**, whoever writes it.
 * - **The ledger** takes the count's own event (`pickup.collection.recorded`, OB-S1-54) and the promotion with the facts of the rows and no others, and
 *   takes `pickup.stop.collected` and `pickup.stop.partially_collected` (the events of the close) from the counting key never.
 * - **No other role is made to hold anything it has no use for**: the notification worker may execute the two functions the policies call, and reads
 *   no record.
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
const RUN = 'pickup.run.execute';

const rider = (riderId: string, key: string): SecurityContext => ({
  principalType: 'RIDER',
  principalId: riderId,
  sessionId: randomUUID(),
  surface: 'RIDER_ANDROID',
  riderId,
  authorizationKey: key,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'collection-record-policies',
});
const staff = (key: string, hubs: readonly string[] | 'ALL' = 'ALL'): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  sessionId: randomUUID(),
  surface: 'OPS_PORTAL',
  authorizationKey: key,
  hubScopeMode: hubs === 'ALL' ? 'ALL' : 'SET',
  authorizedHubIds: hubs === 'ALL' ? [] : [...hubs],
  correlationId: 'collection-record-policies',
});
const vendor = (): SecurityContext => ({
  principalType: 'VENDOR',
  principalId: vendorA.row.accountId,
  sessionId: randomUUID(),
  surface: 'VENDOR_PWA',
  authorizationKey: CONFIRM,
  vendorOrganizationId: vendorA.row.organizationId,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'collection-record-policies',
});

type Result = { readonly rows: unknown[] } | { readonly code: string | undefined };

/** What a statement does as a context: the rows it returned, or the SQLSTATE of the error the database raised. */
async function attempt(context: SecurityContext, text: string): Promise<Result> {
  try {
    const rows = await routes.built.service.transactionWithContext(
      context,
      async (tx) => (await tx.execute(sql.raw(text))).rows,
    );
    return { rows };
  } catch (error) {
    return { code: serverErrorIn(error)?.code ?? 'other' };
  }
}
/**
 * What a statement does as a context, with the reason a guard states for a refusal it means to be answered as what it is (`DETAIL reason=<WORD>`:
 * the application turns `REASON_NOT_ACTIVE` and `REASON_REQUIRED` into the contract's errors). A refusal by anything else has no reason, so a test that
 * expects one cannot pass on an unrelated refusal (a stop not arrived at, a key, a policy).
 */
async function attemptWithReason(
  context: SecurityContext,
  text: string,
): Promise<{ readonly code?: string; readonly reason?: string; readonly rows?: unknown[] }> {
  try {
    const rows = await routes.built.service.transactionWithContext(
      context,
      async (tx) => (await tx.execute(sql.raw(text))).rows,
    );
    return { rows };
  } catch (error) {
    const reason = guardReasonIn(error);
    return {
      code: serverErrorIn(error)?.code ?? 'other',
      ...(reason === undefined ? {} : { reason }),
    };
  }
}
const idsOf = (result: Result): string[] =>
  'rows' in result ? result.rows.map((row) => (row as { id: string }).id) : [];
const codeOf = (result: Result): string | undefined => ('code' in result ? result.code : undefined);
/** Several statements in one transaction: the error code of the first that fails, or the rows of the last. The promotion's marker lives in its transaction. */
async function attemptAll(context: SecurityContext, texts: readonly string[]): Promise<Result> {
  try {
    const rows = await routes.built.service.transactionWithContext(context, async (tx) => {
      let last: unknown[] = [];
      for (const text of texts) last = (await tx.execute(sql.raw(text))).rows;
      return last;
    });
    return { rows };
  } catch (error) {
    return { code: serverErrorIn(error)?.code ?? 'other' };
  }
}
/** The guard of the table (a BEFORE trigger, 23514) answers before the policy's check (42501) and the policy's before a key's (23503): any of them refuses. */
const REFUSED = ['42501', '23514', '23503'] as const;
const refusedBy = (result: Result, ...codes: readonly string[]): void => {
  expect(codes.length === 0 ? REFUSED : codes).toContain(codeOf(result));
};

const senderState = async (id: string): Promise<string | undefined> =>
  (await routes.rows<{ state: string }>(`select state from ad_hoc_sender where id = $1`, [id]))[0]
    ?.state;
/** The `pickup.sender.promoted` rows of the ledger for a sender: the event is the promotion operation's own, so a test counts what exists. */
const promotionEventsOf = (senderId: string): Promise<Record<string, unknown>[]> =>
  routes.rows(
    `select * from audit_event where event_code = 'pickup.sender.promoted' and object_id = $1`,
    [senderId],
  );
/** The same events by the stop they cite: an event with no object at all, or with another sender's, is found by the stop it names. */
const promotionEventsCiting = (stopId: string): Promise<Record<string, unknown>[]> =>
  routes.rows(
    `select * from audit_event where event_code = 'pickup.sender.promoted' and related_ids ->> 'pickup_stop_id' = $1`,
    [stopId],
  );
/** The statement a caller of the runtime login would send to write that event itself, as the application's writer did before the operation wrote it. */
const promotionEventSql = (
  riderId: string,
  object: string,
  related: string | null,
  hub: string | null = HUB_A,
): string =>
  `insert into audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, responsible_hub_id, object_type,
                           object_id, correlation_id, previous_state, resulting_state, outcome, enhanced, related_ids, serialisation_version)
   values (gen_random_uuid(), 'pickup.sender.promoted', now(), 'RIDER', '${riderId}'::uuid, 'RIDER_ANDROID',
           ${hub === null ? 'null' : `'${hub}'::uuid`}, 'AdHocSender', '${object}'::uuid, 'collection-record-policies', 'PROVISIONAL', 'REUSABLE',
           'SUCCEEDED', false, ${related === null ? 'null' : `'${related}'::jsonb`}, 1)`;

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

interface RecordOver {
  readonly riderId?: string;
  readonly stopId?: string;
  readonly hub?: string;
  readonly declared?: number;
  readonly collected?: number;
  readonly variance?: string;
  readonly reason?: string | null;
  readonly flagged?: boolean;
  readonly type?: string;
  readonly channel?: string | null;
  readonly version?: number;
  /** Whether the statement returns the row: a returning statement must also read it, which the read policy decides. */
  readonly returning?: boolean;
  /** A SQL expression for the flag's instant the writer gives (the database's own is what is kept for a short count), instead of `clock_timestamp()`. */
  readonly notifiedAt?: string;
  /** A SQL expression for `recorded_at`; left out, the statement gives none. */
  readonly recordedAt?: string;
  /** A SQL expression for `captured_at`, the device's own moment; left out, the statement gives none. */
  readonly capturedAt?: string;
}
/** The statement that makes a record, as the service makes it, with whatever a test changes. */
function insertRecordSql(arranged: ArrangedRun, over: RecordOver = {}): string {
  const collected = over.collected ?? 3;
  const declared = over.declared ?? 3;
  const variance = over.variance ?? (collected < declared ? 'SHORT' : 'MATCH');
  const reason =
    over.reason === undefined
      ? variance === 'SHORT'
        ? `'{"reason_code":"SOME_PARCELS_NOT_READY","label":"Some parcels not ready","attribution":"CUSTOMER"}'::jsonb`
        : 'null'
      : over.reason === null
        ? 'null'
        : `'${over.reason}'::jsonb`;
  const flagged = over.flagged ?? variance === 'SHORT';
  return `insert into collection_record (id, pickup_stop_id, responsible_hub_id, declared_count, collected_count, variance, variance_reason_snapshot,
                                       office_notified_at, handshake_type, handshake_channel, recorded_by, version${over.recordedAt === undefined ? '' : ', recorded_at'}${over.capturedAt === undefined ? '' : ', captured_at'})
          values ('${randomUUID()}'::uuid, '${over.stopId ?? first(arranged).id}'::uuid, '${over.hub ?? HUB_A}'::uuid, ${String(declared)}, ${String(collected)},
                  '${variance}', ${reason}, ${over.notifiedAt ?? (flagged ? 'clock_timestamp()' : 'null')}, '${over.type ?? 'VENDOR_ENTERED_RIDER_DISPLAYED'}',
                  ${over.channel === undefined || over.channel === null ? 'null' : `'${over.channel}'`}, '${over.riderId ?? arranged.rider.id}'::uuid, ${String(over.version ?? 1)}${over.recordedAt === undefined ? '' : `, ${over.recordedAt}`}${over.capturedAt === undefined ? '' : `, ${over.capturedAt}`})
          ${over.returning === false ? '' : 'returning id'}`;
}

describe('who may write a collection record, and what it must be', () => {
  // Break caught: the one writer widened (another key, another rider, an officer, a vendor), or narrowed so that the rider's own act fails.
  it('is made by the assigned rider’s counting key for its own arrived stop, in its own name, and by nobody else', async () => {
    const arranged = await run();
    const other = await arrangedRider(routes.kit, routes.admin);
    const statement = insertRecordSql(arranged);
    refusedBy(await attempt(rider(other.id, CONFIRM), statement));
    refusedBy(await attempt(rider(arranged.rider.id, RUN), statement));
    refusedBy(await attempt(staff(CONFIRM), statement));
    refusedBy(await attempt(staff('pickup.stop.skip'), statement));
    refusedBy(await attempt(vendor(), statement));
    // Another rider's name in the record.
    // Without RETURNING, so that the insert policy is what refuses (a returning statement must read the row too, and the read policy shows a rider only
    // its own).
    refusedBy(
      await attempt(
        rider(arranged.rider.id, CONFIRM),
        insertRecordSql(arranged, { riderId: other.id, returning: false }),
      ),
      '42501',
    );
    expect(
      await routes.rows(`select id from collection_record where pickup_stop_id = $1`, [
        first(arranged).id,
      ]),
    ).toEqual([]);
    expect(codeOf(await attempt(rider(arranged.rider.id, CONFIRM), statement))).toBeUndefined();
  });

  // Break caught: a record made for a stop that is not arrived at, on a run that is not in progress, or with a count the stop did not declare.
  it.each([
    // The guard of the table (23514) and the policy's check (42501) both refuse these, and the guard answers first; the hub is the policy's.
    ['a stop not yet arrived at', { stopStates: ['PENDING', 'PENDING'] }, {}, ['23514', '42501']],
    ['a stop already worked', { stopStates: ['SKIPPED', 'PENDING'] }, {}, ['23514', '42501']],
    ['an arrived stop of a run that is not in progress', { state: 'DISPATCHED' }, {}, ['23514']],
    ['a count the stop did not declare', {}, { declared: 4, collected: 3 }, ['23514']],
    ['another hub than the stop’s', {}, { hub: HUB_B }, ['42501', '23503']],
  ] as const)('refuses a record for %s', async (_what, arrangement, over, codes) => {
    const arranged = await run({ ...arrangement });
    refusedBy(
      await attempt(rider(arranged.rider.id, CONFIRM), insertRecordSql(arranged, { ...over })),
      ...codes,
    );
  });

  // Break caught: the guard's own rules for the stop (policies do not bind an administrator, triggers do): a record for a stop not arrived at or already
  // worked, which the policy's check also refuses and so hides when it is the one that answers.
  it.each([
    ['a stop not yet arrived at', { stopStates: ['PENDING', 'PENDING'] }],
    ['a stop already worked', { stopStates: ['SKIPPED', 'PENDING'] }],
  ] as const)(
    'holds, in the guard alone, that a record is not made for %s',
    async (_what, arrangement) => {
      const arranged = await run({ ...arrangement });
      await expect(routes.admin.query(insertRecordSql(arranged))).rejects.toMatchObject({
        code: '23514',
      });
    },
  );

  // Break caught: a constraint dropped, so that a record is empty, over, short without its reason or its flag, or clean with either, or begins with a
  // handshake outcome or a version of its own.
  it.each([
    ['an empty collection', { collected: 0, variance: 'SHORT' }, '23514'],
    ['more than was declared', { collected: 4, variance: 'MATCH' }, '23514'],
    ['a short variance for equal counts', { collected: 3, variance: 'SHORT' }, '23514'],
    ['a short variance for more than was declared', { collected: 4, variance: 'SHORT' }, '23514'],
    [
      'a variance that is not the comparison',
      { collected: 2, variance: 'MATCH', reason: null, flagged: false },
      '23514',
    ],
    ['a short count with no reason', { collected: 2, reason: null }, '23514'],
    // (A short count whose writer gives no flag is not refused any more: the database raises the flag itself, OB-S1-60; see the instants of a record.)
    ['a clean count with a reason', { collected: 3, reason: '{"reason_code":"X"}' }, '23514'],
    ['a clean count with the flag raised', { collected: 3, flagged: true }, '23514'],
    ['a handshake outcome at the count', { channel: 'PORTAL' }, '23514'],
    ['a version of its own', { version: 2 }, '23514'],
    ['a direction that is not one', { type: 'BOTH' }, '23514'],
  ] as const)('refuses %s', async (_what, over, code) => {
    const arranged = await run();
    expect(
      codeOf(
        await attempt(rider(arranged.rider.id, CONFIRM), insertRecordSql(arranged, { ...over })),
      ),
    ).toBe(code);
  });

  // Break caught: a second record for a stop (a double submission under another key).
  it('keeps one record for a stop', async () => {
    const arranged = await run();
    await routes.admin.query(insertRecordSql(arranged));
    expect(
      codeOf(await attempt(rider(arranged.rider.id, CONFIRM), insertRecordSql(arranged))),
    ).toBe('23505');
  });

  // Break caught (the second review of 4 November 2026): the guard not comparing the record's direction with the one the request's sender fixes. The
  // table accepts either valid word, so a direct insert by the rider's own key could store the individual-sender flow for a vendor's pickup, or the
  // reverse, and the record freezes that choice for the handshake built on it. The wrong pairing is refused as the real runtime rider; the right one is made.
  it.each([
    ['a vendor’s request', 'vendor', 'SENDER_SMS_RIDER_ENTERED', 'VENDOR_ENTERED_RIDER_DISPLAYED'],
    [
      'an individual sender’s request',
      'individual',
      'VENDOR_ENTERED_RIDER_DISPLAYED',
      'SENDER_SMS_RIDER_ENTERED',
    ],
  ] as const)(
    'stores for %s the direction its sender fixes, and refuses the other',
    async (_what, kind, wrong, right) => {
      const world =
        kind === 'vendor'
          ? await run({ stops: 1, stopStates: ['ARRIVED'] }).then((arranged) => ({
              arranged,
              stopId: first(arranged).id,
            }))
          : await individual().then(({ arranged, stop }) => ({ arranged, stopId: stop.id }));
      const key = rider(world.arranged.rider.id, CONFIRM);
      const insert = (type: string): string =>
        insertRecordSql(world.arranged, { stopId: world.stopId, type });
      const stored = (): Promise<{ handshake_type: string }[]> =>
        routes.rows<{ handshake_type: string }>(
          `select handshake_type from collection_record where pickup_stop_id = $1`,
          [world.stopId],
        );

      // The wrong direction is refused by the guard, and the refusal makes no record.
      expect(codeOf(await attempt(key, insert(wrong)))).toBe('23514');
      expect(await stored()).toEqual([]);
      // The right one is made, and is what the table holds.
      expect(codeOf(await attempt(key, insert(right)))).toBeUndefined();
      expect(await stored()).toEqual([{ handshake_type: right }]);
    },
  );
});

/**
 * OB-S1-60 (found on the review of 4 November 2026, closed on the Product Owner's approval of the same day). A real runtime rider's direct insert,
 * under the counting key, for its own arrived stop, used to be able to keep a reason the `PICKUP_SHORT_COUNT` catalogue does not hold (with a label and an
 * attribution of its own) and any instant it chose for `recorded_at` and `office_notified_at`: the guard judged the stop, the run, the count, the direction
 * and the empty handshake, and nothing judged what the reason and the instants said. Every test here is the permitted writer itself (the runtime login,
 * the key, the assigned rider, an `ARRIVED` stop of its run), and each refusal is shown to be the one the guard states (`DETAIL reason=`), then the same
 * writer is shown to be accepted on the same stop with the genuine facts: an unrelated refusal can pass neither half.
 */
describe('the facts of a collection record that are the catalogue’s and the clock’s, not the writer’s (OB-S1-60)', () => {
  interface Reason {
    readonly code: string;
    readonly label: string;
    readonly attribution: string;
  }
  /** A reason as the catalogue holds it, whatever its domain (the wrong-domain case needs one of another catalogue). */
  const reasonOf = async (code: string): Promise<Reason> => {
    const row = (
      await routes.rows<Reason>(
        `select code, label, attribution from reason_code where code = $1`,
        [code],
      )
    )[0];
    if (row === undefined) throw new Error(`The catalogue holds no reason ${code}`);
    return row;
  };
  /** The snapshot the application builds for a reason: its code, its label and its attribution as they stand, and the rider's note if any. */
  const snapshotOf = (reason: Reason, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      reason_code: reason.code,
      label: reason.label,
      attribution: reason.attribution,
      ...extra,
    });
  const fixtureReason = async (
    code: string,
    over: { readonly active?: boolean; readonly photo?: boolean; readonly label?: string } = {},
  ): Promise<void> => {
    await routes.admin.query(
      `insert into reason_code (code, domain, label, attribution, requires_note, requires_photo, active)
       values ($1, 'PICKUP_SHORT_COUNT', $2, 'CUSTOMER', false, $3, $4)`,
      [
        code,
        over.label ?? `Fixture ${code.toLowerCase().replaceAll('_', ' ')}`,
        over.photo ?? false,
        over.active ?? true,
      ],
    );
  };
  const recordsOf = (stopId: string) =>
    routes.rows<{
      id: string;
      variance_reason_snapshot: Record<string, unknown> | null;
      captured_at: Date | null;
    }>(
      `select id, variance_reason_snapshot, captured_at from collection_record where pickup_stop_id = $1`,
      [stopId],
    );
  const clock = async (): Promise<string> =>
    (await routes.rows<{ t: string }>(`select clock_timestamp()::text as t`))[0]?.t ?? '';
  /** Whether the stored instants of the record of a stop lie within the two readings of the database's clock, and the flag is the recording's own instant. */
  const instantsOf = async (
    stopId: string,
    from: string,
    to: string,
  ): Promise<{ inside: boolean; flagged_at_recording: boolean | null; flag_present: boolean }> => {
    const rows = await routes.rows<{
      inside: boolean;
      flagged_at_recording: boolean | null;
      flag_present: boolean;
    }>(
      `select (recorded_at >= $2::timestamptz and recorded_at <= $3::timestamptz) as inside,
              (office_notified_at = recorded_at) as flagged_at_recording,
              (office_notified_at is not null) as flag_present
         from collection_record where pickup_stop_id = $1`,
      [stopId, from, to],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('No record was kept for the stop');
    return row;
  };

  describe('the reason of a short count', () => {
    beforeAll(async () => {
      await fixtureReason('FIXTURE_RETIRED_SHORT_COUNT', { active: false });
      // A label that is the text of a number: a snapshot that gives the number itself would equal it as text, which only the shape of the snapshot refuses.
      await fixtureReason('FIXTURE_NUMERIC_LABEL', { label: '12345' });
    });

    interface Case {
      /** The genuine reason the fabrication starts from (read from the catalogue); `SOME_PARCELS_NOT_READY` when none is named. */
      readonly code?: string;
      readonly make: (genuine: Reason) => string | Promise<string>;
      readonly reason: 'REASON_NOT_ACTIVE' | 'REASON_REQUIRED';
      /** The snapshot the same writer is then accepted with; left out, the genuine reason's own, and for a reason that asks for a photo a plain reason's. */
      readonly control?: (genuine: Reason) => string;
    }
    const REFUSED: readonly (readonly [string, Case])[] = [
      [
        'a reason the catalogue does not hold',
        {
          make: (g: Reason) => snapshotOf({ ...g, code: 'MADE_UP_SHORTFALL' }),
          reason: 'REASON_NOT_ACTIVE',
        },
      ],
      [
        'a reason the catalogue has retired',
        {
          make: async () => snapshotOf(await reasonOf('FIXTURE_RETIRED_SHORT_COUNT')),
          reason: 'REASON_NOT_ACTIVE',
        },
      ],
      [
        'a reason of another catalogue (a skip reason)',
        {
          make: async () => snapshotOf(await reasonOf('RUN_CUT_SHORT')),
          reason: 'REASON_NOT_ACTIVE',
        },
      ],
      [
        'a genuine code with a label of its own',
        {
          make: (g: Reason) => snapshotOf({ ...g, label: 'Customer agreed to a lower count' }),
          reason: 'REASON_NOT_ACTIVE',
        },
      ],
      [
        'a genuine code with an attribution of its own',
        {
          make: (g: Reason) => snapshotOf({ ...g, attribution: 'MELARC' }),
          reason: 'REASON_NOT_ACTIVE',
        },
      ],
      [
        'a genuine code with no label',
        {
          make: (g: Reason) => JSON.stringify({ reason_code: g.code, attribution: g.attribution }),
          reason: 'REASON_NOT_ACTIVE',
        },
      ],
      [
        'a genuine code with no attribution',
        {
          make: (g: Reason) => JSON.stringify({ reason_code: g.code, label: g.label }),
          reason: 'REASON_NOT_ACTIVE',
        },
      ],
      [
        'a genuine reason with a fact of its own beside it',
        { make: (g: Reason) => snapshotOf(g, { approved_by: 'ops' }), reason: 'REASON_NOT_ACTIVE' },
      ],
      [
        'a code that is not text',
        {
          make: (g: Reason) =>
            JSON.stringify({ reason_code: 7, label: g.label, attribution: g.attribution }),
          reason: 'REASON_NOT_ACTIVE',
        },
      ],
      ['a snapshot that is not an object', { make: () => '[1]', reason: 'REASON_NOT_ACTIVE' }],
      [
        'a label that is a number equal to the catalogue’s label as text',
        {
          make: () =>
            JSON.stringify({
              reason_code: 'FIXTURE_NUMERIC_LABEL',
              label: 12345,
              attribution: 'CUSTOMER',
            }),
          reason: 'REASON_NOT_ACTIVE',
        },
      ],
      [
        'a note that is not text',
        { make: (g: Reason) => snapshotOf(g, { note: 5 }), reason: 'REASON_NOT_ACTIVE' },
      ],
      [
        'a note beyond the 1,000 characters the application keeps',
        {
          make: (g: Reason) => snapshotOf(g, { note: 'x'.repeat(1001) }),
          reason: 'REASON_NOT_ACTIVE',
        },
      ],
      [
        'a reason that asks for a note, with none',
        {
          code: 'VENDOR_HELD_BACK_PARCELS',
          make: (g: Reason) => snapshotOf(g),
          reason: 'REASON_REQUIRED',
          control: (g: Reason) => snapshotOf(g, { note: 'Two boxes are still in the back room' }),
        },
      ],
      [
        'a reason that asks for a note, with a blank one',
        {
          code: 'VENDOR_DISPUTES_COUNT',
          make: (g: Reason) => snapshotOf(g, { note: '   ' }),
          reason: 'REASON_REQUIRED',
          control: (g: Reason) => snapshotOf(g, { note: 'Vendor says it packed five' }),
        },
      ],
      [
        'a reason that asks for a photo, which cannot be given yet',
        {
          code: 'PARCEL_DAMAGED_OR_UNSAFE',
          make: (g: Reason) => snapshotOf(g),
          reason: 'REASON_REQUIRED',
        },
      ],
    ];

    // Break caught: the guard not judging the snapshot (the probe of 4 November 2026 stored every one of these), or judging only some of what it says (the
    // code but not its label, the label but not the attribution, the three members but not a fourth). Each is the permitted writer's direct insert; the
    // refusal is the guard's stated reason, nothing is kept, and the genuine reason is then accepted on the same stop by the same writer.
    it.each(REFUSED)(
      'refuses %s, keeps nothing, and accepts the genuine reason on the same stop',
      async (_what, spec) => {
        const arranged = await run();
        const stop = first(arranged);
        const key = rider(arranged.rider.id, CONFIRM);
        const genuine = await reasonOf(spec.code ?? 'SOME_PARCELS_NOT_READY');
        const fabricated = await spec.make(genuine);

        expect(
          await attemptWithReason(
            key,
            insertRecordSql(arranged, { collected: 2, reason: fabricated, returning: false }),
          ),
        ).toEqual({ code: '23514', reason: spec.reason });
        expect(await recordsOf(stop.id)).toEqual([]);

        // The same writer, the same stop, the facts the application would have written: made. A reason that asks for a photo has no genuine form yet, so
        // the control is another, plain reason.
        const control =
          spec.control !== undefined
            ? spec.control(genuine)
            : snapshotOf(await reasonOf('SOME_PARCELS_NOT_READY'));
        expect(
          await attemptWithReason(
            key,
            insertRecordSql(arranged, { collected: 2, reason: control, returning: false }),
          ),
        ).toEqual({ rows: [] });
        const [kept] = await recordsOf(stop.id);
        expect(kept?.variance_reason_snapshot).toEqual(JSON.parse(control));
      },
    );

    // Break caught: the catalogue's domain left out of the guard's look, so that a reason of another catalogue is accepted whenever its row is visible. The
    // rider's own reading of the catalogue shows this domain alone, so only a writer that sees every catalogue reaches the guard's own filter: the
    // guard judges every writer, the administrator's included.
    it('refuses a reason of another catalogue from a writer that sees every catalogue', async () => {
      const arranged = await run();
      const skip = await reasonOf('RUN_CUT_SHORT');
      await expect(
        routes.admin.query(
          insertRecordSql(arranged, { collected: 2, reason: snapshotOf(skip), returning: false }),
        ),
      ).rejects.toMatchObject({ code: '23514', detail: 'reason=REASON_NOT_ACTIVE' });
      expect(await recordsOf(first(arranged).id)).toEqual([]);
    });

    // Break caught: a short count with no reason at all (SQL null, not a JSON null) answered as an unknown reason, which tells the client to pick another
    // when it has to give one: the guard states `REASON_REQUIRED`.
    it('asks for the reason of a short count that gives none, and keeps nothing', async () => {
      const arranged = await run();
      expect(
        await attemptWithReason(
          rider(arranged.rider.id, CONFIRM),
          insertRecordSql(arranged, { collected: 2, reason: null, returning: false }),
        ),
      ).toEqual({ code: '23514', reason: 'REASON_REQUIRED' });
      expect(await recordsOf(first(arranged).id)).toEqual([]);
    });

    // Break caught: the legitimate note refused with the rest, or kept altered. A note under a reason that does not ask for one is the rider's, and kept.
    it('keeps the rider’s own note as written, under a reason that asks for none and under one that does', async () => {
      for (const [code, note] of [
        ['SOME_PARCELS_NOT_READY', 'Two boxes are still in the back room'],
        ['VENDOR_HELD_BACK_PARCELS', 'The vendor kept one carton for a walk-in'],
      ] as const) {
        const arranged = await run();
        const reason = await reasonOf(code);
        const snapshot = snapshotOf(reason, { note });
        expect(
          await attemptWithReason(
            rider(arranged.rider.id, CONFIRM),
            insertRecordSql(arranged, { collected: 2, reason: snapshot, returning: false }),
          ),
        ).toEqual({ rows: [] });
        expect((await recordsOf(first(arranged).id))[0]?.variance_reason_snapshot).toEqual({
          reason_code: reason.code,
          label: reason.label,
          attribution: reason.attribution,
          note,
        });
      }
    });

    // Break caught: a later edit of the catalogue reaching the record (a join, a trigger, a view over the label): the snapshot is the reason as it was
    // when the count was recorded, for ever (domain-model.md section 3.7).
    it('keeps the snapshot as it was when the catalogue is edited or the reason is retired later', async () => {
      const code = 'FIXTURE_EDITED_AFTER_THE_COUNT';
      await fixtureReason(code);
      const arranged = await run();
      const before = await reasonOf(code);
      expect(
        await attemptWithReason(
          rider(arranged.rider.id, CONFIRM),
          insertRecordSql(arranged, { collected: 2, reason: snapshotOf(before), returning: false }),
        ),
      ).toEqual({ rows: [] });
      await routes.admin.query(
        `update reason_code set label = 'Edited after the count', attribution = 'EXTERNAL', active = false where code = $1`,
        [code],
      );
      expect(await reasonOf(code)).toMatchObject({ label: 'Edited after the count' });
      expect((await recordsOf(first(arranged).id))[0]?.variance_reason_snapshot).toEqual({
        reason_code: before.code,
        label: before.label,
        attribution: before.attribution,
      });
    });

    // Break caught: the snapshot taken from the catalogue at one moment and kept at another with nothing to say they differ (the application reads the
    // reason, then inserts; a catalogue change between the two must leave a snapshot that agrees with the catalogue or a refusal, never a mixture).
    it.each([
      [
        'its label is edited',
        `update reason_code set label = 'Fixture label, edited' where code = $1`,
      ],
      [
        'its attribution is edited',
        `update reason_code set attribution = 'MELARC' where code = $1`,
      ],
      ['it is retired', `update reason_code set active = false where code = $1`],
    ] as const)(
      'refuses a snapshot taken before the catalogue changed (%s), and accepts the one taken after',
      async (what, change) => {
        const code = `FIXTURE_DRIFT_${randomUUID().slice(0, 8).toUpperCase()}`;
        await fixtureReason(code);
        const taken = await reasonOf(code);
        await routes.admin.query(change, [code]);
        const arranged = await run();
        const stop = first(arranged);
        const key = rider(arranged.rider.id, CONFIRM);

        expect(
          await attemptWithReason(
            key,
            insertRecordSql(arranged, {
              collected: 2,
              reason: snapshotOf(taken),
              returning: false,
            }),
          ),
        ).toEqual({ code: '23514', reason: 'REASON_NOT_ACTIVE' });
        expect(await recordsOf(stop.id)).toEqual([]);

        if (what !== 'it is retired') {
          const retaken = await reasonOf(code);
          expect(
            await attemptWithReason(
              key,
              insertRecordSql(arranged, {
                collected: 2,
                reason: snapshotOf(retaken),
                returning: false,
              }),
            ),
          ).toEqual({ rows: [] });
          expect((await recordsOf(stop.id))[0]?.variance_reason_snapshot).toEqual(
            JSON.parse(snapshotOf(retaken)),
          );
        }
      },
    );
  });

  describe('the instants of a record', () => {
    // Break caught: `recorded_at` and `office_notified_at` kept as the writer gave them (a past instant to make a count look early, a future one to
    // make it look late or to hide it from a window). The probe of 4 November 2026 stored both.
    it.each([
      ['a past instant', '2000-01-01T00:00:00Z'],
      ['a future instant', '2099-01-01T00:00:00Z'],
    ] as const)(
      'keeps the database’s own instants when the writer gives %s for the recording and the flag',
      async (_what, instant) => {
        const arranged = await run();
        const stop = first(arranged);
        const from = await clock();
        expect(
          await attempt(
            rider(arranged.rider.id, CONFIRM),
            insertRecordSql(arranged, {
              collected: 2,
              recordedAt: `'${instant}'::timestamptz`,
              notifiedAt: `'${instant}'::timestamptz`,
              returning: false,
            }),
          ),
        ).toEqual({ rows: [] });
        const to = await clock();
        expect(await instantsOf(stop.id, from, to)).toEqual({
          inside: true,
          flagged_at_recording: true,
          flag_present: true,
        });
      },
    );

    // Break caught: a short count whose flag the writer leaves out (the database raises the flag; a short count always has one) and a clean count's flag
    // given by the writer (there is no flag to raise, and a time the writer chose for one is a fabricated fact).
    it('raises the flag of a short count itself even when the writer gives none, and refuses a flag on a clean count', async () => {
      const arranged = await run();
      const stop = first(arranged);
      const from = await clock();
      expect(
        await attempt(
          rider(arranged.rider.id, CONFIRM),
          insertRecordSql(arranged, { collected: 2, flagged: false, returning: false }),
        ),
      ).toEqual({ rows: [] });
      const to = await clock();
      expect(await instantsOf(stop.id, from, to)).toEqual({
        inside: true,
        flagged_at_recording: true,
        flag_present: true,
      });

      const clean = await run();
      expect(
        await attemptWithReason(
          rider(clean.rider.id, CONFIRM),
          insertRecordSql(clean, {
            collected: 3,
            notifiedAt: `'2026-11-03T08:00:00Z'::timestamptz`,
            returning: false,
          }),
        ),
      ).toMatchObject({ code: '23514' });
      expect(await recordsOf(first(clean).id)).toEqual([]);
    });

    // Break caught: the instant of the transaction's beginning kept for a writer that waited for the stop's lock (a default of `now()` is the start of the
    // transaction, so a count that waited for a skip or another act would read as made before the act it waited for). The instants are taken after the
    // lock: the writer that comes second is stamped no earlier than the moment the first let go.
    it('takes the instants after the stop’s lock is held, not when the transaction began', async () => {
      const arranged = await run();
      const stop = first(arranged);
      const key = rider(arranged.rider.id, CONFIRM);
      const holding = held(key, async (statement) => {
        await statement(`select id from pickup_stop where id = '${stop.id}' for update`);
      });
      const released = await (async (): Promise<string> => {
        try {
          const pid = await holding.ready;
          const inserting = attempt(
            key,
            insertRecordSql(arranged, {
              collected: 2,
              recordedAt: `'2000-01-01T00:00:00Z'::timestamptz`,
              returning: false,
            }),
          );
          await waitUntilBlockedBy(routes.admin, pid, 'the insert', inserting);
          // The reading is taken while the insert is seen waiting and before the holder lets go: whatever the insert is stamped with is later.
          const instant = await clock();
          holding.release();
          await holding.done;
          expect(await inserting).toEqual({ rows: [] });
          return instant;
        } finally {
          holding.release();
          await holding.done.catch(() => undefined);
        }
      })();
      const to = await clock();
      // Inside the readings taken before the wait ended and after the insert finished: the instant is the lock's, not the beginning of the transaction's.
      expect(await instantsOf(stop.id, released, to)).toEqual({
        inside: true,
        flagged_at_recording: true,
        flag_present: true,
      });
    });

    // Break caught: the device's own moment lost, replaced by the database's, or taken as the recording: the two are different facts and both are kept.
    it('keeps the device’s own moment as the writer gave it, apart from the recording', async () => {
      const arranged = await run();
      const stop = first(arranged);
      expect(
        await attempt(
          rider(arranged.rider.id, CONFIRM),
          insertRecordSql(arranged, {
            collected: 2,
            capturedAt: `'2026-11-03T08:15:00.250Z'::timestamptz`,
            returning: false,
          }),
        ),
      ).toEqual({ rows: [] });
      const [kept] = await recordsOf(stop.id);
      expect(kept?.captured_at?.toISOString()).toBe('2026-11-03T08:15:00.250Z');
      const apart = await routes.rows<{ apart: boolean }>(
        `select (captured_at <> recorded_at) as apart from collection_record where pickup_stop_id = $1`,
        [stop.id],
      );
      expect(apart[0]?.apart).toBe(true);
    });
  });
});

describe('a record is frozen once it is made', () => {
  // Break caught: a count, a reason, a hub or a rider changed after the fact; the handshake's outcome set twice or taken back; the version moved by
  // the writer instead of the database.
  it('changes nothing of what the count said, sets the handshake’s three columns once, and moves the version itself', async () => {
    const arranged = await run();
    const { rows } = await routes.admin.query<{ id: string }>(
      insertRecordSql(arranged, { collected: 2 }),
    );
    const id = rows[0]?.id ?? '';
    for (const change of [
      `collected_count = 1`,
      `declared_count = 4`,
      `variance = 'MATCH'`,
      `variance_reason_snapshot = null`,
      `office_notified_at = null`,
      `recorded_by = gen_random_uuid()`,
      `handshake_type = 'SENDER_SMS_RIDER_ENTERED'`,
      `captured_at = now()`,
    ]) {
      await expect(
        routes.admin.query(`update collection_record set ${change} where id = $1`, [id]),
        change,
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^23/) as unknown,
      });
    }
    await routes.admin.query(
      `update collection_record set handshake_channel = 'PORTAL', handshake_confirmed_at = now() where id = $1`,
      [id],
    );
    const set = await routes.rows<{ version: number; handshake_channel: string }>(
      `select version, handshake_channel from collection_record where id = $1`,
      [id],
    );
    expect(set[0]).toEqual({ version: 2, handshake_channel: 'PORTAL' });
    await expect(
      routes.admin.query(
        `update collection_record set handshake_channel = 'SMS_FALLBACK' where id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // The runtime login has no update on the table at all (the handshake task grants its own columns).
    expect(
      codeOf(
        await attempt(
          rider(arranged.rider.id, CONFIRM),
          `update collection_record set collected_count = 1 where id = '${id}'`,
        ),
      ),
    ).toBe('42501');
  });
});

describe('who reads a collection record', () => {
  // Break caught: a record read by a rider that did not count it, a vendor, a key of another domain, or staff of another hub.
  it('is read by the rider that counted it and staff of its hub, and by nobody else', async () => {
    const arranged = await run();
    const other = await arrangedRider(routes.kit, routes.admin);
    const { rows } = await routes.admin.query<{ id: string }>(insertRecordSql(arranged));
    const id = rows[0]?.id ?? '';
    const read = `select id from collection_record where id = '${id}'`;
    expect(idsOf(await attempt(rider(arranged.rider.id, CONFIRM), read))).toEqual([id]);
    expect(idsOf(await attempt(rider(arranged.rider.id, RUN), read))).toEqual([id]);
    expect(idsOf(await attempt(rider(arranged.rider.id, 'pickup.read'), read))).toEqual([]);
    expect(idsOf(await attempt(rider(other.id, CONFIRM), read))).toEqual([]);
    expect(idsOf(await attempt(vendor(), read))).toEqual([]);
    expect(idsOf(await attempt(staff('pickup.read', [HUB_A]), read))).toEqual([id]);
    expect(idsOf(await attempt(staff('fleet.custody.read', [HUB_A]), read))).toEqual([id]);
    expect(idsOf(await attempt(staff('pickup.read', [HUB_B]), read))).toEqual([]);
    expect(idsOf(await attempt(staff('finance.read', 'ALL'), read))).toEqual([]);
  });
});

describe('what the counting key reaches besides its own table', () => {
  // Break caught: the lock policy giving the key a write, or not giving it the lock (the act would find no stop).
  it('takes the lock of its own dispatched stop and writes nothing of it', async () => {
    const arranged = await run();
    const other = await arrangedRider(routes.kit, routes.admin);
    const id = first(arranged).id;
    const lock = `select id from pickup_stop where id = '${id}' for update`;
    expect(idsOf(await attempt(rider(arranged.rider.id, CONFIRM), lock))).toEqual([id]);
    expect(idsOf(await attempt(rider(other.id, CONFIRM), lock))).toEqual([]);
    expect(idsOf(await attempt(rider(arranged.rider.id, 'pickup.read'), lock))).toEqual([]);
    expect(
      codeOf(
        await attempt(
          rider(arranged.rider.id, CONFIRM),
          `update pickup_stop set state = 'SKIPPED' where id = '${id}'`,
        ),
      ),
    ).toBe('42501');
  });

  // Break caught: the short-count reasons visible to the wrong key, or the other domains' reasons visible to the rider.
  it('reads the short-count reasons and no other, under its key alone', async () => {
    const arranged = await run();
    const reasons = `select code from reason_code where active`;
    const count = async (context: SecurityContext): Promise<string[]> => {
      const result = await attempt(context, `select domain from reason_code`);
      return 'rows' in result
        ? [...new Set(result.rows.map((row) => (row as { domain: string }).domain))]
        : [];
    };
    expect(await count(rider(arranged.rider.id, CONFIRM))).toEqual(['PICKUP_SHORT_COUNT']);
    expect(await count(rider(arranged.rider.id, RUN))).toEqual([]);
    expect(await count(vendor())).toEqual([]);
    expect(codeOf(await attempt(rider(arranged.rider.id, CONFIRM), reasons))).toBeUndefined();
  });

  // Break caught: the old read policies, which gave the counting key the whole row of the request (and of the individual sender) of any stop it
  // had arrived at, and kept it while the handshake is pending. A query of its own, under the key, finds nothing: before the count and after it.
  it('reads no request and no sender as rows, at any stop, before or after its count', async () => {
    const { arranged, sender, stop } = await individual();
    const vendorsRun = await run();
    const key = rider(arranged.rider.id, CONFIRM);
    const rows = (table: string) => `select id from ${table}`;
    for (const when of ['before the count', 'after the count']) {
      expect(await attempt(key, rows('pickup_request')), `a request ${when}`).toEqual({ rows: [] });
      expect(await attempt(key, rows('ad_hoc_sender')), `a sender ${when}`).toEqual({ rows: [] });
      expect(
        await attempt(key, `select * from pickup_request where id = '${stop.requestId}'`),
        `the request of its own stop ${when}`,
      ).toEqual({ rows: [] });
      expect(
        await attempt(key, `select * from ad_hoc_sender where id = '${sender.id}'`),
        `the sender of its own stop ${when}`,
      ).toEqual({ rows: [] });
      if (when === 'before the count') {
        await routes.admin.query(insertRecordSql(arranged, { stopId: stop.id, hub: HUB_A }));
      }
    }
    // The vendor's run: the same for a request of a registered vendor.
    expect(
      await attempt(
        rider(vendorsRun.rider.id, CONFIRM),
        `select id from pickup_request where id = '${first(vendorsRun).requestId}'`,
      ),
    ).toEqual({ rows: [] });
    // No other key, rider or kind of caller has a way to them either.
    // (Staff of the pickup and vendor domains read a sender by the table's own policy, and are not the question here.)
    for (const context of [rider(arranged.rider.id, RUN), staff('finance.read'), vendor()]) {
      expect(
        idsOf(await attempt(context, `select id from ad_hoc_sender where id = '${sender.id}'`)),
      ).toEqual([]);
    }
  });

  // Break caught: the direction of the handshake read for the wrong stop, caller or key, or given as more than a word.
  it('answers the direction of the handshake for the stop the rider has arrived at, and refuses every other caller', async () => {
    const { arranged, stop } = await individual();
    const vendorsRun = await run();
    const other = await arrangedRider(routes.kit, routes.admin);
    const ask = (id: string) => `select melarc.collection_handshake_type('${id}'::uuid) as type`;
    const typeOf = (result: Result): unknown =>
      'rows' in result ? (result.rows[0] as { type: string } | undefined)?.type : codeOf(result);
    expect(typeOf(await attempt(rider(arranged.rider.id, CONFIRM), ask(stop.id)))).toBe(
      'SENDER_SMS_RIDER_ENTERED',
    );
    expect(
      typeOf(await attempt(rider(vendorsRun.rider.id, CONFIRM), ask(first(vendorsRun).id))),
    ).toBe('VENDOR_ENTERED_RIDER_DISPLAYED');
    // Another rider's stop, another key, a stop not arrived at, a staff or vendor caller, and no stop at all.
    expect(typeOf(await attempt(rider(other.id, CONFIRM), ask(stop.id)))).toBe('42501');
    expect(typeOf(await attempt(rider(arranged.rider.id, RUN), ask(stop.id)))).toBe('42501');
    expect(
      typeOf(
        await attempt(rider(vendorsRun.rider.id, CONFIRM), ask(vendorsRun.stops[1]?.id ?? '')),
      ),
    ).toBe('42501');
    expect(typeOf(await attempt(staff(CONFIRM), ask(stop.id)))).toBe('42501');
    expect(typeOf(await attempt(vendor(), ask(stop.id)))).toBe('42501');
    expect(typeOf(await attempt(rider(arranged.rider.id, CONFIRM), ask(randomUUID())))).toBe(
      '42501',
    );
    expect(
      typeOf(
        await attempt(
          rider(arranged.rider.id, CONFIRM),
          `select melarc.collection_handshake_type(null) as type`,
        ),
      ),
    ).toBe('22023');
  });
});

/**
 * A transaction of the runtime login with a security context, left open after `work` until `release()`: the other writer meets what it holds. `ready`
 * is the server process holding it, once `work` is done; a failure of `work` ends `ready` too, so that a test never waits for nothing.
 */
function held(
  context: SecurityContext,
  work: (statement: (text: string) => Promise<unknown>) => Promise<void>,
) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let announce: (pid: number) => void = () => undefined;
  let fail: (reason: unknown) => void = () => undefined;
  const ready = new Promise<number>((resolve, reject) => {
    announce = resolve;
    fail = reject;
  });
  const done = routes.built.service.transactionWithContext(context, async (tx) => {
    try {
      const pid = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0] as {
        pid: number;
      };
      await work((text) => tx.execute(sql.raw(text)));
      announce(pid.pid);
    } catch (error) {
      fail(error);
      throw error;
    }
    await gate;
  });
  return { ready, release, done };
}

/**
 * An individual sender's request, run and stop for the rider of `arranged`, the stop at `stopState`; `arranged` is a one-stop run of a vendor's request that the
 * sender's run stands beside. With `like`, the run is made for the rider of that earlier arrangement (a rider with two individual senders to count); with
 * `sharing`, the request names that sender instead of a new one (two requests of one provisional sender).
 */
async function individual(
  state: 'PROVISIONAL' | 'REUSABLE' = 'PROVISIONAL',
  stopState: 'ARRIVED' | 'PENDING' = 'ARRIVED',
  like?: ArrangedRun,
  sharing?: { readonly id: string },
) {
  const arranged = like ?? (await run({ stops: 1, stopStates: [stopState] }));
  const sender = sharing ?? (await insertAdHocSender(routes.admin, { state }));
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
  const manifest = await insertManifest(
    routes.admin,
    manifestRow(HUB_A, {
      state: 'IN_PROGRESS',
      serviceDate: days.today,
      assignedRiderId: arranged.rider.id,
    }),
  );
  const stop = await insertStop(
    routes.admin,
    stopRow(manifest, request.id, 1, {
      state: stopState,
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
  return { arranged, sender, request, stop };
}

describe('the promotion of an individual sender (AC-SLICE-001-28)', () => {
  const promoteDirectly = (id: string, state = 'REUSABLE') =>
    `update ad_hoc_sender set state = '${state}' where id = '${id}' returning id`;
  const promoteSql = (stopId: string) =>
    `select melarc.promote_collected_sender('${stopId}'::uuid) as sender_id`;
  const outcomeOf = (result: Result): unknown =>
    'rows' in result
      ? (result.rows[0] as { sender_id: string | null } | undefined)?.sender_id
      : codeOf(result);
  const countFor = async (arranged: ArrangedRun, stopId: string): Promise<void> => {
    await routes.admin.query(insertRecordSql(arranged, { stopId }));
  };

  // Break caught: arrival alone promoting a provisional sender (the review of 4 November 2026): a direct update under the key, after the arrival and
  // before any count, and again after the count, is refused and changes nothing; only the operation promotes, and it refuses a stop with no count.
  it('is not made by arrival, nor by any statement of the key: only by the operation, after the rider’s count', async () => {
    const { arranged, sender, stop } = await individual();
    const key = rider(arranged.rider.id, CONFIRM);
    // Before the count: a direct update is refused (the login holds no update on a sender); the operation refuses too.
    expect(codeOf(await attempt(key, promoteDirectly(sender.id)))).toBe('42501');
    expect(codeOf(await attempt(key, promoteSql(stop.id)))).toBe('23514');
    expect(await senderState(sender.id)).toBe('PROVISIONAL');
    // After the count: a direct update is still refused; the operation promotes it, once.
    await countFor(arranged, stop.id);
    expect(codeOf(await attempt(key, promoteDirectly(sender.id)))).toBe('42501');
    expect(await senderState(sender.id)).toBe('PROVISIONAL');
    expect(outcomeOf(await attempt(key, promoteSql(stop.id)))).toBe(sender.id);
    expect(await senderState(sender.id)).toBe('REUSABLE');
    expect(outcomeOf(await attempt(key, promoteSql(stop.id)))).toBeNull();
  });

  // Break caught: the operation open to another rider, another key, a staff or vendor caller, or a stop that is not the caller's.
  it('is the counting key’s, for the rider that counted, and nobody else’s', async () => {
    const { arranged, sender, stop } = await individual();
    const other = await arrangedRider(routes.kit, routes.admin);
    await countFor(arranged, stop.id);
    for (const context of [
      rider(other.id, CONFIRM),
      rider(arranged.rider.id, RUN),
      staff(CONFIRM),
      vendor(),
    ]) {
      expect(codeOf(await attempt(context, promoteSql(stop.id)))).toBe('42501');
    }
    expect(codeOf(await attempt(rider(arranged.rider.id, CONFIRM), promoteSql(randomUUID())))).toBe(
      '42501',
    );
    expect(await senderState(sender.id)).toBe('PROVISIONAL');
    // A record made for the stop by another rider is not the caller's count.
    const stranger = await individual();
    await routes.admin.query(
      insertRecordSql(stranger.arranged, { stopId: stranger.stop.id, riderId: other.id }),
    );
    expect(
      codeOf(
        await attempt(rider(stranger.arranged.rider.id, CONFIRM), promoteSql(stranger.stop.id)),
      ),
    ).toBe('23514');
    expect(await senderState(stranger.sender.id)).toBe('PROVISIONAL');
  });

  // Break caught: a vendor's request promoting anybody, or a sender already reusable being written again.
  it('promotes nobody for a vendor’s request and leaves a reusable sender as it is', async () => {
    const vendors = await run({ stops: 1, stopStates: ['ARRIVED'] });
    await countFor(vendors, first(vendors).id);
    expect(
      outcomeOf(await attempt(rider(vendors.rider.id, CONFIRM), promoteSql(first(vendors).id))),
    ).toBeNull();
    const reusable = await individual('REUSABLE');
    await countFor(reusable.arranged, reusable.stop.id);
    expect(
      outcomeOf(
        await attempt(rider(reusable.arranged.rider.id, CONFIRM), promoteSql(reusable.stop.id)),
      ),
    ).toBeNull();
  });

  it('is never undone, by the key or by anyone', async () => {
    const { arranged, sender } = await individual('REUSABLE');
    expect(
      codeOf(
        await attempt(rider(arranged.rider.id, CONFIRM), promoteDirectly(sender.id, 'PROVISIONAL')),
      ),
    ).toBe('42501');
    await expect(
      routes.admin.query(`update ad_hoc_sender set state = 'PROVISIONAL' where id = $1`, [
        sender.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('is not made for a sender whose stop has not been arrived at', async () => {
    const { arranged, sender, stop } = await individual('PROVISIONAL', 'PENDING');
    expect(codeOf(await attempt(rider(arranged.rider.id, CONFIRM), promoteSql(stop.id)))).toBe(
      '23514',
    );
    expect(await senderState(sender.id)).toBe('PROVISIONAL');
  });

  // Break caught: the login keeping a right to update a sender, which every statement of the runtime under any key would then have to be held from.
  it('is not a right of the runtime login: it holds no update on a sender, in any column', async () => {
    const can = async (query: string): Promise<boolean | undefined> =>
      (await routes.rows<{ ok: boolean }>(query))[0]?.ok;
    expect(
      await can(
        `select has_table_privilege('melarc_api_runtime', 'ad_hoc_sender', 'UPDATE') as ok`,
      ),
    ).toBe(false);
    expect(
      await can(
        `select has_column_privilege('melarc_api_runtime', 'ad_hoc_sender', 'state', 'UPDATE') as ok`,
      ),
    ).toBe(false);
  });

  // Break caught (the second review of 4 November 2026): the promotion made without its event (when the application had to write the event, a caller of
  // the operation could promote and say nothing), an event with other facts than the change (another sender, stop, hub or actor), or a second event for
  // the same sender. The operation writes the event in the change it records, from the rows it changed.
  it('writes the event of the promotion itself, with the facts of the change, once', async () => {
    const { arranged, sender, request, stop } = await individual();
    const key = rider(arranged.rider.id, CONFIRM);
    await countFor(arranged, stop.id);
    expect(await promotionEventsOf(sender.id)).toEqual([]);
    expect(outcomeOf(await attempt(key, promoteSql(stop.id)))).toBe(sender.id);

    const written = await promotionEventsOf(sender.id);
    expect(written).toHaveLength(1);
    // The facts the application's own writer records for the same change, field by field (the identifier and the instants are each writer's own).
    const expected = buildAuditRecord(
      {
        code: 'pickup.sender.promoted',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'AdHocSender', id: sender.id },
        responsibleHubId: HUB_A,
        previousState: 'PROVISIONAL',
        resultingState: 'REUSABLE',
        relatedIds: { pickup_stop_id: stop.id, pickup_request_id: request.id },
      },
      key,
      new Date(),
      randomUUID(),
    );
    expect(written[0]).toMatchObject({
      event_code: expected.eventCode,
      actor_type: expected.actorType,
      actor_id: expected.actorId,
      actor_bundle: expected.actorBundle,
      surface_context: expected.surfaceContext,
      device_context: expected.deviceContext,
      vendor_organization_id: expected.vendorOrganizationId,
      responsible_hub_id: expected.responsibleHubId,
      object_type: expected.objectType,
      object_id: expected.objectId,
      correlation_id: expected.correlationId,
      previous_state: expected.previousState,
      resulting_state: expected.resultingState,
      reason_code: expected.reasonCode,
      reason_label: expected.reasonLabel,
      note: expected.note,
      approval_id: expected.approvalId,
      before_after: expected.beforeAfter,
      related_ids: expected.relatedIds,
      detail: expected.detail,
      outcome: expected.outcome,
      enhanced: expected.enhanced,
      serialisation_version: expected.serialisationVersion,
    });

    // A second call, a vendor's request and a sender already reusable promote nobody, so they write nothing: by the sender and by the stop cited.
    expect(outcomeOf(await attempt(key, promoteSql(stop.id)))).toBeNull();
    expect(await promotionEventsOf(sender.id)).toHaveLength(1);
    expect(await promotionEventsCiting(stop.id)).toHaveLength(1);
    const vendors = await run({ stops: 1, stopStates: ['ARRIVED'] });
    await countFor(vendors, first(vendors).id);
    expect(
      outcomeOf(await attempt(rider(vendors.rider.id, CONFIRM), promoteSql(first(vendors).id))),
    ).toBeNull();
    expect(await promotionEventsCiting(first(vendors).id)).toEqual([]);
    const reusable = await individual('REUSABLE');
    await countFor(reusable.arranged, reusable.stop.id);
    expect(
      outcomeOf(
        await attempt(rider(reusable.arranged.rider.id, CONFIRM), promoteSql(reusable.stop.id)),
      ),
    ).toBeNull();
    expect(await promotionEventsOf(reusable.sender.id)).toEqual([]);
    expect(await promotionEventsCiting(reusable.stop.id)).toEqual([]);
  });

  // Break caught (the second review of 4 November 2026): the ledger's arm for the promotion trusting a marker that any statement of the runtime could set
  // (`melarc.promoted_sender`) and a count the rider really made. A rider with a genuine count could then write the event for a sender it never
  // promoted, name another counted stop in it, or write it again. The event is the operation's own now and no statement of the key writes it.
  it('cannot be manufactured by the counting key: not by a marker, not for another counted stop, not a second time', async () => {
    const one = await individual();
    const two = await individual('PROVISIONAL', 'ARRIVED', one.arranged);
    const key = rider(one.arranged.rider.id, CONFIRM);
    await countFor(one.arranged, one.stop.id);
    await countFor(one.arranged, two.stop.id);
    const forged = (object: string, stopId: string, marker: string | null): string[] => [
      ...(marker === null
        ? []
        : [`select set_config('melarc.promoted_sender', '${marker}', true)`]),
      promotionEventSql(one.arranged.rider.id, object, JSON.stringify({ pickup_stop_id: stopId })),
    ];

    // A sender the operation never promoted: the event is refused whatever marker the statement sets and whichever counted stop it cites.
    for (const cited of [one.stop.id, two.stop.id]) {
      expect(
        codeOf(await attemptAll(key, forged(two.sender.id, cited, two.sender.id))),
        `an event for a sender never promoted, citing ${cited}`,
      ).toBe('42501');
    }
    expect(await senderState(two.sender.id)).toBe('PROVISIONAL');
    expect(await promotionEventsOf(two.sender.id)).toEqual([]);
    expect(await promotionEventsCiting(one.stop.id)).toEqual([]);
    expect(await promotionEventsCiting(two.stop.id)).toEqual([]);

    // The first promotion is the operation's, and its event the only one: the key cannot write it again, with the marker or without it, or in the
    // name of the other counted stop.
    expect(outcomeOf(await attempt(key, promoteSql(one.stop.id)))).toBe(one.sender.id);
    expect(await promotionEventsOf(one.sender.id)).toHaveLength(1);
    expect(await promotionEventsCiting(one.stop.id)).toHaveLength(1);
    for (const again of [
      forged(one.sender.id, one.stop.id, one.sender.id),
      forged(one.sender.id, one.stop.id, null),
      forged(one.sender.id, two.stop.id, one.sender.id),
    ]) {
      expect(codeOf(await attemptAll(key, again))).toBe('42501');
    }
    // The other counted stop's sender, with the first one promoted: the first promotion lends its event to nobody.
    expect(codeOf(await attemptAll(key, forged(two.sender.id, one.stop.id, two.sender.id)))).toBe(
      '42501',
    );
    expect(await promotionEventsOf(one.sender.id)).toHaveLength(1);
    expect(await promotionEventsCiting(one.stop.id)).toHaveLength(1);
    expect(await promotionEventsOf(two.sender.id)).toEqual([]);
    expect(await promotionEventsCiting(two.stop.id)).toEqual([]);
    expect(await senderState(two.sender.id)).toBe('PROVISIONAL');

    // The second stop's promotion is its own event, citing it.
    expect(outcomeOf(await attempt(key, promoteSql(two.stop.id)))).toBe(two.sender.id);
    const second = await promotionEventsOf(two.sender.id);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      related_ids: { pickup_stop_id: two.stop.id, pickup_request_id: two.request.id },
    });
    expect(await promotionEventsOf(one.sender.id)).toHaveLength(1);
  });

  // Break caught: the promotion kept when its event cannot be written (two writes where one change was meant: a failure of the second would leave a sender
  // promoted and unrecorded), or the event kept when the promotion is undone.
  it('is one change with its event: a ledger that refuses the event leaves the sender provisional, and the retry makes both', async () => {
    const { arranged, sender, stop } = await individual();
    const key = rider(arranged.rider.id, CONFIRM);
    await countFor(arranged, stop.id);
    await routes.admin.query(`
      create function fixture_refuse_promotion_event() returns trigger language plpgsql as $$
      begin
        if new.event_code = 'pickup.sender.promoted' then
          raise exception 'fixture: the ledger refuses this event' using errcode = '55000';
        end if;
        return new;
      end $$`);
    await routes.admin.query(`
      create trigger fixture_refuse_promotion_event before insert on audit_event
        for each row execute function fixture_refuse_promotion_event()`);
    try {
      expect(codeOf(await attempt(key, promoteSql(stop.id)))).toBe('55000');
      expect(await senderState(sender.id)).toBe('PROVISIONAL');
      expect(await promotionEventsOf(sender.id)).toEqual([]);
    } finally {
      await routes.admin.query(`drop trigger fixture_refuse_promotion_event on audit_event`);
      await routes.admin.query(`drop function fixture_refuse_promotion_event()`);
    }
    expect(outcomeOf(await attempt(key, promoteSql(stop.id)))).toBe(sender.id);
    expect(await senderState(sender.id)).toBe('REUSABLE');
    expect(await promotionEventsOf(sender.id)).toHaveLength(1);
  });

  // Break caught (the second review of 4 November 2026, "emit the promotion twice", under concurrency): the promotion judged before the sender is locked, so
  // that two counted stops naming one provisional sender, promoted at the same moment, each find it provisional and each write the event. The change
  // is one conditional update, so the second promotion waits for the first, finds the sender reusable and writes nothing.
  it('writes one event when two counted stops name one provisional sender and are promoted by two transactions at once', async () => {
    const one = await individual();
    const two = await individual('PROVISIONAL', 'ARRIVED', one.arranged, one.sender);
    const key = rider(one.arranged.rider.id, CONFIRM);
    await countFor(one.arranged, one.stop.id);
    await countFor(one.arranged, two.stop.id);
    const promoting = held(key, async (statement) => {
      await statement(promoteSql(one.stop.id));
    });
    try {
      const pid = await promoting.ready;
      const second = attempt(key, promoteSql(two.stop.id));
      await waitUntilBlockedBy(routes.admin, pid, 'the second promotion', second);
      promoting.release();
      await promoting.done;
      expect(outcomeOf(await second)).toBeNull();
    } finally {
      promoting.release();
      await promoting.done.catch(() => undefined);
    }
    expect(await senderState(one.sender.id)).toBe('REUSABLE');
    expect(await promotionEventsOf(one.sender.id)).toHaveLength(1);
    expect(await promotionEventsCiting(one.stop.id)).toHaveLength(1);
    expect(await promotionEventsCiting(two.stop.id)).toEqual([]);
  });
});

describe('the ledger takes the event of a count and the promotion with the facts of the rows', () => {
  /**
   * An event of the ledger as the counting key would send it, with every member that the arm of a count reads. OB-S1-54: the count has its own event,
   * `pickup.collection.recorded`, whose object is the record, and `pickup.stop.collected` and `pickup.stop.partially_collected` are the handshake's (they
   * say that the stop closed), so the counting key cannot write them at all.
   */
  interface CountEvent {
    readonly actorId: string;
    readonly code: string;
    readonly objectType: string;
    readonly objectId: string;
    readonly hub: string | null;
    readonly previous: string | null;
    readonly resulting: string | null;
    readonly reasonCode: string | null;
    readonly reasonLabel: string | null;
    readonly note: string | null;
    readonly related: Record<string, unknown> | null;
    readonly detail: Record<string, unknown> | null;
    readonly enhanced: boolean;
    /** The transaction's correlation id is the arm's to judge; left out, the context's own. */
    readonly correlation?: string;
    /** Columns the arm leaves no room for, each with the SQL expression a direct writer gives it (the event of a count has none of them). */
    readonly also?: Readonly<Record<string, string>>;
  }
  const text = (value: string | null): string =>
    value === null ? 'null' : `'${value.replaceAll("'", "''")}'`;
  const json = (value: Record<string, unknown> | null): string =>
    value === null ? 'null' : `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  const eventSql = (event: CountEvent): string =>
    `insert into audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, responsible_hub_id, object_type, object_id,
                             correlation_id, previous_state, resulting_state, reason_code, reason_label, note, related_ids, detail, outcome,
                             enhanced, serialisation_version${Object.keys(event.also ?? {})
                               .map((column) => `, ${column}`)
                               .join('')})
     values (gen_random_uuid(), ${text(event.code)}, now(), 'RIDER', '${event.actorId}'::uuid, 'RIDER_ANDROID',
             ${event.hub === null ? 'null' : `'${event.hub}'::uuid`}, ${text(event.objectType)}, '${event.objectId}'::uuid,
             ${text(event.correlation ?? 'collection-record-policies')}, ${text(event.previous)}, ${text(event.resulting)}, ${text(event.reasonCode)}, ${text(event.reasonLabel)},
             ${text(event.note)}, ${json(event.related)}, ${event.detail === null ? `'{}'::jsonb` : json(event.detail)}, 'SUCCEEDED', ${String(event.enhanced)}, 1${Object.values(
               event.also ?? {},
             )
               .map((value) => `, ${value}`)
               .join('')})`;

  /** A record the administrator made for a run (the count is the fixture's; what is under test is the ledger's judgement of the event) and its stop. */
  const counted = async (collected: number) => {
    const arranged = await run();
    const { rows } = await routes.admin.query<{ id: string }>(
      insertRecordSql(arranged, { collected }),
    );
    return { arranged, recordId: rows[0]?.id ?? '', stopId: first(arranged).id };
  };
  /** The event the application writes for a stored record: every member from the rows of the record and of its stop, as the ledger's arm requires them. */
  const genuineEventOf = async (recordId: string): Promise<CountEvent> => {
    const [row] = await routes.rows<{
      id: string;
      pickup_stop_id: string;
      responsible_hub_id: string;
      declared_count: number;
      collected_count: number;
      variance: string;
      variance_reason_snapshot: { reason_code: string; label: string } | null;
      flagged: boolean;
      handshake_type: string;
      recorded_by: string;
      pickup_manifest_id: string;
      pickup_request_id: string;
    }>(
      `select c.id, c.pickup_stop_id, c.responsible_hub_id, c.declared_count, c.collected_count, c.variance, c.variance_reason_snapshot,
              (c.office_notified_at is not null) as flagged, c.handshake_type, c.recorded_by, s.pickup_manifest_id, s.pickup_request_id
         from collection_record c join pickup_stop s on s.id = c.pickup_stop_id where c.id = $1`,
      [recordId],
    );
    if (row === undefined) throw new Error('No such record');
    return {
      actorId: row.recorded_by,
      code: 'pickup.collection.recorded',
      objectType: 'CollectionRecord',
      objectId: row.id,
      hub: row.responsible_hub_id,
      previous: 'ARRIVED',
      resulting: 'ARRIVED',
      reasonCode: row.variance_reason_snapshot?.reason_code ?? null,
      reasonLabel: row.variance_reason_snapshot?.label ?? null,
      note: null,
      related: {
        pickup_stop_id: row.pickup_stop_id,
        pickup_manifest_id: row.pickup_manifest_id,
        pickup_request_id: row.pickup_request_id,
        rider_id: row.recorded_by,
      },
      detail: {
        declared_count: row.declared_count,
        collected_count: row.collected_count,
        variance: row.variance,
        office_notified: row.flagged,
        handshake_type: row.handshake_type,
      },
      enhanced: false,
    };
  };
  const eventsOf = (recordId: string): Promise<{ event_code: string }[]> =>
    routes.rows<{ event_code: string }>(
      `select event_code from audit_event where object_id = $1 and event_code like 'pickup.%'`,
      [recordId],
    );

  // Break caught: the arm for the count losing its place (the rider's own act refused), or admitting only one variance. The same event serves a clean
  // count and a short one; the difference is in the facts it carries.
  it('takes the event of a count, the same event for a clean count and a short one, with the facts of the record it records', async () => {
    for (const collected of [3, 2]) {
      const { arranged, recordId } = await counted(collected);
      const event = await genuineEventOf(recordId);
      expect(event).toMatchObject({
        code: 'pickup.collection.recorded',
        objectType: 'CollectionRecord',
        previous: 'ARRIVED',
        resulting: 'ARRIVED',
        note: null,
      });
      expect(event.detail).toMatchObject({ variance: collected === 3 ? 'MATCH' : 'SHORT' });
      expect(await attempt(rider(arranged.rider.id, CONFIRM), eventSql(event))).toEqual({
        rows: [],
      });
      expect(await eventsOf(recordId)).toEqual([{ event_code: 'pickup.collection.recorded' }]);
    }
  });

  interface Others {
    readonly riderId: string;
    readonly recordId: string;
  }
  interface Deviation {
    readonly only?: 'MATCH' | 'SHORT';
    readonly make: (genuine: CountEvent, others: Others) => CountEvent;
  }
  const withRelated = (event: CountEvent, over: Record<string, unknown>): CountEvent => ({
    ...event,
    related: { ...event.related, ...over },
  });
  const withDetail = (event: CountEvent, over: Record<string, unknown>): CountEvent => ({
    ...event,
    detail: { ...event.detail, ...over },
  });
  const DEVIATIONS: readonly (readonly [string, Deviation])[] = [
    ['the code of the stop’s close', { make: (e) => ({ ...e, code: 'pickup.stop.collected' }) }],
    [
      'the code of the stop’s partial close',
      { make: (e) => ({ ...e, code: 'pickup.stop.partially_collected' }) },
    ],
    [
      'the record as the object of another type',
      { make: (e) => ({ ...e, objectType: 'PickupStop' }) },
    ],
    [
      'the stop as its object',
      {
        make: (e) => ({
          ...e,
          objectType: 'PickupStop',
          objectId: String(e.related?.pickup_stop_id),
        }),
      },
    ],
    ['another record as its object', { make: (e, o) => ({ ...e, objectId: o.recordId }) }],
    [
      'a record that does not exist as its object',
      { make: (e) => ({ ...e, objectId: randomUUID() }) },
    ],
    ['another hub', { make: (e) => ({ ...e, hub: HUB_B }) }],
    ['no hub', { make: (e) => ({ ...e, hub: null }) }],
    ['another state to start from', { make: (e) => ({ ...e, previous: 'PENDING' }) }],
    ['a stop that is closed by it', { make: (e) => ({ ...e, resulting: 'COLLECTED' }) }],
    ['no states', { make: (e) => ({ ...e, previous: null, resulting: null }) }],
    [
      'a note (the rider’s note is on the record, not in the ledger)',
      { make: (e) => ({ ...e, note: 'Two boxes are still in the back room' }) },
    ],
    ['another stop', { make: (e) => withRelated(e, { pickup_stop_id: randomUUID() }) }],
    ['another rider named', { make: (e, o) => withRelated(e, { rider_id: o.riderId }) }],
    ['another manifest', { make: (e) => withRelated(e, { pickup_manifest_id: randomUUID() }) }],
    ['another request', { make: (e) => withRelated(e, { pickup_request_id: randomUUID() }) }],
    [
      'a related identifier of its own',
      { make: (e) => withRelated(e, { collection_record_id: e.objectId }) },
    ],
    [
      'a related identifier left out',
      {
        make: (e) => {
          const related = { ...e.related };
          delete related.pickup_request_id;
          return { ...e, related };
        },
      },
    ],
    ['no related identifiers', { make: (e) => ({ ...e, related: null }) }],
    ['another declared count', { make: (e) => withDetail(e, { declared_count: 9 }) }],
    ['another collected count', { make: (e) => withDetail(e, { collected_count: 1 }) }],
    [
      'another variance',
      {
        make: (e) =>
          withDetail(e, { variance: e.detail?.variance === 'MATCH' ? 'SHORT' : 'MATCH' }),
      },
    ],
    [
      'a flag the record does not carry',
      { make: (e) => withDetail(e, { office_notified: e.detail?.office_notified !== true }) },
    ],
    [
      'another direction of the handshake',
      {
        make: (e) =>
          withDetail(e, {
            handshake_type:
              e.detail?.handshake_type === 'VENDOR_ENTERED_RIDER_DISPLAYED'
                ? 'SENDER_SMS_RIDER_ENTERED'
                : 'VENDOR_ENTERED_RIDER_DISPLAYED',
          }),
      },
    ],
    ['a fact of its own in the detail', { make: (e) => withDetail(e, { sender_promoted: true }) }],
    [
      'the rider’s note in the detail',
      { make: (e) => withDetail(e, { variance_note: 'Two boxes are still in the back room' }) },
    ],
    ['no detail', { make: (e) => ({ ...e, detail: null }) }],
    ['the enhanced tier', { make: (e) => ({ ...e, enhanced: true }) }],
    [
      'a diff of its own',
      { make: (e) => ({ ...e, also: { before_after: `'{"price": "0"}'::jsonb` } }) },
    ],
    [
      'a device context of its own',
      { make: (e) => ({ ...e, also: { device_context: `'{"model": "x"}'::jsonb` } }) },
    ],
    [
      'a bundle of its own',
      { make: (e) => ({ ...e, also: { actor_bundle: `'Platform Admin'` } }) },
    ],
    [
      'an organization of its own',
      {
        make: (e) => ({
          ...e,
          also: { vendor_organization_id: `'${vendorA.row.organizationId}'::uuid` },
        }),
      },
    ],
    [
      'an approval of its own',
      { make: (e) => ({ ...e, also: { approval_id: 'gen_random_uuid()' } }) },
    ],
    [
      'a correlation id of its own',
      { make: (e) => ({ ...e, correlation: 'a-chosen-correlation-id' }) },
    ],
    [
      'a reason on a clean count',
      {
        only: 'MATCH',
        make: (e) => ({
          ...e,
          reasonCode: 'SOME_PARCELS_NOT_READY',
          reasonLabel: 'Some parcels not ready',
        }),
      },
    ],
    [
      'no reason on a short count',
      { only: 'SHORT', make: (e) => ({ ...e, reasonCode: null, reasonLabel: null }) },
    ],
    [
      'another reason than the record’s',
      {
        only: 'SHORT',
        make: (e) => ({
          ...e,
          reasonCode: 'BOOKED_COUNT_WRONG',
          reasonLabel: 'Booked count wrong',
        }),
      },
    ],
    [
      'another reason code with the record’s label',
      { only: 'SHORT', make: (e) => ({ ...e, reasonCode: 'BOOKED_COUNT_WRONG' }) },
    ],
    [
      'a label of its own for the record’s reason',
      { only: 'SHORT', make: (e) => ({ ...e, reasonLabel: 'Whatever the rider likes' }) },
    ],
  ];

  // Break caught (OB-S1-54: "bind the ledger checks to the stored facts"): the arm checking that some record of the rider exists and not that the event
  // says what that record says. Each member is changed on its own with the rest right, for a clean count and for a short one, as the real counting
  // rider; the genuine event is then accepted by the same writer, so none of the refusals is the key's, the actor's or the record's.
  it.each(['MATCH', 'SHORT'] as const)(
    'refuses, member by member, an event that differs from the stored record of a %s count, and takes the genuine one',
    async (variance) => {
      const { arranged, recordId } = await counted(variance === 'MATCH' ? 3 : 2);
      const other = await counted(2);
      const key = rider(arranged.rider.id, CONFIRM);
      const genuine = await genuineEventOf(recordId);
      for (const [what, deviation] of DEVIATIONS) {
        if (deviation.only !== undefined && deviation.only !== variance) continue;
        expect(
          codeOf(
            await attempt(
              key,
              eventSql(
                deviation.make(genuine, {
                  riderId: other.arranged.rider.id,
                  recordId: other.recordId,
                }),
              ),
            ),
          ),
          what,
        ).toBe('42501');
      }
      expect(await eventsOf(recordId)).toEqual([]);
      expect(await attempt(key, eventSql(genuine))).toEqual({ rows: [] });
      expect(await eventsOf(recordId)).toEqual([{ event_code: 'pickup.collection.recorded' }]);
    },
  );

  // Break caught: the arm judging the event against the record and not against its stop: the event of a count says the stop is still `ARRIVED`, and once
  // the handshake has closed the stop (S1.27; here the administrator does what its key will do) a late event would say it of a closed stop.
  it('refuses the event of a count once the stop has left ARRIVED, whatever the event says of its states', async () => {
    const { arranged, recordId, stopId } = await counted(3);
    const genuine = await genuineEventOf(recordId);
    await routes.admin.query(
      `update pickup_stop set state = 'COLLECTED', resolved_at = now() where id = $1`,
      [stopId],
    );
    expect(codeOf(await attempt(rider(arranged.rider.id, CONFIRM), eventSql(genuine)))).toBe(
      '42501',
    );
    expect(await eventsOf(recordId)).toEqual([]);
  });

  // Break caught: the arm admitting the event to a rider that did not count, to another key of the rider, or to any other kind of caller, or letting a
  // rider name another as the actor.
  it('takes the event from the counting key of the rider that counted the record, and from nobody else', async () => {
    const { arranged, recordId } = await counted(2);
    const other = await arrangedRider(routes.kit, routes.admin);
    const genuine = await genuineEventOf(recordId);
    const byOther = { ...genuine, actorId: other.id };
    expect(codeOf(await attempt(rider(other.id, CONFIRM), eventSql(genuine)))).toBe('42501');
    expect(codeOf(await attempt(rider(other.id, CONFIRM), eventSql(byOther)))).toBe('42501');
    expect(codeOf(await attempt(rider(arranged.rider.id, RUN), eventSql(genuine)))).toBe('42501');
    expect(codeOf(await attempt(rider(arranged.rider.id, 'pickup.read'), eventSql(genuine)))).toBe(
      '42501',
    );
    expect(codeOf(await attempt(staff(CONFIRM), eventSql(genuine)))).toBe('42501');
    expect(codeOf(await attempt(vendor(), eventSql(genuine)))).toBe('42501');
    expect(await eventsOf(recordId)).toEqual([]);
    expect(await attempt(rider(arranged.rider.id, CONFIRM), eventSql(genuine))).toEqual({
      rows: [],
    });
  });

  // Break caught (OB-S1-54): the counting key still admitted to `pickup.stop.collected` and `pickup.stop.partially_collected`, which say that the stop
  // closed. An abandoned handshake would then read to an audit consumer as a completed collection. They are the handshake's (S1.27), so the key cannot
  // write them: not in the shape the count first gave them (the stop as the object, `ARRIVED` to `ARRIVED`), nor as the close they will describe.
  it('takes neither pickup.stop.collected nor pickup.stop.partially_collected from the counting key, whatever the facts', async () => {
    for (const collected of [3, 2]) {
      const { arranged, stopId } = await counted(collected);
      const key = rider(arranged.rider.id, CONFIRM);
      for (const code of ['pickup.stop.collected', 'pickup.stop.partially_collected']) {
        const asFirstBuilt: CountEvent = {
          actorId: arranged.rider.id,
          code,
          objectType: 'PickupStop',
          objectId: stopId,
          hub: HUB_A,
          previous: 'ARRIVED',
          resulting: 'ARRIVED',
          reasonCode: null,
          reasonLabel: null,
          note: null,
          related: null,
          detail: null,
          enhanced: false,
        };
        expect(codeOf(await attempt(key, eventSql(asFirstBuilt))), code).toBe('42501');
        expect(
          codeOf(
            await attempt(
              key,
              eventSql({
                ...asFirstBuilt,
                resulting: collected === 3 ? 'COLLECTED' : 'PARTIALLY_COLLECTED',
              }),
            ),
          ),
          code,
        ).toBe('42501');
      }
      expect(
        await routes.rows(
          `select 1 from audit_event where event_code in ('pickup.stop.collected', 'pickup.stop.partially_collected') and object_id = $1`,
          [stopId],
        ),
      ).toEqual([]);
    }
  });

  // Break caught (the second review of 4 November 2026): the ledger's arm for the promotion admitting a statement of the runtime login (a marker the
  // statement sets, a count the rider really made, the operation having run in the transaction). The event is the operation's own: the arm admits it to a
  // statement that runs as the owner, which is a statement inside the operation, and the key's own statements are refused whatever they say.
  it('takes pickup.sender.promoted from no statement of the runtime login: not with the operation run, the marker set, the stop counted, or the facts right', async () => {
    const { arranged, sender, stop } = await individual();
    await routes.admin.query(insertRecordSql(arranged, { stopId: stop.id }));
    const other = await arrangedRider(routes.kit, routes.admin);
    const promote = `select melarc.promote_collected_sender('${stop.id}'::uuid)`;
    const eventSql = (object: string, related: string | null, hub: string | null = HUB_A): string =>
      promotionEventSql(arranged.rider.id, object, related, hub);
    const cites = JSON.stringify({ pickup_stop_id: stop.id });
    const key = rider(arranged.rider.id, CONFIRM);
    const marked = `select set_config('melarc.promoted_sender', '${sender.id}', true)`;

    // Each refusal rolls its transaction back, so the sender is provisional for the next attempt and nothing is left in the ledger.
    // Nothing run, or only the marker: the facts are right and the stop is counted by this rider, and the event is refused.
    expect(codeOf(await attemptAll(key, [eventSql(sender.id, cites)]))).toBe('42501');
    expect(codeOf(await attemptAll(key, [marked, eventSql(sender.id, cites)]))).toBe('42501');
    // The operation run in the same transaction (it writes its own event; the key's second is refused, and takes the transaction with it).
    expect(codeOf(await attemptAll(key, [promote, eventSql(sender.id, cites)]))).toBe('42501');
    expect(codeOf(await attemptAll(key, [promote, marked, eventSql(sender.id, cites)]))).toBe(
      '42501',
    );
    // Other facts, with the marker set: another sender, no stop cited, a stop not counted, another hub.
    const stranger = await insertAdHocSender(routes.admin);
    const strangerMarked = `select set_config('melarc.promoted_sender', '${stranger.id}', true)`;
    expect(codeOf(await attemptAll(key, [strangerMarked, eventSql(stranger.id, cites)]))).toBe(
      '42501',
    );
    expect(codeOf(await attemptAll(key, [marked, eventSql(sender.id, null)]))).toBe('42501');
    expect(
      codeOf(
        await attemptAll(key, [
          marked,
          eventSql(sender.id, JSON.stringify({ pickup_stop_id: randomUUID() })),
        ]),
      ),
    ).toBe('42501');
    expect(codeOf(await attemptAll(key, [marked, eventSql(sender.id, cites, HUB_B)]))).toBe(
      '42501',
    );
    // Another key or another rider, with the marker set.
    expect(
      codeOf(await attemptAll(rider(arranged.rider.id, RUN), [marked, eventSql(sender.id, cites)])),
    ).toBe('42501');
    expect(
      codeOf(await attemptAll(rider(other.id, CONFIRM), [marked, eventSql(sender.id, cites)])),
    ).toBe('42501');
    expect(await senderState(sender.id)).toBe('PROVISIONAL');
    expect(await promotionEventsOf(sender.id)).toEqual([]);
    // The operation alone promotes, and writes the one event.
    expect(
      codeOf(await attempt(key, `select melarc.promote_collected_sender('${stop.id}'::uuid)`)),
    ).toBeUndefined();
    expect(await senderState(sender.id)).toBe('REUSABLE');
    expect(await promotionEventsOf(sender.id)).toHaveLength(1);
  });

  // Break caught: the arm that admits the promotion's event to the owner relying on `current_user` alone, or losing one of its own conditions (the key, the
  // recording rider, the counted stop it cites, its hub, the states, the object, the tier). No statement of the runtime login reaches the arm, so this is
  // shown where the arm is reached: a statement that runs as the owner, under a rider's context, which is the operation's.
  it('admits the event to a statement run as the owner only with the facts of the rows: the key, the rider that counted, the stop cited, its hub, the states', async () => {
    const { arranged, sender, stop } = await individual();
    await routes.admin.query(insertRecordSql(arranged, { stopId: stop.id }));
    const other = await arrangedRider(routes.kit, routes.admin);
    const cites = JSON.stringify({ pickup_stop_id: stop.id });
    const asOwner = async (context: SecurityContext, text: string): Promise<string> => {
      await routes.admin.query('begin');
      try {
        await routes.admin.query('set local role melarc_owner');
        for (const [name, value] of toContextSettings(context)) {
          await routes.admin.query('select set_config($1, $2, true)', [name, value]);
        }
        await routes.admin.query(text);
        return 'ran';
      } catch (error) {
        return serverErrorIn(error)?.code ?? 'other';
      } finally {
        await routes.admin.query('rollback');
      }
    };
    const key = rider(arranged.rider.id, CONFIRM);
    const event = promotionEventSql(arranged.rider.id, sender.id, cites);
    const changed = (from: string, to: string): string => {
      expect(event).toContain(from);
      return event.replace(from, to);
    };

    // The event of the operation: the counting key of the rider that counted, citing its counted stop, in its hub, for the change from provisional to reusable.
    expect(await asOwner(key, event)).toBe('ran');
    // Each condition of the arm on its own, the rest right.
    expect(await asOwner(rider(arranged.rider.id, RUN), event)).toBe('42501');
    expect(await asOwner(rider(other.id, CONFIRM), event)).toBe('42501');
    expect(
      await asOwner(rider(other.id, CONFIRM), promotionEventSql(other.id, sender.id, cites)),
    ).toBe('42501');
    expect(
      await asOwner(
        key,
        promotionEventSql(
          arranged.rider.id,
          sender.id,
          JSON.stringify({ pickup_stop_id: randomUUID() }),
        ),
      ),
    ).toBe('42501');
    expect(await asOwner(key, promotionEventSql(arranged.rider.id, sender.id, null))).toBe('42501');
    expect(await asOwner(key, promotionEventSql(arranged.rider.id, sender.id, cites, HUB_B))).toBe(
      '42501',
    );
    expect(await asOwner(key, promotionEventSql(arranged.rider.id, sender.id, cites, null))).toBe(
      '42501',
    );
    expect(await asOwner(key, changed(`'PROVISIONAL', 'REUSABLE'`, `'REUSABLE', 'REUSABLE'`))).toBe(
      '42501',
    );
    expect(
      await asOwner(key, changed(`'PROVISIONAL', 'REUSABLE'`, `'PROVISIONAL', 'PROVISIONAL'`)),
    ).toBe('42501');
    expect(await asOwner(key, changed(`'AdHocSender'`, `'PickupStop'`))).toBe('42501');
    expect(await asOwner(key, changed(`'pickup.sender.promoted'`, `'pickup.stop.collected'`))).toBe(
      '42501',
    );
    expect(await asOwner(key, changed(`'SUCCEEDED', false`, `'SUCCEEDED', true`))).toBe('42501');
    // Nothing of those attempts is kept.
    expect(await promotionEventsOf(sender.id)).toEqual([]);
  });
});

describe('no role is given what it has no use for', () => {
  // Break caught: a privilege on the record table for the notification worker, or the two operations of the count executable by anyone but the API's
  // runtime login (they act with the owner's rights).
  it('lets only the API runtime execute the two operations of the count, and the notification worker read no record', async () => {
    const worker = 'melarc_worker_cap_notification';
    const can = async (query: string): Promise<boolean | undefined> =>
      (await routes.rows<{ ok: boolean }>(query))[0]?.ok;
    for (const operation of [
      'melarc.collection_handshake_type(uuid)',
      'melarc.promote_collected_sender(uuid)',
    ]) {
      expect(
        await can(
          `select has_function_privilege('melarc_api_runtime', '${operation}', 'EXECUTE') as ok`,
        ),
      ).toBe(true);
      expect(
        await can(`select has_function_privilege('${worker}', '${operation}', 'EXECUTE') as ok`),
      ).toBe(false);
      expect(
        await can(`select has_function_privilege('public', '${operation}', 'EXECUTE') as ok`),
      ).toBe(false);
    }
    expect(
      await can(`select has_table_privilege('${worker}', 'collection_record', 'SELECT') as ok`),
    ).toBe(false);
    expect(
      await can(
        `select has_table_privilege('melarc_api_runtime', 'collection_record', 'UPDATE') as ok`,
      ),
    ).toBe(false);
    expect(
      await can(
        `select has_table_privilege('melarc_api_runtime', 'collection_record', 'DELETE') as ok`,
      ),
    ).toBe(false);
  });
});

describe('a record and a resolved stop never stand together, in either order of two real transactions', () => {
  const skipSql = (stopId: string): string =>
    `update pickup_stop set state = 'SKIPPED', resolved_at = now(),
            skip_snapshot = jsonb_build_object('reason_code', 'RUN_CUT_SHORT', 'label', 'x', 'skipped_at', now())
      where id = '${stopId}'`;
  const stateOf = async (stopId: string): Promise<string | undefined> =>
    (
      await routes.rows<{ state: string }>(`select state from pickup_stop where id = $1`, [stopId])
    )[0]?.state;
  const recordsOf = (stopId: string) =>
    routes.rows<{ id: string }>(`select id from collection_record where pickup_stop_id = $1`, [
      stopId,
    ]);

  // Break caught (the insert is first): the guard judging the stop without its lock, so that a skip which began after the insert read the stop can
  // commit beside it. A foreign-key check takes the stop's key-share lock, which an update of the stop's state does not conflict with: only the lock the
  // guard takes itself makes the two meet. Direct insert, not the service: the service's own lock is not what is under test.
  it('refuses a skip that waited for a direct insert that took the stop first, and leaves the stop arrived with its record', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const inserting = held(rider(arranged.rider.id, CONFIRM), async (statement) => {
      await statement(insertRecordSql(arranged, { returning: false }));
    });
    try {
      const pid = await inserting.ready;
      const skipping = attempt(staff('pickup.stop.skip'), skipSql(stop.id));
      await waitUntilBlockedBy(routes.admin, pid, 'the skip', skipping);
      inserting.release();
      await inserting.done;
      expect(codeOf(await skipping)).toBe('23514');
    } finally {
      inserting.release();
      await inserting.done.catch(() => undefined);
    }
    expect(await stateOf(stop.id)).toBe('ARRIVED');
    expect(await recordsOf(stop.id)).toHaveLength(1);
  });

  // Break caught (the skip is first): a direct insert that read the stop as arrived before the skip committed, and committed its record after it.
  it('refuses a direct insert that waited for a skip that took the stop first, and makes no record', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const skipping = held(staff('pickup.stop.skip'), async (statement) => {
      await statement(skipSql(stop.id));
    });
    try {
      const pid = await skipping.ready;
      const inserting = attempt(
        rider(arranged.rider.id, CONFIRM),
        insertRecordSql(arranged, { returning: false }),
      );
      await waitUntilBlockedBy(routes.admin, pid, 'the insert', inserting);
      skipping.release();
      await skipping.done;
      expect(codeOf(await inserting)).toBe('23514');
    } finally {
      skipping.release();
      await skipping.done.catch(() => undefined);
    }
    expect(await stateOf(stop.id)).toBe('SKIPPED');
    expect(await recordsOf(stop.id)).toEqual([]);
  });

  // Break caught: the same race with a writer that is not the skip operation (a recovery script, the failure report to come): the database holds it for
  // every writer, and a stop failed first refuses the record in the same way.
  it('refuses a direct insert that waited for a statement that failed the stop first', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(
        `update pickup_stop set state = 'FAILED', resolved_at = now(), failure_category = 'ACCESS_DENIED' where id = $1`,
        [stop.id],
      );
      const pid = Number(
        (await holder.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid,
      );
      const inserting = attempt(
        rider(arranged.rider.id, CONFIRM),
        insertRecordSql(arranged, { returning: false }),
      );
      await waitUntilBlockedBy(routes.admin, pid, 'the insert', inserting);
      await holder.query('commit');
      expect(codeOf(await inserting)).toBe('23514');
      expect(await stateOf(stop.id)).toBe('FAILED');
      expect(await recordsOf(stop.id)).toEqual([]);
    } finally {
      await holder.end();
    }
  });
});
