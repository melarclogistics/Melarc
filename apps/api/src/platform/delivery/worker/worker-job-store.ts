import { sql } from 'drizzle-orm';

import { CryptoConditionError } from '../../auth/crypto/condition.js';
import { randomUUIDv7 } from '../../auth/crypto/uuid-v7.js';
import type { Clock } from '../../auth/ports/clock.port.js';
import type {
  ClaimedDelivery,
  DeliveryChannel,
  JobEnd,
  LeasedJob,
  RecordedOutcome,
} from '../../auth/ports/delivery-queue.port.js';
import type { SecretCipher } from '../../auth/ports/secret-cipher.port.js';
import type { DatabaseService } from '../../database/database.service.js';
import type { SecurityContext } from '../../database/transaction-context.js';
import { LeaseLostError, UnreadableClaimError } from '../delivery-errors.js';
import {
  DELIVERY_WORKER_PRINCIPAL_ID,
  MAX_LEASE_MS,
  MIN_LEASE_MS,
  WORKER_ID_PATTERN,
} from '../delivery-parameters.js';
import {
  PayloadUnreadableError,
  decodeDeliveryPayload,
  deliveryPayloadContext,
} from '../delivery-payload.js';
import { deferralDelayMs, retryDelayMs } from '../delivery-schedule.js';
import { ERASE_PAYLOAD } from '../delivery-sql.js';
import {
  TERMINAL_FAILURE_CLASSES,
  type DeliveryKind,
  type DeliveryPrincipalType,
  type RedemptionRecordType,
} from '../delivery-vocabulary.js';

export interface WorkerJobStoreOptions {
  /**
   * The database the worker reads and writes through: the one that connects as `melarc_worker_runtime`, whose `credential_delivery`
   * capability this store opens. It is a handle to a pool, never a transaction, and nothing here holds a connection across a send.
   */
  readonly database: Pick<DatabaseService, 'transactionWithContext'>;
  /** Opens the payload (purpose `DELIVERY_PAYLOAD`). */
  readonly cipher: Pick<SecretCipher, 'open'>;
  /** The time of the correlation identifiers it makes (UUIDv7). Leases, due times and expiry are the database's. */
  readonly clock: Pick<Clock, 'now'>;
  /** The source of the schedule's jitter. Replaceable so that a test can hold it still. */
  readonly random?: () => number;
}

/** What a claim returns of the row it leased. */
interface ClaimRow {
  readonly id: string;
  readonly kind: DeliveryKind;
  readonly redemption_record_type: RedemptionRecordType;
  readonly redemption_record_id: string;
  readonly principal_type: DeliveryPrincipalType;
  readonly principal_id: string;
  readonly channel: DeliveryChannel;
  readonly attempt_count: number;
  readonly deferred_claims: number;
  readonly lease_version: number;
  /** The end of the redemption record, in milliseconds since the epoch: a raw query hands a timestamp back as text. */
  readonly expires_at_ms: number;
  readonly provider_dedupe_id: string;
  readonly payload_ciphertext: Buffer | null;
  readonly payload_nonce: Buffer | null;
  readonly payload_key_version: number | null;
  readonly payload_envelope_version: number | null;
  readonly reclaimed: boolean;
}

/** What an outcome's statement returns of the row it changed. */
interface EndRow {
  readonly state: JobEnd['state'];
  readonly outcome_class: string;
}

/**
 * The worker's side of the durable delivery queue (S0.17; state-machines.md §22): with the retention cleanup, the only code that
 * opens the `credential_delivery` capability, which is why it lives under `platform/delivery/worker/` and the cleanup under
 * `platform/delivery/retention/` (capability-access.ts). It runs in the delivery worker process, over the worker's own database
 * login, and is called with no transaction open.
 *
 * A claim takes the next job that is due (or whose lease ended with no outcome), with a lease on the database's clock, counts the
 * attempt, and opens the payload in memory; the connection goes back before anything is sent. An outcome is written against the
 * lease version the claim returned: **a worker whose lease was taken over, or whose job was cancelled or finished meanwhile,
 * writes nothing** (`LEASE_LOST`). An unknown outcome waits on the schedule of `delivery-schedule.ts` and tries again with the
 * same payload and the same deduplication identity; a job whose next attempt would fall after the redemption record's end, or
 * after the sixth attempt, ends. A job that ends holds no ciphertext.
 */
export class WorkerJobStore {
  readonly #database: Pick<DatabaseService, 'transactionWithContext'>;
  readonly #cipher: Pick<SecretCipher, 'open'>;
  readonly #clock: Pick<Clock, 'now'>;
  readonly #random: (() => number) | undefined;

