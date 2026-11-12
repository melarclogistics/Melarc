import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  ANY_PICKUP_REQUEST,
  CUTOFF_REVIEW,
  pickupRequestCriteria,
  type PickupRequestCriteria,
} from './pickup-request-criteria.js';

/**
 * The hub of the conditions of the list of pickup requests (task C3; `AC-HUBF-01`, `-04`, `-06`; features/operations/hub-filters.md), as the
 * driver is given them: the text of the conditions and the values bound to its placeholders. The conditions are one function that the list and
 * the counts of four queues call, so a hub that is lost from it is lost from the list and from every count alike, and no comparison of a count
 * with its list can see it: what the hub adds to the criteria is therefore read here directly. What the conditions return, against the plain
 * definition and under row-level security, is `test/database/pickup-request-criteria.db.test.ts`.
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

/**
 * The conditions the text is made of at its top level (the parts joined by `and` outside every parenthesis, which is what a `where` clause
 * of these criteria is), each written on one line with its placeholders unnumbered, so that two are equal when they say the same thing.
 */
function conjuncts(query: Rendered): string[] {
  const text = query.sql;
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (depth === 0) {
      const joint = /^\s+and\s+/.exec(text.slice(at));
      if (joint !== null) {
        parts.push(text.slice(start, at));
        start = at + joint[0].length;
        at = start - 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.replace(/\s+/g, ' ').replace(/\$\d+/g, '?').trim());
}

/** What each comparison of `responsible_hub_id` with a bound, `uuid`-cast value is bound to, wherever it stands in the text. */
function hubValues(query: Rendered): unknown[] {
  return [...query.sql.matchAll(/\bresponsible_hub_id\s*=\s*\$(\d+)::uuid/g)].map(
    (match) => query.params[Number(match[1]) - 1],
  );
}

const HUB = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01';
/** A value that is not an identifier, and would break out of a statement written with it: the criteria bind a hub and never write it. */
const HOSTILE = `x' or '1'='1`;
const THE_HUB_CONDITION = 'responsible_hub_id = ?::uuid';

/** The other filters the hub is added to: each alone, the queues' own, and all of them at once. */
const OTHERS: readonly (readonly [string, Partial<PickupRequestCriteria>])[] = [
  ['no other filter', {}],
  ['a state', { state: 'PENDING' }],
  ['the exception filter of the approver’s queue', { exceptionState: 'REQUESTED' }],
  ['the filter of an approved exception', { exceptionState: 'APPROVED' }],
  ['a cut-off state', { cutoffExceptionState: 'SAME_DAY_APPROVED' }],
  ['a day', { serviceDate: '2026-11-03' }],
  ['the requests on a run', { manifested: true }],
  ['the requests on no run', { manifested: false }],
  ['the pool of confirmed requests that no run holds', { state: 'CONFIRMED', manifested: false }],
  ['the late bookings waiting for Ops', CUTOFF_REVIEW],
  [
    'every filter at once',
    {
      state: 'CONFIRMED',
      exceptionState: 'REQUESTED',
      cutoffExceptionState: 'PENDING_OPS_REVIEW',
      serviceDate: '2026-11-03',
      manifested: false,
    },
  ],
];

describe('the criteria every queue of requests starts from', () => {
  // Break caught: a hub carried by the constants the queues spread (`{ ...ANY_PICKUP_REQUEST, state: 'PENDING' }`), so that every queue counts
  // that hub alone, whatever hub is asked for, and every read with no hub is filtered by it.
  it('name no hub, and cannot be given one', () => {
    expect(ANY_PICKUP_REQUEST.hubId).toBeNull();
    expect(CUTOFF_REVIEW.hubId).toBeNull();
    expect(Object.isFrozen(ANY_PICKUP_REQUEST)).toBe(true);
    expect(Object.isFrozen(CUTOFF_REVIEW)).toBe(true);
  });
});

describe('the hub in the conditions of the list of pickup requests', () => {
  // Break caught: a condition that is written when no hub is asked for (even one that ignores a null costs the plan the criteria were rewritten
  // for, task C1), or a criteria with no filter at all that is anything but `true`: a filter that is not asked for adds no condition at all.
  it('adds no condition and binds no value when no hub is asked for', () => {
    expect(rendered(pickupRequestCriteria(ANY_PICKUP_REQUEST))).toEqual({
      sql: 'true',
      params: [],
    });
    for (const [name, others] of OTHERS) {
      const query = rendered(
        pickupRequestCriteria({ ...ANY_PICKUP_REQUEST, ...others, hubId: null }),
      );

      expect(query.sql, name).not.toMatch(/hub/);
    }
  });

  // Break caught: a hub that is ignored (the list and the counts then return every hub's requests while they are asked for one's), compared with
  // another column, written as a text comparison (an identifier in capitals then matches nothing), or not bound to the hub it was asked for.
  it.each(OTHERS)(
    'adds to %s one condition, on the hub of the request, bound to the hub and cast to a uuid',
    (_name, others) => {
      const without = rendered(pickupRequestCriteria({ ...ANY_PICKUP_REQUEST, ...others }));
      const withHub = rendered(
        pickupRequestCriteria({ ...ANY_PICKUP_REQUEST, ...others, hubId: HUB }),
      );

      expect(hubValues(withHub)).toEqual([HUB]);
      // Exactly one more condition, a conjunct of the `where` clause (never inside a subquery, and never one branch of an `or`), and the others
      // are the ones there were: nothing lost, moved or changed by the hub.
      expect(conjuncts(withHub).toSorted()).toEqual(
        [...conjuncts(without), THE_HUB_CONDITION].toSorted(),
      );
      // ... and one more value, the hub, in the values the others were bound to, in the order they were.
      const remaining = [...withHub.params];
      remaining.splice(remaining.indexOf(HUB), 1);
      expect(remaining).toEqual([...without.params]);
    },
  );

  // Break caught: a hub written into the text of the statement (a hub that is not an identifier would then break out of it) and not bound.
  it.each(OTHERS)('binds the hub of %s and never writes it into the text', (_name, others) => {
    const query = rendered(
      pickupRequestCriteria({ ...ANY_PICKUP_REQUEST, ...others, hubId: HOSTILE }),
    );

    expect(query.params.filter((value) => value === HOSTILE)).toHaveLength(1);
    expect(query.sql).not.toContain(HOSTILE);
  });

  // Break caught: the rule of the pool and the rule of the approver's queue lost or moved when a hub is asked for (the hub would then change
  // which requests a queue counts, and not only whose): they stay conjuncts of the same statement.
  it('keeps the rule of the pool and the rule of the approver’s queue beside the hub', () => {
    const pool = conjuncts(
      rendered(
        pickupRequestCriteria({
          ...ANY_PICKUP_REQUEST,
          state: 'CONFIRMED',
          manifested: false,
          hubId: HUB,
        }),
      ),
    );
    const approver = conjuncts(
      rendered(
        pickupRequestCriteria({ ...ANY_PICKUP_REQUEST, exceptionState: 'REQUESTED', hubId: HUB }),
      ),
    );

    expect(pool).toContain(THE_HUB_CONDITION);
    expect(pool).toContain("cutoff_exception_state is distinct from 'PENDING_OPS_REVIEW'");
    expect(approver).toContain(THE_HUB_CONDITION);
    expect(approver).toContain("state = 'PENDING'");
  });
});

describe('the requests that can show an exception in a state', () => {
  // Break caught: the candidates read as `id in (subquery)` again. Every answer is the same, so no test of an answer can see it; the planner may then run it
  // as a nested loop that reads the requested exceptions again for each pending request of a hub (measured at 400,000 requests: 1.3 seconds against 39
  // milliseconds, features/operations/hub-filters.md section 14.1). They are read once, as an array, whatever the planner estimates.
  it.each(['REQUESTED', 'APPROVED', 'REJECTED'])(
    'reads the candidates of %s once, as an array, and not as a subquery to join',
    (state) => {
      const query = rendered(
        pickupRequestCriteria({ ...ANY_PICKUP_REQUEST, exceptionState: state }),
      );

      expect(query.sql).toMatch(/pickup_request\.id\s*=\s*any\s*\(\s*array\s*\(/);
      expect(query.sql).not.toMatch(/pickup_request\.id\s+in\s*\(/);
    },
  );
});
