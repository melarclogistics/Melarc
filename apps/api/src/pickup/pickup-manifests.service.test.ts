import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import type { DatabaseTransaction } from '../platform/database/database.service.js';
import type { SecurityContext } from '../platform/database/transaction-context.js';
import { registerTransactionFacts } from '../platform/database/transaction-facts.js';
import { bindTransactionHandle } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { encodePageToken } from '../platform/http/page-token.js';
import { PICKUP_MANIFEST_STATES } from './pickup-manifest.schema.js';
import {
  PickupManifestsService,
  type PickupManifestListFilter,
} from './pickup-manifests.service.js';

/**
 * What the manifest list refuses before it reads anything (OB-S1-25). The contract's validation answers these first, on the route (the
 * database test of the list proves the answer a client sees, in the platform's form); the service states them again because it is the one
 * place that knows what a filter may hold, and a read that trusted its caller to have checked would pass a bad value on to a statement.
 * This proves the refusal, with no statement attempted.
 */
const AUDIT = {} as AuditWriter;

/** A hub as the contract writes one (task C3: `hub_id`, a filter beside `state` and `service_date`), with letters in it so that its capitals are another text. */
const HUB = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01';

/** A staff session whose grant reaches the one hub, `HUB`: what is asked below is asked by it, so that a hub inside its grant is read. */
const AUTHORIZED = {
  session: { principalType: 'STAFF', principalId: '11111111-1111-4111-8111-111111111111' },
  scope: { hubScopeMode: 'SET', authorizedHubIds: [HUB] },
} as unknown as AuthorizedRequest;
/** Values that are not a hub, in the forms a client could send them: the service refuses each, naming the parameter, and reads nothing. */
const NOT_A_HUB = [
  ['text that is not an identifier', 'not-a-uuid'],
  ['an empty hub', ''],
  ['a hub of spaces alone', '   '],
  ['a hub with a space before it', ` ${HUB}`],
  ['a hub with a space after it', `${HUB} `],
  ['a hub with a line break after it', `${HUB}\n`],
  ['a hub written as a urn', `urn:uuid:${HUB}`],
  ['a hub in braces', `{${HUB}}`],
  ['a hub without its hyphens', HUB.replaceAll('-', '')],
  ['a hub with a letter that is not a digit of base sixteen', `g${HUB.slice(1)}`],
] as const;

/** A runner that notes that a read was attempted and answers an empty page. */
function service(): { readonly manifests: PickupManifestsService; readonly reads: () => number } {
  let reads = 0;
  const runner = {
    read: () => {
      reads += 1;
      return Promise.resolve({ items: [], next_page_token: null });
    },
  } as unknown as Pick<OperationRunner, 'read'>;
  return {
    manifests: new PickupManifestsService({ runner, audit: AUDIT }),
    reads: () => reads,
  };
}

const refusal = async (filter: Parameters<PickupManifestsService['list']>[2]) => {
  const { manifests, reads } = service();
  const error = await manifests.list(AUTHORIZED, 'correlation', filter).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(reads(), 'no statement was attempted').toBe(0);
  return error;
};

