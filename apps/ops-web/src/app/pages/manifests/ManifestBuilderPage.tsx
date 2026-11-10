import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import { OperationalCode } from '../../../components/ui/code/OperationalCode';
import { DatePicker } from '../../../components/ui/date-picker/DatePicker';
import { AlertDialog } from '../../../components/ui/dialog/AlertDialog';
import {
  CellLines,
  DataTable,
  NoWrap,
  RowTitle,
  type DataColumn,
  type DataTableHandle,
} from '../../../components/ui/data-table/DataTable';
import { EmptyStateV2 } from '../../../components/ui/empty-state/EmptyStateV2';
import { Field } from '../../../components/ui/field/Field';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Input } from '../../../components/ui/input/Input';
import { Link } from '../../../components/ui/link/Link';
import { useQueuePaging } from '../../../components/ui/queue-table/use-queue-paging';
import { CommandOutcomeNotice } from '../../../components/ui/reason-confirmation/command-outcome';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Select } from '../../../components/ui/select/Select';
import {
  Builder,
  BuilderRunList,
  type BuilderRunItem,
} from '../../../components/ui/templates/Builder';
import { FreshnessLine } from '../../../components/ui/page-header/PageHeader';
import { QueuePager } from '../../../components/ui/templates/QueuePager';
import { useApiClient } from '../../../platform/api/api-client';
import type { Violation } from '../../../platform/api/api-response';
import { useConfirmedCommand } from '../../../platform/api/use-confirmed-command';
import { useActiveHub } from '../../../platform/hub/active-hub';
import {
  createPickupManifest,
  type ManifestRecord,
  type NewManifest,
} from '../../../platform/manifest/manifest-commands';
import { MAX_STOPS } from '../../../platform/manifest/manifest-shape';
import { calendarDateOf, type PickupRequestView } from '../../../platform/pickup/pickup-shape';
import { usePickupReasons, usePickupRequests } from '../../../platform/pickup/use-pickup-queries';
import { refusalText } from '../../../platform/problem/capability-words';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { hubNameOf } from '../staff/staff-presentation';
import { creationRuleWords } from './manifest-presentation';
import { packagesText, serviceDateText } from '../pickup/pickup-presentation';
import '../pickup/pickup-pages.css';
import './manifests-pages.css';

/** What the builder keeps of a request once it is chosen: enough to name it in the review, and the day it was promised. */
interface Chosen {
  readonly id: string;
  readonly code: string;
  readonly sender: string;
  readonly address: string;
  readonly promised: string;
}

interface CarryoverEntry {
  readonly reasonCode: string;
  readonly note: string;
}

/**
 * **The hub the run is for** (audit R4-12, decided by the Product Owner on 7 November 2026). A run is for one hub, so the page holds the hub as its own
 * state: it starts as the hub of the switcher (or the only hub of the session) and follows the switcher while no request is chosen; it is asked for
 * when the switcher is on *All hubs* and the session reaches several, because the pool of two hubs is never one run's; and it is never changed
 * under a choice without asking, because the requests chosen for one hub are not the next hub's.
 */
interface RunHub {
  /** The hub the run is for, or nothing while a session of several hubs has not said which. */
  readonly hubId: string | undefined;
  /** The hub of the switcher the page last answered to, so that each move of the switcher is answered once. */
  readonly seen: string | undefined;
  /** The hub the run is proposed to change to while requests are chosen, awaiting the person's answer: the choice would be cleared. */
  readonly proposal: string | undefined;
}

const NO_HUBS: readonly { readonly id: string; readonly display_name: string }[] = [];

const NOT_RECORDED = 'Not recorded';
/** What the pool says under the day of a request that was promised for an earlier day than the run's. */
const CARRIED_OVER = 'Carried over: promised for an earlier day';
/**
 * A session that lists no hub has nothing to choose and nothing to build a run from (task R5.2, M15b: it was told "Choose the hub first" with nothing to choose). The
 * words name no role and no permission, as the portal's refusals do; they are provisional copy for the Product Owner to approve.
 */
const NO_HUB_DESCRIPTION =
  'A run is for one hub, and your session lists none, so there is nothing to build here.';
const NO_HUB_NOTE =
  'Your session lists no hub, so there is nothing to build a run from: a pickup run is made for one hub.';

