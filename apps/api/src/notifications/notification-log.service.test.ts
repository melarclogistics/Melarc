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
import { NotificationLogService } from './notification-log.service.js';
import { encodePageToken } from './notification-page-token.js';

/**
 * What the Ops message log refuses before it reads anything (S1.12e). The contract's validation answers most of these first, on the
 * route; the service states them again because it is the one place that knows what a filter may hold, and a read that trusted its caller
 * to have checked would pass a bad value on to a statement. The route test proves the answer a client sees; this proves the refusal.
 */
const AUTHORIZED = {} as AuthorizedRequest;
const AUDIT = {} as AuditWriter;

/** A hub as the contract writes one (task C3: `hub_id`, beside `subject_id` and the others), with letters in it so that its capitals are another text. */
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

/** A runner that fails the test if a read is attempted, or notes that it was and answers an empty page. */
function service(): { readonly log: NotificationLogService; readonly reads: () => number } {
  let reads = 0;
  const runner = {
    read: () => {
      reads += 1;
      return Promise.resolve({ items: [], next_page_token: null });
    },
  } as unknown as Pick<OperationRunner, 'read'>;
  return { log: new NotificationLogService({ runner, audit: AUDIT }), reads: () => reads };
}

const refusal = async (filter: Parameters<NotificationLogService['list']>[2]) => {
  const { log, reads } = service();
  const error = await log.list(AUTHORIZED, 'correlation', filter).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(reads(), 'no statement was attempted').toBe(0);
  return error;
};

describe('the Ops message log refuses what no filter may hold, before it reads', () => {
  // Break caught: a page size, a filter or a position taken on trust and handed to a statement.
  it.each([
    ['a page size of zero', { pageSize: 0 }, '/page_size'],
    ['a negative page size', { pageSize: -1 }, '/page_size'],
    ['a page size over the maximum', { pageSize: 101 }, '/page_size'],
    ['a page size that is not whole', { pageSize: 1.5 }, '/page_size'],
    ['a page size that is not a number', { pageSize: Number.NaN }, '/page_size'],
    ['a state that is not one', { state: 'SENDING' }, '/state'],
    ['a lower-case state', { state: 'queued' }, '/state'],
    ['an empty state', { state: '' }, '/state'],
    ['an audience that is not one', { audience: 'EVERYONE' }, '/audience'],
    ['a channel that is not one', { channel: 'PUSH' }, '/channel'],
    ['a subject that is not an id', { subjectId: 'not-a-uuid' }, '/subject_id'],
    ['a position that is not one', { pageToken: 'not-a-position' }, '/page_token'],
  ])('refuses %s', async (_what, filter, pointer) => {
    const error = await refusal(filter);
    expect(error).toBeInstanceOf(ApiException);
    const refused = error as ApiException;
    expect(refused.code).toBe('VALIDATION_FAILED');
    expect(refused.getStatus()).toBe(400);
    expect(refused.details).toMatchObject({ violations: [{ in: 'query', pointer }] });
  });

  // Break caught: a hub taken on trust and handed to a statement (an identifier that is not one fails there as a defect, and not as the validation
  // failure the other filters give), an empty value read as "no hub", or a refusal that names another parameter, `subject_id` among them: the
  // log has two filters that are identifiers, and each is judged by its own name (task C3, `AC-HUBF-07`).
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

  // Break caught: a hub judged only when it stands alone, so that a bad one beside filters that are good is read on, or one that is read as the
  // subject's (the two are both identifiers, and a refusal must name the one that is not).
  it('refuses a hub that is not one beside filters that are, and names it and not the subject', async () => {
    const error = await refusal({
      state: 'SUPPRESSED',
      audience: 'AD_HOC_SENDER',
      channel: 'SMS',
      subjectId: '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e03',
      hubId: 'not-a-uuid',
    });
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).details).toEqual({
      violations: [{ in: 'query', pointer: '/hub_id', rule: 'format' }],
    });
  });

  // Break caught: a subject refused as a hub, or a hub refused as a subject: the one that is bad is the one named, whichever it is.
  it('names the subject, and not the hub, when the subject is the one that is not an identifier', async () => {
    const error = await refusal({ subjectId: 'not-a-uuid', hubId: HUB });
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).details).toEqual({
      violations: [{ in: 'query', pointer: '/subject_id', rule: 'format' }],
    });
  });

  // Break caught: a refusal that is too wide, which would turn a hub that is one (in either case) into a 400, or lose the other filters beside it.
  it.each([
    ['a hub', { hubId: HUB }],
    ['a hub in capitals (the same hub)', { hubId: HUB.toUpperCase() }],
    [
      'a hub with every other filter',
      {
        state: 'SUPPRESSED',
        audience: 'AD_HOC_SENDER',
        channel: 'SMS',
        subjectId: '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e03',
        hubId: HUB,
      },
    ],
  ])('goes on to read with %s', async (_what, filter) => {
    const { log, reads } = service();
    await expect(log.list(AUTHORIZED, 'correlation', filter)).resolves.toEqual({
      items: [],
      next_page_token: null,
    });
    expect(reads()).toBe(1);
  });

  // Break caught: a refusal that is too wide, which would turn a legitimate filter into a 400.
  it.each([
    ['no filter at all', {}],
    ['the largest page', { pageSize: 100 }],
    ['the smallest page', { pageSize: 1 }],
    [
      'every filter at once',
      {
        state: 'SUPPRESSED',
        audience: 'AD_HOC_SENDER',
        channel: 'SMS',
        subjectId: '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01',
      },
    ],
    [
      'a position a page made',
      {
        pageToken: encodePageToken({
          createdAt: '2026-10-28 10:00:00+00',
          id: '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01',
        }),
      },
    ],
  ])('goes on to read with %s', async (_what, filter) => {
    const { log, reads } = service();
    await expect(log.list(AUTHORIZED, 'correlation', filter)).resolves.toEqual({
      items: [],
      next_page_token: null,
    });
    expect(reads()).toBe(1);
  });
});

