import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import {
  insertManifest,
  insertStop,
  manifestRow,
  stopRow,
  type ManifestRow,
  type ManifestState,
  type StopRow,
  type StopState,
} from './support/manifests.js';
import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { insertRider, riderRow } from './support/riders.js';
import { HUB_A, HUB_B, startStaffRoutes, type StaffRoutes } from './support/staff-routes.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * S1.23: what the database holds for **every** writer of the two writes of this task (`AC-SLICE-001-74` and `-78`; MSC-DEC-412; migration `0066`):
 *
 * - **The skip of a stop** is the act of the key that authorises it and of no other. The key moves a stop of a hub of its grant to `SKIPPED` with
 *   its moment and the snapshot of an active reason of the `PICKUP_STOP_SKIP` catalogue (with its note where the reason requires one), and
 *   writes nothing else of the stop in the same statement (its place, its arrival and its claim are kept). The system's own codes, a code of
 *   another domain, a retired or unknown code, and a resolved stop are refused for it. A rider, a vendor, another key and another hub reach nothing.
 * - **The completion of a run by the system** is the act of the keys that can turn a stop terminal, on a run in progress of a hub of the grant:
 *   the state and its moment and nothing else, with every stop terminal and none collected. Nothing else completes a run for these keys, and a
 *   rider's key, an assignment's or a vendor's reaches no run.
 */
let routes: StaffRoutes;
let organisation: string;

beforeAll(async () => {
  routes = await startStaffRoutes();
  organisation = (await insertVendor(routes.admin, vendorRow({ hubId: HUB_A }))).organizationId;
  await routes.admin.query(
    `insert into reason_code (code, domain, label, attribution, requires_note, active)
     values ('FIXTURE_SKIP_RETIRED', 'PICKUP_STOP_SKIP', 'Retired', 'MELARC', false, false),
            ('FIXTURE_NOT_A_SKIP', 'PICKUP_CANCELLATION', 'Not a skip', 'CUSTOMER', false, true)`,
  );
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const SKIP_KEY = 'pickup.stop.skip';

const staff = (key: string, hubs: readonly string[] | 'ALL' = 'ALL'): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  sessionId: randomUUID(),
  surface: 'OPS_PORTAL',
  authorizationKey: key,
  hubScopeMode: hubs === 'ALL' ? 'ALL' : 'SET',
  authorizedHubIds: hubs === 'ALL' ? [] : [...hubs],
  correlationId: 'pickup-stop-skip-policies',
});

