import { sql } from 'drizzle-orm';

import { guardReasonIn } from '../../database/database-failures.js';
import { timestampOf } from '../../database/timestamps.js';
import { isUuid } from '../../database/transaction-context.js';
import { securityContextOf, transactionOf } from '../../database/transaction-handle.js';
import type { SettingsReader } from '../../settings/settings-reader.js';
import { randomUUIDv7 } from '../crypto/uuid-v7.js';
import type { Clock } from '../ports/clock.port.js';
import type { DeliveryJobRef, DeliveryQueue } from '../ports/delivery-queue.port.js';
import type { PrincipalRef } from '../ports/identity-directory.port.js';
import type { TokenService } from '../ports/token-service.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import {
  CHANNELS_OF_PRINCIPAL,
  RECOVERY_DELIVERY_KIND,
  RECOVERY_LINK_LIFETIME_SETTING,
  RECOVERY_PRINCIPAL_TYPES,
  RECOVERY_REDEMPTION_TYPE,
  RECOVERY_TOKEN_HASH_BYTES,
  type RecoveryChannel,
  type RecoveryPrincipalType,
  type RecoveryRequestState,
} from './recovery-vocabulary.js';

/** The columns a `StoredRecovery` is made from. **The token hash is not among them**: nothing that reads a request needs it back. */
const COLUMNS = sql.raw(
  `id, principal_type, principal_id, channel, state, issued_at, expires_at, initiated_by, consumed_at`,
);

interface RecoveryColumns {
  readonly id: string;
  readonly principal_type: RecoveryPrincipalType;
  readonly principal_id: string;
  readonly channel: RecoveryChannel;
  readonly state: RecoveryRequestState;
  /** A raw statement returns an instant as the server's text; `timestampOf` reads it. */
  readonly issued_at: Date | string;
  readonly expires_at: Date | string;
  readonly initiated_by: string | null;
  readonly consumed_at: Date | string | null;
}

/** A recovery request as the platform reads it: whose it is, how it travels and where it stands, and never its hash. */
export interface StoredRecovery {
  readonly id: string;
  readonly principalType: RecoveryPrincipalType;
  readonly principalId: string;
  readonly channel: RecoveryChannel;
  readonly state: RecoveryRequestState;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly initiatedBy: string | null;
  readonly consumedAt: Date | null;
}

/** A live link of a credential, and whether it was issued inside the supersede guard (judged on the database's clock). */
export interface LiveRecovery extends StoredRecovery {
  readonly withinGuard: boolean;
}

function recoveryOf(row: RecoveryColumns): StoredRecovery {
  return {
    id: row.id,
    principalType: row.principal_type,
    principalId: row.principal_id,
    channel: row.channel,
    state: row.state,
    issuedAt: timestampOf(row.issued_at),
    expiresAt: timestampOf(row.expires_at),
    initiatedBy: row.initiated_by,
    consumedAt: row.consumed_at === null ? null : timestampOf(row.consumed_at),
  };
}

export interface IssueRecoveryRequest {
  readonly principal: PrincipalRef;
  readonly channel: RecoveryChannel;
  /** The registered address, resolved from the principal's record by the caller and never from a request. */
  readonly destination: string;
  /** The link the principal follows, made from the token that exists nowhere else: the queue seals it with the destination. */
  readonly link: (token: string) => string;
  /** A vendor's account identifier, which every vendor message carries beside the link; absent for a staff member's. */
  readonly accountIdentifier?: string;
  /** The administrator who initiated it; absent for self-service. */
  readonly initiatedBy?: string;
}

export interface IssuedRecovery {
  readonly request: StoredRecovery;
  /** Never returned to a caller: it goes into the message and nowhere else. */
  readonly token: string;
  readonly job: DeliveryJobRef;
}

/** A use of the store that is wrong: a context that may not reach recovery requests, or a request that is not one. Never a value. */
export class RecoveryRequestStoreError extends Error {
  constructor(readonly field: string) {
    super(`The recovery request store refused the call: ${field}`);
    this.name = 'RecoveryRequestStoreError';
  }
}

/** A completion that met a link which lapsed while it waited for the row's lock: the table's guard refused it, after the wait. */
export class RecoveryRequestExpiredError extends Error {
  constructor() {
    super('The recovery request expired while the completion waited for it');
    this.name = 'RecoveryRequestExpiredError';
  }
}

