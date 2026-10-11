import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { randomUUIDv7 } from '../auth/crypto/uuid-v7.js';
import type { Clock } from '../auth/ports/clock.port.js';
import type {
  ClaimedDelivery,
  DeliveryChannel,
  DeliveryJobRef,
  DeliveryQueue,
  DeliveryRequest,
  DeliverySelector,
  JobEnd,
  LeasedJob,
  RecordedOutcome,
} from '../auth/ports/delivery-queue.port.js';
import type { SecretCipher } from '../auth/ports/secret-cipher.port.js';
import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import { serverErrorIn } from '../database/database-failures.js';
import type { DatabaseService } from '../database/database.service.js';
import { credentialDeliveryJob } from '../database/schema/credential-delivery.js';
import { isUuid } from '../database/transaction-context.js';
import { securityContextOf, transactionOf } from '../database/transaction-handle.js';
import {
  DeliveryContextError,
  DeliveryNotQueueableError,
  DeliveryWorkerSideUnavailableError,
  type NotQueueableReason,
} from './delivery-errors.js';
import {
  deliveryPayloadContext,
  destinationProblem,
  encodeDeliveryPayload,
  linkProblem,
} from './delivery-payload.js';
import { ERASE_PAYLOAD } from './delivery-sql.js';
import {
  DELIVERY_CHANNELS,
  DELIVERY_KINDS,
  DELIVERY_PRINCIPAL_TYPES,
  REDEMPTION_RECORD_TYPES,
  REDEMPTION_TYPE_OF_KIND,
  type DeliveryKind,
  type DeliveryPrincipalType,
  type RedemptionRecordType,
} from './delivery-vocabulary.js';
import { WorkerJobStore } from './worker/worker-job-store.js';

export interface PostgresDeliveryQueueOptions {
  /** Seals and opens the payload (purpose `DELIVERY_PAYLOAD`). */
  readonly cipher: Pick<SecretCipher, 'seal' | 'open'>;
  /** The time of the identifiers it makes (UUIDv7). Expiry and due times are the database's. */
  readonly clock: Pick<Clock, 'now'>;
  /**
   * The database the **worker** reads and writes through: the one that connects as `melarc_worker_runtime`, whose `credential_delivery`
   * capability the worker side opens. Absent in the API, which only queues and cancels, in the caller's transaction, and whose
   * connection holds neither the lease nor the payload: `claim` and `recordOutcome` then refuse.
   */
  readonly work?: Pick<DatabaseService, 'transactionWithContext'>;
  /** The source of the schedule's jitter. Replaceable so that a test can hold it still. */
  readonly random?: () => number;
}

/**
 * Queueing and cancelling are the issuing capability's: a `SYSTEM` context under `authentication`. Under any other, a queued message
 * is refused by the table with a bare privilege error, and a cancellation finds no row to change and returns nought, which the caller
 * cannot tell from "nothing was live". Refusing here, before anything is written, keeps both where the caller can see them.
 */
function assertIssuing(transaction: TransactionHandle): void {
  const context = securityContextOf(transaction);
  if (context.principalType !== 'SYSTEM' || context.taskCapability !== 'authentication') {
    throw new DeliveryContextError();
  }
}

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

/**
 * The durable credential-delivery queue over PostgreSQL (S0.17; SECURITY_DESIGN.md §13.9a; state-machines.md §22). A credential
 * service writes a message **in the transaction that issues the credential**, beside its hash-only redemption record, and a
 * separate worker sends it. No provider is called here, on any path.
 *
 * **The issuing side** (`enqueue`, `cancel`) runs in the caller's transaction through its `TransactionHandle`, under the
 * `authentication` capability the caller's context carries, so the message and the record commit together or not at all. `enqueue`
 * seals the destination and the link (authenticated encryption, purpose `DELIVERY_PAYLOAD`, bound to the job, the kind, the
 * principal and the redemption record), gives the job its stable provider deduplication identity, and refuses what could not be
 * delivered: a field that is not usable (`REQUEST_INVALID`), a second message for one record (`ALREADY_QUEUED`), a credential
 * that has already ended (`ENDED`). `cancel` ends the live jobs of a record or of a principal and erases their payloads, in the
 * transaction that consumed, superseded or invalidated the record; it returns how many it ended, and a send already in flight is
 * dead because redemption refuses the record.
 *
 * **The worker side** (`claim`, `recordOutcome`) is `worker/worker-job-store.ts`, which (with the retention cleanup) is the only
 * code that opens the `credential_delivery` capability, built here when the queue is given the worker's database and refusing
 * (`DeliveryWorkerSideUnavailableError`) when it is not, as in the API, whose connection holds neither the lease nor the payload.
 * It opens a short transaction of its own, is called with no transaction open, and writes an outcome only against the lease
 * version its claim returned (`LEASE_LOST` otherwise).
 *
 * The job is delivery bookkeeping and nothing more: it holds no reference to the redemption record, and nothing here reads or
 * writes one.
 */
