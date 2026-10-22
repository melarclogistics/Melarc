import { sql } from 'drizzle-orm';

import { timestampOf } from '../../database/timestamps.js';
import { isUuid } from '../../database/transaction-context.js';
import { securityContextOf, transactionOf } from '../../database/transaction-handle.js';
import { sealedContext } from '../crypto/sealed-context.js';
import { randomUUIDv7 } from '../crypto/uuid-v7.js';
import type { Clock } from '../ports/clock.port.js';
import type { SecretCipher } from '../ports/secret-cipher.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import { MfaFactorContextError, MfaFactorRequestError } from './mfa-factor-errors.js';
import {
  FACTOR_CREATED_BY_PURPOSES,
  TOTP_SEED_OPERATION,
  isFactorCounter,
  type FactorStatus,
  type FactorType,
} from './mfa-vocabulary.js';

/**
 * The columns a `StoredFactor` is made from. **The sealed secret is not among them**: only `openSeed` selects it, and only to open it
 * in memory, so a factor that is returned, logged or cached holds no part of a seed.
 */
const COLUMNS = sql.raw(
  `id, staff_identity_id, ordinal, factor_type, status, enrolled_at, revoked_at, last_verified_counter, created_by_purpose, revoked_by,
   revocation_reason_code, created_episode_id, revocation_episode_id`,
);

interface FactorColumns {
  readonly id: string;
  readonly staff_identity_id: string;
  readonly ordinal: number;
  readonly factor_type: FactorType;
  readonly status: FactorStatus;
  /** A raw statement returns an instant as the server's text; `timestampOf` reads it. */
  readonly enrolled_at: Date | string | null;
  readonly revoked_at: Date | string | null;
  readonly last_verified_counter: string | null;
  readonly created_by_purpose: (typeof FACTOR_CREATED_BY_PURPOSES)[number];
  readonly revoked_by: string | null;
  readonly revocation_reason_code: string | null;
  readonly created_episode_id: string | null;
  readonly revocation_episode_id: string | null;
}

/** An MFA factor as the platform reads it: where it stands and how it came to be, and never its secret. */
export interface StoredFactor {
  readonly id: string;
  readonly staffIdentityId: string;
  /** The place of the factor among its identity's factors, from one: the only order they have (never the identifier's). */
  readonly ordinal: number;
  readonly factorType: FactorType;
  readonly status: FactorStatus;
  /** Non-null from `ACTIVE`. */
  readonly enrolledAt: Date | null;
  readonly revokedAt: Date | null;
  /** The time step of the last accepted code, as decimal text. */
  readonly lastVerifiedCounter: string | null;
  readonly createdByPurpose: (typeof FACTOR_CREATED_BY_PURPOSES)[number];
  /** The administrator who revoked it; null when the system did. */
  readonly revokedBy: string | null;
  readonly revocationReasonCode: string | null;
  readonly createdEpisodeId: string | null;
  readonly revocationEpisodeId: string | null;
}

function factorOf(row: FactorColumns): StoredFactor {
  return {
    id: row.id,
    staffIdentityId: row.staff_identity_id,
    ordinal: row.ordinal,
    factorType: row.factor_type,
    status: row.status,
    enrolledAt: row.enrolled_at === null ? null : timestampOf(row.enrolled_at),
    revokedAt: row.revoked_at === null ? null : timestampOf(row.revoked_at),
    lastVerifiedCounter: row.last_verified_counter,
    createdByPurpose: row.created_by_purpose,
    revokedBy: row.revoked_by,
    revocationReasonCode: row.revocation_reason_code,
    createdEpisodeId: row.created_episode_id,
    revocationEpisodeId: row.revocation_episode_id,
  };
}

export interface CreateFactorRequest {
  readonly staffIdentityId: string;
  /** The purpose of the grant whose consumption creates the factor: one of the three that create one. */
  readonly createdByPurpose: (typeof FACTOR_CREATED_BY_PURPOSES)[number];
  /** The reset episode a re-enrolment creates the factor in; absent for onboarding and the bootstrap. */
  readonly createdEpisodeId?: string | null;
  /** The TOTP seed (`TotpVerifier.newSeed()`): sealed here, shown once by the caller as the provisioning material, never stored as given. */
  readonly seed: Uint8Array;
}

