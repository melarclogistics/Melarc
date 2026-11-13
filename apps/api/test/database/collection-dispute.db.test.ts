import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { guardReasonIn, serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { excusePhotos } from './support/evidence-photo.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, type ArrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.29, `disputeCollection` (`pickup.collection.confirm` on the Vendor surface; `AC-SLICE-001-27`; domain-model.md section 6.19; state-machines.md section 6),
 * against a real PostgreSQL and the real application. The claims:
 *
 * - **A dispute raises a reconciliation item and never reverses physical completion**: the stop stays as it closed (`COLLECTED` or `PARTIALLY_COLLECTED`),
 *   the handshake becomes `DISPUTED` in the same change, one event carries the actor and the note, and the manifest may still complete without waiting.
 * - **Whose, and when**: the vendor whose pickup it is, after the stop has closed through its handshake, once (a failed or skipped stop has no collection
 *   to dispute); another vendor's stop and an id that matches nothing are `NOT_FOUND`, the same.
 * - **Reads are by party**: Ops in the hub reads the item, the vendor that raised it reads it, nobody else; and the runtime login writes none.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let vendorB: ArrangedVendor;
let browser: TestClient;
let ops: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  vendorB = await routes.vendor();
  browser = routes.browser(vendorA.device.credential.token);
  expect((await routes.signIn(browser, vendorA.row.accountIdentifier, vendorA.secret)).status).toBe(
    200,
  );
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const STOP = (id: string) => `${API}/pickup-stops/${id}`;
const DISPUTE = (id: string) => `${STOP(id)}/dispute`;

interface Dispute {
  readonly id: string;
  readonly pickup_stop_id: string;
  readonly state: string;
  readonly raised_by: string;
  readonly note: string;
  readonly created_at: string;
}
const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];
const ruleOf = (response: TestResponse): string | undefined =>
  (response.json() as { details?: { rule?: string } }).details?.rule;

const tokenOf = async (rider: ArrangedRider, stopId: string): Promise<string> =>
  (await rider.client.get(STOP(stopId))).header('etag') ?? '';

/** A run in progress with two stops, the first arrived at and counted and its collection closed by Ops's override. */
async function collected(collectedCount = 3, vendor: ArrangedVendor = vendorA) {
  const arranged: ArrangedRun = await arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendor.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 2,
    stopStates: ['ARRIVED', 'PENDING'],
  });
  const stop = arranged.stops[0];
  if (stop === undefined) throw new Error('stop');
  // The disputes are about the collection, not the photos (D-A10): the stop is let through without them.
  await excusePhotos(routes, stop.id);
  const count = await arranged.rider.client.post(
    `${STOP(stop.id)}/collect`,
    collectedCount < 3
      ? { collected_count: collectedCount, variance_reason_code: 'SOME_PARCELS_NOT_READY' }
      : { collected_count: collectedCount },
    {
      headers: {
        'If-Match': await tokenOf(arranged.rider, stop.id),
        'Idempotency-Key': randomUUID(),
      },
    },
  );
  expect(count.status).toBe(200);
  const closed = await ops.client.post(
    `${STOP(stop.id)}/handshake/ops-override`,
    { verification_note: 'Phoned the vendor on the number we hold' },
    { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
  );
  expect(closed.status).toBe(200);
  return { arranged, stop, second: arranged.stops[1] };
}

const dispute = (
  stopId: string,
  note = 'Two of the three parcels were not ours',
  key: string = randomUUID(),
  client: TestClient = browser,
) => client.post(DISPUTE(stopId), { note }, { headers: { 'Idempotency-Key': key } });

const stopState = async (stopId: string) =>
  (await routes.rows<{ state: string }>(`select state from pickup_stop where id = $1`, [stopId]))[0]
    ?.state;
const handshakeState = async (stopId: string) =>
  (
    await routes.rows<{ state: string }>(
      `select state from collection_handshake where pickup_stop_id = $1`,
      [stopId],
    )
  )[0]?.state;
