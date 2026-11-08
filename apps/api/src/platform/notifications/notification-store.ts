import { sql } from 'drizzle-orm';

import { randomUUIDv7 } from '../auth/crypto/uuid-v7.js';
import type { Clock } from '../auth/ports/clock.port.js';
import type { DatabaseService, DatabaseTransaction } from '../database/database.service.js';
import { NOTIFICATION_LIMITS } from '../database/policy-lock/lock-keys.js';
import type { SecurityContext } from '../database/transaction-context.js';
import type { HandshakeFacts, PickupManifestFacts, PickupRequestFacts } from './message-list.js';
import type {
  NotificationAudience,
  NotificationChannel,
  NotificationOutcomeClass,
  OutboxOutcome,
  SuppressionReason,
} from './notification-vocabulary.js';

/**
 * Everything the notification lane asks of the database (S1.12a): the lane's SQL in one place, so that its transactions, its fences and its
 * contexts can be read together. The lane works as `SYSTEM` under the `notification` capability (data-scope-registry.md §5.2), as the worker's
 * login with the grant set `melarc_worker_cap_notification`, and **a transaction that reads a business table is opened from a stored
 * envelope** (SECURITY_DESIGN.md §14.7 steps 3 and 5): the envelope was read first, from the table that only a business act writes, and
 * the context carries its identifiers, so that the policies of the aggregate tables show the lane the one aggregate the envelope names.
 *
 * **Every claim is a lease and every outcome is fenced.** A row is leased with a version that rises by one at each claim, and the statement
 * that records what became of it names that version, so that a lane that lost its lease (it was slow, and another took the row over) changes
 * nothing: `LeaseLostError`. The sending itself is never inside a transaction (BACKGROUND_JOBS_AND_EVENTS.md §3).
 *
 * **No statement here puts a destination, a text or a code in a column.** The destination is read from the aggregate in a transaction that
 * ends before the provider is asked; what the table keeps of it is a masked hint and a count digest, both computed by the caller.
 */

/** The `SYSTEM` principal of the lane: a fixed name, no person, in the style of the credential worker's. */
export const NOTIFICATION_LANE_PRINCIPAL_ID = '6e6f7469-6669-4000-8000-000000000001';

/** A lease that was not the row's any longer when its outcome was written: nothing was changed. */
export class LeaseLostError extends Error {
  constructor() {
    super('The lease was lost: another lane holds the row, or it ended some other way.');
    this.name = 'LeaseLostError';
  }
}

export interface ClaimedEnvelope {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly responsibleHubId: string;
  readonly vendorOrganizationId: string | null;
  readonly riderId: string | null;
  readonly operationId: string;
  /** The minimum the act put in the envelope for a message that needs a fact the aggregate does not hold (`outbox-writer.ts`); never personal or secret. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** When the act that raised the envelope was written, as the database prints it (microseconds): a message's time to live runs from it. */
  readonly createdAt: string;
  readonly attemptCount: number;
  readonly leaseVersion: number;
}

export interface ClaimedMessage {
  readonly id: string;
  readonly outboxId: string;
  readonly messageKind: string;
  readonly templateVersion: number;
  readonly audience: NotificationAudience;
  readonly responsibleHubId: string;
  readonly vendorOrganizationId: string | null;
  readonly subjectId: string;
  readonly attemptCount: number;
  readonly leaseVersion: number;
}

export interface NewNotification {
  readonly messageKind: string;
  readonly templateVersion: number;
  readonly audience: NotificationAudience;
  readonly channel: NotificationChannel;
  /** `QUEUED` for a text, `DELIVERED` for a feed entry, `SUPPRESSED` for a message held back at once (with its reason). */
  readonly state: 'QUEUED' | 'DELIVERED' | 'SUPPRESSED';
  readonly suppressionReason?: SuppressionReason;
  readonly timeToLiveMs: number;
  /** The closed tokens the message says beyond the code and the day of its subject (`notification.parameters`); none for most messages. */
  readonly parameters?: Readonly<Record<string, string>>;
}

export interface CheckableMessage {
  readonly id: string;
  readonly providerMessageRef: string;
  /** The checks made so far, this one included. */
  readonly receiptChecks: number;
}

/** The most a day may carry: a limit that is null is not applied. */
export interface SendLimits {
  readonly perNumberPerDay: number | null;
  readonly perDay: number | null;
}