/** What the page says of the limit of a manifest, beside the review once the choice is as large as a manifest holds. */
const AT_MOST_STOPS = `A pickup run holds at most ${String(MAX_STOPS)} requests; use another pickup run for the rest.`;

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

const chosenOf = (request: PickupRequestView): Chosen => ({
  id: request.id,
  code: request.code,
  sender: request.sender_name ?? NOT_RECORDED,
  address: request.resolved_pickup_location?.address ?? NOT_RECORDED,
  promised: request.scheduled_service_date,
});

/**
 * Whether a date the date field gave is one a person has finished typing. The field gives each whole date on the way to the one meant (the year
 * 2, then 20, then 202, then 2026); a year of fewer than four figures is one still being typed.
 */
const isFinishedDate = (date: string | null): date is string =>
  date !== null && calendarDateOf(date) !== undefined && Number(date.slice(0, 4)) >= 1000;

/**
 * The pool's columns: **none is marked lesser** (nothing stands beside the pool that shows what a request holds, since the run lists only what was chosen, so the pool is where an officer reads the
 * promised day, the address and the count to choose by; this list marks nothing, and its table has nothing to take away). The columns wrap what is long; where the pool's own box is under 40rem
 * it is the cards, with every fact.
 */
const POOL_COLUMNS = (
  isCarriedOver: (promised: string) => boolean,
  hubs: readonly { readonly id: string; readonly display_name: string }[],
): readonly DataColumn<PickupRequestView>[] => [
  {
    id: 'request',
    header: 'Request / sender',
    rowHeader: true,
    cell: (row) => <RowTitle code={row.code} name={row.sender_name ?? NOT_RECORDED} />,
  },
  {
    id: 'promised',
    header: 'Promised for',
    cell: (row) => {
      const promised = <NoWrap>{serviceDateText(row.scheduled_service_date)}</NoWrap>;
      return isCarriedOver(row.scheduled_service_date) ? (
        <CellLines first={promised} second={CARRIED_OVER} />
      ) : (
        promised
      );
    },
  },
  {
    id: 'where',
    header: 'Pickup address / hub',
    cell: (row) => (
      <CellLines
        first={row.resolved_pickup_location?.address ?? NOT_RECORDED}
        second={hubNameOf(row.responsible_hub_id, hubs)}
      />
    ),
  },
  {
    id: 'packages',
    header: 'Packages',
    cell: (row) => <NoWrap>{packagesText(row)}</NoWrap>,
  },
];

/**
 * A request of the pool as a card, for a pool too narrow for the columns: the sender, and every fact of the row, each a label and its value (`CardFacts`). The table draws the card's one control
 * (the box that chooses it), so the card holds none.
 */
function PoolCard({
  request,
  carriedOver,
  hubs,
}: {
  readonly request: PickupRequestView;
  readonly carriedOver: boolean;
  readonly hubs: readonly { readonly id: string; readonly display_name: string }[];
}) {
  const promised = serviceDateText(request.scheduled_service_date);
  return (
    <CardFacts
      lead={request.sender_name ?? NOT_RECORDED}
      facts={[
        {
          label: 'Promised for',
          value: carriedOver ? <CellLines first={promised} second={CARRIED_OVER} /> : promised,
        },
        {
          label: 'Pickup address / hub',
          value: (
            <CellLines
              first={request.resolved_pickup_location?.address ?? NOT_RECORDED}
              second={hubNameOf(request.responsible_hub_id, hubs)}
            />
          ),
        },
        { label: 'Packages', value: packagesText(request) },
      ]}
    />
  );
}

/** The places the server named in a refusal, as the officer reads them: by the request or the day, and never by a position. */
interface Marks {
  readonly requests: ReadonlyMap<string, string>;
  readonly carryover: ReadonlyMap<string, string>;
  readonly date: string | undefined;
}

function marksOf(
  violations: readonly Violation[],
  sentIds: readonly string[],
  sentCarryover: readonly string[],
): Marks {
  const requests = new Map<string, string>();
  const carryover = new Map<string, string>();
  let date: string | undefined;
  for (const violation of violations) {
    const place = /^\/(pickup_request_ids|carryover)\/(\d+)$/.exec(violation.pointer);
    if (violation.pointer === '/service_date') date = creationRuleWords(violation.rule);
    else if (place?.[1] === 'pickup_request_ids') {
      const id = sentIds[Number(place[2])];
      if (id !== undefined && !requests.has(id))
        requests.set(id, creationRuleWords(violation.rule));
    } else if (place?.[1] === 'carryover') {
      const id = sentCarryover[Number(place[2])];
      if (id !== undefined && !carryover.has(id))
        carryover.set(id, creationRuleWords(violation.rule));
    }
  }
  return { requests, carryover, date };
}

