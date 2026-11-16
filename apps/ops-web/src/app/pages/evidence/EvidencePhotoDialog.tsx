import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { Dialog } from '../../../components/ui/dialog/Dialog';
import { LoadingIndicator } from '../../../components/ui/loading/LoadingIndicator';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { PHOTO_BLOCKED, PHOTO_UNREACHABLE } from '../../../platform/problem/pickup-work-copy';
import type { RetrievalAuthorizationView } from '../../../platform/pickup-work/pickup-work-shape';
import { usePhotoAuthorization } from '../../../platform/pickup-work/use-pickup-work-queries';
import { formatInstant } from '../../../platform/time/format-time';
import './evidence-photo.css';

/**
 * A link with this little time left is as good as run out: the picture is asked for after it, and by then the store would refuse it. It is told when the link arrives, so a link that comes with seconds to
 * live is replaced before the picture is asked for, and never while an officer is looking at a photo that has long since loaded.
 */
const NEARLY_OVER_MS = 15_000;

/**
 * Whether a violation of the browser's policy is this picture's own: the image directive, for the address the picture was asked at (the browser gives the whole address, or only its origin for another
 * origin, so the address starts with what was blocked). A violation of another directive, or of another address, is somebody else's.
 */
function blocksThePicture(event: SecurityPolicyViolationEvent, url: string): boolean {
  const directive = event.effectiveDirective || event.violatedDirective;
  const blocked = event.blockedURI;
  return directive.startsWith('img-src') && blocked !== '' && url.startsWith(blocked);
}

/**
 * The picture of one stored photo, drawn from the address of the authorization that was issued for it. The picture is read only while the dialog that holds it is open, at full size; the `<img>` sends no
 * header and no referrer, and the address is held by nothing but this element: it is not logged, stored or shown as text.
 *
 * **A picture that cannot be loaded is told as what is known of it** (the review of Run B, finding 4). A link lives five minutes and the picture is a request of its own, so the first failure asks for **a new link,
 * once** and draws the photo with it (`renew`: the dialog's, so that the one renewal is the opening's and not each link's); a link that arrives with seconds to live is replaced the same way before the picture
 * is asked for. If the picture fails again, the photo store did not answer and the officer is told so. **A picture the browser's own policy blocked is told as blocked** and no link is asked for: a new link cannot
 * get past a policy, and the browser says so first (a `securitypolicyviolation` of the image directive for this address), which is never told as a link that ran out or a connection that was lost.
 */
function PhotoImage({
  authorization,
  label,
  taken,
  canRenew,
  renew,
  renewing,
}: {
  readonly authorization: RetrievalAuthorizationView;
  readonly label: string;
  readonly taken: string;
  /** Whether the one new link of this opening is still to be asked for. */
  readonly canRenew: boolean;
  readonly renew: () => void;
  /** Whether a new link is being asked for now. */
  readonly renewing: boolean;
}) {
  const [unshown, setUnshown] = useState<'blocked' | 'unreachable' | undefined>(undefined);
  const blocked = useRef(false);
  const { url } = authorization;
  // Told once, when this link arrived: the component is keyed by its link, so a link that was fine then is never judged again by the clock.
  const [nearlyOver] = useState(
    () => canRenew && Date.parse(authorization.expires_at) - Date.now() <= NEARLY_OVER_MS,
  );

  // The browser says that it blocked the picture as an event of the window, which a picture that fails says nothing of: listened for from the moment the picture is asked for (a layout effect runs
  // before the browser has had the chance to report it).
  useLayoutEffect(() => {
    blocked.current = false;
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (blocksThePicture(event, url)) blocked.current = true;
    };
    window.addEventListener('securitypolicyviolation', onViolation);
    return () => {
      window.removeEventListener('securitypolicyviolation', onViolation);
    };
  }, [url]);

  useEffect(() => {
    if (nearlyOver) renew();
  }, [nearlyOver, renew]);

  if (unshown !== undefined) {
    return (
      <Alert variant="danger">
        <p>{unshown === 'blocked' ? PHOTO_BLOCKED : PHOTO_UNREACHABLE}</p>
      </Alert>
    );
  }
  if (nearlyOver || renewing) return <LoadingIndicator label="Opening the photo…" />;
  return (
    <img
      className="stop-photo__image"
      src={url}
      alt={taken === '' ? label : `${label}, taken ${taken}`}
      referrerPolicy="no-referrer"
      decoding="async"
      onError={() => {
        if (blocked.current) setUnshown('blocked');
        else if (canRenew) renew();
        else setUnshown('unreachable');
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
 *
 * **A picture that would not load is asked for again once** (a new authorization: the five minutes may have run out, on a tablet that was put down with the photo open), and the one renewal is this opening's:
 * a second failure is told, and no third link is asked for. A new link that cannot be had is the read's own failure, in its own words.
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
  // One renewal for this opening. A ref beside the state: the development server runs an effect twice, and a second call must not ask again.
  const [renewed, setRenewed] = useState(false);
  const spent = useRef(false);
  const { refetch } = authorization;
  const renew = useCallback(() => {
    if (spent.current) return;
    spent.current = true;
    setRenewed(true);
    void refetch();
  }, [refetch]);
  const picture = (data: RetrievalAuthorizationView) => (
    <PhotoImage
      key={data.url}
      authorization={data}
      label={label}
      taken={taken}
      canRenew={!renewed}
      renew={renew}
      renewing={authorization.isFetching}
    />
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
