import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { PICKUP_STATE_MAP, serviceDateText } from '../../app/pages/pickup/pickup-presentation';
import { Button } from '../../components/ui/button/Button';
import {
  DataTable,
  NoWrap,
  RowTitle,
  type DataColumn,
  type DataSort,
  type DataTableProps,
} from '../../components/ui/data-table/DataTable';
import { CardFacts } from '../../components/ui/card-facts/CardFacts';
import { OperationalCode } from '../../components/ui/code/OperationalCode';
import { EmptyState } from '../../components/ui/empty-state/EmptyState';
import { Input } from '../../components/ui/input/Input';
import { Select } from '../../components/ui/select/Select';
import { StatusBadge } from '../../components/ui/status-badge/StatusBadge';
import { KitSection, Specimen } from './Section';
import { sampleRequests, type SampleRequest } from './sample-data';

/** The same columns with none marked lesser, for a table whose rows open nothing (it never takes a column away: `DataTable`, *Lists that open nothing*). */
export function alwaysDrawn<Item>(
  columns: readonly DataColumn<Item>[],
): readonly DataColumn<Item>[] {
  return columns.map((column) => ({ ...column, priority: 1 }));
}

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
      kind: 'badge',
      cell: (request) => <StatusBadge status={request.state} map={PICKUP_STATE_MAP} />,
    },
    {
      id: 'date',
      header: 'Service date',
      kind: 'date',
      sortable: true,
      cell: (request) => <NoWrap>{serviceDateText(request.scheduled_service_date)}</NoWrap>,
    },
    {
      id: 'packages',
      header: 'Packages',
      align: 'end',
      // The column that goes first when the table's own box is narrow: the date and the state are what a queue is read by.
      priority: 3,
      cell: (request) => <NoWrap>{String(request.declared_package_count)}</NoWrap>,
    },
  ];
}

/**
 * A sample request as a card, for a table that is narrow: the state, the sender, and the facts, each a label and its value (`CardFacts`: side by side where the card has the room), with no control in it
 * (the table draws the card's title, the code, which is its one button, and its box and its act: `requestCardTitle`).
 */
export function requestCard(request: SampleRequest): ReactNode {
  return (
    <CardFacts
      head={<StatusBadge status={request.state} map={PICKUP_STATE_MAP} />}
      lead={request.sender_name ?? 'Not recorded'}
      facts={[
        { label: 'Service date', value: serviceDateText(request.scheduled_service_date) },
        { label: 'Packages', value: String(request.declared_package_count) },
      ]}
    />
  );
}

/** The title of a sample request's card: its code, which is the card's one button where the cards open the record. */
export const requestCardTitle = (request: SampleRequest): ReactNode => (
  <OperationalCode>{request.code}</OperationalCode>
);

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
            // Only a request that is waiting can be confirmed: the rest of the chosen rows are left out, and the bar says so.
            eligible: (chosenIds) =>
              chosenIds.filter(
                (id) => shown.find((request) => request.id === id)?.state === 'PENDING',
              ),
            note: (left) =>
              `${String(left)} ${left === 1 ? 'is' : 'are'} already confirmed or cancelled`,
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

/** A field in a cell, beside the button that opens the row: a press on the field is the field's, and never opens the record. */
function FieldsInCells() {
  return (
    <Plain
      label="Pickup requests, with fields"
      rows={sampleRequests(4)}
      columns={[
        ...requestColumns(false).slice(0, 2),
        {
          id: 'hub',
          header: 'Hub',
          cell: (request) => (
            <Select aria-label={`Hub for ${request.code}`} defaultValue="accra">
              <option value="accra">Accra Central</option>
              <option value="tema">Tema</option>
            </Select>
          ),
        },
        {
          id: 'note',
          header: 'Note',
          cell: (request) => <Input aria-label={`Note for ${request.code}`} defaultValue="" />,
        },
      ]}
    />
  );
}

/** The rows arrive after the box was first drawn: the place the person left is put back when they are there, once, and not while the table is still loading rows. */
function LoadingThenReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setReady(true);
    }, 400);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return (
    <Plain
      label="Pickup requests, returning to a place"
      rows={ready ? sampleRequests(20) : []}
      status={ready ? 'ready' : 'loading'}
      loadingLabel="Loading pickup requests"
      maxHeight="16rem"
      initialScroll={{ left: 0, top: 200 }}
    />
  );
}

/**
 * The lesser columns go as far as it takes for the table's box not to scroll sideways (`priority`: the most lesser first), the request and its state staying. Four of the six are wide on purpose
 * (a line of text that does not wrap), so that a box of 41rem cannot hold them and a box of 70rem can.
 */
