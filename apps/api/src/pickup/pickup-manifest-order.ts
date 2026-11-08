import type { BodyViolation } from './pickup-manifest-eligibility.js';

/**
 * The sequence Ops sets for the stops of a manifest (`setManifestStopOrder`, S1.21; features/pickup/pickup-manifest.md section 5.1). A pure
 * judgement of the list against the stops the manifest holds, so that its rules and their order are tested without a database.
 *
 * - **The complete sequence, not a delta**: the list names every stop of the manifest exactly once, and the stop at place `n` (counted from
 *   one) is numbered `n`. A stop left out is `incomplete` (at the list as a whole, once, after the places are judged), a stop named twice is
 *   `duplicate` at its second place, and an id that is not a stop of this manifest is `not_on_manifest` at its place; nothing is guessed, and
 *   a rider, a hub or a request cannot be named here.
 * - **A stop that is no longer to be worked keeps its place.** A stop skipped because its request was cancelled is history: it stays where it
 *   was, the others are ordered around it, and naming it at another place is `resolved_stop_moved` at that place. (The guard of a stop holds
 *   the same for every writer: a resolved stop is frozen but for the release of its claim.)
 *
 * Violations name a place and a rule and never repeat what the client sent; they are reported together, the places in the order of the list
 * first, then the list as a whole.
 */
export interface OrderedStop {
  /** The stop's id, lower case. */
  readonly id: string;
  /** The place the stop has now. */
  readonly sequence: number;
  readonly state: string;
}

export function judgeStopOrder(input: {
  /** The stop ids the client listed, in its order. */
  readonly ordered: readonly string[];
  /** The stops the manifest holds. */
  readonly stops: readonly OrderedStop[];
}): BodyViolation[] {
  const held = new Map(input.stops.map((stop) => [stop.id, stop] as const));
  const seen = new Set<string>();
  const violations: BodyViolation[] = [];
  input.ordered.forEach((raw, position) => {
    const id = raw.toLowerCase();
    const pointer = `/ordered_stop_ids/${String(position)}`;
    if (seen.has(id)) {
      violations.push({ in: 'body', pointer, rule: 'duplicate' });
      return;
    }
    seen.add(id);
    const stop = held.get(id);
    if (stop === undefined) {
      violations.push({ in: 'body', pointer, rule: 'not_on_manifest' });
    } else if (stop.state !== 'PENDING' && stop.sequence !== position + 1) {
      violations.push({ in: 'body', pointer, rule: 'resolved_stop_moved' });
    }
  });
  if (input.stops.some((stop) => !seen.has(stop.id))) {
    violations.push({ in: 'body', pointer: '/ordered_stop_ids', rule: 'incomplete' });
  }
  return violations;
}
