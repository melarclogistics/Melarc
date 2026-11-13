import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { useState } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { Dialog } from '../../../components/ui/dialog/Dialog';
import { Panel } from '../../../components/ui/panel/Panel';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import type {
  ParcelPhotoExceptionView,
  ParcelPhotoProgressView,
  RetrievalAuthorizationView,
  StopEvidenceItemView,
  StopEvidencePageView,
} from '../../../platform/pickup-work/pickup-work-shape';
import { usePhotoAuthorization } from '../../../platform/pickup-work/use-pickup-work-queries';
import { problemOf } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { actorText } from '../pickup/pickup-presentation';
import { EVIDENCE_STATE_MAP, countText } from '../pickup-work/pickup-work-presentation';
import './stop-photos.css';

/** What a read of a stop's evidence is, as the infinite query gives it: the pages read so far, each with the progress of the whole stop. */
export type EvidenceRead = UseInfiniteQueryResult<
  InfiniteData<StopEvidencePageView, string | undefined>
>;

/** One photo, named for the officer who opens it: its place among the photos of its kind, never an identifier or an address. */
interface Tile {
  readonly item: StopEvidenceItemView;
  readonly label: string;
}

/** The same record on two pages is one photo (a record the cursor read twice must not be drawn twice). */
function distinct(items: readonly StopEvidenceItemView[]): StopEvidenceItemView[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.id.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The progress of the stop's parcel photos **as the server counts it for the whole stop**: *12 of 12 uploaded*, with the ones still waiting and the ones that never came told apart, and an
 * expired record never counted as uploaded. The page works out none of it. A stop with no photo made says so; it never says "0 of 0 uploaded", which would read as an answer that a read that
 * failed could also give.
 */
function ProgressLine({ progress }: { readonly progress: ParcelPhotoProgressView }) {
  const parts = [
    progress.declared === 0
      ? 'No parcel photo is stored or waiting to upload.'
      : `${String(progress.stored)} of ${String(progress.declared)} parcel photos uploaded.`,
    ...(progress.pending === 0
      ? []
      : [`${countText(progress.pending, 'photo is', 'photos are')} still waiting to upload.`]),
    ...(progress.expired === 0
      ? []
      : [
          `${countText(progress.expired, 'photo', 'photos')} never uploaded: the time to upload ran out.`,
        ]),
  ];
  return <p className="stop-photos__progress">{parts.join(' ')}</p>;
}

/**
 * Where Ops let the stop's count through without parcel photos, the stop says **who, when and why**. The officer is not named: the answer carries an identifier and the portal reads no staff directory.
 */
function ExceptionNote({ exception }: { readonly exception: ParcelPhotoExceptionView }) {
  const me = useSignedInSession();
  const when = formatInstant(exception.authorised_at);
  return (
    <div className="stop-photos__exception">
      <h3 className="stop-photos__heading">Counted without parcel photos</h3>
      <p>
        {`${actorText(exception.authorised_by, me?.session.principal_id)} let this stop’s count through without parcel photos${when === undefined ? '' : ` on ${when}`}.`}
      </p>
      <p>{`Why: ${exception.note}`}</p>
    </div>
  );
}

/** What a tile says of the scan: a stored photo is only ever shown to be opened once the malicious-content check found it clean. */
function scanText(item: StopEvidenceItemView): string {
  if (item.scanned_clean) return 'The scan found it clean.';
  return item.state === 'STORED'
    ? 'The scan has not found it clean, so it cannot be opened.'
    : 'It is scanned once its upload is complete.';
}

/**
 * One photo of a stop, shown **without its picture**: the picture is fetched only when the officer opens it. A photo that is not stored yet is shown as waiting, and cannot be opened.
 */
function PhotoTile({ tile, onOpen }: { readonly tile: Tile; readonly onOpen: () => void }) {
  const { item, label } = tile;
  const canOpen = item.state === 'STORED' && item.scanned_clean;
  return (
    <li className="stop-photo">
      <p className="stop-photo__title">{label}</p>
      <p className="stop-photo__support">
        {`Taken ${formatInstant(item.captured_at) ?? ''}`.trim()}
      </p>
      <p>
        <StatusBadge status={item.state} map={EVIDENCE_STATE_MAP} />
      </p>
      <p className="stop-photo__support">{scanText(item)}</p>
      {canOpen ? (
        <Button type="button" variant="secondary" aria-label={`Open ${label}`} onClick={onOpen}>
          Open photo
        </Button>
      ) : null}
    </li>
  );
}

function PhotoImage({
  authorization,
  label,
  taken,
}: {
  readonly authorization: RetrievalAuthorizationView;
  readonly label: string;
  readonly taken: string;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <Alert variant="danger">
        <p>
          The photo could not be shown: its link may have run out, or the photo store did not
          answer. Close it and open it again.
        </p>
      </Alert>
    );
  }
  return (
    // The picture is read only while this dialog is open, at full size, from the address this one authorization gave. The `<img>` sends no header and no referrer, and the address is held by nothing
    // but this element: it is not logged, stored or shown as text.
    <img
      className="stop-photo__image"
      src={authorization.url}
      alt={`${label}, taken ${taken}`}
      referrerPolicy="no-referrer"
      decoding="async"
      onError={() => {
        setBroken(true);
      }}
    />
  );
}

/**
 * One photo, opened: it asks for the authorization to read **this photo alone** (`createEvidenceRetrievalAuthorization`, five minutes) when it is drawn, and drops it when it is closed, so that opening
 * the photo again asks again. It is drawn only while the officer has it open.
 */