export interface ActivatedFactor {
  readonly factor: StoredFactor;
  /** The factors of the identity that were `ACTIVE` and are now revoked by the system, because this one replaced them. */
  readonly replacedFactorIds: readonly string[];
}

export interface AdministrativeRevocation {
  readonly factorId: string;
  /** The administrator who acts: never the identity itself (the table refuses it). */
  readonly administratorId: string;
  /** The `reason_code` of the MFA-reset domain, validated by the operation before it gets here. */
  readonly reasonCode: string;
  /** The reset episode this revocation belongs to: a grant of the same identity carries it, which the database checks at commit. */
  readonly episodeId: string;
}

export interface MfaFactorStoreOptions {
  /** Seals and opens the seed (purpose `TOTP_SEED`). */
  readonly cipher: Pick<SecretCipher, 'seal' | 'open'>;
  /** The time of the identifiers it makes (UUIDv7). Enrolment, revocation and the accepted step are the database's. */
  readonly clock: Pick<Clock, 'now'>;
}

/** The longest a reason code is allowed to be: the code of a catalogue row, never a sentence. */
const MAX_REASON_CODE_LENGTH = 128;

function assertAuthentication(handle: TransactionHandle): void {
  const context = securityContextOf(handle);
  if (context.principalType !== 'SYSTEM' || context.taskCapability !== 'authentication') {
    throw new MfaFactorContextError();
  }
}

const assertUuid = (value: unknown, field: string): string => {
  if (!isUuid(value)) throw new MfaFactorRequestError(field);
  return value;
};

/**
 * The store of MFA factors (S0.29; domain-model.md §6.8 `MfaFactor`; state-machines.md §18; SECURITY_DESIGN.md §13). Every method
 * joins the caller's transaction, under the authentication capability (row-level security admits nothing else to read or write a
 * factor), so creating a factor, consuming the grant that produced it and the act that did both commit together or not at all.
 * **No operation calls it yet**: `completeStaffCredentialSetup` and `beginMfaReenrolment` (S0.31), `completeMfaEnrolment` and the
 * second sign-in step (S0.31, S0.33) and `resetStaffMfa` (S0.37) are its callers, and each writes the audit event of its own act.
 *
 * - **A factor is found by its id and by its identity, and by nothing else**: the ACTIVE one, or the most recent. There is no list,
 *   no scan and no search (`GBT-E5`, the port half). "Most recent" is the greatest `ordinal`, the place the database gave the factor when it was created (an id is a UUIDv7, which is not an order).
 * - **The seed is sealed to the row** (OB-39): `SecretCipher` with purpose `TOTP_SEED` and a context made from the identity, the
 *   operation name and the factor's own id, derived again from the stored row to open it and never from a request, so a ciphertext
 *   moved to another factor does not open. The store stores the envelope version beside the key version, the nonce and the ciphertext.
 *   It returns no secret: `openSeed` returns the seed in memory to the code that verifies a code against it, and nothing else does.
 * - **Time is the database's**: the moment of enrolment and of revocation are `clock_timestamp()` of the statement that writes them.
 * - **Proving a factor locks the identity's factors first**, in id order, and then revokes the one it replaces and activates the
 *   new one, so that two enrolments that finish together take turns instead of meeting the unique index.
 * - **A step is accepted once.** `recordAcceptedStep` is one conditional `UPDATE` that moves the step forward only; of two requests
 *   that present one code together, one is accepted.
 */
export class MfaFactorStore {
  readonly #cipher: Pick<SecretCipher, 'seal' | 'open'>;
  readonly #clock: Pick<Clock, 'now'>;

  constructor(options: MfaFactorStoreOptions) {
    this.#cipher = options.cipher;
    this.#clock = options.clock;
  }

