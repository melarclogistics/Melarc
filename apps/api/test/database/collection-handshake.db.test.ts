import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { guardReasonIn, serverErrorIn } from '../../src/platform/database/database-failures.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { NOTIFICATION_LANE_PRINCIPAL_ID } from '../../src/platform/notifications/notification-store.js';
import { MIGRATIONS_FOLDER } from '../../src/tools/database/run-migrations.js';
import { waitUntilBlockedBy } from './support/lock-wait.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertAdHocSender, insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { arrangeRun, arrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { buildService } from './support/service.js';
import { HUB_A, HUB_B } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.27: what the database holds of the collection handshake for **every** writer (migration `0070`; `AC-SLICE-001-23`, `-24`, `-26`, `-73`). The handshake is
 * written only by five operations (`SECURITY DEFINER` functions that the API's runtime login alone executes), and each test here is that login with the real
 * context of the principal it names: the rider that counted a stop, the vendor whose pickup it is, an officer, the notification lane. A refusal is shown to be the
 * one the operation states (`DETAIL reason=`, or 42501), and an outcome that the application turns into an error (a wrong code, an expired one) is read from what
 * the operation returns and from what it left behind. The digests are stand-ins: the database compares bytes and does not know how a digest was made.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let vendorB: ArrangedVendor;
let vendorC: ArrangedVendor;
/** The notification lane's own login: a SYSTEM context under the notification capability is valid only on the worker's service. */
let work: ReturnType<typeof buildService>;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  work = buildService(routes.database, { poolMax: 2, login: WORKER_RUNTIME_ROLE });
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  vendorB = await routes.vendor();
  vendorC = await routes.vendor();
  // The registered number (F-23, migration 0073) is the phone of the vendor's credential where its channel is PHONE; the organisation's business contact is no registered
  // number and the fallback never uses it. Vendor A has a credential phone on the PHONE channel and a different business number; vendor B has only a business number
  // (and an address on its credential); vendor C has a phone registered on its credential and its messages go to its address, so the number is registered and is not the channel.
  await routes.admin.query(
    `update vendor_credential set recovery_phone = '+233201112222', delivery_channel = 'PHONE' where vendor_account_id = $1`,
    [vendorA.row.accountId],
  );
  await routes.admin.query(
    `update vendor_organization set contact_phone = '+233209990000' where id = $1`,
    [vendorA.row.organizationId],
  );
  await routes.admin.query(
    `update vendor_organization set contact_phone = '+233208880000' where id = $1`,
    [vendorB.row.organizationId],
  );
  await routes.admin.query(
    `update vendor_credential set recovery_phone = '+233207770000' where vendor_account_id = $1`,
    [vendorC.row.accountId],
  );
}, 180_000);

afterAll(async () => {
  await work.close();
  await routes.stop();
});

const CONFIRM = 'pickup.collection.confirm';
const OVERRIDE = 'pickup.handshake.override';
const RESOLVE = 'pickup.handshake.resolve';

const riderCtx = (riderId: string, key: string = CONFIRM): SecurityContext => ({
  principalType: 'RIDER',
  principalId: riderId,
  sessionId: randomUUID(),
  surface: 'RIDER_ANDROID',
  riderId,
  authorizationKey: key,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: randomUUID(),
});
const vendorCtx = (vendor: ArrangedVendor, key: string = CONFIRM): SecurityContext => ({
  principalType: 'VENDOR',
  principalId: vendor.row.accountId,
  sessionId: randomUUID(),
  surface: 'VENDOR_PWA',
  authorizationKey: key,
  vendorOrganizationId: vendor.row.organizationId,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: randomUUID(),
});
const officerId = randomUUID();
const staffCtx = (key: string, hubs: readonly string[] | 'ALL' = 'ALL'): SecurityContext => ({
  principalType: 'STAFF',
  principalId: officerId,
  sessionId: randomUUID(),
  surface: 'OPS_PORTAL',
  authorizationKey: key,
  hubScopeMode: hubs === 'ALL' ? 'ALL' : 'SET',
  authorizedHubIds: hubs === 'ALL' ? [] : [...hubs],
  correlationId: randomUUID(),
});
const laneCtx = (requestId: string, hubId: string = HUB_A): SecurityContext => ({
  principalType: 'SYSTEM',
  principalId: NOTIFICATION_LANE_PRINCIPAL_ID,
  surface: 'SYSTEM',
  taskCapability: 'notification',
  correlationId: randomUUID(),
  outbox: { id: randomUUID(), hubId, aggregateId: requestId },
});

type Outcome =
  | { readonly rows: Record<string, unknown>[] }
  | { readonly code: string; readonly reason?: string };

/** What a statement does as a context: the rows it returned, or the SQLSTATE of the refusal and the reason the operation stated for it. */
async function run(context: SecurityContext, text: string): Promise<Outcome> {
  try {
    const service = context.principalType === 'SYSTEM' ? work.service : routes.built.service;
    const rows = await service.transactionWithContext(
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
const rowOf = (outcome: Outcome): Record<string, unknown> => {
  if (!('rows' in outcome))
    throw new Error(`the statement was refused: ${JSON.stringify(outcome)}`);
  const [row] = outcome.rows;
  if (row === undefined) throw new Error('the statement returned no row');
  return row;
};
const refused = (code: string, reason?: string): Outcome => ({
  code,
  ...(reason === undefined ? {} : { reason }),
});

/** A stand-in for the digest of a code: 32 bytes the database compares and cannot tell from a keyed one. */
const digest = (code: string): string =>
  `decode('${createHash('sha256').update(code).digest('hex')}', 'hex')`;
const arrayOfDigests = (...codes: string[]): string =>
  `array[${codes.map(digest).join(', ')}]::bytea[]`;

const issue = (
  ctx: SecurityContext,
  stop: string,
  code = '1234',
  id: string = randomUUID(),
  length = 4,
) =>
  run(
    ctx,
    `select * from melarc.handshake_issue('${id}'::uuid, '${stop}'::uuid, ${digest(code)}, 1, ${String(length)})`,
  );
const verify = (ctx: SecurityContext, stop: string, ...codes: string[]) =>
  run(ctx, `select * from melarc.handshake_verify('${stop}'::uuid, ${arrayOfDigests(...codes)})`);
const fallback = (
  ctx: SecurityContext,
  stop: string,
  expectedGeneration: number,
  code: string,
  trigger = 'NO_DATA',
  id: string = randomUUID(),
  length = 4,
) =>
  run(
    ctx,
    `select * from melarc.handshake_sms_fallback('${id}'::uuid, '${stop}'::uuid, ${String(expectedGeneration)}, ${digest(code)}, 1, '${trigger}', ${String(length)})`,
  );
const override = (
  ctx: SecurityContext,
  stop: string,
  note = 'Phoned the vendor on the number we hold',
  id: string = randomUUID(),
) => run(ctx, `select * from melarc.handshake_override('${id}'::uuid, '${stop}'::uuid, '${note}')`);
const resolve = (
  ctx: SecurityContext,
  stop: string,
  note = 'The vendor confirmed by phone and sent a photo',
) => run(ctx, `select * from melarc.handshake_resolve('${stop}'::uuid, '${note}')`);

/**
 * A transaction of the runtime login with a security context, left open after `work` until `release()`: the other writer meets what it holds. `ready` is the
 * server process holding it once `work` is done; a failure of `work` ends `ready` too, so that a test never waits for nothing.
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

interface Counted {
  readonly arranged: ArrangedRun;
  readonly riderId: string;
  readonly stopId: string;
  readonly requestId: string;
  readonly recordId: string;
}

const insertRecordFor = async (
  arranged: ArrangedRun,
  stopId: string,
  variance: 'MATCH' | 'SHORT',
  direction: 'VENDOR_ENTERED_RIDER_DISPLAYED' | 'SENDER_SMS_RIDER_ENTERED',
  recordedBy: string = arranged.rider.id,
): Promise<string> => {
  const id = randomUUID();
  await routes.admin.query(
    `insert into collection_record (id, pickup_stop_id, responsible_hub_id, declared_count, collected_count, variance, variance_reason_snapshot, handshake_type, recorded_by)
     values ($1, $2, $3, 3, $4, $5, $6::jsonb, $7, $8)`,
    [
      id,
      stopId,
      HUB_A,
      variance === 'MATCH' ? 3 : 2,
      variance,
      variance === 'SHORT'
        ? JSON.stringify({
            reason_code: 'SOME_PARCELS_NOT_READY',
            label: 'Some parcels not ready',
            attribution: 'CUSTOMER',
          })
        : null,
      direction,
      recordedBy,
    ],
  );
  return id;
};

/**
 * A vendor's pickup the rider has arrived at and counted. A count is recorded only for a stop that has been arrived at, so a stop that is no longer to be worked
 * (`closed`) is one the administrator closes after the count, as a stop that has been collected.
 */
async function counted(
  over: { vendor?: ArrangedVendor; variance?: 'MATCH' | 'SHORT'; closed?: boolean } = {},
): Promise<Counted> {
  const arranged = await arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: (over.vendor ?? vendorA).row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 1,
    stopStates: ['ARRIVED'],
  });
  const stop = arranged.stops[0];
  if (stop === undefined) throw new Error('stop');
  const recordId = await insertRecordFor(
    arranged,
    stop.id,
    over.variance ?? 'MATCH',
    'VENDOR_ENTERED_RIDER_DISPLAYED',
  );
  if (over.closed === true) {
    await routes.admin.query(
      `update pickup_stop set state = 'COLLECTED', resolved_at = now() where id = $1`,
      [stop.id],
    );
  }
  return {
    arranged,
    riderId: arranged.rider.id,
    stopId: stop.id,
    requestId: stop.requestId,
    recordId,
  };
}

/** An individual sender's pickup, arrived at and counted: the code goes to the sender by SMS and the rider enters it. */
async function countedIndividual(variance: 'MATCH' | 'SHORT' = 'MATCH'): Promise<Counted> {
  const arranged = await arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 1,
    stopStates: ['ARRIVED'],
  });
  const sender = await insertAdHocSender(routes.admin, { state: 'REUSABLE' });
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
  const recordId = await insertRecordFor(arranged, stop.id, variance, 'SENDER_SMS_RIDER_ENTERED');
  return { arranged, riderId: arranged.rider.id, stopId: stop.id, requestId: request.id, recordId };
}

const handshakeOf = async (stopId: string): Promise<Record<string, unknown> | undefined> =>
  (await routes.rows(`select * from collection_handshake where pickup_stop_id = $1`, [stopId]))[0];
const stopState = async (stopId: string): Promise<string | undefined> =>
  (await routes.rows<{ state: string }>(`select state from pickup_stop where id = $1`, [stopId]))[0]
    ?.state;
const recordOf = async (stopId: string): Promise<Record<string, unknown> | undefined> =>
  (await routes.rows(`select * from collection_record where pickup_stop_id = $1`, [stopId]))[0];
const eventsOf = (stopId: string, ...codes: string[]) =>
  routes.rows<{
    event_code: string;
    actor_type: string;
    actor_id: string | null;
    surface_context: string;
    object_type: string;
    previous_state: string | null;
    resulting_state: string | null;
    related_ids: Record<string, string>;
    detail: Record<string, unknown>;
    enhanced: boolean;
  }>(
    `select event_code, actor_type, actor_id, surface_context, object_type, previous_state, resulting_state, related_ids, detail, enhanced
       from audit_event where (object_id::text = $1 or related_ids ->> 'pickup_stop_id' = $1) and event_code like 'pickup.%' ${codes.length === 0 ? '' : `and event_code = any ($2::text[])`}
      order by recorded_at, id`,
    codes.length === 0 ? [stopId] : [stopId, codes],
  );
