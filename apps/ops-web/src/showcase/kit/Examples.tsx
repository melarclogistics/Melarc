import { useMemo, useState } from 'react';

import { PICKUP_STATE_MAP, serviceDateText } from '../../app/pages/pickup/pickup-presentation';
import { Button as TouchButton } from '../../components/primitives/button';
import { Button } from '../../components/ui/button/Button';
import { DataTable, RowTitle, type DataColumn } from '../../components/ui/data-table/DataTable';
import { EmptyState } from '../../components/ui/empty-state/EmptyState';
import { FilterBar, type FilterChip } from '../../components/ui/filter-bar/FilterBar';
import { Panel } from '../../components/ui/panel/Panel';
import { PageHeader } from '../../components/ui/page-header/PageHeader';
import { RecordHeader } from '../../components/ui/record-header/RecordHeader';
import { SidePanel } from '../../components/ui/side-panel/SidePanel';
import { StatTile } from '../../components/ui/stat-tile/StatTile';
import { StatusBadge } from '../../components/ui/status-badge/StatusBadge';
import { Timeline } from '../../components/ui/timeline/Timeline';
import { showToast } from '../../components/ui/toast/Toast';
import { ViewTabs } from '../../components/ui/view-tabs/ViewTabs';
import { requestColumns } from './DataGroup';
import { RequestFacts, RequestMenu, REQUEST_STAGES } from './PanelsGroup';
import { sampleRequests, type SampleRequest } from './sample-data';
import { DescriptionList } from '../../components/ui/description-list/DescriptionList';

type View = 'needs-decision' | 'confirmed' | 'cancelled' | 'all';

const VIEW_STATE: Record<Exclude<View, 'all'>, SampleRequest['state']> = {
  'needs-decision': 'PENDING',
  confirmed: 'CONFIRMED',
  cancelled: 'CANCELLED',
};

const FILTERS: readonly FilterChip[] = [
  { id: 'date', label: 'Service date: this week' },
  { id: 'hub', label: 'Hub: Accra Central' },
];

/**
 * The queue workspace template (PRODUCT_DESIGN_DIRECTION section 6.1) composed from the kit on the generated client's pickup-request shape: the page header, the
 * views with counts, the filters, the table, and the record in a panel beside it. Every row is a sample, and the counts are the counts of those sample rows. The
 * filters here only take their chips off: filtering is the server's, and no server is asked.
 */
export function QueueWorkspaceExample() {
  const all = useMemo(() => sampleRequests(12), []);
  const [view, setView] = useState<View>('all');
  const [chips, setChips] = useState(FILTERS);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [opened, setOpened] = useState<SampleRequest | undefined>();
  const [checkedAt, setCheckedAt] = useState('09:42');

  const countOf = (state: SampleRequest['state']): number =>
    all.filter((request) => request.state === state).length;
  const shown = view === 'all' ? all : all.filter((request) => request.state === VIEW_STATE[view]);
  const columns = useMemo<readonly DataColumn<SampleRequest>[]>(() => requestColumns(true), []);

  return (
    <div className="showcase-kit-stack">
      <PageHeader
        title="Pickup requests"
        description="Requests waiting for a decision, and the ones already confirmed. Sample data: nothing here was read from the server."
        count={{ value: all.length, noun: 'sample pickup requests' }}
        freshness={{
          updatedAt: checkedAt,
          onRefresh: () => {
            setCheckedAt('09:43');
          },
        }}
        actions={<Button type="button">Book a pickup</Button>}
      />
      <div className="showcase-kit-split">
        <div className="showcase-kit-card">
          <Panel variant="page" padding="none">
            <ViewTabs
              label="Views of the pickup queue"
              value={view}
              onValueChange={(next) => {
                setView(next as View);
                setChosen([]);
              }}
              tabs={[
                { id: 'needs-decision', label: 'Needs decision', count: countOf('PENDING') },
                { id: 'confirmed', label: 'Confirmed', count: countOf('CONFIRMED') },
                { id: 'cancelled', label: 'Cancelled', count: countOf('CANCELLED') },
                { id: 'all', label: 'All', count: all.length },
              ]}
            >
              <div className="showcase-kit-stack" style={{ padding: 'var(--space-4) 0 0' }}>
                <div style={{ padding: '0 var(--space-4)' }}>
                  <FilterBar
                    label="Filters"
                    chips={chips}
                    onRemove={(id) => {
                      setChips((current) => current.filter((chip) => chip.id !== id));
                    }}
                    sortLabel="Sorted by oldest first"
                  />
                </div>
                <DataTable<SampleRequest>
                  label="Pickup requests"
                  columns={columns}
                  rows={shown}
                  rowId={(request) => request.id}
                  density="two-line"
                  onOpen={setOpened}
                  openLabel={(request) =>
                    `Open ${request.code}${request.sender_name === undefined ? '' : `, ${request.sender_name}`}`
                  }
                  selection={{
                    selectedIds: chosen,
                    onChange: setChosen,
                    selectLabel: (request) => `Select ${request.code}`,
                    bulkActions: [
                      {
                        id: 'confirm',
                        label: (count) => `Confirm ${String(count)}`,
                        primary: true,
                        onRun: (ids) => {
                          showToast({
                            tone: 'success',
                            message: `${String(ids.length)} sample requests confirmed.`,
                            action: { label: 'Open', onClick: () => undefined },
                          });
                          setChosen([]);
                        },
                      },
                    ],
                  }}
                  rowAction={{
                    label: 'Confirm',
                    ariaLabel: (request) => `Confirm ${request.code}`,
                    isAvailable: (request) => request.state === 'PENDING',
                    onRun: (request) => {
                      showToast({ tone: 'success', message: `${request.code} confirmed.` });
                    },
                  }}
                  emptyState={
                    <EmptyState kind="none" heading="Nothing in this view">
                      No sample request has this state.
                    </EmptyState>
                  }
                  maxHeight="28rem"
                />
              </div>
            </ViewTabs>
          </Panel>
        </div>
        <SidePanel
          open={opened !== undefined}
          onClose={() => {
            setOpened(undefined);
          }}
          code={opened?.code ?? ''}
          status={
            opened === undefined ? undefined : (
              <StatusBadge status={opened.state} map={PICKUP_STATE_MAP} />
            )
          }
          fullPage={{ to: '/__showcase/kit/example-record' }}
        >
          {opened === undefined ? null : <RequestFacts request={opened} />}
        </SidePanel>
      </div>
    </div>
  );
}

