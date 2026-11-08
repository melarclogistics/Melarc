import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import type {
  TextMessage,
  TextMessageSender,
} from '../../src/platform/auth/ports/text-message-sender.port.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { bindTransactionHandle } from '../../src/platform/database/transaction-handle.js';
import {
  CaptureTextMessageSender,
  type TextCaptureEntry,
} from '../../src/platform/notifications/capture.text-message-sender.adapter.js';
import { createLanePolicy } from '../../src/platform/notifications/lane-policy.js';
import {
  NotificationLane,
  OPEN_POLICY,
  destinationHint,
} from '../../src/platform/notifications/notification-lane.js';
import {
  NOTIFICATION_LANE_PRINCIPAL_ID,
  NotificationStore,
} from '../../src/platform/notifications/notification-store.js';
import { OutboxWriter } from '../../src/platform/notifications/outbox-writer.js';
import { insertManifest, manifestRow } from './support/manifests.js';
import { insertRider, riderRow } from './support/riders.js';
import { HUB_A, HUB_B, staffContext } from './support/rls-fixture.js';
import { buildService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * S1.21, the rider's text on dispatch (D-11, decided 29 October 2026): the pickup manifest is the second aggregate a notification may be
 * raised about. `dispatchManifest` writes its envelope in its own transaction; the lane of the delivery worker (the worker's login with the
 * grant set of the notification capability) relays it into one text for the rider the run is given to, reads the rider's number for that one
 * send, and holds the text back when events overtook it. The claims, each against a real PostgreSQL and the real lane:
 *
 * - **The chain works.** An envelope of a dispatched run is relayed into one `RUN_DISPATCHED_RIDER` notification, the rider's number is the
 *   destination and appears in no column, and the text names the run and its day and nothing else.
 * - **A run that moved on is not announced.** Started, cancelled or completed before the send, the text is held back (`OVERTAKEN`).
 * - **The envelope is the manifest's.** An envelope that names another hub, a vendor or a rider scope is refused by the database; one whose
 *   scope the manifest no longer has is a security signal and a dead letter, never a send.
 * - **The lane reads the one run and the one rider its envelope names**, only the columns a message is made from, and nothing without an
 *   envelope.
 */
let database: TestDatabase;
let admin: pg.Client;
let api: ReturnType<typeof buildService>;
let work: ReturnType<typeof buildService>;
const clock = new SystemClock();
const NEVER = new AbortController().signal;
const vendor1 = vendorRow({ hubId: HUB_A });

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
}, 120_000);

afterAll(async () => {
  await api.close();
  await work.close();
  await admin.end();
  await database.drop();
});

interface Run {
  readonly id: string;
  readonly code: string;
  readonly riderId: string;
  readonly riderPhone: string;
}

/** A dispatched run of hub A given to an active rider of hub A, as the administrator arranges it. */
async function dispatchedRun(
  over: { hubId?: string; riderHubId?: string; state?: 'DISPATCHED' | 'DRAFT' } = {},
): Promise<Run> {
  const rider = await insertRider(admin, riderRow({ hubId: over.riderHubId ?? HUB_A }));
  const manifest = await insertManifest(
    admin,
    manifestRow(over.hubId ?? HUB_A, {
      state: over.state ?? 'DISPATCHED',
      assignedRiderId: rider.id,
      serviceDate: '2026-11-03',
    }),
  );
  return { id: manifest.id, code: manifest.code, riderId: rider.id, riderPhone: rider.phone };
}

/** The SQLSTATE a piece of work is refused with, or nothing when it is not refused. */
async function refusedWith(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return (
      (error as { cause?: { code?: string }; code?: string }).cause?.code ??
      (error as { code?: string }).code
    );
  }
  return undefined;
}

const dispatchAct = (): SecurityContext => ({
  ...staffContext([HUB_A]),
  authorizationKey: 'pickup.manifest.dispatch',
  correlationId: randomUUID(),
});

