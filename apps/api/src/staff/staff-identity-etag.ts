import { createHash } from 'node:crypto';

import type { StaffIdentityView } from './staff-identities.service.js';

/**
 * The ETag of a staff identity (F02 of the audit of 22 October 2026; domain-model.md section 6.8): an **opaque strong validator of what
 * the read returned**, and the only form a staff identity's ETag takes. It is the digest of the **complete representation** the read
 * answers (every field of `StaffIdentityView`, the second-factor posture among them, as it was judged at the read) and of the
 * identity's **durable revision** (`version`, which the database moves for what a read returns and for the replacement of the credential,
 * which no read shows). So it changes when anything the caller was shown changes, whatever table that came from (a grant that lapsed, a
 * delivery attempt that left the queue, a bundle's privilege that moved, a factor proven or revoked) and when the credential is
 * replaced; it does not change for a failed password attempt, a lock, or a rehash of the credential at a new cost, which neither a read
 * nor the revision shows. It is not the integer form of every other record (`version-etag.ts`), which stays as it is for them.
 *
 * It is opaque: the digest names no version and no field, and a client treats it as a string to send back in `If-Match`. The header is
 * read as strictly as the integer form is: exactly one strong quoted token of this form, and equal to the current one. A mutation that
 * takes it must compare it **under the identity's lock, against the ETag recomputed in that transaction** from the same facts
 * (`melarc.staff_reset_facts` and the identity row), so that what it acts on is what the caller's token names (S0.36, S0.37).
 */
const DOMAIN = 'melarc.staff-identity-etag.v1';

/**
 * Every field of the representation, in the order that is hashed. The record type has exactly the keys of the view, so a field added to
 * the view (or taken from it) stops this file from building until the digest says what it does about it.
 */
function representationOf(view: StaffIdentityView): readonly unknown[] {
  const fields: Record<keyof StaffIdentityView, unknown> = {
    id: view.id,
    work_email: view.work_email,
    full_name: view.full_name,
    phone: view.phone,
    status: view.status,
    role_bundle_id: view.role_bundle_id,
    primary_hub_id: view.primary_hub_id,
    mfa_enrolled: view.mfa_enrolled,
    mfa_reset_state: view.mfa_reset_state,
    created_by: view.created_by,
    approved_by: view.approved_by,
  };
  return Object.values(fields);
}

const STAFF_ETAG = /^"[A-Za-z0-9_-]{43}"$/;

export function staffIdentityEtagOf(view: StaffIdentityView, version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RangeError('A record version is a non-negative safe integer');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([DOMAIN, version, ...representationOf(view)]), 'utf8')
    .digest('base64url');
  return `"${digest}"`;
}

/** Whether the header is exactly the current ETag. Missing, weak, a list, unquoted, another form and different all answer `false`. */
export function staffIdentityEtagMatches(header: string | undefined, current: string): boolean {
  return typeof header === 'string' && STAFF_ETAG.test(header) && header === current;
}
