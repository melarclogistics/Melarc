import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { transactionOf } from '../../src/platform/database/transaction-handle.js';
import { PostgresAuditWriter } from '../../src/platform/audit/postgres.audit-writer.adapter.js';
import { AuditRefusedError } from '../../src/platform/audit/audit-record.js';
import { commitThenRefuse } from '../../src/platform/audit/commit-then-refuse.js';
import { BoundedMetrics } from '../../src/platform/metrics/bounded.metrics.adapter.js';
import { diffRuleFor, tierOf } from '../../src/platform/audit/audit-classification.js';
import type { AuditEventCode } from '../../src/platform/audit/audit-event-codes.js';
import {
  AUDIT_OBJECT_TYPES,
  AUDIT_SERIALISATION_VERSION,
} from '../../src/platform/audit/audit-vocabulary.js';
import {
  canonicalAuditEvent,
  type StoredAuditEvent,
} from '../../src/platform/audit/canonical-audit-event.js';
import type { AuditEventInput } from '../../src/platform/auth/ports/audit-writer.port.js';
import { AUDIT_OUTCOMES } from '../../src/platform/auth/ports/audit-writer.port.js';
import {
  TransactionRolledBackError,
  serverErrorIn,
} from '../../src/platform/database/database-failures.js';
import {
  PROVISIONING_ROLE,
  WORKER_RUNTIME_ROLE,
} from '../../src/platform/database/technical-roles.js';
import { ManualClock } from '../../src/test-support/manual-clock.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { openAdmin, type Admin } from './support/admin.js';
import { observe, type Observer } from './support/observe.js';
import { unitOfWorkOver, withHandle } from './support/handle.js';
import {
  HUB_A,
  HUB_B,
  PRINCIPAL_1,
  VENDOR_1,
  applyContextFixture,
  applyFixture,
  riderContext,
  staffContext,
  systemContext,
  vendorContext,
} from './support/rls-fixture.js';
import { buildService, type BuiltService } from './support/service.js';
import {
  createTestDatabase,
  sqlState,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/**
 * S0.11 against a real PostgreSQL: the audit ledger and its writer, as `melarc_api_runtime` (the login the API connects as) and,
 * to look and to try to change history, as the other logins and the administrator. Security test matrix Family T (`GBT-T1`,
 * `GBT-T10`) and Family U (the sentinel); audit.md sections 2 to 3 and 5.4; SECURITY_DESIGN.md §14.1b (the audit actor).
 *
 * The signed checkpoint chain (`GBT-T3` to `T9`) is release gate G1 and is not here: those rows are open, neither passed nor dropped.
 */

const clock = new ManualClock(new Date('2026-10-10T08:00:00.000Z'));
const writer = new PostgresAuditWriter(clock);
const STAFF_ID = PRINCIPAL_1;
const OBJECT = '33333333-3333-4333-8333-333333333333';
/** The technical identifier of a SYSTEM principal: not the id of any person. */
const TECHNICAL_ID = '77777777-7777-4777-8777-777777777777';

let database: TestDatabase;
let built: BuiltService;
let admin: Admin;
let observer: Observer;

beforeAll(async () => {
  database = await createTestDatabase();
  await applyFixture(database);
  await applyContextFixture(database);
  built = buildService(database);
  admin = await openAdmin(database);
  observer = await observe(database);
});

afterAll(async () => {
  await admin.close();
  await observer.close();
  await built.close();
  await database.drop();
});

const EVENT: AuditEventInput = {
  code: 'auth.session.failed',
  enhanced: false,
  outcome: 'REJECTED',
  object: { type: 'StaffIdentity', id: OBJECT },
  detail: { cause: 'WRONG_PASSWORD', factor: 'PASSWORD' },
};

const EPISODE = '55555555-5555-4555-8555-555555555555';
const REVOKED_FACTOR = '66666666-6666-4666-8666-666666666666';
const NEW_GRANT = '88888888-8888-4888-8888-888888888888';
/** A complete `auth.mfa.reset` of a live factor (audit.md section 5.4, "Facts of `auth.mfa.reset`"). */
const MFA_RESET: AuditEventInput = {
  code: 'auth.mfa.reset',
  enhanced: true,
  outcome: 'SUCCEEDED',
  object: { type: 'StaffIdentity', id: OBJECT },
  reason: { code: 'MFA_AUTHENTICATOR_UNAVAILABLE', label: 'The authenticator is unavailable' },
  previousState: 'ACTIVE_FACTOR',
  resultingState: 'ISSUED',
  relatedIds: {
    episode_id: EPISODE,
    revoked_factor_id: REVOKED_FACTOR,
    new_grant_id: NEW_GRANT,
    superseded_grant_ids: [],
  },
  beforeAfter: {
    mfa_factor: { before: 'ACTIVE', after: 'REVOKED' },
    reenrolment_grant: { before: 'NONE', after: 'PENDING' },
  },
};

/**
 * The facts the catalogue requires of an event a test writes only to see something else (G2-06): the writer holds every event to
 * its tier and, for the identity events whose requirements are settled, to its facts. A test says what it is about, and this gives
 * its event the rest, so that no test passes by luck of what it left out.
 */
const CATALOGUE_FACTS: Readonly<Record<string, Partial<AuditEventInput>>> = {
  'auth.recovery.requested': {
    enhancedBasis: 'SELF_SERVICE',
    object: { type: 'RecoveryRequest', id: OBJECT },
    resultingState: 'ISSUED',
    relatedIds: { initiated_by: OBJECT },
  },
  'auth.session.terminated': {
    enhancedBasis: 'ROUTINE_TERMINATION',
    reason: { code: 'SIGNED_OUT', label: 'Signed out' },
  },
  'staff.identity.approved': { relatedIds: { created_by: OBJECT, approved_by: STAFF_ID } },
};

const event = (overrides: Partial<AuditEventInput> = {}): AuditEventInput => {
  const merged: AuditEventInput = { ...EVENT, ...overrides };
  const tier = tierOf(merged.code as AuditEventCode);
  const enhanced =
    overrides.enhanced !== undefined && tier === 'CONDITIONAL'
      ? overrides.enhanced
      : tier === 'ENHANCED'
        ? true
        : tier === 'STANDARD'
          ? false
          : merged.enhanced;
  const facts = CATALOGUE_FACTS[merged.code] ?? {};
  const complete: AuditEventInput = { ...merged, ...facts, ...overrides, enhanced };
  // A change that took effect carries its before and after; an event that changed nothing carries none (audit.md section 6).
  return diffRuleFor(complete) === 'REQUIRED' &&
    complete.outcome === 'SUCCEEDED' &&
    complete.beforeAfter === undefined
    ? { ...complete, beforeAfter: { state: { from: 'BEFORE', to: 'AFTER' } } }
    : complete;
};

/** The SQLSTATE of the server's error inside what a piece of work rejected with, or `undefined` if it did not reject. */
async function stateOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.code;
  }
}

