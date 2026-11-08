import { createHash } from 'node:crypto';

import { stopRepresentationOf } from './pickup-manifest-etag.js';
import type { PickupStopView } from './pickup-manifest-view.js';

/**
 * The ETag of a pickup stop (S1.22; domain-model.md section 6.4): an **opaque strong validator of what the answer returned**, modelled on the
 * manifest's (`pickup-manifest-etag.ts`) and made of the same members. It is the digest of the **complete representation** of the stop and of
 * its **durable version** (`version`, which the database moves for any change to the row), so it changes when anything the caller was shown
 * changes and when anything else about the row does. `arriveAtPickupStop` hands it back; the acts on a stop that take it as `If-Match` compare it
 * with the token recomputed from the stop under its lock.
 *
 * It is opaque: the digest names no version and no field, and a client treats it as a string to send back. It is a different token from the
 * manifest's even for a manifest of one stop, because the two are made under different domains.
 */
const DOMAIN = 'melarc.pickup-stop-etag.v1';

/** The ETag of a stop as it is answered, and of the version of its row. */
export function pickupStopEtagOf(view: PickupStopView, version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RangeError('A record version is a non-negative safe integer');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([DOMAIN, version, ...stopRepresentationOf(view)]), 'utf8')
    .digest('base64url');
  return `"${digest}"`;
}
