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
  ARRANGED_CHECKER,
  ARRANGER,
  exceptionRow,
  insertOnePackageException,
  insertPickupRequest,
  pickupCode,
  pickupRequestRow,
} from './support/pickups.js';
import { buildService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * S1.16 against a real PostgreSQL: the one-package exception (migration 0051; domain-model.md section 6.2; data-scope-registry.md
 * `OnePackageException`; state-machines.md section 3; permissions.md section 6). The shape (constraints), the guard (what a request for an
 * exception may never change, and the one move it makes), the maker-checker backstop (the checker is not the maker unless the maker holds the
 * approval at the Platform Admin tier), and who reads, requests and decides it under row-level security and the column grants of the
 * runtime login. Arranged and changed as the cluster administrator where a constraint or a trigger is under test.
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

/** A request of one package: the only kind that has an exception. */
const single = async (hub = HUB_A, vendor = vendor1): Promise<string> =>
  (await insertPickupRequest(admin, pickupRequestRow(vendor.organizationId, hub, { packages: 1 })))
    .id;

const staff = (
  key: string,
  hubs: readonly string[] = [HUB_A],
  principalId = PRINCIPAL_1,
): SecurityContext => ({
  ...staffContext(hubs),
  principalId,
  authorizationKey: key,
});
const vendorOf = (organizationId: string, key: string): SecurityContext => ({
  ...vendorContext(organizationId),
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
    const result = await tx.execute(sql.raw('select id from one_package_exception'));
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

/** The SQLSTATE (and constraint) an administrator's statement ends with, rolled back, or `undefined` when it ran. */
const adminState = async (
  statement: string,
  values: unknown[] = [],
): Promise<{ code?: string; constraint?: string } | undefined> => {
  await admin.query('BEGIN');
  try {
    await admin.query(statement, values);
    return undefined;
  } catch (error) {
    const failure = error as { code?: string; constraint?: string };
    return { code: failure.code, constraint: failure.constraint };
  } finally {
    await admin.query('ROLLBACK');
  }
};

describe('the shape of an exception', () => {
  const insert = (requestId: string, over: Record<string, string> = {}): [string, unknown[]] => {
    const column = {
      state: 'REQUESTED',
      note: 'a note',
      recipient_name: 'Kofi',
      recipient_phone: '+233244000111',
      recipient_location: '{"address":"House 7"}',
      ...over,
    };
    return [
      `insert into one_package_exception (id, pickup_request_id, state, requested_by, note, recipient_name, recipient_phone, recipient_location)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        requestId,
        column.state,
        ARRANGER,
        column.note,
        column.recipient_name,
        column.recipient_phone,
        column.recipient_location,
      ],
    ];
  };

  // Break caught: an exception without its reason, its recipient or the address the rider delivers to (section 21.1 makes all three mandatory).
  it.each([
    ['a blank note', { note: '   ' }, ['one_package_exception_note_not_blank']],
    [
      'a blank recipient name',
      { recipient_name: ' ' },
      ['one_package_exception_recipient_not_blank'],
    ],
    [
      'a phone that is not international',
      { recipient_phone: '0244000111' },
      ['one_package_exception_phone_e164'],
    ],
    [
      'a location with no address',
      { recipient_location: '{"landmark":"by the market"}' },
      ['one_package_exception_location_has_address'],
    ],
    [
      'a location that is not an object',
      { recipient_location: '"House 7"' },
      ['one_package_exception_location_has_address'],
    ],
    // (A state the machine does not have also breaks the decision facts, which name the states; either check may be the one reported.)
    [
      'a state the machine does not have',
      { state: 'PENDING' },
      ['one_package_exception_state_closed', 'one_package_exception_decision_facts'],
    ],
  ])('refuses %s', async (_name, over, constraints) => {
    const [text, values] = insert(await single(), over);
    const refused = await adminState(text, values);
    expect(refused?.code).toBe('23514');
    expect(constraints).toContain(refused?.constraint);
  });

  // Break caught: a decided row with no checker, a requested one that already has one, or a fee on an exception that was never approved.
  it('keeps the facts of a decision together: a checker and a moment for a decided exception, neither for a requested one', async () => {
    const request = await single();
    const text = `insert into one_package_exception (id, pickup_request_id, state, requested_by, approved_by, decided_at, note, recipient_name, recipient_phone, recipient_location)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, 'n', 'Kofi', '+233244000111', '{"address":"x"}'::jsonb)`;
    const now = new Date('2026-11-02T09:30:00Z');
    const refused = { code: '23514', constraint: 'one_package_exception_decision_facts' };
    expect(await adminState(text, [request, 'APPROVED', ARRANGER, null, now])).toEqual(refused);
    expect(await adminState(text, [request, 'APPROVED', ARRANGER, ARRANGED_CHECKER, null])).toEqual(
      refused,
    );
    expect(await adminState(text, [request, 'REQUESTED', ARRANGER, ARRANGED_CHECKER, now])).toEqual(
      refused,
    );
    expect(
      await adminState(text, [request, 'APPROVED', ARRANGER, ARRANGED_CHECKER, now]),
    ).toBeUndefined();
  });

  it('allows a fee snapshot on an approved exception only', async () => {
    const request = await single();
    const fee = JSON.stringify({
      amount_minor: 2000,
      setting_key: 'single_package_pickup_fee',
      effective_version: '1',
    });
    const text = `insert into one_package_exception (id, pickup_request_id, state, requested_by, approved_by, decided_at, note, recipient_name, recipient_phone, recipient_location, single_package_fee_snapshot)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, 'n', 'Kofi', '+233244000111', '{"address":"x"}'::jsonb, $6::jsonb)`;
    const decided = ['APPROVED', ARRANGER, ARRANGED_CHECKER, new Date('2026-11-02T09:30:00Z')];
    expect(await adminState(text, [request, ...decided, fee])).toBeUndefined();
    expect(
      await adminState(text, [
        request,
        'REJECTED',
        ARRANGER,
        ARRANGED_CHECKER,
        new Date('2026-11-02T09:30:00Z'),
        fee,
      ]),
    ).toEqual({ code: '23514', constraint: 'one_package_exception_fee_only_when_approved' });
  });

  // Break caught: two live exceptions for one request (two approvers deciding two different recipients), or a refused one blocking a new request.
  it('allows one live exception for a request, and a new one after a refusal', async () => {
    const request = await single();
    await insertOnePackageException(admin, exceptionRow(request));
    const [text, values] = insert(request);
    expect(await adminState(text, values)).toEqual({
      code: '23505',
      constraint: 'one_package_exception_one_live',
    });
    const other = await single();
    await insertOnePackageException(admin, exceptionRow(other, { state: 'REJECTED' }));
    expect(await adminState(...insert(other))).toBeUndefined();
    await insertOnePackageException(admin, exceptionRow(other, { state: 'APPROVED' }));
    expect(await adminState(...insert(other))).toEqual({
      code: '23505',
      constraint: 'one_package_exception_one_live',
    });
  });

  // Break caught: a request pointing at the exception of another booking, which would let one approval confirm a different booking; or an
  // approval that cannot travel with its booking into the clone of a reschedule.
  it('lets a request name an exception raised for it, or the one the request it replaces carries, and no other', async () => {
    const mine = await single();
    const theirs = await single();
    const own = await insertOnePackageException(admin, exceptionRow(mine, { state: 'APPROVED' }));
    const foreign = await insertOnePackageException(
      admin,
      exceptionRow(theirs, { state: 'APPROVED' }),
    );
    const link = `update pickup_request set one_package_exception_id = $2 where id = $1`;
    const refused = { code: '23514', constraint: 'pickup_request_exception_chain' };
    // Raised for it: yes. Raised for another booking: no. One that does not exist: no (the trigger answers before the key does).
    expect(await adminState(link, [mine, foreign.id])).toEqual(refused);
    expect(await adminState(link, [mine, randomUUID()])).toEqual(refused);
    expect(await adminState(link, [mine, own.id])).toBeUndefined();
    await admin.query(link, [mine, own.id]);

    // And only one that was approved: the database holds the maker-checker rule even where a writer (any of the seven keys that update a
    // request) names an exception that is only asked for, or was refused, on its own request.
    const asked = await single();
    const refusedOne = await single();
    const requestedException = await insertOnePackageException(admin, exceptionRow(asked));
    const rejectedException = await insertOnePackageException(
      admin,
      exceptionRow(refusedOne, { state: 'REJECTED' }),
    );
    expect(await adminState(link, [asked, requestedException.id])).toEqual(refused);
    expect(await adminState(link, [refusedOne, rejectedException.id])).toEqual(refused);

    // The clone of a booking that carries its approval carries it too; the clone of one that carries none, or another booking's, may not.
    const replace = (replaces: string, exceptionId: string | undefined) =>
      adminState(
        `insert into pickup_request (id, code, vendor_organization_id, sender_name, responsible_hub_id, pickup_intent, state, declared_package_count,
                                     resolved_pickup_location, primary_phone, scheduled_service_date, default_payer_intent, created_by,
                                     replaces_request_id, one_package_exception_id)
         values (gen_random_uuid(), $1, $2, 'Fixture Sender', $3, 'OWN_PACKAGES', 'PENDING', 1, '{"address":"x"}'::jsonb, '+233200000001',
                 '2026-11-04', 'RECIPIENT_PAYS', $4, $5, $6)`,
        [pickupCode(), vendor1.organizationId, HUB_A, ARRANGER, replaces, exceptionId ?? null],
      );
    expect(await replace(mine, own.id)).toBeUndefined();
    expect(await replace(mine, foreign.id)).toEqual(refused);
    expect(await replace(theirs, own.id)).toEqual(refused);
    expect(await replace(theirs, undefined)).toBeUndefined();
  });
});

describe('the guard: what an exception may not change, and the one move it makes', () => {
  // Break caught: the recipient, the reason or the maker rewritten after the request (an approval must be of what was asked). Each change is
  // attempted in the act of deciding, which is legal in itself: a change made without a decision is also refused by the rule that a requested
  // exception changes only by being decided, and would hide a field the guard stopped protecting.
  it.each([
    ['its request', (other: string) => `pickup_request_id = '${other}'`],
    // (A third identity, so that the rule that the checker is not the maker cannot be the one that refuses it.)
    ['its maker', () => `requested_by = '5eed0000-0000-4000-8000-0000000000e3'`],
    ['its moment', () => `requested_at = requested_at - interval '1 day'`],
    ['its note', () => `note = 'something else'`],
    ['its recipient name', () => `recipient_name = 'Someone Else'`],
    ['its recipient phone', () => `recipient_phone = '+233200000999'`],
    ['its recipient address', () => `recipient_location = '{"address":"Elsewhere"}'::jsonb`],
  ])(
    'does not let an exception change %s, even in the act of deciding it',
    async (_name, change) => {
      const exception = await insertOnePackageException(admin, exceptionRow(await single()));
      // (Another request that exists, so that only the guard can be what refuses the change of the request.)
      const other = await single();
      const decide = (extra?: string): string =>
        `update one_package_exception set state = 'APPROVED', approved_by = '${ARRANGED_CHECKER}', decided_at = now()${
          extra === undefined ? '' : `, ${extra}`
        } where id = $1`;
      // The decision alone is accepted, so that it is the change and nothing else that is refused.
      expect(await adminState(decide(), [exception.id])).toBeUndefined();
      expect(await adminState(decide(change(other)), [exception.id])).toMatchObject({
        code: '23514',
      });
    },
  );

  // Break caught: an exception decided twice, reopened, or decided in a way the machine does not have.
  it('is decided once, as APPROVED or REJECTED, and frozen after', async () => {
    const decide = (
      id: string,
      to: string,
    ): Promise<{ code?: string; constraint?: string } | undefined> =>
      adminState(
        `update one_package_exception set state = $2, approved_by = $3, decided_at = now() where id = $1`,
        [id, to, ARRANGED_CHECKER],
      );
    const requested = await insertOnePackageException(admin, exceptionRow(await single()));
    expect(await decide(requested.id, 'APPROVED')).toBeUndefined();
    expect(await decide(requested.id, 'REJECTED')).toBeUndefined();
    expect(await decide(requested.id, 'REQUESTED')).toMatchObject({ code: '23514' });

    const approved = await insertOnePackageException(
      admin,
      exceptionRow(await single(), { state: 'APPROVED' }),
    );
    for (const to of ['REJECTED', 'REQUESTED', 'APPROVED']) {
      expect(await decide(approved.id, to), to).toMatchObject({ code: '23514' });
    }
    expect(
      await adminState(`update one_package_exception set approved_by = $2 where id = $1`, [
        approved.id,
        ARRANGER,
      ]),
    ).toMatchObject({ code: '23514' });
  });
});

describe('the checker is not the maker, unless the maker holds the approval at the Platform Admin tier (permissions.md section 6)', () => {
  // Break caught: a requester approving their own exception through any writer but the application (the trigger is the backstop).
  it('refuses a decision whose checker is its maker, for a maker the database cannot show to be a Platform Admin', async () => {
    const exception = await insertOnePackageException(admin, exceptionRow(await single()));
    const state = await adminState(
      `update one_package_exception set state = 'APPROVED', approved_by = requested_by, decided_at = now() where id = $1`,
      [exception.id],
    );
    expect(state).toEqual({
      code: '23514',
      constraint: 'one_package_exception_approver_is_not_requester',
    });
  });
});

describe('who reads an exception (the visibility of the request it belongs to)', () => {
  let inA: string;
  let inB: string;
  beforeAll(async () => {
    inA = (await insertOnePackageException(admin, exceptionRow(await single(HUB_A, vendor1)))).id;
    inB = (await insertOnePackageException(admin, exceptionRow(await single(HUB_B, vendor2)))).id;
  });

  // Break caught: an exception readable across hubs, by a vendor not the request's own, or under a key of a domain that does not read requests.
  it('shows staff the exceptions of the requests of the hubs of the grant, under a key of the domains that read requests', async () => {
    const ours = await idsOf(staff('pickup.read'));
    expect(ours).toContain(inA);
    expect(ours).not.toContain(inB);
    expect(await idsOf(staff('pickup.read', [HUB_B]))).toContain(inB);
    expect(await idsOf(staff('pickup.read', []))).toEqual([]);
    expect(await idsOf(staff('staff.read'))).toEqual([]);
    expect(await idsOf(staff('vendor.read'))).toEqual([]);
  });

  it('shows a vendor the exception of its own request and no other', async () => {
    expect(await idsOf(vendorOf(vendor1.organizationId, 'pickup.read'))).toContain(inA);
    expect(await idsOf(vendorOf(vendor1.organizationId, 'pickup.read'))).not.toContain(inB);
    expect(await idsOf(vendorOf(vendor2.organizationId, 'pickup.read'))).not.toContain(inA);
    expect(await idsOf(vendorOf(vendor1.organizationId, 'vendor.read'))).toEqual([]);
  });

  it('shows a rider, a SYSTEM context and a context with no key nothing', async () => {
    expect(await idsOf({ ...riderContext(RIDER_1), authorizationKey: 'pickup.read' })).toEqual([]);
    for (const capability of ['authentication', 'configuration', 'rate_limit'] as const) {
      expect(await idsOf(systemContext(capability)), capability).toEqual([]);
    }
    expect(await idsOf(staffContext([HUB_A, HUB_B]))).toEqual([]);
  });
});

describe('who requests an exception', () => {
  const request = (requestId: string, requestedBy: string, extra = ''): string =>
    `insert into one_package_exception (id, pickup_request_id, requested_by, note, recipient_name, recipient_phone, recipient_location${extra === '' ? '' : ', state'})
     values (gen_random_uuid(), '${requestId}', '${requestedBy}', 'a note', 'Kofi', '+233244000111', '{"address":"x"}'${extra === '' ? '' : `, '${extra}'`})`;

  // Break caught: an exception raised under the key of another operation, for a request of a hub outside the grant, or in someone else's name.
  it('lets staff request only under pickup.exception.request, for a request of a hub of the grant, in their own name', async () => {
    const mine = await single(HUB_A, vendor1);
    const elsewhere = await single(HUB_B, vendor2);
    const key = 'pickup.exception.request';
    expect(await stateOf(staff(key), request(mine, PRINCIPAL_1))).toBeUndefined();
    expect(await stateOf(staff(key), request(elsewhere, PRINCIPAL_1))).toBe('42501');
    expect(await stateOf(staff(key), request(await single(), PRINCIPAL_2))).toBe('42501');
    for (const other of [
      'pickup.exception.approve',
      'pickup.request.create',
      'pickup.request.confirm',
      'pickup.read',
    ]) {
      expect(await stateOf(staff(other), request(await single(), PRINCIPAL_1)), other).toBe(
        '42501',
      );
    }
  });

  // Break caught: a vendor, a rider or a SYSTEM context raising an exception (the vendor holds no such key: AC-03, section 35.2.4).
  it('refuses a vendor, a rider and a SYSTEM context', async () => {
    const mine = await single();
    expect(
      await stateOf(
        vendorOf(vendor1.organizationId, 'pickup.exception.request'),
        request(mine, PRINCIPAL_1),
      ),
    ).toBe('42501');
    expect(
      await stateOf(
        { ...riderContext(RIDER_1), authorizationKey: 'pickup.exception.request' },
        request(mine, PRINCIPAL_1),
      ),
    ).toBe('42501');
    expect(await stateOf(systemContext('configuration'), request(mine, PRINCIPAL_1))).toBe('42501');
  });

  // Break caught: the runtime writing a state or a decision at an insert (the columns it may write are the maker's, and nothing of the decision).
  it('does not let the runtime write a state, a checker or a fee when it requests', async () => {
    const mine = await single();
    expect(
      await stateOf(staff('pickup.exception.request'), request(mine, PRINCIPAL_1, 'APPROVED')),
    ).toBe('42501');
    expect(
      await stateOf(
        staff('pickup.exception.request'),
        `insert into one_package_exception (id, pickup_request_id, requested_by, approved_by, note, recipient_name, recipient_phone, recipient_location)
         values (gen_random_uuid(), '${mine}', '${PRINCIPAL_1}', '${PRINCIPAL_2}', 'n', 'Kofi', '+233244000111', '{"address":"x"}')`,
      ),
    ).toBe('42501');
  });
});

describe('who decides an exception', () => {
  const approve = (id: string, by: string): string =>
    `update one_package_exception set state = 'APPROVED', approved_by = '${by}', decided_at = now() where id = '${id}'`;

  // Break caught: a decision under the key of another operation, outside the hubs of the grant, or in another person's name.
  it('lets staff decide only under pickup.exception.approve, for a request of a hub of the grant, in their own name', async () => {
    const key = 'pickup.exception.approve';
    const fresh = async (hub = HUB_A, vendor = vendor1): Promise<string> =>
      (await insertOnePackageException(admin, exceptionRow(await single(hub, vendor)))).id;
    expect(
      await changed(staff(key, [HUB_A], PRINCIPAL_2), approve(await fresh(), PRINCIPAL_2)),
    ).toBe(1);
    // A request of another hub is not visible to the grant: the update changes nothing.
    expect(
      await changed(
        staff(key, [HUB_A], PRINCIPAL_2),
        approve(await fresh(HUB_B, vendor2), PRINCIPAL_2),
      ),
    ).toBe(0);
    // In another person's name: the check refuses.
    expect(
      await stateOf(staff(key, [HUB_A], PRINCIPAL_2), approve(await fresh(), PRINCIPAL_1)),
    ).toBe('42501');
    for (const other of ['pickup.exception.request', 'pickup.request.confirm', 'pickup.read']) {
      expect(
        await changed(staff(other, [HUB_A], PRINCIPAL_2), approve(await fresh(), PRINCIPAL_2)),
        other,
      ).toBe(0);
    }
  });

  // Break caught: a vendor deciding the exception of its own request, or the runtime rewriting the note or the recipient it decides.
  it('refuses a vendor, and keeps the columns of the request out of the decider’s reach', async () => {
    const id = (await insertOnePackageException(admin, exceptionRow(await single()))).id;
    expect(
      await changed(
        vendorOf(vendor1.organizationId, 'pickup.exception.approve'),
        approve(id, PRINCIPAL_2),
      ),
    ).toBe(0);
    const key = staff('pickup.exception.approve', [HUB_A], PRINCIPAL_2);
    for (const column of [
      "note = 'x'",
      "recipient_name = 'x'",
      "recipient_phone = '+233200000000'",
      "requested_by = '" + PRINCIPAL_2 + "'",
    ]) {
      expect(
        await stateOf(key, `update one_package_exception set ${column} where id = '${id}'`),
        column,
      ).toBe('42501');
    }
  });

  it('refuses the runtime a delete', async () => {
    const id = (await insertOnePackageException(admin, exceptionRow(await single()))).id;
    expect(
      await stateOf(
        staff('pickup.exception.approve'),
        `delete from one_package_exception where id = '${id}'`,
      ),
    ).toBe('42501');
  });
});

describe('the lock of a request that an exception is asked for', () => {
  const lock = (id: string): string =>
    `select id from pickup_request where id = '${id}' for update`;

  // Break caught: the request not found under the lock (a row lock must pass the UPDATE policy as well as the SELECT one), or found by a key
  // that has no business holding it, or found outside the hubs of the grant.
  it('lets the key that asks for an exception lock a request of its hubs, and no other key or hub', async () => {
    const mine = await single(HUB_A, vendor1);
    const elsewhere = await single(HUB_B, vendor2);
    const key = 'pickup.exception.request';
    expect(await changed(staff(key), lock(mine))).toBe(1);
    expect(await changed(staff(key), lock(elsewhere))).toBe(0);
    for (const other of ['pickup.read', 'pickup.exception.request.x']) {
      expect(await changed(staff(other), lock(mine)), other).toBe(0);
    }
    expect(await changed(vendorOf(vendor1.organizationId, key), lock(mine))).toBe(0);
  });

  // Break caught: the lock policy admitting a write, so that the key that asks for an exception could confirm or cancel a request.
  it('never lets that key change the request it locks', async () => {
    const mine = await single(HUB_A, vendor1);
    for (const change of [
      `secondary_phone = '+233200000001'`,
      `state = 'CANCELLED', cancelled_at = now(), cancelled_by = '${PRINCIPAL_1}'`,
      `one_package_exception_id = null`,
    ]) {
      expect(
        await stateOf(
          staff('pickup.exception.request'),
          `update pickup_request set ${change} where id = '${mine}'`,
        ),
        change,
      ).toBe('42501');
    }
  });
});
