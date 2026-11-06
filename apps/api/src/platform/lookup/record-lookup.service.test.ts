import { describe, expect, it } from 'vitest';

import type { AuditEventInput } from '../auth/ports/audit-writer.port.js';
import type { BundleGrantSnapshot, StoredSession } from '../auth/ports/session-store.port.js';
import type { TransactionHandle, UnitOfWorkOptions } from '../auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../authorization/authorized-request.js';
import type { OperationWork } from '../authorization/operation-runner.js';
import { ApiException } from '../http/api-exception.js';
import {
  RECORD_LOOKUP_KINDS,
  type LookupHit,
  type LookupQuery,
  type RecordLookupKind,
  type RecordLookupSource,
} from '../domain-ports/record-lookup.port.js';
import { RecordLookupService } from './record-lookup.service.js';

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
    stateChanging: false,
  };
}

interface Reading {
  readonly key: string | undefined;
  readonly options: UnitOfWorkOptions | undefined;
  readonly handle: TransactionHandle;
}

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
      readings.push({ key: authorized.permission, options, handle });
      return work(handle, authorized);
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

function build(options: {
  readonly sources: readonly RecordLookupSource[];
  readonly primaryHub?: string | null;
  /** The names the `hub` table holds (the two hubs of these tests by default). */
  readonly hubNames?: ReadonlyMap<string, string>;
}) {
  const reads = runner();
  const events: { event: AuditEventInput; handle: TransactionHandle }[] = [];
  const nameReads: NameRead[] = [];
  const names = options.hubNames ?? HUB_NAMES;
  const service = new RecordLookupService({
    runner: reads,
    sources: options.sources,
    audit: {
      write: (handle: TransactionHandle, event: AuditEventInput) => {
        events.push({ event, handle });
        return Promise.resolve();
      },
    },
    primaryHubOf: () =>
      Promise.resolve(options.primaryHub === undefined ? HUB_A : options.primaryHub),
    hubNamesOf: (handle: TransactionHandle, hubIds: readonly string[]) => {
      nameReads.push({ handle, hubIds });
      return Promise.resolve(
        new Map(
          hubIds.flatMap((id) => (names.has(id) ? [[id, names.get(id) ?? ''] as const] : [])),
        ),
      );
    },
  });
  return { service, reads, events, nameReads };
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
      expect(JSON.stringify((failure as ApiException).details)).toContain('/q');
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
    for (const reading of reads.readings)
      expect(reading.options).toEqual({ isolation: 'REPEATABLE READ' });
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
