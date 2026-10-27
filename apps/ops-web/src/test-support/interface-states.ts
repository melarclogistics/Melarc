import { describe, expect, it } from 'vitest';

/**
 * The nine interface states every screen of the Ops Portal answers for (surfaces/ops-portal.md section 8), in the order of that
 * document. A screen's test says, for each one, which test covers it or why it does not apply, and the screen's test fails if it says
 * nothing: the usual way a screen ships without an error state is that no one wrote the line that would have asked for it.
 */
export const INTERFACE_STATES = [
  'loading',
  'empty',
  'validation error',
  'error',
  'retry',
  'offline',
  'stale / conflict',
  'success',
  'permission-restricted',
] as const;

export type InterfaceState = (typeof INTERFACE_STATES)[number];

/** Why `offline` is excused on every screen: the specification says so once, and this is where the tests quote it. */
export const OFFLINE_NOT_APPLICABLE =
  'The Ops Portal has no offline mode: a lost connection is an error, not a queue (surfaces/ops-portal.md section 8).';

/** The fewest characters an excuse may have. A word or two is not a reason. */
const MIN_REASON_LENGTH = 24;

export interface StateTest {
  /** The test that shows the state. It runs as a test of its own, named for the state. */
  readonly test: () => void | Promise<void>;
}

export interface StateNotApplicable {
  /** Why this screen cannot be in this state, in a sentence. */
  readonly inapplicable: string;
}

export type InterfaceStateCoverage = Readonly<
  Record<InterfaceState, StateTest | StateNotApplicable>
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * What is wrong with a claim of coverage: a state it leaves out, a state the specification does not have, an entry that is neither a test
 * nor an excuse, an excuse that is too short to be a reason. An empty list means the claim is complete. It takes the claim as unknown so
 * that its own tests can hand it the wrong shapes a typed caller could not.
 */
export function interfaceStateProblems(coverage: Readonly<Record<string, unknown>>): string[] {
  const problems: string[] = [];
  for (const state of INTERFACE_STATES) {
    if (!Object.hasOwn(coverage, state)) {
      problems.push(`The state "${state}" is neither tested nor marked not applicable.`);
      continue;
    }
    const entry = coverage[state];
    if (isRecord(entry) && typeof entry.test === 'function') continue;
    if (isRecord(entry) && typeof entry.inapplicable === 'string') {
      if (entry.inapplicable.trim().length < MIN_REASON_LENGTH) {
        problems.push(`The state "${state}" is marked not applicable without a reason.`);
      }
      continue;
    }
    problems.push(`The state "${state}" is neither a test nor a reason it does not apply.`);
  }
  const known: readonly string[] = INTERFACE_STATES;
  for (const name of Object.keys(coverage)) {
    if (!known.includes(name)) problems.push(`"${name}" is not one of the nine interface states.`);
  }
  return problems;
}

/**
 * Registers the nine states of a screen as tests. Each tested state runs as `it('<state>')`; each excused one is a test that holds the
 * reason. If the claim is incomplete, the screen has a single failing test that says what is missing, so an unfinished claim cannot pass
 * and cannot be skipped.
 */
export function describeInterfaceStates(screen: string, coverage: InterfaceStateCoverage): void {
  const problems = interfaceStateProblems(coverage);
  describe(`${screen}: the nine interface states`, () => {
    if (problems.length > 0) {
      it('answers for every state', () => {
        expect(problems).toEqual([]);
      });
      return;
    }
    for (const state of INTERFACE_STATES) {
      const entry = coverage[state];
      if ('test' in entry) {
        it(state, entry.test);
      } else {
        it(`${state} does not apply: ${entry.inapplicable}`, () => {
          expect(entry.inapplicable.trim().length).toBeGreaterThanOrEqual(MIN_REASON_LENGTH);
        });
      }
    }
  });
}
