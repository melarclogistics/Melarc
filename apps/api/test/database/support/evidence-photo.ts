import { createHash, randomUUID } from 'node:crypto';

import { EVIDENCE_STORE } from '../../../src/platform/auth/ports/evidence-store.port.js';
import type { InProcessEvidenceStore } from '../../../src/platform/evidence/in-process.evidence-store.adapter.js';
import { BUNDLE_IDS } from '../../../src/tools/seed/bundles.js';
import type { ArrangedRider } from './runs.js';
import { API, HUB_A } from './staff-routes.js';
import type { VendorRoutes } from './vendor-routes.js';

/**
 * The photo of a pickup stop as a rider makes one, through the real operations (S1.11: `createEvidence`, the upload to the in-process stand-in, `completeEvidenceUpload`):
 * the evidence a failure report names in `evidence_ids`, and (D-A10) the photo of each parcel a count names in `parcel_photo_ids`. Test support: the failure and the count tests
 * need records in each of the states the report must tell apart.
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
 * bytes are in the store and the rider never said it was done). The purpose is the proof of a collection (a failure's photo, or a short count's reason) unless the test says it is
 * the photo of a parcel.
 */
export async function photoOf(
  routes: VendorRoutes,
  rider: ArrangedRider,
  stopId: string,
  options: {
    readonly complete?: boolean;
    readonly purpose?: 'COLLECTION_PROOF' | 'PARCEL_PHOTO';
  } = {},
): Promise<Photo> {
  const store = routes.kit.app.app.get<InProcessEvidenceStore>(EVIDENCE_STORE, { strict: false });
  const declared = await rider.client.post(
    `${API}/evidence`,
    {
      owner_type: 'PICKUP_STOP',
      owner_id: stopId,
      purpose: options.purpose ?? 'COLLECTION_PROOF',
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

/** The photos of `count` parcels of a stop, each a stored `PARCEL_PHOTO` of the rider, made one after the other (D-A10); the ids a count names in `parcel_photo_ids`. */
export async function parcelPhotosOf(
  routes: VendorRoutes,
  rider: ArrangedRider,
  stopId: string,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let each = 0; each < count; each += 1) {
    ids.push((await photoOf(routes, rider, stopId, { purpose: 'PARCEL_PHOTO' })).id);
  }
  return ids;
}

/**
 * Ops lets the stop's count through without parcel photos, arranged directly for a test about something other than the photos (the guards are off for the one statement, as the
 * tests age a row): the count of such a stop takes none, and the test need not make one photo for each parcel. The officer is a staff member of the database (one is made if it holds none).
 * A test about the exception itself uses `authoriseParcelPhotoException`, never this.
 */
export async function excusePhotos(routes: VendorRoutes, stopId: string): Promise<void> {
  let officer = (
    await routes.admin.query<{ id: string }>(
      `select id from staff_identity order by created_at limit 1`,
    )
  ).rows[0]?.id;
  if (officer === undefined) {
    officer = (await routes.actor(BUNDLE_IDS.opsStaff, HUB_A)).identity.id;
  }
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(
      `insert into parcel_photo_exception (id, pickup_stop_id, responsible_hub_id, authorised_by, authorised_at, note)
       select gen_random_uuid(), s.id, s.responsible_hub_id, $2::uuid, clock_timestamp(), 'arranged by the test'
         from pickup_stop as s where s.id = $1
       on conflict (pickup_stop_id) do nothing`,
      [stopId, officer],
    );
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback').catch(() => undefined);
    throw error;
  }
}
