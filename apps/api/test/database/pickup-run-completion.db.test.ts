import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AUDIT_WRITER, type AuditWriter } from '../../src/platform/auth/ports/audit-writer.port.js';
import { RUN_ACCESS, type RunAccess } from '../../src/platform/domain-ports/run-access.port.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { backendPidOf, waitUntilBlockedBy } from './support/lock-wait.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { liftProviderCeiling } from './support/provider-ceiling.js';
import { arrangeRun, arrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, OPS, codeOf, type Actor } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.23, the completion of a run by the system (`AC-SLICE-001-74` and `-78`; state-machines.md section 4): a run in progress whose every stop
 * is terminal and none of them collected is completed in the transaction of the act that turned its last stop terminal, with the actor of
 * that act and the cause in the event. Against a real PostgreSQL and the real application, each claim:
 *
 * - **It completes exactly when it should**: every stop terminal and none collected (a failed stop counts as terminal, a collected or partly
 *   collected one makes the hub handover the completion), on a run in progress and on no other.
 * - **Both acts that can turn the last stop terminal complete it**: Ops's skip, and the cancellation of the last open pickup.
 * - **It happens once, under any interleaving**: two acts on the last two stops, a skip against a cancellation of the same stop, and a start
 *   against a skip never end with a run left in progress with nothing to work (the stranded run that nothing would complete), a run completed
 *   twice, or a deadlock.
 */
const STOP = (id: string) => `${API}/pickup-stops/${id}`;
const SKIP = (id: string) => `${STOP(id)}/skip`;
const MANIFEST = (id: string) => `${API}/pickup-manifests/${id}`;
const REQUESTS = `${API}/pickup-requests`;
const CANCEL_REASON = 'FIXTURE_CANCEL_FOR_COMPLETION';

let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;
let ops: Actor;
let second: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  // This file makes dozens of skips from two officers' sessions inside a minute; the ceiling of the operations that cause a text is proven elsewhere.
  await liftProviderCeiling(routes.admin);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
  ops = await routes.actor(BUNDLE_IDS.opsStaff);
  second = await routes.actor(BUNDLE_IDS.opsStaff);
  await routes.admin.query(
    `insert into reason_code (code, domain, label, attribution, requires_note, active)
     values ($1, 'PICKUP_CANCELLATION', 'Fixture customer cancellation', 'CUSTOMER', false, true)`,
    [CANCEL_REASON],
  );
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

interface Manifest {
  readonly state: string;
  readonly completed_at: string | null;
  readonly stops: { id: string; state: string }[];
}

const run = (over: Partial<Parameters<typeof arrangeRun>[2]> = {}): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendor.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    ...over,
  });

