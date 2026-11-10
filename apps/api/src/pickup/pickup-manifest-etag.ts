import { createHash } from 'node:crypto';

import type { PickupManifestView, PickupStopView } from './pickup-manifest-view.js';

/**
 * The ETag of a manifest (S1.20; domain-model.md section 6.3; `AC-SLICE-001-11`): an **opaque strong validator of what the read returned**,
 * modelled on the pickup request's (`pickup-request-etag.ts`). It is the digest of the **complete representation** the read answers, the
 * stops in their order included (but for the moment the run was made, which never changes: `LeftOutOfTheDigest`), and of the
 * manifest's **durable version** (`version`, which the database moves for any change to the row). So it changes when anything the
 * caller was shown changes, **a stop's place in the order among it**, and when anything else about the row does. The operations of
 * S1.21 that take it back as `If-Match` compare it under the manifest's lock against the ETag recomputed in that transaction.
 *
 * It is opaque: the digest names no version and no field, and a client treats it as a string to send back. The header is read strictly:
 * exactly one strong quoted token of this form, equal to the current one.
 *
 * A view without its stops has no ETag: the list of manifests carries none, and a token made of the manifest alone would not move when
 * a stop did.
 */
const DOMAIN = 'melarc.pickup-manifest-etag.v1';

/**
 * Every member of a stop, in the order that is hashed. The record type has exactly the keys of the view, so a member added to the view (or
 * taken from it) stops this file from building until the digest says what it does about it.
 */
export function stopRepresentationOf(stop: PickupStopView): readonly unknown[] {
  const fields: Record<keyof PickupStopView, unknown> = {
    id: stop.id,
    pickup_manifest_id: stop.pickup_manifest_id,
    pickup_request_id: stop.pickup_request_id,
    sequence: stop.sequence,
    state: stop.state,
    arrived_at: stop.arrived_at,
    failure_category: stop.failure_category,
    failure: stop.failure,
    skipped: stop.skipped,
    pickup_summary: stop.pickup_summary ?? null,
  };
  return Object.values(fields);
}

/**
 * The members of the view the digest leaves out, and why (run 6, Stage 1.2). `created_at` is the moment the run was made: set once by the database and never changed, so it tells a
 * client nothing that the version does not. Contract 5.100.0 added it to the view and the digest took it in, which moved the ETag of every run at that release; but a rolling release
 * (architecture/DEPLOYMENT_AND_ENVIRONMENTS.md section 7) serves the build before and the build after side by side against one database,
 * and a run read through one and acted on through the other was refused as stale on every assign, dispatch, cancel and stop order until the old build had drained. Leaving it out
 * keeps the ETag of a run exactly what the build before computed (`pickup-manifest-etag.test.ts` holds two digests of that build). A member added to the view still has to be said
 * here or hashed below: the record type of `representationOf` has the keys of the view but these.
 */
type LeftOutOfTheDigest = Extract<keyof PickupManifestView, 'created_at'>;

function representationOf(view: PickupManifestView): readonly unknown[] {
  if (view.stops === undefined) {
    throw new TypeError('A manifest has an ETag only as it is read with its stops');
  }
  const fields: Record<Exclude<keyof PickupManifestView, LeftOutOfTheDigest>, unknown> = {
    id: view.id,
    code: view.code,
    state: view.state,
    service_date: view.service_date,
    responsible_hub_id: view.responsible_hub_id,
    assigned_rider_id: view.assigned_rider_id,
    assigned_at: view.assigned_at,
    dispatched_at: view.dispatched_at,
    started_at: view.started_at,
    completed_at: view.completed_at,
    stops: view.stops.map((stop) => stopRepresentationOf(stop)),
  };
  return Object.values(fields);
}

const MANIFEST_ETAG = /^"[A-Za-z0-9_-]{43}"$/;

/** The ETag of a manifest read with its stops, and of the version of its row. */
export function pickupManifestEtagOf(view: PickupManifestView, version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RangeError('A record version is a non-negative safe integer');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([DOMAIN, version, ...representationOf(view)]), 'utf8')
    .digest('base64url');
  return `"${digest}"`;
}

/** Whether the header is exactly the current ETag. Missing, weak, a list, unquoted, another form and different all answer `false`. */
export function pickupManifestEtagMatches(header: string | undefined, current: string): boolean {
  return typeof header === 'string' && MANIFEST_ETAG.test(header) && header === current;
}
