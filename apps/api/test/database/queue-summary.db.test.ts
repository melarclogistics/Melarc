import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { insertStaff, staffRow } from './support/identities.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import {
  exceptionRow,
  insertOnePackageException,
  insertPickupRequest,
  pickupRequestRow,
  type PickupRequestRow,
} from './support/pickups.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { insertRider, riderRow } from './support/riders.js';
import {
  API,
  HUB_A,
  HUB_B,
  startStaffRoutes,
  type Actor,
  type StaffRoutes,
} from './support/staff-routes.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * Task C1, `getQueueSummary` against the real application and a real PostgreSQL (`AC-QSUM-01` to `AC-QSUM-09`, reporting-data-dictionary.md
 * section 5.5): **a queue's count is the number of records its own list returns to the same session**, for an Ops Staff officer, a Senior Ops
 * user and a Platform Admin, in the hubs of the grant and in all of them; a queue the session may not read has no entry (never a `0`); the
 * scope of an entry is the grant of the key of its list and no wider one; and the answer is the queue, the count and the moment of the oldest,
 * and nothing else.
 *
 * Each expectation is built from the lists, **read through the real list operations of the same session** and paged by their tokens, and
 * never from the code under test; the numbers a reader can check by eye are also written out for the sessions that matter, so that a count
 * and a list that were wrong in the same way would still fail.
 */
const SUMMARY = `${API}/ops/queue-summary`;

/** The moments the arranged records entered their queues: the oldest of a queue is the least of these in the session's hubs. */
const T = {
  lateB: new Date('2026-10-29T08:00:00.000Z'), // hub B's late booking: older than anything of hub A's
  poolB: new Date('2026-10-29T10:00:00.000Z'),
  lateA: new Date('2026-10-30T08:00:00.000Z'),
  releasedA: new Date('2026-10-30T20:00:00.000Z'), // hub A's request returned to the pool: the oldest of A's pool
  pool1A: new Date('2026-10-31T08:00:00.000Z'),
  pool2A: new Date('2026-11-01T08:00:00.000Z'),
  onDraftA: new Date('2026-11-01T09:00:00.000Z'),
  resolvedA: new Date('2026-11-01T12:00:00.000Z'),
  startedB: new Date('2026-11-02T07:00:00.000Z'), // hub B's run: older than A's
  startedA1: new Date('2026-11-03T07:00:00.000Z'),
  startedA2: new Date('2026-11-03T09:00:00.000Z'),
};

type Queue =
  | 'PICKUP_AWAITING_CONFIRMATION'
  | 'PICKUP_CUTOFF_REVIEW'
  | 'PICKUP_EXCEPTION_APPROVAL'
  | 'PICKUP_UNMANIFESTED_POOL'
  | 'PICKUP_RUNS_IN_PROGRESS'
  | 'STAFF_AWAITING_APPROVAL';

interface Entry {
  readonly queue: Queue;
  readonly count: number;
  readonly oldest_at?: string;
}

interface RequestItem {
  readonly id: string;
  readonly created_at: string;
  readonly confirmed_at: string | null;
  readonly cutoff_exception_state: string | null;
  readonly one_package_exception: { readonly requested_at: string } | null;
}
interface ManifestItem {
  readonly id: string;
  readonly started_at: string | null;
}
interface StaffItem {
  readonly id: string;
}

/**
 * The queues, in the order of the contract's `QueueId`, each with the list the screen reads for it, the keys that make it the session's
 * work, and how the moment of its oldest record is read from what that list returned (never from the code under test).
 */
interface QueueDefinition {
  readonly queue: Queue;
  readonly listKey: string;
  readonly decisionKey?: string;
}
const QUEUES: readonly QueueDefinition[] = [
  { queue: 'PICKUP_AWAITING_CONFIRMATION', listKey: 'pickup.read' },
  { queue: 'PICKUP_CUTOFF_REVIEW', listKey: 'pickup.read' },
  {
    queue: 'PICKUP_EXCEPTION_APPROVAL',
    listKey: 'pickup.read',
    decisionKey: 'pickup.exception.approve',
  },
  { queue: 'PICKUP_UNMANIFESTED_POOL', listKey: 'pickup.read' },
  { queue: 'PICKUP_RUNS_IN_PROGRESS', listKey: 'pickup.read' },
  {
    queue: 'STAFF_AWAITING_APPROVAL',
    listKey: 'staff.read',
    decisionKey: 'staff.identity.approve',
  },
];

