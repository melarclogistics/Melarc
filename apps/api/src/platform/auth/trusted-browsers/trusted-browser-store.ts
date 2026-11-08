import { sql } from 'drizzle-orm';

import { timestampOf } from '../../database/timestamps.js';
import { isUuid } from '../../database/transaction-context.js';
import { securityContextOf, transactionOf } from '../../database/transaction-handle.js';
import { randomUUIDv7 } from '../crypto/uuid-v7.js';
import type { Clock } from '../ports/clock.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import {
  TrustedBrowserContextError,
  TrustedBrowserRequestError,
} from './trusted-browser-errors.js';
import {
  TRUSTED_BROWSER_DAYS,
  TRUSTED_BROWSER_LIMIT,
  type TrustedBrowserRevocationCause,
} from './trusted-browser-policy.js';

/**
 * The columns a `StoredTrustedBrowser` is made from. **The hash is not among them**: the runtime cannot select it (migration `0033`), and
 * the one place that compares it is the definer function `melarc.use_trusted_browser`.
 */
const COLUMNS = sql.raw(
  'id, staff_identity_id, factor_id, label, created_at, expires_at, last_used_at, revoked_at, revocation_cause',
);

interface TrustedBrowserColumns {
  readonly id: string;
  readonly staff_identity_id: string;
  readonly factor_id: string;
  readonly label: string;
  /** A raw statement returns an instant as the server's text; `timestampOf` reads it. */
  readonly created_at: Date | string;
  readonly expires_at: Date | string;
  readonly last_used_at: Date | string | null;
  readonly revoked_at: Date | string | null;
  readonly revocation_cause: TrustedBrowserRevocationCause | null;
}

/** A trusted browser as the platform reads it: whose it is, what it is called and when it ends, and never anything that could be used. */
export interface StoredTrustedBrowser {
  readonly id: string;
  readonly staffIdentityId: string;
  readonly factorId: string;
  readonly label: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revocationCause: TrustedBrowserRevocationCause | null;
}

function browserOf(row: TrustedBrowserColumns): StoredTrustedBrowser {
  return {
    id: row.id,
    staffIdentityId: row.staff_identity_id,
    factorId: row.factor_id,
    label: row.label,
    createdAt: timestampOf(row.created_at),
    expiresAt: timestampOf(row.expires_at),
    lastUsedAt: row.last_used_at === null ? null : timestampOf(row.last_used_at),
    revokedAt: row.revoked_at === null ? null : timestampOf(row.revoked_at),
    revocationCause: row.revocation_cause,
  };
}

export interface IssueTrustedBrowserRequest {
  readonly staffIdentityId: string;
  /** `TokenService.hash` of the 32 random bytes the cookie carries. The credential itself is never given to the store. */
  readonly tokenHash: Uint8Array;
  /** The `ACTIVE` factor whose code was just accepted. */
  readonly factorId: string;
  /** The credential the password step proved, by its generation. */
  readonly credentialGeneration: number;
  /** `trustedBrowserLabel(userAgent)`: a name from a closed list, never the header. */
  readonly label: string;
}

/** What issuing returned: the new row (without its hash), and the ones the cap of five removed to make room for it. */
export interface IssuedTrustedBrowser {
  readonly browser: StoredTrustedBrowser;
  readonly replacedIds: readonly string[];
}

export interface RevokeTrustedBrowsersRequest {
  readonly staffIdentityId: string;
  readonly cause: TrustedBrowserRevocationCause;
  /** The person or administrator who removed them; `null` when the system did (`REPLACED`, `FACTOR_REPLACED`, `CREDENTIAL_CHANGED`). */
  readonly revokedBy: string | null;
}

export interface TrustedBrowserStoreOptions {
  /** The time of the identifiers it makes (UUIDv7). Issue, use and expiry are the database's. */
  readonly clock: Pick<Clock, 'now'>;
}

function assertAuthentication(handle: TransactionHandle): void {
  const context = securityContextOf(handle);
  if (context.principalType !== 'SYSTEM' || context.taskCapability !== 'authentication') {
    throw new TrustedBrowserContextError();
  }
}

function assertHash(hash: Uint8Array): void {
  if (!(hash instanceof Uint8Array) || hash.byteLength !== 32) {
    throw new TrustedBrowserRequestError('tokenHash');
  }
}

function assertUuid(value: string, field: string): void {
  if (!isUuid(value)) throw new TrustedBrowserRequestError(field);
}

/** The text form of a uuid array, which the driver sends as one parameter (as the session store does for hubs). */
function uuidArray(ids: readonly string[]): string {
  return `{${ids.join(',')}}`;
}

