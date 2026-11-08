import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { SessionStore } from '../platform/auth/ports/session-store.port.js';
import type { TokenService } from '../platform/auth/ports/token-service.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { buildEnrolmentUri, parseEnrolmentUri } from '../platform/auth/rider/enrolment-uri.js';
import {
  DEVICE_BINDABLE_RIDER_STATUSES,
  RIDER_DEVICE_KIND,
} from '../platform/auth/rider/rider-vocabulary.js';
import type {
  IssuedGrant,
  SetupGrantStore,
} from '../platform/auth/setup-grants/setup-grant-store.js';
import type { RiderDeviceGrantPurpose } from '../platform/auth/setup-grants/setup-grant-vocabulary.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import {
  ReasonRefusedError,
  type ReasonRequest,
  type ReasonValidator,
  type ValidatedReason,
} from '../platform/settings/reason-validator.js';
import { lockRider, requireRiderVersion, type LockedRider } from './rider-locked-identity.js';
import { requiredNote } from './staff-note.js';

/** What `revokeRiderDevice` takes (`DeviceRevocation`): the reason alone. The path names the rider; the binding is whichever one is current. */
export interface RiderRevocationRequest {
  readonly reason_code: string;
}

/** What `reregisterRiderDevice` takes (`RiderDeviceReregistration`): the path names the rider; no device and no principal. */
export interface RiderReregistrationRequest {
  readonly reason_code: string;
  readonly verification_note: string;
}

/**
 * What the two registration operations answer (`DeviceEnrolmentGrant`): the enrolment URI the Ops Portal renders as a QR code, when the
 * grant ends, and the rider it is bound to (display only, so the officer can confirm). **The URI is the only place the grant's token and
 * the attestation challenge appear**, in an answer served `no-store` that is never logged, audited or cached.
 */
export interface DeviceEnrolmentGrantView {
  readonly enrolment_uri: string;
  readonly expires_at: string;
  readonly rider_id: string;
}

export interface RiderDeviceAdministrationOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly grants: Pick<SetupGrantStore, 'issue'>;
  readonly idempotency: IdempotencyStore;
  /** The attestation challenge is a token of its own: 32 random bytes, shown once, of which only the SHA-256 is kept with the grant. */
  readonly tokens: Pick<TokenService, 'issue'>;
  readonly reasons: Pick<ReasonValidator, 'validate'>;
  /** Ends the session on a revoked device (S0.58). */
  readonly sessions: Pick<SessionStore, 'terminate'>;
}

const OPERATION_REGISTER = 'registerRiderDevice';
const OPERATION_REREGISTER = 'reregisterRiderDevice';
const OPERATION_REVOKE = 'revokeRiderDevice';

const stateConflict = (message: string): ApiException =>
  ApiException.of(ErrorCode.StateConflict, message);

/** A reason the catalogue refuses is the contract's `REASON_REQUIRED` or `REASON_NOT_ACTIVE`; anything else is not this function's. */
async function validated(
  reasons: Pick<ReasonValidator, 'validate'>,
  handle: TransactionHandle,
  request: ReasonRequest,
): Promise<ValidatedReason> {
  try {
    return await reasons.validate(handle, request);
  } catch (error) {
    if (error instanceof ReasonRefusedError) {
      throw ApiException.of(
        error.code === 'REASON_REQUIRED' ? ErrorCode.ReasonRequired : ErrorCode.ReasonNotActive,
        error.message,
      );
    }
    throw error;
  }
}

/** The answer in the form it is stored and replayed: the non-secret part, which the idempotency record keeps as for any operation. */
interface StoredGrantAnswer {
  readonly expires_at: string;
  readonly rider_id: string;
}

const answerOf = (uri: string, stored: StoredGrantAnswer): DeviceEnrolmentGrantView => ({
  enrolment_uri: uri,
  expires_at: stored.expires_at,
  rider_id: stored.rider_id,
});

