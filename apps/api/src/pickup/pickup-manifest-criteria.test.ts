import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { pickupManifestCriteria } from './pickup-manifest-criteria.js';

/**
 * The hub of the conditions of the list of pickup manifests, the runs (task C3; `AC-HUBF-02`, `-04`, `-06`; features/operations/hub-filters.md),
 * as the driver is given them: the text of the conditions and the values bound to its placeholders. The conditions are one function that the run
 * list and the count of the runs in progress call, so a hub lost from it is lost from both alike, and no comparison of the count with the list
 * can see it: what the hub adds is read here directly. The conditions are written in the form of their neighbours, each ignoring a null
 * (`($n::uuid is null or <column> = $n::uuid)`), so that a filter that is not asked for is the null it is bound to.
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

/** The conditions the text is made of at its top level (the parts joined by `and` outside every parenthesis), one line each, placeholders unnumbered. */
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

/**
 * What each placeholder of the condition on the hub is bound to: the two of `($n::uuid is null or responsible_hub_id = $m::uuid)`, in the order
 * they stand (the guard, then the comparison). Empty where the text has no such condition.
 */
function hubValues(query: Rendered): unknown[] {
  return [
    ...query.sql.matchAll(
      /\(\$(\d+)::uuid\s+is\s+null\s+or\s+responsible_hub_id\s*=\s*\$(\d+)::uuid\)/g,
    ),
  ].flatMap((match) => [query.params[Number(match[1]) - 1], query.params[Number(match[2]) - 1]]);
}

const HUB = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01';
const HOSTILE = `x' or '1'='1`;
const THE_HUB_CONDITION = '(?::uuid is null or responsible_hub_id = ?::uuid)';

describe('the hub in the conditions of the list of pickup manifests', () => {
  // Break caught: a hub that is ignored (the run list and the count then return every hub's runs while they are asked for one's), compared with
  // another column, written as a text comparison (an identifier in capitals then matches nothing), or not bound to the hub it was asked for.
  it('is one condition, on the hub of the run, in the form that ignores a null, bound to the hub and cast to a uuid', () => {
    const query = rendered(pickupManifestCriteria({ state: null, serviceDate: null, hubId: HUB }));

    // Both placeholders of the condition (the guard and the comparison) are the hub.
    expect(hubValues(query)).toEqual([HUB, HUB]);
    expect(conjuncts(query)).toContain(THE_HUB_CONDITION);
  });

  // Break caught: a hub condition that, with no hub asked for, is anything but a null the comparison ignores: a value that is not null would
  // count the runs of one hub and call it the count of all.
  it('is the null the condition ignores when no hub is asked for', () => {
    const query = rendered(pickupManifestCriteria({ state: null, serviceDate: null, hubId: null }));

    expect(hubValues(query)).toEqual([null, null]);
  });

  // Break caught: a hub that takes the place of another condition (the state or the day lost when a hub is asked for), is joined by an `or` (it
  // would then widen the list to the hub's runs and the runs that match the rest), or sits inside another condition's parentheses: the list is the
  // conditions of its filters joined by `and`, three of them, and the hub is one more.
  it.each([
    ['no other filter', { state: null, serviceDate: null }],
    ['a state', { state: 'IN_PROGRESS', serviceDate: null }],
    ['a day', { state: null, serviceDate: '2026-11-03' }],
    ['a state and a day', { state: 'DRAFT', serviceDate: '2026-11-03' }],
  ])('has the three conditions joined by and, with %s, the hub one of them', (_name, others) => {
    const without = rendered(pickupManifestCriteria({ ...others, hubId: null }));
    const withHub = rendered(pickupManifestCriteria({ ...others, hubId: HUB }));

    expect(conjuncts(withHub).toSorted()).toEqual(
      [
        '(?::text is null or state = ?::text)',
        '(?::date is null or service_date = ?::date)',
        THE_HUB_CONDITION,
      ].toSorted(),
    );
    // The text does not depend on the hub: the hub is the value of two placeholders, and nothing else differs between the two statements.
    expect(withHub.sql).toBe(without.sql);
    expect(withHub.params.map((value) => (value === HUB ? null : value))).toEqual([
      ...without.params,
    ]);
    expect(withHub.params.filter((value) => value === HUB)).toHaveLength(2);
  });

  // Break caught: the state and the day still bound to the values they were asked with when a hub is given (a hub that shifted the values of the
  // placeholders, so that a state is compared with a day, or the hub with a state): each is bound where its own condition is.
  it('binds the state, the day and the hub each where its own condition is', () => {
    const query = rendered(
      pickupManifestCriteria({ state: 'DISPATCHED', serviceDate: '2026-11-03', hubId: HUB }),
    );
    const comparedWith = (column: string, cast: string): unknown[] =>
      [...query.sql.matchAll(new RegExp(`\\b${column}\\s*=\\s*\\$(\\d+)::${cast}`, 'g'))].map(
        (match) => query.params[Number(match[1]) - 1],
      );

    expect(comparedWith('state', 'text')).toEqual(['DISPATCHED']);
    expect(comparedWith('service_date', 'date')).toEqual(['2026-11-03']);
    expect(comparedWith('responsible_hub_id', 'uuid')).toEqual([HUB]);
    expect(query.params).toHaveLength(6);
  });

  // Break caught: a hub written into the text of the statement (a hub that is not an identifier would then break out of it) and not bound.
  it('binds the hub and never writes it into the text', () => {
    const query = rendered(
      pickupManifestCriteria({ state: null, serviceDate: null, hubId: HOSTILE }),
    );

    expect(query.params.filter((value) => value === HOSTILE)).toHaveLength(2);
    expect(query.sql).not.toContain(HOSTILE);
  });
});
