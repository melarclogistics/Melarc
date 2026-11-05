import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { DatabaseTransaction } from '../../src/platform/database/database.service.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import {
  HUB_A,
  HUB_B,
  PRINCIPAL_1,
  PRINCIPAL_2,
  RIDER_1,
  riderContext,
  staffContext,
  systemContext,
  vendorContext,
} from './support/rls-fixture.js';
import {
  ARRANGER,
  insertAttemptExtension,
  insertPickupRequest,
  pickupRequestRow,
  type PickupRequestRow,
} from './support/pickups.js';
import { buildService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * S1.18 against a real PostgreSQL: the attempt extension (migration 0053; domain-model.md section 6.2; data-scope-registry.md
 * `PickupAttemptExtension`; state-machines.md section 3, "force-extension"), the escalation moment of a request, and the rule that a replacement
 * and its source are never active together. The shape (constraints), the record that is never changed, who reads and writes it under
 * row-level security and the column grants of the runtime login, the link a request may name, and the invariants of the chain. Arranged and
 * changed as the cluster administrator where a constraint or a trigger is under test.
 */
let database: TestDatabase;
let admin: pg.Client;
const vendor1 = vendorRow({ hubId: HUB_A });
const vendor2 = vendorRow({ hubId: HUB_B });

beforeAll(async () => {
  database = await createTestDatabase();
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(
    `insert into hub (id, name) values ('${HUB_A}', 'Hub A'), ('${HUB_B}', 'Hub B')`,
  );
  await insertVendor(admin, vendor1);
  await insertVendor(admin, vendor2);
});

afterAll(async () => {
  await admin.end();
  await database.drop();
});

const request = async (
  over: Partial<PickupRequestRow> = {},
  hub = HUB_A,
  vendor = vendor1,
): Promise<string> =>
  (await insertPickupRequest(admin, pickupRequestRow(vendor.organizationId, hub, over))).id;
const confirmed = (over: Partial<PickupRequestRow> = {}, hub = HUB_A): Promise<string> =>
  request({ state: 'CONFIRMED', ...over }, hub);

const staff = (
  key: string,
  hubs: readonly string[] = [HUB_A],
  principalId = PRINCIPAL_1,
): SecurityContext => ({
  ...staffContext(hubs),
  principalId,
  authorizationKey: key,
});

async function inContext<T>(
  context: SecurityContext,
  work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  const { service, close } = buildService(database);
  try {
    return await service.transactionWithContext(context, work);
  } finally {
    await close();
  }
}

const idsOf = async (context: SecurityContext): Promise<string[]> =>
  inContext(context, async (tx) => {
    const result = await tx.execute(sql.raw('select id from pickup_attempt_extension'));
    return (result.rows as { id: string }[]).map((row) => row.id);
  });

async function stateOf(context: SecurityContext, statement: string): Promise<string | undefined> {
  try {
    await inContext(context, async (tx) => {
      await tx.execute(sql.raw(statement));
    });
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.code;
  }
}

async function changed(context: SecurityContext, statement: string): Promise<number> {
  return inContext(context, async (tx) => {
    const result = await tx.execute(sql.raw(statement));
    return result.rowCount ?? 0;
  });
}

interface Refusal {
  readonly code?: string;
  readonly constraint?: string;
}

/**
 * What an administrator's work ends with, **at commit** (a deferred constraint is judged there): the SQLSTATE and the constraint it is
 * refused with, or `undefined` when it was committed. The transaction is rolled back when it is refused, and the work is the test's own rows.
 */
const refusal = async (work: () => Promise<unknown>): Promise<Refusal | undefined> => {
  await admin.query('BEGIN');
  try {
    await work();
    await admin.query('COMMIT');
    return undefined;
  } catch (error) {
    const failure = error as Refusal;
    await admin.query('ROLLBACK').catch(() => undefined);
    return { code: failure.code, constraint: failure.constraint };
  }
};

const insertExtensionSql = (requestId: string, extendedBy: string, id = randomUUID()): string =>
  `insert into pickup_attempt_extension (id, pickup_request_id, ceiling_before, ceiling_after, extended_by, reason)
   values ('${id}', '${requestId}', 3, 4, '${extendedBy}', 'The vendor asked for one more visit')`;

describe('the shape of an extension', () => {
  const insert = (
    requestId: string,
    over: { before?: number; after?: number; reason?: string } = {},
  ): Promise<unknown> =>
    admin.query(
      `insert into pickup_attempt_extension (id, pickup_request_id, ceiling_before, ceiling_after, extended_by, reason)
       values (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [
        requestId,
        over.before ?? 3,
        over.after ?? 4,
        ARRANGER,
        over.reason ?? 'The vendor asked for one more visit',
      ],
    );

  // Break caught: an extension with no reason (section 21.6 makes it mandatory), or one that does not raise the ceiling it extends.
  it.each([
    ['a blank reason', { reason: '   ' }, 'pickup_attempt_extension_reason_not_blank'],
    [
      'a ceiling that does not rise',
      { before: 4, after: 4 },
      'pickup_attempt_extension_ceiling_rises',
    ],
    ['a ceiling that falls', { before: 4, after: 3 }, 'pickup_attempt_extension_ceiling_rises'],
    [
      'a ceiling below the first attempt',
      { before: 0, after: 1 },
      'pickup_attempt_extension_ceiling_positive',
    ],
  ])('refuses %s', async (_name, over, constraint) => {
    const id = await confirmed();
    expect(await refusal(() => insert(id, over))).toEqual({ code: '23514', constraint });
  });

  // Break caught: a request raised twice (the ceiling is raised for this request once), or an extension of a request that is not there.
  it('is raised for one request at most once, and only for a request that exists', async () => {
    const id = await confirmed();
    expect(await refusal(() => insert(id))).toBeUndefined();
    expect(await refusal(() => insert(id))).toEqual({
      code: '23505',
      constraint: 'pickup_attempt_extension_one_per_request',
    });
    expect(await refusal(() => insert(randomUUID()))).toEqual({
      code: '23503',
      constraint: 'pickup_attempt_extension_request_fkey',
    });
  });
});

describe('an extension is a record that is never changed or removed', () => {
  // Break caught: a reason, a ceiling or an author rewritten after the fact (the audit is immutable, section 21.6), or the record removed.
  it('refuses any change and any removal, by whoever makes them', async () => {
    const id = await confirmed();
    const extension = await insertAttemptExtension(admin, { requestId: id });
    for (const statement of [
      `update pickup_attempt_extension set reason = 'another' where id = '${extension}'`,
      `update pickup_attempt_extension set ceiling_after = 9 where id = '${extension}'`,
      `update pickup_attempt_extension set extended_by = '${PRINCIPAL_2}' where id = '${extension}'`,
      `delete from pickup_attempt_extension where id = '${extension}'`,
    ]) {
      expect(await refusal(() => admin.query(statement)), statement).toMatchObject({
        code: '23514',
      });
    }
    const runtime = staff('pickup.attempt.extend');
    expect(await stateOf(runtime, `update pickup_attempt_extension set reason = 'another'`)).toBe(
      '42501',
    );
    expect(await stateOf(runtime, `delete from pickup_attempt_extension`)).toBe('42501');
  });
});

describe('who reads and who writes an extension', () => {
  // Break caught: the record read through a key that has no business with the chain, in another hub's grant, by a vendor (the vendor's
  // request does not show it), a rider or a SYSTEM context.
  it('is read by the pickup operations of the hubs of the grant, and by nobody else', async () => {
    const id = await confirmed();
    const extension = await insertAttemptExtension(admin, { requestId: id });
    for (const key of [
      'pickup.attempt.extend',
      'pickup.request.confirm',
      'pickup.request.cancel',
      'pickup.failure.resolve',
      'pickup.read',
    ]) {
      expect(await idsOf(staff(key)), key).toContain(extension);
    }
    expect(await idsOf(staff('pickup.read', [HUB_B]))).not.toContain(extension);
    expect(await idsOf(staff('hub.read'))).not.toContain(extension);
    expect(
      await idsOf({
        ...vendorContext(vendor1.organizationId),
        authorizationKey: 'pickup.read',
      }),
    ).not.toContain(extension);
    expect(await idsOf({ ...riderContext(RIDER_1), authorizationKey: 'pickup.read' })).toEqual([]);
    for (const capability of ['configuration', 'rate_limit'] as const) {
      expect(await idsOf(systemContext(capability)), capability).toEqual([]);
    }
  });

  // Break caught: an extension written by a key other than the one that extends, for a request outside the grant's hubs, in another
  // member's name, or by a vendor, a rider or a SYSTEM context.
  it('is written only under pickup.attempt.extend, for a request of the grant’s hubs, in the writer’s own name', async () => {
    const own = staff('pickup.attempt.extend');
    expect(await changed(own, insertExtensionSql(await confirmed(), PRINCIPAL_1))).toBe(1);

    expect(await stateOf(own, insertExtensionSql(await confirmed(), PRINCIPAL_2))).toBe('42501');
    expect(await stateOf(own, insertExtensionSql(await confirmed({}, HUB_B), PRINCIPAL_1))).toBe(
      '42501',
    );
    for (const key of [
      'pickup.request.cancel',
      'pickup.failure.resolve',
      'pickup.request.confirm',
    ]) {
      expect(
        await stateOf(staff(key), insertExtensionSql(await confirmed(), PRINCIPAL_1)),
        key,
      ).toBe('42501');
    }
    const asVendor = {
      ...vendorContext(vendor1.organizationId),
      principalId: PRINCIPAL_1,
      authorizationKey: 'pickup.attempt.extend',
    };
    expect(await stateOf(asVendor, insertExtensionSql(await confirmed(), PRINCIPAL_1))).toBe(
      '42501',
    );
    expect(
      await stateOf(
        { ...riderContext(RIDER_1), authorizationKey: 'pickup.attempt.extend' },
        insertExtensionSql(await confirmed(), PRINCIPAL_1),
      ),
    ).toBe('42501');
  });
});

describe('the extension a request names', () => {
  // Break caught: one booking carrying another's extension (it would confirm a fourth attempt that was never allowed), or a request that
  // cannot name the extension raised for it.
  it('is one raised for it, or the one the request it replaces carries', async () => {
    const mine = await confirmed();
    const other = await confirmed();
    const own = await insertAttemptExtension(admin, { requestId: mine });
    const foreign = await insertAttemptExtension(admin, { requestId: other });

    expect(
      await refusal(() =>
        admin.query(`update pickup_request set attempt_extension_id = $2 where id = $1`, [
          mine,
          foreign,
        ]),
      ),
    ).toEqual({ code: '23514', constraint: 'pickup_request_extension_chain' });
    expect(
      await refusal(() =>
        admin.query(`update pickup_request set attempt_extension_id = $2 where id = $1`, [
          mine,
          randomUUID(),
        ]),
      ),
    ).toEqual({ code: '23514', constraint: 'pickup_request_extension_chain' });
    expect(
      await refusal(() =>
        admin.query(`update pickup_request set attempt_extension_id = $2 where id = $1`, [
          mine,
          own,
        ]),
      ),
    ).toBeUndefined();

    // A clone carries its source's extension (it is the same booking at its next attempt) and no other.
    await admin.query(
      `update pickup_request set state = 'CANCELLED', cancelled_at = now(), cancelled_by = $2 where id = $1`,
      [mine, ARRANGER],
    );
    const clone = (extension: string | undefined) =>
      insertPickupRequest(
        admin,
        pickupRequestRow(vendor1.organizationId, HUB_A, {
          replacesRequestId: mine,
          attemptNumber: 4,
        }),
      ).then(({ id }) =>
        extension === undefined
          ? undefined
          : admin.query(`update pickup_request set attempt_extension_id = $2 where id = $1`, [
              id,
              extension,
            ]),
      );
    expect(await refusal(() => clone(foreign))).toEqual({
      code: '23514',
      constraint: 'pickup_request_extension_chain',
    });
    expect(await refusal(() => clone(own))).toBeUndefined();
  });
});

describe('the moment of an escalation', () => {
  // Break caught: a request escalated before it was ever confirmed (a failed attempt needs a request that was attempted).
  it('belongs to a request that was confirmed', async () => {
    expect(
      await refusal(() =>
        request({ state: 'PENDING', escalatedAt: new Date('2026-11-02T11:00:00Z') }),
      ),
    ).toEqual({ code: '23514', constraint: 'pickup_request_escalation_facts' });
    expect(
      await refusal(() => confirmed({ escalatedAt: new Date('2026-11-02T11:00:00Z') })),
    ).toBeUndefined();
  });

  // Break caught: an escalation taken back or moved (it is a recorded judgement, not a flag), or one that stops the request being cancelled
  // (the request is never uncancellable, section 21.6).
  it('is never taken back or moved, and does not stop the request being cancelled', async () => {
    const id = await confirmed({ escalatedAt: new Date('2026-11-02T11:00:00Z') });
    for (const set of [`escalated_at = null`, `escalated_at = now()`]) {
      expect(
        await refusal(() => admin.query(`update pickup_request set ${set} where id = $1`, [id])),
        set,
      ).toMatchObject({ code: '23514' });
    }
    expect(
      await refusal(() =>
        admin.query(
          `update pickup_request set state = 'CANCELLED', cancelled_at = now(), cancelled_by = $2 where id = $1`,
          [id, ARRANGER],
        ),
      ),
    ).toBeUndefined();
    const [row] = (
      await admin.query<{ escalated_at: Date | null }>(
        `select escalated_at from pickup_request where id = $1`,
        [id],
      )
    ).rows;
    expect(row?.escalated_at?.toISOString()).toBe('2026-11-02T11:00:00.000Z');
  });
});

describe('a replacement and its source are never active together', () => {
  const cloneOf = (source: string, over: Partial<PickupRequestRow> = {}): PickupRequestRow =>
    pickupRequestRow(vendor1.organizationId, HUB_A, { replacesRequestId: source, ...over });

  // Break caught: a replacement committed while its source still stands (AC-SLICE-001-06: the two are never both active), however it got there.
  it.each([
    ['pending', { state: 'PENDING' }],
    ['confirmed', { state: 'CONFIRMED' }],
  ] as const)('refuses, at commit, a replacement of a source that is %s', async (_name, over) => {
    const source = await request(over);
    expect(await refusal(() => insertPickupRequest(admin, cloneOf(source)))).toEqual({
      code: '23514',
      constraint: 'pickup_request_source_cancelled',
    });
  });

  // Break caught: the rule judged statement by statement (a reschedule inserts the clone first, then cancels the source, in one transaction),
  // or a replacement of a source that is cancelled refused.
  it('allows a replacement of a source cancelled before it, or in the same transaction', async () => {
    const cancelled = await request({ state: 'CANCELLED' });
    expect(await refusal(() => insertPickupRequest(admin, cloneOf(cancelled)))).toBeUndefined();

    const source = await confirmed();
    expect(
      await refusal(async () => {
        await insertPickupRequest(admin, cloneOf(source));
        await admin.query(
          `update pickup_request set state = 'CANCELLED', cancelled_at = now(), cancelled_by = $2 where id = $1`,
          [source, ARRANGER],
        );
      }),
    ).toBeUndefined();
  });

  // Break caught: the judgement made on the row as it was inserted and not as it ends, so that a replacement cancelled in the same
  // transaction (no longer active) is still refused for a source that stands.
  it('judges a replacement as it ends the transaction', async () => {
    const source = await confirmed();
    expect(
      await refusal(async () => {
        const clone = await insertPickupRequest(admin, cloneOf(source));
        await admin.query(
          `update pickup_request set state = 'CANCELLED', cancelled_at = now(), cancelled_by = $2 where id = $1`,
          [clone.id, ARRANGER],
        );
      }),
    ).toBeUndefined();
  });
});

describe('the rule of the replacement for a writer that cannot read the source', () => {
  /** The insert of an active replacement of `source`, in `hub`, as a staff context of that hub (the clone is theirs to make). */
  const insertClone = (source: string, hub: string, organization: string): string =>
    `insert into pickup_request (id, code, vendor_organization_id, sender_name, responsible_hub_id, pickup_intent, state, declared_package_count,
                                 resolved_pickup_location, primary_phone, scheduled_service_date, default_payer_intent, created_by, replaces_request_id)
     values ('${randomUUID()}', '${pickupRequestRow(organization, hub).code}', '${organization}', 'Fixture Sender', '${hub}', 'OWN_PACKAGES', 'PENDING', 3,
             '{"address":"Fixture shop"}'::jsonb, '+233200000001', '2026-11-03', 'RECIPIENT_PAYS', '${PRINCIPAL_1}', '${source}')`;

  // Break caught: the rule judged as the superuser sees it: a context that cannot read the source (the hub's staff cannot read another hub's
  // request) would then commit an active replacement of a request that may still be active. It fails closed, as a deny-by-default rule does.
  it('refuses at commit an active replacement of a source the writer cannot see, and accepts one whose source it can see cancelled', async () => {
    const context = staff('pickup.request.cancel', [HUB_B]);
    const hidden = await request({ state: 'CANCELLED' }, HUB_A);
    expect(await stateOf(context, insertClone(hidden, HUB_B, vendor2.organizationId))).toBe(
      '23514',
    );

    const visible = await request({ state: 'CANCELLED' }, HUB_B, vendor2);
    expect(await changed(context, insertClone(visible, HUB_B, vendor2.organizationId))).toBe(1);
  });
});
