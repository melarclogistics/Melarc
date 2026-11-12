import { useState } from 'react';

import { DatePicker } from '../../components/ui/date-picker/DatePicker';
import { Field } from '../../components/ui/field/Field';
import { Button } from '../../components/ui/button/Button';
import { FilterBar, type FilterChip } from '../../components/ui/filter-bar/FilterBar';
import { PageHeader } from '../../components/ui/page-header/PageHeader';
import { ViewTabs, type ViewTab } from '../../components/ui/view-tabs/ViewTabs';
import { Select } from '../../components/ui/select/Select';
import { KitSection, Specimen } from './Section';

const noop = (): void => undefined;

function PageHeaderSpecimens() {
  const [state, setState] = useState<'idle' | 'refreshing' | 'failed'>('idle');
  return (
    <KitSection
      title="PageHeader"
      note="The title, the count the server stated, how fresh the results are, the pages above and the page's actions. A count that was not stated is not drawn."
    >
      <Specimen label="Title only">
        <PageHeader title="Pickup requests" />
      </Specimen>
      <Specimen label="With a description, a count and an action">
        <PageHeader
          title="Pickup requests"
          description="Requests waiting for a decision, and the ones already confirmed."
          count={{ value: 128, noun: 'pickup requests' }}
          actions={<Button type="button">Book a pickup</Button>}
        />
      </Specimen>
      <Specimen label="A count of 0 that was read">
        <PageHeader title="Exception approvals" count={{ value: 0, noun: 'exceptions waiting' }} />
      </Specimen>
      <Specimen label="Freshness: updated (press Refresh to see it check, then fail, then recover)">
        <PageHeader
          title="Pickup requests"
          count={{ value: 128, noun: 'pickup requests' }}
          freshness={{
            state,
            updatedAt: '09:42',
            onRefresh: () => {
              setState('refreshing');
              window.setTimeout(() => {
                setState('failed');
              }, 900);
              window.setTimeout(() => {
                setState('idle');
              }, 2600);
            },
          }}
        />
      </Specimen>
      <Specimen label="Freshness: checking">
        <PageHeader
          title="Pickup requests"
          freshness={{ state: 'refreshing', updatedAt: '09:42', onRefresh: noop }}
        />
      </Specimen>
      <Specimen label="Freshness: the last read failed">
        <PageHeader
          title="Pickup requests"
          freshness={{ state: 'failed', updatedAt: '09:42', onRefresh: noop }}
        />
      </Specimen>
      <Specimen label="Freshness: the first read failed, so there is no time to tell">
        <PageHeader title="Pickup requests" freshness={{ state: 'failed', onRefresh: noop }} />
      </Specimen>
      <Specimen label="With the pages above">
        <PageHeader
          title="Run ACC-MF-Q92422"
          breadcrumb={[
            { label: 'Dispatch', to: '/__showcase/kit/header' },
            { label: 'Pickup runs', to: '/__showcase/kit/header' },
          ]}
          actions={
            <>
              <Button type="button" variant="secondary">
                Print the run
              </Button>
              <Button type="button">Assign a rider</Button>
            </>
          }
        />
      </Specimen>
      <Specimen label="In a narrow room: the actions wrap under the title" width="22rem">
        <PageHeader
          title="Pickup requests"
          description="Requests waiting for a decision."
          count={{ value: 128, noun: 'pickup requests' }}
          freshness={{ updatedAt: '09:42', onRefresh: noop }}
          actions={
            <>
              <Button type="button" variant="secondary">
                Export the list
              </Button>
              <Button type="button">Book a pickup</Button>
            </>
          }
        />
      </Specimen>
    </KitSection>
  );
}

const VIEWS: readonly ViewTab[] = [
  { id: 'needs-decision', label: 'Needs decision', count: 12 },
  { id: 'confirmed', label: 'Confirmed', count: 86 },
  { id: 'cancelled', label: 'Cancelled', count: 30 },
  { id: 'all', label: 'All', count: 128 },
];

function Views({
  tabs,
  initial = 'needs-decision',
  width,
}: {
  tabs: readonly ViewTab[];
  initial?: string;
  width?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ViewTabs label="Views of the pickup queue" tabs={tabs} value={value} onValueChange={setValue}>
      <p style={{ margin: 'var(--space-3) 0 0', maxWidth: width }}>
        The {tabs.find((tab) => tab.id === value)?.label.toLowerCase()} view. Its rows would be
        here.
      </p>
    </ViewTabs>
  );
}