const itemsOf = (stopId: string) =>
  routes.rows<{
    state: string;
    vendor_organization_id: string;
    raised_by: string;
    note: string;
    version: number;
  }>(
    `select state, vendor_organization_id, raised_by, note, version from collection_dispute where pickup_stop_id = $1`,
    [stopId],
  );

describe('disputeCollection', () => {
  // Break caught (AC-SLICE-001-27): the dispute reversing the stop, not raising the item, not setting the handshake, no event, a replay raising a second item.
  it.each([
    ['a clean count', 3, 'COLLECTED'],
    ['a short count', 2, 'PARTIALLY_COLLECTED'],
  ] as const)(
    'raises the item for %s, leaves the stop %s, sets the handshake DISPUTED, and writes one event with the note',
    async (_what, count, closed) => {
      const { stop } = await collected(count);
      expect(await stopState(stop.id)).toBe(closed);
      const key = randomUUID();
      const raised = await dispute(stop.id, 'Two of the three parcels were not ours', key);
      expect(raised.status).toBe(201);
      const body = raised.json() as Dispute;
      expect(body).toMatchObject({
        pickup_stop_id: stop.id,
        state: 'OPEN',
        raised_by: vendorA.row.accountId,
        note: 'Two of the three parcels were not ours',
      });
      expect(Date.parse(body.created_at)).not.toBeNaN();
      expect(await stopState(stop.id)).toBe(closed);
      expect(await handshakeState(stop.id)).toBe('DISPUTED');
      expect(await itemsOf(stop.id)).toEqual([
        {
          state: 'OPEN',
          vendor_organization_id: vendorA.row.organizationId,
          raised_by: vendorA.row.accountId,
          note: 'Two of the three parcels were not ours',
          version: 1,
        },
      ]);
      const events = await routes.rows<{
        actor_type: string;
        actor_id: string;
        surface_context: string;
        previous_state: string;
        resulting_state: string;
        note: string;
        enhanced: boolean;
        detail: Record<string, unknown>;
      }>(
        `select actor_type, actor_id, surface_context, previous_state, resulting_state, note, enhanced, detail from audit_event where event_code = 'pickup.handshake.disputed' and related_ids ->> 'pickup_stop_id' = $1`,
        [stop.id],
      );
      expect(events).toEqual([
        {
          actor_type: 'VENDOR_ACCOUNT',
          actor_id: vendorA.row.accountId,
          surface_context: 'VENDOR_PWA',
          previous_state: 'VERIFIED',
          resulting_state: 'DISPUTED',
          note: 'Two of the three parcels were not ours',
          enhanced: false,
          detail: { stop_state: closed, physical_completion_reversed: false },
        },
      ]);
      // The same key is the same answer and no second item.
      const again = await dispute(stop.id, 'Two of the three parcels were not ours', key);
      expect(again.status).toBe(201);
      expect(again.json()).toEqual(body);
      expect(await itemsOf(stop.id)).toHaveLength(1);
      expect(outcome(await dispute(stop.id, 'A different note', key))).toEqual([
        409,
        'IDEMPOTENCY_KEY_CONFLICT',
      ]);
    },
  );

  // Break caught (AC-SLICE-001-27): the manifest held for a dispute. The rule the database holds for the completion of a run is that nothing is left to work; a
  // stop that closed and was disputed is a stop with nothing left to work. (The system completes only a run that collected nothing, and the completion of a run
  // that collected parcels is the custody holder's hub handover, which this slice does not build: the completion is made here as the administrator, to whom the
  // guard applies as it applies to every writer.)
  it('does not hold the manifest: the run can complete when its other stop is settled', async () => {
    const { arranged, stop, second } = await collected();
    expect((await dispute(stop.id)).status).toBe(201);
    if (second === undefined) throw new Error('second stop');
    // The run cannot complete while a stop is still to be worked, as before the dispute.
    const complete = `update pickup_manifest set state = 'COMPLETED', completed_at = now() where id = '${arranged.manifest.id}'`;
    await expect(routes.admin.query(complete)).rejects.toMatchObject({ code: '23514' });
    const skipped = await ops.client.post(
      `${STOP(second.id)}/skip`,
      { reason_code: 'RUN_CUT_SHORT' },
      {
        origin: OPS,
        headers: {
          'If-Match': (await ops.client.get(STOP(second.id))).header('etag') ?? '',
          'Idempotency-Key': randomUUID(),
        },
      },
    );
    expect(skipped.status).toBe(200);
    await routes.admin.query(complete);
    expect(
      (
        await routes.rows<{ state: string }>(`select state from pickup_manifest where id = $1`, [
          arranged.manifest.id,
        ])
      )[0]?.state,
    ).toBe('COMPLETED');
    expect(await stopState(stop.id)).toBe('COLLECTED');
    expect(await handshakeState(stop.id)).toBe('DISPUTED');
    expect(await itemsOf(stop.id)).toHaveLength(1);
  });

  // Break caught: a dispute of a stop that has not closed, of a skipped or failed one (no dispute form by design), a second for the same collection.
  it('refuses a stop that has not closed (STATE_CONFLICT), a stop that was skipped, and a second dispute', async () => {
    const run = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendorA.row.organizationId,
      serviceDate: days.today,
      state: 'IN_PROGRESS',
      stops: 2,
      stopStates: ['ARRIVED', 'PENDING'],
    });
    const open = run.stops[0];
    const pending = run.stops[1];
    if (open === undefined || pending === undefined) throw new Error('stops');
    for (const stop of [open, pending]) {
      const refused = await dispute(stop.id);
      expect(outcome(refused)).toEqual([409, 'STATE_CONFLICT']);
      expect(ruleOf(refused)).toBe('stop_not_closed');
    }
    expect(
      (
        await ops.client.post(
          `${STOP(pending.id)}/skip`,
          { reason_code: 'RUN_CUT_SHORT' },
          {
            origin: OPS,
            headers: {
              'If-Match': (await ops.client.get(STOP(pending.id))).header('etag') ?? '',
              'Idempotency-Key': randomUUID(),
            },
          },
        )
      ).status,
    ).toBe(200);
    expect(ruleOf(await dispute(pending.id))).toBe('stop_not_closed');

    // A stop that failed has no collection to dispute either (`AC-SLICE-001-35`: a vendor cannot reverse a failure by complaining).
    const failing = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendorA.row.organizationId,
      serviceDate: days.today,
      state: 'IN_PROGRESS',
      stops: 1,
      stopStates: ['ARRIVED'],
    });
    const failed = failing.stops[0];
    if (failed === undefined) throw new Error('stop');
    expect(
      (
        await failing.rider.client.post(
          `${STOP(failed.id)}/fail`,
          {
            category: 'PARCEL_NOT_READY',
            reason_code: 'PARCELS_NOT_PACKED',
            note: 'The parcels were not packed',
          },
          {
            headers: {
              'If-Match': await tokenOf(failing.rider, failed.id),
              'Idempotency-Key': randomUUID(),
            },
          },
        )
      ).status,
    ).toBe(200);
    const afterFailure = await dispute(failed.id);
    expect(outcome(afterFailure)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(afterFailure)).toBe('stop_not_closed');
    expect(await itemsOf(failed.id)).toEqual([]);

    const { stop } = await collected();
    expect((await dispute(stop.id)).status).toBe(201);
    const second = await dispute(stop.id, 'Again');
    expect(outcome(second)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(second)).toBe('dispute_open');
    expect(await itemsOf(stop.id)).toHaveLength(1);
  });

  // Break caught: another vendor disputing a collection that is not its own, the note optional, a rider or an officer reaching the route.
  it('is the pickup’s own vendor’s: another vendor and an unknown id are NOT_FOUND, a blank note is REASON_REQUIRED, and a rider or an officer is PERMISSION_DENIED', async () => {
    const { arranged, stop } = await collected();
    const foreign = routes.browser(vendorB.device.credential.token);
    expect(
      (await routes.signIn(foreign, vendorB.row.accountIdentifier, vendorB.secret)).status,
    ).toBe(200);
    expect(outcome(await dispute(stop.id, 'Not mine', randomUUID(), foreign))).toEqual([
      404,
      'NOT_FOUND',
    ]);
    expect(outcome(await dispute(randomUUID()))).toEqual([404, 'NOT_FOUND']);
    expect(outcome(await dispute(stop.id, '   '))).toEqual([422, 'REASON_REQUIRED']);
    expect(
      outcome(
        await arranged.rider.client.post(
          DISPUTE(stop.id),
          { note: 'x' },
          { headers: { 'Idempotency-Key': randomUUID() } },
        ),
      ),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(
      outcome(
        await ops.client.post(
          DISPUTE(stop.id),
          { note: 'x' },
          { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
        ),
      ),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(await itemsOf(stop.id)).toEqual([]);
    expect(await handshakeState(stop.id)).toBe('VERIFIED');
  });

  // Break caught (the review of 5 November 2026): the stop locked before it is known to be the caller's, so that another vendor's request waits for the lock of a stop that is not its
  // own, and can tell by how long that someone is working on it. It is refused, the same, at once.
  it('does not lock a stop that is not the calling vendor’s: it is refused at once while another transaction holds that stop', async () => {
    const { stop } = await collected();
    const foreign = routes.browser(vendorB.device.credential.token);
    expect(
      (await routes.signIn(foreign, vendorB.row.accountIdentifier, vendorB.secret)).status,
    ).toBe(200);
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(`select id from pickup_stop where id = $1 for update`, [stop.id]);

      const answer = await Promise.race([
        dispute(stop.id, 'Not mine', randomUUID(), foreign),
        new Promise<'waited'>((resolve) =>
          setTimeout(() => {
            resolve('waited');
          }, 4000),
        ),
      ]);

      expect(answer).not.toBe('waited');
      expect(outcome(answer as TestResponse)).toEqual([404, 'NOT_FOUND']);
    } finally {
      await holder.query('rollback');
      await holder.end();
    }
  });

  // Break caught: two disputes of one collection at the same moment both raised, or both refused: the stop is locked and the second meets the first's end.
  it('raises one item when the collection is disputed twice at the same moment', async () => {
    const { stop } = await collected();

    const answers = await Promise.all([
      dispute(stop.id, 'First of two'),
      dispute(stop.id, 'Second of two'),
    ]);

    expect(answers.map((each) => each.status).toSorted()).toEqual([201, 409]);
    expect(await itemsOf(stop.id)).toHaveLength(1);
    expect(await handshakeState(stop.id)).toBe('DISPUTED');
  });
});

