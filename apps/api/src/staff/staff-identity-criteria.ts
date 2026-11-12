import { sql, type SQL } from 'drizzle-orm';

/**
 * Which staff identities the list of staff contains, written once (task C1; reporting-data-dictionary.md section 5.5.6).
 * `listStaffIdentities` and the count of the queue of profiles waiting for approval (`getQueueSummary`) both call
 * `staffIdentityCriteria`, so the count is the number of profiles the list returns **by construction**. The position of a page is not a
 * criterion and stays in the list.
 *
 * Every statement that uses these criteria selects `from staff_identity`, whose columns they name.
 */
export interface StaffIdentityCriteria {
  /** Only the identities in this status, or all of them. */
  readonly status: string | null;
  /** Only the identities whose primary hub is this one. */
  readonly hubId: string | null;
  /** The `ilike` pattern of the search (`literal` has already made it match text, not a pattern), or none. */
  readonly pattern: string | null;
}

export function staffIdentityCriteria(criteria: StaffIdentityCriteria): SQL {
  const { status, hubId, pattern } = criteria;
  return sql`(${status}::text is null or status = ${status}::text)
           and (${hubId}::uuid is null or primary_hub_id = ${hubId}::uuid)
           and (${pattern}::text is null or full_name ilike ${pattern}::text escape '\\' or work_email ilike ${pattern}::text escape '\\')`;
}