const ACTIVITY = [
  {
    key: 'received',
    title: 'Booked by the vendor',
    details: 'Wed 4 Nov 2026, 09:12. Three packages for Mon 9 Nov 2026.',
  },
  { key: 'confirmed', title: 'Confirmed by the hub', details: 'Wed 4 Nov 2026, 09:40.' },
  {
    key: 'note',
    title: 'A note was added',
    details: 'Thu 5 Nov 2026, 14:05. "Ask for the manager at the side gate."',
    current: true,
  },
] as const;

/**
 * The record template (PRODUCT_DESIGN_DIRECTION section 6.2) composed from the kit: the header with the stage tracker, one primary action and the menu; a main
 * column for the work and a side column for facts, and an activity timeline. The record is a sample.
 */
export function RecordPageExample() {
  const request = sampleRequests(1)[0];
  if (request === undefined) return null;
  return (
    <div className="showcase-kit-stack">
      <PageHeader
        title="Pickup request"
        breadcrumb={[{ label: 'Pickup requests', to: '/__showcase/kit/example-queue' }]}
        description="A sample record: nothing here was read from the server."
      />
      <Panel variant="page">
        <RecordHeader
          code={request.code}
          level={2}
          status={<StatusBadge status="CONFIRMED" map={PICKUP_STATE_MAP} />}
          sentence="The hub confirmed this pickup for Mon 9 Nov 2026. A rider is not assigned yet."
          stages={{
            label: 'Progress of the pickup request',
            stages: REQUEST_STAGES,
            currentId: 'confirmed',
          }}
          secondaryActions={
            <Button type="button" variant="secondary">
              Edit the note
            </Button>
          }
          primaryAction={<Button type="button">Assign a rider</Button>}
          menu={<RequestMenu code={request.code} />}
        />
      </Panel>
      <div className="showcase-kit-columns">
        <div className="showcase-kit-stack">
          <Panel title="Pickup" headingLevel={3}>
            <DescriptionList
              items={[
                { label: 'Request', value: request.code, code: true },
                { label: 'Service date', value: serviceDateText(request.scheduled_service_date) },
                { label: 'Hub', value: 'Accra Central' },
                { label: 'Packages', value: String(request.declared_package_count) },
                { label: 'Landmark' },
              ]}
            />
          </Panel>
          <Panel title="Activity" headingLevel={3}>
            <Timeline label="Activity of the request" entries={ACTIVITY} currentLabel="Latest" />
          </Panel>
        </div>
        <div className="showcase-kit-stack">
          <Panel title="Sender" headingLevel={3}>
            <DescriptionList
              items={[
                { label: 'Name', value: request.sender_name },
                { label: 'Phone', value: '+233******111' },
              ]}
            />
          </Panel>
          <Panel title="Estimate" headingLevel={3}>
            <StatTile
              label="Indicative total"
              value="GH₵25.50"
              caption="An estimate, not a price"
            />
          </Panel>
        </div>
      </div>
    </div>
  );
}