// Break caught: a note the ledger could not keep (too long, or text its screening refuses) reaching the database, where it would be a server error after the act began.
describe('the note of a dispute is the vendor’s words, bounded as the ledger bounds a note', () => {
  it('refuses a note that is too long or that the ledger would refuse, as a malformed body, before anything is raised', async () => {
    const { stop } = await collected();
    const long = await dispute(stop.id, 'x'.repeat(1001));
    expect(outcome(long)).toEqual([400, 'VALIDATION_FAILED']);
    expect(
      (long.json() as { details?: { violations?: { pointer: string; rule: string }[] } }).details
        ?.violations,
    ).toEqual([{ in: 'body', pointer: '/note', rule: 'maxLength' }]);
    const address = await dispute(stop.id, 'Please write to ama@example.com about it');
    expect(outcome(address)).toEqual([400, 'VALIDATION_FAILED']);
    expect(await itemsOf(stop.id)).toEqual([]);
    expect(await handshakeState(stop.id)).toBe('VERIFIED');
    expect((await dispute(stop.id, 'x'.repeat(1000))).status).toBe(201);
  });

  // Break caught (the review of 5 November 2026): the vendor's words reaching the append-only ledger as they are, though the writer of every other note removes a secret that travels
  // inside a text (the event of a dispute is written by the database function, which does not pass the writer). The note is screened as the writer screens it and the screened
  // text is what the item, the event and the answer hold: the secret is in none of them, and the same words are in all three.
  it.each([
    [
      'a key and a value that is a secret',
      'The slip said token=abc123def456 and was not ours',
      'abc123def456',
    ],
    [
      'a credential inside an address',
      'See https://user:hunter2@example.test/slip for the slip',
      'hunter2',
    ],
    [
      'a bearer credential',
      'The driver showed Authorization: Bearer abcdefghijklmnop on his phone',
      'abcdefghijklmnop',
    ],
  ] as const)(
    'keeps a note that carries %s with the secret removed, in the item, the event and the answer alike',
    async (_what, note, secret) => {
      const { stop } = await collected();

      const raised = await dispute(stop.id, note);

      expect(raised.status).toBe(201);
      const kept = (raised.json() as Dispute).note;
      expect(kept).toContain('[REDACTED]');
      expect(kept).not.toContain(secret);
      expect((await itemsOf(stop.id)).map((row) => row.note)).toEqual([kept]);
      const events = await routes.rows<{ note: string | null }>(
        `select note from audit_event where event_code = 'pickup.handshake.disputed' and related_ids ->> 'pickup_stop_id' = $1`,
        [stop.id],
      );
      expect(events.map((row) => row.note)).toEqual([kept]);
      const everywhere = await routes.rows<{ n: string }>(
        `select (
         (select count(*) from collection_dispute where note like '%' || $1 || '%')
       + (select count(*) from audit_event where to_jsonb(audit_event)::text like '%' || $1 || '%')
       + (select count(*) from idempotency_record where convert_from(coalesce(response_body, ''::bytea), 'UTF8') like '%' || $1 || '%')
       )::text as n`,
        [secret],
      );
      expect(everywhere[0]?.n).toBe('0');
    },
  );

  // Break caught: a note the writer would keep refused, because the screening that removes a secret was taken for a reason to refuse. An ordinary sentence with a word the
  // scrubber takes for a scheme is kept (the scrubber turns the word after it into a marker, as it does for the ledger of every operation).
  it('keeps an ordinary sentence that has a word the scrubber takes for a credential scheme', async () => {
    const { stop } = await collected();

    const raised = await dispute(stop.id, 'Basic items were short by two');

    expect(raised.status).toBe(201);
    expect((raised.json() as Dispute).note).toBe('Basic [REDACTED] were short by two');
  });
});

