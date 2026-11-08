import { sql } from 'drizzle-orm';

import { randomUUIDv7 } from '../../auth/crypto/uuid-v7.js';
import type { Clock } from '../../auth/ports/clock.port.js';
import type { RedemptionRef } from '../../auth/ports/delivery-queue.port.js';
import type { DatabaseService } from '../../database/database.service.js';
import { isUuid, type SecurityContext } from '../../database/transaction-context.js';
import { DELIVERY_WORKER_PRINCIPAL_ID } from '../delivery-parameters.js';
import type { RedemptionRecordReader, RedemptionStanding } from './redemption-record-reader.js';

export interface RecoveryRequestRedemptionReaderOptions {
  /** The database the worker connects through: `melarc_worker_runtime`, whose `credential_delivery` capability this reader opens. */
  readonly database: Pick<DatabaseService, 'transactionWithContext'>;
  /** The time of the correlation identifier it makes (UUIDv7). The expiry is the database's, judged in the read itself. */
  readonly clock: Pick<Clock, 'now'>;
}

/**
 * The delivery worker's reader of a recovery request (S0.50, obligation OB-119; SECURITY_DESIGN.md section 13.9a: "re-read cancellation and
 * expiry before calling the provider"), the setup grant's reader's twin. It asks whether the request can still be redeemed and reads **three
 * columns and no more**: the id, the state and the expiry, which are the columns the worker's capability role holds (data-scope-registry.md
 * section 5.2, "state and expiry only, never the hash"; migration 0037).
 *
 * - `PENDING`: the state is `PENDING` and the request has not expired, judged by the database on its clock in the read itself.
 * - `CLOSED`: consumed, superseded or expired, or its time has passed. Nothing is sent and the job ends.
 * - `UNCONFIRMED`: no such request is visible, or the id is not an id. The message waits on its schedule and ends at its own expiry.
 *
 * A failed read throws, which the worker takes for `UNCONFIRMED`.
 */
export class RecoveryRequestRedemptionReader implements RedemptionRecordReader {
  readonly #database: Pick<DatabaseService, 'transactionWithContext'>;
  readonly #clock: Pick<Clock, 'now'>;

  constructor(options: RecoveryRequestRedemptionReaderOptions) {
    this.#database = options.database;
    this.#clock = options.clock;
  }

  async standing(record: RedemptionRef): Promise<RedemptionStanding> {
    if (record.type !== 'RECOVERY_REQUEST' || !isUuid(record.id)) return 'UNCONFIRMED';
    const row = await this.#database.transactionWithContext(this.#context(), async (tx) => {
      const result = await tx.execute(sql`
        select state, (expires_at > clock_timestamp()) as live from recovery_request where id = ${record.id}::uuid`);
      return result.rows[0] as { state: string; live: boolean } | undefined;
    });
    if (row === undefined) return 'UNCONFIRMED';
    return row.state === 'PENDING' && row.live ? 'PENDING' : 'CLOSED';
  }

  #context(): SecurityContext {
    return {
      principalType: 'SYSTEM',
      principalId: DELIVERY_WORKER_PRINCIPAL_ID,
      surface: 'SYSTEM',
      taskCapability: 'credential_delivery',
      correlationId: randomUUIDv7(this.#clock),
    };
  }
}
