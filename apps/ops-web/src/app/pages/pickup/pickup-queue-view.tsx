import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import {
  CellLines,
  NoWrap,
  RowTitle,
  type DataColumn,
} from '../../../components/ui/data-table/DataTable';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import type { PickupRequestView, PickupState } from '../../../platform/pickup/pickup-shape';
import { hubNameOf } from '../staff/staff-presentation';
import {
  canBeConfirmed,
  hasApprovedException,
  hasRequestedException,
  INTENT_LABELS,
  isSinglePackage,
  packagesText,
  PICKUP_STATE_MAP,
  serviceDateText,
} from './pickup-presentation';

/**
 * How the pickup queue draws a request (surfaces/ops-portal.md section 7, `/pickup-requests`; COMPONENT_PATTERNS section 22f): once as a row of six
 * columns, and once as a card for a room too narrow for them. Both are drawn from the same facts (`QueueFacts`), made once from the record, so
 * that neither can tell less than the other. Nothing here fetches, filters or decides: the server's order, the filters and the paging are the
 * page's, and what a person may do with a request is its own page's.
 */
const NOT_RECORDED = 'Not recorded';
/** What a dash means in the column of what a request needs: it says nothing about blockers, and does not say the request may go ahead. */
const NO_NOTE = 'No additional note';

/**
 * What the queue asks the person to look at on a row, in words: a late booking waiting for a decision, a single package whose exception is
 * still to be asked for, or one whose exception waits for its approver. These rules, and their order, are the queue's; a grouping of columns
 * does not add urgency, a blocker or a claim that a request may be confirmed.
 */
function attentionOf(request: PickupRequestView): string {
  // Only a confirmed request has a decision to make: one cancelled since keeps the decision it had, with nothing left to decide on it (as the
  // request's own page and the landing's count have it).
  if (request.state === 'CONFIRMED' && request.cutoff_exception_state === 'PENDING_OPS_REVIEW') {
    return 'Late booking to decide';
  }
  if (request.state === 'PENDING' && isSinglePackage(request) && !hasApprovedException(request)) {
    return hasRequestedException(request)
      ? 'One-package exception waiting for approval'
      : 'One-package exception to request';
  }
  return '';
}

/** What the queue tells of a request, in the words of the screen. `needs` is empty when nothing is asked of the person. */
export interface QueueFacts {
  readonly id: string;
  readonly code: string;
  readonly href: string;
  readonly state: PickupState;
  readonly sender: string;
  readonly date: string;
  /** The address the server resolved for the pickup, and no other. */
  readonly address: string;
  readonly hub: string;
  readonly packages: string;
  readonly bookedAs: string;
  readonly needs: string;
  /** The screen offers to confirm it (waiting, and not a single package without its approved exception). The server decides whatever is offered. */
  readonly confirmable: boolean;
}

export function queueFactsOf(
  request: PickupRequestView,
  hubs: readonly { readonly id: string; readonly display_name: string }[],
): QueueFacts {
  return {
    id: request.id,
    code: request.code,
    href: `/pickup-requests/${request.id}`,
    state: request.state,
    sender: request.sender_name ?? NOT_RECORDED,
    date: serviceDateText(request.scheduled_service_date),
    address: request.resolved_pickup_location?.address ?? NOT_RECORDED,
    hub: hubNameOf(request.responsible_hub_id, hubs),
    packages: packagesText(request),
    bookedAs:
      request.pickup_intent === undefined ? NOT_RECORDED : INTENT_LABELS[request.pickup_intent],
    needs: attentionOf(request),
    confirmable: canBeConfirmed(request),
  };
}

/**
 * A dash for the eye, and for assistive technology what it stands for. The words are placed against their own dash (`position: relative`),
 * so that a table scrolled sideways inside its region takes them with it, as the message log's dash does (messages-page.css).
 */
function Dash({ means }: { readonly means: string }) {
  return (
    <span className="pickup-dash">
      <span aria-hidden="true">—</span>
      <span className="pickup-hidden">{means}</span>
    </span>
  );
}

/** The state as a badge, on one line: the column takes its width. */
function State({ state }: { readonly state: PickupState }) {
  return <StatusBadge status={state} map={PICKUP_STATE_MAP} />;
}

const Needs = ({ text }: { readonly text: string }) =>
  text === '' ? <Dash means={NO_NOTE} /> : <>{text}</>;

/**
 * The nine facts of the queue in six columns, grouped by what they mean: who and which request, where it stands, when, where and for which hub, what is being
 * collected and as what, and what it needs. The code over the sender is the row's header, and **the button that opens the request in the panel beside the queue**
 * (the table draws it, stretched over the row); the row is no link. **The columns that go when the table's own box is narrow are the screen's choice, and the table takes them away only
 * as far as it takes for the box not to scroll sideways** (the Product Owner, 10 November 2026): the packages with the booking type first (weight 3), then the pickup address with the hub
 * (weight 2). The request with its sender, the state, the service date and what a request needs stay; a card, under 40rem, shows every fact.
 */
export const QUEUE_COLUMNS: readonly DataColumn<QueueFacts>[] = [
  {
    id: 'request',
    header: 'Request / sender',
    rowHeader: true,
    cell: (row) => <RowTitle code={row.code} name={row.sender} />,
  },
  { id: 'state', header: 'State', kind: 'badge', cell: (row) => <State state={row.state} /> },
  {
    id: 'date',
    header: 'Service date',
    kind: 'date',
    cell: (row) => <NoWrap>{row.date}</NoWrap>,
  },
  {
    id: 'where',
    header: 'Pickup address / hub',
    kind: 'prose',
    priority: 2,
    cell: (row) => <CellLines first={row.address} second={row.hub} />,
  },
  {
    id: 'packages',
    header: 'Packages / booking type',
    kind: 'count',
    priority: 3,
    cell: (row) => <CellLines first={row.packages} second={row.bookedAs} oneLine />,
  },
  { id: 'needs', header: 'Needs', kind: 'prose', cell: (row) => <Needs text={row.needs} /> },
];

/** What opens a request, for the pointer and for assistive technology: its code and its sender. */
export const openLabelOf = (row: QueueFacts): string => `Open ${row.code}, ${row.sender}`;

/**
 * A request as a card, for a room too narrow for the columns: the state, the sender, and then the facts in the order a person reads them, each a label and its value (`CardFacts`). It holds
 * **no control**: the table draws the card's one hit target (the button that opens the request, stretched over the card) and its heading, the code.
 */
export function QueueCard({ facts }: { readonly facts: QueueFacts }) {
  return (
    <CardFacts
      head={<State state={facts.state} />}
      lead={facts.sender}
      facts={[
        { label: 'Service date', value: facts.date },
        {
          label: 'Pickup address / hub',
          value: <CellLines first={facts.address} second={facts.hub} />,
        },
        {
          label: 'Packages / booking type',
          value: <CellLines first={facts.packages} second={facts.bookedAs} />,
        },
        { label: 'Needs', value: <Needs text={facts.needs} /> },
      ]}
    />
  );
}
