import type {
  CountsView,
  ParcelState,
  RunSummaryView,
  VendorView,
} from '../../../platform/hub-receiving/receiving-shape';
import type { IntakeState } from '../../../platform/hub-intake/hub-intake-shape';
import type { StatusMap } from '../../../components/ui/status-badge/StatusBadge';

/**
 * How the receiving screens of a run say things (S1.35c): the sentences a run's and a vendor's facts are told in, in the floor's vocabulary (*run, vendor, parcels, check in, missing, extra, damaged, decide*). **Nothing
 * here works out a count, a difference or a state**: the counts and the state are the API's and this only puts them into words, and a state is told by its words, with the tone supporting them and never carrying
 * them. Every mapping is typed over its whole enumeration, so a value the contract adds is a compile error here until someone decides how it reads. The words are drafts for the Product Owner (OB-S1-111).
 */
export const runPath = (manifestId: string): string => `/receiving/${manifestId}`;
export const RECEIVING_QUEUE_PATH = '/receiving';

/** The number of parcels, in words ("1 parcel", "12 parcels"). */
export const parcelsText = (count: number): string =>
  `${String(count)} ${count === 1 ? 'parcel' : 'parcels'}`;

/** The vendors of a run, by name: the first two and how many more ("Kente Crafts, Shea Naturals +2 more"). */
export function vendorsText(names: readonly string[], shown = 2): string {
  const first = names.slice(0, shown).join(', ');
  const more = names.length - shown;
  return more > 0 ? `${first} +${String(more)} more` : first;
}

/** Who is checking a run in now, for a cell of the queue: "No one", or the officers' names with "You" for the caller. */
export function checkingInText(people: RunSummaryView['checking_in']): string {
  if (people.length === 0) return 'No one';
  return people.map((person) => (person.is_you ? 'You' : person.name)).join(', ');
}

/** What is left to do on a run, in words, from the counts of its row: the vendors that wait, the vendors that need a decision and the parcels being searched for. */
export function toDoText(run: RunSummaryView): readonly string[] {
  const lines: string[] = [];
  if (run.vendors_waiting > 0) {
    lines.push(
      `${String(run.vendors_waiting)} of ${String(run.vendors_total)} ${run.vendors_total === 1 ? 'vendor' : 'vendors'} still to check in`,
    );
  }
  if (run.vendors_needing_decision > 0) {
    lines.push(
      `${String(run.vendors_needing_decision)} ${run.vendors_needing_decision === 1 ? 'vendor needs' : 'vendors need'} a decision`,
    );
  }
  if (run.missing_searching > 0) {
    lines.push(`${parcelsText(run.missing_searching)} being searched for`);
  }
  if (lines.length === 0) lines.push('Everything is checked in');
  return lines;
}

/** What a vendor's section says of where it stands, in a sentence the officer can act on: the API's state, said in the floor's words. */
export const VENDOR_STATE_MAP: StatusMap<IntakeState> = {
  AWAITING_COUNT: { tone: 'warning', label: 'Waiting to be checked in' },
  COUNTED: { tone: 'info', label: 'Checked in' },
  RECONCILIATION_REQUIRED: { tone: 'warning', label: 'Needs a decision' },
  READY_FOR_ITEMIZATION: { tone: 'success', label: 'Checked in and cleared' },
  ITEMIZING: { tone: 'info', label: 'Orders being listed' },
  CLOSED: { tone: 'neutral', label: 'Closed' },
};

/** What a parcel is called, by its state. Missing and extra are said in words and never by colour alone. */
export const PARCEL_STATE_MAP: StatusMap<ParcelState> = {
  EXPECTED: { tone: 'neutral', label: 'Not checked in' },
  ARRIVED: { tone: 'success', label: 'Checked in' },
  MISSING: { tone: 'danger', label: 'Missing' },
  VOID: { tone: 'neutral', label: 'Taken back' },
};

/** The condition of a parcel, in words: **"Not checked yet" until someone has recorded one** (never "Good condition" from a default). */
export function conditionWords(condition: VendorView['parcels'][number]['condition']): string {
  if (condition === null) return 'Condition not checked yet';
  switch (condition.condition) {
    case 'OK':
      return 'Looks fine';
    case 'DAMAGED':
      return 'Damaged';
    case 'TAMPERED':
      return 'Tampered with';
    case 'OTHER':
      return 'Another problem';
  }
}

/** The sentence under a vendor's name: what was photographed at the door, or that it is counted without photos. */
export function photographedText(vendor: VendorView): string {
  if (vendor.receiving_mode === 'BLIND_COUNT')
    return 'No photos at the door: counted, not checked in';
  const expected = vendor.parcels_expected ?? 0;
  return `${parcelsText(expected)} photographed`;
}

/**
 * What a finished vendor came to, from its counts, in the floor's words ("11 arrived, 1 missing"). **The counts are the API's**: this draws them and works out nothing. A vendor still waiting says how many
 * have been checked in so far.
 */
export function countsText(vendor: Pick<VendorView, 'state'> & CountsView): string {
  const parts: string[] = [];
  const arrived = vendor.arrived_count;
  if (arrived !== null) parts.push(`${String(arrived)} checked in`);
  if (vendor.missing_count > 0) parts.push(`${String(vendor.missing_count)} missing`);
  if (vendor.extra_count > 0) parts.push(`${String(vendor.extra_count)} extra`);
  if (vendor.damaged_count > 0) parts.push(`${String(vendor.damaged_count)} damaged`);
  return parts.join(', ');
}