/** Writes `input` in a transaction under `context` and returns when it commits. */
const writeAs = (
  context: Parameters<typeof withHandle>[1],
  input: AuditEventInput,
): Promise<void> => withHandle(built.service, context, (handle) => writer.write(handle, input));

async function rowsFor(correlationOrCode: string): Promise<Record<string, unknown>[]> {
  return observer.rows('select * from audit_event where event_code = $1 order by recorded_at, id', [
    correlationOrCode,
  ]);
}

describe('writing an event', () => {
  // Break caught: an event stored with a field of the contract missing or from the wrong source.
  it('stores an event of a staff context with the actor, surface and correlation id of that context', async () => {
    const hub = HUB_A;
    await writeAs(
      staffContext([hub]),
      event({
        code: 'staff.identity.rejected',
        outcome: 'SUCCEEDED',
        responsibleHubId: hub,
        previousState: 'PENDING_APPROVAL',
        resultingState: 'ACTIVE',
        reason: { code: 'ONBOARDED', label: 'Onboarded' },
        beforeAfter: { status: { from: 'PENDING_APPROVAL', to: 'ACTIVE' } },
        relatedIds: { staff_identity_id: OBJECT },
        detail: { channel: 'EMAIL' },
        enhanced: true,
      }),
    );

    const [row] = await rowsFor('staff.identity.rejected');
    expect(row).toMatchObject({
      actor_type: 'STAFF',
      actor_id: STAFF_ID,
      surface_context: 'OPS_PORTAL',
      correlation_id: 'database-test',
      object_type: 'StaffIdentity',
      object_id: OBJECT,
      responsible_hub_id: hub,
      previous_state: 'PENDING_APPROVAL',
      resulting_state: 'ACTIVE',
      reason_code: 'ONBOARDED',
      reason_label: 'Onboarded',
      outcome: 'SUCCEEDED',
      enhanced: true,
      serialisation_version: AUDIT_SERIALISATION_VERSION,
      before_after: { status: { from: 'PENDING_APPROVAL', to: 'ACTIVE' } },
      related_ids: { staff_identity_id: OBJECT },
      detail: { channel: 'EMAIL' },
    });
  });

  // Break caught: the identifier not being time-ordered by the injected clock, or the recording time coming from the application.
  it('takes the identifier from the injected clock and the recording time from the database', async () => {
    clock.advance(60_000);
    const expectedMilliseconds = clock.now().getTime();
    await writeAs(
      staffContext([HUB_A]),
      event({ code: 'auth.mfa.completed', outcome: 'SUCCEEDED' }),
    );

    const [row] = await rowsFor('auth.mfa.completed');
    const id = String(row?.id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(expectedMilliseconds);
    expect((row?.occurred_at as Date).getTime()).toBe(expectedMilliseconds);
    // The database's own time: the manual clock is in the past of it, and the column default is what set it.
    const measured = await observer.one<{ gap: number }>(
      'select extract(epoch from (now() - recorded_at))::float as gap from audit_event where event_code = $1',
      ['auth.mfa.completed'],
    );
    const gap = measured?.gap ?? Number.NaN;
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(60);
    expect((row?.recorded_at as Date).getTime()).toBeGreaterThan(expectedMilliseconds + 1000);
  });

  // Break caught: recorded_at taken from the start of the transaction (`now()`), so that every event of a long act carries the same
  // instant and a row inserted late cannot be told from one inserted first (Product decision, 11 October 2026; audit.md section 3).
  // No sleep: the second insert follows the first by at least one statement round trip, and the database's clock reads microseconds.
  it('records the moment of each insert, not the start of the transaction', async () => {
    let started = '';
    await withHandle(built.service, staffContext([HUB_A]), async (handle, tx) => {
      const result = await tx.execute(sql`select transaction_timestamp()::text as started`);
      started = (result.rows[0] as { started: string }).started;
      await writer.write(
        handle,
        event({ code: 'auth.device.proof_failed', note: 'first of one transaction' }),
      );
      await writer.write(
        handle,
        event({ code: 'auth.device.proof_failed', note: 'second of one transaction' }),
      );
    });

    const rows = await observer.rows<{ note: string; after_start: boolean }>(
      `select note, recorded_at > $1::timestamptz as after_start
         from audit_event where note in ('first of one transaction', 'second of one transaction')
         order by recorded_at, id`,
      [started],
    );
    expect(rows.map((row) => row.note)).toEqual([
      'first of one transaction',
      'second of one transaction',
    ]);
    expect(rows.map((row) => row.after_start)).toEqual([true, true]);
    const ordered = await observer.one<{ increasing: boolean }>(
      `select (select recorded_at from audit_event where note = 'second of one transaction')
            > (select recorded_at from audit_event where note = 'first of one transaction') as increasing`,
    );
    expect(ordered?.increasing).toBe(true);
  });

  // Break caught: the explicit MFA-reset shape validated in memory but not stored as given, or an event that changed nothing stored
  // with an invented change.
  it('stores a complete MFA reset with its lineage and diff, and an event that changed nothing with neither a diff nor a made-up one', async () => {
    await writeAs(staffContext([HUB_A]), MFA_RESET);
    await writeAs(
      staffContext([HUB_A]),
      event({ code: 'payment.ledger.exported', outcome: 'SUCCEEDED' }),
    );

    const [reset] = await rowsFor('auth.mfa.reset');
    expect(reset).toMatchObject({
      enhanced: true,
      object_type: 'StaffIdentity',
      object_id: OBJECT,
      previous_state: 'ACTIVE_FACTOR',
      resulting_state: 'ISSUED',
      reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE',
      related_ids: MFA_RESET.relatedIds,
      before_after: MFA_RESET.beforeAfter,
    });
    const [exported] = await rowsFor('payment.ledger.exported');
    expect(exported).toMatchObject({ enhanced: true, before_after: null });
  });

  // Break caught: the system's technical identifier copied into actor_id (OB-47).
  it('records a SYSTEM transaction as the null actor', async () => {
    await writeAs(systemContext('authentication'), event({ code: 'auth.recovery.requested' }));

    const [row] = await rowsFor('auth.recovery.requested');
    expect(row).toMatchObject({ actor_type: 'SYSTEM', actor_id: null, surface_context: 'SYSTEM' });
  });

  // Break caught: a sign-in unable to name the person it authenticated.
  it('lets a SYSTEM transaction record the person it authenticated', async () => {
    // A SYSTEM principal's id is the capability's technical identifier, never a person's (SECURITY_DESIGN.md section 14.16); the
    // fixture's contexts all carry one shared id, which here is the staff member's, so this one is given its own.
    await writeAs(
      { ...systemContext('authentication'), principalId: TECHNICAL_ID },
      event({
        code: 'auth.session.issued',
        outcome: 'SUCCEEDED',
        actor: { type: 'STAFF', id: STAFF_ID },
      }),
    );

    const [row] = await rowsFor('auth.session.issued');
    expect(row).toMatchObject({
      actor_type: 'STAFF',
      actor_id: STAFF_ID,
      surface_context: 'SYSTEM',
    });
  });

  // Break caught: a stored event without the manifest of a time that a rider syncs late.
  it('keeps the time the act happened apart from the time it was recorded', async () => {
    const earlier = new Date('2026-10-10T05:30:00.000Z');
    await writeAs(
      staffContext([HUB_A]),
      event({ code: 'auth.device.registered', outcome: 'SUCCEEDED', occurredAt: earlier }),
    );

    const [row] = await rowsFor('auth.device.registered');
    expect((row?.occurred_at as Date).toISOString()).toBe(earlier.toISOString());
    expect((row?.recorded_at as Date).getTime()).toBeGreaterThan(earlier.getTime());
  });

  // Break caught: a code outside the catalogue reaching the table, and a refusal that stores a half-written row.
  it('refuses a code the catalogue does not hold, before any statement, and stores nothing', async () => {
    await expect(
      writeAs(staffContext([HUB_A]), event({ code: 'auth.session.invented' })),
    ).rejects.toMatchObject({ name: 'AuditRefusedError', code: 'AUDIT_EVENT_CODE_UNKNOWN' });
    expect(await observer.count('audit_event', { event_code: 'auth.session.invented' })).toBe(0);
  });
});

describe('who may write and read the ledger (data-scope-registry.md section 4.5)', () => {
  // Break caught: a vendor or a rider context reaching the ledger, or a SYSTEM context under a capability the registry does not give it.
  it('refuses a vendor, a rider and a SYSTEM context under any capability but authentication', async () => {
    for (const context of [
      vendorContext(VENDOR_1),
      riderContext('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'),
      systemContext('rate_limit'),
    ]) {
      expect(
        await stateOf(
          writeAs(context, event({ code: 'auth.device.revoked', outcome: 'SUCCEEDED' })),
        ),
      ).toBe('42501');
    }
    expect(await observer.count('audit_event', { event_code: 'auth.device.revoked' })).toBe(0);
  });

  // Break caught: the writer's own check being the only thing that stops one staff member recording an act as another.
  it('refuses at the database a row a staff context writes for another actor', async () => {
    const attempt = (actor: string, actorType: string) =>
      built.service.transactionWithContext(staffContext([HUB_A]), (tx) =>
        tx.execute(sql`
          insert into audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, object_type, correlation_id, outcome, enhanced, serialisation_version)
          values (gen_random_uuid(), 'auth.mfa.failed', now(), ${actorType}, ${actor}::uuid, 'OPS_PORTAL', 'MfaFactor', 'x', 'REJECTED', false, 1)`),
      );

    expect(await stateOf(attempt('99999999-9999-4999-8999-999999999999', 'STAFF'))).toBe('42501');
    expect(await stateOf(attempt(STAFF_ID, 'RIDER'))).toBe('42501');
    expect(await observer.count('audit_event', { event_code: 'auth.mfa.failed' })).toBe(0);
  });

  // Break caught: a hub scope that does not apply to a read of the ledger.
  it('lets a staff context read the events of its hubs and the events of no other hub', async () => {
    await admin.query(
      `insert into audit_event (id, event_code, occurred_at, actor_type, surface_context, object_type, correlation_id, outcome, enhanced, serialisation_version, responsible_hub_id)
       values (gen_random_uuid(), 'hub.zone.created', now(), 'SYSTEM', 'SYSTEM', 'HUB', 'scope-a', 'SUCCEEDED', false, 1, $1),
              (gen_random_uuid(), 'hub.zone.created', now(), 'SYSTEM', 'SYSTEM', 'HUB', 'scope-b', 'SUCCEEDED', false, 1, $2),
              (gen_random_uuid(), 'hub.zone.created', now(), 'SYSTEM', 'SYSTEM', 'HUB', 'scope-none', 'SUCCEEDED', false, 1, null)`,
      [HUB_A, HUB_B],
    );
    const readScopes = (context: Parameters<typeof withHandle>[1]) =>
      built.service.transactionWithContext(context, async (tx) => {
        const result = await tx.execute(
          sql`select correlation_id from audit_event where event_code = 'hub.zone.created' order by correlation_id`,
        );
        return result.rows.map((row) => (row as { correlation_id: string }).correlation_id);
      });

    expect(await readScopes(staffContext([HUB_A]))).toEqual(['scope-a']);
    expect(await readScopes(staffContext([HUB_B]))).toEqual(['scope-b']);
    expect(await readScopes(staffContext([HUB_A, HUB_B]))).toEqual(['scope-a', 'scope-b']);
    expect(await readScopes(staffContext([]))).toEqual([]);
    expect(await readScopes(staffContext([HUB_A], 'ALL'))).toEqual([
      'scope-a',
      'scope-b',
      'scope-none',
    ]);
  });

  // Break caught: a principal that must not read the ledger reading it, or a refusal that is an error rather than nothing.
  it('shows a vendor, a rider and a SYSTEM context no event at all', async () => {
    for (const context of [
      vendorContext(VENDOR_1),
      riderContext('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'),
      systemContext('authentication'),
    ]) {
      const count = await built.service.transactionWithContext(context, async (tx) => {
        const result = await tx.execute(sql`select count(*)::int as n from audit_event`);
        return (result.rows[0] as { n: number }).n;
      });
      expect(count).toBe(0);
    }
  });
});

describe('the ledger is append-only (GBT-T1)', () => {
  // Break caught: a runtime login being able to change or remove history. This is the row of the matrix: the layer is the grant.
  it('gives every runtime login an error for UPDATE, DELETE and TRUNCATE, because none holds the privilege', async () => {
    await writeAs(
      staffContext([HUB_A]),
      event({ code: 'auth.session.terminated', enhanced: false, outcome: 'SUCCEEDED' }),
    );
    const before = await observer.count('audit_event');
    expect(before).toBeGreaterThan(0);

    for (const login of ['melarc_api_runtime', WORKER_RUNTIME_ROLE, PROVISIONING_ROLE] as const) {
      await withClient(database.urlFor(login), async (client) => {
        for (const statement of [
          "update audit_event set note = 'rewritten'",
          'delete from audit_event',
          'truncate audit_event',
        ]) {
          expect(await sqlState(client, statement), `${login}: ${statement}`).toBe('42501');
        }
      });
    }
    expect(await observer.count('audit_event')).toBe(before);
    expect(await observer.count('audit_event', { note: 'rewritten' })).toBe(0);
  });

  // Break caught: the guard resting on the grants alone, so that a login that holds every privilege could change history. The
  // table owner and the migration identity hold UPDATE, DELETE and TRUNCATE, are subject to forced row-level security, and no policy
  // admits either command: an UPDATE or a DELETE reaches no row, and TRUNCATE (which row-level security does not govern) is
  // refused by the trigger. The administrator bypasses row-level security, so the trigger refuses the rows themselves.
  it('refuses the owner, the migration identity and the administrator as well, each by its own layer', async () => {
    const before = await observer.count('audit_event');
    expect(before).toBeGreaterThan(0);

    for (const url of [database.urlFor(MIGRATION_ROLE), database.urlFor('postgres')]) {
      await withClient(url, async (client) => {
        // Through the migration identity directly, and through the owner by SET ROLE.
        const roles = url === database.urlFor('postgres') ? ['melarc_owner', null] : [null];
        for (const role of roles) {
          if (role !== null) await client.query(`set role ${role}`);
          const asSuperuser = role === null && url === database.urlFor('postgres');
          for (const statement of [
            "update audit_event set note = 'rewritten'",
            'delete from audit_event',
          ]) {
            if (asSuperuser) {
              expect(await sqlState(client, statement), statement).toBe('42501');
            } else {
              const result = await client.query(statement);
              expect(result.rowCount, `${role ?? 'migration'}: ${statement}`).toBe(0);
            }
          }
          expect(
            await sqlState(client, 'truncate audit_event'),
            `${role ?? 'login'}: truncate`,
          ).toBe('42501');
          if (role !== null) await client.query('reset role');
        }
      });
    }
    expect(await observer.count('audit_event')).toBe(before);
    expect(await observer.count('audit_event', { note: 'rewritten' })).toBe(0);
  });

  // Break caught: the trigger refusing for the wrong reason, or in words that do not say why.
  it('says the ledger is append-only when the administrator is refused', async () => {
    for (const statement of [
      "update audit_event set note = 'x'",
      'delete from audit_event',
      'truncate audit_event',
    ]) {
      await expect(admin.query(statement), statement).rejects.toThrow('append-only');
    }
  });

  // Break caught: a login holding any privilege beyond SELECT and INSERT on the ledger.
  it('grants the API runtime SELECT and INSERT and nothing else, and the other logins nothing', async () => {
    const holds = async (login: string, privilege: string): Promise<boolean> =>
      (
        await observer.one<{ held: boolean }>('select has_table_privilege($1, $2, $3) as held', [
          login,
          'public.audit_event',
          privilege,
        ])
      )?.held === true;

    for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      for (const login of ['melarc_api_runtime', WORKER_RUNTIME_ROLE, PROVISIONING_ROLE]) {
        expect(await holds(login, privilege), `${login} ${privilege}`).toBe(false);
      }
    }
    expect(await holds('melarc_api_runtime', 'SELECT')).toBe(true);
    expect(await holds('melarc_api_runtime', 'INSERT')).toBe(true);
    for (const login of [WORKER_RUNTIME_ROLE, PROVISIONING_ROLE]) {
      expect(await holds(login, 'INSERT'), login).toBe(false);
    }
  });
});

