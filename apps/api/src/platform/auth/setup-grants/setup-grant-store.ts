import { sql, type SQL } from 'drizzle-orm';

import { guardReasonIn } from '../../database/database-failures.js';
import { timestampOf } from '../../database/timestamps.js';
import { isUuid } from '../../database/transaction-context.js';
import { securityContextOf, transactionOf } from '../../database/transaction-handle.js';
import type { DeliveryKind } from '../../delivery/delivery-vocabulary.js';
import type { SettingsReader } from '../../settings/settings-reader.js';
import { randomUUIDv7 } from '../crypto/uuid-v7.js';
import type { Clock } from '../ports/clock.port.js';
import type {
  DeliveryChannel,
  DeliveryJobRef,
  DeliveryQueue,
} from '../ports/delivery-queue.port.js';
import type { PrincipalRef } from '../ports/identity-directory.port.js';
import type { TokenService } from '../ports/token-service.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import {
  SetupGrantContextError,
  SetupGrantExpiredError,
  SetupGrantRequestError,
} from './setup-grant-errors.js';
import { mayEndGrant, mayIssueGrant } from './issuing-authority.js';
import {
  CONTINUATION_PURPOSE,
  EPISODE_PURPOSES,
  GRANT_PRINCIPAL_TYPES,
  GRANT_TOKEN_HASH_BYTES,
  NO_EXPIRY_PURPOSE,
  PURPOSES_OF_PRINCIPAL,
  REPLAYED_GRANT_PURPOSE,
  RIDER_DEVICE_PURPOSES,
  SETUP_GRANT_LIFETIME_SETTING,
  isMessagePurpose,
  type GrantPrincipalType,
  type SetupGrantPurpose,
  type SetupGrantState,
} from './setup-grant-vocabulary.js';

/** The record a delivery job serves when it carries a grant. */
const REDEMPTION_TYPE = 'SETUP_GRANT';

/**
 * The columns a `StoredGrant` is made from. **The token hash and the attestation challenge hash are not among them**: nothing that
 * reads a grant needs a hash back, and a value that is never selected cannot be returned, logged or cached by mistake.
 */
const COLUMNS = sql.raw(
  `id, principal_type, principal_id, purpose, state, issued_at, expires_at, issued_by, episode_id, supersedes_grant_id,
   continued_from_grant_id, consumed_at`,
);

interface GrantColumns {
  readonly id: string;
  readonly principal_type: GrantPrincipalType;
  readonly principal_id: string;
  readonly purpose: SetupGrantPurpose;
  readonly state: SetupGrantState;
  /** A raw statement returns an instant as the server's text; `timestampOf` reads it. */
  readonly issued_at: Date | string;
  readonly expires_at: Date | string | null;
  readonly issued_by: string | null;
  readonly episode_id: string | null;
  readonly supersedes_grant_id: string | null;
  readonly continued_from_grant_id: string | null;
  readonly consumed_at: Date | string | null;
}

/** A setup grant as the platform reads it: what it is for and where it stands, and never a hash. */
export interface StoredGrant {
  readonly id: string;
  readonly principalType: GrantPrincipalType;
  readonly principalId: string;
  readonly purpose: SetupGrantPurpose;
  readonly state: SetupGrantState;
  readonly issuedAt: Date;
  /** Null for `BOOTSTRAP_SETUP` alone. */
  readonly expiresAt: Date | null;
  readonly issuedBy: string | null;
  readonly episodeId: string | null;
  readonly supersedesGrantId: string | null;
  readonly continuedFromGrantId: string | null;
  readonly consumedAt: Date | null;
}

function grantOf(row: GrantColumns): StoredGrant {
  return {
    id: row.id,
    principalType: row.principal_type,
    principalId: row.principal_id,
    purpose: row.purpose,
    state: row.state,
    issuedAt: timestampOf(row.issued_at),
    expiresAt: row.expires_at === null ? null : timestampOf(row.expires_at),
    issuedBy: row.issued_by,
    episodeId: row.episode_id,
    supersedesGrantId: row.supersedes_grant_id,
    continuedFromGrantId: row.continued_from_grant_id,
    consumedAt: row.consumed_at === null ? null : timestampOf(row.consumed_at),
  };
}

/**
 * The message that carries a grant to its principal, for the four purposes that travel that way (`isMessagePurpose`). The store
 * builds the link from the token it has just made, queues the message in the issuing transaction and never sees a provider.
 * The destination is the caller's to resolve from the principal's record and never from a request (state-machines.md §19).
 */