const outboxOf = (requestId: string) =>
  routes.rows<{
    event_type: string;
    payload: Record<string, unknown>;
    rider_id: string | null;
    originating_principal_type: string;
    originating_principal_id: string;
  }>(
    `select event_type, payload, rider_id, originating_principal_type, originating_principal_id
       from outbox where aggregate_id = $1 and event_type = 'pickup.handshake.requested' order by created_at, id`,
    [requestId],
  );
/** What an envelope of a code is: the request's own scope, no rider scope, and the rider as the origin of the act. */
const envelopeOf = (riderId: string, generation: number) => ({
  event_type: 'pickup.handshake.requested',
  payload: { generation },
  rider_id: null,
  originating_principal_type: 'RIDER',
  originating_principal_id: riderId,
});
const age = (stopId: string, change: string) =>
  routes.admin.query(`update collection_handshake set ${change} where pickup_stop_id = $1`, [
    stopId,
  ]);
const clock = async (): Promise<string> =>
  (await routes.rows<{ t: string }>(`select clock_timestamp()::text as t`))[0]?.t ?? '';

describe('asking for the first code (initiateHandshake)', () => {
  // Break caught: the handshake not made, made for the wrong direction, with the wrong life, or kept with a code. The operation keeps a digest and a generation
  // and no code, and the one event of the code, naming the stop, the run, the request, the record and the rider.
  it('makes the handshake for the rider that counted the stop: code generated, one generation, fifteen minutes, the event, and no text for a vendor’s pickup', async () => {
    const stop = await counted();
    const from = await clock();
    const outcome = await issue(riderCtx(stop.riderId), stop.stopId);
    const to = await clock();
    expect(rowOf(outcome)).toMatchObject({
      out_direction: 'VENDOR_ENTERED_RIDER_DISPLAYED',
      out_state: 'CODE_GENERATED',
      out_generation: 1,
      out_key_version: 1,
      out_attempts: 0,
      out_fallback_sends: 0,
    });
    const kept = await handshakeOf(stop.stopId);
    expect(kept).toMatchObject({
      state: 'CODE_GENERATED',
      code_generation: 1,
      attempts: 0,
      fallback_sends: 0,
      channel: null,
      confirmed_at: null,
      pickup_request_id: stop.requestId,
      responsible_hub_id: HUB_A,
    });
    const life = await routes.rows<{ ok: boolean; digest_kept: boolean }>(
      `select (expires_at - code_generated_at = interval '15 minutes') as ok, (code_digest is not null and octet_length(code_digest) = 32) as digest_kept
         from collection_handshake where pickup_stop_id = $1`,
      [stop.stopId],
    );
    expect(life).toEqual([{ ok: true, digest_kept: true }]);
    const inside = await routes.rows<{ inside: boolean }>(
      `select (code_generated_at >= $2::timestamptz and code_generated_at <= $3::timestamptz) as inside from collection_handshake where pickup_stop_id = $1`,
      [stop.stopId, from, to],
    );
    expect(inside).toEqual([{ inside: true }]);

    const events = await eventsOf(stop.stopId, 'pickup.handshake.generated');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_type: 'RIDER',
      actor_id: stop.riderId,
      surface_context: 'RIDER_ANDROID',
      object_type: 'CollectionHandshake',
      previous_state: null,
      resulting_state: 'CODE_GENERATED',
      enhanced: false,
      detail: { direction: 'VENDOR_ENTERED_RIDER_DISPLAYED', generation: 1 },
    });
    expect(events[0]?.related_ids).toMatchObject({
      pickup_stop_id: stop.stopId,
      pickup_request_id: stop.requestId,
      rider_id: stop.riderId,
    });
    // The vendor displays and enters: nobody is texted.
    expect(await outboxOf(stop.requestId)).toEqual([]);
  });

  // Break caught: the sender's code not asked of the lane, or asked with more than the number of the generation (the envelope may carry no code and no number).
  it('asks the lane to text the individual sender’s code, in the same change, with the generation and nothing else', async () => {
    const stop = await countedIndividual();
    expect(rowOf(await issue(riderCtx(stop.riderId), stop.stopId))).toMatchObject({
      out_direction: 'SENDER_SMS_RIDER_ENTERED',
      out_state: 'CODE_GENERATED',
    });
    const envelopes = await outboxOf(stop.requestId);
    expect(envelopes).toEqual([envelopeOf(stop.riderId, 1)]);
  });

  // Break caught: the counted-stop authority (4 November 2026) widened or narrowed: only the rider that recorded the count, while it is the run's assigned rider.
  it('refuses every caller but the assigned rider that recorded the count, under the counting key', async () => {
    const stop = await counted();
    const other = await arrangedRider(routes.kit, routes.admin);
    const refusals = [
      ['another rider', await issue(riderCtx(other.id), stop.stopId)],
      [
        'the rider under another key',
        await issue(riderCtx(stop.riderId, 'pickup.run.execute'), stop.stopId),
      ],
      ['an officer', await issue(staffCtx(CONFIRM), stop.stopId)],
      ['the vendor', await issue(vendorCtx(vendorA), stop.stopId)],
    ] as const;
    for (const [what, outcome] of refusals) expect(outcome, what).toEqual(refused('42501'));
    expect(await handshakeOf(stop.stopId)).toBeUndefined();
    expect(await eventsOf(stop.stopId)).toEqual([]);
    expect(await issue(riderCtx(stop.riderId), stop.stopId)).toHaveProperty('rows');
  });

  // Break caught: a custody transfer giving the receiving rider the handshake of a stop the previous holder counted (custody alone grants no authority).
  it('gives a rider that holds the run by custody no authority over the handshake of a stop another rider counted', async () => {
    const stop = await counted();
    const receiving = await arrangedRider(routes.kit, routes.admin);
    // The custody handover is accepted: the receiving rider holds the run's parcels, and the run's rider is as it was.
    const made = await routes.admin.query<{ id: string }>(
      `insert into run_custody_handover (id, manifest_id, responsible_hub_id, from_rider_id, to_rider_id, initiation_note, initiated_by)
       values (gen_random_uuid(), $1, $2, $3, $4, 'The motorcycle broke down', gen_random_uuid()) returning id`,
      [stop.arranged.manifest.id, HUB_A, stop.riderId, receiving.id],
    );
    await routes.admin.query(
      `update run_custody_handover set state = 'COMPLETED', parcel_count_taken = 3, accepted_by = $2, resolved_at = now() where id = $1`,
      [made.rows[0]?.id, receiving.id],
    );
    expect(await issue(riderCtx(receiving.id), stop.stopId)).toEqual(refused('42501'));
    expect(await verify(riderCtx(receiving.id), stop.stopId, '1234')).toEqual(refused('42501'));
    expect(await fallback(riderCtx(receiving.id), stop.stopId, 0, '1234')).toEqual(
      refused('42501'),
    );
    // The recording rider, still assigned, may begin it.
    expect(await issue(riderCtx(stop.riderId), stop.stopId)).toHaveProperty('rows');
  });

  // Break caught: a code asked for before the count is recorded, at a stop not arrived at, on a run not started, or twice.
  it('refuses a code for a stop that was never counted', async () => {
    const arranged = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendorA.row.organizationId,
      serviceDate: days.today,
      state: 'IN_PROGRESS',
      stops: 1,
      stopStates: ['ARRIVED'],
    });
    const stopId = arranged.stops[0]?.id ?? '';
    expect(await issue(riderCtx(arranged.rider.id), stopId)).toEqual(
      refused('23514', 'COLLECTION_NOT_RECORDED'),
    );
  });

  it('refuses a code at a stop that has been closed, and a second time', async () => {
    const closed = await counted({ closed: true });
    expect(await issue(riderCtx(closed.riderId), closed.stopId)).toEqual(
      refused('23514', 'STOP_NOT_ARRIVED'),
    );
    const stop = await counted();
    expect(await issue(riderCtx(stop.riderId), stop.stopId)).toHaveProperty('rows');
    expect(await issue(riderCtx(stop.riderId), stop.stopId)).toEqual(
      refused('23514', 'HANDSHAKE_EXISTS'),
    );
    expect(
      await routes.rows(`select 1 from collection_handshake where pickup_stop_id = $1`, [
        stop.stopId,
      ]),
    ).toHaveLength(1);
  });

  // Break caught: the digest of a wrong length, or no digest, accepted (the table's check refuses a digest that is not 32 bytes, and the operation refuses first).
  it('refuses a digest that is not 32 bytes and a key version that is not one', async () => {
    const stop = await counted();
    const key = riderCtx(stop.riderId);
    expect(
      await run(
        key,
        `select * from melarc.handshake_issue('${randomUUID()}'::uuid, '${stop.stopId}'::uuid, decode('abcd', 'hex'), 1, 4)`,
      ),
    ).toEqual(refused('22023'));
    expect(
      await run(
        key,
        `select * from melarc.handshake_issue('${randomUUID()}'::uuid, '${stop.stopId}'::uuid, null, 1, 4)`,
      ),
    ).toEqual(refused('22023'));
    expect(
      await run(
        key,
        `select * from melarc.handshake_issue('${randomUUID()}'::uuid, '${stop.stopId}'::uuid, ${digest('1234')}, 0, 4)`,
      ),
    ).toEqual(refused('22023'));
    // A length outside four to eight digits, or none, is not a length.
    for (const length of ['3', '9', 'null']) {
      expect(
        await run(
          key,
          `select * from melarc.handshake_issue('${randomUUID()}'::uuid, '${stop.stopId}'::uuid, ${digest('1234')}, 1, ${length})`,
        ),
        length,
      ).toEqual(refused('22023'));
    }
    expect(await handshakeOf(stop.stopId)).toBeUndefined();
  });

  // Break caught (the review of 5 November 2026): a code whose length is read again from the setting by whoever makes it again. The length of a generation is kept with it, from
  // the length the digest was made with, and refused when it is not the platform's now, so that a length and a digest never disagree; a fallback records its own.
  it('keeps the length of each code with its generation, refuses a length the platform does not hold, and freezes it with the generation', async () => {
    const stop = await counted();
    const key = riderCtx(stop.riderId);
    try {
      expect(rowOf(await issue(key, stop.stopId, '1234', randomUUID(), 4))).toMatchObject({
        out_generation: 1,
      });
      expect(
        await routes.rows(
          `select code_length from collection_handshake where pickup_stop_id = $1`,
          [stop.stopId],
        ),
      ).toEqual([{ code_length: 4 }]);

      // The platform's length changes: a code made with the old one is refused, and the one made with the new one is kept with the new one.
      await routes.admin.query(
        `update setting set value = '6'::jsonb where key = 'handshake_code_length'`,
      );
      expect(await fallback(key, stop.stopId, 1, '2222', 'NO_DATA', randomUUID(), 4)).toEqual(
        refused('23514', 'CODE_LENGTH_CHANGED'),
      );
      expect(
        rowOf(await fallback(key, stop.stopId, 1, '333333', 'NO_DATA', randomUUID(), 6)),
      ).toMatchObject({
        out_outcome: 'SENT',
        out_generation: 2,
      });
      expect(
        await routes.rows(
          `select code_length, code_generation from collection_handshake where pickup_stop_id = $1`,
          [stop.stopId],
        ),
      ).toEqual([{ code_length: 6, code_generation: 2 }]);

      // A first code made by the fallback is refused the same way, and the first generation of another stop is made with the length now held.
      const another = await counted();
      expect(
        await issue(riderCtx(another.riderId), another.stopId, '1234', randomUUID(), 4),
      ).toEqual(refused('23514', 'CODE_LENGTH_CHANGED'));
      expect(
        await issue(riderCtx(another.riderId), another.stopId, '123456', randomUUID(), 6),
      ).toHaveProperty('rows');

      // Nothing changes the inputs of a code but a new generation: not the length, not the key version, whoever writes.
      for (const text of [
        `update collection_handshake set code_length = 5 where pickup_stop_id = '${stop.stopId}'`,
        `update collection_handshake set code_key_version = 2 where pickup_stop_id = '${stop.stopId}'`,
      ]) {
        await expect(routes.admin.query(text), text).rejects.toMatchObject({ code: '23514' });
      }
    } finally {
      await routes.admin.query(
        `update setting set value = '4'::jsonb where key = 'handshake_code_length'`,
      );
    }
  });
});

