import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { PageHeader } from '../../../components/PageHeader';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { DatePicker } from '../../../components/ui/date-picker/DatePicker';
import { EmptyState } from '../../../components/ui/empty-state/EmptyState';
import { Field } from '../../../components/ui/field/Field';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Input } from '../../../components/ui/input/Input';
import { Link } from '../../../components/ui/link/Link';
import { QueuePanel, QueueTable } from '../../../components/ui/queue-table/QueueTable';
import { useQueuePaging } from '../../../components/ui/queue-table/use-queue-paging';
import { CommandOutcomeNotice } from '../../../components/ui/reason-confirmation/command-outcome';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Select } from '../../../components/ui/select/Select';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import type { TableColumn } from '../../../components/ui/table/Table';
import { useApiClient } from '../../../platform/api/api-client';
import type { Violation } from '../../../platform/api/api-response';
import { useConfirmedCommand } from '../../../platform/api/use-confirmed-command';
import {
  createPickupManifest,
  type ManifestRecord,
  type NewManifest,
} from '../../../platform/manifest/manifest-commands';
import { MAX_STOPS } from '../../../platform/manifest/manifest-shape';
import {
  calendarDateOf,
  type PickupRequestPageView,
  type PickupRequestView,
} from '../../../platform/pickup/pickup-shape';
import { usePickupReasons, usePickupRequests } from '../../../platform/pickup/use-pickup-queries';
import { copyFor } from '../../../platform/problem/problem-copy';
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

const NOT_RECORDED = 'Not recorded';

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

