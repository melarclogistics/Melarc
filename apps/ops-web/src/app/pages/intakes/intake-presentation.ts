import type { StatusMap } from '../../../components/ui/status-badge/StatusBadge';
import type {
  AdjudicationOutcome,
  CountVariance,
  FindingKind,
  FindingView,
  IntakeBaseView,
  IntakeCondition,
  IntakeState,
  ReceiverHold,
} from '../../../platform/hub-intake/hub-intake-shape';
import { receiverHoldOf } from '../../../platform/hub-intake/hub-intake-shape';
import { formatInstant } from '../../../platform/time/format-time';
import { actorText } from '../pickup/pickup-presentation';

/**
 * How the receiving screens say things (S1.35): what a state is called and the sentences an intake's facts are told in. The words belong to the screens and not to the server; every mapping is typed over
 * its whole enumeration, so a value the contract adds is a compile error here until someone decides how it reads. A state is told by its words, and the tone supports them and never carries them.
 * **Nothing here works out a count, a difference or a state:** the comparison and the state are the server's and this only puts them into words. No sentence draws the rider's declaration before the
 * count, and none names an officer (the answers carry an identifier and the portal reads no staff directory).
 */

/** What each state of an intake is called. */
export const INTAKE_STATE_MAP: StatusMap<IntakeState> = {
  AWAITING_COUNT: { tone: 'warning', label: 'Awaiting count' },
  COUNTED: { tone: 'info', label: 'Counted' },
  RECONCILIATION_REQUIRED: { tone: 'warning', label: 'Needs a decision' },
  READY_FOR_ITEMIZATION: { tone: 'success', label: 'Ready to itemise' },
  ITEMIZING: { tone: 'info', label: 'Being itemised' },
  CLOSED: { tone: 'neutral', label: 'Closed' },
};

/** The server's comparison of the count with the declaration, as a state in words. */
export const VARIANCE_MAP: StatusMap<CountVariance> = {
  MATCH: { tone: 'success', label: 'Matches' },
  SHORT: { tone: 'warning', label: 'Short' },
  OVER: { tone: 'warning', label: 'Over' },
};

/** What the receiver found: independent of the count, and never collapsed with it. */
export const CONDITION_MAP: StatusMap<IntakeCondition> = {
  OK: { tone: 'success', label: 'Good condition' },
  DAMAGED: { tone: 'danger', label: 'Damaged' },
  TAMPERED: { tone: 'danger', label: 'Tampered with' },
  OTHER: { tone: 'warning', label: 'Another problem' },
};

/** The choices of a condition, for the forms: a name and what choosing it means. */
export const CONDITION_CHOICES: readonly {
  readonly value: IntakeCondition;
  readonly label: string;
  readonly help: string;
}[] = [
  {
    value: 'OK',
    label: 'Good condition',
    help: 'Nothing wrong with the parcels or their packing. This changes nothing.',
  },
  {
    value: 'DAMAGED',
    label: 'Damaged',
    help: 'A parcel is damaged. A photo is needed, and a senior officer reviews it.',
  },
  {
    value: 'TAMPERED',
    label: 'Tampered with',
    help: 'A parcel looks opened or its seal is broken. A photo is needed, and a senior officer reviews it.',
  },
  {
    value: 'OTHER',
    label: 'Another problem',
    help: 'Something else is wrong. Say what in the note.',
  },
];

/** What each outcome of an adjudication is called, and what it does and does not do. */
export const OUTCOME_CHOICES: readonly {
  readonly value: AdjudicationOutcome;
  readonly label: string;
  readonly help: string;
}[] = [
  {
    value: 'ACCEPTED',
    label: 'Accept the count',
    help: 'The count stands. The intake is cleared for itemising.',
  },
  {
    value: 'WRITTEN_OFF',
    label: 'Write off the difference',
    help: 'Records that the difference is written off. The intake is cleared for itemising.',
  },
  {
    value: 'VENDOR_NOTIFIED',
    label: 'Vendor notified',
    help: 'Records that the vendor was told of the difference. The portal sends no message. The intake is cleared for itemising.',
  },
  {
    value: 'ESCALATED',
    label: 'Escalate',
    help: 'Records your reason and leaves the case open for a later decision.',
  },
];