export interface GrantDelivery {
  readonly kind: DeliveryKind;
  readonly channel: DeliveryChannel;
  readonly destination: string;
  /** The link the principal follows, made from the token that exists nowhere else: the queue seals it with the destination. */
  readonly link: (token: string) => string;
  /** A vendor's account identifier, which its message carries beside the link (S0.47); absent for every other principal. */
  readonly accountIdentifier?: string;
}

export interface IssueGrantRequest {
  readonly principal: PrincipalRef;
  readonly purpose: SetupGrantPurpose;
  /** The authorising actor of an administrative issue; absent for a grant the system issues. */
  readonly issuedBy?: string | null;
  /** The reset episode of an `MFA_REENROLMENT` or `MFA_ENROLMENT` grant. */
  readonly episodeId?: string | null;
  /** The `CONSUMED` grant whose consumption produced this continuation (an `MFA_ENROLMENT` grant). */
  readonly continuedFromGrantId?: string | null;
  /** The hash of the attestation challenge issued beside a rider's device grant (32 bytes). */
  readonly attestationChallengeHash?: Uint8Array | null;
  /**
   * The idempotency record of the `registerRiderDevice` call whose sealed response holds this grant's token and challenge (S0.53b;
   * SECURITY_DESIGN.md §14.16). For the first-registration grant alone: the table refuses it on any other purpose, and the database ends
   * the replay in the statement that takes the grant out of `PENDING`.
   */
  readonly idempotencyRecordId?: string | null;
  readonly delivery?: GrantDelivery;
}

export interface IssuedGrant {
  readonly grant: StoredGrant;
  /** Shown once: 32 random bytes as 43 base64url characters. Only its SHA-256 is stored. */
  readonly token: string;
  /**
   * The live grant of the same purpose that this one ended, which is named in `grant.supersedesGrantId`; null when there was none. A
   * continuation names its source and no predecessor, so for one this is the grant that was ended and `supersedesGrantId` is null.
   */
  readonly supersededGrantId: string | null;
  /** The grants of the same purpose that had lapsed, and were marked `EXPIRED`: history, never named as a predecessor. */
  readonly expiredGrantIds: readonly string[];
  /** The message queued for the grant, or null when it travels no message. */
  readonly job: DeliveryJobRef | null;
}

export interface ConsumeGrantRequest {
  readonly principal: PrincipalRef;
  readonly purpose: SetupGrantPurpose;
  /** The token as presented. Never logged, never in an error. */
  readonly token: string;
}

/** What `supersedePending` ended: the live grants it superseded, and the ones whose expiry had already passed, marked `EXPIRED`. */
export interface EndedGrants {
  readonly superseded: readonly string[];
  readonly expired: readonly string[];
}

export interface SetupGrantStoreOptions {
  readonly tokens: Pick<TokenService, 'issue' | 'hash'>;
  /** The delivery path of S0.17: a message is queued, and cancelled, in the caller's transaction. */
  readonly queue: Pick<DeliveryQueue, 'enqueue' | 'cancel'>;
  /** Reads `recovery_link_ttl_minutes`, the one lifetime every grant but the bootstrap secret has. */
  readonly settings: Pick<SettingsReader, 'integer'>;
  /** The time of the identifiers it makes (UUIDv7). Issue, expiry and consumption are the database's. */
  readonly clock: Pick<Clock, 'now'>;
}

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

/** The store refuses what the authentication capability's policy would silently hide the effect of. */
function assertAuthentication(handle: TransactionHandle): void {
  const context = securityContextOf(handle);
  if (context.principalType !== 'SYSTEM' || context.taskCapability !== 'authentication') {
    throw new SetupGrantContextError();
  }
}

/**
 * Issuing a grant is the authentication capability's and, for the grants an administrator issues to another person, the staff member's
 * own under the key of the operation (S0.36, S0.37; migrations 0029, 0030). The store refuses any other context for the same reason as
 * above, and consumes and looks up as the authentication capability alone.
 */
function assertIssuer(handle: TransactionHandle, purposes: readonly unknown[]): void {
  const context = securityContextOf(handle);
  if (!purposes.every((purpose) => mayIssueGrant(context, purpose as SetupGrantPurpose))) {
    throw new SetupGrantContextError();
  }
}