/**
 * What the log gives the database to run when it is given a hub (task C3; `AC-HUBF-03`, `-06`). The route tests see what comes back, and a hub
 * that was judged and then not used, or compared with the wrong column, would come back as the messages of every hub, or of none: so the
 * statement is read here as the driver is given it, its text and the values bound to its placeholders. The log has no criteria function and no
 * count: its statement is written in the service, and these are the only tests that see it as text.
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

const STAFF = {
  session: { principalType: 'STAFF', principalId: '11111111-1111-4111-8111-111111111111' },
} as unknown as AuthorizedRequest;

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
 * The values the two placeholders of `($n::uuid is null or <column> = $m::uuid)` are bound to: the guard's and the comparison's. Both are the filter
 * when it is asked for and both are null when it is not; a guard bound to another filter's value (the log has two filters that are identifiers) lets the
 * condition through, or shuts it, for a reason that is not the hub's.
 */
function guarded(
  query: { readonly sql: string; readonly params: readonly unknown[] },
  column: string,
): unknown[] {
  const condition = new RegExp(
    `\\(\\$(\\d+)::uuid\\s+is\\s+null\\s+or\\s+${column}\\s*=\\s*\\$(\\d+)::uuid\\)`,
    'g',
  );
  return [...query.sql.matchAll(condition)].flatMap((match) => [
    query.params[Number(match[1]) - 1],
    query.params[Number(match[2]) - 1],
  ]);
}

/**
 * The statement that selects the page of messages, as the driver is given it, for a list asked with `filter` (by the authorization given, or a bare
 * staff one), and the authorizations the runner was handed, in the order it was handed them.
 */
