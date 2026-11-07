import { useMemo, useState, type ReactNode } from 'react';

import { PICKUP_STATE_MAP, serviceDateText } from '../../app/pages/pickup/pickup-presentation';
import { Button } from '../../components/ui/button/Button';
import {
  DataTable,
  RowTitle,
  type DataColumn,
  type DataSort,
  type DataTableProps,
} from '../../components/ui/data-table/DataTable';
import { EmptyState } from '../../components/ui/empty-state/EmptyState';
import { StatusBadge } from '../../components/ui/status-badge/StatusBadge';
import { KitSection, Specimen } from './Section';
import { sampleRequests, type SampleRequest } from './sample-data';

/** The columns of a pickup queue, in the Melarc words: the request over its sender, its state, the service date and the packages. */
export function requestColumns(twoLine: boolean): readonly DataColumn<SampleRequest>[] {
  return [
    {
      id: 'request',
      header: twoLine ? 'Request / sender' : 'Request',
      rowHeader: true,
      cell: (request) =>
        twoLine ? (
          <RowTitle code={request.code} name={request.sender_name ?? 'Not recorded'} />
        ) : (
          <RowTitle code={request.code} />
        ),
    },
    {
      id: 'state',
      header: 'State',
      cell: (request) => <StatusBadge status={request.state} map={PICKUP_STATE_MAP} />,
    },
    {
      id: 'date',
      header: 'Service date',
      sortable: true,
      cell: (request) => serviceDateText(request.scheduled_service_date),
    },
    {
      id: 'packages',
      header: 'Packages',
      align: 'end',
      cell: (request) => String(request.declared_package_count),
    },
  ];
}

const openLabel = (request: SampleRequest): string =>
  `Open ${request.code}${request.sender_name === undefined ? '' : `, ${request.sender_name}`}`;

function useChosen(): {
  readonly ids: readonly string[];
  readonly set: (ids: readonly string[]) => void;
} {
  const [ids, set] = useState<readonly string[]>([]);
  return { ids, set };
}

/** Draws the table a specimen gives, and says which record the last press opened (a table that has no rows to press says nothing). */
function Opened({
  silent = false,
  children,
}: {
  readonly silent?: boolean;
  readonly children: (open: (request: SampleRequest) => void) => ReactNode;
}) {
  const [opened, setOpened] = useState<string | undefined>();
  return (
    <>
      {children((request) => {
        setOpened(request.code);
      })}
      {silent ? null : (
        <p aria-live="polite" className="showcase-kit-opened">
          {opened === undefined
            ? 'No record is open.'
            : `Opened ${opened}. The page decides what that shows.`}
        </p>
      )}
    </>
  );
}

type Overrides = Partial<DataTableProps<SampleRequest>>;

function Plain({
  density = 'single',
  rows = sampleRequests(6),
  label = 'Pickup requests',
  ...rest
}: Overrides) {
  // A table with no rows to press (loading, failed, empty) has nothing to say about a press.
  const silent = rest.status === 'loading' || rest.status === 'error' || rows.length === 0;
  return (
    <Opened silent={silent}>
      {(open) => (
        <DataTable<SampleRequest>
          label={label}
          columns={requestColumns(density === 'two-line')}
          rows={rows}
          rowId={(request) => request.id}
          density={density}
          onOpen={open}
          openLabel={openLabel}
          {...rest}
        />
      )}
    </Opened>
  );
}

function Workspace() {
  const chosen = useChosen();
  const [changed, setChanged] = useState<readonly string[]>([]);
  const [confirmed, setConfirmed] = useState<readonly string[]>([]);
  const rows = useMemo(() => sampleRequests(8), []);
  const shown = rows.map((request) =>
    confirmed.includes(request.id) ? { ...request, state: 'CONFIRMED' as const } : request,
  );
  return (
    <Plain
      label="Pickup requests, two lines"
      density="two-line"
      rows={shown}
      changedIds={changed}
      selection={{
        selectedIds: chosen.ids,
        onChange: chosen.set,
        selectLabel: (request) => `Select ${request.code}`,
        bulkActions: [
          {
            id: 'confirm',
            label: (count) => `Confirm ${String(count)}`,
            primary: true,
            onRun: (ids) => {
              setConfirmed((current) => [...new Set([...current, ...ids])]);
              setChanged(ids);
              chosen.set([]);
            },
          },
        ],
      }}
      rowAction={{
        label: 'Confirm',
        ariaLabel: (request) => `Confirm ${request.code}`,
        isAvailable: (request) => request.state === 'PENDING',
        onRun: (request) => {
          setConfirmed((current) => [...current, request.id]);
          setChanged([request.id]);
        },
      }}
    />
  );
}

