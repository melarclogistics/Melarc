import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import { OperationalCode } from '../../../components/ui/code/OperationalCode';
import {
  CellLines,
  NoWrap,
  RowTitle,
  type DataColumn,
} from '../../../components/ui/data-table/DataTable';
import { Link } from '../../../components/ui/link/Link';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import type { IntakeState, IntakeSummaryView } from '../../../platform/hub-intake/hub-intake-shape';
import { useHubIntakes } from '../../../platform/hub-intake/use-hub-intake-queries';
import { refusalText } from '../../../platform/problem/capability-words';
import type { Problem } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { hubNameOf } from '../staff/staff-presentation';
import { WorkList, type WorkView } from '../pickup-work/WorkList';
import { INTAKE_STATE_MAP, intakePath, receivingNowText } from './intake-presentation';
import type { WorkListParams } from '../../../platform/pickup-work/use-pickup-work-queries';

/** What each view of the queue asks the server for: its `state` filter. The page filters nothing itself. */
const STATE_OF_VIEW: Readonly<Record<string, IntakeState | undefined>> = {
  awaiting: 'AWAITING_COUNT',
  decision: 'RECONCILIATION_REQUIRED',
  all: undefined,
};

const VIEWS: readonly [WorkView, ...WorkView[]] = [
  {
    id: 'awaiting',
    label: 'Awaiting count',
    open: undefined,
    none: 'Nothing is waiting to be counted. An intake appears here when a rider hands a run over at your hub.',
  },
  {
    id: 'decision',
    label: 'Needs a decision',
    open: undefined,
    none: 'No intake is waiting for a senior officer’s decision.',
  },
  {
    id: 'all',
    label: 'All',
    open: undefined,
    none: 'An intake appears here when a rider hands a run over at your hubs.',
  },
];

const refusalWords = (problem: Problem): string =>
  refusalText(problem.forbidden, 'hub.read', { of: 'intakes' });

/** The list the page asks, from the view it is on: the view is the server's `state` filter. */
function useIntakeQueue(params: WorkListParams) {
  const state = params.view === undefined ? undefined : STATE_OF_VIEW[params.view];
  return useHubIntakes({
    ...(state === undefined ? {} : { state }),
    ...(params.pageToken === undefined ? {} : { pageToken: params.pageToken }),
    ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
  });
}

type Hubs = readonly { readonly id: string; readonly display_name: string }[];

function IntakeCard({
  item,
  hubs,
  me,
}: {
  readonly item: IntakeSummaryView;
  readonly hubs: Hubs;
  readonly me: string | undefined;
}) {
  return (
    <CardFacts
      head={<StatusBadge status={item.state} map={INTAKE_STATE_MAP} />}
      facts={[
        { label: 'Handed over', value: formatInstant(item.handed_over_at) ?? '' },
        { label: 'Receiving now', value: receivingNowText(item, me) },
        {
          label: 'Pickup run',
          value: <Link to={`/manifests/${item.pickup_manifest_id}`}>Open the run</Link>,
        },
        { label: 'Hub', value: hubNameOf(item.hub_id, hubs) },
      ]}
    />
  );
}

/**
 * The receiving queue (surfaces/ops-portal.md section 7, `/intakes`; S1.35): the intakes at the hubs of the grant, from `listHubIntakes`, **oldest handover first**, in three views that are the server's
 * `state` filter (*Awaiting count*, *Needs a decision*, *All*). A row says what the contract states of an intake that has not been counted: its code, the run it came from, when the rider handed
 * over, who is receiving now and its state. **No declared count is on it, not even a zero one, and none can be:** the list's guard gives a page the base of an intake and nothing of a count, counted or
 * not. A rider is not named (the answer carries an identifier and the portal has no read of a rider's name under this key). **The hub the switcher chose does not narrow it**: the operation has no hub filter,
 * so it lists the hubs of the grant and each row names its hub; the page says so.
 */
export function IntakeQueuePage() {
  const me = useSignedInSession();
  if (me === undefined) return null;
  const hubs = me.session.authorized_hubs;
  const principal = me.session.principal_id;

  const columns: readonly DataColumn<IntakeSummaryView>[] = [
    {
      id: 'intake',
      header: 'Intake',
      rowHeader: true,
      cell: (item) => <RowTitle code={item.code} to={intakePath(item.id)} />,
    },
    {
      id: 'run',
      header: 'Pickup run',
      priority: 2,
      cell: (item) => <Link to={`/manifests/${item.pickup_manifest_id}`}>Open the run</Link>,
    },
    {
      id: 'handed',
      header: 'Handed over',
      kind: 'date',
      cell: (item) => (
        <CellLines
          first={<NoWrap>{formatInstant(item.handed_over_at) ?? ''}</NoWrap>}
          second="By a rider"
        />
      ),
    },
    {
      id: 'receiving',
      header: 'Receiving now',
      priority: 2,
      cell: (item) => receivingNowText(item, principal),
    },
    {
      id: 'state',
      header: 'State',
      kind: 'badge',
      cell: (item) => <StatusBadge status={item.state} map={INTAKE_STATE_MAP} />,
    },
    {
      id: 'hub',
      header: 'Hub',
      priority: 3,
      cell: (item) => hubNameOf(item.hub_id, hubs),
    },
  ];

  return (
    <WorkList<IntakeSummaryView>
      name="intakes"
      operation="listHubIntakes"
      title="Receiving"
      description="The parcels handed over at your hubs, oldest handover first. Open one to count it."
      viewsLabel="Views of the intakes"
      views={VIEWS}
      noun={{ plural: 'intakes', one: 'intake', other: 'intakes' }}
      tableLabel="Intakes"
      refusal={refusalWords}
      hubFilter={false}
      useList={useIntakeQueue}
      rowId={(item) => item.id}
      note="This list shows every hub you work in, whichever hub is chosen at the top; each row names its hub. It never shows the number a rider declared: that appears on an intake once it has been counted."
      table={{
        columns,
        density: 'two-line',
        opens: 'record',
        card: (item) => <IntakeCard item={item} hubs={hubs} me={principal} />,
        cardTitle: (item) => (
          <Link to={intakePath(item.id)}>
            <OperationalCode>{item.code}</OperationalCode>
          </Link>
        ),
      }}
    />
  );
}
