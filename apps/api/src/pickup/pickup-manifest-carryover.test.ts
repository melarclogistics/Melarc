import { describe, expect, it } from 'vitest';

import {
  carryoverSnapshotOf,
  judgeCarryover,
  noteOf,
  type CarryoverEntry,
} from './pickup-manifest-carryover.js';

const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, at) => `5eed0200-0000-4000-8000-00000000000${String(at + 1)}`);

const [A, B, C, D] = ids(4) as [string, string, string, string];
/** The manifest holds A, B, C in that order; A and C were promised for an earlier day and are carried over. */
const LISTED = [A, B, C];
const CARRIED = [A, C];

const entry = (
  pickup_request_id: string,
  overrides: Partial<CarryoverEntry> = {},
): CarryoverEntry => ({
  pickup_request_id,
  reason_code: 'ANY_CODE',
  ...overrides,
});

const judge = (
  entries: readonly CarryoverEntry[] | undefined,
  carriedOver: readonly string[] = CARRIED,
) => judgeCarryover({ ids: LISTED, carriedOver, entries });

const rulesOf = (judged: ReturnType<typeof judge>): [string, string][] =>
  judged.violations.map((each) => [each.pointer, each.rule]);

describe('the entries that give the reasons of the requests a manifest carries over', () => {
  // Break caught: an entry for each carried-over request not being accepted, or being accepted but lost (it would not reach the stop).
  it('accepts one entry for each carried-over request and keeps each by its request, in the order written', () => {
    const judged = judge([entry(C, { reason_code: 'SECOND' }), entry(A, { reason_code: 'FIRST' })]);
    expect(judged.violations).toEqual([]);
    expect(judged.missing).toEqual([]);
    expect([...judged.entries.keys()]).toEqual([C, A]);
    expect(judged.entries.get(A)).toMatchObject({ position: 1, entry: { reason_code: 'FIRST' } });
    expect(judged.entries.get(C)).toMatchObject({ position: 0, entry: { reason_code: 'SECOND' } });
  });

  // Break caught: ids compared as typed, so an upper-case id would be 'not listed' and the entry (or the request) lost.
  it('matches an id whatever its case', () => {
    const judged = judge([entry(A.toUpperCase()), entry(C)]);
    expect(judged.violations).toEqual([]);
    expect([...judged.entries.keys()].toSorted()).toEqual([A, C].toSorted());
  });

  // Break caught: a manifest with no overdue work being asked for reasons, or needing the member at all.
  it('needs no entry, and accepts none, when nothing is carried over', () => {
    expect(judge(undefined, [])).toMatchObject({ violations: [], missing: [] });
    expect(judge([], [])).toMatchObject({ violations: [], missing: [] });
  });

  // Break caught: a carried-over request with no entry accepted, which is the carry-over nobody gave a reason for.
  it('tells the places of the carried-over requests that have no entry, once the entries are well formed', () => {
    expect(judge(undefined).missing).toEqual([0, 2]);
    expect(judge([]).missing).toEqual([0, 2]);
    expect(judge([entry(C)]).missing).toEqual([0]);
    expect(judge([entry(A)]).missing).toEqual([2]);
    // Reported in the order of the manifest, not of the entries.
    expect(judge([], [C, A]).missing).toEqual([0, 2]);
  });

  // Break caught: an entry for a request that is not on the manifest accepted, and a reason kept for a stop that does not exist.
  it('refuses an entry for a request that is not on the manifest', () => {
    const judged = judge([entry(A), entry(C), entry(D)]);
    expect(rulesOf(judged)).toEqual([['/carryover/2/pickup_request_id', 'not_listed']]);
    expect(judged.entries.size).toBe(0);
    expect(judged.missing).toEqual([]);
  });

  // Break caught: a reason recorded for a request that was not carried over, which would make a false record of a carry-over that never was.
  it('refuses an entry for a request that is on its own day', () => {
    const judged = judge([entry(A), entry(B), entry(C)]);
    expect(rulesOf(judged)).toEqual([['/carryover/1/pickup_request_id', 'not_carried_over']]);
  });

  // Break caught: two reasons for one request, one of them silently winning.
  it('refuses a second entry for a request at the second place, whatever the first said', () => {
    const judged = judge([
      entry(A, { reason_code: 'ONE' }),
      entry(A, { reason_code: 'TWO' }),
      entry(C),
    ]);
    expect(rulesOf(judged)).toEqual([['/carryover/1/pickup_request_id', 'duplicate']]);
  });

  // Break caught: faults reported one at a time, so that mending the first leaves the next to be found by another attempt.
  it('reports every fault together, in the order of the entries', () => {
    const judged = judge([entry(D), entry(A), entry(B), entry(A), entry(C)]);
    expect(rulesOf(judged)).toEqual([
      ['/carryover/0/pickup_request_id', 'not_listed'],
      ['/carryover/2/pickup_request_id', 'not_carried_over'],
      ['/carryover/3/pickup_request_id', 'duplicate'],
    ]);
  });

  // Break caught: the carry-over of an old request refused for its age, which the owner's decision forbids; and a rule that depends on
  // anything but the entry and the set that is carried over.
  it('does not look at how old the work is: the set that is carried over is all it knows', () => {
    expect(judge([entry(A), entry(C)], [A, C]).violations).toEqual([]);
    expect(judge([entry(A), entry(C)], [A]).violations).toEqual([
      { in: 'body', pointer: '/carryover/1/pickup_request_id', rule: 'not_carried_over' },
    ]);
  });
});

describe('the note of an entry', () => {
  // Break caught: a blank note kept as if it were one (and a reason that wants a note satisfied by a space).
  it('is none when it is blank, and as given otherwise', () => {
    expect(noteOf({})).toBeUndefined();
    expect(noteOf({ note: '' })).toBeUndefined();
    expect(noteOf({ note: ' \t ' })).toBeUndefined();
    expect(noteOf({ note: '  Gate was locked  ' })).toBe('  Gate was locked  ');
  });

  // Break caught: a note the ledger would refuse reaching the stop, or its fault named by the text it held.
  it('is screened as the ledger screens one, and the refusal names the entry and never the text', () => {
    const judged = judge([
      entry(A, { note: 'x'.repeat(1001) }),
      entry(C, { note: 'Call me on +23320000000' }),
    ]);
    expect(rulesOf(judged)).toEqual([
      ['/carryover/0/note', 'maxLength'],
      ['/carryover/1/note', 'format'],
    ]);
    expect(JSON.stringify(judged)).not.toContain('233');
  });

  // Break caught: a blank note screened as a note, so that "   " is a fault.
  it('does not screen a blank one', () => {
    expect(judge([entry(A, { note: '   ' }), entry(C)]).violations).toEqual([]);
  });
});

describe('what a stop keeps of its carry-over', () => {
  // Break caught: the label read again from the live catalogue instead of kept as the actor saw it, or a missing note kept as undefined
  // (which a JSON column drops, so that "no note" and "never recorded" cannot be told apart).
  it('is the code and label the actor saw, and the note or an explicit null', () => {
    expect(carryoverSnapshotOf({ code: 'ROAD_CLOSED', label: 'Road closed' }, 'Flooded')).toEqual({
      reason_code: 'ROAD_CLOSED',
      label: 'Road closed',
      note: 'Flooded',
    });
    expect(carryoverSnapshotOf({ code: 'ROAD_CLOSED', label: 'Road closed' }, undefined)).toEqual({
      reason_code: 'ROAD_CLOSED',
      label: 'Road closed',
      note: null,
    });
  });
});
