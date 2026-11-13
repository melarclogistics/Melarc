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
import type { DisputeView } from '../../../platform/pickup-work/pickup-work-shape';
import { useCollectionDisputes } from '../../../platform/pickup-work/use-pickup-work-queries';
import { refusalText } from '../../../platform/problem/capability-words';
import type { Problem } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { hubNameOf } from '../staff/staff-presentation';
import {
  DISPUTE_STATE_MAP,
  VARIANCE_WORDS,
  shortCountText,
  stopPathOf,
} from './pickup-work-presentation';
import { WorkList, type WorkView } from './WorkList';

const VIEWS: readonly [WorkView, ...WorkView[]] = [
  {
    id: 'open',
    label: 'Open',
    open: true,
    none: 'No collection is disputed. A dispute appears here when a vendor disputes what a rider collected.',
  },
  {
    id: 'resolved',
    label: 'Resolved',
    open: false,
    none: 'No dispute has been resolved. No operation resolves one yet.',
  },
  {
    id: 'all',
    label: 'All',
    open: undefined,
    none: 'A dispute appears here when a vendor disputes what a rider collected at your hubs.',
  },
];

const refusalWords = (problem: Problem): string =>
  refusalText(problem.forbidden, 'pickup.read', {
    doing: 'see collection disputes',
    of: 'collection disputes',
  });

type Hubs = readonly { readonly id: string; readonly display_name: string }[];

const stopOf = (item: DisputeView): string =>
  stopPathOf(item.pickup_manifest_id, item.pickup_stop_id);

function DisputeCard({ item, hubs }: { readonly item: DisputeView; readonly hubs: Hubs }) {
  return (
    <CardFacts
      head={<StatusBadge status={item.state} map={DISPUTE_STATE_MAP} />}
      lead={item.sender_name}
      facts={[
        { label: 'The vendor says', value: item.note },
        { label: 'Counted', value: shortCountText(item.declared_count, item.collected_count) },
        { label: 'Raised', value: formatInstant(item.created_at) ?? '' },
        { label: 'Hub', value: hubNameOf(item.responsible_hub_id, hubs) },
      ]}
    />
  );
}

/**
 * Collection disputes (surfaces/ops-portal.md section 7, `/collection-disputes`; S1.30): the Ops side of a dispute a vendor raised with `disputeCollection`, from `listCollectionDisputes`, **oldest
 * first**, each beside what was counted at the door. Views: *Open*, *Resolved*, *All*. **A dispute never reverses physical completion, and no operation resolves one in this slice**, so every item is open
 * and the page offers no resolution: it says what it is, the reconciliation workflow's, and does not draw it as an act it lacks. The vendor's words are drawn as text and never as markup (React
 * draws a string as text, and no row is given to anything that renders HTML).
 */
export function DisputesPage() {
  const me = useSignedInSession();
  if (me === undefined) return null;
  const hubs = me.session.authorized_hubs;

  const columns: readonly DataColumn<DisputeView>[] = [
    {
      id: 'pickup',
      header: 'Pickup / sender',
      rowHeader: true,
      cell: (item) => (
        <RowTitle code={item.request_code} name={item.sender_name} to={stopOf(item)} />
      ),
    },
    {
      id: 'says',
      header: 'The vendor says',
      kind: 'prose',
      cell: (item) => item.note,
    },
    {
      id: 'counted',
      header: 'Counted at the door',
      kind: 'prose',
      priority: 2,
      cell: (item) => (
        <CellLines
          first={shortCountText(item.declared_count, item.collected_count)}
          second={VARIANCE_WORDS[item.variance]}
        />
      ),
    },
    {
      id: 'raised',
      header: 'Raised',
      kind: 'date',
      priority: 2,
      cell: (item) => <NoWrap>{formatInstant(item.created_at) ?? ''}</NoWrap>,
    },
    {
      id: 'state',
      header: 'State',
      kind: 'badge',
      cell: (item) => <StatusBadge status={item.state} map={DISPUTE_STATE_MAP} />,
    },
    {
      id: 'hub',
      header: 'Hub',
      priority: 3,
      cell: (item) => hubNameOf(item.responsible_hub_id, hubs),
    },
  ];

  return (
    <WorkList<DisputeView>
      name="disputes"
      operation="listCollectionDisputes"
      title="Collection disputes"
      description="Collections a vendor disputes at your hubs, oldest first, beside what the rider counted at the door."
      viewsLabel="Views of the collection disputes"
      views={VIEWS}
      noun={{
        plural: 'collection disputes',
        one: 'collection dispute',
        other: 'collection disputes',
      }}
      tableLabel="Collection disputes"
      refusal={refusalWords}
      useList={useCollectionDisputes}
      rowId={(item) => item.id}
      note="A dispute never changes that the parcels were collected, and no operation resolves one yet: that is the reconciliation workflow’s. This list shows each dispute beside what was counted, and offers no resolution."
      table={{
        columns,
        density: 'two-line',
        opens: 'record',
        card: (item) => <DisputeCard item={item} hubs={hubs} />,
        cardTitle: (item) => (
          <Link to={stopOf(item)}>
            <OperationalCode>{item.request_code}</OperationalCode>
          </Link>
        ),
      }}
    />
  );
}