/** Reading the pending grants of purposes and ending them in the transaction of the act that does it: the same two contexts, and each key for the grants of its own acts. */
function assertEnder(handle: TransactionHandle, purposes: readonly unknown[]): void {
  const context = securityContextOf(handle);
  if (!purposes.every((purpose) => mayEndGrant(context, purpose as SetupGrantPurpose))) {
    throw new SetupGrantContextError();
  }
}

function assertTokenHash(tokenHash: unknown): asserts tokenHash is Uint8Array {
  if (!(tokenHash instanceof Uint8Array) || tokenHash.length !== GRANT_TOKEN_HASH_BYTES) {
    throw new TypeError('A grant is found by the SHA-256 of its token (32 bytes)');
  }
}

function assertPrincipal(principal: unknown): asserts principal is PrincipalRef {
  const given = principal as Partial<PrincipalRef> | null | undefined;
  if (!isOneOf(GRANT_PRINCIPAL_TYPES, given?.type) || !isUuid(given.id)) {
    throw new SetupGrantRequestError('principal');
  }
}

function assertPurposeOf(
  principal: PrincipalRef,
  purpose: unknown,
): asserts purpose is SetupGrantPurpose {
  if (!isOneOf(PURPOSES_OF_PRINCIPAL[principal.type], purpose)) {
    throw new SetupGrantRequestError('purpose');
  }
}

/** A text array literal of values that are already known to be words of a closed set, so that nothing in it needs quoting. */
const textArray = (values: readonly string[]): SQL => sql`${`{${values.join(',')}}`}::text[]`;

/**
 * The store of setup grants (S0.29; domain-model.md §6.8 `SetupGrant`; state-machines.md §19; SECURITY_DESIGN.md §13.9). Every
 * method joins the caller's transaction, under the authentication capability (row-level security admits nothing else to read or
 * write a grant), so issuing a grant, queueing its message, consuming a grant and the act that did it commit together or not at all.
 * **No operation calls it yet**: the bootstrap seed (S0.30) and the credential operations (S0.31, S0.36) are its first callers, and
 * each writes the audit event of its own act (`auth.setup_grant.issued`, `consumed`, `superseded`: the event needs the actor and the
 * channel, which are the operation's to know).
 *
 * - **A grant is found by the hash of its token and by its id, and by nothing else.** There is no list, no scan and no search
 *   (`GBT-E5`, the port half): the capability's policy would allow one across every principal's rows, so the store offers none.
 * - **A token is made here and shown once.** The store keeps the SHA-256 of the 32 decoded bytes (`TokenService.hash`) and returns the
 *   token to the caller, which puts it in the response or hands it to the delivery job. It selects no hash back and logs nothing.
 * - **Time is the database's.** `issued_at` and `expires_at` come from one `clock_timestamp()` of the issuing statement, the lifetime
 *   is `recovery_link_ttl_minutes` (never a figure of the store's own) and `BOOTSTRAP_SETUP` has none. A consumption is judged on a
 *   fresh database time, after the row lock, in the one statement that writes it (valid means `now < expires_at`).
 * - **Issuing ends the live grant first.** A grant of the purpose that has lapsed is marked `EXPIRED` and named by nobody (an expired
 *   grant is never rewritten); a live one becomes `SUPERSEDED`, and the new grant names it. Only a `PENDING` grant ever changes, which
 *   the table's guard holds against every other writer. The superseded grant's message is cancelled in the same transaction.
 */
export class SetupGrantStore {
  readonly #tokens: Pick<TokenService, 'issue' | 'hash'>;
  readonly #queue: Pick<DeliveryQueue, 'enqueue' | 'cancel'>;
  readonly #settings: Pick<SettingsReader, 'integer'>;
  readonly #clock: Pick<Clock, 'now'>;

  constructor(options: SetupGrantStoreOptions) {
    this.#tokens = options.tokens;
    this.#queue = options.queue;
    this.#settings = options.settings;
    this.#clock = options.clock;
  }

