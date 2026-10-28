import { summarise, type RunSummary } from './argon2-benchmark.js';

/**
 * The arithmetic of the integrated capacity measurement (S0.65): what a run measured, said as throughput and latency, and what it implies
 * for the values the Product Owner sets (contracts/settings.md section 9: the per-address edge ceiling and the transport and
 * hash-admission capacity). Pure: it reads measurements and returns figures, and decides nothing. A measured engineering value is
 * proposed here; a product value (how many people sit behind one address, how fast a hub's shift signs in) is the owner's and is an input,
 * never invented.
 */

export interface StageResult extends RunSummary {
  /** How many of the operation ran at once. */
  readonly concurrency: number;
  /** Completed operations a second over the stage's whole time. */
  readonly throughputPerSecond: number;
  /** Answers that were not the operation's success (a refusal, a failure), counted apart from the latencies. */
  readonly refused: number;
}

/** The result of a stage: the latencies of the operations that succeeded, the stage's elapsed time, and how many were refused. */
export function stageResult(
  concurrency: number,
  durationsMs: readonly number[],
  elapsedMs: number,
  refused: number,
): StageResult {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new RangeError('A stage runs at least one at a time.');
  if (!(elapsedMs > 0)) throw new RangeError('A stage takes some time.');
  return {
    ...summarise(durationsMs),
    concurrency,
    throughputPerSecond: Math.round((durationsMs.length / elapsedMs) * 1000 * 10) / 10,
    refused,
  };
}

/**
 * The stage after which more concurrency bought less than `gain` more throughput: where the measured path saturates on this machine.
 * Undefined when every stage still gained.
 */
export function saturation(stages: readonly StageResult[], gain = 0.1): StageResult | undefined {
  const ordered = [...stages].sort((a, b) => a.concurrency - b.concurrency);
  for (let index = 1; index < ordered.length; index += 1) {
    const before = ordered[index - 1];
    const now = ordered[index];
    if (before === undefined || now === undefined) continue;
    if (now.throughputPerSecond < before.throughputPerSecond * (1 + gain)) return before;
  }
  return undefined;
}

export interface SharedAddressCase {
  /** The people who sign in from behind one address (one hub's NAT): the owner's figure. */
  readonly people: number;
  /** The minutes in which they all sign in at the start of a shift: the owner's figure. */
  readonly windowMinutes: number;
}

/**
 * What a per-address edge ceiling means for people who share one address (DEPLOYMENT_AND_ENVIRONMENTS.md, the edge ceiling with NAT): the
 * sign-ins a minute that address needs at the start of a shift, and whether the API measured here can serve them. The ceiling itself is
 * the owner's to set; this says the least it can be for the case given and how much of the measured capacity that case uses.
 */
export function sharedAddressNeed(
  shared: SharedAddressCase,
  measuredSignInsPerSecond: number,
): { readonly signInsPerMinute: number; readonly shareOfCapacity: number } {
  if (!Number.isInteger(shared.people) || shared.people < 1)
    throw new RangeError('At least one person shares the address.');
  if (!(shared.windowMinutes > 0)) throw new RangeError('The window is some minutes long.');
  if (!(measuredSignInsPerSecond > 0)) throw new RangeError('The measured capacity is above zero.');
  const signInsPerMinute = Math.ceil(shared.people / shared.windowMinutes);
  return {
    signInsPerMinute,
    shareOfCapacity: Math.round((signInsPerMinute / (measuredSignInsPerSecond * 60)) * 1000) / 1000,
  };
}
