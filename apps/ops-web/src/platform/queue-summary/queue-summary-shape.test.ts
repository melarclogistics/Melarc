import { describe, expect, it } from 'vitest';

import { parseQueueSummary, QUEUE_IDS } from './queue-summary-shape';

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  queue: 'PICKUP_AWAITING_CONFIRMATION',
  count: 3,
  oldest_at: '2026-11-02T09:15:30.123Z',
  ...overrides,
});

describe('parseQueueSummary: what is accepted', () => {
  it('accepts a real-shaped summary and returns the queue, the count and the moment, and nothing else', () => {
    expect(
      parseQueueSummary({
        queues: [
          entry(),
          { queue: 'PICKUP_CUTOFF_REVIEW', count: 0 },
          entry({ queue: 'STAFF_AWAITING_APPROVAL', count: 12, extra: 'not read' }),
        ],
      }),
    ).toEqual({
      queues: [
        { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 3, oldestAt: '2026-11-02T09:15:30.123Z' },
        { queue: 'PICKUP_CUTOFF_REVIEW', count: 0, oldestAt: null },
        { queue: 'STAFF_AWAITING_APPROVAL', count: 12, oldestAt: '2026-11-02T09:15:30.123Z' },
      ],
      incomplete: false,
    });
  });

  // Break caught: a session that may read no queue refused as though the answer were broken, which would break the menu for it.
  it('accepts a summary with no queue: a session that may read none', () => {
    expect(parseQueueSummary({ queues: [] })).toEqual({ queues: [], incomplete: false });
  });

  // Break caught: a queue that holds records with no moment refused, which would take the whole summary away for one missing age.
  it('accepts a queue with records and no moment, which is drawn without an age', () => {
    expect(parseQueueSummary({ queues: [{ queue: 'PICKUP_RUNS_IN_PROGRESS', count: 2 }] })).toEqual(
      {
        queues: [{ queue: 'PICKUP_RUNS_IN_PROGRESS', count: 2, oldestAt: null }],
        incomplete: false,
      },
    );
  });

  // Break caught: every queue of the contract being accepted, one at a time.
  it.each(QUEUE_IDS.map((queue) => [queue] as const))('takes the queue %s', (queue) => {
    expect(parseQueueSummary({ queues: [entry({ queue })] })).toMatchObject({
      queues: [{ queue }],
    });
  });
});

describe('parseQueueSummary: a queue of a newer server', () => {
  // Break caught: the menu losing every count because a server newer than the page names a queue the page has no words for.
  it('leaves out a queue it has no words for and keeps the ones it has', () => {
    expect(
      parseQueueSummary({
        queues: [
          entry({ queue: 'A_QUEUE_FROM_THE_FUTURE' }),
          entry({ queue: 'PICKUP_CUTOFF_REVIEW' }),
        ],
      }),
    ).toEqual({
      queues: [{ queue: 'PICKUP_CUTOFF_REVIEW', count: 3, oldestAt: '2026-11-02T09:15:30.123Z' }],
      incomplete: true,
    });
  });

  // Break caught (the review of C1): a queue left out without a trace, so that the screens, seeing only zeros, say nothing is waiting while
  // the queue they have no words for holds seven.
  it('says that the answer holds more than it shows, when a queue was left out', () => {
    expect(
      parseQueueSummary({
        queues: [entry({ queue: 'PICKUP_AWAITING_CONFIRMATION', count: 0, oldest_at: undefined })],
      })?.incomplete,
    ).toBe(false);
    expect(
      parseQueueSummary({
        queues: [
          entry({ queue: 'PICKUP_AWAITING_CONFIRMATION', count: 0, oldest_at: undefined }),
          entry({ queue: 'A_QUEUE_FROM_THE_FUTURE', count: 7 }),
        ],
      }),
    ).toEqual({
      queues: [{ queue: 'PICKUP_AWAITING_CONFIRMATION', count: 0, oldestAt: null }],
      incomplete: true,
    });
    // An answer of nothing but queues this build cannot show is not an empty answer.
    expect(parseQueueSummary({ queues: [entry({ queue: 'A_QUEUE_FROM_THE_FUTURE' })] })).toEqual({
      queues: [],
      incomplete: true,
    });
  });

  // Break caught: an identifier from the server reaching the screen as a label.
  it('never carries an unknown identifier on', () => {
    const parsed = parseQueueSummary({ queues: [entry({ queue: 'TOTALLY_NEW' })] });
    expect(JSON.stringify(parsed)).not.toContain('TOTALLY_NEW');
  });
});

describe('parseQueueSummary: what is refused', () => {
  // Break caught: a body that is not a summary accepted, so that a proxy's `{}` is drawn as a menu that says nothing is wrong.
  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a list', []],
    ['text', 'queues'],
    ['an object with no queues', {}],
    ['queues that are not a list', { queues: 'many' }],
    ['queues that are an object', { queues: { a: 1 } }],
  ])('refuses %s', (_name, body) => {
    expect(parseQueueSummary(body)).toBeUndefined();
  });

  // Break caught: a figure that is not a count drawn beside a queue, or turned into one that looks right.
  it.each([
    ['a negative count', { count: -1 }],
    ['a fraction', { count: 1.5, oldest_at: '2026-11-02T09:15:30Z' }],
    ['a count that is text', { count: '3' }],
    ['a count that is null', { count: null }],
    ['a missing count', { count: undefined }],
    ['a count too large to be exact', { count: Number.MAX_SAFE_INTEGER + 2 }],
    ['not a number', { count: Number.NaN }],
  ])('refuses %s', (_name, overrides) => {
    const body = { queues: [entry(overrides)] };
    expect(parseQueueSummary(body)).toBeUndefined();
  });

  // Break caught: an age on an empty queue, which the contract forbids and which would draw a wait for nothing that waits.
  it('refuses a moment on a queue that holds nothing', () => {
    expect(parseQueueSummary({ queues: [entry({ count: 0 })] })).toBeUndefined();
  });

  // Break caught: a moment that is not an instant drawn as one.
  it.each([['yesterday'], [''], [1_700_000_000], ['2026-11-02'], ['2026-13-40T99:00:00Z'], [null]])(
    'refuses the moment %j',
    (oldest) => {
      expect(parseQueueSummary({ queues: [entry({ oldest_at: oldest })] })).toBeUndefined();
    },
  );

  // Break caught: an entry that is not an object, or has no queue, taken for an unknown queue and quietly dropped.
  it.each([[null], ['PICKUP_CUTOFF_REVIEW'], [7], [{ count: 2 }], [{ queue: 5, count: 2 }]])(
    'refuses the entry %j',
    (each) => {
      expect(parseQueueSummary({ queues: [each] })).toBeUndefined();
    },
  );

  // Break caught: the same queue twice, which cannot both be right and of which the later would win in any map made from them.
  it('refuses a queue given twice', () => {
    expect(parseQueueSummary({ queues: [entry(), entry({ count: 9 })] })).toBeUndefined();
  });

  // Break caught: an answer far beyond the contract's six queues taken for the API's.
  it('refuses an answer with far more entries than there are queues', () => {
    const many = Array.from({ length: 200 }, () => entry({ queue: 'PICKUP_CUTOFF_REVIEW' }));
    expect(parseQueueSummary({ queues: many })).toBeUndefined();
  });
});