describe('the manifest list refuses what no filter may hold, before it reads (OB-S1-25)', () => {
  // Break caught: a state taken on trust and handed to a statement, where it would answer an empty list for a mistake and hide it.
  it.each([
    ['a state that is not one', 'NOPE'],
    ['a lower-case state', 'draft'],
    ['an empty state', ''],
    ['a state with a space after it', 'DRAFT '],
  ])('refuses %s', async (_what, state) => {
    const error = await refusal({ state });
    expect(error).toBeInstanceOf(ApiException);
    const refused = error as ApiException;
    expect(refused.code).toBe('VALIDATION_FAILED');
    expect(refused.getStatus()).toBe(400);
    expect(refused.details).toEqual({
      violations: [{ in: 'query', pointer: '/state', rule: 'enum' }],
    });
  });

  // Break caught: a day taken on trust: one that does not exist, is not written as the contract writes it, or carries more than a day.
  it.each([
    ['a day that does not exist', '2031-02-30'],
    ['the 29th of February of a year that is not a leap year', '2031-02-29'],
    ['the 31st of a month of thirty days', '2031-06-31'],
    ['a month that does not exist', '2031-13-01'],
    ['a month of zero', '2031-00-10'],
    ['a day of zero', '2031-06-00'],
    ['a day without its zeros', '2031-6-2'],
    ['text that is not a day', 'not-a-date'],
    ['an empty day', ''],
    ['a day with a time', '2031-06-02T00:00:00Z'],
  ])('refuses %s', async (_what, serviceDate) => {
    const error = await refusal({ serviceDate });
    expect(error).toBeInstanceOf(ApiException);
    const refused = error as ApiException;
    expect(refused.code).toBe('VALIDATION_FAILED');
    expect(refused.getStatus()).toBe(400);
    expect(refused.details).toEqual({
      violations: [{ in: 'query', pointer: '/service_date', rule: 'format' }],
    });
  });

  // Break caught: a hub taken on trust and handed to a statement (an identifier that is not one fails there as a defect, and not as the validation
  // failure the other filters give), an empty value read as "no hub", or a refusal that names another parameter (task C3, `AC-HUBF-07`). The
  // route's validation answers these first; the service states them again because it is the place that knows what a filter may hold.
  it.each(NOT_A_HUB)('refuses %s as a hub', async (_what, hubId) => {
    const error = await refusal({ hubId });
    expect(error).toBeInstanceOf(ApiException);
    const refused = error as ApiException;
    expect(refused.code).toBe('VALIDATION_FAILED');
    expect(refused.getStatus()).toBe(400);
    expect(refused.details).toEqual({
      violations: [{ in: 'query', pointer: '/hub_id', rule: 'format' }],
    });
  });

  // Break caught: a hub judged only when it stands alone, so that a bad one beside filters that are good is read on, and the one violation that
  // names it lost among the others.
  it('refuses a hub that is not one beside filters that are', async () => {
    const error = await refusal({
      state: 'DISPATCHED',
      serviceDate: '2031-06-02',
      hubId: 'not-a-uuid',
    });
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).details).toEqual({
      violations: [{ in: 'query', pointer: '/hub_id', rule: 'format' }],
    });
  });

  // Break caught: a refusal that is too wide, which would turn a legitimate filter into a 400.
  const ACCEPTED: readonly (readonly [string, PickupManifestListFilter])[] = [
    ['no filter at all', {}],
    ...PICKUP_MANIFEST_STATES.map((state): readonly [string, PickupManifestListFilter] => [
      `the state ${state}`,
      { state },
    ]),
    ['a day', { serviceDate: '2031-06-02' }],
    ['the 29th of February of a leap year', { serviceDate: '2032-02-29' }],
    ['a state and a day', { state: 'DISPATCHED', serviceDate: '2031-06-02' }],
    ['a hub', { hubId: HUB }],
    ['a hub in capitals (the same hub)', { hubId: HUB.toUpperCase() }],
    ['a hub, a state and a day', { state: 'DISPATCHED', serviceDate: '2031-06-02', hubId: HUB }],
  ];
  it.each(ACCEPTED)('goes on to read with %s', async (_what, filter) => {
    const { manifests, reads } = service();
    await expect(manifests.list(AUTHORIZED, 'correlation', filter)).resolves.toEqual({
      items: [],
      next_page_token: null,
    });
    expect(reads()).toBe(1);
  });
});

/**
 * What the list gives the database to run when it is given a hub (task C3; `AC-HUBF-02`, `-06`). The route tests see what comes back, and a hub
 * that was judged and then not used would come back as the runs of every hub: so the statement is read here as the driver is given it, its text and
 * the values bound to its placeholders, for each kind of reader the list serves.
 */
const dialect = new PgDialect();

const CONTEXT: SecurityContext = {
  principalType: 'STAFF',
  principalId: '11111111-1111-4111-8111-111111111111',
  surface: 'OPS_PORTAL',
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'correlation',
};

/**
 * What the guard decided, in the little these tests need: who asks, and the scope of the grant. A staff grant reaches the one hub `HUB`; a Rider's
 * reaches none, because its runs are scoped by assignment and not by a hub (task A1: a hub is no reason to answer it empty).
 */
const asked = (principalType: 'STAFF' | 'RIDER'): AuthorizedRequest =>
  ({
    session: { principalType, principalId: '11111111-1111-4111-8111-111111111111' },
    scope: {
      hubScopeMode: 'SET',
      authorizedHubIds: principalType === 'STAFF' ? [HUB] : [],
    },
  }) as unknown as AuthorizedRequest;

