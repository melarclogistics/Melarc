import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { insertSessionRow, sessionRow, type SessionRow } from './support/identities.js';
import {
  API,
  HUB_A,
  HUB_B,
  outcomeOf,
  startStaffRoutes,
  type Actor,
  type StaffRoutes,
} from './support/staff-routes.js';

/**
 * F02 of 23 October 2026: `listSessions` writes `auth.hub_boundary.crossed` (audit.md section 5.4 and 6) for the hubs its answer represents
 * that are not the actor's own. The rule is the one the S0.35 reads follow: the baseline is the actor's primary hub (an actor with none
 * has none of their own), one bounded event for each distinct foreign hub the returned list represents, naming the hub and the operation
 * and carrying neither a row nor a session id, none for an empty answer or an answer inside the actor's own hub, and a ledger that cannot
 * take the event fails the read. A session represents every hub it was issued for, so a session of two hubs represents both.
 */
let routes: StaffRoutes;

beforeAll(async () => {
  routes = await startStaffRoutes();
});

afterAll(async () => {
  await routes.stop();
});

const LIST = (type: string, id: string) =>
  `${API}/auth/sessions?principal_type=${type}&principal_id=${id}`;

/** A live session of a rider, a vendor or a staff member, arranged: the principal and the hubs it was issued for. */
function arranged(
  type: 'VENDOR' | 'RIDER' | 'STAFF',
  hubs: readonly string[],
  principalId: string,
  overrides: Partial<SessionRow> = {},
): Promise<SessionRow> {
  return insertSessionRow(
    routes.admin,
    sessionRow({
      principalType: type,
      principalId,
      authorizedHubIds: hubs,
      registeredDeviceId: type === 'STAFF' ? null : randomUUID(),
      policyRevision: type === 'STAFF' ? null : 1,
      bundleId:
        type === 'VENDOR'
          ? BUNDLE_IDS.vendor
          : type === 'RIDER'
            ? BUNDLE_IDS.rider
            : BUNDLE_IDS.opsStaff,
      ...overrides,
    }),
  );
}

interface Crossing {
  readonly object_type: string;
  readonly object_id: string;
  readonly responsible_hub_id: string;
  readonly enhanced: boolean;
  readonly outcome: string;
  readonly related_ids: Record<string, unknown>;
  readonly before_after: unknown;
  readonly note: string | null;
  readonly detail: Record<string, unknown>;
  readonly actor_id: string;
}

/** The crossing events a given actor's listings wrote, in the order they were written. */
const crossingsBy = (officer: Actor) =>
  routes.rows<Crossing>(
    `select object_type, object_id, responsible_hub_id, enhanced, outcome, related_ids, before_after, note, detail, actor_id
       from audit_event
      where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 order by recorded_at, id`,
    [officer.identity.id],
  );

const hubsOf = (events: readonly Crossing[]): string[] => events.map((event) => event.object_id);

