import { sql } from 'drizzle-orm';

/**
 * One staff identity as the reads and the mutations answer it (`StaffIdentity`): what the record says, and what the recorded factors say.
 * The reads (S0.35) and the mutations that return the record (S0.36) build it from the same columns and the same rule, so that the ETag a
 * mutation recomputes under the identity's lock is the one the read gave (`staff-identity-etag.ts`).
 */
export interface StaffIdentityView {
  readonly id: string;
  readonly work_email: string;
  readonly full_name: string;
  readonly phone: string | null;
  readonly status: string;
  readonly role_bundle_id: string;
  readonly primary_hub_id: string | null;
  readonly mfa_enrolled: boolean;
  readonly mfa_reset_state: string;
  readonly created_by: string;
  readonly approved_by: string | null;
}

/** The columns of `staff_identity` a representation is made of, with the revision and the moment of creation a page position uses. */
export interface IdentityRow {
  readonly id: string;
  readonly work_email: string;
  readonly full_name: string;
  readonly phone: string | null;
  readonly status: string;
  readonly role_bundle_id: string;
  readonly primary_hub_id: string | null;
  readonly created_by: string;
  readonly approved_by: string | null;
  readonly version: number;
  readonly created_at_text: string;
}

export const IDENTITY_COLUMNS = sql.raw(
  `id, work_email, full_name, phone, status, role_bundle_id, primary_hub_id, created_by, approved_by, version, created_at::text as created_at_text`,
);

export function viewOf(
  row: IdentityRow,
  posture: { readonly mfaEnrolled: boolean; readonly resetState: string },
): StaffIdentityView {
  return {
    id: row.id,
    work_email: row.work_email,
    full_name: row.full_name,
    phone: row.phone,
    status: row.status,
    role_bundle_id: row.role_bundle_id,
    primary_hub_id: row.primary_hub_id,
    mfa_enrolled: posture.mfaEnrolled,
    mfa_reset_state: posture.resetState,
    created_by: row.created_by,
    approved_by: row.approved_by,
  };
}
