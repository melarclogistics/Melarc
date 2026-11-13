import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { guardReasonIn, serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { photoOf } from './support/evidence-photo.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { HUB_A, HUB_B } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.28, the photo of a failure at the database (migration `0083`): what `pickup_stop_evidence` and the stop's guard hold for **every** writer, whatever the application does.
 *
 * - **The link is the rider's act and the guard's judgement**: only `STORED` evidence of this very stop, captured by the rider as the proof of its collection and not yet attached,
 *   is attached, to a stop the rider has arrived at on a run in progress that is assigned to it; the writer names the record and the stop, and the hub, the rider and the moment are
 *   derived. **It is append-only**: no update and no delete, for the rider, the staff and the administrator.
 * - **Who reads**: the rider what it attached, the staff of the stop's hub under a key of the pickup domain; nobody else.
 * - **The stop's guard asks for the photo and the category** (D-A4): a failure whose reason requires a photo is refused without a link; a reason is refused under a category that
 *   is not the catalogue's for it (`reason=REASON_CATEGORY_MISMATCH`), for each of the eight reasons and each of the other three categories.
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
const CORRELATION = 'pickup-stop-evidence-policies';

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
const staff = (
  key: string,
  hubs: readonly string[],
  mode: 'SET' | 'ALL' = 'SET',
): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  sessionId: randomUUID(),
  surface: 'OPS_PORTAL',
  authorizationKey: key,
  hubScopeMode: mode,
  authorizedHubIds: mode === 'ALL' ? [] : [...hubs],
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
async function attempt(context: SecurityContext, text: string): Promise<Result> {
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
const refused = (result: Result, ...codes: string[]): void => {
  expect(result.code, JSON.stringify(result)).toBeDefined();
  expect(codes.length === 0 ? ['42501', '23514', '23503', '23505'] : codes).toContain(result.code);
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
    stopStates: ['ARRIVED', 'ARRIVED'],
    ...over,
  });
const stopAt = (arranged: ArrangedRun, index = 0): ArrangedRun['stops'][number] => {
  const stop = arranged.stops[index];
  if (stop === undefined) throw new Error('stop');
  return stop;
};

/** The attachment of a record to a stop: the two columns the writer is granted, and, where a test tries more, a third with its literal. */
const attachSql = (evidenceId: string, stopId: string, extra?: readonly [string, string]): string =>
  `insert into pickup_stop_evidence (evidence_id, pickup_stop_id${extra === undefined ? '' : `, ${extra[0]}`})
   values ('${evidenceId}', '${stopId}'${extra === undefined ? '' : `, ${extra[1]}`}) returning evidence_id`;
const linksOf = (stopId: string) =>
  routes.rows<{
    evidence_id: string;
    responsible_hub_id: string;
    attached_by_rider: string;
    attached_at: Date;
  }>(`select * from pickup_stop_evidence where pickup_stop_id = $1`, [stopId]);

/** Changes a stored fact of an evidence record, which its guard forbids to every writer: the guard and the version trigger are put aside for the one statement. */
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

describe('pickup_stop_evidence: the link is made by the rider and judged by the guard', () => {
  // Break caught: a link the rider cannot make for its own stored photo; a hub, a rider or a moment that is the writer's, not the stop's, the capturer's and the database's.
  it('lets the rider attach its stored photo of the stop it has arrived at, and derives the hub, the rider and the moment', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photo = await photoOf(routes, arranged.rider, stop.id);
    const before = Date.now();
    reached(await attempt(rider(arranged.rider.id), attachSql(photo.id, stop.id)));
    const [link] = await linksOf(stop.id);
    expect(link).toMatchObject({
      evidence_id: photo.id,
      responsible_hub_id: HUB_A,
      attached_by_rider: arranged.rider.id,
    });
    expect(Math.abs((link?.attached_at.getTime() ?? 0) - before)).toBeLessThan(10_000);
  });

  // Break caught: a writer that gives the hub, the rider or the moment (so that a link names another hub than its stop's, another rider, or a moment of its own).
  it.each([
    ['the hub', ['responsible_hub_id', `'${HUB_B}'`]],
    ['the rider', ['attached_by_rider', `'${randomUUID()}'`]],
    ['the moment', ['attached_at', `'2001-01-01T00:00:00Z'`]],
  ] as const)(
    'does not let the writer give %s: the column is not granted',
    async (_what, extra) => {
      const arranged = await run();
      const stop = stopAt(arranged);
      const photo = await photoOf(routes, arranged.rider, stop.id);
      refused(
        await attempt(rider(arranged.rider.id), attachSql(photo.id, stop.id, extra)),
        '42501',
      );
      expect(await linksOf(stop.id)).toEqual([]);
    },
  );

  // Break caught: evidence that is not stored, not the rider's, not this stop's, not the proof of a collection or already attached taken as the photo.
  it.each([
    ['a record still PENDING_UPLOAD', 'pending', 'EVIDENCE_NOT_STORED'],
    ['a record that has EXPIRED', 'expired', 'EVIDENCE_NOT_STORED'],
    ['a record another rider captured', 'foreign', 'EVIDENCE_NOT_STORED'],
    ['a record about another stop', 'otherStop', 'EVIDENCE_NOT_STORED'],
    ['a record that is not the proof of a collection', 'otherPurpose', 'EVIDENCE_NOT_STORED'],
    ['a record that is not there', 'unknown', 'EVIDENCE_NOT_STORED'],
  ] as const)('refuses %s, and attaches nothing', async (_what, kind, reason) => {
    const arranged = await run();
    const stop = stopAt(arranged);
    let named: string;
    switch (kind) {
      case 'pending':
        named = (await photoOf(routes, arranged.rider, stop.id, { complete: false })).id;
        break;
      case 'expired':
        named = (await photoOf(routes, arranged.rider, stop.id, { complete: false })).id;
        await arrangeEvidence(
          named,
          `state = 'EXPIRED', created_at = now() - interval '2 hours', upload_expires_at = now() - interval '1 hour'`,
        );
        break;
      case 'foreign': {
        const other = await run();
        named = (await photoOf(routes, other.rider, stopAt(other).id)).id;
        break;
      }
      case 'otherStop':
        named = (await photoOf(routes, arranged.rider, stopAt(arranged, 1).id)).id;
        break;
      case 'otherPurpose':
        named = (await photoOf(routes, arranged.rider, stop.id)).id;
        await arrangeEvidence(named, `purpose = 'CONDITION'`);
        break;
      case 'unknown':
        named = randomUUID();
        break;
    }
    const result = await attempt(rider(arranged.rider.id), attachSql(named, stop.id));
    refused(result, '23514');
    expect(result.reason).toBe(reason);
    expect(await linksOf(stop.id)).toEqual([]);
  });

  // Break caught: one record attached twice (the key of the table is the record, so a second attachment is refused whoever writes it).
  it('attaches a record once', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photo = await photoOf(routes, arranged.rider, stop.id);
    reached(await attempt(rider(arranged.rider.id), attachSql(photo.id, stop.id)));
    refused(
      await attempt(rider(arranged.rider.id), attachSql(photo.id, stop.id)),
      '23505',
      '23514',
    );
    expect(await linksOf(stop.id)).toHaveLength(1);
  });

  // Break caught: a photo attached to a stop the rider has not arrived at, has already resolved, or whose run is over or another rider's.
  it.each([
    ['a stop that was collected', `update pickup_stop set state = 'COLLECTED' where id = $1`],
    ['a stop that was skipped', `update pickup_stop set state = 'SKIPPED' where id = $1`],
    [
      'a stop whose claim was released',
      `update pickup_stop set state = 'SKIPPED', released_at = clock_timestamp() where id = $1`,
    ],
  ])('refuses the photo of %s', async (_what, change) => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photo = await photoOf(routes, arranged.rider, stop.id);
    await routes.admin.query(change, [stop.id]);
    const result = await attempt(rider(arranged.rider.id), attachSql(photo.id, stop.id));
    refused(result, '23514', '42501');
    expect(await linksOf(stop.id)).toEqual([]);
  });

  it('refuses the photo of a stop whose run is no longer in progress or no longer the rider’s', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photo = await photoOf(routes, arranged.rider, stop.id);
    const other = await run();
    await routes.admin.query('alter table pickup_manifest disable trigger user');
    try {
      await routes.admin.query(`update pickup_manifest set assigned_rider_id = $1 where id = $2`, [
        other.rider.id,
        arranged.manifest.id,
      ]);
      refused(
        await attempt(rider(arranged.rider.id), attachSql(photo.id, stop.id)),
        '23514',
        '42501',
      );
      await routes.admin.query(
        `update pickup_manifest set assigned_rider_id = $1, state = 'COMPLETED', completed_at = clock_timestamp() where id = $2`,
        [arranged.rider.id, arranged.manifest.id],
      );
      refused(
        await attempt(rider(arranged.rider.id), attachSql(photo.id, stop.id)),
        '23514',
        '42501',
      );
    } finally {
      await routes.admin.query('alter table pickup_manifest enable trigger user');
    }
    expect(await linksOf(stop.id)).toEqual([]);
  });

  // Break caught: any other principal or key let into the table.
  it.each([
    ['another rider under the same key', 'otherRider', FAILURE],
    ['the same rider under the key of the arrival', 'rider', 'pickup.run.execute'],
    ['staff presenting the rider’s key', 'staff', FAILURE],
    ['a vendor presenting the rider’s key', 'vendor', FAILURE],
  ] as const)('does not let %s attach', async (_who, who, key) => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photo = await photoOf(routes, arranged.rider, stop.id);
    const stranger = await run();
    const context =
      who === 'rider'
        ? rider(arranged.rider.id, key)
        : who === 'otherRider'
          ? rider(stranger.rider.id, key)
          : who === 'staff'
            ? staff(key, [HUB_A])
            : vendor();
    refused(await attempt(context, attachSql(photo.id, stop.id)));
    expect(await linksOf(stop.id)).toEqual([]);
  });

  // Break caught (D-A10; fails on ac9f613, where only the key of the failure attached): a short count's reason that asks for a photo has nowhere to put it, because the rider counts
  // under the key of the count. The same guard holds the same things under either key: the link is the rider's own, of a stored failure-kind photo of this very stop.
  it('lets the same rider attach under the key of the count, for the photo a short count’s reason asks for, and judges it by the same guard', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photo = await photoOf(routes, arranged.rider, stop.id);
    const parcel = await photoOf(routes, arranged.rider, stop.id, { purpose: 'PARCEL_PHOTO' });
    // A parcel's photo is not the proof of a collection, under either key.
    refused(
      await attempt(
        rider(arranged.rider.id, 'pickup.collection.confirm'),
        attachSql(parcel.id, stop.id),
      ),
    );
    reached(
      await attempt(
        rider(arranged.rider.id, 'pickup.collection.confirm'),
        attachSql(photo.id, stop.id),
      ),
    );
    expect(await linksOf(stop.id)).toHaveLength(1);
  });
});