describe('what the runtime login can and cannot do with the table', () => {
  // Break caught: a grant on the digest, the key version, the last fallback or the officer's note (a login that reads the digest can test a guess offline), or any write.
  it('reads where a handshake stands and nothing secret, and writes nothing of it', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId);
    const key = riderCtx(stop.riderId);
    expect(
      await run(
        key,
        `select state, code_generation, attempts, expires_at from collection_handshake where pickup_stop_id = '${stop.stopId}'`,
      ),
    ).toHaveProperty('rows');
    for (const column of ['code_digest', 'code_key_version', 'last_fallback_at', 'note']) {
      expect(
        await run(
          key,
          `select ${column} from collection_handshake where pickup_stop_id = '${stop.stopId}'`,
        ),
        column,
      ).toEqual(refused('42501'));
    }
    expect(await run(key, `select * from collection_handshake`), 'select *').toEqual(
      refused('42501'),
    );
    expect(
      await run(
        key,
        `update collection_handshake set attempts = 0 where pickup_stop_id = '${stop.stopId}'`,
      ),
    ).toEqual(refused('42501'));
    expect(
      await run(
        key,
        `update collection_handshake set state = 'VERIFIED' where pickup_stop_id = '${stop.stopId}'`,
      ),
    ).toEqual(refused('42501'));
    expect(
      await run(key, `delete from collection_handshake where pickup_stop_id = '${stop.stopId}'`),
    ).toEqual(refused('42501'));
    expect(
      await run(
        key,
        `insert into collection_handshake (id, pickup_stop_id, pickup_request_id, responsible_hub_id, direction, state, code_generation, attempts, fallback_sends)
         values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '${HUB_A}', 'VENDOR_ENTERED_RIDER_DISPLAYED', 'CODE_GENERATED', 1, 0, 0)`,
      ),
    ).toEqual(refused('42501'));
  });

  // Break caught: the policy showing a handshake to the wrong party: another rider, another vendor, a rider under a key that is not a handshake's.
  it('shows a handshake to the rider that counted the stop, the vendor whose pickup it is and the staff of its hub, and to nobody else', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId);
    const other = await arrangedRider(routes.kit, routes.admin);
    const read = `select id from collection_handshake where pickup_stop_id = '${stop.stopId}'`;
    const seen = async (context: SecurityContext): Promise<number> => {
      const outcome = await run(context, read);
      return 'rows' in outcome ? outcome.rows.length : -1;
    };
    expect(await seen(riderCtx(stop.riderId))).toBe(1);
    expect(await seen(riderCtx(stop.riderId, 'pickup.run.execute'))).toBe(1);
    expect(await seen(vendorCtx(vendorA))).toBe(1);
    expect(await seen(staffCtx('pickup.read', [HUB_A]))).toBe(1);
    expect(await seen(riderCtx(other.id))).toBe(0);
    expect(await seen(riderCtx(stop.riderId, 'pickup.read'))).toBe(0);
    expect(await seen(vendorCtx(vendorB))).toBe(0);
    expect(await seen(staffCtx('pickup.read', [HUB_B]))).toBe(0);
    expect(await seen(staffCtx('finance.read'))).toBe(0);
  });

  // Break caught: the operations executable by PUBLIC, the staff login, a worker, or the helpers (which run with the owner's rights and are for the operations).
  it('lets the API’s runtime execute the operations, nobody else, and nobody the helpers', async () => {
    const can = async (who: string, signature: string): Promise<boolean | undefined> =>
      (
        await routes.rows<{ ok: boolean }>(
          `select has_function_privilege('${who}', '${signature}', 'EXECUTE') as ok`,
        )
      )[0]?.ok;
    const operations = [
      'melarc.handshake_issue(uuid, uuid, bytea, integer, integer)',
      'melarc.handshake_verify(uuid, bytea[])',
      'melarc.handshake_sms_fallback(uuid, uuid, integer, bytea, integer, text, integer)',
      'melarc.handshake_override(uuid, uuid, text)',
      'melarc.handshake_resolve(uuid, text)',
    ];
    for (const operation of operations) {
      expect(await can('melarc_api_runtime', operation), operation).toBe(true);
      expect(await can('public', operation), operation).toBe(false);
      expect(await can('melarc_worker_cap_notification', operation), operation).toBe(false);
    }
    expect(
      await can('melarc_worker_cap_notification', 'melarc.handshake_mark_delivered(uuid, integer)'),
    ).toBe(true);
    expect(await can('melarc_api_runtime', 'melarc.handshake_mark_delivered(uuid, integer)')).toBe(
      false,
    );
    for (const helper of [
      'melarc.handshake_setting(text)',
      'melarc.handshake_event(text, text, uuid, uuid, text, text, jsonb, jsonb)',
      'melarc.handshake_envelope(uuid, uuid, uuid, integer, text)',
      'melarc.handshake_settle(uuid, uuid, uuid, text, text, text, timestamp with time zone)',
    ]) {
      expect(await can('melarc_api_runtime', helper), helper).toBe(false);
      expect(await can('public', helper), helper).toBe(false);
    }
  });
});