/** What a comparison of `column` with a bound value of `cast` is bound to, in the order the comparisons stand in the text. */
function boundTo(
  query: { readonly sql: string; readonly params: readonly unknown[] },
  column: string,
  cast: string,
): unknown[] {
  return [...query.sql.matchAll(new RegExp(`\\b${column}\\s*=\\s*\\$(\\d+)::${cast}`, 'g'))].map(
    (match) => query.params[Number(match[1]) - 1],
  );
}

/**
 * A list asked as `principalType` (with the authorization given, or a bare one) with `filter`, on fakes: what it answered, every statement it gave the
 * driver (text and bound values), and the authorizations the runner was handed, in the order it was handed them. A read that never reached the
 * runner has none of the last two, which is how a read that opened no transaction is told from one that opened it and found nothing.
 */
async function attempt(
  principalType: 'STAFF' | 'RIDER',
  filter: PickupManifestListFilter,
  authorized: AuthorizedRequest = asked(principalType),
): Promise<{
  readonly answer: unknown;
  readonly statements: readonly { readonly sql: string; readonly params: readonly unknown[] }[];
  readonly received: readonly AuthorizedRequest[];
}> {
  const statements: SQL[] = [];
  const received: AuthorizedRequest[] = [];
  const transaction = {
    execute: (statement: SQL) => {
      statements.push(statement);
      return Promise.resolve({ rows: [] });
    },
  } as unknown as DatabaseTransaction;
  registerTransactionFacts(transaction, {
    statementsSinceContext: () => statements.length,
    markContextApplied: () => undefined,
    appliedContext: () => CONTEXT,
  });
  const handle = bindTransactionHandle(transaction);
  // A runner that keeps the authorization it is handed, runs the work of the read on that transaction, and answers what the work answers.
  const runner = {
    read: (
      decision: AuthorizedRequest,
      _correlationId: string,
      work: (handle: unknown, authorized: AuthorizedRequest) => Promise<unknown>,
    ) => {
      received.push(decision);
      return work(handle, decision);
    },
  } as unknown as Pick<OperationRunner, 'read'>;
  const manifests = new PickupManifestsService({ runner, audit: AUDIT });

  const answer = await manifests.list(authorized, 'correlation', filter);
  return {
    answer,
    statements: statements.map((statement) => dialect.sqlToQuery(statement)),
    received,
  };
}

/**
 * The statement that selects the page of manifests, as the driver is given it, for a list asked as `principalType` (with the authorization given, or
 * a bare one) with `filter`, and the authorizations the runner was handed, in the order it was handed them.
 */
async function listStatement(
  principalType: 'STAFF' | 'RIDER',
  filter: PickupManifestListFilter,
  authorized: AuthorizedRequest = asked(principalType),
): Promise<{
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly received: readonly AuthorizedRequest[];
}> {
  const { answer, statements, received } = await attempt(principalType, filter, authorized);
  expect(answer).toEqual({ items: [], next_page_token: null });
  const listing = statements.filter((query) => /\bfrom\s+pickup_manifest\b/.test(query.sql));
  expect(listing, 'the statements it ran').toHaveLength(1);
  const { sql, params } = listing[0] as { sql: string; params: unknown[] };
  return { sql, params, received };
}

/** A hub that no session of these tests reaches, and the identifier of no hub at all. */
const OUTSIDE = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e0b';
const NOBODY = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e0f';

/** The value frozen all the way down, so that a service that changes it in place is refused by the language and not left to a comparison. */
function frozen<T extends object>(value: T): T {
  for (const member of Object.values(value) as unknown[]) {
    if (typeof member === 'object' && member !== null && !(member instanceof Date)) frozen(member);
  }
  return Object.freeze(value);
}

/**
 * What the guard decided for a staff session whose grant of `pickup.read` is `hubScope` (the hubs of the session, `HUB` alone, or every hub):
 * frozen, and its own object each time it is asked for.
 */
