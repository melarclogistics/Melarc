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
  /** The vendor's name where the list carries it (a vendor checked in against photos); null for a vendor counted without photos. */
  readonly vendor_name: string | null;
  readonly run_code: string | null;
  readonly pickup_manifest_id: string;
  readonly handed_over_at: string;
  /** What the hub received: the parcels that arrived, or the count. */
  readonly received: number | null;
  readonly missing: number | null;
}

const MAX_PAGE_ITEMS = 500;
const MAX_TOKEN = 2048;
const READY: readonly IntakeState[] = ['READY_FOR_ITEMIZATION', 'ITEMIZING'];

function parseItem(entry: unknown): ItemizableIntakeView | undefined {
  if (!isRecord(entry)) return undefined;
  if (entry.count_phase === 'CHECK_IN') {
    const view = parseCheckIn(entry);
    if (view === undefined || !READY.includes(view.state)) return undefined;
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
      missing: view.missing_count,
    };
  }
  const intake = parseIntake(entry);
  if (intake?.count_phase !== 'POST_COUNT' || !READY.includes(intake.state)) return undefined;
  return {
    id: intake.id,
    code: intake.code,
    state: intake.state,
    mode: 'BLIND_COUNT',
    vendor_name: null,
    run_code: null,
    pickup_manifest_id: intake.pickup_manifest_id,
    handed_over_at: intake.handed_over_at,
    received: intake.physical_count,
    missing: null,
  };
}

export function parseIntakeListPage(
  body: unknown,
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
    const item = parseItem(entry);
    if (item === undefined || seen.has(item.id.toLowerCase())) return undefined;
    seen.add(item.id.toLowerCase());
    items.push(item);
  }
  return { items, nextPageToken: token };
}
