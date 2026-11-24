import { useState } from 'react';

import { PhotoGrid } from '../../../components/ui/photo-grid/PhotoGrid';
import { PhotoViewer } from '../../../components/ui/photo-viewer/PhotoViewer';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { PhotoPicture } from '../evidence/PhotoPicture';
import './orders-pages.css';

/**
 * The photo of the parcel an order is made for, on the order's page and on the change page (D-S7-14, the Product Owner's decision of 24 November 2026): **a tile, and the photo opened whole on a tap** in the kit's
 * photo viewer, so that an officer checks the order against the parcel. The tile is the kit's one-tile grid (a button for the keyboard and the finger, named *Photo of the parcel*), asked for only when it is near
 * the screen, and the photo whole is asked for while the viewer is open (the tile and the viewer share one link for the one photo, which the platform lets go when neither wants it); the focus goes back to the tile. **The page draws it only for an officer who
 * may read photos and only where the order carries one**: the identifier of the record is never drawn, and nothing is zoomed or turned here (the next run adds both). The photo is the API's: this
 * decides nothing.
 */
export function ParcelPhotoOpener({ evidenceId }: { readonly evidenceId: string }) {
  const [open, setOpen] = useState(false);
  const label = WORDS.form.photoOf;
  return (
    <>
      <PhotoGrid
        label={WORDS.record.sections.photo}
        items={[{ key: evidenceId, label }]}
        renderPicture={(_item, { near }) => (
          <PhotoPicture evidenceId={evidenceId} wanted={near} size="tile" />
        )}
        onSelect={() => {
          setOpen(true);
        }}
      />
      {open ? (
        <PhotoViewer
          items={[{ key: evidenceId, label }]}
          index={0}
          onIndexChange={() => undefined}
          onClose={() => {
            setOpen(false);
          }}
          renderPicture={(item, { current }) => (
            <PhotoPicture
              evidenceId={evidenceId}
              wanted={current}
              size="full"
              alt={item.label}
              reading={{ permission: 'hub.read', context: 'intake' }}
            />
          )}
        />
      ) : null}
    </>
  );
}
