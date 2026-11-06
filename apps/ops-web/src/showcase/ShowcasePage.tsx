import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { PageHeader } from '../components/PageHeader';
import { Alert } from '../components/ui/alert/Alert';
import { AlertDialog } from '../components/ui/dialog/AlertDialog';
import { Dialog, DialogActions } from '../components/ui/dialog/Dialog';
import { SideMenu } from '../components/side-menu/SideMenu';
import { Button } from '../components/ui/button/Button';
import { Checkbox } from '../components/ui/checkbox/Checkbox';
import { CodeInput } from '../components/ui/code-input/CodeInput';
import { DatePicker } from '../components/ui/date-picker/DatePicker';
import { EmptyState } from '../components/ui/empty-state/EmptyState';
import { Field } from '../components/ui/field/Field';
import { Icon } from '../components/ui/icon/Icon';
import { ICON_NAMES } from '../components/ui/icon/icons';
import { IconButton } from '../components/ui/icon-button/IconButton';
import {
  ForbiddenState,
  type ForbiddenKind,
} from '../components/ui/forbidden-state/ForbiddenState';
import { fieldText, useSubmission } from '../components/ui/form/use-submission';
import { Input } from '../components/ui/input/Input';
import { Link } from '../components/ui/link/Link';
import { LoadingIndicator } from '../components/ui/loading/LoadingIndicator';
import { MoneyAmount } from '../components/ui/money/MoneyAmount';
import { OneTimeSecret } from '../components/ui/one-time-secret/OneTimeSecret';
import { PasswordInput } from '../components/ui/password-input/PasswordInput';
import { Picker, type PickerOption } from '../components/ui/picker/Picker';
import { CountBadge } from '../components/ui/count-badge/CountBadge';
import { QrCode } from '../components/ui/qr-code/QrCode';
import { QueueFilters, QueueTable } from '../components/ui/queue-table/QueueTable';
import { useQueuePaging } from '../components/ui/queue-table/use-queue-paging';
import { RadioGroup } from '../components/ui/radio/RadioGroup';
import { ReorderList, type ReorderItem } from '../components/ui/reorder-list/ReorderList';
import { ReasonConfirmationDialog } from '../components/ui/reason-confirmation/ReasonConfirmationDialog';
import { Select } from '../components/ui/select/Select';
import { Skeleton } from '../components/ui/skeleton/Skeleton';
import { StatusBadge, type StatusMap } from '../components/ui/status-badge/StatusBadge';
import { Table, type SortDirection, type TableColumn } from '../components/ui/table/Table';
import { Textarea } from '../components/ui/textarea/Textarea';
import { Timeline } from '../components/ui/timeline/Timeline';
import { useApiClient } from '../platform/api/api-client';
import { answerOf } from '../platform/api/api-response';
import { manualKeyOf } from '../platform/secrets/otpauth';
import { useTransientSecret } from '../platform/secrets/use-transient-secret';
import './showcase.css';

/**
 * The development-only component showcase (COMPONENT_PATTERNS section 27). It exists to look at the tokens and the
 * components in every state, and to give the browser tests real components to drive. Everything on it is synthetic
 * and says so; no production-looking data appears. Its code, its route and its styles are absent from the production
 * build, which test/build.test.ts proves. It is not a second specification of any component.
 */

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="showcase-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Buttons() {
  const [pressed, setPressed] = useState(0);
  return (
    <Section title="Buttons">
      <p>
        Primary action pressed <span>{pressed}</span> times.
      </p>
      <div className="showcase-row">
        <Button
          type="button"
          onClick={() => {
            setPressed((count) => count + 1);
          }}
        >
          Primary action
        </Button>
        <Button type="button" variant="secondary">
          Secondary action
        </Button>
        <Button type="button" variant="danger">
          Danger action
        </Button>
        <Button type="button" disabled>
          Disabled action
        </Button>
        <Button type="button" loading>
          Saving…
        </Button>
        <Button type="button" variant="secondary" loading>
          Saving…
        </Button>
      </div>
    </Section>
  );
}

