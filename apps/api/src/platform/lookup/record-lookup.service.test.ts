import { describe, expect, it } from 'vitest';

import type { AuditEventInput } from '../auth/ports/audit-writer.port.js';
import type { BundleGrantSnapshot, StoredSession } from '../auth/ports/session-store.port.js';
import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../authorization/authorized-request.js';
import type { OperationWork } from '../authorization/operation-runner.js';
import { DatabaseDeadlineError } from '../database/database-failures.js';
import { ApiException } from '../http/api-exception.js';
import { classifyFailure } from '../http/operational-failure.js';
import {
  RECORD_LOOKUP_KINDS,
  type LookupHit,
  type LookupQuery,
  type RecordLookupKind,
  type RecordLookupSource,
} from '../domain-ports/record-lookup.port.js';
import {
  RECORD_LOOKUP_STATEMENT_TIMEOUT_MS,
  RecordLookupService,
} from './record-lookup.service.js';

/**
 * `lookupRecords` on fakes (task C2; `features/operations/global-lookup.md`): which kinds a session is searched for, under which key and in
 * which order, how many results are kept, how a result is drawn and masked, and when a hub crossing is written. The scope against the
 * policies, with the real database, is `record-lookup.db.test.ts`.
 */
const HUB_A = '11111111-1111-4111-8111-111111111111';
const HUB_B = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL = '44444444-4444-4444-8444-444444444444';

const held = (permission: string, hubScope: BundleGrantSnapshot['hubScope'] = 'own') =>
  ({ permission, hubScope, ownershipScope: 'any', tier: 'A' }) satisfies BundleGrantSnapshot;

/** The request of a staff session of the Ops Portal holding the grants given. */
function request(
  grants: readonly BundleGrantSnapshot[],
  hubs: readonly string[] = [HUB_A],
): AuthorizedRequest {
  return {
    session: {
      id: '33333333-3333-4333-8333-333333333333',
      principalType: 'STAFF',
      principalId: PRINCIPAL,
      authority: { snapshot: { grants }, authorizedHubIds: hubs },
    } as unknown as StoredSession,
    credential: 'COOKIE',
    idleMinutes: 30,
    judgedAt: new Date('2026-11-06T09:00:00.000Z'),
    permission: undefined,
    grant: undefined,
    scope: { hubScopeMode: 'SET', authorizedHubIds: [] },
    activity: 'qualifying',
    // The lookup is a POST that changes nothing: the runner takes every request of a method that is not safe as one that changes state.
    stateChanging: true,
  };
}

interface Reading {
  readonly key: string | undefined;
  readonly stateChanging: boolean;
  readonly handle: TransactionHandle;
  /** The authorization the runner was handed: the key's (`authorizationForKey`) for a search, the request's own for the step that writes the events. */
  readonly authorized: AuthorizedRequest;
}

/**
 * `runs` is how many times the coordinator runs a work: the locked path runs it again after a rollback (a stronger lock asked for, or a plan that
 * changed), and only the last run's result is the answer. The fake has no rollback, so what an earlier run wrote (an audit event) stays in its
 * record, and what an earlier run left in the memory of the caller stays too: which is what a work that is not restart-safe cannot survive.
 */
function runner(runs = 1) {
  const readings: Reading[] = [];
  return {
    readings,
    // The only door the service has: the runner's locked path. The lock-free `read` refuses a request of a method that is not safe, and the
    // type of the service's runner does not offer it.
    mutate: async <T>(
      authorized: AuthorizedRequest,
      _correlationId: string,
      work: OperationWork<T>,
    ): Promise<T> => {
      let answer: T | undefined;
      for (let run = 0; run < runs; run += 1) {
        const handle = { reading: readings.length } as unknown as TransactionHandle;
        readings.push({
          key: authorized.permission,
          stateChanging: authorized.stateChanging,
          handle,
          authorized,
        });
        answer = await work(handle, authorized);
      }
      return answer as T;
    },
  };
}

interface Search {
  readonly kind: RecordLookupKind;
  readonly query: LookupQuery;
  readonly limit: number;
  readonly handle: TransactionHandle;
}

/**
 * A source of a kind that finds `hits` (as many as it is allowed) for any query it can answer (`answers`: every query unless the test says
 * otherwise), and records that it was asked.
 */
function source(
  kind: RecordLookupKind,
  readKey: string,
  hits: readonly LookupHit[],
  searches: Search[],
  answers: (query: LookupQuery) => boolean = () => true,
): RecordLookupSource {
  return {
    kind,
    readKey,
    answers,
    search: (handle, query, limit) => {
      searches.push({ kind, query, limit, handle });
      return Promise.resolve(hits.slice(0, limit));
    },
  };
}

