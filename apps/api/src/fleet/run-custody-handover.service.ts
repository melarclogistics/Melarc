import { sql } from 'drizzle-orm';

import { randomUUIDv7 } from '../platform/auth/crypto/uuid-v7.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { serverErrorIn } from '../platform/database/database-failures.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import type { RunAccess } from '../platform/domain-ports/run-access.port.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import { requiredNote } from '../platform/audit/required-note.js';
import { decodePageToken, encodePageToken } from '../platform/http/page-token.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../platform/http/pagination.js';
import { MAX_PARCEL_COUNT_TAKEN } from './run-custody-handover-schemas.js';
import {
  HANDOVER_COLUMNS,
  handoverEtagMatches,
  handoverEtagOf,
  handoverViewOf,
  type RunCustodyHandoverRow,
  type RunCustodyHandoverState,
  type RunCustodyHandoverView,
} from './run-custody-handover-view.js';

export interface RunCustodyHandoversOptions {
  readonly runner: Pick<OperationRunner, 'mutate' | 'read'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  /** The identifiers of the handovers are time-ordered, from the clock it is given, no more. */
  readonly clock: Pick<Clock, 'now'>;
  /** The run, as the `pickup` domain lets another domain reach it: always in the transaction of the act (`platform/domain-ports/run-access.port.ts`). */
  readonly runs: RunAccess;
}

export interface CreateBody {
  readonly to_rider_id?: string;
  readonly to_hub_id?: string;
  readonly note: string;
}

export interface AcceptBody {
  readonly parcel_count_taken: number;
}

export interface FailBody {
  readonly note: string;
}

export interface HandoverAnswer {
  readonly handover: RunCustodyHandoverView;
  readonly etag: string;
}

export interface HandoverListFilter {
  readonly pageSize?: number;
  readonly pageToken?: string;
  readonly manifestId?: string;
  readonly state?: string;
}

/** What is kept of an act so that a retry with the same key is answered with it, byte for byte. */
interface StoredAnswer {
  readonly etag: string;
  readonly handover: RunCustodyHandoverView;
}

const ACCEPT = 'acceptRunCustodyHandover';
const FAIL = 'failRunCustodyHandover';
const STATES: readonly RunCustodyHandoverState[] = ['PENDING', 'COMPLETED', 'FAILED'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Both reads open one `REPEATABLE READ` transaction: the rows, and the audit of a crossing, are one picture of the data. */
const ONE_SNAPSHOT = { isolation: 'REPEATABLE READ' } as const;

const invalid = (where: 'body' | 'query', name: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: where, pointer: `/${name}`, rule }],
  });

/**
 * The refusal of a rider who acts on a custody that is not its own: it is not the named receiver, the run is not its, or there is no such run, and
 * these are **one answer**, in one place (errors-and-enums.md: a rider who acts on unassigned work is told `NOT_ASSIGNED_RIDER`, one who looks it
 * up is told `NOT_FOUND`). The rider reads the handovers it is a party to and never the run, so nothing here can say which of them it was.
 */
const notTheRidersCustody = (): ApiException =>
  ApiException.of(ErrorCode.NotAssignedRider, 'This is not a custody handover to you');

