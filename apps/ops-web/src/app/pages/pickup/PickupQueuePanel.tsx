import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '../../../components/ui/button/Button';
import { ConfirmationDialog } from '../../../components/ui/confirmation/ConfirmationDialog';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { RecordPage } from '../../../components/ui/templates/RecordPage';
import { showToast } from '../../../components/ui/toast/Toast';
import { useApiClient } from '../../../platform/api/api-client';
import { confirmPickupRequest } from '../../../platform/pickup/pickup-commands';
import type { PickupRequestView } from '../../../platform/pickup/pickup-shape';
import type { PickupRecord, PickupRecordRead } from '../../../platform/pickup/use-pickup-queries';
import { canBeConfirmed, STATE_SENTENCES } from './pickup-presentation';
import { queueFactsOf } from './pickup-queue-view';

/**
 * The question that confirms a request (`confirmPickupRequest`), **one question for the queue's panel and for the request's own page**: the same title, the same consequence and the same two
 * buttons (COMPONENT_PATTERNS: the dismiss button is "Cancel", for confirming is not itself a cancellation). It confirms with **the version of the read the screen shows** (`version`, the `ETag`
 * of that read, sent as `If-Match`), and never with a version read just before: a request that changed since the person saw it (its date, its hub, its packages) is refused by the server
 * (`STATE_CONFLICT`) and the person is told it changed, not confirmed at a version they never saw (the review of 5edada2). A refusal, a conflict and an answer that is lost are told the same way
 * on both screens, over the kit's `ConfirmationDialog`. The queue summary is read again by the API client when the act is answered.
 */
export function ConfirmPickupDialog({
  open,
  id,
  version,
  onDone,
  onCancel,
  onConflict,
  onReload,
}: {
  readonly open: boolean;
  readonly id: string;
  /** The `ETag` of the read the screen shows. */
  readonly version: string;
  readonly onDone: (request: PickupRequestView) => void;
  readonly onCancel: () => void;
  /** The server said the request is not as the person saw it: the screen says so where the record is drawn (a banner with the way to read it again). */
  readonly onConflict?: () => void;
  readonly onReload: () => unknown;
}) {
  const client = useApiClient();
  return (
    <ConfirmationDialog<PickupRequestView>
      open={open}
      title="Confirm this pickup?"
      consequence={
        <p>
          The request joins the pool of confirmed pickups waiting for a run. Nothing is charged and
          no credit is reserved. A request booked after the hub’s cut-off is confirmed all the same,
          and waits for an Ops decision on the late booking.
        </p>
      }
      confirmLabel="Confirm the pickup"
      operation="confirmPickupRequest"
      version={version}
      send={(command) => confirmPickupRequest(client, id, command.version ?? version)}
      onDone={onDone}
      onCancel={onCancel}
      {...(onConflict === undefined ? {} : { onConflict })}
      onReload={onReload}
    />
  );
}

/** Says that a request was confirmed, with the way to open it. The toast is the screen's own news; the server's answer is what made it true. */
export function useConfirmedNews(): (request: PickupRequestView) => void {
  const navigate = useNavigate();
  return (request) => {
    showToast({
      tone: 'success',
      message: `${request.code} is confirmed. It waits in the pool for a pickup run.`,
      action: {
        label: 'Open',
        onClick: () => {
          void navigate(`/pickup-requests/${request.id}`);
        },
      },
    });
  };
}

