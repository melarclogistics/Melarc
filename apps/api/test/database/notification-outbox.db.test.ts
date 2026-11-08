import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { DatabaseTransaction } from '../../src/platform/database/database.service.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import {
  FINAL_NOTIFICATION_STATES,
  NOTIFICATION_AUDIENCES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_OUTCOME_CLASSES,
  NOTIFICATION_STATES,
  OUTBOX_AGGREGATE_TYPES,
  OUTBOX_OUTCOMES,
  OUTBOX_PRINCIPAL_TYPES,
  OUTBOX_RELAY_STATES,
  SUPPRESSION_REASONS,
} from '../../src/platform/notifications/notification-vocabulary.js';
import { insertAdHocSender, insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import {
  HUB_A,
  HUB_B,
  PRINCIPAL_1,
  RIDER_1,
  riderContext,
  staffContext,
  systemContext,
  vendorContext,
} from './support/rls-fixture.js';
import { buildService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * S1.12a against a real PostgreSQL: the outbox envelope and the notification (migration 0055; BACKGROUND_JOBS_AND_EVENTS.md section 3.7;
 * SECURITY_DESIGN.md section 14.7; data-scope-registry.md `Outbox` and `Notification`). The closed sets the code and the database share, who
 * may write an envelope and what it may name, what the lane of the delivery worker may read and change (and the business rows it may reach,
 * which are the one aggregate its leased envelope names and no other), the state machines of the two tables, and who reads a notification.
 * Arranged and changed as the cluster administrator where a constraint or a trigger is under test.
 */
let database: TestDatabase;
let admin: pg.Client;
let api: Built;
let work: Built;

const vendor1 = vendorRow({ hubId: HUB_A });
const vendor2 = vendorRow({ hubId: HUB_B });
let sender: { id: string; phone: string };
let adHocInA: string;
let otherAdHocInA: string;
let vendorRequestInA: string;
let vendorRequestInB: string;

beforeAll(async () => {
  database = await createTestDatabase();
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(
    `insert into hub (id, name) values ('${HUB_A}', 'Hub A'), ('${HUB_B}', 'Hub B')`,
  );
  await insertVendor(admin, vendor1);
  await insertVendor(admin, vendor2);
  sender = await insertAdHocSender(admin);
  const other = await insertAdHocSender(admin);
  const adHoc = (adHocSenderId: string) =>
    pickupRequestRow('', HUB_A, {
      vendorOrganizationId: null,
      adHocSenderId,
      intent: 'ADHOC_SENDER',
    });
  adHocInA = (await insertPickupRequest(admin, adHoc(sender.id))).id;
  otherAdHocInA = (await insertPickupRequest(admin, adHoc(other.id))).id;
  vendorRequestInA = (
    await insertPickupRequest(admin, pickupRequestRow(vendor1.organizationId, HUB_A))
  ).id;
  vendorRequestInB = (
    await insertPickupRequest(admin, pickupRequestRow(vendor2.organizationId, HUB_B))
  ).id;
  api = buildService(database, { poolMax: 2 });
  work = buildService(database, { poolMax: 2, login: WORKER_RUNTIME_ROLE });
});

afterAll(async () => {
  await api.close();
  await work.close();
  await admin.end();
  await database.drop();
});

type Built = ReturnType<typeof buildService>;

/**
 * The contexts of a business act carry the key of the operation (SECURITY_DESIGN.md 14.1a), and the policies of the pickup tables read it:
 * an envelope is written, and its aggregate read by the guard, in the context the act ran in.
 */
const staffKeyed = (hubs: readonly string[], mode: 'SET' | 'ALL' = 'SET'): SecurityContext => ({
  ...staffContext(hubs, mode),
  authorizationKey: 'pickup.request.confirm',
});
const vendorKeyed = (organizationId: string): SecurityContext => ({
  ...vendorContext(organizationId),
  authorizationKey: 'pickup.request.create',
});

/** The SQLSTATE an administrator's statement ends with, rolled back, or `undefined` when it ran. */
const adminCode = async (
  statement: string,
  values: unknown[] = [],
): Promise<string | undefined> => {
  await admin.query('BEGIN');
  try {
    await admin.query(statement, values);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  } finally {
    await admin.query('ROLLBACK');
  }
};

/** The words of the refusal an administrator's statement ends with, rolled back, or `undefined` when it ran. */
const adminMessage = async (
  statement: string,
  values: unknown[] = [],
): Promise<string | undefined> => {
  await admin.query('BEGIN');
  try {
    await admin.query(statement, values);
    return undefined;
  } catch (error) {
    return (error as { message?: string }).message;
  } finally {
    await admin.query('ROLLBACK');
  }
};

const run = <T>(
  service: Built,
  context: SecurityContext,
  body: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> => service.service.transactionWithContext(context, body);

/** The words of the refusal a statement run in a context ends with, or `undefined` when it ran. */
async function messageOf(
  service: Built,
  context: SecurityContext,
  statement: ReturnType<typeof sql>,
) {
  try {
    await run(service, context, async (tx) => {
      await tx.execute(statement);
    });
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.message;
  }
}

/** The SQLSTATE a statement run in a context ends with, or `undefined` when it ran. */
async function stateOf(
  service: Built,
  context: SecurityContext,
  statement: ReturnType<typeof sql>,
) {
  try {
    await run(service, context, async (tx) => {
      await tx.execute(statement);
    });
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.code;
  }
}

async function rowsOf<T = Record<string, unknown>>(
  service: Built,
  context: SecurityContext,
  statement: ReturnType<typeof sql>,
): Promise<T[]> {
  return run(service, context, async (tx) => (await tx.execute(statement)).rows as T[]);
}

const asApi = (context: SecurityContext, statement: ReturnType<typeof sql>) =>
  stateOf(api, context, statement);
const asWorker = (context: SecurityContext, statement: ReturnType<typeof sql>) =>
  stateOf(work, context, statement);

interface Envelope {
  id: string;
  eventType: string;
  aggregateId: string;
  hubId: string;
  vendorOrganizationId: string | null;
  riderId: string | null;
  principalType: string;
  principalId: string;
  correlationId: string;
}

function envelope(over: Partial<Envelope> & { aggregateId: string }): Envelope {
  return {
    id: randomUUID(),
    eventType: 'pickup.request.confirmed',
    hubId: HUB_A,
    vendorOrganizationId: null,
    riderId: null,
    principalType: 'STAFF',
    principalId: PRINCIPAL_1,
    correlationId: randomUUID(),
    ...over,
  };
}

const insertEnvelope = (e: Envelope): ReturnType<typeof sql> =>
  sql`insert into outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, vendor_organization_id, rider_id,
                          originating_principal_type, originating_principal_id, operation_id, correlation_id, payload)
      values (${e.id}, ${e.eventType}, 'PICKUP_REQUEST', ${e.aggregateId}, ${e.hubId}, ${e.vendorOrganizationId}, ${e.riderId},
              ${e.principalType}, ${e.principalId}, 'confirmPickupRequest', ${e.correlationId}, '{"k":1}'::jsonb)`;

/** An envelope as the administrator arranges it (its guard still runs); `dueInMinutes` makes it wait. */
async function arrange(
  over: Partial<Envelope> & { aggregateId: string },
  dueInMinutes = 0,
): Promise<Envelope> {
  const e = envelope(over);
  await admin.query(
    `insert into outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, vendor_organization_id, rider_id,
                         originating_principal_type, originating_principal_id, operation_id, correlation_id, next_attempt_at)
     values ($1, $2, 'PICKUP_REQUEST', $3, $4, $5, $6, $7, $8, 'confirmPickupRequest', $9, clock_timestamp() + ($10 || ' minutes')::interval)`,
    [
      e.id,
      e.eventType,
      e.aggregateId,
      e.hubId,
      e.vendorOrganizationId,
      e.riderId,
      e.principalType,
      e.principalId,
      e.correlationId,
      String(dueInMinutes),
    ],
  );
  return e;
}

const CLAIM = (unit: 'minutes' | 'seconds' = 'minutes', amount = 5) =>
  `update outbox set relay_state = 'LEASED', attempt_count = attempt_count + 1, lease_version = lease_version + 1,
                     lease_owner = 'lane-1', lease_expires_at = clock_timestamp() + interval '${String(amount)} ${unit}' where id = $1`;

const leased = async (over: Partial<Envelope> & { aggregateId: string }): Promise<Envelope> => {
  const e = await arrange(over);
  await admin.query(CLAIM(), [e.id]);
  return e;
};

/** The lane's context for one envelope, as the worker builds it from the row it leased. */
const laneFor = (e: Pick<Envelope, 'id' | 'hubId' | 'aggregateId'>): SecurityContext => ({
  ...systemContext('notification'),
  outbox: { id: e.id, hubId: e.hubId, aggregateId: e.aggregateId },
});
const LANE: SecurityContext = systemContext('notification');

let kinds = 0;
const nextKind = () => `KIND_${String((kinds += 1))}_X`;

interface Message {
  kind?: string;
  audience?: string;
  channel?: string;
  state?: string;
  reason?: string | null;
  hubId?: string;
}

const notificationInsert = (e: Envelope, m: Message = {}): ReturnType<typeof sql> =>
  sql`insert into notification (id, outbox_id, message_kind, template_version, audience, channel, responsible_hub_id,
                                vendor_organization_id, subject_type, subject_id, state, suppression_reason, expires_at)
      values (${randomUUID()}, ${e.id}, ${m.kind ?? nextKind()}, 1, ${m.audience ?? 'AD_HOC_SENDER'}, ${m.channel ?? 'SMS'}, ${m.hubId ?? e.hubId},
              ${e.vendorOrganizationId}, 'PICKUP_REQUEST', ${e.aggregateId}, ${m.state ?? 'QUEUED'}, ${m.reason ?? null},
              clock_timestamp() + interval '6 hours')`;

/** A notification as the administrator arranges it, under a leased envelope. */
async function arrangeNotification(
  e: Envelope,
  m: Message = {},
  expiresIn = '6 hours',
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into notification (id, outbox_id, message_kind, template_version, audience, channel, responsible_hub_id, vendor_organization_id,
                               subject_type, subject_id, state, suppression_reason, expires_at)
     values ($1, $2, $3, 1, $4, $5, $6, $7, 'PICKUP_REQUEST', $8, $9, $10, clock_timestamp() + $11::interval)`,
    [
      id,
      e.id,
      m.kind ?? nextKind(),
      m.audience ?? 'AD_HOC_SENDER',
      m.channel ?? 'SMS',
      m.hubId ?? e.hubId,
      e.vendorOrganizationId,
      e.aggregateId,
      m.state ?? 'QUEUED',
      m.reason ?? null,
      expiresIn,
    ],
  );
  return id;
}

const CLAIM_MESSAGE = `update notification set state = 'LEASED', attempt_count = attempt_count + 1, lease_version = lease_version + 1,
                              lease_owner = 'lane-1', lease_expires_at = clock_timestamp() + interval '5 minutes' where id = $1`;
const SEND = `update notification set state = 'SENT', outcome_class = 'ACCEPTED', sent_at = clock_timestamp(), provider_message_ref = 'ref-1',
                     next_receipt_check_at = clock_timestamp() + interval '1 minute' where id = $1`;

describe('the closed sets are the database’s', () => {
  const literalsOf = async (table: string, constraint: string): Promise<string[]> => {
    const found = await admin.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class t on t.oid = c.conrelid
        where t.relname = $1 and c.conname = $2`,
      [table, constraint],
    );
    const def = found.rows[0]?.def;
    if (def === undefined) throw new Error(`no constraint ${constraint}`);
    return [...def.matchAll(/'([A-Z_]+)'::text/g)].map((match) => match[1] ?? '').toSorted();
  };

  // Break caught: a value added to the code and not to the table, or the reverse: the vocabulary and the CHECK would then disagree
  // about what a row may say, and the first write of the new value would fail in production and not in a test.
  it.each([
    ['outbox', 'outbox_aggregate_type_closed', OUTBOX_AGGREGATE_TYPES],
    ['outbox', 'outbox_principal_closed', OUTBOX_PRINCIPAL_TYPES],
    ['outbox', 'outbox_state_closed', OUTBOX_RELAY_STATES],
    ['outbox', 'outbox_outcome_closed', OUTBOX_OUTCOMES],
    ['notification', 'notification_audience_closed', NOTIFICATION_AUDIENCES],
    ['notification', 'notification_channel_closed', NOTIFICATION_CHANNELS],
    ['notification', 'notification_state_closed', NOTIFICATION_STATES],
    ['notification', 'notification_suppression_closed', SUPPRESSION_REASONS],
    ['notification', 'notification_outcome_closed', NOTIFICATION_OUTCOME_CLASSES],
    ['notification', 'notification_subject_closed', OUTBOX_AGGREGATE_TYPES],
  ] as const)('%s %s lists exactly the values of the code', async (table, constraint, values) => {
    expect(await literalsOf(table, constraint)).toEqual([...values].toSorted());
  });

  it('keeps the final states of a notification inside its states', () => {
    for (const state of FINAL_NOTIFICATION_STATES) expect(NOTIFICATION_STATES).toContain(state);
  });
});

