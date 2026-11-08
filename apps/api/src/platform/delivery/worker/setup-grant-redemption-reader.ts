import { sql } from 'drizzle-orm';

import { randomUUIDv7 } from '../../auth/crypto/uuid-v7.js';
import type { Clock } from '../../auth/ports/clock.port.js';
import type { RedemptionRef } from '../../auth/ports/delivery-queue.port.js';
import type { DatabaseService } from '../../database/database.service.js';
import { isUuid, type SecurityContext } from '../../database/transaction-context.js';
import { DELIVERY_WORKER_PRINCIPAL_ID } from '../delivery-parameters.js';
import type { RedemptionRecordReader, RedemptionStanding } from './redemption-record-reader.js';

export interface SetupGrantRedemptionReaderOptions {
  /** The database the worker connects through: `melarc_worker_runtime`, whose `credential_delivery` capability this reader opens. */
  readonly database: Pick<DatabaseService, 'transactionWithContext'>;
  /** The time of the correlation identifier it makes (UUIDv7). The expiry is the database's, judged in the read itself. */
  readonly clock: Pick<Clock, 'now'>;
}

/**
 * The delivery worker's reader of a setup grant (S0.29, obligation OB-119; SECURITY_DESIGN.md §13.9a: "re-read cancellation and
 * expiry before calling the provider"). It asks the one question a send depends on, whether the grant can still be redeemed, and
 * reads **three columns and no more**: the grant's id, its state and its expiry. Those are the columns the worker's capability role
 * holds (data-scope-registry.md section 5.2, "state and expiry only, never the hash"), so a read of anything else would be refused by
 * the database, not by this code's good manners.
 *
 * - `PENDING`: the state is `PENDING` and the grant has not expired. **The expiry is judged by the database in the read itself**, on
 *   its clock (plan section 3, "Time"; valid means `now < expires_at`, equality is closed), because a grant can lapse while its state
 *   is still `PENDING`: the state is rewritten to `EXPIRED` only by the next issue.
 * - `CLOSED`: the grant was consumed, superseded or marked expired, or its time has passed. Nothing is sent and the job ends.
 * - `UNCONFIRMED`: no such grant is visible, or the id is not an id. A grant that cannot be found is not a grant that has ended, and
 *   it is not one that may be sent for: the message waits on its schedule and ends at its own expiry.
 *
 * A failed read throws, which the worker takes for `UNCONFIRMED` (it sends nothing and tries again on the schedule).
 */
export class SetupGrantRedemptionReader implements RedemptionRecordReader {
  readonly #database: Pick<DatabaseService, 'transactionWithContext'>;
  readonly #clock: Pick<Clock, 'now'>;

  constructor(options: SetupGrantRedemptionReaderOptions) {
    this.#database = options.database;
    this.#clock = options.clock;
  }

  async standing(record: RedemptionRef): Promise<RedemptionStanding> {
    if (record.type !== 'SETUP_GRANT' || !isUuid(record.id)) return 'UNCONFIRMED';
    const row = await this.#database.transactionWithContext(this.#context(), async (tx) => {
      const result = await tx.execute(sql`
        select state, (expires_at is null or expires_at > clock_timestamp()) as live
          from setup_grant where id = ${record.id}::uuid`);
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