describe('entering a code (verifyHandshake)', () => {
  // Break caught: the stop not closed by a verified handshake, closed as the wrong state, or the record's three columns or the events left out.
  it.each([
    ['a clean count', 'MATCH', 'COLLECTED', 'pickup.stop.collected'],
    ['a short count', 'SHORT', 'PARTIALLY_COLLECTED', 'pickup.stop.partially_collected'],
  ] as const)(
    'closes the stop of %s as %s when the vendor enters the code, on the portal, with the events',
    async (_what, variance, closed, closeEvent) => {
      const stop = await counted({ variance });
      await issue(riderCtx(stop.riderId), stop.stopId, '4321');
      const from = await clock();
      const outcome = await verify(vendorCtx(vendorA), stop.stopId, '4321');
      const to = await clock();
      expect(rowOf(outcome)).toMatchObject({
        out_outcome: 'VERIFIED',
        out_state: 'VERIFIED',
        out_channel: 'PORTAL',
        out_attempts: 0,
        out_authorised_by: null,
      });
      expect(await stopState(stop.stopId)).toBe(closed);
      const record = await recordOf(stop.stopId);
      expect(record).toMatchObject({ handshake_channel: 'PORTAL', handshake_override_by: null });
      expect(record?.handshake_confirmed_at).toBeInstanceOf(Date);
      const kept = await handshakeOf(stop.stopId);
      expect(kept).toMatchObject({
        state: 'VERIFIED',
        channel: 'PORTAL',
        confirmed_by_type: 'VENDOR_ACCOUNT',
        confirmed_by_id: vendorA.row.accountId,
        authorised_by: null,
        code_digest: null,
      });
      const moments = await routes.rows<{ inside: boolean; same: boolean }>(
        `select (h.confirmed_at >= $2::timestamptz and h.confirmed_at <= $3::timestamptz) as inside,
              (h.confirmed_at = c.handshake_confirmed_at and h.confirmed_at = s.resolved_at) as same
         from collection_handshake h join collection_record c on c.pickup_stop_id = h.pickup_stop_id join pickup_stop s on s.id = h.pickup_stop_id
        where h.pickup_stop_id = $1`,
        [stop.stopId, from, to],
      );
      expect(moments).toEqual([{ inside: true, same: true }]);

      const events = await eventsOf(
        stop.stopId,
        'pickup.handshake.verified',
        'pickup.stop.collected',
        'pickup.stop.partially_collected',
      );
      expect(events.map((e) => e.event_code).toSorted()).toEqual(
        ['pickup.handshake.verified', closeEvent].toSorted(),
      );
      for (const event of events) {
        expect(event).toMatchObject({
          actor_type: 'VENDOR_ACCOUNT',
          actor_id: vendorA.row.accountId,
          surface_context: 'VENDOR_PWA',
          enhanced: false,
        });
      }
      const closing = events.find((e) => e.event_code === closeEvent);
      expect(closing).toMatchObject({
        object_type: 'PickupStop',
        previous_state: 'ARRIVED',
        resulting_state: closed,
        detail: { variance, channel: 'PORTAL' },
      });
      const verified = events.find((e) => e.event_code === 'pickup.handshake.verified');
      expect(verified).toMatchObject({
        object_type: 'CollectionHandshake',
        previous_state: 'CODE_GENERATED',
        resulting_state: 'VERIFIED',
        detail: { channel: 'PORTAL', attempts: 0 },
      });
      // A code appears in no event.
      expect(JSON.stringify(events)).not.toContain('4321');
    },
  );

  // Break caught: a wrong code not counted (or counted only when the caller's transaction commits), the remaining attempts miscounted, the handshake not ended at the limit,
  // a right code accepted after the limit, or the stop closed by any of it.
  it('counts each wrong code, ends the handshake at the fifth, and verifies nothing after that, with the stop still arrived', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    const vendor = vendorCtx(vendorA);
    for (const [wrong, attempts, remaining] of [
      [1, 1, 4],
      [2, 2, 3],
      [3, 3, 2],
      [4, 4, 1],
    ] as const) {
      expect(
        rowOf(await verify(vendor, stop.stopId, `000${String(wrong)}`)),
        `wrong code ${String(wrong)}`,
      ).toMatchObject({
        out_outcome: 'CODE_INVALID',
        out_state: 'CODE_GENERATED',
        out_attempts: attempts,
        out_remaining: remaining,
      });
    }
    expect((await handshakeOf(stop.stopId))?.attempts).toBe(4);
    expect(rowOf(await verify(vendor, stop.stopId, '0005'))).toMatchObject({
      out_outcome: 'ATTEMPTS_EXHAUSTED',
      out_state: 'EXHAUSTED',
      out_attempts: 5,
      out_remaining: 0,
    });
    expect(await handshakeOf(stop.stopId)).toMatchObject({
      state: 'EXHAUSTED',
      attempts: 5,
      code_digest: null,
    });
    // The right code, now: too late.
    expect(rowOf(await verify(vendor, stop.stopId, '1111'))).toMatchObject({
      out_outcome: 'ATTEMPTS_EXHAUSTED',
      out_state: 'EXHAUSTED',
    });
    expect(await stopState(stop.stopId)).toBe('ARRIVED');
    expect(
      await eventsOf(stop.stopId, 'pickup.handshake.verified', 'pickup.stop.collected'),
    ).toEqual([]);
  });

  // Break caught (AC-SLICE-001-26): the correct code accepted after its life (late self-confirmation), the expiry not kept, or the physical state changed by it.
  it('refuses the correct code after the life of the code, keeps the handshake expired, and leaves the stop as it was', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '2468');
    await age(stop.stopId, `expires_at = clock_timestamp() - interval '1 second'`);
    expect(rowOf(await verify(vendorCtx(vendorA), stop.stopId, '2468'))).toMatchObject({
      out_outcome: 'CODE_EXPIRED',
      out_state: 'EXPIRED',
    });
    expect(await handshakeOf(stop.stopId)).toMatchObject({
      state: 'EXPIRED',
      code_digest: null,
      channel: null,
    });
    expect(await stopState(stop.stopId)).toBe('ARRIVED');
    expect(rowOf(await verify(vendorCtx(vendorA), stop.stopId, '2468'))).toMatchObject({
      out_outcome: 'CODE_EXPIRED',
    });
    expect(await eventsOf(stop.stopId, 'pickup.stop.collected')).toEqual([]);
  });

  // Break caught: the instant of expiry judged on the application's clock or a boundary that is off by one (a code is valid until its end, and not at it).
  it('judges the end of a code on the database’s clock: a code that has not ended verifies', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '1357');
    await age(stop.stopId, `expires_at = clock_timestamp() + interval '30 seconds'`);
    expect(rowOf(await verify(vendorCtx(vendorA), stop.stopId, '1357'))).toMatchObject({
      out_outcome: 'VERIFIED',
    });
  });

  // Break caught: the rung's authority: the rider proving its own presence with the code it displays, a vendor entering a sender's code, a vendor that is not the stop's.
  it('holds who may enter which code: the vendor its rider displays, the rider the sender’s, never the rider its own display, never another vendor', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '1212');
    expect(
      await verify(riderCtx(stop.riderId), stop.stopId, '1212'),
      'the rider entering the code it displays',
    ).toEqual(refused('23514', 'WRONG_ENTRANT'));
    expect(await verify(vendorCtx(vendorB), stop.stopId, '1212'), 'another vendor').toEqual(
      refused('42501'),
    );
    expect(await verify(staffCtx(CONFIRM), stop.stopId, '1212'), 'an officer').toEqual(
      refused('42501'),
    );
    expect(
      await verify(vendorCtx(vendorA, 'pickup.read'), stop.stopId, '1212'),
      'the vendor under another key',
    ).toEqual(refused('42501'));
    expect((await handshakeOf(stop.stopId))?.attempts).toBe(0);

    const individual = await countedIndividual();
    await issue(riderCtx(individual.riderId), individual.stopId, '3434');
    expect(
      await verify(vendorCtx(vendorA), individual.stopId, '3434'),
      'a vendor at a sender’s stop',
    ).toEqual(refused('42501'));
    expect(
      rowOf(await verify(riderCtx(individual.riderId), individual.stopId, '3434')),
    ).toMatchObject({ out_outcome: 'VERIFIED', out_channel: 'PORTAL' });
    expect(await stopState(individual.stopId)).toBe('COLLECTED');
  });

  // Break caught: a handshake that was never asked for verified, a closed one entered again, or another rider entering the code of a stop it did not count.
  it('refuses a stop whose handshake has not begun, one that has ended, and a rider that did not count it', async () => {
    const fresh = await counted();
    expect(await verify(vendorCtx(vendorA), fresh.stopId, '1234')).toEqual(
      refused('23514', 'HANDSHAKE_NOT_STARTED'),
    );
    await issue(riderCtx(fresh.riderId), fresh.stopId, '1234');
    expect(rowOf(await verify(vendorCtx(vendorA), fresh.stopId, '1234'))).toMatchObject({
      out_outcome: 'VERIFIED',
    });
    expect(await verify(vendorCtx(vendorA), fresh.stopId, '1234')).toEqual(
      refused('23514', 'HANDSHAKE_CLOSED'),
    );
    const individual = await countedIndividual();
    await issue(riderCtx(individual.riderId), individual.stopId, '5555');
    const other = await arrangedRider(routes.kit, routes.admin);
    expect(await verify(riderCtx(other.id), individual.stopId, '5555')).toEqual(refused('42501'));
  });

  // Break caught: the digests of every key version not tried (a rotation would end the handshakes in flight), or a digest of one version accepted for another stop's.
  it('accepts any of the digests it is given, and none that is not the code’s', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '7777');
    expect(
      rowOf(await verify(vendorCtx(vendorA), stop.stopId, '0000', '9999', '7777')),
    ).toMatchObject({ out_outcome: 'VERIFIED' });
    const other = await counted();
    await issue(riderCtx(other.riderId), other.stopId, '7777');
    expect(rowOf(await verify(vendorCtx(vendorA), other.stopId, '0000', '9999'))).toMatchObject({
      out_outcome: 'CODE_INVALID',
      out_attempts: 1,
    });
    expect(
      await run(
        vendorCtx(vendorA),
        `select * from melarc.handshake_verify('${other.stopId}'::uuid, array[]::bytea[])`,
      ),
    ).toEqual(refused('22023'));
    // Nine is more than any rotation holds: refused, and nothing counted.
    const nine = Array.from({ length: 9 }, (_, n) => digest(String(n))).join(', ');
    expect(
      await run(
        vendorCtx(vendorA),
        `select * from melarc.handshake_verify('${other.stopId}'::uuid, array[${nine}]::bytea[])`,
      ),
    ).toEqual(refused('22023'));
    expect((await handshakeOf(other.stopId))?.attempts).toBe(1);
  });

  // Break caught: two entries at the same moment both closing the stop, or one of them a server error: the handshake's lock serialises them, the first closes the stop
  // and the second finds it ended.
  it('closes the stop once when the code is entered twice at the same moment', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '8080');
    const answers = await Promise.all([
      verify(vendorCtx(vendorA), stop.stopId, '8080'),
      verify(vendorCtx(vendorA), stop.stopId, '8080'),
    ]);
    const outcomes = answers
      .map((answer) =>
        'rows' in answer
          ? String(answer.rows[0]?.out_outcome)
          : `${answer.code}/${answer.reason ?? ''}`,
      )
      .toSorted();
    expect(outcomes).toEqual(['23514/HANDSHAKE_CLOSED', 'VERIFIED']);
    expect(await eventsOf(stop.stopId, 'pickup.stop.collected')).toHaveLength(1);
    expect(await stopState(stop.stopId)).toBe('COLLECTED');
  });

  // Break caught: the wrong attempts of two requests at the same moment counted as one (a lost update that gives a vendor more guesses than the limit).
  it('counts every wrong code of requests at the same moment: no guess is free', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '1000');
    await Promise.all(
      [1, 2, 3, 4].map((n) => verify(vendorCtx(vendorA), stop.stopId, `900${String(n)}`)),
    );
    expect((await handshakeOf(stop.stopId))?.attempts).toBe(4);
  });
});