function DemoForm() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [accepted, setAccepted] = useState(false);
  const [failures, setFailures] = useState(0);
  const form = useRef<HTMLFormElement>(null);

  // After a failed submit, focus goes to the first invalid field, which reads its error once (DESIGN_SYSTEM section 14).
  useEffect(() => {
    if (failures > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [failures]);

  return (
    <Section title="Form fields">
      <form
        ref={form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === '') {
            setAccepted(false);
            setError('Enter a demo name.');
            setFailures((count) => count + 1);
            return;
          }
          setError(undefined);
          setAccepted(true);
        }}
      >
        <Field label="Demo name" required help="Any text. Nothing is sent or stored." error={error}>
          <Input
            name="demo-name"
            autoComplete="off"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        <Field label="Demo read-only value">
          <Input readOnly defaultValue="Synthetic value" />
        </Field>
        <Field label="Demo disabled value">
          <Input disabled defaultValue="Synthetic value" />
        </Field>
        <Field label="Demo note" help="Any text, over several lines. Nothing is sent or stored.">
          <Textarea name="demo-note" />
        </Field>
        <Field label="Demo disabled note">
          <Textarea disabled defaultValue="Synthetic value" />
        </Field>
        <Field label="Demo choice" help="Any option. Nothing is sent or stored.">
          <Select name="demo-choice" defaultValue="">
            <option value="">Choose a demo option</option>
            <option value="a">Demo option A</option>
            <option value="b">Demo option B</option>
          </Select>
        </Field>
        <Field label="Demo disabled choice">
          <Select disabled defaultValue="a">
            <option value="a">Demo option A</option>
          </Select>
        </Field>
        <Button type="submit">Submit demo</Button>
      </form>
      {accepted ? (
        <Alert variant="success" announce>
          The demo form was accepted. Nothing was saved.
        </Alert>
      ) : null}
    </Section>
  );
}

/**
 * The date field (COMPONENT_PATTERNS section 22a) in every state a page gives it. The page holds the date as text and the demo shows it,
 * so a browser test can see exactly what a page would be given. Nothing is sent or stored.
 */
function DateDemo() {
  const [date, setDate] = useState<string | null>(null);
  const [limited, setLimited] = useState<string | null>('2026-10-12');
  const nothing = (): void => undefined;
  return (
    <Section title="Date field">
      <div className="showcase-stack">
        <Field label="Demo date" help="Day, month and year. Nothing is sent or stored." required>
          <DatePicker value={date} onChange={setDate} />
        </Field>
        <p>The page holds: {date ?? 'no date'}</p>
        <Field label="Demo date in a range" help="Only 5 to 20 October 2026 are offered.">
          <DatePicker
            value={limited}
            onChange={setLimited}
            minValue="2026-10-05"
            maxValue="2026-10-20"
          />
        </Field>
        <p>The page holds: {limited ?? 'no date'}</p>
        <Field label="Demo date with an error" error="This is a synthetic error message.">
          <DatePicker value="2026-10-12" onChange={nothing} />
        </Field>
        <Field label="Demo read-only date">
          <DatePicker value="2026-10-12" onChange={nothing} isReadOnly />
        </Field>
        <Field label="Demo empty read-only date">
          <DatePicker value={null} onChange={nothing} isReadOnly />
        </Field>
        <Field label="Demo disabled date">
          <DatePicker value="2026-10-12" onChange={nothing} isDisabled />
        </Field>
      </div>
    </Section>
  );
}

/**
 * A form built on `useSubmission`: validation with focus on the first invalid field, a pending state, and a second submit
 * that is ignored. The "work" is a timer; nothing is sent.
 */
function SubmissionDemo() {
  const [errors, setErrors] = useState<{ password?: string; code?: string }>({});
  const [accepted, setAccepted] = useState(0);
  const submission = useSubmission(async (form) => {
    const password = fieldText(form, 'password');
    const code = fieldText(form, 'code');
    const next = {
      ...(password === '' ? { password: 'Enter a demo password.' } : {}),
      ...(code.length !== 6 ? { code: 'Enter the six digits of the demo code.' } : {}),
    };
    setErrors(next);
    if (Object.keys(next).length > 0) return 'invalid';
    await new Promise((resolve) => setTimeout(resolve, 400));
    form.reset();
    setAccepted((count) => count + 1);
    return 'accepted';
  });

  return (
    <Section title="Password, code and submission">
      <form {...submission.formProps} aria-label="Demo sign-in">
        <Field
          label="Demo password"
          required
          help="Nothing is sent or stored."
          error={errors.password}
        >
          <PasswordInput name="password" autoComplete="new-password" />
        </Field>
        <Field label="Demo code" required help="Six digits." error={errors.code}>
          <CodeInput name="code" />
        </Field>
        <Checkbox
          name="remember"
          label="Demo remember this choice"
          help="A checkbox is off until the person turns it on. Nothing is sent or stored."
        />
        <Button type="submit" loading={submission.pending}>
          Submit sign-in demo
        </Button>
      </form>
      <p>
        Demo submissions accepted: <span>{accepted}</span>
      </p>
    </Section>
  );
}

/** A synthetic provisioning URI: a made-up key that enrols no real authenticator for anyone. */
const DEMO_URI =
  'otpauth://totp/Melarc:synthetic.demo?secret=DEMODEMODEMODEMO&issuer=Melarc&period=30';

