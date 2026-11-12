import { describe, expect, it } from 'vitest';

import type { BundleGrantSnapshot, StoredSession } from '../auth/ports/session-store.port.js';
import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import type { UnitOfWorkOptions } from '../auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../authorization/authorized-request.js';
import type { OperationWork } from '../authorization/operation-runner.js';
import {
  ANY_HUB,
  QUEUE_IDS,
  type QueueCount,
  type QueueCounter,
  type QueueFilter,
  type QueueId,
} from '../domain-ports/queue-counter.port.js';
import { ApiException } from '../http/api-exception.js';
import {
  QUEUE_SUMMARY_STATEMENT_TIMEOUT_MS,
  QueueSummaryService,
} from './queue-summary.service.js';

/**
 * `getQueueSummary` on fakes (task C1): which queues a session is given, in which context each is counted, how the answer is shaped and
 * ordered, and what a failure does. The counts against the lists they must equal, with the real database and the real policies, are
 * `queue-summary.db.test.ts`.
 */
/** A limit that sets nothing, for the tests that are not about it (the bound on a count is tested below). */
const noLimit = (): Promise<void> => Promise.resolve();

const HUB = '11111111-1111-4111-8111-111111111111';
const OTHER_HUB = '22222222-2222-4222-8222-222222222222';

const held = (permission: string, hubScope: BundleGrantSnapshot['hubScope'] = 'own') =>
  ({ permission, hubScope, ownershipScope: 'any', tier: 'A' }) satisfies BundleGrantSnapshot;

/** The request a staff session of the Ops Portal makes, holding the grants given and reaching the hubs given. */
function request(
  grants: readonly BundleGrantSnapshot[],
  hubs: readonly string[] = [HUB],
): AuthorizedRequest {
  return {
    session: {
      id: '33333333-3333-4333-8333-333333333333',
      principalType: 'STAFF',
      principalId: '44444444-4444-4444-8444-444444444444',
      authority: { snapshot: { grants }, authorizedHubIds: hubs },
    } as unknown as StoredSession,
    credential: 'COOKIE',
    idleMinutes: 30,
    judgedAt: new Date('2026-11-05T09:00:00.000Z'),
    permission: undefined,
    grant: undefined,
    scope: { hubScopeMode: 'SET', authorizedHubIds: [] },
    activity: 'background',
    stateChanging: false,
  };
}

interface Reading {
  readonly authorized: AuthorizedRequest;
  readonly options: UnitOfWorkOptions | undefined;
  readonly handle: TransactionHandle;
}

/** A runner that opens nothing: it runs the work with a handle of its own and records the decision and the options it was given. */
function runner() {
  const readings: Reading[] = [];
  return {
    readings,
    read: <T>(
      authorized: AuthorizedRequest,
      _correlationId: string,
      work: OperationWork<T>,
      options?: UnitOfWorkOptions,
    ): Promise<T> => {
      const handle = { reading: readings.length } as unknown as TransactionHandle;
      readings.push({ authorized, options, handle });
      return work(handle, authorized);
    },
  };
}

interface Call {
  readonly queue: QueueId;
  readonly handle: TransactionHandle;
  /** The filter the counter was asked with (task C3); `undefined` is a count asked without one, which the port does not allow. */
  readonly filter: QueueFilter | undefined;
}

function counters(
  specs: readonly {
    readonly queue: QueueId;
    readonly listKey: string;
    readonly decisionKey?: string;
    readonly result?: QueueCount;
  }[],
) {
  const calls: Call[] = [];
  const made: QueueCounter[] = specs.map((spec) => ({
    queue: spec.queue,
    listKey: spec.listKey,
    ...(spec.decisionKey === undefined ? {} : { decisionKey: spec.decisionKey }),
    count: (handle, filter) => {
      calls.push({ queue: spec.queue, handle, filter });
      return Promise.resolve(spec.result ?? { count: 0, oldestAt: null });
    },
  }));
  return { calls, made };
}

const queueIdsOf = (answer: { readonly queues: readonly { readonly queue: string }[] }) =>
  answer.queues.map((entry) => entry.queue);

const EVERY_QUEUE = [
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
] as const;