describe('pickup_stop_evidence: a link is kept as it was attached', () => {
  // Break caught: a link changed or removed, by the rider that made it, by staff, or by the administrator (the guard holds it for every login).
  it('is never updated and never deleted, for anyone', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photo = await photoOf(routes, arranged.rider, stop.id);
    reached(await attempt(rider(arranged.rider.id), attachSql(photo.id, stop.id)));
    const before = await linksOf(stop.id);
    for (const context of [rider(arranged.rider.id), staff('pickup.failure.resolve', [HUB_A])]) {
      refused(
        await attempt(
          context,
          `update pickup_stop_evidence set attached_at = clock_timestamp() where pickup_stop_id = '${stop.id}' returning evidence_id`,
        ),
      );
      const deleted = await attempt(
        context,
        `delete from pickup_stop_evidence where pickup_stop_id = '${stop.id}' returning evidence_id`,
      );
      refused(deleted);
    }
    for (const text of [
      `update pickup_stop_evidence set attached_at = clock_timestamp() where pickup_stop_id = $1`,
      `update pickup_stop_evidence set attached_by_rider = attached_by_rider where pickup_stop_id = $1`,
      `delete from pickup_stop_evidence where pickup_stop_id = $1`,
    ]) {
      await expect(routes.admin.query(text, [stop.id]), text).rejects.toMatchObject({
        code: '23514',
      });
    }
    expect(await linksOf(stop.id)).toEqual(before);
  });
});

