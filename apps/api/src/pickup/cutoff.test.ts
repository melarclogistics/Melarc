import { describe, expect, it } from 'vitest';

import { cutoffVerdict, hubLocal, HUB_TIME_ZONE } from './cutoff.js';

/**
 * The booking cutoff (S1.15; pickup-request.md section 5.2, settings.md `booking_cutoff_time` and `vendor_credit_grace_window_minutes`;
 * `AC-SLICE-001-04`): whether a booking confirmed at an instant is late for its service date, read on the hub's clock. A late booking is
 * never refused: the verdict only decides whether it queues for Ops review.
 *
 * Every instant below is written in UTC, which is the hub's clock too (Africa/Accra has no daylight saving and sits on UTC). One case
 * reads the same instant in a zone east of Accra to prove the reading goes through the zone it is given.
 */
const at = (iso: string): Date => new Date(iso);
const TEN = 10 * 60;

describe('the hub clock', () => {
  it('is Africa/Accra', () => {
    expect(HUB_TIME_ZONE).toBe('Africa/Accra');
  });

  // Break caught: the day or the minute read in the wrong zone, or with the wrong day at the edge of midnight.
  it.each([
    ['2026-11-03T00:00:00Z', '2026-11-03', 0],
    ['2026-11-03T09:59:59Z', '2026-11-03', 599.983_333_333_333_3],
    ['2026-11-03T10:00:00Z', '2026-11-03', 600],
    ['2026-11-03T23:59:00Z', '2026-11-03', 1439],
    ['2026-11-04T00:00:00Z', '2026-11-04', 0],
  ])('reads %s as the day %s at minute %s', (instant, date, minutes) => {
    const local = hubLocal(at(instant));
    expect(local.date).toBe(date);
    expect(local.minutes).toBeCloseTo(minutes, 6);
  });

  // Break caught: a reading that ignores the zone it is asked for (the same instant is the next day, half past midnight, in Lagos).
  it('reads an instant in the zone it is asked for', () => {
    const lagos = hubLocal(at('2026-11-03T23:30:00Z'), 'Africa/Lagos');
    expect(lagos.date).toBe('2026-11-04');
    expect(lagos.minutes).toBeCloseTo(30, 6);
    expect(hubLocal(at('2026-11-03T23:30:00Z')).date).toBe('2026-11-03');
  });

  it('carries the fraction of a second, so a boundary is read exactly', () => {
    expect(hubLocal(at('2026-11-03T10:00:00.500Z')).minutes).toBeCloseTo(600 + 0.5 / 60, 6);
  });
});

