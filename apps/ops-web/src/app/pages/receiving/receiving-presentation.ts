import type { StatusMap } from '../../../components/ui/status-badge/StatusBadge';
import type { CountVariance, IntakeState } from '../../../platform/hub-intake/hub-intake-shape';
import type { FindingView as BlindFindingView } from '../../../platform/hub-intake/hub-intake-shape';
import type {
  CheckInView,
  CountsView,
  FindingView,
  ParcelState,
  RunSummaryView,
  VendorView,
} from '../../../platform/hub-receiving/receiving-shape';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { formatInstant } from '../../../platform/time/format-time';
import { actorText } from '../pickup/pickup-presentation';

/**
 * How the receiving screens of a run put a fact into words (S1.35c): the tone of a state and the sentences a run's and a vendor's counts are told in. **The words themselves are in one place**
 * (`RECEIVING_WORDS`, `platform/problem/receiving-copy.ts`), drafts for the Product Owner (OB-S1-111); this holds the tone of each state, which the words never carry alone, and the sentences that are
 * made of a count. **Nothing here works out a count, a difference or a state**: the counts and the state are the API's and this only puts them into words. Every mapping is typed over its whole
 * enumeration, so a value the contract adds is a compile error here until someone decides how it reads.
 */
export const runPath = (manifestId: string): string => `/receiving/${manifestId}`;
export const RECEIVING_QUEUE_PATH = '/receiving';
export const MISSING_PARCELS_PATH = '/missing-parcels';
/** A vendor's record, and the pages of the acts on it: the count of a vendor with no photos, and the senior officer's decision. */
export const recordPath = (id: string): string => `/intakes/${id}`;
export const countPath = (id: string): string => `/intakes/${id}/count`;
export const decisionPath = (id: string): string => `/intakes/${id}/discrepancy`;

/** What a page that did an act tells the record it brings the officer to, once: which act was done. */
export interface DoneState {
  readonly done?: 'counted' | 'damage' | 'decided';
}

/** The number of parcels, in words ("1 parcel", "12 parcels"). */
export const parcelsText = WORDS.parcels;

/** The vendors of a run, by name: the first two and how many more ("Kente Crafts, Shea Naturals +2 more"). */
export function vendorsText(names: readonly string[], shown = 2): string {
  return WORDS.queue.vendorNames(names.slice(0, shown).join(', '), names.length - shown);
}

/** Who is checking a run in now, for a cell of the queue: "No one", or the officers' names with "You" for the caller. */
export function checkingInText(people: RunSummaryView['checking_in']): string {
  if (people.length === 0) return WORDS.queue.noOne;
  return people.map((person) => (person.is_you ? WORDS.queue.you : person.name)).join(', ');
}

/** What is left to do on a run, in words, from the counts of its row: the vendors that wait, the vendors that need a decision and the parcels being searched for. */
export function toDoText(run: RunSummaryView): readonly string[] {
  const lines: string[] = [];
  if (run.vendors_waiting > 0) {
    lines.push(WORDS.queue.stillToCheckIn(run.vendors_waiting, run.vendors_total));
  }
  if (run.vendors_needing_decision > 0) {
    lines.push(WORDS.queue.needDecision(run.vendors_needing_decision));
  }
  if (run.missing_searching > 0) {
    lines.push(WORDS.queue.beingSearchedFor(run.missing_searching));
  }
  if (lines.length === 0) lines.push(WORDS.queue.allCheckedIn);
  return lines;
}

/** What a vendor's section says of where it stands: the API's state, said in the floor's words. */
export const VENDOR_STATE_MAP: StatusMap<IntakeState> = {
  AWAITING_COUNT: { tone: 'warning', label: WORDS.states.vendor.AWAITING_COUNT },
  COUNTED: { tone: 'info', label: WORDS.states.vendor.COUNTED },
  RECONCILIATION_REQUIRED: { tone: 'warning', label: WORDS.states.vendor.RECONCILIATION_REQUIRED },
  READY_FOR_ITEMIZATION: { tone: 'success', label: WORDS.states.vendor.READY_FOR_ITEMIZATION },
  ITEMIZING: { tone: 'info', label: WORDS.states.vendor.ITEMIZING },
  CLOSED: { tone: 'neutral', label: WORDS.states.vendor.CLOSED },
};