/**
 * The one-time secret pieces together: a transient secret, shown as a QR code and as the key to type, and gone on
 * completion, on expiry, on navigation and when the page is hidden.
 */
function SecretDemo() {
  const secret = useTransientSecret<string>();
  const client = useApiClient();
  const [unanswered, setUnanswered] = useState(false);
  const key = secret.value === undefined ? undefined : manualKeyOf(secret.value);

  /**
   * The fixture of the late-answer browser tests (U02 of 23 October 2026, review of 24 October 2026): the same flow a screen that asks the
   * API for a secret uses (begin a flow, send with its signal, hold the answer only if the flow is still current), against the
   * enrolment operation with a made-up token. The tests answer the request themselves and hold the answer while the page changes; with
   * no API behind the development server the request simply fails and nothing is shown.
   */
  async function askTheServer(): Promise<void> {
    setUnanswered(false);
    const flow = secret.begin();
    try {
      const answer = answerOf(
        await client.POST('/auth/staff/setup/credential', {
          body: { setup_token: 'synthetic-demo-token', password: 'synthetic-demo-password' },
          signal: flow.signal,
        }),
      );
      const uri = answer.data.mfa_provisioning?.otpauth_uri;
      if (uri !== undefined) secret.hold(flow, uri, 60_000);
    } catch {
      // A page that has moved on is not told of a failure it no longer asked about.
      if (flow.current()) setUnanswered(true);
    }
  }

  return (
    <Section title="One-time secret and QR code">
      <p>A synthetic key that enrols nothing. It is held in memory only, for one minute.</p>
      <div className="showcase-row">
        <Button
          type="button"
          onClick={() => {
            // No request here: the demo key is made up. A screen that asks the API for a secret begins the flow first and sends the
            // request with its signal; the answer is held only if the flow is still current when it arrives.
            secret.hold(secret.begin(), DEMO_URI, 60_000);
          }}
        >
          Show demo setup key
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void askTheServer();
          }}
        >
          Ask the server for a demo setup key
        </Button>
        <Link to="/__showcase?step=2">Same page, next step</Link>
      </div>
      {secret.value !== undefined && key !== undefined ? (
        <section aria-label="Demo authenticator setup" className="showcase-stack">
          <QrCode payload={secret.value} label="Demo QR code" />
          <OneTimeSecret
            label="Demo setup key"
            secret={key}
            help="Type this key into an authenticator app if you cannot scan the code."
          />
          <div className="showcase-row">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                secret.clear();
              }}
            >
              Done with the demo key
            </Button>
          </div>
        </section>
      ) : null}
      {unanswered ? <Alert variant="danger">The demo server did not answer.</Alert> : null}
      {secret.status === 'expired' ? (
        <Alert variant="danger" announce>
          The demo setup key expired.
        </Alert>
      ) : null}
    </Section>
  );
}

/** A made-up enumeration: the badge knows no domain value, and the showcase uses none of the product's. */
type DemoState = 'OPEN' | 'HELD' | 'DONE' | 'LOST' | 'IDLE';

const DEMO_STATES: StatusMap<DemoState> = {
  OPEN: { tone: 'info', label: 'Demo open' },
  HELD: { tone: 'warning', label: 'Demo held' },
  DONE: { tone: 'success', label: 'Demo done' },
  LOST: { tone: 'danger', label: 'Demo lost' },
  IDLE: { tone: 'neutral', label: 'Demo idle' },
};

function StatusBadges() {
  return (
    <Section title="Status badges">
      <div className="showcase-row">
        {(Object.keys(DEMO_STATES) as DemoState[]).map((state) => (
          <StatusBadge key={state} status={state} map={DEMO_STATES} />
        ))}
        <StatusBadge status="NOT_IN_THE_MAP" map={DEMO_STATES} />
      </div>
    </Section>
  );
}

/** The count of a queue, as the menu and the landing draw it (task C1): on the page, and on the dark ground of the side menu. */
function CountBadges() {
  return (
    <Section title="Count badges">
      <div className="showcase-row">
        <span>
          Pickup requests <CountBadge count={5} meaning="waiting for confirmation" />
        </span>
        <span>
          Manifests <CountBadge count={0} meaning="in progress" />
        </span>
        <span>
          Staff <CountBadge count={12480} meaning="waiting for approval" />
        </span>
      </div>
      <div className="showcase-ink">
        <span className="showcase-ink__entry">
          Pickup requests{' '}
          <CountBadge count={5} meaning="waiting for confirmation" surface="shell" />
        </span>
        <span className="showcase-ink__entry">
          Manifests <CountBadge count={0} meaning="in progress" surface="shell" />
        </span>
      </div>
    </Section>
  );
}