interface CountLine {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

const COUNT_LINES: readonly CountLine[] = [
  { id: 'line-1', code: 'ACC-PR-7KQ2MZ', name: 'Sample Fabrics Ltd' },
  { id: 'line-2', code: 'ACC-PR-4HT9WD', name: 'Sample Bakery' },
  { id: 'line-3', code: 'ACC-PR-2MX8RC', name: 'Sample Pharmacy' },
  { id: 'line-4', code: 'ACC-PR-9WXH4T', name: 'Sample Books' },
];

/**
 * A hub-floor task on a tablet (DESIGN_SYSTEM section 12; surfaces/ops-portal.md section 11): the blind count at 768px, one task on the screen, with rows and
 * every target at 56px. **The sender's declared count is not on the screen**, and the screen says why: it is shown only after the officer's own count is sent.
 * Nothing is added up here: what was counted is the officer's, line by line, and the server compares.
 */
export function BlindCountExample() {
  const [counts, setCounts] = useState<Readonly<Record<string, string>>>({});
  const columns = useMemo<readonly DataColumn<CountLine>[]>(
    () => [
      {
        id: 'line',
        header: 'Parcels from',
        cell: (line) => <RowTitle code={line.code} name={line.name} />,
      },
      {
        id: 'counted',
        header: 'You counted',
        align: 'end',
        cell: (line) => {
          const value = counts[line.id] ?? '';
          const set = (next: number): void => {
            setCounts((current) => ({ ...current, [line.id]: String(Math.max(0, next)) }));
          };
          return (
            <span
              className="showcase-kit-row"
              style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}
            >
              <TouchButton
                type="button"
                variant="outline"
                size="icon-lg"
                aria-label={`One fewer parcel from ${line.name}`}
                onClick={() => {
                  set((Number(value) || 0) - 1);
                }}
              >
                <span className="showcase-kit-count__step" aria-hidden="true">
                  −
                </span>
              </TouchButton>
              <input
                className="showcase-kit-count__field"
                inputMode="numeric"
                aria-label={`Parcels counted from ${line.name}`}
                value={value}
                placeholder="0"
                onChange={(event) => {
                  const digits = event.target.value.replace(/\D/g, '').slice(0, 3);
                  setCounts((current) => ({ ...current, [line.id]: digits }));
                }}
              />
              <TouchButton
                type="button"
                variant="outline"
                size="icon-lg"
                aria-label={`One more parcel from ${line.name}`}
                onClick={() => {
                  set((Number(value) || 0) + 1);
                }}
              >
                <span className="showcase-kit-count__step" aria-hidden="true">
                  +
                </span>
              </TouchButton>
            </span>
          );
        },
      },
    ],
    [counts],
  );
  const everyLineCounted = COUNT_LINES.every((line) => (counts[line.id] ?? '') !== '');
  return (
    <div className="showcase-kit-tablet">
      <PageHeader
        title="Count the parcels"
        description="Count every parcel on the bench, line by line. The sender's count is not shown until yours is sent."
      />
      <Panel padding="none">
        <DataTable<CountLine>
          label="Parcels to count"
          columns={columns}
          rows={COUNT_LINES}
          rowId={(line) => line.id}
          density="touch"
        />
      </Panel>
      <div
        className="showcase-kit-row"
        style={{ marginTop: 'var(--space-4)', justifyContent: 'flex-end' }}
      >
        <TouchButton type="button" variant="outline" size="lg">
          Save and come back
        </TouchButton>
        <TouchButton
          type="button"
          size="lg"
          disabled={!everyLineCounted}
          onClick={() => {
            showToast({
              tone: 'success',
              message: 'Your count was sent. The hub will compare it with the sender’s.',
            });
          }}
        >
          Send the count
        </TouchButton>
      </div>
      {everyLineCounted ? null : <p className="showcase-kit-opened">Count every line to send.</p>}
    </div>
  );
}