/** What a parcel is called, by its state. Missing and extra are said in words and never by colour alone. */
export const PARCEL_STATE_MAP: StatusMap<ParcelState> = {
  EXPECTED: { tone: 'neutral', label: WORDS.states.parcel.EXPECTED },
  ARRIVED: { tone: 'success', label: WORDS.states.parcel.ARRIVED },
  MISSING: { tone: 'danger', label: WORDS.states.parcel.MISSING },
  VOID: { tone: 'neutral', label: WORDS.states.parcel.VOID },
};

/** The condition of a parcel, in words: **"Not checked yet" until someone has recorded one** (never "Good condition" from a default). */
export function conditionWords(condition: VendorView['parcels'][number]['condition']): string {
  if (condition === null) return WORDS.states.conditionUnchecked;
  return WORDS.states.condition[condition.condition];
}

/**
 * The comparison of what was checked in or counted with what was expected, in words: **the API's variance and its difference** (`MATCH`, `SHORT` or `OVER`, and by how many where it says), which this puts into
 * words and works out nothing from. A difference the API did not state is said without its number.
 */
export function comparisonText(
  variance: CountVariance | null,
  difference: number | null,
): string | undefined {
  if (variance === null) return undefined;
  if (variance === 'MATCH') return WORDS.record.came.same;
  if (difference === null) return WORDS.record.came.differs[variance];
  const by = Math.abs(difference);
  return variance === 'SHORT' ? WORDS.record.came.fewer(by) : WORDS.record.came.more(by);
}

/**
 * What a vendor checked in against its photos came to, told against them, **true of the parcels and not only of the totals**: the API's comparison says the totals match (`MATCH`) for a vendor with a parcel
 * missing and one extra (four photographed, four checked in), and "the same" would be false of it, so a match with a parcel missing or extra says which (*1 missing, 1 extra*), and only a vendor with every
 * parcel here and none extra is *the same*. A count that is short or over is told as the API stated it (`comparisonText`). The page counts nothing: the numbers are the API's.
 */
export function checkInComparison(
  counts: Pick<CountsView, 'count_variance' | 'missing_count' | 'extra_count'>,
  difference: number | null,
): string | undefined {
  if (counts.count_variance === 'MATCH' && (counts.missing_count > 0 || counts.extra_count > 0)) {
    return [
      ...(counts.missing_count > 0 ? [WORDS.counts.missing(counts.missing_count)] : []),
      ...(counts.extra_count > 0 ? [WORDS.counts.extra(counts.extra_count)] : []),
    ].join(', ');
  }
  return comparisonText(counts.count_variance, difference);
}

/** The sentence under a vendor's name: what was photographed at the door, or that it is counted without photos. */
export function photographedText(vendor: VendorView): string {
  if (vendor.receiving_mode === 'BLIND_COUNT') return WORDS.vendor.blindPhotographed;
  return WORDS.vendor.photographed(vendor.parcels_expected ?? 0);
}

/**
 * What a finished vendor came to, from its counts, in the floor's words ("11 checked in, 1 missing"). **The counts are the API's**: this draws them and works out nothing. **A parcel that is not on the list and
 * a damaged parcel are checked in**, so they are told inside the count of the ones checked in ("4 checked in (1 not on the list, 1 damaged), 1 missing"), where beside it they read as more parcels than came
 * (seven for a vendor of five). A vendor with no count of ones checked in (counted without photos) says each as it is.
 */
export function countsText(vendor: Pick<VendorView, 'state'> & CountsView): string {
  const missing = vendor.missing_count > 0 ? [WORDS.counts.missing(vendor.missing_count)] : [];
  const damaged = vendor.damaged_count > 0 ? [WORDS.counts.damaged(vendor.damaged_count)] : [];
  if (vendor.arrived_count === null) {
    const extra = vendor.extra_count > 0 ? [WORDS.counts.extra(vendor.extra_count)] : [];
    return [...missing, ...extra, ...damaged].join(', ');
  }
  const among = [
    ...(vendor.extra_count > 0 ? [WORDS.counts.notOnTheList(vendor.extra_count)] : []),
    ...damaged,
  ];
  const checkedIn = WORDS.counts.checkedIn(vendor.arrived_count);
  return [among.length === 0 ? checkedIn : `${checkedIn} (${among.join(', ')})`, ...missing].join(
    ', ',
  );
}