/**
 * The run custody handover (S1.24; `fleet.custody.initiate`, `.accept` and `.read`; `AC-SLICE-001-67` and `-68`; state-machines.md section 4.1;
 * domain-model.md section 6.8.1; `MSC-DEC-246`): custody of a started run's parcels moves from the rider who holds them to another rider or to the
 * hub, because the rider cannot go on. **Custody changes hands only when the receiver accepts**: opening a handover moves nothing, so nobody is ever
 * without the parcels, and a handover that fails leaves custody where it was.
 *
 * - **`initiateRunCustodyHandover`** is Ops's: the run is in progress and has no handover pending (one run has one open handover, by an index, so a
 *   double click is `STATE_CONFLICT`), the `ETag` of the run is current, the origin is read from the run (the current custody holder, never sent),
 *   and the destination is another active rider of the run's hub (`RIDER_UNAVAILABLE`, one answer for a rider that cannot be seen, that does not
 *   exist or that is unavailable) or the run's own hub. A run the hub already holds has no rider to hand on (`STATE_CONFLICT`).
 * - **`acceptRunCustodyHandover`** is the named receiver's, or Ops's where the hub is the destination. The act is on the run's one pending handover
 *   under the run's lock and then its own, and judges, in order: that the run is in progress; that there is a handover to this caller (a rider who is
 *   not the receiver, and a run that is not its own, are `NOT_ASSIGNED_RIDER`; Ops on a handover to a rider is `PERMISSION_DENIED`; no handover is
 *   `STATE_CONFLICT` for Ops); the `ETag` of the handover. It records the count the receiver took, which is a custody record and **never seeds a
 *   count**. If the acceptance leaves a run with every stop terminal and none collected, the system completes it in the same transaction.
 * - **`failRunCustodyHandover`** is Ops's: the pending handover becomes `FAILED` with a mandatory note and custody stays where it was; the run may be
 *   completed by the system in the same transaction if its stops were all resolved while the handover stood.
 * - **The reads** (`listRunCustodyHandovers`, `getRunCustodyHandover`) are scoped by row-level security: a rider reads the handovers it is a party to
 *   and nothing of the run, staff those of the hubs of the grant. The `ETag` the acts take comes from the read of one (or the answer that opened it).
 *
 * **Locks**: the run first, then its handover, so that the acts on a run's custody and the acts that complete the run (the system's completion takes
 * the run's lock after the stop it has resolved) wait in one direction only, and a handover cannot be opened on a run that is being completed or
 * completed under a handover being opened.
 */
export class RunCustodyHandovers {
  readonly #options: RunCustodyHandoversOptions;

  constructor(options: RunCustodyHandoversOptions) {
    this.#options = options;
  }

  // ---- initiate ------------------------------------------------------------------------------------------------------------------

