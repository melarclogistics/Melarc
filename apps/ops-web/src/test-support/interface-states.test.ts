import { describe, expect, it } from 'vitest';

import {
  INTERFACE_STATES,
  OFFLINE_NOT_APPLICABLE,
  interfaceStateProblems,
} from './interface-states';

const tested = { test: () => undefined };

/** Every state tested, except offline, which the Ops Portal has none of. */
function complete(): Record<string, unknown> {
  return Object.fromEntries(
    INTERFACE_STATES.map((state) => [
      state,
      state === 'offline' ? { inapplicable: OFFLINE_NOT_APPLICABLE } : tested,
    ]),
  );
}

describe('the nine interface states of surfaces/ops-portal.md section 8', () => {
  it('names the nine, in the order of the specification', () => {
    expect(INTERFACE_STATES).toEqual([
      'loading',
      'empty',
      'validation error',
      'error',
      'retry',
      'offline',
      'stale / conflict',
      'success',
      'permission-restricted',
    ]);
  });

  it('accepts a screen that tests or excuses every one of them', () => {
    expect(interfaceStateProblems(complete())).toEqual([]);
  });

  // Break caught: a screen whose tests silently leave a state out, which is how a screen ships with no error state at all.
  it.each(INTERFACE_STATES)('reports a screen that says nothing about %s', (state) => {
    const coverage = Object.fromEntries(
      Object.entries(complete()).filter(([name]) => name !== state),
    );

    const problems = interfaceStateProblems(coverage);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(state);
    // It says the state was left out, which is different from an entry that is there and wrong.
    expect(problems[0]).toMatch(/neither tested nor marked not applicable/);
  });

  // Break caught: "not applicable" as a way to skip a state. An excuse is a sentence that says why.
  it.each([
    ['empty', ''],
    ['short', 'n/a'],
    ['blank', '            '],
  ])('reports a state excused with a %s reason', (_label, reason) => {
    const coverage = { ...complete(), empty: { inapplicable: reason } };

    expect(interfaceStateProblems(coverage)).toEqual([expect.stringContaining('empty')]);
  });

  it('reports an entry that is neither a test nor an excuse', () => {
    const coverage = { ...complete(), success: {} };

    expect(interfaceStateProblems(coverage)).toEqual([expect.stringContaining('success')]);
  });

  it('reports an entry whose test is not a function', () => {
    const coverage = { ...complete(), success: { test: 'yes' } };

    expect(interfaceStateProblems(coverage)).toEqual([expect.stringContaining('success')]);
  });

  it('reports a state the specification does not have', () => {
    const coverage = { ...complete(), 'partially loaded': tested };

    expect(interfaceStateProblems(coverage)).toEqual([expect.stringContaining('partially loaded')]);
  });

  it('gives the reason offline is excused for every screen of the Ops Portal', () => {
    expect(OFFLINE_NOT_APPLICABLE).toMatch(/no offline mode/i);
    expect(OFFLINE_NOT_APPLICABLE.length).toBeGreaterThan(20);
  });
});