/** One finding of a vendor as the record says it: what it is, in the floor's words, with its note, its photos and who made it. */
export interface FindingLine {
  readonly id: string;
  readonly title: string;
  /** What the decision was, for a decision. */
  readonly facts: string | undefined;
  readonly note: string | null;
  /** The evidence records of its photos, in the order they were attached: never drawn, opened one at a time. */
  readonly evidenceIds: readonly string[];
  readonly byline: string;
}

/** What a finding of a check-in is called, by whether it is a condition (of a parcel, or of the whole vendor) or a decision. */
export function checkInFindings(view: CheckInView): readonly FindingLine[] {
  return view.condition_findings.map((finding: FindingView): FindingLine => {
    const when = formatInstant(finding.recorded_at) ?? '';
    const byline = WORDS.record.found.by(finding.recorded_by_name, when);
    if (finding.kind === 'ADJUDICATION') {
      return {
        id: finding.id,
        title: WORDS.record.found.decision,
        facts: finding.outcome === null ? undefined : WORDS.record.found.outcomes[finding.outcome],
        note: finding.note,
        evidenceIds: finding.evidence_ids,
        byline,
      };
    }
    const what = finding.condition === null ? '' : WORDS.states.condition[finding.condition];
    const parcel =
      finding.intake_parcel_id === null
        ? undefined
        : view.parcels.find(
            (candidate) => candidate.id.toLowerCase() === finding.intake_parcel_id?.toLowerCase(),
          );
    return {
      id: finding.id,
      title:
        parcel === undefined
          ? WORDS.record.found.wholeVendor(what)
          : WORDS.record.found.onParcel(
              WORDS.parcel.label(parcel.ordinal, parcel.origin === 'HUB_EXTRA'),
              what,
            ),
      facts: undefined,
      note: finding.note,
      evidenceIds: finding.evidence_ids,
      byline,
    };
  });
}

/** The findings of a vendor counted without photos: a person is an identifier there, so the line says *You* or *Another member of staff*, and never a name. */
export function blindFindings(
  findings: readonly BlindFindingView[],
  principalId: string | undefined,
): readonly FindingLine[] {
  return findings.map((finding): FindingLine => {
    const when = formatInstant(finding.recorded_at) ?? '';
    const byline = WORDS.record.found.by(actorText(finding.recorded_by, principalId), when);
    if (finding.kind === 'ADJUDICATION') {
      return {
        id: finding.id,
        title: WORDS.record.found.decision,
        facts: finding.outcome === null ? undefined : WORDS.record.found.outcomes[finding.outcome],
        note: finding.note,
        evidenceIds: finding.evidence_ids,
        byline,
      };
    }
    return {
      id: finding.id,
      title: WORDS.record.found.wholeVendor(
        finding.condition === null ? '' : WORDS.states.condition[finding.condition],
      ),
      facts: undefined,
      note: finding.note,
      evidenceIds: finding.evidence_ids,
      byline,
    };
  });
}

/**
 * Whether a vendor's missing parcels were written off, and whether someone has since been recorded as telling the vendor: **from its findings, which are the API's** (a decision is a finding of the vendor).
 * *Vendor told* is a record that follows a write-off and is made once, so the decision is offered only while a write-off stands and no such record does; the API judges it all the same.
 */
export function vendorTold(
  findings: readonly {
    readonly kind: 'CONDITION' | 'ADJUDICATION';
    readonly outcome: string | null;
  }[],
): { readonly writtenOff: boolean; readonly told: boolean } {
  const decisions = findings.filter((finding) => finding.kind === 'ADJUDICATION');
  return {
    writtenOff: decisions.some((finding) => finding.outcome === 'WRITTEN_OFF'),
    told: decisions.some((finding) => finding.outcome === 'VENDOR_NOTIFIED'),
  };
}