/**
 * The operations on a rider's device binding by an officer: the two that start one, in the officer's presence (S0.53b `registerRiderDevice`,
 * S0.53c `reregisterRiderDevice`; rider-authentication.md sections 4.2 and 4.3; `AC-SLICE-000-13`, `-23`, `-40`, `-76`, `-108`, `-124`), and the
 * one that ends it on the report of a loss or a theft (S0.58 `revokeRiderDevice`, below). Each runs
 * through `OperationRunner.mutate` in the caller's own staff context under the key of the operation (migration 0040 states the mechanism, as
 * 0029, 0030 and 0035 do): the shared policy locks first, the session judged again under them, the rider locked in the caller's scope, and
 * every row the act touches admitted by a policy of that key and of the rider the act has locked.
 *
 * - **The grant travels as a QR code, never as a message.** A `RIDER_DEVICE_ENROLMENT` or `RIDER_DEVICE_REREGISTRATION` grant is issued with
 *   the hash of a single-use attestation challenge, and the answer is the version-1 enrolment URI that carries the grant's token and the
 *   challenge. Nothing is queued for delivery. The officer sees a code and learns neither the PIN (the rider sets it on the handset), nor the
 *   private key (it never leaves the handset), nor a session credential (enrolment issues none). **No token, challenge or URI is logged,
 *   audited or kept anywhere but the grant's hash, the challenge's hash and, for the first registration alone, the sealed replay.**
 * - **The order of refusal is the contract's** (permission-enforcement.md section 5.1): the guard has answered the key, the rider's scope
 *   (`HUB_SCOPE_VIOLATION`, `NOT_FOUND`) and the schema before this runs. Here, in the transaction that acts: the idempotency of a command
 *   that has a key, then the rider's lock, then the version (`If-Match`, replacement only), the state and the reason.
 * - **A rider has at most one `ACTIVE` device, and the first binding is the rider's first.** `registerRiderDevice` is refused (`STATE_CONFLICT`)
 *   for a rider with an `ACTIVE` device or one that was `REVOKED` (only `reregisterRiderDevice`, with its verification note and the rider's
 *   ETag, binds that rider again); `reregisterRiderDevice` is refused for a rider that has held none. A rider whose access has been ended
 *   (`SUSPENDED`, `OFFBOARDED`) is given no credential. The table's guard holds the same for every writer.
 * - **The first registration is the one operation whose replay returns a secret** (SECURITY_DESIGN.md section 14.16). The URI is stored
 *   sealed, apart from the rest of the answer, in the idempotency record the grant names; the same key and request replay it while the grant
 *   is still usable, a changed request is `IDEMPOTENCY_KEY_CONFLICT`, and a grant that has been consumed, superseded or has expired makes the
 *   replay `STATE_CONFLICT` with no secret (the database erases the sealed fields in the statement that ends the grant). A caller who has
 *   lost authority is refused by the guard before any replay.
 */
export class RiderDeviceAdministration {
  readonly #options: RiderDeviceAdministrationOptions;

  constructor(options: RiderDeviceAdministrationOptions) {
    this.#options = options;
  }