const FORBIDDEN_KINDS: readonly ForbiddenKind[] = [
  'permission-missing',
  'insufficient-authority',
  'outside-hubs',
  'approval-required',
  'unavailable-here',
];

function ForbiddenStates() {
  return (
    <Section title="Forbidden states">
      <div className="showcase-stack">
        {FORBIDDEN_KINDS.map((kind) => (
          <ForbiddenState key={kind} kind={kind} permission="demo.permission.read" />
        ))}
      </div>
    </Section>
  );
}

function EmptyStates() {
  const [cleared, setCleared] = useState(false);
  return (
    <Section title="Empty states">
      <div className="showcase-stack">
        <EmptyState kind="none" heading="Nothing is waiting in the demo queue">
          The demo queue holds nothing, and that is the answer.
        </EmptyState>
        <EmptyState
          kind="filtered"
          heading="Nothing matches the demo filters"
          action={
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setCleared(true);
              }}
            >
              Clear the demo filters
            </Button>
          }
        >
          The demo filters hide everything the demo queue holds.
        </EmptyState>
        {cleared ? (
          <Alert variant="success" announce>
            The demo filters were cleared. Nothing was saved.
          </Alert>
        ) : null}
      </div>
    </Section>
  );
}

interface DemoRow {
  readonly id: string;
  readonly name: string;
  readonly state: DemoState;
  readonly parcels: number;
  readonly note: string;
}

const DEMO_ROWS: readonly DemoRow[] = [
  {
    id: '1',
    name: 'Demo row alpha',
    state: 'OPEN',
    parcels: 12,
    note: 'A synthetic note that is long enough to make the row wider than a narrow screen.',
  },
  { id: '2', name: 'Demo row beta', state: 'HELD', parcels: 3, note: 'Synthetic.' },
  { id: '3', name: 'Demo row gamma', state: 'DONE', parcels: 140, note: 'Synthetic.' },
  { id: '4', name: 'Demo row delta', state: 'LOST', parcels: 27, note: 'Synthetic.' },
  { id: '5', name: 'Demo row epsilon', state: 'IDLE', parcels: 0, note: 'Synthetic.' },
];

function DemoTable() {
  const [sort, setSort] = useState<{ column: string; direction: SortDirection } | undefined>(
    undefined,
  );
  const rows = useMemo(() => {
    if (sort === undefined) return DEMO_ROWS;
    const sign = sort.direction === 'ascending' ? 1 : -1;
    return DEMO_ROWS.toSorted((a, b) =>
      sort.column === 'parcels'
        ? sign * (a.parcels - b.parcels)
        : sign * a.name.localeCompare(b.name),
    );
  }, [sort]);
  const columns: readonly TableColumn<DemoRow>[] = [
    { key: 'name', header: 'Name', cell: (row) => row.name, rowHeader: true, sortable: true },
    {
      key: 'state',
      header: 'State',
      cell: (row) => <StatusBadge status={row.state} map={DEMO_STATES} />,
    },
    {
      key: 'parcels',
      header: 'Parcels',
      cell: (row) => String(row.parcels),
      numeric: true,
      sortable: true,
    },
    { key: 'note', header: 'Note', cell: (row) => row.note },
  ];
  return (
    <Section title="Table">
      <Table
        caption="Demo table"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        sort={{
          ...(sort === undefined ? {} : { current: sort }),
          onChange: (column, direction) => {
            setSort({ column, direction });
          },
        }}
      />
      <p>
        Demo order:{' '}
        <span>{sort === undefined ? 'as given' : `${sort.column} ${sort.direction}`}</span>
      </p>
    </Section>
  );
}

/** A choice of three, with nothing chosen until a person chooses (S1.19). */
function RadioDemo() {
  const [choice, setChoice] = useState<string | null>(null);
  return (
    <Section title="Radio group">
      <div className="showcase-stack">
        <RadioGroup
          legend="Demo question"
          name="demo-radio"
          required
          help="Nothing is chosen until you choose. Nothing is sent or stored."
          options={[
            { value: 'one', label: 'Demo choice one', help: 'What choosing one would do.' },
            { value: 'two', label: 'Demo choice two' },
            { value: 'three', label: 'Demo choice three' },
          ]}
          value={choice}
          onChange={setChoice}
        />
        <p>
          The demo page holds: <span>{choice ?? 'no choice'}</span>
        </p>
        <RadioGroup
          legend="Demo question with an error"
          name="demo-radio-error"
          error="This is a synthetic error message."
          options={[
            { value: 'a', label: 'Demo choice A' },
            { value: 'b', label: 'Demo choice B, not available here', disabled: true },
          ]}
          value={null}
          onChange={() => undefined}
        />
      </div>
    </Section>
  );
}