async function skip(actor: Actor, stopId: string): Promise<TestResponse> {
  const etag = (await actor.client.get(STOP(stopId))).header('etag') ?? '';
  return actor.client.post(
    SKIP(stopId),
    { reason_code: 'RUN_CUT_SHORT' },
    { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
  );
}

async function cancel(actor: Actor, requestId: string): Promise<TestResponse> {
  const etag = (await actor.client.get(`${REQUESTS}/${requestId}`)).header('etag') ?? '';
  return actor.client.post(
    `${REQUESTS}/${requestId}/cancel`,
    { reason_code: CANCEL_REASON, apply_charge: false, charge_reason_code: CANCEL_REASON },
    { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
  );
}

const manifestRow = (id: string) =>
  routes
    .rows<{ state: string; completed_at: Date | null }>(
      `select state, completed_at from pickup_manifest where id = $1`,
      [id],
    )
    .then((rows) => rows[0]);

const completions = (manifestId: string) =>
  routes.rows<{
    actor_id: string | null;
    previous_state: string | null;
    resulting_state: string | null;
    detail: Record<string, unknown> | null;
    related_ids: Record<string, string> | null;
    responsible_hub_id: string | null;
    enhanced: boolean;
  }>(
    `select actor_id, previous_state, resulting_state, detail, related_ids, responsible_hub_id, enhanced
       from audit_event where event_code = 'pickup.manifest.completed' and object_id = $1 order by recorded_at, id`,
    [manifestId],
  );

describe('a run in progress is completed when its last stop turns terminal with nothing collected', () => {
  // Break caught: a run left in progress with nothing to work (nothing would complete it), a completion that carries the wrong actor or no
  // cause, or an event that is not the catalogue's standard one.
  it('completes the run at the skip of its last open stop, by the system, in the officer’s transaction', async () => {
    const arranged = await run({ stops: 3, stopStates: ['FAILED', 'SKIPPED', 'PENDING'] });
    const last = arranged.stops[2];
    expect(last).toBeDefined();
    const response = await skip(ops, last?.id ?? '');
    expect(response.status).toBe(200);

    const row = await manifestRow(arranged.manifest.id);
    expect(row?.state).toBe('COMPLETED');
    expect(row?.completed_at).toBeInstanceOf(Date);
    const written = await completions(arranged.manifest.id);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      actor_id: ops.identity.id,
      previous_state: 'IN_PROGRESS',
      resulting_state: 'COMPLETED',
      detail: { completed_by: 'SYSTEM', cause: 'LAST_STOP_SKIPPED' },
      related_ids: { rider_id: arranged.rider.id },
      enhanced: false,
    });
    // The skip's own event comes first, then the completion's.
    const order = await routes.rows<{ event_code: string }>(
      `select event_code from audit_event
        where correlation_id = (select correlation_id from audit_event where event_code = 'pickup.manifest.completed' and object_id = $1)
          and event_code in ('pickup.stop.skipped', 'pickup.manifest.completed')
        order by recorded_at, id`,
      [arranged.manifest.id],
    );
    expect(order.map((each) => each.event_code)).toEqual([
      'pickup.stop.skipped',
      'pickup.manifest.completed',
    ]);
    // The run is read as completed by staff and by the rider it was given to; no handover or intake was made (none exists to make).
    const read = (await ops.client.get(MANIFEST(arranged.manifest.id))).json() as Manifest;
    expect(read.state).toBe('COMPLETED');
    expect(read.completed_at).not.toBeNull();
    expect(
      ((await arranged.rider.client.get(MANIFEST(arranged.manifest.id))).json() as Manifest).state,
    ).toBe('COMPLETED');
  });

  // Break caught: a run closed while something is still to be worked, or by the first of two skips.
  it('leaves the run in progress while another stop is to be worked, and completes it at the second skip only', async () => {
    const arranged = await run({ stops: 2, stopStates: ['PENDING', 'ARRIVED'] });
    const [first, last] = arranged.stops;
    expect((await skip(ops, first?.id ?? '')).status).toBe(200);
    expect((await manifestRow(arranged.manifest.id))?.state).toBe('IN_PROGRESS');
    expect(await completions(arranged.manifest.id)).toEqual([]);
    expect((await skip(ops, last?.id ?? '')).status).toBe(200);
    expect((await manifestRow(arranged.manifest.id))?.state).toBe('COMPLETED');
    expect(await completions(arranged.manifest.id)).toHaveLength(1);
  });

  // Break caught: a run completed by the system although something was collected (the custody of the parcels is closed by the hub handover
  // and by nothing else), for a collection and for a partial one.
  it.each(['COLLECTED', 'PARTIALLY_COLLECTED'] as const)(
    'does not complete a run that collected something (%s): the hub handover is its completion',
    async (collected) => {
      const arranged = await run({ stops: 2, stopStates: [collected, 'PENDING'] });
      const last = arranged.stops[1];
      expect((await skip(ops, last?.id ?? '')).status).toBe(200);
      expect((await manifestRow(arranged.manifest.id))?.state).toBe('IN_PROGRESS');
      expect(await completions(arranged.manifest.id)).toEqual([]);
    },
  );

  // Break caught: a completion of a run that is not in progress (a draft or a dispatched run whose stops are all skipped is cancelled
  // unstarted, never completed), or one that is already over.
  it('completes nothing that is not in progress', async () => {
    for (const state of ['DRAFT', 'DISPATCHED'] as const) {
      const arranged = await run({ state, stops: 1 });
      expect((await skip(ops, arranged.stops[0]?.id ?? '')).status, state).toBe(200);
      expect((await manifestRow(arranged.manifest.id))?.state, state).toBe(state);
      expect(await completions(arranged.manifest.id), state).toEqual([]);
    }
  });
});

