import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import { OperationalCode } from '../../../components/ui/code/OperationalCode';
import {
  CellLines,
  NoWrap,
  RowTitle,
  type DataColumn,
} from '../../../components/ui/data-table/DataTable';
import { Link } from '../../../components/ui/link/Link';
import {
  RUN_VIEWS,
  type RunSummaryView,
  type RunView,
} from '../../../platform/hub-receiving/receiving-shape';
import {
  LOOKUP_MAX,
  LOOKUP_MIN,
  useReceivingRuns,
} from '../../../platform/hub-receiving/use-receiving-queries';
import type { WorkListParams } from '../../../platform/pickup-work/use-pickup-work-queries';
import { refusalText } from '../../../platform/problem/capability-words';
import type { Problem } from '../../../platform/problem/problem-copy';
import { formatInstant } from '../../../platform/time/format-time';
import { waitedText } from '../../../platform/time/waited';
import { WorkList, type WorkView } from '../pickup-work/WorkList';
import {
  checkingInText,
  parcelsText,
  runPath,
  toDoText,
  vendorsText,
} from './receiving-presentation';

/** The queue's views are the server's `view` filter, and the page filters nothing itself. */
const VIEWS: readonly [WorkView, ...WorkView[]] = [
  {
    id: 'waiting',
    label: 'Waiting to be checked in',
    open: undefined,
    none: 'No run is waiting to be checked in. A run appears here when a rider hands it over at your hub.',
  },
  {
    id: 'needs_decision',
    label: 'Needs a decision',
    open: undefined,
    none: 'No run has parcels waiting for a senior officer’s decision.',
  },
  {
    id: 'all',
    label: 'All runs',
    open: undefined,
    none: 'A run appears here when a rider hands it over at your hubs.',
  },
];

const refusalWords = (problem: Problem): string =>
  refusalText(problem.forbidden, 'hub.read', { of: 'runs' });

const isRunView = (value: string | undefined): value is RunView =>
  value !== undefined && (RUN_VIEWS as readonly string[]).includes(value);

/** The list the page asks, from the view it is on, the hub the switcher chose and the lookup: all three are the server's filters. */
function useReceivingQueue(params: WorkListParams) {
  return useReceivingRuns({
    ...(isRunView(params.view) ? { view: params.view } : {}),
    ...(params.hubId === undefined ? {} : { hubId: params.hubId }),
    ...(params.q === undefined ? {} : { q: params.q }),
    ...(params.pageToken === undefined ? {} : { pageToken: params.pageToken }),
    ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
  });
}

/** How long the run has waited since the rider handed it over, with the moment under it. */
function WaitedCell({ run }: { readonly run: RunSummaryView }) {
  const waited = waitedText(run.handed_over_at);
  return (
    <CellLines
      first={<NoWrap>{waited ?? ''}</NoWrap>}
      second={<NoWrap>{formatInstant(run.handed_over_at) ?? ''}</NoWrap>}
    />
  );
}

function RunCard({ run }: { readonly run: RunSummaryView }) {
  return (
    <CardFacts
      facts={[
        { label: 'Rider', value: run.rider_name },
        { label: 'Vendors', value: vendorsText(run.vendor_names) },
        {
          label: 'Parcels',
          value:
            run.parcels_expected > 0 ? parcelsText(run.parcels_expected) : 'Counted without photos',
        },
        { label: 'To do', value: toDoText(run).join('. ') },
        { label: 'Waiting', value: waitedText(run.handed_over_at) ?? '' },
        { label: 'Checking in now', value: checkingInText(run.checking_in) },
        { label: 'Hub', value: run.hub_name },
      ]}
    />
  );
}

/**
 * The receiving queue, by run (surfaces/ops-portal.md section 7, `/receiving`; S1.35c; D-D2): one row for each run that has parcels to check in, from `listReceivingRuns`, **oldest handover first**, in three
 * views that are the server's `view` filter (*Waiting to be checked in*, *Needs a decision*, *All runs*). A row names **the run by its code, the rider and the vendors by name** (never a phone number), says how many
 * parcels the door photos expect, what is left to do and how long the run has waited, and who is checking it in. **The hub the switcher chose narrows it** (OB-S1-104: the server's `hub_id`), and a lookup in the bar
 * finds a run by its code and a run by its vendor's name (the server finds; the page filters nothing). **No declared count is on a row, not even a blind-count vendor's**: the row says only that such a vendor is
 * counted. A row opens the run's page, where the parcels are checked in.
 */
export function ReceivingQueuePage() {
  const columns: readonly DataColumn<RunSummaryView>[] = [
    {
      id: 'run',
      header: 'Run',
      rowHeader: true,
      cell: (run) => <RowTitle code={run.run_code} to={runPath(run.run_id)} />,
    },
    {
      id: 'rider',
      header: 'Rider',
      priority: 2,
      cell: (run) => run.rider_name,
    },
    {
      id: 'vendors',
      header: 'Vendors',
      kind: 'prose',
      cell: (run) => vendorsText(run.vendor_names),
    },
    {
      id: 'parcels',
      header: 'Parcels',
      kind: 'count',
      priority: 2,
      cell: (run) =>
        run.parcels_expected > 0 ? parcelsText(run.parcels_expected) : 'Counted without photos',
    },
    {
      id: 'todo',
      header: 'To do',
      kind: 'prose',
      cell: (run) => (
        <>
          {toDoText(run).map((line) => (
            <span key={line} className="receiving-line">
              {line}
            </span>
          ))}
        </>
      ),
    },
    {
      id: 'waited',
      header: 'Waiting',
      kind: 'date',
      cell: (run) => <WaitedCell run={run} />,
    },
    {
      id: 'checking',
      header: 'Checking in now',
      priority: 2,
      cell: (run) => checkingInText(run.checking_in),
    },
    {
      id: 'hub',
      header: 'Hub',
      priority: 3,
      cell: (run) => run.hub_name,
    },
  ];

  return (
    <WorkList<RunSummaryView>
      name="receiving-runs"
      operation="listReceivingRuns"
      title="Receiving"
      description="The runs handed over at your hubs, oldest first. Open a run to check its parcels in."
      viewsLabel="Views of the runs"
      views={VIEWS}
      noun={{ plural: 'runs', one: 'run', other: 'runs' }}
      tableLabel="Runs"
      refusal={refusalWords}
      lookup={{
        label: 'Search by run code or vendor name',
        minLength: LOOKUP_MIN,
        maxLength: LOOKUP_MAX,
      }}
      useList={useReceivingQueue}
      rowId={(run) => run.run_id}
      table={{
        columns,
        density: 'two-line',
        opens: 'record',
        card: (run) => <RunCard run={run} />,
        cardTitle: (run) => (
          <Link to={runPath(run.run_id)}>
            <OperationalCode>{run.run_code}</OperationalCode>
          </Link>
        ),
      }}
    />
  );
}