describe('the SMS fallback (requestSmsHandshakeFallback)', () => {
  // Break caught: the fallback not superseding the code the rider was shown, not counting its send, not asking the lane, or not logging the rung.
  it('makes a new code the rider has not seen, counts the send, asks the lane for the text and logs the rung; the old code no longer verifies, the new one does by the rider, on SMS_FALLBACK', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    const outcome = await fallback(riderCtx(stop.riderId), stop.stopId, 1, '2222', 'PORTAL_DOWN');
    expect(rowOf(outcome)).toMatchObject({
      out_outcome: 'SENT',
      out_state: 'CODE_GENERATED',
      out_generation: 2,
      out_fallback_sends: 1,
      out_attempts: 0,
    });
    expect(await handshakeOf(stop.stopId)).toMatchObject({
      code_generation: 2,
      fallback_sends: 1,
      state: 'CODE_GENERATED',
    });
    expect(await outboxOf(stop.requestId)).toEqual([envelopeOf(stop.riderId, 2)]);
    const logged = await eventsOf(stop.stopId, 'pickup.handshake.fallback_sms');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      actor_type: 'RIDER',
      object_type: 'CollectionHandshake',
      resulting_state: 'CODE_GENERATED',
      detail: { generation: 2, fallback_sends: 1, trigger: 'PORTAL_DOWN' },
    });
    // The code the rider was shown is spent: a wrong attempt now.
    expect(rowOf(await verify(vendorCtx(vendorA), stop.stopId, '1111'))).toMatchObject({
      out_outcome: 'CODE_INVALID',
    });
    // The rider enters the code the vendor read out: verified on the fallback.
    expect(rowOf(await verify(riderCtx(stop.riderId), stop.stopId, '2222'))).toMatchObject({
      out_outcome: 'VERIFIED',
      out_channel: 'SMS_FALLBACK',
    });
    expect((await recordOf(stop.stopId))?.handshake_channel).toBe('SMS_FALLBACK');
  });

  // Break caught: the wrong attempts reset by a fallback (five more guesses for every text), or the fallback used for a handshake that is not live.
  it('keeps the wrong attempts already counted', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    await verify(vendorCtx(vendorA), stop.stopId, '0001');
    await verify(vendorCtx(vendorA), stop.stopId, '0002');
    expect(rowOf(await fallback(riderCtx(stop.riderId), stop.stopId, 1, '2222'))).toMatchObject({
      out_generation: 2,
      out_attempts: 2,
    });
    expect((await handshakeOf(stop.stopId))?.attempts).toBe(2);
  });

  // Break caught (AC-SLICE-001-73): the cap and the cooldown held by the application and not the database, so that a second process or a direct statement sends more.
  it('refuses a fourth send, and a send inside the cooldown, for every caller', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    const key = () => riderCtx(stop.riderId);
    expect(rowOf(await fallback(key(), stop.stopId, 1, '2222'))).toMatchObject({
      out_generation: 2,
      out_fallback_sends: 1,
    });
    // Inside the cooldown: refused, and nothing is sent or changed.
    expect(await fallback(key(), stop.stopId, 2, '3333')).toEqual(
      refused('23514', 'SMS_FALLBACK_LIMIT_REACHED'),
    );
    expect(await handshakeOf(stop.stopId)).toMatchObject({ code_generation: 2, fallback_sends: 1 });
    expect(await outboxOf(stop.requestId)).toHaveLength(1);
    // After the cooldown the second and the third go; the fourth is over the cap.
    await age(stop.stopId, `last_fallback_at = clock_timestamp() - interval '61 seconds'`);
    expect(rowOf(await fallback(key(), stop.stopId, 2, '3333'))).toMatchObject({
      out_generation: 3,
      out_fallback_sends: 2,
    });
    await age(stop.stopId, `last_fallback_at = clock_timestamp() - interval '61 seconds'`);
    expect(rowOf(await fallback(key(), stop.stopId, 3, '4444'))).toMatchObject({
      out_generation: 4,
      out_fallback_sends: 3,
    });
    await age(stop.stopId, `last_fallback_at = clock_timestamp() - interval '61 seconds'`);
    expect(await fallback(key(), stop.stopId, 4, '5555')).toEqual(
      refused('23514', 'SMS_FALLBACK_LIMIT_REACHED'),
    );
    expect(await handshakeOf(stop.stopId)).toMatchObject({ code_generation: 4, fallback_sends: 3 });
    expect(await outboxOf(stop.requestId)).toHaveLength(3);
    expect(await eventsOf(stop.stopId, 'pickup.handshake.fallback_sms')).toHaveLength(3);
  });

  // Break caught: two sends at the same moment both going (the cap read before the row is locked), or one of them a server error.
  it('sends once of two requests at the same moment', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    const key = () => riderCtx(stop.riderId);
    const answers = await Promise.all([
      fallback(key(), stop.stopId, 1, '2222'),
      fallback(key(), stop.stopId, 1, '3333'),
    ]);
    const sorted = answers
      .map((answer) => ('rows' in answer ? 'SENT' : `${answer.code}/${answer.reason ?? ''}`))
      .toSorted();
    expect(sorted).toEqual(['23514/GENERATION_CHANGED', 'SENT']);
    expect((await handshakeOf(stop.stopId))?.fallback_sends).toBe(1);
  });

  // Break caught: a fallback sent to a vendor with no registered number, for a sender (who is texted in the first place), after the handshake ended, with a stale generation.
  it('refuses a vendor with no registered number, an individual sender, a handshake that has ended and a generation that moved', async () => {
    // Vendor B has a business contact number and no credential phone: the business contact is no registered number. Vendor C has a phone on its credential whose messages go
    // to its address: the number is registered and is not the channel the vendor is reached by.
    for (const vendor of [vendorB, vendorC]) {
      const noNumber = await counted({ vendor });
      await issue(riderCtx(noNumber.riderId), noNumber.stopId, '1111');
      expect(await fallback(riderCtx(noNumber.riderId), noNumber.stopId, 1, '2222')).toEqual(
        refused('23514', 'NO_REGISTERED_NUMBER'),
      );
      expect(await outboxOf(noNumber.requestId)).toEqual([]);
    }

    // A number nobody has proved: the credential has a phone on the PHONE channel and the vendor never set its secret from the grant sent there (the review of 5 November
    // 2026: "verified by possession" is what makes the number the vendor's). It is not registered until the secret is set.
    const unproved = await routes.vendor();
    // The vendor guard allows a secret to be set or removed only with the acts of the credential; the arrangement of this test is the administrator's, so the guard is
    // stood aside for these statements alone and put back.
    const arrangeCredential = async (change: string): Promise<void> => {
      await routes.admin.query('alter table vendor_credential disable trigger user');
      try {
        await routes.admin.query(
          `update vendor_credential set ${change} where vendor_account_id = $1`,
          [unproved.row.accountId],
        );
      } finally {
        await routes.admin.query('alter table vendor_credential enable trigger user');
      }
    };
    await arrangeCredential(
      `recovery_phone = '+233205550000', delivery_channel = 'PHONE', secret_hash = null, credential_established_at = null, credential_generation = 0`,
    );
    const waiting = await counted({ vendor: unproved });
    await issue(riderCtx(waiting.riderId), waiting.stopId, '1111');
    expect(await fallback(riderCtx(waiting.riderId), waiting.stopId, 1, '2222')).toEqual(
      refused('23514', 'NO_REGISTERED_NUMBER'),
    );
    await arrangeCredential(
      `secret_hash = 'fixture-hash', credential_established_at = clock_timestamp(), credential_generation = 1`,
    );
    expect('rows' in (await fallback(riderCtx(waiting.riderId), waiting.stopId, 1, '2222'))).toBe(
      true,
    );

    const individual = await countedIndividual();
    await issue(riderCtx(individual.riderId), individual.stopId, '1111');
    expect(await fallback(riderCtx(individual.riderId), individual.stopId, 1, '2222')).toEqual(
      refused('23514', 'FALLBACK_NOT_APPLICABLE'),
    );

    const done = await counted();
    await issue(riderCtx(done.riderId), done.stopId, '1111');
    await verify(vendorCtx(vendorA), done.stopId, '1111');
    expect(await fallback(riderCtx(done.riderId), done.stopId, 1, '2222')).toEqual(
      refused('23514', 'STOP_NOT_ARRIVED'),
    );

    const moved = await counted();
    await issue(riderCtx(moved.riderId), moved.stopId, '1111');
    expect(await fallback(riderCtx(moved.riderId), moved.stopId, 0, '2222')).toEqual(
      refused('23514', 'GENERATION_CHANGED'),
    );
    expect(await fallback(riderCtx(moved.riderId), moved.stopId, 2, '2222')).toEqual(
      refused('23514', 'GENERATION_CHANGED'),
    );
  });

  // Break caught: the fallback unusable until the code has been shown (a rider whose portal was down from the start): it makes the handshake itself; and the
  // reason it is asked for (a vendor too busy is not one).
  it('makes the handshake itself when none has begun, and takes only the reasons of a technical failure', async () => {
    const stop = await counted();
    expect(await fallback(riderCtx(stop.riderId), stop.stopId, 0, '2222', 'VENDOR_BUSY')).toEqual(
      refused('22023'),
    );
    expect(await handshakeOf(stop.stopId)).toBeUndefined();
    expect(
      rowOf(await fallback(riderCtx(stop.riderId), stop.stopId, 0, '2222', 'NO_DATA')),
    ).toMatchObject({ out_generation: 1, out_fallback_sends: 1, out_state: 'CODE_GENERATED' });
    expect(await outboxOf(stop.requestId)).toHaveLength(1);
  });

  // Break caught: a code that ran out sent again (a fallback must not revive a handshake that routes to Ops), or the expiry not kept.
  it('does not revive a code that has run out: the handshake is marked expired and routes to Ops', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    await age(stop.stopId, `expires_at = clock_timestamp() - interval '1 second'`);
    expect(rowOf(await fallback(riderCtx(stop.riderId), stop.stopId, 1, '2222'))).toMatchObject({
      out_outcome: 'CODE_EXPIRED',
      out_state: 'EXPIRED',
    });
    expect(await handshakeOf(stop.stopId)).toMatchObject({
      state: 'EXPIRED',
      code_generation: 1,
      fallback_sends: 0,
    });
    expect(await outboxOf(stop.requestId)).toEqual([]);
  });

  // Break caught: another rider, another key, an officer or a vendor asking for a fallback.
  it('is the rider that counted the stop’s alone', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    const other = await arrangedRider(routes.kit, routes.admin);
    for (const context of [
      riderCtx(other.id),
      riderCtx(stop.riderId, 'pickup.run.execute'),
      staffCtx(CONFIRM),
      vendorCtx(vendorA),
    ]) {
      expect(await fallback(context, stop.stopId, 1, '2222')).toEqual(refused('42501'));
    }
    expect((await handshakeOf(stop.stopId))?.fallback_sends).toBe(0);
  });
});

describe('the officer’s override and resolution', () => {
  // Break caught: the override not closing the stop, not naming the officer, not recording the channel and the note, or written under the wrong actor.
  it.each([
    [
      'a handshake with a live code',
      async (s: Counted) => {
        await issue(riderCtx(s.riderId), s.stopId, '1111');
      },
      'CODE_GENERATED',
    ],
    [
      'an exhausted handshake',
      async (s: Counted) => {
        await issue(riderCtx(s.riderId), s.stopId, '1111');
        await age(s.stopId, `state = 'EXHAUSTED', code_digest = null, attempts = 5`);
      },
      'EXHAUSTED',
    ],
    [
      'an expired handshake',
      async (s: Counted) => {
        await issue(riderCtx(s.riderId), s.stopId, '1111');
        await age(s.stopId, `state = 'EXPIRED', code_digest = null`);
      },
      'EXPIRED',
    ],
    ['no handshake at all', () => Promise.resolve(), null],
  ] as const)(
    'establishes the collection from %s by override: verified on OPS_OVERRIDE naming the officer, the stop closed',
    async (_what, arrange, before) => {
      const stop = await counted({ variance: 'SHORT' });
      await arrange(stop);
      const outcome = await override(
        staffCtx(OVERRIDE, [HUB_A]),
        stop.stopId,
        'Phoned the vendor on the number we hold',
      );
      expect(rowOf(outcome)).toMatchObject({
        out_previous_state: before,
        out_state: 'VERIFIED',
        out_channel: 'OPS_OVERRIDE',
        out_authorised_by: officerId,
        out_stop_state: 'PARTIALLY_COLLECTED',
      });
      expect(await handshakeOf(stop.stopId)).toMatchObject({
        state: 'VERIFIED',
        channel: 'OPS_OVERRIDE',
        confirmed_by_type: 'STAFF',
        confirmed_by_id: officerId,
        authorised_by: officerId,
        note: 'Phoned the vendor on the number we hold',
        code_digest: null,
      });
      expect(await stopState(stop.stopId)).toBe('PARTIALLY_COLLECTED');
      expect(await recordOf(stop.stopId)).toMatchObject({
        handshake_channel: 'OPS_OVERRIDE',
        handshake_override_by: officerId,
      });
      const events = await eventsOf(stop.stopId, 'pickup.stop.partially_collected');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor_type: 'STAFF',
        actor_id: officerId,
        surface_context: 'OPS_PORTAL',
        detail: { channel: 'OPS_OVERRIDE', variance: 'SHORT' },
      });
    },
  );

  // Break caught: the note not required, a blank one accepted, the wrong key, another hub's officer, or a caller that is not an officer.
  it('needs the note, the key of the override and an officer of the stop’s hub', async () => {
    const stop = await counted();
    expect(await override(staffCtx(OVERRIDE, [HUB_A]), stop.stopId, '   ')).toEqual(
      refused('23514', 'REASON_REQUIRED'),
    );
    expect(await override(staffCtx(RESOLVE, [HUB_A]), stop.stopId)).toEqual(refused('42501'));
    expect(await override(staffCtx(OVERRIDE, [HUB_B]), stop.stopId)).toEqual(refused('42501'));
    expect(await override(riderCtx(stop.riderId, OVERRIDE), stop.stopId)).toEqual(refused('42501'));
    expect(await override(vendorCtx(vendorA, OVERRIDE), stop.stopId)).toEqual(refused('42501'));
    expect(await stopState(stop.stopId)).toBe('ARRIVED');
    expect(await handshakeOf(stop.stopId)).toBeUndefined();
    expect(rowOf(await override(staffCtx(OVERRIDE, 'ALL'), stop.stopId))).toMatchObject({
      out_state: 'VERIFIED',
    });
  });

  // Break caught: the override's own key not asked for. The resolution's key passes the policies that update a handshake, so the key is the operation's to refuse
  // for a handshake that exists (for none, the policy of the insert refuses it first).
  it('refuses the key of the resolution for the override of a handshake that exists', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    expect(await override(staffCtx(RESOLVE, [HUB_A]), stop.stopId)).toEqual(refused('42501'));
    expect(await handshakeOf(stop.stopId)).toMatchObject({ state: 'CODE_GENERATED' });
    expect(await stopState(stop.stopId)).toBe('ARRIVED');
  });

  // Break caught (the review of 5 November 2026): the override, the way out of a handshake that cannot go on, made to depend on a platform setting (the length of a code) that may be
  // missing or out of range, so that an officer is refused for a number nobody uses, for a handshake that has no code. The row records the least length the table allows.
  it.each([
    ['a length of three, below the least a code has', '3'],
    ['a length of nine, above the most a code has', '9'],
    ['a length that is not a number', '"four"'],
    ['a length that is not a whole number', '4.5'],
    ['no value', 'null'],
  ] as const)(
    'establishes the collection of a stop with no handshake when the platform holds %s',
    async (_what, value) => {
      await routes.admin.query(
        `update setting set value = $1::jsonb where key = 'handshake_code_length'`,
        [value],
      );
      try {
        const stop = await counted();

        const outcome = await override(
          staffCtx(OVERRIDE, [HUB_A]),
          stop.stopId,
          'Phoned the vendor on the number we hold',
        );

        expect(rowOf(outcome)).toMatchObject({
          out_state: 'VERIFIED',
          out_channel: 'OPS_OVERRIDE',
        });
        expect(await handshakeOf(stop.stopId)).toMatchObject({
          state: 'VERIFIED',
          code_generation: 0,
          code_length: 4,
        });
        expect(await stopState(stop.stopId)).toBe('COLLECTED');
      } finally {
        await routes.admin.query(
          `update setting set value = '4'::jsonb where key = 'handshake_code_length'`,
        );
      }
    },
  );

  // Break caught: a handshake that has ended, on a stop that is still arrived at (a state no operation makes, forced here), overridden or resolved again.
  it('refuses an ended handshake whatever the stop stands at', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    await age(
      stop.stopId,
      `state = 'VERIFIED', code_digest = null, channel = 'PORTAL', confirmed_at = now(), confirmed_by_type = 'VENDOR_ACCOUNT', confirmed_by_id = gen_random_uuid()`,
    );
    expect(await override(staffCtx(OVERRIDE, [HUB_A]), stop.stopId)).toEqual(
      refused('23514', 'HANDSHAKE_CLOSED'),
    );
    expect(await resolve(staffCtx(RESOLVE, [HUB_A]), stop.stopId)).toEqual(
      refused('23514', 'HANDSHAKE_CLOSED'),
    );
    expect(await verify(vendorCtx(vendorA), stop.stopId, '1111')).toEqual(
      refused('23514', 'HANDSHAKE_CLOSED'),
    );
    expect(await stopState(stop.stopId)).toBe('ARRIVED');
  });

  // Break caught: a stop overridden that is not counted, not arrived at, or whose handshake has already ended; the override of an overridden stop.
  it('refuses a stop that is not counted, not arrived at, or already closed', async () => {
    const arranged = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendorA.row.organizationId,
      serviceDate: days.today,
      state: 'IN_PROGRESS',
      stops: 1,
      stopStates: ['ARRIVED'],
    });
    expect(await override(staffCtx(OVERRIDE), arranged.stops[0]?.id ?? '')).toEqual(
      refused('23514', 'COLLECTION_NOT_RECORDED'),
    );
    const closed = await counted({ closed: true });
    expect(await override(staffCtx(OVERRIDE), closed.stopId)).toEqual(
      refused('23514', 'STOP_NOT_ARRIVED'),
    );
    const stop = await counted();
    expect(rowOf(await override(staffCtx(OVERRIDE), stop.stopId))).toMatchObject({
      out_state: 'VERIFIED',
    });
    expect(await override(staffCtx(OVERRIDE), stop.stopId)).toEqual(
      refused('23514', 'STOP_NOT_ARRIVED'),
    );
    const verified = await counted();
    await issue(riderCtx(verified.riderId), verified.stopId, '1111');
    await verify(vendorCtx(vendorA), verified.stopId, '1111');
    expect(await override(staffCtx(OVERRIDE), verified.stopId)).toEqual(
      refused('23514', 'STOP_NOT_ARRIVED'),
    );
  });

  // Break caught: the manual resolution of a live code (the vendor can still enter it), of one that has ended, with no note, or by the officer of the override.
  it('resolves an expired or exhausted handshake by hand, and a live one whose life has passed, and nothing else', async () => {
    const live = await counted();
    await issue(riderCtx(live.riderId), live.stopId, '1111');
    expect(await resolve(staffCtx(RESOLVE), live.stopId)).toEqual(
      refused('23514', 'NOT_RESOLVABLE'),
    );
    expect(await resolve(staffCtx(OVERRIDE), live.stopId)).toEqual(refused('42501'));
    expect(await resolve(staffCtx(RESOLVE), live.stopId, '  ')).toEqual(
      refused('23514', 'REASON_REQUIRED'),
    );
    await age(live.stopId, `expires_at = clock_timestamp() - interval '1 second'`);
    expect(rowOf(await resolve(staffCtx(RESOLVE, [HUB_A]), live.stopId))).toMatchObject({
      out_previous_state: 'EXPIRED',
      out_state: 'MANUALLY_RESOLVED',
      out_channel: 'OPS_OVERRIDE',
      out_authorised_by: officerId,
      out_stop_state: 'COLLECTED',
    });
    expect(await handshakeOf(live.stopId)).toMatchObject({
      state: 'MANUALLY_RESOLVED',
      channel: 'OPS_OVERRIDE',
      note: 'The vendor confirmed by phone and sent a photo',
      code_digest: null,
    });
    expect(await stopState(live.stopId)).toBe('COLLECTED');
    expect(await resolve(staffCtx(RESOLVE), live.stopId)).toEqual(
      refused('23514', 'STOP_NOT_ARRIVED'),
    );

    const exhausted = await counted({ variance: 'SHORT' });
    await issue(riderCtx(exhausted.riderId), exhausted.stopId, '1111');
    await age(exhausted.stopId, `state = 'EXHAUSTED', code_digest = null, attempts = 5`);
    expect(rowOf(await resolve(staffCtx(RESOLVE), exhausted.stopId))).toMatchObject({
      out_previous_state: 'EXHAUSTED',
      out_stop_state: 'PARTIALLY_COLLECTED',
    });

    const none = await counted();
    expect(await resolve(staffCtx(RESOLVE), none.stopId)).toEqual(
      refused('23514', 'HANDSHAKE_NOT_STARTED'),
    );
    expect(await resolve(staffCtx(RESOLVE, [HUB_B]), none.stopId)).toEqual(refused('42501'));
  });
});

