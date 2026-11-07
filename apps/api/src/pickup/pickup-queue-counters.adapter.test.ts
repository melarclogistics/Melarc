import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { DatabaseTransaction } from '../platform/database/database.service.js';
import type { SecurityContext } from '../platform/database/transaction-context.js';
import { registerTransactionFacts } from '../platform/database/transaction-facts.js';
import { bindTransactionHandle } from '../platform/database/transaction-handle.js';
import { ANY_HUB, type QueueFilter } from '../platform/domain-ports/queue-counter.port.js';
import { PICKUP_QUEUE_STATEMENTS, pickupQueueCounters } from './pickup-queue-counters.adapter.js';

/**
 * The statements of the five pickup queues, and the counters that run them, with the hub of the filter (task C3; `AC-HUBF-04`, `-06`;
 * features/operations/hub-filters.md). A queue's count with a hub is the number of its list's records with that hub **only if the queue's own
 * statement applies the hub**, and that is the defect the database tests cannot see by comparing a count with its list: a statement that ignored
 * the hub would be wrong in the same way as the list it was written from, and no count would differ from the list. So the statements are read
 * here as the driver is given them: their text and the values bound to its placeholders.
 */
const dialect = new PgDialect();

/** A statement as the driver is given it: its text with `$n` placeholders, and the values bound to them. */
interface Rendered {
  readonly sql: string;
  readonly params: readonly unknown[];
}
const rendered = (statement: SQL): Rendered => {
  const { sql, params } = dialect.sqlToQuery(statement);
  return { sql, params };
};

/**
 * What each comparison of `column` with a bound, `uuid`-cast value is bound to, in the order the comparisons stand in the text: one for a hub
 * that is asked for, none where a filter that is not asked for adds no condition at all, and `null` where the condition is written in the form
 * that ignores a null.
 */
function hubValues(query: Rendered, column: string): unknown[] {
  return [...query.sql.matchAll(new RegExp(`\\b${column}\\s*=\\s*\\$(\\d+)::uuid`, 'g'))].map(
    (match) => query.params[Number(match[1]) - 1],
  );
}

/**
 * The statement as it would be without its one condition on the hub, which is a conjunct (`and <column> = $n::uuid`) wherever it stands, with
 * the placeholders after it numbered afresh and its value left out: for a statement that adds the condition only when a hub is asked for.
 */
function withoutTheHubCondition(query: Rendered, column: string): Rendered {
  const match = new RegExp(`\\s+and\\s+${column}\\s*=\\s*\\$(\\d+)::uuid`).exec(query.sql);
  if (match === null) throw new Error(`The statement has no condition on ${column}: ${query.sql}`);
  const dropped = Number(match[1]);
  return {
    sql: query.sql
      .replace(match[0], '')
      .replace(/\$(\d+)/g, (_found, index: string) =>
        Number(index) > dropped ? `$${String(Number(index) - 1)}` : `$${index}`,
      ),
    params: query.params.filter((_value, position) => position !== dropped - 1),
  };
}

/** The context a transaction was opened under: a handle can only be made over a transaction that has one. */
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

/** A handle over a transaction that runs nothing and keeps each statement it is given, so that what a counter asks of the database can be read. */
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
/** A value that is not an identifier, and would break out of a statement written with it: the statements bind a hub and never write it. */
const HOSTILE = `x' or '1'='1`;

type PickupQueue = keyof typeof PICKUP_QUEUE_STATEMENTS;

/**
 * The five queues, the table each counts and the column of that table that is its hub. The pickup requests have a hub on every record
 * and a request is counted in the filter form the request list uses (a condition only when a hub is asked for); the runs are counted in the
 * form of the run list (a condition that ignores a null, written like its neighbours).
 */
const QUEUES: readonly {
  readonly queue: PickupQueue;
  readonly table: string;
  readonly column: string;
  readonly onlyWhenAsked: boolean;
}[] = [
  {
    queue: 'PICKUP_AWAITING_CONFIRMATION',
    table: 'pickup_request',
    column: 'responsible_hub_id',
    onlyWhenAsked: true,
  },
  {
    queue: 'PICKUP_CUTOFF_REVIEW',
    table: 'pickup_request',
    column: 'responsible_hub_id',
    onlyWhenAsked: true,
  },
  {
    queue: 'PICKUP_EXCEPTION_APPROVAL',
    table: 'pickup_request',
    column: 'responsible_hub_id',
    onlyWhenAsked: true,
  },
  {
    queue: 'PICKUP_UNMANIFESTED_POOL',
    table: 'pickup_request',
    column: 'responsible_hub_id',
    onlyWhenAsked: true,
  },
  {
    queue: 'PICKUP_RUNS_IN_PROGRESS',
    table: 'pickup_manifest',
    column: 'responsible_hub_id',
    onlyWhenAsked: false,
  },
];