describe('pickup_stop_evidence: who reads', () => {
  // Break caught: a link read by a vendor, by staff of another hub or under a key outside the pickup domain, or by another rider; or not read by the staff who work the failure.
  it('shows the link to the rider that attached it and to the staff of the stop’s hub under a pickup key, and to nobody else', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photo = await photoOf(routes, arranged.rider, stop.id);
    reached(await attempt(rider(arranged.rider.id), attachSql(photo.id, stop.id)));
    const read = `select evidence_id from pickup_stop_evidence where pickup_stop_id = '${stop.id}'`;
    const other = await run();
    const sees = async (context: SecurityContext): Promise<number> =>
      ((await attempt(context, read)).rows ?? []).length;
    expect(await sees(rider(arranged.rider.id))).toBe(1);
    // The staff who work the failure queue (S1.30 counts the photos of a failure under pickup.failure.resolve), within the hubs of their grant.
    expect(await sees(staff('pickup.failure.resolve', [HUB_A]))).toBe(1);
    expect(await sees(staff('pickup.failure.resolve', [HUB_A, HUB_B]))).toBe(1);
    expect(await sees(staff('pickup.failure.resolve', [], 'ALL'))).toBe(1);
    expect(await sees(staff('pickup.read', [HUB_A]))).toBe(1);
    expect(await sees(rider(other.rider.id))).toBe(0);
    expect(await sees(rider(arranged.rider.id, 'pickup.run.execute'))).toBe(0);
    expect(await sees(staff('pickup.failure.resolve', [HUB_B]))).toBe(0);
    expect(await sees(staff('pickup.failure.resolve', []))).toBe(0);
    expect(await sees(staff('staff.read', [HUB_A]))).toBe(0);
    expect(await sees(staff('fleet.run.read', [HUB_A]))).toBe(0);
    expect(await sees(vendor())).toBe(0);
  });
});