describe('who writes an envelope, and what it may name', () => {
  // Break caught: an envelope that a business act could not write, which would make every act fail.
  it('lets a staff member write the envelope of its own act, for a request in its hubs', async () => {
    expect(
      await asApi(staffKeyed([HUB_A]), insertEnvelope(envelope({ aggregateId: adHocInA }))),
    ).toBeUndefined();
  });

  it('lets a vendor write the envelope of its own act, for its own request', async () => {
    const e = envelope({
      aggregateId: vendorRequestInA,
      vendorOrganizationId: vendor1.organizationId,
      principalType: 'VENDOR',
    });
    expect(await asApi(vendorKeyed(vendor1.organizationId), insertEnvelope(e))).toBeUndefined();
  });

  // Break caught: a policy that checks the staff member's hubs against the envelope's claim only, so that the claim decides.
  it('refuses a staff member an envelope for a hub it does not hold', async () => {
    const e = envelope({
      aggregateId: vendorRequestInB,
      hubId: HUB_B,
      vendorOrganizationId: vendor2.organizationId,
    });
    // The guard reads the aggregate in the writer's own context before the policy reads the envelope: a request in a hub the writer
    // does not hold is not one it can read, so the envelope is refused there (the policy's hub test is the second line behind it).
    expect(await asApi(staffKeyed([HUB_A]), insertEnvelope(e))).toBe('23514');
  });

  // Break caught: the scope of an envelope taken from its writer's claim and not from the aggregate (SECURITY_DESIGN.md 14.7): a staff
  // member who holds both hubs names the hub of the request, and no other.
  it('refuses an envelope whose hub is not the aggregate’s, even for a staff member who holds both hubs', async () => {
    const e = envelope({ aggregateId: adHocInA, hubId: HUB_B });
    expect(await asApi(staffKeyed([HUB_A, HUB_B]), insertEnvelope(e))).toBe('23514');
  });

  // Break caught: a vendor on the envelope of a request that is not its own, or none on the envelope of a request that has one.
  it('refuses an envelope whose vendor is not the aggregate’s', async () => {
    const staffWrote = envelope({ aggregateId: vendorRequestInA, vendorOrganizationId: null });
    expect(await asApi(staffKeyed([HUB_A]), insertEnvelope(staffWrote))).toBe('23514');
    const wrong = envelope({
      aggregateId: vendorRequestInA,
      vendorOrganizationId: vendor2.organizationId,
    });
    expect(await asApi(staffKeyed([HUB_A]), insertEnvelope(wrong))).toBe('23514');
  });

  // Break caught: the envelope of an aggregate its writer cannot read, which would let one vendor raise a notification about another's.
  it('refuses an envelope about an aggregate the writer cannot read, or that does not exist', async () => {
    const theirs = envelope({
      aggregateId: vendorRequestInA,
      vendorOrganizationId: vendor2.organizationId,
      principalType: 'VENDOR',
    });
    expect(await asApi(vendorKeyed(vendor2.organizationId), insertEnvelope(theirs))).toBe('23514');
    expect(
      await asApi(staffKeyed([HUB_A]), insertEnvelope(envelope({ aggregateId: randomUUID() }))),
    ).toBe('23514');
    // And it says what it refuses: an aggregate its writer cannot read, and not a scope that differs.
    for (const [context, e] of [
      [vendorKeyed(vendor2.organizationId), theirs],
      [staffKeyed([HUB_A]), envelope({ aggregateId: randomUUID() })],
    ] as const) {
      expect(await messageOf(api, context, insertEnvelope(e))).toMatch(
        /aggregate that its writer can read/,
      );
    }
  });

  // Break caught: an originating principal that is somebody else, which would put another person's name on the act.
  it('refuses an envelope that names another principal as its origin', async () => {
    expect(
      await asApi(
        staffKeyed([HUB_A]),
        insertEnvelope(envelope({ aggregateId: adHocInA, principalId: randomUUID() })),
      ),
    ).toBe('42501');
    expect(
      await asApi(
        staffKeyed([HUB_A]),
        insertEnvelope(envelope({ aggregateId: adHocInA, principalType: 'VENDOR' })),
      ),
    ).toBe('42501');
    const vendorsAct = envelope({
      aggregateId: vendorRequestInA,
      vendorOrganizationId: vendor1.organizationId,
      principalType: 'VENDOR',
    });
    expect(
      await asApi(
        vendorKeyed(vendor1.organizationId),
        insertEnvelope({ ...vendorsAct, principalId: randomUUID() }),
      ),
    ).toBe('42501');
    expect(
      await asApi(
        vendorKeyed(vendor1.organizationId),
        insertEnvelope({ ...vendorsAct, principalType: 'STAFF' }),
      ),
    ).toBe('42501');
  });

  // Break caught: a rider or a SYSTEM context with an arm they were never given, and a rider's id on the envelope of a pickup request.
  it('refuses a rider, a SYSTEM context and an envelope that names a rider for a request', async () => {
    const byRider = envelope({ aggregateId: adHocInA, principalType: 'RIDER', riderId: RIDER_1 });
    expect(await asApi(riderContext(RIDER_1), insertEnvelope(byRider))).toBe('23514');
    // A SYSTEM context under another capability reads no pickup request, so the guard refuses before the policy (which has no SYSTEM arm).
    expect(
      await asApi(
        systemContext('authentication'),
        insertEnvelope(envelope({ aggregateId: adHocInA })),
      ),
    ).toBe('23514');
    expect(
      await asApi(
        staffKeyed([HUB_A]),
        insertEnvelope(envelope({ aggregateId: adHocInA, riderId: RIDER_1 })),
      ),
    ).toBe('23514');
  });

  // Break caught: the same act raising the same event twice, so that a retry of the act would notify twice.
  it('keeps one envelope for one event of one act', async () => {
    const e = envelope({ aggregateId: adHocInA });
    expect(await asApi(staffKeyed([HUB_A]), insertEnvelope(e))).toBeUndefined();
    expect(await asApi(staffKeyed([HUB_A]), insertEnvelope({ ...e, id: randomUUID() }))).toBe(
      '23505',
    );
  });

  // Break caught: an envelope that rolls back with its act still reaching the lane, or one that survives a rolled-back act.
  it('rolls back with the act that wrote it', async () => {
    const e = envelope({ aggregateId: adHocInA });
    await expect(
      run(api, staffKeyed([HUB_A]), async (tx) => {
        await tx.execute(insertEnvelope(e));
        throw new Error('the act failed after the envelope was written');
      }),
    ).rejects.toThrow('the act failed');
    const found = await admin.query('select 1 from outbox where id = $1', [e.id]);
    expect(found.rowCount).toBe(0);
  });

  // Break caught: an envelope written in a state the relay owns (leased, relayed, counted, with an outcome).
  it.each([
    [
      'leased',
      'relay_state, attempt_count, lease_version, lease_owner, lease_expires_at',
      "'LEASED', 1, 1, 'x', clock_timestamp() + interval '1 minute'",
    ],
    ['relayed', 'relay_state, relayed_at', "'RELAYED', clock_timestamp()"],
    ['counted', 'attempt_count', '2'],
    ['versioned', 'lease_version', '1'],
    ['with an outcome', 'last_outcome', "'MATERIALISED'"],
  ])('writes an envelope untouched: it is refused %s', async (_what, columns, values) => {
    expect(
      await adminCode(
        `insert into outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, originating_principal_type, originating_principal_id, operation_id, correlation_id, ${columns})
         values (gen_random_uuid(), 'a.b', 'PICKUP_REQUEST', $1, $2, 'STAFF', $3, 'op', gen_random_uuid()::text, ${values})`,
        [adHocInA, HUB_A, PRINCIPAL_1],
      ),
    ).toBe('23514');
  });

  it.each([
    ['an event type that is not an event code', "'NotACode'", "'{}'::jsonb", "'PICKUP_REQUEST'"],
    ['a payload that is not an object', "'a.b'", "'[1]'::jsonb", "'PICKUP_REQUEST'"],
    [
      'a payload that is not small',
      "'a.b'",
      "jsonb_build_object('k', repeat('x', 3000))",
      "'PICKUP_REQUEST'",
    ],
    ['an aggregate type outside the list', "'a.b'", "'{}'::jsonb", "'ORDER'"],
  ])('refuses %s', async (_what, eventType, payload, aggregateType) => {
    expect(
      await adminCode(
        `insert into outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, originating_principal_type, originating_principal_id, operation_id, correlation_id, payload)
         values (gen_random_uuid(), ${eventType}, ${aggregateType}, $1, $2, 'STAFF', $3, 'op', gen_random_uuid()::text, ${payload})`,
        [adHocInA, HUB_A, PRINCIPAL_1],
      ),
    ).toBe('23514');
  });
});