describe('the statement of each pickup queue', () => {
  // Break caught: a queue added to the adapter that this file does not know, whose statement could ignore the hub with nothing here to say so.
  it('is one of the five this file reads, and no other', () => {
    expect(Object.keys(PICKUP_QUEUE_STATEMENTS).toSorted()).toEqual(
      QUEUES.map((each) => each.queue).toSorted(),
    );
  });

  // Break caught: a statement that ignores the filter it is given (the queue counts every hub's records while its list counts one's), a hub
  // condition on another column or another table than the queue's own, or a hub that is asked for and never reaches the statement.
  it.each(QUEUES)(
    '$queue counts the table $table by $column, bound to the hub it is given',
    ({ queue, table, column }) => {
      const query = rendered(PICKUP_QUEUE_STATEMENTS[queue]({ hubId: HUB }));

      expect(query.sql).toMatch(new RegExp(`\\bfrom\\s+${table}\\b`));
      // One condition on the hub's column, bound to the hub: the hub is among the values the driver is given, and where the statement puts it.
      expect(hubValues(query, column)).toEqual([HUB]);
      // ... and no other hub column of any table is compared with it.
      expect(hubValues(query, 'primary_hub_id')).toEqual([]);
      expect(hubValues(query, 'hub_id')).toEqual([]);
    },
  );

  // Break caught: a statement that writes the hub into its text (a hub that is not an identifier then breaks out of the statement), and not only
  // binds it: it is bound, whatever it holds, and never part of the text.
  it.each(QUEUES)('$queue binds a hub and never writes it into the statement', ({ queue }) => {
    const query = rendered(PICKUP_QUEUE_STATEMENTS[queue]({ hubId: HOSTILE }));

    expect(query.params).toContain(HOSTILE);
    expect(query.sql).not.toContain(HOSTILE);
  });

  // Break caught: a hub condition that appears with no hub asked for (`responsible_hub_id = null` counts nothing at all; a plain `is null or`
  // form costs a plan the criteria were rewritten to avoid): a filter that is not asked for adds no condition at all (task C1).
  it.each(QUEUES.filter((each) => each.onlyWhenAsked))(
    '$queue adds no condition on the hub when none is asked for',
    ({ queue }) => {
      const query = rendered(PICKUP_QUEUE_STATEMENTS[queue](ANY_HUB));

      expect(query.sql).not.toMatch(/hub/);
    },
  );

  // Break caught: a run count whose condition on the hub, with no hub, is anything but a null that matches every run (a comparison with a value that
  // is not null would count the runs of one hub and call it the count of all).
  it('PICKUP_RUNS_IN_PROGRESS binds no hub at all when none is asked for', () => {
    const query = rendered(PICKUP_QUEUE_STATEMENTS.PICKUP_RUNS_IN_PROGRESS(ANY_HUB));

    expect(hubValues(query, 'responsible_hub_id')).toEqual([null]);
  });

  // Break caught: a hub that changes more than the hub: a state, a day or a rule of the queue lost or moved when a hub is asked for, so that the count
  // with a hub is the count of another queue (a statement is the queue's with the hub added, and nothing else).
  it.each(QUEUES)(
    '$queue differs by nothing but the hub when one is asked for',
    ({ queue, column, onlyWhenAsked }) => {
      const without = rendered(PICKUP_QUEUE_STATEMENTS[queue](ANY_HUB));
      const withHub = rendered(PICKUP_QUEUE_STATEMENTS[queue]({ hubId: HUB }));

      if (onlyWhenAsked) {
        expect(withoutTheHubCondition(withHub, column)).toEqual(without);
      } else {
        // The condition is always there, and ignores a null: the text is the same, and the value of the hub (twice) is the only difference.
        expect(withHub.sql).toBe(without.sql);
        expect(withHub.params.filter((value) => value === HUB)).toHaveLength(2);
        expect(withHub.params.map((value) => (value === HUB ? null : value))).toEqual([
          ...without.params,
        ]);
      }
    },
  );
});

describe('the counter of each pickup queue', () => {
  const counters = pickupQueueCounters();

  // Break caught: a counter that is given the filter and runs its statement without it (the statements may each take the hub, and a counter that
  // asks for `statement(ANY_HUB)` or for `statement()` still counts every hub): what the counter runs is its statement for the filter it was given.
  it.each(QUEUES)(
    '$queue runs its statement for the filter it is given',
    async ({ queue, column }) => {
      const counter = counters.find((each) => each.queue === queue);
      expect(counter, queue).toBeDefined();
      const filters: QueueFilter[] = [{ hubId: HUB }, ANY_HUB];

      for (const filter of filters) {
        const { handle, statements } = recording();
        const count = await counter?.count(handle, filter);

        expect(count).toEqual({ count: 0, oldestAt: null });
        const asked = rendered(onlyOf(statements));
        expect(asked, `${queue} ${JSON.stringify(filter)}`).toEqual(
          rendered(PICKUP_QUEUE_STATEMENTS[queue](filter)),
        );
        expect(hubValues(asked, column).includes(HUB)).toBe(filter.hubId !== null);
      }
    },
  );

  // Break caught: one counter that keeps the hub of the previous count (a statement built once and reused), so that a later count with another hub
  // or none is the first one's: each count is for the filter it was asked with, in either order.
  it.each(QUEUES)(
    '$queue counts for each filter it is asked with, one after the other',
    async ({ queue, column, onlyWhenAsked }) => {
      const counter = counters.find((each) => each.queue === queue);
      const { handle, statements } = recording();
      const other = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e02';

      await counter?.count(handle, { hubId: HUB });
      await counter?.count(handle, { hubId: other });
      await counter?.count(handle, ANY_HUB);

      const asked = statements.map((statement) => hubValues(rendered(statement), column));
      expect(asked).toEqual([[HUB], [other], onlyWhenAsked ? [] : [null]]);
    },
  );
});
