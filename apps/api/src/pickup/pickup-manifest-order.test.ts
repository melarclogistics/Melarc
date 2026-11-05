import { describe, expect, it } from 'vitest';

import { judgeStopOrder, type OrderedStop } from './pickup-manifest-order.js';

const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, at) => `5eed0800-0000-4000-8000-00000000000${String(at + 1)}`);
const [A, B, C, D] = ids(4) as [string, string, string, string];

/** The stops of a manifest in the order they have now, all pending unless a test says otherwise. */
const held = (...entries: (string | [string, string])[]): OrderedStop[] =>
  entries.map((entry, at) =>
    typeof entry === 'string'
      ? { id: entry, sequence: at + 1, state: 'PENDING' }
      : { id: entry[0], sequence: at + 1, state: entry[1] },
  );

const rules = (ordered: readonly string[], stops: readonly OrderedStop[]): [string, string][] =>
  judgeStopOrder({ ordered, stops }).map((each) => [each.pointer, each.rule]);

describe('the sequence of the stops of a manifest', () => {
  // Break caught: a permutation of the stops refused, or the order the manifest already has refused as a change.
  it('accepts every stop once, in any order, and the order it already has', () => {
    expect(rules([C, A, B], held(A, B, C))).toEqual([]);
    expect(rules([A, B, C], held(A, B, C))).toEqual([]);
    expect(rules([A], held(A))).toEqual([]);
  });

  // Break caught: a delta accepted as a sequence (a stop left unplaced would keep a stale number beside the new ones).
  it('refuses a list that leaves a stop out, once, at the list as a whole', () => {
    expect(rules([A, C], held(A, B, C))).toEqual([['/ordered_stop_ids', 'incomplete']]);
    expect(rules([C], held(A, B, C))).toEqual([['/ordered_stop_ids', 'incomplete']]);
  });

  // Break caught: a stop named twice taking two places (or the second naming silently winning).
  it('refuses a stop named twice at its second place', () => {
    expect(rules([A, B, A, C], held(A, B, C))).toEqual([['/ordered_stop_ids/2', 'duplicate']]);
  });

  // Break caught: a stop of another manifest (or an id that is nobody's) accepted into this one's sequence.
  it('refuses an id that is not a stop of the manifest, at its place', () => {
    expect(rules([A, D, B, C], held(A, B, C))).toEqual([
      ['/ordered_stop_ids/1', 'not_on_manifest'],
    ]);
  });

  // Break caught: a resolved stop moved (a skip that was history rewritten into a new place), or the others refused room around it.
  it('keeps a stop that is no longer to be worked in its place, and orders the others around it', () => {
    const stops = held(A, [B, 'SKIPPED'], C, D);
    expect(rules([C, B, A, D], stops)).toEqual([]);
    expect(rules([D, A, C, B], stops)).toEqual([['/ordered_stop_ids/3', 'resolved_stop_moved']]);
    expect(rules([B, A, C, D], stops)).toEqual([['/ordered_stop_ids/0', 'resolved_stop_moved']]);
    // A skipped stop that stays where it is breaks nothing, whatever surrounds it.
    expect(rules([D, B, C, A], stops)).toEqual([]);
  });

  // Break caught: faults reported one at a time, and the id of the same stop in another spelling taken for another stop.
  it('reports every fault together, the places first, and reads an id whatever its case', () => {
    expect(rules([A.toUpperCase(), D, A, B], held(A, B, C))).toEqual([
      ['/ordered_stop_ids/1', 'not_on_manifest'],
      ['/ordered_stop_ids/2', 'duplicate'],
      ['/ordered_stop_ids', 'incomplete'],
    ]);
  });

  it('names no value in a violation', () => {
    expect(JSON.stringify(judgeStopOrder({ ordered: [D], stops: held(A) }))).not.toContain(D);
  });
});