interface EnvelopeRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  responsible_hub_id: string;
  vendor_organization_id: string | null;
  rider_id: string | null;
  operation_id: string;
  payload: Record<string, unknown>;
  created_at_text: string;
  attempt_count: number;
  lease_version: number;
}

interface MessageRow {
  id: string;
  outbox_id: string;
  message_kind: string;
  template_version: number;
  audience: NotificationAudience;
  responsible_hub_id: string;
  vendor_organization_id: string | null;
  subject_id: string;
  attempt_count: number;
  lease_version: number;
}

// A double, not an integer: a feed entry stays for months, which is more milliseconds than a 32-bit integer holds.
const milliseconds = (value: number) =>
  sql`(interval '1 millisecond' * ${value}::double precision)`;

/** What a context opened from an envelope may read: the one aggregate the envelope names, and the one sender of it. */
export class AggregateReader {
  protected readonly tx: DatabaseTransaction;

  constructor(tx: DatabaseTransaction) {
    this.tx = tx;
  }

  /** The aggregate the envelope names, as the policies show it to this context: nothing where it is not that aggregate's. */
  async pickupRequest(): Promise<PickupRequestFacts | undefined> {
    const found = await this.tx.execute(sql`
      select id, code, state, responsible_hub_id, vendor_organization_id, ad_hoc_sender_id,
             scheduled_service_date::text as scheduled_service_date, attempt_number
        from pickup_request`);
    const rows = found.rows as unknown as {
      id: string;
      code: string;
      state: string;
      responsible_hub_id: string;
      vendor_organization_id: string | null;
      ad_hoc_sender_id: string | null;
      scheduled_service_date: string;
      attempt_number: number;
    }[];
    // The policy shows the one request the envelope names. More than one row is a policy that has failed, and nothing is built on it.
    const [row] = rows;
    if (rows.length !== 1 || row === undefined) return undefined;
    return {
      id: row.id,
      code: row.code,
      state: row.state,
      responsibleHubId: row.responsible_hub_id,
      vendorOrganizationId: row.vendor_organization_id,
      adHocSenderId: row.ad_hoc_sender_id,
      scheduledServiceDate: row.scheduled_service_date,
      attemptNumber: row.attempt_number,
    };
  }

  /** The number of the ad-hoc sender of the aggregate, in E.164; read for one send and held in memory only. */
  async adHocSenderNumber(): Promise<string | undefined> {
    const found = await this.tx.execute(sql`select phone from ad_hoc_sender`);
    const rows = found.rows as unknown as { phone: string }[];
    return rows.length === 1 ? rows[0]?.phone : undefined;
  }

  /**
   * The collection handshake of the request the envelope names (S1.27), as the policy shows it to this context: the columns a code is made from (its generation, its key version and its length),
   * and whether the code has run out on the database's clock. The digest, the counters and the officer's note are columns the lane cannot read.
   */
  async collectionHandshake(): Promise<HandshakeFacts | undefined> {
    const found = await this.tx.execute(sql`
      select id, pickup_stop_id, direction, state, code_generation, code_key_version, code_length, expires_at > clock_timestamp() as live
        from collection_handshake`);
    const rows = found.rows as unknown as {
      id: string;
      pickup_stop_id: string;
      direction: HandshakeFacts['direction'];
      state: string;
      code_generation: number;
      code_key_version: number;
      code_length: number;
      live: boolean;
    }[];
    const [row] = rows;
    if (rows.length !== 1 || row === undefined) return undefined;
    return {
      id: row.id,
      stopId: row.pickup_stop_id,
      direction: row.direction,
      state: row.state,
      generation: row.code_generation,
      keyVersion: row.code_key_version,
      codeLength: row.code_length,
      live: row.live,
    };
  }

  /**
   * The registered number of the vendor that owns the request the envelope names, in E.164; read for one send and held in memory only. It is the number of the vendor's
   * credential channel (`VendorCredential.recovery_phone` where the channel is PHONE; F-23, migration 0073), and the database gives it to this lane for this request only
   * and only while a fallback code is live for it: nothing otherwise, which is no destination.
   */
  async vendorRegisteredNumber(): Promise<string | undefined> {
    const found = await this.tx.execute(
      sql`select melarc.notification_handshake_number() as phone`,
    );
    const phone = (found.rows[0] as { phone: string | null } | undefined)?.phone;
    return typeof phone === 'string' && phone !== '' ? phone : undefined;
  }

