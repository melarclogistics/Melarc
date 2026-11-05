import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { waitUntilBlockedBy } from './support/lock-wait.js';
import {
  holdingPickupRequest,
  insertPickupRequest,
  operatingDay,
  pickupRequestRow,
} from './support/pickups.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.18, `extendPickupAttempts` and `escalatePickupRequest` against the real application and a real PostgreSQL (`AC-SLICE-001-06`, `-07`;
 * pickup-request.md section 5.2; pickup-failure.md sections 5 and 13; state-machines.md section 3; `MSC-DEC-116`): the cap holds without a
 * Senior Ops extension, an extension permits one further attempt and records the actor, the reason and the ceiling before and after, and Ops
 * can escalate a request out of its own hands once. The recording of a failure is S1.28's: these tests prove the chain around it.
 *
 * The reasons of a cancellation are fixtures of the tests' own: the codes of the `PICKUP_CANCELLATION` domain are the Product Owner's to supply
 * (D-05) and none is seeded.
 */
const ONE = (id: string) => `${API}/pickup-requests/${id}`;
const EXTEND = (id: string) => `${API}/pickup-requests/${id}/attempt-extension`;
const ESCALATE = (id: string) => `${API}/pickup-requests/${id}/escalate`;
const CANCEL = (id: string) => `${API}/pickup-requests/${id}/cancel`;
const CONFIRM = (id: string) => `${API}/pickup-requests/${id}/confirm`;
const REASON = 'The vendor was closed and asked us to come back';
const NOTE = 'Rider found the shop closed on the third visit and the vendor asked for review';
const CANCEL_REASON = 'FIXTURE_CANCEL_CUSTOMER';

let routes: VendorRoutes;
let ops: Actor;
let opsTwo: Actor;
let opsEscalating: Actor;
let opsB: Actor;
let senior: Actor;
let seniorTwo: Actor;
let seniorB: Actor;
let seniorRaces: Actor;
let platformAdmin: Actor;
let vendorOne: ArrangedVendor;
let vendorInB: ArrangedVendor;
let browserOne: TestClient;
let ahead: string;

beforeAll(async () => {
  // The races hold a row until the test has seen the operation wait for it: the test ends the wait and not a bound, so the database's lock
  // bound is lengthened for this application alone. Nothing here tests a timeout.
  routes = await startVendorRoutes({
    env: {
      DATABASE_LOCK_TIMEOUT_MS: '20000',
      DATABASE_STATEMENT_TIMEOUT_MS: '25000',
      DATABASE_TRANSACTION_TIMEOUT_MS: '30000',
    },
  });
  await seedHubConfiguration(routes.database);
  vendorOne = await routes.vendor();
  vendorInB = await routes.vendor({ hubId: HUB_B });
  browserOne = routes.browser(vendorOne.device.credential.token);
  expect(
    (await routes.signIn(browserOne, vendorOne.row.accountIdentifier, vendorOne.secret)).status,
  ).toBe(200);
  // Their own members for each family of tests: the API limits the requests one principal makes in a minute, and the file is run inside one.
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsTwo = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsEscalating = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
  senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
  seniorTwo = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
  seniorRaces = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
  seniorB = await routes.actor(BUNDLE_IDS.seniorOps, HUB_B);
  platformAdmin = await routes.actor(BUNDLE_IDS.platformAdmin, HUB_A);
  ahead = await operatingDay(routes.admin, 3);
  await routes.admin.query(
    `insert into reason_code (code, domain, label, attribution) values ($1, 'PICKUP_CANCELLATION', 'Fixture reason', 'CUSTOMER')`,
    [CANCEL_REASON],
  );
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

/** A confirmed request of the first vendor in hub A that has been tried `attempt` times, unless the test says otherwise. */
const confirmed = async (
  attempt = 3,
  over: Parameters<typeof pickupRequestRow>[2] = {},
  vendor: ArrangedVendor = vendorOne,
  hub: string = HUB_A,
): Promise<string> =>
  (
    await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.row.organizationId, hub, {
        state: 'CONFIRMED',
        attemptNumber: attempt,
        serviceDate: ahead,
        ...over,
      }),
    )
  ).id;

