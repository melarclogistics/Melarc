import type { StatusMap } from '../../../components/ui/status-badge/StatusBadge';
import type {
  ContactMethod,
  CountVariance,
  DisputeState,
  EscalationView,
  EvidenceState,
  FailureDecision,
  HandshakeChannel,
  HandshakeState,
  OpsHandshakeView,
  RoutedBecause,
} from '../../../platform/pickup-work/pickup-work-shape';
import { formatInstant } from '../../../platform/time/format-time';
import { actorText } from '../pickup/pickup-presentation';

/**
 * How the screens of the door and the failure say things (S1.30): what a state is called and the sentences a record's facts are told in. The words belong to the screens and not to the
 * server; every mapping is typed over its whole enumeration, so a value the contract adds is a compile error here until someone decides how it reads. A state is told by its words, and the tone
 * supports them and never carries them. **Nothing here works out a time, a count or a total:** the wait of a failure, the counters of a handshake and the progress of the photos are the server's
 * figures, and this only puts them into words. No sentence draws a code, a digest, a phone number or the name of an officer (the answers carry an identifier and no name).
 */

/** What became of a failure's request, as the queue shows it. A decision that waits is the office's to take; the others say what was decided. */
export const DECISION_MAP: StatusMap<FailureDecision> = {
  PENDING: { tone: 'warning', label: 'Waiting for Ops' },
  ESCALATED: { tone: 'warning', label: 'Escalated, still waiting' },
  RESCHEDULED: { tone: 'success', label: 'Rescheduled' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled' },
};

/** Whether a decision is one that still waits for the office: the request is still confirmed. */
export const isWaiting = (decision: FailureDecision): boolean =>
  decision === 'PENDING' || decision === 'ESCALATED';

export const CONTACT_METHOD_WORDS: Readonly<Record<ContactMethod, string>> = {
  PHONE_CALL: 'Phone call',
  SMS: 'Text message',
  IN_PERSON: 'In person',
};

/**
 * A wait in words, from the figure the server gave: "Less than a minute", "25 min", "2 h 5 min", "1 d 3 h". It is the database's number put into units and never a clock of the page's: the
 * page works out no time (surfaces/ops-portal.md section 7).
 */
export function waitText(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'Less than a minute';
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
  }
  const days = Math.floor(hours / 24);
  const left = hours % 24;
  return left === 0 ? `${String(days)} d` : `${String(days)} d ${String(left)} h`;
}

/**
 * Who escalated a failure's request, in words (section 17.3): a person (never named), the scheduled backstop with the threshold it had passed and the wait it had reached as its event recorded
 * them, or an escalation the ledger holds no event for (told as that and never read as a person). `undefined` for a request that was not escalated.
 */
export function escalationText(escalation: EscalationView | null): string | undefined {
  if (escalation === null) return undefined;
  switch (escalation.by) {
    case 'PERSON':
      return 'Escalated by an officer.';
    case 'BACKSTOP': {
      const parts = [
        ...(escalation.threshold_hours === null
          ? []
          : [`it had passed the limit of ${String(escalation.threshold_hours)} hours`]),
        ...(escalation.waited_seconds === null
          ? []
          : [`it had waited ${waitText(escalation.waited_seconds)}`]),
      ];
      return parts.length === 0
        ? 'Escalated by the backstop.'
        : `Escalated by the backstop: ${parts.join(' and ')}.`;
    }
    case 'UNKNOWN':
      return 'Escalated. Who escalated it is not recorded.';
  }
}

/** The moment of a failure's escalation, as a line, or nothing. */
export function escalatedLine(
  escalatedAt: string | null,
  escalation: EscalationView | null,
): string {
  const when = escalatedAt === null ? undefined : formatInstant(escalatedAt);
  const who = escalationText(escalation) ?? 'Not escalated.';
  return when === undefined ? who : `${who} ${when}`;
}

/** What each state of a handshake is called. A handshake that waits for the vendor is told as that: the office has nothing to do until it needs it. */
export const HANDSHAKE_STATE_MAP: StatusMap<HandshakeState> = {
  PENDING: { tone: 'neutral', label: 'Not asked for yet' },
  CODE_GENERATED: { tone: 'info', label: 'Code made' },
  CODE_DELIVERED: { tone: 'info', label: 'Code with the vendor' },
  VERIFIED: { tone: 'success', label: 'Confirmed' },
  EXPIRED: { tone: 'warning', label: 'Code ran out' },
  EXHAUSTED: { tone: 'warning', label: 'Attempts used up' },
  DISPUTED: { tone: 'danger', label: 'Disputed' },
  MANUALLY_RESOLVED: { tone: 'success', label: 'Settled by Ops' },
};