describe('the queues a session is given', () => {
  // Break caught: an entry for a queue the session may not read, or a queue the session may read left out.
  it('has an entry for each queue whose list key the session holds, and for no other', async () => {
    const { made } = counters(EVERY_QUEUE);
    const service = new QueueSummaryService({
      limitStatements: noLimit,
      runner: runner(),
      counters: made,
    });

    const officer = await service.read(
      request([held('pickup.read'), held('pickup.exception.approve')]),
      'c1',
    );
    expect(queueIdsOf(officer)).toEqual([
      'PICKUP_AWAITING_CONFIRMATION',
      'PICKUP_CUTOFF_REVIEW',
      'PICKUP_EXCEPTION_APPROVAL',
      'PICKUP_UNMANIFESTED_POOL',
      'PICKUP_RUNS_IN_PROGRESS',
    ]);

    const everything = await service.read(
      request([
        held('pickup.read'),
        held('pickup.exception.approve'),
        held('staff.read'),
        held('staff.identity.approve'),
      ]),
      'c1',
    );
    expect(queueIdsOf(everything)).toEqual([...QUEUE_IDS]);
  });

  // Break caught: an approver's queue shown to a session that holds only the list's key, or only the decision key; or its absence drawn as 0.
  it('shows an approver’s queue only to a session that holds the list’s key and the decision key', async () => {
    const { made } = counters(EVERY_QUEUE);
    const service = new QueueSummaryService({
      limitStatements: noLimit,
      runner: runner(),
      counters: made,
    });

    const listOnly = await service.read(request([held('pickup.read'), held('staff.read')]), 'c1');
    expect(queueIdsOf(listOnly)).toEqual([
      'PICKUP_AWAITING_CONFIRMATION',
      'PICKUP_CUTOFF_REVIEW',
      'PICKUP_UNMANIFESTED_POOL',
      'PICKUP_RUNS_IN_PROGRESS',
    ]);

    // The decision key alone admits nothing: the list's key decides what may be read at all.
    const decisionOnly = await service.read(
      request([held('pickup.exception.approve'), held('staff.identity.approve')]),
      'c1',
    );
    expect(decisionOnly).toEqual({ queues: [] });
  });

  // Break caught: a session with no key answered with zeros (which say "read, and nothing waits"), or a transaction opened for nothing.
  it('answers a session that may read none with no entries, and opens no transaction', async () => {
    const reader = runner();
    const { made, calls } = counters(EVERY_QUEUE);
    const service = new QueueSummaryService({
      limitStatements: noLimit,
      runner: reader,
      counters: made,
    });

    expect(await service.read(request([held('dispatch.read')]), 'c1')).toEqual({ queues: [] });
    expect(await service.read(request([]), 'c1')).toEqual({ queues: [] });
    expect(reader.readings).toEqual([]);
    expect(calls).toEqual([]);
  });

  // Break caught: the order of the answer following the order the counters were composed in, so that it moves when a module is reordered.
  it('answers in the order of the contract’s queue identifiers, whatever the order of the counters', async () => {
    const { made } = counters([...EVERY_QUEUE].reverse());
    const service = new QueueSummaryService({
      limitStatements: noLimit,
      runner: runner(),
      counters: made,
    });

    const answer = await service.read(
      request([
        held('pickup.read'),
        held('pickup.exception.approve'),
        held('staff.read'),
        held('staff.identity.approve'),
      ]),
      'c1',
    );
    expect(queueIdsOf(answer)).toEqual([...QUEUE_IDS]);
  });

  // Break caught: two counters for one queue, one of which would be dropped without a word.
  it('refuses a composition with two counters for one queue', () => {
    const { made } = counters([EVERY_QUEUE[0], EVERY_QUEUE[0]]);
    expect(
      () => new QueueSummaryService({ limitStatements: noLimit, runner: runner(), counters: made }),
    ).toThrow('PICKUP_AWAITING_CONFIRMATION');
  });
});

describe('the context each count is taken in', () => {
  // Break caught: a count taken in the widest grant the session holds, so that it reaches records the queue's own list would not.
  it('counts each key in the scope of its own grant and never a wider one', async () => {
    const reader = runner();
    const { made } = counters(EVERY_QUEUE);
    const service = new QueueSummaryService({
      limitStatements: noLimit,
      runner: reader,
      counters: made,
    });

    // Pickup at its own hubs; the decision key of the exceptions at all hubs; the staff list at all hubs, its decision key at its own.
    await service.read(
      request(
        [
          held('pickup.read', 'own'),
          held('pickup.exception.approve', 'all'),
          held('staff.read', 'all'),
          held('staff.identity.approve', 'own'),
        ],
        [HUB, OTHER_HUB],
      ),
      'c1',
    );

    expect(reader.readings.map((reading) => reading.authorized.permission)).toEqual([
      'pickup.read',
      'staff.read',
    ]);
    const [pickup, staff] = reader.readings;
    expect(pickup?.authorized.scope).toEqual({
      hubScopeMode: 'SET',
      authorizedHubIds: [HUB, OTHER_HUB],
    });
    expect(pickup?.authorized.grant).toMatchObject({ permission: 'pickup.read', hubScope: 'own' });
    expect(staff?.authorized.scope).toEqual({ hubScopeMode: 'ALL', authorizedHubIds: [] });
    expect(staff?.authorized.grant).toMatchObject({ permission: 'staff.read', hubScope: 'all' });
  });

  // Break caught: a session that holds the key with no hub scope, or with no hub at all, counted as though it reached every hub.
  it('gives a grant of no hub scope, and a session with no hub, the empty set and never all of them', async () => {
    const reader = runner();
    const { made } = counters(EVERY_QUEUE);
    const service = new QueueSummaryService({
      limitStatements: noLimit,
      runner: reader,
      counters: made,
    });

    await service.read(request([held('pickup.read', 'own')], []), 'c1');
    await service.read(request([held('pickup.read', 'none')], [HUB]), 'c1');

    expect(reader.readings.map((reading) => reading.authorized.scope)).toEqual([
      { hubScopeMode: 'SET', authorizedHubIds: [] },
      { hubScopeMode: 'SET', authorizedHubIds: [] },
    ]);
  });

  // Break caught: the counts of one key taken in separate snapshots, so that two of them can disagree; or one transaction for each count.
  it('counts the queues of one key in one repeatable-read transaction, and one transaction for each key', async () => {
    const reader = runner();
    const { made, calls } = counters(EVERY_QUEUE);
    const service = new QueueSummaryService({
      limitStatements: noLimit,
      runner: reader,
      counters: made,
    });

    await service.read(
      request([
        held('pickup.read'),
        held('pickup.exception.approve'),
        held('staff.read'),
        held('staff.identity.approve'),
      ]),
      'c1',
    );

    expect(reader.readings).toHaveLength(2);
    expect(reader.readings.map((reading) => reading.options)).toEqual([
      { isolation: 'REPEATABLE READ' },
      { isolation: 'REPEATABLE READ' },
    ]);
    const [pickup, staff] = reader.readings;
    expect(calls.map((call) => [call.queue, call.handle])).toEqual([
      ['PICKUP_AWAITING_CONFIRMATION', pickup?.handle],
      ['PICKUP_CUTOFF_REVIEW', pickup?.handle],
      ['PICKUP_EXCEPTION_APPROVAL', pickup?.handle],
      ['PICKUP_UNMANIFESTED_POOL', pickup?.handle],
      ['PICKUP_RUNS_IN_PROGRESS', pickup?.handle],
      ['STAFF_AWAITING_APPROVAL', staff?.handle],
    ]);
  });

  // Break caught: the state-changing refusal of the runner bypassed by building the decision of a read from one that changes state.
  it('reads through the runner’s read path, for a request that changes nothing', async () => {
    const reader = runner();
    const { made } = counters(EVERY_QUEUE);
    const service = new QueueSummaryService({
      limitStatements: noLimit,
      runner: reader,
      counters: made,
    });

    await service.read(request([held('pickup.read')]), 'c1');

    expect(reader.readings.every((reading) => !reading.authorized.stateChanging)).toBe(true);
  });
});

