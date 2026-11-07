import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { DatabaseTransaction } from '../platform/database/database.service.js';
import type { SecurityContext } from '../platform/database/transaction-context.js';
import { registerTransactionFacts } from '../platform/database/transaction-facts.js';
import { bindTransactionHandle } from '../platform/database/transaction-handle.js';
import { ANY_HUB, type QueueFilter } from '../platform/domain-ports/queue-counter.port.js';
import { STAFF_QUEUE_STATEMENT, staffQueueCounters } from './staff-queue-counter.adapter.js';

/**
 * The statement of the approver's queue of staff profiles, and the counter that runs it, with the hub of the filter (task C3; `AC-HUBF-04`,
 * `-06`; features/operations/hub-filters.md). The hub of a staff profile is its **primary hub** (`primary_hub_id`), as the staff list's own
 * `hub_id` reads it, and not the `responsible_hub_id` the pickup queues' records carry: a count that read the wrong column would not fail a
 * test that compared it with its list (both call one function), and would count a column that no profile has. The statement is read here as the
 * driver is given it: its text, and the values bound to its placeholders.
 */
const dialect = new PgDialect();

interface Rendered {
  readonly sql: string;
  readonly params: readonly unknown[];
}
const rendered = (statement: SQL): Rendered => {
  const { sql, params } = dialect.sqlToQuery(statement);
  return { sql, params };
};

/** What each comparison of `column` with a bound, `uuid`-cast value is bound to, in the order they stand in the text. */
function hubValues(query: Rendered, column: string): unknown[] {
  return [...query.sql.matchAll(new RegExp(`\\b${column}\\s*=\\s*\\$(\\d+)::uuid`, 'g'))].map(
    (match) => query.params[Number(match[1]) - 1],
  );
}

const CONTEXT: SecurityContext = {
  principalType: 'STAFF',
  principalId: '11111111-1111-4111-8111-111111111111',
  surface: 'OPS_PORTAL',
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'c3',
};

/** The one statement a count ran: a count is one statement, and a count that ran none or two is not the count this file reads. */
function onlyOf(statements: readonly SQL[]): SQL {
  const [only] = statements;
  if (only === undefined || statements.length !== 1) {
    throw new Error(`A count runs one statement; this one ran ${String(statements.length)}`);
  }
  return only;
}

/** A handle over a transaction that runs nothing and keeps each statement it is given, so that what the counter asks of the database can be read. */
function recording(): { readonly handle: TransactionHandle; readonly statements: SQL[] } {
  const statements: SQL[] = [];
  const transaction = {
    execute: (statement: SQL) => {
      statements.push(statement);
      return Promise.resolve({ rows: [{ count: 0, oldest: null }] });
    },
  } as unknown as DatabaseTransaction;
  registerTransactionFacts(transaction, {
    statementsSinceContext: () => statements.length,
    markContextApplied: () => undefined,
    appliedContext: () => CONTEXT,
  });
  return { handle: bindTransactionHandle(transaction), statements };
}

const HUB = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01';
/** A value that is not an identifier, and would break out of a statement written with it: the statement binds a hub and never writes it. */
const HOSTILE = `x' or '1'='1`;

describe('the statement of the approver’s queue of staff profiles', () => {
  // Break caught: a statement that ignores the filter it is given (the queue counts every hub's profiles while its list counts one's), a hub that
  // is compared with the wrong column (`responsible_hub_id` is the hub of a pickup record, and a profile has none), or a hub that is asked for and
  // never reaches the statement.
  it('counts the profiles of the primary hub it is given, bound to it', () => {
    const query = rendered(STAFF_QUEUE_STATEMENT({ hubId: HUB }));

    expect(query.sql).toMatch(/\bfrom\s+staff_identity\b/);
    expect(hubValues(query, 'primary_hub_id')).toEqual([HUB]);
    expect(query.sql).not.toMatch(/responsible_hub_id/);
    // The queue is still the profiles waiting for approval: the hub is a second condition and changes no state.
    expect(query.params).toContain('PENDING_APPROVAL');
  });

  // Break caught: a statement that writes the hub into its text (a hub that is not an identifier then breaks out of the statement), and not only
  // binds it.
  it('binds a hub and never writes it into the statement', () => {
    const query = rendered(STAFF_QUEUE_STATEMENT({ hubId: HOSTILE }));

    expect(query.params).toContain(HOSTILE);
    expect(query.sql).not.toContain(HOSTILE);
  });

  // Break caught: a condition on the hub that is not null-proof when no hub is asked for (a comparison with a value that is not null counts the
  // profiles of one hub and calls it the count of all, and would leave out a profile with no primary hub from the count with no hub, which is in it).
  it('binds no hub at all when none is asked for, so that it counts the profiles of every hub the scope reaches, those with no hub too', () => {
    const query = rendered(STAFF_QUEUE_STATEMENT(ANY_HUB));

    expect(hubValues(query, 'primary_hub_id')).toEqual([null]);
    // ... in the form that ignores a null (`$n::uuid is null or primary_hub_id = $n::uuid`), the form of the staff list.
    expect(query.sql).toMatch(/\$(\d+)::uuid\s+is\s+null\s+or\s+primary_hub_id\s*=\s*\$\d+::uuid/);
  });

  // Break caught: a hub that changes more than the hub: the status of the queue, or the search pattern, lost or moved when a hub is asked for, so
  // that the count with a hub is the count of another queue.
  it('differs by nothing but the hub when one is asked for', () => {
    const without = rendered(STAFF_QUEUE_STATEMENT(ANY_HUB));
    const withHub = rendered(STAFF_QUEUE_STATEMENT({ hubId: HUB }));

    expect(withHub.sql).toBe(without.sql);
    expect(withHub.params.filter((value) => value === HUB)).toHaveLength(2);
    expect(withHub.params.map((value) => (value === HUB ? null : value))).toEqual([
      ...without.params,
    ]);
  });
});

describe('the counter of the approver’s queue of staff profiles', () => {
  const [counter] = staffQueueCounters();

  // Break caught: a counter that is given the filter and runs its statement without it (`STAFF_QUEUE_STATEMENT(ANY_HUB)`, or `()`): the staff
  // queue is counted in a transaction of its own under its own key, and a count that ignored its hub there would say the work of every hub the
  // grant of `staff.read` reaches.
  it('runs its statement for the filter it is given', async () => {
    expect(counter?.queue).toBe('STAFF_AWAITING_APPROVAL');
    const filters: QueueFilter[] = [{ hubId: HUB }, ANY_HUB];

    for (const filter of filters) {
      const { handle, statements } = recording();
      const count = await counter?.count(handle, filter);

      expect(count).toEqual({ count: 0, oldestAt: null });
      const asked = rendered(onlyOf(statements));
      expect(asked, JSON.stringify(filter)).toEqual(rendered(STAFF_QUEUE_STATEMENT(filter)));
      expect(hubValues(asked, 'primary_hub_id').includes(HUB)).toBe(filter.hubId !== null);
    }
  });

  // Break caught: a counter that keeps the hub of the previous count (a statement built once and reused).
  it('counts for each filter it is asked with, one after the other', async () => {
    const { handle, statements } = recording();
    const other = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e02';

    await counter?.count(handle, { hubId: HUB });
    await counter?.count(handle, { hubId: other });
    await counter?.count(handle, ANY_HUB);

    expect(statements.map((each) => hubValues(rendered(each), 'primary_hub_id'))).toEqual([
      [HUB],
      [other],
      [null],
    ]);
  });
});