  async register(
    authorized: AuthorizedRequest,
    correlationId: string,
    riderId: string,
    request: { readonly idempotencyKey: string; readonly fingerprint: string },
  ): Promise<DeviceEnrolmentGrantView> {
    const { runner, idempotency } = this.#options;
    const actor = authorized.session.principalId;
    // The key is the store's to keep: one it would refuse is a request that is not valid, not a defect of the server.
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const scope = {
      principalType: 'STAFF',
      principalId: actor,
      operationId: OPERATION_REGISTER,
      key: request.idempotencyKey,
    } as const;

    return runner.mutate(authorized, correlationId, async (handle) => {
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        // The original answer: its non-secret part as stored, and the URI opened from the sealed fields, while the window is open.
        if (begun.sealed === undefined) {
          throw new Error('The replay of a rider registration holds no sealed enrolment URI');
        }
        const uri = Buffer.from(begun.sealed).toString('utf8');
        if (parseEnrolmentUri(uri) === null) {
          throw new Error(
            'The sealed enrolment URI of a rider registration is not a version-1 URI',
          );
        }
        const stored = JSON.parse(
          Buffer.from(begun.response.body).toString('utf8'),
        ) as StoredGrantAnswer;
        return answerOf(uri, stored);
      }
      if (begun.outcome === 'REPLAY_UNAVAILABLE') {
        // The grant has been consumed, superseded or has lapsed: no secret is disclosed and nothing executes again.
        throw stateConflict('The enrolment grant of that request can no longer be shown');
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

      const locked = await lockRider(handle, riderId);
      this.#requireBindable(locked);
      if (locked.facts.active_devices > 0) {
        throw stateConflict(
          'The rider already has an active device: a change of handset is a re-registration',
        );
      }
      if (locked.facts.revoked_devices > 0) {
        throw stateConflict(
          'The rider has had a device revoked: only a re-registration binds the rider again',
        );
      }

      const { issued, uri } = await this.#issue(handle, actor, locked, 'RIDER_DEVICE_ENROLMENT', {
        idempotencyRecordId: begun.recordId,
      });
      const { grant } = issued;
      if (grant.expiresAt === null) throw new Error('A rider device grant has an expiry');
      const stored: StoredGrantAnswer = {
        expires_at: grant.expiresAt.toISOString(),
        rider_id: locked.row.id,
      };
      await idempotency.complete(
        handle,
        scope,
        { status: 200, body: new TextEncoder().encode(JSON.stringify(stored)) },
        { plaintext: new TextEncoder().encode(uri), expiresAt: grant.expiresAt },
      );
      return answerOf(uri, stored);
    });
  }

  async reregister(
    authorized: AuthorizedRequest,
    correlationId: string,
    riderId: string,
    ifMatch: string | undefined,
    body: RiderReregistrationRequest,
  ): Promise<DeviceEnrolmentGrantView> {
    const { runner, reasons } = this.#options;
    const actor = authorized.session.principalId;
    // How identity was verified is required, and recorded: judged first, in the place a malformed body is judged.
    const note = requiredNote(body.verification_note, 'verification_note');

    return runner.mutate(authorized, correlationId, async (handle) => {
      const locked = await lockRider(handle, riderId);
      requireRiderVersion(ifMatch, locked.etag);
      this.#requireBindable(locked);
      if (locked.facts.active_devices + locked.facts.revoked_devices === 0) {
        throw stateConflict(
          'The rider has held no device: the first binding is a registration, and a replacement replaces one',
        );
      }
      const reason = await validated(reasons, handle, {
        reasonCode: body.reason_code,
        operationId: OPERATION_REREGISTER,
        note,
      });
      const { issued, uri } = await this.#issue(
        handle,
        actor,
        locked,
        'RIDER_DEVICE_REREGISTRATION',
        { reason, note },
      );
      const { grant } = issued;
      if (grant.expiresAt === null) throw new Error('A rider device grant has an expiry');
      return answerOf(uri, {
        expires_at: grant.expiresAt.toISOString(),
        rider_id: locked.row.id,
      });
    });
  }

  /**
   * `revokeRiderDevice` (S0.58; rider-authentication.md section 5.3; `AC-SLICE-000-46`, `-74`, `-112`): the report of a lost or stolen handset ends the
   * rider's `ACTIVE` device as `REVOKED` and the live session on it as `DEVICE_REVOKED`, **in one transaction under the rider's lock and with
   * nothing checked first** (no version, no verification of who is asking: a check would leave a stolen handset live for as long as it took).
   * The reason is judged against the catalogue's revocation domain whether or not there is anything to revoke, because a request the contract
   * refuses is refused. **It grants nothing**: re-binding is `reregisterRiderDevice`, in person.
   *
   * - **The rider's lock puts it in an order with a replacement.** A replacement that completes while this waits finds the device it is about to
   *   replace already `REVOKED` and leaves it so (`AC-SLICE-000-74`); one that completed first has made a new device the current binding, and it
   *   is that one this ends. The rider is never left with two `ACTIVE` devices or a session on an ended one.
   * - **A rider with no `ACTIVE` device is answered as one whose binding has been revoked**: `204`, nothing changed and no event, because no
   *   specification says otherwise and the contract declares no code for it. A repeated report is therefore safe, and an officer who cannot tell
   *   whether a first one arrived does not have to (a finding for the Product Owner: the documents are silent).
   * - Only the current binding is touched: a device already `REPLACED` or `REVOKED` stays as it is, and so does every other rider's.
   */
  async revoke(
    authorized: AuthorizedRequest,
    correlationId: string,
    riderId: string,
    body: RiderRevocationRequest,
  ): Promise<void> {
    const { runner, reasons, audit, sessions } = this.#options;
    await runner.mutate(authorized, correlationId, async (handle) => {
      const locked = await lockRider(handle, riderId);
      const reason = await validated(reasons, handle, {
        reasonCode: body.reason_code,
        operationId: OPERATION_REVOKE,
      });
      const deviceId = locked.facts.active_device_id;
      if (deviceId === null) return;

      const ended = await transactionOf(handle).execute(sql`
        update registered_device set status = 'REVOKED', ended_at = clock_timestamp()
         where id = ${deviceId}::uuid and principal_type = 'RIDER' and rider_identity_id = ${locked.row.id}::uuid and status = 'ACTIVE'
        returning id`);
      if (ended.rows.length !== 1) {
        throw new Error('A rider’s active device could not be revoked under the rider’s lock');
      }
      const endedSessions = await sessions.terminate(
        handle,
        { by: 'device', registeredDeviceId: deviceId },
        'DEVICE_REVOKED',
      );
      await audit.write(handle, {
        code: 'auth.device.revoked',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'RegisteredDevice', id: deviceId },
        responsibleHubId: locked.row.primary_hub_id,
        previousState: 'ACTIVE',
        resultingState: 'REVOKED',
        beforeAfter: { status: { before: 'ACTIVE', after: 'REVOKED' } },
        reason: { code: reason.code, label: reason.label },
        relatedIds: { principal_id: locked.row.id, ended_session_ids: [...endedSessions] },
        detail: { device_kind: RIDER_DEVICE_KIND, cause: 'REPORTED' },
      });
      for (const sessionId of endedSessions) {
        await audit.write(handle, {
          code: 'auth.session.terminated',
          enhanced: false,
          enhancedBasis: 'ROUTINE_TERMINATION',
          outcome: 'SUCCEEDED',
          object: { type: 'Session', id: sessionId },
          responsibleHubId: locked.row.primary_hub_id,
          reason: { code: 'DEVICE_REVOKED', label: 'The handset was revoked' },
          relatedIds: { principal_id: locked.row.id, registered_device_id: deviceId },
        });
      }
    });
  }

  /** A rider whose access has been ended is given no credential (`SUSPENDED`, `OFFBOARDED`); the others may be bound a device. */
  #requireBindable(locked: LockedRider): void {
    if (!(DEVICE_BINDABLE_RIDER_STATUSES as readonly string[]).includes(locked.facts.status)) {
      throw stateConflict('A rider whose access has ended is not given a device');
    }
  }

  /**
   * Issues the grant with the attestation challenge beside it, ends the earlier pending grant of the same purpose (the store supersedes it,
   * and the database ends its replay), builds the URI from the two tokens that exist nowhere else, and records both events. **Nothing is
   * queued**: the grant is shown as a QR code and travels in no message.
   */
  async #issue(
    handle: TransactionHandle,
    actor: string,
    locked: LockedRider,
    purpose: RiderDeviceGrantPurpose,
    given: {
      readonly idempotencyRecordId?: string;
      readonly reason?: ValidatedReason;
      readonly note?: string;
    },
  ): Promise<{ readonly issued: IssuedGrant; readonly uri: string }> {
    const { grants, audit, tokens } = this.#options;
    const rider = locked.row;
    const challenge = tokens.issue();
    const issued = await grants.issue(handle, {
      principal: { type: 'RIDER', id: rider.id },
      purpose,
      issuedBy: actor,
      attestationChallengeHash: challenge.hash,
      ...(given.idempotencyRecordId === undefined
        ? {}
        : { idempotencyRecordId: given.idempotencyRecordId }),
    });
    if (issued.supersededGrantId !== null) {
      await audit.write(handle, {
        code: 'auth.setup_grant.superseded',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'SetupGrant', id: issued.supersededGrantId },
        responsibleHubId: rider.primary_hub_id,
        previousState: 'PENDING',
        resultingState: 'SUPERSEDED',
        relatedIds: { principal_id: rider.id, superseded_by: issued.grant.id },
        detail: { purpose, principal_type: 'RIDER' },
      });
    }
    await audit.write(handle, {
      code: 'auth.setup_grant.issued',
      enhanced: false,
      outcome: 'SUCCEEDED',
      object: { type: 'SetupGrant', id: issued.grant.id },
      responsibleHubId: rider.primary_hub_id,
      ...(given.reason === undefined
        ? {}
        : { reason: { code: given.reason.code, label: given.reason.label } }),
      ...(given.note === undefined ? {} : { note: given.note }),
      relatedIds: { principal_id: rider.id, issued_by: actor },
      detail: { purpose, channel: 'QR', principal_type: 'RIDER' },
    });
    return { issued, uri: buildEnrolmentUri(issued.token, challenge.token) };
  }
}