describe('an act and its record commit together, or not at all (GBT-T10)', () => {
  const NOTE = 'act-and-record';
  const insertNote = (
    tx: Parameters<Parameters<typeof built.service.transactionWithContext>[1]>[0],
  ) =>
    tx.execute(sql`insert into rls_fixture.notes (hub_id, vendor_organization_id, body)
                   values (${HUB_A}, ${VENDOR_1}, ${NOTE})`);
  const noteCount = async (): Promise<number> =>
    (
      await observer.one<{ n: number }>(
        'select count(*)::int as n from rls_fixture.notes where body = $1',
        [NOTE],
      )
    )?.n ?? 0;

  // Break caught: an enhanced audit write that cannot be stored letting the act commit anyway.
  it('does not commit the act when its enhanced event cannot be stored', async () => {
    // A vendor context may write a note and may not write the ledger: the audit write fails, the note must not remain.
    const act = withHandle(built.service, vendorContext(VENDOR_1), async (handle, tx) => {
      await insertNote(tx);
      await writer.write(
        handle,
        event({ code: 'auth.device.revoked', enhanced: true, outcome: 'SUCCEEDED' }),
      );
    });

    expect(await stateOf(act)).toBe('42501');
    expect(await noteCount()).toBe(0);
  });

  // Break caught: a caller that swallows the audit failure and returns normally being answered as a success.
  it('is never a success, even when the caller catches the failed audit write and carries on', async () => {
    const act = withHandle(built.service, vendorContext(VENDOR_1), async (handle, tx) => {
      await insertNote(tx);
      await writer
        .write(handle, event({ code: 'auth.device.revoked', enhanced: true, outcome: 'SUCCEEDED' }))
        .catch(() => undefined);
      return 'done';
    });

    await expect(act).rejects.toBeInstanceOf(TransactionRolledBackError);
    expect(await noteCount()).toBe(0);
  });

  // Break caught: an event the writer itself refuses (no statement is sent for it) leaving the transaction healthy, so that a
  // caller that catches the refusal commits the act with no record (review of 10 October 2026, finding 1).
  it.each([
    ['a code the catalogue does not hold', { code: 'auth.session.invented' }],
    [
      'a field named for a secret',
      { code: 'auth.credential.changed', detail: { new_password: 'x' } },
    ],
    [
      'an address in the note',
      { code: 'auth.credential.changed', note: 'sent to someone@example.test' },
    ],
    // G2-06: the catalogue's tier and facts are enforced by the same refusal, so an act whose record was refused for them cannot
    // be committed by a caller that catches the refusal either.
    ['a mandatory enhanced event written as ordinary', { code: 'auth.mfa.reset', enhanced: false }],
    [
      'a mandatory enhanced event without its reason and lineage',
      { code: 'auth.mfa.reset', enhanced: true },
    ],
    ['an ordinary event written as enhanced', { code: 'auth.session.issued', enhanced: true }],
    // G2 follow-up: the explicit shape of an MFA reset and the per-change diff rule are refused by the same path.
    [
      'an MFA reset that names no revoked factor where one was revoked',
      {
        ...MFA_RESET,
        relatedIds: { episode_id: EPISODE, new_grant_id: NEW_GRANT, superseded_grant_ids: [] },
      },
    ],
    [
      'an MFA reset of another kind of object',
      { ...MFA_RESET, object: { type: 'MfaFactor', id: OBJECT } },
    ],
    [
      'an event that changed nothing given a before and after',
      { code: 'payment.ledger.exported', beforeAfter: { state: { from: 'A', to: 'B' } } },
    ],
    ['a change recorded without its before and after', { code: 'staff.identity.suspended' }],
  ] as const)(
    'is never a success when the caller catches the writer’s own refusal (%s) and carries on',
    async (_name, overrides) => {
      const act = withHandle(built.service, staffContext([HUB_A]), async (handle, tx) => {
        await tx.execute(
          sql`insert into rls_fixture.notes (hub_id, body) values (${HUB_A}, ${NOTE})`,
        );
        // Stated as the caller states it, not completed from the catalogue: the refusal is what is being proved.
        await writer
          .write(handle, {
            ...EVENT,
            ...overrides,
            enhanced: 'enhanced' in overrides ? overrides.enhanced : true,
            outcome: 'SUCCEEDED',
          })
          .catch(() => undefined);
        return 'done';
      });

      await expect(act).rejects.toBeInstanceOf(TransactionRolledBackError);
      expect(await noteCount()).toBe(0);
    },
  );

  // Break caught: a write the store breaks mid-act (not a policy refusal) leaving the act behind.
  it('does not commit the act when the store itself fails the write', async () => {
    const broken = await admin.breakWrites('audit_event');
    try {
      const act = withHandle(built.service, staffContext([HUB_A]), async (handle, tx) => {
        await tx.execute(
          sql`insert into rls_fixture.notes (hub_id, body) values (${HUB_A}, ${NOTE})`,
        );
        await writer.write(
          handle,
          event({ code: 'staff.identity.approved', enhanced: true, outcome: 'SUCCEEDED' }),
        );
      });

      expect(await stateOf(act)).toBe('P0001');
      expect(await noteCount()).toBe(0);
    } finally {
      await broken.mend();
    }
  });

  // Break caught: an act and its event being written in separate transactions, so that one could commit without the other.
  it('commits the act and its event together when both are stored', async () => {
    await withHandle(built.service, staffContext([HUB_A]), async (handle, tx) => {
      await tx.execute(
        sql`insert into rls_fixture.notes (hub_id, body) values (${HUB_A}, ${NOTE})`,
      );
      await writer.write(
        handle,
        event({ code: 'staff.identity.suspended', enhanced: true, outcome: 'SUCCEEDED' }),
      );
    });

    expect(await noteCount()).toBe(1);
    expect(await observer.count('audit_event', { event_code: 'staff.identity.suspended' })).toBe(1);
  });
});

