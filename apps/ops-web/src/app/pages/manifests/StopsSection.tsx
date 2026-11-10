import { useEffect, useRef, useState } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { DataTable, type DataColumn } from '../../../components/ui/data-table/DataTable';
import { Link } from '../../../components/ui/link/Link';
import { Panel } from '../../../components/ui/panel/Panel';
import { ReorderList, type ReorderItem } from '../../../components/ui/reorder-list/ReorderList';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { useApiClient } from '../../../platform/api/api-client';
import { useConfirmedCommand } from '../../../platform/api/use-confirmed-command';
import {
  setManifestStopOrder,
  type ManifestRecord,
} from '../../../platform/manifest/manifest-commands';
import type { StopView } from '../../../platform/manifest/manifest-shape';
import { useStopRequests } from '../../../platform/manifest/use-manifest-queries';
import type { PickupRequestView } from '../../../platform/pickup/pickup-shape';
import { usePickupReasons } from '../../../platform/pickup/use-pickup-queries';
import { CommandOutcomeNotice } from '../../../components/ui/reason-confirmation/command-outcome';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import {
  FAILURE_LABELS,
  isToBeWorked,
  skipReasonText,
  STOP_STATUS_MAP,
  stopsText,
  stopStatusOf,
} from './manifest-presentation';
import '../pickup/pickup-pages.css';
import './manifests-pages.css';

/** What the screen can tell of one stop's pickup, from the stop's own summary or from the request behind it. */
interface StopFacts {
  readonly stop: StopView;
  /** The pickup's operational code, when the stop or its request gave one. */
  readonly code: string | undefined;
  readonly sender: string | undefined;
  readonly place: string | undefined;
  /** Whether the request behind the stop is still being read. */
  readonly reading: boolean;
}

function factsOf(
  stop: StopView,
  requests: ReadonlyMap<string, PickupRequestView | null> | undefined,
  reading: boolean,
): StopFacts {
  const summary = stop.pickup_summary;
  if (summary !== undefined) {
    return {
      stop,
      code: summary.reference,
      sender: summary.sender_display_name,
      place: summary.resolved_pickup_location.address,
      reading: false,
    };
  }
  const request = requests?.get(stop.pickup_request_id.toLowerCase());
  if (request === undefined || request === null) {
    return {
      stop,
      code: undefined,
      sender: undefined,
      place: undefined,
      reading: reading && request === undefined,
    };
  }
  return {
    stop,
    code: request.code,
    sender: request.sender_name,
    place: request.resolved_pickup_location?.address,
    reading: false,
  };
}

function PickupCell({ facts }: { readonly facts: StopFacts }) {
  const href = `/pickup-requests/${facts.stop.pickup_request_id}`;
  return (
    <span className="manifest-stop-line">
      <span className="manifest-nowrap">
        <Link to={href}>{facts.code ?? 'Open the pickup request'}</Link>
      </span>
      {facts.sender === undefined ? null : <span className="manifest-support">{facts.sender}</span>}
      {facts.code === undefined ? (
        <span className="manifest-support">
          {facts.reading ? 'Reading the pickup…' : 'The pickup could not be read here.'}
        </span>
      ) : null}
    </span>
  );
}

/** The pickup's place, as the summary or the request gave it. */
const placeOf = (facts: StopFacts): string => facts.place ?? 'Not shown';

export interface StopsSectionProps {
  readonly record: ManifestRecord;
  /** The stops a refused dispatch named: marked in words, and not by colour alone. */
  readonly flagged: ReadonlySet<string>;
  /** The order was saved (the page reads the manifest again and says so). */
  readonly onSaved: () => void;
  /** The officer asks for the manifest to be read again, after a conflict or an outcome nobody knows. */
  readonly onReload: () => unknown;
}

/**
 * The stops of a run, in their order (surfaces/ops-portal.md section 7, `/manifests/{id}`): the place, the pickup (by its code, never its id),
 * its state as a labelled badge, when the rider arrived, and why it was skipped, with the officer's own note, which is staff's alone. **A stop
 * skipped because its request was cancelled is told as that**, as a stop that needs nothing, and keeps its place when the stops are ordered.
 * Each stop still to be worked of a run in progress offers the Ops skip to a holder of `pickup.stop.skip`.
 *
 * **The order is changed apart from the reading** (`setManifestStopOrder`, a draft only, a holder of `pickup.manifest.create`): "Change the
 * order" turns the table into the reordering control, the order is sent whole with the version read, and "Save this order" is the act. A stop
 * that is no longer to be worked is held in its place and the others are ordered around it; whether the order is acceptable is the server's.
 */