describe('the shape of an entry', () => {
  // Break caught: an age on an empty queue, an age missing on a queue that has records, a count that is not the counter's, an extra property.
  it('is the queue, the count and, when the count is not 0, the moment of the oldest, and nothing else', async () => {
    const { made } = counters([
      {
        queue: 'PICKUP_AWAITING_CONFIRMATION',
        listKey: 'pickup.read',
        result: { count: 3, oldestAt: new Date('2026-11-02T09:15:30.123Z') },
      },
      {
        queue: 'PICKUP_CUTOFF_REVIEW',
        listKey: 'pickup.read',
        result: { count: 0, oldestAt: null },
      },
    ]);
    const service = new QueueSummaryService({
      limitStatements: noLimit,
      runner: runner(),
      counters: made,
    });

    const answer = await service.read(request([held('pickup.read')]), 'c1');

    expect(answer).toEqual({
      queues: [
        {
          queue: 'PICKUP_AWAITING_CONFIRMATION',
          count: 3,
          oldest_at: '2026-11-02T09:15:30.123Z',
        },
        { queue: 'PICKUP_CUTOFF_REVIEW', count: 0 },
      ],
    });
    expect(Object.keys(answer.queues[1] ?? {})).toEqual(['queue', 'count']);
    expect(Object.keys(answer)).toEqual(['queues']);
  });
});

describe('a counter that cannot answer', () => {
  // Break caught: the counts that were read returned without the one that failed, which would say "not yours" about a queue that is.
  it('fails the read and returns no partial answer', async () => {
    const { made } = counters(EVERY_QUEUE);
    // The second queue's counter fails; the others answer.
    const service = new QueueSummaryService({
      limitStatements: noLimit,
      runner: runner(),
      counters: made.map((counter) =>
        counter.queue === 'PICKUP_CUTOFF_REVIEW'
          ? { ...counter, count: () => Promise.reject(new Error('the count failed')) }
          : counter,
      ),
    });

    await expect(service.read(request([held('pickup.read')]), 'c1')).rejects.toThrow(
      'the count failed',
    );
  });
});

