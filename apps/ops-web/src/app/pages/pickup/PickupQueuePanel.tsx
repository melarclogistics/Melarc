import { useState } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '../../../components/ui/button/Button';
import { ConfirmationDialog } from '../../../components/ui/confirmation/ConfirmationDialog';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { RecordPage } from '../../../components/ui/templates/RecordPage';
import { showToast } from '../../../components/ui/toast/Toast';
import { useApiClient } from '../../../platform/api/api-client';
import { confirmPickupRequest } from '../../../platform/pickup/pickup-commands';
import type { PickupRequestView } from '../../../platform/pickup/pickup-shape';
import {
  readPickupRequest,
  usePickupRequest,
  type PickupRecord,
} from '../../../platform/pickup/use-pickup-queries';
import { canBeConfirmed, PICKUP_STATE_MAP, STATE_SENTENCES } from './pickup-presentation';
import { queueFactsOf, type QueueFacts } from './pickup-queue-view';

/**
 * The confirmation of a request from the queue (`confirmPickupRequest`): the question, its consequence and the two buttons of the kit's `ConfirmationDialog`, over the same
 * machinery as the request's own page, so that a refusal, a conflict and an answer that is lost are told the same way. **It reads the request just before it confirms it**, because
 * the version the act takes (`If-Match`) is the `ETag` of a read of that one request, and the queue's list carries none: a request that has moved on since the list was read is
 * refused by the server (`STATE_CONFLICT`), and the dialog says so. The queue summary is read again by the API client when the act is answered.
 */
export function ConfirmPickupDialog({
  open,
  id,
  code,
  onDone,
  onCancel,
  onReload,
}: {
  readonly open: boolean;
  readonly id: string;
  readonly code: string;
  readonly onDone: (request: PickupRequestView) => void;
  readonly onCancel: () => void;
  readonly onReload: () => unknown;
}) {
  const client = useApiClient();
  return (
    <ConfirmationDialog<PickupRequestView>
      open={open}
      title={`Confirm ${code}?`}
      consequence={
        <p>
          The request joins the pool of confirmed pickups waiting for a run. Nothing is charged and
          no credit is reserved. A request booked after the hub’s cut-off is confirmed all the same,
          and waits for an Ops decision on the late booking.
        </p>
      }
      confirmLabel="Confirm the pickup"
      cancelLabel="Go back"
      operation="confirmPickupRequest"
      send={async () => {
        const { etag } = await readPickupRequest(client, id);
        return confirmPickupRequest(client, id, etag);
      }}
      onDone={onDone}
      onCancel={onCancel}
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
  onConfirmed,
  onReload,
}: {
  readonly record: PickupRecord;
  readonly hubs: readonly { readonly id: string; readonly display_name: string }[];
  readonly canConfirm: boolean;
  readonly onConfirmed: (request: PickupRequestView) => void;
  readonly onReload: () => unknown;
}) {
  const { request } = record;
  const facts = queueFactsOf(request, hubs);
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <RecordPage
        header={{ code: request.code, sentence: STATE_SENTENCES[request.state] }}
        acts={
          canConfirm && canBeConfirmed(request)
            ? {
                primary: (
                  <Button
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
        main={
          <DescriptionList
            items={[
              {
                label: 'State',
                value: <StatusBadge status={request.state} map={PICKUP_STATE_MAP} />,
              },
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
        code={request.code}
        onDone={(answer) => {
          setConfirming(false);
          onConfirmed(answer);
          void onReload();
        }}
        onCancel={() => {
          setConfirming(false);
        }}
        onReload={onReload}
      />
    </>
  );
}

/**
 * What the panel beside the pickup queue holds for a request: its summary, read as the request's own page reads it (`getPickupRequest`), with the one act the queue offers, in
 * the record template's composition for a panel. A request the session may not read, one in another hub and a failure are the read's own states, in the panel. The full page, with
 * every act, is "Open full page".
 */
export function PickupQueuePanel({
  row,
  hubs,
  canConfirm,
  onConfirmed,
}: {
  readonly row: QueueFacts;
  readonly hubs: readonly { readonly id: string; readonly display_name: string }[];
  readonly canConfirm: boolean;
  readonly onConfirmed: (request: PickupRequestView) => void;
}) {
  const record = usePickupRequest(row.id);
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
          onConfirmed={onConfirmed}
          onReload={() => record.refetch()}
        />
      )}
    </ReadState>
  );
}