let routes: StaffRoutes;
const requests: Record<string, string> = {};
const staff: Record<string, string> = {};

/** A page of any of the three lists, read by an actor through HTTP; the status is kept, because a list the session may not read is refused. */
async function everyItemOf(
  actor: Actor,
  path: string,
): Promise<{ readonly status: number; readonly items: readonly unknown[] }> {
  const items: unknown[] = [];
  let token: string | null = null;
  // A page of two, so that a queue of any size is read across pages and a count is compared with the whole of the list, not with a page.
  for (;;) {
    const separator = path.includes('?') ? '&' : '?';
    const url = `${API}${path}${separator}page_size=2${token === null ? '' : `&page_token=${encodeURIComponent(token)}`}`;
    const response: TestResponse = await actor.client.get(url);
    if (response.status !== 200) return { status: response.status, items: [] };
    const page = response.json() as { items: unknown[]; next_page_token: string | null };
    items.push(...page.items);
    if (page.next_page_token === null) return { status: 200, items };
    token = page.next_page_token;
  }
}

/** The three lists, each read to its end, with the fields of its items this file reads. */
const requestsOf = async (actor: Actor, path: string) => {
  const read = await everyItemOf(actor, path);
  return { status: read.status, items: read.items as readonly RequestItem[] };
};
const manifestsOf = async (actor: Actor, path: string) => {
  const read = await everyItemOf(actor, path);
  return { status: read.status, items: read.items as readonly ManifestItem[] };
};
const staffOf = async (actor: Actor, path: string) => {
  const read = await everyItemOf(actor, path);
  return { status: read.status, items: read.items as readonly StaffItem[] };
};

const earliest = (moments: readonly string[]): string | undefined =>
  moments.length === 0
    ? undefined
    : new Date(Math.min(...moments.map((moment) => new Date(moment).getTime()))).toISOString();

/** What the queue's own list returns to the actor, as the entry that must equal it (or the refusal of the list when the actor may not read it). */
async function fromTheList(
  actor: Actor,
  queue: Queue,
): Promise<{ readonly status: number; readonly entry: Omit<Entry, 'queue'> }> {
  const entry = (moments: readonly string[], count: number): Omit<Entry, 'queue'> => {
    const oldest = earliest(moments);
    return oldest === undefined || count === 0 ? { count } : { count, oldest_at: oldest };
  };
  switch (queue) {
    case 'PICKUP_AWAITING_CONFIRMATION': {
      const list = await requestsOf(actor, '/pickup-requests?state=PENDING');
      return {
        status: list.status,
        entry: entry(
          list.items.map((item) => item.created_at),
          list.items.length,
        ),
      };
    }
    case 'PICKUP_CUTOFF_REVIEW': {
      // The list has no parameter for it: the confirmed list shows each such request with the cutoff state, and the count is held to that.
      const list = await requestsOf(actor, '/pickup-requests?state=CONFIRMED');
      const late = list.items.filter(
        (item) => item.cutoff_exception_state === 'PENDING_OPS_REVIEW',
      );
      return {
        status: list.status,
        entry: entry(
          late.map((item) => item.confirmed_at ?? ''),
          late.length,
        ),
      };
    }
    case 'PICKUP_EXCEPTION_APPROVAL': {
      const list = await requestsOf(
        actor,
        '/pickup-requests?one_package_exception_state=REQUESTED',
      );
      return {
        status: list.status,
        entry: entry(
          list.items.map((item) => item.one_package_exception?.requested_at ?? ''),
          list.items.length,
        ),
      };
    }
    case 'PICKUP_UNMANIFESTED_POOL': {
      const list = await requestsOf(actor, '/pickup-requests?state=CONFIRMED&manifested=false');
      return {
        status: list.status,
        entry: entry(
          list.items.map((item) => item.confirmed_at ?? ''),
          list.items.length,
        ),
      };
    }
    case 'PICKUP_RUNS_IN_PROGRESS': {
      const list = await manifestsOf(actor, '/pickup-manifests?state=IN_PROGRESS');
      return {
        status: list.status,
        entry: entry(
          list.items.map((item) => item.started_at ?? ''),
          list.items.length,
        ),
      };
    }
    case 'STAFF_AWAITING_APPROVAL': {
      const list = await staffOf(actor, '/staff-identities?status=PENDING_APPROVAL');
      // A staff representation carries no creation moment: it is read, for the profiles the list returned, from the table.
      const ids = list.items.map((item) => item.id);
      const moments =
        ids.length === 0
          ? []
          : (
              await routes.rows<{ created_at: Date }>(
                `select created_at from staff_identity where id = any($1::uuid[])`,
                [ids],
              )
            ).map((row) => row.created_at.toISOString());
      return { status: list.status, entry: entry(moments, list.items.length) };
    }
  }
}

