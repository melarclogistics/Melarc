import { useState } from 'react';

import { Button } from '../../../components/ui/button/Button';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { useApiClient } from '../../../platform/api/api-client';
import {
  acceptRunCustodyHandover,
  failRunCustodyHandover,
  initiateRunCustodyHandover,
  type HandoverRecord,
  type ManifestRecord,
} from '../../../platform/manifest/manifest-commands';
import type { HandoverView } from '../../../platform/manifest/manifest-shape';
import { usePendingHandover } from '../../../platform/manifest/use-manifest-queries';
import { useRider } from '../../../platform/rider/use-rider-queries';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { hubNameOf } from '../staff/staff-presentation';
import { NoteActDialog } from '../pickup/PickupActDialogs';
import { ActBlock } from './ActBlock';
import { AcceptHandoverDialog, InitiateHandoverDialog } from './ManifestActDialogs';
import { HANDOVER_STATE_MAP } from './manifest-presentation';
import '../pickup/pickup-pages.css';
import './manifests-pages.css';

/** A rider by name, as the roster knows them (`getRider`, `dispatch.read`); a rider the session cannot read is told as a rider. */
export function RiderName({
  id,
  fallback = 'A rider',
}: {
  readonly id: string;
  readonly fallback?: string;
}) {
  const rider = useRider(id);
  if (rider.status === 'success') return <>{rider.data.rider.full_name}</>;
  return <>{rider.status === 'pending' ? 'Reading the rider…' : fallback}</>;
}

type Act = 'initiate' | 'fail' | 'accept';

export interface CustodySectionProps {
  readonly record: ManifestRecord;
  /** The act was done: the page says what it came to and reads the manifest again, because the API may have completed the run in the same act. */
  readonly onDone: (notice: string) => void;
  readonly onReload: () => unknown;
}

function Pending({ handover }: { readonly handover: HandoverView }) {
  const me = useSignedInSession();
  return (
    <div className="manifest-handover">
      <p>
        <StatusBadge status={handover.state} map={HANDOVER_STATE_MAP} />
      </p>
      <p>
        {'Custody is to go to '}
        {handover.to_hub_id !== undefined ? (
          <strong>{`the hub: ${hubNameOf(handover.to_hub_id, me?.session.authorized_hubs ?? [])}`}</strong>
        ) : (
          <strong>
            <RiderName id={handover.to_rider_id ?? ''} />
          </strong>
        )}
        {'. It is held now by '}
        <strong>
          <RiderName id={handover.from_rider_id} />
        </strong>
        {' and stays with them until it is accepted.'}
      </p>
      <p>{`Opened ${formatInstant(handover.initiated_at) ?? ''}.`.trim()}</p>
    </div>
  );
}

/**
 * The Ops side of a run's custody handover (surfaces/ops-portal.md section 7, `/manifests/{id}`; S1.25), **only while the run is in progress**:
 * open one (to another rider, or to the hub), see the one that waits, mark it failed with a note, and accept it as Ops where the destination is
 * the hub. Each is its own act with its own confirmation. **Opening a handover moves nothing**: custody stays with the rider who holds it until
 * the receiver accepts. A handover to a rider is the rider's to accept in the Rider app, and Ops is not offered it. The number an acceptance
 * records is a custody record of what was taken; it is never shown as the hub's count and never used as one.
 *
 * What is offered follows the record and the keys the session lists (`fleet.custody.read`, `.initiate`, `.accept`) and decides nothing: the
 * server checks the key, the hub, the run and the handover on every act.
 */