const etagOf = async (client: TestClient, id: string): Promise<string> => {
  const read = await client.get(ONE(id));
  expect(read.status).toBe(200);
  const etag = read.header('etag');
  if (etag === null) throw new Error('the read carries no ETag');
  return etag;
};
const tokenOf = (who: Actor, id: string): Promise<string> => etagOf(who.client, id);

interface Options {
  readonly ifMatch?: string | null;
  readonly key?: string;
}
const post = async (
  who: Actor,
  url: string,
  id: string,
  body: Record<string, unknown>,
  options: Options = {},
): Promise<TestResponse> => {
  const ifMatch = options.ifMatch === undefined ? await tokenOf(who, id) : options.ifMatch;
  return who.client.post(url, body, {
    origin: OPS,
    headers: {
      ...(ifMatch === null ? {} : { 'If-Match': ifMatch }),
      'Idempotency-Key': options.key ?? randomUUID(),
    },
  });
};
const extend = (who: Actor, id: string, body: Record<string, unknown>, options?: Options) =>
  post(who, EXTEND(id), id, body, options);
const escalate = (who: Actor, id: string, body: Record<string, unknown>, options?: Options) =>
  post(who, ESCALATE(id), id, body, options);
const reschedule = (who: Actor, id: string, options?: Options) =>
  post(who, CANCEL(id), id, { reason_code: CANCEL_REASON, create_replacement: true }, options);

interface Chained {
  readonly id: string;
  readonly state: string;
  readonly attempt_number: number;
  readonly attempt_extension_id: string | null;
  readonly escalated_at: string | null;
  readonly replacement_request_id: string | null;
  readonly replaces_request_id: string | null;
}
const bodyOf = (response: TestResponse): Chained => response.json() as Chained;

const rowOf = async (id: string): Promise<Record<string, unknown>> => {
  const [row] = await routes.rows(`select * from pickup_request where id = $1`, [id]);
  if (row === undefined) throw new Error('no such request');
  return row;
};
const extensionsOf = (id: string): Promise<Record<string, unknown>[]> =>
  routes.rows(
    `select id, pickup_request_id, ceiling_before, ceiling_after, extended_by, reason from pickup_attempt_extension where pickup_request_id = $1`,
    [id],
  );

