import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { waitUntilBlockedBy } from './support/lock-wait.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { holdingClaim, insertManifest, manifestRow } from './support/manifests.js';
import {
  ARRANGER,
  holdingPickupRequest,
  insertPickupRequest,
  pickupRequestRow,
} from './support/pickups.js';
import { API, HUB_A, OPS, codeOf, type Actor } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import { startVendorRoutes, type VendorRoutes } from './support/vendor-routes.js';

/**
 * S1.20, `createPickupManifest` where two acts meet (`AC-SLICE-001-11`; the Product Owner's decision of 1 November 2026, plan section 11,
 * call 2 and the verification of the review): **one claim wins, and nothing partial is left behind**. A manifest and its stops are one
 * transaction, the claim is the partial unique index of the stop, and a creation that loses refuses whole.
 *
 * - Two Ops users who name overlapping requests at once: exactly one creation succeeds, the other is refused `ALREADY_MANIFESTED`, the
 *   contested request has one claim, and no manifest is left without its stops, no stop without its manifest.
 * - A claim that is held and not yet decided (the competing transaction has not committed): the creation waits for it, observed from
 *   the server and not assumed, and then is refused if the claim stood and succeeds if it did not.
 * - The claims are taken in the order of the request ids, so that two creations that name the same requests in opposite orders queue
 *   on the same request first and never wait for each other.
 * - A cancellation that holds a request while a creation is placing its stops: the creation judges the request again once its stop holds
 *   it, and refuses a request that was cancelled in that window.
 *
 * Nothing here tests a timeout: the database's lock bound is lengthened for this application alone, and each wait ends when the test
 * says so, once the server reports the creation waiting.
 */
const LIST = `${API}/pickup-manifests`;
/** Relative to the database's clock on the hub (support/manifest-days.ts), set before any test runs. */
let days: ManifestDays;

let routes: VendorRoutes;
let opsOne: Actor;
let opsTwo: Actor;
let opsThree: Actor;
let organisation: string;

