import { sql } from 'drizzle-orm';

import { randomUUIDv7 } from '../crypto/uuid-v7.js';
import type { Clock } from '../ports/clock.port.js';
import type { TokenService } from '../ports/token-service.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import { securityContextOf, transactionOf } from '../../database/transaction-handle.js';
import { isUuid } from '../../database/transaction-context.js';

/** A registered browser as the vendor's own operations answer it (`RegisteredDevice`): never the credential, never its hash. */
export interface RegisteredDeviceRecord {
  readonly id: string;
  readonly principal_type: 'VENDOR';
  readonly principal_id: string;
  readonly device_kind: 'VENDOR_BROWSER_CREDENTIAL';
  readonly status: 'ACTIVE' | 'REPLACED' | 'REVOKED';
  readonly registered_at: string;
  readonly registered_by: string | null;
}

/** A browser found by the credential its cookie carries: which device, of which account, in which state. */
export interface PresentedDevice {
  readonly deviceId: string;
  readonly accountId: string;
  readonly status: 'ACTIVE' | 'REPLACED' | 'REVOKED';
}

/** The store is the authentication capability's: row-level security admits no other context to register or end a browser. */
export class RegisteredDeviceContextError extends Error {
  constructor() {
    super('A registered browser is registered and found under the authentication capability alone');
    this.name = 'RegisteredDeviceContextError';
  }
}

function assertAuthentication(handle: TransactionHandle): void {
  const context = securityContextOf(handle);
  if (context.principalType !== 'SYSTEM' || context.taskCapability !== 'authentication') {
    throw new RegisteredDeviceContextError();
  }
}

interface DeviceColumns {
  readonly id: string;
  readonly principal_type: 'VENDOR';
  readonly principal_id: string;
  readonly device_kind: 'VENDOR_BROWSER_CREDENTIAL';
  readonly status: 'ACTIVE' | 'REPLACED' | 'REVOKED';
  readonly registered_at: Date | string;
  readonly registered_by: string | null;
}

const COLUMNS = sql.raw(
  'id, principal_type, principal_id, device_kind, status, registered_at, registered_by',
);

const recordOf = (row: DeviceColumns): RegisteredDeviceRecord => ({
  id: row.id,
  principal_type: row.principal_type,
  principal_id: row.principal_id,
  device_kind: row.device_kind,
  status: row.status,
  registered_at: new Date(row.registered_at).toISOString(),
  registered_by: row.registered_by,
});

/**
 * The vendor's registered browsers as `platform/auth` writes and finds them (S0.47 onward; SECURITY_DESIGN.md sections 13.7, 13.8a;
 * domain-model.md section 6.8 `RegisteredDevice`), over the vendor part of `registered_device` (migration 0034), in the caller's
 * transaction under the authentication capability.
 *
 * - **A browser is registered with a credential made here and shown once**: 32 random bytes as 43 base64url characters
 *   (`TokenService.issue`), which the response sets in the `melarc_vendor_device` cookie; only its SHA-256 is written, and the runtime
 *   cannot select it back. The device is `ACTIVE` from the database's clock, and records who authorised it only where that was not the
 *   vendor itself.
 * - **A browser is found by the credential its cookie carries and by nothing else** (`melarc.vendor_device_by_credential`, which compares
 *   the hash where it can be selected and answers the authentication capability alone): its id, its account and its state. A value that is
 *   not a credential finds nothing and costs no statement.
 */
export class RegisteredDeviceStore {
  readonly #tokens: Pick<TokenService, 'issue' | 'hash'>;
  readonly #clock: Pick<Clock, 'now'>;

  constructor(options: {
    readonly tokens: Pick<TokenService, 'issue' | 'hash'>;
    readonly clock: Pick<Clock, 'now'>;
  }) {
    this.#tokens = options.tokens;
    this.#clock = options.clock;
  }