function Summary({
  record,
  hubs,
  canConfirm,
  confirmAsk,
  onConfirmed,
  onReload,
}: {
  readonly record: PickupRecord;
  readonly hubs: readonly { readonly id: string; readonly display_name: string }[];
  readonly canConfirm: boolean;
  readonly confirmAsk: number;
  readonly onConfirmed: (request: PickupRequestView) => void;
  readonly onReload: () => unknown;
}) {
  // What the panel shows is the server's last word on the request: the read, which the screen replaces with the answer of the act the person just made.
  const request = record.request;
  const facts = queueFactsOf(request, hubs);
  const [confirming, setConfirming] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  // The row's Confirm opens the panel with focus on the panel's own: once the panel has drawn it (the panel's own move of focus to its heading comes first, and is not the person's choice).
  useEffect(() => {
    if (confirmAsk === 0) return;
    const frame = requestAnimationFrame(() => {
      confirmButton.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [confirmAsk]);
  return (
    <>
      <RecordPage
        header={{ code: request.code, sentence: STATE_SENTENCES[request.state] }}
        acts={
          canConfirm && canBeConfirmed(request)
            ? {
                primary: (
                  <Button
                    ref={confirmButton}
                    type="button"
                    onClick={() => {
                      setConfirming(true);
                    }}
                  >
                    Confirm pickup
                  </Button>
                ),
              }
            : {}
        }
        {...(conflicted
          ? {
              conflict: {
                onReload: () => {
                  setConflicted(false);
                  void onReload();
                },
              },
            }
          : {})}
        main={
          <DescriptionList
            items={[
              // The state is told once, by the badge in the panel's header (the Product Owner, 9 November 2026); it is not a fact of this list as well.
              { label: 'Sender', value: facts.sender },
              { label: 'Service date', value: facts.date },
              { label: 'Packages', value: facts.packages },
              { label: 'Booked as', value: facts.bookedAs },
              { label: 'Pickup address', value: facts.address },
              { label: 'Hub', value: facts.hub },
              ...(facts.needs === '' ? [] : [{ label: 'Needs', value: facts.needs }]),
            ]}
          />
        }
      />
      {/* In the panel, so that over the sheet of a phone (a modal) the question is inside what holds focus. */}
      <ConfirmPickupDialog
        open={confirming}
        id={request.id}
        version={record.etag}
        onDone={(answer) => {
          setConfirming(false);
          onConfirmed(answer);
        }}
        onCancel={() => {
          setConfirming(false);
        }}
        onConflict={() => {
          setConflicted(true);
        }}
        onReload={() => {
          setConfirming(false);
          setConflicted(false);
          return onReload();
        }}
      />
    </>
  );
}

/**
 * What the panel beside the pickup queue holds for a request: its summary, read as the request's own page reads it (`getPickupRequest`), with the one act the queue offers, in
 * the record template's composition for a panel. A request the session may not read, one in another hub and a failure are the read's own states, in the panel. The full page, with
 * every act, is "Open full page".
 *
 * **The read is the page's, handed in** (`record`): the panel's header (its state badge) and its body are drawn from the same read, and never from the row of the list, which is the
 * last page read and is older than the panel's own answer (the review of 5edada2). **The act confirms with the version of this read**, so that a request that changed since the person saw it
 * is refused and told as changed (a banner with the way to read it again), and never confirmed at a version they never saw. The answer of the act just made is written into that read by the
 * screen (`onConfirmed`), which shows it at once and keeps it no longer than the panel is open, and `confirmAsk` counts the times the row's own Confirm asked for focus on the panel's.
 */
export function PickupQueuePanel({
  record,
  hubs,
  canConfirm,
  confirmAsk,
  onConfirmed,
}: {
  readonly record: PickupRecordRead;
  readonly hubs: readonly { readonly id: string; readonly display_name: string }[];
  readonly canConfirm: boolean;
  readonly confirmAsk: number;
  readonly onConfirmed: (request: PickupRequestView) => void;
}) {
  return (
    <ReadState<PickupRecord>
      query={record}
      isEmpty={() => false}
      empty={null}
      loadingLabel="Loading the request…"
      skeleton={<Skeleton lines={5} />}
      permission="pickup.read"
      operation="getPickupRequest"
    >
      {(data) => (
        <Summary
          record={data}
          hubs={hubs}
          canConfirm={canConfirm}
          confirmAsk={confirmAsk}
          onConfirmed={onConfirmed}
          onReload={() => record.refetch()}
        />
      )}
    </ReadState>
  );
}
