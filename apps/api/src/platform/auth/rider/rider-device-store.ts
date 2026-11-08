import { sql } from 'drizzle-orm';

import { isUuid } from '../../database/transaction-context.js';
import { securityContextOf, transactionOf } from '../../database/transaction-handle.js';
import { randomUUIDv7 } from '../crypto/uuid-v7.js';
import { parseDevicePublicKey } from '../device-key/device-key-protocol.js';
import type { Clock } from '../ports/clock.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import { RIDER_DEVICE_KIND } from './rider-vocabulary.js';

/** A rider's registered device as the enrolment answers it (`RegisteredDevice`): never the key. */
export interface RiderDeviceRecord {
  readonly id: string;
  readonly principal_type: 'RIDER';
  readonly principal_id: string;
  readonly device_kind: typeof RIDER_DEVICE_KIND;
  readonly status: 'ACTIVE' | 'REPLACED' | 'REVOKED';
  readonly registered_at: string;
  readonly registered_by: string | null;
}

/** What a decision about a rider's devices needs, and nothing it could use to read a key. */
export interface RiderDeviceFacts {
  /** The rider's `ACTIVE` device, if any: at most one, which the table holds. */
  readonly activeDeviceId: string | null;
  readonly revokedDevices: number;
  readonly replacedDevices: number;
}

/** The store is the authentication capability's: row-level security admits no other context to register or end a rider's device. */
export class RiderDeviceContextError extends Error {
  constructor() {
    super('A rider’s device is registered and ended under the authentication capability alone');
    this.name = 'RiderDeviceContextError';
  }
}

function assertAuthentication(handle: TransactionHandle): void {
  const context = securityContextOf(handle);
  if (context.principalType !== 'SYSTEM' || context.taskCapability !== 'authentication') {
    throw new RiderDeviceContextError();
  }
}

interface DeviceColumns {
  readonly id: string;
  readonly principal_id: string;
  readonly status: RiderDeviceRecord['status'];
  readonly registered_at: Date | string;
  readonly registered_by: string | null;
}

// The key is not among the columns the runtime may select (migration 0040): a device is written with it and never read back with it.
const COLUMNS = sql.raw('id, principal_id, status, registered_at, registered_by');

const recordOf = (row: DeviceColumns): RiderDeviceRecord => ({
  id: row.id,
  principal_type: 'RIDER',
  principal_id: row.principal_id,
  device_kind: RIDER_DEVICE_KIND,
  status: row.status,
  registered_at: new Date(row.registered_at).toISOString(),
  registered_by: row.registered_by,
});

/**
 * The rider's registered devices as `completeRiderDeviceEnrolment` writes them (S0.57; SECURITY_DESIGN.md sections 13.6 and 15.2.1;
 * domain-model.md section 6.8 `RegisteredDevice`), over the rider part of `registered_device` (migration 0040), in the caller's transaction
 * under the authentication capability. It is the vendor's `RegisteredDeviceStore` for the other kind of device and shares nothing with it.
 *
 * - **A device is the public half of a hardware-backed key**, written in its one canonical spelling (`parseDevicePublicKey` has judged it
 *   before a statement is sent, and the table's pattern holds it again), `ACTIVE` from the database's clock. The runtime cannot select the
 *   column, so a record answers with the device's id, state and registration and never the key.
 * - **A rider has at most one `ACTIVE` device, and the table is the last word on it**: a second one is refused by the unique index whatever
 *   this store does, and the caller ends the old device before it registers the new one, in one transaction under the rider's lock.
 * - **`ACTIVE` ends once.** `replace` ends an `ACTIVE` device as `REPLACED` on the database's clock and ends no other: a `REVOKED` device
 *   stays revoked through a replacement (domain-model.md section 6.8; AC-SLICE-000-74), and neither state returns to `ACTIVE`.
 * - **It lists and scans nothing.** Every act names one rider.
 */
export class RiderDeviceStore {
  readonly #clock: Pick<Clock, 'now'>;

  constructor(options: { readonly clock: Pick<Clock, 'now'> }) {
    this.#clock = options.clock;
  }