function Prioritised({ label }: { readonly label: string }) {
  return (
    <Plain
      label={label}
      rows={sampleRequests(4)}
      columns={[
        ...requestColumns(false).slice(0, 2),
        {
          id: 'date',
          header: 'Service date',
          priority: 2,
          cell: (request) => <NoWrap>{serviceDateText(request.scheduled_service_date)}</NoWrap>,
        },
        {
          id: 'booked',
          header: 'Booked as',
          priority: 2,
          cell: () => <NoWrap>Booked by a vendor from the shop</NoWrap>,
        },
        {
          id: 'packages',
          header: 'Packages',
          priority: 3,
          cell: (request) => (
            <NoWrap>{`${String(request.declared_package_count)} packages`}</NoWrap>
          ),
        },
        {
          id: 'hub',
          header: 'Hub',
          priority: 3,
          cell: () => <NoWrap>Accra Central depot</NoWrap>,
        },
      ]}
    />
  );
}

const SAMPLE_ADDRESS = 'Plot 14, Independence Avenue, near the old Ridge roundabout, Accra';
const SAMPLE_NEEDS = 'One-package exception approval';

/**
 * Prose columns (an address, what a request needs) in a box that cannot hold them all: they keep `PROSE_MIN_WIDTH` of their own, so no word falls to a letter a line, and the lesser columns go to make
 * the room (run 7, Stage 1). The rows open a panel, so a column may go.
 */
function ProseColumns({ label }: { readonly label: string }) {
  return (
    <Plain
      label={label}
      rows={sampleRequests(3)}
      density="two-line"
      columns={[
        ...requestColumns(true).slice(0, 2),
        {
          id: 'where',
          header: 'Pickup address',
          kind: 'prose',
          priority: 2,
          cell: () => SAMPLE_ADDRESS,
        },
        { id: 'needs', header: 'Needs', kind: 'prose', cell: () => SAMPLE_NEEDS },
        {
          id: 'packages',
          header: 'Packages',
          kind: 'count',
          priority: 3,
          cell: (request) => (
            <NoWrap>{`${String(request.declared_package_count)} packages`}</NoWrap>
          ),
        },
      ]}
    />
  );
}

const SAMPLE_SENDER = 'Internationalrepresentativeoffice Ltd';

/**
 * A column of plain text with long words and no kind (run 7, Stage 1.1): its longest word holds its column, so a box that cannot hold the word and the other columns takes the lesser column away
 * and does not squeeze the words to a letter a line.
 */
function PlainWords({ label }: { readonly label: string }) {
  return (
    <Plain
      label={label}
      rows={sampleRequests(3)}
      columns={[
        ...requestColumns(false).slice(0, 1),
        { id: 'sender', header: 'Sender', cell: () => SAMPLE_SENDER },
        {
          id: 'packages',
          header: 'Packages',
          kind: 'count',
          priority: 3,
          cell: (request) => (
            <NoWrap>{`${String(request.declared_package_count)} packages`}</NoWrap>
          ),
        },
      ]}
    />
  );
}

/**
 * A list whose rows open nothing (a message log, a list of sessions): it never takes a column away, for the fact would be on no screen. Where its columns cannot fit it is cards, with every fact.
 */
function OpensNothing({ label }: { readonly label: string }) {
  return (
    <DataTable<SampleRequest>
      label={label}
      columns={[
        {
          id: 'when',
          header: 'When',
          rowHeader: true,
          cell: (request) => <NoWrap>{serviceDateText(request.scheduled_service_date)}</NoWrap>,
        },
        {
          id: 'state',
          header: 'State',
          kind: 'badge',
          cell: (request) => <StatusBadge status={request.state} map={PICKUP_STATE_MAP} />,
        },
        {
          id: 'sender',
          header: 'Sender',
          cell: (request) => <NoWrap>{request.sender_name ?? 'Not recorded'}</NoWrap>,
        },
        { id: 'to', header: 'To', cell: () => <NoWrap>Booked by a vendor from the shop</NoWrap> },
        { id: 'number', header: 'Number', cell: () => <NoWrap>+233 ** *** 1234, masked</NoWrap> },
      ]}
      rows={sampleRequests(3)}
      rowId={(request) => request.id}
      card={(request) => (
        <CardFacts
          head={<StatusBadge status={request.state} map={PICKUP_STATE_MAP} />}
          facts={[
            { label: 'When', value: serviceDateText(request.scheduled_service_date) },
            { label: 'Sender', value: request.sender_name ?? 'Not recorded' },
            { label: 'To', value: 'Booked by a vendor from the shop' },
            { label: 'Number', value: '+233 ** *** 1234, masked' },
          ]}
        />
      )}
      cardTitle={(request) => request.sender_name ?? 'Not recorded'}
    />
  );
}

