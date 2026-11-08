import { weekdayOf } from '../pricing/price-calculation.js';

/**
 * Which requests a manifest may be built from (S1.20; `AC-SLICE-001-11`; features/pickup/pickup-manifest.md section 4; the Product Owner's
 * decisions of 29 October and 1 November 2026, plan section 11). A pure judgement from what the request said, the rows the caller **can
 * see** and today's date on the hub's clock, so that its order and its refusals are tested without a database.
 *
 * - **Only what the caller can see is judged.** `found` holds the requests row-level security showed the caller. An id that is not in it
 *   is **one** answer, `not_available`, whether no request has that id or the request belongs to a hub the caller does not reach, and
 *   whether or not that request is already on a manifest: the answer must not tell a hub's staff that another hub's request exists, or
 *   is claimed. The claim is judged afterwards, only for requests that passed every rule here.
 * - **One hub.** All the requests of a manifest belong to one hub, and the reference is the first request submitted. A request of
 *   another hub is `hub_mismatch`, so a grant that reaches several hubs never makes a manifest that spans them.
 * - **Confirmed, and not awaiting its cutoff review.** Only a `CONFIRMED` request is eligible. One whose cutoff review is pending is not
 *   claimable until Ops decides (the owner's decision of 29 to 30 October), and it stays visible in the request queues.
 * - **The manifest's day is the day the run is worked, and the request's day is the promise.** `PickupRequest.scheduled_service_date` is
 *   the day the pickup was promised and no manifest changes it; `PickupManifest.service_date` is the day the run is to be worked: a day the
 *   hub operates (Monday to Saturday, `MSC-DEC-149`) and not one that has passed on the hub's clock (a manifest is a plan, and a day that
 *   has gone cannot be planned). A request may go on a manifest for the day it was promised or for a **later** one, which carries it over
 *   and leaves it late against its promise (derived from the two dates, never stored again); it may **not** go on one for a day before
 *   its promise (`before_scheduled_day`). A request that is to be promised another day is cancelled and rebooked, or rescheduled, and has
 *   a new promise (the Product Owner, 1 November 2026, on the reviewer's recommendation: a manifest must not force that as the answer to Melarc's own delay).
 * - **Each id is judged once.** A repeated id is `duplicate` at its second place.
 *
 * Every refusal is a violation of the body at the place of the offending id (`/pickup_request_ids/<position>`) or of the day
 * (`/service_date`), and names a rule, never a value. They are all reported together, the day first, then the places in order.
 */
export interface RequestFacts {
  readonly id: string;
  readonly state: string;
  readonly responsible_hub_id: string;
  readonly scheduled_service_date: string;
  readonly cutoff_exception_state: string | null;
}

export interface BodyViolation {
  readonly in: 'body';
  readonly pointer: string;
  readonly rule: string;
}

export type EligibilityRule =
  | 'duplicate'
  | 'not_available'
  | 'hub_mismatch'
  | 'not_confirmed'
  | 'awaiting_cutoff_review'
  | 'before_scheduled_day';

const at = (position: number): string => `/pickup_request_ids/${String(position)}`;

/**
 * The day-level rules of the manifest's own date: a real calendar day, not a Sunday, and not a day that has passed. `today` is the
 * calendar day on the hub's clock, `YYYY-MM-DD`; two such dates compare as text.
 */
export function dateViolationsOf(serviceDate: string, today: string): BodyViolation[] {
  let weekday: ReturnType<typeof weekdayOf>;
  try {
    weekday = weekdayOf(serviceDate);
  } catch {
    return [{ in: 'body', pointer: '/service_date', rule: 'format' }];
  }
  const violations: BodyViolation[] = [];
  if (weekday === 'SUN')
    violations.push({ in: 'body', pointer: '/service_date', rule: 'operating_day' });
  if (serviceDate < today)
    violations.push({ in: 'body', pointer: '/service_date', rule: 'past_day' });
  return violations;
}

export interface Assessment {
  readonly violations: readonly BodyViolation[];
  /** The hub of the manifest, where every request submitted was found in one hub (the first request's); otherwise none. */
  readonly hubId: string | undefined;
  /**
   * The requests (lower-case ids, in the order submitted) promised for an earlier day than the manifest's, which the manifest carries
   * over; none where anything is refused. A request promised for the manifest's own day is not among them.
   */
  readonly carriedOver: readonly string[];
}

export function assessRequests(input: {
  readonly ids: readonly string[];
  readonly serviceDate: string;
  readonly today: string;
  readonly found: ReadonlyMap<string, RequestFacts>;
}): Assessment {
  const violations: BodyViolation[] = [...dateViolationsOf(input.serviceDate, input.today)];
  const carriedOver: string[] = [];
  const seen = new Set<string>();
  const referenceHub = input.found.get(input.ids[0]?.toLowerCase() ?? '')?.responsible_hub_id;

  /** The first rule an id breaks, in the order the rules are stated above; none if the id is eligible. */
  const ruleOf = (id: string): EligibilityRule | undefined => {
    if (seen.has(id)) return 'duplicate';
    seen.add(id);
    const facts = input.found.get(id);
    if (facts === undefined) return 'not_available';
    if (referenceHub !== undefined && facts.responsible_hub_id !== referenceHub) {
      return 'hub_mismatch';
    }
    if (facts.state !== 'CONFIRMED') return 'not_confirmed';
    if (facts.cutoff_exception_state === 'PENDING_OPS_REVIEW') return 'awaiting_cutoff_review';
    if (facts.scheduled_service_date > input.serviceDate) return 'before_scheduled_day';
    return undefined;
  };

  // The report is in the order of the places: the day first, then the ids as they were submitted.
  input.ids.forEach((raw, position) => {
    const id = raw.toLowerCase();
    const rule = ruleOf(id);
    if (rule !== undefined) {
      violations.push({ in: 'body', pointer: at(position), rule });
      return;
    }
    // The request passed every rule, so it was found: promised for an earlier day than the manifest's, it is carried over.
    const promised = input.found.get(id)?.scheduled_service_date;
    if (promised !== undefined && promised < input.serviceDate) carriedOver.push(id);
  });

  const refused = violations.length > 0;
  return {
    violations,
    hubId: refused ? undefined : referenceHub,
    carriedOver: refused ? [] : carriedOver,
  };
}
