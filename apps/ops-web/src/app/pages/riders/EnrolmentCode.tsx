import { useEffect, useRef } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { QrCode } from '../../../components/ui/qr-code/QrCode';
import type { EnrolmentGrantView } from '../../../platform/rider/rider-shape';
import { formatInstant } from '../../../platform/time/format-time';
import './riders.css';

export interface EnrolmentCodeProps {
  /** The grant, held in memory by the page. Only its URI is drawn, and only as the modules of the picture. */
  readonly grant: EnrolmentGrantView;
  /** The rider scanned it, or the officer is done: the code goes and the page leaves. */
  readonly onFinish: () => void;
  /** Another code is wanted: this one stops working when the new one is made. */
  readonly onNew: () => void;
  readonly renewing: boolean;
}

/**
 * The code an officer shows a rider (surfaces/ops-portal.md section 7, `/admin/riders/{id}/device/register` and `/device`): the enrolment QR,
 * drawn by the S0.39c primitive, and what to do with it. **The QR is the credential.** It is not text on the page, not an attribute, not a link
 * and has no copy button; the page says so and says when it ends. What is guaranteed is narrow and exact: it is short-lived bearer material that
 * the officer's browser must hold to draw it, so a camera or a screenshot can capture it; the officer never receives the rider's PIN or private
 * key, and the code is useless without the handset's hardware attestation.
 */
export function EnrolmentCode({ grant, onFinish, onNew, renewing }: EnrolmentCodeProps) {
  const until = formatInstant(grant.expiresAt);
  const region = useRef<HTMLElement>(null);
  // The button that asked for the code is gone from the page, so focus would fall to the document: it goes to the code's own region, which
  // a screen reader reads from its heading. (The global focus rule draws a ring for a keyboard and not for a mouse.)
  useEffect(() => {
    region.current?.focus();
  }, []);
  return (
    <section ref={region} tabIndex={-1} aria-labelledby="enrolment-code" className="rider-code">
      <h2 id="enrolment-code">Scan this code with the rider’s handset</h2>
      <p>
        On the handset the rider will use, open the Melarc Rider app and scan this code. The rider
        then chooses their own PIN on the handset: you never see it.
      </p>
      <div className="rider-code__picture">
        <QrCode payload={grant.enrolmentUri} label="QR code for the rider’s handset" />
      </div>
      <p>
        The code works once{until === undefined ? '' : `, until ${until}`}. It is shown on this
        screen only and is not kept. Do not photograph it or send it to anyone.
      </p>
      <div className="staff-action__buttons">
        <Button type="button" onClick={onFinish}>
          The rider has scanned it
        </Button>
        <Button type="button" variant="secondary" loading={renewing} onClick={onNew}>
          Make a new code
        </Button>
      </div>
    </section>
  );
}

/** What the page says once a code has lapsed: it is never left on screen, and a new one is offered. */
export function LapsedCode({
  onNew,
  renewing,
}: {
  readonly onNew: () => void;
  readonly renewing: boolean;
}) {
  const notice = useRef<HTMLDivElement>(null);
  // What was on the page (the code, and the button the officer was on) is gone: focus goes to the news, which the alert also announces.
  useEffect(() => {
    notice.current?.focus();
  }, []);
  return (
    <div ref={notice} tabIndex={-1} className="rider-code">
      <Alert variant="danger" announce>
        <p>
          The code has expired and is no longer shown. It can no longer be used. Make a new one when
          the rider is ready.
        </p>
      </Alert>
      <div className="staff-action__buttons">
        <Button type="button" loading={renewing} onClick={onNew}>
          Make a new code
        </Button>
      </div>
    </div>
  );
}