  async issue(handle: TransactionHandle, request: IssueGrantRequest): Promise<IssuedGrant> {
    assertIssuer(handle, [request.purpose]);
    const checked = this.#checked(request);
    const lifetimeMinutes = await this.#lifetime(handle, checked.purpose);

    const ended = await this.#endLive(handle, checked.principal, [checked.purpose]);
    for (const id of ended.messaged) await this.#cancelMessage(handle, id);
    const supersededGrantId = ended.superseded[0] ?? null;
    // A grant names one lineage, and a continuation's is its source (the table holds it to that: `setup_grant_one_lineage`). The live
    // grant a continuation ends is still ended and still reported, for the event that says so, but it is not named as a predecessor.
    const predecessorGrantId = checked.continuedFromGrantId === null ? supersededGrantId : null;

    const issued = this.#tokens.issue();
    const database = transactionOf(handle);
    const inserted = await database.execute(sql`
      with at as (select clock_timestamp() as now)
      insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state, issued_by,
                               episode_id, supersedes_grant_id, continued_from_grant_id, attestation_challenge_hash,
                               idempotency_record_id)
      select ${randomUUIDv7(this.#clock)}::uuid, ${checked.principal.type}, ${checked.principal.id}::uuid, ${checked.purpose},
             ${Buffer.from(issued.hash)}::bytea, at.now,
             case when ${lifetimeMinutes}::int is null then null else at.now + make_interval(mins => ${lifetimeMinutes}::int) end,
             'PENDING', ${checked.issuedBy}::uuid, ${checked.episodeId}::uuid, ${predecessorGrantId}::uuid,
             ${checked.continuedFromGrantId}::uuid,
             ${checked.attestationChallengeHash === null ? null : Buffer.from(checked.attestationChallengeHash)}::bytea,
             ${checked.idempotencyRecordId}::uuid
        from at
      returning ${COLUMNS}`);
    const grant = grantOf(inserted.rows[0] as unknown as GrantColumns);

    let job: DeliveryJobRef | null = null;
    if (request.delivery !== undefined && grant.expiresAt !== null) {
      job = await this.#queue.enqueue(handle, {
        kind: request.delivery.kind,
        redemption: { type: REDEMPTION_TYPE, id: grant.id },
        principal: checked.principal,
        channel: request.delivery.channel,
        destination: request.delivery.destination,
        link: request.delivery.link(issued.token),
        ...(request.delivery.accountIdentifier === undefined
          ? {}
          : { accountIdentifier: request.delivery.accountIdentifier }),
        expiresAt: grant.expiresAt,
      });
    }
    return {
      grant,
      token: issued.token,
      supersededGrantId,
      expiredGrantIds: ended.expired,
      job,
    };
  }

  /**
   * Consumes the grant the token belongs to, for this principal and this purpose, once. The row is locked in a statement of its own,
   * and the judgement and the write are one statement after it, so the clock the expiry is judged on is read after any wait for the
   * lock: a request that waited for a rival's consumption meets the consumed row and gets nothing. **Null for every refusal alike**
   * (a token that is malformed, unknown, another purpose's, another principal's, spent, superseded or past its expiry): which of
   * them it was is not for a caller to learn. The grant's message is cancelled in the same transaction.
   *
   * **One refusal is an error and not a null**: a grant that lapsed while the statement waited for a lock that left the row unchanged is
   * judged by the table's guard, after the wait (the `where` was judged before it), and the guard's refusal fails the statement and so
   * the transaction. It is raised as `SetupGrantExpiredError`, and only for the guard's stated reason: the caller lets the transaction
   * roll back and answers the grant as one that cannot be used.
   */
  async consume(
    handle: TransactionHandle,
    request: ConsumeGrantRequest,
  ): Promise<StoredGrant | null> {
    assertAuthentication(handle);
    assertPrincipal(request.principal);
    assertPurposeOf(request.principal, request.purpose);
    const hash = this.#tokens.hash(request.token);
    if (hash === null) return null;

    const database = transactionOf(handle);
    const locked = await database.execute(sql`
      select id from setup_grant
       where token_hash = ${Buffer.from(hash)} and principal_type = ${request.principal.type}
         and principal_id = ${request.principal.id}::uuid and purpose = ${request.purpose}
         for no key update`);
    const id = (locked.rows[0] as { id: string } | undefined)?.id;
    if (id === undefined) return null;

    let result;
    try {
      result = await database.execute(sql`
        update setup_grant
           set state = 'CONSUMED', consumed_at = clock_timestamp()
         where id = ${id}::uuid and state = 'PENDING' and (expires_at is null or expires_at > clock_timestamp())
        returning ${COLUMNS}`);
    } catch (error) {
      // The `where` is judged before a wait for a lock that left the row unchanged, and the table's guard after it: a grant that lapsed
      // in that wait is refused by the guard, with its reason, and that reason alone is this error. Any other failure is rethrown as it
      // was (a lost commit is not this statement's, and a check violation without the reason is a defect).
      if (guardReasonIn(error) === 'GRANT_EXPIRED') throw new SetupGrantExpiredError();
      throw error;
    }
    const row = result.rows[0] as unknown as GrantColumns | undefined;
    if (row === undefined) return null;
    await this.#cancelMessage(handle, id);
    return grantOf(row);
  }

  /**
   * Ends the live grants of the named purposes for a principal, in the transaction of the act that does it (an offboarding, an MFA
   * reset): a grant whose expiry has passed becomes `EXPIRED`, any other `PENDING` one `SUPERSEDED`, and the message of each
   * superseded grant is cancelled. A grant already past `PENDING` keeps its state, and another purpose's is not touched.
   */
  async supersedePending(
    handle: TransactionHandle,
    principal: PrincipalRef,
    purposes: readonly SetupGrantPurpose[],
  ): Promise<EndedGrants> {
    assertEnder(handle, Array.isArray(purposes) ? purposes : []);
    assertPrincipal(principal);
    if (!Array.isArray(purposes) || purposes.length === 0) {
      throw new SetupGrantRequestError('purposes');
    }
    for (const purpose of purposes) assertPurposeOf(principal, purpose);
    const ended = await this.#endLive(handle, principal, [...new Set(purposes)]);
    for (const id of ended.messaged) await this.#cancelMessage(handle, id);
    return { superseded: ended.superseded, expired: ended.expired };
  }

  /**
   * The `PENDING` grants of a principal of the purposes named, oldest first, whatever their expiry (a lapsed grant stays `PENDING` until
   * the next issue rewrites it): what a reset that coalesces reports the expiry of. No hash is read.
   */
  async findPendingOf(
    handle: TransactionHandle,
    principal: PrincipalRef,
    purposes: readonly SetupGrantPurpose[],
  ): Promise<readonly StoredGrant[]> {
    assertEnder(handle, Array.isArray(purposes) ? purposes : []);
    assertPrincipal(principal);
    if (!Array.isArray(purposes) || purposes.length === 0) {
      throw new SetupGrantRequestError('purposes');
    }
    for (const purpose of purposes) assertPurposeOf(principal, purpose);
    const result = await transactionOf(handle).execute(sql`
      select ${COLUMNS} from setup_grant
       where principal_type = ${principal.type} and principal_id = ${principal.id}::uuid
         and purpose = any(${textArray([...new Set(purposes)])}) and state = 'PENDING'
       order by issued_at, id`);
    return (result.rows as unknown as GrantColumns[]).map(grantOf);
  }

  async findById(handle: TransactionHandle, id: string): Promise<StoredGrant | null> {
    assertAuthentication(handle);
    if (!isUuid(id)) throw new TypeError('A grant is identified by its id (a UUID)');
    const result = await transactionOf(handle).execute(
      sql`select ${COLUMNS} from setup_grant where id = ${id}::uuid`,
    );
    const row = result.rows[0] as unknown as GrantColumns | undefined;
    return row === undefined ? null : grantOf(row);
  }

  /**
   * The grant a token belongs to **if it can be used now**: `PENDING` and not past its expiry, judged on the database's clock in the
   * statement itself (`state` alone is not enough: a grant whose expiry has passed stays `PENDING` until the next issue rewrites it).
   * It takes no lock, so it is the cheap look that spares a hash or a proof for a token that was never going to work, and nothing
   * decided on it is final: `lockLive` is what a transaction asks once it holds the identity's lock.
   */
  async findLiveByTokenHash(
    handle: TransactionHandle,
    tokenHash: Uint8Array,
  ): Promise<StoredGrant | null> {
    assertAuthentication(handle);
    assertTokenHash(tokenHash);
    const result = await transactionOf(handle).execute(sql`
      select ${COLUMNS} from setup_grant
       where token_hash = ${Buffer.from(tokenHash)} and state = 'PENDING'
         and (expires_at is null or expires_at > clock_timestamp())`);
    const row = result.rows[0] as unknown as GrantColumns | undefined;
    return row === undefined ? null : grantOf(row);
  }

  /**
   * The SHA-256 of the attestation challenge issued with a rider's device grant (S0.57), **for a grant that can be used now**: `PENDING`,
   * not past its expiry on the database's clock, and of one of the two rider purposes. It is the one thing of a grant that a `StoredGrant`
   * never carries, and it is read for the one caller that needs it, which gives it to the verifier to find in the evidence (the challenge
   * itself went to the handset in the QR and is kept nowhere). The grant is found by the token a request presents; an unknown, spent,
   * superseded or lapsed grant, and a grant of another purpose, is `null`, and which of them it was is not for a caller to learn.
   * It takes no lock: the challenge of a grant never changes (the table's guard keeps it), so what is read here is what the locked
   * grant holds, and the transaction of the act judges the grant again under its lock.
   */
  async attestationChallengeHashOf(
    handle: TransactionHandle,
    tokenHash: Uint8Array,
  ): Promise<Uint8Array | null> {
    assertAuthentication(handle);
    assertTokenHash(tokenHash);
    const result = await transactionOf(handle).execute(sql`
      select attestation_challenge_hash from setup_grant
       where token_hash = ${Buffer.from(tokenHash)} and state = 'PENDING'
         and purpose = any(${textArray(RIDER_DEVICE_PURPOSES)})
         and attestation_challenge_hash is not null
         and (expires_at is null or expires_at > clock_timestamp())`);
    const row = result.rows[0] as { attestation_challenge_hash: Uint8Array } | undefined;
    return row === undefined ? null : new Uint8Array(row.attestation_challenge_hash);
  }

  /**
   * Locks the grant a token belongs to (`FOR NO KEY UPDATE`, the lock `consume` takes) and **then**, in a statement of its own, judges
   * on a fresh database time whether it can still be used: `PENDING` and not past its expiry. Two statements because a lock and a
   * time are not one thing: an expression read in the same statement as the lock is read before the wait for it, so a grant that
   * expired while the request waited would be judged by the time at which the wait began. A request that waited meets the grant as
   * the transaction it waited for left it, and a lapsed one is `null`. The caller holds the identity's lock already (the order is
   * identity, then grant), and decides everything that follows (a seed opened, a code verified) on the answer.
   */
  async lockLive(handle: TransactionHandle, tokenHash: Uint8Array): Promise<StoredGrant | null> {
    assertAuthentication(handle);
    assertTokenHash(tokenHash);
    const database = transactionOf(handle);
    const locked = await database.execute(
      sql`select id from setup_grant where token_hash = ${Buffer.from(tokenHash)} for no key update`,
    );
    const id = (locked.rows[0] as { id: string } | undefined)?.id;
    if (id === undefined) return null;
    const judged = await database.execute(sql`
      select ${COLUMNS} from setup_grant
       where id = ${id}::uuid and state = 'PENDING' and (expires_at is null or expires_at > clock_timestamp())`);
    const row = judged.rows[0] as unknown as GrantColumns | undefined;
    return row === undefined ? null : grantOf(row);
  }

  async findByTokenHash(
    handle: TransactionHandle,
    tokenHash: Uint8Array,
  ): Promise<StoredGrant | null> {
    assertAuthentication(handle);
    assertTokenHash(tokenHash);
    const result = await transactionOf(handle).execute(
      sql`select ${COLUMNS} from setup_grant where token_hash = ${Buffer.from(tokenHash)}`,
    );
    const row = result.rows[0] as unknown as GrantColumns | undefined;
    return row === undefined ? null : grantOf(row);
  }

  /** The request, judged field by field before anything is written, with the optional fields given their absent value. */
  #checked(request: IssueGrantRequest): {
    principal: PrincipalRef;
    purpose: SetupGrantPurpose;
    issuedBy: string | null;
    episodeId: string | null;
    continuedFromGrantId: string | null;
    attestationChallengeHash: Uint8Array | null;
    idempotencyRecordId: string | null;
  } {
    assertPrincipal(request.principal);
    assertPurposeOf(request.principal, request.purpose);
    const { purpose } = request;
    const issuedBy = request.issuedBy ?? null;
    const episodeId = request.episodeId ?? null;
    const continuedFromGrantId = request.continuedFromGrantId ?? null;
    const challenge = request.attestationChallengeHash ?? null;
    const idempotencyRecordId = request.idempotencyRecordId ?? null;

    if (issuedBy !== null && !isUuid(issuedBy)) throw new SetupGrantRequestError('issuedBy');
    if (episodeId !== null && (!isOneOf(EPISODE_PURPOSES, purpose) || !isUuid(episodeId))) {
      throw new SetupGrantRequestError('episodeId');
    }
    if (
      continuedFromGrantId !== null &&
      (purpose !== CONTINUATION_PURPOSE || !isUuid(continuedFromGrantId))
    ) {
      throw new SetupGrantRequestError('continuedFromGrantId');
    }
    const isRiderDevice = isOneOf(RIDER_DEVICE_PURPOSES, purpose);
    if (
      isRiderDevice !== (challenge !== null) ||
      (challenge !== null &&
        (!(challenge instanceof Uint8Array) || challenge.length !== GRANT_TOKEN_HASH_BYTES))
    ) {
      throw new SetupGrantRequestError('attestationChallengeHash');
    }
    if (
      idempotencyRecordId !== null &&
      (purpose !== REPLAYED_GRANT_PURPOSE || !isUuid(idempotencyRecordId))
    ) {
      throw new SetupGrantRequestError('idempotencyRecordId');
    }
    if (request.delivery !== undefined) {
      const { delivery } = request;
      if (
        !isMessagePurpose(purpose) ||
        typeof delivery.destination !== 'string' ||
        typeof delivery.link !== 'function'
      ) {
        throw new SetupGrantRequestError('delivery');
      }
    }
    return {
      principal: request.principal,
      purpose,
      issuedBy,
      episodeId,
      continuedFromGrantId,
      attestationChallengeHash: challenge,
      idempotencyRecordId,
    };
  }

  /** The lifetime of a grant of `purpose`, in minutes, from the setting; null for the one purpose that has none. */
  async #lifetime(handle: TransactionHandle, purpose: SetupGrantPurpose): Promise<number | null> {
    if (purpose === NO_EXPIRY_PURPOSE) return null;
    const minutes = await this.#settings.integer(handle, SETUP_GRANT_LIFETIME_SETTING);
    if (!Number.isSafeInteger(minutes) || minutes < 1) {
      throw new RangeError('The lifetime of a setup grant is a positive whole number of minutes');
    }
    return minutes;
  }

  /**
   * Ends the live (`PENDING`) grants of a principal's purposes: the rows are locked in id order, so that two endings that overlap
   * cannot wait for each other in a cycle, and then each becomes `EXPIRED` if its expiry has passed on the clock as it is after the
   * locks, and `SUPERSEDED` if not. One statement, so a grant is judged and moved at the same instant.
   */
  async #endLive(
    handle: TransactionHandle,
    principal: PrincipalRef,
    purposes: readonly SetupGrantPurpose[],
  ): Promise<{ superseded: string[]; expired: string[]; messaged: string[] }> {
    const result = await transactionOf(handle).execute(sql`
      with locked as (
        select id, expires_at from setup_grant
         where principal_type = ${principal.type} and principal_id = ${principal.id}::uuid
           and purpose = any(${textArray(purposes)}) and state = 'PENDING'
         order by id for no key update
      )
      update setup_grant as g
         set state = case when l.expires_at is not null and l.expires_at <= clock_timestamp() then 'EXPIRED' else 'SUPERSEDED' end
        from locked l where g.id = l.id
      returning g.id, g.state, g.purpose`);
    const rows = result.rows as {
      id: string;
      state: 'EXPIRED' | 'SUPERSEDED';
      purpose: SetupGrantPurpose;
    }[];
    const superseded = rows.filter((row) => row.state === 'SUPERSEDED');
    return {
      superseded: superseded.map((row) => row.id).toSorted(),
      expired: rows
        .filter((row) => row.state === 'EXPIRED')
        .map((row) => row.id)
        .toSorted(),
      // A grant that travels no message has no job to cancel: the two rider grants are shown as a QR, and their issuing key does not queue
      // anything (the delivery statements are not run for it, and the policies of the delivery job name no such key).
      messaged: superseded
        .filter((row) => isMessagePurpose(row.purpose))
        .map((row) => row.id)
        .toSorted(),
    };
  }

  /** Cancels the message that carries a grant that has ended, in the same transaction; none queued is not an error. */
  async #cancelMessage(handle: TransactionHandle, grantId: string): Promise<void> {
    await this.#queue.cancel(handle, {
      by: 'redemption',
      redemption: { type: REDEMPTION_TYPE, id: grantId },
    });
  }
}