describe('what is written is screened (Family U)', () => {
  const SENTINEL = 'SENTINEL-planted-secret-7f3a9c';

  // Break caught: a secret planted in a value reaching the ledger, which cannot be corrected afterwards.
  it('removes a secret planted in a text value and stores nothing that contains it', async () => {
    await writeAs(
      staffContext([HUB_A]),
      event({
        code: 'auth.credential.changed',
        outcome: 'SUCCEEDED',
        note: `password=${SENTINEL}`,
        detail: {
          cause: `Bearer ${SENTINEL}.abc`,
          link: `https://user:${SENTINEL}@example.test/x`,
        },
        relatedIds: { reference: `token=${SENTINEL}` },
      }),
    );

    expect(await observer.count('audit_event', { event_code: 'auth.credential.changed' })).toBe(1);
    const leaked = await observer.rows(
      'select 1 from audit_event where audit_event::text like $1',
      [`%${SENTINEL}%`],
    );
    expect(leaked).toEqual([]);
  });

  // Break caught: a field named for a secret being stored, or the refusal repeating what it refused.
  it('refuses a field named for a secret and the refusal does not repeat the value', async () => {
    const error = await writeAs(
      staffContext([HUB_A]),
      event({ code: 'auth.credential.changed', detail: { new_password: SENTINEL } }),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AuditRefusedError);
    expect((error as Error).message).not.toContain(SENTINEL);
    expect(await observer.count('audit_event', { event_code: 'auth.credential.changed' })).toBe(1);
  });
});

