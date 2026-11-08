import { useMemo, useState, type SubmitEvent } from 'react';

import { PICKUP_STATE_MAP, serviceDateText } from '../../app/pages/pickup/pickup-presentation';
import { Avatar } from '../../components/ui/avatar/Avatar';
import { Button } from '../../components/ui/button/Button';
import { DataTable, type DataColumn } from '../../components/ui/data-table/DataTable';
import { DescriptionList } from '../../components/ui/description-list/DescriptionList';
import { Field } from '../../components/ui/field/Field';
import { type FilterChip } from '../../components/ui/filter-bar/FilterBar';
import { Input } from '../../components/ui/input/Input';
import { Panel } from '../../components/ui/panel/Panel';
import { StatTile } from '../../components/ui/stat-tile/StatTile';
import { StatusBadge } from '../../components/ui/status-badge/StatusBadge';
import { showToast } from '../../components/ui/toast/Toast';
import {
  Builder,
  BuilderRunList,
  type BuilderRunItem,
} from '../../components/ui/templates/Builder';
import { QueueWorkspace } from '../../components/ui/templates/QueueWorkspace';
import { RecordPage } from '../../components/ui/templates/RecordPage';
import {
  announceTaskDone,
  TaskForm,
  TaskFormSection,
  TaskFormWide,
} from '../../components/ui/templates/TaskForm';
import { requestCard, requestColumns } from './DataGroup';
import { REQUEST_STAGES, requestMenuItems, RequestFacts } from './PanelsGroup';
import { SAMPLE_SENDER_PHONE, sampleRequests, type SampleRequest } from './sample-data';

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

/** What the sample queue's read has come to, for the buttons that show each state of the template. */
type Mode = 'rows' | 'loading' | 'failed' | 'stale' | 'hub' | 'filtered';

const MODES: readonly { readonly id: Mode; readonly label: string }[] = [
  { id: 'rows', label: 'Rows' },
  { id: 'loading', label: 'Loading' },
  { id: 'failed', label: 'Failed' },
  { id: 'stale', label: 'Stale' },
  { id: 'hub', label: 'Nothing at the hub' },
  { id: 'filtered', label: 'Nothing fits' },
];

const sentenceOf = (request: SampleRequest): string =>
  request.state === 'PENDING'
    ? 'Booked after the hub’s cut-off: it waits for an Ops decision before it can be confirmed.'
    : `The hub confirmed this pickup for ${serviceDateText(request.scheduled_service_date)}.`;

/**
 * The queue workspace template (PRODUCT_DESIGN_DIRECTION section 6.1) on the generated client's pickup-request shape: the page header, the views with counts, the filters, the
 * table with its bar of acts and its card layout, and the record in a panel beside it, drawn by the record page template. Every row is a sample and the counts are the counts of
 * those sample rows. The buttons above show each state of the template; nothing is asked of a server.
 */