/** Amounts as the server sends them, in pesewas, shown in cedis (S1.19). */
function MoneyDemo() {
  return (
    <Section title="Money">
      <ul>
        {[0, 5, 2550, 125_000, 123_456_789].map((amount) => (
          <li key={amount}>
            <code>{amount}</code> pesewas: <MoneyAmount amountMinor={amount} currency="GHS" />
          </li>
        ))}
      </ul>
    </Section>
  );
}

const DEMO_SHOPS: readonly PickerOption[] = [
  { value: 'a', label: 'Demo shop alpha', description: 'Demo account A1' },
  { value: 'b', label: 'Demo shop beta', description: 'Demo account B2' },
  { value: 'c', label: 'Demo stall gamma' },
];

/** A searchable picker over a synthetic list held in the page; nothing is asked of a server (S1.19). */
function PickerDemo() {
  const [searched, setSearched] = useState<string | undefined>(undefined);
  const [chosen, setChosen] = useState<PickerOption | null>(null);
  const results =
    searched === undefined
      ? undefined
      : {
          status: 'success' as const,
          data: DEMO_SHOPS.filter((shop) =>
            shop.label.toLowerCase().includes(searched.toLowerCase()),
          ),
          error: null,
          isFetching: false,
          refetch: () => Promise.resolve(),
        };
  return (
    <Section title="Searchable picker">
      <Picker
        label="Demo shop"
        required
        searchLabel="Search demo shops by name"
        searchHelp="Try “shop”, “stall” or a name that is not there."
        searchAction="Search"
        onSearch={setSearched}
        results={results}
        noResults={<p>No demo shop matches. Try another name.</p>}
        value={chosen}
        onChange={setChosen}
        chooseAction="Choose"
        changeAction="Choose another demo shop"
      />
      <p>
        The demo page holds: <span>{chosen?.label ?? 'no shop'}</span>
      </p>
    </Section>
  );
}

const DEMO_QUEUE_PAGE = 2;

/** A paged, filtered queue over the demo rows, two to a page, with the pages held by token as a server would (S1.19). */
function QueueDemo() {
  const [state, setState] = useState<DemoState | ''>('');
  // Row selection (S1.25): off until the person asks for it, so that the queue is drawn as it always was; the choice is kept by the row's key,
  // so it survives a move to another page.
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const paging = useQueuePaging(state);
  const rows = DEMO_ROWS.filter((row) => state === '' || row.state === state);
  const start = (paging.page - 1) * DEMO_QUEUE_PAGE;
  const shown = rows.slice(start, start + DEMO_QUEUE_PAGE);
  const next = start + DEMO_QUEUE_PAGE < rows.length ? `demo-${String(paging.page + 1)}` : null;
  const columns: readonly TableColumn<DemoRow>[] = [
    { key: 'name', header: 'Name', cell: (row) => row.name, rowHeader: true },
    {
      key: 'state',
      header: 'State',
      cell: (row) => <StatusBadge status={row.state} map={DEMO_STATES} />,
    },
    { key: 'parcels', header: 'Parcels', cell: (row) => String(row.parcels), numeric: true },
  ];
  return (
    <Section title="Queue table">
      <QueueFilters label="Filter the demo queue">
        <Field label="Demo state">
          <Select
            value={state}
            onChange={(event) => {
              const value = (Object.keys(DEMO_STATES) as DemoState[]).find(
                (key) => key === event.target.value,
              );
              setState(value ?? '');
            }}
          >
            <option value="">Every demo state</option>
            {(Object.keys(DEMO_STATES) as DemoState[]).map((key) => (
              <option key={key} value={key}>
                {DEMO_STATES[key].label}
              </option>
            ))}
          </Select>
        </Field>
      </QueueFilters>
      <Checkbox
        label="Choose demo rows"
        help="Turns on a box for each demo row; the choice is kept as you move between pages."
        checked={choosing}
        onChange={(event) => {
          setChoosing(event.target.checked);
        }}
      />
      {choosing ? (
        <p role="status">
          {`${String(chosen.size)} demo ${chosen.size === 1 ? 'row' : 'rows'} chosen.`}
        </p>
      ) : null}
      {shown.length === 0 ? (
        <EmptyState
          kind="filtered"
          heading="Nothing matches the demo state"
          action={
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setState('');
              }}
            >
              Show every demo row
            </Button>
          }
        >
          The demo filter hides every demo row.
        </EmptyState>
      ) : (
        <QueueTable
          caption="Demo queue"
          columns={columns}
          rows={shown}
          rowKey={(row) => row.id}
          noun={{ one: 'demo row', other: 'demo rows' }}
          paging={paging}
          nextPageToken={next}
          {...(choosing
            ? {
                selection: {
                  selected: chosen,
                  rowLabel: (row: DemoRow) => `Choose ${row.name}`,
                  onToggle: (row: DemoRow, ticked: boolean) => {
                    setChosen((current) => {
                      const next2 = new Set(current);
                      if (ticked) next2.add(row.id);
                      else next2.delete(row.id);
                      return next2;
                    });
                  },
                },
              }
            : {})}
        />
      )}
    </Section>
  );
}

