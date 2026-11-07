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
import { PickupRequestsService, type PickupListFilter } from './pickup-requests.service.js';

/**
 * The hub of the list of pickup requests (task C3; `AC-HUBF-01`, `-06`, `-07`, `-12`; features/operations/hub-filters.md), on fakes: what the
 * list refuses before it reads anything, and what it gives the database to run. The contract's validation answers a hub that is not an
 * identifier first, on the route (the database tests prove the answer a client sees); the service states it again because it is the one place that
 * knows what a filter may hold, and a read that trusted its caller to have checked would hand a bad value to a statement, where `::uuid` fails as
 * a defect and not as a validation failure. The route tests see only what comes back, and a hub that was judged and then not used would come back
 * as the requests of every hub: so the statement is read as the driver is given it, its text and the values bound to its placeholders.
 */
const AUDIT = {} as AuditWriter;

/** A hub as the contract writes one, with letters in it so that its capitals are another text. */
const HUB = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01';
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

type Principal = 'STAFF' | 'VENDOR' | 'RIDER';

/**
 * What the guard decided, in the little these tests need: who asks, and the scope of the grant. A staff grant reaches the one hub `HUB`; a Vendor's
 * and a Rider's reach none, because their rows are scoped by what they own and not by a hub (task A1: a hub is no reason to answer them empty).
 */
const asked = (principalType: Principal): AuthorizedRequest =>
  ({
    session: { principalType, principalId: '11111111-1111-4111-8111-111111111111' },
    scope: {
      hubScopeMode: 'SET',
      authorizedHubIds: principalType === 'STAFF' ? [HUB] : [],
    },
  }) as unknown as AuthorizedRequest;

/** A runner that notes that a read was attempted and answers an empty page, so that a refusal can be told from a read that went ahead. */
function service(): { readonly requests: PickupRequestsService; readonly reads: () => number } {
  let reads = 0;
  const runner = {
    read: () => {
      reads += 1;
      return Promise.resolve({ items: [], next_page_token: null });
    },
  } as unknown as Pick<OperationRunner, 'read'>;
  return { requests: new PickupRequestsService({ runner, audit: AUDIT }), reads: () => reads };
}

const refusal = async (filter: PickupListFilter, principal: Principal = 'STAFF') => {
  const { requests, reads } = service();
  const error = await requests.list(asked(principal), 'correlation', filter).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(reads(), 'no statement was attempted').toBe(0);
  return error;
};

describe('the request list refuses a hub that is not one, before it reads', () => {
  // Break caught: a hub taken on trust and handed to a statement (an identifier that is not one fails there as a defect), an empty value read as
  // "no hub" (a check on truthiness), or a refusal that names another parameter (task C3, `AC-HUBF-07`).
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
      state: 'CONFIRMED',
      serviceDate: '2026-11-03',
      manifested: 'false',
      exceptionState: 'REQUESTED',
      cutoffExceptionState: 'PENDING_OPS_REVIEW',
      hubId: 'not-a-uuid',
    });

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).details).toEqual({
      violations: [{ in: 'query', pointer: '/hub_id', rule: 'format' }],
    });
  });

  // Break caught: a hub that is refused to a vendor as `manifested` is (it reads the stops it may not see; the hub reads nothing it may not,
  // `responsible_hub_id` being in every request it is shown), or ignored for it without a word: it narrows what it is shown. (A rider is not served the
  // reads at all since task A3.1: see the refusal tests at the end of this file.)
  it('does not refuse a hub to a vendor, and reads', async () => {
    const { requests, reads } = service();

    await expect(requests.list(asked('VENDOR'), 'correlation', { hubId: HUB })).resolves.toEqual({
      items: [],
      next_page_token: null,
    });
    expect(reads()).toBe(1);
  });

  // Break caught: the value of the hub judged for staff alone, so that a value that is not an identifier reaches the statement of a vendor: the answer is
  // the same for everyone (only the staff-only filter is `PERMISSION_DENIED`, and before its value is judged).
  it('refuses a hub that is not one to a vendor as it does to staff', async () => {
    const error = await refusal({ hubId: 'not-a-uuid' }, 'VENDOR');

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('VALIDATION_FAILED');
    expect((error as ApiException).details).toEqual({
      violations: [{ in: 'query', pointer: '/hub_id', rule: 'format' }],
    });
  });

  // Break caught: a refusal that is too wide, which would turn a hub that is one (in either case) into a 400, or lose the filters beside it.
  it.each([
    ['a hub', { hubId: HUB }],
    ['a hub in capitals (the same hub)', { hubId: HUB.toUpperCase() }],
    ['a hub and a state', { hubId: HUB, state: 'PENDING' }],
    [
      'a hub with every other filter',
      {
        hubId: HUB,
        state: 'CONFIRMED',
        serviceDate: '2026-11-03',
        manifested: 'false',
        exceptionState: 'REQUESTED',
        cutoffExceptionState: 'PENDING_OPS_REVIEW',
      },
    ],
  ])('goes on to read with %s', async (_what, filter) => {
    const { requests, reads } = service();

    await expect(requests.list(asked('STAFF'), 'correlation', filter)).resolves.toEqual({
      items: [],
      next_page_token: null,
    });
    expect(reads()).toBe(1);
  });
});

