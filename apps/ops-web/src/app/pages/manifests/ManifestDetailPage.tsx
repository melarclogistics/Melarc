import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { Link } from '../../../components/ui/link/Link';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { useApiClient } from '../../../platform/api/api-client';
import {
  assignRider,
  cancelPickupManifest,
  dispatchManifest,
  type ManifestRecord,
} from '../../../platform/manifest/manifest-commands';
import { subjectLogPath } from '../../../platform/notifications/notification-shape';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { NoteActDialog } from '../pickup/PickupActDialogs';
import { serviceDateText } from '../pickup/pickup-presentation';
import { hubNameOf } from '../staff/staff-presentation';
import { ActBlock } from './ActBlock';
import { CustodySection, RiderName } from './CustodySection';
import { AssignRiderDialog, DispatchDialog } from './ManifestActDialogs';
import { MANIFEST_STATE_MAP, MANIFEST_STATE_SENTENCES, stopsText } from './manifest-presentation';
import type { SkippedState } from './StopSkipPage';
import { StopsSection } from './StopsSection';
import { WithManifest } from './WithManifest';
import '../pickup/pickup-pages.css';
import './manifests-pages.css';

type Act = 'assign' | 'dispatch' | 'cancel';

/** What a page that just made a manifest tells the one it brings here (router state; a reload of the page is not a creation). */
export interface CreatedState {
  readonly created?: true;
}