  constructor(options: WorkerJobStoreOptions) {
    this.#database = options.database;
    this.#cipher = options.cipher;
    this.#clock = options.clock;
    this.#random = options.random;
  }

  async claim(workerId: string, leaseMilliseconds: number): Promise<ClaimedDelivery | null> {
    if (typeof workerId !== 'string' || !WORKER_ID_PATTERN.test(workerId)) {
      throw new RangeError('A worker name is plain text of one to 128 characters');
    }
    if (
      !Number.isInteger(leaseMilliseconds) ||
      leaseMilliseconds < MIN_LEASE_MS ||
      leaseMilliseconds > MAX_LEASE_MS
    ) {
      throw new RangeError('A lease is a whole number of milliseconds from one second to an hour');
    }
    const seconds = leaseMilliseconds / 1000;

    const row = await this.#database.transactionWithContext(this.#context(), async (tx) => {
      // The next job that is due, or whose lease ended with no outcome, and whose credential has not ended. The row is locked
      // and rows another worker holds locked are skipped, so two workers never take one job; the guard of the table refuses a
      // claim that is not due, that skips the count, or that comes while the lease is held.
      const result = await tx.execute(sql`
        with due as (
          select id, state as previous_state
            from credential_delivery_job
           where expires_at > clock_timestamp()
             and ((state in ('QUEUED', 'RETRYABLE') and next_attempt_at <= clock_timestamp())
               or (state = 'LEASED' and lease_expires_at <= clock_timestamp()))
           order by case when state = 'LEASED' then lease_expires_at else next_attempt_at end, id
           limit 1
             for update skip locked
        )
        update credential_delivery_job j
           set state = 'LEASED', attempt_count = j.attempt_count + 1, lease_version = j.lease_version + 1,
               lease_owner = ${workerId}, lease_expires_at = clock_timestamp() + make_interval(secs => ${seconds}::float8)
          from due
         where j.id = due.id
        returning j.id, j.kind, j.redemption_record_type, j.redemption_record_id, j.principal_type, j.principal_id, j.channel,
                  j.attempt_count, j.deferred_claims, j.lease_version, (extract(epoch from j.expires_at) * 1000)::float8 as expires_at_ms,
                  j.provider_dedupe_id, j.payload_ciphertext, j.payload_nonce,
                  j.payload_key_version, j.payload_envelope_version, (due.previous_state = 'LEASED') as reclaimed`);
      return result.rows[0] as ClaimRow | undefined;
    });
    if (row === undefined) return null;
    return this.#open(row);
  }

  async recordOutcome(leased: LeasedJob, outcome: RecordedOutcome): Promise<JobEnd> {
    const statement = this.#outcomeStatement(leased, outcome);
    const rows = await this.#database.transactionWithContext(this.#context(), async (tx) => {
      const result = await tx.execute(statement);
      // The columns are the two the statement returns, and the table's constraints keep each within its closed set.
      return result.rows as unknown as EndRow[];
    });
    // The fence: one row means this lease was still the job's. None means it was taken over, or the job ended some other way.
    const [row] = rows;
    if (rows.length !== 1 || row === undefined) throw new LeaseLostError();
    return { state: row.state, outcomeClass: row.outcome_class };
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

  /** Opens the payload in memory, or reports the lease the worker now holds and cannot use. */
  async #open(row: ClaimRow): Promise<ClaimedDelivery> {
    const leased: LeasedJob = {
      job: { id: row.id, providerDedupeId: row.provider_dedupe_id },
      leaseVersion: row.lease_version,
      // The sends so far, this claim included: a claim that was recorded as deferred was not a send and is not counted.
      attempt: row.attempt_count - row.deferred_claims,
      deferrals: row.deferred_claims,
      kind: row.kind,
      channel: row.channel,
    };
    if (
      row.payload_ciphertext === null ||
      row.payload_nonce === null ||
      row.payload_key_version === null ||
      row.payload_envelope_version === null
    ) {
      throw new UnreadableClaimError(leased);
    }
    try {
      const opened = await this.#cipher.open(
        'DELIVERY_PAYLOAD',
        {
          envelopeVersion: row.payload_envelope_version,
          keyVersion: row.payload_key_version,
          nonce: new Uint8Array(row.payload_nonce),
          ciphertext: new Uint8Array(row.payload_ciphertext),
        },
        deliveryPayloadContext({
          jobId: row.id,
          kind: row.kind,
          principal: { type: row.principal_type, id: row.principal_id },
          redemption: { type: row.redemption_record_type, id: row.redemption_record_id },
        }),
      );
      const content = decodeDeliveryPayload(opened);
      return {
        ...leased,
        reclaimed: row.reclaimed,
        request: {
          kind: row.kind,
          redemption: { type: row.redemption_record_type, id: row.redemption_record_id },
          principal: { type: row.principal_type, id: row.principal_id },
          channel: row.channel,
          destination: content.destination,
          link: content.link,
          expiresAt: new Date(Math.round(row.expires_at_ms)),
        },
      };
    } catch (error) {
      // What only this worker cannot open (a key, an envelope or a layout it has not been given) is kept for one that can; what no
      // worker can open ends the job.
      if (error instanceof CryptoConditionError) {
        throw new UnreadableClaimError(
          leased,
          error.condition === 'AUTHENTICATION_FAILED' ? 'UNREADABLE' : 'NOT_HELD',
        );
      }
      if (error instanceof PayloadUnreadableError) {
        throw new UnreadableClaimError(
          leased,
          error.reason === 'VERSION_UNSUPPORTED' ? 'NOT_HELD' : 'UNREADABLE',
        );
      }
      throw error;
    }
  }

  /** The one UPDATE that records an outcome, fenced by the lease version the claim returned. */
  #outcomeStatement(leased: LeasedJob, outcome: RecordedOutcome): ReturnType<typeof sql> {
    const fence = sql`id = ${leased.job.id} and state = 'LEASED' and lease_version = ${leased.leaseVersion}`;
    switch (outcome.outcome) {
      case 'ACCEPTED': {
        const reference = outcome.providerMessageRef;
        const kept =
          typeof reference === 'string' && reference.length >= 1 && reference.length <= 256
            ? reference
            : null;
        return sql`
          update credential_delivery_job
             set state = 'ACCEPTED', accepted_at = clock_timestamp(), outcome_class = 'ACCEPTED',
                 provider_message_ref = ${kept}, lease_expires_at = null, ${ERASE_PAYLOAD}
           where ${fence}
       returning state, outcome_class`;
      }
      case 'REJECTED': {
        // A class outside the closed set is a rejection of no more particular kind, never a class the table does not hold.
        const reported = outcome.outcomeClass;
        const outcomeClass =
          (TERMINAL_FAILURE_CLASSES as readonly string[]).includes(reported) &&
          (reported === 'REJECTED' || reported === 'DESTINATION_NOT_ALLOWED')
            ? reported
            : 'REJECTED';
        return sql`
          update credential_delivery_job
             set state = 'FAILED', outcome_class = ${outcomeClass}, lease_expires_at = null, ${ERASE_PAYLOAD}
           where ${fence}
       returning state, outcome_class`;
      }
      case 'UNKNOWN':
        return this.#retryStatement(leased, fence, 'UNKNOWN', outcome.retryAfterMs);
      case 'REDEMPTION_UNCONFIRMED':
      case 'PAYLOAD_DEFERRED':
        // Nothing was sent: the worker could not confirm the record, or could not open the payload. The claim is given back.
        return this.#deferStatement(leased, fence, outcome.outcome);
      case 'SCHEDULE_EXHAUSTED':
        // The schedule has no attempt left, whatever the count says: the job ends (as expired if its credential has).
        return this.#retryStatement(leased, fence, null, undefined);
      case 'REDEMPTION_CLOSED':
        // Ended by time once its end has passed on the database's clock, and cancelled while the end is still ahead. The clock is
        // read once, for the state and the class together: two readings could fall one on each side of the moment the credential
        // ended, and give a pair the table refuses, so that the outcome would not be recorded at all.
        return sql`
          with target as (
            select id, expires_at <= clock_timestamp() as ended
              from credential_delivery_job where ${fence} for update
          )
          update credential_delivery_job j
             set state = case when t.ended then 'EXPIRED' else 'CANCELLED' end,
                 outcome_class = case when t.ended then 'EXPIRED' else 'CANCELLED' end,
                 lease_expires_at = null, ${ERASE_PAYLOAD}
            from target t
           where j.id = t.id
       returning j.state, j.outcome_class`;
      case 'PAYLOAD_UNREADABLE':
        return sql`
          update credential_delivery_job
             set state = 'FAILED', outcome_class = 'PAYLOAD_UNREADABLE', lease_expires_at = null, ${ERASE_PAYLOAD}
           where ${fence}
       returning state, outcome_class`;
      case 'RELINQUISHED':
        // Given back unfinished. No wait is added: a job is leased only once it is due, so its time is already past and the next
        // worker takes it at once. The attempt stays counted (the guard keeps the count), but nothing was asked of the provider.
        return sql`
          update credential_delivery_job
             set state = 'RETRYABLE', outcome_class = 'RELINQUISHED', lease_expires_at = null
           where ${fence}
       returning state, outcome_class`;
    }
  }

  /**
   * A deferral (G2-03): the claim ended before any provider was asked, because the worker could not open the payload or confirm the
   * record. The job waits (RETRYABLE) on a schedule of its own and **the claim is given back**: it was not a send. The wait does not
   * end the job, however long, and the payload is kept: the only ends are the ones that are real, the credential's own end (EXPIRED,
   * judged on the database's clock in this statement) and a cancellation. A job whose next attempt falls past its credential's end
   * simply is not claimed again, and the cleanup ends it when the end comes.
   */
  #deferStatement(
    leased: LeasedJob,
    fence: ReturnType<typeof sql>,
    reason: 'PAYLOAD_DEFERRED' | 'REDEMPTION_UNCONFIRMED',
  ): ReturnType<typeof sql> {
    const seconds =
      deferralDelayMs(
        leased.deferrals,
        this.#random === undefined ? {} : { random: this.#random },
      ) / 1000;
    return sql`
      with target as (
        select id, expires_at <= clock_timestamp() as ended
          from credential_delivery_job where ${fence} for update
      )
      update credential_delivery_job j
         set state = case when t.ended then 'EXPIRED' else 'RETRYABLE' end,
             outcome_class = case when t.ended then 'EXPIRED' else ${reason} end,
             deferred_claims = case when t.ended then j.deferred_claims else j.deferred_claims + 1 end,
             next_attempt_at = case when t.ended then j.next_attempt_at
                                    else clock_timestamp() + make_interval(secs => ${seconds}::float8) end,
             lease_expires_at = null,
             payload_ciphertext = case when t.ended then null else j.payload_ciphertext end,
             payload_nonce = case when t.ended then null else j.payload_nonce end,
             payload_key_version = case when t.ended then null else j.payload_key_version end,
             payload_envelope_version = case when t.ended then null else j.payload_envelope_version end,
             payload_erased_at = case when t.ended then clock_timestamp() else null end
        from target t
       where j.id = t.id
   returning j.state, j.outcome_class`;
  }

  /**
   * The outcome that waits for another attempt: the job becomes RETRYABLE on the schedule, or ends. It ends as EXPIRED when its
   * credential has already ended, and as FAILED (`SCHEDULE_EXHAUSTED`) when the schedule has no attempt left or the next attempt
   * would fall at or after the credential's end. Judged on the database's clock, in the one statement that records it.
   */
  #retryStatement(
    leased: LeasedJob,
    fence: ReturnType<typeof sql>,
    retryClass: 'UNKNOWN' | null,
    retryAfterMs: number | undefined,
  ): ReturnType<typeof sql> {
    const options = {
      ...(this.#random === undefined ? {} : { random: this.#random }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
    // No class means no retry: the schedule is over, however many attempts the count holds.
    const delayMs = retryClass === null ? undefined : retryDelayMs(leased.attempt, options);
    const seconds = delayMs === undefined ? null : delayMs / 1000;
    return sql`
      with target as (
        select id, expires_at from credential_delivery_job where ${fence} for update
      ), decision as (
        select t.id,
               t.expires_at <= clock_timestamp() as ended,
               (${seconds}::float8 is not null
                 and clock_timestamp() + make_interval(secs => ${seconds}::float8) < t.expires_at) as retry
          from target t
      )
      update credential_delivery_job j
         set state = case when d.ended then 'EXPIRED' when d.retry then 'RETRYABLE' else 'FAILED' end,
             outcome_class = case when d.ended then 'EXPIRED' when d.retry then ${retryClass ?? 'UNKNOWN'} else 'SCHEDULE_EXHAUSTED' end,
             next_attempt_at = case when d.retry and not d.ended
                                    then clock_timestamp() + make_interval(secs => ${seconds}::float8)
                                    else j.next_attempt_at end,
             lease_expires_at = null,
             payload_ciphertext = case when d.retry and not d.ended then j.payload_ciphertext else null end,
             payload_nonce = case when d.retry and not d.ended then j.payload_nonce else null end,
             payload_key_version = case when d.retry and not d.ended then j.payload_key_version else null end,
             payload_envelope_version = case when d.retry and not d.ended then j.payload_envelope_version else null end,
             payload_erased_at = case when d.retry and not d.ended then null else clock_timestamp() end
        from decision d
       where j.id = d.id
   returning j.state, j.outcome_class`;
  }
}
