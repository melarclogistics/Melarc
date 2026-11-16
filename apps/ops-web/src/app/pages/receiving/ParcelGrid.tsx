import {
  PhotoGrid,
  type PhotoGridItem,
  type PhotoTileState,
} from '../../../components/ui/photo-grid/PhotoGrid';
import type { ParcelView } from '../../../platform/hub-receiving/receiving-shape';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { PhotoPicture } from '../evidence/PhotoPicture';
import './receiving-pages.css';

/** Whether a parcel has a condition recorded that is not "looks fine": the parcel is damaged, tampered with or has another problem. */
export const isFlagged = (parcel: ParcelView): boolean =>
  parcel.condition !== null && parcel.condition.condition !== 'OK';

/**
 * What a tile says of its parcel, in an icon **and** words, never in colour alone (the grid draws both): checked in (ticked), missing and damaged (marked, they need someone), taken back (set apart). A parcel
 * not yet checked in has no mark: its tile is the photo, and the tile's name says which parcel it is. While the officer is tapping, a tile is a toggle and says whether it is on, so a parcel that is checked
 * in and damaged stays on (and says damaged); once the vendor is finished the same parcel is marked as damaged.
 */
export function tileOf(parcel: ParcelView, tapping: boolean): PhotoTileState {
  switch (parcel.state) {
    case 'EXPECTED':
      return { kind: 'normal' };
    case 'ARRIVED':
      if (isFlagged(parcel)) {
        return tapping
          ? { kind: 'selected', label: WORDS.parcel.tile.checkedInDamaged }
          : { kind: 'marked', label: WORDS.parcel.tile.damaged };
      }
      return { kind: 'selected', label: WORDS.parcel.tile.checkedIn };
    case 'MISSING':
      return { kind: 'marked', label: WORDS.parcel.tile.missing };
    case 'VOID':
      return { kind: 'dimmed', label: WORDS.parcel.tile.takenBack };
  }
}

export interface ParcelGridProps {
  /** Names the list for assistive technology ("Photos of Kente Crafts’s parcels"). */
  readonly label: string;
  readonly parcels: readonly ParcelView[];
  /** The officer is checking parcels in: a tile is a toggle that checks a parcel in or takes it back. Otherwise a tile opens its parcel. */
  readonly tapping?: boolean;
  /** A tile was pressed. Left out, the grid only shows the photos (the confirmation of "All N here"). */
  readonly onPress?: (parcel: ParcelView) => void;
}

/**
 * The photos of a vendor's parcels as the grid of tiles (D-D1, D-D2): a tile for each parcel, in the order the door photos were taken and the extras after them, with its place as a badge. The grid decides
 * nothing: **what a tile says is the API's state of its parcel** and a press is told to the page, which acts on it. A parcel taken back (an extra the officer voided) cannot be checked in again, so its tile is
 * not a toggle while the officer is tapping.
 */
export function ParcelGrid({ label, parcels, tapping = false, onPress }: ParcelGridProps) {
  const byKey = new Map(parcels.map((parcel) => [parcel.id, parcel]));
  const items: PhotoGridItem[] = parcels.map((parcel) => ({
    key: parcel.id,
    label: WORDS.parcel.label(parcel.ordinal, parcel.origin === 'HUB_EXTRA'),
    state: tileOf(parcel, tapping),
    badge: String(parcel.ordinal),
    // A parcel taken back cannot be checked in again, so it is not a toggle. (A tile is never disabled while its tap is on its way: a disabled button loses the focus, and the page ignores a second press instead.)
    disabled: tapping && parcel.state === 'VOID',
  }));
  return (
    <PhotoGrid
      label={label}
      items={items}
      selectable={tapping}
      renderPicture={(item, { near }) => {
        const parcel = byKey.get(item.key);
        return parcel === undefined ? null : (
          <PhotoPicture evidenceId={parcel.photo_evidence_id} wanted={near} size="tile" />
        );
      }}
      {...(onPress === undefined
        ? {}
        : {
            onSelect: (item: PhotoGridItem) => {
              const parcel = byKey.get(item.key);
              if (parcel !== undefined) onPress(parcel);
            },
          })}
    />
  );
}