  async register(
    handle: TransactionHandle,
    accountId: string,
    registeredBy: string | null = null,
  ): Promise<{ readonly device: RegisteredDeviceRecord; readonly credential: string }> {
    assertAuthentication(handle);
    if (!isUuid(accountId) || (registeredBy !== null && !isUuid(registeredBy))) {
      throw new TypeError(
        'A browser is registered to an account, by an actor where one authorised it (identifiers)',
      );
    }
    const issued = this.#tokens.issue();
    const inserted = await transactionOf(handle).execute(sql`
      insert into registered_device (id, principal_type, principal_id, vendor_account_id, device_kind, device_credential_hash, status,
                                     registered_at, registered_by)
      values (${randomUUIDv7(this.#clock)}::uuid, 'VENDOR', ${accountId}::uuid, ${accountId}::uuid, 'VENDOR_BROWSER_CREDENTIAL',
              ${Buffer.from(issued.hash)}::bytea, 'ACTIVE', clock_timestamp(), ${registeredBy}::uuid)
      returning ${COLUMNS}`);
    const row = inserted.rows[0] as unknown as DeviceColumns | undefined;
    if (row === undefined) throw new Error('A registered browser was inserted and not returned');
    return { device: recordOf(row), credential: issued.token };
  }

  /**
   * Every browser the account has held, newest first (then by id): what the version of the device set is made from. A read whose rows
   * row-level security decides: the vendor's own context sees its own browsers, the authentication capability any account's.
   */
  async listFor(
    handle: TransactionHandle,
    accountId: string,
  ): Promise<readonly RegisteredDeviceRecord[]> {
    if (!isUuid(accountId)) throw new TypeError('A vendor account is named by its id (a UUID)');
    const result = await transactionOf(handle).execute(sql`
      select ${COLUMNS} from registered_device
       where principal_type = 'VENDOR' and principal_id = ${accountId}::uuid
       order by registered_at desc, id`);
    return (result.rows as unknown as DeviceColumns[]).map(recordOf);
  }

  /** Ends an `ACTIVE` browser of the account as `REVOKED`, on the database's clock; `null` when there is no such live browser. */
  async revoke(
    handle: TransactionHandle,
    deviceId: string,
    accountId: string,
  ): Promise<RegisteredDeviceRecord | null> {
    assertAuthentication(handle);
    if (!isUuid(deviceId) || !isUuid(accountId)) return null;
    const result = await transactionOf(handle).execute(sql`
      update registered_device set status = 'REVOKED', ended_at = clock_timestamp()
       where id = ${deviceId}::uuid and principal_type = 'VENDOR' and principal_id = ${accountId}::uuid and status = 'ACTIVE'
      returning ${COLUMNS}`);
    const row = result.rows[0] as unknown as DeviceColumns | undefined;
    return row === undefined ? null : recordOf(row);
  }

  /** Whether the browser is still an `ACTIVE` one of the account: what a sign-in asks again under the account's lock. */
  async isActiveFor(
    handle: TransactionHandle,
    deviceId: string,
    accountId: string,
  ): Promise<boolean> {
    assertAuthentication(handle);
    if (!isUuid(deviceId) || !isUuid(accountId)) return false;
    const found = await transactionOf(handle).execute(sql`
      select 1 from registered_device
       where id = ${deviceId}::uuid and principal_type = 'VENDOR' and principal_id = ${accountId}::uuid and status = 'ACTIVE'`);
    return found.rows.length === 1;
  }

  async findByCredential(
    handle: TransactionHandle,
    credential: string | undefined,
  ): Promise<PresentedDevice | null> {
    assertAuthentication(handle);
    if (credential === undefined) return null;
    const hash = this.#tokens.hash(credential);
    if (hash === null) return null;
    const found = await transactionOf(handle).execute(
      sql`select device_id, vendor_account_id, status from melarc.vendor_device_by_credential(${Buffer.from(hash)}::bytea)`,
    );
    const row = found.rows[0] as
      | { device_id: string; vendor_account_id: string; status: PresentedDevice['status'] }
      | undefined;
    return row === undefined
      ? null
      : { deviceId: row.device_id, accountId: row.vendor_account_id, status: row.status };
  }
}
