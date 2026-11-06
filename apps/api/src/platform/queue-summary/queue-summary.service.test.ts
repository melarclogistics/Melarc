import { describe, expect, it } from 'vitest';

import type { BundleGrantSnapshot, StoredSession } from '../auth/ports/session-store.port.js';
import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import type { UnitOfWorkOptions } from '../auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../authorization/authorized-request.js';
import type { OperationWork } from '../authorization/operation-runner.js';
import {
  QUEUE_IDS,
  type QueueCount,
  type QueueCounter,
  type QueueId,
} from '../domain-ports/queue-counter.port.js';
import { QueueSummaryService } from './queue-summary.service.js';

/**
 * `getQueueSummary` on fakes (task C1): which queues a session is given, in which context each is counted, how the answer is shaped and
 * ordered, and what a failure does. The counts against the lists they must equal, with the real database and the real policies, are
 * `queue-summary.db.test.ts`.
 */
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
    count: (handle) => {
      calls.push({ queue: spec.queue, handle });
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
    const service = new QueueSummaryService({ runner: runner(), counters: made });

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
    const service = new QueueSummaryService({ runner: runner(), counters: made });

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
    const service = new QueueSummaryService({ runner: reader, counters: made });

    expect(await service.read(request([held('dispatch.read')]), 'c1')).toEqual({ queues: [] });
    expect(await service.read(request([]), 'c1')).toEqual({ queues: [] });
    expect(reader.readings).toEqual([]);
    expect(calls).toEqual([]);
  });

  // Break caught: the order of the answer following the order the counters were composed in, so that it moves when a module is reordered.
  it('answers in the order of the contract’s queue identifiers, whatever the order of the counters', async () => {
    const { made } = counters([...EVERY_QUEUE].reverse());
    const service = new QueueSummaryService({ runner: runner(), counters: made });

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
    expect(() => new QueueSummaryService({ runner: runner(), counters: made })).toThrow(
      'PICKUP_AWAITING_CONFIRMATION',
    );
  });
});

describe('the context each count is taken in', () => {
  // Break caught: a count taken in the widest grant the session holds, so that it reaches records the queue's own list would not.
  it('counts each key in the scope of its own grant and never a wider one', async () => {
    const reader = runner();
    const { made } = counters(EVERY_QUEUE);
    const service = new QueueSummaryService({ runner: reader, counters: made });

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
    const service = new QueueSummaryService({ runner: reader, counters: made });

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
    const service = new QueueSummaryService({ runner: reader, counters: made });

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
    const service = new QueueSummaryService({ runner: reader, counters: made });

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
    const service = new QueueSummaryService({ runner: runner(), counters: made });

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
