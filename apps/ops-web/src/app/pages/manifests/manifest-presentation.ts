import type { StatusMap } from '../../../components/ui/status-badge/StatusBadge';
import type { AttributedReason } from '../../../platform/pickup/pickup-shape';
import type {
  HandoverState,
  ManifestState,
  StopState,
  StopView,
  SystemSkipReason,
} from '../../../platform/manifest/manifest-shape';
import { SYSTEM_SKIP_REASONS } from '../../../platform/manifest/manifest-shape';

/**
 * How the manifest screens say things (S1.25): what a state is called, and the sentences a record's facts are told in. The words belong to the
 * screens and not to the server; every mapping is typed over its whole enumeration, so a value the contract adds is a compile error here until
 * someone decides how it reads. A state is told by its words, and the tone supports them and never carries them. Nothing here decides what a
 * person may do: the acts offered follow the record and the held keys, and the server decides.
 */
export const MANIFEST_STATE_MAP: StatusMap<ManifestState> = {
  DRAFT: { tone: 'warning', label: 'Draft' },
  DISPATCHED: { tone: 'info', label: 'Dispatched' },
  IN_PROGRESS: { tone: 'info', label: 'In progress' },
  COMPLETED: { tone: 'success', label: 'Completed' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled' },
};

/** What each state of a manifest means to the officer looking at it, in one sentence: where it stands and what comes next. */
export const MANIFEST_STATE_SENTENCES: Readonly<Record<ManifestState, string>> = {
  DRAFT:
    'It is a draft. Order its stops, give it a rider and dispatch it: the rider sees nothing until it is dispatched.',
  DISPATCHED:
    'It is dispatched. Its rider can see the stops and starts the run on the run’s day. Until then it can still be cancelled.',
  IN_PROGRESS: 'The run is in progress. A stop is worked by the rider, or skipped by Ops.',
  COMPLETED: 'The run is completed.',
  CANCELLED: 'It was cancelled. Its requests that are still confirmed are back in the pool.',
};

/** A stop is told as its state, and a stop skipped by the system is told as why, because it needs nothing from the officer. */
export type StopStatus = StopState | 'SKIPPED_REQUEST_CANCELLED' | 'SKIPPED_MANIFEST_CANCELLED';

export const STOP_STATUS_MAP: StatusMap<StopStatus> = {
  PENDING: { tone: 'neutral', label: 'To be worked' },
  ARRIVED: { tone: 'info', label: 'Rider arrived' },
  COLLECTED: { tone: 'success', label: 'Collected' },
  PARTIALLY_COLLECTED: { tone: 'warning', label: 'Partly collected' },
  FAILED: { tone: 'danger', label: 'Failed' },
  SKIPPED: { tone: 'neutral', label: 'Skipped' },
  SKIPPED_REQUEST_CANCELLED: { tone: 'neutral', label: 'Cancelled with its request' },
  SKIPPED_MANIFEST_CANCELLED: { tone: 'neutral', label: 'Cancelled with the manifest' },
};

export function isSystemSkip(reason: string): reason is SystemSkipReason {
  return (SYSTEM_SKIP_REASONS as readonly string[]).includes(reason);
}

/** The status a stop is drawn with. A stop skipped because its request was cancelled is a stop that needs nothing, and says so. */
export function stopStatusOf(stop: StopView): StopStatus {
  if (
    stop.state === 'SKIPPED' &&
    stop.skipped !== undefined &&
    isSystemSkip(stop.skipped.reason_code)
  ) {
    return stop.skipped.reason_code === 'REQUEST_CANCELLED'
      ? 'SKIPPED_REQUEST_CANCELLED'
      : 'SKIPPED_MANIFEST_CANCELLED';
  }
  return stop.state;
}

/** Whether a stop is still to be worked: it has not been collected, failed or skipped. The Ops skip is offered for these, and the server decides. */
export function isToBeWorked(stop: StopView): boolean {
  return stop.state === 'PENDING' || stop.state === 'ARRIVED';
}

export const HANDOVER_STATE_MAP: StatusMap<HandoverState> = {
  PENDING: { tone: 'warning', label: 'Waiting for the receiver' },
  COMPLETED: { tone: 'success', label: 'Custody handed over' },
  FAILED: { tone: 'danger', label: 'Did not happen' },
};

export const FAILURE_LABELS: Readonly<Record<NonNullable<StopView['failure_category']>, string>> = {
  VENDOR_UNAVAILABLE: 'The vendor was not available',
  ACCESS_DENIED: 'Access was denied',
  PARCEL_NOT_READY: 'The parcel was not ready',
  REFUSED_COLLECTION: 'The collection was refused',
};

/**
 * The reason a stop was skipped, in words. A system skip is told as what it is; an officer's skip is told by the label the catalogue gives its
 * code, and when the catalogue no longer offers the code (it was retired, or the reasons could not be read) as a skip whose reason is not in the
 * current list, never as the code itself.
 */
export function skipReasonText(
  stop: StopView,
  catalogue: readonly AttributedReason[] | undefined,
): string | undefined {
  const skip = stop.skipped;
  if (skip === undefined) return undefined;
  if (skip.reason_code === 'REQUEST_CANCELLED') {
    return 'Its request was cancelled, so the stop was skipped with it.';
  }
  if (skip.reason_code === 'MANIFEST_CANCELLED') {
    return 'The manifest was cancelled, so the stop was skipped with it.';
  }
  const label = catalogue?.find((reason) => reason.code === skip.reason_code)?.label;
  return label === undefined
    ? 'Skipped by Ops. The reason is not in the current list of reasons.'
    : `Skipped by Ops: ${label}.`;
}

/** The stops of a manifest in words: "3 stops", "1 stop". */
export function stopsText(count: number): string {
  return `${String(count)} ${count === 1 ? 'stop' : 'stops'}`;
}

/**
 * What the server's rule for a place of the manifest being made means to the officer, in words. The places are of the request list
 * (`/pickup_request_ids/n`), of the day (`/service_date`) and of the carry-over entries (`/carryover/n`); a rule these words do not know is
 * told as a refusal and never as the rule itself.
 */
export const CREATION_RULE_WORDS: Readonly<Record<string, string>> = {
  already_manifested: 'Already on a manifest.',
  not_available: 'Not available for a manifest: it is not there, or not one your session acts on.',
  duplicate: 'Chosen twice.',
  hub_mismatch: 'Belongs to another hub than the first request chosen.',
  not_confirmed: 'Not confirmed any more.',
  awaiting_cutoff_review: 'Its late booking still waits for an Ops decision.',
  before_scheduled_day: 'Promised for a later day than this run’s.',
  promise_changed: 'Its promised day changed while you were choosing. Refresh the pool.',
  carryover_reason_required: 'Promised for an earlier day: it needs a carry-over reason.',
  reason: 'The carry-over reason was not accepted.',
  format: 'Choose a day that exists.',
  operating_day: 'The hub does not run on that day. Runs go from Monday to Saturday.',
  past_day: 'That day has passed. Choose today or a later day.',
};

export const creationRuleWords = (rule: string): string =>
  Object.hasOwn(CREATION_RULE_WORDS, rule) ? (CREATION_RULE_WORDS[rule] ?? '') : 'Not accepted.';