  async initiate(
    authorized: AuthorizedRequest,
    correlationId: string,
    manifestId: string,
    request: { readonly body: CreateBody; readonly ifMatch: string | undefined },
  ): Promise<HandoverAnswer> {
    const { runner, audit, clock, runs } = this.#options;
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    const { body } = request;
    // Exactly one destination: the schema cannot say it, and a request that names both or neither is not a handover.
    if ((body.to_rider_id === undefined) === (body.to_hub_id === undefined)) {
      throw invalid('body', 'to_rider_id', 'exactly_one_destination');
    }
    const note = requiredNote(body.note);
    const officerId = authorized.session.principalId.toLowerCase();

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const visible = await runs.peek(handle, manifestId);
      if (visible === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      if (visible.state !== 'IN_PROGRESS') {
        throw ApiException.of(ErrorCode.StateConflict, 'Only a run in progress is handed over', {
          rule: 'run_not_in_progress',
        });
      }

      // The run, under its lock: a handover cannot be opened on a run that is being completed, nor a run completed under one being opened.
      const loaded = await runs.lockWithVersion(handle, manifestId);
      if (loaded?.state !== 'IN_PROGRESS') {
        throw ApiException.of(ErrorCode.StateConflict, 'The run is no longer in progress', {
          rule: 'run_not_in_progress',
        });
      }
      runs.requireCurrentVersion(request.ifMatch, loaded);

      const pending = await tx.execute(
        sql`select 1 from run_custody_handover where manifest_id = ${manifestId}::uuid and state = 'PENDING'`,
      );
      if (pending.rows.length > 0) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'A custody handover of this run is already pending',
          { rule: 'custody_handover_pending' },
        );
      }
      const held = await tx.execute(
        sql`select melarc.run_custody_holder(${manifestId}::uuid) as holder`,
      );
      const holder = (held.rows[0] as { holder: string | null } | undefined)?.holder ?? null;
      if (holder === null) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The hub holds the custody of this run: there is no rider to hand it on',
          { rule: 'custody_with_hub' },
        );
      }

      const runHub = loaded.responsibleHubId.toLowerCase();
      const toHub = body.to_hub_id?.toLowerCase();
      if (toHub !== undefined && toHub !== runHub) {
        throw invalid('body', 'to_hub_id', 'run_hub');
      }
      const toRider = body.to_rider_id?.toLowerCase();
      if (toRider !== undefined) {
        // The rider as they are now: what a grant lets the officer see of a rider is not what makes the rider eligible, and the one who
        // holds the custody is not a destination. One answer for a rider the caller cannot see, one that does not exist and one that is not
        // available.
        const riders = await tx.execute(
          sql`select id, status, primary_hub_id from rider_identity where id = ${toRider}::uuid`,
        );
        const rider = riders.rows[0] as
          { id: string; status: string; primary_hub_id: string } | undefined;
        if (
          rider?.status !== 'ACTIVE' ||
          rider.primary_hub_id.toLowerCase() !== runHub ||
          toRider === holder.toLowerCase()
        ) {
          throw ApiException.of(ErrorCode.RiderUnavailable, 'That rider cannot take the custody');
        }
      }

      const id = randomUUIDv7(clock);
      let inserted: RunCustodyHandoverRow | undefined;
      try {
        // The lock first, and then the instant: the opening is stamped no earlier than anything that committed to the run while this waited.
        const written = await tx.execute(sql`
          insert into run_custody_handover (id, manifest_id, responsible_hub_id, from_rider_id, to_rider_id, to_hub_id, initiation_note,
                                            initiated_by, initiated_at)
          values (${id}::uuid, ${manifestId}::uuid, ${runHub}::uuid, ${holder}::uuid, ${toRider ?? null}::uuid, ${toHub ?? null}::uuid,
                  ${note}, ${officerId}::uuid, clock_timestamp())
          returning ${HANDOVER_COLUMNS}`);
        inserted = written.rows[0] as unknown as RunCustodyHandoverRow | undefined;
      } catch (error) {
        // The index of the one open handover: a second opener that raced this one (the run's lock makes it a line, and this is the backstop).
        if (serverErrorIn(error)?.code === '23505') {
          throw ApiException.of(
            ErrorCode.StateConflict,
            'A custody handover of this run is already pending',
            { rule: 'custody_handover_pending' },
          );
        }
        throw error;
      }
      if (inserted === undefined) throw new Error('A custody handover was not made');

      await audit.write(handle, {
        code: 'fleet.custody.initiated',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'RunCustodyHandover', id: inserted.id },
        responsibleHubId: inserted.responsible_hub_id,
        resultingState: 'PENDING',
        note,
        // Opening a handover moves nothing: the holder is the same before and after, which the event says plainly.
        beforeAfter: {
          custody_handover: { before: null, after: 'PENDING' },
          custody_holder: { before: holder, after: holder },
        },
        relatedIds: {
          pickup_manifest_id: manifestId,
          from_rider_id: holder,
          ...(toRider === undefined ? { to_hub_id: toHub ?? runHub } : { to_rider_id: toRider }),
        },
        detail: { destination: toRider === undefined ? 'HUB' : 'RIDER' },
      });

      const view = handoverViewOf(inserted);
      return { handover: view, etag: handoverEtagOf(view, inserted.version) };
    });
  }

  // ---- accept and fail ---------------------------------------------------------------------------------------------------------

  async accept(
    authorized: AuthorizedRequest,
    correlationId: string,
    manifestId: string,
    request: {
      readonly body: AcceptBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<HandoverAnswer> {
    const type = authorized.session.principalType;
    if (type !== 'STAFF' && type !== 'RIDER') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw invalid('body', 'Idempotency-Key', 'format');
    }
    const count = request.body.parcel_count_taken;
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_PARCEL_COUNT_TAKEN) {
      throw invalid('body', 'parcel_count_taken', 'range');
    }
    return this.#resolve(authorized, correlationId, manifestId, {
      operation: ACCEPT,
      idempotencyKey: request.idempotencyKey,
      fingerprint: request.fingerprint,
      ifMatch: request.ifMatch,
      resolution: { kind: 'ACCEPT', count },
    });
  }

  async fail(
    authorized: AuthorizedRequest,
    correlationId: string,
    manifestId: string,
    request: {
      readonly body: FailBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<HandoverAnswer> {
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw invalid('body', 'Idempotency-Key', 'format');
    }
    const note = requiredNote(request.body.note);
    return this.#resolve(authorized, correlationId, manifestId, {
      operation: FAIL,
      idempotencyKey: request.idempotencyKey,
      fingerprint: request.fingerprint,
      ifMatch: request.ifMatch,
      resolution: { kind: 'FAIL', note },
    });
  }

  /** The two resolutions of a pending handover, which differ in who may do them and what they write and are one act otherwise. */
  async #resolve(
    authorized: AuthorizedRequest,
    correlationId: string,
    manifestId: string,
    act: {
      readonly operation: typeof ACCEPT | typeof FAIL;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
      readonly ifMatch: string | undefined;
      readonly resolution:
        | { readonly kind: 'ACCEPT'; readonly count: number }
        | { readonly kind: 'FAIL'; readonly note: string };
    },
  ): Promise<HandoverAnswer> {
    const { runner, audit, idempotency, runs } = this.#options;
    const type = authorized.session.principalType === 'RIDER' ? 'RIDER' : 'STAFF';
    const actorId = authorized.session.principalId.toLowerCase();
    // A rider reads only the handovers it is a party to: for it there is no difference between a custody that is not its own and one that does
    // not exist, and it is told so in one way. Staff are told the truth about a run they can see.
    const missing = (staffAnswer: ApiException): ApiException =>
      type === 'RIDER' ? notTheRidersCustody() : staffAnswer;

    return runner.mutate(authorized, correlationId, async (handle: TransactionHandle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: type,
        principalId: actorId,
        operationId: act.operation,
        key: act.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, act.fingerprint);
      if (begun.outcome === 'REPLAY') {
        const stored = JSON.parse(
          Buffer.from(begun.response.body).toString('utf8'),
        ) as StoredAnswer;
        return { handover: stored.handover, etag: stored.etag };
      }
      if (begun.outcome === 'CONFLICT') {
        throw ApiException.of(
          ErrorCode.IdempotencyKeyConflict,
          'That Idempotency-Key was used with a different request',
        );
      }
      if (begun.outcome !== 'NEW') {
        // A record that began and did not complete is a stranded one (OB-100): the command is not run again, and nothing is invented.
        throw new Error('An idempotency record of this command is stranded');
      }

      const run = await runs.peek(handle, manifestId);
      if (run === undefined) throw missing(ApiException.of(ErrorCode.NotFound, 'Not found'));
      if (run.state !== 'IN_PROGRESS') {
        throw missing(
          ApiException.of(ErrorCode.StateConflict, 'The run is not in progress', {
            rule: 'run_not_in_progress',
          }),
        );
      }
      // The run first, then its handover (the one order of locks): the system's completion takes the run's lock too.
      const manifest = await runs.lock(handle, manifestId);
      if (manifest?.state !== 'IN_PROGRESS') {
        throw missing(
          ApiException.of(ErrorCode.StateConflict, 'The run is not in progress', {
            rule: 'run_not_in_progress',
          }),
        );
      }

      const found = await tx.execute(sql`
        select ${HANDOVER_COLUMNS} from run_custody_handover
         where manifest_id = ${manifestId}::uuid and state = 'PENDING' for update`);
      const pending = found.rows[0] as unknown as RunCustodyHandoverRow | undefined;
      if (pending === undefined) {
        throw missing(
          ApiException.of(ErrorCode.StateConflict, 'No custody handover of this run is pending', {
            rule: 'no_custody_handover_pending',
          }),
        );
      }

      // Who may resolve it, before anything is said about its state: a caller who is not the party learns nothing of the handover.
      if (act.resolution.kind === 'ACCEPT') {
        if (type === 'RIDER' && pending.to_rider_id?.toLowerCase() !== actorId) {
          throw notTheRidersCustody();
        }
        if (type === 'STAFF' && pending.to_hub_id === null) {
          throw ApiException.of(
            ErrorCode.PermissionDenied,
            'A handover to a rider is accepted by that rider',
          );
        }
      }
      const current = handoverEtagOf(handoverViewOf(pending), pending.version);
      if (!handoverEtagMatches(act.ifMatch, current)) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The custody handover has changed since it was read',
        );
      }

      // The lock first, and then the instant: the resolution is stamped no earlier than anything that committed to the run while this waited.
      const resolution = act.resolution;
      const written =
        resolution.kind === 'ACCEPT'
          ? await tx.execute(sql`
              update run_custody_handover
                 set state = 'COMPLETED', parcel_count_taken = ${resolution.count}, accepted_by = ${actorId}::uuid, resolved_at = clock_timestamp()
               where id = ${pending.id}::uuid and state = 'PENDING'
              returning ${HANDOVER_COLUMNS}`)
          : await tx.execute(sql`
              update run_custody_handover
                 set state = 'FAILED', failure_note = ${resolution.note}, failed_by = ${actorId}::uuid, resolved_at = clock_timestamp()
               where id = ${pending.id}::uuid and state = 'PENDING'
              returning ${HANDOVER_COLUMNS}`);
      const row = written.rows[0] as unknown as RunCustodyHandoverRow | undefined;
      // Under the lock and having read the handover pending, the update cannot miss it.
      if (row === undefined) throw new Error('A locked pending custody handover was not resolved');

      const parties = {
        pickup_manifest_id: manifestId,
        from_rider_id: row.from_rider_id,
        ...(row.to_rider_id === null
          ? { to_hub_id: row.to_hub_id ?? row.responsible_hub_id }
          : { to_rider_id: row.to_rider_id }),
      };
      if (resolution.kind === 'ACCEPT') {
        await audit.write(handle, {
          code: 'fleet.custody.accepted',
          enhanced: true,
          outcome: 'SUCCEEDED',
          object: { type: 'RunCustodyHandover', id: row.id },
          responsibleHubId: row.responsible_hub_id,
          previousState: 'PENDING',
          resultingState: 'COMPLETED',
          beforeAfter: {
            custody_handover: { before: 'PENDING', after: 'COMPLETED' },
            custody_holder: { before: row.from_rider_id, after: row.to_rider_id ?? 'HUB' },
          },
          relatedIds: parties,
          detail: {
            parcel_count_taken: resolution.count,
            destination: row.to_rider_id === null ? 'HUB' : 'RIDER',
          },
        });
      } else {
        await audit.write(handle, {
          code: 'fleet.custody.failed',
          enhanced: false,
          outcome: 'SUCCEEDED',
          object: { type: 'RunCustodyHandover', id: row.id },
          responsibleHubId: row.responsible_hub_id,
          previousState: 'PENDING',
          resultingState: 'FAILED',
          note: resolution.note,
          relatedIds: parties,
          detail: { destination: row.to_rider_id === null ? 'HUB' : 'RIDER' },
        });
      }
      // The handover that held the run's completion has resolved: if every stop is terminal and none was collected, the system closes the run.
      await runs.completeIfSettled(handle, manifestId, 'CUSTODY_HANDOVER_RESOLVED');

      const view = handoverViewOf(row);
      const etag = handoverEtagOf(view, row.version);
      const answer: StoredAnswer = { etag, handover: view };
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(answer)),
      });
      return { handover: view, etag };
    });
  }

  // ---- the reads -------------------------------------------------------------------------------------------------------------

  async get(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
  ): Promise<HandoverAnswer> {
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const found = await transactionOf(handle).execute(sql`
          select ${HANDOVER_COLUMNS} from run_custody_handover where id = ${id}::uuid`);
        const row = found.rows[0] as unknown as RunCustodyHandoverRow | undefined;
        if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
        const baseline = await this.#primaryHubOf(handle, authorized);
        if (baseline !== undefined && row.responsible_hub_id !== baseline) {
          await this.#options.audit.write(handle, {
            code: 'auth.hub_boundary.crossed',
            enhanced: true,
            outcome: 'SUCCEEDED',
            object: { type: 'RunCustodyHandover', id: row.id },
            responsibleHubId: row.responsible_hub_id,
          });
        }
        const view = handoverViewOf(row);
        return { handover: view, etag: handoverEtagOf(view, row.version) };
      },
      ONE_SNAPSHOT,
    );
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: HandoverListFilter,
  ): Promise<{
    readonly items: readonly RunCustodyHandoverView[];
    readonly next_page_token: string | null;
  }> {
    const size = filter.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      throw invalid('query', 'page_size', 'range');
    }
    const after = filter.pageToken === undefined ? undefined : decodePageToken(filter.pageToken);
    if (filter.pageToken !== undefined && after === undefined) {
      throw invalid('query', 'page_token', 'format');
    }
    if (filter.manifestId !== undefined && !UUID.test(filter.manifestId)) {
      throw invalid('query', 'manifest_id', 'format');
    }
    if (filter.state !== undefined && !STATES.includes(filter.state as RunCustodyHandoverState)) {
      throw invalid('query', 'state', 'enum');
    }

    const afterMoment = after?.createdAt ?? null;
    const afterId = after?.id ?? null;
    const manifestId = filter.manifestId?.toLowerCase() ?? null;
    const state = filter.state ?? null;
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const result = await transactionOf(handle).execute(sql`
          select ${HANDOVER_COLUMNS} from run_custody_handover
           where (${afterMoment}::timestamptz is null or (initiated_at, id) < (${afterMoment}::timestamptz, ${afterId}::uuid))
             and (${manifestId}::uuid is null or manifest_id = ${manifestId}::uuid)
             and (${state}::text is null or state = ${state}::text)
           order by initiated_at desc, id desc
           limit ${size + 1}`);
        const read = result.rows as unknown as RunCustodyHandoverRow[];
        const page = read.slice(0, size);
        const baseline = await this.#primaryHubOf(handle, authorized);
        if (baseline !== undefined) {
          const foreign = [
            ...new Set(page.map((row) => row.responsible_hub_id).filter((hub) => hub !== baseline)),
          ].toSorted();
          for (const hubId of foreign) {
            await this.#options.audit.write(handle, {
              code: 'auth.hub_boundary.crossed',
              enhanced: true,
              outcome: 'SUCCEEDED',
              object: { type: 'HUB', id: hubId },
              responsibleHubId: hubId,
              relatedIds: { operation_id: 'listRunCustodyHandovers' },
            });
          }
        }
        const last = page.at(-1);
        return {
          items: page.map((row) => handoverViewOf(row)),
          next_page_token:
            read.length > size && last !== undefined
              ? encodePageToken({ createdAt: last.initiated_at_text, id: last.id })
              : null,
        };
      },
      ONE_SNAPSHOT,
    );
  }

  /**
   * The actor's primary hub, which is the baseline of a crossing: `null` for a staff actor with none (every hub it reads is foreign),
   * `undefined` for a rider, whose reads are not hub-scoped and cross no hub.
   */
  async #primaryHubOf(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
  ): Promise<string | null | undefined> {
    if (authorized.session.principalType !== 'STAFF') return undefined;
    const own = await transactionOf(handle).execute(
      sql`select primary_hub_id from staff_identity where id = ${authorized.session.principalId}::uuid`,
    );
    return (own.rows[0] as { primary_hub_id: string | null } | undefined)?.primary_hub_id ?? null;
  }
}