async function listStatement(
  filter: Parameters<NotificationLogService['list']>[2],
  authorized: AuthorizedRequest = STAFF,
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
  const log = new NotificationLogService({ runner, audit: AUDIT });

  await expect(log.list(authorized, 'correlation', filter)).resolves.toEqual({
    items: [],
    next_page_token: null,
  });
  const queries = statements.map((statement) => dialect.sqlToQuery(statement));
  const listing = queries.filter((query) => /\bfrom\s+notification\b/.test(query.sql));
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

/** What the guard decided for a staff session whose grant of `notification.read` reaches one hub, `HUB`: frozen, and its own object each time it is asked for. */
const decided = (): AuthorizedRequest =>
  frozen({
    session: {
      id: '33333333-3333-4333-8333-333333333333',
      principalType: 'STAFF',
      principalId: '11111111-1111-4111-8111-111111111111',
      authority: {
        snapshot: {
          grants: [
            { permission: 'notification.read', hubScope: 'own', ownershipScope: 'any', tier: 'A' },
          ],
        },
        authorizedHubIds: [HUB],
      },
    },
    credential: 'COOKIE',
    idleMinutes: 30,
    judgedAt: new Date('2026-11-06T09:00:00.000Z'),
    permission: 'notification.read',
    grant: { permission: 'notification.read', hubScope: 'own', ownershipScope: 'any', tier: 'A' },
    scope: { hubScopeMode: 'SET', authorizedHubIds: [HUB] },
    activity: 'qualifying',
    stateChanging: false,
  }) as unknown as AuthorizedRequest;

/**
 * The words that join the conditions of the `where` clause to each other at its top level (outside every parenthesis), in the order they stand. The
 * log writes its conditions in the service and not in a function of their own, so this is where the "and" of the hub with the other filters is seen:
 * a hub joined by an `or` would keep every message the other filters admit, or all of those the hub names, and no value bound to a placeholder shows it.
 */
function joiners(text: string): string[] {
  const clause = text.slice(text.search(/\bwhere\b/i) + 'where'.length);
  const found: string[] = [];
  let depth = 0;
  for (let at = 0; at < clause.length; at += 1) {
    const character = clause[at];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (depth === 0 && /\s/.test(clause[at - 1] ?? '')) {
      const word = /^(and|or)\b/i.exec(clause.slice(at));
      if (word?.[1] !== undefined) {
        found.push(word[1].toLowerCase());
        at += word[0].length - 1;
      }
    }
  }
  return found;
}

describe('the statement of the message log, with a hub (task C3)', () => {
  // Break caught: a service (or a controller) that builds another authorization from the filter and hands that to the runner: a scope narrowed to the
  // hub named (the same pages, so that no test of the consequences sees it) or widened to every hub (a hub outside the session's hubs then reads
  // the messages of another, `GBT-GS14`). The hub is a parameter of the statement and never of the authorization, so the runner is handed the very
  // object the guard decided (identity, not equality), whatever hub is named: one the session reaches, one it does not, and one that names no hub.
  it.each([
    ['no hub', {}],
    ['a hub inside the session’s hubs', { hubId: HUB }],
    ['a hub outside the session’s hubs', { hubId: OUTSIDE }],
    ['the identifier of no hub', { hubId: NOBODY }],
  ])('hands the runner the very authorization it was given, for %s', async (_which, filter) => {
    const authorized = decided();

    const { received } = await listStatement(filter, authorized);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(authorized);
  });

  // Break caught: the hub joined to the other filters by an `or` instead of an `and`, which keeps every message that the other filters admit, or
  // all of the hub's, and not the messages of the hub that the filters admit (`AC-HUBF-03`: "and" with state, audience, channel and subject).
  it('joins the hub to the other conditions with and, as it joins each of them, and never with or', async () => {
    const query = await listStatement({
      hubId: HUB,
      state: 'SUPPRESSED',
      audience: 'AD_HOC_SENDER',
      channel: 'SMS',
      subjectId: '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e03',
      pageToken: encodePageToken({
        createdAt: '2026-10-28 10:00:00+00',
        id: '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e02',
      }),
    });

    // Six conditions (state, audience, channel, subject, hub, position), five joints, every one an `and`.
    expect(joiners(query.sql)).toEqual(['and', 'and', 'and', 'and', 'and']);
  });

  // Break caught: a hub that is judged and never used (the log returns every hub's messages for the hub it was asked for), or compared with the
  // wrong column (a message has its record's id and its hub, and a filter on the subject instead of the hub finds a record and not a hub).
  it('gives the statement the hub it was asked for, compared with the hub of the message', async () => {
    const query = await listStatement({ hubId: HUB });

    expect(guarded(query, 'responsible_hub_id')).toEqual([HUB, HUB]);
    expect(guarded(query, 'subject_id')).toEqual([null, null]);
  });

  // Break caught: the hub and the subject swapped, merged, or one taken for the other (they are both identifiers, bound in the same form): each is
  // bound where its own condition is, the two together are an "and", and a subject of one hub with the filter of another is an empty page, which
  // only two conditions can say.
  it('binds the hub and the subject each to its own condition when both are given', async () => {
    const subject = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e03';
    const query = await listStatement({ hubId: HUB, subjectId: subject });

    expect(guarded(query, 'responsible_hub_id')).toEqual([HUB, HUB]);
    expect(guarded(query, 'subject_id')).toEqual([subject, subject]);
  });

  // Break caught: a text comparison, which an identifier written in capitals would not match: the hub is bound as it was sent and the statement's
  // own cast reads it (an identifier is the same hub in either case).
  it('binds a hub written in capitals to the comparison that casts it to a uuid', async () => {
    const query = await listStatement({ hubId: HUB.toUpperCase() });

    expect(
      guarded(query, 'responsible_hub_id').map((value) => String(value).toLowerCase()),
    ).toEqual([HUB, HUB]);
  });

  // Break caught: a hub taken from somewhere when none was asked for (a default, the session's own), or a condition that is not the null the
  // comparison ignores: with no hub the log is the messages of every hub the reader may read.
  it('gives the statement no hub when none was asked for', async () => {
    const query = await listStatement({});

    expect(guarded(query, 'responsible_hub_id')).toEqual([null, null]);
  });

  // Break caught: the hub lost from a page after the first (a statement rebuilt from the position alone), or a hub that takes the place of another
  // filter's value: each filter is bound where its own condition is, and the position is as it was given.
  it('gives the statement the hub, the other filters and the position, each bound where its own condition is', async () => {
    const createdAt = '2026-10-28 10:00:00+00';
    const after = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e02';
    const query = await listStatement({
      hubId: HUB,
      state: 'SUPPRESSED',
      audience: 'AD_HOC_SENDER',
      channel: 'SMS',
      pageToken: encodePageToken({ createdAt, id: after }),
    });

    expect(guarded(query, 'responsible_hub_id')).toEqual([HUB, HUB]);
    expect(boundTo(query, 'state', 'text')).toEqual(['SUPPRESSED']);
    expect(boundTo(query, 'audience', 'text')).toEqual(['AD_HOC_SENDER']);
    expect(boundTo(query, 'channel', 'text')).toEqual(['SMS']);
    expect(query.sql).toMatch(/\(created_at, id\) < \(\$\d+::timestamptz, \$\d+::uuid\)/);
    expect(query.params).toContain(createdAt);
    expect(query.params).toContain(after);
  });
});
