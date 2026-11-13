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
import type { ShortfallView } from '../../../platform/pickup-work/pickup-work-shape';
import { useCollectionShortfalls } from '../../../platform/pickup-work/use-pickup-work-queries';
import { refusalText } from '../../../platform/problem/capability-words';
import type { Problem } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { MANIFEST_STATE_MAP } from '../manifests/manifest-presentation';
import { hubNameOf } from '../staff/staff-presentation';
import { shortCountText, stopPathOf } from './pickup-work-presentation';
import { WorkList, type WorkView } from './WorkList';

const VIEWS: readonly [WorkView, ...WorkView[]] = [
  {
    id: 'in-progress',
    label: 'In progress',
    open: true,
    none: 'No rider is out with parcels the office was told are missing. A short count appears here when a rider counts fewer parcels than were declared.',
  },
  {
    id: 'ended',
    label: 'Ended runs',
    open: false,
    none: 'A short count whose run has ended appears here.',
  },
  {
    id: 'all',
    label: 'All',
    open: undefined,
    none: 'A short count appears here when a rider counts fewer parcels than were declared at your hubs.',
  },
];

const refusalWords = (problem: Problem): string =>
  refusalText(problem.forbidden, 'pickup.handshake.override', { of: 'short counts' });

type Hubs = readonly { readonly id: string; readonly display_name: string }[];

const stopOf = (item: ShortfallView): string =>
  stopPathOf(item.pickup_manifest_id, item.pickup_stop_id);

function ShortfallCard({ item, hubs }: { readonly item: ShortfallView; readonly hubs: Hubs }) {
  return (
    <CardFacts
      head={<StatusBadge status={item.run_state} map={MANIFEST_STATE_MAP} />}
      lead={item.sender_name}
      facts={[
        { label: 'Counted', value: shortCountText(item.declared_count, item.collected_count) },
        { label: 'Short by', value: String(item.shortfall_count) },
        { label: 'Reason', value: item.reason.label },
        ...(item.note === null ? [] : [{ label: 'Rider’s note', value: item.note }]),
        { label: 'Office told', value: formatInstant(item.office_notified_at) ?? '' },
        { label: 'Hub', value: hubNameOf(item.responsible_hub_id, hubs) },
      ]}
    />
  );
}

/**
 * Short counts (surfaces/ops-portal.md section 7, `/collection-shortfalls`; S1.30): the counts the office was flagged on, from `listCollectionShortfalls`, **oldest first**: what was declared and
 * counted, the reason the rider gave and its note (staff's own), when the flag was raised and the pickup. Views: *In progress* (the rider is still out with the parcels the office was told are
 * missing), *Ended runs* and *All*. A row opens the stop. It supplements the rider's phone call and replaces nothing; **nothing marks a shortfall as read or worked yet, so the page offers no such
 * act and says so.** No price, total or fee is drawn.
 */
export function ShortfallsPage() {
  const me = useSignedInSession();
  if (me === undefined) return null;
  const hubs = me.session.authorized_hubs;

  const columns: readonly DataColumn<ShortfallView>[] = [
    {
      id: 'pickup',
      header: 'Pickup / sender',
      rowHeader: true,
      cell: (item) => (
        <RowTitle code={item.request_code} name={item.sender_name} to={stopOf(item)} />
      ),
    },
    {
      id: 'counts',
      header: 'Counted',
      kind: 'prose',
      cell: (item) => (
        <CellLines
          first={shortCountText(item.declared_count, item.collected_count)}
          second={`Short by ${String(item.shortfall_count)}`}
        />
      ),
    },
    {
      id: 'reason',
      header: 'Reason',
      kind: 'prose',
      priority: 2,
      cell: (item) => (
        <CellLines first={item.reason.label} second={item.note ?? 'The rider left no note.'} />
      ),
    },
    {
      id: 'told',
      header: 'Office told',
      kind: 'date',
      priority: 2,
      cell: (item) => <NoWrap>{formatInstant(item.office_notified_at) ?? ''}</NoWrap>,
    },
    {
      id: 'run',
      header: 'Run',
      kind: 'badge',
      priority: 3,
      cell: (item) => <StatusBadge status={item.run_state} map={MANIFEST_STATE_MAP} />,
    },
    {
      id: 'hub',
      header: 'Hub',
      priority: 3,
      cell: (item) => hubNameOf(item.responsible_hub_id, hubs),
    },
  ];

  return (
    <WorkList<ShortfallView>
      name="shortfalls"
      operation="listCollectionShortfalls"
      title="Short counts"
      description="Counts where a rider collected fewer parcels than were declared at your hubs, oldest first."
      viewsLabel="Views of the short counts"
      views={VIEWS}
      noun={{ plural: 'short counts', one: 'short count', other: 'short counts' }}
      tableLabel="Short counts"
      refusal={refusalWords}
      useList={useCollectionShortfalls}
      rowId={(item) => item.id}
      note="This list supplements the rider’s phone call and replaces nothing. Nothing marks a short count as read or worked yet, so there is no act here."
      table={{
        columns,
        density: 'two-line',
        opens: 'record',
        card: (item) => <ShortfallCard item={item} hubs={hubs} />,
        cardTitle: (item) => (
          <Link to={stopOf(item)}>
            <OperationalCode>{item.request_code}</OperationalCode>
          </Link>
        ),
      }}
    />
  );
}