  /**
   * Tells the handshake that the text carrying the code of a generation was accepted by the provider (`melarc.handshake_mark_delivered`): it moves
   * `CODE_GENERATED` to `CODE_DELIVERED` if the handshake still stands at that generation, and writes nothing otherwise. Whether it moved.
   */
  async markHandshakeDelivered(handshakeId: string, generation: number): Promise<boolean> {
    const done = await this.tx.execute(
      sql`select melarc.handshake_mark_delivered(${handshakeId}::uuid, ${generation}::integer) as moved`,
    );
    return (done.rows[0] as { moved: boolean } | undefined)?.moved === true;
  }

  /** The pickup manifest the envelope names, as the policy shows it to this context: nothing where it is not that manifest's. */
  async pickupManifest(): Promise<PickupManifestFacts | undefined> {
    const found = await this.tx.execute(sql`
      select id, code, state, responsible_hub_id, service_date::text as service_date, assigned_rider_id
        from pickup_manifest`);
    const rows = found.rows as unknown as {
      id: string;
      code: string;
      state: string;
      responsible_hub_id: string;
      service_date: string;
      assigned_rider_id: string | null;
    }[];
    // The policy shows the one manifest the envelope names. More than one row is a policy that has failed, and nothing is built on it.
    const [row] = rows;
    if (rows.length !== 1 || row === undefined) return undefined;
    return {
      id: row.id,
      code: row.code,
      state: row.state,
      responsibleHubId: row.responsible_hub_id,
      serviceDate: row.service_date,
      assignedRiderId: row.assigned_rider_id,
    };
  }

  /** The number of the rider the manifest of the envelope is given to, in E.164; read for one send and held in memory only. */
  async riderNumber(): Promise<string | undefined> {
    const found = await this.tx.execute(sql`select phone from rider_identity`);
    const rows = found.rows as unknown as { phone: string }[];
    return rows.length === 1 ? rows[0]?.phone : undefined;
  }
}

/** What the lane may do inside the transaction opened from one leased envelope: read its aggregate, write its notifications, end it. */
export class EnvelopeScope extends AggregateReader {
  readonly #envelope: ClaimedEnvelope;
  readonly #newId: () => string;

  constructor(tx: DatabaseTransaction, envelope: ClaimedEnvelope, newId: () => string) {
    super(tx);
    this.#envelope = envelope;
    this.#newId = newId;
  }

  /**
   * Writes one notification of the envelope; `EXISTS` where the relay already wrote that message to that audience.
   *
   * **A message stays worth sending for its time to live from the act, not from the relay** (the list's own definition): a worker that was
   * down overnight must not text a confirmation fifteen hours late. One that is already out of date when it is relayed is made with an
   * end one second away and is not due before it, so that the first step of the next tick ends it as `EXPIRED` and the log shows it was
   * too late; the table has no other way to make an ended row, and a row made already ended would be a second way into that state.
   */
  async insertNotification(message: NewNotification): Promise<'INSERTED' | 'EXISTS'> {
    const envelope = this.#envelope;
    const inserted = await this.tx.execute(sql`
      with life as materialized (
        select clock_timestamp() as moment,
               ${envelope.createdAt}::timestamptz + ${milliseconds(message.timeToLiveMs)} as ends
      ), term as materialized (
        select ends <= moment + interval '1 second' as late,
               case when ends <= moment + interval '1 second' then moment + interval '1 second' else ends end as at,
               moment
          from life
      )
      insert into notification (id, outbox_id, message_kind, template_version, audience, channel, responsible_hub_id,
                                vendor_organization_id, subject_type, subject_id, state, suppression_reason, parameters,
                                expires_at, next_attempt_at)
      select ${this.#newId()}::uuid, ${envelope.id}::uuid, ${message.messageKind}, ${message.templateVersion},
             ${message.audience}, ${message.channel}, ${envelope.responsibleHubId}::uuid,
             ${envelope.vendorOrganizationId}::uuid, ${envelope.aggregateType}, ${envelope.aggregateId}::uuid,
             ${message.state}, ${message.suppressionReason ?? null}, ${JSON.stringify(message.parameters ?? {})}::jsonb,
             term.at, case when term.late then term.at else term.moment end
        from term
      on conflict (outbox_id, message_kind, audience) do nothing
      returning id`);
    return inserted.rows.length === 1 ? 'INSERTED' : 'EXISTS';
  }