describe('what the notification lane reads and changes of an envelope', () => {
  // Break caught: a policy or a grant that opens the outbox to the API, a person or another capability.
  it('is the only reader of the outbox: the API’s login holds no SELECT, and no other capability reads a row', async () => {
    const e = await arrange({ aggregateId: adHocInA });
    expect(await rowsOf(work, LANE, sql`select id from outbox where id = ${e.id}`)).toHaveLength(1);
    expect(
      await rowsOf(work, systemContext('credential_delivery'), sql`select id from outbox`),
    ).toHaveLength(0);
    expect(await asApi(staffKeyed([HUB_A, HUB_B], 'ALL'), sql`select id from outbox`)).toBe(
      '42501',
    );
    expect(await asApi(vendorKeyed(vendor1.organizationId), sql`select id from outbox`)).toBe(
      '42501',
    );
    expect(await asApi(systemContext('authentication'), sql`select id from outbox`)).toBe('42501');
  });

  // Break caught: a grant on a column of the envelope, which would let the lane (or code that asserts the capability) rewrite what
  // happened, to whom, or under whose scope.
  it('changes the relay bookkeeping and no column of the envelope', async () => {
    const e = await arrange({ aggregateId: adHocInA });
    for (const column of [
      "payload = '{}'::jsonb",
      "event_type = 'x.y'",
      `responsible_hub_id = '${HUB_B}'`,
      'created_at = clock_timestamp()',
      `aggregate_id = '${randomUUID()}'`,
      "operation_id = 'z'",
    ]) {
      expect(
        await asWorker(LANE, sql.raw(`update outbox set ${column} where id = '${e.id}'`)),
        column,
      ).toBe('42501');
    }
    expect(
      await asWorker(
        LANE,
        sql.raw(
          `update outbox set relay_state = 'LEASED', attempt_count = 1, lease_version = 1, lease_owner = 'lane-1', lease_expires_at = clock_timestamp() + interval '5 minutes' where id = '${e.id}'`,
        ),
      ),
    ).toBeUndefined();
    const found = await admin.query('select relay_state, lease_version from outbox where id = $1', [
      e.id,
    ]);
    expect(found.rows[0]).toEqual({ relay_state: 'LEASED', lease_version: 1 });
  });

  // Break caught: the guard that keeps the envelope immutable being only a privilege: the administrator, who holds every privilege, is
  // refused by the trigger too.
  it.each([
    ['identity', 'id = gen_random_uuid()'],
    ['payload', `payload = '{"changed":true}'::jsonb`],
    ['event type', "event_type = 'x.y'"],
    ['aggregate', `aggregate_id = '${randomUUID()}'`],
    ['hub', `responsible_hub_id = '${HUB_B}'`],
    ['vendor', `vendor_organization_id = '${randomUUID()}'`],
    ['originating principal', `originating_principal_id = '${randomUUID()}'`],
    ['correlation', "correlation_id = 'other'"],
    ['creation time', "created_at = created_at + interval '1 second'"],
  ])('refuses any change to the envelope’s %s, whoever writes', async (_what, assignment) => {
    const e = await arrange({ aggregateId: adHocInA });
    expect(await adminCode(`update outbox set ${assignment} where id = $1`, [e.id])).toBe('23514');
    // And not smuggled in beside a change of state the relay may make: the lease ends in an outcome, and the envelope changes with it.
    // (On a waiting envelope any update is refused for want of a state change, so only here is the rule of the envelope the one that holds.)
    const held = await leased({ aggregateId: adHocInA });
    const sneaky = `update outbox set relay_state = 'RELAYED', relayed_at = clock_timestamp(), last_outcome = 'MATERIALISED', ${assignment} where id = $1`;
    expect(await adminCode(sneaky, [held.id])).toBe('23514');
    expect(await adminMessage(sneaky, [held.id])).toMatch(/envelope never changes/);
  });

  describe('the relay’s state machine', () => {
    // Break caught: a claim of an envelope that is not due, or that another lane still holds.
    it('claims what is due, once, and counts the claim', async () => {
      const e = await arrange({ aggregateId: adHocInA });
      expect(await adminCode(CLAIM(), [e.id])).toBeUndefined();
      await admin.query(CLAIM(), [e.id]);
      expect(await adminCode(CLAIM(), [e.id])).toBe('23514');
      const waiting = await arrange({ aggregateId: adHocInA }, 30);
      expect(await adminCode(CLAIM(), [waiting.id])).toBe('23514');
    });

    it.each([
      [
        'miscounted',
        "attempt_count = attempt_count + 2, lease_version = lease_version + 1, lease_expires_at = clock_timestamp() + interval '5 minutes'",
      ],
      [
        'unversioned',
        "attempt_count = attempt_count + 1, lease_expires_at = clock_timestamp() + interval '5 minutes'",
      ],
      [
        'without an end in the future',
        "attempt_count = attempt_count + 1, lease_version = lease_version + 1, lease_expires_at = clock_timestamp() - interval '1 minute'",
      ],
      [
        'for more than an hour',
        "attempt_count = attempt_count + 1, lease_version = lease_version + 1, lease_expires_at = clock_timestamp() + interval '2 hours'",
      ],
    ])('refuses a claim that is %s', async (_what, assignment) => {
      const e = await arrange({ aggregateId: adHocInA });
      expect(
        await adminCode(
          `update outbox set relay_state = 'LEASED', lease_owner = 'lane-1', ${assignment} where id = $1`,
          [e.id],
        ),
      ).toBe('23514');
    });

    // Break caught: a lane that cannot take over the envelope of one that died holding it, and a takeover of a lease that is alive.
    it('lets a lane take over a lease that has ended, and no other', async () => {
      const e = await arrange({ aggregateId: adHocInA });
      await admin.query(CLAIM('seconds', 1), [e.id]);
      expect(await adminCode(CLAIM(), [e.id])).toBe('23514');
      await sleep(1300);
      expect(await adminCode(CLAIM(), [e.id])).toBeUndefined();
    });

    it('ends in relayed or dead, leaving the lease as it was, and then never changes', async () => {
      const done = await leased({ aggregateId: adHocInA });
      expect(
        await adminCode(
          "update outbox set relay_state = 'RELAYED', relayed_at = clock_timestamp(), last_outcome = 'MATERIALISED' where id = $1",
          [done.id],
        ),
      ).toBeUndefined();
      await admin.query(
        "update outbox set relay_state = 'RELAYED', relayed_at = clock_timestamp(), last_outcome = 'MATERIALISED' where id = $1",
        [done.id],
      );
      expect(
        await adminCode("update outbox set last_outcome = 'NOTHING_TO_SEND' where id = $1", [
          done.id,
        ]),
      ).toBe('23514');
      const dead = await leased({ aggregateId: adHocInA });
      expect(
        await adminCode(
          "update outbox set relay_state = 'DEAD', last_outcome = 'SCOPE_MISMATCH' where id = $1",
          [dead.id],
        ),
      ).toBeUndefined();
      const tampered = await leased({ aggregateId: adHocInA });
      expect(
        await adminCode(
          "update outbox set relay_state = 'RELAYED', relayed_at = clock_timestamp(), lease_version = 9 where id = $1",
          [tampered.id],
        ),
      ).toBe('23514');
      expect(
        await adminCode(
          "update outbox set relay_state = 'RELAYED', relayed_at = clock_timestamp(), attempt_count = 9 where id = $1",
          [tampered.id],
        ),
      ).toBe('23514');
    });

    // Break caught: an envelope that has been relayed or dead-lettered being claimed again, which would send its messages again. The claim
    // clears the time it was relayed, so that no other rule of the table is what refuses it.
    it.each([
      [
        'relayed',
        "relay_state = 'RELAYED', relayed_at = clock_timestamp(), last_outcome = 'MATERIALISED'",
      ],
      ['dead-lettered', "relay_state = 'DEAD', last_outcome = 'SCOPE_MISMATCH'"],
    ])('does not let an envelope that is %s be claimed again', async (_what, ending) => {
      const e = await leased({ aggregateId: adHocInA });
      await admin.query(`update outbox set ${ending} where id = $1`, [e.id]);
      const again = `update outbox set relay_state = 'LEASED', relayed_at = null, attempt_count = attempt_count + 1, lease_version = lease_version + 1, lease_owner = 'lane-2', lease_expires_at = clock_timestamp() + interval '5 minutes' where id = $1`;
      expect(await adminCode(again, [e.id])).toBe('23514');
      expect(await adminMessage(again, [e.id])).toMatch(/relayed or dead-lettered does not change/);
    });

    // Break caught: a retry that is due before the claim was, and a skip from waiting to relayed with no lease.
    it('retries later, never earlier, and is relayed only from a lease', async () => {
      const e = await leased({ aggregateId: adHocInA });
      expect(
        await adminCode(
          "update outbox set relay_state = 'PENDING', lease_expires_at = null, last_outcome = 'RETRY', next_attempt_at = clock_timestamp() + interval '1 minute' where id = $1",
          [e.id],
        ),
      ).toBeUndefined();
      expect(
        await adminCode(
          "update outbox set relay_state = 'PENDING', lease_expires_at = null, next_attempt_at = clock_timestamp() - interval '1 hour' where id = $1",
          [e.id],
        ),
      ).toBe('23514');
      const idle = await arrange({ aggregateId: adHocInA });
      expect(
        await adminCode(
          "update outbox set relay_state = 'RELAYED', relayed_at = clock_timestamp() where id = $1",
          [idle.id],
        ),
      ).toBe('23514');
    });
  });
});

