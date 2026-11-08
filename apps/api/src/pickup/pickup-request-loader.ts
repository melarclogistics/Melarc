import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { exceptionViewOf, exceptionsShownFor } from './one-package-exception-view.js';
import { pickupRequestEtagMatches, pickupRequestEtagOf } from './pickup-request-etag.js';
import {
  REQUEST_COLUMNS,
  forAudience,
  viewOf,
  type ExceptionAudience,
  type PickupRequestRow,
  type PickupRequestView,
} from './pickup-request-view.js';

export interface LoadedRequest {
  readonly row: PickupRequestRow;
  readonly view: PickupRequestView;
  /** The ETag of exactly this representation and version: what a read answers and what a mutation compares `If-Match` with. */
  readonly etag: string;
}

/**
 * A pickup request as `getPickupRequest` answers it, with its ETag (S1.13, S1.15). **The one place a view and its ETag are made from a
 * row**, so that the token a read hands out and the token a mutation recomputes under the row's lock cannot drift apart: a client that
 * read a request and sends its ETag back is compared with the very same function of the very same row.
 *
 * `lock` takes the row's lock (`for update`) for a mutation, so that two callers who both hold the same ETag are put in a line, and the
 * second reads the row the first left. The caller's own context decides what it can see: a row that is out of its scope is not found.
 */
export async function loadRequest(
  handle: TransactionHandle,
  id: string,
  options: { readonly lock?: boolean; readonly audience?: ExceptionAudience } = {},
): Promise<LoadedRequest | undefined> {
  const found = await transactionOf(handle).execute(
    options.lock === true
      ? sql`select ${REQUEST_COLUMNS} from pickup_request where id = ${id}::uuid for update`
      : sql`select ${REQUEST_COLUMNS} from pickup_request where id = ${id}::uuid`,
  );
  const row = found.rows[0] as unknown as PickupRequestRow | undefined;
  if (row === undefined) return undefined;
  // The exception the request shows belongs to the representation, and so to the token: a change to it moves the token even where the
  // request's own row has not moved (an exception is asked for, and the request is not changed by it).
  const shown = (await exceptionsShownFor(handle, [row.id])).get(row.id);
  // What the caller is shown of the exception is its audience's: the whole of it for staff, the outcome for every other principal. The
  // token digests the outcome alone, so the audiences hold one token for one request.
  const view = forAudience(
    viewOf(row, { exception: shown === undefined ? null : exceptionViewOf(shown) }),
    options.audience ?? 'STAFF',
  );
  return { row, view, etag: pickupRequestEtagOf(view, row.version) };
}

/**
 * `If-Match` is exactly the ETag of the request as it is now, under its lock: one strong quoted token of the form the reads hand out and
 * equal to the recomputed one. Missing, weak, a list, `*`, another request's and a stale one are all the same answer, `STATE_CONFLICT`:
 * the caller read a request that is not the one that is there.
 */
export function requireCurrent(ifMatch: string | undefined, loaded: LoadedRequest): void {
  if (!pickupRequestEtagMatches(ifMatch, loaded.etag)) {
    throw ApiException.of(ErrorCode.StateConflict, 'The request has changed since it was read');
  }
}