/** Why a handshake needs Ops (`routed_because`), in the words of the policy (state-machines.md section 6). */
export const ROUTED_WORDS: Readonly<Record<RoutedBecause, string>> = {
  CODE_EXPIRED: 'The code ran out before the vendor entered it.',
  ATTEMPTS_EXHAUSTED: 'The vendor used up the attempts to enter it.',
  FALLBACK_LIMIT_REACHED: 'The text-message fallback has sent all it may.',
};

/** How a handshake was closed, for one Ops settled (`channel`). */
export const CHANNEL_WORDS: Readonly<Record<HandshakeChannel, string>> = {
  PORTAL: 'The vendor confirmed it in the portal.',
  SMS_FALLBACK: 'The vendor confirmed it by text message.',
  OPS_OVERRIDE: 'Ops established the collection as an exception.',
};

/** A counter beside the limit the platform holds: "0 of 5". A limit the platform has no usable value for is said to be unknown, and never filled in with a default. */
export function countOfText(used: number, limit: number | null): string {
  return limit === null
    ? `${String(used)} (the limit is not known)`
    : `${String(used)} of ${String(limit)}`;
}

/** The same counter with what it counts, for a cell that holds two of them. */
export function counterText(used: number, limit: number | null, what: string): string {
  return `${what}: ${countOfText(used, limit)}`;
}

/** Whether Ops has settled a handshake: an officer resolved it by hand, or overrode it. */
export function isSettledByOps(handshake: OpsHandshakeView): boolean {
  return handshake.state === 'MANUALLY_RESOLVED' || handshake.channel === 'OPS_OVERRIDE';
}

/** Who settled a handshake and when, for one Ops settled. The officer is never named: the answer carries an identifier. */
export function settledText(
  handshake: OpsHandshakeView,
  principalId: string | undefined,
): string | undefined {
  if (!isSettledByOps(handshake)) return undefined;
  const who =
    handshake.authorised_by === null
      ? 'An officer'
      : actorText(handshake.authorised_by, principalId);
  const when = handshake.confirmed_at === null ? undefined : formatInstant(handshake.confirmed_at);
  return when === undefined ? `${who} settled it.` : `${who} settled it on ${when}.`;
}

/** What a stored, waiting or expired photo is called on its tile. */
export const EVIDENCE_STATE_WORDS: Readonly<Record<EvidenceState, string>> = {
  STORED: 'Stored',
  PENDING_UPLOAD: 'Waiting to upload',
  EXPIRED: 'Never uploaded',
};

export const EVIDENCE_STATE_MAP: StatusMap<EvidenceState> = {
  STORED: { tone: 'success', label: 'Stored' },
  PENDING_UPLOAD: { tone: 'warning', label: 'Waiting to upload' },
  EXPIRED: { tone: 'danger', label: 'Never uploaded' },
};

/** The count of something, with its noun in the right number. */
export const countText = (count: number, one: string, other: string): string =>
  `${String(count)} ${count === 1 ? one : other}`;

/** The figures of a count, as the server stated them: what was declared, what was counted, and by how many it fell short. */
export function shortCountText(declared: number, collected: number): string {
  return `${String(collected)} counted of ${String(declared)} declared`;
}

/** What a dispute a vendor raised is called. No operation resolves one in this slice, so every item is open until the reconciliation workflow exists. */
export const DISPUTE_STATE_MAP: StatusMap<DisputeState> = {
  OPEN: { tone: 'warning', label: 'Open' },
  RESOLVED: { tone: 'success', label: 'Resolved' },
};

/** What was counted at the door against what was declared, as the dispute's item states it. */
export const VARIANCE_WORDS: Readonly<Record<CountVariance, string>> = {
  MATCH: 'The count matched what was declared.',
  SHORT: 'The count was short of what was declared.',
};

/** The way to a stop's own page, where its photos open one at a time. */
export const stopPathOf = (manifestId: string, stopId: string): string =>
  `/manifests/${manifestId}/stops/${stopId}`;
