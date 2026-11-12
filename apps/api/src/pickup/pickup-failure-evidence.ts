import { sql } from 'drizzle-orm';

import { guardReasonIn, serverErrorIn } from '../platform/database/database-failures.js';
import { isUuid } from '../platform/database/transaction-context.js';
import type { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { MAX_FAILURE_EVIDENCE } from './pickup-failure-schemas.js';

type Transaction = ReturnType<typeof transactionOf>;

/**
 * A referenced record that is not usable as the photo of this failure: one that does not exist, is still `PENDING_UPLOAD` or has `EXPIRED`, belongs to another rider or to another
 * stop, is not the proof of a collection, or is already attached to a failure. **One answer** for all of them, so that the reply tells a caller nothing about a record that is not its own.
 */
export const evidenceNotStored = (): ApiException =>
  ApiException.of(ErrorCode.EvidenceNotStored, 'A referenced evidence record is not stored');

/** A Postgres array literal of identifiers that were each judged to be one (the statement's parameter is the text). */
function uuidArray(ids: readonly string[]): string {
  return `{${ids.join(',')}}`;
}

/**
 * The evidence the rider names for the failure of a stop (S1.28, the photo; the contract's `evidence_ids`): every record must be `STORED`, captured by this rider as the proof of the
 * collection **of this stop**, and not yet attached to a failure. Read under the rider's own context, so a record of another rider is not there to be found. The database holds the same
 * for every writer (`melarc.pickup_stop_evidence_guard`, migration 0083); this is the check that answers the caller before anything is written.
 */
export async function requireStoredEvidence(
  tx: Transaction,
  stopId: string,
  riderId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const distinct = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (distinct.length > MAX_FAILURE_EVIDENCE || !distinct.every((id) => isUuid(id))) {
    throw evidenceNotStored();
  }
  const found = await tx.execute(sql`
    select e.id
      from evidence as e
     where e.id = any(${uuidArray(distinct)}::uuid[])
       and e.state = 'STORED' and e.owner_type = 'PICKUP_STOP' and e.owner_id = ${stopId}::uuid and e.purpose = 'COLLECTION_PROOF'
       and e.captured_by_principal_type = 'RIDER' and e.captured_by_actor = ${riderId}::uuid
       and not exists (select 1 from pickup_stop_evidence as attached where attached.evidence_id = e.id)`);
  if (found.rows.length !== distinct.length) throw evidenceNotStored();
}

/**
 * The attachment of the evidence to the stop, before the stop becomes `FAILED` (the stop's guard asks for it when the reason requires a photo). A writer names the record and the stop
 * and nothing else: the hub, the rider and the moment are the guard's. A record that the guard or the key refuses (it changed since it was read, or another report attached it
 * first) is the same single answer as one that was never usable; nothing is asked of the database after the refusal, because the transaction is aborted.
 */
export async function attachEvidence(
  tx: Transaction,
  stopId: string,
  ids: readonly string[],
): Promise<void> {
  const distinct = [...new Set(ids.map((id) => id.toLowerCase()))];
  for (const id of distinct) {
    try {
      await tx.execute(
        sql`insert into pickup_stop_evidence (evidence_id, pickup_stop_id) values (${id}::uuid, ${stopId}::uuid)`,
      );
    } catch (error) {
      if (
        guardReasonIn(error) === 'EVIDENCE_NOT_STORED' ||
        serverErrorIn(error)?.code === '23505'
      ) {
        throw evidenceNotStored();
      }
      throw error;
    }
  }
}
