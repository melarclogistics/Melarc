import { sql } from 'drizzle-orm';

import {
  guardReasonIn,
  guardRuleIn,
  serverErrorIn,
} from '../platform/database/database-failures.js';
import { isUuid } from '../platform/database/transaction-context.js';
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
 * The most photos one batch of `stageParcelPhotos` names (D-E1 and D-E4, the plan's Stage 6b): **a limit on a request, about 20 KB of body, and never on a pickup**: a collection of any
 * size is staged in as many batches as it needs, and the count that closes it names none of the staged photos.
 */
export const MAX_STAGED_BATCH = 500;

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
 * The parcel photos a count names, judged by their number alone (pickup-collection.md section 5.5): one for each parcel counted, or none for a stop Ops let through without them. The
 * number is the count's **staged and named together**: the photos the rider put aside with `stageParcelPhotos` (`staged`, how many the stop has) are attached by the count beside the
 * ones it names, so a count that stages all of its photos names none. A photo named twice is `duplicate`, and a number that is not the count's is `parcel_photo_count` (a count with none
 * at all included; a count above or below the photos). **There is no cap**: a pickup of two hundred parcels has two hundred photos, and the size of the body that names them is the
 * transport's to bound (it admits them, `collection-parcel-photos.test.ts`; a larger collection is staged in batches). The database holds the same number for every writer, at the end of
 * the transaction (migration 0088).
 */
export function checkedParcelPhotoIds(
  ids: readonly string[] | undefined,
  collectedCount: number,
  excused: boolean,
  staged = 0,
): string[] {
  const given = (ids ?? []).map((id) => id.toLowerCase());
  if (new Set(given).size !== given.length) throw invalid('parcel_photo_ids', 'duplicate');
  if (excused ? given.length > 0 : given.length + staged !== collectedCount) {
    throw invalid('parcel_photo_ids', 'parcel_photo_count');
  }
  return given;
}

/**
 * The photos of one batch of `stageParcelPhotos`: one to `MAX_STAGED_BATCH` identifiers (the contract's `minItems` and `maxItems`, answered here too for a caller that does not go
 * through the schema), each an identifier, none twice. What the schema says is said again so that the same refusal is given however the service is reached.
 */
export function checkedStagedBatch(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length < 1) throw invalid('parcel_photo_ids', 'minItems');
  if (ids.length > MAX_STAGED_BATCH) throw invalid('parcel_photo_ids', 'maxItems');
  const given = ids.map((id: unknown) => (typeof id === 'string' ? id.toLowerCase() : ''));
  if (!given.every((id) => isUuid(id))) throw invalid('parcel_photo_ids', 'format');
  if (new Set(given).size !== given.length) throw invalid('parcel_photo_ids', 'duplicate');
  return given;
}

/** How many parcel photos the rider has staged for the stop: the rows of its own, which the policy of the table shows it and no other, never an identifier list. */
export async function stagedParcelPhotoCount(tx: Transaction, stopId: string): Promise<number> {
  const found = await tx.execute(
    sql`select count(*) as staged from collection_parcel_photo_staged where pickup_stop_id = ${stopId}::uuid`,
  );
  return Number((found.rows[0] as { staged: string | number } | undefined)?.staged ?? 0);
}

/**
 * A photo that is staged is not also named by the count: it is attached with the others, and naming it too would count it twice (`duplicate`, as one named twice is). One statement for the
 * whole list, by the key of the staged table.
 */