function ViewTabsSpecimens() {
  return (
    <KitSection
      title="ViewTabs"
      note="The views of one queue. The counts are the server's; a view with no count stated draws none, and the current view's count is filled in Ink. Use the arrow keys, Home and End."
    >
      <Specimen label="Four views with counts (the sample figures are made up)">
        <Views tabs={VIEWS} />
      </Specimen>
      <Specimen label="Counts still being read: no figure, never a 0">
        <Views tabs={VIEWS.map((tab) => ({ id: tab.id, label: tab.label }))} />
      </Specimen>
      <Specimen label="A view with a 0 that was read, and one that cannot be chosen now">
        <Views
          tabs={[
            { id: 'needs-decision', label: 'Needs decision', count: 0 },
            { id: 'confirmed', label: 'Confirmed', count: 86 },
            { id: 'archive', label: 'Archive', disabled: true },
          ]}
        />
      </Specimen>
      <Specimen label="In a narrow room: the list scrolls inside its own box" width="20rem">
        <Views tabs={VIEWS} width="16rem" />
      </Specimen>
      <Specimen
        label="In a narrow room, the last view current: it is brought into view and the start fades"
        width="20rem"
      >
        <Views tabs={VIEWS} initial="all" width="16rem" />
      </Specimen>
    </KitSection>
  );
}

const SERVICE_DATE: FilterChip = { id: 'date', label: 'Service date: this week' };
const STATE: FilterChip = { id: 'state', label: 'State: Confirmed' };
const HUB: FilterChip = { id: 'hub', label: 'Hub: Accra Central' };

function Bar({
  initial,
  sortLabel,
  many = false,
  searching = false,
}: {
  initial: readonly FilterChip[];
  sortLabel?: string;
  many?: boolean;
  searching?: boolean;
}) {
  const [chips, setChips] = useState(initial);
  const [searched, setSearched] = useState('');
  const [date, setDate] = useState<string | null>(null);
  const [state, setState] = useState('');
  return (
    <FilterBar
      label="Filters"
      chips={chips}
      {...(searching
        ? {
            search: {
              label: 'Search by name or email',
              value: searched,
              onSearch: setSearched,
              maxLength: 80,
            },
          }
        : {})}
      onRemove={(id) => {
        setChips((current) => current.filter((chip) => chip.id !== id));
      }}
      onClearAll={() => {
        setChips([]);
      }}
      {...(sortLabel === undefined ? {} : { sortLabel })}
      filterPanel={
        <div className="showcase-kit-stack">
          <Field label="State">
            <Select
              value={state}
              onChange={(event) => {
                setState(event.target.value);
              }}
            >
              <option value="">Any state</option>
              <option value="PENDING">Waiting for confirmation</option>
              <option value="CONFIRMED">Confirmed</option>
            </Select>
          </Field>
          <Field label="Service date" help="Day, month and year.">
            <DatePicker value={date} onChange={setDate} />
          </Field>
          {many ? <p>Sample filters. Nothing is sent.</p> : null}
        </div>
      }
    />
  );
}

function FilterBarSpecimens() {
  return (
    <KitSection
      title="FilterBar"
      note="What is applied is a chip that can be removed on its own; the dashed Filter button opens the page's fields in a popover; the order of the rows is told at the end; a queue that is searched has its search field in the bar. Remove a chip with the keyboard and focus stays where it should."
    >
      <Specimen label="Nothing applied">
        <Bar initial={[]} sortLabel="Sorted by oldest first" />
      </Specimen>
      <Specimen label="One filter">
        <Bar initial={[SERVICE_DATE]} sortLabel="Sorted by oldest first" />
      </Specimen>
      <Specimen label="Three filters, with Clear all">
        <Bar initial={[SERVICE_DATE, STATE, HUB]} sortLabel="Sorted by oldest first" />
      </Specimen>
      <Specimen label="A search field, always in the bar (nothing is opened to find it)">
        <Bar initial={[SERVICE_DATE]} sortLabel="Sorted by oldest first" searching />
      </Specimen>
      <Specimen label="Many filters wrap, and nothing is cut off" width="30rem">
        <Bar
          initial={[
            SERVICE_DATE,
            STATE,
            HUB,
            { id: 'vendor', label: 'Vendor: Demo Fabrics Ltd' },
            { id: 'late', label: 'Late bookings only' },
          ]}
          sortLabel="Sorted by oldest first"
          many
        />
      </Specimen>
    </KitSection>
  );
}

export function HeaderGroup() {
  return (
    <>
      <PageHeaderSpecimens />
      <ViewTabsSpecimens />
      <FilterBarSpecimens />
    </>
  );
}