describe('F02: listSessions audits the foreign hubs its answer represents', () => {
  // Break caught: no event at all (the finding), or one for every session instead of every hub, or one that names the sessions.
  it('writes one bounded event for a foreign hub however many of its sessions are listed, and names neither a session nor a row', async () => {
    const officer = await routes.platformAdmin();
    const target = await routes.opsStaff(HUB_A);
    const second = await arranged('STAFF', [HUB_A], target.identity.id);
    const third = await arranged('STAFF', [HUB_A], target.identity.id);

    const answer = await officer.client.get(LIST('STAFF', target.identity.id));

    expect(answer.status).toBe(200);
    expect((answer.json() as { items: unknown[] }).items).toHaveLength(3);
    const events = await crossingsBy(officer);
    expect(events).toEqual([
      {
        object_type: 'HUB',
        object_id: HUB_A,
        responsible_hub_id: HUB_A,
        enhanced: true,
        outcome: 'SUCCEEDED',
        related_ids: { operation_id: 'listSessions' },
        before_after: null,
        note: null,
        detail: {},
        actor_id: officer.identity.id,
      },
    ]);
    const text = JSON.stringify(events);
    for (const secret of [target.sessionId, second.id, third.id, target.identity.id]) {
      expect(text).not.toContain(secret);
    }
  });

  // Break caught: the baseline being the actor's reach instead of their primary hub, or an actor with no primary hub being exempt.
  it('treats every hub as foreign for an actor with no primary hub, and only the other hubs for one who has one', async () => {
    const homeless = await routes.platformAdmin();
    const homed = await routes.actor(BUNDLE_IDS.platformAdmin, HUB_A);
    const inA = await routes.opsStaff(HUB_A);
    const inB = await routes.opsStaff(HUB_B);

    await homeless.client.get(LIST('STAFF', inA.identity.id));
    await homed.client.get(LIST('STAFF', inA.identity.id));
    await homed.client.get(LIST('STAFF', inB.identity.id));

    expect(hubsOf(await crossingsBy(homeless))).toEqual([HUB_A]);
    expect(hubsOf(await crossingsBy(homed))).toEqual([HUB_B]);
  });

  // Break caught: hubs of a list chosen arbitrarily (the first session's), so a staff member with sessions in two hubs is audited for one.
  // A rider or a vendor holds one live session at most (session_one_live_vendor_or_rider_key); a staff member may hold several.
  it('writes one event for each distinct foreign hub a list represents, in the order of the hubs’ ids', async () => {
    const officer = await routes.platformAdmin();
    const target = await routes.opsStaff(null);
    await arranged('STAFF', [HUB_B], target.identity.id);
    await arranged('STAFF', [HUB_A], target.identity.id);
    await arranged('STAFF', [HUB_A], target.identity.id);

    const answer = await officer.client.get(LIST('STAFF', target.identity.id));

    expect((answer.json() as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(3);
    expect(hubsOf(await crossingsBy(officer))).toEqual([HUB_A, HUB_B].toSorted());
  });

  // Break caught: a session with several hubs being filed under one of them. It represents all of them: a session of the actor's own hub
  // and another is a read of the other hub too, and one hub is never chosen for it.
  it('counts every hub of a session that has several', async () => {
    const homed = await routes.actor(BUNDLE_IDS.platformAdmin, HUB_A);
    const rider = randomUUID();
    await arranged('RIDER', [HUB_A, HUB_B], rider);

    await homed.client.get(LIST('RIDER', rider));

    expect(hubsOf(await crossingsBy(homed))).toEqual([HUB_B]);
  });

  it('writes none for a list inside the actor’s own hub', async () => {
    const homed = await routes.actor(BUNDLE_IDS.platformAdmin, HUB_A);
    const rider = randomUUID();
    await arranged('RIDER', [HUB_A], rider);

    const answer = await homed.client.get(LIST('RIDER', rider));

    expect((answer.json() as { items: unknown[] }).items).toHaveLength(1);
    expect(await crossingsBy(homed)).toEqual([]);
  });

  // Break caught: an event written for an empty answer (the identity's hub is foreign, but nothing of it was read), or for a session
  // that was not returned (an ended one, or one past its idle limit).
  it('writes none for an empty answer, and counts only the sessions it returned', async () => {
    const officer = await routes.platformAdmin();
    const rider = randomUUID();
    await arranged('RIDER', [HUB_B], rider, {
      terminatedAt: new Date(),
      terminationReason: 'SIGNED_OUT',
    });
    const withoutSessions = await routes.opsStaff(HUB_B);
    await routes.admin.query(
      'update session set terminated_at = now(), termination_reason = $2 where principal_id = $1',
      [withoutSessions.identity.id, 'SIGNED_OUT'],
    );

    const ended = await officer.client.get(LIST('RIDER', rider));
    const none = await officer.client.get(LIST('STAFF', withoutSessions.identity.id));

    expect((ended.json() as { items: unknown[] }).items).toEqual([]);
    expect((none.json() as { items: unknown[] }).items).toEqual([]);
    expect(await crossingsBy(officer)).toEqual([]);
  });

  // Break caught: a vendor's sessions, which carry no hub, being reported as a crossing of a hub that does not exist.
  it('writes none for a vendor, whose sessions carry no hub', async () => {
    const officer = await routes.platformAdmin();
    const vendor = randomUUID();
    await arranged('VENDOR', [], vendor);

    const answer = await officer.client.get(LIST('VENDOR', vendor));

    expect((answer.json() as { items: unknown[] }).items).toHaveLength(1);
    expect(await crossingsBy(officer)).toEqual([]);
  });

  it('writes none for a list that was refused', async () => {
    const senior = await routes.seniorOps(HUB_A);
    const target = await routes.opsStaff(HUB_B);

    const tier = await senior.client.get(LIST('STAFF', target.identity.id));
    const absent = await senior.client.get(LIST('RIDER', randomUUID()));

    expect(outcomeOf(tier)).toEqual([403, 'INSUFFICIENT_AUTHORITY']);
    expect(outcomeOf(absent)).toEqual([404, 'NOT_FOUND']);
    expect(await crossingsBy(senior)).toEqual([]);
  });

  // Break caught: a read that returns the list when the event cannot be written, which is an unaudited cross-hub read: "an authorised
  // staff read outside the actor's own hub" is exactly what the event exists to record (audit.md section 5.4).
  it('fails the read when the ledger cannot take the event, and returns no list', async () => {
    const officer = await routes.platformAdmin();
    const target = await routes.opsStaff(HUB_A);
    await routes.admin.query(`
      create function public.melarc_test_refuse_crossing() returns trigger language plpgsql as
        $$ begin raise exception 'the event is refused by the test' using errcode = 'P0001'; end $$`);
    await routes.admin.query(`
      create trigger melarc_test_refuse_crossing before insert on audit_event
        for each row when (new.event_code = 'auth.hub_boundary.crossed') execute function public.melarc_test_refuse_crossing()`);
    let answer;
    try {
      answer = await officer.client.get(LIST('STAFF', target.identity.id));
    } finally {
      await routes.admin.query('drop trigger melarc_test_refuse_crossing on audit_event');
      await routes.admin.query('drop function public.melarc_test_refuse_crossing()');
    }

    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(answer.json())).not.toContain(target.sessionId);
    expect(await crossingsBy(officer)).toEqual([]);
  });

  // Senior Ops lists a rider of its own hub: the baseline is the primary hub, so a session of its hub and another is audited for the other.
  it('audits the other hub of a rider’s session that Senior Ops reaches through its own', async () => {
    const senior = await routes.seniorOps(HUB_A);
    const rider = randomUUID();
    await arranged('RIDER', [HUB_A, HUB_B], rider);

    const answer = await senior.client.get(LIST('RIDER', rider));

    expect((answer.json() as { items: unknown[] }).items).toHaveLength(1);
    expect(hubsOf(await crossingsBy(senior))).toEqual([HUB_B]);
  });
});
