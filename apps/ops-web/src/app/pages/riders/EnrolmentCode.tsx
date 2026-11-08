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
  /** Another code is wanted: this one leaves the screen as it is asked for, and stops working once the new one is made. */
  readonly onNew: () => void;
}

/**
 * The code an officer shows a rider (surfaces/ops-portal.md section 7, `/admin/riders/{id}/device/register` and `/device`): the enrolment QR,
 * drawn by the S0.39c primitive, and what to do with it. **The QR is the credential.** It is not text on the page, not an attribute, not a link
 * and has no copy button; the page says so and says when it ends. What is guaranteed is narrow and exact: it is short-lived bearer material that
 * the officer's browser must hold to draw it, so a camera or a screenshot can capture it; the officer never receives the rider's PIN or private
 * key, and the code is useless without the handset's hardware attestation.
 */
export function EnrolmentCode({ grant, onFinish, onNew }: EnrolmentCodeProps) {
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
        <Button type="button" variant="secondary" onClick={onNew}>
          Make a new code
        </Button>
      </div>
    </section>
  );
}

/**
 * What the page says once a code has lapsed: it is never left on screen, and a new one is offered. **The words say what the page did and claim
 * nothing of the server.** The page stops showing a code at the lesser of its lifetime and its own limit for holding a secret
 * (`MAX_HOLD_MS`), and the grant can outlive that limit, so "expired" or "can no longer be used" would be a statement about the server that the
 * page cannot make.
 */
export function LapsedCode({ onNew }: { readonly onNew: () => void }) {
  const notice = useRef<HTMLDivElement>(null);
  // What was on the page (the code, and the button the officer was on) is gone: focus goes to the news, which the alert also announces.
  useEffect(() => {
    notice.current?.focus();
  }, []);
  return (
    <div ref={notice} tabIndex={-1} className="rider-code">
      <Alert variant="danger" announce>
        <p>The QR code is no longer displayed. Make a new code when the rider is ready.</p>
      </Alert>
      <div className="staff-action__buttons">
        <Button type="button" onClick={onNew}>
          Make a new code
        </Button>
      </div>
    </div>
  );
}

/**
 * What the page says while a new code is asked for and the one that was on the screen is not: it was taken off the screen when the officer asked.
 * **That ends nothing.** The server ends the earlier code when it makes the new one, and when the answer is lost the new one may already have been
 * made, so the words say what the page did and what ends a code, and no more. The code and the button the officer pressed are gone from the page,
 * so focus goes to these words, where a screen reader reads them and the officer is not dropped at the top of the document.
 */
export function WithdrawnCode() {
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    notice.current?.focus();
  }, []);
  return (
    <div ref={notice} tabIndex={-1} className="staff-notice">
      <p className="staff-action__text">
        The earlier code is no longer shown. Taking it off the screen does not end it; making a new
        code does.
      </p>
    </div>
  );
}
