import { createHash } from 'node:crypto';

import type {
  HubIntakePostCountView,
  HubIntakePreCountView,
  HubIntakeView,
} from './hub-intake-view.js';

/**
 * The ETag of an intake (S1.32; domain-model.md section 6.6; `AC-SLICE-001-43`): an **opaque strong validator of the facts of what the read returned**, modelled on the manifest's
 * (`pickup-manifest-etag.ts`). It is the digest of the representation the read answers and of the intake's durable `version`, which the database moves for any change to the row but
 * the lock. `submitBlindCount` (S1.33) takes it back as `If-Match` and compares it, under the intake's lock, with the one recomputed in its transaction.
 *
 * - **The advisory lock is left out of it, on purpose** (`LeftOutOfTheDigest`): who holds the lock and since when are not facts of the intake that a count rests on, and the lock does not
 *   substitute for the guards (§22.8, `AC-SLICE-001-43`). A receiver who read the intake holds its ETag through every refresh and every takeover of the lock; the count it sends is refused
 *   for the fact that the intake has been counted (by the other receiver), and never for a lock. The database leaves the same two columns out of the version (migration `0093`).
 * - **It never carries the declaration before the count**: the digest of an intake that has not been counted is made of the representation that has no such property. After the count the
 *   representation carries the declaration, which has been served by then and is frozen.
 *
 * It is opaque: the digest names no version and no field, and a client treats it as a string to send back. The header is read strictly: exactly one strong quoted token of this form,
 * equal to the current one.
 */
const DOMAIN = 'melarc.hub-intake-etag.v1';

/** The members of the view the digest leaves out: the two of the advisory lock. A member added to the view has to be said here or hashed below, or this file does not build. */
type LeftOutOfTheDigest = 'active_receiver_id' | 'lock_acquired_at';

/** The members of an intake as it is read before its count, but the lock's, and the members only the post-count shape adds: each hashed, and a record type that says every one. */
type BeforeTheCount = Omit<HubIntakePreCountView, LeftOutOfTheDigest>;
type OnlyAfterTheCount = Omit<HubIntakePostCountView, keyof HubIntakePreCountView>;

function representationOf(view: HubIntakeView): readonly unknown[] {
  const before: Record<keyof BeforeTheCount, unknown> = {
    id: view.id,
    code: view.code,
    state: view.state,
    hub_id: view.hub_id,
    pickup_request_id: view.pickup_request_id,
    pickup_manifest_id: view.pickup_manifest_id,
    handed_over_by: view.handed_over_by,
    handed_over_at: view.handed_over_at,
    declaration_captured_at: view.declaration_captured_at,
    count_phase: view.count_phase,
  };
  if (view.count_phase === 'PRE_COUNT') return Object.values(before);
  const after: Record<keyof OnlyAfterTheCount, unknown> = {
    rider_declared_count: view.rider_declared_count,
    physical_count: view.physical_count,
    count_variance: view.count_variance,
    count_difference: view.count_difference,
    condition: view.condition,
    parcel_photo_ids: view.parcel_photo_ids ?? null,
  };
  return [...Object.values(before), ...Object.values(after)];
}

const INTAKE_ETAG = /^"[A-Za-z0-9_-]{43}"$/;

/** The ETag of an intake as it is read, and of the version of its row. */
export function hubIntakeEtagOf(view: HubIntakeView, version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RangeError('A record version is a non-negative safe integer');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([DOMAIN, version, ...representationOf(view)]), 'utf8')
    .digest('base64url');
  return `"${digest}"`;
}

/** Whether the header is exactly the current ETag. Missing, weak, a list, unquoted, another form and different all answer `false`. */
export function hubIntakeEtagMatches(header: string | undefined, current: string): boolean {
  return typeof header === 'string' && INTAKE_ETAG.test(header) && header === current;
}