function Ordered() {
  const [sort, setSort] = useState<DataSort>({ columnId: 'date', direction: 'ascending' });
  // The table sorts nothing: this stands in for the server, which would be asked for the order and answer with the rows in it.
  const rows = useMemo(() => {
    const ordered = sampleRequests(8).sort((left, right) =>
      left.scheduled_service_date.localeCompare(right.scheduled_service_date),
    );
    return sort.direction === 'ascending' ? ordered : ordered.reverse();
  }, [sort]);
  return (
    <Plain
      label="Pickup requests, ordered"
      rows={rows}
      sort={sort}
      onSortChange={(columnId) => {
        setSort((current) => ({
          columnId,
          direction:
            current.columnId === columnId && current.direction === 'ascending'
              ? 'descending'
              : 'ascending',
        }));
      }}
    />
  );
}

function Failing() {
  const [attempts, setAttempts] = useState(0);
  return (
    <Plain
      label="Pickup requests, failed"
      status="error"
      rows={[]}
      error={{
        message:
          attempts === 0
            ? 'The requests could not be read. Check the connection and try again.'
            : `Still no answer after ${String(attempts)} ${attempts === 1 ? 'try' : 'tries'}. Try again.`,
        onRetry: () => {
          setAttempts((count) => count + 1);
        },
      }}
    />
  );
}

export function DataGroup() {
  return (
    <>
      <KitSection
        title="DataTable"
        note="TanStack Table's model over the table primitive. The whole row opens its record through the real button in the code cell; Space chooses the row, the arrow keys move between rows. Every row below is a sample. The table draws what it is given, in the order it is given, and never a total of its own."
      >
        <Specimen label="Single line, 36px rows (sample data)">
          <Plain label="Pickup requests, single line" />
        </Specimen>
        <Specimen label="Two lines (a code over a name), 52px rows, with selection, the bar of acts, the inline act and a changed row (sample data)">
          <Workspace />
        </Specimen>
        <Specimen label="Touch rows, 56px, for the hub-floor tablet (sample data)">
          <Plain density="touch" label="Pickup requests, touch rows" />
        </Specimen>
        <Specimen label="Ordered by a column: the heading asks, the page orders (sample data)">
          <Ordered />
        </Specimen>
        <Specimen
          label="A box of its own: the header stays while the rows scroll, and it scrolls sideways inside its box (sample data)"
          width="34rem"
        >
          <Plain rows={sampleRequests(20)} maxHeight="16rem" label="Pickup requests, in a box" />
        </Specimen>
        <Specimen label="Loading: rows of its own shape, never a number">
          <Plain
            label="Pickup requests, loading"
            status="loading"
            rows={[]}
            loadingRows={5}
            loadingLabel="Loading pickup requests"
          />
        </Specimen>
        <Specimen label="Nothing there: the queue is empty">
          <Plain
            label="Pickup requests, empty"
            rows={[]}
            emptyState={
              <EmptyState kind="none" heading="Nothing is waiting">
                Every request has been dealt with.
              </EmptyState>
            }
          />
        </Specimen>
        <Specimen label="Nothing fits the filters">
          <Plain
            label="Pickup requests, filtered to nothing"
            rows={[]}
            emptyState={
              <EmptyState
                kind="filtered"
                heading="Nothing fits these filters"
                action={
                  <Button type="button" variant="secondary">
                    Clear the filters
                  </Button>
                }
              >
                No request has the state Cancelled on this service date.
              </EmptyState>
            }
          />
        </Specimen>
        <Specimen label="A failure, with a way to try again">
          <Failing />
        </Specimen>
        <Specimen label="Stale: the last rows that were read, under a line that says so (sample data)">
          <Plain
            label="Pickup requests, stale"
            stale={{
              message:
                'The list may be out of date. The last read was at 09:42, and the next one failed.',
              onRefresh: () => undefined,
            }}
          />
        </Specimen>
      </KitSection>
    </>
  );
}
