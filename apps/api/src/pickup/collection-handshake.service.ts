import { sql, type SQL } from 'drizzle-orm';

import { noteRefusal } from '../platform/audit/audit-record.js';
import { randomUUIDv7 } from '../platform/auth/crypto/uuid-v7.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { guardReasonIn, serverErrorIn } from '../platform/database/database-failures.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import type { HandshakeCodes } from '../platform/auth/crypto/handshake-codes.js';
import {
  handshakeFactsOf,
  handshakeViewOf,
  type HandshakeIssuedView,
  type HandshakeView,
} from './handshake-view.js';

export interface HandshakesOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  /** The identifiers of the handshakes are time-ordered, from the clock it is given, no more. */
  readonly clock: Pick<Clock, 'now'>;
  /** The codes: made here for the rider to show, checked here against what the database keeps (a digest), and made again by the notification lane. */
  readonly codes: Pick<
    HandshakeCodes,
    'activeVersion' | 'codeFor' | 'digestOfVersion' | 'digestsOf'
  >;
}

export interface VerifyBody {
  readonly code: string;
}
export interface SmsFallbackBody {
  readonly trigger: string;
}
export interface OverrideBody {
  readonly verification_note: string;
}
export interface ResolveBody {
  readonly note: string;
  readonly evidence_ids?: readonly string[];
}

export interface IssuedHandshake {
  readonly handshake: HandshakeIssuedView;
}
export interface HandshakeAnswer {
  readonly handshake: HandshakeView;
}

interface Retry {
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

/** What an answer keeps for its replay: the handshake as it was told, and what the code of it is made from, never the code. */
interface StoredIssued {
  readonly handshake: HandshakeView;
  readonly generation: number;
  readonly key_version: number;
  readonly length: number;
}
/** An answer that was a refusal the act committed (a code that had run out): kept as the error it was, and told again. */
interface StoredRefusal {
  readonly refusal: { readonly code: ErrorCode; readonly message: string; readonly rule?: string };
}
/** What a request that may commit a refusal settled with: the handshake it answers, or the refusal it kept. */
type Settled = HandshakeAnswer | StoredRefusal;

const ISSUE = 'initiateHandshake';
const FALLBACK = 'requestSmsHandshakeFallback';
const OVERRIDE = 'authoriseHandshakeOverride';
const RESOLVE = 'resolveHandshake';

const CODE_FORMAT = /^[0-9]{4,8}$/;
/** The longest submission worth a digest: a code is at most eight digits, and a longer text cannot be one. */
const SUBMISSION_BOUND = 64;

const invalid = (name: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer: `/${name}`, rule }],
  });

/** A stop that is not the rider's, and an id that matches nothing, are one answer: a rider who acts on work that is not its own is told so. */
const notTheRidersWork = (): ApiException =>
  ApiException.of(ErrorCode.NotAssignedRider, 'This is not work assigned to you');

const conflict = (rule: string, message: string): ApiException =>
  ApiException.of(ErrorCode.StateConflict, message, { rule });

type Caller = 'RIDER' | 'VENDOR' | 'STAFF';

/**
 * The answer a refusal of the database's operations is, by the reason it states (`DETAIL reason=`, SQLSTATE 23514) or by the SQLSTATE of a
 * privilege it did not find (42501): `undefined` for anything else, which is a defect and goes up as one. The reasons are the operations' own and
 * closed; the application renders none of the text of a refusal.
 */
