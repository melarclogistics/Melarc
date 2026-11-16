import { useState } from 'react';

import { Button } from '../../../components/ui/button/Button';
import { PhotoViewer, type PhotoViewerItem } from '../../../components/ui/photo-viewer/PhotoViewer';
import type { ParcelView } from '../../../platform/hub-receiving/receiving-shape';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { PhotoPicture } from '../evidence/PhotoPicture';
import { stateLine } from './ParcelDialog';
import './receiving-pages.css';

export interface ParcelViewerProps {
  /** The parcels the officer can move among, in the order of their grid: the vendor's parcels, or its missing ones in the summary. */
  readonly parcels: readonly ParcelView[];
  /** The parcel whose photo opens first: the tile the officer pressed. */
  readonly startId: string;
  readonly onClose: () => void;
  /** Opens the dialog of acts on a parcel (check in, find, take back, record damage). Left out where the page offers no act (an officer without the key, the summary's tiles). */
  readonly onAct?: (parcel: ParcelView) => void;
}

/**
 * The photos of a vendor's parcels, one at a time (D-D2, OB-S1-86): the kit's viewer over the parcels of the grid the officer pressed a tile of, with *3 of 12*, next and previous at 56 px, the arrow keys and
 * a swipe. **It decides nothing**: under each photo it says where the parcel stands (the API's state and the officer and the moment it was checked in), and, to an officer who may act, one button that opens the
 * parcel's own dialog, where the acts are. The picture is the page's (`PhotoPicture`, read only while the photo is the one looked at, with an authorization of its own that is let go when the viewer closes).
 */
export function ParcelViewer({ parcels, startId, onClose, onAct }: ParcelViewerProps) {
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      parcels.findIndex((parcel) => parcel.id === startId),
    ),
  );
  const byKey = new Map(parcels.map((parcel) => [parcel.id, parcel]));
  const items: PhotoViewerItem[] = parcels.map((parcel) => ({
    key: parcel.id,
    label: WORDS.parcel.label(parcel.ordinal, parcel.origin === 'HUB_EXTRA'),
    detail: stateLine(parcel),
  }));
  if (items.length === 0) return null;
  return (
    <PhotoViewer
      items={items}
      index={Math.min(index, items.length - 1)}
      onIndexChange={setIndex}
      onClose={onClose}
      renderPicture={(item, { current }) => {
        const parcel = byKey.get(item.key);
        if (parcel === undefined) return null;
        return (
          <>
            <PhotoPicture
              evidenceId={parcel.photo_evidence_id}
              wanted={current}
              size="full"
              alt={item.label}
              reading={{ permission: 'hub.read', context: 'intake' }}
            />
            {current && onAct !== undefined ? (
              <div className="receiving-viewer__act">
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  onClick={() => {
                    onAct(parcel);
                  }}
                >
                  {WORDS.viewer.act}
                </Button>
              </div>
            ) : null}
          </>
        );
      }}
    />
  );
}