describe('the table and the contract agree', () => {
  const insertRaw = (columns: Record<string, unknown>) => {
    const row = {
      id: 'gen_random_uuid()',
      event_code: "'auth.session.failed'",
      occurred_at: 'now()',
      actor_type: "'SYSTEM'",
      surface_context: "'SYSTEM'",
      object_type: "'Session'",
      correlation_id: "'raw'",
      outcome: "'REJECTED'",
      enhanced: 'false',
      serialisation_version: '1',
      ...Object.fromEntries(Object.entries(columns).map(([key, value]) => [key, String(value)])),
    };
    return admin.query(
      `insert into audit_event (${Object.keys(row).join(', ')}) values (${Object.values(row).join(', ')})`,
    );
  };

  // Break caught: the closed sets of the table drifting from the vocabularies the writer uses.
  it('accepts every object type and outcome the writer knows and refuses one it does not', async () => {
    for (const type of AUDIT_OBJECT_TYPES) await insertRaw({ object_type: `'${type}'` });
    for (const outcome of AUDIT_OUTCOMES) await insertRaw({ outcome: `'${outcome}'` });

    await expect(insertRaw({ object_type: "'Invented'" })).rejects.toMatchObject({ code: '23514' });
    await expect(insertRaw({ outcome: "'OK'" })).rejects.toMatchObject({ code: '23514' });
    await expect(insertRaw({ surface_context: "'WEB'" })).rejects.toMatchObject({ code: '23514' });
    await expect(insertRaw({ actor_type: "'ADMIN'" })).rejects.toMatchObject({ code: '23514' });
    await expect(insertRaw({ event_code: "'Auth.Session.Failed'" })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insertRaw({ event_code: "'sessionfailed'" })).rejects.toMatchObject({
      code: '23514',
    });
  });

  // Break caught: a SYSTEM event with an actor id, or a person with none, which the contract forbids.
  it('keeps the system the only null actor', async () => {
    await expect(
      insertRaw({ actor_type: "'SYSTEM'", actor_id: "'11111111-1111-4111-8111-111111111111'" }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(insertRaw({ actor_type: "'STAFF'" })).rejects.toMatchObject({ code: '23514' });
    await insertRaw({
      actor_type: "'STAFF'",
      actor_id: "'11111111-1111-4111-8111-111111111111'",
      surface_context: "'OPS_PORTAL'",
    });
  });

  // Break caught: a reason code without its snapshotted label, and a structured field that is not an object.
  it('keeps the reason a pair and the structured facts objects', async () => {
    await expect(insertRaw({ reason_code: "'DEVICE_LOST'" })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insertRaw({ reason_label: "'Lost'" })).rejects.toMatchObject({ code: '23514' });
    await expect(insertRaw({ detail: "'[1]'::jsonb" })).rejects.toMatchObject({ code: '23514' });
    await expect(insertRaw({ before_after: "'3'::jsonb" })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insertRaw({ correlation_id: "''" })).rejects.toMatchObject({ code: '23514' });
  });

  // Break caught: the canonical form not being reproducible from what the database holds (a checkpoint reads rows, not objects).
  it('has a canonical form, from the stored row, that is the same each time it is read', async () => {
    await writeAs(
      systemContext('authentication'),
      event({
        code: 'auth.lockout.applied',
        outcome: 'SUCCEEDED',
        responsibleHubId: HUB_A,
        relatedIds: { b: [2, 1], a: { z: true } },
        detail: { factor: 'PASSWORD', attempts: 5 },
      }),
    );
    const read = async (): Promise<StoredAuditEvent> => {
      const [row] = await observer.rows(
        `select id, event_code,
                to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
                to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at,
                actor_type, actor_id, actor_bundle, surface_context, device_context, vendor_organization_id,
                responsible_hub_id, object_type, object_id, correlation_id, previous_state, resulting_state,
                reason_code, reason_label, note, approval_id, before_after, related_ids, detail, outcome, enhanced,
                serialisation_version
           from audit_event where event_code = 'auth.lockout.applied'`,
      );
      return row as unknown as StoredAuditEvent;
    };

    const first = canonicalAuditEvent(await read());
    expect(canonicalAuditEvent(await read())).toBe(first);
    const parsed = JSON.parse(first) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      event_code: 'auth.lockout.applied',
      actor_id: null,
      related_ids: { a: { z: true }, b: [2, 1] },
      serialisation_version: 1,
    });
    expect(first.indexOf('"related_ids"')).toBeLessThan(first.indexOf('"resulting_state"'));
  });
});