describe('the bound on a count (AC-QSUM-13; the decision of 6 November 2026)', () => {
  // Break caught: a count with no statement timeout of its own (a scan that runs as long as the pool allows), a limit set after the counts it
  // is meant to bound, one set on another transaction than the counts run in, or one that is not three seconds.
  it('limits the statements of each transaction to three seconds, before any count of it, on the handle the counts use', async () => {
    const { made, calls } = counters(EVERY_QUEUE);
    const limits: { handle: TransactionHandle; milliseconds: number; countsBefore: number }[] = [];
    const service = new QueueSummaryService({
      runner: runner(),
      counters: made,
      limitStatements: (handle, milliseconds) => {
        limits.push({ handle, milliseconds, countsBefore: calls.length });
        return Promise.resolve();
      },
    });

    await service.read(
      request([
        held('pickup.read'),
        held('pickup.exception.approve'),
        held('staff.read'),
        held('staff.identity.approve'),
      ]),
      'c1',
    );

    // One transaction for each key (pickup.read for five queues, staff.read for one), each bounded at three seconds before its first count.
    expect(limits.map((limit) => limit.milliseconds)).toEqual([3000, 3000]);
    expect(limits.map((limit) => limit.countsBefore)).toEqual([0, 5]);
    const handleOf = (queue: QueueId) => calls.find((call) => call.queue === queue)?.handle;
    expect(limits[0]?.handle).toBe(handleOf('PICKUP_AWAITING_CONFIRMATION'));
    expect(limits[1]?.handle).toBe(handleOf('STAFF_AWAITING_APPROVAL'));
    expect(QUEUE_SUMMARY_STATEMENT_TIMEOUT_MS).toBe(3000);
  });

  // Break caught: a read that goes on without its bound because setting it failed (the count would then run unbounded).
  it('fails the read, and counts nothing, when the limit cannot be set', async () => {
    const { made, calls } = counters(EVERY_QUEUE);
    const service = new QueueSummaryService({
      runner: runner(),
      counters: made,
      limitStatements: () => Promise.reject(new Error('the limit was not set')),
    });

    await expect(service.read(request([held('pickup.read')]), 'c1')).rejects.toThrow(
      'the limit was not set',
    );
    expect(calls).toEqual([]);
  });

  // Break caught: a transaction opened (and bounded) for a session that reads no queue.
  it('sets no limit for a session that reads no queue', async () => {
    const { made } = counters(EVERY_QUEUE);
    let limited = 0;
    const service = new QueueSummaryService({
      runner: runner(),
      counters: made,
      limitStatements: () => {
        limited += 1;
        return Promise.resolve();
      },
    });

    expect((await service.read(request([held('notification.read')]), 'c1')).queues).toEqual([]);
    expect(limited).toBe(0);
  });
});

/**
 * The optional hub (`hub_id`) of the summary (task C3; `AC-HUBF-04`, `-07`, `-10`, `-11`; features/operations/hub-filters.md): **a filter that
 * narrows and never widens**. What this proves, on fakes, is what the database tests cannot see from the outside: the filter reaches every
 * counter of every key group (a count with a hub is the number of its list's records with that hub only if each counter is asked for it), it is
 * never part of the context a count is taken in (a scope comes from the grant alone), a value that is not an identifier is refused before a
 * transaction opens, the bound of three seconds holds with it, and a read with no filter is the read of before. The counts against the lists they
 * must equal, in the real database and under the real policies, are `queue-summary.db.test.ts` and `hub-filters.db.test.ts`.
 */
