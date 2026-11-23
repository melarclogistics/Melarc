import { useNearViewport } from '../../../components/ui/photo-grid/use-near-viewport';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { PhotoPicture } from '../evidence/PhotoPicture';
import './orders-pages.css';

/** The record of the photo of a parcel: the rider's door photo, or the photo taken at the hub for a parcel that was not on the list. A parcel has one or the other, and the identifier is never drawn. */
export interface ParcelPhotoRef {
  readonly door_photo_evidence_id: string | null;
  readonly hub_photo_evidence_id: string | null;
}

/** The record to ask for the photo of, if the parcel has one. */
export const photoOf = (parcel: ParcelPhotoRef | null): string | undefined =>
  parcel === null
    ? undefined
    : (parcel.door_photo_evidence_id ?? parcel.hub_photo_evidence_id ?? undefined);

/**
 * The photo of a parcel on the order screens (D-D6: the order is made for a parcel and the parcel's photo is the order's, so it sits beside the form): in a list (`tile`) it is a small picture asked for only
 * when its row is near the screen; open (`full`) it is the photo whole, asked for while it is wanted. **It is the parcel's own photo, drawn by the kit's picture from the identifier the parcel carries**,
 * and the identifier is never drawn: a parcel with no photo is told as one, and a refusal to read the photo is told in the words of the table.
 */
export function OrderPhoto({
  parcel,
  size,
  alt,
}: {
  readonly parcel: ParcelPhotoRef | null;
  readonly size: 'tile' | 'full';
  readonly alt: string;
}) {
  const [watch, near] = useNearViewport<HTMLSpanElement>();
  const evidenceId = photoOf(parcel);
  if (evidenceId === undefined) {
    return size === 'full' ? (
      <p className="orders-photo__none">{WORDS.workspace.panel.noPhoto}</p>
    ) : (
      <span className="orders-photo__none" aria-hidden="true" />
    );
  }
  if (size === 'full') {
    return (
      <PhotoPicture
        evidenceId={evidenceId}
        wanted
        size="full"
        alt={alt}
        reading={{ permission: 'hub.read', context: 'intake' }}
      />
    );
  }
  return (
    <span ref={watch} className="orders-photo__tile">
      <PhotoPicture evidenceId={evidenceId} wanted={near} size="tile" />
    </span>
  );
}