  async create(handle: TransactionHandle, request: CreateFactorRequest): Promise<StoredFactor> {
    assertAuthentication(handle);
    const staffIdentityId = assertUuid(request.staffIdentityId, 'staffIdentityId');
    const { createdByPurpose, seed } = request;
    const createdEpisodeId = request.createdEpisodeId ?? null;
    if (!(FACTOR_CREATED_BY_PURPOSES as readonly string[]).includes(createdByPurpose)) {
      throw new MfaFactorRequestError('createdByPurpose');
    }
    // Only a re-enrolment creates a factor inside a reset episode; onboarding and the bootstrap carry none.
    if (
      createdEpisodeId !== null &&
      (createdByPurpose !== 'MFA_REENROLMENT' || !isUuid(createdEpisodeId))
    ) {
      throw new MfaFactorRequestError('createdEpisodeId');
    }
    if (!(seed instanceof Uint8Array) || seed.length === 0) throw new MfaFactorRequestError('seed');

    const id = randomUUIDv7(this.#clock);
    const sealed = await this.#cipher.seal('TOTP_SEED', seed, this.#contextOf(staffIdentityId, id));
    const result = await transactionOf(handle).execute(sql`
      insert into mfa_factor (id, staff_identity_id, factor_type, status, secret_ciphertext, secret_nonce, secret_key_version,
                              secret_envelope_version, created_by_purpose, created_episode_id)
      values (${id}::uuid, ${staffIdentityId}::uuid, 'TOTP', 'PENDING', ${Buffer.from(sealed.ciphertext)}::bytea,
              ${Buffer.from(sealed.nonce)}::bytea, ${sealed.keyVersion}::int, ${sealed.envelopeVersion}::int, ${createdByPurpose},
              ${createdEpisodeId}::uuid)
      returning ${COLUMNS}`);
    return factorOf(result.rows[0] as unknown as FactorColumns);
  }

  /**
   * The seed of a `PENDING` or `ACTIVE` factor, opened in memory for the one verification, or null when there is no such factor (a
   * revoked factor's secret is no longer for anything). The seed is never logged and never leaves the caller's verification.
   */
  async openSeed(handle: TransactionHandle, factorId: string): Promise<Uint8Array | null> {
    assertAuthentication(handle);
    assertUuid(factorId, 'factorId');
    const result = await transactionOf(handle).execute(sql`
      select staff_identity_id, secret_ciphertext, secret_nonce, secret_key_version, secret_envelope_version
        from mfa_factor where id = ${factorId}::uuid and status in ('PENDING', 'ACTIVE')`);
    const row = result.rows[0] as
      | {
          staff_identity_id: string;
          secret_ciphertext: Buffer;
          secret_nonce: Buffer;
          secret_key_version: number;
          secret_envelope_version: number;
        }
      | undefined;
    if (row === undefined) return null;
    return this.#cipher.open(
      'TOTP_SEED',
      {
        envelopeVersion: row.secret_envelope_version,
        keyVersion: row.secret_key_version,
        nonce: new Uint8Array(row.secret_nonce),
        ciphertext: new Uint8Array(row.secret_ciphertext),
      },
      this.#contextOf(row.staff_identity_id, factorId),
    );
  }