function refusalOf(error: unknown, caller: Caller): ApiException | undefined {
  const state = serverErrorIn(error)?.code;
  if (state === '42501') {
    if (caller === 'RIDER') return notTheRidersWork();
    if (caller === 'VENDOR') return ApiException.of(ErrorCode.NotFound, 'Not found');
    return ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
  }
  if (state !== '23514') return undefined;
  switch (guardReasonIn(error)) {
    case 'COLLECTION_NOT_RECORDED':
      return ApiException.of(
        ErrorCode.CollectionNotRecorded,
        'The count of this stop has not been recorded',
      );
    case 'MANIFEST_NOT_STARTED':
      return ApiException.of(ErrorCode.ManifestNotStarted, 'The run has not been started');
    case 'RUN_NOT_IN_PROGRESS':
      return conflict('run_not_in_progress', 'The run is over');
    case 'STOP_NOT_ARRIVED':
      return conflict('stop_not_arrived', 'The stop has not been arrived at, or has been closed');
    case 'HANDSHAKE_EXISTS':
      return conflict('handshake_exists', 'A code has already been asked for at this stop');
    case 'HANDSHAKE_NOT_STARTED':
      return conflict('handshake_not_started', 'No code has been asked for at this stop');
    case 'HANDSHAKE_CLOSED':
      return conflict('handshake_closed', 'The handshake of this stop has ended');
    case 'GENERATION_CHANGED':
      return conflict('handshake_changed', 'The handshake changed since it was read');
    case 'FALLBACK_NOT_APPLICABLE':
      return conflict(
        'fallback_not_applicable',
        'An individual sender is sent the code in the first place',
      );
    case 'CODE_LENGTH_CHANGED':
      // The platform's code length changed between the application's reading of it and the write: nothing was kept, and asking again makes the code with the length now held.
      return conflict(
        'code_length_changed',
        'The length of a code changed while this one was made: ask again',
      );
    case 'NOT_RESOLVABLE':
      return conflict('code_live', 'The code of this handshake is still live');
    case 'WRONG_ENTRANT':
      return ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    case 'NO_REGISTERED_NUMBER':
      return ApiException.of(
        ErrorCode.NoRegisteredNumber,
        'This vendor has no registered number to send the code to',
      );
    case 'SMS_FALLBACK_LIMIT_REACHED':
      return ApiException.of(
        ErrorCode.SmsFallbackLimitReached,
        'The code cannot be sent to the registered number again for this stop',
      );
    case 'REASON_REQUIRED':
      return ApiException.of(ErrorCode.ReasonRequired, 'A note is required', { rule: 'note' });
    default:
      return undefined;
  }
}

/** Runs an operation of the database, answering its refusals as what they are. */
async function operation<T>(caller: Caller, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw refusalOf(error, caller) ?? error;
  }
}

/**
 * The collection handshake (S1.27; `AC-SLICE-001-23`, `-24`, `-26`, `-73`; pickup-collection.md; state-machines.md section 6): the two-party proof that
 * closes a counted stop. **The database is the authority** (migration 0070): the handshake is written by five operations of the owner that the runtime
 * login alone executes, each of which takes the lock of the stop first and writes the handshake, the close of the stop, the envelope for the notification
 * lane and the events in one change; the table is written by no other statement. This service makes the code (a function of the stop and the generation,
 * under a key of the `credential_delivery` purpose), gives the database its keyed digest, and answers what the database decided.
 *
 * - **The code is never stored.** It is made here for the rider to show (once, in the answer of `initiateHandshake`, and again only to the same rider's
 *   retry while it is the live one), and by the notification lane for the individual sender's text; the database keeps a digest of the live one. No log,
 *   metric, audit event or stored answer repeats it.
 * - **The judgement of a code is the database's** (`melarc.handshake_verify`): the wrong ones are counted whatever the application does, the code ends at
 *   `handshake_max_wrong_attempts` and at `handshake_code_ttl_minutes` on the database's clock, and a code is accepted from the one party the direction
 *   gives it to. A wrong, an expired and an exhausted code are outcomes the database *keeps* (the count, the end), so they are committed first and
 *   answered after (`CODE_INVALID`, `CODE_EXPIRED`, `ATTEMPTS_EXHAUSTED`); a refusal the database raises is undone with the act.
 * - **Idempotent where it can be**: the four acts that make or change a handshake take an `Idempotency-Key`; entering a code does not (a repeated code
 *   is a repeated attempt, counted).
 * - **The counted-stop authority** (the Product Owner, 4 November 2026) is the database's: the rider that recorded the count, while it is the run's
 *   assigned rider; custody alone gives the receiving rider none.
 */
export class Handshakes {
  readonly #options: HandshakesOptions;