describe('what the lane reads of the business tables', () => {
  // Break caught: a policy keyed on the hub or on the capability alone, which would let the lane read every request of a hub.
  it('reads the one request its envelope names, and no other', async () => {
    const e = await leased({ aggregateId: adHocInA });
    const ids = async (context: SecurityContext) =>
      (
        await rowsOf<{ id: string }>(work, context, sql`select id from pickup_request order by id`)
      ).map((row) => row.id);
    expect(await ids(laneFor(e))).toEqual([adHocInA]);
    const other = await leased({ aggregateId: otherAdHocInA });
    expect(await ids(laneFor(other))).toEqual([otherAdHocInA]);
    expect(await ids(LANE)).toEqual([]);
    expect(await ids(laneFor({ ...e, hubId: HUB_B }))).toEqual([]);
    expect(await ids(systemContext('credential_delivery'))).toEqual([]);
  });

  // Break caught: a column grant wider than the message needs, which would put the phone of the pickup contact, the address or the price
  // in reach of a lane that only announces a confirmation.
  it('reads the columns a message is made from and no others', async () => {
    const e = await leased({ aggregateId: adHocInA });
    const columns =
      'id, code, state, responsible_hub_id, vendor_organization_id, ad_hoc_sender_id, scheduled_service_date, attempt_number';
    expect(
      await rowsOf(work, laneFor(e), sql.raw(`select ${columns} from pickup_request`)),
    ).toHaveLength(1);
    for (const column of [
      'primary_phone',
      'resolved_pickup_location',
      'estimate_snapshot',
      'sender_name',
      'created_by',
    ]) {
      expect(
        await asWorker(laneFor(e), sql.raw(`select ${column} from pickup_request`)),
        column,
      ).toBe('42501');
    }
  });

  // Break caught: the sender policy keyed on the capability alone, which would let the lane read every ad-hoc sender's number.
  it('reads the one sender of that request: its name and number', async () => {
    const e = await leased({ aggregateId: adHocInA });
    const rows = await rowsOf<{ id: string; phone: string }>(
      work,
      laneFor(e),
      sql`select id, phone from ad_hoc_sender`,
    );
    expect(rows).toEqual([{ id: sender.id, phone: sender.phone }]);
    expect(await rowsOf(work, LANE, sql`select id from ad_hoc_sender`)).toEqual([]);
    const forVendor = await leased({
      aggregateId: vendorRequestInA,
      vendorOrganizationId: vendor1.organizationId,
    });
    expect(await rowsOf(work, laneFor(forVendor), sql`select id from ad_hoc_sender`)).toEqual([]);
    expect(await asWorker(laneFor(e), sql`select phone_as_entered from ad_hoc_sender`)).toBe(
      '42501',
    );
  });

  // Break caught: a write grant on the business tables, which would let a lane change the thing it announces.
  it('writes nothing of the business tables', async () => {
    const e = await leased({ aggregateId: adHocInA });
    expect(
      await asWorker(
        laneFor(e),
        sql`update pickup_request set state = 'CANCELLED' where id = ${adHocInA}`,
      ),
    ).toBe('42501');
    expect(
      await asWorker(laneFor(e), sql`update ad_hoc_sender set name = 'x' where id = ${sender.id}`),
    ).toBe('42501');
    expect(await asWorker(laneFor(e), sql`delete from pickup_request where id = ${adHocInA}`)).toBe(
      '42501',
    );
  });

  // Break caught: the new policies widening what a person sees of the tables they sit on.
  it('leaves what a staff member and a vendor read of the pickup tables as it was', async () => {
    const seen = async (context: SecurityContext) =>
      (
        await rowsOf<{ id: string }>(api, context, sql`select id from pickup_request order by id`)
      ).map((row) => row.id);
    expect((await seen(staffKeyed([HUB_B]))).toSorted()).toEqual([vendorRequestInB]);
    expect(await seen(vendorKeyed(vendor1.organizationId))).toEqual([vendorRequestInA]);
    expect(await rowsOf(api, staffKeyed([HUB_A]), sql`select id from ad_hoc_sender`)).toBeDefined();
  });
});