interface Event {
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly enhanced: boolean;
  readonly previous_state: string | null;
  readonly resulting_state: string | null;
  readonly note: string | null;
  readonly before_after: Record<string, unknown> | null;
  readonly related_ids: Record<string, unknown> | null;
  readonly detail: Record<string, unknown>;
  readonly responsible_hub_id: string | null;
  readonly vendor_organization_id: string | null;
}
const eventsOf = (id: string, code: string): Promise<Event[]> =>
  routes.rows<Event>(
    `select actor_type, actor_id, enhanced, previous_state, resulting_state, note, before_after, related_ids, detail,
            responsible_hub_id, vendor_organization_id
       from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, id],
  );
const EXTENDED = 'pickup.attempt.extended';
const ESCALATED = 'pickup.request.escalated';

/** A refusal changed nothing: the request is as it was, with no extension and no escalation, and nothing was recorded. */
const expectUntouched = async (id: string, version = 1): Promise<void> => {
  const row = await rowOf(id);
  expect([row.version, row.attempt_extension_id, row.escalated_at]).toEqual([version, null, null]);
  expect(await extensionsOf(id)).toEqual([]);
  for (const code of [EXTENDED, ESCALATED]) expect(await eventsOf(id, code), code).toEqual([]);
};

describe('hub Senior Ops force-extends the cap with a reason (AC-SLICE-001-07)', () => {
  // Break caught: an extension that records no actor, no reason or no ceiling, one that can be rewritten, or an answer that does not carry it.
  it('records the actor, the reason and the ceiling before and after, and answers with the request and its new token', async () => {
    const id = await confirmed(3);
    const before = await tokenOf(senior, id);
    const answer = await extend(senior, id, { reason: REASON });
    expect(answer.status).toBe(200);
    const request = bodyOf(answer);
    expect(request).toMatchObject({ id, state: 'CONFIRMED', attempt_number: 3 });
    expect(request.attempt_extension_id).toEqual(expect.any(String));
    expect(answer.header('etag')).not.toBe(before);
    expect(answer.header('etag')).toBe(await tokenOf(senior, id));

    expect(await extensionsOf(id)).toEqual([
      {
        id: request.attempt_extension_id,
        pickup_request_id: id,
        ceiling_before: 3,
        ceiling_after: 4,
        extended_by: senior.identity.id,
        reason: REASON,
      },
    ]);
    expect((await rowOf(id)).attempt_extension_id).toBe(request.attempt_extension_id);
  });

  // Break caught: the extension unaudited or audited as an ordinary act (it is an override of the cap, under section 38.5), or its before and after lost.
  it('writes one enhanced event with the reason, the extension and the ceiling before and after', async () => {
    const id = await confirmed(3);
    const request = bodyOf(await extend(senior, id, { reason: REASON }));
    expect(await eventsOf(id, EXTENDED)).toEqual([
      {
        actor_type: 'STAFF',
        actor_id: senior.identity.id,
        enhanced: true,
        previous_state: 'CONFIRMED',
        resulting_state: 'CONFIRMED',
        note: REASON,
        before_after: {
          attempt_extension_id: { before: null, after: request.attempt_extension_id },
          attempt_ceiling: { before: 3, after: 4 },
        },
        related_ids: { attempt_extension_id: request.attempt_extension_id },
        // What the extension did, said as it was done (migration 0073): it lifted the ceiling of the hub's cap, and it released no refused collection.
        detail: {
          permission: 'pickup.attempt.extend',
          lifts_attempt_ceiling: true,
          releases_refused_collection: false,
        },
        responsible_hub_id: HUB_A,
        vendor_organization_id: vendorOne.row.organizationId,
      },
    ]);
  });

  // Break caught: Ops Staff able to force the cap (AC-07's first half), or a holder of another bundle's keys, or a Platform Admin shut out.
  it('is refused to Ops Staff and to a bundle without the key, and done by a Platform Admin', async () => {
    const id = await confirmed(3);
    const refused = await extend(ops, id, { reason: REASON });
    expect([refused.status, codeOf(refused)]).toEqual([403, 'PERMISSION_DENIED']);
    const finance = await routes.actor(BUNDLE_IDS.finance, null);
    const other = await extend(
      finance,
      id,
      { reason: REASON },
      { ifMatch: await tokenOf(senior, id) },
    );
    expect([other.status, codeOf(other)]).toEqual([403, 'PERMISSION_DENIED']);
    await expectUntouched(id);

    const done = await extend(platformAdmin, id, { reason: REASON });
    expect(done.status).toBe(200);
    expect((await extensionsOf(id))[0]).toMatchObject({ extended_by: platformAdmin.identity.id });
  });

  // Break caught: the whole of AC-07 as one chain: the cap refused to Ops, lifted by one extension for one further attempt, the replacement
  // confirmable, and the next reschedule refused again until a further extension (it is not an uncapped request).
  it('lets Ops make exactly the one further attempt, and a further extension the next', async () => {
    const third = await confirmed(3);
    const refused = await reschedule(ops, third);
    expect([refused.status, codeOf(refused)]).toEqual([422, 'PICKUP_ATTEMPT_LIMIT_REACHED']);
    await expectUntouched(third);

    const firstExtension = bodyOf(
      await extend(senior, third, { reason: REASON }),
    ).attempt_extension_id;
    const fourth = bodyOf(await reschedule(ops, third));
    expect(fourth.state).toBe('CANCELLED');
    const replacement = fourth.replacement_request_id ?? '';
    expect(bodyOf(await ops.client.get(ONE(replacement)))).toMatchObject({
      state: 'PENDING',
      attempt_number: 4,
      replaces_request_id: third,
      attempt_extension_id: firstExtension,
    });

    // The fourth attempt can be confirmed: the extension it carries permits it.
    const confirmedFourth = await ops.client.post(CONFIRM(replacement), undefined, {
      origin: OPS,
      headers: { 'If-Match': await tokenOf(ops, replacement) },
    });
    expect([confirmedFourth.status, bodyOf(confirmedFourth).state]).toEqual([200, 'CONFIRMED']);

    // ... and no fifth without a further extension.
    const again = await reschedule(ops, replacement);
    expect([again.status, codeOf(again)]).toEqual([422, 'PICKUP_ATTEMPT_LIMIT_REACHED']);
    const secondExtension = bodyOf(await extend(senior, replacement, { reason: REASON }));
    expect(secondExtension.attempt_extension_id).not.toBe(firstExtension);
    expect(await eventsOf(replacement, EXTENDED)).toMatchObject([
      {
        before_after: {
          attempt_extension_id: {
            before: firstExtension,
            after: secondExtension.attempt_extension_id,
          },
          attempt_ceiling: { before: 4, after: 5 },
        },
      },
    ]);
    const fifth = bodyOf(await reschedule(ops, replacement));
    expect(
      bodyOf(await ops.client.get(ONE(fifth.replacement_request_id ?? ''))).attempt_number,
    ).toBe(5);
  });

  // Break caught: an extension for a request that can already go on (it would pile up ceilings), for one that was never attempted or is over, or
  // in a hub with no cap (there is no ceiling to raise).
  it('is STATE_CONFLICT where there is nothing to extend', async () => {
    for (const attempt of [1, 2]) {
      const id = await confirmed(attempt);
      const answer = await extend(senior, id, { reason: REASON });
      expect([answer.status, codeOf(answer)], `attempt ${String(attempt)}`).toEqual([
        409,
        'STATE_CONFLICT',
      ]);
      await expectUntouched(id);
    }
    const pending = await confirmed(3, { state: 'PENDING' });
    const cancelled = await confirmed(3, { state: 'CANCELLED' });
    for (const id of [pending, cancelled]) {
      const answer = await extend(senior, id, { reason: REASON });
      expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
      await expectUntouched(id);
    }

    const extended = await confirmed(3);
    expect((await extend(senior, extended, { reason: REASON })).status).toBe(200);
    const twice = await extend(senior, extended, { reason: REASON });
    expect([twice.status, codeOf(twice)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await extensionsOf(extended)).toHaveLength(1);

    const noCap = await confirmed(5, {}, vendorInB, HUB_B);
    const none = await extend(seniorB, noCap, { reason: REASON });
    expect([none.status, codeOf(none)]).toEqual([409, 'STATE_CONFLICT']);
    await expectUntouched(noCap);
  });

  // Break caught: the new ceiling taken as the old one plus one, so that a request already past the cap (the cap was lowered after it was
  // made) is given an attempt it still cannot make: the extension reaches the attempt after the request's own.
  it('raises the ceiling to the attempt after the request’s own', async () => {
    const id = await confirmed(4);
    const answer = await extend(senior, id, { reason: REASON });
    expect(answer.status).toBe(200);
    expect((await extensionsOf(id))[0]).toMatchObject({ ceiling_before: 3, ceiling_after: 5 });
  });

  // Break caught: a blank reason accepted (the schema requires one, section 21.6), a settable ceiling (it would make a request uncapped), a
  // reason the ledger would not keep, or any member the contract does not have.
  it.each([
    ['a blank reason', { reason: '   ' }, 422, 'REASON_REQUIRED'],
    ['no reason', {}, 400, 'VALIDATION_FAILED'],
    [
      'a ceiling of its own (new_ceiling)',
      { reason: REASON, new_ceiling: 9 },
      400,
      'VALIDATION_FAILED',
    ],
    ['another member', { reason: REASON, resolution: 'RESCHEDULE' }, 400, 'VALIDATION_FAILED'],
    [
      'a reason the ledger would not keep',
      { reason: 'Ring the vendor on +233244123456' },
      400,
      'VALIDATION_FAILED',
    ],
  ])('refuses %s and extends nothing', async (_name, body, status, code) => {
    const id = await confirmed(3);
    const answer = await extend(senior, id, body);
    expect([answer.status, codeOf(answer)]).toEqual([status, code]);
    await expectUntouched(id);
  });

  // Break caught: an extension on a token that is no longer the request's, outside the grant's hubs, for an id that matches nothing, for a vendor
  // or for a caller with no session.
  it('is made under the version it was read at, in the hubs of the grant, and never for a vendor', async () => {
    const id = await confirmed(3);
    const stale = await extend(senior, id, { reason: REASON }, { ifMatch: '"stale"' });
    expect([stale.status, codeOf(stale)]).toEqual([409, 'STATE_CONFLICT']);
    const missing = await extend(senior, id, { reason: REASON }, { ifMatch: null });
    // A missing version is a malformed request (the header is required by the contract), told before the operation runs.
    expect([missing.status, codeOf(missing)]).toEqual([400, 'VALIDATION_FAILED']);
    const outside = await extend(
      seniorB,
      id,
      { reason: REASON },
      { ifMatch: await tokenOf(senior, id) },
    );
    expect([outside.status, codeOf(outside)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const none = await senior.client.post(
      EXTEND(randomUUID()),
      { reason: REASON },
      { origin: OPS, headers: { 'If-Match': '"x"', 'Idempotency-Key': randomUUID() } },
    );
    expect([none.status, codeOf(none)]).toEqual([404, 'NOT_FOUND']);
    const asVendor = await browserOne.post(
      EXTEND(id),
      { reason: REASON },
      { headers: { 'If-Match': '"x"', 'Idempotency-Key': randomUUID() } },
    );
    expect([asVendor.status, codeOf(asVendor)]).toEqual([403, 'PERMISSION_DENIED']);
    const anonymous = await routes
      .browser()
      .post(
        EXTEND(id),
        { reason: REASON },
        { origin: OPS, headers: { 'If-Match': '"x"', 'Idempotency-Key': randomUUID() } },
      );
    expect([anonymous.status, codeOf(anonymous)]).toEqual([401, 'SESSION_INVALID']);
    await expectUntouched(id);
  });

  // Break caught: a retry over a flaky connection raising the ceiling twice, or answering differently the second time.
  it('is made once however many times it is sent', async () => {
    const id = await confirmed(3);
    const etag = await tokenOf(senior, id);
    const key = randomUUID();
    const first = await extend(senior, id, { reason: REASON }, { ifMatch: etag, key });
    const second = await extend(senior, id, { reason: REASON }, { ifMatch: etag, key });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.json()).toEqual(first.json());
    expect(second.header('etag')).toBe(first.header('etag'));
    expect(await extensionsOf(id)).toHaveLength(1);
    expect(await eventsOf(id, EXTENDED)).toHaveLength(1);

    const other = await extend(
      senior,
      id,
      { reason: 'Another reason entirely' },
      { ifMatch: etag, key },
    );
    expect([other.status, codeOf(other)]).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
  });

  // Break caught: two Senior Ops members extending one request at once, each raising the ceiling.
  it('lets exactly one of two concurrent extensions succeed', async () => {
    const id = await confirmed(3);
    const etag = await tokenOf(seniorRaces, id);
    const [first, second] = await Promise.all([
      extend(seniorRaces, id, { reason: REASON }, { ifMatch: etag }),
      extend(seniorTwo, id, { reason: 'A second look at the same request' }, { ifMatch: etag }),
    ]);
    expect(
      [first, second]
        .map((each) =>
          each.status === 200 ? '200' : `${String(each.status)} ${String(codeOf(each))}`,
        )
        .sort(),
    ).toEqual(['200', '409 STATE_CONFLICT']);
    expect(await extensionsOf(id)).toHaveLength(1);
  });

  // Break caught: the version compared outside the request's lock, so that a request changed while the extension waited is extended on the
  // token of an earlier read.
  it('compares the version under the lock: a change committed while the extension waits is seen by it', async () => {
    const id = await confirmed(3);
    const etag = await tokenOf(senior, id);
    const held = await holdingPickupRequest(routes.database, id);
    let extending: Promise<TestResponse> | undefined;
    try {
      extending = extend(senior, id, { reason: REASON }, { ifMatch: etag });
      await waitUntilBlockedBy(routes.admin, held.pid, 'the extension', extending);
      await held.client.query(
        `update pickup_request set secondary_phone = '+233200000008' where id = $1`,
        [id],
      );
      await held.client.query('commit');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await extending?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    const answer = await extending;
    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await extensionsOf(id)).toEqual([]);
  });
});

describe('Ops escalates a request out of its own hands, once', () => {
  // Break caught: an escalation that changes the request's state (it stays confirmed, and can still be cancelled), that records no moment, or
  // that answers with a token that is not the request's.
  it('records the moment on a confirmed request, and answers with the request and its new token', async () => {
    const id = await confirmed(1);
    const before = await tokenOf(opsEscalating, id);
    const answer = await escalate(opsEscalating, id, { note: NOTE });
    expect(answer.status).toBe(200);
    const request = bodyOf(answer);
    expect(request).toMatchObject({ id, state: 'CONFIRMED', attempt_extension_id: null });
    expect(request.escalated_at).toEqual(expect.any(String));
    expect(new Date(request.escalated_at ?? '').toISOString()).toBe(request.escalated_at);
    expect(answer.header('etag')).not.toBe(before);
    expect(answer.header('etag')).toBe(await tokenOf(opsEscalating, id));
    const row = await rowOf(id);
    expect(row.version).toBe(2);
    expect((row.escalated_at as Date).toISOString()).toBe(request.escalated_at);
  });

  // Break caught: the escalation unaudited or audited as an ordinary act (it is a manual state override, section 38.5), or its actor, trigger or
  // note missing: the audit event is where they are.
  it('writes one enhanced event with the actor, the trigger and the note', async () => {
    const id = await confirmed(1);
    const request = bodyOf(await escalate(opsEscalating, id, { note: NOTE }));
    expect(await eventsOf(id, ESCALATED)).toEqual([
      {
        actor_type: 'STAFF',
        actor_id: opsEscalating.identity.id,
        enhanced: true,
        previous_state: 'CONFIRMED',
        resulting_state: 'CONFIRMED',
        note: NOTE,
        before_after: { escalated_at: { before: null, after: request.escalated_at } },
        related_ids: null,
        detail: { trigger: 'OPS', permission: 'pickup.failure.resolve' },
        responsible_hub_id: HUB_A,
        vendor_organization_id: vendorOne.row.organizationId,
      },
    ]);
  });

  // Break caught: a second escalation accepted (the moment moved, a second record written), or one of a request that was never confirmed or is over.
  it('is once, and only for a request that was confirmed: any other is STATE_CONFLICT', async () => {
    const id = await confirmed(1);
    expect((await escalate(opsEscalating, id, { note: NOTE })).status).toBe(200);
    const again = await escalate(opsEscalating, id, { note: 'Second look' });
    expect([again.status, codeOf(again)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await eventsOf(id, ESCALATED)).toHaveLength(1);

    for (const state of ['PENDING', 'CANCELLED'] as const) {
      const other = await confirmed(1, { state });
      const answer = await escalate(opsEscalating, other, { note: NOTE });
      expect([answer.status, codeOf(answer)], state).toEqual([409, 'STATE_CONFLICT']);
      expect((await rowOf(other)).escalated_at).toBeNull();
      expect(await eventsOf(other, ESCALATED)).toEqual([]);
    }
  });

  // Break caught: the request made uncancellable by escalating it (section 21.6: office cancellation remains available at every point), or the
  // moment lost with the cancellation.
  it('leaves the request cancellable, and a cancellation keeps the moment', async () => {
    const id = await confirmed(1);
    const escalated = bodyOf(await escalate(opsEscalating, id, { note: NOTE }));
    const cancelled = await post(opsEscalating, CANCEL(id), id, { reason_code: CANCEL_REASON });
    expect(cancelled.status).toBe(200);
    expect(bodyOf(cancelled)).toMatchObject({
      state: 'CANCELLED',
      escalated_at: escalated.escalated_at,
    });
  });

  // Break caught: an escalation that closes the way on: the documents say it changes nothing else, and the extension of a Senior Ops member
  // and the reschedule it opens are the way out of an exhausted chain.
  it('does not stop a Senior Ops extension, nor the reschedule it opens', async () => {
    const id = await confirmed(3);
    const escalated = bodyOf(await escalate(opsEscalating, id, { note: NOTE }));
    expect((await extend(senior, id, { reason: REASON })).status).toBe(200);

    const rescheduled = bodyOf(await reschedule(ops, id));
    expect(rescheduled).toMatchObject({ state: 'CANCELLED', escalated_at: escalated.escalated_at });
    expect(rescheduled.replacement_request_id).toEqual(expect.any(String));
  });

  // Break caught: an escalation with no note (it is the senior queue's only account of why), a note that is a number or an address of a person,
  // or a member the contract does not have (there is no `resolution`).
  it.each([
    ['a blank note', { note: '   ' }, 422, 'REASON_REQUIRED'],
    ['no note', {}, 400, 'VALIDATION_FAILED'],
    ['a resolution of its own', { note: NOTE, resolution: 'RETURN' }, 400, 'VALIDATION_FAILED'],
    [
      'a note the ledger would not keep',
      { note: 'Rang the sender on +233244123456' },
      400,
      'VALIDATION_FAILED',
    ],
  ])('refuses %s and escalates nothing', async (_name, body, status, code) => {
    const id = await confirmed(1);
    const answer = await escalate(opsEscalating, id, body);
    expect([answer.status, codeOf(answer)]).toEqual([status, code]);
    await expectUntouched(id);
  });

  // Break caught: a caller with no key escalating, an escalation outside the grant's hubs, on a stale token, of a request that is not there, for a
  // vendor or with no session.
  it('is made under the version it was read at, in the hubs of the grant, and never for a vendor', async () => {
    const id = await confirmed(1);
    const finance = await routes.actor(BUNDLE_IDS.finance, null);
    const without = await escalate(
      finance,
      id,
      { note: NOTE },
      { ifMatch: await tokenOf(ops, id) },
    );
    expect([without.status, codeOf(without)]).toEqual([403, 'PERMISSION_DENIED']);
    const stale = await escalate(ops, id, { note: NOTE }, { ifMatch: '"stale"' });
    expect([stale.status, codeOf(stale)]).toEqual([409, 'STATE_CONFLICT']);
    const missing = await escalate(ops, id, { note: NOTE }, { ifMatch: null });
    // A missing version is a malformed request (the header is required by the contract), told before the operation runs.
    expect([missing.status, codeOf(missing)]).toEqual([400, 'VALIDATION_FAILED']);
    const outside = await escalate(opsB, id, { note: NOTE }, { ifMatch: await tokenOf(ops, id) });
    expect([outside.status, codeOf(outside)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const none = await ops.client.post(
      ESCALATE(randomUUID()),
      { note: NOTE },
      { origin: OPS, headers: { 'If-Match': '"x"', 'Idempotency-Key': randomUUID() } },
    );
    expect([none.status, codeOf(none)]).toEqual([404, 'NOT_FOUND']);
    const asVendor = await browserOne.post(
      ESCALATE(id),
      { note: NOTE },
      { headers: { 'If-Match': '"x"', 'Idempotency-Key': randomUUID() } },
    );
    expect([asVendor.status, codeOf(asVendor)]).toEqual([403, 'PERMISSION_DENIED']);
    const anonymous = await routes
      .browser()
      .post(
        ESCALATE(id),
        { note: NOTE },
        { origin: OPS, headers: { 'If-Match': '"x"', 'Idempotency-Key': randomUUID() } },
      );
    expect([anonymous.status, codeOf(anonymous)]).toEqual([401, 'SESSION_INVALID']);
    await expectUntouched(id);
  });

  // Break caught: a retry escalating twice or answering differently, and two members of the office escalating one request at once.
  it('is made once however many times it is sent, and by one of two who race', async () => {
    const id = await confirmed(1);
    const etag = await tokenOf(opsEscalating, id);
    const key = randomUUID();
    const first = await escalate(opsEscalating, id, { note: NOTE }, { ifMatch: etag, key });
    const second = await escalate(opsEscalating, id, { note: NOTE }, { ifMatch: etag, key });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.json()).toEqual(first.json());
    expect(await eventsOf(id, ESCALATED)).toHaveLength(1);
    const other = await escalate(opsEscalating, id, { note: 'Another' }, { ifMatch: etag, key });
    expect([other.status, codeOf(other)]).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);

    const raced = await confirmed(1);
    const token = await tokenOf(opsTwo, raced);
    const [one, two] = await Promise.all([
      escalate(opsTwo, raced, { note: NOTE }, { ifMatch: token }),
      escalate(ops, raced, { note: 'Same request, other member' }, { ifMatch: token }),
    ]);
    expect(
      [one, two]
        .map((each) =>
          each.status === 200 ? '200' : `${String(each.status)} ${String(codeOf(each))}`,
        )
        .sort(),
    ).toEqual(['200', '409 STATE_CONFLICT']);
    expect(await eventsOf(raced, ESCALATED)).toHaveLength(1);
  });

  // Break caught: the version compared outside the request's lock, so that a request changed while the escalation waited is escalated on the
  // token of an earlier read.
  it('compares the version under the lock: a change committed while the escalation waits is seen by it', async () => {
    const id = await confirmed(1);
    const etag = await tokenOf(opsTwo, id);
    const held = await holdingPickupRequest(routes.database, id);
    let escalating: Promise<TestResponse> | undefined;
    try {
      escalating = escalate(opsTwo, id, { note: NOTE }, { ifMatch: etag });
      await waitUntilBlockedBy(routes.admin, held.pid, 'the escalation', escalating);
      await held.client.query(
        `update pickup_request set secondary_phone = '+233200000008' where id = $1`,
        [id],
      );
      await held.client.query('commit');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await escalating?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    const answer = await escalating;
    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    expect((await rowOf(id)).escalated_at).toBeNull();
  });
});

describe('the act and its record stand or fall together', () => {
  /** The act is sent while the ledger cannot be written, then again under the same key once it can: the first changed nothing, the second does. */
  async function failsWithItsRecord(
    send: (key: string, etag: string) => Promise<TestResponse>,
    etag: string,
  ): Promise<{ failed: TestResponse; retried: TestResponse }> {
    const key = randomUUID();
    const broken = await routes.kit.admin.breakWrites('audit_event');
    const failed = await send(key, etag).finally(() => broken.mend());
    return { failed, retried: await send(key, etag) };
  }

  // Break caught: the extension committed although its audit event could not be written (an override of the cap with no record of who made it),
  // or the failed attempt leaving the key behind so that the retry is refused.
  it('an extension whose event cannot be written is not made', async () => {
    const id = await confirmed(3);
    const etag = await tokenOf(senior, id);
    const { failed, retried } = await failsWithItsRecord(
      (key, token) => extend(senior, id, { reason: REASON }, { ifMatch: token, key }),
      etag,
    );

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(200);
    expect(await extensionsOf(id)).toHaveLength(1);
    expect(await eventsOf(id, EXTENDED)).toHaveLength(1);
  });

  it('an escalation whose event cannot be written is not made', async () => {
    const id = await confirmed(1);
    const etag = await tokenOf(opsEscalating, id);
    const { failed, retried } = await failsWithItsRecord(
      (key, token) => escalate(opsEscalating, id, { note: NOTE }, { ifMatch: token, key }),
      etag,
    );

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(200);
    expect(await eventsOf(id, ESCALATED)).toHaveLength(1);
  });

  // Break caught: a replacement made although the cancellation's event could not be written (a request cancelled and a booking made with no record).
  it('a reschedule whose event cannot be written makes neither the cancellation nor the replacement', async () => {
    const id = await confirmed(1);
    const etag = await tokenOf(ops, id);
    const made = (): Promise<number> =>
      routes
        .rows(`select id from pickup_request where replaces_request_id = $1`, [id])
        .then((rows) => rows.length);
    const broken = await routes.kit.admin.breakWrites('audit_event');
    const failed = await reschedule(ops, id, { ifMatch: etag }).finally(() => broken.mend());

    expect(failed.status).toBe(500);
    expect((await rowOf(id)).state).toBe('CONFIRMED');
    expect(await made()).toBe(0);
    expect((await reschedule(ops, id)).status).toBe(200);
    expect(await made()).toBe(1);
  });
});