export function QueueWorkspaceExample() {
  const all = useMemo(() => sampleRequests(12), []);
  const [view, setView] = useState<View>('all');
  const [chips, setChips] = useState(FILTERS);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [opened, setOpened] = useState<SampleRequest | undefined>();
  const [checkedAt, setCheckedAt] = useState('09:42');
  const [mode, setMode] = useState<Mode>('rows');
  const countOf = (state: SampleRequest['state']): number =>
    all.filter((request) => request.state === state).length;
  const inView = view === 'all' ? all : all.filter((request) => request.state === VIEW_STATE[view]);
  const rows = mode === 'hub' || mode === 'filtered' ? [] : inView;
  const columns = useMemo<readonly DataColumn<SampleRequest>[]>(() => requestColumns(true), []);
  const clearFilters = (): void => {
    setChips([]);
    setMode('rows');
  };
  return (
    <div className="showcase-kit-stack">
      <div className="showcase-kit-row" role="group" aria-label="State of the sample read">
        {MODES.map((each) => (
          <Button
            key={each.id}
            type="button"
            variant="secondary"
            aria-pressed={mode === each.id}
            onClick={() => {
              setMode(each.id);
            }}
          >
            {each.label}
          </Button>
        ))}
      </div>
      <QueueWorkspace<SampleRequest>
        header={{
          title: 'Pickup requests',
          description:
            'Requests waiting for a decision, and the ones already confirmed. Sample data: nothing here was read from the server.',
          count: { value: all.length, noun: 'sample pickup requests' },
          freshness: {
            updatedAt: checkedAt,
            onRefresh: () => {
              setCheckedAt('09:43');
            },
          },
          actions: <Button type="button">Book a pickup</Button>,
        }}
        views={{
          label: 'Views of the pickup queue',
          value: view,
          onValueChange: (next) => {
            setView(next as View);
            setChosen([]);
          },
          tabs: [
            { id: 'needs-decision', label: 'Needs decision', count: countOf('PENDING') },
            { id: 'confirmed', label: 'Confirmed', count: countOf('CONFIRMED') },
            { id: 'cancelled', label: 'Cancelled', count: countOf('CANCELLED') },
            { id: 'all', label: 'All', count: all.length },
          ],
        }}
        filters={{
          label: 'Filters',
          chips,
          onRemove: (id) => {
            setChips((current) => current.filter((chip) => chip.id !== id));
          },
          sortLabel: 'Sorted by oldest first',
        }}
        result={
          mode === 'loading'
            ? { status: 'loading' }
            : mode === 'failed'
              ? {
                  status: 'error',
                  message:
                    'The pickup requests could not be read. Check the connection and try again.',
                  onRetry: () => {
                    setMode('rows');
                  },
                }
              : {
                  status: 'ready',
                  rows,
                  ...(mode === 'stale'
                    ? {
                        stale: {
                          message:
                            'The list may be out of date. The last read was at 09:42, and the next one failed.',
                          onRefresh: () => {
                            setMode('rows');
                          },
                        },
                      }
                    : {}),
                }
        }
        empty={
          mode === 'hub'
            ? {
                noun: 'pickup requests',
                none: 'Requests booked at your hubs appear here.',
                hub: {
                  name: 'Accra Central',
                  onShowAllHubs: () => {
                    setMode('rows');
                  },
                },
              }
            : {
                noun: 'pickup requests',
                none: 'Requests booked at your hubs appear here.',
                filtered: true,
                onClearFilters: clearFilters,
                clearLabel: 'Show every request',
              }
        }
        table={{
          label: 'Pickup requests',
          columns,
          rowId: (request) => request.id,
          density: 'two-line',
          onOpen: setOpened,
          openLabel: (request) =>
            `Open ${request.code}${request.sender_name === undefined ? '' : `, ${request.sender_name}`}`,
          card: requestCard,
          selection: {
            selectedIds: chosen,
            onChange: setChosen,
            selectLabel: (request) => `Select ${request.code}`,
            bulkActions: [
              {
                id: 'confirm',
                label: (count) => `Confirm ${String(count)}`,
                primary: true,
                // Only a request that is waiting can be confirmed: the others are left out, and the bar says how many.
                eligible: (chosenIds) =>
                  chosenIds.filter(
                    (id) => all.find((request) => request.id === id)?.state === 'PENDING',
                  ),
                note: (left) =>
                  `${String(left)} ${left === 1 ? 'is' : 'are'} already confirmed or cancelled`,
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
          },
          rowAction: {
            label: 'Confirm',
            ariaLabel: (request) => `Confirm ${request.code}`,
            isAvailable: (request) => request.state === 'PENDING',
            onRun: (request) => {
              showToast({ tone: 'success', message: `${request.code} confirmed.` });
            },
          },
          maxHeight: '28rem',
        }}
        panel={{
          open: opened !== undefined,
          onClose: () => {
            setOpened(undefined);
          },
          code: opened?.code ?? '',
          ...(opened === undefined
            ? {}
            : {
                status: <StatusBadge status={opened.state} map={PICKUP_STATE_MAP} />,
              }),
          fullPage: { to: '/__showcase/kit/example-record' },
          children:
            opened === undefined ? null : (
              <RecordPage
                header={{
                  code: opened.code,
                  sentence: sentenceOf(opened),
                  stages: {
                    label: 'Progress of the pickup request',
                    stages: REQUEST_STAGES,
                    currentId: opened.state === 'PENDING' ? 'received' : 'confirmed',
                  },
                }}
                acts={
                  opened.state === 'PENDING'
                    ? {
                        primary: (
                          <Button
                            type="button"
                            onClick={() => {
                              showToast({
                                tone: 'success',
                                message: `${opened.code} confirmed.`,
                              });
                            }}
                          >
                            Confirm pickup
                          </Button>
                        ),
                      }
                    : {}
                }
                main={<RequestFacts request={opened} />}
              />
            ),
        }}
      />
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
 * The record page template (PRODUCT_DESIGN_DIRECTION section 6.2): the header with the stage tracker, one primary action and the menu; a main column for the work and the
 * activity, a side column for facts and people. The buttons show a version conflict and the acts a session without the permission would not be given. The record is a sample.
 */
export function RecordPageExample() {
  const request = sampleRequests(1)[0];
  const [conflict, setConflict] = useState(false);
  const [limited, setLimited] = useState(false);
  if (request === undefined) return null;
  return (
    <div className="showcase-kit-stack">
      <div className="showcase-kit-row" role="group" aria-label="State of the sample record">
        <Button
          type="button"
          variant="secondary"
          aria-pressed={conflict}
          onClick={() => {
            setConflict((now) => !now);
          }}
        >
          A stale version
        </Button>
        <Button
          type="button"
          variant="secondary"
          aria-pressed={limited}
          onClick={() => {
            setLimited((now) => !now);
          }}
        >
          A session with fewer acts
        </Button>
      </div>
      <RecordPage
        breadcrumb={[{ label: 'Pickup requests', to: '/__showcase/kit/example-queue' }]}
        header={{
          code: request.code,
          status: <StatusBadge status="CONFIRMED" map={PICKUP_STATE_MAP} />,
          sentence:
            'The hub confirmed this pickup for Mon 9 Nov 2026. A rider is not assigned yet.',
          stages: {
            label: 'Progress of the pickup request',
            stages: REQUEST_STAGES,
            currentId: 'confirmed',
          },
        }}
        acts={
          limited
            ? {}
            : {
                primary: <Button type="button">Assign a rider</Button>,
                secondary: (
                  <Button type="button" variant="secondary">
                    Edit the note
                  </Button>
                ),
                menu: {
                  label: `More actions for ${request.code}`,
                  items: requestMenuItems(request.code),
                },
              }
        }
        {...(conflict
          ? {
              conflict: {
                onReload: () => {
                  setConflict(false);
                },
              },
            }
          : {})}
        main={
          <Panel title="Pickup" headingLevel={2}>
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
        }
        side={
          <>
            <Panel title="Sender" headingLevel={2}>
              <DescriptionList
                items={[
                  {
                    label: 'Name',
                    value:
                      request.sender_name === undefined ? undefined : (
                        <span className="showcase-kit-person">
                          <Avatar name={request.sender_name} />
                          {request.sender_name}
                        </span>
                      ),
                  },
                  { label: 'Phone', value: SAMPLE_SENDER_PHONE },
                ]}
              />
            </Panel>
            <Panel title="Estimate" headingLevel={2}>
              <StatTile
                label="Indicative total"
                value="GH₵25.50"
                caption="An estimate, not a price"
              />
            </Panel>
          </>
        }
        activity={{ entries: ACTIVITY }}
      />
    </div>
  );
}

/**
 * The task form template (PRODUCT_DESIGN_DIRECTION section 6.3): a sample booking with two sections, a field grid, a sticky summary of what the server states, a review before
 * it is sent, inline validation, a guard against leaving with what was typed, and a success toast with *Open* and *Book another*. Nothing is sent: the booking is a sample.
 */
export function TaskFormExample() {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [count, setCount] = useState('');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [reviewing, setReviewing] = useState(false);
  const [sent, setSent] = useState(false);
  const dirty = !sent && (name !== '' || phone !== '' || count !== '');

  const problems = (): Record<string, string> => {
    const found: Record<string, string> = {};
    if (name.trim() === '') found.name = 'Enter the sender’s name.';
    if (phone.trim() === '') found.phone = 'Enter a phone number.';
    if (!/^[1-9]\d{0,2}$/.test(count)) found.count = 'Enter how many packages, from 1 to 999.';
    return found;
  };

  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const found = problems();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    if (!reviewing) {
      setReviewing(true);
      return;
    }
    setSent(true);
    setReviewing(false);
    announceTaskDone({
      id: 'sample-booking',
      message: 'Sample pickup booked.',
      open: () => undefined,
      another: {
        label: 'Book another',
        onClick: () => {
          setSent(false);
          setName('');
          setPhone('');
          setCount('');
        },
      },
    });
  }

  return (
    <TaskForm
      header={{
        title: 'Book a pickup',
        description: 'A sample booking: nothing here is sent to the server.',
      }}
      dirty={dirty}
      onSubmit={submit}
      summary={{
        title: 'What the server states',
        children: (
          <div className="showcase-kit-stack">
            <StatTile
              label="Indicative total"
              value="GH₵25.50"
              caption="An estimate, not a price"
            />
            <p className="showcase-kit-opened">
              A booking made after the hub’s cut-off waits for an Ops decision.
            </p>
          </div>
        ),
      }}
      review={{
        active: reviewing,
        onBack: () => {
          setReviewing(false);
        },
        children: (
          <>
            <DescriptionList
              items={[
                { label: 'Sender', value: name },
                { label: 'Phone', value: phone },
                { label: 'Packages', value: count },
              ]}
            />
            <p>The server confirms the day and the price when the booking is sent.</p>
          </>
        ),
      }}
      actions={
        <>
          <Button type="submit">{reviewing ? 'Book the pickup' : 'Review the booking'}</Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setName('');
              setPhone('');
              setCount('');
              setErrors({});
              setReviewing(false);
            }}
          >
            Clear the form
          </Button>
        </>
      }
    >
      <TaskFormSection
        title="The sender"
        description="Who the pickup is for, as they gave it on the call."
      >
        <Field label="Name" required {...(errors.name === undefined ? {} : { error: errors.name })}>
          <Input
            value={name}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        <Field
          label="Phone"
          required
          help="With the country code."
          {...(errors.phone === undefined ? {} : { error: errors.phone })}
        >
          <Input
            value={phone}
            inputMode="tel"
            autoComplete="off"
            onChange={(event) => {
              setPhone(event.target.value);
            }}
          />
        </Field>
      </TaskFormSection>
      <TaskFormSection title="What is collected">
        <Field
          label="Packages"
          required
          {...(errors.count === undefined ? {} : { error: errors.count })}
        >
          <Input
            value={count}
            inputMode="numeric"
            autoComplete="off"
            onChange={(event) => {
              setCount(event.target.value);
            }}
          />
        </Field>
        <TaskFormWide>
          <Field label="Landmark" help="Optional. Where the rider can find the sender.">
            <Input autoComplete="off" />
          </Field>
        </TaskFormWide>
      </TaskFormSection>
    </TaskForm>
  );
}

interface PoolRow {
  readonly id: string;
  readonly request: SampleRequest;
}

/**
 * The builder template (PRODUCT_DESIGN_DIRECTION section 6.4): a run put together from a pool, for one hub. The pool is on the left with a box on each row, the run on the right in
 * the order chosen, with its totals. One chosen row is flagged as no longer waiting (kept, never dropped), and sending the run shows a refusal on the first row it names. The
 * rows, the words and the refusal are samples.
 */
export function BuilderExample() {
  const pool = useMemo<readonly PoolRow[]>(
    () => sampleRequests(8).map((request) => ({ id: request.id, request })),
    [],
  );
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [refused, setRefused] = useState(false);
  const columns = useMemo<readonly DataColumn<PoolRow>[]>(
    () =>
      requestColumns(true).map((column): DataColumn<PoolRow> => ({
        ...column,
        cell: (row) => column.cell(row.request),
      })),
    [],
  );
  const items: BuilderRunItem[] = chosen.flatMap((id, index) => {
    const row = pool.find((candidate) => candidate.id === id);
    if (row === undefined) return [];
    const stale = row.request.state === 'CANCELLED';
    return [
      {
        id,
        code: row.request.code,
        title: row.request.sender_name ?? 'Sender not recorded',
        detail: serviceDateText(row.request.scheduled_service_date),
        ...(stale ? { stale: 'It is no longer waiting for a manifest.' } : {}),
        ...(refused && index === 0
          ? { refusal: 'Another manifest holds this request. Take it out and try again.' }
          : {}),
        remove: {
          label: `Remove ${row.request.code} from the choice`,
          onClick: () => {
            setChosen((current) => current.filter((each) => each !== id));
            setRefused(false);
          },
        },
      },
    ];
  });
  return (
    <Builder
      header={{
        title: 'Build a manifest',
        description:
          'Run for Accra Central. Choose confirmed pickups for one run, on one day. Nothing is made until you create the manifest.',
        breadcrumb: [{ label: 'Manifests', to: '/__showcase/kit/example-builder' }],
      }}
      dirty={chosen.length > 0}
      onSubmit={(event) => {
        event.preventDefault();
        setRefused(chosen.length > 0);
      }}
      setup={
        <Field label="Hub" help="A run is for one hub, and the pool is that hub’s.">
          <Input value="Accra Central" readOnly />
        </Field>
      }
      panes={{
        pool: {
          title: 'The pool of confirmed pickups',
          description:
            'The confirmed pickups of Accra Central that no manifest holds, as the server lists them.',
          children: (
            <DataTable<PoolRow>
              label="Confirmed pickups waiting for a manifest"
              columns={columns}
              rows={pool}
              rowId={(row) => row.id}
              density="two-line"
              selection={{
                selectedIds: chosen,
                onChange: (ids) => {
                  setChosen(ids);
                  setRefused(false);
                },
                selectLabel: (row) => `Choose ${row.request.code}`,
              }}
              card={(row) => requestCard(row.request)}
              maxHeight="26rem"
            />
          ),
        },
        run: {
          title: 'The run',
          summary:
            chosen.length === 0
              ? 'No request is chosen yet.'
              : `${String(chosen.length)} ${chosen.length === 1 ? 'request' : 'requests'} chosen.`,
          totals: [{ label: 'Stops chosen', value: String(chosen.length) }, { label: 'Distance' }],
          children: (
            <BuilderRunList
              label="The requests chosen, in order"
              items={items}
              emptyText="Choose requests from the pool to build the run."
            />
          ),
          actions: (
            <>
              <Button type="submit">Create the manifest</Button>
            </>
          ),
        },
      }}
    />
  );
}