const decided = (hubScope: 'own' | 'all' = 'own'): AuthorizedRequest =>
  frozen({
    session: {
      id: '33333333-3333-4333-8333-333333333333',
      principalType: 'STAFF',
      principalId: '11111111-1111-4111-8111-111111111111',
      authority: {
        snapshot: {
          grants: [{ permission: 'pickup.read', hubScope, ownershipScope: 'any', tier: 'A' }],
        },
        authorizedHubIds: [HUB],
      },
    },
    credential: 'COOKIE',
    idleMinutes: 30,
    judgedAt: new Date('2026-11-06T09:00:00.000Z'),
    permission: 'pickup.read',
    grant: { permission: 'pickup.read', hubScope, ownershipScope: 'any', tier: 'A' },
    scope:
      hubScope === 'all'
        ? { hubScopeMode: 'ALL', authorizedHubIds: [] }
        : { hubScopeMode: 'SET', authorizedHubIds: [HUB] },
    activity: 'qualifying',
    stateChanging: false,
  }) as unknown as AuthorizedRequest;

describe('the statement of the manifest list, with a hub (task C3)', () => {
  // Break caught: a service (or a controller) that builds another authorization from the filter and hands that to the runner: a scope narrowed to the
  // hub named (the same pages, so that no test of the consequences sees it) or widened to every hub (a hub outside the session's hubs then reads
  // the runs of another, `GBT-GS14`). The hub is a parameter of the statement and never of the authorization, so the runner is handed the very
  // object the guard decided (identity, not equality), whatever hub is named: one the session's grant holds and none; and, for a grant of every
  // hub, one the session has never heard of and one that names no hub (a set-grant session is not handed to the runner for a hub outside its hubs
  // at all: task A1, below).
  it.each([
    ['no hub', 'own', {}],
    ['a hub inside the session’s hubs', 'own', { hubId: HUB }],
    ['a hub inside the session’s hubs, in capitals', 'own', { hubId: HUB.toUpperCase() }],
    ['no hub, with a grant of every hub', 'all', {}],
    ['a hub no hub-set reaches, with a grant of every hub', 'all', { hubId: OUTSIDE }],
    ['the identifier of no hub, with a grant of every hub', 'all', { hubId: NOBODY }],
  ] as const)(
    'hands the runner the very authorization it was given, for %s',
    async (_which, hubScope, filter) => {
      const authorized = decided(hubScope);

      const { received } = await listStatement('STAFF', filter, authorized);

      expect(received).toHaveLength(1);
      expect(received[0]).toBe(authorized);
    },
  );

  // Break caught (task A1, `AC-HUBF-05`, `GBT-GS14`): the hub filter run as a statement for a hub the staff session's grant does not reach, so that the
  // database walks that hub's index (20,000 runs took 77 milliseconds, 200,000 requests 0.7 seconds) before row-level security discards every row,
  // and the time tells a caller whether the hub exists and how much it holds; or the shortcut judged on the text of the identifier (a hub in capitals
  // is the same hub). A hub outside the set, one that names no hub and the same in capitals never reach the runner, so no transaction is opened and no
  // statement is given to the driver, and the answer is the empty page the statement would have returned.
  it.each([
    ['a hub outside the session’s hubs', { hubId: OUTSIDE }],
    ['a hub outside the session’s hubs, in capitals', { hubId: OUTSIDE.toUpperCase() }],
    ['the identifier of no hub', { hubId: NOBODY }],
    [
      'a hub outside the hubs, beside every other filter',
      {
        hubId: OUTSIDE,
        state: 'DISPATCHED',
        serviceDate: '2031-06-02',
        pageSize: 7,
        pageToken: encodePageToken({
          createdAt: '2026-11-03 10:00:00+00',
          id: '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e02',
        }),
      },
    ],
  ])(
    'answers %s with the empty page, opening no transaction and running no statement',
    async (_which, filter) => {
      const { answer, statements, received } = await attempt('STAFF', filter, decided('own'));

      expect(answer).toEqual({ items: [], next_page_token: null });
      expect(received, 'the runner was not asked').toEqual([]);
      expect(statements, 'no statement was given to the driver').toEqual([]);
    },
  );

  // Break caught: the shortcut taken for a Rider, whose runs are scoped by assignment and not by a hub (the hubs of its grant, here none, say nothing
  // about its runs: an empty page on that would hide the runs assigned to it).
  it('does not take the shortcut for a rider, whose hubs say nothing of its runs', async () => {
    const { received, statements } = await attempt('RIDER', { hubId: OUTSIDE });

    expect(received).toHaveLength(1);
    expect(statements.length).toBeGreaterThan(0);
  });

  // Break caught: a shortcut that answers a hub outside the set before the other filters are judged, so that a request the contract refuses is
  // answered `200` with an empty page when its hub happens to be outside the grant, and the same request is a `400` for a hub inside it.
  it.each([
    ['a position that is not one', { hubId: OUTSIDE, pageToken: 'not-a-position' }, '/page_token'],
    ['a state that is not one', { hubId: OUTSIDE, state: 'NOPE' }, '/state'],
    ['a day that does not exist', { hubId: OUTSIDE, serviceDate: '2031-02-30' }, '/service_date'],
    ['a page size of zero', { hubId: OUTSIDE, pageSize: 0 }, '/page_size'],
  ])(
    'still refuses %s, beside a hub outside the session’s hubs, before it answers',
    async (_what, filter, pointer) => {
      const error = await attempt('STAFF', filter, decided('own')).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(ApiException);
      expect((error as ApiException).details).toMatchObject({ violations: [{ pointer }] });
    },
  );

  // Break caught: a hub that is judged and never used (the list returns every hub's runs for the hub it was asked for), a hub compared with another
  // column, or one that never reaches the statement of a kind of reader (a rider's list is the runs assigned to it, and the hub narrows inside them).
  it.each([
    ['a staff session', 'STAFF'],
    ['a rider session', 'RIDER'],
  ] as const)('gives the statement the hub it was asked for, for %s', async (_who, principal) => {
    const query = await listStatement(principal, { hubId: HUB });

    expect(boundTo(query, 'responsible_hub_id', 'uuid')).toEqual([HUB]);
  });

  // Break caught (task A1): the Rider's own assignment left out of its statement, so that the database starts from the hub's index and discards the
  // runs of every other rider (77 milliseconds for a foreign hub of 20,000 runs, against microseconds for a hub that does not exist); or named for a
  // caller whose runs are not assigned (a staff session reads every run of its hubs). The rider is the context's own function, the one the policy
  // applies: nothing the request supplied is in it.
  it.each([
    ['a rider', 'RIDER', true],
    ['a staff session', 'STAFF', false],
  ] as const)(
    'names the assignment in the statement of %s only if it is a rider',
    async (_who, principal, named) => {
      for (const filter of [{}, { hubId: HUB }] as const) {
        const query = await listStatement(principal, filter);

        const owns = /\bassigned_rider_id\s*=\s*melarc\.current_rider_id\(\)/.test(query.sql);
        expect(owns, JSON.stringify(filter)).toBe(named);
      }
    },
  );

  // Break caught: a text comparison, which an identifier written in capitals would not match: the hub is bound as it was sent and the statement's
  // own cast reads it (an identifier is the same hub in either case).
  it('binds a hub written in capitals to the comparison that casts it to a uuid', async () => {
    const query = await listStatement('STAFF', { hubId: HUB.toUpperCase() });

    expect(
      boundTo(query, 'responsible_hub_id', 'uuid').map((value) => String(value).toLowerCase()),
    ).toEqual([HUB]);
  });

  // Break caught: a hub taken from somewhere when none was asked for (a default, the session's own), or a condition that is not the null the
  // comparison ignores: with no hub the list is the runs of every hub the reader may read.
  it('gives the statement no hub when none was asked for', async () => {
    const query = await listStatement('STAFF', {});

    expect(boundTo(query, 'responsible_hub_id', 'uuid')).toEqual([null]);
  });

  // Break caught: the hub lost from a page after the first (a statement rebuilt from the position alone), or a hub that takes the place of
  // another filter's value: each filter is bound where its own condition is, and the position is as it was given.
  it('gives the statement the hub, the state, the day and the position, each bound where its own condition is', async () => {
    const createdAt = '2026-11-03 10:00:00+00';
    const after = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e02';
    const query = await listStatement('STAFF', {
      hubId: HUB,
      state: 'DISPATCHED',
      serviceDate: '2031-06-02',
      pageToken: encodePageToken({ createdAt, id: after }),
    });

    expect(boundTo(query, 'responsible_hub_id', 'uuid')).toEqual([HUB]);
    expect(boundTo(query, 'state', 'text')).toEqual(['DISPATCHED']);
    expect(boundTo(query, 'service_date', 'date')).toEqual(['2031-06-02']);
    expect(query.sql).toMatch(/\(created_at, id\) > \(\$\d+::timestamptz, \$\d+::uuid\)/);
    expect(query.params).toContain(createdAt);
    expect(query.params).toContain(after);
  });
});