/** The eight reasons as the catalogue holds them, with the category of each and what each asks of the rider. */
const REASONS = [
  ['VENDOR_NOT_AT_LOCATION', 'Vendor not at location', 'CUSTOMER', 'VENDOR_UNAVAILABLE', 'contact'],
  [
    'VENDOR_UNREACHABLE_BY_PHONE',
    'Vendor unreachable by phone',
    'CUSTOMER',
    'VENDOR_UNAVAILABLE',
    'contact',
  ],
  ['ENTRY_REFUSED_BY_SECURITY', 'Entry refused by security', 'EXTERNAL', 'ACCESS_DENIED', 'photo'],
  ['LOCATION_CLOSED', 'Location closed', 'EXTERNAL', 'ACCESS_DENIED', 'photo'],
  ['PARCELS_NOT_PACKED', 'Parcels not packed', 'CUSTOMER', 'PARCEL_NOT_READY', 'none'],
  [
    'VENDOR_ASKED_TO_COME_BACK_LATER',
    'Vendor asked to come back later',
    'CUSTOMER',
    'PARCEL_NOT_READY',
    'none',
  ],
  ['VENDOR_REFUSED_HANDOVER', 'Vendor refused handover', 'CUSTOMER', 'REFUSED_COLLECTION', 'none'],
  ['PARCEL_NOT_ACCEPTABLE', 'Parcel not acceptable', 'CUSTOMER', 'REFUSED_COLLECTION', 'none'],
] as const;
const CATEGORIES = [
  'VENDOR_UNAVAILABLE',
  'ACCESS_DENIED',
  'PARCEL_NOT_READY',
  'REFUSED_COLLECTION',
] as const;