export async function refuseStagedNames(tx: Transaction, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await tx.execute(
    sql`select 1 as staged from collection_parcel_photo_staged where evidence_id = any(${uuidArray(ids)}::uuid[]) limit 1`,
  );
  if (found.rows.length > 0) throw invalid('parcel_photo_ids', 'duplicate');
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

/** What the guard of the staged table (`melarc.collection_parcel_photo_staged_guard`, migration 0108) answered, as the contract names it; `undefined` for any other failure. */
function stagingRefusalOf(error: unknown): ApiException | undefined {
  const reason = guardReasonIn(error);
  if (reason === 'EVIDENCE_NOT_STORED') return evidenceNotStored();
  if (reason !== 'STATE_CONFLICT') return undefined;
  const rule = guardRuleIn(error);
  if (rule === 'collection_recorded') {
    return ApiException.of(
      ErrorCode.StateConflict,
      'A collection is already recorded for this stop',
      { rule },
    );
  }
  if (rule === 'parcel_photo_exception') {
    return ApiException.of(
      ErrorCode.StateConflict,
      'Ops let this stop through without parcel photos, so none is staged for it',
      { rule },
    );
  }
  return ApiException.of(ErrorCode.StateConflict, 'The stop is no longer one to be counted', {
    rule: 'stop_not_arrived',
  });
}

/**
 * One batch of `stageParcelPhotos`: the photos are put aside for the count that is not yet made, in one statement. Each must be a stored photo of this stop, captured by this rider as a
 * parcel's photo and not attached to a count (`EVIDENCE_NOT_STORED`, one answer, as the count's own check gives it); **a photo that is already staged is a no-op** (the evidence record is the
 * key of the table), so a batch sent again, under the same key or another, is the same set. The database holds the rest for every writer and answers it here: the stop has to be arrived at
 * on a run in progress, with no count and no exception that let it through without photos (`melarc.collection_parcel_photo_staged_guard`, migration 0108).
 */
export async function stageParcelPhotos(
  tx: Transaction,
  stopId: string,
  riderId: string,
  ids: readonly string[],
): Promise<void> {
  await requireStoredParcelPhotos(tx, stopId, riderId, ids);
  try {
    await tx.execute(sql`
      insert into collection_parcel_photo_staged (evidence_id)
      select photo from unnest(${uuidArray(ids)}::uuid[]) as photo
      on conflict (evidence_id) do nothing`);
  } catch (error) {
    throw stagingRefusalOf(error) ?? error;
  }
}

/** How many staged photos one statement attaches: each has its own statement timeout, so a collection of any size is attached in as many as it needs. */
export const ATTACH_CHUNK = 2_000;

/**
 * The attachment of the photos to the count just made, in the same transaction. A writer names the photo and the count and nothing else: the stop, the hub, the rider and the moment are the
 * guard's. **The photos the rider staged (`stagedForStop`, the stop they are staged for) are attached first, by batch and then by identifier (the order they were staged in is kept between
 * batches and not within one, which stages its photos in the same millisecond), in statements of at most `ATTACH_CHUNK`, and the ones the count names after them**; the staged set is closed by the
 * count, so none is staged between the reading of how many there were and this. A record that the guard or the key refuses (it changed
 * since it was read, or another count attached it first) is the same single answer as one that was never usable; nothing is asked of the database after the refusal, because the
 * transaction is aborted.
 */
export async function attachParcelPhotos(
  tx: Transaction,
  recordId: string,
  ids: readonly string[],
  stagedForStop?: string,
): Promise<void> {
  if (stagedForStop === undefined && ids.length === 0) return;
  try {
    if (stagedForStop !== undefined) {
      for (;;) {
        const attached = await tx.execute(sql`
          insert into collection_parcel_photo (evidence_id, collection_record_id)
          select s.evidence_id, ${recordId}::uuid
            from collection_parcel_photo_staged as s
           where s.pickup_stop_id = ${stagedForStop}::uuid
             and not exists (select 1 from collection_parcel_photo as linked where linked.evidence_id = s.evidence_id)
           order by s.staged_at, s.evidence_id
           limit ${ATTACH_CHUNK}
          returning evidence_id`);
        if (attached.rows.length < ATTACH_CHUNK) break;
      }
    }
    if (ids.length > 0) {
      await tx.execute(sql`
        insert into collection_parcel_photo (evidence_id, collection_record_id)
        select photo, ${recordId}::uuid from unnest(${uuidArray(ids)}::uuid[]) as photo`);
    }
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
