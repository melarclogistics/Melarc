import { sql, type SQL } from 'drizzle-orm';

/**
 * Which manifests (runs) the list of manifests contains, written once (task C1; reporting-data-dictionary.md section 5.5.5).
 * `listPickupManifests` and the count of the queue of runs in progress (`getQueueSummary`) both call `pickupManifestCriteria`, so the count
 * is the number of runs the list returns **by construction**. The position of a page is not a criterion and stays in the list.
 *
 * Every statement that uses these criteria selects `from pickup_manifest`, whose columns they name.
 */
export interface PickupManifestCriteria {
  /** Only the manifests in this state, or all of them. */
  readonly state: string | null;
  /** Only the manifests worked on this day (`YYYY-MM-DD`), or those of every day. */
  readonly serviceDate: string | null;
  /**
   * Only the manifests of this hub: their `responsible_hub_id` (task C3, `AC-HUBF-02`), or those of every hub the reader may read. A filter,
   * never a scope: the row-level security of the transaction decides what may be read, and the hub is never put in the security context.
   */
  readonly hubId: string | null;
}

export function pickupManifestCriteria(criteria: PickupManifestCriteria): SQL {
  const { state, serviceDate, hubId } = criteria;
  return sql`(${state}::text is null or state = ${state}::text)
             and (${serviceDate}::date is null or service_date = ${serviceDate}::date)
             and (${hubId}::uuid is null or responsible_hub_id = ${hubId}::uuid)`;
}