export const OUTCOME_WORDS: Readonly<Record<AdjudicationOutcome, string>> = {
  ACCEPTED: 'Count accepted',
  WRITTEN_OFF: 'Difference written off',
  VENDOR_NOTIFIED: 'Vendor notified',
  ESCALATED: 'Escalated, still open',
};

export const FINDING_KIND_WORDS: Readonly<Record<FindingKind, string>> = {
  CONDITION: 'Condition recorded at receiving',
  ADJUDICATION: 'Decided by a senior officer',
};

/** What the record's header says of where the intake stands and what can be done next, in plain words: the server's state, said as a sentence. */
export const STATE_SENTENCES: Readonly<Record<IntakeState, string>> = {
  AWAITING_COUNT:
    'Waiting to be counted. The count is blind: the number the rider declared is shown once your count is recorded.',
  COUNTED: 'Counted. The result is being settled.',
  RECONCILIATION_REQUIRED: 'The count or the condition needs a senior officer’s decision.',
  READY_FOR_ITEMIZATION:
    'Counted and cleared. Itemising and closing an intake are later work: nothing on this page starts them.',
  ITEMIZING: 'Itemising has begun.',
  CLOSED: 'Closed.',
};

/** The words of the lock, by who holds it: never a name. */
export function holderWords(hold: ReceiverHold): { readonly who: string; readonly since?: string } {
  if (hold.kind === 'nobody') return { who: 'No one' };
  const since = formatInstant(hold.since);
  return {
    who: hold.kind === 'you' ? 'You' : 'Another receiver',
    ...(since === undefined ? {} : { since }),
  };
}

/** Who is receiving an intake now, for a cell of the queue: "No one", "You", or "Another receiver" with when they were last active. */
export function receivingNowText(
  intake: Pick<IntakeBaseView, 'active_receiver_id' | 'lock_acquired_at'>,
  principalId: string | undefined,
): string {
  const { who, since } = holderWords(receiverHoldOf(intake, principalId));
  return since === undefined ? who : `${who}, last active ${since}`;
}

/** A count of parcels in words. */
export const parcelsText = (count: number): string =>
  `${String(count)} ${count === 1 ? 'parcel' : 'parcels'}`;

/**
 * The comparison in words, from the server's variance and its difference: the page works out nothing, it only says which side the count is on and, where the server gave it, by how many. A difference
 * the server did not state is not worked out.
 */
export function differenceText(variance: CountVariance, difference: number | null): string {
  if (variance === 'MATCH') return 'The count matches what the rider declared.';
  const by = difference === null ? undefined : parcelsText(Math.abs(difference));
  if (variance === 'SHORT') {
    return by === undefined
      ? 'The count is short of what the rider declared.'
      : `The count is ${by} short of what the rider declared.`;
  }
  return by === undefined
    ? 'The count is over what the rider declared.'
    : `The count is ${by} over what the rider declared.`;
}

/** Who made a finding and when, for the line under it: an officer is never named. */
export function findingByline(finding: FindingView, principalId: string | undefined): string {
  const who = actorText(finding.recorded_by, principalId);
  const when = formatInstant(finding.recorded_at);
  return when === undefined ? who : `${who}, ${when}`;
}

/** What a page that did an act tells the record it brings the officer to, once: which act was done. */
export interface DoneState {
  readonly done?: 'counted' | 'condition' | 'adjudicated';
}

export const intakePath = (id: string): string => `/intakes/${id}`;
export const countPath = (id: string): string => `/intakes/${id}/count`;
export const conditionPath = (id: string): string => `/intakes/${id}/condition`;
export const discrepancyPath = (id: string): string => `/intakes/${id}/discrepancy`;
