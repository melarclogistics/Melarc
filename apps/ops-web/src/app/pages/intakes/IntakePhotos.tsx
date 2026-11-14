import { useState } from 'react';

import { Button } from '../../../components/ui/button/Button';
import { EvidencePhotoDialog } from '../evidence/EvidencePhotoDialog';
import './intake-pages.css';

/**
 * The photos of a **counted** intake, as a row of buttons, each opening one photo at a time: the photos of the parcels counted at the door (the intake's `parcel_photo_ids`, which a counted intake alone has) and the
 * photos of a finding (its `evidence_ids`). **The one file of the receiving side that opens a photo**: the intake's record page is the only page that draws it, and only from a counted intake, whose shape alone has
 * the identifiers (`test/stop-photos-not-on-the-receiving-side.test.ts` holds both). A photo is fetched only when it is opened, at full size, with an authorization of its own that the page drops when it is closed;
 * no tile has a picture, and no identifier, address or storage key is drawn: a photo is named by its place among its kind.
 */
export function IntakePhotos({
  ids,
  noun,
  label,
}: {
  /** The evidence records of the photos, in the order they were attached. */
  readonly ids: readonly string[];
  /** What each photo is called with its place among them: "Photo of the collection" gives "Photo of the collection 3". */
  readonly noun: string;
  /** Names the list for assistive technology. */
  readonly label: string;
}) {
  const [opened, setOpened] = useState<number | undefined>(undefined);
  const id = opened === undefined ? undefined : ids[opened];
  return (
    <>
      <ul className="intake-photos" aria-label={label}>
        {ids.map((photo, index) => (
          <li key={photo}>
            <Button
              type="button"
              variant="secondary"
              aria-label={`Open ${noun} ${String(index + 1)}`}
              onClick={() => {
                setOpened(index);
              }}
            >
              {`${noun} ${String(index + 1)}`}
            </Button>
          </li>
        ))}
      </ul>
      {opened === undefined || id === undefined ? null : (
        <EvidencePhotoDialog
          key={id}
          evidenceId={id}
          label={`${noun} ${String(opened + 1)}`}
          of="intake"
          onClose={() => {
            setOpened(undefined);
          }}
        />
      )}
    </>
  );
}
