import { sql } from 'drizzle-orm';

import { guardReasonIn, serverErrorIn } from '../platform/database/database-failures.js';
import type { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { evidenceNotStored } from './pickup-failure-evidence.js';

type Transaction = ReturnType<typeof transactionOf>;

const invalid = (name: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer: `/${name}`, rule }],
  });

/** A Postgres array literal of identifiers that were each judged to be one (the statement's parameter is the text). */
const uuidArray = (ids: readonly string[]): string => `{${ids.join(',')}}`;

/**
 * Whether Ops let this stop's count through without parcel photos (`authoriseParcelPhotoException`, D-A10). Read under the rider's own context: the policy of the exception shows it for
 * a stop the rider has arrived at on its own run in progress, and for no other.
 */
export async function stopIsExcused(tx: Transaction, stopId: string): Promise<boolean> {
  const found = await tx.execute(
    sql`select 1 as excused from parcel_photo_exception where pickup_stop_id = ${stopId}::uuid`,
  );
  return found.rows.length > 0;
}

/**
 * The parcel photos a count names, judged by their number alone (pickup-collection.md section 5.5): one for each parcel counted, or none for a stop Ops let through without them. A photo
 * named twice is `duplicate`, and a number that is not the count's is `parcel_photo_count` (a count with none at all included; a count above or below the photos). **There is no cap**: a
 * pickup of two hundred parcels has two hundred photos, and the size of the body that names them is the transport's to bound (it admits them, `collection-parcel-photos.test.ts`).
 * The database holds the same number for every writer, at the end of the transaction (migration 0088).
 */
export function checkedParcelPhotoIds(
  ids: readonly string[] | undefined,
  collectedCount: number,
  excused: boolean,
): string[] {
  const given = (ids ?? []).map((id) => id.toLowerCase());
  if (new Set(given).size !== given.length) throw invalid('parcel_photo_ids', 'duplicate');
  if (excused ? given.length > 0 : given.length !== collectedCount) {
    throw invalid('parcel_photo_ids', 'parcel_photo_count');
  }
  return given;
}

/**
 * The parcel photos the rider names for the count of a stop: every record must be `STORED`, captured by this rider as a parcel's photo **of this stop**, and not yet attached to a count.
 * Read under the rider's own context, so a record of another rider is not there to be found. **One answer** for a record that is still pending, has expired, is another rider's, is of
 * another stop or another purpose, or is already counted, so that the reply tells a caller nothing about a record that is not its own (`EVIDENCE_NOT_STORED`). The database holds the
 * same for every writer (`melarc.collection_parcel_photo_guard`, migration 0088); this is the check that answers the caller before anything is written.
 */
export async function requireStoredParcelPhotos(
  tx: Transaction,
  stopId: string,
  riderId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const found = await tx.execute(sql`
    select e.id
      from evidence as e
     where e.id = any(${uuidArray(ids)}::uuid[])
       and e.state = 'STORED' and e.owner_type = 'PICKUP_STOP' and e.owner_id = ${stopId}::uuid and e.purpose = 'PARCEL_PHOTO'
       and e.captured_by_principal_type = 'RIDER' and e.captured_by_actor = ${riderId}::uuid
       and not exists (select 1 from collection_parcel_photo as attached where attached.evidence_id = e.id)`);
  if (found.rows.length !== ids.length) throw evidenceNotStored();
}

/**
 * The attachment of the photos to the count just made, in the same transaction, in one statement. A writer names the photo and the count and nothing else: the stop, the hub, the
 * rider and the moment are the guard's. A record that the guard or the key refuses (it changed since it was read, or another count attached it first) is the same single answer as one
 * that was never usable; nothing is asked of the database after the refusal, because the transaction is aborted.
 */
export async function attachParcelPhotos(
  tx: Transaction,
  recordId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  try {
    await tx.execute(sql`
      insert into collection_parcel_photo (evidence_id, collection_record_id)
      select photo, ${recordId}::uuid from unnest(${uuidArray(ids)}::uuid[]) as photo`);
  } catch (error) {
    if (guardReasonIn(error) === 'EVIDENCE_NOT_STORED' || serverErrorIn(error)?.code === '23505') {
      throw evidenceNotStored();
    }
    if (guardReasonIn(error) === 'STATE_CONFLICT') {
      throw ApiException.of(ErrorCode.StateConflict, 'The stop is no longer one to be counted', {
        rule: 'stop_not_arrived',
      });
    }
    throw error;
  }
}