describe('the delivery of a code (the notification lane)', () => {
  // Break caught: the handshake moved by anyone but the lane, at a generation it has left, or twice; the event written more than once or by the wrong actor.
  it('moves the handshake to delivered once, for the generation it was told, as the system, and for nobody else', async () => {
    const stop = await countedIndividual();
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    const kept = await handshakeOf(stop.stopId);
    const id = String(kept?.id);
    const mark = (context: SecurityContext, generation: number) =>
      run(
        context,
        `select melarc.handshake_mark_delivered('${id}'::uuid, ${String(generation)}) as moved`,
      );
    expect(await mark(riderCtx(stop.riderId), 1)).toEqual(refused('42501'));
    expect(await mark(staffCtx('pickup.read'), 1)).toEqual(refused('42501'));
    // A generation the handshake has left (or never reached): nothing is written.
    expect(rowOf(await mark(laneCtx(stop.requestId), 2))).toEqual({ moved: false });
    expect(await handshakeOf(stop.stopId)).toMatchObject({ state: 'CODE_GENERATED' });
    // The lane of another request sees no handshake of this one.
    expect(rowOf(await mark(laneCtx(randomUUID()), 1))).toEqual({ moved: false });
    expect(rowOf(await mark(laneCtx(stop.requestId), 1))).toEqual({ moved: true });
    expect(await handshakeOf(stop.stopId)).toMatchObject({ state: 'CODE_DELIVERED' });
    expect(rowOf(await mark(laneCtx(stop.requestId), 1))).toEqual({ moved: false });
    const events = await eventsOf(stop.stopId, 'pickup.handshake.delivered');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_type: 'SYSTEM',
      actor_id: null,
      surface_context: 'SYSTEM',
      previous_state: 'CODE_GENERATED',
      resulting_state: 'CODE_DELIVERED',
      detail: { generation: 1 },
    });
    // A delivered code verifies like any other.
    expect(rowOf(await verify(riderCtx(stop.riderId), stop.stopId, '1111'))).toMatchObject({
      out_outcome: 'VERIFIED',
    });
  });

  // Break caught: the lane reading more of a handshake than the columns a text is made from, or the handshake of a request its envelope does not name.
  it('reads the one handshake its envelope names, the columns a code is made from, and no digest', async () => {
    const stop = await countedIndividual();
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    const lane = laneCtx(stop.requestId);
    const read = await run(
      lane,
      `select id, pickup_stop_id, direction, state, code_generation, code_key_version, code_length, expires_at from collection_handshake`,
    );
    expect(read).toHaveProperty('rows');
    expect('rows' in read && read.rows.length).toBe(1);
    expect(await run(lane, `select code_digest from collection_handshake`)).toEqual(
      refused('42501'),
    );
    expect(await run(lane, `select attempts from collection_handshake`)).toEqual(refused('42501'));
    const elsewhere = await run(laneCtx(randomUUID()), `select id from collection_handshake`);
    expect('rows' in elsewhere && elsewhere.rows.length).toBe(0);
  });

  // Break caught (F-23): the lane reading the organisation, its business contact or the credential itself (the table holds the secret's hash), the number given for a request
  // the envelope does not name, to a context that is not the lane, or while no fallback code is live for the request.
  it('learns the registered number only through its function, for the request its envelope names and only while a fallback code is live', async () => {
    const stop = await counted();
    const lane = laneCtx(stop.requestId);
    const ask = `select melarc.notification_handshake_number() as phone`;

    // The tables themselves are no business of the lane: neither the organisation (the business contact among its columns) nor the credential.
    expect(await run(lane, `select contact_phone from vendor_organization`)).toEqual(
      refused('42501'),
    );
    expect(await run(lane, `select id from vendor_organization`)).toEqual(refused('42501'));
    expect(await run(lane, `select recovery_phone from vendor_credential`)).toEqual(
      refused('42501'),
    );
    expect(await run(lane, `select id from vendor_account`)).toEqual(refused('42501'));

    // No handshake yet, and a primary rung (no fallback sent): no number.
    expect(await run(lane, ask)).toEqual({ rows: [{ phone: null }] });
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    expect(await run(lane, ask)).toEqual({ rows: [{ phone: null }] });

    // A fallback is live: the credential's number, not the business contact's.
    await fallback(riderCtx(stop.riderId), stop.stopId, 1, '2222');
    expect(await run(lane, ask)).toEqual({ rows: [{ phone: '+233201112222' }] });
    // Not for the request of another envelope, and not to the rider, the vendor, a member of staff or the other capability.
    expect(await run(laneCtx(randomUUID()), ask)).toEqual({ rows: [{ phone: null }] });
    for (const who of [riderCtx(stop.riderId), vendorCtx(vendorA), staffCtx(OVERRIDE)]) {
      expect(await run(who, ask), who.principalType).toEqual(refused('42501'));
    }
    // The internal helper is the operations' own: nobody executes it.
    expect(
      await run(
        riderCtx(stop.riderId),
        `select melarc.vendor_registered_number('${vendorA.row.organizationId}'::uuid)`,
      ),
    ).toEqual(refused('42501'));
    expect(
      await run(
        lane,
        `select melarc.vendor_registered_number('${vendorA.row.organizationId}'::uuid)`,
      ),
    ).toEqual(refused('42501'));

    // The code ends (a verified entry): no number is given any more.
    expect(rowOf(await verify(riderCtx(stop.riderId), stop.stopId, '2222'))).toMatchObject({
      out_outcome: 'VERIFIED',
    });
    expect(await run(lane, ask)).toEqual({ rows: [{ phone: null }] });

    // An individual sender is texted at the number of its own record: the function gives none.
    const individual = await countedIndividual();
    await issue(riderCtx(individual.riderId), individual.stopId, '1111');
    expect(await run(laneCtx(individual.requestId), ask)).toEqual({ rows: [{ phone: null }] });
  });

  // Break caught: a number given for a code past its life only because the handshake has not yet been marked expired (the mark is made by the next act on the handshake, and
  // the lane judges the life of a code itself): the function gives nothing once the code has run out.
  it('gives no number once the fallback code has run out, though the handshake is not yet marked expired', async () => {
    const stop = await counted();
    const lane = laneCtx(stop.requestId);
    const ask = `select melarc.notification_handshake_number() as phone`;
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    await fallback(riderCtx(stop.riderId), stop.stopId, 1, '2222');
    expect(await run(lane, ask)).toEqual({ rows: [{ phone: '+233201112222' }] });

    await age(stop.stopId, `expires_at = clock_timestamp() - interval '1 second'`);

    expect(await handshakeOf(stop.stopId)).toMatchObject({ state: 'CODE_GENERATED' });
    expect(await run(lane, ask)).toEqual({ rows: [{ phone: null }] });
  });

  // Break caught (the review of 5 November 2026): the owner-run reads of the vendor's account and credential open to every row, so that the two functions were all that stood
  // between the rider's key or the lane and every vendor's credential. A statement that runs as the owner in those contexts sees the organisation concerned and no other:
  // for the rider, the organisation of a request whose stop it counted; for the lane, the organisation of the request its envelope names. (A probe function of the owner,
  // made here and dropped after, stands for a statement of an operation that is not one of the two.)
  it('is bound, for the owner-run statements of its contexts, to the vendor concerned: the account and the credential of that organisation and no other', async () => {
    const mine = await counted();
    const theirs = await counted({ vendor: vendorB });
    await routes.admin.query(
      `create function melarc.probe_registered_number_rows() returns table (organisations uuid[], accounts uuid[])
         language sql security definer set search_path = pg_catalog, pg_temp as $$
         select (select coalesce(array_agg(a.vendor_organization_id order by a.vendor_organization_id), '{}') from public.vendor_account a),
                (select coalesce(array_agg(c.vendor_account_id order by c.vendor_account_id), '{}') from public.vendor_credential c)
       $$`,
    );
    await routes.admin.query(
      `alter function melarc.probe_registered_number_rows() owner to melarc_owner`,
    );
    await routes.admin.query(
      `revoke all on function melarc.probe_registered_number_rows() from public`,
    );
    await routes.admin.query(
      `grant execute on function melarc.probe_registered_number_rows() to melarc_api_runtime, melarc_worker_runtime, melarc_worker_cap_notification`,
    );
    const ask = `select * from melarc.probe_registered_number_rows()`;
    const seen = async (context: SecurityContext) => {
      const outcome = await run(context, ask);
      return 'rows' in outcome
        ? outcome.rows.map((row) => ({ organisations: row.organisations, accounts: row.accounts }))
        : outcome;
    };
    try {
      // The rider that counted vendor A's stop, under the key of the fallback: vendor A's rows. The rider of vendor B's stop: vendor B's. A rider that counted nothing: none.
      expect(await seen(riderCtx(mine.riderId))).toEqual([
        { organisations: [vendorA.row.organizationId], accounts: [vendorA.row.accountId] },
      ]);
      expect(await seen(riderCtx(theirs.riderId))).toEqual([
        { organisations: [vendorB.row.organizationId], accounts: [vendorB.row.accountId] },
      ]);
      expect(await seen(riderCtx(randomUUID()))).toEqual([{ organisations: [], accounts: [] }]);
      // Under another key of the rider the owner-run statement reads nothing of them.
      expect(await seen(riderCtx(mine.riderId, 'pickup.run.execute'))).toEqual([
        { organisations: [], accounts: [] },
      ]);
      // The lane: the organisation of the request its envelope names, and nothing for an envelope that names none.
      expect(await seen(laneCtx(mine.requestId))).toEqual([
        { organisations: [vendorA.row.organizationId], accounts: [vendorA.row.accountId] },
      ]);
      expect(await seen(laneCtx(theirs.requestId))).toEqual([
        { organisations: [vendorB.row.organizationId], accounts: [vendorB.row.accountId] },
      ]);
      expect(await seen(laneCtx(randomUUID()))).toEqual([{ organisations: [], accounts: [] }]);
    } finally {
      await routes.admin.query(`drop function melarc.probe_registered_number_rows()`);
    }
  });
});

