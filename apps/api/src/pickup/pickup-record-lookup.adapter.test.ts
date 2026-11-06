import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  NAME_SEARCH_WINDOW_DAYS,
  TERMINAL_REQUEST_STATES,
  currentWork,
  nameSearchWindowStart,
} from './pickup-record-lookup.adapter.js';
import { PICKUP_REQUEST_STATES } from './pickup-request.schema.js';

/**
 * The rule that says a pickup request is searched by a name only while it is current work (`AC-LOOKUP-13`; the Product Owner's decision D3,
 * option (c), 6 November 2026): its state is not terminal, or its service date is on or after the hub's today minus 30 days. The database tests
 * prove the behaviour through the application; these hold the pieces: the day the window starts, the states that are terminal, and the condition
 * as it is sent to the database.
 */
describe('the day the window starts', () => {
  // Break caught: a window of another length, a day off at the edge, or arithmetic that fails across a month, a year or a leap day.
  it.each([
    ['2026-11-06', '2026-10-07'],
    ['2026-03-01', '2026-01-30'],
    ['2026-01-15', '2025-12-16'],
    ['2024-03-30', '2024-02-29'],
    ['2026-12-31', '2026-12-01'],
  ])('is 30 days before %s: %s', (today, start) => {
    expect(NAME_SEARCH_WINDOW_DAYS).toBe(30);
    expect(nameSearchWindowStart(today)).toBe(start);
  });

  // Break caught: a text that is not a day reaching the database as a date, or a silent fallback to some other day.
  it.each([['2026-13-01'], ['yesterday'], ['']])('refuses %j as a day', (today) => {
    expect(() => nameSearchWindowStart(today)).toThrow(/not a calendar day/);
  });
});

describe('the states that are terminal', () => {
  const dialect = new PgDialect();

  // Break caught: a terminal list that drifts from the state machine, which would hide work (a state wrongly terminal) or show history.
  it('are those the state machine names: DECLINED and CANCELLED, and no state is invented', () => {
    const machine = readFileSync(
      resolve(import.meta.dirname, '../../../../contracts/state-machines.md'),
      'utf8',
    );
    const section = machine.slice(machine.indexOf('## 3. `PickupRequest`'));
    const states = /States: ([^\n]+)\. Terminal: ([^\n]+?)\./.exec(section);

    expect(states).not.toBeNull();
    const named = (text: string | undefined): string[] =>
      [...(text ?? '').matchAll(/`([A-Z_]+)`/g)].map((match) => match[1] ?? '');
    expect(named(states?.[1])).toEqual([...PICKUP_REQUEST_STATES]);
    expect([...TERMINAL_REQUEST_STATES].toSorted()).toEqual(named(states?.[2]).toSorted());
  });

  // Break caught: a condition that lists a terminal state as current, drops a state that is current, or puts the date in as text.
  it('are left out of the states a request may be in to be current work, whatever its date, and the date is a bound day', () => {
    const { sql: text, params } = dialect.sqlToQuery(currentWork('2026-10-07'));

    expect(text).toMatch(
      /^\(state in \(\$1::text, \$2::text\) or scheduled_service_date >= \$3::date\)$/,
    );
    expect(params).toEqual(['PENDING', 'CONFIRMED', '2026-10-07']);
  });
});