/** The statement of the report of a failure: the stop FAILED under `category` with the snapshot of the reason, in the shape the application builds. */
const failureSql = (
  stopId: string,
  [code, label, attribution, , needs]: (typeof REASONS)[number],
  category: string,
): string => {
  const snapshot = {
    reason_code: code,
    label,
    attribution,
    note: 'The rider could not collect the parcels',
    ...(needs === 'contact'
      ? {
          contact_attempts: [
            {
              method: 'PHONE_CALL',
              attempted_at: '2026-11-04T08:00:00.000Z',
              outcome: 'No answer',
            },
          ],
        }
      : {}),
  };
  return `update pickup_stop set state = 'FAILED', failure_category = '${category}', failure_reason_snapshot = '${JSON.stringify(snapshot)}'::jsonb
           where id = '${stopId}' returning id`;
};

describe('the stop’s guard: the category is the reason’s (D-A4)', () => {
  // Break caught: a reason written under a category that is not the catalogue's for it by a statement that does not go through the application (the pairing would then be the
  // application's alone); a pairing refused only for some of the reasons; a refusal that writes the stop. Each of the eight reasons under each of the other three categories.
  it.each(REASONS.map((each) => [each[0], each] as const))(
    'refuses %s under each of the other three categories, and takes it under its own',
    async (_code, reason) => {
      const arranged = await run({ stops: 2, stopStates: ['ARRIVED', 'ARRIVED'] });
      const stop = stopAt(arranged);
      const own = reason[3];
      // Everything else the reason asks for is satisfied (a photo is linked first), so that the pairing is the only thing wrong.
      if (reason[4] === 'photo') {
        const photo = await photoOf(routes, arranged.rider, stop.id);
        reached(await attempt(rider(arranged.rider.id), attachSql(photo.id, stop.id)));
      }
      for (const category of CATEGORIES.filter((each) => each !== own)) {
        const result = await attempt(
          rider(arranged.rider.id),
          failureSql(stop.id, reason, category),
        );
        refused(result, '23514');
        expect(result.reason, `${reason[0]} under ${category}`).toBe('REASON_CATEGORY_MISMATCH');
      }
      expect(
        (
          await routes.rows<{ state: string }>(`select state from pickup_stop where id = $1`, [
            stop.id,
          ])
        )[0]?.state,
      ).toBe('ARRIVED');
      reached(await attempt(rider(arranged.rider.id), failureSql(stop.id, reason, own)));
    },
  );
});

describe('the stop’s guard: the photo is the evidence attached to the stop (S1.28)', () => {
  // Break caught: a failure whose reason requires a photo accepted with none attached (the requirement left to the application), or refused with one; a requirement hard-coded.
  it('refuses a failure whose reason asks for a photo until one is attached, and takes one that asks for none', async () => {
    const arranged = await run({ stops: 3, stopStates: ['ARRIVED', 'ARRIVED', 'ARRIVED'] });
    const [asks, plain] = [stopAt(arranged, 0), stopAt(arranged, 1)];
    const closed = REASONS[3];
    const noPhoto = await attempt(
      rider(arranged.rider.id),
      failureSql(asks.id, closed, 'ACCESS_DENIED'),
    );
    refused(noPhoto, '23514');
    expect(noPhoto.reason).toBe('REASON_REQUIRED');
    const photo = await photoOf(routes, arranged.rider, asks.id);
    reached(await attempt(rider(arranged.rider.id), attachSql(photo.id, asks.id)));
    reached(await attempt(rider(arranged.rider.id), failureSql(asks.id, closed, 'ACCESS_DENIED')));
    // A reason that asks for none is taken with none.
    reached(
      await attempt(rider(arranged.rider.id), failureSql(plain.id, REASONS[4], 'PARCEL_NOT_READY')),
    );
  });

  // Break caught: the photo of another stop counted for this one (the check asks for any link and not this stop's).
  it('counts only the evidence attached to this very stop', async () => {
    const arranged = await run({ stops: 2, stopStates: ['ARRIVED', 'ARRIVED'] });
    const [one, two] = [stopAt(arranged, 0), stopAt(arranged, 1)];
    const photo = await photoOf(routes, arranged.rider, one.id);
    reached(await attempt(rider(arranged.rider.id), attachSql(photo.id, one.id)));
    const result = await attempt(
      rider(arranged.rider.id),
      failureSql(two.id, REASONS[3], 'ACCESS_DENIED'),
    );
    refused(result, '23514');
    expect(result.reason).toBe('REASON_REQUIRED');
  });
});