/** The act of the API: an envelope written inside the act's own transaction, as `dispatchManifest` writes it. */
async function dispatchEnvelope(
  manifestId: string,
  over: { hubId?: string; vendorOrganizationId?: string | null } = {},
): Promise<void> {
  await api.service.transactionWithContext(dispatchAct(), async (tx) => {
    await new OutboxWriter(clock).write(bindTransactionHandle(tx), {
      eventType: 'pickup.manifest.dispatched',
      aggregate: { type: 'PICKUP_MANIFEST', id: manifestId },
      responsibleHubId: over.hubId ?? HUB_A,
      vendorOrganizationId: over.vendorOrganizationId ?? null,
      operationId: 'dispatchManifest',
    });
  });
}

function laneOf(entries: TextCaptureEntry[]): NotificationLane {
  const store = new NotificationStore({ database: work.service, clock, workerId: 'test-run-lane' });
  return new NotificationLane({
    store,
    sender: new CaptureTextMessageSender({
      sink: { record: (entry) => Promise.resolve(void entries.push(entry)) },
      clock,
    }),
    policy: OPEN_POLICY,
    logger: work.logs.logger,
    leaseMs: 30_000,
    firstReceiptCheckMs: 0,
    receiptHoldMs: 60_000,
    random: () => 0.5,
  });
}

const notificationsOf = async (manifestId: string) =>
  (
    await admin.query<{
      message_kind: string;
      audience: string;
      channel: string;
      state: string;
      suppression_reason: string | null;
      subject_type: string;
      destination_hint: string | null;
      destination_digest: string | null;
    }>(
      `select message_kind, audience, channel, state, suppression_reason, subject_type, destination_hint, destination_digest
         from notification where subject_id = $1 order by message_kind, audience`,
      [manifestId],
    )
  ).rows;

const envelopesOf = async (manifestId: string) =>
  (
    await admin.query<{ relay_state: string; last_outcome: string | null }>(
      `select relay_state, last_outcome from outbox where aggregate_id = $1 order by created_at`,
      [manifestId],
    )
  ).rows;