const dialect = new PgDialect();

const CONTEXT: SecurityContext = {
  principalType: 'STAFF',
  principalId: '11111111-1111-4111-8111-111111111111',
  surface: 'OPS_PORTAL',
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'correlation',
};

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
 * A list asked as `principal` (with the authorization given, or a bare one) with `filter`, on fakes: what it answered, every statement it gave the
 * driver (text and bound values), and the authorizations the runner was handed, in the order it was handed them. A read that never reached the
 * runner has none of the last two, which is how a read that opened no transaction is told from one that opened it and found nothing.
 */
async function attempt(
  principal: Principal,
  filter: PickupListFilter,
  authorized: AuthorizedRequest = asked(principal),
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
  const requests = new PickupRequestsService({ runner, audit: AUDIT });

  const answer = await requests.list(authorized, 'correlation', filter);
  return {
    answer,
    statements: statements.map((statement) => dialect.sqlToQuery(statement)),
    received,
  };
}

/**
 * The statement that selects the page of requests, as the driver is given it, for a list asked as `principal` (with the authorization given, or a
 * bare one) with `filter`, and the authorizations the runner was handed, in the order it was handed them.
 */
async function listStatement(
  principal: Principal,
  filter: PickupListFilter,
  authorized: AuthorizedRequest = asked(principal),
): Promise<{
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly received: readonly AuthorizedRequest[];
}> {
  const { answer, statements, received } = await attempt(principal, filter, authorized);
  expect(answer).toEqual({ items: [], next_page_token: null });
  const listing = statements.filter((query) => /\border by created_at, id\b/.test(query.sql));
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

describe('the statement of the request list, with a hub (task C3)', () => {
  // Break caught: a service (or a controller) that builds another authorization from the filter and hands that to the runner: a scope narrowed to the
  // hub named (the same pages, so that no test of the consequences sees it) or widened to every hub (a hub outside the session's hubs then reads
  // the requests of another, `GBT-GS14`). The hub is a parameter of the statement and never of the authorization, so the runner is handed the very
  // object the guard decided (identity, not equality), whatever hub is named: one the session's grant holds and none; and, for a grant of every
  // hub, one the session has never heard of and one that names no hub (a set-grant session is not handed to the runner for a hub outside its
  // hubs at all: task A1, below).
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
  // database walks that hub's index (200,000 rows took 0.7 to 0.9 seconds) before row-level security discards every row, and the time tells a caller
  // whether the hub exists and how much it holds; or the shortcut judged on the hub of another key, of the session's widest grant, or on the text of
  // the identifier (a hub in capitals is the same hub). A hub outside the set, one that names no hub and the same in capitals never reach the runner,
  // so no transaction is opened and no statement is given to the driver, and the answer is the empty page the statement would have returned.
  it.each([
    ['a hub outside the session’s hubs', { hubId: OUTSIDE }],
    ['a hub outside the session’s hubs, in capitals', { hubId: OUTSIDE.toUpperCase() }],
    ['the identifier of no hub', { hubId: NOBODY }],
    [
      'a hub outside the hubs, beside every other filter',
      {
        hubId: OUTSIDE,
        state: 'CONFIRMED',
        serviceDate: '2026-11-03',
        manifested: 'false',
        exceptionState: 'REQUESTED',
        cutoffExceptionState: 'PENDING_OPS_REVIEW',
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

  // Break caught: the shortcut taken for the caller it is not for (a Vendor's rows are scoped by what it owns, and the hubs of its grant say nothing about
  // it: here they reach none, and a read answered empty on that would hide its own requests), or a validation skipped for it (a value that is not a hub is
  // still refused first, below, and so is every other filter).
  it('does not take the shortcut for a vendor, whose hubs say nothing of its rows', async () => {
    const { received, statements } = await attempt('VENDOR', { hubId: OUTSIDE });

    expect(received).toHaveLength(1);
    expect(statements.length).toBeGreaterThan(0);
  });

  // Break caught: a shortcut that answers a hub outside the set before the other filters are judged, so that a request the contract refuses (a hub
  // that is not one, a filter that is not one) is answered `200` with an empty page when its hub happens to be outside the grant, and the same
  // request is a `400` for a hub inside it.
  it.each([
    ['a position that is not one', { hubId: OUTSIDE, pageToken: 'not-a-position' }, '/page_token'],
    ['a day that does not exist', { hubId: OUTSIDE, serviceDate: '2031-02-30' }, '/service_date'],
    [
      'an exception state that is not one',
      { hubId: OUTSIDE, exceptionState: 'NOPE' },
      '/one_package_exception_state',
    ],
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

  // Break caught: a hub that is judged and never used (the list returns every hub's requests for the hub it was asked for), compared with
  // another column, or one that never reaches the statement of a kind of reader (a vendor's list is its organisation's requests, across hubs,
  // and the hub narrows inside them).
  it.each([
    ['a staff session', 'STAFF'],
    ['a vendor session', 'VENDOR'],
  ] as const)('gives the statement the hub it was asked for, for %s', async (_who, principal) => {
    const query = await listStatement(principal, { hubId: HUB });

    expect(boundTo(query, 'responsible_hub_id', 'uuid')).toEqual([HUB]);
  });

  // Break caught (task A1): the Vendor's own organisation left out of its statement, so that the database starts from the hub's index and discards the
  // rows of every other vendor (0.4 seconds for a foreign hub of 200,000 requests, against microseconds for a hub that does not exist); or named for a
  // caller whose rows are not a Vendor's (a staff session reads every request of its hubs, and `vendor_organization_id` means nothing to it). The
  // organisation is the context's own function, the one the policy applies: nothing the request supplied is in it.
  it.each([
    ['a vendor', 'VENDOR', true],
    ['a staff session', 'STAFF', false],
  ] as const)(
    'names the organisation in the statement of %s only if it is a vendor',
    async (_who, principal, named) => {
      // A hub outside the grant is no statement at all for a staff session (above), so it is asked of the callers that are read as before.
      const filters =
        principal === 'STAFF' ? [{}, { hubId: HUB }] : [{}, { hubId: HUB }, { hubId: OUTSIDE }];
      for (const filter of filters) {
        const query = await listStatement(principal, filter);

        const owns =
          /\bvendor_organization_id\s*=\s*melarc\.current_vendor_organization_id\(\)/.test(
            query.sql,
          );
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

  // Break caught: a hub taken from somewhere when none was asked for (a default, the session's own), or a condition on the hub that is written when
  // none is asked for (the criteria add no condition for a filter that is not asked for): with no hub the list is the requests of every hub the
  // reader may read.
  it('gives the statement no condition on the hub when none was asked for', async () => {
    const query = await listStatement('STAFF', {});

    expect(boundTo(query, 'responsible_hub_id', 'uuid')).toEqual([]);
  });

  // Break caught: the hub lost from a page after the first (a statement rebuilt from the position alone), or a hub that takes the place of
  // another filter's value: each filter is bound where its own condition is, and the position is as it was given.
  it('gives the statement the hub, the other filters and the position, each bound where its own condition is', async () => {
    const createdAt = '2026-11-03 10:00:00+00';
    const after = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e02';
    const query = await listStatement('STAFF', {
      hubId: HUB,
      state: 'CONFIRMED',
      serviceDate: '2026-11-03',
      cutoffExceptionState: 'PENDING_OPS_REVIEW',
      pageToken: encodePageToken({ createdAt, id: after }),
    });

    expect(boundTo(query, 'responsible_hub_id', 'uuid')).toEqual([HUB]);
    expect(boundTo(query, 'state', 'text')).toEqual(['CONFIRMED']);
    expect(boundTo(query, 'scheduled_service_date', 'date')).toEqual(['2026-11-03']);
    expect(boundTo(query, 'cutoff_exception_state', 'text')).toEqual(['PENDING_OPS_REVIEW']);
    expect(query.sql).toMatch(/\(created_at, id\) > \(\$\d+::timestamptz, \$\d+::uuid\)/);
    expect(query.params).toContain(createdAt);
    expect(query.params).toContain(after);
  });

  // Break caught: the hub dropped when the filter of the approver's queue or the pool is asked for (these build their conditions along other
  // paths: the exception filter starts from the exceptions in a state, the pool adds a rule of its own), so that the hub narrows the plain list
  // and not the queues the counts are of.
  it.each([
    ['the approver’s queue', { exceptionState: 'REQUESTED' }],
    ['the pool', { state: 'CONFIRMED', manifested: 'false' }],
    ['the requests on a run', { manifested: 'true' }],
  ])('gives the statement the hub beside the filter of %s', async (_which, others) => {
    const query = await listStatement('STAFF', { ...others, hubId: HUB });

    expect(boundTo(query, 'responsible_hub_id', 'uuid')).toEqual([HUB]);
  });
});

describe('a Rider is not served the two reads (task A3.1 of the audit follow-up, AC-HUBF-15)', () => {
  // Break caught: a Rider's authorization reaching the statement of the list (the routes refuse its bearer before this runs, and a service that answers about
  // records does not rely on that alone), or judged first, so that what it asks decides the answer: whatever it asks, with a hub, with a hub that is not one,
  // or with the filter that is staff's alone, the answer is the one refusal and nothing is read.
  it.each([
    ['no filter', {}],
    ['a hub', { hubId: HUB }],
    ['a hub that is not one', { hubId: 'not-a-uuid' }],
    ['the filter that is staff’s alone', { manifested: 'false' }],
  ])(
    'refuses the list for a rider with %s, PERMISSION_DENIED, and reads nothing',
    async (_what, filter) => {
      const error = await refusal(filter, 'RIDER');

      expect(error).toBeInstanceOf(ApiException);
      expect((error as ApiException).code).toBe('PERMISSION_DENIED');
      expect((error as ApiException).getStatus()).toBe(403);
    },
  );

  // Break caught: the read of one request answered for a Rider (the registry gives it no pickup request, so the database would answer `NOT_FOUND`, which is
  // the answer of a record that is not there and not the refusal of a read it is not served).
  it('refuses the read of one request for a rider, PERMISSION_DENIED, and reads nothing', async () => {
    const { requests, reads } = service();

    const error = await requests
      .get(asked('RIDER'), 'correlation', '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e0c')
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('PERMISSION_DENIED');
    expect(reads()).toBe(0);
  });
});
