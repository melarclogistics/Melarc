import type { StatusMap } from '../../../components/ui/status-badge/StatusBadge';
import type {
  CancellationChargeOutcome,
  CutoffExceptionState,
  EstimateStatus,
  EstimateView,
  PayerIntent,
  PickupIntent,
  PickupRequestView,
  PickupState,
} from '../../../platform/pickup/pickup-shape';

/**
 * How the pickup screens say things (S1.19): what a state, an intent, a payer arrangement and an outcome are called, and the sentences a record's
 * facts are told in. The words belong to the screens and not to the server; every mapping is typed over its whole enumeration, so a value the
 * contract adds is a compile error here until someone decides how it reads. Nothing here decides what a person may do: the acts offered follow
 * the record and the held keys, and the server decides.
 */
export const PICKUP_STATE_MAP: StatusMap<PickupState> = {
  PENDING: { tone: 'warning', label: 'Waiting for confirmation' },
  CONFIRMED: { tone: 'success', label: 'Confirmed' },
  DECLINED: { tone: 'danger', label: 'Declined' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled' },
};

/** The order the states are offered in a filter: the way a request moves. */
export const PICKUP_STATE_ORDER: readonly PickupState[] = [
  'PENDING',
  'CONFIRMED',
  'DECLINED',
  'CANCELLED',
];

export const INTENT_LABELS: Readonly<Record<PickupIntent, string>> = {
  OWN_PACKAGES: 'A vendor’s own packages',
  COLLECT_FOR_VENDOR: 'A collection for a vendor',
  ADHOC_SENDER: 'A walk-in sender',
};

export const PAYER_LABELS: Readonly<Record<PayerIntent, string>> = {
  RECIPIENT_PAYS: 'The recipient pays',
  SENDER_PAYS_FULL: 'The sender pays in full',
  SPLIT: 'Shared between the sender and the recipient',
};

export const CUTOFF_LABELS: Readonly<Record<CutoffExceptionState, string>> = {
  PENDING_OPS_REVIEW: 'Booked after the hub’s cut-off: waiting for an Ops decision',
  SAME_DAY_APPROVED: 'Booked after the hub’s cut-off: approved for the same day',
  RESCHEDULED: 'Booked after the hub’s cut-off: moved to the next operating day',
};

/** The five outcomes are five different facts (domain-model.md section 6.2), and each is told as itself. */
export const CHARGE_OUTCOME_LABELS: Readonly<Record<CancellationChargeOutcome, string>> = {
  APPLIED: 'The cancellation charge was applied.',
  WAIVED: 'The cancellation charge was applied and then waived in full.',
  NOT_APPLIED: 'No charge: Ops chose not to apply one.',
  UNAVAILABLE: 'No charge: the hub has no cancellation charge set.',
  EXEMPT: 'No charge: the reason puts the cause with Melarc, so none is permitted.',
};

/** Why there is no estimate, in plain words (MSC-DEC-211): never a number for an estimate the server did not give. */
export const ESTIMATE_UNAVAILABLE: Readonly<Record<Exclude<EstimateStatus, 'AVAILABLE'>, string>> =
  {
    UNAVAILABLE_OUTSIDE_SERVICE_AREA:
      'No estimate: the destination is outside the service area, so the carrier’s charge is known only at itemization.',
    UNAVAILABLE_SETTING_MISSING:
      'No estimate: this hub has no approved fee to estimate from yet. The booking is not affected.',
  };

const ESTIMATE_PARTS: Readonly<Record<EstimateView['components'][number]['kind'], string>> = {
  SERVICE_AREA_BASE_FEE: 'Service-area base fee',
  CORRIDOR_OFF_DAY_FEE: 'Corridor off-day fee',
  SINGLE_PACKAGE_PICKUP_FEE: 'Single-package pickup fee',
};

/** What a part of the estimate is, with the quantity the server counted: "Service-area base fee × 3". */
export function estimatePartLabel(part: EstimateView['components'][number]): string {
  return part.quantity === 1
    ? ESTIMATE_PARTS[part.kind]
    : `${ESTIMATE_PARTS[part.kind]} × ${String(part.quantity)}`;
}

/** What the estimate leaves out, as the server listed it, in words. */
export function estimateExclusions(estimate: EstimateView): string | undefined {
  const words = estimate.excludes.map((kind) =>
    kind === 'SIZE_SURCHARGE' ? 'a size surcharge' : 'a high-value surcharge',
  );
  if (words.length === 0) return undefined;
  return `It leaves out ${words.join(' and ')}.`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The day of the week of a calendar date `YYYY-MM-DD`, 0 for Sunday. A date has no zone, so it is read as the date it is. */
export function weekdayOf(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * A calendar date as the screens show it: the weekday, the day, the month and the year (`Mon 2 Nov 2026`), with words from a fixed table and not
 * a locale's, so a screen does not change with the machine. A service date is a date and not an instant, so no zone moves it.
 */
export function serviceDateText(date: string): string {
  const [year = '', month = '', day = ''] = date.split('-');
  const weekday = WEEKDAYS[weekdayOf(date)] ?? '';
  const monthName = MONTHS[Number(month) - 1] ?? '';
  return `${weekday} ${String(Number(day))} ${monthName} ${year}`;
}

/** Whether a request is for a single package, which waits for its one-package exception before it can be confirmed. */
export function isSinglePackage(request: PickupRequestView): boolean {
  return request.declared_package_count === 1;
}

/**
 * Whether a single-package request's exception has been approved: the request carries the approval (domain-model.md section 6.2), and its
 * exception says so. A clone carries the approval of the booking it continues.
 */
export function hasApprovedException(request: PickupRequestView): boolean {
  return (
    request.one_package_exception_id !== undefined ||
    request.one_package_exception?.state === 'APPROVED'
  );
}

/** Whether a single-package request's exception was asked for and waits for its checker. */
export function hasRequestedException(request: PickupRequestView): boolean {
  return request.one_package_exception?.state === 'REQUESTED';
}

/** Whether an act was the signed-in person's own, by the session's principal. */
export function isSelf(actorId: string, principalId: string | undefined): boolean {
  return principalId?.toLowerCase() === actorId.toLowerCase();
}

/** Who did something, from the session's own id: the screens are given an identifier and no name, so another person is not named. */
export function actorText(actorId: string, principalId: string | undefined): string {
  return isSelf(actorId, principalId) ? 'You' : 'Another member of staff';
}

/** The packages of a request in words: "3 packages", "1 package", or that the count is not recorded. */
export function packagesText(request: PickupRequestView): string {
  const count = request.declared_package_count;
  if (count === undefined) return 'Not recorded';
  return `${String(count)} ${count === 1 ? 'package' : 'packages'}`;
}

/** Who ended a cancelled request, in words, or nothing when the record does not say. */
export function cancelledByText(request: PickupRequestView): string | undefined {
  if (request.cancelled_by_actor_type === 'VENDOR') return 'Cancelled by the vendor.';
  if (request.cancelled_by_actor_type === 'OPS') return 'Cancelled by Melarc Ops.';
  return undefined;
}