/** The keys the actor's session holds, as the session says them. */
async function keysHeldBy(actor: Actor): Promise<ReadonlySet<string>> {
  const response = await actor.client.get(`${API}/auth/session`);
  expect(response.status).toBe(200);
  return new Set((response.json() as { permissions: string[] }).permissions);
}

/**
 * The summary the lists predict for the actor: an entry for each queue whose list key and decision key the session holds, built from what
 * the list returned; and, for a queue it may not read, the list must refuse the session (so that "no entry" is the list's refusal and not a
 * count that was lost).
 */
async function predictedFor(actor: Actor): Promise<readonly Entry[]> {
  const held = await keysHeldBy(actor);
  const entries: Entry[] = [];
  for (const definition of QUEUES) {
    const read = await fromTheList(actor, definition.queue);
    if (!held.has(definition.listKey)) {
      expect(read.status, `${definition.queue}: the list refuses a session without its key`).toBe(
        403,
      );
      continue;
    }
    expect(read.status, `${definition.queue}: the list is read`).toBe(200);
    if (definition.decisionKey !== undefined && !held.has(definition.decisionKey)) continue;
    entries.push({ queue: definition.queue, ...read.entry });
  }
  return entries;
}

async function summaryOf(actor: Actor): Promise<{
  readonly status: number;
  readonly queues: readonly Entry[];
  readonly response: TestResponse;
}> {
  const response = await actor.client.get(SUMMARY);
  const body = response.json() as { queues?: Entry[] };
  return { status: response.status, queues: body.queues ?? [], response };
}

const entryFor = (queues: readonly Entry[], queue: Queue): Entry | undefined =>
  queues.find((entry) => entry.queue === queue);

let vendorOrganizationId = '';

/** Inserts a request in creation order, by the name the file uses for it. */
async function make(
  name: string,
  hub: string,
  overrides: Partial<PickupRequestRow> = {},
): Promise<string> {
  const row = await insertPickupRequest(
    routes.admin,
    pickupRequestRow(vendorOrganizationId, hub, overrides),
  );
  requests[name] = row.id;
  return row.id;
}