export interface RecoveryRequestStoreOptions {
  readonly tokens: Pick<TokenService, 'issue' | 'hash'>;
  /** The delivery path of S0.17: a message is queued, and cancelled, in the caller's transaction. */
  readonly queue: Pick<DeliveryQueue, 'enqueue' | 'cancel'>;
  /** Reads `recovery_link_ttl_minutes`. */
  readonly settings: Pick<SettingsReader, 'integer'>;
  /** The time of the identifiers it makes (UUIDv7). Issue, expiry and consumption are the database's. */
  readonly clock: Pick<Clock, 'now'>;
}

/** The key under which an administrator recovers a principal of each type (permissions.md section 7: Platform Admin, every hub). */
const RECOVERY_KEY_OF: Readonly<Record<RecoveryPrincipalType, string>> = Object.freeze({
  STAFF: 'staff.credential.recover',
  VENDOR: 'vendor.credential.recover',
});

const isRecoveryPrincipal = (
  principal: PrincipalRef,
): principal is PrincipalRef & { type: RecoveryPrincipalType } =>
  (RECOVERY_PRINCIPAL_TYPES as readonly string[]).includes(principal.type) && isUuid(principal.id);

/**
 * The store of recovery requests (S0.50, S0.51; domain-model.md section 6.8 `RecoveryRequest`; credential-recovery.md sections 5.5 and
 * 5.7). Every method joins the caller's transaction, so a request, its message, the event of the act and the act's other effects commit
 * together or not at all. **The identity's lock is the caller's** (the order of SECURITY_DESIGN.md section 13.10a: identity, then the
 * request): the bound of two live links and the eligibility it is issued under are judged by the caller under it.
 *
 * - **A request is found by the hash of its token and by its principal, and by nothing else**: there is no list across principals.
 * - **A token is made here and shown to nobody**: the store keeps the SHA-256 of the 32 decoded bytes and hands the token to the message.
 * - **Time is the database's.** `issued_at` and `expires_at` come from one `clock_timestamp()` of the issuing statement; the lifetime is
 *   `recovery_link_ttl_minutes`; a link is live while `now < expires_at`, judged in the statement that reads it.
 * - **A live link** is a `PENDING`, unexpired request whose message did not end `FAILED` or `CANCELLED`: one that was never delivered does
 *   not count toward the cap (Product decision of 8 October 2026).
 */
export class RecoveryRequestStore {
  readonly #tokens: Pick<TokenService, 'issue' | 'hash'>;
  readonly #queue: Pick<DeliveryQueue, 'enqueue' | 'cancel'>;
  readonly #settings: Pick<SettingsReader, 'integer'>;
  readonly #clock: Pick<Clock, 'now'>;

  constructor(options: RecoveryRequestStoreOptions) {
    this.#tokens = options.tokens;
    this.#queue = options.queue;
    this.#settings = options.settings;
    this.#clock = options.clock;
  }

  /**
   * The live links of a principal's credential, newest first, each with whether it was issued less than `guardSeconds` ago. Read on one
   * database time, after the identity's lock the caller holds.
   */
  async liveOf(
    handle: TransactionHandle,
    principal: PrincipalRef,
    guardSeconds: number,
  ): Promise<readonly LiveRecovery[]> {
    this.#assertContext(handle, principal);
    if (!isRecoveryPrincipal(principal)) throw new RecoveryRequestStoreError('principal');
    if (!Number.isSafeInteger(guardSeconds) || guardSeconds < 0)
      throw new RecoveryRequestStoreError('guardSeconds');
    const result = await transactionOf(handle).execute(sql`
      with at as (select clock_timestamp() as now)
      select ${COLUMNS}, (r.issued_at > at.now - make_interval(secs => ${guardSeconds}::int)) as within_guard
        from recovery_request r, at
       where r.principal_type = ${principal.type} and r.principal_id = ${principal.id}::uuid
         and r.state = 'PENDING' and r.expires_at > at.now
         and not exists (select 1 from credential_delivery_job j
                          where j.redemption_record_type = ${RECOVERY_REDEMPTION_TYPE} and j.redemption_record_id = r.id
                            and j.state in ('FAILED', 'CANCELLED'))
       order by r.issued_at desc, r.id desc`);
    return (result.rows as unknown as (RecoveryColumns & { within_guard: boolean })[]).map(
      (row) => ({
        ...recoveryOf(row),
        withinGuard: row.within_guard,
      }),
    );
  }

