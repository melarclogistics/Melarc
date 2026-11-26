import { parseIntake, type IntakeState } from '../hub-intake/hub-intake-shape';
import { parseCheckIn } from '../hub-receiving/receiving-shape';
import type { WorkListPageView } from '../pickup-work/pickup-work-shape';
import { isRecord } from '../staff/staff-shape';

/**
 * A vendor a hub has cleared for its orders, as the list of vendors (`listHubIntakes`) gives it, **judged by the shapes the receiving screens already hold**: a vendor checked in against its door photos is
 * a check-in (`parseCheckIn`: the vendor's name, its run and what arrived), and a vendor counted without photos is the intake as the blind-count screens judge it (`parseIntake`; it has a code and its count, and no
 * name of its own). A row that is neither, or that carries a vendor that is not cleared for orders, is not this list's. The page draws what the list says and works out nothing: how many orders are made is the
 * worklist's, read when the vendor is opened.
 */
export interface ItemizableIntakeView {
  readonly id: string;
  readonly code: string;
  readonly state: IntakeState;
  readonly mode: 'PHOTO_CHECK_IN' | 'BLIND_COUNT';
  /** The vendor's name where the list carries it (a vendor checked in against photos, and, since Run G1, one counted without them); null where it names none. */
  readonly vendor_name: string | null;
  readonly run_code: string | null;
  readonly pickup_manifest_id: string;
  readonly handed_over_at: string;
  /** What the hub received: the parcels that arrived, or the count. */
  readonly received: number | null;
  /** How many parcels a vendor checked in against its photos arrived with (its door photos): null for a vendor counted without them, which has none of the rider's number to say. */
  readonly expected: number | null;
  readonly missing: number | null;
  /** The orders that stand, and the received parcels that still need one: the database's own count of the whole vendor (D-S7-6), null where the list did not say. */
  readonly orders_made: number | null;
  readonly parcels_needing_order: number | null;
  /** Why a senior officer is needed (D-S7-7, narrowed by D-S7-11), when one is: an arrival that was taken back. A vendor with parcels still to order is the officer's and never has a reason. */
  readonly senior_needed: 'ARRIVAL_TAKEN_BACK' | null;
}

/**
 * What a page of this list is for: the vendors cleared for orders (the default), or **the vendors whose check-in is open** (D-D6, Run G2, Part 2, item 1: the vendors an officer begins early orders for, from their
 * photos). The server's `AWAITING_COUNT` filter answers both a vendor checked in against its photos and a vendor counted without them that waits for its count, so that list leaves the second out (it has no photo to
 * make an order from), and refuses a vendor that is anywhere but at the start of its check-in.
 */
export interface IntakeListOptions {
  readonly checkingIn?: boolean;
}

const MAX_PAGE_ITEMS = 500;
const MAX_TOKEN = 2048;
const READY: readonly IntakeState[] = ['READY_FOR_ITEMIZATION', 'ITEMIZING'];

const countOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** The reason a senior is needed as the list says it: absent is none, and a value that is not the one reason is a refusal of the row (undefined). */
function seniorOf(value: unknown): ItemizableIntakeView['senior_needed'] | undefined {
  if (value === undefined) return null;
  return value === 'ARRIVAL_TAKEN_BACK' ? value : undefined;
}

/** A vendor is in the list in the states where orders are made, and in reconciliation only when a senior is needed for it (an arrival that was taken back). */
const inThisList = (state: IntakeState, senior: ItemizableIntakeView['senior_needed']): boolean =>
  READY.includes(state) || (senior !== null && state === 'RECONCILIATION_REQUIRED');

/** A row that is not wrong and is not this page's: a vendor counted without photos in the list of those whose check-in is open. */
const LEFT_OUT = 'left out';

function parseItem(
  entry: unknown,
  checkingIn: boolean,
): ItemizableIntakeView | typeof LEFT_OUT | undefined {
  if (!isRecord(entry)) return undefined;
  const senior = seniorOf(entry.senior_needed);
  if (senior === undefined) return undefined;
  const counts = {
    orders_made: countOf(entry.orders_made),
    parcels_needing_order: countOf(entry.parcels_needing_order),
    senior_needed: senior,
  };
  if (entry.count_phase === 'CHECK_IN') {
    const view = parseCheckIn(entry);
    if (view === undefined) return undefined;
    if (checkingIn ? view.state !== 'AWAITING_COUNT' : !inThisList(view.state, senior)) {
      return undefined;
    }
    return {
      id: view.id,
      code: view.code,
      state: view.state,
      mode: 'PHOTO_CHECK_IN',
      vendor_name: view.vendor_name,
      run_code: view.run_code,
      pickup_manifest_id: view.pickup_manifest_id,
      handed_over_at: view.handed_over_at,
      received: view.arrived_count,
      expected: view.parcels_expected,
      missing: view.missing_count,
      ...counts,
    };
  }
  // A vendor counted without photos that waits for its count is the server's answer to the same filter, and has no photo to make an order from.
  if (checkingIn) return parseIntake(entry) === undefined ? undefined : LEFT_OUT;
  const intake = parseIntake(entry);
  if (intake?.count_phase !== 'POST_COUNT' || !inThisList(intake.state, senior)) return undefined;
  return {
    id: intake.id,
    code: intake.code,
    state: intake.state,
    mode: 'BLIND_COUNT',
    vendor_name: intake.vendor_name,
    run_code: null,
    pickup_manifest_id: intake.pickup_manifest_id,
    handed_over_at: intake.handed_over_at,
    received: intake.physical_count,
    expected: null,
    missing: null,
    ...counts,
  };
}

export function parseIntakeListPage(
  body: unknown,
  options: IntakeListOptions = {},
): WorkListPageView<ItemizableIntakeView> | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_PAGE_ITEMS) {
    return undefined;
  }
  const token = body.next_page_token;
  if (token !== null && !(typeof token === 'string' && token !== '' && token.length <= MAX_TOKEN)) {
    return undefined;
  }
  const items: ItemizableIntakeView[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    const item = parseItem(entry, options.checkingIn === true);
    if (item === LEFT_OUT) continue;
    if (item === undefined || seen.has(item.id.toLowerCase())) return undefined;
    seen.add(item.id.toLowerCase());
    items.push(item);
  }
  return { items, nextPageToken: token };
}