const DEMO_STOPS: readonly (ReorderItem & { readonly line: string })[] = [
  { id: 's1', label: 'Demo stop alpha', line: 'Demo stop alpha · 14 Demo Lane', content: null },
  { id: 's2', label: 'Demo stop beta', line: 'Demo stop beta · 2 Demo Close', content: null },
  {
    id: 's3',
    label: 'Demo stop gamma',
    line: 'Demo stop gamma · 9 Demo Street',
    content: null,
    fixed: true,
    fixedNote: 'Cancelled with its request: it keeps its place.',
  },
  { id: 's4', label: 'Demo stop delta', line: 'Demo stop delta · 5 Demo Road', content: null },
];

/** The stop-reordering control over four demo stops, one of which keeps its place (S1.25). Nothing is asked of a server. */
function ReorderDemo() {
  const [order, setOrder] = useState<readonly string[]>(DEMO_STOPS.map((item) => item.id));
  const items = order.flatMap((id) => {
    const found = DEMO_STOPS.find((item) => item.id === id);
    return found === undefined ? [] : [{ ...found, content: <p>{found.line}</p> }];
  });
  return (
    <Section title="Reorder list">
      <ReorderList label="Demo stops" items={items} onChange={setOrder} />
      <p>
        The demo page holds the order:{' '}
        <span>
          {order.map((id) => DEMO_STOPS.find((item) => item.id === id)?.label ?? id).join(', ')}
        </span>
      </p>
    </Section>
  );
}

const DEMO_RIDERS: readonly PickerOption[] = [
  { value: 'r1', label: 'Demo rider Ama', description: '+233 20 000 0001' },
  { value: 'r2', label: 'Demo rider Kofi', description: '+233 20 000 0002 · no registered device' },
  { value: 'r3', label: 'Demo rider Esi', description: '+233 20 000 0003 · no PIN set' },
];

/**
 * The rider picker as the manifest screens use it (S1.25): the searchable picker over the active riders of one hub, listed at once and narrowed
 * by name, each told by the facts a roster returns. The list is held in the page; nothing is asked of a server.
 */
function RiderPickerDemo() {
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<PickerOption | null>(null);
  const results = {
    status: 'success' as const,
    data: DEMO_RIDERS.filter((rider) => rider.label.toLowerCase().includes(search.toLowerCase())),
    error: null,
    isFetching: false,
    refetch: () => Promise.resolve(),
  };
  return (
    <Section title="Rider picker">
      <Picker
        label="Demo rider"
        required
        searchLabel="Search demo riders by name or phone"
        searchHelp="Leave it empty to list the demo riders."
        searchAction="Search riders"
        onSearch={setSearch}
        results={results}
        noResults={<p>No demo rider matches. Try another name.</p>}
        value={chosen}
        onChange={setChosen}
        chooseAction="Choose"
        changeAction="Choose another demo rider"
      />
      <p>
        The demo page holds: <span>{chosen?.label ?? 'no rider'}</span>
      </p>
    </Section>
  );
}

/** Three demo attempts, the second the one the page is about (S1.19). */
function TimelineDemo() {
  return (
    <Section title="Timeline">
      <Timeline
        label="Demo attempts, oldest first"
        currentLabel="(the demo step shown)"
        entries={[
          {
            key: 'one',
            title: <Link to="/__showcase">Demo attempt 1</Link>,
            details: <p>Demo cancelled, for a demo date</p>,
          },
          {
            key: 'two',
            title: 'Demo attempt 2',
            details: <p>Demo confirmed, for a demo date</p>,
            current: true,
          },
          {
            key: 'three',
            title: <Link to="/__showcase">Demo attempt 3</Link>,
            details: <p>Demo waiting, for a demo date</p>,
          },
        ]}
      />
    </Section>
  );
}

/** The identifier of the made-up record the confirmation demos act on. Nothing is behind it. */
const DEMO_ID = '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d';