/**
 * Build a pickup run (surfaces/ops-portal.md section 7, `/manifests/new`; S1.25): the pool of confirmed requests that no pickup run holds
 * (`listPickupRequests` with `state=CONFIRMED&manifested=false`, which the server narrows further: a request awaiting the review of its booking
 * cutoff is not in it), row selection across its pages, the day the run is worked, the carry-over reason of each overdue request, and a review
 * before the manifest is made (`createPickupManifest`, under an `Idempotency-Key`, one to 64 requests).
 *
 * **The server decides eligibility**: the pool is its list, a request chosen is only a request asked for, and every refusal (a request taken by
 * another officer meanwhile, a day that has passed, a promise that changed) comes back at the place of the request or the day and is told there,
 * with nothing created. A request promised for an earlier day than the run's is shown as carried over and asks for its reason, as the surface
 * document says; whether the day or the reason is acceptable is the server's.
 *
 * **A run is for one hub** (audit R4-12, decided by the Product Owner on 7 November 2026; `AC-HUBF-09`): the pool is that hub's, the description of the
 * page says "Run for <hub>", and no request of another hub can be chosen, so a mixed choice can never be made or sent. The hub is the switcher's when one
 * is chosen, the only hub of a session that reaches one, and asked for first when the switcher is on *All hubs* and the session reaches several. A move
 * of the switcher with nothing chosen carries the run to the new hub; with requests chosen the run stays and the person is asked, because the choice
 * would be cleared.
 */
