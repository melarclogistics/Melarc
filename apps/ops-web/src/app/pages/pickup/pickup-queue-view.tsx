import type { ReactNode } from 'react';

import { Link } from '../../../components/ui/link/Link';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import type { TableColumn } from '../../../components/ui/table/Table';
import type { PickupRequestView, PickupState } from '../../../platform/pickup/pickup-shape';
import { hubNameOf } from '../staff/staff-presentation';
import {
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

/** Two facts that belong together, the first as it is and the second quieter beneath it. */
function Pair({ first, second }: { readonly first: string; readonly second: string }) {
  return (
    <span className="pickup-lines">
      <span>{first}</span>
      <span className="pickup-support">{second}</span>
    </span>
  );
}

/** The state as a badge that wraps at its words in a narrow column, instead of making the column as wide as the longest state. */
function State({ state }: { readonly state: PickupState }) {
  return (
    <span className="pickup-state">
      <StatusBadge status={state} map={PICKUP_STATE_MAP} />
    </span>
  );
}

const Needs = ({ text }: { readonly text: string }) =>
  text === '' ? <Dash means={NO_NOTE} /> : <>{text}</>;

/**
 * The nine facts of the queue in six columns, grouped by what they mean: who and which request, where it stands, when, where and for which hub,
 * what is being collected and as what, and what it needs. The code is the row's header and its one link; the row itself is not a link.
 */
export const QUEUE_COLUMNS: readonly TableColumn<QueueFacts>[] = [
  {
    key: 'request',
    header: 'Request / sender',
    rowHeader: true,
    cell: (row) => (
      <span className="pickup-lines">
        <span className="pickup-nowrap">
          <Link to={row.href} data-request-id={row.id}>
            {row.code}
          </Link>
        </span>
        <span className="pickup-support">{row.sender}</span>
      </span>
    ),
  },
  { key: 'state', header: 'State', cell: (row) => <State state={row.state} /> },
  {
    key: 'date',
    header: 'Service date',
    cell: (row) => <span className="pickup-nowrap">{row.date}</span>,
  },
  {
    key: 'where',
    header: 'Pickup address / hub',
    cell: (row) => <Pair first={row.address} second={row.hub} />,
  },
  {
    key: 'packages',
    header: 'Packages / booking type',
    cell: (row) => <Pair first={row.packages} second={row.bookedAs} />,
  },
  { key: 'needs', header: 'Needs', cell: (row) => <Needs text={row.needs} /> },
];

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="pickup-card__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * A request as a card, for a room too narrow for the columns: the code (the one link) with the state, the sender, and then the facts in the
 * order a person reads them, each under the name of its column. The code is a heading, so that a screen reader can move from request to request.
 */
export function QueueCard({ facts }: { readonly facts: QueueFacts }) {
  return (
    <>
      <div className="pickup-card__head">
        <h2 className="pickup-card__title">
          <Link to={facts.href} data-request-id={facts.id}>
            {facts.code}
          </Link>
        </h2>
        <State state={facts.state} />
      </div>
      <p className="pickup-card__sender pickup-support">{facts.sender}</p>
      <dl className="pickup-card__facts">
        <Fact label="Service date">{facts.date}</Fact>
        <Fact label="Pickup address / hub">
          <Pair first={facts.address} second={facts.hub} />
        </Fact>
        <Fact label="Packages / booking type">
          <Pair first={facts.packages} second={facts.bookedAs} />
        </Fact>
        <Fact label="Needs">
          <Needs text={facts.needs} />
        </Fact>
      </dl>
    </>
  );
}