const hit = (id: string, hubId: string | null, over: Partial<LookupHit> = {}): LookupHit => ({
  id,
  hubId,
  title: `Title ${id}`,
  state: 'CONFIRMED',
  ...over,
});

/** The names of the two hubs of these tests, as the `hub` table holds them. */
const HUB_NAMES: ReadonlyMap<string, string> = new Map([
  [HUB_A, 'Accra'],
  [HUB_B, 'Kumasi'],
]);

interface NameRead {
  readonly handle: TransactionHandle;
  readonly hubIds: readonly string[];
}

const many = (prefix: string, count: number, hubId: string | null = HUB_A): LookupHit[] =>
  Array.from({ length: count }, (_, index) =>
    hit(`${prefix}-${String(index + 1).padStart(2, '0')}`, hubId),
  );

/** The bound a transaction was given before its statements (`limitStatements`), and how many searches had been made when it was given. */
interface Limit {
  readonly handle: TransactionHandle;
  readonly milliseconds: number;
  readonly searchesBefore: number;
}

function build(options: {
  readonly sources: readonly RecordLookupSource[];
  readonly primaryHub?: string | null;
  /** The names the `hub` table holds (the two hubs of these tests by default). */
  readonly hubNames?: ReadonlyMap<string, string>;
  /** How many times the runner runs each work (the coordinator may run it again after a rollback). */
  readonly runs?: number;
  /** The searches the sources record into, for the tests that say when something happened in relation to them. */
  readonly searches?: readonly Search[];
  /** What setting the bound does; it sets nothing by default. */
  readonly limitStatements?: (handle: TransactionHandle, milliseconds: number) => Promise<void>;
  /** What writing an event does; it records the event by default. */
  readonly failWriting?: Error;
}) {
  const reads = runner(options.runs);
  const events: {
    event: AuditEventInput;
    handle: TransactionHandle;
    /** How many searches had been made when the event was written. */
    searchesBefore: number;
  }[] = [];
  const nameReads: NameRead[] = [];
  const baselineReads: TransactionHandle[] = [];
  const limits: Limit[] = [];
  const names = options.hubNames ?? HUB_NAMES;
  const searchesMade = (): number => options.searches?.length ?? 0;
  const service = new RecordLookupService({
    runner: reads,
    sources: options.sources,
    audit: {
      write: (handle: TransactionHandle, event: AuditEventInput) => {
        if (options.failWriting !== undefined) return Promise.reject(options.failWriting);
        events.push({ event, handle, searchesBefore: searchesMade() });
        return Promise.resolve();
      },
    },
    primaryHubOf: (handle: TransactionHandle) => {
      baselineReads.push(handle);
      return Promise.resolve(options.primaryHub === undefined ? HUB_A : options.primaryHub);
    },
    hubNamesOf: (handle: TransactionHandle, hubIds: readonly string[]) => {
      nameReads.push({ handle, hubIds });
      return Promise.resolve(
        new Map(
          hubIds.flatMap((id) => (names.has(id) ? [[id, names.get(id) ?? ''] as const] : [])),
        ),
      );
    },
    limitStatements: (handle: TransactionHandle, milliseconds: number) => {
      limits.push({ handle, milliseconds, searchesBefore: searchesMade() });
      return options.limitStatements === undefined
        ? Promise.resolve()
        : options.limitStatements(handle, milliseconds);
    },
  });
  return { service, reads, events, nameReads, baselineReads, limits };
}

const ALL_KEYS = [
  held('pickup.read'),
  held('vendor.read'),
  held('dispatch.read'),
  held('staff.read'),
];

function everyKind(searches: Search[], counts: Partial<Record<RecordLookupKind, number>> = {}) {
  const keyOf: Record<RecordLookupKind, string> = {
    PICKUP_REQUEST: 'pickup.read',
    PICKUP_MANIFEST: 'pickup.read',
    VENDOR_ACCOUNT: 'vendor.read',
    RIDER: 'dispatch.read',
    STAFF_IDENTITY: 'staff.read',
  };
  // Composed in a scrambled order: the answer is in the order of the kinds whatever the composition gave.
  return [...RECORD_LOOKUP_KINDS]
    .reverse()
    .map((kind) =>
      source(kind, keyOf[kind], many(kind.toLowerCase(), counts[kind] ?? 1), searches),
    );
}

const kindsOf = (answer: { readonly items: readonly { readonly kind: string }[] }) =>
  answer.items.map((item) => item.kind);