describe('the envelope of a dispatched run and the lane', () => {
  // Break caught: the whole chain not working end to end for a run: no envelope accepted, none relayed, no message for the rider, the text sent
  // to nobody or to the wrong number, or a number kept in a column.
  it('relays the envelope into one text for the rider of the run, which names the run and its day and holds no number', async () => {
    const run = await dispatchedRun();
    await dispatchEnvelope(run.id);
    const entries: TextCaptureEntry[] = [];

    const report = await laneOf(entries).runOnce(NEVER);

    expect(report).toMatchObject({
      relayed: 1,
      notificationsWritten: 1,
      sent: 1,
      delivered: 1,
      errors: 0,
      leasesLost: 0,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.destination).toBe(run.riderPhone);
    expect(entries[0]?.text).toBe(
      `Melarc: your pickup run ${run.code} for Tuesday 3 November is ready. Open the Melarc app to see your stops.`,
    );
    expect(await notificationsOf(run.id)).toEqual([
      expect.objectContaining({
        message_kind: 'RUN_DISPATCHED_RIDER',
        audience: 'RIDER',
        channel: 'SMS',
        state: 'DELIVERED',
        subject_type: 'PICKUP_MANIFEST',
        destination_hint: destinationHint(run.riderPhone),
      }),
    ]);
    expect(await envelopesOf(run.id)).toEqual([
      { relay_state: 'RELAYED', last_outcome: 'MATERIALISED' },
    ]);
    // Nothing the person could be reached by is kept in the notification or the envelope.
    const kept = await admin.query<{ everything: string }>(
      `select (select coalesce(string_agg(n::text, ' '), '') from notification n where n.subject_id = $1)
              || (select coalesce(string_agg(o::text, ' '), '') from outbox o where o.aggregate_id = $1) as everything`,
      [run.id],
    );
    expect(kept.rows[0]?.everything).not.toContain(run.riderPhone);
  });

  // Break caught: a text sent for a run that was started, completed or cancelled before the lane got to it, which says what is no longer so.
  it.each([
    ['cancelled', `update pickup_manifest set state = 'CANCELLED' where id = $1`],
    [
      'started',
      `update pickup_manifest set state = 'IN_PROGRESS', started_at = clock_timestamp() where id = $1`,
    ],
  ])('holds the text back for a run that was %s before the send', async (_what, change) => {
    const run = await dispatchedRun();
    await dispatchEnvelope(run.id);
    await admin.query(change, [run.id]);
    const entries: TextCaptureEntry[] = [];

    const report = await laneOf(entries).runOnce(NEVER);

    expect(report).toMatchObject({ relayed: 1, notificationsWritten: 1, sent: 0, suppressed: 1 });
    expect(entries).toEqual([]);
    expect(await notificationsOf(run.id)).toEqual([
      expect.objectContaining({
        message_kind: 'RUN_DISPATCHED_RIDER',
        state: 'SUPPRESSED',
        suppression_reason: 'OVERTAKEN',
      }),
    ]);
  });

  // Break caught (OB-S1-06; the Product Owner, 2 November 2026): the provider's answer standing in the dispatch's success. A dispatch commits
  // with its envelope; whether the provider delivers the text is another fact, told by the message log. A provider that refuses the rider's text
  // leaves the run dispatched and the envelope relayed, and the refusal is the notification's, not the run's.
  it('leaves the run dispatched and its envelope relayed when the provider refuses the text', async () => {
    const run = await dispatchedRun();
    await dispatchEnvelope(run.id);
    const refusing: TextMessageSender = {
      send: () => Promise.resolve({ outcome: 'REJECTED', outcomeClass: 'REQUEST_INVALID' }),
      status: () => Promise.resolve({ state: 'PENDING' }),
    };
    const store = new NotificationStore({
      database: work.service,
      clock,
      workerId: 'test-refusal',
    });
    const lane = new NotificationLane({
      store,
      sender: refusing,
      policy: OPEN_POLICY,
      logger: work.logs.logger,
      leaseMs: 30_000,
      firstReceiptCheckMs: 0,
      receiptHoldMs: 60_000,
      random: () => 0.5,
    });

    const report = await lane.runOnce(NEVER);

    // The provider refused it, so it was not sent; the lane itself did not fail.
    expect(report).toMatchObject({ relayed: 1, notificationsWritten: 1, sent: 0, errors: 0 });
    expect(await notificationsOf(run.id)).toEqual([
      expect.objectContaining({ message_kind: 'RUN_DISPATCHED_RIDER', state: 'FAILED' }),
    ]);
    expect(await envelopesOf(run.id)).toEqual([
      { relay_state: 'RELAYED', last_outcome: 'MATERIALISED' },
    ]);
    const state = await admin.query<{ state: string; dispatched_at: Date | null }>(
      `select state, dispatched_at from pickup_manifest where id = $1`,
      [run.id],
    );
    expect(state.rows[0]).toMatchObject({ state: 'DISPATCHED' });
    expect(state.rows[0]?.dispatched_at).not.toBeNull();
  });

  // Break caught (OB-S1-06): the approval of the wording opening more than the wording gate. With the words approved and a real provider named,
  // the owner's switch still holds the rider's text back, nothing reaches the sender, and the run is as dispatched as before.
  it('holds the approved text back while the owner’s switch is off, with nothing sent and the run still dispatched', async () => {
    const run = await dispatchedRun();
    await dispatchEnvelope(run.id);
    const sent: TextMessage[] = [];
    const watching: TextMessageSender = {
      send: (message) => {
        sent.push(message);
        return Promise.resolve({ outcome: 'ACCEPTED', providerMessageRef: 'never' });
      },
      status: () => Promise.resolve({ state: 'PENDING' }),
    };
    const store = new NotificationStore({ database: work.service, clock, workerId: 'test-switch' });
    const lane = new NotificationLane({
      store,
      sender: watching,
      policy: createLanePolicy({
        realProvider: true,
        settings: {
          smsEnabled: () => Promise.resolve(false),
          disabledKinds: () => Promise.resolve(new Set<string>()),
          limits: () => Promise.resolve({ perNumberPerDay: null, perDay: null }),
        },
      }),
      logger: work.logs.logger,
      leaseMs: 30_000,
      firstReceiptCheckMs: 0,
      receiptHoldMs: 60_000,
      random: () => 0.5,
    });

    const report = await lane.runOnce(NEVER);

    expect(report).toMatchObject({ relayed: 1, notificationsWritten: 1, sent: 0, suppressed: 1 });
    expect(sent).toEqual([]);
    expect(await notificationsOf(run.id)).toEqual([
      expect.objectContaining({
        message_kind: 'RUN_DISPATCHED_RIDER',
        state: 'SUPPRESSED',
        suppression_reason: 'KILL_SWITCH',
      }),
    ]);
    const state = await admin.query<{ state: string }>(
      `select state from pickup_manifest where id = $1`,
      [run.id],
    );
    expect(state.rows[0]).toMatchObject({ state: 'DISPATCHED' });
  });

  // Break caught: a message made for a run nobody was given, which would be a text to nobody or, worse, to the last rider that was.
  it('makes no message for a run that has no rider', async () => {
    const run = await insertManifest(admin, manifestRow(HUB_A, { serviceDate: '2026-11-03' }));
    await dispatchEnvelope(run.id);
    const entries: TextCaptureEntry[] = [];

    const report = await laneOf(entries).runOnce(NEVER);

    expect(report).toMatchObject({ relayed: 1, notificationsWritten: 0, sent: 0, errors: 0 });
    expect(entries).toEqual([]);
    expect(await notificationsOf(run.id)).toEqual([]);
    expect(await envelopesOf(run.id)).toEqual([
      { relay_state: 'RELAYED', last_outcome: 'NOTHING_TO_SEND' },
    ]);
  });
});

describe('what the database accepts as the envelope of a run', () => {
  const writeAs = (context: SecurityContext, manifestId: string, hubId: string, vendor?: string) =>
    api.service.transactionWithContext(context, async (tx) => {
      await new OutboxWriter(clock).write(bindTransactionHandle(tx), {
        eventType: 'pickup.manifest.dispatched',
        aggregate: { type: 'PICKUP_MANIFEST', id: manifestId },
        responsibleHubId: hubId,
        vendorOrganizationId: vendor ?? null,
        operationId: 'dispatchManifest',
      });
    });

  // Break caught: an envelope that carries a scope the manifest does not have (the hub of another, a vendor, a rider), which the lane would
  // then read the manifest under, or an envelope for a manifest its writer cannot read.
  it('refuses an envelope that names another hub, a vendor, or a run its writer cannot read', async () => {
    const run = await dispatchedRun();
    const foreign = await dispatchedRun({ hubId: HUB_B, riderHubId: HUB_B });
    expect(await refusedWith(() => writeAs(dispatchAct(), run.id, HUB_B))).toBe('23514');
    expect(
      await refusedWith(() =>
        writeAs(dispatchAct(), run.id, HUB_A, '5eed0000-0000-4000-8000-0000000000a1'),
      ),
    ).toBe('23514');
    // The writer has the key in hub A only: a run of hub B is not one it can read, and an envelope cannot be written about it.
    expect(await refusedWith(() => writeAs(dispatchAct(), foreign.id, HUB_B))).toBe('23514');
    expect(await refusedWith(() => writeAs(dispatchAct(), randomUUID(), HUB_A))).toBe('23514');
    expect(await envelopesOf(run.id)).toEqual([]);
    // And the one that is right is accepted.
    expect(await refusedWith(() => writeAs(dispatchAct(), run.id, HUB_A))).toBeUndefined();
    expect(await envelopesOf(run.id)).toEqual([{ relay_state: 'PENDING', last_outcome: null }]);
  });

  // Break caught: a rider scope on the envelope of a run (the rider is the manifest's, found by the lane under the policy, and never a label
  // the envelope asserts).
  it('refuses an envelope that carries a rider scope of its own', async () => {
    const run = await dispatchedRun();
    const context = dispatchAct();
    const refused = await refusedWith(() =>
      api.service.transactionWithContext(context, async (tx) => {
        await tx.execute(
          sql`insert into outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, rider_id, originating_principal_type,
                                 originating_principal_id, operation_id, correlation_id)
              values (${randomUUID()}::uuid, 'pickup.manifest.dispatched', 'PICKUP_MANIFEST', ${run.id}::uuid, ${HUB_A}::uuid,
                      ${run.riderId}::uuid, 'STAFF', ${context.principalId}::uuid, 'dispatchManifest', ${randomUUID()}::uuid)`,
        );
      }),
    );
    expect(refused).toBeDefined();
    expect(await envelopesOf(run.id)).toEqual([]);
  });

  // Break caught: a stored envelope whose scope the manifest no longer has, relayed and texted anyway. The lane reads the manifest under
  // the envelope's own hub, finds none, and ends the envelope as a security signal with nothing written.
  it('dead-letters, with no message and no text, an envelope whose scope the run does not have', async () => {
    // The envelope another test of this file left waiting is relayed first, so that the counts below are this envelope's alone.
    await laneOf([]).runOnce(NEVER);
    const run = await dispatchedRun();
    await dispatchEnvelope(run.id);
    // The run moves to another hub behind the envelope, which the application never does (the guard of a manifest holds its hub).
    await admin.query('BEGIN');
    await admin.query('alter table pickup_manifest disable trigger user');
    await admin.query('update pickup_manifest set responsible_hub_id = $2 where id = $1', [
      run.id,
      HUB_B,
    ]);
    await admin.query('alter table pickup_manifest enable trigger user');
    await admin.query('COMMIT');
    const entries: TextCaptureEntry[] = [];

    const report = await laneOf(entries).runOnce(NEVER);

    expect(report).toMatchObject({ scopeMismatches: 1, deadLettered: 1, relayed: 0, sent: 0 });
    expect(entries).toEqual([]);
    expect(await notificationsOf(run.id)).toEqual([]);
    expect(await envelopesOf(run.id)).toEqual([
      { relay_state: 'DEAD', last_outcome: 'SCOPE_MISMATCH' },
    ]);
    expect(work.logs.text()).toContain(
      'SECURITY: a notification envelope and its aggregate disagree about scope',
    );
  });
});

describe('what the lane may read of a run and its rider', () => {
  const lane = (
    envelope: { id: string; hubId: string; aggregateId: string } | undefined,
  ): SecurityContext => ({
    principalType: 'SYSTEM',
    principalId: NOTIFICATION_LANE_PRINCIPAL_ID,
    surface: 'SYSTEM',
    taskCapability: 'notification',
    correlationId: randomUUID(),
    ...(envelope === undefined ? {} : { outbox: envelope }),
  });
  const rows = (context: SecurityContext, text: string) =>
    work.service.transactionWithContext(
      context,
      async (tx) => (await tx.execute(sql.raw(text))).rows,
    );
  const stateOf = (context: SecurityContext, text: string) =>
    refusedWith(() =>
      work.service.transactionWithContext(context, (tx) => tx.execute(sql.raw(text))),
    );

  // Break caught: a policy that shows the lane every run or every rider, or any when no envelope is open; and a grant that shows it more
  // of a rider than the number (the PIN's hash, the status) or more of a run than a message is made from.
  it('reads the one run and the one rider its envelope names, the columns a message is made from, and nothing without an envelope', async () => {
    const run = await dispatchedRun();
    const other = await dispatchedRun();
    const open = lane({ id: randomUUID(), hubId: HUB_A, aggregateId: run.id });

    expect(await rows(open, 'select id from pickup_manifest')).toEqual([{ id: run.id }]);
    expect(await rows(open, 'select id, phone from rider_identity')).toEqual([
      { id: run.riderId, phone: run.riderPhone },
    ]);
    // Without an envelope, or under another hub's, the lane sees neither.
    expect(await rows(lane(undefined), 'select id from pickup_manifest')).toEqual([]);
    expect(await rows(lane(undefined), 'select id from rider_identity')).toEqual([]);
    expect(
      await rows(
        lane({ id: randomUUID(), hubId: HUB_B, aggregateId: run.id }),
        'select id from pickup_manifest',
      ),
    ).toEqual([]);
    expect(other.id).not.toBe(run.id);

    // The columns beyond what a message is made from are not granted: not the rider's hash or status, not the run's moments.
    for (const text of [
      'select pin_hash from rider_identity',
      'select status from rider_identity',
      'select full_name from rider_identity',
      'select assigned_at from pickup_manifest',
      'select dispatched_at from pickup_manifest',
    ]) {
      expect(await stateOf(open, text), text).toBe('42501');
    }
    // And it writes neither table.
    expect(await stateOf(open, `update pickup_manifest set state = 'CANCELLED'`)).toBe('42501');
    expect(await stateOf(open, `update rider_identity set status = 'SUSPENDED'`)).toBe('42501');
  });
});
