import { useMemo } from 'react';

import { encodeQr, QR_QUIET_ZONE, type ErrorCorrection, type QrMatrix } from './qr-matrix';
import './qr-code.css';

export interface QrCodeProps {
  /** What the code says. A transient credential: it is drawn as modules and written nowhere else on the page. */
  readonly payload: string;
  /** The accessible name of the picture: what it is for ("QR code for your authenticator app"). Never the payload. */
  readonly label: string;
  /** Recovers this much damage: `L` 7%, `M` 15%, `Q` 25%, `H` 30%. */
  readonly errorCorrection?: ErrorCorrection;
}

/** The smallest a module is drawn, in CSS pixels, before the container makes it smaller. */
const MODULE_PIXELS = 4;

/** One rectangle for each unbroken run of dark modules in a row: `M x,y h n v 1 h -n z`. */
function pathOf(matrix: QrMatrix): string {
  const parts: string[] = [];
  matrix.modules.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x += 1) {
      const dark = x < row.length && row[x] === true;
      if (dark && start < 0) start = x;
      if (!dark && start >= 0) {
        const length = x - start;
        parts.push(
          `M${String(start + QR_QUIET_ZONE)},${String(y + QR_QUIET_ZONE)}h${String(length)}v1h-${String(length)}z`,
        );
        start = -1;
      }
    }
  });
  return parts.join('');
}

/**
 * A QR code, drawn as an inline SVG from a matrix computed here (S0.39c; plan section 11.2). It needs no remote service,
 * no canvas and no image file, and nothing in it is script or style the page's Content-Security-Policy would refuse: the
 * colours come from the stylesheet, as classes.
 *
 * It is a picture and not a control: not focusable, and not a link (a payload is never offered as a navigable
 * `otpauth` link). Its accessible name is `label`, and the payload is in no attribute, title or text of the page; the
 * only form of it on the screen is the modules a camera reads. It is always dark on light with a light quiet zone, even in
 * forced-colours mode, because a scanner needs exactly that.
 *
 * A payload that cannot be drawn (empty, or too long for a code a camera can read at this size) throws a
 * `QrCodeError` that does not contain it; the screen's error boundary shows its error state.
 */
export function QrCode({ payload, label, errorCorrection = 'M' }: QrCodeProps) {
  const matrix = useMemo(() => encodeQr(payload, errorCorrection), [payload, errorCorrection]);
  const path = useMemo(() => pathOf(matrix), [matrix]);
  const modules = matrix.size + 2 * QR_QUIET_ZONE;
  const pixels = modules * MODULE_PIXELS;

  return (
    <svg
      className="ui-qr"
      role="img"
      aria-label={label}
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${String(modules)} ${String(modules)}`}
      width={pixels}
      height={pixels}
      preserveAspectRatio="xMidYMid meet"
      shapeRendering="crispEdges"
    >
      <rect className="ui-qr__background" width={modules} height={modules} />
      <path className="ui-qr__modules" d={path} />
    </svg>
  );
}
