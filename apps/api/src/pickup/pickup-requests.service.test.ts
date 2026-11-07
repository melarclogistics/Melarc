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

const asked = (principalType: Principal): AuthorizedRequest =>
  ({
    session: { principalType, principalId: '11111111-1111-4111-8111-111111111111' },
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

  // Break caught: a hub that is refused to a vendor or a rider as `manifested` is (it reads the stops they may not see; the hub reads nothing they
  // may not, `responsible_hub_id` being in every request they are shown), or ignored for them without a word: it narrows what they are shown.
  it.each([
    ['a vendor', 'VENDOR'],
    ['a rider', 'RIDER'],
  ] as const)('does not refuse a hub to %s, and reads', async (_who, principal) => {
    const { requests, reads } = service();

    await expect(requests.list(asked(principal), 'correlation', { hubId: HUB })).resolves.toEqual({
      items: [],
      next_page_token: null,
    });
    expect(reads()).toBe(1);
  });

  // Break caught: the value of the hub judged for staff alone, so that a value that is not an identifier reaches the statement of a vendor or a
  // rider: the answer is the same for everyone (only the staff-only filter is `PERMISSION_DENIED`, and before its value is judged).
  it.each([
    ['a vendor', 'VENDOR'],
    ['a rider', 'RIDER'],
  ] as const)(
    'refuses a hub that is not one to %s as it does to staff',
    async (_who, principal) => {
      const error = await refusal({ hubId: 'not-a-uuid' }, principal);

      expect(error).toBeInstanceOf(ApiException);
      expect((error as ApiException).code).toBe('VALIDATION_FAILED');
      expect((error as ApiException).details).toEqual({
        violations: [{ in: 'query', pointer: '/hub_id', rule: 'format' }],
      });
    },
  );

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

  await expect(requests.list(authorized, 'correlation', filter)).resolves.toEqual({
    items: [],
    next_page_token: null,
  });
  const queries = statements.map((statement) => dialect.sqlToQuery(statement));
  const listing = queries.filter((query) => /\border by created_at, id\b/.test(query.sql));
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

/** What the guard decided for a staff session whose grant of `pickup.read` reaches one hub, `HUB`: frozen, and its own object each time it is asked for. */
const decided = (): AuthorizedRequest =>
  frozen({
    session: {
      id: '33333333-3333-4333-8333-333333333333',
      principalType: 'STAFF',
      principalId: '11111111-1111-4111-8111-111111111111',
      authority: {
        snapshot: {
          grants: [
            { permission: 'pickup.read', hubScope: 'own', ownershipScope: 'any', tier: 'A' },
          ],
        },
        authorizedHubIds: [HUB],
      },
    },
    credential: 'COOKIE',
    idleMinutes: 30,
    judgedAt: new Date('2026-11-06T09:00:00.000Z'),
    permission: 'pickup.read',
    grant: { permission: 'pickup.read', hubScope: 'own', ownershipScope: 'any', tier: 'A' },
    scope: { hubScopeMode: 'SET', authorizedHubIds: [HUB] },
    activity: 'qualifying',
    stateChanging: false,
  }) as unknown as AuthorizedRequest;

describe('the statement of the request list, with a hub (task C3)', () => {
  // Break caught: a service (or a controller) that builds another authorization from the filter and hands that to the runner: a scope narrowed to the
  // hub named (the same pages, so that no test of the consequences sees it) or widened to every hub (a hub outside the session's hubs then reads
  // the requests of another, `GBT-GS14`). The hub is a parameter of the statement and never of the authorization, so the runner is handed the very
  // object the guard decided (identity, not equality), whatever hub is named: one the session reaches, one it does not, and one that names no hub.
  it.each([
    ['no hub', {}],
    ['a hub inside the session’s hubs', { hubId: HUB }],
    ['a hub outside the session’s hubs', { hubId: OUTSIDE }],
    ['the identifier of no hub', { hubId: NOBODY }],
  ])('hands the runner the very authorization it was given, for %s', async (_which, filter) => {
    const authorized = decided();

    const { received } = await listStatement('STAFF', filter, authorized);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(authorized);
  });

  // Break caught: a hub that is judged and never used (the list returns every hub's requests for the hub it was asked for), compared with
  // another column, or one that never reaches the statement of a kind of reader (a vendor's list is its organisation's requests, across hubs,
  // and the hub narrows inside them).
  it.each([
    ['a staff session', 'STAFF'],
    ['a vendor session', 'VENDOR'],
    ['a rider session', 'RIDER'],
  ] as const)('gives the statement the hub it was asked for, for %s', async (_who, principal) => {
    const query = await listStatement(principal, { hubId: HUB });

    expect(boundTo(query, 'responsible_hub_id', 'uuid')).toEqual([HUB]);
  });

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