export class PostgresDeliveryQueue implements DeliveryQueue {
  readonly #cipher: Pick<SecretCipher, 'seal' | 'open'>;
  readonly #clock: Pick<Clock, 'now'>;
  readonly #worker: WorkerJobStore | undefined;

  constructor(options: PostgresDeliveryQueueOptions) {
    this.#cipher = options.cipher;
    this.#clock = options.clock;
    this.#worker =
      options.work === undefined
        ? undefined
        : new WorkerJobStore({
            database: options.work,
            cipher: options.cipher,
            clock: options.clock,
            ...(options.random === undefined ? {} : { random: options.random }),
          });
  }

  async enqueue(transaction: TransactionHandle, request: DeliveryRequest): Promise<DeliveryJobRef> {
    assertIssuing(transaction);
    const checked = checkRequest(request);
    const tx = transactionOf(transaction);
    const id = randomUUIDv7(this.#clock);
    const providerDedupeId = randomUUID();

    const sealed = await this.#cipher.seal(
      'DELIVERY_PAYLOAD',
      encodeDeliveryPayload({ destination: checked.destination, link: checked.link }),
      deliveryPayloadContext({
        jobId: id,
        kind: checked.kind,
        principal: checked.principal,
        redemption: checked.redemption,
      }),
    );

    try {
      await tx.insert(credentialDeliveryJob).values({
        id,
        kind: checked.kind,
        redemptionRecordType: checked.redemption.type,
        redemptionRecordId: checked.redemption.id,
        principalType: checked.principal.type,
        principalId: checked.principal.id,
        channel: checked.channel,
        // Due at once, on the database's clock: the first attempt is immediate.
        nextAttemptAt: sql`clock_timestamp()`,
        expiresAt: checked.expiresAt,
        providerDedupeId,
        payloadCiphertext: Buffer.from(sealed.ciphertext),
        payloadNonce: Buffer.from(sealed.nonce),
        payloadKeyVersion: sealed.keyVersion,
        payloadEnvelopeVersion: sealed.envelopeVersion,
      });
    } catch (error) {
      throw notQueueable(error) ?? error;
    }
    return { id, providerDedupeId };
  }

  async cancel(transaction: TransactionHandle, selector: DeliverySelector): Promise<number> {
    assertIssuing(transaction);
    const tx = transactionOf(transaction);
    let which: ReturnType<typeof sql>;
    if (selector.by === 'redemption') {
      const { type, id } = selector.redemption;
      if (!isOneOf(REDEMPTION_RECORD_TYPES, type) || !isUuid(id)) {
        throw new TypeError('A redemption record is a known type and an identifier.');
      }
      which = sql`redemption_record_type = ${type} and redemption_record_id = ${id.toLowerCase()}`;
    } else {
      const { type, id } = selector.principal;
      if (!isOneOf(DELIVERY_PRINCIPAL_TYPES, type) || !isUuid(id)) {
        throw new TypeError('A principal is a staff member or a vendor account and an identifier.');
      }
      which = sql`principal_type = ${type} and principal_id = ${id.toLowerCase()}`;
    }
    // No RETURNING: the issuing capability may read the columns that find a row and nothing else, so it asks for a count.
    const result = await tx.execute(sql`
      update credential_delivery_job
         set state = 'CANCELLED', outcome_class = 'CANCELLED', ${ERASE_PAYLOAD}
       where ${which} and state in ('QUEUED', 'LEASED', 'RETRYABLE')`);
    return result.rowCount ?? 0;
  }