  constructor(options: HandshakesOptions) {
    this.#options = options;
  }

  // ---- initiateHandshake -------------------------------------------------------------------------------------------------------

  async initiate(
    authorized: AuthorizedRequest,
    correlationId: string,
    stopId: string,
    request: Retry,
  ): Promise<IssuedHandshake> {
    const { runner, idempotency, clock, codes } = this.#options;
    const riderId = riderOf(authorized);
    requireKey(request.idempotencyKey);

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'RIDER',
        principalId: riderId,
        operationId: ISSUE,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        return this.#replayedIssue(handle, stopId, begun.response.body);
      }
      settle(begun.outcome);

      // The code of the first generation. The database refuses a stop that is not the calling rider's, not counted, not arrived at or already
      // asked for, and none of that is judged here: this makes the code and the digest, and the database decides whether they are kept.
      const length = await codeLength(tx);
      const version = codes.activeVersion;
      const code = codes.codeFor(stopId, 1, version, length);
      const digest = codes.digestOfVersion(stopId, code, version);
      const id = randomUUIDv7(clock);
      const answer = await operation('RIDER', async () => {
        const rows = await tx.execute(sql`
          select * from melarc.handshake_issue(${id}::uuid, ${stopId}::uuid, ${digest}::bytea, ${version}::integer, ${length}::integer)`);
        return rows.rows[0];
      });
      if (answer === undefined) throw new Error('The handshake was not made');
      const view = handshakeViewOf(handshakeFactsOf(stopId, answer));
      // An individual sender is texted the code by the lane (the envelope is the database's, written in the same change); the vendor's code is shown,
      // not sent. The cost of a text is the caller's: the operation carries the sub-ceiling of the provider-initiating operations (`providerInitiating`
      // on its route), which the authentication guard applies before this runs.
      const kept: StoredIssued = { handshake: view, generation: 1, key_version: version, length };
      await idempotency.complete(handle, scope, {
        status: 201,
        body: new TextEncoder().encode(JSON.stringify(kept)),
      });
      return {
        handshake:
          view.direction === 'VENDOR_ENTERED_RIDER_DISPLAYED'
            ? { ...view, display_code: code }
            : view,
      };
    });
  }

  /** The answer of an earlier request with the same key: the handshake as it was told, and its code again only while that code is the live one. */
  async #replayedIssue(
    handle: TransactionHandle,
    stopId: string,
    body: Uint8Array,
  ): Promise<IssuedHandshake> {
    const stored = JSON.parse(Buffer.from(body).toString('utf8')) as StoredIssued;
    if (stored.handshake.direction !== 'VENDOR_ENTERED_RIDER_DISPLAYED') {
      return { handshake: stored.handshake };
    }
    const live = await transactionOf(handle).execute(sql`
      select (state in ('CODE_GENERATED', 'CODE_DELIVERED') and code_generation = ${stored.generation} and expires_at > clock_timestamp()) as live
        from collection_handshake where pickup_stop_id = ${stopId}::uuid`);
    const still = (live.rows[0] as { live: boolean } | undefined)?.live === true;
    if (!still) return { handshake: stored.handshake };
    const code = this.#options.codes.codeFor(
      stopId,
      stored.generation,
      stored.key_version,
      stored.length,
    );
    return { handshake: { ...stored.handshake, display_code: code } };
  }

  // ---- verifyHandshake ---------------------------------------------------------------------------------------------------------

  async verify(
    authorized: AuthorizedRequest,
    correlationId: string,
    stopId: string,
    body: VerifyBody,
  ): Promise<HandshakeAnswer> {
    const { runner, codes } = this.#options;
    const caller = authorized.session.principalType;
    if (caller !== 'RIDER' && caller !== 'VENDOR') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    // What was typed is judged by the database against the digests of every key version held: a text that is not a code simply is not the code, and is
    // counted as a wrong one (the answer for a short, a long or a lettered text is the answer for a wrong number, which tells an onlooker nothing).
    const submitted =
      typeof body.code === 'string' ? body.code.trim().slice(0, SUBMISSION_BOUND) : '';
    const candidate = CODE_FORMAT.test(submitted) ? submitted : `invalid:${submitted}`;

    const outcome = await runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const digests = codes.digestsOf(stopId, candidate);
      const list: SQL = sql.join(
        digests.map((digest) => sql`${digest.bytes}::bytea`),
        sql`, `,
      );
      const answer = await operation(caller, async () => {
        const rows = await tx.execute(
          sql`select * from melarc.handshake_verify(${stopId}::uuid, array[${list}]::bytea[])`,
        );
        return rows.rows[0];
      });
      if (answer === undefined) throw new Error('The code was not judged');
      return {
        kind: String(answer.out_outcome),
        handshake: handshakeViewOf(handshakeFactsOf(stopId, answer)),
      };
    });

    // The wrong attempt, the end of a code and the exhaustion are kept by the database (they committed above); the caller is then told what they were.
    switch (outcome.kind) {
      case 'VERIFIED':
        return { handshake: outcome.handshake };
      case 'CODE_INVALID':
        throw ApiException.of(ErrorCode.CodeInvalid, 'That code is not right');
      case 'CODE_EXPIRED':
        throw ApiException.of(ErrorCode.CodeExpired, 'That code has run out');
      case 'ATTEMPTS_EXHAUSTED':
        throw ApiException.of(ErrorCode.AttemptsExhausted, 'Too many wrong codes');
      default:
        throw new Error('The database judged a code in a way the application does not know');
    }
  }

  // ---- requestSmsHandshakeFallback ---------------------------------------------------------------------------------------------

  async requestSmsFallback(
    authorized: AuthorizedRequest,
    correlationId: string,
    stopId: string,
    request: Retry & { readonly body: SmsFallbackBody },
  ): Promise<HandshakeAnswer> {
    const { runner, idempotency, clock, codes } = this.#options;
    const riderId = riderOf(authorized);
    requireKey(request.idempotencyKey);
    const trigger = request.body.trigger;
    // Busy is not a trigger (MSC-DEC-198): the ladder answers a technical failure, not a vendor's inattention.
    if (trigger === 'VENDOR_BUSY') throw invalid('trigger', 'not_a_technical_failure');
    if (trigger !== 'NO_DATA' && trigger !== 'PORTAL_DOWN') throw invalid('trigger', 'enum');

    const settled = await runner.mutate<Settled>(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'RIDER',
        principalId: riderId,
        operationId: FALLBACK,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY')
        return answerOfStored(begun.response.status, begun.response.body);
      settle(begun.outcome);

      // The generation the rider last saw, so that two requests at the same moment do not both send and a code made since is not made over.
      const present = await tx.execute(sql`
        select code_generation from collection_handshake where pickup_stop_id = ${stopId}::uuid`);
      const expected =
        (present.rows[0] as { code_generation: number } | undefined)?.code_generation ?? 0;
      const length = await codeLength(tx);
      const version = codes.activeVersion;
      const code = codes.codeFor(stopId, expected + 1, version, length);
      const digest = codes.digestOfVersion(stopId, code, version);
      const id = randomUUIDv7(clock);
      const answer = await operation('RIDER', async () => {
        const rows = await tx.execute(sql`
          select * from melarc.handshake_sms_fallback(${id}::uuid, ${stopId}::uuid, ${expected}::integer, ${digest}::bytea, ${version}::integer, ${trigger}, ${length}::integer)`);
        return rows.rows[0];
      });
      if (answer === undefined) throw new Error('The fallback was not made');
      const view = handshakeViewOf(handshakeFactsOf(stopId, answer));

      if (answer.out_outcome === 'CODE_EXPIRED') {
        // The code had run out: the database marked it (the handshake routes to Ops) and sent nothing. That mark is kept, so the answer is a refusal the act
        // commits, and a retry of the same request is told the same.
        const refusal: StoredRefusal = {
          refusal: {
            code: ErrorCode.StateConflict,
            message: 'The code has run out: the handshake routes to Ops',
            rule: 'code_expired',
          },
        };
        await idempotency.complete(handle, scope, {
          status: 409,
          body: new TextEncoder().encode(JSON.stringify(refusal)),
        });
        return refusal;
      }
      await idempotency.complete(handle, scope, {
        status: 202,
        body: new TextEncoder().encode(JSON.stringify({ handshake: view })),
      });
      return { handshake: view };
    });
    if ('refusal' in settled) {
      throw ApiException.of(settled.refusal.code, settled.refusal.message, {
        ...(settled.refusal.rule === undefined ? {} : { rule: settled.refusal.rule }),
      });
    }
    return settled;
  }

  // ---- authoriseHandshakeOverride -----------------------------------------------------------------------------------------------

  async authoriseOverride(
    authorized: AuthorizedRequest,
    correlationId: string,
    stopId: string,
    request: Retry & { readonly body: OverrideBody },
  ): Promise<HandshakeAnswer> {
    const { runner, audit, idempotency, clock } = this.#options;
    const officerId = officerOf(authorized);
    requireKey(request.idempotencyKey);
    const note = noteOf(request.body.verification_note, 'verification_note');

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'STAFF',
        principalId: officerId,
        operationId: OVERRIDE,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') return storedAnswer(begun.response.body);
      settle(begun.outcome);

      const id = randomUUIDv7(clock);
      const answer = await operation('STAFF', async () => {
        const rows = await tx.execute(
          sql`select * from melarc.handshake_override(${id}::uuid, ${stopId}::uuid, ${note})`,
        );
        return rows.rows[0];
      });
      if (answer === undefined) throw new Error('The override was not made');
      const view = handshakeViewOf(handshakeFactsOf(stopId, answer));
      await this.#recordException(
        audit,
        handle,
        'pickup.handshake.fallback_override',
        stopId,
        answer,
        note,
      );

      const kept: HandshakeAnswer = { handshake: view };
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(kept)),
      });
      return kept;
    });
  }

  // ---- resolveHandshake ---------------------------------------------------------------------------------------------------------

  async resolve(
    authorized: AuthorizedRequest,
    correlationId: string,
    stopId: string,
    request: Retry & { readonly body: ResolveBody },
  ): Promise<HandshakeAnswer> {
    const { runner, audit, idempotency } = this.#options;
    const officerId = officerOf(authorized);
    requireKey(request.idempotencyKey);
    const note = noteOf(request.body.note, 'note');
    // The evidence a note may cite is stored by the evidence store (S1.11, not built yet): until it exists no reference can name a stored record.
    if (request.body.evidence_ids !== undefined && request.body.evidence_ids.length > 0) {
      throw ApiException.of(
        ErrorCode.EvidenceNotStored,
        'A referenced evidence record is not stored',
      );
    }

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'STAFF',
        principalId: officerId,
        operationId: RESOLVE,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') return storedAnswer(begun.response.body);
      settle(begun.outcome);

      const answer = await operation('STAFF', async () => {
        const rows = await tx.execute(
          sql`select * from melarc.handshake_resolve(${stopId}::uuid, ${note})`,
        );
        return rows.rows[0];
      });
      if (answer === undefined) throw new Error('The resolution was not made');
      const view = handshakeViewOf(handshakeFactsOf(stopId, answer));
      await this.#recordException(
        audit,
        handle,
        'pickup.handshake.manually_resolved',
        stopId,
        answer,
        note,
      );

      const kept: HandshakeAnswer = { handshake: view };
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(kept)),
      });
      return kept;
    });
  }

  /**
   * The enhanced event of an officer's exception (`pickup.handshake.fallback_override`, `pickup.handshake.manually_resolved`): the handshake that ended
   * outside the ladder's ordinary rungs, with the officer's note and the change it made. The database wrote the events of the handshake's own end and the
   * close of the stop in the same change; this one is the officer's, as the catalogue makes it an enhanced event of the staff member.
   */
  async #recordException(
    audit: AuditWriter,
    handle: TransactionHandle,
    code: 'pickup.handshake.fallback_override' | 'pickup.handshake.manually_resolved',
    stopId: string,
    answer: Readonly<Record<string, unknown>>,
    note: string,
  ): Promise<void> {
    const stops = await transactionOf(handle).execute(sql`
      select pickup_manifest_id, pickup_request_id, responsible_hub_id from pickup_stop where id = ${stopId}::uuid`);
    const stop = stops.rows[0] as
      | { pickup_manifest_id: string; pickup_request_id: string; responsible_hub_id: string }
      | undefined;
    if (stop === undefined) throw new Error('A stop an officer closed cannot be read');
    const previous =
      typeof answer.out_previous_state === 'string' ? answer.out_previous_state : null;
    await audit.write(handle, {
      code,
      enhanced: true,
      outcome: 'SUCCEEDED',
      object: { type: 'CollectionHandshake', id: String(answer.out_handshake_id) },
      responsibleHubId: stop.responsible_hub_id,
      ...(previous === null ? {} : { previousState: previous }),
      resultingState: String(answer.out_state),
      note,
      beforeAfter: {
        handshake_state: { before: previous, after: String(answer.out_state) },
        pickup_stop_state: { before: 'ARRIVED', after: String(answer.out_stop_state) },
      },
      relatedIds: {
        pickup_stop_id: stopId,
        pickup_manifest_id: stop.pickup_manifest_id,
        pickup_request_id: stop.pickup_request_id,
      },
      detail: { channel: 'OPS_OVERRIDE' },
    });
  }
}