describe('the notification', () => {
  // Break caught: the lane that cannot write what it exists to write.
  it('is written by the lane under an envelope leased to it, queued, held back or in the feed', async () => {
    const e = await leased({ aggregateId: adHocInA });
    const lane = laneFor(e);
    expect(await asWorker(lane, notificationInsert(e))).toBeUndefined();
    expect(
      await asWorker(lane, notificationInsert(e, { state: 'SUPPRESSED', reason: 'KILL_SWITCH' })),
    ).toBeUndefined();
    expect(
      await asWorker(
        lane,
        notificationInsert(e, { state: 'DELIVERED', channel: 'FEED', audience: 'OPS_FEED' }),
      ),
    ).toBeUndefined();
  });

  // Break caught: a notification written under an envelope the lane does not hold, or a label the lane asserted taken for the authority.
  it('is refused without a lease on the envelope it names, and with the scope of no other envelope', async () => {
    const waiting = await arrange({ aggregateId: adHocInA });
    expect(await asWorker(laneFor(waiting), notificationInsert(waiting))).toBe('23514');
    const e = await leased({ aggregateId: adHocInA });
    const elsewhere = await leased({ aggregateId: otherAdHocInA });
    expect(await asWorker(laneFor(elsewhere), notificationInsert(e))).toBe('42501');
    expect(await asWorker(LANE, notificationInsert(e))).toBe('42501');
    // The guard reads the stored envelope before the policy reads the context, so a hub the envelope does not have is the guard's.
    expect(await asWorker(laneFor(e), notificationInsert(e, { hubId: HUB_B }))).toBe('23514');
    const forged = laneFor({ ...e, hubId: HUB_B });
    expect(await asWorker(forged, notificationInsert({ ...e, hubId: HUB_B }))).toBe('23514');
    const ended = await leased({ aggregateId: adHocInA });
    await admin.query(
      "update outbox set relay_state = 'RELAYED', relayed_at = clock_timestamp(), last_outcome = 'NOTHING_TO_SEND' where id = $1",
      [ended.id],
    );
    expect(await asWorker(laneFor(ended), notificationInsert(ended))).toBe('23514');
  });

  // Break caught: a lane holding the envelope of one event writing its notification under the envelope of another event of the same
  // request, which has the same hub and the same aggregate and so passes every other test. The context names the envelope.
  it('is refused under another envelope of the same aggregate than the one the context names', async () => {
    const a = await leased({ aggregateId: adHocInA, eventType: 'pickup.request.confirmed' });
    const b = await leased({ aggregateId: adHocInA, eventType: 'pickup.request.declined' });
    expect(await asWorker(laneFor(a), notificationInsert(b))).toBe('42501');
    expect(await asWorker(laneFor(b), notificationInsert(a))).toBe('42501');
    expect(await asWorker(laneFor(b), notificationInsert(b))).toBeUndefined();
  });

  // Break caught: a message written already sent, leased or delivered, which would count a send that never happened.
  it.each([
    ['sent', { state: 'SENT' }, '42501'],
    ['leased', { state: 'LEASED' }, '42501'],
    ['retryable', { state: 'RETRYABLE' }, '42501'],
    ['failed', { state: 'FAILED' }, '42501'],
    ['expired', { state: 'EXPIRED' }, '42501'],
    ['a delivered text', { state: 'DELIVERED' }, '23514'],
    ['a queued feed entry', { channel: 'FEED', audience: 'OPS_FEED' }, '23514'],
    ['held back without a reason', { state: 'SUPPRESSED' }, '23514'],
    ['queued with a reason', { reason: 'KILL_SWITCH' }, '23514'],
    [
      'held back for a reason outside the list',
      { state: 'SUPPRESSED', reason: 'BECAUSE' },
      '23514',
    ],
  ] as const)('refuses a notification written %s', async (_what, message, code) => {
    const e = await leased({ aggregateId: adHocInA });
    expect(await asWorker(laneFor(e), notificationInsert(e, message))).toBe(code);
  });

  // Break caught: a relay that runs twice writing the same message twice.
  it('keeps one message of the list to one audience for one event', async () => {
    const e = await leased({ aggregateId: adHocInA });
    expect(
      await asWorker(laneFor(e), notificationInsert(e, { kind: 'PICKUP_CONFIRMED' })),
    ).toBeUndefined();
    expect(await asWorker(laneFor(e), notificationInsert(e, { kind: 'PICKUP_CONFIRMED' }))).toBe(
      '23505',
    );
    expect(
      await asWorker(
        laneFor(e),
        notificationInsert(e, { kind: 'PICKUP_CONFIRMED', audience: 'VENDOR_NUMBER' }),
      ),
    ).toBeUndefined();
  });

  // Break caught: a read that shows a hub another hub's messages, or a vendor or a rider any, or that opens to a staff operation that
  // holds another key (the scope of a pickup grant is not a right to read the Ops log: the registry gives it to `notification.read`).
  it('is read by staff in their hubs under notification.read and by nobody else but the lane', async () => {
    const e = await leased({ aggregateId: adHocInA });
    const id = await arrangeNotification(e);
    const read = (service: Built, context: SecurityContext) =>
      rowsOf<{ id: string }>(service, context, sql`select id from notification where id = ${id}`);
    const reading = (hubs: readonly string[], mode: 'SET' | 'ALL' = 'SET'): SecurityContext => ({
      ...staffContext(hubs, mode),
      authorizationKey: 'notification.read',
    });
    expect(await read(api, reading([HUB_A]))).toHaveLength(1);
    expect(await read(api, reading([HUB_B]))).toHaveLength(0);
    expect(await read(api, reading([], 'ALL'))).toHaveLength(1);
    expect(await read(api, staffKeyed([HUB_A]))).toHaveLength(0);
    expect(await read(api, staffKeyed([], 'ALL'))).toHaveLength(0);
    expect(await read(api, { ...reading([HUB_A]), authorizationKey: 'pickup.read' })).toHaveLength(
      0,
    );
    expect(await read(api, staffContext([HUB_A]))).toHaveLength(0);
    expect(await read(api, vendorKeyed(vendor1.organizationId))).toHaveLength(0);
    expect(await read(api, riderContext(RIDER_1))).toHaveLength(0);
    expect(await read(work, LANE)).toHaveLength(1);
    expect(await read(work, systemContext('credential_delivery'))).toHaveLength(0);
  });

  // Break caught: a grant of the whole row to the API, which would put the count digest, the provider's reference and the lease where
  // the Ops log reads.
  it('shows the API the columns of the Ops log and not the digest, the provider’s reference or the lease', async () => {
    const shown =
      'id, outbox_id, message_kind, template_version, audience, channel, responsible_hub_id, subject_id, state, suppression_reason, outcome_class, destination_hint, attempt_count, expires_at, sent_at, delivered_at, created_at';
    expect(
      await asApi(staffKeyed([HUB_A]), sql.raw(`select ${shown} from notification`)),
    ).toBeUndefined();
    for (const column of [
      'destination_digest',
      'provider_message_ref',
      'lease_owner',
      'next_attempt_at',
      'receipt_checks',
    ]) {
      expect(
        await asApi(staffKeyed([HUB_A]), sql.raw(`select ${column} from notification`)),
        column,
      ).toBe('42501');
    }
    expect(await asApi(staffKeyed([HUB_A]), sql`update notification set state = 'FAILED'`)).toBe(
      '42501',
    );
    expect(
      await asApi(staffKeyed([HUB_A]), notificationInsert(envelope({ aggregateId: adHocInA }))),
    ).toBe('42501');
  });

  describe('the state machine', () => {
    it('is claimed when due, sent, and then delivered, and never changes again', async () => {
      const e = await leased({ aggregateId: adHocInA });
      const id = await arrangeNotification(e);
      expect(await adminCode(CLAIM_MESSAGE, [id])).toBeUndefined();
      await admin.query(CLAIM_MESSAGE, [id]);
      expect(await adminCode(SEND, [id])).toBeUndefined();
      await admin.query(SEND, [id]);
      expect(
        await adminCode(
          "update notification set state = 'DELIVERED', delivered_at = clock_timestamp() where id = $1",
          [id],
        ),
      ).toBeUndefined();
      await admin.query(
        "update notification set state = 'DELIVERED', delivered_at = clock_timestamp() where id = $1",
        [id],
      );
      expect(
        await adminCode("update notification set provider_message_ref = 'other' where id = $1", [
          id,
        ]),
      ).toBe('23514');
      expect(
        await adminMessage("update notification set provider_message_ref = 'other' where id = $1", [
          id,
        ]),
      ).toMatch(/that has ended does not change/);
    });

    // Break caught: a send recorded without the moment it left, or with a moment that moves; the daily limits count on that moment.
    it('records the moment a message left once, and only with the state that says it left', async () => {
      const e = await leased({ aggregateId: adHocInA });
      const id = await arrangeNotification(e);
      await admin.query(CLAIM_MESSAGE, [id]);
      expect(
        await adminCode(
          "update notification set state = 'SENT', outcome_class = 'ACCEPTED' where id = $1",
          [id],
        ),
      ).toBe('23514');
      await admin.query(SEND, [id]);
      expect(
        await adminCode(
          "update notification set sent_at = clock_timestamp() + interval '1 hour' where id = $1",
          [id],
        ),
      ).toBe('23514');
      expect(
        await adminCode("update notification set state = 'RETRYABLE' where id = $1", [id]),
      ).toBe('23514');
    });

    it('refuses a claim that is early, miscounted, or past the message’s end', async () => {
      const e = await leased({ aggregateId: adHocInA });
      const later = await arrangeNotification(e);
      await admin.query('alter table notification disable trigger notification_guard');
      await admin.query(
        "update notification set next_attempt_at = clock_timestamp() + interval '1 hour' where id = $1",
        [later],
      );
      await admin.query('alter table notification enable trigger notification_guard');
      expect(await adminCode(CLAIM_MESSAGE, [later])).toBe('23514');
      const now = await arrangeNotification(e);
      expect(
        await adminCode(CLAIM_MESSAGE.replace('attempt_count + 1', 'attempt_count + 3'), [now]),
      ).toBe('23514');
      const short = await arrangeNotification(e, {}, '1 second');
      await sleep(1300);
      expect(await adminCode(CLAIM_MESSAGE, [short])).toBe('23514');
      expect(
        await adminCode(
          "update notification set state = 'EXPIRED', outcome_class = 'EXPIRED' where id = $1",
          [short],
        ),
      ).toBeUndefined();
      expect(
        await adminCode(
          "update notification set state = 'EXPIRED', outcome_class = 'EXPIRED' where id = $1",
          [now],
        ),
      ).toBe('23514');
    });

    // Break caught: the network's no recorded as the outcome of a send, and a receipt that rewrites the count of attempts.
    it('keeps a send’s outcomes and the network’s receipts apart', async () => {
      const e = await leased({ aggregateId: adHocInA });
      const refused = await arrangeNotification(e);
      await admin.query(CLAIM_MESSAGE, [refused]);
      expect(
        await adminCode(
          "update notification set state = 'FAILED', outcome_class = 'REJECTED', provider_outcome_class = 'REQUEST_INVALID' where id = $1",
          [refused],
        ),
      ).toBeUndefined();
      expect(
        await adminCode(
          "update notification set state = 'FAILED', outcome_class = 'DELIVERY_FAILED' where id = $1",
          [refused],
        ),
      ).toBe('23514');
      expect(
        await adminMessage(
          "update notification set state = 'FAILED', outcome_class = 'DELIVERY_FAILED' where id = $1",
          [refused],
        ),
      ).toMatch(/receipt, not the outcome of a send/);
      expect(
        await adminCode(
          "update notification set state = 'RETRYABLE', outcome_class = 'UNKNOWN', next_attempt_at = clock_timestamp() + interval '30 seconds' where id = $1",
          [refused],
        ),
      ).toBeUndefined();
      const sent = await arrangeNotification(e);
      await admin.query(CLAIM_MESSAGE, [sent]);
      await admin.query(SEND, [sent]);
      expect(
        await adminCode(
          "update notification set state = 'FAILED', outcome_class = 'REJECTED' where id = $1",
          [sent],
        ),
      ).toBe('23514');
      expect(
        await adminCode(
          "update notification set state = 'FAILED', outcome_class = 'DELIVERY_FAILED' where id = $1",
          [sent],
        ),
      ).toBeUndefined();
      expect(
        await adminCode('update notification set attempt_count = 5 where id = $1', [sent]),
      ).toBe('23514');
      expect(
        await adminCode(
          "update notification set receipt_checks = receipt_checks + 1, next_receipt_check_at = clock_timestamp() + interval '2 minutes' where id = $1",
          [sent],
        ),
      ).toBeUndefined();
    });

    // Break caught (S1.12e): a holder under its lease rewriting more than the hint and the digest of the destination, which the fenced
    // writers of the outcome would then find already done.
    it.each([
      ['an outcome', "outcome_class = 'ACCEPTED'"],
      ['the provider’s class', "provider_outcome_class = 'REQUEST_INVALID'"],
      ['the provider’s reference', "provider_message_ref = 'ref-1'"],
      ['the schedule', "next_attempt_at = clock_timestamp() + interval '1 hour'"],
      ['the count of looks', 'receipt_checks = 3'],
      ['the next look', "next_receipt_check_at = clock_timestamp() + interval '1 hour'"],
      ['the holder', "lease_owner = 'someone-else'"],
      ['the end of the lease', "lease_expires_at = clock_timestamp() + interval '40 minutes'"],
      ['the count of attempts', 'attempt_count = 4'],
    ])('keeps %s as it was while the message is under a lease', async (_what, assignment) => {
      const e = await leased({ aggregateId: adHocInA });
      const id = await arrangeNotification(e);
      await admin.query(CLAIM_MESSAGE, [id]);
      expect(await adminCode(`update notification set ${assignment} where id = $1`, [id])).toBe(
        '23514',
      );
    });

    it('lets the holder keep the hint and the digest of the destination under its lease', async () => {
      const e = await leased({ aggregateId: adHocInA });
      const id = await arrangeNotification(e);
      await admin.query(CLAIM_MESSAGE, [id]);
      expect(
        await adminCode(
          `update notification set destination_hint = '+233****111', destination_digest = repeat('a', 64) where id = $1`,
          [id],
        ),
      ).toBeUndefined();
    });

    // Break caught (review I-1): the place a message reserved in the day's limits rewritten, unreserved, or reserved without the number it
    // is reserved for, any of which would make the count that reads it lie.
    it('lets the holder reserve a place once, beside the digest it is reserved for, and no one move it', async () => {
      const e = await leased({ aggregateId: adHocInA });
      const id = await arrangeNotification(e);
      await admin.query(CLAIM_MESSAGE, [id]);
      const reserve =
        "update notification set destination_hint = '+233******111', destination_digest = repeat('a', 64), reserved_at = coalesce(reserved_at, clock_timestamp()) where id = $1";
      expect(await adminCode(reserve, [id])).toBeUndefined();
      await admin.query(reserve, [id]);
      // The same statement again changes nothing, and is allowed; a different moment, or none, is refused.
      expect(await adminCode(reserve, [id])).toBeUndefined();
      for (const assignment of [
        "reserved_at = clock_timestamp() + interval '1 second'",
        "reserved_at = clock_timestamp() - interval '1 day'",
        'reserved_at = null',
      ]) {
        expect(
          await adminCode(`update notification set ${assignment} where id = $1`, [id]),
          assignment,
        ).toBe('23514');
      }
      expect(
        await adminMessage('update notification set reserved_at = null where id = $1', [id]),
      ).toMatch(/was reserved is written once/);
    });

    it('refuses a place reserved for no number', async () => {
      const e = await leased({ aggregateId: adHocInA });
      const id = await arrangeNotification(e);
      await admin.query(CLAIM_MESSAGE, [id]);
      expect(
        await adminCode('update notification set reserved_at = clock_timestamp() where id = $1', [
          id,
        ]),
      ).toBe('23514');
    });

    // Break caught: a place reserved by a claim, an outcome or a receipt: only the holder's bookkeeping under its own lease reserves one.
    it.each([
      [
        'a claim',
        CLAIM_MESSAGE.replace(
          ' where id = $1',
          ", destination_digest = repeat('a', 64), reserved_at = clock_timestamp() where id = $1",
        ),
        false,
      ],
      ['an outcome', SEND.replace(' where id = $1', ', reserved_at = null where id = $1'), true],
    ])('refuses a place reserved or released by %s', async (_what, statement, afterReserving) => {
      const e = await leased({ aggregateId: adHocInA });
      const id = await arrangeNotification(e);
      if (afterReserving) {
        await admin.query(CLAIM_MESSAGE, [id]);
        await admin.query(
          "update notification set destination_digest = repeat('a', 64), reserved_at = clock_timestamp() where id = $1",
          [id],
        );
      }
      expect(await adminCode(statement, [id])).toBe('23514');
      expect(await adminMessage(statement, [id])).toMatch(
        /reserved by the holder of the lease and by no other change/,
      );
    });

    it('is written with no place reserved', async () => {
      const e = await leased({ aggregateId: adHocInA });
      const base = notificationInsert(e);
      expect(await asWorker(laneFor(e), base)).toBeUndefined();
      expect(
        await asWorker(
          laneFor(e),
          sql`insert into notification (id, outbox_id, message_kind, template_version, audience, channel, responsible_hub_id,
                                        vendor_organization_id, subject_type, subject_id, state, expires_at, destination_digest, reserved_at)
              values (${randomUUID()}, ${e.id}, ${nextKind()}, 1, 'AD_HOC_SENDER', 'SMS', ${e.hubId}, ${e.vendorOrganizationId},
                      'PICKUP_REQUEST', ${e.aggregateId}, 'QUEUED', clock_timestamp() + interval '6 hours', repeat('a', 64), clock_timestamp())`,
        ),
      ).toBe('23514');
    });

    it('is held back before it is claimed, with its reason', async () => {
      const e = await leased({ aggregateId: adHocInA });
      const id = await arrangeNotification(e);
      expect(
        await adminCode(
          "update notification set state = 'SUPPRESSED', suppression_reason = 'DAY_LIMIT' where id = $1",
          [id],
        ),
      ).toBeUndefined();
      expect(
        await adminCode("update notification set state = 'SUPPRESSED' where id = $1", [id]),
      ).toBe('23514');
      expect(
        await adminCode(
          "update notification set state = 'DELIVERED', delivered_at = clock_timestamp() where id = $1",
          [id],
        ),
      ).toBe('23514');
    });

    // Break caught: a message that changes who it is for, what it says or whose scope it is in after it was written.
    it.each([
      ['envelope', `outbox_id = '${randomUUID()}'`],
      ['message', "message_kind = 'OTHER_KIND'"],
      ['wording', 'template_version = 2'],
      ['audience', "audience = 'RIDER'"],
      ['channel', "channel = 'FEED'"],
      ['hub', `responsible_hub_id = '${HUB_B}'`],
      ['subject', `subject_id = '${randomUUID()}'`],
      ['end', "expires_at = expires_at + interval '1 day'"],
      ['creation time', "created_at = created_at + interval '1 second'"],
    ])('refuses any change to the notification’s %s', async (_what, assignment) => {
      const e = await leased({ aggregateId: adHocInA });
      const id = await arrangeNotification(e);
      expect(await adminCode(`update notification set ${assignment} where id = $1`, [id])).toBe(
        '23514',
      );
    });

    it('has no way to be deleted or emptied by the lane or the API', async () => {
      const privilege = async (role: string, table: string, what: string) =>
        (
          await admin.query<{ held: boolean }>('select has_table_privilege($1, $2, $3) as held', [
            role,
            table,
            what,
          ])
        ).rows[0]?.held;
      for (const table of ['outbox', 'notification']) {
        for (const what of ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          expect(await privilege(WORKER_RUNTIME_ROLE, table, what), `${table} ${what} worker`).toBe(
            false,
          );
          expect(await privilege('melarc_api_runtime', table, what), `${table} ${what} api`).toBe(
            false,
          );
        }
      }
      expect(await privilege('melarc_api_runtime', 'notification', 'UPDATE')).toBe(false);
      expect(await privilege('melarc_api_runtime', 'outbox', 'SELECT')).toBe(false);
      expect(await privilege(WORKER_RUNTIME_ROLE, 'outbox', 'INSERT')).toBe(false);
    });
  });
});