export function CustodySection({ record, onDone, onReload }: CustodySectionProps) {
  const client = useApiClient();
  const me = useSignedInSession();
  const { manifest, etag } = record;
  const canRead = me?.holds('fleet.custody.read') === true;
  const pending = usePendingHandover(manifest.id, canRead);
  const [open, setOpen] = useState<Act | undefined>(undefined);
  if (me === undefined) return null;

  function close(): void {
    setOpen(undefined);
  }
  function done(text: string): void {
    setOpen(undefined);
    void pending.refetch();
    onDone(text);
  }
  function reload(): unknown {
    setOpen(undefined);
    void pending.refetch();
    return onReload();
  }

  const holdsInitiate = me.holds('fleet.custody.initiate');

  return (
    <section className="pickup-section" aria-labelledby="manifest-custody">
      <h2 id="manifest-custody">Custody of the parcels</h2>
      {!canRead ? (
        <p className="pickup-act__text">
          Seeing a custody handover needs the permission <code>fleet.custody.read</code>, which your
          session does not hold.
        </p>
      ) : (
        <ReadState<HandoverRecord | null>
          query={pending}
          isEmpty={() => false}
          empty={null}
          loadingLabel="Loading the custody handover…"
          skeleton={<Skeleton lines={3} />}
          permission="fleet.custody.read"
          operation="listRunCustodyHandovers"
        >
          {(handover) =>
            handover === null ? (
              <ActBlock
                title="No handover is waiting"
                permission="fleet.custody.initiate"
                holds={holdsInitiate}
                text="Custody of the parcels is with the rider who holds it. If that rider cannot go on, with parcels aboard, open a handover to another rider or to the hub."
                control={
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setOpen('initiate');
                    }}
                  >
                    Open a custody handover
                  </Button>
                }
              />
            ) : (
              <>
                <Pending handover={handover.handover} />
                <ActBlock
                  title="Mark the handover as failed"
                  permission="fleet.custody.initiate"
                  holds={holdsInitiate}
                  text="Use this when the receiver did not take custody. Custody stays with the rider who holds it and the run stays in progress; another handover can then be opened."
                  control={
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setOpen('fail');
                      }}
                    >
                      Mark the handover as failed
                    </Button>
                  }
                />
                {handover.handover.to_hub_id === undefined ? (
                  <div className="pickup-act">
                    <h3>Accept the handover</h3>
                    <p className="pickup-act__text">
                      A handover to a rider is accepted by that rider, in the Rider app. Ops does
                      not accept it.
                    </p>
                  </div>
                ) : (
                  <ActBlock
                    title="Accept the handover for the hub"
                    permission="fleet.custody.accept"
                    holds={me.holds('fleet.custody.accept')}
                    text="Use this when the parcels have reached the hub. You record how many were taken; that is a record of custody, not the hub’s count."
                    control={
                      <Button
                        type="button"
                        onClick={() => {
                          setOpen('accept');
                        }}
                      >
                        Accept the handover
                      </Button>
                    }
                  />
                )}
                <NoteActDialog<HandoverView>
                  open={open === 'fail'}
                  title="Mark this handover as failed?"
                  consequence={
                    <p>
                      The receiver did not take custody. Custody stays with the rider who holds it,
                      and the run stays in progress. Your note is kept with the handover.
                    </p>
                  }
                  confirmLabel="Mark the handover as failed"
                  noteLabel="Why it did not happen"
                  noteHelp="One line, kept with the handover. Leave out phone numbers and email addresses."
                  operation="failRunCustodyHandover"
                  notePointer="/note"
                  version={handover.etag}
                  retryable
                  send={(note, version, key) =>
                    failRunCustodyHandover(client, manifest.id, version, note, key)
                  }
                  onDone={() => {
                    done('The handover is marked as failed. Custody is where it was.');
                  }}
                  onCancel={close}
                  onReload={reload}
                />
                <AcceptHandoverDialog<HandoverView>
                  open={open === 'accept'}
                  version={handover.etag}
                  send={(count, version, key) =>
                    acceptRunCustodyHandover(client, manifest.id, version, count, key)
                  }
                  onDone={(accepted) => {
                    done(
                      `Custody is handed over to the hub. You recorded ${String(
                        accepted.parcel_count_taken ?? 0,
                      )} parcels taken: a record of custody, not the hub’s count.`,
                    );
                  }}
                  onCancel={close}
                  onReload={reload}
                />
              </>
            )
          }
        </ReadState>
      )}
      <InitiateHandoverDialog<HandoverRecord>
        open={open === 'initiate'}
        hubId={manifest.responsible_hub_id}
        hubName={hubNameOf(manifest.responsible_hub_id, me.session.authorized_hubs)}
        version={etag}
        send={(destination, note, version) =>
          initiateRunCustodyHandover(client, manifest.id, version, destination, note)
        }
        onDone={() => {
          done('A custody handover is opened. Custody stays where it is until it is accepted.');
        }}
        onCancel={close}
        onReload={reload}
      />
    </section>
  );
}