beforeAll(async () => {
  routes = await startStaffRoutes();
  const vendor = await insertVendor(routes.admin, vendorRow({ hubId: HUB_A }));
  vendorOrganizationId = vendor.organizationId;

  // ---- Hub B first for the two that must be the oldest in the data (a leak of a hub's moments into another's would show as the oldest).
  await make('b.late', HUB_B, {
    state: 'CONFIRMED',
    cutoffState: 'PENDING_OPS_REVIEW',
    confirmedAt: T.lateB,
  });
  await make('b.pool', HUB_B, { state: 'CONFIRMED', confirmedAt: T.poolB });
  await make('b.pending', HUB_B);
  const bException = await make('b.pendingException', HUB_B, { packages: 1 });
  await insertOnePackageException(routes.admin, exceptionRow(bException));

  // ---- Hub A.
  await make('a.pending1', HUB_A);
  await make('a.pending2', HUB_A);
  const requested = await make('a.pendingException', HUB_A, { packages: 1 });
  await insertOnePackageException(routes.admin, exceptionRow(requested));
  // A refused exception and a second one asked for after it: the request is counted once, for the new one.
  const refusedThenAsked = await make('a.refusedThenAsked', HUB_A, { packages: 1 });
  await insertOnePackageException(
    routes.admin,
    exceptionRow(refusedThenAsked, { state: 'REJECTED' }),
  );
  await insertOnePackageException(routes.admin, exceptionRow(refusedThenAsked));
  // An approved exception that the request carries: decided, so it leaves the approver's queue.
  const approved = await make('a.approved', HUB_A, { packages: 1 });
  const approvedException = await insertOnePackageException(
    routes.admin,
    exceptionRow(approved, { state: 'APPROVED' }),
  );
  await routes.admin.query(
    `update pickup_request set one_package_exception_id = $1 where id = $2`,
    [approvedException.id, approved],
  );
  // A request cancelled while its exception was still asked for: it stays in the approver's queue, as the list shows it.
  const cancelled = await make('a.cancelledException', HUB_A, { packages: 1 });
  await insertOnePackageException(routes.admin, exceptionRow(cancelled));
  await routes.admin.query(
    `update pickup_request set state = 'CANCELLED', confirmed_at = $2, confirmed_by = created_by, cancelled_at = $3, cancelled_by = created_by where id = $1`,
    [cancelled, new Date('2026-11-02T09:00:00Z'), new Date('2026-11-02T10:00:00Z')],
  );
  await make('a.cancelled', HUB_A, { state: 'CANCELLED' });

  await make('a.late', HUB_A, {
    state: 'CONFIRMED',
    cutoffState: 'PENDING_OPS_REVIEW',
    confirmedAt: T.lateA,
  });
  const released = await make('a.released', HUB_A, {
    state: 'CONFIRMED',
    confirmedAt: T.releasedA,
  });
  await make('a.pool1', HUB_A, { state: 'CONFIRMED', confirmedAt: T.pool1A });
  await make('a.pool2', HUB_A, { state: 'CONFIRMED', confirmedAt: T.pool2A });
  const onDraft = await make('a.onDraft', HUB_A, { state: 'CONFIRMED', confirmedAt: T.onDraftA });
  await make('a.resolved', HUB_A, {
    state: 'CONFIRMED',
    cutoffState: 'SAME_DAY_APPROVED',
    confirmedAt: T.resolvedA,
  });

  // ---- The runs. A draft that holds a request (so that request is not in the pool), a cancelled one that released its claim (so that
  // request is back in it), the runs in progress of both hubs, and the ones that are not in progress.
  const draft = await insertManifest(routes.admin, manifestRow(HUB_A));
  await insertStop(routes.admin, stopRow(draft, onDraft, 1));
  const cancelledRun = await insertManifest(
    routes.admin,
    manifestRow(HUB_A, { state: 'CANCELLED' }),
  );
  await insertStop(
    routes.admin,
    stopRow(cancelledRun, released, 1, { releasedAt: new Date('2026-11-02T12:00:00Z') }),
  );
  // A run that has gone out has a rider; each of these has one of its own.
  const riderFor = async (hub: string): Promise<string> =>
    (await insertRider(routes.admin, riderRow({ hubId: hub }))).id;
  await insertManifest(
    routes.admin,
    manifestRow(HUB_A, { state: 'DISPATCHED', assignedRiderId: await riderFor(HUB_A) }),
  );
  await insertManifest(
    routes.admin,
    manifestRow(HUB_A, { state: 'COMPLETED', assignedRiderId: await riderFor(HUB_A) }),
  );
  await insertManifest(
    routes.admin,
    manifestRow(HUB_A, {
      state: 'IN_PROGRESS',
      startedAt: T.startedA1,
      assignedRiderId: await riderFor(HUB_A),
    }),
  );
  await insertManifest(
    routes.admin,
    manifestRow(HUB_A, {
      state: 'IN_PROGRESS',
      startedAt: T.startedA2,
      assignedRiderId: await riderFor(HUB_A),
    }),
  );
  await insertManifest(
    routes.admin,
    manifestRow(HUB_B, {
      state: 'IN_PROGRESS',
      startedAt: T.startedB,
      assignedRiderId: await riderFor(HUB_B),
    }),
  );

  // ---- The profiles waiting for approval: two at hub A, one at hub B, one with no hub; and two that are not waiting.
  const pending = (hub: string | null) =>
    staffRow({
      status: 'PENDING_APPROVAL',
      approvedBy: null,
      primaryHubId: hub,
      roleBundleId: BUNDLE_IDS.opsStaff,
    });
  for (const [name, hub] of [
    ['a.first', HUB_A],
    ['a.second', HUB_A],
    ['b.only', HUB_B],
    ['none', null],
  ] as const) {
    const row = await insertStaff(routes.admin, pending(hub));
    staff[name] = row.id;
  }
  await insertStaff(routes.admin, staffRow({ primaryHubId: HUB_A }));
  await insertStaff(
    routes.admin,
    staffRow({
      status: 'REJECTED',
      primaryHubId: HUB_A,
      credentialHash: null,
      credentialEstablishedAt: null,
    }),
  );
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

describe('a count is what its list returns', () => {
  const people: readonly [string, () => Promise<Actor>][] = [
    ['an Ops Staff officer of the first hub', () => routes.opsStaff(HUB_A)],
    ['an Ops Staff officer of the second hub', () => routes.opsStaff(HUB_B)],
    ['a Senior Ops user of the first hub', () => routes.seniorOps(HUB_A)],
    ['a Senior Ops user of the second hub', () => routes.seniorOps(HUB_B)],
    ['a Platform Admin with a primary hub', () => routes.actor(BUNDLE_IDS.platformAdmin, HUB_A)],
    ['a seeded Platform Admin with no hub', () => routes.platformAdmin()],
    [
      'a bundle of the all-hub grants of the queues’ lists',
      async () =>
        routes.actor(
          await newBundle(routes.admin, [
            grant('pickup.read', 'all'),
            grant('pickup.exception.approve', 'all'),
            grant('staff.read', 'all'),
            grant('staff.identity.approve', 'all'),
          ]),
          HUB_A,
        ),
    ],
    [
      'a bundle that reads the pickups at its hub and the staff at all of them',
      async () =>
        routes.actor(
          await newBundle(routes.admin, [
            grant('pickup.read', 'own'),
            grant('pickup.exception.approve', 'all'),
            grant('staff.read', 'all'),
            grant('staff.identity.approve', 'own'),
          ]),
          HUB_B,
        ),
    ],
  ];

  // Break caught: a count that differs from the list for the same session in any queue, in any scope: the heart of the operation.
  it.each(people)('for %s, every entry equals the list of its queue', async (_name, becomes) => {
    const actor = await becomes();
    const expected = await predictedFor(actor);
    const answer = await summaryOf(actor);

    expect(answer.status).toBe(200);
    expect(answer.queues).toEqual(expected);
  });

  // Break caught: the comparison above passing because both sides are empty, or the arranged data never reaching a queue.
  it('is not a comparison of empty things: the arranged data reaches every queue of the first hub’s officer and the second hub’s', async () => {
    const officerA = await summaryOf(await routes.opsStaff(HUB_A));
    expect(officerA.queues.map((entry) => entry.count)).toEqual([5, 1, 3, 4, 2]);
    const officerB = await summaryOf(await routes.opsStaff(HUB_B));
    expect(officerB.queues.map((entry) => entry.count)).toEqual([2, 1, 1, 1, 1]);
  });
});

describe('the figures a reader can check by eye', () => {
  // Break caught: a count and a list that are wrong in the same way (a shared predicate that has drifted from the feature).
  it('are, for an Ops Staff officer of the first hub: what is pending, late, asked for, in the pool and out on a run, and no staff queue', async () => {
    const officer = await routes.opsStaff(HUB_A);
    const { queues } = await summaryOf(officer);

    expect(queues).toEqual([
      // Pending: the two plain ones, the three with an exception of any state that are still pending (asked, refused-then-asked, approved).
      {
        queue: 'PICKUP_AWAITING_CONFIRMATION',
        count: 5,
        oldest_at: await createdAtOf(requests['a.pending1']),
      },
      // Late: the one confirmed after the cutoff and not decided; the one whose review was resolved is not in it.
      { queue: 'PICKUP_CUTOFF_REVIEW', count: 1, oldest_at: T.lateA.toISOString() },
      // Asked for and not decided: the asked one, the one asked for again after a refusal (once) and the one cancelled while asked for.
      {
        queue: 'PICKUP_EXCEPTION_APPROVAL',
        count: 3,
        oldest_at: await exceptionRequestedAt(requests['a.pendingException']),
      },
      // The pool: confirmed, no claim held, not awaiting the cutoff decision: the returned one, the two plain ones and the resolved one.
      { queue: 'PICKUP_UNMANIFESTED_POOL', count: 4, oldest_at: T.releasedA.toISOString() },
      { queue: 'PICKUP_RUNS_IN_PROGRESS', count: 2, oldest_at: T.startedA1.toISOString() },
    ]);
  });

  // Break caught: a hub's moments leaking into another's oldest, or a count that crosses hubs.
  it('are, for an officer of the second hub, the second hub’s own, with its own oldest moments', async () => {
    const { queues } = await summaryOf(await routes.opsStaff(HUB_B));

    expect(queues).toEqual([
      {
        queue: 'PICKUP_AWAITING_CONFIRMATION',
        count: 2,
        oldest_at: await createdAtOf(requests['b.pending']),
      },
      { queue: 'PICKUP_CUTOFF_REVIEW', count: 1, oldest_at: T.lateB.toISOString() },
      {
        queue: 'PICKUP_EXCEPTION_APPROVAL',
        count: 1,
        oldest_at: await exceptionRequestedAt(requests['b.pendingException']),
      },
      { queue: 'PICKUP_UNMANIFESTED_POOL', count: 1, oldest_at: T.poolB.toISOString() },
      { queue: 'PICKUP_RUNS_IN_PROGRESS', count: 1, oldest_at: T.startedB.toISOString() },
    ]);
  });

  // Break caught: the approver's staff queue counted outside the approver's hub, or shown to a session that cannot approve.
  it('are, for a Senior Ops user of the first hub, the officer’s queues and the two profiles waiting at its hub', async () => {
    const { queues } = await summaryOf(await routes.seniorOps(HUB_A));

    expect(queues.map((entry) => [entry.queue, entry.count])).toEqual([
      ['PICKUP_AWAITING_CONFIRMATION', 5],
      ['PICKUP_CUTOFF_REVIEW', 1],
      ['PICKUP_EXCEPTION_APPROVAL', 3],
      ['PICKUP_UNMANIFESTED_POOL', 4],
      ['PICKUP_RUNS_IN_PROGRESS', 2],
      ['STAFF_AWAITING_APPROVAL', 2],
    ]);
    expect(entryFor(queues, 'STAFF_AWAITING_APPROVAL')?.oldest_at).toBe(
      await staffCreatedAt(staff['a.first']),
    );
  });

  // Break caught: the all-hub grant of the staff list not reaching the profiles of every hub, and the hub grant reaching more than its hubs.
  it('are, for a seeded Platform Admin with no hub: the pickups of no hub (the key is held, so the entries are 0), and every profile waiting', async () => {
    const { queues } = await summaryOf(await routes.platformAdmin());

    expect(queues).toEqual([
      { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 0 },
      { queue: 'PICKUP_CUTOFF_REVIEW', count: 0 },
      { queue: 'PICKUP_EXCEPTION_APPROVAL', count: 0 },
      { queue: 'PICKUP_UNMANIFESTED_POOL', count: 0 },
      { queue: 'PICKUP_RUNS_IN_PROGRESS', count: 0 },
      {
        queue: 'STAFF_AWAITING_APPROVAL',
        count: 4,
        oldest_at: await staffCreatedAt(staff['a.first']),
      },
    ]);
  });

  // Break caught: the scope of the all-hub grant of a list not reaching every hub, or a moment that is not the least of them all.
  it('are, for a session that reads every hub, the sum of the hubs and the oldest of all of them', async () => {
    const bundle = await newBundle(routes.admin, [
      grant('pickup.read', 'all'),
      grant('pickup.exception.approve', 'all'),
      grant('staff.read', 'all'),
      grant('staff.identity.approve', 'all'),
    ]);
    const { queues } = await summaryOf(await routes.actor(bundle, HUB_A));

    expect(queues.map((entry) => [entry.queue, entry.count])).toEqual([
      ['PICKUP_AWAITING_CONFIRMATION', 7],
      ['PICKUP_CUTOFF_REVIEW', 2],
      ['PICKUP_EXCEPTION_APPROVAL', 4],
      ['PICKUP_UNMANIFESTED_POOL', 5],
      ['PICKUP_RUNS_IN_PROGRESS', 3],
      ['STAFF_AWAITING_APPROVAL', 4],
    ]);
    expect(entryFor(queues, 'PICKUP_CUTOFF_REVIEW')?.oldest_at).toBe(T.lateB.toISOString());
    expect(entryFor(queues, 'PICKUP_UNMANIFESTED_POOL')?.oldest_at).toBe(T.poolB.toISOString());
    expect(entryFor(queues, 'PICKUP_RUNS_IN_PROGRESS')?.oldest_at).toBe(T.startedB.toISOString());
  });
});

describe('what a session is given depends on its keys, entry by entry', () => {
  // Break caught: a queue the session may not read drawn as a zero, or a decision key that grants the list.
  it('has no entry for a queue whose list key the session lacks, and an empty list for a session that may read none', async () => {
    const none = await routes.actor(
      await newBundle(routes.admin, [grant('dispatch.read', 'own')]),
      HUB_A,
    );
    const noneAnswer = await summaryOf(none);
    expect(noneAnswer.status).toBe(200);
    expect(noneAnswer.queues).toEqual([]);

    // The decision keys alone read nothing: the list's key decides what may be read at all.
    const deciders = await routes.actor(
      await newBundle(routes.admin, [
        grant('pickup.exception.approve', 'own'),
        grant('staff.identity.approve', 'own'),
      ]),
      HUB_A,
    );
    expect((await summaryOf(deciders)).queues).toEqual([]);

    // An officer holds no staff.read, on purpose: the staff queue is absent for them, and is not a 0.
    const officer = await summaryOf(await routes.opsStaff(HUB_A));
    expect(entryFor(officer.queues, 'STAFF_AWAITING_APPROVAL')).toBeUndefined();
  });

  // Break caught: an approver's queue shown to a session that holds the list's key and not the decision key.
  it('has no entry for an approver’s queue to a session that reads the list and cannot decide', async () => {
    const readers = await routes.actor(
      await newBundle(routes.admin, [grant('pickup.read', 'own'), grant('staff.read', 'own')]),
      HUB_A,
    );
    const { queues } = await summaryOf(readers);

    expect(queues.map((entry) => entry.queue)).toEqual([
      'PICKUP_AWAITING_CONFIRMATION',
      'PICKUP_CUTOFF_REVIEW',
      'PICKUP_UNMANIFESTED_POOL',
      'PICKUP_RUNS_IN_PROGRESS',
    ]);
    // ... while the lists themselves are open to the same session: the entry is the queue's being the session's work, and not a refusal.
    expect(
      (await readers.client.get(`${API}/staff-identities?status=PENDING_APPROVAL`)).status,
    ).toBe(200);
    expect(
      (await readers.client.get(`${API}/pickup-requests?one_package_exception_state=REQUESTED`))
        .status,
    ).toBe(200);
  });

  // Break caught: a count taken in the widest grant the session holds, so that the decision key's reach widens a list's count.
  it('counts each queue in the scope of its list’s grant, whatever the decision key reaches', async () => {
    const bundle = await newBundle(routes.admin, [
      grant('pickup.read', 'own'),
      grant('pickup.exception.approve', 'all'),
      grant('staff.read', 'own'),
      grant('staff.identity.approve', 'all'),
    ]);
    const { queues } = await summaryOf(await routes.actor(bundle, HUB_A));

    // The exceptions of the first hub only (3), not the four of both; the profiles of the first hub only (2), not the four.
    expect(entryFor(queues, 'PICKUP_EXCEPTION_APPROVAL')?.count).toBe(3);
    expect(entryFor(queues, 'STAFF_AWAITING_APPROVAL')?.count).toBe(2);
  });

  // Break caught: a session with no hub counted as though it reached them all (an empty set is no hub, never every hub).
  it('counts nothing for a grant of the hubs of a session that has none, and not everything', async () => {
    const bundle = await newBundle(routes.admin, [
      grant('pickup.read', 'own'),
      grant('pickup.exception.approve', 'own'),
    ]);
    const { queues } = await summaryOf(await routes.actor(bundle, null));

    expect(queues.map((entry) => entry.count)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('the shape of the answer', () => {
  // Break caught: a moment on an empty queue, or any property beyond the queue, the count and the moment.
  it('is the queue, the count and, when the count is not 0, the moment, and nothing else', async () => {
    const empty = await summaryOf(await routes.platformAdmin());
    for (const entry of empty.queues.filter((each) => each.count === 0)) {
      expect(Object.keys(entry)).toEqual(['queue', 'count']);
    }
    const officer = await summaryOf(await routes.opsStaff(HUB_A));
    for (const entry of officer.queues) {
      expect(Object.keys(entry)).toEqual(['queue', 'count', 'oldest_at']);
      expect(entry.oldest_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    expect(Object.keys(officer.response.json() as object)).toEqual(['queues']);
  });

  // Break caught: a count or an age that is cached by a browser or a proxy, so that a queue shows what it held a while ago.
  it('is never to be stored', async () => {
    const { response } = await summaryOf(await routes.opsStaff(HUB_A));
    expect(response.header('cache-control')).toBe('no-store');
  });

  // Break caught: a count that is stored, or computed once: the next read must see a change made after the last.
  it('is the queue as it is now: a request that arrives is counted by the next read, and its age does not move', async () => {
    const officer = await routes.opsStaff(HUB_A);
    const before = entryFor((await summaryOf(officer)).queues, 'PICKUP_AWAITING_CONFIRMATION');
    await make('a.late-arrival', HUB_A);
    const after = entryFor((await summaryOf(officer)).queues, 'PICKUP_AWAITING_CONFIRMATION');

    expect(after?.count).toBe((before?.count ?? 0) + 1);
    expect(after?.oldest_at).toBe(before?.oldest_at);
    // ... and the next list shows the same, which is the point.
    expect((await fromTheList(officer, 'PICKUP_AWAITING_CONFIRMATION')).entry.count).toBe(
      after?.count,
    );
  });

  // Break caught: the read writing an audit event for the records it counted (it returns none, and a count is not a page of records).
  it('writes no audit event, even for a session that reads other hubs', async () => {
    const admin = await routes.actor(BUNDLE_IDS.platformAdmin, HUB_A);
    const [before] = await routes.rows<{ events: string }>(
      `select count(*) as events from audit_event`,
    );
    await summaryOf(admin);
    const [after] = await routes.rows<{ events: string }>(
      `select count(*) as events from audit_event`,
    );

    expect(after?.events).toBe(before?.events);
  });
});

/** The moment a request was created, as the table has it, to the millisecond. */
async function createdAtOf(id: string | undefined): Promise<string> {
  const [row] = await routes.rows<{ created_at: Date }>(
    `select created_at from pickup_request where id = $1`,
    [id],
  );
  if (row === undefined) throw new Error('no such request was arranged');
  return row.created_at.toISOString();
}

async function exceptionRequestedAt(requestId: string | undefined): Promise<string> {
  const [row] = await routes.rows<{ requested_at: Date }>(
    `select min(requested_at) filter (where state = 'REQUESTED') as requested_at from one_package_exception where pickup_request_id = $1`,
    [requestId],
  );
  if (row === undefined) throw new Error('no such exception was arranged');
  return row.requested_at.toISOString();
}

async function staffCreatedAt(id: string | undefined): Promise<string> {
  const [row] = await routes.rows<{ created_at: Date }>(
    `select created_at from staff_identity where id = $1`,
    [id],
  );
  if (row === undefined) throw new Error('no such profile was arranged');
  return row.created_at.toISOString();
}