describe('several events in one transaction', () => {
  // Break caught: a second event of one transaction waiting for a connection the first holds (a pool of one).
  it('writes them all on the one connection the transaction holds', async () => {
    await withHandle(built.service, staffContext([HUB_A]), async (handle) => {
      for (const code of [
        'auth.mfa.enrolled',
        'auth.mfa.revoked',
        'auth.mfa.reenrolment_begun',
      ] as const) {
        await writer.write(handle, event({ code, outcome: 'SUCCEEDED' }));
      }
    });

    for (const code of ['auth.mfa.enrolled', 'auth.mfa.revoked', 'auth.mfa.reenrolment_begun']) {
      expect(await observer.count('audit_event', { event_code: code })).toBe(1);
    }
  });
});

describe('bookkeeping that survives a refusal (the committed-failure shape)', () => {
  class WrongPassword extends Error {}
  const COUNTER = 'failed attempts';
  const attempts = async (): Promise<string | undefined> =>
    (
      await observer.one<{ body: string }>(
        'select body from rls_fixture.system_records where body like $1',
        [`${COUNTER}%`],
      )
    )?.body;

  /** The bookkeeping of one failed sign-in: its counter (a row only the authentication capability reaches) and its event. */
  const bookkeeping =
    (count: number) =>
    async (handle: Parameters<Parameters<ReturnType<typeof unitOfWorkOver>['run']>[1]>[0]) => {
      await transactionOf(handle).execute(
        sql`update rls_fixture.system_records set body = ${`${COUNTER}: ${String(count)}`} where body like ${`${COUNTER}%`}`,
      );
      await writer.write(handle, event({ code: 'auth.session.failed', outcome: 'REJECTED' }));
    };

  // Break caught: the counter and the event being rolled back with the refusal, so a lockout would never count.
  it('keeps the counter and the event of a refused attempt, and then answers the refusal', async () => {
    await admin.query(
      "insert into rls_fixture.system_records (body) values ('failed attempts: 0')",
    );
    const before = await observer.count('audit_event', {
      correlation_id: 'database-test',
      event_code: 'auth.session.failed',
    });

    const caught = await commitThenRefuse(
      unitOfWorkOver(built.service),
      systemContext('authentication'),
      async (handle) => {
        await bookkeeping(1)(handle);
        return new WrongPassword('refused');
      },
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(WrongPassword);
    expect(await attempts()).toBe('failed attempts: 1');
    expect(
      await observer.count('audit_event', {
        correlation_id: 'database-test',
        event_code: 'auth.session.failed',
      }),
    ).toBe(before + 1);
  });

  // Break caught: the shape being no different from raising the refusal inside the transaction, which keeps nothing.
  it('is what raising the refusal inside the transaction is not', async () => {
    const before = await observer.count('audit_event', { event_code: 'auth.session.failed' });

    await expect(
      unitOfWorkOver(built.service).run(systemContext('authentication'), async (handle) => {
        await bookkeeping(2)(handle);
        throw new WrongPassword('refused inside');
      }),
    ).rejects.toBeInstanceOf(WrongPassword);

    expect(await attempts()).toBe('failed attempts: 1');
    expect(await observer.count('audit_event', { event_code: 'auth.session.failed' })).toBe(before);
  });

  // Break caught: a bookkeeping that could not be stored being answered as the refusal.
  it('answers the failure of the bookkeeping, and keeps nothing, when the event cannot be stored', async () => {
    const broken = await admin.breakWrites('audit_event');
    try {
      const state = await stateOf(
        commitThenRefuse(
          unitOfWorkOver(built.service),
          systemContext('authentication'),
          async (handle) => {
            await bookkeeping(3)(handle);
            return new WrongPassword('refused');
          },
        ),
      );

      expect(state).toBe('P0001');
      expect(await attempts()).toBe('failed attempts: 1');
    } finally {
      await broken.mend();
    }
  });
});

describe('a write that fails closed is counted (OBSERVABILITY_AND_RECOVERY.md §3, "Enhanced-audit write failed closed")', () => {
  const metrics = new BoundedMetrics({ policy: 'throw', clock });
  const counted = new PostgresAuditWriter(clock, metrics);
  const failed = () =>
    metrics.snapshot().counters.find((entry) => entry.name === 'audit_enhanced_write_failed_total')
      ?.value ?? 0;
  const attempt = (input: AuditEventInput, context = vendorContext(VENDOR_1)) =>
    withHandle(built.service, context, (handle) => counted.write(handle, input)).then(
      () => 'written',
      () => 'failed',
    );

  // Break caught: the block of a privileged act leaving no trace for the alert that exists for it.
  it('counts an enhanced event that could not be written, once, and says nothing of the act or the actor', async () => {
    const before = failed();

    expect(
      await attempt(event({ code: 'auth.device.revoked', enhanced: true, outcome: 'SUCCEEDED' })),
    ).toBe('failed');

    expect(failed()).toBe(before + 1);
    expect(JSON.stringify(metrics.snapshot())).not.toContain(VENDOR_1);
  });

  // Break caught: the counter counting what is not a block: an ordinary event's failure, a refusal of the event itself, a success.
  it('counts neither an event that is not enhanced, nor a success', async () => {
    const before = failed();

    expect(await attempt(event({ code: 'auth.session.issued', outcome: 'SUCCEEDED' }))).toBe(
      'failed',
    );
    expect(
      await attempt(
        event({ code: 'auth.mfa.completed', enhanced: true, outcome: 'SUCCEEDED' }),
        staffContext([HUB_A]),
      ),
    ).toBe('written');

    expect(failed()).toBe(before);
  });

  // Break caught: an event the writer itself refuses (a defect of the caller) hiding an enhanced act’s block from the counter.
  it('counts an enhanced event the writer refuses as well: the act did not happen either', async () => {
    const before = failed();

    expect(
      await attempt(
        { ...event({ code: 'auth.session.invented', outcome: 'SUCCEEDED' }), enhanced: true },
        staffContext([HUB_A]),
      ),
    ).toBe('failed');

    expect(failed()).toBe(before + 1);
  });
});