  /**
   * `PENDING` to `ACTIVE`: a generated code has been proven (the caller proved it, against the seed `openSeed` returned, under the
   * identity's lock). The identity's factors are locked in id order; a factor that is not `PENDING` (or not there) answers null and
   * nothing is written, so an identity is never left with its earlier factor revoked and no new one. Otherwise any `ACTIVE` factor of
   * the identity is revoked by the system (a replacement), and this one becomes `ACTIVE` at the database's time with `step` recorded,
   * so the code that proved it cannot be accepted again.
   */
  async activate(
    handle: TransactionHandle,
    factorId: string,
    step: string,
  ): Promise<ActivatedFactor | null> {
    assertAuthentication(handle);
    assertUuid(factorId, 'factorId');
    if (!isFactorCounter(step)) throw new MfaFactorRequestError('step');
    const database = transactionOf(handle);

    const locked = await database.execute(sql`
      select f.id, f.status, f.staff_identity_id from mfa_factor f
       where f.staff_identity_id = (select staff_identity_id from mfa_factor where id = ${factorId}::uuid)
       order by f.id for no key update`);
    const rows = locked.rows as { id: string; status: FactorStatus; staff_identity_id: string }[];
    const target = rows.find((row) => row.id === factorId);
    if (target?.status !== 'PENDING') return null;

    const replaced = await database.execute(sql`
      update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp()
       where staff_identity_id = ${target.staff_identity_id}::uuid and status = 'ACTIVE' and id <> ${factorId}::uuid
      returning id`);
    const activated = await database.execute(sql`
      update mfa_factor
         set status = 'ACTIVE', enrolled_at = clock_timestamp(), last_verified_counter = ${step}
       where id = ${factorId}::uuid and status = 'PENDING'
      returning ${COLUMNS}`);
    const row = activated.rows[0] as unknown as FactorColumns | undefined;
    if (row === undefined) return null;
    return {
      factor: factorOf(row),
      replacedFactorIds: (replaced.rows as { id: string }[]).map((entry) => entry.id).toSorted(),
    };
  }

  /**
   * Records `step` as the last accepted time step of an `ACTIVE` factor, only if it is later than the one recorded: true when it was
   * accepted, false for a replay, an earlier step, a factor that is not `ACTIVE` and one that does not exist. One statement, so of two
   * requests that present one code together, one is accepted.
   */
  async recordAcceptedStep(
    handle: TransactionHandle,
    factorId: string,
    step: string,
  ): Promise<boolean> {
    assertAuthentication(handle);
    assertUuid(factorId, 'factorId');
    if (!isFactorCounter(step)) throw new MfaFactorRequestError('step');
    const result = await transactionOf(handle).execute(sql`
      update mfa_factor set last_verified_counter = ${step}
       where id = ${factorId}::uuid and status = 'ACTIVE'
         and (last_verified_counter is null or last_verified_counter::numeric < ${step}::numeric)
      returning id`);
    return result.rows.length === 1;
  }

  /**
   * Revokes a factor by the system (an enrolment abandoned or superseded): no administrator, no reason, no episode. Null when the
   * factor is not `PENDING` or `ACTIVE`, or does not exist. The row stays: the revoked factor is history.
   */
  async revokeBySystem(handle: TransactionHandle, factorId: string): Promise<StoredFactor | null> {
    assertAuthentication(handle);
    assertUuid(factorId, 'factorId');
    const result = await transactionOf(handle).execute(sql`
      update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp()
       where id = ${factorId}::uuid and status in ('PENDING', 'ACTIVE')
      returning ${COLUMNS}`);
    const row = result.rows[0] as unknown as FactorColumns | undefined;
    return row === undefined ? null : factorOf(row);
  }

  /**
   * Revokes a factor as an administrator, in the one statement the table allows to write a revocation episode: the status, the
   * administrator, the reason and the episode together (domain-model.md §6.8). It belongs inside `resetStaffMfa`'s transaction, which
   * also writes the grant of the episode, and the database holds the episode to a grant of the same identity at commit. Null when the
   * factor is not `PENDING` or `ACTIVE`, or does not exist.
   */
  async revokeAdministratively(
    handle: TransactionHandle,
    request: AdministrativeRevocation,
  ): Promise<StoredFactor | null> {
    assertAuthentication(handle);
    const factorId = assertUuid(request.factorId, 'factorId');
    const administratorId = assertUuid(request.administratorId, 'administratorId');
    const episodeId = assertUuid(request.episodeId, 'episodeId');
    const reason = request.reasonCode;
    if (
      typeof reason !== 'string' ||
      reason.trim().length === 0 ||
      reason.length > MAX_REASON_CODE_LENGTH
    ) {
      throw new MfaFactorRequestError('reasonCode');
    }
    const result = await transactionOf(handle).execute(sql`
      update mfa_factor
         set status = 'REVOKED', revoked_at = clock_timestamp(), revoked_by = ${administratorId}::uuid,
             revocation_reason_code = ${reason}, revocation_episode_id = ${episodeId}::uuid
       where id = ${factorId}::uuid and status in ('PENDING', 'ACTIVE')
      returning ${COLUMNS}`);
    const row = result.rows[0] as unknown as FactorColumns | undefined;
    return row === undefined ? null : factorOf(row);
  }