function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Manifest({
  record,
  query,
}: {
  readonly record: ManifestRecord;
  readonly query: UseQueryResult<ManifestRecord>;
}) {
  const client = useApiClient();
  const me = useSignedInSession();
  const location = useLocation();
  const arrival = location.state as (CreatedState & SkippedState) | null;
  const [open, setOpen] = useState<Act | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(
    arrival?.created === true
      ? 'The manifest is made. It is a draft: order its stops, give it a rider and dispatch it.'
      : arrival?.skipped === true
        ? 'The stop is skipped and the vendor is told. The manifest is read again below: skipping the last stop to be worked of a run that collected nothing completes the run.'
        : undefined,
  );
  // The stops a refused dispatch named, until the manifest is read again.
  const [flagged, setFlagged] = useState<ReadonlySet<string>>(new Set());
  const noticeBox = useRef<HTMLDivElement>(null);
  // Focus goes to the news of an act the person has just done, here; the news of an arrival (the manifest was just made, a stop was just
  // skipped) is read in its place, because the arrival has put focus on the heading of the page, where a person starts.
  const focusNotice = useRef(false);
  useEffect(() => {
    if (notice !== undefined && focusNotice.current) noticeBox.current?.focus();
  }, [notice]);
  if (me === undefined) return null;

  const { manifest, etag } = record;
  const id = manifest.id;
  const draft = manifest.state === 'DRAFT';
  const dispatched = manifest.state === 'DISPATCHED';
  const inProgress = manifest.state === 'IN_PROGRESS';

  function close(): void {
    setOpen(undefined);
  }
  /** The act was done: say what it came to and read the manifest again for its new state and version. */
  function done(text: string): void {
    focusNotice.current = true;
    setOpen(undefined);
    setFlagged(new Set());
    setNotice(text);
    void query.refetch();
  }
  function reload(): Promise<unknown> {
    setOpen(undefined);
    setNotice(undefined);
    setFlagged(new Set());
    return query.refetch();
  }
  /** Stops by their place in the order, which is how an officer reads a run: "stops 2 and 4". */
  function stopsNamed(stopIds: readonly string[]): string {
    const places = manifest.stops
      .filter((stop) => stopIds.some((named) => named.toLowerCase() === stop.id.toLowerCase()))
      .map((stop) => String(stop.sequence));
    if (places.length === 0) return 'some stops';
    return `${places.length === 1 ? 'stop' : 'stops'} ${places.join(' and ')}`;
  }

  const riderId = manifest.assigned_rider_id;
  const moments = [
    ['Assigned', manifest.assigned_at],
    ['Dispatched', manifest.dispatched_at],
    ['Started', manifest.started_at],
    ['Completed', manifest.completed_at],
  ] as const;

  return (
    <>
      {notice === undefined ? null : (
        <div className="pickup-notice" ref={noticeBox} tabIndex={-1}>
          <Alert variant="success">
            <p>{notice}</p>
          </Alert>
        </div>
      )}

      <p className="pickup-status">
        <StatusBadge status={manifest.state} map={MANIFEST_STATE_MAP} />{' '}
        <span>{MANIFEST_STATE_SENTENCES[manifest.state]}</span>
      </p>

      <dl className="pickup-facts">
        <Fact term="Service date">{serviceDateText(manifest.service_date)}</Fact>
        <Fact term="Hub">{hubNameOf(manifest.responsible_hub_id, me.session.authorized_hubs)}</Fact>
        <Fact term="Rider">
          {riderId === undefined ? 'No rider assigned yet' : <RiderName id={riderId} />}
        </Fact>
        <Fact term="Stops">{stopsText(manifest.stops.length)}</Fact>
        {moments.map(([term, at]) =>
          at === undefined ? null : (
            <Fact key={term} term={term}>
              {formatInstant(at)}
            </Fact>
          ),
        )}
      </dl>

      {/* The message log narrowed to this run, for a session that lists the key of the log (the server checks it all the same). */}
      {me.holds('notification.read') ? (
        <p>
          <Link to={subjectLogPath('PICKUP_MANIFEST', id)}>Messages about this run</Link>
        </p>
      ) : null}

      <StopsSection
        record={record}
        flagged={flagged}
        onSaved={() => {
          done('The order of the stops is saved.');
        }}
        onReload={reload}
      />

      {inProgress ? <CustodySection record={record} onDone={done} onReload={reload} /> : null}

      <section className="pickup-section" aria-labelledby="manifest-acts">
        <h2 id="manifest-acts">What you can do</h2>

        {draft ? (
          <>
            <ActBlock
              title={riderId === undefined ? 'Assign a rider' : 'Change the rider'}
              permission="pickup.manifest.assign"
              holds={me.holds('pickup.manifest.assign')}
              text="Assigning a rider closes the vendor’s own cancellation of every request on this manifest. The rider sees nothing until the manifest is dispatched. This is a separate step from dispatching."
              control={
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setOpen('assign');
                  }}
                >
                  {riderId === undefined ? 'Assign a rider' : 'Choose another rider'}
                </Button>
              }
            />
            <ActBlock
              title="Dispatch the manifest"
              permission="pickup.manifest.dispatch"
              holds={me.holds('pickup.manifest.dispatch')}
              text="Dispatching shows the stops to the assigned rider and queues a text message for them. It does not start the run: the rider does that, on the run’s day. A manifest needs a rider, and a stop still to be worked, to be dispatched."
              control={
                <Button
                  type="button"
                  onClick={() => {
                    setOpen('dispatch');
                  }}
                >
                  Dispatch the manifest
                </Button>
              }
            />
          </>
        ) : null}

        {dispatched ? (
          <div className="pickup-act">
            <h3>The rider</h3>
            <p className="pickup-act__text">
              A rider cannot be changed once the manifest is dispatched. To give the run to another
              rider, cancel the manifest and plan its requests again.
            </p>
          </div>
        ) : null}

        {draft || dispatched ? (
          <ActBlock
            title="Cancel the manifest"
            permission="pickup.manifest.create"
            holds={me.holds('pickup.manifest.create')}
            text="Cancelling asks for a note. The stops still to be worked are skipped, and the requests that are still confirmed return to the pool with their commitment to a rider ended. It can be done until the run starts."
            control={
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  setOpen('cancel');
                }}
              >
                Cancel the manifest
              </Button>
            }
          />
        ) : null}

        {inProgress ? (
          <div className="pickup-act">
            <h3>The run has started</h3>
            <p className="pickup-act__text">
              A run that has started cannot be cancelled. A stop that cannot be worked is skipped
              from this page, and if the rider cannot go on the parcels are handed to another rider
              or to the hub, above.
            </p>
          </div>
        ) : null}

        {!draft && !dispatched && !inProgress ? (
          <p className="pickup-act__text">
            {manifest.state === 'CANCELLED'
              ? 'A cancelled manifest is not changed again. Its stops are listed above.'
              : 'A completed run is not changed again.'}
          </p>
        ) : null}
      </section>

      <AssignRiderDialog<ManifestRecord>
        open={open === 'assign'}
        hubId={manifest.responsible_hub_id}
        version={etag}
        send={(riderId2, version) => assignRider(client, id, version, riderId2)}
        onDone={() => {
          done(
            'A rider is assigned. The manifest is still a draft: dispatch it to show the stops to the rider.',
          );
        }}
        onCancel={close}
        onReload={reload}
      />
      <DispatchDialog<ManifestRecord>
        open={open === 'dispatch'}
        riderName={undefined}
        version={etag}
        send={(version) => dispatchManifest(client, id, version)}
        onDone={() => {
          done(
            'The manifest is dispatched. The rider can see its stops; the run starts on its day.',
          );
        }}
        onCancel={close}
        onReload={reload}
        onStopsNamed={stopsNamed}
        onRefused={(problem) => {
          if (problem.rule === 'request_not_confirmed' && problem.stops !== undefined) {
            setFlagged(new Set(problem.stops));
          }
        }}
      />
      <NoteActDialog<ManifestRecord>
        open={open === 'cancel'}
        title="Cancel this manifest?"
        consequence={
          <p>
            The stops still to be worked are skipped and every claim is released: the requests that
            are still confirmed return to the pool, with their commitment to a rider ended. A
            request cancelled in the meantime stays cancelled. The run has not started, so nothing
            has been collected.
          </p>
        }
        confirmLabel="Cancel the manifest"
        confirmVariant="danger"
        noteLabel="Why it is cancelled"
        noteHelp="One line, kept with the cancellation. Leave out phone numbers and email addresses."
        operation="cancelPickupManifest"
        notePointer="/note"
        version={etag}
        retryable
        send={(note, version, key) => cancelPickupManifest(client, id, version, note, key)}
        onDone={() => {
          done(
            'The manifest is cancelled. Its requests that are still confirmed are back in the pool.',
          );
        }}
        onCancel={close}
        onReload={reload}
      />
    </>
  );
}

/**
 * One manifest (surfaces/ops-portal.md section 7, `/manifests/{id}`; S1.25): where the run stands and what comes next, the rider, the stops in
 * their order, and the acts the record and the session's keys allow. **Assigning a rider and dispatching are separate acts**, never one button;
 * the order of the stops, the cancellation, the Ops skip of a stop and the custody handover are each their own. Every act sends the version the
 * page read (`If-Match`), so a concurrent edit is a `STATE_CONFLICT` that is explained and read again, never a silent overwrite. What is offered
 * is a hint and decides nothing: the server checks the key, the hub and the state. A manifest outside the session's hubs and one that does not
 * exist are pages of their own (`HUB_SCOPE_VIOLATION`, `NOT_FOUND`).
 */
export function ManifestDetailPage() {
  const { id = '' } = useParams();
  return (
    <WithManifest
      id={id}
      heading={(record) => ({
        title: record?.manifest.code ?? 'Manifest',
        description: 'Pickup run',
        documentTitle: record?.manifest.code ?? 'Manifest',
      })}
    >
      {(record, query) => <Manifest record={record} query={query} />}
    </WithManifest>
  );
}