describe('a run whose custody was accepted with parcels and whose every stop is then skipped (OB-S1-59, the review of 4 November 2026)', () => {
  // Break caught: the discrepancy being hidden or "reconciled" by copying a figure. The receiver took three parcels into custody and no stop was
  // collected, so the system completes the run as one that collected nothing while the custody record says three. **This pins what the product does
  // today and is not an endorsement of it**: the Product Owner decides whether such a run may complete as empty (OB-S1-59; the review recommends
  // that both counts be kept and that an Ops reconciliation outcome be required first). Until then the two records must stay what each is: the
  // custody count a custody record, never copied into a collection or an intake, and the completion carrying no word about it.
  it('completes the run today and keeps both facts as they were: the custody count of three, and no collection', async () => {
    const arranged = await run({ stops: 1, stopStates: ['PENDING'] });
    const receiver = await arrangedRider(routes.kit, routes.admin);
    const made = await routes.admin.query<{ id: string }>(
      `insert into run_custody_handover (id, manifest_id, responsible_hub_id, from_rider_id, to_rider_id, initiation_note, initiated_by)
       values (gen_random_uuid(), $1, $2, $3, $4, 'Fixture handover', gen_random_uuid()) returning id`,
      [arranged.manifest.id, HUB_A, arranged.rider.id, receiver.id],
    );
    const handoverId = made.rows[0]?.id ?? '';
    await routes.admin.query(
      `update run_custody_handover set state = 'COMPLETED', parcel_count_taken = 3, accepted_by = $2, resolved_at = now() where id = $1`,
      [handoverId, receiver.id],
    );

    expect((await skip(ops, arranged.stops[0]?.id ?? '')).status).toBe(200);

    expect((await manifestRow(arranged.manifest.id))?.state).toBe('COMPLETED');
    const handover = (
      await routes.rows<{ state: string; parcel_count_taken: number }>(
        `select state, parcel_count_taken from run_custody_handover where id = $1`,
        [handoverId],
      )
    )[0];
    expect(handover).toEqual({ state: 'COMPLETED', parcel_count_taken: 3 });
    expect(
      await routes.rows(`select 1 from collection_record where pickup_stop_id = $1`, [
        arranged.stops[0]?.id ?? '',
      ]),
    ).toEqual([]);
    const written = await completions(arranged.manifest.id);
    expect(written).toHaveLength(1);
    expect(written[0]?.detail).toEqual({ completed_by: 'SYSTEM', cause: 'LAST_STOP_SKIPPED' });
  });
});

describe('the cancellation of the last open pickup completes a run in progress', () => {
  // Break caught: the cancellation that skips the last stop of a run (the case of the S1.20 closeout) leaving the run in progress with nothing
  // to work; the completion carrying another actor, cause or order.
  it('completes the run with the cancelling officer as the actor, after the cancellation’s own events', async () => {
    const arranged = await run({ stops: 2, stopStates: ['SKIPPED', 'PENDING'] });
    const open = arranged.stops[1];
    const response = await cancel(ops, open?.requestId ?? '');
    expect(response.status).toBe(200);

    expect((await manifestRow(arranged.manifest.id))?.state).toBe('COMPLETED');
    const written = await completions(arranged.manifest.id);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      actor_id: ops.identity.id,
      detail: { completed_by: 'SYSTEM', cause: 'LAST_PICKUP_CANCELLED' },
    });
    const order = await routes.rows<{ event_code: string }>(
      `select event_code from audit_event
        where correlation_id = (select correlation_id from audit_event where event_code = 'pickup.manifest.completed' and object_id = $1)
          and event_code in ('pickup.request.cancelled_chargeable', 'pickup.stop.skipped', 'pickup.manifest.completed')
        order by recorded_at, id`,
      [arranged.manifest.id],
    );
    // The request the run arranges is committed to its rider, so its cancellation is the chargeable event (the decision is recorded).
    expect(order.map((each) => each.event_code)).toEqual([
      'pickup.request.cancelled_chargeable',
      'pickup.stop.skipped',
      'pickup.manifest.completed',
    ]);
  });

  it('does not complete a run that still has a pickup to work, collected something, or has not started', async () => {
    const another = await run({ stops: 2, stopStates: ['PENDING', 'PENDING'] });
    expect((await cancel(ops, another.stops[0]?.requestId ?? '')).status).toBe(200);
    expect((await manifestRow(another.manifest.id))?.state).toBe('IN_PROGRESS');

    const collected = await run({ stops: 2, stopStates: ['COLLECTED', 'PENDING'] });
    expect((await cancel(ops, collected.stops[1]?.requestId ?? '')).status).toBe(200);
    expect((await manifestRow(collected.manifest.id))?.state).toBe('IN_PROGRESS');

    const dispatched = await run({ state: 'DISPATCHED', stops: 1 });
    expect((await cancel(ops, dispatched.stops[0]?.requestId ?? '')).status).toBe(200);
    expect((await manifestRow(dispatched.manifest.id))?.state).toBe('DISPATCHED');
    for (const each of [another, collected, dispatched]) {
      expect(await completions(each.manifest.id)).toEqual([]);
    }
  });
});