  async findById(handle: TransactionHandle, factorId: string): Promise<StoredFactor | null> {
    assertAuthentication(handle);
    if (!isUuid(factorId)) throw new TypeError('A factor is identified by its id (a UUID)');
    const result = await transactionOf(handle).execute(
      sql`select ${COLUMNS} from mfa_factor where id = ${factorId}::uuid`,
    );
    const row = result.rows[0] as unknown as FactorColumns | undefined;
    return row === undefined ? null : factorOf(row);
  }

  /** The `ACTIVE` factor of an identity: at most one exists. */
  async findActiveOf(
    handle: TransactionHandle,
    staffIdentityId: string,
  ): Promise<StoredFactor | null> {
    assertAuthentication(handle);
    if (!isUuid(staffIdentityId))
      throw new TypeError('An identity is identified by its id (a UUID)');
    const result = await transactionOf(handle).execute(sql`
      select ${COLUMNS} from mfa_factor where staff_identity_id = ${staffIdentityId}::uuid and status = 'ACTIVE'`);
    const row = result.rows[0] as unknown as FactorColumns | undefined;
    return row === undefined ? null : factorOf(row);
  }

  /** The most recent factor of an identity, whatever its status: the one with the greatest ordinal (the place the database allocated; never the id). */
  async findLatestOf(
    handle: TransactionHandle,
    staffIdentityId: string,
  ): Promise<StoredFactor | null> {
    assertAuthentication(handle);
    if (!isUuid(staffIdentityId))
      throw new TypeError('An identity is identified by its id (a UUID)');
    const result = await transactionOf(handle).execute(sql`
      select ${COLUMNS} from mfa_factor where staff_identity_id = ${staffIdentityId}::uuid order by ordinal desc limit 1`);
    const row = result.rows[0] as unknown as FactorColumns | undefined;
    return row === undefined ? null : factorOf(row);
  }

  /**
   * The `PENDING` factors of an identity, oldest first (S0.31): the ones a re-enrolment supersedes. A factor in any other state is
   * not among them, and neither is another identity's.
   */
  async findPendingOf(
    handle: TransactionHandle,
    staffIdentityId: string,
  ): Promise<readonly StoredFactor[]> {
    assertAuthentication(handle);
    if (!isUuid(staffIdentityId))
      throw new TypeError('An identity is identified by its id (a UUID)');
    const result = await transactionOf(handle).execute(sql`
      select ${COLUMNS} from mfa_factor
       where staff_identity_id = ${staffIdentityId}::uuid and status = 'PENDING' order by ordinal`);
    return (result.rows as unknown as FactorColumns[]).map(factorOf);
  }

  /**
   * Whether any factor of the identity was ever proven, though it may have been revoked since (S0.31): `enrolled_at` is written once,
   * at the first proof, and never cleared. The bootstrap's completion is recorded at the first proof of a bootstrap identity only,
   * and an identity whose factor was reset and proven again has been proven before.
   */
  async hasBeenProven(handle: TransactionHandle, staffIdentityId: string): Promise<boolean> {
    assertAuthentication(handle);
    if (!isUuid(staffIdentityId))
      throw new TypeError('An identity is identified by its id (a UUID)');
    const result = await transactionOf(handle).execute(sql`
      select 1 from mfa_factor
       where staff_identity_id = ${staffIdentityId}::uuid and enrolled_at is not null limit 1`);
    return result.rows.length === 1;
  }

  /** The context a seed is sealed under: the identity it belongs to, one stable operation name and the factor's own id. */
  #contextOf(staffIdentityId: string, factorId: string): Uint8Array {
    return sealedContext({
      principal: staffIdentityId,
      operation: TOTP_SEED_OPERATION,
      record: factorId,
    });
  }
}
