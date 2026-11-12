import { createHash, randomUUID } from 'node:crypto';

import { EVIDENCE_STORE } from '../../../src/platform/auth/ports/evidence-store.port.js';
import type { InProcessEvidenceStore } from '../../../src/platform/evidence/in-process.evidence-store.adapter.js';
import type { ArrangedRider } from './runs.js';
import { API } from './staff-routes.js';
import type { VendorRoutes } from './vendor-routes.js';

/**
 * The photo of a pickup stop as a rider makes one, through the real operations (S1.11: `createEvidence`, the upload to the in-process stand-in, `completeEvidenceUpload`):
 * the evidence a failure report names in `evidence_ids`. Test support: the failure tests need records in each of the states the report must tell apart.
 */

/** A few bytes that begin as a JPEG does. */
export const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

export interface Photo {
  readonly id: string;
  /** The record's `ETag`, as the rider read it. */
  readonly etag: string;
}

interface Ticket {
  readonly evidence: { readonly id: string };
  readonly upload: {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
  };
}

/**
 * A record the rider declared for the stop and uploaded the bytes of. It is `STORED` when `complete` is left as it is, and still `PENDING_UPLOAD` with `complete: false` (the
 * bytes are in the store and the rider never said it was done).
 */
export async function photoOf(
  routes: VendorRoutes,
  rider: ArrangedRider,
  stopId: string,
  options: { readonly complete?: boolean } = {},
): Promise<Photo> {
  const store = routes.kit.app.app.get<InProcessEvidenceStore>(EVIDENCE_STORE, { strict: false });
  const declared = await rider.client.post(
    `${API}/evidence`,
    {
      owner_type: 'PICKUP_STOP',
      owner_id: stopId,
      purpose: 'COLLECTION_PROOF',
      captured_at: new Date(Date.now() - 60_000).toISOString(),
      content_type: 'image/jpeg',
      byte_size: JPEG.length,
      checksum_sha256: createHash('sha256').update(JPEG).digest('hex'),
    },
    { headers: { 'Idempotency-Key': randomUUID() } },
  );
  if (declared.status !== 200)
    throw new Error(`createEvidence answered ${String(declared.status)}`);
  const ticket = declared.json() as Ticket;
  const uploaded = store.redeem({
    method: ticket.upload.method,
    url: ticket.upload.url,
    headers: { ...ticket.upload.headers, 'Content-Length': String(JPEG.length) },
    body: JPEG,
  });
  if (uploaded.status !== 200) throw new Error(`the upload answered ${String(uploaded.status)}`);
  const etag = declared.header('etag') ?? '';
  if (options.complete === false) return { id: ticket.evidence.id, etag };
  const done = await rider.client.post(
    `${API}/evidence/${ticket.evidence.id}/complete`,
    undefined,
    {
      headers: { 'If-Match': etag },
    },
  );
  if (done.status !== 200)
    throw new Error(`completeEvidenceUpload answered ${String(done.status)}`);
  return { id: ticket.evidence.id, etag: done.header('etag') ?? '' };
}