function PhotoDialog({ tile, onClose }: { readonly tile: Tile; readonly onClose: () => void }) {
  const authorization = usePhotoAuthorization(tile.item.id, true);
  const taken = formatInstant(tile.item.captured_at) ?? '';
  return (
    <Dialog
      open
      title={tile.label}
      description={
        taken === ''
          ? 'The photo is read only while this window is open.'
          : `Taken ${taken}. The photo is read only while this window is open.`
      }
      onRequestClose={onClose}
    >
      <ReadState<RetrievalAuthorizationView>
        query={authorization}
        isEmpty={() => false}
        empty={null}
        loadingLabel="Opening the photo…"
        permission="pickup.read"
        capability="see pickup runs"
        operation="createEvidenceRetrievalAuthorization"
      >
        {(data) => <PhotoImage authorization={data} label={tile.label} taken={taken} />}
      </ReadState>
      <p className="stop-photo__close">
        <Button type="button" variant="secondary" data-initial-focus onClick={onClose}>
          Close the photo
        </Button>
      </p>
    </Dialog>
  );
}

/** The tiles of one kind of evidence, each named by its place among its kind. */
function tilesOf(
  items: readonly StopEvidenceItemView[],
  purpose: StopEvidenceItemView['purpose'],
  noun: string,
): Tile[] {
  return items
    .filter((item) => item.purpose === purpose)
    .map((item, index) => ({ item, label: `${noun} ${String(index + 1)}` }));
}

function Photos({
  evidence,
  data,
}: {
  readonly evidence: EvidenceRead;
  readonly data: InfiniteData<StopEvidencePageView, string | undefined>;
}) {
  const [opened, setOpened] = useState<Tile | undefined>(undefined);
  const freshest = data.pages.at(-1);
  if (freshest === undefined) return null;
  const items = distinct(data.pages.flatMap((page) => page.items));
  const parcel = tilesOf(items, 'PARCEL_PHOTO', 'Parcel photo');
  const proof = tilesOf(items, 'COLLECTION_PROOF', 'Photo of the failure or short count');
  const moreFailed = evidence.isFetchNextPageError;

  return (
    <>
      {freshest.parcel_photo_exception === null ? null : (
        <ExceptionNote exception={freshest.parcel_photo_exception} />
      )}
      <ProgressLine progress={freshest.parcel_photos} />
      {items.length === 0 ? <p>No photos have arrived for this stop yet.</p> : null}
      {parcel.length === 0 ? null : (
        <section aria-label="Parcel photos" className="stop-photos__group">
          <h3 className="stop-photos__heading">Parcel photos</h3>
          <ul className="stop-photos__list">
            {parcel.map((tile) => (
              <PhotoTile
                key={tile.item.id}
                tile={tile}
                onOpen={() => {
                  setOpened(tile);
                }}
              />
            ))}
          </ul>
        </section>
      )}
      {proof.length === 0 ? null : (
        <section aria-label="Photos of the failure or short count" className="stop-photos__group">
          <h3 className="stop-photos__heading">Evidence of a failure or a short count</h3>
          <ul className="stop-photos__list">
            {proof.map((tile) => (
              <PhotoTile
                key={tile.item.id}
                tile={tile}
                onOpen={() => {
                  setOpened(tile);
                }}
              />
            ))}
          </ul>
        </section>
      )}
      {moreFailed ? (
        <Alert variant="danger" announce>
          <p>
            {problemOf(evidence.error, { operation: 'listPickupStopEvidence' }).message} The photos
            shown are those that were loaded.
          </p>
        </Alert>
      ) : null}
      {evidence.hasNextPage ? (
        <p className="stop-photos__more">
          <Button
            type="button"
            variant="secondary"
            loading={evidence.isFetchingNextPage}
            onClick={() => {
              void evidence.fetchNextPage();
            }}
          >
            {moreFailed ? 'Try to load more photos again' : 'Load more photos'}
          </Button>
        </p>
      ) : null}
      {opened === undefined ? null : (
        <PhotoDialog
          key={opened.item.id}
          tile={opened}
          onClose={() => {
            setOpened(undefined);
          }}
        />
      )}
    </>
  );
}

/**
 * The parcel photos of a stop as they arrive (surfaces/ops-portal.md section 7, `/manifests/{id}/stops/{stopId}`; S1.30): the progress as the server counts it, and a tile for each photo with when it was
 * taken, whether it is stored and whether the scan found it clean, **without a picture**. A photo is fetched only when it is opened, at full size, with an authorization of its own, and the page reads
 * the list a page at a time, so a stop of two hundred photos costs it two reads of the largest page and nothing else until a photo is opened. **No photo and no number of them is on any page of the
 * receiving side** (the hub's blind count, hub-intake.md section 5.3): this is the one page that draws them, and `test/stop-photos-not-on-the-receiving-side.test.ts` holds it to that.
 */
export function StopPhotos({ evidence }: { readonly evidence: EvidenceRead }) {
  // A failure of *more* photos must not take the photos that were loaded away: once there is data, the read is a success for the page, and the failure is told beside the button.
  const query = {
    status: evidence.data === undefined ? evidence.status : ('success' as const),
    data: evidence.data,
    error: evidence.error,
    refetch: evidence.refetch,
    isFetching: evidence.isFetching,
  };
  return (
    <Panel title="Photos" headingLevel={2} region>
      <ReadState<InfiniteData<StopEvidencePageView, string | undefined>>
        query={query}
        isEmpty={() => false}
        empty={null}
        loadingLabel="Loading the photos…"
        skeleton={<Skeleton lines={3} />}
        permission="pickup.read"
        capability="see pickup runs"
        operation="listPickupStopEvidence"
      >
        {(data) => <Photos evidence={evidence} data={data} />}
      </ReadState>
    </Panel>
  );
}
