import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import { OperationalCode } from '../../../components/ui/code/OperationalCode';
import {
  CellLines,
  NoWrap,
  RowTitle,
  type DataColumn,
} from '../../../components/ui/data-table/DataTable';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import type { PickupFailureView } from '../../../platform/pickup-work/pickup-work-shape';
import { usePickupFailures } from '../../../platform/pickup-work/use-pickup-work-queries';
import { refusalText } from '../../../platform/problem/capability-words';
import type { Problem } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { FAILURE_LABELS } from '../manifests/manifest-presentation';
import { hubNameOf } from '../staff/staff-presentation';
import { FailurePanel } from './FailurePanel';
import {
  DECISION_MAP,
  countText,
  escalationText,
  waitText,
  isWaiting,
} from './pickup-work-presentation';
import { WorkList, type WorkView } from './WorkList';

const VIEWS: readonly [WorkView, ...WorkView[]] = [
  {
    id: 'waiting',
    label: 'Waiting',
    open: true,
    none: 'A failed pickup appears here when a rider reports one at your hubs, and stays until the office reschedules or cancels it.',
  },
  {
    id: 'decided',
    label: 'Decided',
    open: false,
    none: 'A failed pickup that the office has rescheduled or cancelled appears here.',
  },
  {
    id: 'all',
    label: 'All',
    open: undefined,
    none: 'A failed pickup appears here when a rider reports one at your hubs.',
  },
];

/** The words of a refusal of the queue: what the account cannot do, or the hub it does not work in. */
const refusalWords = (problem: Problem): string =>
  refusalText(problem.forbidden, 'pickup.failure.resolve', { of: 'failed pickups' });

type Hubs = readonly { readonly id: string; readonly display_name: string }[];

/** What the row says under the decision: who escalated it, in words, when it was. */
const escalationLine = (failure: PickupFailureView): string | undefined =>
  escalationText(failure.escalation);

function Decision({ failure }: { readonly failure: PickupFailureView }) {
  const line = isWaiting(failure.decision) ? escalationLine(failure) : undefined;
  const badge = <StatusBadge status={failure.decision} map={DECISION_MAP} />;
  return line === undefined ? badge : <CellLines first={badge} second={line} />;
}

function FailureCard({
  failure,
  hubs,
}: {
  readonly failure: PickupFailureView;
  readonly hubs: Hubs;
}) {
  const escalated = escalationLine(failure);
  return (
    <CardFacts
      head={<StatusBadge status={failure.decision} map={DECISION_MAP} />}
      lead={failure.sender_name}
      facts={[
        {
          label: 'Why',
          value: (
            <CellLines first={FAILURE_LABELS[failure.category]} second={failure.reason.label} />
          ),
        },
        {
          label: isWaiting(failure.decision) ? 'Waiting' : 'Waited',
          value: waitText(failure.waiting_seconds),
        },
        {
          label: 'Attempt',
          value: `Attempt ${String(failure.attempt_number)}${failure.attempt_extended ? ', extended' : ''}`,
        },
        { label: 'Photos', value: countText(failure.photo_count, 'photo', 'photos') },
        ...(escalated === undefined ? [] : [{ label: 'Escalation', value: escalated }]),
        { label: 'Hub', value: hubNameOf(failure.responsible_hub_id, hubs) },
      ]}
    />
  );
}

/**
 * Failed pickups (surfaces/ops-portal.md section 7, `/pickup-failures`; S1.30): the failure decision queue of the hubs of the grant, from `listPickupFailures`, **oldest failure first**, in the three
 * views the server's `open` filter makes (*Waiting*: the request is still confirmed, escalated or not; *Decided*; *All*). Every fact section 17.3 makes mandatory is on the row or in the panel as
 * the server gave it: the category and the reason in the catalogue's words, the rider's note, the contact attempts, the attempt and whether Senior Ops extended it, how many photos the rider attached,
 * **how long it has waited** (the database's figure: the page works out no time) and **whether it was escalated and by whom**, a person or the backstop, with the threshold the backstop had passed and the
 * wait it had reached. Opening a row shows it beside the list with the four acts of the office (Reschedule, Cancel, Escalate and Extend, each under its own key and only while the request waits),
 * which are the acts of the pickup request and are sent on the version of the request as it is read. **A decided failure says what was decided** and links the replacement. A vendor's dispute of a
 * failure is not offered; the retryability and the cap's state are not drawn (the read has no field for them).
 */
export function FailedPickupsPage() {
  const me = useSignedInSession();
  if (me === undefined) return null;
  const hubs = me.session.authorized_hubs;

  const columns: readonly DataColumn<PickupFailureView>[] = [
    {
      id: 'request',
      header: 'Request / sender',
      rowHeader: true,
      cell: (failure) => <RowTitle code={failure.request_code} name={failure.sender_name} />,
    },
    {
      id: 'why',
      header: 'Why it failed',
      kind: 'prose',
      cell: (failure) => (
        <CellLines first={FAILURE_LABELS[failure.category]} second={failure.reason.label} />
      ),
    },
    {
      id: 'waiting',
      header: 'Waiting',
      kind: 'count',
      priority: 2,
      cell: (failure) => <NoWrap>{waitText(failure.waiting_seconds)}</NoWrap>,
    },
    {
      id: 'decision',
      header: 'Decision',
      kind: 'prose',
      cell: (failure) => <Decision failure={failure} />,
    },
    {
      id: 'attempt',
      header: 'Attempt',
      kind: 'count',
      priority: 3,
      cell: (failure) => (
        <CellLines
          first={`Attempt ${String(failure.attempt_number)}`}
          second={failure.attempt_extended ? 'Extended by Senior Ops' : 'Not extended'}
        />
      ),
    },
    {
      id: 'hub',
      header: 'Hub',
      priority: 3,
      cell: (failure) => hubNameOf(failure.responsible_hub_id, hubs),
    },
  ];

  return (
    <WorkList<PickupFailureView>
      name="failures"
      operation="listPickupFailures"
      title="Failed pickups"
      description="Pickups a rider could not collect at your hubs, oldest first, for the office to reschedule, cancel or escalate."
      viewsLabel="Views of the failed pickups"
      views={VIEWS}
      noun={{ plural: 'failed pickups', one: 'failed pickup', other: 'failed pickups' }}
      tableLabel="Failed pickups"
      refusal={refusalWords}
      useList={usePickupFailures}
      rowId={(failure) => failure.pickup_stop_id}
      table={{
        columns,
        density: 'two-line',
        openLabel: (failure) => `Open ${failure.request_code}, ${failure.sender_name}`,
        card: (failure) => <FailureCard failure={failure} hubs={hubs} />,
        cardTitle: (failure) => <OperationalCode>{failure.request_code}</OperationalCode>,
      }}
      panel={(failure, tools) => ({
        code: failure.request_code,
        status: <StatusBadge status={failure.decision} map={DECISION_MAP} />,
        fullPage: { to: `/pickup-requests/${failure.pickup_request_id}` },
        body: <FailurePanel key={failure.pickup_stop_id} failure={failure} tools={tools} />,
      })}
    />
  );
}