describe('under any interleaving the run completes once and is never stranded', () => {
  // Break caught: two officers skipping the last two stops of a run at once, each seeing the other's stop still to be worked and neither
  // completing it (a run in progress that nothing would ever close), or both completing it, or a deadlock between the two.
  it('completes the run once when its last two stops are skipped at the same moment', async () => {
    for (let round = 0; round < 6; round += 1) {
      const arranged = await run({ stops: 2 });
      const [one, two] = arranged.stops;
      const [a, b] = await Promise.all([skip(ops, one?.id ?? ''), skip(second, two?.id ?? '')]);
      expect([a.status, b.status], `round ${String(round)}`).toEqual([200, 200]);
      expect((await manifestRow(arranged.manifest.id))?.state, `round ${String(round)}`).toBe(
        'COMPLETED',
      );
      expect(await completions(arranged.manifest.id), `round ${String(round)}`).toHaveLength(1);
    }
  });

  // Break caught: the skip of a stop and the cancellation of its request at the same moment ending in a stranded run, a refusal that is a
  // failure (a deadlock or a 500) rather than a conflict, or the stop skipped twice. Both orders are real: the skip wins and the
  // cancellation then finds the stop already skipped, or the cancellation wins and the skip is refused as a conflict.
  it('ends a skip against the cancellation of the same pickup as one serial order would', async () => {
    for (let round = 0; round < 6; round += 1) {
      const arranged = await run({ stops: 1 });
      const only = arranged.stops[0];
      const [skipped, cancelled] = await Promise.all([
        skip(ops, only?.id ?? ''),
        cancel(second, only?.requestId ?? ''),
      ]);
      const tag = `round ${String(round)}`;
      expect(cancelled.status, tag).toBe(200);
      expect([200, 409], tag).toContain(skipped.status);
      if (skipped.status === 409) expect(codeOf(skipped), tag).toBe('STATE_CONFLICT');
      expect((await manifestRow(arranged.manifest.id))?.state, tag).toBe('COMPLETED');
      expect(await completions(arranged.manifest.id), tag).toHaveLength(1);
      const stop = await routes.rows<{ state: string }>(
        `select state from pickup_stop where id = $1`,
        [only?.id],
      );
      expect(stop[0]?.state, tag).toBe('SKIPPED');
    }
  });

  // Break caught: the start of a run past a pickup that is being resolved, which leaves a run in progress with nothing to work and nothing to
  // complete it. The skip holds the stop (its transaction has locked it and not ended); the start must wait for it and then find nothing to
  // work, and the run stays dispatched.
  it('makes a start wait for the pickup being resolved, and refuses a run that has nothing left', async () => {
    const arranged = await run({ state: 'DISPATCHED', stops: 1 });
    const only = arranged.stops[0];
    const etag = (await arranged.rider.client.get(MANIFEST(arranged.manifest.id))).header('etag');

    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(`select 1 from pickup_stop where id = $1 for update`, [only?.id]);
      const pid = await backendPidOf(holder);
      const starting = arranged.rider.client.post(
        `${MANIFEST(arranged.manifest.id)}/start`,
        undefined,
        {
          headers: { 'If-Match': etag ?? '' },
        },
      );
      await waitUntilBlockedBy(routes.admin, pid, 'the start of the run', starting);
      // The resolution of the pickup commits while the start waits.
      await holder.query(
        `update pickup_stop set state = 'SKIPPED', resolved_at = now(),
                skip_snapshot = jsonb_build_object('reason_code', 'RUN_CUT_SHORT', 'label', 'x', 'skipped_at', now())
          where id = $1`,
        [only?.id],
      );
      await holder.query('commit');
      // The token the rider held is stale now (the run changed under it), and the answer is the conflict that says so, or the refusal of an
      // empty run if the token was refreshed by the change: either way the run is not started.
      const answer = await starting;
      expect([409, 422]).toContain(answer.status);
      expect((await manifestRow(arranged.manifest.id))?.state).toBe('DISPATCHED');
    } finally {
      await holder.end();
    }
  });

  // Break caught: the stops of a run counted before the run's lock is won. The other skip has resolved the run's other stop and holds the run
  // (its transaction has not ended); this skip, which turns the last stop terminal, must wait for the run's lock and count the stops after it,
  // so that it sees the other skip's stop as resolved and completes the run. Counted before the lock it would see that stop still to be
  // worked, complete nothing, and leave a run in progress that nothing would ever close.
  it('counts the stops of the run after the run’s lock is won, so that the second of two skips completes it', async () => {
    const arranged = await run({ stops: 2 });
    const [mine, theirs] = arranged.stops;
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      // The other act, part-way: it has resolved the run's other stop and holds the run, and has not ended.
      await holder.query(
        `update pickup_stop set state = 'SKIPPED', resolved_at = now(),
                skip_snapshot = jsonb_build_object('reason_code', 'RUN_CUT_SHORT', 'label', 'x', 'skipped_at', now())
          where id = $1`,
        [theirs?.id],
      );
      await holder.query(`select 1 from pickup_manifest where id = $1 for update`, [
        arranged.manifest.id,
      ]);
      const pid = await backendPidOf(holder);
      const skipping = skip(ops, mine?.id ?? '');
      await waitUntilBlockedBy(routes.admin, pid, 'the skip of the last open stop', skipping);
      await holder.query('commit');
      expect((await skipping).status).toBe(200);
    } finally {
      await holder.end();
    }
    expect((await manifestRow(arranged.manifest.id))?.state).toBe('COMPLETED');
    expect(await completions(arranged.manifest.id)).toHaveLength(1);
  });

  // Break caught (the adversarial review of 2 November 2026): an ordering of a draft's stops that read a stop as pending, then found it resolved by
  // a skip that committed while it waited for the stop's lock, and was answered with a 500 by the stop's guard. A serial order gives a conflict (the
  // skip first: the officer's token is stale) or a success (the ordering first). The ordering locks the stops after the manifest and judges them
  // as they are once it has them.
  it('makes an ordering of a draft wait for the stop being resolved, and answers a conflict and not a failure', async () => {
    const arranged = await run({ state: 'DRAFT', stops: 3 });
    const [first, second, third] = arranged.stops;
    const etag = (await ops.client.get(MANIFEST(arranged.manifest.id))).header('etag') ?? '';

    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      // The skip, part-way: it has resolved the first stop and holds it, and has not ended.
      await holder.query(
        `update pickup_stop set state = 'SKIPPED', resolved_at = now(),
                skip_snapshot = jsonb_build_object('reason_code', 'RUN_CUT_SHORT', 'label', 'x', 'skipped_at', now())
          where id = $1`,
        [first?.id],
      );
      const pid = await backendPidOf(holder);
      const ordering = ops.client.put(
        `${MANIFEST(arranged.manifest.id)}/stops`,
        { ordered_stop_ids: [second?.id, first?.id, third?.id] },
        { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
      );
      await waitUntilBlockedBy(routes.admin, pid, 'the ordering of the stops', ordering);
      await holder.query('commit');
      const answer = await ordering;
      expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    } finally {
      await holder.end();
    }
    // Nothing was reordered: the stops are where they were.
    expect(
      await routes.rows<{ id: string; sequence: number }>(
        `select id, sequence from pickup_stop where pickup_manifest_id = $1 order by sequence`,
        [arranged.manifest.id],
      ),
    ).toEqual([
      { id: first?.id, sequence: 1 },
      { id: second?.id, sequence: 2 },
      { id: third?.id, sequence: 3 },
    ]);
  });

  // Break caught: the stops' locks taken for a run in progress. A skip of the last stop of such a run holds its stop and then asks for the run, so
  // an act that held the run and waited for that stop would meet it in a circle and neither would move. A second start of a run (a double tap) is
  // the act that would: it must be refused at once on the run's state, whatever is happening to a stop.
  it('refuses a second start of a run in progress at once, without waiting for a stop that is being resolved', async () => {
    const arranged = await run({ state: 'IN_PROGRESS', stops: 2 });
    const etag = (await arranged.rider.client.get(MANIFEST(arranged.manifest.id))).header('etag');
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(`select 1 from pickup_stop where id = $1 for update`, [
        arranged.stops[0]?.id,
      ]);
      const starting = arranged.rider.client.post(
        `${MANIFEST(arranged.manifest.id)}/start`,
        undefined,
        {
          headers: { 'If-Match': etag ?? '' },
        },
      );
      const outcome = await Promise.race([
        starting,
        new Promise<'waited'>((resolve) => {
          setTimeout(() => {
            resolve('waited');
          }, 4_000);
        }),
      ]);
      await holder.query('commit');
      expect(outcome).not.toBe('waited');
      expect([(outcome as TestResponse).status, codeOf(outcome as TestResponse)]).toEqual([
        409,
        'STATE_CONFLICT',
      ]);
      await starting;
    } finally {
      await holder.end();
    }
  });

  // Break caught: a run put into progress by a start that raced the skip of its last pickup, with the skip's completion not seen by either.
  it('never leaves a started run with nothing to work, whichever of a start and a skip is first', async () => {
    for (let round = 0; round < 8; round += 1) {
      const arranged = await run({ state: 'DISPATCHED', stops: 1 });
      const only = arranged.stops[0];
      const etag = (await arranged.rider.client.get(MANIFEST(arranged.manifest.id))).header('etag');
      const [started, skipped] = await Promise.all([
        arranged.rider.client.post(`${MANIFEST(arranged.manifest.id)}/start`, undefined, {
          headers: { 'If-Match': etag ?? '' },
        }),
        skip(ops, only?.id ?? ''),
      ]);
      const tag = `round ${String(round)}: start ${String(started.status)}, skip ${String(skipped.status)}`;
      const row = await manifestRow(arranged.manifest.id);
      const stop = await routes.rows<{ state: string }>(
        `select state from pickup_stop where id = $1`,
        [only?.id],
      );
      // The stop is skipped in every order (the skip never loses to a start: a stop to be worked is skippable on a started run too).
      expect(stop[0]?.state, tag).toBe('SKIPPED');
      // And the run is never in progress with nothing to work: it is either still dispatched or completed.
      expect(['DISPATCHED', 'COMPLETED'], tag).toContain(row?.state);
      expect([200, 409, 422], tag).toContain(started.status);
      expect([200, 409], tag).toContain(skipped.status);
      if (row?.state === 'COMPLETED') {
        expect(started.status, tag).toBe(200);
        expect(await completions(arranged.manifest.id), tag).toHaveLength(1);
      }
    }
  });
});