describe('the verdict of a booking against the cutoff', () => {
  const verdict = (
    instant: string,
    serviceDate: string,
    over: { cutoff?: number | undefined; grace?: number } = {},
  ) =>
    cutoffVerdict({
      instant: at(instant),
      serviceDate,
      cutoffMinutes: 'cutoff' in over ? over.cutoff : TEN,
      graceMinutes: over.grace ?? 0,
    });

  // Break caught: a booking for a later day treated as late, which would queue every advance booking for review.
  it('is on time for a service date after the day it is confirmed', () => {
    expect(verdict('2026-11-03T23:59:00Z', '2026-11-04')).toEqual({ kind: 'ON_TIME' });
    expect(verdict('2026-11-03T12:00:00Z', '2026-11-10')).toEqual({ kind: 'ON_TIME' });
  });

  // Break caught: the cutoff applied to the wrong side, or a boundary read as passed before it is.
  it('is on time up to the cutoff of the service day and late after it', () => {
    expect(verdict('2026-11-03T00:00:00Z', '2026-11-03')).toEqual({ kind: 'ON_TIME' });
    expect(verdict('2026-11-03T09:59:59Z', '2026-11-03')).toEqual({ kind: 'ON_TIME' });
    expect(verdict('2026-11-03T10:00:00Z', '2026-11-03')).toEqual({ kind: 'ON_TIME' });
    expect(verdict('2026-11-03T10:00:01Z', '2026-11-03')).toEqual({ kind: 'LATE' });
    expect(verdict('2026-11-03T16:30:00Z', '2026-11-03')).toEqual({ kind: 'LATE' });
  });

  // Break caught: a stale request confirmed days after its date reading as on time because the clock is earlier in the day.
  it('is late for a service date that has already passed, whatever the time of day', () => {
    expect(verdict('2026-11-04T00:00:00Z', '2026-11-03')).toEqual({ kind: 'LATE' });
    expect(verdict('2026-11-04T08:00:00Z', '2026-11-03')).toEqual({ kind: 'LATE' });
    expect(verdict('2026-11-20T03:00:00Z', '2026-11-03')).toEqual({ kind: 'LATE' });
  });

  // Break caught: a grace window that never applies, or that extends the cutoff of every sender instead of the ones that were given it.
  it('extends the cutoff by the grace window it is given, and by nothing it is not', () => {
    expect(verdict('2026-11-03T10:30:00Z', '2026-11-03', { grace: 60 })).toEqual({
      kind: 'ON_TIME_IN_GRACE',
    });
    expect(verdict('2026-11-03T11:00:00Z', '2026-11-03', { grace: 60 })).toEqual({
      kind: 'ON_TIME_IN_GRACE',
    });
    expect(verdict('2026-11-03T11:00:01Z', '2026-11-03', { grace: 60 })).toEqual({ kind: 'LATE' });
    expect(verdict('2026-11-03T10:30:00Z', '2026-11-03', { grace: 0 })).toEqual({ kind: 'LATE' });
    // Before the cutoff itself the grace window is not what made it on time.
    expect(verdict('2026-11-03T09:00:00Z', '2026-11-03', { grace: 60 })).toEqual({
      kind: 'ON_TIME',
    });
  });

  // The window is minutes after the cutoff, so a window that crosses midnight simply runs into the next day: no special case.
  it('counts the grace window as minutes after the cutoff, across midnight too', () => {
    expect(verdict('2026-11-04T00:30:00Z', '2026-11-03', { grace: 1500 })).toEqual({
      kind: 'ON_TIME_IN_GRACE',
    });
    expect(verdict('2026-11-04T11:00:00Z', '2026-11-03', { grace: 1500 })).toEqual({
      kind: 'ON_TIME_IN_GRACE',
    });
    expect(verdict('2026-11-04T11:00:01Z', '2026-11-03', { grace: 1500 })).toEqual({
      kind: 'LATE',
    });
  });

  // Break caught: an unset cutoff blocking a booking or queuing it as late (it can decide nothing).
  it('is unset when the hub has no cutoff, whatever the day', () => {
    expect(verdict('2026-11-03T16:00:00Z', '2026-11-03', { cutoff: undefined })).toEqual({
      kind: 'UNSET',
    });
    expect(verdict('2026-11-20T16:00:00Z', '2026-11-03', { cutoff: undefined })).toEqual({
      kind: 'UNSET',
    });
  });

  it('refuses a cutoff or a grace window that is not a time of the day or a count of minutes', () => {
    expect(() => verdict('2026-11-03T10:00:00Z', '2026-11-03', { cutoff: -1 })).toThrow(RangeError);
    expect(() => verdict('2026-11-03T10:00:00Z', '2026-11-03', { cutoff: 24 * 60 })).toThrow(
      RangeError,
    );
    expect(() => verdict('2026-11-03T10:00:00Z', '2026-11-03', { grace: -5 })).toThrow(RangeError);
    expect(() => verdict('2026-11-03T10:00:00Z', '2026-11-03', { grace: 1.5 })).toThrow(RangeError);
  });

  it('refuses a service date that is not a calendar day', () => {
    expect(() => verdict('2026-11-03T10:00:00Z', '2026-02-30')).toThrow(RangeError);
  });
});
