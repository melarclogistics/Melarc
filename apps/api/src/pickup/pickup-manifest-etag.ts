import { createHash } from 'node:crypto';

import type { PickupManifestView, PickupStopView } from './pickup-manifest-view.js';

/**
 * The ETag of a manifest (S1.20; domain-model.md section 6.3; `AC-SLICE-001-11`): an **opaque strong validator of what the read returned**,
 * modelled on the pickup request's (`pickup-request-etag.ts`). It is the digest of the **complete representation** the read answers, the
 * stops in their order included, and of the manifest's **durable version** (`version`, which the database moves for any change to the
 * row). So it changes when anything the caller was shown changes, **a stop's place in the order among it**, and when anything else about
 * the row does. The operations of S1.21 that take it back as `If-Match` compare it under the manifest's lock against the ETag recomputed
 * in that transaction.
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

function representationOf(view: PickupManifestView): readonly unknown[] {
  if (view.stops === undefined) {
    throw new TypeError('A manifest has an ETag only as it is read with its stops');
  }
  const fields: Record<keyof PickupManifestView, unknown> = {
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
    created_at: view.created_at,
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
