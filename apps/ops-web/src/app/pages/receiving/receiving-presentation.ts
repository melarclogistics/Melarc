import type { StatusMap } from '../../../components/ui/status-badge/StatusBadge';
import type { IntakeState } from '../../../platform/hub-intake/hub-intake-shape';
import type {
  CountsView,
  ParcelState,
  RunSummaryView,
  VendorView,
} from '../../../platform/hub-receiving/receiving-shape';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';

/**
 * How the receiving screens of a run put a fact into words (S1.35c): the tone of a state and the sentences a run's and a vendor's counts are told in. **The words themselves are in one place**
 * (`RECEIVING_WORDS`, `platform/problem/receiving-copy.ts`), drafts for the Product Owner (OB-S1-111); this holds the tone of each state, which the words never carry alone, and the sentences that are
 * made of a count. **Nothing here works out a count, a difference or a state**: the counts and the state are the API's and this only puts them into words. Every mapping is typed over its whole
 * enumeration, so a value the contract adds is a compile error here until someone decides how it reads.
 */
export const runPath = (manifestId: string): string => `/receiving/${manifestId}`;
export const RECEIVING_QUEUE_PATH = '/receiving';

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

/** The sentence under a vendor's name: what was photographed at the door, or that it is counted without photos. */
export function photographedText(vendor: VendorView): string {
  if (vendor.receiving_mode === 'BLIND_COUNT') return WORDS.vendor.blindPhotographed;
  return WORDS.vendor.photographed(vendor.parcels_expected ?? 0);
}

/**
 * What a finished vendor came to, from its counts, in the floor's words ("11 checked in, 1 missing"). **The counts are the API's**: this draws them and works out nothing. A vendor still waiting says how
 * many have been checked in so far.
 */
export function countsText(vendor: Pick<VendorView, 'state'> & CountsView): string {
  const parts: string[] = [];
  const arrived = vendor.arrived_count;
  if (arrived !== null) parts.push(WORDS.counts.checkedIn(arrived));
  if (vendor.missing_count > 0) parts.push(WORDS.counts.missing(vendor.missing_count));
  if (vendor.extra_count > 0) parts.push(WORDS.counts.extra(vendor.extra_count));
  if (vendor.damaged_count > 0) parts.push(WORDS.counts.damaged(vendor.damaged_count));
  return parts.join(', ');
}