describe('what the database holds of a dispute, for every writer', () => {
  const vendorContext = (vendor: ArrangedVendor): SecurityContext => ({
    principalType: 'VENDOR',
    principalId: vendor.row.accountId,
    sessionId: randomUUID(),
    surface: 'VENDOR_PWA',
    authorizationKey: 'pickup.collection.confirm',
    vendorOrganizationId: vendor.row.organizationId,
    hubScopeMode: 'SET',
    authorizedHubIds: [],
    correlationId: randomUUID(),
  });
  const staffContext = (hubs: readonly string[]): SecurityContext => ({
    principalType: 'STAFF',
    principalId: randomUUID(),
    sessionId: randomUUID(),
    surface: 'OPS_PORTAL',
    authorizationKey: 'pickup.read',
    hubScopeMode: 'SET',
    authorizedHubIds: [...hubs],
    correlationId: randomUUID(),
  });
  const riderContext = (riderId: string): SecurityContext => ({
    principalType: 'RIDER',
    principalId: riderId,
    sessionId: randomUUID(),
    surface: 'RIDER_ANDROID',
    riderId,
    authorizationKey: 'pickup.collection.confirm',
    hubScopeMode: 'SET',
    authorizedHubIds: [],
    correlationId: randomUUID(),
  });
  async function attempt(
    context: SecurityContext,
    text: string,
  ): Promise<{ rows?: unknown[]; code?: string; reason?: string }> {
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

  // Break caught: a dispute readable by the wrong party; the item is Ops's reconciliation item and its vendor's own.
  it('is read by Ops in the hub and by the vendor that raised it, and by nobody else', async () => {
    const { arranged, stop } = await collected();
    expect((await dispute(stop.id)).status).toBe(201);
    const read = `select id from collection_dispute where pickup_stop_id = '${stop.id}'`;
    const seen = async (context: SecurityContext) => {
      const outcome = await attempt(context, read);
      return outcome.rows === undefined ? -1 : outcome.rows.length;
    };
    expect(await seen(staffContext([HUB_A]))).toBe(1);
    expect(await seen(staffContext([HUB_B]))).toBe(0);
    expect(await seen(vendorContext(vendorA))).toBe(1);
    expect(await seen(vendorContext(vendorB))).toBe(0);
    expect(await seen(riderContext(arranged.rider.id))).toBe(0);
  });

  // Break caught: the runtime login writing a dispute itself (an item for a collection that was never disputed, or one that changes), or the operation reachable by a wrong key.
  it('is written by no statement of the runtime login, and the operation answers the vendor’s key alone', async () => {
    const { arranged, stop } = await collected();
    const vendor = vendorContext(vendorA);
    const insert = `insert into collection_dispute (id, pickup_stop_id, responsible_hub_id, vendor_organization_id, raised_by, note, state)
       values (gen_random_uuid(), '${stop.id}', '${HUB_A}', '${vendorA.row.organizationId}', '${vendorA.row.accountId}', 'x', 'OPEN')`;
    expect((await attempt(vendor, insert)).code).toBe('42501');
    expect((await attempt(vendor, `update collection_dispute set note = 'y'`)).code).toBe('42501');
    expect((await attempt(vendor, `delete from collection_dispute`)).code).toBe('42501');
    const call = `select * from melarc.dispute_collection(gen_random_uuid(), '${stop.id}', 'x')`;
    expect((await attempt({ ...vendor, authorizationKey: 'pickup.read' }, call)).code).toBe(
      '42501',
    );
    expect((await attempt(riderContext(arranged.rider.id), call)).code).toBe('42501');
    expect((await attempt(staffContext([HUB_A]), call)).code).toBe('42501');
    // The note is the operation's own to require, whoever calls it: a blank one is refused with its reason, and nothing is raised.
    const blank = await attempt(
      vendor,
      `select * from melarc.dispute_collection(gen_random_uuid(), '${stop.id}', '   ')`,
    );
    expect([blank.code, blank.reason]).toEqual(['23514', 'REASON_REQUIRED']);
    expect(await handshakeState(stop.id)).toBe('VERIFIED');
    expect(await itemsOf(stop.id)).toEqual([]);
  });

  // Break caught: the table's guard held by the operation alone: an item for a stop that has not closed, a second open one, an item changed after it was raised.
  it('refuses an item for a collection that has not closed, a second open item, and any change but OPEN to RESOLVED', async () => {
    const run = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendorA.row.organizationId,
      serviceDate: days.today,
      state: 'IN_PROGRESS',
      stops: 1,
      stopStates: ['ARRIVED'],
    });
    const arrived = run.stops[0];
    if (arrived === undefined) throw new Error('stop');
    const insert = (stopId: string) =>
      routes.admin.query(
        `insert into collection_dispute (id, pickup_stop_id, responsible_hub_id, vendor_organization_id, raised_by, note) values ($1, $2, $3, $4, $5, 'a note')`,
        [randomUUID(), stopId, HUB_A, vendorA.row.organizationId, vendorA.row.accountId],
      );
    await expect(insert(arrived.id)).rejects.toMatchObject({ code: '23514' });

    const { stop } = await collected();
    // The handshake must already be disputed for the item to name it.
    await expect(insert(stop.id)).rejects.toMatchObject({ code: '23514' });
    expect((await dispute(stop.id)).status).toBe(201);
    await expect(insert(stop.id)).rejects.toMatchObject({ code: '23505' });
    await expect(
      routes.admin.query(
        `update collection_dispute set note = 'changed' where pickup_stop_id = $1`,
        [stop.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      routes.admin.query(
        `update collection_dispute set vendor_organization_id = $2 where pickup_stop_id = $1`,
        [stop.id, vendorB.row.organizationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await routes.admin.query(
      `update collection_dispute set state = 'RESOLVED', resolved_at = now() where pickup_stop_id = $1`,
      [stop.id],
    );
    expect((await itemsOf(stop.id))[0]).toMatchObject({ state: 'RESOLVED', version: 2 });
    await expect(
      routes.admin.query(
        `update collection_dispute set state = 'OPEN', resolved_at = null where pickup_stop_id = $1`,
        [stop.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