beforeAll(async () => {
  routes = await startVendorRoutes({
    env: {
      DATABASE_LOCK_TIMEOUT_MS: '20000',
      DATABASE_STATEMENT_TIMEOUT_MS: '25000',
      DATABASE_TRANSACTION_TIMEOUT_MS: '30000',
    },
  });
  days = await manifestDays(routes.admin);
  organisation = (await routes.vendor()).row.organizationId;
  opsOne = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsTwo = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsThree = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const confirmedMany = async (count: number): Promise<string[]> => {
  const made: string[] = [];
  for (let each = 0; each < count; each += 1) {
    made.push(
      (
        await insertPickupRequest(
          routes.admin,
          pickupRequestRow(organisation, HUB_A, { state: 'CONFIRMED', serviceDate: days.day }),
        )
      ).id,
    );
  }
  return made;
};

function create(
  actor: Actor,
  ids: readonly string[],
  idempotencyKey: string = randomUUID(),
): Promise<TestResponse> {
  return actor.client.post(
    LIST,
    { pickup_request_ids: ids, service_date: days.day },
    { origin: OPS, headers: { 'Idempotency-Key': idempotencyKey } },
  );
}

interface Made {
  readonly id: string;
  readonly stops: { readonly pickup_request_id: string }[];
}
const madeBy = (response: TestResponse): Made => response.json() as Made;
const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];

const claimsOf = (requestId: string) =>
  routes.rows<{ pickup_manifest_id: string; released_at: Date | null }>(
    `select pickup_manifest_id, released_at from pickup_stop where pickup_request_id = $1`,
    [requestId],
  );

/** Manifests with no stop, and stops of no manifest of the hub: the partial result a lost claim must never leave. */
async function leftovers(): Promise<{
  readonly emptyManifests: number;
  readonly orphanStops: number;
}> {
  const [row] = await routes.rows<{ empty: number; orphan: number }>(
    `select (select count(*) from pickup_manifest m where m.created_by = any($1::uuid[])
              and not exists (select 1 from pickup_stop s where s.pickup_manifest_id = m.id))::int as empty,
            (select count(*) from pickup_stop s
              where not exists (select 1 from pickup_manifest m where m.id = s.pickup_manifest_id))::int as orphan`,
    [[opsOne.identity.id, opsTwo.identity.id, opsThree.identity.id]],
  );
  return { emptyManifests: row?.empty ?? -1, orphanStops: row?.orphan ?? -1 };
}

describe('two Ops users claim overlapping requests at once', () => {
  // Break caught: a claim that two creations can both hold (a check that reads and then writes, with no index behind it), or a loser
  // that leaves its manifest, a stop of it, or a claim on its other request behind.
  it.each([
    ['in the same order', false],
    ['in opposite orders', true],
  ])(
    'lets one win and refuses the other whole, when they name the contested request %s',
    async (_label, reverse) => {
      for (let round = 0; round < 5; round += 1) {
        const [a = '', b = '', c = ''] = await confirmedMany(3);
        const [first, second] = await Promise.all([
          create(opsOne, [a, b]),
          create(opsTwo, reverse ? [c, b] : [b, c]),
        ]);
        const outcomes = [first, second].map(outcome);
        expect(
          outcomes.filter(([status]) => status === 201),
          JSON.stringify(outcomes),
        ).toHaveLength(1);
        expect(outcomes).toContainEqual([422, 'ALREADY_MANIFESTED']);

        const [winner, loserOnly] = first.status === 201 ? [first, c] : [second, a];
        const won = madeBy(winner);
        expect(won.stops).toHaveLength(2);
        // The contested request has one claim, the winner's; the request only the loser named is free.
        expect(await claimsOf(b)).toEqual([{ pickup_manifest_id: won.id, released_at: null }]);
        expect(await claimsOf(loserOnly)).toEqual([]);
      }
      expect(await leftovers()).toEqual({ emptyManifests: 0, orphanStops: 0 });
    },
  );

  // Break caught: claims taken in the order the client named them, so that three creations that name the same requests in a cycle wait
  // for each other (the database ends the wait with an error, a server failure to the client).
  it('lets exactly one of three creations that name the same requests in a cycle win, and fails none', async () => {
    for (let round = 0; round < 4; round += 1) {
      const [a = '', b = '', c = ''] = await confirmedMany(3);
      const answers = await Promise.all([
        create(opsOne, [a, b]),
        create(opsTwo, [b, c]),
        create(opsThree, [c, a]),
      ]);
      const outcomes = answers.map(outcome);
      expect(
        outcomes.filter(([status]) => status === 201),
        JSON.stringify(outcomes),
      ).toHaveLength(1);
      expect(
        outcomes.filter(([status, code]) => status === 422 && code === 'ALREADY_MANIFESTED'),
      ).toHaveLength(2);
      for (const request of [a, b, c])
        expect((await claimsOf(request)).length).toBeLessThanOrEqual(1);
    }
    expect(await leftovers()).toEqual({ emptyManifests: 0, orphanStops: 0 });
  });

  // Break caught: a retry sent twice at once that makes two manifests, or is answered a server failure.
  it('answers the same command sent twice at once with one manifest and the same answer', async () => {
    const ids = await confirmedMany(2);
    const key = randomUUID();
    const [x, y] = await Promise.all([create(opsOne, ids, key), create(opsOne, ids, key)]);
    expect([x.status, y.status]).toEqual([201, 201]);
    expect(y.text).toBe(x.text);
    expect(await claimsOf(ids[0] ?? '')).toHaveLength(1);
  });
});

describe('a claim that is held and not yet decided', () => {
  /**
   * Starts the creation, waits until the server reports it waiting for the holder, and returns it still pending (in an object: a promise
   * returned from an async function would be waited for, and it cannot end until the holder lets go).
   */
  async function waitingFor(
    holder: { readonly pid: number },
    actor: Actor,
    ids: readonly string[],
  ): Promise<{ readonly creating: Promise<TestResponse> }> {
    const creating = create(actor, ids);
    await waitUntilBlockedBy(routes.admin, holder.pid, 'the creation', creating);
    return { creating };
  }

  // Break caught: a creation that does not wait for a claim that is still open, and so takes the request or refuses it on a guess; and one
  // that, refused, leaves a part of itself behind.
  it('waits for the claim, and is refused whole when the claim stood', async () => {
    const [contested = '', other = ''] = await confirmedMany(2);
    const held = await holdingClaim(routes.database, HUB_A, contested);
    let creating: Promise<TestResponse> | undefined;
    try {
      creating = (await waitingFor(held, opsOne, [other, contested])).creating;
      await held.client.query('commit');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await creating?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    const answer = await creating;
    expect(outcome(answer)).toEqual([422, 'ALREADY_MANIFESTED']);
    expect((answer.json() as { details?: { violations?: unknown[] } }).details?.violations).toEqual(
      [{ in: 'body', pointer: '/pickup_request_ids/1', rule: 'already_manifested' }],
    );
    // The holder's claim stands, alone; the request the loser also named is free; the loser left nothing.
    expect(await claimsOf(contested)).toEqual([
      { pickup_manifest_id: held.manifest.id, released_at: null },
    ]);
    expect(await claimsOf(other)).toEqual([]);
    expect(await leftovers()).toEqual({ emptyManifests: 0, orphanStops: 0 });
  });

  // Break caught: a creation that is refused although the claim it waited for was abandoned.
  it('waits for the claim, and succeeds when the claim was abandoned', async () => {
    const [contested = '', other = ''] = await confirmedMany(2);
    const held = await holdingClaim(routes.database, HUB_A, contested);
    let creating: Promise<TestResponse> | undefined;
    try {
      creating = (await waitingFor(held, opsOne, [contested, other])).creating;
      await held.client.query('rollback');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await creating?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    const answer = await creating;
    expect(answer.status).toBe(201);
    const made = madeBy(answer);
    expect(made.stops.map((stop) => stop.pickup_request_id)).toEqual([contested, other]);
    expect(await claimsOf(contested)).toEqual([{ pickup_manifest_id: made.id, released_at: null }]);
  });

  // Break caught: claims taken in the order the client named the requests. A creation that names the highest request first, and meets a
  // claim on it, must already hold the lowest: that is what makes two creations queue on the same request and never on each other.
  it('takes the claims in the order of the request ids, whatever order the client named them in', async () => {
    const [low = '', high = ''] = (await confirmedMany(2)).toSorted();
    const held = await holdingClaim(routes.database, HUB_A, high);
    const probe = clientFor(routes.database.urlFor('postgres'));
    await probe.connect();
    let creating: Promise<TestResponse> | undefined;
    try {
      creating = (await waitingFor(held, opsOne, [high, low])).creating;
      // Another transaction that wants the lowest request has to wait for the creation, which already holds it (an insert into a unique
      // index waits for an insert that has not ended). If the creation had not reached it, this would simply succeed.
      const other = await insertManifest(routes.admin, manifestRow(HUB_A));
      await probe.query('begin');
      await probe.query(`set local lock_timeout = '400ms'`);
      const probed = await probe
        .query(
          `insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence)
           values ($1, $2, $3, $4, 1)`,
          [randomUUID(), other.id, low, HUB_A],
        )
        .then(
          () => 'inserted',
          (error: unknown) => (error as { code?: string }).code,
        );
      await probe.query('rollback');
      expect(probed).toBe('55P03');
      await held.client.query('rollback');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await creating?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
      await probe.end();
    }
    // The claim was abandoned, so the creation succeeds with the stops in the order named.
    const answer = await creating;
    expect(answer.status).toBe(201);
    expect(madeBy(answer).stops.map((stop) => stop.pickup_request_id)).toEqual([high, low]);
  });
});

describe('a cancellation that holds a request while its stop is being placed', () => {
  // Break caught: a creation that judged its requests once, before their stops held them, and so manifests a request that was cancelled
  // between the two. The stop's foreign key takes a share of the request's row, which the cancellation's lock (`for update`) has to
  // be waited for, and the statement that follows sees what the cancellation committed.
  it('refuses a request cancelled in that window, and leaves no manifest and no claim', async () => {
    const [cancelled = '', other = ''] = await confirmedMany(2);
    const [before] = await routes.rows<{ n: number }>(
      `select count(*)::int as n from pickup_manifest`,
    );
    const held = await holdingPickupRequest(routes.database, cancelled);
    let creating: Promise<TestResponse> | undefined;
    try {
      creating = create(opsOne, [cancelled, other]);
      await waitUntilBlockedBy(routes.admin, held.pid, 'the creation', creating);
      await held.client.query(
        `update pickup_request set state = 'CANCELLED', cancelled_at = now(), cancelled_by = $2 where id = $1`,
        [cancelled, ARRANGER],
      );
      await held.client.query('commit');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await creating?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    const answer = await creating;
    expect(outcome(answer)).toEqual([400, 'VALIDATION_FAILED']);
    expect((answer.json() as { details?: { violations?: unknown[] } }).details?.violations).toEqual(
      [{ in: 'body', pointer: '/pickup_request_ids/0', rule: 'not_confirmed' }],
    );
    expect(await claimsOf(cancelled)).toEqual([]);
    expect(await claimsOf(other)).toEqual([]);
    const [after] = await routes.rows<{ n: number }>(
      `select count(*)::int as n from pickup_manifest`,
    );
    expect(after?.n).toBe(before?.n);
    expect(await leftovers()).toEqual({ emptyManifests: 0, orphanStops: 0 });
  });
});

describe('a promise that changes while a manifest is being made', () => {
  const FIXTURE_REASON = 'FIXTURE_CARRYOVER_RACE';

  // Break caught: reasons asked for the requests that were overdue when the creation began, and written to stops although a promise was
  // changed in the window (the stops would name a request as carried over that is on its own day, or leave one out). Nothing changes the day
  // of a request in the application; the administrator can, and the creation judges its requests again once their stops hold them.
  it('refuses the creation at the places whose standing changed, and leaves no manifest and no claim', async () => {
    await routes.admin.query(
      `insert into reason_code (code, domain, label, attribution, requires_note, active)
       values ($1, 'PICKUP_CARRYOVER', 'Fixture race', 'EXTERNAL', false, true)`,
      [FIXTURE_REASON],
    );
    const late = (
      await insertPickupRequest(
        routes.admin,
        pickupRequestRow(organisation, HUB_A, { state: 'CONFIRMED', serviceDate: days.past }),
      )
    ).id;
    const [onDay = ''] = await confirmedMany(1);
    const [before] = await routes.rows<{ n: number }>(
      `select count(*)::int as n from pickup_manifest`,
    );
    const held = await holdingPickupRequest(routes.database, late);
    let creating: Promise<TestResponse> | undefined;
    try {
      creating = opsOne.client.post(
        LIST,
        {
          pickup_request_ids: [late, onDay],
          service_date: days.day,
          carryover: [{ pickup_request_id: late, reason_code: FIXTURE_REASON }],
        },
        { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
      );
      await waitUntilBlockedBy(routes.admin, held.pid, 'the creation', creating);
      // The overdue request is promised for the manifest's own day now, and the other one for a day that has gone.
      await held.client.query(
        `update pickup_request set scheduled_service_date = $2 where id = $1`,
        [late, days.day],
      );
      await held.client.query(
        `update pickup_request set scheduled_service_date = $2 where id = $1`,
        [onDay, days.past],
      );
      await held.client.query('commit');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await creating?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    const answer = await creating;
    expect(outcome(answer)).toEqual([400, 'VALIDATION_FAILED']);
    expect((answer.json() as { details?: { violations?: unknown[] } }).details?.violations).toEqual(
      [
        { in: 'body', pointer: '/pickup_request_ids/0', rule: 'promise_changed' },
        { in: 'body', pointer: '/pickup_request_ids/1', rule: 'promise_changed' },
      ],
    );
    expect(await claimsOf(late)).toEqual([]);
    expect(await claimsOf(onDay)).toEqual([]);
    const [after] = await routes.rows<{ n: number }>(
      `select count(*)::int as n from pickup_manifest`,
    );
    expect(after?.n).toBe(before?.n);
    expect(await leftovers()).toEqual({ emptyManifests: 0, orphanStops: 0 });
  });
});