describe('the table’s own guard, for every writer', () => {
  const admin = (text: string, values: unknown[] = []) => routes.admin.query(text, values);

  // Break caught: the state machine, the counters and the immutable columns held by the operations alone, so that any other writer could undo a wrong code, jump a
  // state, rewrite a generation or move a handshake to another stop.
  it('refuses a move the machine does not make, a counter that goes back or jumps, and a column that never changes', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    await verify(vendorCtx(vendorA), stop.stopId, '0001');
    for (const change of [
      `attempts = 0`,
      `code_generation = 5`,
      `code_generation = 0`,
      `fallback_sends = 2`,
      `state = 'MANUALLY_RESOLVED', code_digest = null`,
      `state = 'DISPUTED', code_digest = null`,
      `direction = 'SENDER_SMS_RIDER_ENTERED'`,
      `pickup_request_id = gen_random_uuid()`,
      `created_at = now()`,
      `state = 'EXPIRED', code_generation = code_generation + 1, code_digest = null`,
    ]) {
      await expect(
        admin(`update collection_handshake set ${change} where pickup_stop_id = $1`, [stop.stopId]),
        change,
      ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) as unknown });
    }
    expect(await handshakeOf(stop.stopId)).toMatchObject({
      attempts: 1,
      code_generation: 1,
      state: 'CODE_GENERATED',
    });
  });

  // Break caught: a handshake that has ended well changed (a channel rewritten, a verified handshake undone), or moved anywhere but to a dispute.
  it('freezes a handshake that has ended well, but for its move to a dispute', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    await verify(vendorCtx(vendorA), stop.stopId, '1111');
    for (const change of [
      `channel = 'OPS_OVERRIDE', authorised_by = gen_random_uuid()`,
      `state = 'EXPIRED'`,
      `state = 'CODE_GENERATED'`,
      `attempts = 9`,
    ]) {
      await expect(
        admin(`update collection_handshake set ${change} where pickup_stop_id = $1`, [stop.stopId]),
        change,
      ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) as unknown });
    }
    await admin(`update collection_handshake set state = 'DISPUTED' where pickup_stop_id = $1`, [
      stop.stopId,
    ]);
    expect((await handshakeOf(stop.stopId))?.state).toBe('DISPUTED');
    await expect(
      admin(`update collection_handshake set state = 'VERIFIED' where pickup_stop_id = $1`, [
        stop.stopId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // Break caught: a handshake made for a stop that is not counted, in the other direction than its record fixes, or naming another stop's request, or with a digest of the wrong size.
  it('refuses a handshake for a stop with no count, in the other direction, for another request, or with a digest that is not 32 bytes', async () => {
    const stop = await counted();
    const insert = (over: Record<string, string>) => {
      const row: Record<string, string> = {
        id: `'${randomUUID()}'`,
        pickup_stop_id: `'${stop.stopId}'`,
        pickup_request_id: `'${stop.requestId}'`,
        responsible_hub_id: `'${HUB_A}'`,
        direction: `'VENDOR_ENTERED_RIDER_DISPLAYED'`,
        state: `'CODE_GENERATED'`,
        code_generation: '1',
        code_digest: `decode('${'ab'.repeat(32)}', 'hex')`,
        code_key_version: '1',
        code_length: '4',
        code_generated_at: 'now()',
        expires_at: `now() + interval '15 minutes'`,
        ...over,
      };
      return admin(
        `insert into collection_handshake (${Object.keys(row).join(', ')}) values (${Object.values(row).join(', ')})`,
      );
    };
    await expect(insert({ direction: `'SENDER_SMS_RIDER_ENTERED'` })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert({ pickup_request_id: `'${randomUUID()}'` })).rejects.toMatchObject({
      code: expect.stringMatching(/^23/) as unknown,
    });
    await expect(insert({ code_digest: `decode('abcd', 'hex')` })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert({ state: `'EXPIRED'`, code_digest: 'null' })).rejects.toMatchObject({
      code: '23514',
    });
    const arranged = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendorA.row.organizationId,
      serviceDate: days.today,
      state: 'IN_PROGRESS',
      stops: 1,
      stopStates: ['ARRIVED'],
    });
    const uncounted = arranged.stops[0];
    await expect(
      insert({
        pickup_stop_id: `'${uncounted?.id ?? ''}'`,
        pickup_request_id: `'${uncounted?.requestId ?? ''}'`,
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await insert({});
    await expect(insert({ id: `'${randomUUID()}'` })).rejects.toMatchObject({ code: '23505' });
  });

  // Break caught: the version moved by the writer, or not moved at all by a change.
  it('moves the version itself, on each change and on none that changes nothing', async () => {
    const stop = await counted();
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    expect((await handshakeOf(stop.stopId))?.version).toBe(1);
    await verify(vendorCtx(vendorA), stop.stopId, '0001');
    expect((await handshakeOf(stop.stopId))?.version).toBe(2);
    await admin(`update collection_handshake set attempts = attempts where pickup_stop_id = $1`, [
      stop.stopId,
    ]);
    expect((await handshakeOf(stop.stopId))?.version).toBe(2);
  });

  // Break caught: the stop closed by a writer that is not an operation, or by an operation with no handshake that has ended, or as the other state than the count says.
  it('closes a stop for no writer but the operations: not the runtime login, not an administrator with no ended handshake, and never as the other state', async () => {
    const stop = await counted({ variance: 'SHORT' });
    // A statement of the runtime login changes nothing of the stop: its policies find no row to update, or refuse the new one.
    const writes = `update pickup_stop set state = 'COLLECTED', resolved_at = now() where id = '${stop.stopId}' returning id`;
    for (const [who, context] of [
      ['the rider', riderCtx(stop.riderId)],
      ['the vendor', vendorCtx(vendorA)],
      ['an officer', staffCtx(OVERRIDE)],
    ] as const) {
      const outcome = await run(context, writes);
      expect('rows' in outcome ? outcome.rows : outcome.code, who).toSatisfy((seen: unknown) =>
        Array.isArray(seen) ? seen.length === 0 : seen === '42501' || seen === '23514',
      );
    }
    expect(await stopState(stop.stopId)).toBe('ARRIVED');
    await issue(riderCtx(stop.riderId), stop.stopId, '1111');
    // A closing under the operations' keys with no handshake that has ended (the keys are an operation's: the statement runs as the owner under the key).
    const asOwner = async (context: SecurityContext, text: string): Promise<string> => {
      await routes.admin.query('begin');
      try {
        await routes.admin.query('set local role melarc_owner');
        const { toContextSettings } =
          await import('../../src/platform/database/transaction-context.js');
        for (const [name, value] of toContextSettings(context))
          await routes.admin.query('select set_config($1, $2, true)', [name, value]);
        await routes.admin.query(text);
        return 'ran';
      } catch (error) {
        return serverErrorIn(error)?.code ?? 'other';
      } finally {
        await routes.admin.query('rollback');
      }
    };
    const close = (state: string) =>
      `update pickup_stop set state = '${state}', resolved_at = now() where id = '${stop.stopId}'`;
    expect(
      await asOwner(vendorCtx(vendorA), close('PARTIALLY_COLLECTED')),
      'no handshake that has ended',
    ).toBe('23514');
    await age(
      stop.stopId,
      `state = 'VERIFIED', code_digest = null, channel = 'PORTAL', confirmed_at = now(), confirmed_by_type = 'VENDOR_ACCOUNT', confirmed_by_id = gen_random_uuid()`,
    );
    expect(
      await asOwner(vendorCtx(vendorA), close('COLLECTED')),
      'the other state than the count says',
    ).toBe('23514');
    expect(
      await asOwner(vendorCtx(vendorA), close('PARTIALLY_COLLECTED')),
      'as the count says',
    ).toBe('ran');
    expect(await asOwner(vendorCtx(vendorA), close('FAILED')), 'any other state').toBe('23514');
    expect(
      await asOwner(
        vendorCtx(vendorA),
        `update pickup_stop set sequence = sequence + 1 where id = '${stop.stopId}'`,
      ),
      'another column',
    ).toBe('23514');
    expect(
      await asOwner(
        vendorCtx(vendorA),
        `update pickup_stop set state = 'PARTIALLY_COLLECTED', resolved_at = now(), sequence = sequence + 1 where id = '${stop.stopId}'`,
      ),
      'a close that writes another column',
    ).toBe('23514');
  });

  // Break caught: the ledger admitting the events of the handshake to a statement of the runtime login (a marker, a key, the right facts): they are the operations', run as the owner.
  it('takes the events of the handshake from no statement of the runtime login', async () => {
    const stop = await counted();
    const event = (code: string, objectType: string, objectId: string, actor: string) =>
      `insert into audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, responsible_hub_id, object_type, object_id, correlation_id, outcome, enhanced, serialisation_version, related_ids)
       values (gen_random_uuid(), '${code}', now(), '${actor}', '${actor === 'RIDER' ? stop.riderId : vendorA.row.accountId}'::uuid, '${actor === 'RIDER' ? 'RIDER_ANDROID' : 'VENDOR_PWA'}', '${HUB_A}', '${objectType}', '${objectId}'::uuid, 'collection-handshake', 'SUCCEEDED', false, 1,
               '{"pickup_stop_id": "${stop.stopId}", "pickup_request_id": "${stop.requestId}"}'::jsonb)`;
    for (const code of [
      'pickup.handshake.generated',
      'pickup.handshake.fallback_sms',
      'pickup.handshake.verified',
    ]) {
      expect(
        await run(
          riderCtx(stop.riderId),
          event(code, 'CollectionHandshake', randomUUID(), 'RIDER'),
        ),
        code,
      ).toEqual(refused('42501'));
    }
    for (const code of ['pickup.stop.collected', 'pickup.stop.partially_collected']) {
      expect(
        await run(riderCtx(stop.riderId), event(code, 'PickupStop', stop.stopId, 'RIDER')),
        code,
      ).toEqual(refused('42501'));
    }
    for (const code of ['pickup.handshake.verified', 'pickup.stop.collected']) {
      expect(
        await run(
          vendorCtx(vendorA),
          event(code, 'CollectionHandshake', randomUUID(), 'VENDOR_ACCOUNT'),
        ),
        code,
      ).toEqual(refused('42501'));
    }
    expect(
      await run(
        laneCtx(stop.requestId),
        `insert into audit_event (id, event_code, occurred_at, actor_type, surface_context, responsible_hub_id, object_type, object_id, correlation_id, outcome, enhanced, serialisation_version)
        values (gen_random_uuid(), 'pickup.handshake.delivered', now(), 'SYSTEM', 'SYSTEM', '${HUB_A}', 'CollectionHandshake', gen_random_uuid(), 'collection-handshake', 'SUCCEEDED', false, 1)`,
      ),
    ).toEqual(refused('42501'));
    expect(await eventsOf(stop.stopId)).toEqual([]);
  });
});

describe('the counted-stop authority has two conditions, and the database holds each (the Product Owner, 4 November 2026)', () => {
  /**
   * A stop that the rider the run is assigned to did not count: another rider's record stands for it (no operation makes one, so it is arranged as the
   * administrator does). The assigned rider is not the one that counted; the one that counted is not assigned. With `handshake`, a live code exists.
   */
  async function split(handshake: boolean) {
    const arranged = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendorA.row.organizationId,
      serviceDate: days.today,
      state: 'IN_PROGRESS',
      stops: 1,
      stopStates: ['ARRIVED'],
    });
    const stop = arranged.stops[0];
    if (stop === undefined) throw new Error('stop');
    const recorder = await arrangedRider(routes.kit, routes.admin);
    await insertRecordFor(
      arranged,
      stop.id,
      'MATCH',
      'VENDOR_ENTERED_RIDER_DISPLAYED',
      recorder.id,
    );
    if (handshake) {
      await routes.admin.query(
        `insert into collection_handshake (id, pickup_stop_id, pickup_request_id, responsible_hub_id, direction, state, code_generation, code_digest, code_key_version, code_length,
                                           code_generated_at, expires_at)
         values (gen_random_uuid(), $1, $2, $3, 'VENDOR_ENTERED_RIDER_DISPLAYED', 'CODE_GENERATED', 1, decode($4, 'hex'), 1, 4, clock_timestamp(),
                 clock_timestamp() + interval '15 minutes')`,
        [stop.id, stop.requestId, HUB_A, 'ab'.repeat(32)],
      );
    }
    return { assigned: arranged.rider.id, recorder: recorder.id, stopId: stop.id };
  }

  // Break caught: the rider the run is assigned to, that did not count, asking for the code, entering one or asking for the fallback (custody alone is the same
  // case: a rider that holds the run and did not record the count); and the rider that counted, no longer the run's rider, doing the same.
  it('asks for the code of no rider but the one that counted while it is assigned', async () => {
    // The rider the run is assigned to reads no record but its own (the record's policy), so another rider's record is, to it, no record: the answer is the
    // uniform one, and the recording-rider check inside the operations is the second line behind that policy. The rider that counted and is no longer the run's
    // rider is refused by the assignment.
    const withoutCode = await split(false);
    const none = refused('23514', 'COLLECTION_NOT_RECORDED');
    expect(await issue(riderCtx(withoutCode.assigned), withoutCode.stopId)).toEqual(none);
    expect(await issue(riderCtx(withoutCode.recorder), withoutCode.stopId)).toEqual(
      refused('42501'),
    );
    expect(await fallback(riderCtx(withoutCode.assigned), withoutCode.stopId, 0, '2222')).toEqual(
      none,
    );
    expect(await fallback(riderCtx(withoutCode.recorder), withoutCode.stopId, 0, '2222')).toEqual(
      refused('42501'),
    );
    expect(await handshakeOf(withoutCode.stopId)).toBeUndefined();

    const withCode = await split(true);
    expect(await verify(riderCtx(withCode.assigned), withCode.stopId, '1234')).toEqual(none);
    expect(await verify(riderCtx(withCode.recorder), withCode.stopId, '1234')).toEqual(
      refused('42501'),
    );
    expect(await fallback(riderCtx(withCode.assigned), withCode.stopId, 1, '2222')).toEqual(none);
    expect(await fallback(riderCtx(withCode.recorder), withCode.stopId, 1, '2222')).toEqual(
      refused('42501'),
    );
    expect((await handshakeOf(withCode.stopId))?.attempts).toBe(0);
  });
});