// ---- the small judgements ------------------------------------------------------------------------------------------------------

function riderOf(authorized: AuthorizedRequest): string {
  if (authorized.session.principalType !== 'RIDER') {
    throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
  }
  return authorized.session.principalId.toLowerCase();
}

function officerOf(authorized: AuthorizedRequest): string {
  if (authorized.session.principalType !== 'STAFF') {
    throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
  }
  return authorized.session.principalId.toLowerCase();
}

function requireKey(key: string): void {
  if (!isIdempotencyKey(key)) {
    throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
      violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
    });
  }
}

/** The outcome of `begin` for a command that is to run: anything but a fresh start is the conflict of the key or a defect. */
function settle(outcome: string): void {
  if (outcome === 'CONFLICT') {
    throw ApiException.of(
      ErrorCode.IdempotencyKeyConflict,
      'That Idempotency-Key was used with a different request',
    );
  }
  if (outcome !== 'NEW') {
    // A record that began and did not complete is a stranded one (OB-100): the command is not run again, and nothing is invented.
    throw new Error('An idempotency record of this command is stranded');
  }
}

/** An officer's note: required (a blank one is `REASON_REQUIRED`), and no more than the ledger could keep. */
function noteOf(text: string, name: string): string {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed === '') {
    throw ApiException.of(ErrorCode.ReasonRequired, 'A note is required', { rule: 'note' });
  }
  const rule = noteRefusal(trimmed);
  if (rule !== undefined) throw invalid(name, rule);
  return trimmed;
}

/** The length of a code, the platform's setting (a rider's context reads this one row; the database reads the others inside its operations). */
async function codeLength(tx: ReturnType<typeof transactionOf>): Promise<number> {
  const rows = await tx.execute(
    sql`select (value #>> '{}')::integer as length from setting where key = 'handshake_code_length'`,
  );
  const length = (rows.rows[0] as { length: number } | undefined)?.length;
  if (length === undefined || !Number.isSafeInteger(length) || length < 4 || length > 8) {
    throw new Error('The setting handshake_code_length is missing or not between 4 and 8');
  }
  return length;
}

/** What a stored answer of a fallback was: the handshake, or the refusal it committed (told again as it was). */
function answerOfStored(status: number, body: Uint8Array): Settled {
  const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as Settled;
  return status >= 400 && 'refusal' in parsed
    ? { refusal: parsed.refusal }
    : { handshake: (parsed as HandshakeAnswer).handshake };
}

function storedAnswer(body: Uint8Array): HandshakeAnswer {
  return JSON.parse(Buffer.from(body).toString('utf8')) as HandshakeAnswer;
}
