import { useState } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { Dialog } from '../../../components/ui/dialog/Dialog';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import type { RetrievalAuthorizationView } from '../../../platform/pickup-work/pickup-work-shape';
import { usePhotoAuthorization } from '../../../platform/pickup-work/use-pickup-work-queries';
import { formatInstant } from '../../../platform/time/format-time';
import './evidence-photo.css';

/**
 * The picture of one stored photo, drawn from the address of the one authorization that was issued for it. The picture is read only while the dialog that holds it is open, at full size; the `<img>` sends no
 * header and no referrer, and the address is held by nothing but this element: it is not logged, stored or shown as text. A picture that cannot be loaded (its link ran out, the store did not answer) is told, and
 * the person opens the photo again, which asks again.
 */
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
    <img
      className="stop-photo__image"
      src={authorization.url}
      alt={taken === '' ? label : `${label}, taken ${taken}`}
      referrerPolicy="no-referrer"
      decoding="async"
      onError={() => {
        setBroken(true);
      }}
    />
  );
}

export interface EvidencePhotoDialogProps {
  /** The evidence record of the photo: asked for when the dialog is drawn, for this photo alone. Never drawn. */
  readonly evidenceId: string;
  /** What the photo is called on the screen, in the page's words ("Parcel photo 3"): its place among the photos, never an identifier or an address. */
  readonly label: string;
  /** When it was taken, as an instant, where the page knows it. */
  readonly capturedAt?: string;
  /**
   * Whose photo it is, which is what decides what a refusal to open it says and which key the read asks for: a photo of a stop (the stop's pages) or of an intake (the counted intake's record). The page
   * names no key and writes no words of a refusal.
   */
  readonly of: 'stop' | 'intake';
  readonly onClose: () => void;
}

/**
 * One photo, opened: it asks for the authorization to read **this photo alone** (`createEvidenceRetrievalAuthorization`, five minutes) when it is drawn, and drops it when it is closed, so that opening the photo
 * again asks again. It is drawn only while the officer has it open. **It is the one dialog that opens a photo of evidence**: the stop's page and the receiving side's record both use it, each for the photos it is
 * allowed to show (`test/stop-photos-not-on-the-receiving-side.test.ts` holds the receiving side to its one file).
 */
export function EvidencePhotoDialog({
  evidenceId,
  label,
  capturedAt,
  of,
  onClose,
}: EvidencePhotoDialogProps) {
  const authorization = usePhotoAuthorization(evidenceId, true);
  const taken = capturedAt === undefined ? '' : (formatInstant(capturedAt) ?? '');
  const picture = (data: RetrievalAuthorizationView) => (
    <PhotoImage authorization={data} label={label} taken={taken} />
  );
  return (
    <Dialog
      open
      title={label}
      description={
        taken === ''
          ? 'The photo is read only while this window is open.'
          : `Taken ${taken}. The photo is read only while this window is open.`
      }
      onRequestClose={onClose}
    >
      {/* A stop's photo is read with the key that reads the stop, and a counted intake's with the key that reads the intake: each is refused in its own words (the table has them for both). */}
      {of === 'stop' ? (
        <ReadState<RetrievalAuthorizationView>
          query={authorization}
          isEmpty={() => false}
          empty={null}
          loadingLabel="Opening the photo…"
          permission="pickup.read"
          capability="see pickup runs"
          operation="createEvidenceRetrievalAuthorization"
        >
          {picture}
        </ReadState>
      ) : (
        <ReadState<RetrievalAuthorizationView>
          query={authorization}
          isEmpty={() => false}
          empty={null}
          loadingLabel="Opening the photo…"
          permission="hub.read"
          context="intake"
          operation="createEvidenceRetrievalAuthorization"
        >
          {picture}
        </ReadState>
      )}
      <p className="stop-photo__close">
        <Button type="button" variant="secondary" data-initial-focus onClick={onClose}>
          Close the photo
        </Button>
      </p>
    </Dialog>
  );
}