const POOL_COLUMNS = (
  isCarriedOver: (promised: string) => boolean,
  hubs: readonly { readonly id: string; readonly display_name: string }[],
): readonly TableColumn<PickupRequestView>[] => [
  {
    key: 'request',
    header: 'Request / sender',
    rowHeader: true,
    cell: (row) => (
      <span className="manifest-lines">
        <span className="manifest-nowrap">{row.code}</span>
        <span className="manifest-support">{row.sender_name ?? NOT_RECORDED}</span>
      </span>
    ),
  },
  {
    key: 'promised',
    header: 'Promised for',
    cell: (row) => (
      <span className="manifest-lines">
        <span className="manifest-nowrap">{serviceDateText(row.scheduled_service_date)}</span>
        {isCarriedOver(row.scheduled_service_date) ? (
          <span className="manifest-support">Carried over: promised for an earlier day</span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'where',
    header: 'Pickup address / hub',
    cell: (row) => (
      <span className="manifest-lines">
        <span>{row.resolved_pickup_location?.address ?? NOT_RECORDED}</span>
        <span className="manifest-support">{hubNameOf(row.responsible_hub_id, hubs)}</span>
      </span>
    ),
  },
  { key: 'packages', header: 'Packages', cell: (row) => packagesText(row) },
];

function PoolCard({
  request,
  carriedOver,
}: {
  readonly request: PickupRequestView;
  readonly carriedOver: boolean;
}) {
  return (
    <>
      <h2 className="manifest-card__title">{request.code}</h2>
      <p className="manifest-support">{request.sender_name ?? NOT_RECORDED}</p>
      <dl className="manifest-card__facts">
        <div className="manifest-card__fact">
          <dt>Promised for</dt>
          <dd>
            {serviceDateText(request.scheduled_service_date)}
            {carriedOver ? ' · Carried over: promised for an earlier day' : ''}
          </dd>
        </div>
        <div className="manifest-card__fact">
          <dt>Pickup address</dt>
          <dd>{request.resolved_pickup_location?.address ?? NOT_RECORDED}</dd>
        </div>
        <div className="manifest-card__fact">
          <dt>Packages</dt>
          <dd>{packagesText(request)}</dd>
        </div>
      </dl>
    </>
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
 * Build a manifest (surfaces/ops-portal.md section 7, `/manifests/new`; S1.25): the pool of confirmed requests that no manifest holds
 * (`listPickupRequests` with `state=CONFIRMED&manifested=false`, which the server narrows further: a request awaiting the review of its booking
 * cutoff is not in it), row selection across its pages, the day the run is worked, the carry-over reason of each overdue request, and a review
 * before the manifest is made (`createPickupManifest`, under an `Idempotency-Key`, one to 64 requests).
 *
 * **The server decides eligibility**: the pool is its list, a request chosen is only a request asked for, and every refusal (a request taken by
 * another officer meanwhile, a day that has passed, a promise that changed) comes back at the place of the request or the day and is told there,
 * with nothing created. A request promised for an earlier day than the run's is shown as carried over and asks for its reason, as the surface
 * document says; whether the day or the reason is acceptable is the server's.
 */
export function ManifestBuilderPage() {
  const client = useApiClient();
  const me = useSignedInSession();
  const navigate = useNavigate();
  const paging = useQueuePaging('pool');
  const pool = usePickupRequests({
    state: 'CONFIRMED',
    manifested: false,
    ...(paging.pageToken === undefined ? {} : { pageToken: paging.pageToken }),
    enabled: me !== undefined,
  });
  const [chosen, setChosen] = useState<ReadonlyMap<string, Chosen>>(new Map());
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
  const queue = useRef<HTMLDivElement>(null);

  const day = isFinishedDate(serviceDate) ? serviceDate : undefined;
  const isCarriedOver = (promised: string): boolean => day !== undefined && promised < day;
  const overdue = [...chosen.values()].filter((request) => isCarriedOver(request.promised));
  const reasons = usePickupReasons('PICKUP_CARRYOVER', overdue.length > 0);

  const command = useConfirmedCommand<NewManifest, ManifestRecord>({
    send: (body, key) => createPickupManifest(client, body, key),
    onDone: (record) => {
      void navigate(`/manifests/${record.manifest.id}`, { state: { created: true } });
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

  // A move to a page with nothing to draw leaves the pager button it was made from gone: focus goes to the message, once.
  const { takeFocus } = paging;
  const settled = !pool.isFetching && (pool.isSuccess || pool.isError);
  const hasRows = pool.isSuccess && pool.data.items.length > 0;
  useEffect(() => {
    if (!settled || hasRows || !takeFocus()) return;
    queue.current?.querySelector<HTMLElement>('.ui-read-state')?.focus({ preventScroll: true });
  }, [settled, hasRows, takeFocus]);

  if (me === undefined) return null;
  const locked = command.locked;
  const full = chosen.size >= MAX_STOPS;

  function toggle(request: PickupRequestView, ticked: boolean): void {
    setChosen((current) => {
      const next = new Map(current);
      if (ticked) next.set(request.id, chosenOf(request));
      else next.delete(request.id);
      return next;
    });
    setInvalid((current) => ({ ...current, none: undefined }));
    command.dismiss();
  }
  function remove(id: string): void {
    setChosen((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
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
  const poolColumns = POOL_COLUMNS(isCarriedOver, me.session.authorized_hubs);

  return (
    <>
      <title>Build a manifest · Melarc Ops Portal</title>
      <p className="pickup-back">
        <Link to="/manifests">Back to manifests</Link>
      </p>
      <PageHeader
        title="Build a manifest"
        description="Choose confirmed pickups for one run, on one day. Nothing is made until you create the manifest."
      />
      <form
        ref={form}
        noValidate
        aria-busy={command.phase === 'sending' ? true : undefined}
        onSubmit={submit}
      >
        <CommandOutcomeNotice
          command={command}
          unknownText={copyFor({ operation: 'createPickupManifest', context: 'unknown-outcome' })}
        />

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

        <section className="pickup-form-section" aria-labelledby="builder-pool">
          <h2 id="builder-pool">The pool of confirmed pickups</h2>
          <p className="manifest-note">
            These are the confirmed pickups that no manifest holds, as the server lists them. A
            pickup whose late booking waits for an Ops decision is not in it. Choose up to{' '}
            {MAX_STOPS}; your choice is kept as you move between pages.
          </p>
          {invalid.none === undefined ? null : (
            <p className="manifest-carryover__error" role="alert">
              {invalid.none}
            </p>
          )}
          <div className="manifest-queue" ref={queue}>
            <QueuePanel>
              <div className="manifest-freshness">
                <p className="manifest-freshness__text">
                  {pool.dataUpdatedAt > 0
                    ? `Last checked ${formatInstant(new Date(pool.dataUpdatedAt).toISOString()) ?? ''}.`
                    : ''}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  loading={pool.isFetching}
                  disabled={locked}
                  onClick={() => {
                    void pool.refetch({ cancelRefetch: false });
                  }}
                >
                  Refresh the pool
                </Button>
              </div>
              <ReadState<PickupRequestPageView>
                query={
                  pool.isFetching && pool.status === 'success'
                    ? {
                        status: 'pending',
                        data: undefined,
                        error: null,
                        refetch: pool.refetch,
                        isFetching: true,
                      }
                    : pool
                }
                isEmpty={(data) => data.items.length === 0}
                empty={
                  paging.page > 1 ? (
                    <EmptyState
                      kind="filtered"
                      heading="No requests on this page"
                      announce
                      action={
                        <Button type="button" variant="secondary" onClick={paging.toFirstPage}>
                          Back to first page
                        </Button>
                      }
                    >
                      Page {paging.page} has no requests now. Earlier pages may still have some.
                    </EmptyState>
                  ) : (
                    <EmptyState kind="none" heading="The pool is empty">
                      No confirmed pickup is waiting for a manifest. A confirmed pickup appears here
                      until a manifest holds it.
                    </EmptyState>
                  )
                }
                loadingLabel="Loading the pool…"
                skeleton={<Skeleton lines={5} />}
                permission="pickup.read"
                operation="listPickupRequests"
                context="pool"
              >
                {(data) => (
                  <QueueTable
                    caption="Confirmed pickups waiting for a manifest"
                    columns={poolColumns}
                    rows={data.items}
                    rowKey={(row) => row.id}
                    noun={{ one: 'request', other: 'requests' }}
                    paging={paging}
                    nextPageToken={data.nextPageToken}
                    card={(row) => (
                      <PoolCard
                        request={row}
                        carriedOver={isCarriedOver(row.scheduled_service_date)}
                      />
                    )}
                    selection={{
                      selected: new Set(chosen.keys()),
                      rowLabel: (row) => `Choose ${row.code}`,
                      isDisabled: () => full || locked,
                      onToggle: toggle,
                    }}
                  />
                )}
              </ReadState>
            </QueuePanel>
          </div>
        </section>

        {overdue.length > 0 ? (
          <section
            className="pickup-form-section manifest-carryover"
            aria-labelledby="builder-carryover"
          >
            <h2 id="builder-carryover">Carried over from an earlier day</h2>
            <p className="manifest-note">
              These pickups were promised for an earlier day than the run’s. Each is carried over
              for a reason you give for that pickup, and it keeps the day it was promised, so it
              stays late against that promise.
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
                    No carry-over reason is configured yet, so a manifest holding a pickup from an
                    earlier day cannot be made. The reasons are added to the reason catalogue by a
                    holder of <code>settings.reason.manage</code>.
                  </p>
                </Alert>
              }
            >
              {(list) => (
                <>
                  {overdue.map((request) => {
                    const entry = carryover.get(request.id);
                    const reason = list.find((candidate) => candidate.code === entry?.reasonCode);
                    const error =
                      invalid.carryover.get(request.id) ?? marks.carryover.get(request.id);
                    return (
                      <div key={request.id} className="manifest-carryover__entry">
                        <h3>{request.code}</h3>
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
                              setEntry(request.id, { reasonCode: event.target.value });
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

        <section className="manifest-builder__summary" aria-labelledby="builder-review">
          <h2 id="builder-review">Review</h2>
          {chosen.size === 0 ? (
            <p>No request is chosen yet.</p>
          ) : (
            <>
              <p>
                {`${String(chosen.size)} ${chosen.size === 1 ? 'request' : 'requests'} chosen${
                  day === undefined ? '' : ` for ${serviceDateText(day)}`
                }${
                  overdue.length === 0 ? '' : `, ${String(overdue.length)} carried over`
                }. The stops take this order; you can change it after the manifest is made, until it is dispatched.`}
              </p>
              {full ? (
                <p className="manifest-support">
                  {`A manifest holds at most ${String(MAX_STOPS)} requests; use another manifest for the rest.`}
                </p>
              ) : null}
              <ol className="manifest-builder__chosen" aria-label="The requests chosen, in order">
                {[...chosen.values()].map((request) => {
                  const mark = marks.requests.get(request.id);
                  return (
                    <li key={request.id}>
                      <span className="manifest-lines">
                        <span>{`${request.code}: ${request.sender}`}</span>
                        <span className="manifest-support">{request.address}</span>
                        {mark === undefined ? null : (
                          <span className="manifest-carryover__error">{mark}</span>
                        )}
                      </span>{' '}
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={locked}
                        aria-label={`Remove ${request.code} from the choice`}
                        onClick={() => {
                          remove(request.id);
                        }}
                      >
                        Remove
                      </Button>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
          <div className="manifest-builder__actions">
            {recovering ? (
              <Button key="check" type="button" data-recovery onClick={command.checkRecord}>
                {command.phase === 'conflict' ? 'Reload the pool' : 'Check the pool'}
              </Button>
            ) : (
              <Button key="create" type="submit" loading={command.phase === 'sending'}>
                Create the manifest
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
          </div>
        </section>
      </form>
    </>
  );
}