describe('the hub filter (task C3)', () => {
  /** A hub that is none of the session's own, so that wherever it turns up (a scope, a request, an answer) it was put there by the filter. */
  const FILTER_HUB = '55555555-5555-4555-8555-555555555555';
  /** An identifier with letters in it, so that its capitals are another text and the same hub. */
  const LETTERED_HUB = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

  /** Every key the summary reads: pickup.read for five queues and staff.read for one, so that there are two groups of counters and two transactions. */
  const EVERY_KEY = [
    held('pickup.read'),
    held('pickup.exception.approve'),
    held('staff.read'),
    held('staff.identity.approve'),
  ];

  /**
   * The same four keys, each held at every hub. A hub that no set of hubs holds is then no reason to answer without counting (task A1), so these are
   * the sessions of the tests that follow the filter into the counters; a session that holds its keys at its own hubs is the subject of the tests of
   * the shortcut, below.
   */
  const EVERYWHERE = [
    held('pickup.read', 'all'),
    held('pickup.exception.approve', 'all'),
    held('staff.read', 'all'),
    held('staff.identity.approve', 'all'),
  ];

  // Break caught: the filter handed to the counters of the first key group alone (the staff queue is counted in a transaction of its own), to the
  // first counter of a group, or to none of them: a count that ignores its hub says the work of every hub the grant reaches.
  it('gives the filter to every counter of every key group, and asks no count without it', async () => {
    const { made, calls } = counters(EVERY_QUEUE);
    const service = new QueueSummaryService({
      limitStatements: noLimit,
      runner: runner(),
      counters: made,
    });

    await service.read(request(EVERYWHERE), 'c3', { hubId: FILTER_HUB });

    // The arrangement is what the test says: the six queues, each counted once, in two transactions (a group for each key).
    expect(calls.map((call) => call.queue)).toEqual([...QUEUE_IDS]);
    expect(new Set(calls.map((call) => call.handle)).size).toBe(2);
    expect(calls.map((call) => call.filter)).toEqual(QUEUE_IDS.map(() => ({ hubId: FILTER_HUB })));
  });

  /** One answer with something in each entry but one, so that a read that changes the shape, the order or a figure is seen. */
  const SPECS = [
    { ...EVERY_QUEUE[0], result: { count: 3, oldestAt: new Date('2026-11-02T09:15:30.123Z') } },
    { ...EVERY_QUEUE[1], result: { count: 0, oldestAt: null } },
    { ...EVERY_QUEUE[2], result: { count: 2, oldestAt: new Date('2026-11-03T08:00:00.000Z') } },
    { ...EVERY_QUEUE[3], result: { count: 7, oldestAt: new Date('2026-10-30T12:30:00.000Z') } },
    { ...EVERY_QUEUE[4], result: { count: 1, oldestAt: new Date('2026-11-05T07:45:00.000Z') } },
    { ...EVERY_QUEUE[5], result: { count: 4, oldestAt: new Date('2026-11-01T10:10:10.010Z') } },
  ];
  /** What the counters above answer, as the read answers it: written out, in the order of the contract's queues, the 0 with no moment. */
  const THE_ANSWER = {
    queues: [
      { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 3, oldest_at: '2026-11-02T09:15:30.123Z' },
      { queue: 'PICKUP_CUTOFF_REVIEW', count: 0 },
      { queue: 'PICKUP_EXCEPTION_APPROVAL', count: 2, oldest_at: '2026-11-03T08:00:00.000Z' },
      { queue: 'PICKUP_UNMANIFESTED_POOL', count: 7, oldest_at: '2026-10-30T12:30:00.000Z' },
      { queue: 'PICKUP_RUNS_IN_PROGRESS', count: 1, oldest_at: '2026-11-05T07:45:00.000Z' },
      { queue: 'STAFF_AWAITING_APPROVAL', count: 4, oldest_at: '2026-11-01T10:10:10.010Z' },
    ],
  };

  // Break caught (AC-HUBF-11): a read with no filter that is not the read of before: a counter asked for a hub nobody named, or for no filter at
  // all (so that it fails on `filter.hubId`), or an answer that changes its figures, its shape or its order for want of one.
  it.each([
    ['no filter at all', undefined],
    ['the filter that names no hub', ANY_HUB],
    ['a filter written as no hub', { hubId: null }],
  ] as const)(
    'asks every counter for no hub, and answers as it always did, given %s',
    async (_how, filter) => {
      const { made, calls } = counters(SPECS);
      const service = new QueueSummaryService({
        limitStatements: noLimit,
        runner: runner(),
        counters: made,
      });

      const answer = await service.read(request(EVERY_KEY), 'c3', filter);

      expect(answer).toEqual(THE_ANSWER);
      expect(calls.map((call) => call.queue)).toEqual([...QUEUE_IDS]);
      expect(calls.map((call) => call.filter)).toEqual(QUEUE_IDS.map(() => ({ hubId: null })));
    },
  );

  // Break caught: a shared default that a caller can put a hub on, after which every read made with no filter is filtered by it.
  it('has a default filter that names no hub and cannot be given one', () => {
    expect(ANY_HUB).toEqual({ hubId: null });
    expect(Object.isFrozen(ANY_HUB)).toBe(true);
  });

  // Break caught: the hub put into the context a count is taken in (a scope built from what the request says and not from the grant, which widens
  // it, or narrows it to the hub), or left as a trace in what the runner is given: the hub is a parameter of the statement and never of the
  // transaction (AC-HUBF-10, GBT-GS1, GBT-GS14). The hub here is one the key that reaches it holds, so that it is counted: pickup at two hubs
  // (the hub named is the second), the staff list at all of them.
  it('gives the runner exactly what it is given without a hub, for a hub a grant of its key holds', async () => {
    // Pickup at its own hubs (two); the decision key of the exceptions at all hubs; the staff list at all hubs, its decision key at its own.
    const grants = [
      held('pickup.read', 'own'),
      held('pickup.exception.approve', 'all'),
      held('staff.read', 'all'),
      held('staff.identity.approve', 'own'),
    ];
    const without = runner();
    const withHub = runner();
    for (const [reader, filter] of [
      [without, undefined],
      [withHub, { hubId: OTHER_HUB }],
    ] as const) {
      const { made } = counters(EVERY_QUEUE);
      const service = new QueueSummaryService({
        limitStatements: noLimit,
        runner: reader,
        counters: made,
      });
      await service.read(request(grants, [HUB, OTHER_HUB]), 'c3', filter);
    }

    expect(withHub.readings.map((reading) => reading.authorized.permission)).toEqual([
      'pickup.read',
      'staff.read',
    ]);
    expect(withHub.readings.map((reading) => reading.authorized)).toEqual(
      without.readings.map((reading) => reading.authorized),
    );
    expect(withHub.readings.map((reading) => reading.options)).toEqual(
      without.readings.map((reading) => reading.options),
    );
    // ... which is the grant of each list's key as the session holds it, written out: neither widened to every hub, nor narrowed to the one named.
    expect(withHub.readings.map((reading) => reading.authorized.scope)).toEqual([
      { hubScopeMode: 'SET', authorizedHubIds: [HUB, OTHER_HUB] },
      { hubScopeMode: 'ALL', authorizedHubIds: [] },
    ]);
  });

  // Break caught (AC-HUBF-10, GBT-GS1, task A1): the shortcut judged on the session's widest grant, or on another key's: the hub is outside the grant of
  // the pickup key (so those five queues are not counted) and inside the grant of the staff key (so that one is), and what is counted is counted in
  // that key's own context, the one it has without a hub. The hub is in what the runner is given for the staff key because that grant is of every
  // hub, and for no other reason.
  it('decides the shortcut key by key: the pickup key does not reach the hub and is not counted, the staff key does and is', async () => {
    const grants = [
      held('pickup.read', 'own'),
      held('pickup.exception.approve', 'all'),
      held('staff.read', 'all'),
      held('staff.identity.approve', 'own'),
    ];
    const without = runner();
    const withHub = runner();
    const { made, calls } = counters(EVERY_QUEUE);
    await new QueueSummaryService({
      limitStatements: noLimit,
      runner: without,
      counters: counters(EVERY_QUEUE).made,
    }).read(request(grants, [HUB]), 'c3');
    const answer = await new QueueSummaryService({
      limitStatements: noLimit,
      runner: withHub,
      counters: made,
    }).read(request(grants, [HUB]), 'c3', { hubId: FILTER_HUB });

    // Only the staff key's transaction was opened, exactly as it is opened without a hub, and only its queue was counted, with the filter.
    expect(withHub.readings.map((reading) => reading.authorized.permission)).toEqual([
      'staff.read',
    ]);
    expect(withHub.readings[0]?.authorized).toEqual(without.readings[1]?.authorized);
    expect(withHub.readings[0]?.options).toEqual({ isolation: 'REPEATABLE READ' });
    expect(calls.map((call) => [call.queue, call.filter])).toEqual([
      ['STAFF_AWAITING_APPROVAL', { hubId: FILTER_HUB }],
    ]);
    // The entries are the ones that would have been counted: every queue the session may read, at 0 and with no moment.
    expect(answer.queues).toEqual(QUEUE_IDS.map((queue) => ({ queue, count: 0 })));
  });

  // Break caught (AC-HUBF-05, GBT-GS14, task A1): a hub outside a staff session's hubs that is still counted, so that the database walks the hub's index
  // for each of the five pickup queues (the manifest pool took 0.8 seconds at 200,000 requests) and the time tells a caller whether the hub exists and
  // how much it holds; or a count that is skipped but answered with fewer entries (an absent entry says "not yours", and a 0 says "read, and nothing
  // waits"); or a refusal (`HUB_SCOPE_VIOLATION`, `NOT_FOUND`): lists never probe (SECURITY_DESIGN 14.4b). A hub outside the grant, the same in
  // capitals and the identifier of no hub are one case, answered at once: no transaction is opened, none is bounded and no counter is asked.
  it.each([
    ['a hub outside the session’s hubs', OTHER_HUB],
    ['a hub outside the session’s hubs, in capitals', OTHER_HUB.toUpperCase()],
    ['the identifier of no hub', FILTER_HUB],
  ])(
    'answers %s with every entry the session may read at 0, asking no count and opening no transaction',
    async (_which, hubId) => {
      const reader = runner();
      const { made, calls } = counters(EVERY_QUEUE);
      let limited = 0;
      const service = new QueueSummaryService({
        runner: reader,
        counters: made,
        limitStatements: () => {
          limited += 1;
          return Promise.resolve();
        },
      });

      // The session reaches the first hub alone with every key it holds.
      const answer = await service.read(request(EVERY_KEY, [HUB]), 'c3', { hubId });

      expect(answer.queues).toEqual(QUEUE_IDS.map((queue) => ({ queue, count: 0 })));
      expect(reader.readings, 'no transaction was opened').toEqual([]);
      expect(calls, 'no count was asked').toEqual([]);
      expect(limited, 'no limit was set').toBe(0);
    },
  );

  // Break caught: the shortcut taken where the grant holds the hub (the own hub of an officer answered 0 for every queue), or where a grant is of every
  // hub (a Platform Admin answered 0 for a hub it may read), or an empty set read as every hub: those three are counted, or answered, as they were.
  it('still counts a hub the grant holds, and a hub under a grant of every hub, and answers 0 for an empty set without counting', async () => {
    const own = counters(EVERY_QUEUE);
    const ownReader = runner();
    await new QueueSummaryService({
      limitStatements: noLimit,
      runner: ownReader,
      counters: own.made,
    }).read(request(EVERY_KEY, [HUB]), 'c3', { hubId: HUB.toUpperCase() });
    expect(own.calls.map((call) => call.queue)).toEqual([...QUEUE_IDS]);
    expect(ownReader.readings).toHaveLength(2);

    const everywhere = counters(EVERY_QUEUE);
    const everywhereReader = runner();
    await new QueueSummaryService({
      limitStatements: noLimit,
      runner: everywhereReader,
      counters: everywhere.made,
    }).read(request(EVERYWHERE, []), 'c3', { hubId: FILTER_HUB });
    expect(everywhere.calls.map((call) => call.queue)).toEqual([...QUEUE_IDS]);
    expect(everywhereReader.readings).toHaveLength(2);

    // A session with no hub at all (an empty set reaches nothing): every queue it may read is 0 and nothing is counted.
    const none = counters(EVERY_QUEUE);
    const noneReader = runner();
    const answer = await new QueueSummaryService({
      limitStatements: noLimit,
      runner: noneReader,
      counters: none.made,
    }).read(request(EVERY_KEY, []), 'c3', { hubId: HUB });
    expect(answer.queues).toEqual(QUEUE_IDS.map((queue) => ({ queue, count: 0 })));
    expect(noneReader.readings).toEqual([]);
    expect(none.calls).toEqual([]);
  });

  const NOT_A_HUB = [
    ['text that is not an identifier', 'not-a-uuid'],
    ['an empty value', ''],
    ['a value of spaces alone', '   '],
    ['an identifier with a space before it', ` ${HUB}`],
    ['an identifier with a space after it', `${HUB} `],
    ['an identifier with a line break after it', `${HUB}\n`],
    ['an identifier written as a urn', `urn:uuid:${HUB}`],
    ['an identifier in braces', `{${HUB}}`],
    ['an identifier without its hyphens', HUB.replaceAll('-', '')],
    ['an identifier with a letter that is not a digit of base sixteen', `g${HUB.slice(1)}`],
  ] as const;

  // Break caught: a hub taken on trust and handed to the statements (where `::uuid` fails as a defect, after a transaction was opened and a limit
  // set), validation that comes after the first transaction opens, a check on truthiness (an empty value read as "no filter"), or an invalid hub
  // turned into the whole of every hub's work. The refusal names the parameter, as it does on the other lists (AC-HUBF-07).
  it.each(NOT_A_HUB)('refuses %s as a hub, before any transaction opens', async (_what, hubId) => {
    const reader = runner();
    const { made, calls } = counters(EVERY_QUEUE);
    let limited = 0;
    const service = new QueueSummaryService({
      runner: reader,
      counters: made,
      limitStatements: () => {
        limited += 1;
        return Promise.resolve();
      },
    });

    const error = await service.read(request(EVERY_KEY), 'c3', { hubId }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ApiException);
    const refused = error as ApiException;
    expect(refused.code).toBe('VALIDATION_FAILED');
    expect(refused.getStatus()).toBe(400);
    expect(refused.details).toEqual({
      violations: [{ in: 'query', pointer: '/hub_id', rule: 'format' }],
    });
    // Nothing was opened, bounded or counted for it: the session holds every key, so each would have been.
    expect(reader.readings).toEqual([]);
    expect(limited).toBe(0);
    expect(calls).toEqual([]);
  });

  // Break caught: the value judged only inside the loop over the keys the session holds, so that a session with none of them is answered `200`
  // with no queues for a value the route refuses to every other session (the check is the first act of the read, not a side effect of opening one).
  it('refuses a hub that is not one from a session that reads no queue as it does from any other', async () => {
    const reader = runner();
    const { made, calls } = counters(EVERY_QUEUE);
    const service = new QueueSummaryService({
      limitStatements: noLimit,
      runner: reader,
      counters: made,
    });

    for (const hubId of ['not-a-uuid', '']) {
      const error = await service.read(request([held('dispatch.read')]), 'c3', { hubId }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error, JSON.stringify(hubId)).toBeInstanceOf(ApiException);
      expect((error as ApiException).code).toBe('VALIDATION_FAILED');
      expect((error as ApiException).details).toEqual({
        violations: [{ in: 'query', pointer: '/hub_id', rule: 'format' }],
      });
    }
    expect(reader.readings).toEqual([]);
    expect(calls).toEqual([]);
  });

  // Break caught: an identifier in capitals refused as though it were not one (a pattern that knows lower case alone), or one that is not given on
  // to the counters: a UUID is the same hub in either, and the statement's own `::uuid` reads both.
  it.each([
    ['in lower case', LETTERED_HUB],
    ['in capitals', LETTERED_HUB.toUpperCase()],
  ])('goes on to count, for every counter, with a hub written %s', async (_how, hubId) => {
    expect(hubId.toLowerCase()).toBe(LETTERED_HUB);
    const { made, calls } = counters(EVERY_QUEUE);
    const service = new QueueSummaryService({
      limitStatements: noLimit,
      runner: runner(),
      counters: made,
    });

    await service.read(request(EVERYWHERE), 'c3', { hubId });

    expect(calls.map((call) => call.queue)).toEqual([...QUEUE_IDS]);
    expect(calls.map((call) => call.filter?.hubId?.toLowerCase())).toEqual(
      QUEUE_IDS.map(() => LETTERED_HUB),
    );
  });

  // Break caught: the bound of three seconds lost when a hub is named (a read with a filter that sets no limit, sets it after the counts, or sets it
  // once for the two transactions): the hub is what makes a count cheap at scale, and the bound is what keeps a count that is not cheap from
  // holding a connection (AC-QSUM-13).
  it('limits the statements of each transaction to three seconds, before any count of it, when a hub is given', async () => {
    const { made, calls } = counters(EVERY_QUEUE);
    const limits: { handle: TransactionHandle; milliseconds: number; countsBefore: number }[] = [];
    const service = new QueueSummaryService({
      runner: runner(),
      counters: made,
      limitStatements: (handle, milliseconds) => {
        limits.push({ handle, milliseconds, countsBefore: calls.length });
        return Promise.resolve();
      },
    });

    await service.read(request(EVERYWHERE), 'c3', { hubId: FILTER_HUB });

    // One transaction for each key (pickup.read for five queues, staff.read for one), each bounded once, before its first count.
    expect(limits.map((limit) => limit.milliseconds)).toEqual([3000, 3000]);
    expect(limits.map((limit) => limit.countsBefore)).toEqual([0, 5]);
    expect(
      calls.map((call) => [call.queue, call.handle === limits[0]?.handle ? 'first' : 'second']),
    ).toEqual([
      ['PICKUP_AWAITING_CONFIRMATION', 'first'],
      ['PICKUP_CUTOFF_REVIEW', 'first'],
      ['PICKUP_EXCEPTION_APPROVAL', 'first'],
      ['PICKUP_UNMANIFESTED_POOL', 'first'],
      ['PICKUP_RUNS_IN_PROGRESS', 'first'],
      ['STAFF_AWAITING_APPROVAL', 'second'],
    ]);
    expect(calls.at(-1)?.handle).toBe(limits[1]?.handle);
  });

  /** The sessions of the tests of the entries, and the queues each is given (written out, in the order of the contract). */
  const SESSIONS: readonly (readonly [
    string,
    readonly BundleGrantSnapshot[],
    readonly QueueId[],
  ])[] = [
    [
      'an officer of the pickup desk',
      [held('pickup.read'), held('pickup.exception.approve')],
      [
        'PICKUP_AWAITING_CONFIRMATION',
        'PICKUP_CUTOFF_REVIEW',
        'PICKUP_EXCEPTION_APPROVAL',
        'PICKUP_UNMANIFESTED_POOL',
        'PICKUP_RUNS_IN_PROGRESS',
      ],
    ],
    ['a session of every key', EVERY_KEY, [...QUEUE_IDS]],
    [
      'a session of the lists’ keys alone',
      [held('pickup.read'), held('staff.read')],
      [
        'PICKUP_AWAITING_CONFIRMATION',
        'PICKUP_CUTOFF_REVIEW',
        'PICKUP_UNMANIFESTED_POOL',
        'PICKUP_RUNS_IN_PROGRESS',
      ],
    ],
    [
      'a session of the decision keys alone',
      [held('pickup.exception.approve'), held('staff.identity.approve')],
      [],
    ],
  ];

  // Break caught: an entry dropped because the hub has nothing in it (a 0 read as "absent", which says "not yours"), an entry for a queue the
  // session may not read, an approver's queue shown for a hub without its decision key, or a queue counted that the session may not read
  // (AC-HUBF-04: which entries are present does not depend on the hub). The same sessions hold their keys at their own hubs (the hub named is
  // outside them: nothing is counted, and the entries are the same) and at every hub (the hub is counted, and only the queues of the session are).
  it.each(SESSIONS)(
    'answers %s with the entries it has without a hub, each at 0 when the hub has nothing',
    async (_who, grants, expected) => {
      const { made, calls } = counters(EVERY_QUEUE);
      const service = new QueueSummaryService({
        limitStatements: noLimit,
        runner: runner(),
        counters: made,
      });

      const unfiltered = await service.read(request(grants), 'c3');
      calls.length = 0;
      const outside = await service.read(request(grants), 'c3', { hubId: FILTER_HUB });
      // A hub that no grant of the session holds is answered at 0 without a count (task A1) ...
      expect(calls, 'nothing was counted').toEqual([]);
      calls.length = 0;
      // ... and the same keys held at every hub are counted, each queue once, and no queue the session may not read.
      const everywhere = grants.map((each) => held(each.permission, 'all'));
      const filtered = await service.read(request(everywhere), 'c3', { hubId: FILTER_HUB });

      for (const answer of [outside, filtered]) {
        expect(queueIdsOf(answer)).toEqual(expected);
        expect(queueIdsOf(answer)).toEqual(queueIdsOf(unfiltered));
        // Each is a 0 with no moment (the counters found nothing, or none was asked).
        expect(answer.queues).toEqual(expected.map((queue) => ({ queue, count: 0 })));
      }
      expect(calls.map((call) => call.queue)).toEqual(expected);
    },
  );

  // Break caught: the answer naming the hub it was asked for (an echo that the contract's closed entry does not have), or an entry that carries
  // more than the queue, the count and the moment because a hub was given (AC-HUBF-04: the answer names no hub and holds nothing more).
  it('answers with the shape it always has, and names no hub, when a hub is given', async () => {
    const { made } = counters(SPECS);
    const service = new QueueSummaryService({
      limitStatements: noLimit,
      runner: runner(),
      counters: made,
    });

    const answer = await service.read(request(EVERYWHERE), 'c3', { hubId: FILTER_HUB });

    expect(answer).toEqual(THE_ANSWER);
    expect(Object.keys(answer)).toEqual(['queues']);
    for (const entry of answer.queues) {
      expect(Object.keys(entry).every((key) => ['queue', 'count', 'oldest_at'].includes(key))).toBe(
        true,
      );
    }
    expect(JSON.stringify(answer)).not.toContain(FILTER_HUB);
  });
});
