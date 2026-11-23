import type { StatusMap } from '../../../components/ui/status-badge/StatusBadge';
import type {
  CorrectionState,
  GateState,
  PriceComponentView,
  WorkState,
  WorklistViewId,
} from '../../../platform/hub-orders/orders-shape';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';

/**
 * How the order screens (S1.40) put a fact into words and into a place: the routes, the tone of each state and the words a price's parts are told in. **The words themselves are in `ORDERS_WORDS`
 * (`platform/problem/orders-copy.ts`), drafts for the Product Owner; this holds the tone of each state, which the words never carry alone.** Nothing here works out a price, a count or a date: they are the
 * server's, and this only puts them into words. Every mapping is typed over the contract's enumeration, so a value the contract adds is a compile error here until someone decides how it reads.
 */

/** A vendor's orders: the work that is really left, and the pages of its acts. */
export const ordersPath = (intakeId: string): string => `/intakes/${intakeId}/orders`;
export const newOrderPath = (intakeId: string, parcelId?: string): string =>
  parcelId === undefined
    ? `/intakes/${intakeId}/orders/new`
    : `/intakes/${intakeId}/orders/new?parcel=${parcelId}`;
export const closePath = (intakeId: string): string => `/intakes/${intakeId}/close`;
export const summaryPath = (intakeId: string): string => `/intakes/${intakeId}/summary`;
/** An order, and the page of its change. */
export const orderPath = (orderId: string): string => `/orders/${orderId}`;
export const amendPath = (orderId: string): string => `/orders/${orderId}/amend`;
export const CORRECTIONS_PATH = '/payer-corrections';
export const correctionPath = (id: string): string => `/payer-corrections/${id}`;
export const CLOSED_VENDORS_PATH = '/closed-vendors';
export const ORDERS_TO_MAKE_PATH = '/orders-to-make';
export const RECEIVING_PATH = '/receiving';
export const messageLogPath = (requestId: string): string =>
  `/messages?subject=${requestId}&subject_type=PICKUP_REQUEST`;

/** The tone of each state of a parcel's work, which the label never carries alone. */
export const WORK_STATE_MAP: StatusMap<WorkState> = {
  NEEDS_ORDER: { tone: 'warning', label: WORDS.workspace.state.NEEDS_ORDER },
  AWAITING_ARRIVAL: { tone: 'neutral', label: WORDS.workspace.state.AWAITING_ARRIVAL },
  PREPARED: { tone: 'info', label: WORDS.workspace.state.PREPARED },
  ITEMIZED: { tone: 'success', label: WORDS.workspace.state.ITEMIZED },
  MISSING: { tone: 'danger', label: WORDS.workspace.state.MISSING },
};

/** What an order's price is, beside what its commercial state is: an early quote is not a fixed price. */
export type OrderStanding = 'EARLY_QUOTE' | 'FROZEN' | 'REVERSED';
export const ORDER_STANDING_MAP: StatusMap<OrderStanding> = {
  EARLY_QUOTE: { tone: 'info', label: WORDS.record.status.EARLY_QUOTE },
  FROZEN: { tone: 'success', label: WORDS.record.status.FROZEN },
  REVERSED: { tone: 'neutral', label: WORDS.record.status.REVERSED },
};

export const CORRECTION_STATE_MAP: StatusMap<CorrectionState> = {
  REQUESTED: { tone: 'warning', label: WORDS.corrections.state.REQUESTED },
  APPROVED: { tone: 'success', label: WORDS.corrections.state.APPROVED },
  REJECTED: { tone: 'neutral', label: WORDS.corrections.state.REJECTED },
};

/** Where an order stands commercially, in the words of the floor: it never says an order is paid when it is only not charged. */
export function commercialText(state: string | null): string | undefined {
  if (state === null) return undefined;
  return (WORDS.record.commercial as Readonly<Record<string, string>>)[state];
}

export const GATE_WORDS: Readonly<Record<GateState, string>> = WORDS.review.gate;

/** The name of a part of a price, in the words of the floor; a kind the table has no words for is told as another charge and never as its code. */
export function componentText(component: PriceComponentView): string {
  return (
    (WORDS.review.kinds as Readonly<Record<string, string>>)[component.kind] ??
    WORDS.review.unknownKind
  );
}

/** Whether a worklist view is one of the server's. */
export const isWorklistView = (value: string | null): value is WorklistViewId =>
  value === 'all' ||
  value === 'needs_order' ||
  value === 'awaiting_arrival' ||
  value === 'prepared' ||
  value === 'itemized' ||
  value === 'payment_required' ||
  value === 'missing';

/** The way a window of the day is told: `09:00 to 13:00`, or nothing where the server gave none. */
export function windowText(start: string | null, end: string | null): string | undefined {
  return start === null || end === null ? undefined : `${start} to ${end}`;
}
