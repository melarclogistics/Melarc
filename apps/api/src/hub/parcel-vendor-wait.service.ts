import { sql } from 'drizzle-orm';

import { noteRefusal } from '../platform/audit/audit-record.js';
import { randomUUIDv7 } from '../platform/auth/crypto/uuid-v7.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { noteHubCrossing } from './hub-crossing.js';
import { hubIntakeEtagMatches } from './hub-intake-etag.js';
import { receivingRefusalOf } from './check-in.service.js';
import {
  RECEIVING_INTAKE_COLUMNS,
  loadIntakes,
  type ReceivingIntakeRow,
} from './receiving-views.js';

export interface ParcelVendorWaitsOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  /** The identifier of a mark is time-ordered, from the clock it is given, no more. */
  readonly clock: Pick<Clock, 'now'>;
}

/** The body of `setParcelWaitingForVendor`: whether the parcel waits, and, for a mark, a short note of what was asked and how. */
export interface ParcelWaitBody {
  readonly waiting?: unknown;
  readonly note?: unknown;
}

/** The answer of the act (`ParcelWaitingForVendor`): the state of the mark after it, whether or not the act changed it. */
export interface ParcelWaitView {
  readonly parcel_id: string;
  readonly waiting: boolean;
  readonly since: string | null;
  readonly note: string | null;
}

const invalid = (pointer: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });

const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * The note of a mark as it is kept: trimmed, a note of spaces no note, and **one short line** (no line break or other control character; the length, at most `PARCEL_WAIT_NOTE_MAX`, is the body schema's and the
 * table's). What the audit would refuse of a note is refused here with a reason of its own, before the act, and not met afterwards as a failure of the ledger.
 */
function noteOf(body: ParcelWaitBody, waiting: boolean): string | null {
  if (body.note === undefined || body.note === null) return null;
  if (typeof body.note !== 'string') throw invalid('/note', 'type');
  if (!waiting) throw invalid('/note', 'not_allowed');
  const trimmed = body.note.trim();
  if (trimmed === '') return null;
  if (CONTROL_CHARACTER.test(trimmed)) throw invalid('/note', 'single_line');
  // What the audit would refuse of a note, told with the rule of its own: the shape (`format`) or a telephone number in the words (`phone_number`: "Leave the number out of the note.").
  const refused = noteRefusal(trimmed);
  if (refused !== undefined) throw invalid('/note', refused);
  return trimmed;
}

/**
 * **A parcel the officer is waiting on the vendor's details for** (Run G1, Part 1, item 2; D-S7-12 of the Product Owner's decisions of 24 November 2026; `hub.intake.itemize`; itemization.md section 5.2; migration
 * `0126`): `setParcelWaitingForVendor`, `PUT /intake-parcels/{parcel_id}/waiting-for-vendor`.
 *
 * - **A parcel an officer cannot order yet is the officer's** (D-S7-11): the officer calls or messages the vendor and gets the details. The mark says so and **the server holds it**, so every officer and every
 *   tablet sees it; *Make the next order* passes over a marked parcel, the vendor's orders page has a tab for them, and the mark is cleared when the parcel's order is made (by the database, in the order's own
 *   transaction) or by an officer. **No senior, no money, no new key.**
 * - **One parcel at a time, stated as the state it should be in** (`waiting` true or false), so the act is idempotent by nature and takes no `Idempotency-Key`: a repeat of the same mark changes nothing and is not
 *   audited again. It takes the vendor's `ETag` as `If-Match`, as the order a parcel's officer makes does (a token that is missing is `VALIDATION_FAILED`; weak, another vendor's and out of date are `STATE_CONFLICT`, rule `stale`), **and does not move that token**
 *   (the mark is no part of what a save compares), so the screen's price check and entries stand.
 * - **Judged in this order** (the repo's): the principal; the body; then, in the transaction, the vendor's intake under its lock (`NOT_FOUND`; the route's guard has told `HUB_SCOPE_VIOLATION` for another hub's), the
 *   `ETag` the officer read (`STATE_CONFLICT`, rule `stale`), then the database's own rules, answered with the `details.rule` the contract names (`reconciliation_open`, `intake_not_ready`, `parcel_ordered`, `parcel_missing`,
 *   `parcel_void`). The guard of the table repeats every rule for every writer.
 * - **Events:** `hub.parcel.vendor_wait_marked` (a mark made, or its note renewed: the note is the event's note) and `hub.parcel.vendor_wait_cleared` (an officer took it off), ordinary tier, on the object
 *   `PickupIntake` with the parcel in `related_ids`. The clearing by an order has no event of its own: the order's events say it.
 */
export class ParcelVendorWaits {
  readonly #options: ParcelVendorWaitsOptions;

  constructor(options: ParcelVendorWaitsOptions) {
    this.#options = options;
  }

  async set(
    authorized: AuthorizedRequest,
    correlationId: string,
    parcelId: string,
    request: { readonly body: ParcelWaitBody; readonly ifMatch: string | undefined },
  ): Promise<ParcelWaitView> {
    if (authorized.session.principalType !== 'STAFF') {
      throw new ApiException(ErrorCode.PermissionDenied, 403, 'Permission denied');
    }
    // The body is what was sent: the platform has judged it against the contract's schema, and this service does not rely on that alone.
    const sent: unknown = request.body;
    if (typeof sent !== 'object' || sent === null || Array.isArray(sent)) {
      throw invalid('/', 'type');
    }
    const body = sent as ParcelWaitBody;
    for (const member of Object.keys(body)) {
      if (member !== 'waiting' && member !== 'note') throw invalid(`/${member}`, 'unknown');
    }
    if (body.waiting === undefined) throw invalid('/waiting', 'required');
    if (typeof body.waiting !== 'boolean') throw invalid('/waiting', 'type');
    const waiting = body.waiting;
    const note = noteOf(body, waiting);
    return this.#options.runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const owner = await tx.execute(
        sql`select pickup_intake_id from intake_parcel where id = ${parcelId}::uuid`,
      );
      const intakeId = (owner.rows[0] as { pickup_intake_id: string } | undefined)
        ?.pickup_intake_id;
      if (intakeId === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      // The intake first, then what is under it: the order of every act of the hub.
      const locked = await tx.execute(
        sql`select ${RECEIVING_INTAKE_COLUMNS} from pickup_intake where id = ${intakeId}::uuid for update`,
      );
      const row = locked.rows[0] as unknown as ReceivingIntakeRow | undefined;
      if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      await noteHubCrossing(this.#options.audit, handle, authorized, row);
      const loaded = await loadIntakes(tx, [row], authorized.session.principalId.toLowerCase());
      const current = loaded.checkIns.get(row.id)?.etag ?? loaded.blind.get(row.id)?.etag;
      if (current === undefined || !hubIntakeEtagMatches(request.ifMatch, current)) {
        throw ApiException.of(ErrorCode.StateConflict, 'The intake has changed since it was read', {
          rule: 'stale',
        });
      }
      let done:
        | {
            is_waiting: boolean;
            since_at: string | Date | null;
            held_note: string | null;
            did_change: boolean;
          }
        | undefined;
      try {
        const asked = await tx.execute(
          sql`select is_waiting, since_at, held_note, did_change
                from melarc.set_parcel_vendor_wait(${parcelId}::uuid, ${waiting}, ${note}::text, ${randomUUIDv7(this.#options.clock)}::uuid)`,
        );
        done = asked.rows[0] as typeof done;
      } catch (error) {
        throw receivingRefusalOf(error, '/waiting') ?? error;
      }
      if (done === undefined) throw new Error('A locked parcel was not asked about its wait');
      if (done.did_change) {
        await this.#options.audit.write(handle, {
          code: waiting ? 'hub.parcel.vendor_wait_marked' : 'hub.parcel.vendor_wait_cleared',
          enhanced: false,
          outcome: 'SUCCEEDED',
          object: { type: 'PickupIntake', id: intakeId },
          responsibleHubId: row.responsible_hub_id,
          ...(waiting && done.held_note !== null ? { note: done.held_note } : {}),
          relatedIds: { pickup_request_id: row.pickup_request_id, parcel_id: parcelId },
        });
      }
      return {
        parcel_id: parcelId,
        waiting: done.is_waiting,
        since: done.since_at === null ? null : new Date(done.since_at).toISOString(),
        note: done.held_note,
      };
    });
  }
}