describe('the lock order: a handshake meets the other acts on its stop in one order', () => {
  // Break caught: the stop not locked first, so that a handshake and a skip both commit, or a handshake made at a stop another transaction is closing.
  it('waits for the stop’s lock: a code asked for while the stop is held is made after the holder lets go', async () => {
    const stop = await counted();
    const holding = held(riderCtx(stop.riderId), async (statement) => {
      await statement(`select id from pickup_stop where id = '${stop.stopId}' for update`);
    });
    try {
      const pid = await holding.ready;
      const issuing = issue(riderCtx(stop.riderId), stop.stopId, '1111');
      await waitUntilBlockedBy(routes.admin, pid, 'the code', issuing);
      holding.release();
      await holding.done;
      expect(rowOf(await issuing)).toMatchObject({ out_state: 'CODE_GENERATED' });
    } finally {
      holding.release();
      await holding.done.catch(() => undefined);
    }
  });

  // Break caught (the review of 5 November 2026): a key of the handshake on the request, whose key-share lock made the first handshake of a stop wait for the request while it
  // held the stop, against the cancellation, which takes the request and then the stop: each waited for the other and the database ended one of them (a deadlock). The first code of
  // a stop is made while another transaction holds its request for update, and does not wait for it.
  it('takes no lock on the request: the first code is made while the request is held, without waiting for the holder', async () => {
    const stop = await counted();
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(`select id from pickup_request where id = $1 for update`, [
        stop.requestId,
      ]);

      const outcome = await Promise.race([
        issue(riderCtx(stop.riderId), stop.stopId, '1111'),
        new Promise<'waited'>((resolve) =>
          setTimeout(() => {
            resolve('waited');
          }, 5000),
        ),
      ]);

      expect(outcome).not.toBe('waited');
      expect(rowOf(outcome as Outcome)).toMatchObject({ out_state: 'CODE_GENERATED' });
    } finally {
      await holder.query('rollback');
      await holder.end();
    }
  });
});

// This is the last describe of the file: it takes the column away and puts it back, as the migration does, and the tests above are done with the table.
describe('the migration that gives each handshake the length of its code (0073)', () => {
  /** The block of the migration that adds the column and fills it, exactly as the migration file holds it. */
  const BLOCK = /DO \$code_length\$[\s\S]*?\$code_length\$;/.exec(
    readFileSync(
      join(MIGRATIONS_FOLDER, '0073_review_closeout_handshake_ceiling_extension.sql'),
      'utf8',
    ),
  )?.[0];

  // Break caught (the review of 5 November 2026, "include the handshakes that exist in the migration plan"): the handshakes of a database the migration finds, in every state, left
  // without a length, or given one the platform cannot hold, or the whole migration stopped by a setting that is not a whole number. Each row takes the length the platform holds on
  // the day of the migration, and 4 (the confirmed value) where that cannot be used; and no row is left with a default that would hide a later insert that states none.
  it.each([
    ['6', 6],
    ['8', 8],
    ['4', 4],
    ['12', 4],
    ['3', 4],
    ['4.5', 4],
    ['"four"', 4],
    ['null', 4],
  ] as const)(
    'gives the handshakes that exist, in every state, the platform length of the day when it is usable (%s), and 4 when it is not',
    async (value, expected) => {
      expect(BLOCK).toBeDefined();
      const live = await counted();
      await issue(riderCtx(live.riderId), live.stopId, '1111');
      const sent = await counted();
      await issue(riderCtx(sent.riderId), sent.stopId, '1111');
      await fallback(riderCtx(sent.riderId), sent.stopId, 1, '2222');
      const ended = await counted();
      await issue(riderCtx(ended.riderId), ended.stopId, '1111');
      await age(ended.stopId, `state = 'EXPIRED', code_digest = null`);
      const closed = await counted();
      expect(rowOf(await override(staffCtx(OVERRIDE, [HUB_A]), closed.stopId))).toMatchObject({
        out_state: 'VERIFIED',
      });

      await routes.admin.query(
        `update setting set value = $1::jsonb where key = 'handshake_code_length'`,
        [value],
      );
      try {
        // What the migration does to a database that has the table without the column (the statements around the block are the migration's own).
        await routes.admin.query('begin');
        await routes.admin.query(
          `alter table collection_handshake drop constraint collection_handshake_code_length_range`,
        );
        await routes.admin.query(`alter table collection_handshake drop column code_length`);
        await routes.admin.query(BLOCK ?? '');
        await routes.admin.query(
          `alter table collection_handshake add constraint collection_handshake_code_length_range check (code_length between 4 and 8)`,
        );
        await routes.admin.query(
          `grant select ("code_length") on collection_handshake to melarc_worker_cap_notification`,
        );
        await routes.admin.query('commit');

        const held = await routes.admin.query<{ code_length: number; n: string }>(
          `select code_length, count(*) as n from collection_handshake group by code_length`,
        );
        expect(held.rows.map((row) => row.code_length)).toEqual([expected]);
        expect(Number(held.rows[0]?.n)).toBeGreaterThanOrEqual(4);
        const column = await routes.admin.query<{
          column_default: string | null;
          is_nullable: string;
        }>(
          `select column_default, is_nullable from information_schema.columns where table_name = 'collection_handshake' and column_name = 'code_length'`,
        );
        expect(column.rows).toEqual([{ column_default: null, is_nullable: 'NO' }]);
      } finally {
        await routes.admin.query('rollback').catch(() => undefined);
        await routes.admin.query(
          `update setting set value = '4'::jsonb where key = 'handshake_code_length'`,
        );
      }
    },
  );
});
