import type pg from 'pg';

import { nextOperatingDay } from '../../../src/pickup/booking-rules.js';
import { operatingDay } from './pickups.js';

/**
 * The days a manifest test names, **relative to the database's clock on the hub** (Africa/Accra), because the day of a manifest cannot
 * have passed: a fixed date would pass every test until it was reached and fail every one after. They are computed once, by the file that
 * uses them, and every one is a day the rule under test judges the same way whatever day of the week the tests happen to run on.
 */
export interface ManifestDays {
  /** Today on the hub's clock. It may be a Sunday. */
  readonly today: string;
  /** The first day a manifest can be made for: today, or the Monday after when today is a Sunday. */
  readonly first: string;
  /** The day the manifests of a test are made for: an operating day at least two days ahead. */
  readonly day: string;
  /** The operating day after `day`. */
  readonly nextDay: string;
  /** A Sunday after `day`. */
  readonly sunday: string;
  /** An operating day that has passed (the last one before today). */
  readonly past: string;
  /** An operating day long past (about a month ago): work that old is carried over like any other, never refused for its age. */
  readonly longPast: string;
}

/** The first Sunday strictly after a calendar day. */
export function sundayAfter(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  while (next.getUTCDay() !== 0) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export async function manifestDays(client: Pick<pg.Client, 'query'>): Promise<ManifestDays> {
  const found = await client.query<{ day: string }>(
    `select to_char((now() at time zone 'Africa/Accra')::date, 'YYYY-MM-DD') as day`,
  );
  const today = found.rows[0]?.day;
  if (today === undefined) throw new Error('the database gave no date');
  const day = await operatingDay(client, 2);
  return {
    today,
    first: new Date(`${today}T00:00:00Z`).getUTCDay() === 0 ? nextOperatingDay(today) : today,
    day,
    nextDay: nextOperatingDay(day),
    sunday: sundayAfter(day),
    past: await operatingDay(client, -1),
    longPast: await operatingDay(client, -30),
  };
}