export function ManifestBuilderPage() {
  const client = useApiClient();
  const me = useSignedInSession();
  const navigate = useNavigate();
  const hubs = me?.session.authorized_hubs ?? NO_HUBS;
  const switcherHubId = useActiveHub();
  // Every request chosen in this visit, from across the pages of the pool. All of them are the hub of the run's: the choice is cleared, after
  // asking, when the run changes hub, so a run of the requests of two hubs can never be made or sent (all the stops of a run belong to the
  // manifest's hub: features/pickup/pickup-manifest.md).
  const [chosen, setChosen] = useState<ReadonlyMap<string, Chosen>>(new Map());
  const [run, setRun] = useState<RunHub>({
    hubId: switcherHubId,
    seen: switcherHubId,
    proposal: undefined,
  });
  const onlyHubId = hubs.length === 1 ? hubs[0]?.id : undefined;
  const runHubId = hubs.some((hub) => hub.id === run.hubId) ? run.hubId : onlyHubId;
  const runHub = hubs.find((hub) => hub.id === runHubId);
  if (run.seen !== switcherHubId) {
    // The switcher moved (state adjusted while rendering, the way React keeps state in step with what it is given): with nothing chosen the run
    // follows it to the new hub; with requests chosen the run stays as it is and the person is asked, because the choice would be cleared.
    setRun({
      hubId: switcherHubId !== undefined && chosen.size === 0 ? switcherHubId : run.hubId,
      seen: switcherHubId,
      proposal:
        switcherHubId !== undefined && chosen.size > 0 && switcherHubId !== runHubId
          ? switcherHubId
          : undefined,
    });
  }
  // The pool is the pool of the hub of the run, and another hub starts again at its first page.
  const paging = useQueuePaging(`pool|${runHubId ?? ''}`);
  const pool = usePickupRequests({
    state: 'CONFIRMED',
    manifested: false,
    ...(runHubId === undefined ? {} : { hubId: runHubId }),
    ...(paging.pageToken === undefined ? {} : { pageToken: paging.pageToken }),
    enabled: me !== undefined && runHubId !== undefined,
  });
  const hubField = useRef<HTMLDivElement>(null);
  const [serviceDate, setServiceDate] = useState<string | null>(null);
  const [carryover, setCarryover] = useState<ReadonlyMap<string, CarryoverEntry>>(new Map());
  const [invalid, setInvalid] = useState<{
    readonly date?: string;
    readonly none?: string;
    readonly carryover: ReadonlyMap<string, string>;
  }>({ carryover: new Map() });
  const [attempts, setAttempts] = useState(0);
  const [sent, setSent] = useState<{ ids: readonly string[]; carryover: readonly string[] }>({
    ids: [],
    carryover: [],
  });
  const form = useRef<HTMLFormElement>(null);
  const poolTable = useRef<DataTableHandle>(null);

  const day = isFinishedDate(serviceDate) ? serviceDate : undefined;
  const isCarriedOver = (promised: string): boolean => day !== undefined && promised < day;
  const overdue = [...chosen.values()].filter((request) => isCarriedOver(request.promised));
  const reasons = usePickupReasons('PICKUP_CARRYOVER', overdue.length > 0);

  const [made, setMade] = useState<string | undefined>();
  useEffect(() => {
    if (made !== undefined) void navigate(`/manifests/${made}`, { state: { created: true } });
  }, [made, navigate]);
  const command = useConfirmedCommand<NewManifest, ManifestRecord>({
    send: (body, key) => createPickupManifest(client, body, key),
    // The manifest is made: the page follows it once the form no longer holds anything unsent (the guard against leaving is off by then), and not in the same breath.
    onDone: (record) => {
      setMade(record.manifest.id);
    },
    // The pool is read again: what the officer chose may have been taken, and what the server says is what the pool is.
    onReload: () => pool.refetch(),
    retryable: true,
    operation: 'createPickupManifest',
  });

  const refused = command.phase === 'refused' || command.phase === 'conflict';
  const violations = command.problem?.violations;
  const marks = useMemo(
    () => marksOf(refused ? (violations ?? []) : [], sent.ids, sent.carryover),
    [refused, violations, sent],
  );
  const recovering = command.phase === 'unknown' || command.phase === 'conflict';

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);
  useEffect(() => {
    if (command.phase === 'refused') focusFirstInvalid(form.current);
    if (recovering) form.current?.querySelector<HTMLElement>('[data-recovery]')?.focus();
  }, [command.phase, recovering]);

  // A move to another page leaves the pager button it was made from gone while the page loads: once it has been read, whatever it holds, focus goes to the results, once.
  const { takeFocus } = paging;
  const settled = !pool.isFetching && (pool.isSuccess || pool.isError);
  useEffect(() => {
    if (!settled || !takeFocus()) return;
    poolTable.current?.focusResults();
  }, [settled, pool.dataUpdatedAt, takeFocus]);

  if (me === undefined) return null;
  const locked = command.locked;
  const full = chosen.size >= MAX_STOPS;

  /** Chooses another hub for the run: at once when nothing is chosen, and when something is, after the person has been asked (the choice is cleared). */
  function chooseHub(hubId: string): void {
    if (hubId === '' || hubId === runHubId) return;
    if (chosen.size === 0) setRun({ ...run, hubId, proposal: undefined });
    else setRun({ ...run, proposal: hubId });
  }
  /** The answer *yes*: the run is for the proposed hub, and nothing chosen for the other is left. */
  function changeHub(): void {
    if (run.proposal === undefined) return;
    setChosen(new Map());
    setCarryover(new Map());
    setInvalid({ carryover: new Map() });
    setRun({ ...run, hubId: run.proposal, proposal: undefined });
    command.dismiss();
  }
  function keepHub(): void {
    setRun({ ...run, proposal: undefined });
  }

  function remove(id: string): void {
    setChosen((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
    // A request taken out of a choice that was too large is how a person makes it fit: what was said of the size is not left standing.
    setInvalid((current) => ({ ...current, none: undefined }));
    setCarryover((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
    command.dismiss();
  }
  function setEntry(id: string, patch: Partial<CarryoverEntry>): void {
    setCarryover((current) => {
      const next = new Map(current);
      next.set(id, { reasonCode: '', note: '', ...current.get(id), ...patch });
      return next;
    });
    setInvalid((current) => {
      const next = new Map(current.carryover);
      next.delete(id);
      return { ...current, carryover: next };
    });
    command.dismiss();
  }

  function submit(event: { preventDefault: () => void }): void {
    event.preventDefault();
    if (locked) return;
    const found = new Map<string, string>();
    for (const request of overdue) {
      const entry = carryover.get(request.id);
      const reason = reasons.data?.find((candidate) => candidate.code === entry?.reasonCode);
      if (reason === undefined) found.set(request.id, 'Choose why this request is carried over.');
      else if (reason.requiresNote && (entry?.note.trim() ?? '') === '') {
        found.set(request.id, 'This reason needs a note.');
      } else if (hasControlCharacter(entry?.note ?? '')) {
        found.set(request.id, 'The note must be one line.');
      }
    }
    const problems = {
      ...(chosen.size === 0 ? { none: 'Choose at least one request from the pool.' } : {}),
      ...(day === undefined ? { date: 'Choose the day the run is worked.' } : {}),
      carryover: found,
    };
    setInvalid(problems);
    if (chosen.size === 0 || day === undefined || found.size > 0) {
      setAttempts((count) => count + 1);
      return;
    }
    const ids = [...chosen.keys()];
    const entries = overdue.map((request) => {
      const entry = carryover.get(request.id);
      const note = entry?.note.trim() ?? '';
      return {
        pickup_request_id: request.id,
        reason_code: entry?.reasonCode ?? '',
        ...(note === '' ? {} : { note }),
      };
    });
    setSent({ ids, carryover: entries.map((entry) => entry.pickup_request_id) });
    void command.submit({
      pickup_request_ids: ids,
      service_date: day,
      ...(entries.length === 0 ? {} : { carryover: entries }),
    });
  }

  const dateError = invalid.date ?? marks.date;
  const poolColumnsOf = POOL_COLUMNS(isCarriedOver, me.session.authorized_hubs);
  const proposedHub = hubs.find((hub) => hub.id === run.proposal);

  /**
   * The rows ticked in the pool, as the table reports them (every id of the choice, from every page): what is new is read from the page now shown, and what is gone is taken out. A
   * ticked row can always be cleared; a row can be ticked while the run has room, and only the pool's own rows can be.
   */
  function choose(ids: readonly string[]): void {
    const wanted = new Set(ids);
    const items = pool.isSuccess ? pool.data.items : [];
    setChosen((current) => {
      const next = new Map<string, Chosen>();
      for (const [id, entry] of current) if (wanted.has(id)) next.set(id, entry);
      for (const id of ids) {
        if (next.has(id) || current.has(id)) continue;
        const request = items.find((candidate) => candidate.id === id);
        // A request of another hub is never chosen: the pool is the run's hub's, so this holds off a row that is not (a stale answer, a foreign one).
        if (
          request !== undefined &&
          request.responsible_hub_id === runHubId &&
          next.size < MAX_STOPS
        ) {
          next.set(id, chosenOf(request));
        }
      }
      return next;
    });
    setCarryover((current) => {
      const next = new Map(current);
      for (const id of current.keys()) if (!wanted.has(id)) next.delete(id);
      return next;
    });
    setInvalid((current) => ({ ...current, none: undefined }));
    command.dismiss();
  }

  const updatedAt =
    pool.dataUpdatedAt > 0 ? formatInstant(new Date(pool.dataUpdatedAt).toISOString()) : undefined;

  // What stands in the place of the pool's rows: loading, a failure in the page's words, or one of the three kinds of nothing.
  const poolLoading = pool.status === 'pending' || (pool.isFetching && pool.status === 'success');
  const poolProblem =
    pool.status === 'error'
      ? problemOf(pool.error, { operation: 'listPickupRequests', context: 'pool' })
      : undefined;
  const poolFailure =
    poolProblem === undefined ||
    poolProblem.kind === 'session-ended' ||
    poolProblem.kind === 'stale'
      ? undefined
      : {
          message:
            poolProblem.kind === 'forbidden'
              ? refusalText(poolProblem.forbidden, 'pickup.read', { of: 'pickup requests' })
              : poolProblem.reference === undefined
                ? poolProblem.message
                : `${poolProblem.message} Reference: ${poolProblem.reference}`,
          ...(poolProblem.kind === 'unavailable' || poolProblem.kind === 'rate-limited'
            ? {
                onRetry: () => {
                  void pool.refetch();
                },
              }
            : {}),
        };
  const poolRows = pool.isSuccess && !poolLoading ? pool.data.items : [];
  const poolEmpty =
    paging.page > 1 ? (
      <EmptyStateV2
        variant="filtered-empty"
        title="No requests on this page"
        headingLevel={3}
        announce
        action={
          <Button type="button" variant="secondary" onClick={paging.toFirstPage}>
            Back to first page
          </Button>
        }
      >
        {`Page ${String(paging.page)} has no requests now. Earlier pages may still have some.`}
      </EmptyStateV2>
    ) : hubs.length > 1 && runHub !== undefined ? (
      // The run's hub is a filter of the pool (audit B1): the pool of this hub is empty, which says nothing of the others, and a run is for one hub, so the way on is another hub and
      // never *All hubs*.
      <EmptyStateV2
        variant="filtered-empty"
        title={`Nothing at ${runHub.display_name}`}
        headingLevel={3}
        announce
        action={
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              hubField.current?.querySelector('select')?.focus();
            }}
          >
            Choose another hub
          </Button>
        }
      >
        {`No confirmed pickup at ${runHub.display_name} is waiting for a pickup run. A confirmed pickup appears here until a pickup run holds it. A run is for one hub: choose another hub to build one for it.`}
      </EmptyStateV2>
    ) : (
      <EmptyStateV2 variant="empty" title="The pool is empty" headingLevel={3}>
        No confirmed pickup is waiting for a pickup run. A confirmed pickup appears here until a
        pickup run holds it.
      </EmptyStateV2>
    );

  const items: BuilderRunItem[] = [...chosen.values()].map((request) => {
    const mark = marks.requests.get(request.id);
    return {
      id: request.id,
      code: request.code,
      title: request.sender,
      detail: request.address,
      ...(mark === undefined ? {} : { refusal: mark }),
      remove: {
        label: `Remove ${request.code} from the choice`,
        disabled: locked,
        onClick: () => {
          remove(request.id);
        },
      },
    };
  });
  return (
    <>
      <title>Build a pickup run · Melarc Ops Portal</title>
      <Builder
        header={{
          title: 'Build a pickup run',
          description:
            runHub === undefined
              ? hubs.length === 0
                ? NO_HUB_DESCRIPTION
                : 'Choose the hub of the run first, then confirmed pickups for it, on one day. Nothing is made until you create the pickup run.'
              : `Run for ${runHub.display_name}. Choose confirmed pickups for one run, on one day. Nothing is made until you create the pickup run.`,
          breadcrumb: [{ label: 'Pickup runs', to: '/manifests' }],
        }}
        formRef={form}
        busy={command.phase === 'sending'}
        dirty={made === undefined && (chosen.size > 0 || serviceDate !== null)}
        onSubmit={submit}
        alerts={
          <CommandOutcomeNotice
            command={command}
            unknownText={copyFor({ operation: 'createPickupManifest', context: 'unknown-outcome' })}
          />
        }
        setup={
          <>
            {hubs.length > 1 ? (
              <section className="pickup-form-section" aria-labelledby="builder-hub">
                <h2 id="builder-hub">The hub of the run</h2>
                <div ref={hubField}>
                  <Field
                    label="Hub"
                    required
                    help="A run is for one hub, and the pool below is that hub’s. Changing the hub clears the requests already chosen, after asking."
                  >
                    <Select
                      value={runHubId ?? ''}
                      disabled={locked}
                      onChange={(event) => {
                        chooseHub(event.target.value);
                      }}
                    >
                      {runHubId === undefined ? <option value="">Choose a hub</option> : null}
                      {hubs.map((hub) => (
                        <option key={hub.id} value={hub.id}>
                          {hub.display_name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </section>
            ) : null}
            {runHubId === undefined ? null : (
              <section className="pickup-form-section" aria-labelledby="builder-day">
                <h2 id="builder-day">The day of the run</h2>
                <Field
                  label="Service date"
                  required
                  help="The day the run is worked: Monday to Saturday, today or later. Pickups promised for an earlier day are carried over to it."
                  {...(dateError === undefined ? {} : { error: dateError })}
                >
                  <DatePicker
                    value={serviceDate}
                    isDisabled={locked}
                    onChange={(next) => {
                      setServiceDate(next);
                      setInvalid((current) => ({ ...current, date: undefined }));
                      command.dismiss();
                    }}
                  />
                </Field>
              </section>
            )}
          </>
        }
        {...(runHubId === undefined
          ? {
              note:
                hubs.length === 0
                  ? NO_HUB_NOTE
                  : 'Choose the hub first: the pool, the review and the pickup run are that hub’s.',
            }
          : {
              panes: {
                pool: {
                  title: 'The pool of confirmed pickups',
                  description: (
                    <>
                      These are the confirmed pickups of {runHub?.display_name} that no pickup run
                      holds. A pickup whose late booking waits for an Ops decision is not in it.
                      Choose up to {MAX_STOPS}; your choice is kept as you move between pages.
                      {invalid.none === undefined ? null : (
                        <span className="manifest-carryover__error" role="alert">
                          {` ${invalid.none}`}
                        </span>
                      )}
                    </>
                  ),
                  toolbar: (
                    <FreshnessLine
                      freshness={{
                        state: pool.isFetching ? 'refreshing' : pool.isError ? 'failed' : 'idle',
                        ...(updatedAt === undefined ? {} : { updatedAt }),
                        // While the pickup run is being made the pool is left as it is: a press is ignored, as one is while a read is under way.
                        onRefresh: () => {
                          if (!locked) void pool.refetch({ cancelRefetch: false });
                        },
                      }}
                    />
                  ),
                  children: (
                    <DataTable<PickupRequestView>
                      ref={poolTable}
                      label="Confirmed pickups waiting for a pickup run"
                      columns={poolColumnsOf}
                      rows={poolRows}
                      rowId={(row) => row.id}
                      density="two-line"
                      status={
                        poolLoading ? 'loading' : poolFailure === undefined ? 'ready' : 'error'
                      }
                      loadingLabel="Loading the pool"
                      {...(poolFailure === undefined ? {} : { error: poolFailure })}
                      emptyState={poolEmpty}
                      // The code is the heading of each card (under the pool’s own, so level 3), outside the card’s control, for heading navigation.
                      cardTitle={(row) => <OperationalCode>{row.code}</OperationalCode>}
                      cardHeadingLevel={3}
                      card={(row) => (
                        <PoolCard
                          request={row}
                          carriedOver={isCarriedOver(row.scheduled_service_date)}
                          hubs={hubs}
                        />
                      )}
                      selection={{
                        selectedIds: [...chosen.keys()],
                        onChange: choose,
                        selectLabel: (row) => `Choose ${row.code}`,
                        isSelectable: (row) => (chosen.has(row.id) ? !locked : !full && !locked),
                      }}
                      // The pager is in the page whatever the pool is doing, so that its status region is the same one while a page is read (the review of 499399c).
                      footer={
                        <QueuePager
                          label="Pages of the pool"
                          noun={{ one: 'request', other: 'requests' }}
                          shown={pool.isSuccess && !poolLoading ? poolRows.length : undefined}
                          page={paging.page}
                          hasNext={pool.isSuccess && pool.data.nextPageToken !== null}
                          onNext={() => {
                            if (pool.isSuccess && pool.data.nextPageToken !== null) {
                              paging.toNextPage(pool.data.nextPageToken);
                            }
                          }}
                          onPrevious={paging.toPreviousPage}
                        />
                      }
                    />
                  ),
                },
                run: {
                  title: 'Review',
                  summary:
                    chosen.size === 0
                      ? 'No request is chosen yet.'
                      : `${String(chosen.size)} ${chosen.size === 1 ? 'request' : 'requests'} chosen${
                          day === undefined ? '' : ` for ${serviceDateText(day)}`
                        }${overdue.length === 0 ? '' : `, ${String(overdue.length)} carried over`}.`,
                  children: (
                    <>
                      {chosen.size === 0 ? null : (
                        <p>
                          The stops take this order; you can change it after the pickup run is made,
                          until it is dispatched.
                        </p>
                      )}
                      {full ? <p className="manifest-support">{AT_MOST_STOPS}</p> : null}
                      <BuilderRunList
                        label="The requests chosen, in order"
                        items={items}
                        emptyText="Choose requests from the pool to build the run."
                      />
                      {overdue.length > 0 ? (
                        <section className="manifest-carryover" aria-labelledby="builder-carryover">
                          <h3 id="builder-carryover">Carried over from an earlier day</h3>
                          <p className="manifest-note">
                            These pickups were promised for an earlier day than the run’s. Each is
                            carried over for a reason you give for that pickup, and it keeps the day
                            it was promised, so it stays late against that promise.
                          </p>
                          <ReadState
                            query={reasons}
                            operation="listReasonDefinitions"
                            context="carryover"
                            permission="settings.reason.read"
                            loadingLabel="Loading the carry-over reasons…"
                            isEmpty={(list) => list.length === 0}
                            empty={
                              <Alert variant="danger">
                                <p>
                                  No carry-over reason is configured yet, so a pickup run holding a
                                  pickup from an earlier day cannot be made. The reasons are added
                                  to the reason catalogue by an administrator of the settings.
                                </p>
                              </Alert>
                            }
                          >
                            {(list) => (
                              <>
                                {overdue.map((request) => {
                                  const entry = carryover.get(request.id);
                                  const reason = list.find(
                                    (candidate) => candidate.code === entry?.reasonCode,
                                  );
                                  const error =
                                    invalid.carryover.get(request.id) ??
                                    marks.carryover.get(request.id);
                                  return (
                                    <div key={request.id} className="manifest-carryover__entry">
                                      <h4>{request.code}</h4>
                                      <p className="manifest-support">
                                        {`${request.sender}. Promised for ${serviceDateText(request.promised)}.`}
                                      </p>
                                      {error === undefined ? null : (
                                        <p className="manifest-carryover__error">{error}</p>
                                      )}
                                      <Field label="Why it is carried over" required>
                                        <Select
                                          name={`carryover-reason-${request.id}`}
                                          value={reason === undefined ? '' : reason.code}
                                          disabled={locked}
                                          onChange={(event) => {
                                            setEntry(request.id, {
                                              reasonCode: event.target.value,
                                            });
                                          }}
                                        >
                                          <option value="">Choose a reason</option>
                                          {list.map((candidate) => (
                                            <option key={candidate.code} value={candidate.code}>
                                              {candidate.label}
                                            </option>
                                          ))}
                                        </Select>
                                      </Field>
                                      <Field
                                        label="Note"
                                        required={reason?.requiresNote === true}
                                        help="One line, kept with the stop. Leave out phone numbers and email addresses."
                                      >
                                        <Input
                                          name={`carryover-note-${request.id}`}
                                          value={entry?.note ?? ''}
                                          autoComplete="off"
                                          readOnly={locked}
                                          onChange={(event) => {
                                            setEntry(request.id, { note: event.target.value });
                                          }}
                                        />
                                      </Field>
                                    </div>
                                  );
                                })}
                              </>
                            )}
                          </ReadState>
                        </section>
                      ) : null}
                    </>
                  ),
                  actions: (
                    <>
                      {recovering ? (
                        <Button
                          key="check"
                          type="button"
                          data-recovery
                          onClick={command.checkRecord}
                        >
                          {command.phase === 'conflict' ? 'Reload the pool' : 'Check the pool'}
                        </Button>
                      ) : (
                        <Button key="create" type="submit" loading={command.phase === 'sending'}>
                          Create the pickup run
                        </Button>
                      )}
                      {command.canRetry ? (
                        <Button
                          key="retry"
                          type="button"
                          onClick={() => {
                            void command.retry();
                          }}
                        >
                          Try again
                        </Button>
                      ) : null}
                      <Link to="/manifests">Cancel</Link>
                    </>
                  ),
                },
              },
            })}
        // Outside the form on purpose: a submit inside the dialog would otherwise reach the form's own, and make a manifest.
        outside={
          <AlertDialog
            open={proposedHub !== undefined && runHub !== undefined}
            title={`Make the run for ${proposedHub?.display_name ?? 'another hub'}?`}
            confirmLabel={`Make the run for ${proposedHub?.display_name ?? 'another hub'}`}
            cancelLabel={`Keep ${runHub?.display_name ?? 'this hub'}`}
            onConfirm={changeHub}
            onCancel={keepHub}
          >
            {`A run is for one hub. ${
              chosen.size === 1 ? 'The request' : `The ${String(chosen.size)} requests`
            } chosen for ${runHub?.display_name ?? 'this hub'} ${
              chosen.size === 1 ? 'is' : 'are'
            } taken out of the choice, with anything written for ${chosen.size === 1 ? 'it' : 'them'}, and the pool becomes ${
              proposedHub?.display_name ?? 'the other hub'
            }’s.`}
          </AlertDialog>
        }
      />
    </>
  );
}