describe('the text asked', () => {
  // Break caught (AC-LOOKUP-01): a text the contract refuses being searched.
  it.each([undefined, '', ' x ', 'x'.repeat(65)])(
    'refuses %j as /q, and reads nothing',
    async (q) => {
      const searches: Search[] = [];
      const { service, reads } = build({ sources: everyKind(searches) });

      const failure = await service.lookup(request(ALL_KEYS), 'corr', q).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(ApiException);
      expect((failure as ApiException).code).toBe('VALIDATION_FAILED');
      // The text is the field `q` of the body (`AC-LOOKUP-01`): the violation says so, and never that it was in the address.
      expect((failure as ApiException).details).toMatchObject({
        violations: [{ in: 'body', pointer: '/q' }],
      });
      expect(reads.readings).toEqual([]);
      expect(searches).toEqual([]);
    },
  );

  it('gives each source the query it understood, trimmed', async () => {
    const searches: Search[] = [];
    const { service } = build({ sources: everyKind(searches) });

    await service.lookup(request(ALL_KEYS), 'corr', '  acc-pr-7kq2mz ');

    expect(searches.length).toBeGreaterThan(0);
    for (const search of searches) {
      expect(search.query).toMatchObject({
        text: 'acc-pr-7kq2mz',
        code: 'ACC-PR-7KQ2MZ',
        codeType: 'PR',
      });
    }
  });
});