/**
 * The store of trusted browsers (staff-authentication.md §5.8; SECURITY_DESIGN.md §13.5a; domain-model.md §6.8). Every method joins the
 * caller's transaction. **Which context is the caller's differs by method**, and the row-level security of the table decides what each can
 * reach, not the store:
 *
 * - **The authentication capability** issues, uses and recognises a trusted browser, and removes the ones that give way (`REPLACED`), or
 *   whose authenticator was replaced (`FACTOR_REPLACED`) — `issue`, `use`, `idFor`, `revokeAll`.
 * - **A staff context** lists the valid trusted browsers its policy shows (`list`: its own, or those of the one identity an administrator's
 *   operation has locked) and removes them (`revokeOne` by the person, `revokeAll` by an administrator or by the reset).
 *
 * Time is the database's: a trusted browser is created, used and removed at the `clock_timestamp()` of the statement that does it, and
 * lasts exactly seven days from its creation (a guard of the table holds that, so the store cannot give a longer one). **No method returns
 * a hash, and none finds a row by anything but an identifier or a hash it was handed.**
 */
export class TrustedBrowserStore {
  readonly #clock: Pick<Clock, 'now'>;

  constructor(options: TrustedBrowserStoreOptions) {
    this.#clock = options.clock;
  }

  /**
   * Records a trusted browser for an identity **the caller has locked** (the session issue's order: the identity's lock first). The valid
   * ones of the identity are locked in creation order, and the oldest give way (`REPLACED`) until the new one makes five; the new row is
   * then inserted unused, for exactly seven days.
   */
  async issue(
    handle: TransactionHandle,
    request: IssueTrustedBrowserRequest,
  ): Promise<IssuedTrustedBrowser> {
    assertAuthentication(handle);
    const { staffIdentityId, tokenHash, factorId, credentialGeneration, label } = request;
    assertUuid(staffIdentityId, 'staffIdentityId');
    assertUuid(factorId, 'factorId');
    assertHash(tokenHash);
    if (!Number.isSafeInteger(credentialGeneration) || credentialGeneration < 1) {
      throw new TrustedBrowserRequestError('credentialGeneration');
    }
    if (label.length < 1 || label.length > 80) throw new TrustedBrowserRequestError('label');
    const database = transactionOf(handle);

    // The valid ones, oldest first, locked in that one order so that two issues that overlap cannot wait for each other in a cycle.
    const live = await database.execute(sql`
      select id from trusted_browser
       where staff_identity_id = ${staffIdentityId}::uuid and revoked_at is null and expires_at > clock_timestamp()
       order by created_at, id for no key update`);
    const liveIds = live.rows.map((row) => (row as { id: string }).id);
    const surplus = liveIds.length + 1 - TRUSTED_BROWSER_LIMIT;
    const replacedIds = surplus > 0 ? liveIds.slice(0, surplus) : [];
    if (replacedIds.length > 0) {
      await database.execute(sql`
        update trusted_browser
           set revoked_at = clock_timestamp(), revocation_cause = 'REPLACED'
         where id = any(${uuidArray(replacedIds)}::uuid[]) and revoked_at is null`);
    }

    const inserted = await database.execute(sql`
      with at as (select clock_timestamp() as now)
      insert into trusted_browser
        (id, staff_identity_id, token_hash, factor_id, credential_generation, label, created_at, expires_at)
      select ${randomUUIDv7(this.#clock)}::uuid, ${staffIdentityId}::uuid, ${Buffer.from(tokenHash)}::bytea, ${factorId}::uuid,
             ${credentialGeneration}::bigint, ${label}, at.now, at.now + make_interval(days => ${TRUSTED_BROWSER_DAYS}::int)
        from at
      returning ${COLUMNS}`);
    return {
      browser: browserOf(inserted.rows[0] as unknown as TrustedBrowserColumns),
      replacedIds,
    };
  }

  /**
   * The password step's question and its one act: is this credential a valid trusted browser of this identity — not removed, before its
   * end on the database's clock, the identity `ACTIVE`, bound to the identity's `ACTIVE` factor and to the credential it holds now — and
   * if it is, it was used now. The identifier of the row, or `null` for every other case (an unknown credential, another identity's, an
   * expired, removed or unbound one), which the caller does not tell apart. **The caller has locked the identity.**
   */
  async use(
    handle: TransactionHandle,
    tokenHash: Uint8Array,
    staffIdentityId: string,
  ): Promise<string | null> {
    assertAuthentication(handle);
    assertHash(tokenHash);
    assertUuid(staffIdentityId, 'staffIdentityId');
    const result = await transactionOf(handle).execute(
      sql`select melarc.use_trusted_browser(${Buffer.from(tokenHash)}::bytea, ${staffIdentityId}::uuid) as id`,
    );
    return (result.rows[0] as { id: string | null } | undefined)?.id ?? null;
  }