export function StopsSection({ record, flagged, onSaved, onReload }: StopsSectionProps) {
  const client = useApiClient();
  const me = useSignedInSession();
  const { manifest, etag } = record;
  const stops = manifest.stops;
  const requests = useStopRequests(stops);
  const wantsCatalogue = stops.some(
    (stop) =>
      stop.skipped !== undefined &&
      stop.skipped.reason_code !== 'REQUEST_CANCELLED' &&
      stop.skipped.reason_code !== 'MANIFEST_CANCELLED',
  );
  // The labels of the officers' reasons come from the catalogue, when the session may read it; a session that may not is told the skip without them.
  const catalogue = usePickupReasons(
    'PICKUP_STOP_SKIP',
    wantsCatalogue && me?.holds('settings.reason.read') === true,
  );
  const [order, setOrder] = useState<readonly string[] | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  /** Set when the changes are put aside: focus goes to the heading of the stops, where the officer was working (the control they pressed is gone, and the table is drawn in its place). */
  const returnFocus = useRef(false);
  const reordering = order !== undefined;
  useEffect(() => {
    if (reordering || !returnFocus.current) return;
    returnFocus.current = false;
    heading.current?.focus();
  }, [reordering]);

  const command = useConfirmedCommand<
    { readonly orderedStopIds: readonly string[]; readonly version: string },
    ManifestRecord
  >({
    send: (sent, key) =>
      setManifestStopOrder(client, manifest.id, sent.version, sent.orderedStopIds, key),
    onDone: () => {
      setOrder(undefined);
      onSaved();
    },
    onReload: () => {
      setOrder(undefined);
      return onReload();
    },
    retryable: true,
    operation: 'setManifestStopOrder',
  });

  useEffect(() => {
    if (command.phase === 'unknown' || command.phase === 'conflict') {
      document.querySelector<HTMLElement>('[data-reorder-recovery]')?.focus();
    }
  }, [command.phase]);

  if (me === undefined) return null;
  const canOrder =
    manifest.state === 'DRAFT' && me.holds('pickup.manifest.create') && stops.length > 1;
  const canSkip = manifest.state === 'IN_PROGRESS' && me.holds('pickup.stop.skip');
  const facts = stops.map((stop) => factsOf(stop, requests.data, requests.isFetching));
  const byId = new Map(facts.map((entry) => [entry.stop.id, entry]));

  // The places the server named when it refused the order, as the numbers an officer sees.
  const named = new Set(
    (command.problem?.violations ?? [])
      .map((violation) => /^\/ordered_stop_ids\/(\d+)$/.exec(violation.pointer)?.[1])
      .filter((index): index is string => index !== undefined)
      .map((index) => Number(index) + 1),
  );

  const items: ReorderItem[] = (order ?? stops.map((stop) => stop.id)).flatMap((id) => {
    const entry = byId.get(id);
    if (entry === undefined) return [];
    const movable = isToBeWorked(entry.stop);
    return [
      {
        id,
        label: entry.code ?? `the stop that was number ${String(entry.stop.sequence)}`,
        fixed: !movable,
        ...(movable
          ? {}
          : {
              fixedNote: `${STOP_STATUS_MAP[stopStatusOf(entry.stop)].label}: it keeps its place.`,
            }),
        content: (
          <span className="manifest-stop-line">
            <PickupCell facts={entry} />
            <span className="manifest-support">{placeOf(entry)}</span>
          </span>
        ),
      },
    ];
  });

  const original = stops.map((stop) => stop.id);
  const unchanged = order === undefined || order.every((id, index) => id === original[index]);

  /** The act of a stop that is still to be worked of a run in progress: the Ops skip, to a holder of its key. A link, for it goes to the page that asks why. */
  const skipAct = (row: StopFacts) =>
    canSkip && isToBeWorked(row.stop) ? (
      <ButtonLink
        to={`/manifests/${manifest.id}/stops/${row.stop.id}/skip`}
        variant="secondary"
        aria-label={`Skip stop ${String(row.stop.sequence)}${row.code === undefined ? '' : `, ${row.code}`}`}
      >
        Skip this stop
      </ButtonLink>
    ) : null;

  // Every column stays (`crowded: keep`): what the officer reads of a stop is its place and its state, and none of them is lesser. Under 40rem of the table's own box each stop is a card.
  const columns: readonly DataColumn<StopFacts>[] = [
    {
      id: 'stop',
      header: 'Stop',
      rowHeader: true,
      align: 'end',
      cell: (row) => String(row.stop.sequence),
    },
    { id: 'pickup', header: 'Pickup', cell: (row) => <PickupCell facts={row} /> },
    { id: 'place', header: 'Place', cell: (row) => placeOf(row) },
    {
      id: 'state',
      header: 'State',
      cell: (row) => (
        <StopState facts={row} flagged={flagged.has(row.stop.id)} catalogue={catalogue.data} />
      ),
    },
    ...(canSkip
      ? [{ id: 'actions', header: 'Actions', cell: skipAct } satisfies DataColumn<StopFacts>]
      : []),
  ];

  return (
    <Panel title="Stops" headingLevel={2} region headingRef={heading}>
      <p className="manifest-note">
        {stopsText(stops.length)}, in the order the rider is shown them.
      </p>
      {requests.isError ? (
        <Alert variant="danger">
          <p>
            The pickups behind some stops could not be loaded, so those stops are named by their
            place in the order.{' '}
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void requests.refetch();
              }}
            >
              Try again
            </Button>
          </p>
        </Alert>
      ) : null}

      {reordering ? (
        <>
          <p className="manifest-note">
            Use the buttons to move a stop. Nothing changes until you save the order.
          </p>
          <ReorderList
            label="Stops, in order"
            items={items}
            disabled={command.locked}
            onChange={(ids) => {
              setOrder(ids);
              command.dismiss();
            }}
          />
          <div className="manifest-stop__actions">
            <CommandOutcomeNotice command={command} />
          </div>
          {named.size > 0 ? (
            <p className="manifest-note">
              {`The server did not accept the place${named.size === 1 ? '' : 's'} numbered ${[...named].join(', ')}.`}
            </p>
          ) : null}
          <div className="pickup-act__buttons">
            {command.phase === 'unknown' ? (
              <>
                <Button
                  key="check"
                  type="button"
                  variant="secondary"
                  data-reorder-recovery
                  onClick={command.checkRecord}
                >
                  Check the pickup run
                </Button>
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
              </>
            ) : command.phase === 'conflict' ? (
              <Button
                key="reload"
                type="button"
                data-reorder-recovery
                onClick={command.checkRecord}
              >
                Reload the pickup run
              </Button>
            ) : (
              <>
                <Button
                  key="save"
                  type="button"
                  disabled={unchanged}
                  loading={command.phase === 'sending'}
                  onClick={() => {
                    if (!command.locked) {
                      void command.submit({ orderedStopIds: order, version: etag });
                    }
                  }}
                >
                  Save this order
                </Button>
                <Button
                  key="discard"
                  type="button"
                  variant="secondary"
                  disabled={command.locked}
                  onClick={() => {
                    returnFocus.current = true;
                    setOrder(undefined);
                    command.dismiss();
                  }}
                >
                  Discard the changes
                </Button>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <DataTable<StopFacts>
            label="Stops"
            columns={columns}
            rows={facts}
            rowId={(row) => row.stop.id}
            density="two-line"
            crowded="keep"
            cardHeadingLevel={3}
            cardTitle={(row) => `Stop ${String(row.stop.sequence)}`}
            card={(row) => (
              <span className="manifest-stop-line">
                <PickupCell facts={row} />
                <span className="manifest-support">{placeOf(row)}</span>
                <StopState
                  facts={row}
                  flagged={flagged.has(row.stop.id)}
                  catalogue={catalogue.data}
                />
                {skipAct(row)}
              </span>
            )}
          />
          {canOrder ? (
            <div className="pickup-act__buttons">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setOrder(stops.map((stop) => stop.id));
                }}
              >
                Change the order
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function StopState({
  facts,
  flagged,
  catalogue,
}: {
  readonly facts: StopFacts;
  readonly flagged: boolean;
  readonly catalogue: Parameters<typeof skipReasonText>[1];
}) {
  const { stop } = facts;
  const skip = skipReasonText(stop, catalogue);
  return (
    <span className={flagged ? 'manifest-stop-line manifest-marked' : 'manifest-stop-line'}>
      <span>
        <StatusBadge status={stopStatusOf(stop)} map={STOP_STATUS_MAP} />
      </span>
      {flagged ? (
        <span>The dispatch was refused because this pickup is no longer confirmed.</span>
      ) : null}
      {stop.arrived_at === undefined ? null : (
        <span className="manifest-support">
          {`Rider arrived ${formatInstant(stop.arrived_at) ?? ''}`.trim()}
        </span>
      )}
      {stop.failure_category === undefined ? null : (
        <span className="manifest-support">{FAILURE_LABELS[stop.failure_category]}</span>
      )}
      {skip === undefined ? null : <span className="manifest-support">{skip}</span>}
      {stop.skipped?.note === undefined ? null : (
        <span className="manifest-support">{`Note: ${stop.skipped.note}`}</span>
      )}
    </span>
  );
}
