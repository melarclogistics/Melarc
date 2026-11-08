import { encode } from 'uqr';

/**
 * The one place the QR encoder (`uqr`, exactly pinned) is imported. Nothing else in the application knows which library
 * draws the modules, so changing it is a change to this file and the decoder-backed tests, and nothing else.
 *
 * The payload is a transient credential (plan section 11.2): it is encoded here, in memory, and never sent anywhere. The
 * library is a pure function of its input: no network, no storage, no DOM.
 */

/** The quiet zone the standard requires on every side of the code, in modules. */
export const QR_QUIET_ZONE = 4;

/**
 * The largest QR version the component draws. Version 12 is 65 modules wide: with the quiet zone and four pixels to a
 * module it is 292 pixels, which fits a 320-pixel screen without shrinking below the size a camera can read. A payload
 * that needs more is refused rather than drawn too small.
 */
export const QR_MAX_VERSION = 12;

export type ErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
  /** Modules on a side, without the quiet zone. */
  readonly size: number;
  /** `modules[row][column]` is true for a dark module. */
  readonly modules: readonly (readonly boolean[])[];
}

/** The payload cannot be shown as a code a camera can read. The message never holds the payload. */
export class QrCodeError extends Error {
  override name = 'QrCodeError';
}

/**
 * Encodes a payload. Error correction `M` (recovers about 15% damage) is the default: a screen is a clean medium, and a
 * higher level makes a bigger code for the same text.
 */
export function encodeQr(payload: string, errorCorrection: ErrorCorrection = 'M'): QrMatrix {
  if (payload === '') throw new QrCodeError('QR code: there is nothing to encode.');
  try {
    const { data, size } = encode(payload, {
      ecc: errorCorrection,
      maxVersion: QR_MAX_VERSION,
      border: 0,
      boostEcc: false,
    });
    return { size, modules: data };
  } catch {
    // The library's own message can name the data; ours does not.
    throw new QrCodeError(
      `QR code: the payload does not fit in a code of version ${String(QR_MAX_VERSION)} or smaller.`,
    );
  }
}
