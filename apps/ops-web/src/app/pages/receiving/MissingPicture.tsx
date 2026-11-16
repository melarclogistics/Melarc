import { useNearViewport } from '../../../components/ui/photo-grid/use-near-viewport';
import type { MissingParcelView } from '../../../platform/hub-receiving/receiving-shape';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { PhotoPicture } from '../evidence/PhotoPicture';
import './receiving-pages.css';

/**
 * The photo of a missing parcel, in the list of parcels being searched for (D-D4), so that the officer who is looking for the parcel can see what it looks like. In its row (`tile`) it is a small picture that
 * is asked for only when the row is near the screen; in the panel of the row (`full`) it is the photo whole, asked for while the panel is open. **It is the parcel's own photo, drawn by the kit's picture**: the
 * identifier of the photo is never drawn, and a refusal to read it is told in the words of the table.
 */
export function MissingPicture({
  item,
  size,
}: {
  readonly item: MissingParcelView;
  readonly size: 'tile' | 'full';
}) {
  const [watch, near] = useNearViewport<HTMLSpanElement>();
  if (size === 'full') {
    return (
      <PhotoPicture
        evidenceId={item.photo_evidence_id}
        wanted
        size="full"
        alt={WORDS.missingList.photoOf(item.vendor_name)}
        reading={{ permission: 'hub.read', context: 'intake' }}
      />
    );
  }
  return (
    <span ref={watch} className="receiving-missing__picture">
      <PhotoPicture evidenceId={item.photo_evidence_id} wanted={near} size="tile" />
    </span>
  );
}