  /**
   * Which of an identity's trusted browsers this credential is, **whatever its state** (so that a list can mark the browser that is
   * asking, and a removal of it can clear the cookie). Answered to the authentication capability for any identity and to a staff context
   * for its own alone; `null` when the credential is none of the identity's.
   */
  async idFor(
    handle: TransactionHandle,
    tokenHash: Uint8Array,
    staffIdentityId: string,
  ): Promise<string | null> {
    assertHash(tokenHash);
    assertUuid(staffIdentityId, 'staffIdentityId');
    const result = await transactionOf(handle).execute(
      sql`select melarc.trusted_browser_id_for(${Buffer.from(tokenHash)}::bytea, ${staffIdentityId}::uuid) as id`,
    );
    return (result.rows[0] as { id: string | null } | undefined)?.id ?? null;
  }

  /**
   * The valid trusted browsers an identity holds that the caller's policy shows, newest first: not removed, before their end on the
   * database's clock, and still on the credential they were trusted on (the identity `ACTIVE` and holding the same credential generation;
   * every staff context that lists can read that much of the identity, its own or one in scope). **A browser that is no longer valid stays
   * as history and is never listed as usable.** The authenticator a browser was bound to is not read here (a person's own and an
   * administrator's contexts cannot read a factor); the reset and the replacement of an authenticator remove its browsers in their own
   * transaction, and `use` judges the binding on every use.
   */
  async list(handle: TransactionHandle, staffIdentityId: string): Promise<StoredTrustedBrowser[]> {
    assertUuid(staffIdentityId, 'staffIdentityId');
    const result = await transactionOf(handle).execute(sql`
      select ${COLUMNS} from trusted_browser
       where staff_identity_id = ${staffIdentityId}::uuid and revoked_at is null and expires_at > clock_timestamp()
         and exists (select 1 from staff_identity as i
                      where i.id = trusted_browser.staff_identity_id and i.status = 'ACTIVE'
                        and i.credential_generation = trusted_browser.credential_generation)
       order by created_at desc, id desc`);
    return result.rows.map((row) => browserOf(row as unknown as TrustedBrowserColumns));
  }

  /**
   * A person removes one of their own (`SELF`). `true` for the request that removed it, `false` for any other case: not theirs, not there,
   * already removed or already past its end — which are not told apart, so that an identifier of another person's browser reads as an
   * absent one.
   */
  async revokeOne(handle: TransactionHandle, id: string, revokedBy: string): Promise<boolean> {
    assertUuid(id, 'id');
    assertUuid(revokedBy, 'revokedBy');
    const result = await transactionOf(handle).execute(sql`
      update trusted_browser
         set revoked_at = clock_timestamp(), revocation_cause = 'SELF', revoked_by = ${revokedBy}::uuid
       where id = ${id}::uuid and staff_identity_id = ${revokedBy}::uuid and revoked_at is null and expires_at > clock_timestamp()
      returning id`);
    return result.rows.length === 1;
  }

  /**
   * Removes every **valid** trusted browser an identity holds, for one cause, and returns their identifiers: the rows not removed and not past their
   * end. One that has already ended is left as the history it is (its end is its expiry). Under a staff context only `ADMINISTRATOR` (the
   * key that ends standing access) and `FACTOR_RESET` (the reset) for the one identity the operation locked, which the table's policy
   * holds; under the authentication capability the causes of the system.
   */
  async revokeAll(
    handle: TransactionHandle,
    request: RevokeTrustedBrowsersRequest,
  ): Promise<string[]> {
    const { staffIdentityId, cause, revokedBy } = request;
    assertUuid(staffIdentityId, 'staffIdentityId');
    if (revokedBy !== null) assertUuid(revokedBy, 'revokedBy');
    const result = await transactionOf(handle).execute(sql`
      update trusted_browser
         set revoked_at = clock_timestamp(), revocation_cause = ${cause}, revoked_by = ${revokedBy}::uuid
       where staff_identity_id = ${staffIdentityId}::uuid and revoked_at is null and expires_at > clock_timestamp()
      returning id`);
    return result.rows.map((row) => (row as { id: string }).id).toSorted();
  }
}