  /**
   * Registers a device for the rider, `ACTIVE`, with the officer who authorised it where there was one. The caller holds the rider's
   * identity lock and has ended the rider's earlier `ACTIVE` device: the table refuses a second.
   */
  async register(
    handle: TransactionHandle,
    request: {
      readonly riderId: string;
      readonly publicKey: string;
      readonly registeredBy?: string | null;
    },
  ): Promise<RiderDeviceRecord> {
    assertAuthentication(handle);
    const registeredBy = request.registeredBy ?? null;
    if (!isUuid(request.riderId) || (registeredBy !== null && !isUuid(registeredBy))) {
      throw new TypeError(
        'A device is registered to a rider, by an officer where one authorised it (identifiers)',
      );
    }
    if (!parseDevicePublicKey(request.publicKey).ok) {
      throw new TypeError('A rider’s device is registered with its canonical P-256 public key');
    }
    const inserted = await transactionOf(handle).execute(sql`
      insert into registered_device (id, principal_type, principal_id, rider_identity_id, device_kind, public_key, status,
                                     registered_at, registered_by)
      values (${randomUUIDv7(this.#clock)}::uuid, 'RIDER', ${request.riderId}::uuid, ${request.riderId}::uuid,
              ${RIDER_DEVICE_KIND}, ${request.publicKey}, 'ACTIVE', clock_timestamp(), ${registeredBy}::uuid)
      returning ${COLUMNS}`);
    const row = inserted.rows[0] as unknown as DeviceColumns | undefined;
    if (row === undefined) throw new Error('A rider’s device was inserted and not returned');
    return recordOf(row);
  }

  /** Ends an `ACTIVE` device of the rider as `REPLACED`, on the database's clock; `null` when the rider has no such device. */
  async replace(
    handle: TransactionHandle,
    deviceId: string,
    riderId: string,
  ): Promise<RiderDeviceRecord | null> {
    assertAuthentication(handle);
    if (!isUuid(deviceId) || !isUuid(riderId)) return null;
    const result = await transactionOf(handle).execute(sql`
      update registered_device set status = 'REPLACED', ended_at = clock_timestamp()
       where id = ${deviceId}::uuid and principal_type = 'RIDER' and rider_identity_id = ${riderId}::uuid and status = 'ACTIVE'
      returning ${COLUMNS}`);
    const row = result.rows[0] as unknown as DeviceColumns | undefined;
    return row === undefined ? null : recordOf(row);
  }

  /**
   * The key of the rider's `ACTIVE` device, for the one caller that verifies a signature against it (the sign-in, S0.59): through
   * `melarc.rider_active_device`, which answers the authentication capability alone because the runtime cannot select the column. `null` for
   * a rider with no `ACTIVE` device and for an identifier that names no rider, in the same one statement. It takes no lock, and the key is the
   * caller's to verify with and never to log, return or keep.
   */
  async activeKeyFor(
    handle: TransactionHandle,
    riderId: string,
  ): Promise<{ readonly deviceId: string; readonly publicKey: string } | null> {
    assertAuthentication(handle);
    if (!isUuid(riderId)) throw new TypeError('A rider is named by its id (a UUID)');
    const result = await transactionOf(handle).execute(
      sql`select device_id, public_key from melarc.rider_active_device(${riderId}::uuid)`,
    );
    const row = result.rows[0] as unknown as { device_id: string; public_key: string } | undefined;
    return row === undefined ? null : { deviceId: row.device_id, publicKey: row.public_key };
  }

  /** Whether `deviceId` is still an `ACTIVE` device of the rider: judged again under the rider's lock before a session is issued on it. */
  async isActiveFor(
    handle: TransactionHandle,
    deviceId: string,
    riderId: string,
  ): Promise<boolean> {
    assertAuthentication(handle);
    if (!isUuid(deviceId) || !isUuid(riderId)) return false;
    const result = await transactionOf(handle).execute(sql`
      select 1 from registered_device
       where id = ${deviceId}::uuid and principal_type = 'RIDER' and rider_identity_id = ${riderId}::uuid and status = 'ACTIVE'`);
    return result.rows.length === 1;
  }

  /** The rider's devices by state, read under the rider's lock for the decision that follows (a binding is refused or needs a device held). */
  async factsFor(handle: TransactionHandle, riderId: string): Promise<RiderDeviceFacts> {
    assertAuthentication(handle);
    if (!isUuid(riderId)) throw new TypeError('A rider is named by its id (a UUID)');
    const result = await transactionOf(handle).execute(sql`
      select status, id from registered_device
       where principal_type = 'RIDER' and rider_identity_id = ${riderId}::uuid`);
    const rows = result.rows as unknown as readonly { status: string; id: string }[];
    return {
      activeDeviceId: rows.find((row) => row.status === 'ACTIVE')?.id ?? null,
      revokedDevices: rows.filter((row) => row.status === 'REVOKED').length,
      replacedDevices: rows.filter((row) => row.status === 'REPLACED').length,
    };
  }
}
