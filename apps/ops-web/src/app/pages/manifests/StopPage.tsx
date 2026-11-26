import { useEffect, useRef } from 'react';
import { useLocation, useParams } from 'react-router';

import { PageHeading } from '../../../components/PageHeading';
import { Alert } from '../../../components/ui/alert/Alert';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { ForbiddenPage } from '../../../components/ui/forbidden-state/ForbiddenState';
import { Link } from '../../../components/ui/link/Link';
import { PageHeader } from '../../../components/ui/page-header/PageHeader';
import { Panel } from '../../../components/ui/panel/Panel';
import { drawnData, ReadState, RefreshFailed } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { RecordPage } from '../../../components/ui/templates/RecordPage';
import type { StopRecord } from '../../../platform/manifest/manifest-commands';
import { useManifest, useStop } from '../../../platform/manifest/use-manifest-queries';
import { usePickupRequest } from '../../../platform/pickup/use-pickup-queries';
import type { ParcelPhotoProgressView } from '../../../platform/pickup-work/pickup-work-shape';
import { useStopEvidence } from '../../../platform/pickup-work/use-pickup-work-queries';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { UUID } from '../staff/WithProfile';
import {
  FAILURE_LABELS,
  skipReasonText,
  STOP_STATUS_MAP,
  stopStatusOf,
} from './manifest-presentation';
import { StopPhotos } from './StopPhotos';
import { useFocusFallenToHeading } from './WithManifest';
import '../pickup/pickup-pages.css';
import './manifests-pages.css';

/** What the photo exception form tells the stop's page it brings the officer to, once. */
export interface LetThroughState {
  readonly letThrough?: true;
}

/**
 * Whether every parcel photo the rider made is uploaded: some were made, none still waits and none was lost. Then the photos made the count possible and the rider counts with them (or has counted),
 * so there is nothing to let through without photos, and the exception, which the server refuses once a count is recorded (`STATE_CONFLICT`, rule `collection_recorded`), is not offered (the review of
 * Run B, finding 6). **No read of the stop says whether a count is recorded**, and the progress cannot: this is the one case it can tell apart. Where some photos never came, or still wait, the act is
 * offered and the server judges the rest, in words.
 */
const everyParcelPhotoIsIn = (progress: ParcelPhotoProgressView): boolean =>
  progress.declared > 0 && progress.pending === 0 && progress.expired === 0;

function BackToRun({ manifestId }: { readonly manifestId: string }) {
  return (
    <p className="pickup-back">
      {manifestId === '' ? (
        <Link to="/manifests">Back to pickup runs</Link>
      ) : (
        <Link to={`/manifests/${manifestId}`}>Back to the pickup run</Link>
      )}
    </p>
  );
}

function StopNotFound({ manifestId }: { readonly manifestId: string }) {
  useFocusFallenToHeading();
  return (
    <>
      <title>Stop not found · Melarc Ops Portal</title>
      <PageHeading>Stop not found</PageHeading>
      <p>{copyFor({ operation: 'getPickupStop', code: 'NOT_FOUND' })}</p>
      <BackToRun manifestId={manifestId} />
    </>
  );
}

function Stop({
  manifestId,
  stopId,
  record,
  runCode,
  code,
}: {
  readonly manifestId: string;
  readonly stopId: string;
  readonly record: StopRecord;
  readonly runCode: string | undefined;
  readonly code: string | undefined;
}) {
  const me = useSignedInSession();
  const location = useLocation();
  const letThrough = (location.state as LetThroughState | null)?.letThrough === true;
  const noticeBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (letThrough) noticeBox.current?.focus();
  }, [letThrough]);
  useFocusFallenToHeading();
  // The photos of the stop are read a page at a time, only for a session that may read the stop (the server decides all the same).
  const evidence = useStopEvidence(stopId, undefined, me?.holds('pickup.read') === true);
  if (me === undefined) return null;
  const { stop } = record;
  const status = stopStatusOf(stop);
  const freshest = evidence.data?.pages.at(-1);
  const exception = freshest?.parcel_photo_exception;
  const skipLine = skipReasonText(stop, undefined);
  // The act is offered to a holder of its key, for a stop the rider has arrived at, that has not been let through and whose photos have not all made it: the server judges the rest (a count already
  // recorded is refused in words).
  const mayLetThrough =
    me.holds('pickup.handshake.override') &&
    stop.state === 'ARRIVED' &&
    evidence.status === 'success' &&
    exception === null &&
    freshest !== undefined &&
    !everyParcelPhotoIsIn(freshest.parcel_photos);
  const label = `Stop ${String(stop.sequence)}`;

  return (
    <RecordPage
      breadcrumb={[
        { label: 'Pickup runs', to: '/manifests' },
        { label: runCode ?? 'The pickup run', to: `/manifests/${manifestId}` },
      ]}
      header={{
        code: label,
        titleKind: 'name',
        status: <StatusBadge status={status} map={STOP_STATUS_MAP} />,
        sentence: `${label} of ${runCode ?? 'the pickup run'}${code === undefined ? '' : `, for ${code}`}.`,
      }}
      acts={{
        ...(mayLetThrough
          ? {
              primary: (
                <ButtonLink to={`/manifests/${manifestId}/stops/${stopId}/photo-exception`}>
                  Let the count through without photos
                </ButtonLink>
              ),
            }
          : {}),
      }}
      notice={
        letThrough ? (
          <div className="pickup-notice" ref={noticeBox} tabIndex={-1}>
            <Alert variant="success">
              <p>
                This stop’s count is let through without parcel photos. The rider can now count it.
              </p>
            </Alert>
          </div>
        ) : undefined
      }
      main={<StopPhotos evidence={evidence} />}
      side={
        <Panel title="The stop" headingLevel={2}>
          <DescriptionList
            items={[
              {
                label: 'Pickup',
                value: (
                  <Link to={`/pickup-requests/${stop.pickup_request_id}`}>
                    {code ?? 'Open the pickup request'}
                  </Link>
                ),
              },
              ...(stop.pickup_summary === undefined
                ? []
                : [
                    { label: 'Sender', value: stop.pickup_summary.sender_display_name },
                    {
                      label: 'Place',
                      value: stop.pickup_summary.resolved_pickup_location.address,
                    },
                  ]),
              {
                label: 'State',
                value: <StatusBadge status={status} map={STOP_STATUS_MAP} />,
              },
              {
                label: 'Rider arrived',
                value:
                  stop.arrived_at === undefined
                    ? 'The rider has not arrived.'
                    : formatInstant(stop.arrived_at),
              },
              ...(stop.failure_category === undefined
                ? []
                : [{ label: 'Failure', value: FAILURE_LABELS[stop.failure_category] }]),
              ...(skipLine === undefined ? [] : [{ label: 'Skipped', value: skipLine }]),
            ]}
          />
        </Panel>
      }
    />
  );
}