describe('the completion is done through the run port, in the act’s own transaction', () => {
  const runAccess = (): RunAccess =>
    routes.kit.app.app.get<RunAccess>(RUN_ACCESS, { strict: false });
  const ledger = (): AuditWriter =>
    routes.kit.app.app.get<AuditWriter>(AUDIT_WRITER, { strict: false });
  const stopStateOf = (id: string) =>
    routes
      .rows<{ state: string }>(`select state from pickup_stop where id = $1`, [id])
      .then((rows) => rows[0]?.state);
  const requestStateOf = (id: string) =>
    routes
      .rows<{ state: string }>(`select state from pickup_request where id = $1`, [id])
      .then((rows) => rows[0]?.state);

  /** Skips with a key the test chooses, so that the same request can be sent again. */
  async function skipWith(actor: Actor, stopId: string, key: string): Promise<TestResponse> {
    const etag = (await actor.client.get(STOP(stopId))).header('etag') ?? '';
    return actor.client.post(
      SKIP(stopId),
      { reason_code: 'RUN_CUT_SHORT' },
      { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': key } },
    );
  }

  // Break caught: the completion asked on a connection of its own, or after the act's commit, which would make the skip and the completion that it
  // causes two pieces of work.
  it('gives the port the very transaction of the skip, the one its own ledger write used', async () => {
    const arranged = await run({ stops: 1 });
    const complete = vi.spyOn(runAccess(), 'completeIfSettled');
    const written = vi.spyOn(ledger(), 'write');
    try {
      expect((await skip(ops, arranged.stops[0]?.id ?? '')).status).toBe(200);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0]?.[2]).toBe('LAST_STOP_SKIPPED');
      expect(complete.mock.calls[0]?.[0]).toBeDefined();
      expect(complete.mock.calls[0]?.[0]).toBe(written.mock.calls[0]?.[0]);
    } finally {
      complete.mockRestore();
      written.mockRestore();
    }
    expect((await manifestRow(arranged.manifest.id))?.state).toBe('COMPLETED');
  });

  // Break caught: a skip kept although the completion it causes failed (a stop skipped in a run that nothing would now complete), or a key spent by a
  // skip that did not happen.
  it('takes the skip back whole when the completion through the port fails, and lets the same request be sent again', async () => {
    const arranged = await run({ stops: 1 });
    const stopId = arranged.stops[0]?.id ?? '';
    const key = randomUUID();
    const failing = vi
      .spyOn(runAccess(), 'completeIfSettled')
      .mockRejectedValueOnce(new Error('the port failed'));
    try {
      expect((await skipWith(ops, stopId, key)).status).toBeGreaterThanOrEqual(500);
      expect(failing).toHaveBeenCalledTimes(1);
    } finally {
      failing.mockRestore();
    }
    expect(await stopStateOf(stopId)).toBe('PENDING');
    expect((await manifestRow(arranged.manifest.id))?.state).toBe('IN_PROGRESS');
    const skipped = await routes.rows(
      `select id from audit_event where event_code = 'pickup.stop.skipped' and object_id = $1`,
      [stopId],
    );
    expect(skipped).toEqual([]);

    expect((await skipWith(ops, stopId, key)).status).toBe(200);
    expect(await stopStateOf(stopId)).toBe('SKIPPED');
    expect((await manifestRow(arranged.manifest.id))?.state).toBe('COMPLETED');
  });

  // Break caught: a cancellation kept although the completion it causes failed.
  it('takes the cancellation back whole when the completion through the port fails', async () => {
    const arranged = await run({ stops: 2, stopStates: ['SKIPPED', 'PENDING'] });
    const open = arranged.stops[1];
    const failing = vi
      .spyOn(runAccess(), 'completeIfSettled')
      .mockRejectedValueOnce(new Error('the port failed'));
    try {
      expect((await cancel(ops, open?.requestId ?? '')).status).toBeGreaterThanOrEqual(500);
      expect(failing).toHaveBeenCalledTimes(1);
    } finally {
      failing.mockRestore();
    }
    expect(await requestStateOf(open?.requestId ?? '')).toBe('CONFIRMED');
    expect(await stopStateOf(open?.id ?? '')).toBe('PENDING');
    expect((await manifestRow(arranged.manifest.id))?.state).toBe('IN_PROGRESS');

    expect((await cancel(ops, open?.requestId ?? '')).status).toBe(200);
    expect((await manifestRow(arranged.manifest.id))?.state).toBe('COMPLETED');
  });
});