type DemoOpen = 'dialog' | 'dated' | 'confirmation' | 'reasoned' | 'keyed' | undefined;

/**
 * The dialogs (S0.41): a plain dialog, an alert dialog, and the reason and confirmation workflow in both of its modes. The two workflow demos
 * call the real client against `/api/v1`, which the browser tests answer themselves; with no API behind the development server the calls simply
 * fail, which is the unknown outcome the workflow exists for.
 */
function DialogDemos() {
  const client = useApiClient();
  const [open, setOpen] = useState<DemoOpen>(undefined);
  const [outcome, setOutcome] = useState('none yet');
  const [reloads, setReloads] = useState(0);
  const [datedValue, setDatedValue] = useState<string | null>(null);
  const close = () => {
    setOpen(undefined);
  };

  return (
    <Section title="Dialogs">
      <div className="showcase-row">
        {(
          [
            ['dialog', 'Open the demo dialog'],
            ['dated', 'Open the demo date dialog'],
            ['confirmation', 'Open the demo confirmation'],
            ['reasoned', 'Open the demo reason confirmation'],
            ['keyed', 'Open the demo keyed confirmation'],
          ] as const
        ).map(([which, label]) => (
          <Button
            key={which}
            type="button"
            variant="secondary"
            onClick={() => {
              setOpen(which);
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <p>
        Demo confirmation answered: <span>{outcome}</span>.
      </p>
      <p>
        Demo record reloaded: <span>{reloads}</span>.
      </p>

      <Dialog
        open={open === 'dialog'}
        title="Demo dialog"
        description="A made-up dialog. Nothing in it is saved."
        onRequestClose={close}
      >
        <Field label="Demo dialog field">
          <Input name="demo-dialog-field" autoComplete="off" />
        </Field>
        <DialogActions>
          <Button type="button" variant="secondary" onClick={close}>
            Close the demo dialog
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={open === 'dated'}
        title="Demo dialog with a date"
        description="A made-up dialog with a date field in it. Nothing in it is saved."
        onRequestClose={close}
      >
        <Field label="Demo date in a dialog">
          <DatePicker value={datedValue} onChange={setDatedValue} />
        </Field>
        <p>The dialog holds: {datedValue ?? 'no date'}</p>
        <DialogActions>
          <Button type="button" variant="secondary" onClick={close}>
            Close the demo date dialog
          </Button>
        </DialogActions>
      </Dialog>

      <AlertDialog
        open={open === 'confirmation'}
        title="End this demo session?"
        confirmLabel="End the demo session"
        onCancel={() => {
          setOutcome('cancelled');
          close();
        }}
        onConfirm={() => {
          setOutcome('confirmed');
          close();
        }}
      >
        <p>The demo person is signed out of every browser. This cannot be undone.</p>
      </AlertDialog>

      <ReasonConfirmationDialog<string>
        open={open === 'reasoned'}
        title="Reset this demo person’s second factor?"
        consequence={<p>Every session of this demo person ends. This cannot be undone.</p>}
        confirmLabel="Reset the second factor"
        operation="resetStaffMfa"
        branch="FACTOR_ACTIVE"
        version={'"demo-version-1"'}
        send={async (command) =>
          answerOf(
            await client.POST('/ops/staff/{id}/mfa/reset', {
              params: { path: { id: DEMO_ID }, header: { 'If-Match': command.version ?? '' } },
              body: {
                reason_code: command.reasonCode,
                ...(command.note === undefined ? {} : { note: command.note }),
              },
            }),
          ).status.toString()
        }
        onDone={() => {
          setOutcome('done');
          close();
        }}
        onCancel={() => {
          setOutcome('cancelled');
          close();
        }}
        onReload={() => {
          setReloads((count) => count + 1);
        }}
      />

      <ReasonConfirmationDialog<string>
        open={open === 'keyed'}
        title="Skip this demo stop?"
        consequence={
          <p>
            A stand-in for a command that takes an Idempotency-Key, so that a retry can be shown.
            The reasons are the demo&apos;s, not the stop&apos;s.
          </p>
        }
        confirmLabel="Skip the demo stop"
        operation="revokeSession"
        version={'"demo-version-1"'}
        retryable
        send={async (command, key) =>
          answerOf(
            await client.POST('/pickup-stops/{id}/skip', {
              params: {
                path: { id: DEMO_ID },
                header: { 'Idempotency-Key': key, 'If-Match': command.version ?? '' },
              },
              body: {
                reason_code: command.reasonCode,
                ...(command.note === undefined ? {} : { note: command.note }),
              },
            }),
          ).status.toString()
        }
        onDone={() => {
          setOutcome('done');
          close();
        }}
        onCancel={() => {
          setOutcome('cancelled');
          close();
        }}
        onReload={() => {
          setReloads((count) => count + 1);
        }}
      />
    </Section>
  );
}

/** Made-up entries for the side menu, so that it can be looked at, collapsed and slid in: they go nowhere. */
const DEMO_MENU_ITEMS = [
  ['Demo overview', 'overview'],
  ['Demo staff', 'staff'],
  ['Demo add a profile', 'add-staff'],
  ['Demo sessions', 'sessions'],
] as const;

const DEMO_MENU = DEMO_MENU_ITEMS.map(([label, icon], index) => ({
  to: index === 0 ? '/__showcase' : `/__showcase/demo-${String(index)}`,
  label,
  icon,
}));

function SideMenuDemo() {
  return (
    <Section title="Side menu">
      <p>
        The menu of the authenticated shell, with entries that go nowhere. It collapses to its
        icons, and slides in on a narrow screen.
      </p>
      <div className="showcase-side-menu">
        <SideMenu
          items={DEMO_MENU}
          account={{ name: 'Demo Person', detail: 'Demo hub' }}
          signingOut={false}
          onSignOut={() => undefined}
        />
      </div>
    </Section>
  );
}

/** Every icon of the one family, by the meaning it has in the application, at the three sizes it has. */
function IconsDemo() {
  return (
    <Section title="Icons">
      <p>
        The icons of the design system: one family, one stroke, three sizes. Each is named by its
        meaning.
      </p>
      <ul className="showcase-icons">
        {ICON_NAMES.map((name) => (
          <li key={name}>
            <Icon name={name} size="lg" />
            <Icon name={name} />
            <Icon name={name} size="sm" />
            <code>{name}</code>
          </li>
        ))}
      </ul>
      <p>
        <IconButton type="button" icon="menu" label="Demo icon button" />{' '}
        <IconButton type="button" icon="close" label="Demo icon button, loading" loading />
      </p>
    </Section>
  );
}

function Surface({ name, className }: { readonly name: string; readonly className: string }) {
  return (
    <div className={`showcase-surface ${className}`}>
      <h3>{name}</h3>
      <p>Primary text on this surface.</p>
      <p className="showcase-secondary">Secondary text on this surface.</p>
      <p>
        <Link to="/">A link on this surface</Link>
      </p>
      <Input aria-label={`Demo input on ${name}`} defaultValue="Synthetic value" />
    </div>
  );
}

/** The route's page. The showcase sits inside the neutral frame like any other page. */
export function ShowcasePage() {
  return (
    <>
      <title>Component showcase · Melarc Ops Portal</title>
      <PageHeader
        title="Component showcase"
        description="Development only. Every example here is synthetic and none of it is product data."
        actions={
          <Button type="button" variant="secondary">
            Demo page action
          </Button>
        }
      />
      <Buttons />
      <Section title="Links">
        <p>
          A link sits inside a sentence, as in <Link to="/">go to the start page</Link>, and is
          underlined so that colour does not carry it alone.
        </p>
      </Section>
      <Section title="Alerts">
        <div className="showcase-stack">
          <Alert variant="danger" title="Demo error">
            This is a synthetic error message with an icon and words.
          </Alert>
          <Alert variant="danger" action={<Link to="/">Go to the start page</Link>}>
            A synthetic error with an action after the message.
          </Alert>
          <Alert variant="success" title="Demo success">
            This is a synthetic success message with an icon and words.
          </Alert>
        </div>
      </Section>
      <DemoForm />
      <DateDemo />
      <SubmissionDemo />
      <SecretDemo />
      <Section title="Loading">
        <div className="showcase-row">
          <LoadingIndicator />
          <LoadingIndicator spinner={false} label="Still waiting…" />
        </div>
        <LoadingIndicator label="Loading the demo table…" />
        <Skeleton lines={4} />
      </Section>
      <StatusBadges />
      <CountBadges />
      <EmptyStates />
      <ForbiddenStates />
      <DemoTable />
      <QueueDemo />
      <RadioDemo />
      <MoneyDemo />
      <PickerDemo />
      <RiderPickerDemo />
      <ReorderDemo />
      <TimelineDemo />
      <DialogDemos />
      <SideMenuDemo />
      <IconsDemo />
      <Section title="Surfaces">
        <div className="showcase-surfaces">
          <Surface name="The page surface" className="showcase-surface--page" />
          <Surface name="The default surface" className="showcase-surface--default" />
          <Surface name="The subtle surface" className="showcase-surface--subtle" />
          <Surface name="The selected surface" className="showcase-surface--selected" />
        </div>
      </Section>
    </>
  );
}