  /** Issues a request and queues its message, in the caller's transaction. The caller has judged the eligibility and the cap. */
  async issue(handle: TransactionHandle, request: IssueRecoveryRequest): Promise<IssuedRecovery> {
    const { principal } = request;
    this.#assertContext(handle, principal);
    if (!isRecoveryPrincipal(principal)) throw new RecoveryRequestStoreError('principal');
    if (!(CHANNELS_OF_PRINCIPAL[principal.type] as readonly string[]).includes(request.channel)) {
      throw new RecoveryRequestStoreError('channel');
    }
    if (typeof request.destination !== 'string' || typeof request.link !== 'function') {
      throw new RecoveryRequestStoreError('delivery');
    }
    const initiatedBy = request.initiatedBy ?? null;
    if (initiatedBy !== null && !isUuid(initiatedBy))
      throw new RecoveryRequestStoreError('initiatedBy');
    const minutes = await this.#settings.integer(handle, RECOVERY_LINK_LIFETIME_SETTING);
    if (!Number.isSafeInteger(minutes) || minutes < 1) {
      throw new RangeError('The lifetime of a recovery link is a positive whole number of minutes');
    }

    const issued = this.#tokens.issue();
    const inserted = await transactionOf(handle).execute(sql`
      with at as (select clock_timestamp() as now)
      insert into recovery_request (id, principal_type, principal_id, channel, token_hash, issued_at, expires_at, state, initiated_by)
      select ${randomUUIDv7(this.#clock)}::uuid, ${principal.type}, ${principal.id}::uuid, ${request.channel},
             ${Buffer.from(issued.hash)}::bytea, at.now, at.now + make_interval(mins => ${minutes}::int), 'PENDING',
             ${initiatedBy}::uuid
        from at
      returning ${COLUMNS}`);
    const stored = recoveryOf(inserted.rows[0] as unknown as RecoveryColumns);
    const job = await this.#queue.enqueue(handle, {
      kind: RECOVERY_DELIVERY_KIND,
      redemption: { type: RECOVERY_REDEMPTION_TYPE, id: stored.id },
      principal,
      channel: request.channel,
      destination: request.destination,
      link: request.link(issued.token),
      ...(request.accountIdentifier === undefined
        ? {}
        : { accountIdentifier: request.accountIdentifier }),
      expiresAt: stored.expiresAt,
    });
    return { request: stored, token: issued.token, job };
  }

  /**
   * The request a token belongs to **if it can be used now**, with no lock: the cheap look that spares a hash for a token that was never
   * going to work. Nothing decided on it is final; `lockLive` is what a transaction asks once it holds the identity's lock.
   */
  async findLiveByToken(handle: TransactionHandle, token: string): Promise<StoredRecovery | null> {
    this.#assertAuthentication(handle);
    const hash = this.#hashOf(token);
    if (hash === null) return null;
    const result = await transactionOf(handle).execute(sql`
      select ${COLUMNS} from recovery_request
       where token_hash = ${Buffer.from(hash)} and state = 'PENDING' and expires_at > clock_timestamp()`);
    const row = result.rows[0] as unknown as RecoveryColumns | undefined;
    return row === undefined ? null : recoveryOf(row);
  }

  /**
   * Locks the request a token belongs to (`FOR NO KEY UPDATE`) and **then**, in a statement of its own, judges on a fresh database time
   * whether it can still be used: `PENDING` and not past its expiry. Two statements because an expression read in the statement that
   * takes a lock is read before the wait for it. The caller holds the identity's lock already (identity, then request).
   */
  async lockLive(handle: TransactionHandle, token: string): Promise<StoredRecovery | null> {
    this.#assertAuthentication(handle);
    const hash = this.#hashOf(token);
    if (hash === null) return null;
    const database = transactionOf(handle);
    const locked = await database.execute(
      sql`select id from recovery_request where token_hash = ${Buffer.from(hash)} for no key update`,
    );
    const id = (locked.rows[0] as { id: string } | undefined)?.id;
    if (id === undefined) return null;
    const judged = await database.execute(sql`
      select ${COLUMNS} from recovery_request
       where id = ${id}::uuid and state = 'PENDING' and expires_at > clock_timestamp()`);
    const row = judged.rows[0] as unknown as RecoveryColumns | undefined;
    return row === undefined ? null : recoveryOf(row);
  }

  /**
   * Consumes a request the caller has locked and judged live, once, and cancels its message. Null when it is no longer `PENDING` and live
   * on the clock read by the statement itself. A link that lapsed in the wait for a lock that left its row unchanged is refused by the
   * table's guard, with its reason: that alone is `RecoveryRequestExpiredError`, for the caller to roll back and answer as an invalid link.
   */
  async consume(handle: TransactionHandle, id: string): Promise<StoredRecovery | null> {
    this.#assertAuthentication(handle);
    if (!isUuid(id)) throw new RecoveryRequestStoreError('id');
    let result;
    try {
      result = await transactionOf(handle).execute(sql`
        update recovery_request set state = 'CONSUMED', consumed_at = clock_timestamp()
         where id = ${id}::uuid and state = 'PENDING' and expires_at > clock_timestamp()
        returning ${COLUMNS}`);
    } catch (error) {
      if (guardReasonIn(error) === 'RECOVERY_EXPIRED') throw new RecoveryRequestExpiredError();
      throw error;
    }
    const row = result.rows[0] as unknown as RecoveryColumns | undefined;
    if (row === undefined) return null;
    await this.#cancelMessage(handle, id);
    return recoveryOf(row);
  }

  /**
   * Ends every other `PENDING` request of the principal's credential, in the transaction of the completed recovery that ends them: one past
   * its expiry becomes `EXPIRED`, any other `SUPERSEDED`, and each one's message is cancelled. The rows are locked in id order, so two
   * endings that overlap cannot wait for each other in a cycle.
   */
  async endOthers(
    handle: TransactionHandle,
    principal: PrincipalRef,
    exceptId: string,
  ): Promise<{ readonly superseded: readonly string[]; readonly expired: readonly string[] }> {
    this.#assertAuthentication(handle);
    if (!isRecoveryPrincipal(principal)) throw new RecoveryRequestStoreError('principal');
    if (!isUuid(exceptId)) throw new RecoveryRequestStoreError('exceptId');
    const result = await transactionOf(handle).execute(sql`
      with locked as (
        select id, expires_at from recovery_request
         where principal_type = ${principal.type} and principal_id = ${principal.id}::uuid and state = 'PENDING'
           and id <> ${exceptId}::uuid
         order by id for no key update
      )
      update recovery_request as r
         set state = case when l.expires_at <= clock_timestamp() then 'EXPIRED' else 'SUPERSEDED' end
        from locked l where r.id = l.id
      returning r.id, r.state`);
    const rows = result.rows as { id: string; state: 'EXPIRED' | 'SUPERSEDED' }[];
    for (const row of rows) await this.#cancelMessage(handle, row.id);
    return {
      superseded: rows
        .filter((row) => row.state === 'SUPERSEDED')
        .map((row) => row.id)
        .toSorted(),
      expired: rows
        .filter((row) => row.state === 'EXPIRED')
        .map((row) => row.id)
        .toSorted(),
    };
  }

  #hashOf(token: string): Uint8Array | null {
    if (typeof token !== 'string') return null;
    const hash = this.#tokens.hash(token);
    return hash?.length !== RECOVERY_TOKEN_HASH_BYTES ? null : hash;
  }

  async #cancelMessage(handle: TransactionHandle, id: string): Promise<void> {
    await this.#queue.cancel(handle, {
      by: 'redemption',
      redemption: { type: RECOVERY_REDEMPTION_TYPE, id },
    });
  }

  /**
   * Issuing and reading the live links: the authentication capability's (self-service), and a staff member's under the recovery key of the
   * principal's type (an administrator's recovery, S0.51b; migration 0038 binds those arms to the principal the act has locked).
   */
  #assertContext(handle: TransactionHandle, principal: PrincipalRef): void {
    const context = securityContextOf(handle);
    if (context.principalType === 'SYSTEM' && context.taskCapability === 'authentication') return;
    const key = Object.hasOwn(RECOVERY_KEY_OF, principal.type)
      ? RECOVERY_KEY_OF[principal.type as RecoveryPrincipalType]
      : undefined;
    if (context.principalType === 'STAFF' && key !== undefined && context.authorizationKey === key)
      return;
    throw new RecoveryRequestStoreError('context');
  }

  /** Redeeming and ending: the authentication capability's alone. */
  #assertAuthentication(handle: TransactionHandle): void {
    const context = securityContextOf(handle);
    if (context.principalType !== 'SYSTEM' || context.taskCapability !== 'authentication') {
      throw new RecoveryRequestStoreError('context');
    }
  }
}
