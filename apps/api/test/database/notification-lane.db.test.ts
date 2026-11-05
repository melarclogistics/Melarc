import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import type { DeliveryOutcome } from '../../src/platform/auth/ports/delivery-queue.port.js';
import type {
  TextMessage,
  TextMessageSender,
  TextStatus,
} from '../../src/platform/auth/ports/text-message-sender.port.js';
import { NOTIFICATION_LIMITS } from '../../src/platform/database/policy-lock/lock-keys.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import { bindTransactionHandle } from '../../src/platform/database/transaction-handle.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import {
  CaptureTextMessageSender,
  type TextCaptureEntry,
} from '../../src/platform/notifications/capture.text-message-sender.adapter.js';
import {
  NotificationLane,
  OPEN_POLICY,
  destinationDigest,
  destinationHint,
  type LanePolicy,
} from '../../src/platform/notifications/notification-lane.js';
import {
  LeaseLostError,
  NotificationStore,
} from '../../src/platform/notifications/notification-store.js';
import { createLanePolicy } from '../../src/platform/notifications/lane-policy.js';
import {
  DatabaseNotificationSettings,
  DatabaseSettingsReader,
} from '../../src/platform/notifications/notification-settings.js';
import {
  isApproved,
  spokenDate,
  templateOf,
  type Template,
} from '../../src/platform/notifications/templates.js';
import { OutboxWriter } from '../../src/platform/notifications/outbox-writer.js';
import { insertAdHocSender, insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { HUB_A, HUB_B, staffContext } from './support/rls-fixture.js';
import { buildService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * S1.12a against a real PostgreSQL and the real lane: a business act writes its envelope in its own transaction, the lane of the delivery
 * worker (the worker's login with the grant set of the notification capability) relays it, sends the text through a sender that reaches
 * nobody, and asks for the network's word. What the lane writes holds no number and no text; what overtook a message holds it back; a
 * limit holds across two lanes; a lost lease changes nothing.
 */
let database: TestDatabase;
let admin: pg.Client;
let api: ReturnType<typeof buildService>;
let work: ReturnType<typeof buildService>;
let second: ReturnType<typeof buildService>;
const clock = new SystemClock();
const vendor1 = vendorRow({ hubId: HUB_A });
const NEVER = new AbortController().signal;

beforeAll(async () => {
  database = await createTestDatabase();
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(
    `insert into hub (id, name) values ('${HUB_A}', 'Hub A'), ('${HUB_B}', 'Hub B')`,
  );
  await insertVendor(admin, vendor1);
  api = buildService(database, { poolMax: 2 });
  work = buildService(database, { poolMax: 3, login: WORKER_RUNTIME_ROLE });
  second = buildService(database, { poolMax: 3, login: WORKER_RUNTIME_ROLE });
});

afterAll(async () => {
  await api.close();
  await work.close();
  await second.close();
  await admin.end();
  await database.drop();
});

// ---- the world ------------------------------------------------------------------------------------------------------------

let numbers = 0;
const nextPhone = () => `+23324${String(1_000_000 + randomInt(0, 8_000_000) + (numbers += 1))}`;

interface Pickup {
  readonly id: string;
  readonly code: string;
  readonly phone: string;
  readonly senderId: string;
}

/** A pickup request of an ad-hoc sender with a number of its own (or one given), in a state. */
async function adHocPickup(
  state: 'PENDING' | 'CONFIRMED' = 'CONFIRMED',
  sender?: { id: string; phone: string },
): Promise<Pickup> {
  const who = sender ?? (await insertAdHocSender(admin, { phone: nextPhone() }));
  const row = await insertPickupRequest(
    admin,
    pickupRequestRow('', HUB_A, {
      vendorOrganizationId: null,
      adHocSenderId: who.id,
      intent: 'ADHOC_SENDER',
      state,
    }),
  );
  return { id: row.id, code: row.code, phone: who.phone, senderId: who.id };
}

/** An envelope of the request as the administrator arranges it, due `minutes` from now (negative: it has been due that long). */
async function arrangeEnvelopeDue(
  requestId: string,
  minutes: number,
  eventType = 'pickup.request.confirmed',
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, originating_principal_type, originating_principal_id,
                         operation_id, correlation_id, next_attempt_at)
     values ($1, $2, 'PICKUP_REQUEST', $3, $4, 'STAFF', $5, 'confirmPickupRequest', $6, clock_timestamp() + ($7 || ' minutes')::interval)`,
    [
      id,
      eventType,
      requestId,
      HUB_A,
      '5eed0000-0000-4000-8000-0000000000e1',
      randomUUID(),
      String(minutes),
    ],
  );
  return id;
}

const staffAct = (): SecurityContext => ({
  ...staffContext([HUB_A]),
  authorizationKey: 'pickup.request.confirm',
  correlationId: randomUUID(),
});

/** The act of the API: an envelope written inside the act's own transaction, as `confirmPickupRequest` writes it. */
async function confirmAct(
  requestId: string,
  over: { eventType?: string; vendorOrganizationId?: string | null } = {},
): Promise<void> {
  await api.service.transactionWithContext(staffAct(), async (tx) => {
    await new OutboxWriter(clock).write(bindTransactionHandle(tx), {
      eventType: over.eventType ?? 'pickup.request.confirmed',
      aggregate: { type: 'PICKUP_REQUEST', id: requestId },
      responsibleHubId: HUB_A,
      vendorOrganizationId: over.vendorOrganizationId ?? null,
      operationId: 'confirmPickupRequest',
    });
  });
}

/** A sender that answers as it is told, and keeps what it was asked to send. */
class ScriptedSender implements TextMessageSender {
  readonly sent: TextMessage[] = [];
  readonly statuses = new Map<string, TextStatus>();
  readonly #outcomes: DeliveryOutcome[];
  constructor(outcomes: DeliveryOutcome[] = []) {
    this.#outcomes = outcomes;
  }
  send(message: TextMessage): Promise<DeliveryOutcome> {
    this.sent.push(message);
    const told = this.#outcomes.shift();
    return Promise.resolve(
      told ?? { outcome: 'ACCEPTED', providerMessageRef: `ref-${message.dedupeId}` },
    );
  }
  status(ref: string): Promise<TextStatus> {
    return Promise.resolve(this.statuses.get(ref) ?? { state: 'PENDING' });
  }
}

/** What a lane counted: the name and the labels of each increment, in order. */
class RecordedMetrics {
  readonly seen: string[] = [];
  increment(name: string, labels: Readonly<Record<string, string>> = {}): void {
    this.seen.push(
      `${name}{${Object.entries(labels)
        .map(([key, value]) => `${key}=${value}`)
        .join(',')}}`,
    );
  }
}

interface LaneOver {
  readonly templates?: (kind: string, version: number) => Template | undefined;
  readonly providerTimeoutMs?: number;
  readonly sender?: TextMessageSender;
  readonly metrics?: RecordedMetrics;
  readonly policy?: LanePolicy;
  readonly service?: ReturnType<typeof buildService>;
  readonly workerId?: string;
  readonly batch?: { envelopes: number; sends: number; receipts: number };
}

function laneWith(over: LaneOver = {}): { lane: NotificationLane; store: NotificationStore } {
  const service = over.service ?? work;
  const store = new NotificationStore({
    database: service.service,
    clock,
    workerId: over.workerId ?? 'test-lane',
  });
  const lane = new NotificationLane({
    store,
    sender: over.sender ?? new ScriptedSender(),
    policy: over.policy ?? OPEN_POLICY,
    logger: service.logs.logger,
    ...(over.metrics === undefined ? {} : { metrics: over.metrics }),
    ...(over.providerTimeoutMs === undefined ? {} : { providerTimeoutMs: over.providerTimeoutMs }),
    ...(over.templates === undefined ? {} : { templates: over.templates }),
    leaseMs: 30_000,
    firstReceiptCheckMs: 0,
    receiptHoldMs: 60_000,
    random: () => 0.5,
    ...(over.batch === undefined ? {} : { batch: over.batch }),
  });
  return { lane, store };
}

/** A lane that relays and does nothing else, so that the sends of a test happen when the test says. */
const relayOnly = (over: LaneOver = {}) =>
  laneWith({ ...over, batch: { envelopes: 50, sends: 0, receipts: 0 } });

interface Row {
  message_kind: string;
  audience: string;
  channel: string;
  state: string;
  suppression_reason: string | null;
  outcome_class: string | null;
  provider_outcome_class: string | null;
  destination_hint: string | null;
  destination_digest: string | null;
  attempt_count: number;
  receipt_checks: number;
  provider_message_ref: string | null;
  id: string;
}

const notificationsOf = async (requestId: string): Promise<Row[]> =>
  (
    await admin.query<Row>(
      `select id, message_kind, audience, channel, state, suppression_reason, outcome_class, provider_outcome_class, destination_hint,
              destination_digest, attempt_count, receipt_checks, provider_message_ref
         from notification where subject_id = $1 order by message_kind, audience`,
      [requestId],
    )
  ).rows;

const envelopeOf = async (requestId: string) =>
  (
    await admin.query<{
      relay_state: string;
      last_outcome: string | null;
      attempt_count: number;
      id: string;
    }>('select id, relay_state, last_outcome, attempt_count from outbox where aggregate_id = $1', [
      requestId,
    ])
  ).rows;

/** A change the guards would refuse, made by the administrator alone, to move time or to arrange a world the application cannot make. */
async function withoutGuards(
  tables: readonly string[],
  statement: string,
  values: unknown[] = [],
): Promise<void> {
  await admin.query('BEGIN');
  try {
    for (const table of tables) await admin.query(`alter table ${table} disable trigger user`);
    await admin.query(statement, values);
    for (const table of tables) await admin.query(`alter table ${table} enable trigger user`);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

// The day's count is the database's, so the messages the other tests sent or reserved today are moved to the day before: each test
// starts a day. And a message that a test left waiting or leased is ended, so that it is neither counted nor taken over by a later test.
const startAFreshDay = async (): Promise<void> => {
  await withoutGuards(
    ['notification'],
    `update notification set sent_at = sent_at - interval '3 days' where sent_at is not null and sent_at > clock_timestamp() - interval '2 days';
     update notification set reserved_at = reserved_at - interval '3 days' where reserved_at is not null and reserved_at > clock_timestamp() - interval '2 days';
     update notification set state = 'EXPIRED', outcome_class = 'EXPIRED' where state in ('LEASED', 'QUEUED', 'RETRYABLE')`,
  );
};

const makeDue = (id: string) =>
  withoutGuards(
    ['notification'],
    "update notification set next_attempt_at = clock_timestamp() - interval '1 second' where id = $1",
    [id],
  );

describe('an act, its envelope and the lane', () => {
  // Break caught: the whole chain not working end to end: no envelope written, none relayed, no message made, no word asked for.
  it('relays the envelope of a confirmed request, texts its ad-hoc sender and learns that it was delivered', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    const entries: TextCaptureEntry[] = [];
    const sender = new CaptureTextMessageSender({
      sink: { record: (entry) => Promise.resolve(void entries.push(entry)) },
      clock,
    });

    const report = await laneWith({ sender }).lane.runOnce(NEVER);

    expect(report).toMatchObject({
      relayed: 1,
      notificationsWritten: 1,
      sent: 1,
      delivered: 1,
      errors: 0,
      leasesLost: 0,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.destination).toBe(pickup.phone);
    expect(entries[0]?.text).toContain(pickup.code);
    expect(entries[0]?.text).toMatch(
      /^Melarc: your pickup .+ is confirmed for [A-Z][a-z]+day \d{1,2} [A-Z][a-z]+\./,
    );
    const [row] = await notificationsOf(pickup.id);
    expect(row).toMatchObject({
      message_kind: 'PICKUP_CONFIRMED_SENDER',
      audience: 'AD_HOC_SENDER',
      channel: 'SMS',
      state: 'DELIVERED',
      outcome_class: 'ACCEPTED',
      attempt_count: 1,
      destination_hint: destinationHint(pickup.phone),
      destination_digest: destinationDigest(pickup.phone),
    });
    expect(row?.provider_message_ref).toBe(`capture:${row?.id ?? ''}`);
    expect(entries[0]?.dedupeId).toBe(row?.id);
    expect(await envelopeOf(pickup.id)).toMatchObject([
      { relay_state: 'RELAYED', last_outcome: 'MATERIALISED', attempt_count: 1 },
    ]);
  });

  // Break caught: a number, a text or a code kept in a column or a log, which every reader of the message log would then see.
  it('keeps no number, no text and no code in any column or any log line', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    await laneWith().lane.runOnce(NEVER);
    const stored = (
      await admin.query<{ everything: string }>(
        `select (select string_agg(row_to_json(n)::text, ' ') from notification n where n.subject_id = $1)
             || ' ' || (select string_agg(row_to_json(o)::text, ' ') from outbox o where o.aggregate_id = $1) as everything`,
        [pickup.id],
      )
    ).rows[0]?.everything;
    expect(stored).toBeDefined();
    for (const secret of [
      pickup.phone,
      pickup.phone.slice(1),
      pickup.code,
      'Please have your parcels ready',
    ]) {
      expect(stored, secret).not.toContain(secret);
      expect(work.logs.text(), secret).not.toContain(secret);
    }
  });

  // Break caught: a registered vendor texted at the number of a walk-in's rules, or a walk-in given a feed it will never read.
  it('writes the feed entry of a registered vendor and sends it no text', async () => {
    const request = await insertPickupRequest(
      admin,
      pickupRequestRow(vendor1.organizationId, HUB_A, { state: 'CONFIRMED' }),
    );
    await confirmAct(request.id, { vendorOrganizationId: vendor1.organizationId });
    const sender = new ScriptedSender();
    const report = await laneWith({ sender }).lane.runOnce(NEVER);
    expect(report).toMatchObject({ relayed: 1, notificationsWritten: 1, sent: 0 });
    expect(sender.sent).toHaveLength(0);
    expect(await notificationsOf(request.id)).toMatchObject([
      {
        message_kind: 'PICKUP_CONFIRMED_VENDOR_FEED',
        audience: 'VENDOR_FEED',
        channel: 'FEED',
        state: 'DELIVERED',
      },
    ]);
  });

  // Break caught: a relay that runs twice writing every message twice: two lanes, one envelope.
  it('writes each message once however many lanes race for the envelope', async () => {
    const pickups = await Promise.all(Array.from({ length: 6 }, () => adHocPickup()));
    for (const pickup of pickups) await confirmAct(pickup.id);
    const reports = await Promise.all([
      laneWith({ workerId: 'lane-a' }).lane.runOnce(NEVER),
      laneWith({ workerId: 'lane-b', service: second }).lane.runOnce(NEVER),
    ]);
    expect(reports.reduce((sum, report) => sum + report.relayed, 0)).toBe(6);
    expect(reports.reduce((sum, report) => sum + report.errors, 0)).toBe(0);
    for (const pickup of pickups) {
      expect(await notificationsOf(pickup.id)).toHaveLength(1);
      expect((await envelopeOf(pickup.id))[0]?.attempt_count).toBe(1);
    }
  });

  it('does nothing when nothing is due', async () => {
    const report = await laneWith().lane.runOnce(NEVER);
    expect(report).toMatchObject({ relayed: 0, sent: 0, errors: 0 });
  });
});

describe('what the lane counts and what it shows of its backlog (S1.12e)', () => {
  // Break caught: a lane that does not count, or counts under a name the catalogue does not know, or under an identifier.
  it('counts the relay, the send and the receipt by closed outcome, and nothing by identifier', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    const metrics = new RecordedMetrics();
    const sender = new ScriptedSender();
    const { lane } = laneWith({ sender, metrics });
    await lane.runOnce(NEVER);
    sender.statuses.set(`ref-${(await notificationsOf(pickup.id))[0]?.id ?? ''}`, {
      state: 'DELIVERED',
    });
    await admin.query(
      "update notification set next_receipt_check_at = clock_timestamp() - interval '1 second' where subject_id = $1",
      [pickup.id],
    );
    await lane.runOnce(NEVER);
    expect(metrics.seen).toEqual([
      'notification_relay_total{outcome=MATERIALISED}',
      'notification_sends_total{result=SENT}',
      'notification_receipts_total{result=DELIVERED}',
    ]);
  });

  it('counts a message held back by its reason, a retry, a refusal and a dead letter', async () => {
    const overtaken = await adHocPickup('PENDING');
    const refused = await adHocPickup();
    const unknown = await adHocPickup();
    const unheard = await adHocPickup();
    await confirmAct(overtaken.id);
    await confirmAct(refused.id);
    await confirmAct(unknown.id);
    await confirmAct(unheard.id, { eventType: 'pickup.request.unheard_of' });
    const metrics = new RecordedMetrics();
    // The messages are sent oldest first: the overtaken one is held back before the provider is asked, so the two answers go to the other two.
    const sender = new ScriptedSender([
      { outcome: 'REJECTED', outcomeClass: 'REQUEST_INVALID' },
      { outcome: 'UNKNOWN' },
    ]);
    await laneWith({ sender, metrics }).lane.runOnce(NEVER);
    expect(metrics.seen.toSorted()).toEqual(
      [
        'notification_relay_total{outcome=MATERIALISED}',
        'notification_relay_total{outcome=MATERIALISED}',
        'notification_relay_total{outcome=MATERIALISED}',
        'notification_relay_total{outcome=UNKNOWN_EVENT}',
        'notification_suppressed_total{reason=OVERTAKEN}',
        'notification_sends_total{result=REJECTED}',
        'notification_sends_total{result=RETRY}',
      ].toSorted(),
    );
  });

  it('counts a scope that no longer matches as the security signal it is', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    await withoutGuards(
      ['pickup_request'],
      'update pickup_request set responsible_hub_id = $2 where id = $1',
      [pickup.id, HUB_B],
    );
    const metrics = new RecordedMetrics();
    await laneWith({ metrics }).lane.runOnce(NEVER);
    expect(metrics.seen).toEqual(['notification_relay_total{outcome=SCOPE_MISMATCH}']);
  });

  // Break caught: a backlog that cannot be seen: a lane that has stopped looks like a quiet system.
  it('tells how long the oldest due work has waited, and zero when nothing is due', async () => {
    const { store } = laneWith();
    // Whatever earlier tests left behind that is still due is ended, so that this test starts from nothing.
    await withoutGuards(
      ['outbox'],
      "update outbox set relay_state = 'RELAYED', relayed_at = clock_timestamp(), last_outcome = 'NOTHING_TO_SEND' where relay_state in ('PENDING', 'LEASED')",
    );
    await withoutGuards(
      ['notification'],
      "update notification set state = 'EXPIRED', outcome_class = 'EXPIRED' where state in ('QUEUED', 'RETRYABLE', 'LEASED')",
    );
    expect(await store.oldestDueAgeSeconds()).toBe(0);
    const pickup = await adHocPickup();
    const waited = await arrangeEnvelopeDue(pickup.id, -2);
    expect(waited).toBeDefined();
    const age = await store.oldestDueAgeSeconds();
    expect(age).toBeGreaterThanOrEqual(115);
    expect(age).toBeLessThan(180);
    // Work that is not yet due does not count.
    await withoutGuards(
      ['outbox'],
      "update outbox set relay_state = 'RELAYED', relayed_at = clock_timestamp(), last_outcome = 'NOTHING_TO_SEND' where relay_state = 'PENDING'",
    );
    await arrangeEnvelopeDue(pickup.id, 30, 'pickup.request.declined');
    expect(await store.oldestDueAgeSeconds()).toBe(0);
  });
});

describe('what the relay refuses', () => {
  // Break caught: an event no message answers being relayed as nothing, silently, and lost.
  it('dead-letters an envelope whose event no message answers', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id, { eventType: 'pickup.request.unheard_of' });
    const report = await laneWith().lane.runOnce(NEVER);
    expect(report).toMatchObject({ deadLettered: 1, relayed: 0 });
    expect(await envelopeOf(pickup.id)).toMatchObject([
      { relay_state: 'DEAD', last_outcome: 'UNKNOWN_EVENT' },
    ]);
    expect(await notificationsOf(pickup.id)).toHaveLength(0);
    // Break caught (review m5): a dead letter nobody can find. The log names the envelope, so a person can look it up in the outbox.
    const [envelope] = await envelopeOf(pickup.id);
    expect(work.logs.text()).toContain(envelope?.id);
  });

  // Break caught (review m5): the dead letter that the message log cannot show, for lack of a notification, and that the counter forgets
  // at the next start: the gauge counts the envelopes that wait for a person for as long as they do.
  it('counts the envelopes in the dead letter, which write no notification for the log to show', async () => {
    const store = new NotificationStore({ database: work.service, clock, workerId: 'dead-count' });
    const before = await store.deadEnvelopeCount();
    const pickup = await adHocPickup();
    await confirmAct(pickup.id, { eventType: 'pickup.request.unheard_of_again' });
    await laneWith().lane.runOnce(NEVER);
    expect(await store.deadEnvelopeCount()).toBe(before + 1);
  });

  // Break caught (SECURITY_DESIGN.md 14.7 step 8): an aggregate that moved out of the envelope's scope still being notified about.
  it('dead-letters, with a security signal and no side effect, an envelope whose aggregate is no longer in its scope', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    await withoutGuards(
      ['pickup_request'],
      'update pickup_request set responsible_hub_id = $2 where id = $1',
      [pickup.id, HUB_B],
    );
    const sender = new ScriptedSender();
    const report = await laneWith({ sender }).lane.runOnce(NEVER);
    expect(report).toMatchObject({ scopeMismatches: 1, deadLettered: 1, relayed: 0, sent: 0 });
    expect(sender.sent).toHaveLength(0);
    expect(await envelopeOf(pickup.id)).toMatchObject([
      { relay_state: 'DEAD', last_outcome: 'SCOPE_MISMATCH' },
    ]);
    expect(await notificationsOf(pickup.id)).toHaveLength(0);
    expect(work.logs.text()).toContain(
      'SECURITY: a notification envelope and its aggregate disagree about scope',
    );
    // Break caught (review m5): the one finding of this kind that names nothing to look at.
    const [envelope] = await envelopeOf(pickup.id);
    expect(work.logs.text()).toContain(envelope?.id);
  });
});

describe('what holds a message back', () => {
  // Break caught: a confirmation texted for a request that was not confirmed any longer.
  it('holds back a message that events overtook', async () => {
    const pickup = await adHocPickup('PENDING');
    await confirmAct(pickup.id);
    const sender = new ScriptedSender();
    const report = await laneWith({ sender }).lane.runOnce(NEVER);
    expect(report).toMatchObject({ relayed: 1, suppressed: 1, sent: 0 });
    expect(sender.sent).toHaveLength(0);
    expect(await notificationsOf(pickup.id)).toMatchObject([
      { state: 'SUPPRESSED', suppression_reason: 'OVERTAKEN', destination_digest: null },
    ]);
  });

  // Break caught: a kill switch, or wording nobody approved, that the lane does not obey.
  it.each(['KILL_SWITCH', 'WORDING_NOT_APPROVED'] as const)(
    'holds back a message the policy withholds: %s',
    async (reason) => {
      const pickup = await adHocPickup();
      await confirmAct(pickup.id);
      const sender = new ScriptedSender();
      const asked: string[] = [];
      const policy: LanePolicy = {
        withhold: ({ kind, template }) => {
          asked.push(`${kind}:${String(template.version)}`);
          return Promise.resolve(reason);
        },
        limits: OPEN_POLICY.limits,
      };
      const report = await laneWith({ sender, policy }).lane.runOnce(NEVER);
      expect(report.suppressed).toBe(1);
      expect(sender.sent).toHaveLength(0);
      expect(asked).toEqual(['PICKUP_CONFIRMED_SENDER:1']);
      expect(await notificationsOf(pickup.id)).toMatchObject([
        { state: 'SUPPRESSED', suppression_reason: reason },
      ]);
    },
  );

  // Break caught: the guards in front of a real provider being read as failures (a refusal that the owner's window made on purpose).
  it.each([
    ['DESTINATION_NOT_ALLOWED', 'DESTINATION_NOT_ALLOWED'],
    ['WINDOW_ENDED', 'WINDOW_LIMIT'],
    ['WINDOW_CAP', 'WINDOW_LIMIT'],
  ] as const)(
    'reads a guard’s refusal %s as a message held back for %s, not as a failure',
    async (refusal, reason) => {
      const pickup = await adHocPickup();
      await confirmAct(pickup.id);
      const sender = new ScriptedSender([{ outcome: 'REJECTED', outcomeClass: refusal }]);
      const report = await laneWith({ sender }).lane.runOnce(NEVER);
      expect(report).toMatchObject({ suppressed: 1, failed: 0 });
      expect(await notificationsOf(pickup.id)).toMatchObject([
        { state: 'SUPPRESSED', suppression_reason: reason },
      ]);
    },
  );
});

describe('the limits of a day', () => {
  const limits = (perNumberPerDay: number | null, perDay: number | null): LanePolicy => ({
    withhold: OPEN_POLICY.withhold,
    limits: () => Promise.resolve({ perNumberPerDay, perDay }),
  });

  beforeEach(startAFreshDay);
  afterEach(startAFreshDay);

  // Break caught: a per-number limit that is not applied, or applied to another number.
  it('holds back the message that would pass a number’s limit, and no other number’s', async () => {
    const sender = await insertAdHocSender(admin, { phone: nextPhone() });
    const first = await adHocPickup('CONFIRMED', sender);
    const again = await adHocPickup('CONFIRMED', sender);
    const stranger = await adHocPickup();
    for (const pickup of [first, again, stranger]) await confirmAct(pickup.id);
    const scripted = new ScriptedSender();
    await laneWith({ sender: scripted, policy: limits(1, null) }).lane.runOnce(NEVER);
    const rows = (
      await Promise.all([first, again, stranger].map((pickup) => notificationsOf(pickup.id)))
    ).map((each) => each[0]);
    const suppressed = rows.filter((row) => row?.state === 'SUPPRESSED');
    expect(suppressed.map((row) => row?.suppression_reason)).toEqual(['NUMBER_LIMIT']);
    expect(rows[2]?.state).not.toBe('SUPPRESSED');
    expect(scripted.sent).toHaveLength(2);
  });

  // Break caught: the overall day's limit not applied.
  it('holds back the message that would pass the day’s limit', async () => {
    const pickups = [await adHocPickup(), await adHocPickup(), await adHocPickup()];
    for (const pickup of pickups) await confirmAct(pickup.id);
    const scripted = new ScriptedSender();
    await laneWith({ sender: scripted, policy: limits(null, 2) }).lane.runOnce(NEVER);
    const rows = (await Promise.all(pickups.map((pickup) => notificationsOf(pickup.id)))).map(
      (each) => each[0],
    );
    expect(
      rows.filter((row) => row?.state === 'SUPPRESSED').map((row) => row?.suppression_reason),
    ).toEqual(['DAY_LIMIT']);
    expect(scripted.sent).toHaveLength(2);
  });

  // Break caught (evidence of S1.12): the limits holding in one process and not across two: both read the count, both pass. The lock
  // is held from outside while both lanes reach their count, so that they cannot help but meet.
  it('holds across two lanes in two processes', async () => {
    const sender = await insertAdHocSender(admin, { phone: nextPhone() });
    const pickups = [
      await adHocPickup('CONFIRMED', sender),
      await adHocPickup('CONFIRMED', sender),
    ];
    for (const pickup of pickups) await confirmAct(pickup.id);
    await relayOnly().lane.runOnce(NEVER);
    const one = new NotificationStore({ database: work.service, clock, workerId: 'lane-a' });
    const two = new NotificationStore({ database: second.service, clock, workerId: 'lane-b' });
    const mine = await one.claimMessage(30_000);
    const yours = await two.claimMessage(30_000);
    expect(mine).not.toBeNull();
    expect(yours).not.toBeNull();
    if (mine === null || yours === null) return;
    const destination = {
      hint: destinationHint(sender.phone),
      digest: destinationDigest(sender.phone),
    };
    const only = { perNumberPerDay: 1, perDay: null };

    await admin.query('BEGIN');
    await admin.query('select pg_advisory_xact_lock($1::int4, 0)', [NOTIFICATION_LIMITS]);
    const both = Promise.all([
      one.reserve(mine, destination, only),
      two.reserve(yours, destination, only),
    ]);
    await sleep(400);
    await admin.query('COMMIT');
    const answers = (await both).toSorted();

    expect(answers).toEqual(['NUMBER_LIMIT', 'RESERVED']);
  });

  // Break caught: a message counting itself when it is tried again: its first attempt left its number on it, and a limit of one would
  // hold back the one message that has not been sent.
  it('does not count the message itself when it is tried again', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    const scripted = new ScriptedSender([{ outcome: 'UNKNOWN' }]);
    const { lane } = laneWith({ sender: scripted, policy: limits(1, 1) });
    await lane.runOnce(NEVER);
    const [first] = await notificationsOf(pickup.id);
    expect(first).toMatchObject({ state: 'RETRYABLE', attempt_count: 1 });
    expect(first?.destination_digest).not.toBeNull();
    await makeDue(first?.id ?? '');
    await lane.runOnce(NEVER);
    expect(scripted.sent).toHaveLength(2);
    expect((await notificationsOf(pickup.id))[0]).toMatchObject({ attempt_count: 2 });
    expect((await notificationsOf(pickup.id))[0]?.state).not.toBe('SUPPRESSED');
  });

  // Break caught: a day that never ends: yesterday's messages counted against today.
  it('counts the UTC day and not the messages of yesterday', async () => {
    const sender = await insertAdHocSender(admin, { phone: nextPhone() });
    const old = await adHocPickup('CONFIRMED', sender);
    await confirmAct(old.id);
    await laneWith().lane.runOnce(NEVER);
    expect((await notificationsOf(old.id))[0]?.destination_digest).not.toBeNull();
    await withoutGuards(
      ['notification'],
      "update notification set sent_at = clock_timestamp() - interval '2 days', reserved_at = clock_timestamp() - interval '2 days' where subject_id = $1",
      [old.id],
    );
    const today = await adHocPickup('CONFIRMED', sender);
    await confirmAct(today.id);
    const scripted = new ScriptedSender();
    await laneWith({ sender: scripted, policy: limits(1, 1) }).lane.runOnce(NEVER);
    expect(scripted.sent).toHaveLength(1);
  });

  // Break caught (review I-1): a text whose answer was lost not counted. The provider may have taken it; each try may text the person
  // again, and the day's limits, which counted only what the provider said it took, would never see any of them.
  it('counts a text whose answer was lost, because it may have left', async () => {
    const sender = await insertAdHocSender(admin, { phone: nextPhone() });
    const first = await adHocPickup('CONFIRMED', sender);
    const next = await adHocPickup('CONFIRMED', sender);
    await confirmAct(first.id);
    const scripted = new ScriptedSender([{ outcome: 'UNKNOWN' }]);
    const { lane } = laneWith({ sender: scripted, policy: limits(1, null) });
    await lane.runOnce(NEVER);
    expect((await notificationsOf(first.id))[0]).toMatchObject({ state: 'RETRYABLE' });
    await confirmAct(next.id);
    await lane.runOnce(NEVER);
    expect((await notificationsOf(next.id))[0]).toMatchObject({
      state: 'SUPPRESSED',
      suppression_reason: 'NUMBER_LIMIT',
    });
    expect(scripted.sent).toHaveLength(1);
  });

  describe('what counts, by how the message ended (review I-1, m10)', () => {
    /** A message that has reserved its place, then moved by the administrator into the state under test; and a second to the same number. */
    async function arranged(shape: {
      readonly state: string;
      readonly outcome: string | null;
      readonly reason?: string;
      readonly deadLease?: boolean;
    }) {
      const sender = await insertAdHocSender(admin, { phone: nextPhone() });
      const earlier = await adHocPickup('CONFIRMED', sender);
      const later = await adHocPickup('CONFIRMED', sender);
      await confirmAct(earlier.id);
      await confirmAct(later.id);
      await relayOnly().lane.runOnce(NEVER);
      const one = new NotificationStore({ database: work.service, clock, workerId: 'lane-a' });
      const two = new NotificationStore({ database: second.service, clock, workerId: 'lane-b' });
      const mine = await one.claimMessage(30_000);
      const yours = await two.claimMessage(30_000);
      if (mine === null || yours === null) throw new Error('two messages were due');
      const destination = {
        hint: destinationHint(sender.phone),
        digest: destinationDigest(sender.phone),
      };
      expect(await one.reserve(mine, destination, { perNumberPerDay: null, perDay: null })).toBe(
        'RESERVED',
      );
      await withoutGuards(
        ['notification'],
        `update notification set state = $2, outcome_class = $3, suppression_reason = $4,
                lease_expires_at = case when $5::boolean then clock_timestamp() - interval '1 minute' else lease_expires_at end
          where id = $1`,
        [mine.id, shape.state, shape.outcome, shape.reason ?? null, shape.deadLease ?? false],
      );
      return { two, yours, destination };
    }

    // Break caught: each way a message can have left without the provider's word, not counted; and each way it is known not to have, counted.
    it.each([
      [
        'a text whose answer was lost, waiting for its next try',
        { state: 'RETRYABLE', outcome: 'UNKNOWN' },
        true,
      ],
      [
        'a text that gave up after answers it could not read',
        { state: 'FAILED', outcome: 'SCHEDULE_EXHAUSTED' },
        true,
      ],
      [
        'a text that expired while it waited to be tried again',
        { state: 'EXPIRED', outcome: 'EXPIRED' },
        true,
      ],
      [
        'a text whose lane stopped in the middle of the send (the lease ended with no outcome)',
        { state: 'LEASED', outcome: null, deadLease: true },
        true,
      ],
      ['a text the provider refused', { state: 'FAILED', outcome: 'REJECTED' }, false],
      [
        'a text a guard held back after it reserved its place',
        { state: 'SUPPRESSED', outcome: null, reason: 'DESTINATION_NOT_ALLOWED' },
        false,
      ],
    ] as const)('%s: counted is %s', async (_what, shape, counted) => {
      const { two, yours, destination } = await arranged(shape);
      expect(await two.reserve(yours, destination, { perNumberPerDay: 1, perDay: null })).toBe(
        counted ? 'NUMBER_LIMIT' : 'RESERVED',
      );
    });

    // Break caught (review m10): the day's edge. The first instant of the UTC day is today's and the last second before it is not.
    it.each([
      ['reserved', 'reserved_at'],
      ['sent', 'sent_at'],
    ] as const)(
      'counts a message %s at the first instant of the UTC day and not the second before it',
      async (_what, column) => {
        const { two, yours, destination } = await arranged({
          state: 'RETRYABLE',
          outcome: 'UNKNOWN',
        });
        const dayStart =
          "(date_trunc('day', clock_timestamp() at time zone 'UTC') at time zone 'UTC')";
        // A message the provider took has been sent; one that was only reserved has not. Only the column under test is dated at the edge:
        // a message sent just after midnight may have reserved its place just before it, a day earlier, and then only its sending counts it.
        const moveTo = (when: string) =>
          withoutGuards(
            ['notification'],
            column === 'reserved_at'
              ? `update notification set reserved_at = ${when} where destination_digest = $1 and state = 'RETRYABLE'`
              : `update notification set sent_at = ${when}, reserved_at = ${dayStart} - interval '1 day', state = 'DELIVERED',
                      outcome_class = 'ACCEPTED', delivered_at = clock_timestamp()
                where destination_digest = $1 and state in ('RETRYABLE', 'DELIVERED')`,
            [destination.digest],
          );
        await moveTo(`${dayStart} - interval '1 second'`);
        expect(await two.reserve(yours, destination, { perNumberPerDay: 1, perDay: null })).toBe(
          'RESERVED',
        );
        await moveTo(dayStart);
        expect(await two.reserve(yours, destination, { perNumberPerDay: 1, perDay: null })).toBe(
          'NUMBER_LIMIT',
        );
      },
    );
  });

  // Break caught: a message in flight not counted, so that the lane that holds one and the lane that counts do not see each other.
  it('counts the message another lane is holding', async () => {
    const sender = await insertAdHocSender(admin, { phone: nextPhone() });
    const held = await adHocPickup('CONFIRMED', sender);
    const waiting = await adHocPickup('CONFIRMED', sender);
    await confirmAct(held.id);
    await confirmAct(waiting.id);
    await relayOnly().lane.runOnce(NEVER);
    const one = new NotificationStore({ database: work.service, clock, workerId: 'lane-a' });
    const two = new NotificationStore({ database: second.service, clock, workerId: 'lane-b' });
    const mine = await one.claimMessage(30_000);
    const yours = await two.claimMessage(30_000);
    if (mine === null || yours === null) throw new Error('two messages were due');
    const destination = {
      hint: destinationHint(sender.phone),
      digest: destinationDigest(sender.phone),
    };
    expect(await one.reserve(mine, destination, { perNumberPerDay: 1, perDay: null })).toBe(
      'RESERVED',
    );
    // `mine` has not been sent: it is leased, and the other lane's count sees it.
    expect(await two.reserve(yours, destination, { perNumberPerDay: 1, perDay: null })).toBe(
      'NUMBER_LIMIT',
    );
  });
});

describe('the lane under the platform’s settings (S1.12e)', () => {
  const unusable: string[] = [];
  const settingsPolicy = (realProvider = false): LanePolicy =>
    createLanePolicy({
      realProvider,
      settings: new DatabaseNotificationSettings({
        reader: new DatabaseSettingsReader({ database: work.service, clock }),
        clock,
        cacheMs: 0,
        onUnusable: (key) => unusable.push(key),
      }),
    });
  const write = (key: string, value: string) =>
    admin.query(
      `insert into setting (key, scope, value_type, value, unit, description) values ($1, 'PLATFORM', 'integer', $2::jsonb, 'x', 'x')
       on conflict (key) do update set value = excluded.value`,
      [key, value],
    );
  const writeAll = async (enabled: string, perNumber: string, perDay: string) => {
    await write('sms_enabled', enabled);
    await write('sms_per_number_daily_limit', perNumber);
    await write('sms_daily_limit', perDay);
  };
  beforeEach(async () => {
    unusable.length = 0;
    await admin.query(
      `delete from setting where key in ('sms_enabled','sms_per_number_daily_limit','sms_daily_limit')`,
    );
    await withoutGuards(
      ['notification'],
      `update notification set state = 'EXPIRED', outcome_class = 'EXPIRED' where state = 'LEASED';
      update notification set sent_at = sent_at - interval '3 days' where sent_at is not null and sent_at > clock_timestamp() - interval '2 days'`,
    );
  });

  // Break caught: the pilot figures not read from the settings, so that the Platform Admin's limit changes nothing the lane does.
  it('holds back the message that would pass the number’s limit the settings state', async () => {
    await writeAll('true', '1', '500');
    const sender = await insertAdHocSender(admin, { phone: nextPhone() });
    const first = await adHocPickup('CONFIRMED', sender);
    const again = await adHocPickup('CONFIRMED', sender);
    await confirmAct(first.id);
    await confirmAct(again.id);
    const scripted = new ScriptedSender();
    await laneWith({ sender: scripted, policy: settingsPolicy() }).lane.runOnce(NEVER);
    const states = [(await notificationsOf(first.id))[0], (await notificationsOf(again.id))[0]];
    expect(
      states.filter((row) => row?.state === 'SUPPRESSED').map((row) => row?.suppression_reason),
    ).toEqual(['NUMBER_LIMIT']);
    expect(scripted.sent).toHaveLength(1);
  });

  // Break caught: the switch not read, so that the owner cannot stop the texts in a bad hour.
  it('holds every text back while the switch is off, and sends again when it is on', async () => {
    await writeAll('false', '10', '500');
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    const scripted = new ScriptedSender();
    const { lane } = laneWith({ sender: scripted, policy: settingsPolicy() });
    await lane.runOnce(NEVER);
    expect(scripted.sent).toHaveLength(0);
    expect(await notificationsOf(pickup.id)).toMatchObject([
      { state: 'SUPPRESSED', suppression_reason: 'KILL_SWITCH' },
    ]);
    // Held back is final for that message; the next one goes out under the switch as it stands.
    await write('sms_enabled', 'true');
    const next = await adHocPickup();
    await confirmAct(next.id);
    await lane.runOnce(NEVER);
    expect(scripted.sent).toHaveLength(1);
  });

  // Break caught (settings.md section 8): settings that are missing read as "on, without a limit", which is how a runaway sends.
  it('sends nothing when the settings are missing, and names the keys', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    const scripted = new ScriptedSender();
    await laneWith({ sender: scripted, policy: settingsPolicy() }).lane.runOnce(NEVER);
    expect(scripted.sent).toHaveLength(0);
    expect(await notificationsOf(pickup.id)).toMatchObject([
      { state: 'SUPPRESSED', suppression_reason: 'KILL_SWITCH' },
    ]);
    expect(unusable).toContain('sms_enabled');
  });

  it('reads a limit that is not a number as zero: the message is held back as a limit', async () => {
    await writeAll('true', '"ten"', '500');
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    const scripted = new ScriptedSender();
    await laneWith({ sender: scripted, policy: settingsPolicy() }).lane.runOnce(NEVER);
    expect(scripted.sent).toHaveLength(0);
    expect(await notificationsOf(pickup.id)).toMatchObject([
      { state: 'SUPPRESSED', suppression_reason: 'NUMBER_LIMIT' },
    ]);
    expect(unusable).toEqual(['sms_per_number_daily_limit']);
  });

  // The wording the lane reads, with the approval taken off: what the words were before the owner approved them, and what any later
  // message's will be until the owner does.
  const asDrafts = (kind: string, version: number): Template | undefined => {
    const found = templateOf(kind, version);
    return found === undefined
      ? undefined
      : { ...found, approvedBy: null, approvedOn: null, approvedDigest: null };
  };

  // Break caught (OQ-037): a real provider asked to send words the owner never approved.
  it('does not ask a real provider to send words nobody approved, and sends them to a sender that reaches nobody', async () => {
    await writeAll('true', '10', '500');
    const draft = asDrafts('PICKUP_CONFIRMED_SENDER', 1);
    if (draft === undefined) throw new Error('the sender’s confirmation has no template');
    expect(isApproved(draft)).toBe(false);
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    const real = new ScriptedSender();
    await laneWith({
      sender: real,
      policy: settingsPolicy(true),
      templates: asDrafts,
    }).lane.runOnce(NEVER);
    expect(real.sent).toHaveLength(0);
    expect(await notificationsOf(pickup.id)).toMatchObject([
      { state: 'SUPPRESSED', suppression_reason: 'WORDING_NOT_APPROVED' },
    ]);

    // The same draft, sent to a sender that reaches nobody, goes: the gate stands in front of a real provider only.
    const next = await adHocPickup();
    await confirmAct(next.id);
    const capture = new ScriptedSender();
    await laneWith({
      sender: capture,
      policy: settingsPolicy(false),
      templates: asDrafts,
    }).lane.runOnce(NEVER);
    expect(capture.sent).toHaveLength(1);
  });

  // Break caught: the owner's approval (30 October 2026) not honoured, so that a real provider is never given the words.
  it('sends the words the owner approved to a real provider, exactly as approved', async () => {
    await writeAll('true', '10', '500');
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    const real = new ScriptedSender();
    await laneWith({ sender: real, policy: settingsPolicy(true) }).lane.runOnce(NEVER);
    expect(real.sent).toHaveLength(1);
    expect(real.sent[0]?.text).toBe(
      `Melarc: your pickup ${pickup.code} is confirmed for ${spokenDate('2026-11-03')}. Please have your parcels ready.`,
    );
  });
});

describe('what the provider says', () => {
  // Break caught: a timeout read as a refusal (a lost message) or as success (a message never sent).
  it('retries an unknown outcome on the schedule and ends it after the sixth attempt', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    const sender = new ScriptedSender(
      Array.from({ length: 6 }, () => ({ outcome: 'UNKNOWN' }) as const),
    );
    const { lane } = laneWith({ sender });
    await lane.runOnce(NEVER);
    let [row] = await notificationsOf(pickup.id);
    expect(row).toMatchObject({ state: 'RETRYABLE', outcome_class: 'UNKNOWN', attempt_count: 1 });
    // Waiting is the schedule's: nothing is sent again before it is due.
    await lane.runOnce(NEVER);
    expect(sender.sent).toHaveLength(1);
    for (let attempt = 2; attempt <= 6; attempt += 1) {
      await makeDue(row?.id ?? '');
      await lane.runOnce(NEVER);
      [row] = await notificationsOf(pickup.id);
      expect(row?.attempt_count).toBe(attempt);
    }
    expect(sender.sent).toHaveLength(6);
    expect(row).toMatchObject({
      state: 'FAILED',
      outcome_class: 'SCHEDULE_EXHAUSTED',
      attempt_count: 6,
    });
    // Every attempt was the same message to the provider.
    expect(new Set(sender.sent.map((message) => message.dedupeId)).size).toBe(1);
  });

  // Break caught: the provider's own wait ignored.
  it('waits at least as long as the provider asked', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    const sender = new ScriptedSender([{ outcome: 'UNKNOWN', retryAfterMs: 600_000 }]);
    await laneWith({ sender }).lane.runOnce(NEVER);
    const waits = await admin.query<{ seconds: number }>(
      'select extract(epoch from (next_attempt_at - clock_timestamp()))::int as seconds from notification where subject_id = $1',
      [pickup.id],
    );
    expect(waits.rows[0]?.seconds).toBeGreaterThan(540);
    expect(waits.rows[0]?.seconds).toBeLessThanOrEqual(600);
  });

  // Break caught: a refusal retried, or a refusal that loses its closed class.
  it('ends a refusal at once, with the provider’s class', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    const sender = new ScriptedSender([{ outcome: 'REJECTED', outcomeClass: 'REQUEST_INVALID' }]);
    const { lane } = laneWith({ sender });
    const report = await lane.runOnce(NEVER);
    expect(report).toMatchObject({ failed: 1, retried: 0 });
    expect(await notificationsOf(pickup.id)).toMatchObject([
      { state: 'FAILED', outcome_class: 'REJECTED', provider_outcome_class: 'REQUEST_INVALID' },
    ]);
    await lane.runOnce(NEVER);
    expect(sender.sent).toHaveLength(1);
  });

  // Break caught: a provider's free text (which may hold the number) reaching the table as a class.
  it('keeps no outcome class that is not a plain word', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    const sender = new ScriptedSender([
      { outcome: 'REJECTED', outcomeClass: `bad number ${pickup.phone}` },
    ]);
    await laneWith({ sender }).lane.runOnce(NEVER);
    const [row] = await notificationsOf(pickup.id);
    expect(row?.provider_outcome_class).toBe('PROVIDER_REFUSED');
  });
});

describe('the network’s word', () => {
  async function sentMessage(): Promise<{
    pickup: Pickup;
    sender: ScriptedSender;
    row: Row;
    lane: NotificationLane;
  }> {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    const sender = new ScriptedSender();
    const { lane } = laneWith({ sender });
    await lane.runOnce(NEVER);
    const [row] = await notificationsOf(pickup.id);
    if (row === undefined) throw new Error('nothing was written');
    return { pickup, sender, row, lane };
  }

  const askAgainNow = (id: string) =>
    admin.query(
      "update notification set next_receipt_check_at = clock_timestamp() - interval '1 second' where id = $1",
      [id],
    );

  it('asks again later while it is pending', async () => {
    const pending = await sentMessage();
    expect(pending.row.state).toBe('SENT');
    expect(pending.row.receipt_checks).toBe(1);
    const later = await admin.query<{ seconds: number }>(
      'select extract(epoch from (next_receipt_check_at - clock_timestamp()))::int as seconds from notification where id = $1',
      [pending.row.id],
    );
    expect(later.rows[0]?.seconds).toBeGreaterThan(20);
    expect(later.rows[0]?.seconds).toBeLessThanOrEqual(30);
  });

  it('records delivered', async () => {
    const delivered = await sentMessage();
    delivered.sender.statuses.set(delivered.row.provider_message_ref ?? '', { state: 'DELIVERED' });
    await askAgainNow(delivered.row.id);
    expect((await delivered.lane.runOnce(NEVER)).delivered).toBeGreaterThanOrEqual(1);
    expect((await notificationsOf(delivered.pickup.id))[0]).toMatchObject({ state: 'DELIVERED' });
    const stamped = await admin.query(
      'select 1 from notification where id = $1 and delivered_at is not null',
      [delivered.row.id],
    );
    expect(stamped.rowCount).toBe(1);
  });

  it('records a failure in delivery with the provider’s class', async () => {
    const failed = await sentMessage();
    failed.sender.statuses.set(failed.row.provider_message_ref ?? '', {
      state: 'FAILED',
      outcomeClass: 'UNDELIVERABLE',
    });
    await askAgainNow(failed.row.id);
    expect((await failed.lane.runOnce(NEVER)).deliveryFailed).toBeGreaterThanOrEqual(1);
    expect((await notificationsOf(failed.pickup.id))[0]).toMatchObject({
      state: 'FAILED',
      outcome_class: 'DELIVERY_FAILED',
      provider_outcome_class: 'UNDELIVERABLE',
    });
  });

  // Break caught: a message that never answers asked for ever.
  it('stops asking about a message that never answers', async () => {
    const { row, lane, pickup } = await sentMessage();
    for (let look = 2; look <= 12; look += 1) {
      await askAgainNow(row.id);
      await lane.runOnce(NEVER);
      expect((await notificationsOf(pickup.id))[0]?.receipt_checks).toBe(look);
    }
    const last = await admin.query<{ next_receipt_check_at: Date | null }>(
      'select next_receipt_check_at from notification where id = $1',
      [row.id],
    );
    expect(last.rows[0]?.next_receipt_check_at).toBeNull();
    expect((await notificationsOf(pickup.id))[0]?.state).toBe('SENT');
  });
});

describe('the end of a message’s usefulness, and of a lease', () => {
  // Break caught: a confirmation sent the next day because the lane was down overnight.
  it('lets a message that waited past its end expire unsent', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    await relayOnly().lane.runOnce(NEVER);
    await withoutGuards(
      ['notification'],
      "update notification set created_at = created_at - interval '2 days', expires_at = clock_timestamp() - interval '1 hour' where subject_id = $1",
      [pickup.id],
    );
    const sender = new ScriptedSender();
    const report = await laneWith({ sender }).lane.runOnce(NEVER);
    expect(report).toMatchObject({ expired: 1, sent: 0 });
    expect(sender.sent).toHaveLength(0);
    expect(await notificationsOf(pickup.id)).toMatchObject([
      { state: 'EXPIRED', outcome_class: 'EXPIRED' },
    ]);
  });

  // Break caught: an outcome written by a lane that lost its lease overwriting the lane that took the message over.
  it('lets a lane that lost its lease change nothing', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    await relayOnly().lane.runOnce(NEVER);
    const store = new NotificationStore({ database: work.service, clock, workerId: 'lane-a' });
    const slow = await store.claimMessage(30_000);
    expect(slow?.subjectId).toBe(pickup.id);
    if (slow === null) return;
    // The lease ends with no outcome, and another lane takes the message over.
    await withoutGuards(
      ['notification'],
      "update notification set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [slow.id],
    );
    const other = new NotificationStore({ database: second.service, clock, workerId: 'lane-b' });
    const taken = await other.claimMessage(30_000);
    expect(taken?.id).toBe(slow.id);
    expect(taken?.leaseVersion).toBe(slow.leaseVersion + 1);
    await expect(store.recordSent(slow, 'late-ref', 0)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(store.recordSuppressed(slow, 'KILL_SWITCH')).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    if (taken !== null) await other.recordSent(taken, 'real-ref', 0);
    expect((await notificationsOf(pickup.id))[0]).toMatchObject({
      state: 'SENT',
      provider_message_ref: 'real-ref',
      attempt_count: 2,
    });
  });
});

/** Everything still waiting from earlier tests is ended, so that a test that claims "the next" message or envelope claims its own. */
const clearTheQueue = async (): Promise<void> => {
  await startAFreshDay();
  await withoutGuards(
    ['outbox'],
    "update outbox set relay_state = 'RELAYED', relayed_at = clock_timestamp(), last_outcome = 'NOTHING_TO_SEND' where relay_state in ('PENDING', 'LEASED')",
  );
};

describe('a message lives from the act, not from the relay (review I-2)', () => {
  beforeEach(clearTheQueue);
  afterEach(clearTheQueue);
  const ageTheAct = (requestId: string, interval: string) =>
    withoutGuards(
      ['outbox'],
      `update outbox set created_at = created_at - interval '${interval}' where aggregate_id = $1`,
      [requestId],
    );

  // Break caught: a message that lives from its relay and not from its act. The worker was down overnight, the envelope is relayed in
  // the morning, and the confirmation of the evening before is texted fifteen hours late.
  it('ends a message six hours after the act, however late the envelope is relayed', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    await ageTheAct(pickup.id, '5 hours');
    await relayOnly().lane.runOnce(NEVER);
    const found = await admin.query<{ drift: number }>(
      `select extract(epoch from (n.expires_at - (o.created_at + interval '6 hours')))::float8 as drift
         from notification n join outbox o on o.id = n.outbox_id where n.subject_id = $1`,
      [pickup.id],
    );
    expect(Math.abs(found.rows[0]?.drift ?? Number.NaN)).toBeLessThan(0.01);
    // An hour is left of its life, so it is sent.
    const sender = new ScriptedSender();
    await laneWith({ sender }).lane.runOnce(NEVER);
    expect(sender.sent).toHaveLength(1);
  });

  // Break caught: the same, past the end. The message is not sent, and the log shows it was too late, not that it never was.
  it('does not send a message that is already out of date when its envelope is relayed, and shows it expired', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    await ageTheAct(pickup.id, '7 hours');
    const sender = new ScriptedSender();
    const { lane } = laneWith({ sender });
    const first = await lane.runOnce(NEVER);
    expect(first).toMatchObject({ relayed: 1, notificationsWritten: 1, sent: 0 });
    expect(sender.sent).toHaveLength(0);
    // Made with an end one second away and not due before it: the first step of the next tick ends it.
    expect(await notificationsOf(pickup.id)).toMatchObject([{ state: 'QUEUED', attempt_count: 0 }]);
    await sleep(1_300);
    const second_ = await lane.runOnce(NEVER);
    expect(second_).toMatchObject({ expired: 1, sent: 0 });
    expect(sender.sent).toHaveLength(0);
    expect(await notificationsOf(pickup.id)).toMatchObject([
      { state: 'EXPIRED', outcome_class: 'EXPIRED', attempt_count: 0 },
    ]);
  });

  // Break caught: a late message sent in the second between its relay and its end (due at once, because nothing made it wait).
  it('does not let a late message be claimed in the second it has left', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    await ageTheAct(pickup.id, '7 hours');
    await relayOnly().lane.runOnce(NEVER);
    const store = new NotificationStore({ database: work.service, clock, workerId: 'lane-late' });
    expect(await store.claimMessage(30_000)).toBeNull();
  });
});

describe('the fences of the lease (review I-3)', () => {
  beforeEach(clearTheQueue);
  afterEach(clearTheQueue);
  const noLimits = { perNumberPerDay: null, perDay: null };

  /** A message claimed by a slow lane whose lease then ended, and taken over by another lane. */
  async function takenOver() {
    const sender = await insertAdHocSender(admin, { phone: nextPhone() });
    const pickup = await adHocPickup('CONFIRMED', sender);
    await confirmAct(pickup.id);
    await relayOnly().lane.runOnce(NEVER);
    const slow = new NotificationStore({ database: work.service, clock, workerId: 'lane-slow' });
    const quick = new NotificationStore({
      database: second.service,
      clock,
      workerId: 'lane-quick',
    });
    const claimed = await slow.claimMessage(30_000);
    if (claimed?.subjectId !== pickup.id) throw new Error('the message was not the one due');
    await withoutGuards(
      ['notification'],
      "update notification set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [claimed.id],
    );
    const taken = await quick.claimMessage(30_000);
    if (taken?.id !== claimed.id) throw new Error('the message was not taken over');
    return {
      slow,
      quick,
      claimed,
      taken,
      pickup,
      destination: { hint: destinationHint(sender.phone), digest: destinationDigest(sender.phone) },
    };
  }

  // Break caught: each of these writing the outcome of a lane that lost its lease over the lane that holds it. The table's guard does not
  // look at the version, so the `where` of each statement is the only protection.
  it.each([
    ['a retry', (s: Awaited<ReturnType<typeof takenOver>>) => s.slow.recordRetry(s.claimed, 1_000)],
    [
      'a refusal',
      (s: Awaited<ReturnType<typeof takenOver>>) =>
        s.slow.recordFailed(s.claimed, 'REJECTED', 'REQUEST_INVALID'),
    ],
    [
      'the end of the schedule',
      (s: Awaited<ReturnType<typeof takenOver>>) =>
        s.slow.recordFailed(s.claimed, 'SCHEDULE_EXHAUSTED', null),
    ],
    [
      'the reservation of a place',
      (s: Awaited<ReturnType<typeof takenOver>>) =>
        s.slow.reserve(s.claimed, s.destination, noLimits),
    ],
  ] as const)(
    'refuses %s from a lane that lost its lease, and changes nothing',
    async (_what, stale) => {
      const world = await takenOver();
      await expect(stale(world)).rejects.toBeInstanceOf(LeaseLostError);
      // The row is as the lane that holds the lease left it: leased to it, with no outcome and no place reserved by the other.
      const [row] = await notificationsOf(world.pickup.id);
      expect(row).toMatchObject({
        state: 'LEASED',
        outcome_class: null,
        provider_outcome_class: null,
        destination_digest: null,
        attempt_count: 2,
      });
      const owner = await admin.query<{
        lease_owner: string;
        lease_version: number;
        reserved_at: Date | null;
      }>('select lease_owner, lease_version, reserved_at from notification where id = $1', [
        world.claimed.id,
      ]);
      expect(owner.rows[0]).toMatchObject({
        lease_owner: 'lane-quick',
        lease_version: world.taken.leaseVersion,
        reserved_at: null,
      });
      // ...and the lane that holds it goes on and ends it.
      await world.quick.recordRetry(world.taken, 1_000);
      expect((await notificationsOf(world.pickup.id))[0]).toMatchObject({ state: 'RETRYABLE' });
    },
  );

  /** An envelope claimed by a slow lane whose lease then ended, and taken over by another lane. */
  async function envelopeTakenOver() {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    const slow = new NotificationStore({ database: work.service, clock, workerId: 'lane-slow' });
    const quick = new NotificationStore({
      database: second.service,
      clock,
      workerId: 'lane-quick',
    });
    const claimed = await slow.claimEnvelope(30_000);
    if (claimed?.aggregateId !== pickup.id) throw new Error('the envelope was not the one due');
    await withoutGuards(
      ['outbox'],
      "update outbox set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [claimed.id],
    );
    const taken = await quick.claimEnvelope(30_000);
    if (taken?.id !== claimed.id) throw new Error('the envelope was not taken over');
    return { slow, quick, claimed, taken, pickup };
  }

  // Break caught: the same for the envelope: a slow lane giving it back, dead-lettering it or ending it as relayed (with its notifications)
  // after another lane took it over.
  it.each([
    [
      'giving it back to wait',
      (s: Awaited<ReturnType<typeof envelopeTakenOver>>) => s.slow.retryEnvelope(s.claimed, 1_000),
    ],
    [
      'dead-lettering it',
      (s: Awaited<ReturnType<typeof envelopeTakenOver>>) =>
        s.slow.deadLetterEnvelope(s.claimed, 'SCOPE_MISMATCH'),
    ],
    [
      'ending it as relayed, with the messages it made',
      (s: Awaited<ReturnType<typeof envelopeTakenOver>>) =>
        s.slow.inEnvelope(s.claimed, async (scope) => {
          await scope.insertNotification({
            messageKind: 'PICKUP_CONFIRMED_SENDER',
            templateVersion: 1,
            audience: 'AD_HOC_SENDER',
            channel: 'SMS',
            state: 'QUEUED',
            timeToLiveMs: 6 * 3_600_000,
          });
          await scope.relayed('MATERIALISED');
        }),
    ],
  ] as const)(
    'refuses %s from a lane that lost its lease, and changes nothing',
    async (_what, stale) => {
      const world = await envelopeTakenOver();
      await expect(stale(world)).rejects.toBeInstanceOf(LeaseLostError);
      expect(await envelopeOf(world.pickup.id)).toMatchObject([
        { relay_state: 'LEASED', last_outcome: null, attempt_count: 2 },
      ]);
      const held = await admin.query<{ lease_owner: string; lease_version: number }>(
        'select lease_owner, lease_version from outbox where id = $1',
        [world.claimed.id],
      );
      expect(held.rows[0]).toMatchObject({
        lease_owner: 'lane-quick',
        lease_version: world.taken.leaseVersion,
      });
      // The messages the stale lane wrote in its transaction went with the transaction.
      expect(await notificationsOf(world.pickup.id)).toHaveLength(0);
      // ...and the lane that holds the envelope relays it.
      await world.quick.inEnvelope(world.taken, (scope) => scope.relayed('NOTHING_TO_SEND'));
      expect(await envelopeOf(world.pickup.id)).toMatchObject([{ relay_state: 'RELAYED' }]);
    },
  );
});

describe('a send starts only with time left in its lease (review m4)', () => {
  beforeEach(clearTheQueue);
  afterEach(clearTheQueue);
  // Break caught: a lane that stalled on the way to the provider (a slow read, a database that hesitated) asking it under a lease that
  // another lane may take over, so that both send the text.
  it('leaves the message for the next claim when too little of the lease is left to ask the provider', async () => {
    const pickup = await adHocPickup();
    await confirmAct(pickup.id);
    await relayOnly().lane.runOnce(NEVER);
    const stall: LanePolicy = {
      withhold: async () => {
        await sleep(400);
        return null;
      },
      limits: OPEN_POLICY.limits,
    };
    const sender = new ScriptedSender();
    // A lease of thirty seconds, the provider allowed twenty-four and eight tenths, and five kept back for the record: a send may start in
    // the first two tenths of a second, and this one starts after four.
    const stalled = laneWith({ sender, policy: stall, providerTimeoutMs: 24_800 });
    const report = await stalled.lane.runOnce(NEVER);
    expect(report).toMatchObject({ sent: 0, leasesLost: 1 });
    expect(sender.sent).toHaveLength(0);
    expect(await notificationsOf(pickup.id)).toMatchObject([{ state: 'LEASED', attempt_count: 1 }]);

    // Its lease ends, and a lane that is not stalled sends it.
    await withoutGuards(
      ['notification'],
      "update notification set lease_expires_at = clock_timestamp() - interval '1 second' where subject_id = $1",
      [pickup.id],
    );
    const again = await laneWith({ sender, providerTimeoutMs: 0 }).lane.runOnce(NEVER);
    expect(again).toMatchObject({ sent: 1 });
    expect(sender.sent).toHaveLength(1);
    expect((await notificationsOf(pickup.id))[0]).toMatchObject({
      state: 'SENT',
      attempt_count: 2,
    });
  });
});
