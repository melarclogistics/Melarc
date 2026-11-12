import { describe, expect, it } from 'vitest';

import { hubRunsOn, hubToday } from './hub-calendar.ts';

describe('the hub works Monday to Saturday', () => {
  // Break caught: a Sunday taken for a day the hub works (the journey then builds a manifest the API refuses), or a working day taken for a
  // Sunday (the journey then never runs). One calendar week, Monday 9 to Sunday 15 November 2026, answers for each day in turn.
  it('answers true for each of Monday to Saturday and false for Sunday', () => {
    const week = [
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
    ];
    expect(week.map(hubRunsOn)).toEqual([true, true, true, true, true, true, false]);
  });

  // Break caught: the case that failed in the first hosted run, kept as it happened, a Sunday, beside the Monday after it. (The weekday is read from
  // noon UTC of the day, which no zone within eleven hours of UTC moves to another day, and the hub's own zone is UTC.)
  it('answers false for 8 November 2026, the Sunday of the first hosted run, and true for the Monday after it', () => {
    expect(hubRunsOn('2026-11-08')).toBe(false);
    expect(hubRunsOn('2026-11-09')).toBe(true);
  });

  // Break caught: a malformed or impossible day answered as if it were a day (a skip, or a run, decided by a typo).
  it('refuses what is not a calendar day', () => {
    for (const bad of ['', '2026-11-8', '08/11/2026', '2026-02-30', '2026-13-01', 'Sunday']) {
      expect(() => hubRunsOn(bad), bad).toThrow(/not a calendar day/);
    }
  });
});

describe('today at the hub', () => {
  // Break caught: the day read in the machine's own zone, and not the hub's. The hub's clock is Africa/Accra, which keeps UTC all year.
  it('is the calendar day of the hub for an instant, in the form the form takes', () => {
    expect(hubToday(new Date('2026-11-08T00:00:00Z'))).toBe('2026-11-08');
    expect(hubToday(new Date('2026-11-08T23:59:59Z'))).toBe('2026-11-08');
    expect(hubToday(new Date('2026-11-09T00:00:00Z'))).toBe('2026-11-09');
    expect(hubToday(new Date('2026-12-31T23:30:00Z'))).toBe('2026-12-31');
  });
});