describe('the kinds a session is searched for', () => {
  // Break caught (AC-LOOKUP-05): a kind searched without its key, or under another key's grant.
  it('searches a kind under the key of its own read, in one transaction for each key, and no kind without the key', async () => {
    const searches: Search[] = [];
    const { service, reads } = build({ sources: everyKind(searches) });

    const answer = await service.lookup(
      request([held('pickup.read'), held('staff.read')]),
      'corr',
      'ama',
    );

    expect(kindsOf(answer)).toEqual(['PICKUP_REQUEST', 'PICKUP_MANIFEST', 'STAFF_IDENTITY']);
    expect(reads.readings.map((reading) => reading.key)).toEqual(['pickup.read', 'staff.read']);
    // Each transaction is the POST's: asked of the locked path with the request as the guard judged it.
    for (const reading of reads.readings) expect(reading.stateChanging).toBe(true);
    // The two kinds of pickup.read share the transaction of that key; each other kind has its own.
    const byKind = new Map(searches.map((search) => [search.kind, search.handle]));
    expect(byKind.get('PICKUP_REQUEST')).toBe(byKind.get('PICKUP_MANIFEST'));
    expect(byKind.get('PICKUP_REQUEST')).not.toBe(byKind.get('STAFF_IDENTITY'));
    expect(searches.map((search) => search.kind)).not.toContain('VENDOR_ACCOUNT');
    expect(searches.map((search) => search.kind)).not.toContain('RIDER');
  });

  // Break caught: a transaction opened (and a snapshot taken) for a key none of whose kinds can answer the query, which a code or a phone
  // number typed in full would do for every key the session holds; or a kind asked a question it cannot answer.
  it('opens a transaction only for a key with a kind that can answer the query, and asks only that kind', async () => {
    const searches: Search[] = [];
    const named = (query: LookupQuery): boolean =>
      query.code === undefined && query.phone === undefined;
    const { service, reads } = build({
      sources: [
        source('PICKUP_REQUEST', 'pickup.read', many('r', 1), searches, (q) => q.codeType !== 'MF'),
        source(
          'PICKUP_MANIFEST',
          'pickup.read',
          many('m', 1),
          searches,
          (q) => q.codeType === 'MF',
        ),
        source('VENDOR_ACCOUNT', 'vendor.read', many('v', 1), searches, named),
        source('RIDER', 'dispatch.read', many('d', 1), searches, (q) => q.code === undefined),
        source('STAFF_IDENTITY', 'staff.read', many('s', 1), searches, named),
      ],
    });

    const byCode = await service.lookup(request(ALL_KEYS), 'corr', 'acc-pr-7kq2mz');
    expect(kindsOf(byCode)).toEqual(['PICKUP_REQUEST']);
    expect(reads.readings.map((reading) => reading.key)).toEqual(['pickup.read']);
    expect(searches.map((search) => search.kind)).toEqual(['PICKUP_REQUEST']);

    reads.readings.length = 0;
    searches.length = 0;
    const byRunCode = await service.lookup(request(ALL_KEYS), 'corr', 'acc-mf-8wxh4t');
    expect(kindsOf(byRunCode)).toEqual(['PICKUP_MANIFEST']);
    expect(searches.map((search) => search.kind)).toEqual(['PICKUP_MANIFEST']);

    reads.readings.length = 0;
    searches.length = 0;
    const byPhone = await service.lookup(request(ALL_KEYS), 'corr', '0241112222');
    expect(kindsOf(byPhone)).toEqual(['PICKUP_REQUEST', 'RIDER']);
    expect(reads.readings.map((reading) => reading.key)).toEqual(['pickup.read', 'dispatch.read']);

    reads.readings.length = 0;
    const byName = await service.lookup(request(ALL_KEYS), 'corr', 'ama');
    expect(kindsOf(byName)).toEqual([
      'PICKUP_REQUEST',
      'VENDOR_ACCOUNT',
      'RIDER',
      'STAFF_IDENTITY',
    ]);
    expect(reads.readings.map((reading) => reading.key)).toEqual([
      'pickup.read',
      'vendor.read',
      'dispatch.read',
      'staff.read',
    ]);
  });

  // Break caught: the lookup served to a session of another principal because the surface gate was bypassed or misdeclared.
  it.each(['VENDOR', 'RIDER', 'SYSTEM'])(
    'refuses a %s session, and reads nothing',
    async (principalType) => {
      const searches: Search[] = [];
      const { service, reads } = build({ sources: everyKind(searches) });
      const own = request(ALL_KEYS);
      const other = { ...own, session: { ...own.session, principalType } } as AuthorizedRequest;

      const failure = await service.lookup(other, 'corr', 'ama').then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(ApiException);
      expect((failure as ApiException).code).toBe('PERMISSION_DENIED');
      expect(reads.readings).toEqual([]);
      expect(searches).toEqual([]);
    },
  );

  it('is an empty answer, not an error, for a session that holds none of the keys', async () => {
    const searches: Search[] = [];
    const { service, reads, events } = build({ sources: everyKind(searches) });

    const answer = await service.lookup(request([held('notification.read')]), 'corr', 'ama');

    expect(answer).toEqual({ items: [] });
    expect(reads.readings).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('the answer', () => {
  // Break caught (AC-LOOKUP-08): more than eight of a kind or twenty in all, a kind left out of the order, or a later kind searched for
  // after the twenty were taken.
  it('keeps at most eight of a kind and twenty in all, in the order of the kinds, and reads no kind for which no room is left', async () => {
    const searches: Search[] = [];
    const { service } = build({
      sources: everyKind(searches, {
        PICKUP_REQUEST: 12,
        VENDOR_ACCOUNT: 12,
        RIDER: 12,
        STAFF_IDENTITY: 12,
      }),
    });

    const answer = await service.lookup(request(ALL_KEYS), 'corr', 'ama');

    const counts = new Map<string, number>();
    for (const kind of kindsOf(answer)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    expect([...counts]).toEqual([
      ['PICKUP_REQUEST', 8],
      ['PICKUP_MANIFEST', 1],
      ['VENDOR_ACCOUNT', 8],
      ['RIDER', 3],
    ]);
    expect(answer.items).toHaveLength(20);
    expect(searches.map((search) => search.kind)).not.toContain('STAFF_IDENTITY');
    // A source is never asked for more than the eight, or than there is room for.
    expect(searches.map((search) => [search.kind, search.limit])).toEqual([
      ['PICKUP_REQUEST', 8],
      ['PICKUP_MANIFEST', 8],
      ['VENDOR_ACCOUNT', 8],
      ['RIDER', 3],
    ]);
  });

  // Break caught (AC-LOOKUP-10): a route or a sentence in a result, a state reworded, a hub without its name, a field the facts do not name.
  it('draws a result from the kind, the id, the code, the title and the facts: the state as given, the hub by name, the service date', async () => {
    const searches: Search[] = [];
    const { service } = build({
      sources: [
        source(
          'PICKUP_REQUEST',
          'pickup.read',
          [
            hit('r1', HUB_A, {
              code: 'ACC-PR-7KQ2MZ',
              title: 'ACC-PR-7KQ2MZ',
              state: 'PENDING',
              serviceDate: '2026-11-07',
              senderName: 'Ama Boateng-Demo',
            }),
          ],
          searches,
        ),
        source(
          'PICKUP_MANIFEST',
          'pickup.read',
          [
            hit('m1', HUB_B, {
              code: 'ACC-MF-8WXH4T',
              state: 'IN_PROGRESS',
              serviceDate: '2026-11-08',
            }),
          ],
          searches,
        ),
        source(
          'VENDOR_ACCOUNT',
          'vendor.read',
          [hit('v1', HUB_A, { code: 'K7M2P9XQ', state: 'SUSPENDED' })],
          searches,
        ),
        source(
          'RIDER',
          'dispatch.read',
          [hit('d1', HUB_B, { state: 'TEMPORARILY_UNAVAILABLE' })],
          searches,
        ),
        source('STAFF_IDENTITY', 'staff.read', [hit('s1', null, { state: 'ACTIVE' })], searches),
      ],
    });

    const answer = await service.lookup(request(ALL_KEYS), 'corr', 'ama');

    expect(answer.items).toEqual([
      {
        kind: 'PICKUP_REQUEST',
        id: 'r1',
        code: 'ACC-PR-7KQ2MZ',
        title: 'ACC-PR-7KQ2MZ',
        state: 'PENDING',
        hub: { id: HUB_A, display_name: 'Accra' },
        service_date: '2026-11-07',
        sender_name: 'Ama Boateng-Demo',
      },
      {
        kind: 'PICKUP_MANIFEST',
        id: 'm1',
        code: 'ACC-MF-8WXH4T',
        title: 'Title m1',
        state: 'IN_PROGRESS',
        hub: { id: HUB_B, display_name: 'Kumasi' },
        service_date: '2026-11-08',
      },
      {
        kind: 'VENDOR_ACCOUNT',
        id: 'v1',
        code: 'K7M2P9XQ',
        title: 'Title v1',
        state: 'SUSPENDED',
        hub: { id: HUB_A, display_name: 'Accra' },
      },
      {
        kind: 'RIDER',
        id: 'd1',
        title: 'Title d1',
        state: 'TEMPORARILY_UNAVAILABLE',
        hub: { id: HUB_B, display_name: 'Kumasi' },
      },
      { kind: 'STAFF_IDENTITY', id: 's1', title: 'Title s1', state: 'ACTIVE' },
    ]);
    for (const item of answer.items) {
      expect(item).not.toHaveProperty('route');
      expect(item).not.toHaveProperty('subtitle');
    }
  });

  // Break caught (AC-LOOKUP-09): a number in clear, or a number shown when the person did not search by it.
  it('shows a phone only when the source says the person searched by it, and masked, as phone_hint', async () => {
    const searches: Search[] = [];
    const { service } = build({
      sources: [
        source(
          'PICKUP_REQUEST',
          'pickup.read',
          [hit('r1', HUB_A, { matchedPhone: '+233241112222' }), hit('r2', HUB_A)],
          searches,
        ),
      ],
    });

    const answer = await service.lookup(request([held('pickup.read')]), 'corr', '0241112222');

    expect(answer.items.map((item) => item.phone_hint)).toEqual(['+233******222', undefined]);
    expect(answer.items[1]).not.toHaveProperty('phone_hint');
    expect(JSON.stringify(answer)).not.toContain('2411');
  });
});

describe('the names of the hubs', () => {
  // Break caught (AC-LOOKUP-10): a hub name read in another transaction than the hit's, for a hub no kept result represents, for a result
  // with no hub, or once for each result.
  it('reads the names in the transaction that read the hits, once for the hubs they represent, and for no result without a hub', async () => {
    const searches: Search[] = [];
    const { service, nameReads } = build({
      sources: [
        source(
          'PICKUP_REQUEST',
          'pickup.read',
          [hit('r1', HUB_A), hit('r2', HUB_B), hit('r3', HUB_A)],
          searches,
        ),
        source('STAFF_IDENTITY', 'staff.read', [hit('s1', null)], searches),
      ],
    });

    await service.lookup(
      request([held('pickup.read', 'all'), held('staff.read', 'all')], [HUB_A, HUB_B]),
      'corr',
      'ama',
    );

    const pickupHandle = searches.find((search) => search.kind === 'PICKUP_REQUEST')?.handle;
    expect(nameReads).toHaveLength(1);
    expect(nameReads[0]?.handle).toBe(pickupHandle);
    expect(nameReads[0]?.hubIds.toSorted()).toEqual([HUB_A, HUB_B]);
  });

  it('reads no name for an answer with no hub to name', async () => {
    const searches: Search[] = [];
    const { service, nameReads } = build({
      sources: [
        source('PICKUP_REQUEST', 'pickup.read', [], searches),
        source('STAFF_IDENTITY', 'staff.read', [hit('s1', null)], searches),
      ],
    });

    const answer = await service.lookup(
      request([held('pickup.read'), held('staff.read')]),
      'corr',
      'ama',
    );

    expect(answer.items).toHaveLength(1);
    expect(nameReads).toEqual([]);
  });

  // Break caught: a result drawn with no hub because its name was not found, which a client reads as "this record has no hub".
  it('fails the whole read when the name of a hub a result belongs to cannot be read', async () => {
    const searches: Search[] = [];
    const { service } = build({
      hubNames: new Map([[HUB_A, 'Accra']]),
      sources: [source('PICKUP_REQUEST', 'pickup.read', [hit('r1', HUB_B)], searches)],
    });

    await expect(service.lookup(request([held('pickup.read')]), 'corr', 'ama')).rejects.toThrow(
      /hub/i,
    );
  });
});

describe('the crossing of a hub', () => {
  // Break caught (AC-LOOKUP-11): the hub of the actor audited as foreign, a foreign hub audited more than once, or none audited.
  it('writes one event for each hub other than the actor’s own that the results represent, naming the operation', async () => {
    const searches: Search[] = [];
    const { service, events } = build({
      primaryHub: HUB_A,
      sources: [
        source(
          'PICKUP_REQUEST',
          'pickup.read',
          [hit('r1', HUB_A), hit('r2', HUB_B), hit('r3', HUB_B)],
          searches,
        ),
        source('RIDER', 'dispatch.read', [hit('d1', HUB_B), hit('d2', HUB_A)], searches),
      ],
    });

    await service.lookup(
      request([held('pickup.read', 'all'), held('dispatch.read', 'all')], [HUB_A, HUB_B]),
      'corr',
      'ama',
    );

    expect(events.map((entry) => entry.event)).toEqual([
      {
        code: 'auth.hub_boundary.crossed',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'HUB', id: HUB_B },
        responsibleHubId: HUB_B,
        relatedIds: { operation_id: 'lookupRecords' },
      },
    ]);
  });

  it('writes one for each hub the results represent for a staff member with no primary hub, in the order of the hubs’ ids', async () => {
    const searches: Search[] = [];
    const { service, events } = build({
      primaryHub: null,
      sources: [
        source(
          'PICKUP_REQUEST',
          'pickup.read',
          [hit('r1', HUB_B), hit('r2', HUB_A), hit('r3', null)],
          searches,
        ),
      ],
    });

    await service.lookup(request([held('pickup.read', 'all')], [HUB_A, HUB_B]), 'corr', 'ama');

    expect(events.map((entry) => entry.event.responsibleHubId)).toEqual([HUB_A, HUB_B]);
  });

  // Break caught (the review of 6 November 2026): a work that keeps what it took and what it wrote in the read's own memory while it runs, which the
  // coordinator's second run would find: less room (a short answer), and the hubs of the rolled-back run taken as written (a result without its event).
  it('is restart-safe: a work the runner runs again gives the same answer, and writes its events again', async () => {
    const sources = (searches: Search[]) => [
      source('PICKUP_REQUEST', 'pickup.read', [hit('r1', HUB_B), ...many('r', 7, HUB_A)], searches),
      source('VENDOR_ACCOUNT', 'vendor.read', many('v', 8, HUB_A), searches),
      source('RIDER', 'dispatch.read', many('d', 8, HUB_A), searches),
    ];
    const grants = request(
      [held('pickup.read'), held('vendor.read'), held('dispatch.read')],
      [HUB_A, HUB_B],
    );
    const once = build({ sources: sources([]), primaryHub: HUB_A, runs: 1 });
    const again = build({ sources: sources([]), primaryHub: HUB_A, runs: 2 });

    const single = await once.service.lookup(grants, 'corr', 'ama');
    const restarted = await again.service.lookup(grants, 'corr', 'ama');

    // Twenty in all: eight requests, eight vendors and four riders, however many times each work ran.
    expect(single.items).toHaveLength(20);
    expect(restarted).toEqual(single);
    // The hub of the foreign request is written once by each run of the step that writes the events: nothing was taken as written by a run that rolled back.
    expect(once.events.map((entry) => entry.event.responsibleHubId)).toEqual([HUB_B]);
    expect(again.events.map((entry) => entry.event.responsibleHubId)).toEqual([HUB_B, HUB_B]);
  });

  // Break caught (the audit of 7 November 2026, A4): an event written in the transaction of the key that read the hub, which commits before the
  // searches that follow it have succeeded, so that a lookup that fails later has recorded a crossing for a result it never returned. The events are
  // written together, in one transaction of their own (the request's own authorization, which holds no key), after the last search.
  it('writes the events together, in one transaction of their own, after the last search has succeeded', async () => {
    const searches: Search[] = [];
    const { service, reads, events, baselineReads } = build({
      searches,
      primaryHub: null,
      sources: [
        source('PICKUP_REQUEST', 'pickup.read', [hit('r1', HUB_B), hit('r2', HUB_A)], searches),
        source('VENDOR_ACCOUNT', 'vendor.read', [hit('v1', HUB_B)], searches),
        source('RIDER', 'dispatch.read', [hit('d1', HUB_A)], searches),
      ],
    });
    const asked = request(
      [held('pickup.read', 'all'), held('vendor.read', 'all'), held('dispatch.read', 'all')],
      [HUB_A, HUB_B],
    );

    await service.lookup(asked, 'corr', 'ama');

    // One transaction for each key, and then one more, the request's own: the grant of no key.
    expect(reads.readings.map((reading) => reading.key)).toEqual([
      'pickup.read',
      'vendor.read',
      'dispatch.read',
      undefined,
    ]);
    const last = reads.readings.at(-1);
    expect(last?.authorized).toBe(asked);
    expect(last?.stateChanging).toBe(true);
    // Every event is written in that transaction, after all three searches. The actor's own hub is read where the records are, in each key's transaction,
    // which keeps what it found to the hubs that are foreign to the actor; the step that writes the events asks nothing more.
    expect(events.map((entry) => entry.event.responsibleHubId)).toEqual([HUB_A, HUB_B]);
    for (const entry of events) {
      expect(entry.handle).toBe(last?.handle);
      expect(entry.searchesBefore).toBe(searches.length);
    }
    expect(baselineReads).toEqual(reads.readings.slice(0, 3).map((reading) => reading.handle));
    expect(searches).toHaveLength(3);
  });

  // Break caught: a second transaction (and its two, the coordinator's) opened for every lookup that finds a record with a hub, which an officer who reads
  // their own hub alone would pay on every search for events they will never write.
  it('opens no transaction for the events of a lookup that has none to write', async () => {
    const searches: Search[] = [];
    const { service, reads, baselineReads, events } = build({
      primaryHub: HUB_A,
      sources: [source('PICKUP_REQUEST', 'pickup.read', [hit('r1', HUB_A)], searches)],
    });

    await service.lookup(request([held('pickup.read')]), 'corr', 'ama');

    // The hub of the result is the actor's own, read in the transaction of the search: no crossing, and no second transaction.
    expect(reads.readings.map((reading) => reading.key)).toEqual(['pickup.read']);
    expect(baselineReads).toEqual([reads.readings[0]?.handle]);
    expect(events).toEqual([]);
  });

  // Break caught (A4): a hub written down for a result the answer never carried, because a later search failed. The failure is the read's, whole: the
  // earlier keys' findings are not answered and not recorded, and the error is the source's own (the platform answers it).
  it('writes no event when a search fails after another has found a record of a foreign hub, and opens no transaction to write one', async () => {
    const searches: Search[] = [];
    const failing: RecordLookupSource = {
      kind: 'RIDER',
      readKey: 'dispatch.read',
      answers: () => true,
      search: () => Promise.reject(new Error('the read failed')),
    };
    const { service, reads, events } = build({
      searches,
      primaryHub: HUB_A,
      sources: [
        source('PICKUP_REQUEST', 'pickup.read', [hit('r1', HUB_B)], searches),
        source('VENDOR_ACCOUNT', 'vendor.read', [hit('v1', HUB_B)], searches),
        failing,
      ],
    });

    await expect(
      service.lookup(
        request(
          [held('pickup.read', 'all'), held('vendor.read', 'all'), held('dispatch.read', 'all')],
          [HUB_A, HUB_B],
        ),
        'corr',
        'ama',
      ),
    ).rejects.toThrow('the read failed');

    expect(searches.map((search) => search.kind)).toEqual(['PICKUP_REQUEST', 'VENDOR_ACCOUNT']);
    expect(reads.readings.map((reading) => reading.key)).toEqual([
      'pickup.read',
      'vendor.read',
      'dispatch.read',
    ]);
    expect(events).toEqual([]);

    // The same lookup, once the search can be made, writes the event and answers.
    const retry = build({
      primaryHub: HUB_A,
      sources: [
        source('PICKUP_REQUEST', 'pickup.read', [hit('r1', HUB_B)], []),
        source('VENDOR_ACCOUNT', 'vendor.read', [hit('v1', HUB_B)], []),
      ],
    });
    const answer = await retry.service.lookup(
      request([held('pickup.read', 'all'), held('vendor.read', 'all')], [HUB_A, HUB_B]),
      'corr',
      'ama',
    );
    expect(answer.items).toHaveLength(2);
    expect(retry.events.map((entry) => entry.event.responsibleHubId)).toEqual([HUB_B]);
  });

  // Break caught: events lost without a word, a lookup that answers although the ledger could not take what it owes.
  it('fails the read when the events cannot be written, and answers nothing', async () => {
    const searches: Search[] = [];
    const { service } = build({
      primaryHub: HUB_A,
      failWriting: new Error('the ledger refused the event'),
      sources: [source('PICKUP_REQUEST', 'pickup.read', [hit('r1', HUB_B)], searches)],
    });

    await expect(
      service.lookup(request([held('pickup.read', 'all')], [HUB_A, HUB_B]), 'corr', 'ama'),
    ).rejects.toThrow('the ledger refused the event');
  });

  it('writes nothing for an answer with no result, and nothing for a hub whose result was cut from the twenty', async () => {
    const empty: Search[] = [];
    const first = build({
      primaryHub: null,
      sources: [source('PICKUP_REQUEST', 'pickup.read', [], empty)],
    });
    await first.service.lookup(request([held('pickup.read')]), 'corr', 'ama');
    expect(first.events).toEqual([]);

    const searches: Search[] = [];
    const { service, events } = build({
      primaryHub: HUB_A,
      sources: [
        source('PICKUP_REQUEST', 'pickup.read', many('r', 8, HUB_A), searches),
        source('VENDOR_ACCOUNT', 'vendor.read', many('v', 8, HUB_A), searches),
        source('RIDER', 'dispatch.read', many('d', 4, HUB_A), searches),
        source('STAFF_IDENTITY', 'staff.read', many('s', 8, HUB_B), searches),
      ],
    });

    const answer = await service.lookup(request(ALL_KEYS, [HUB_A, HUB_B]), 'corr', 'ama');

    expect(answer.items).toHaveLength(20);
    expect(events).toEqual([]);
  });

  it('fails the whole read when a source fails, and never answers with the kinds that did not', async () => {
    const searches: Search[] = [];
    const failing: RecordLookupSource = {
      kind: 'VENDOR_ACCOUNT',
      readKey: 'vendor.read',
      answers: () => true,
      search: () => Promise.reject(new Error('the read failed')),
    };
    const { service } = build({
      sources: [source('PICKUP_REQUEST', 'pickup.read', many('r', 1), searches), failing],
    });

    await expect(service.lookup(request(ALL_KEYS), 'corr', 'ama')).rejects.toThrow(
      'the read failed',
    );
  });
});

describe('the bound on a search (the audit of 7 November 2026, A5; AC-LOOKUP-15)', () => {
  // Break caught: a search with no statement timeout of its own (a name scan that runs as long as the pool allows, holding the shared lock of the
  // bundle), a limit set after the searches it is meant to bound, one set on another transaction than the searches run in, or one that is not three seconds.
  it('limits the statements of each key’s transaction to three seconds, before any search of it, on the handle the searches use', async () => {
    const searches: Search[] = [];
    const { service, limits } = build({
      searches,
      sources: everyKind(searches),
    });

    await service.lookup(request(ALL_KEYS), 'corr', 'ama');

    // One transaction for each key (pickup.read for two kinds, the others for one), each bounded at three seconds before its first search.
    expect(limits.map((limit) => limit.milliseconds)).toEqual([3000, 3000, 3000, 3000]);
    expect(limits.map((limit) => limit.searchesBefore)).toEqual([0, 2, 3, 4]);
    const handleOf = (kind: RecordLookupKind) =>
      searches.find((search) => search.kind === kind)?.handle;
    expect(limits.map((limit) => limit.handle)).toEqual([
      handleOf('PICKUP_REQUEST'),
      handleOf('VENDOR_ACCOUNT'),
      handleOf('RIDER'),
      handleOf('STAFF_IDENTITY'),
    ]);
    expect(RECORD_LOOKUP_STATEMENT_TIMEOUT_MS).toBe(3000);
  });

  // Break caught: a lookup that goes on without its bound because setting it failed (the search would then run unbounded).
  it('fails the read, and searches nothing, when the limit cannot be set', async () => {
    const searches: Search[] = [];
    const { service } = build({
      searches,
      sources: everyKind(searches),
      limitStatements: () => Promise.reject(new Error('the limit was not set')),
    });

    await expect(service.lookup(request(ALL_KEYS), 'corr', 'ama')).rejects.toThrow(
      'the limit was not set',
    );
    expect(searches).toEqual([]);
  });

  // Break caught: a transaction opened (and bounded) for a session that is searched for nothing, or for a key none of whose kinds can answer the query.
  it('sets no limit for a session that is searched for nothing', async () => {
    const searches: Search[] = [];
    const { service, limits, reads } = build({ searches, sources: everyKind(searches) });

    expect(
      (await service.lookup(request([held('notification.read')]), 'corr', 'ama')).items,
    ).toEqual([]);
    expect(limits).toEqual([]);
    expect(reads.readings).toEqual([]);
  });

  // Break caught: a failure of the database's time that the service catches, rewords or turns into a refusal of its own, which the platform could then no
  // longer read as what it is (the failed read, `503` with no code, as the summary's counts end: AC-QSUM-13). The service lets the source's error out as it
  // is, and the platform reads it as operational.
  it('lets the failure of a search that the database ended out as it is, which the platform answers as a failed read', async () => {
    const ended = new DatabaseDeadlineError('statement', '57014', {
      cause: new Error('canceling statement due to statement timeout'),
    });
    const searches: Search[] = [];
    const slow: RecordLookupSource = {
      kind: 'RIDER',
      readKey: 'dispatch.read',
      answers: () => true,
      search: () => Promise.reject(ended),
    };
    const { service, events } = build({
      searches,
      primaryHub: null,
      sources: [source('PICKUP_REQUEST', 'pickup.read', [hit('r1', HUB_B)], searches), slow],
    });

    const failure = await service
      .lookup(
        request([held('pickup.read', 'all'), held('dispatch.read', 'all')], [HUB_A, HUB_B]),
        'corr',
        'ama',
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBe(ended);
    expect(classifyFailure(failure)).toEqual({ kind: 'operational' });
    // ... and nothing is recorded for the hub the first key found.
    expect(events).toEqual([]);
  });
});
