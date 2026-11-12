import { describe, expect, it } from 'vitest';

import { inOrderOfUrgency } from './queue-summary-order';
import type { QueueCountView, QueueName } from './queue-summary-shape';

const queue = (id: QueueName, count: number, oldestAt: string | null): QueueCountView => ({
  queue: id,
  count,
  oldestAt,
});

const idsOf = (queues: readonly QueueCountView[]): QueueName[] => queues.map((each) => each.queue);

describe('the order of the queues on the landing', () => {
  // Break caught: the order the server gave, or the order of the counts, taken for the order of urgency.
  it('puts the queue whose oldest record has waited longest first', () => {
    const ordered = inOrderOfUrgency([
      queue('PICKUP_AWAITING_CONFIRMATION', 40, '2026-11-04T09:00:00.000Z'),
      queue('STAFF_AWAITING_APPROVAL', 1, '2026-10-30T09:00:00.000Z'),
      queue('PICKUP_EXCEPTION_APPROVAL', 7, '2026-11-02T09:00:00.000Z'),
    ]);

    expect(idsOf(ordered)).toEqual([
      'STAFF_AWAITING_APPROVAL',
      'PICKUP_EXCEPTION_APPROVAL',
      'PICKUP_AWAITING_CONFIRMATION',
    ]);
  });

  // Break caught: a text comparison of instants written in different offsets, which puts a later moment first.
  it('compares moments as moments, whatever offset they are written in', () => {
    const ordered = inOrderOfUrgency([
      queue('PICKUP_CUTOFF_REVIEW', 1, '2026-11-02T10:00:00.000+02:00'),
      queue('PICKUP_RUNS_IN_PROGRESS', 1, '2026-11-02T09:00:00.000Z'),
    ]);

    // 10:00 at +02:00 is 08:00 UTC, which is earlier than 09:00 UTC.
    expect(idsOf(ordered)).toEqual(['PICKUP_CUTOFF_REVIEW', 'PICKUP_RUNS_IN_PROGRESS']);
  });

  // Break caught: an empty queue made to look urgent, or hidden.
  it('puts a queue with nothing in it after every queue that has work, and keeps it', () => {
    const ordered = inOrderOfUrgency([
      queue('PICKUP_CUTOFF_REVIEW', 0, null),
      queue('PICKUP_UNMANIFESTED_POOL', 2, '2026-11-05T08:00:00.000Z'),
      queue('PICKUP_RUNS_IN_PROGRESS', 0, null),
      queue('STAFF_AWAITING_APPROVAL', 1, '2026-11-01T08:00:00.000Z'),
    ]);

    expect(idsOf(ordered)).toEqual([
      'STAFF_AWAITING_APPROVAL',
      'PICKUP_UNMANIFESTED_POOL',
      'PICKUP_CUTOFF_REVIEW',
      'PICKUP_RUNS_IN_PROGRESS',
    ]);
  });

  // Break caught: a queue the server gave no moment for placed among the ones that have one as though it were the oldest.
  it('puts a queue with work and no moment after the ones that have a moment', () => {
    const ordered = inOrderOfUrgency([
      queue('PICKUP_CUTOFF_REVIEW', 3, null),
      queue('PICKUP_RUNS_IN_PROGRESS', 1, '2026-11-02T09:00:00.000Z'),
    ]);

    expect(idsOf(ordered)).toEqual(['PICKUP_RUNS_IN_PROGRESS', 'PICKUP_CUTOFF_REVIEW']);
  });

  // Break caught: an unstable order, so that two queues with the same oldest swap places from one read to the next.
  it('keeps the server’s order for queues that are equally old, and for the empty ones', () => {
    const same = '2026-11-02T09:00:00.000Z';
    const ordered = inOrderOfUrgency([
      queue('PICKUP_EXCEPTION_APPROVAL', 1, same),
      queue('PICKUP_AWAITING_CONFIRMATION', 1, same),
      queue('PICKUP_RUNS_IN_PROGRESS', 0, null),
      queue('PICKUP_CUTOFF_REVIEW', 0, null),
    ]);

    expect(idsOf(ordered)).toEqual([
      'PICKUP_EXCEPTION_APPROVAL',
      'PICKUP_AWAITING_CONFIRMATION',
      'PICKUP_RUNS_IN_PROGRESS',
      'PICKUP_CUTOFF_REVIEW',
    ]);
  });

  // Break caught: the input list reordered in place, which would change what the menu draws from the same cache.
  it('leaves the list it was given as it was', () => {
    const given = [
      queue('PICKUP_CUTOFF_REVIEW', 1, '2026-11-03T09:00:00.000Z'),
      queue('PICKUP_RUNS_IN_PROGRESS', 1, '2026-11-01T09:00:00.000Z'),
    ];
    inOrderOfUrgency(given);
    expect(idsOf(given)).toEqual(['PICKUP_CUTOFF_REVIEW', 'PICKUP_RUNS_IN_PROGRESS']);
  });

  it('gives nothing for nothing', () => {
    expect(inOrderOfUrgency([])).toEqual([]);
  });
});