  /** Ends the envelope as relayed, against the lease it was claimed under. */
  async relayed(
    outcome: Extract<OutboxOutcome, 'MATERIALISED' | 'NOTHING_TO_SEND'>,
  ): Promise<void> {
    const envelope = this.#envelope;
    const ended = await this.tx.execute(sql`
      update outbox set relay_state = 'RELAYED', relayed_at = clock_timestamp(), last_outcome = ${outcome}
       where id = ${envelope.id}::uuid and relay_state = 'LEASED' and lease_version = ${envelope.leaseVersion}
      returning id`);
    if (ended.rows.length !== 1) throw new LeaseLostError();
  }
}

export interface NotificationStoreOptions {
  readonly database: DatabaseService;
  readonly clock: Clock;
  /** The lane's name for itself, as a lease names its holder: plain and non-secret. */
  readonly workerId: string;
}

export class NotificationStore {
  readonly #database: DatabaseService;
  readonly #clock: Clock;
  readonly #workerId: string;

  constructor(options: NotificationStoreOptions) {
    this.#database = options.database;
    this.#clock = options.clock;
    this.#workerId = options.workerId;
  }

  #newId = (): string => randomUUIDv7(this.#clock);

  /** The lane's context: `SYSTEM` under `notification`, with the envelope it works for where it reads a business table. */
  #context(envelope?: { id: string; hubId: string; aggregateId: string }): SecurityContext {
    return {
      principalType: 'SYSTEM',
      principalId: NOTIFICATION_LANE_PRINCIPAL_ID,
      surface: 'SYSTEM',
      taskCapability: 'notification',
      correlationId: this.#newId(),
      ...(envelope === undefined ? {} : { outbox: envelope }),
    };
  }

  #run<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.#database.transactionWithContext(this.#context(), work);
  }

  async #fenced(
    statement: (tx: DatabaseTransaction) => Promise<{ readonly rows: readonly unknown[] }>,
  ): Promise<void> {
    const result = await this.#run(statement);
    if (result.rows.length !== 1) throw new LeaseLostError();
  }

  // ---- the relay: the outbox envelope -------------------------------------------------------------------------------------

  /** Leases the oldest envelope that is due (or whose lease ended with no outcome). `null` when there is none. */
  async claimEnvelope(leaseMs: number): Promise<ClaimedEnvelope | null> {
    return this.#run(async (tx) => {
      const claimed = await tx.execute(sql`
        update outbox set relay_state = 'LEASED', attempt_count = attempt_count + 1, lease_version = lease_version + 1,
               lease_owner = ${this.#workerId}, lease_expires_at = clock_timestamp() + ${milliseconds(leaseMs)}
         where id = (
           select id from outbox
            where (relay_state = 'PENDING' and next_attempt_at <= clock_timestamp())
               or (relay_state = 'LEASED' and lease_expires_at <= clock_timestamp())
            order by created_at, id
            limit 1
            for update skip locked)
        returning id, event_type, aggregate_type, aggregate_id, responsible_hub_id, vendor_organization_id, rider_id,
                  operation_id, payload, created_at::text as created_at_text, attempt_count, lease_version`);
      const row = claimed.rows[0] as unknown as EnvelopeRow | undefined;
      if (row === undefined) return null;
      return {
        id: row.id,
        eventType: row.event_type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        responsibleHubId: row.responsible_hub_id,
        vendorOrganizationId: row.vendor_organization_id,
        riderId: row.rider_id,
        operationId: row.operation_id,
        payload: row.payload,
        createdAt: row.created_at_text,
        attemptCount: row.attempt_count,
        leaseVersion: row.lease_version,
      };
    });
  }

  /** Opens the transaction of one leased envelope: the context carries what the stored row says, and nothing a caller chose. */
  inEnvelope<T>(envelope: ClaimedEnvelope, work: (scope: EnvelopeScope) => Promise<T>): Promise<T> {
    const context = this.#context({
      id: envelope.id,
      hubId: envelope.responsibleHubId,
      aggregateId: envelope.aggregateId,
    });
    return this.#database.transactionWithContext(context, (tx) =>
      work(new EnvelopeScope(tx, envelope, this.#newId)),
    );
  }

  /** Gives an envelope back to wait for its next attempt. */
  async retryEnvelope(envelope: ClaimedEnvelope, delayMs: number): Promise<void> {
    await this.#fenced((tx) =>
      tx.execute(sql`
        update outbox set relay_state = 'PENDING', lease_expires_at = null, last_outcome = 'RETRY',
               next_attempt_at = clock_timestamp() + ${milliseconds(delayMs)}
         where id = ${envelope.id}::uuid and relay_state = 'LEASED' and lease_version = ${envelope.leaseVersion}
        returning id`),
    );
  }

  /** Dead-letters an envelope: it waits for a person (BACKGROUND_JOBS_AND_EVENTS.md §3.3). */
  async deadLetterEnvelope(
    envelope: ClaimedEnvelope,
    outcome: Extract<OutboxOutcome, 'SCOPE_MISMATCH' | 'UNKNOWN_EVENT' | 'SCHEDULE_EXHAUSTED'>,
  ): Promise<void> {
    await this.#fenced((tx) =>
      tx.execute(sql`
        update outbox set relay_state = 'DEAD', last_outcome = ${outcome}
         where id = ${envelope.id}::uuid and relay_state = 'LEASED' and lease_version = ${envelope.leaseVersion}
        returning id`),
    );
  }

  // ---- the messages --------------------------------------------------------------------------------------------------------

  /** Ends the life of the messages whose time has passed, unsent. Returns how many. */
  async expireDue(limit = 50): Promise<number> {
    return this.#run(async (tx) => {
      const expired = await tx.execute(sql`
        update notification set state = 'EXPIRED', outcome_class = 'EXPIRED'
         where id in (
           select id from notification
            where (state in ('QUEUED', 'RETRYABLE') or (state = 'LEASED' and lease_expires_at <= clock_timestamp()))
              and expires_at <= clock_timestamp()
            order by expires_at
            limit ${limit}
            for update skip locked)
        returning id`);
      return expired.rows.length;
    });
  }

  /** Leases the next text message that is due and not out of date. `null` when there is none. */
  async claimMessage(leaseMs: number): Promise<ClaimedMessage | null> {
    return this.#run(async (tx) => {
      const claimed = await tx.execute(sql`
        update notification set state = 'LEASED', attempt_count = attempt_count + 1, lease_version = lease_version + 1,
               lease_owner = ${this.#workerId}, lease_expires_at = clock_timestamp() + ${milliseconds(leaseMs)}
         where id = (
           select id from notification
            where channel = 'SMS' and expires_at > clock_timestamp()
              and ((state in ('QUEUED', 'RETRYABLE') and next_attempt_at <= clock_timestamp())
                or (state = 'LEASED' and lease_expires_at <= clock_timestamp()))
            order by next_attempt_at, id
            limit 1
            for update skip locked)
        returning id, outbox_id, message_kind, template_version, audience, responsible_hub_id, vendor_organization_id,
                  subject_id, attempt_count, lease_version`);
      const row = claimed.rows[0] as unknown as MessageRow | undefined;
      if (row === undefined) return null;
      return {
        id: row.id,
        outboxId: row.outbox_id,
        messageKind: row.message_kind,
        templateVersion: row.template_version,
        audience: row.audience,
        responsibleHubId: row.responsible_hub_id,
        vendorOrganizationId: row.vendor_organization_id,
        subjectId: row.subject_id,
        attemptCount: row.attempt_count,
        leaseVersion: row.lease_version,
      };
    });
  }

  /**
   * Opens the transaction of one leased message, from the envelope it was written under: the message carries that envelope's
   * identifiers, copied when it was written, under a guard that compared them with the stored envelope.
   */
  inMessage<T>(message: ClaimedMessage, work: (reader: AggregateReader) => Promise<T>): Promise<T> {
    const context = this.#context({
      id: message.outboxId,
      hubId: message.responsibleHubId,
      aggregateId: message.subjectId,
    });
    return this.#database.transactionWithContext(context, (tx) => work(new AggregateReader(tx)));
  }

  /**
   * Counts what the day has carried and, if there is room, keeps the hint and the digest of the destination on the message it holds and
   * the moment it reserved its place (the keeping is what makes the next lane's count see it). Under one advisory lock, so that two lanes
   * cannot both count the last free place: the limits hold across lanes.
   *
   * **The day's count is what may have left, not only what the provider said it took.** A message counts from the moment it reserved a
   * place (just before the provider is first asked) unless it is known not to have left: held back, or refused. An answer that was lost
   * (a time-out, a body that could not be read), a lane that stopped in the middle of the send, a message that gave up after answers it
   * could not read: each may have texted the person, and none says so. A day is the UTC day, which is Accra's.
   */
  async reserve(
    message: ClaimedMessage,
    destination: { readonly hint: string | null; readonly digest: string },
    limits: SendLimits,
  ): Promise<'RESERVED' | 'NUMBER_LIMIT' | 'DAY_LIMIT'> {
    return this.#run(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${NOTIFICATION_LIMITS}::int4, 0)`);
      const counted = await tx.execute(sql`
        select count(*) filter (where destination_digest = ${destination.digest}) as to_number, count(*) as overall
          from notification
         where channel = 'SMS' and id <> ${message.id}::uuid and destination_digest is not null
           and (sent_at >= (date_trunc('day', clock_timestamp() at time zone 'UTC') at time zone 'UTC')
                or (reserved_at >= (date_trunc('day', clock_timestamp() at time zone 'UTC') at time zone 'UTC')
                    and state <> 'SUPPRESSED'
                    and not (state = 'FAILED' and outcome_class = 'REJECTED')))`);
      const row = counted.rows[0] as unknown as { to_number: string; overall: string };
      if (limits.perNumberPerDay !== null && Number(row.to_number) >= limits.perNumberPerDay)
        return 'NUMBER_LIMIT';
      if (limits.perDay !== null && Number(row.overall) >= limits.perDay) return 'DAY_LIMIT';
      const kept = await tx.execute(sql`
        update notification set destination_hint = ${destination.hint}, destination_digest = ${destination.digest},
               reserved_at = coalesce(reserved_at, clock_timestamp())
         where id = ${message.id}::uuid and state = 'LEASED' and lease_version = ${message.leaseVersion}
        returning id`);
      if (kept.rows.length !== 1) throw new LeaseLostError();
      return 'RESERVED';
    });
  }

  /** The provider took the message. A reference gives the network's word a place to be asked for; none, none. */
  async recordSent(
    message: ClaimedMessage,
    providerMessageRef: string | null,
    firstCheckInMs: number,
  ): Promise<void> {
    await this.#fenced((tx) =>
      tx.execute(sql`
        update notification set state = 'SENT', outcome_class = 'ACCEPTED', sent_at = clock_timestamp(),
               provider_message_ref = ${providerMessageRef},
               next_receipt_check_at = ${providerMessageRef === null ? sql`null` : sql`clock_timestamp() + ${milliseconds(firstCheckInMs)}`}
         where id = ${message.id}::uuid and state = 'LEASED' and lease_version = ${message.leaseVersion}
        returning id`),
    );
  }

  /** The outcome is unknown: the message waits for its next attempt. */
  async recordRetry(message: ClaimedMessage, delayMs: number): Promise<void> {
    await this.#fenced((tx) =>
      tx.execute(sql`
        update notification set state = 'RETRYABLE', outcome_class = 'UNKNOWN',
               next_attempt_at = clock_timestamp() + ${milliseconds(delayMs)}
         where id = ${message.id}::uuid and state = 'LEASED' and lease_version = ${message.leaseVersion}
        returning id`),
    );
  }

  /** The message will not be sent: the provider refused it, or its schedule ended. */
  async recordFailed(
    message: ClaimedMessage,
    outcome: Extract<NotificationOutcomeClass, 'REJECTED' | 'SCHEDULE_EXHAUSTED'>,
    providerOutcomeClass: string | null,
  ): Promise<void> {
    await this.#fenced((tx) =>
      tx.execute(sql`
        update notification set state = 'FAILED', outcome_class = ${outcome}, provider_outcome_class = ${providerOutcomeClass}
         where id = ${message.id}::uuid and state = 'LEASED' and lease_version = ${message.leaseVersion}
        returning id`),
    );
  }

  /** The message is held back, with its reason, and was never sent. */
  async recordSuppressed(message: ClaimedMessage, reason: SuppressionReason): Promise<void> {
    await this.#fenced((tx) =>
      tx.execute(sql`
        update notification set state = 'SUPPRESSED', suppression_reason = ${reason}
         where id = ${message.id}::uuid and state = 'LEASED' and lease_version = ${message.leaseVersion}
        returning id`),
    );
  }

  /**
   * Seconds since the oldest work that is due and not done became due: an envelope waiting to be relayed, or a text waiting to be sent
   * (not one past its end). Zero when there is none. It reads two times and no row, and is what the gauge of the worker's metrics serves.
   */
  async oldestDueAgeSeconds(): Promise<number> {
    return this.#run(async (tx) => {
      const found = await tx.execute(sql`
        select coalesce(extract(epoch from (clock_timestamp() - min(due))), 0)::float8 as seconds
          from (
            select next_attempt_at as due from outbox
             where relay_state = 'PENDING' and next_attempt_at <= clock_timestamp()
            union all
            select next_attempt_at from notification
             where channel = 'SMS' and state in ('QUEUED', 'RETRYABLE') and next_attempt_at <= clock_timestamp()
               and expires_at > clock_timestamp()
          ) waiting`);
      const row = found.rows[0] as unknown as { seconds: number } | undefined;
      return Math.max(0, Math.round(row?.seconds ?? 0));
    });
  }

  /**
   * How many envelopes are in the dead letter (`DEAD`): acts whose messages were never made, which wait for a person. A dead envelope
   * writes no notification, so this is the one place a reader of the metrics can see that one exists.
   */
  async deadEnvelopeCount(): Promise<number> {
    return this.#run(async (tx) => {
      const found = await tx.execute(
        sql`select count(*)::int as dead from outbox where relay_state = 'DEAD'`,
      );
      return (found.rows[0] as unknown as { dead: number } | undefined)?.dead ?? 0;
    });
  }

  // ---- the network's word --------------------------------------------------------------------------------------------------

  /**
   * Takes the messages whose network status is due to be asked, and holds them off for `holdMs` so that no other lane asks at once. The
   * count of checks rises with the claim. A message that never answers is asked a bounded number of times by the caller.
   */
  async claimReceiptChecks(limit: number, holdMs: number): Promise<CheckableMessage[]> {
    return this.#run(async (tx) => {
      const taken = await tx.execute(sql`
        update notification set receipt_checks = receipt_checks + 1,
               next_receipt_check_at = clock_timestamp() + ${milliseconds(holdMs)}
         where id in (
           select id from notification
            where state = 'SENT' and provider_message_ref is not null and next_receipt_check_at <= clock_timestamp()
            order by next_receipt_check_at
            limit ${limit}
            for update skip locked)
        returning id, provider_message_ref, receipt_checks`);
      return (
        taken.rows as unknown as {
          id: string;
          provider_message_ref: string;
          receipt_checks: number;
        }[]
      ).map((row) => ({
        id: row.id,
        providerMessageRef: row.provider_message_ref,
        receiptChecks: row.receipt_checks,
      }));
    });
  }

  /** The network delivered it. */
  async recordDelivered(id: string): Promise<boolean> {
    return this.#run(async (tx) => {
      const done = await tx.execute(sql`
        update notification set state = 'DELIVERED', delivered_at = clock_timestamp()
         where id = ${id}::uuid and state = 'SENT' returning id`);
      return done.rows.length === 1;
    });
  }

  /** The network could not deliver it. */
  async recordDeliveryFailed(id: string, providerOutcomeClass: string | null): Promise<boolean> {
    return this.#run(async (tx) => {
      const done = await tx.execute(sql`
        update notification set state = 'FAILED', outcome_class = 'DELIVERY_FAILED', provider_outcome_class = ${providerOutcomeClass}
         where id = ${id}::uuid and state = 'SENT' returning id`);
      return done.rows.length === 1;
    });
  }

  /** The network has not said yet: the next look, or none (a message that does not answer is left as it was sent). */
  async scheduleReceiptCheck(id: string, delayMs: number | null): Promise<void> {
    await this.#run((tx) =>
      tx.execute(sql`
        update notification
           set next_receipt_check_at = ${delayMs === null ? sql`null` : sql`clock_timestamp() + ${milliseconds(delayMs)}`}
         where id = ${id}::uuid and state = 'SENT'`),
    );
  }
}