const SAMPLE_NOTE =
  'Ring the bell twice at the side gate, ask for the night porter, and have the packages weighed on the scale by the door before they are handed over to the rider, who will sign for them.';

/**
 * A list whose rows are tall because of a lesser column, in a box as wide as the page (run 7, Stage 1.4): the page grows past the window with the column and not without it, so the page's
 * scrollbar comes and goes as the fit drops and restores the column. `?ballast=N` gives the column's cells N pixels of least width, so that a test can make the box hold the table with the
 * scrollbar away and not with it.
 */
function NearTheWindow({ label }: { readonly label: string }) {
  const ballast = Number(new URLSearchParams(window.location.search).get('ballast') ?? '0');
  return (
    <Plain
      label={label}
      rows={sampleRequests(6)}
      density="two-line"
      columns={[
        ...requestColumns(true).slice(0, 2),
        {
          id: 'notes',
          header: 'Notes',
          kind: 'prose',
          priority: 2,
          cell: () => (
            <div style={ballast > 0 ? { minWidth: `${String(ballast)}px` } : undefined}>
              <p style={{ width: '8rem', margin: 0 }}>{SAMPLE_NOTE}</p>
            </div>
          ),
        },
      ]}
    />
  );
}

/** A table narrow enough to be cards: one button for a card, its box and its act. */
function AsCards() {
  const chosen = useChosen();
  return (
    <Plain
      label="Pickup requests, as cards"
      rows={sampleRequests(5)}
      card={requestCard}
      cardTitle={requestCardTitle}
      selection={{
        selectedIds: chosen.ids,
        onChange: chosen.set,
        selectLabel: (request) => `Select ${request.code}`,
      }}
      rowAction={{
        label: 'Confirm',
        ariaLabel: (request) => `Confirm ${request.code}`,
        isAvailable: (request) => request.state === 'PENDING',
        onRun: () => undefined,
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
        <Specimen label="A field in a cell, beside the button that opens the row (sample data)">
          <FieldsInCells />
        </Specimen>
        <Specimen label="Loading, then the rows: the place the person left is put back once the rows are there (sample data)">
          <LoadingThenReady />
        </Specimen>
        <Specimen
          label="Column fit at 70rem: the box holds every column, and every column is drawn (sample data)"
          width="70rem"
        >
          <Prioritised label="Pickup requests, in 70rem" />
        </Specimen>
        <Specimen
          label="Column fit at 41rem: the lesser columns go, the most lesser first, as far as it takes for the box not to scroll sideways (sample data)"
          width="41rem"
        >
          <Prioritised label="Pickup requests, in 41rem" />
        </Specimen>
        <Specimen
          label="Prose columns at 44rem: the words keep 8rem and stay whole, and the lesser columns go to make the room (sample data)"
          width="44rem"
        >
          <ProseColumns label="Pickup requests, prose, in 44rem" />
        </Specimen>
        {['38rem', '41rem', '47rem'].map((width) => (
          <Specimen
            key={width}
            label={`Prose columns at ${width}, for the faces' test: the same table in a box a little narrower or wider (sample data)`}
            width={width}
          >
            <ProseColumns label={`Pickup requests, prose, in ${width}`} />
          </Specimen>
        ))}
        <Specimen label="A list near the height of the window: the fit does not follow the page's scrollbar (sample data)">
          <NearTheWindow label="Pickup requests, tall rows" />
        </Specimen>
        <Specimen
          label="Plain words at 30rem: the longest word holds its column, so the lesser column goes and no word is broken (sample data)"
          width="30rem"
        >
          <PlainWords label="Pickup requests, plain words, in 30rem" />
        </Specimen>
        <Specimen
          label="A list that opens nothing at 45rem: its columns cannot fit, so it is cards with every fact, and no column is lost (sample data)"
          width="45rem"
        >
          <OpensNothing label="Messages, in 45rem" />
        </Specimen>
        <Specimen
          label="A list that opens nothing at 75rem: the box holds every column, so it is a table (sample data)"
          width="75rem"
        >
          <OpensNothing label="Messages, in 75rem" />
        </Specimen>
        <Specimen
          label="Cards, where the box is narrow (22rem): one button for each, its box and its act (sample data)"
          width="22rem"
        >
          <AsCards />
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
