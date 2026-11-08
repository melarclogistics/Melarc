import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/primitives/table';
import { Button } from '../../components/ui/button/Button';
import { DataTable } from '../../components/ui/data-table/DataTable';
import { EmptyStateV2 } from '../../components/ui/empty-state/EmptyStateV2';
import { LoadingIndicator } from '../../components/ui/loading/LoadingIndicator';
import { Panel } from '../../components/ui/panel/Panel';
import { LoadingRow } from '../../components/ui/skeleton/LoadingRow';
import { SkeletonBar } from '../../components/ui/skeleton/SkeletonBar';
import { SkeletonCard } from '../../components/ui/skeleton/SkeletonCard';
import { requestColumns } from './DataGroup';
import { sampleRequests, type SampleRequest } from './sample-data';
import { KitSection, ScrollRegion, Specimen } from './Section';

const COLUMNS = ['Request', 'Sender', 'Hub', 'Service date', 'Status'] as const;

function EmptyStateSpecimens() {
  return (
    <KitSection
      title="EmptyState v2"
      note="The 10px square of the brand crimson, a title, one line and, if there is one, the next thing to do. It tells three kinds of nothing apart: nothing yet (empty), something that a filter hides (filtered-empty, which always offers the way to take the filter off) and a queue worked to nothing (all-clear, which is good news and reads as such). It shows no example rows. The earlier EmptyState stays in use until the screens move."
    >
      <div className="showcase-kit-grid">
        <Specimen label="Empty: nothing yet, with the next step">
          <EmptyStateV2
            variant="empty"
            title="No pickup requests yet"
            action={<Button type="button">Book a pickup</Button>}
          >
            Requests from vendors appear here as they come in.
          </EmptyStateV2>
        </Specimen>
        <Specimen label="Empty: nothing yet, and nothing to do about it">
          <EmptyStateV2 variant="empty" title="No messages were sent today">
            Messages to vendors and recipients appear here once they are sent.
          </EmptyStateV2>
        </Specimen>
        <Specimen label="Filtered-empty: the filters hide everything">
          <EmptyStateV2
            variant="filtered-empty"
            title="No pickup requests match"
            action={
              <Button type="button" variant="secondary">
                Clear the filters
              </Button>
            }
          >
            No request has the state Cancelled on this service date.
          </EmptyStateV2>
        </Specimen>
        <Specimen label="All-clear: worked to nothing">
          <EmptyStateV2 variant="all-clear" title="Nothing is waiting">
            Every pickup request has been dealt with. New ones appear here as they come in.
          </EmptyStateV2>
        </Specimen>
        <Specimen label="Inside a card, one level down (320px wide)" width="20rem">
          <Panel title="Packages" headingLevel={3}>
            <EmptyStateV2 variant="empty" title="No packages declared" headingLevel={4}>
              The sender gave no package count.
            </EmptyStateV2>
          </Panel>
        </Specimen>
      </div>
      <Specimen label="In a table that has no rows (all-clear, then filtered-empty)">
        <div className="showcase-kit-stack">
          <DataTable<SampleRequest>
            label="Pickup requests, all-clear"
            columns={requestColumns(false)}
            rows={[]}
            rowId={(request) => request.id}
            emptyState={
              <EmptyStateV2 variant="all-clear" title="Nothing is waiting" headingLevel={3}>
                Every pickup request has been dealt with.
              </EmptyStateV2>
            }
          />
          <DataTable<SampleRequest>
            label="Pickup requests, filtered to nothing"
            columns={requestColumns(false)}
            rows={[]}
            rowId={(request) => request.id}
            emptyState={
              <EmptyStateV2
                variant="filtered-empty"
                title="No pickup requests match"
                headingLevel={3}
                action={
                  <Button type="button" variant="secondary">
                    Clear the filters
                  </Button>
                }
              >
                No request has the state Cancelled on this service date.
              </EmptyStateV2>
            }
          />
        </div>
      </Specimen>
    </KitSection>
  );
}

function SkeletonSpecimens() {
  return (
    <KitSection
      title="Skeleton v2"
      note="Bars in the shape of what is on the way, so that the layout keeps still and nothing jumps when the content arrives. They are decoration: the words that say the page is loading are the loading indicator's. They pulse only where motion is welcome."
    >
      <div className="showcase-kit-grid">
        <Specimen label="Bars: a line, a short one and a title">
          <div className="showcase-kit-stack">
            <SkeletonBar />
            <SkeletonBar width="40%" />
            <SkeletonBar width="60%" height="1.5rem" />
          </div>
        </Specimen>
        <Specimen label="A card with a title and three lines">
          <SkeletonCard />
        </Specimen>
        <Specimen label="A card with no title and two lines">
          <SkeletonCard header={false} lines={2} />
        </Specimen>
        <Specimen label="A card with five lines">
          <SkeletonCard lines={5} />
        </Specimen>
      </div>
    </KitSection>
  );
}

function LoadingRowSpecimens() {
  return (
    <KitSection
      title="LoadingRow"
      note="A row of a table that is loading: a bar in each cell, in the widths of a real row, so the table keeps its columns and its height. The table says in words that it is loading, and the row is hidden from assistive technology. The table of the queue draws these itself while its rows are read."
    >
      <Specimen label="Five loading rows under their headings">
        <div className="showcase-kit-stack">
          <LoadingIndicator label="Loading pickup requests" />
          <ScrollRegion label="Pickup requests, loading">
            <Table aria-label="Pickup requests, loading">
              <TableHeader>
                <TableRow>
                  {COLUMNS.map((column) => (
                    <TableHead key={column} scope="col">
                      {column}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {Array.from({ length: 5 }, (_row, index) => (
                  <LoadingRow key={index} columns={COLUMNS.length} index={index} />
                ))}
              </TableBody>
            </Table>
          </ScrollRegion>
        </div>
      </Specimen>
      <Specimen label="The queue's table while it loads, and when its rows have arrived (sample data)">
        <div className="showcase-kit-stack">
          <DataTable<SampleRequest>
            label="Pickup requests, loading"
            columns={requestColumns(false)}
            rows={[]}
            rowId={(request) => request.id}
            status="loading"
            loadingRows={3}
            loadingLabel="Loading pickup requests"
          />
          <DataTable<SampleRequest>
            label="Pickup requests, loaded"
            columns={requestColumns(false)}
            rows={sampleRequests(3)}
            rowId={(request) => request.id}
          />
        </div>
      </Specimen>
    </KitSection>
  );
}

/** The empty and the loading states (COMPONENT_PATTERNS, *EmptyState v2*, *Skeleton v2* and *LoadingRow*; the second half of redesign step R5). */
export function StatesGroup() {
  return (
    <>
      <EmptyStateSpecimens />
      <SkeletonSpecimens />
      <LoadingRowSpecimens />
    </>
  );
}