const rider = (riderId: string, key: string): SecurityContext => ({
  principalType: 'RIDER',
  principalId: riderId,
  sessionId: randomUUID(),
  surface: 'RIDER_ANDROID',
  riderId,
  authorizationKey: key,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'pickup-stop-skip-policies',
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
const idsOf = (result: Result): string[] =>
  'rows' in result ? result.rows.map((row) => (row as { id: string }).id) : [];
const codeOf = (result: Result): string | undefined => ('code' in result ? result.code : undefined);

interface Fixture {
  readonly riderId: string;
  readonly manifest: ManifestRow;
  readonly stops: StopRow[];
}

/** A run of hub A with one stop in each of the given states (a summary with each, as a dispatched run has). */
async function fixture(
  state: ManifestState = 'IN_PROGRESS',
  stopStates: readonly StopState[] = ['PENDING'],
): Promise<Fixture> {
  const riderId = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
  const manifest = await insertManifest(
    routes.admin,
    manifestRow(HUB_A, { state, assignedRiderId: riderId }),
  );
  const stops: StopRow[] = [];
  for (const [at, stopState] of stopStates.entries()) {
    const request = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(organisation, HUB_A, { state: 'CONFIRMED' }),
    );
    stops.push(
      await insertStop(
        routes.admin,
        stopRow(manifest, request.id, at + 1, {
          state: stopState,
          ...(state === 'DRAFT'
            ? {}
            : {
                pickupSummary: {
                  reference: request.code,
                  sender_display_name: 'Fixture Sender',
                  declared_package_count: 1,
                  resolved_pickup_location: { address: 'Fixture shop' },
                  location_note: null,
                  contact_phone: null,
                },
              }),
        }),
      ),
    );
  }
  return { riderId, manifest, stops };
}

const stopState = async (id: string) =>
  (
    await routes.rows<{
      state: string;
      sequence: number;
      released_at: Date | null;
      arrived_at: Date | null;
    }>(`select state, sequence, released_at, arrived_at from pickup_stop where id = $1`, [id])
  )[0];
const manifestState = async (id: string) =>
  (await routes.rows<{ state: string }>(`select state from pickup_manifest where id = $1`, [id]))[0]
    ?.state;

/** The write of a skip: the state, the moment, and the snapshot of the reason with the same moment. */
const snapshot = (code: string, note?: string) =>
  `jsonb_build_object('reason_code', '${code}', 'label', 'x', 'skipped_at', now()${note === undefined ? '' : `, 'note', '${note}'`})`;
const skipSql = (id: string, code = 'RUN_CUT_SHORT', extra = '', note?: string) =>
  `update pickup_stop set state = 'SKIPPED', resolved_at = now(), skip_snapshot = ${snapshot(code, note)}${extra} where id = '${id}' returning id`;
const completeSql = (id: string, set = `state = 'COMPLETED', completed_at = now()`) =>
  `update pickup_manifest set ${set} where id = '${id}' returning id`;

describe('the skip of a stop, as the database holds it for every writer', () => {
  // Break caught: a policy that does not admit the key, or admits another key, a rider, or another hub; and a skip that is applied to a row
  // the context cannot reach.
  it('admits the key of the skip in a hub of its grant, and nobody else', async () => {
    const own = await fixture();
    const other = await fixture();
    const at = own.stops[0]?.id ?? '';
    // Hidden (no row, no error): another key, a hub outside the grant, a rider whatever it holds, and the planning keys that also reach stops.
    for (const key of [
      'pickup.read',
      'pickup.manifest.create',
      'pickup.manifest.dispatch',
      'pickup.manifest.assign',
    ]) {
      expect(idsOf(await attempt(staff(key), skipSql(at))), key).toEqual([]);
    }
    expect(idsOf(await attempt(staff(SKIP_KEY, [HUB_B]), skipSql(at)))).toEqual([]);
    expect(idsOf(await attempt(rider(own.riderId, SKIP_KEY), skipSql(at)))).toEqual([]);
    expect(idsOf(await attempt(rider(own.riderId, 'pickup.run.execute'), skipSql(at)))).toEqual([]);
    expect((await stopState(at))?.state).toBe('PENDING');

    expect(idsOf(await attempt(staff(SKIP_KEY, [HUB_A]), skipSql(at)))).toEqual([at]);
    expect((await stopState(at))?.state).toBe('SKIPPED');
    expect(idsOf(await attempt(staff(SKIP_KEY), skipSql(other.stops[0]?.id ?? '')))).toEqual([
      other.stops[0]?.id,
    ]);
  });

  // Break caught: a skip that carries another column with it: the place in the order, the claim (a skip does not release it), the arrival, the
  // carry-over reason or the summary, whichever statement carries it.
  it.each([
    ['the place', `, sequence = 9`],
    ['the claim', `, released_at = now()`],
    ['the arrival', `, arrived_at = now()`],
  ])('refuses a skip that also changes %s', async (_what, extra) => {
    const run = await fixture('IN_PROGRESS', ['ARRIVED']);
    const id = run.stops[0]?.id ?? '';
    const before = await stopState(id);
    expect(codeOf(await attempt(staff(SKIP_KEY), skipSql(id, 'RUN_CUT_SHORT', extra)))).toBe(
      '23514',
    );
    expect(await stopState(id)).toEqual(before);
  });

  // Break caught: a reason the catalogue does not hold for this act: the system's own codes (the cancellation of a request or of a manifest),
  // a failure code of another domain, a retired code, an unknown code, a code that needs a note given without one or with a blank one.
  it.each([
    ['the system code of a cancellation', 'REQUEST_CANCELLED', undefined],
    ['the system code of a manifest', 'MANIFEST_CANCELLED', undefined],
    ['a code of another domain', 'FIXTURE_NOT_A_SKIP', undefined],
    ['a retired code', 'FIXTURE_SKIP_RETIRED', undefined],
    ['an unknown code', 'NO_SUCH_CODE', undefined],
    ['a code that requires a note, with none', 'LOCATION_INACCESSIBLE', undefined],
    ['a code that requires a note, with a blank one', 'STOP_RAISED_IN_ERROR', '   '],
  ])('refuses %s', async (_what, code, note) => {
    const run = await fixture();
    const id = run.stops[0]?.id ?? '';
    expect(codeOf(await attempt(staff(SKIP_KEY), skipSql(id, code, '', note)))).toBe('23514');
    expect((await stopState(id))?.state).toBe('PENDING');
  });

  it('accepts a code that requires a note when it comes with one', async () => {
    const run = await fixture();
    const id = run.stops[0]?.id ?? '';
    expect(
      idsOf(await attempt(staff(SKIP_KEY), skipSql(id, 'LOCATION_INACCESSIBLE', '', 'Gate shut'))),
    ).toEqual([id]);
  });

  // Break caught: a skip whose snapshot names another moment than the stop's, or none, or that moves the stop to another state under this key.
  it('refuses a snapshot whose moment is not the stop’s, a skip with no moment, and any other state', async () => {
    const run = await fixture('IN_PROGRESS', ['PENDING', 'PENDING', 'PENDING']);
    const [moment, none, other] = run.stops.map((each) => each.id);
    expect(
      codeOf(
        await attempt(
          staff(SKIP_KEY),
          `update pickup_stop set state = 'SKIPPED', resolved_at = now(), skip_snapshot = jsonb_build_object('reason_code', 'RUN_CUT_SHORT', 'label', 'x', 'skipped_at', now() - interval '1 hour') where id = '${moment ?? ''}'`,
        ),
      ),
    ).toBe('23514');
    expect(
      codeOf(
        await attempt(
          staff(SKIP_KEY),
          `update pickup_stop set state = 'SKIPPED', skip_snapshot = ${snapshot('RUN_CUT_SHORT')} where id = '${none ?? ''}'`,
        ),
      ),
    ).toBe('23514');
    for (const id of [moment, none, other])
      expect((await stopState(id ?? ''))?.state).toBe('PENDING');
  });

  // Break caught: the skip key writing a state that is not the skip. A state alone is a legal move for the stop's general rules (a pending stop is
  // arrived at, an arrived one is collected), so only the policy's check and the key's own rule stop it: each is exercised with nothing else
  // changed, so that no column rule can be the one that refuses.
  it.each([
    ['arrives a pending stop', 'PENDING', `state = 'ARRIVED'`],
    ['collects an arrived stop', 'ARRIVED', `state = 'COLLECTED'`],
    ['partly collects an arrived stop', 'ARRIVED', `state = 'PARTIALLY_COLLECTED'`],
  ] as const)('refuses a statement that %s', async (_what, from, set) => {
    const run = await fixture('IN_PROGRESS', [from]);
    const id = run.stops[0]?.id ?? '';
    const answer = await attempt(
      staff(SKIP_KEY),
      `update pickup_stop set ${set} where id = '${id}' returning id`,
    );
    expect(['42501', '23514']).toContain(codeOf(answer));
    expect((await stopState(id))?.state).toBe(from);
  });

  // Break caught: a stop already resolved (collected, partly collected, failed, skipped) skipped again, which would erase a custody or a failure.
  it.each(['COLLECTED', 'PARTIALLY_COLLECTED', 'FAILED', 'SKIPPED'] as const)(
    'refuses the skip of a %s stop and leaves it as it is',
    async (resolved) => {
      const run = await fixture('IN_PROGRESS', [resolved, 'PENDING']);
      const id = run.stops[0]?.id ?? '';
      const before = await routes.rows(`select * from pickup_stop where id = $1`, [id]);
      expect(codeOf(await attempt(staff(SKIP_KEY), skipSql(id)))).toBe('23514');
      expect(await routes.rows(`select * from pickup_stop where id = $1`, [id])).toEqual(before);
    },
  );
});

describe('the completion of a run by the system, as the database holds it for every writer', () => {
  const KEYS = [SKIP_KEY, 'pickup.request.cancel'] as const;

  // Break caught: a completion that a key other than the two that can turn a stop terminal can make; one made on a run that is not in progress; one
  // outside the hubs of the grant; or one by a rider, a vendor or the assignment.
  it.each(KEYS)(
    'admits the completion under %s, on a run in progress of a hub of the grant, and nothing else',
    async (key) => {
      const run = await fixture('IN_PROGRESS', ['SKIPPED', 'FAILED']);
      const id = run.manifest.id;
      for (const hidden of [
        'pickup.read',
        'pickup.manifest.create',
        'pickup.manifest.assign',
        'pickup.manifest.dispatch',
        'pickup.run.execute',
      ]) {
        expect(idsOf(await attempt(staff(hidden), completeSql(id))), hidden).toEqual([]);
      }
      expect(idsOf(await attempt(staff(key, [HUB_B]), completeSql(id)))).toEqual([]);
      expect(idsOf(await attempt(rider(run.riderId, key), completeSql(id)))).toEqual([]);
      expect(
        idsOf(await attempt(rider(run.riderId, 'pickup.run.execute'), completeSql(id))),
      ).toEqual([]);
      expect(await manifestState(id)).toBe('IN_PROGRESS');

      expect(idsOf(await attempt(staff(key, [HUB_A]), completeSql(id)))).toEqual([id]);
      expect(await manifestState(id)).toBe('COMPLETED');
    },
  );

  it.each(['DRAFT', 'DISPATCHED'] as const)('reaches no %s manifest', async (state) => {
    const run = await fixture(state, ['SKIPPED']);
    expect(idsOf(await attempt(staff(SKIP_KEY), completeSql(run.manifest.id)))).toEqual([]);
    expect(await manifestState(run.manifest.id)).toBe(state);
  });

  // Break caught: a run completed while a stop is still to be worked, or with something collected, by these keys.
  it.each([
    ['a pending stop', ['SKIPPED', 'PENDING']],
    ['an arrived stop', ['SKIPPED', 'ARRIVED']],
    ['a collected stop', ['SKIPPED', 'COLLECTED']],
    ['a partly collected stop', ['FAILED', 'PARTIALLY_COLLECTED']],
  ] as const)('refuses the completion of a run that has %s', async (_what, states) => {
    for (const key of KEYS) {
      const run = await fixture('IN_PROGRESS', states);
      expect(codeOf(await attempt(staff(key), completeSql(run.manifest.id)))).toBe('23514');
      expect(await manifestState(run.manifest.id)).toBe('IN_PROGRESS');
    }
  });

  // Break caught: a completion that carries another change with it (another rider, a new date, a cleared start), or a state other than the
  // completion under these keys, or a completion with no moment.
  it('writes the state and its moment and nothing else', async () => {
    const run = await fixture('IN_PROGRESS', ['SKIPPED']);
    const id = run.manifest.id;
    const other = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
    expect(
      codeOf(
        await attempt(
          staff(SKIP_KEY),
          completeSql(
            id,
            `state = 'COMPLETED', completed_at = now(), assigned_rider_id = '${other}'`,
          ),
        ),
      ),
    ).toBe('23514');
    expect(codeOf(await attempt(staff(SKIP_KEY), completeSql(id, `state = 'COMPLETED'`)))).toBe(
      '23514',
    );
    // The state stays in progress and a moment is changed: the policy's check names the completion.
    expect(
      ['42501', '23514'].includes(
        codeOf(await attempt(staff(SKIP_KEY), completeSql(id, `started_at = now()`))) ?? '',
      ),
    ).toBe(true);
    // The state moves to cancelled under the key of a skip: no.
    expect(
      ['42501', '23514'].includes(
        codeOf(await attempt(staff(SKIP_KEY), completeSql(id, `state = 'CANCELLED'`))) ?? '',
      ),
    ).toBe(true);
    expect(await manifestState(id)).toBe('IN_PROGRESS');
  });
});