  async claim(workerId: string, leaseMilliseconds: number): Promise<ClaimedDelivery | null> {
    return this.#workerSide().claim(workerId, leaseMilliseconds);
  }

  async recordOutcome(leased: LeasedJob, outcome: RecordedOutcome): Promise<JobEnd> {
    return this.#workerSide().recordOutcome(leased, outcome);
  }

  #workerSide(): WorkerJobStore {
    if (this.#worker === undefined) throw new DeliveryWorkerSideUnavailableError();
    return this.#worker;
  }
}

interface CheckedRequest {
  readonly kind: DeliveryKind;
  readonly channel: DeliveryChannel;
  readonly principal: { readonly type: DeliveryPrincipalType; readonly id: string };
  readonly redemption: { readonly type: RedemptionRecordType; readonly id: string };
  readonly destination: string;
  readonly link: string;
  readonly expiresAt: Date;
}

const invalid = (field: string): never => {
  throw new DeliveryNotQueueableError('REQUEST_INVALID', field);
};

/** What the request says, judged field by field; the first field that is not usable is named, and its value never is. */
function checkRequest(request: DeliveryRequest): CheckedRequest {
  // The type says an object; a caller that is not typed (a script, a test) may hand over anything, and that is a refusal, not a crash.
  const raw: unknown = request;
  const given: Record<string, unknown> = typeof raw === 'object' && raw !== null ? { ...raw } : {};
  if (!isOneOf(DELIVERY_KINDS, given.kind)) return invalid('kind');
  const kind = given.kind;
  if (!isOneOf(DELIVERY_CHANNELS, given.channel)) return invalid('channel');
  const channel = given.channel;

  const principal = given.principal as { type?: unknown; id?: unknown } | null | undefined;
  if (
    typeof principal !== 'object' ||
    principal === null ||
    !isOneOf(DELIVERY_PRINCIPAL_TYPES, principal.type) ||
    !isUuid(principal.id)
  ) {
    return invalid('principal');
  }
  const redemption = given.redemption as { type?: unknown; id?: unknown } | null | undefined;
  if (
    typeof redemption !== 'object' ||
    redemption === null ||
    !isOneOf(REDEMPTION_RECORD_TYPES, redemption.type) ||
    !isUuid(redemption.id) ||
    REDEMPTION_TYPE_OF_KIND[kind] !== redemption.type
  ) {
    return invalid('redemption');
  }
  if (
    typeof given.destination !== 'string' ||
    destinationProblem(channel, given.destination) !== undefined
  ) {
    return invalid('destination');
  }
  if (typeof given.link !== 'string' || linkProblem(given.link) !== undefined) {
    return invalid('link');
  }
  if (!(given.expiresAt instanceof Date) || !Number.isFinite(given.expiresAt.getTime())) {
    return invalid('expiresAt');
  }
  return {
    kind,
    channel,
    principal: { type: principal.type, id: principal.id.toLowerCase() },
    redemption: { type: redemption.type, id: redemption.id.toLowerCase() },
    destination: given.destination,
    link: given.link,
    expiresAt: given.expiresAt,
  };
}

/** The refusal a failed insert amounts to, when the database's own constraint says why; otherwise undefined. */
function notQueueable(error: unknown): DeliveryNotQueueableError | undefined {
  const failure = serverErrorIn(error);
  let reason: NotQueueableReason | undefined;
  if (
    failure?.code === '23505' &&
    failure.constraint === 'credential_delivery_job_redemption_key'
  ) {
    reason = 'ALREADY_QUEUED';
  } else if (
    failure?.code === '23514' &&
    failure.constraint === 'credential_delivery_job_expires_after_created'
  ) {
    reason = 'ENDED';
  }
  return reason === undefined
    ? undefined
    : new DeliveryNotQueueableError(reason, reason === 'ENDED' ? 'expiresAt' : 'redemption');
}