function Reading({ manifestId, stopId }: { readonly manifestId: string; readonly stopId: string }) {
  const stopQuery = useStop(stopId);
  const stop = stopQuery.data?.stop;
  const request = usePickupRequest(
    stop?.pickup_request_id ?? '',
    stop !== undefined && stop.pickup_summary === undefined,
  );
  // The run is read for its code, which the way back names (a stop carries only the run's id). A run that cannot be read leaves the words: the page does not wait for it or depend on it.
  const run = useManifest(
    manifestId,
    stop?.pickup_manifest_id.toLowerCase() === manifestId.toLowerCase(),
  );

  if (stopQuery.status === 'error') {
    const problem = problemOf(stopQuery.error, { operation: 'getPickupStop' });
    if (problem.kind === 'not-found') return <StopNotFound manifestId={manifestId} />;
    if (problem.kind === 'forbidden' && problem.forbidden === 'outside-hubs') {
      return (
        <>
          <ForbiddenPage kind="outside-hubs" />
          <BackToRun manifestId={manifestId} />
        </>
      );
    }
  }
  // An address that pairs a stop with a manifest that is not its own is a stop that is not there.
  if (
    stopQuery.status === 'success' &&
    stopQuery.data.stop.pickup_manifest_id.toLowerCase() !== manifestId.toLowerCase()
  ) {
    return <StopNotFound manifestId={manifestId} />;
  }

  const code = stop?.pickup_summary?.reference ?? request.data?.request.code;
  const runCode = run.data?.manifest.code;
  // A page that is kept after a read that failed again is a page that is drawn (`ReadState`): the stop is shown as it was read, with a line that says so.
  const stopRecord = drawnData(stopQuery, { operation: 'getPickupStop' });
  return (
    <>
      <title>
        {`${stop === undefined ? 'Stop' : `Stop ${String(stop.sequence)}`} · Melarc Ops Portal`}
      </title>
      {stopRecord !== undefined ? (
        <>
          <RefreshFailed query={stopQuery} operation="getPickupStop" />
          <Stop
            manifestId={manifestId}
            stopId={stopId}
            record={stopRecord}
            runCode={runCode}
            code={code}
          />
        </>
      ) : (
        <>
          <PageHeader
            title="Stop"
            breadcrumb={[
              { label: 'Pickup runs', to: '/manifests' },
              { label: 'The pickup run', to: `/manifests/${manifestId}` },
            ]}
          />
          <ReadState<StopRecord>
            query={stopQuery}
            isEmpty={() => false}
            empty={null}
            loadingLabel="Loading the stop…"
            skeleton={<Skeleton lines={4} />}
            permission="pickup.read"
            capability="see pickup runs"
            operation="getPickupStop"
          >
            {() => null}
          </ReadState>
        </>
      )}
    </>
  );
}

/**
 * A stop of a pickup run (surfaces/ops-portal.md section 7, `/manifests/{id}/stops/{stopId}`; S1.30): the record page of one stop, as `getPickupStop` gave it, with **its parcel photos as they arrive**
 * (`listPickupStopEvidence`, a page at a time): the progress as the server counts it and a tile for each photo, **with no picture**; a photo is fetched only when it is opened, at full size, with
 * an authorization of its own that the page holds only while the photo is open. Where Ops let the count through without photos the stop says who, when and why; where it has not and no count is
 * recorded, the act to do so is offered to a holder of its key. **No photo and no number of them is on any page of the receiving side** (hub-intake.md section 5.3); this is the page that draws them.
 */
export function StopPage() {
  const { id = '', stopId = '' } = useParams();
  if (!UUID.test(id) || !UUID.test(stopId)) {
    return <StopNotFound manifestId={UUID.test(id) ? id : ''} />;
  }
  return <Reading key={stopId} manifestId={id} stopId={stopId} />;
}
