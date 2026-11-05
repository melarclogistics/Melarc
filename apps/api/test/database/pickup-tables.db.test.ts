import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { DatabaseTransaction } from '../../src/platform/database/database.service.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import {
  HUB_A,
  HUB_B,
  RIDER_1,
  riderContext,
  staffContext,
  systemContext,
  vendorContext,
} from './support/rls-fixture.js';
import {
  ARRANGER,
  insertAdHocSender,
  insertPickupRequest,
  insertVendorLocation,
  pickupCode,
  pickupRequestRow,
} from './support/pickups.js';
import { buildService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * S1.10 and S1.13 against a real PostgreSQL: the vendor's saved locations and financial standing, the ad-hoc sender and the pickup
 * request (migration 0045; data-scope-registry.md `VendorPickupLocation`, `AdHocSender`, `PickupRequest`). Read and written as
 * `melarc_api_runtime` under each principal type and each authorization key, where row-level security is under test; arranged and
 * changed as the cluster administrator where a constraint or a trigger is (they bind a superuser too; row-level security does not).
 */
let database: TestDatabase;
let admin: pg.Client;
const vendor1 = vendorRow({ hubId: HUB_A });
const vendor2 = vendorRow({ hubId: HUB_B });
let requestA: string;
let requestB: string;
let requestOfVendor2: string;

beforeAll(async () => {
  database = await createTestDatabase();
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(
    `insert into hub (id, name) values ('${HUB_A}', 'Hub A'), ('${HUB_B}', 'Hub B')`,
  );
  await insertVendor(admin, vendor1);
  await insertVendor(admin, vendor2);
  requestA = (await insertPickupRequest(admin, pickupRequestRow(vendor1.organizationId, HUB_A))).id;
  requestB = (await insertPickupRequest(admin, pickupRequestRow(vendor1.organizationId, HUB_B))).id;
  requestOfVendor2 = (
    await insertPickupRequest(admin, pickupRequestRow(vendor2.organizationId, HUB_B))
  ).id;
  await insertVendorLocation(admin, vendor1.organizationId, { label: 'Shop', isDefault: true });
  await insertVendorLocation(admin, vendor2.organizationId, {
    label: 'Warehouse',
    isDefault: true,
  });
  await insertAdHocSender(admin, { phone: '+233241111111' });
});

afterAll(async () => {
  await admin.end();
  await database.drop();
});

const staff = (
  key: string,
  hubs: readonly string[] = [HUB_A],
  mode: 'SET' | 'ALL' = 'SET',
): SecurityContext => ({
  ...staffContext(hubs, mode),
  authorizationKey: key,
});
const vendorOf = (organizationId: string, key: string): SecurityContext => ({
  ...vendorContext(organizationId),
  authorizationKey: key,
});

/** Runs `work` in a transaction of the runtime login under `context`. */
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

const ids = async (context: SecurityContext, table: string): Promise<string[]> =>
  inContext(context, async (tx) => {
    const result = await tx.execute(sql.raw(`select id from ${table}`));
    return (result.rows as { id: string }[]).map((row) => row.id);
  });

/** The SQLSTATE a statement ends with under `context`, or `undefined` when it ran. */
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

/** How many rows a statement of the runtime login changed under `context` (an update the policy hides changes none). */
async function changed(context: SecurityContext, statement: string): Promise<number> {
  return inContext(context, async (tx) => {
    const result = await tx.execute(sql.raw(statement));
    return result.rowCount ?? 0;
  });
}

const adminState = async (
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

describe('who reads a pickup request (registry: staff by hub and operation key, a vendor its own, nobody else)', () => {
  // Break caught: a request readable across hubs, by a vendor not its own, or under a key of another domain.
  it('shows staff the requests of the hubs of the grant, under a key of the domains that read them', async () => {
    expect(await ids(staff('pickup.read'), 'pickup_request')).toEqual([requestA]);
    expect((await ids(staff('pickup.read', [HUB_A, HUB_B]), 'pickup_request')).toSorted()).toEqual(
      [requestA, requestB, requestOfVendor2].toSorted(),
    );
    expect(await ids(staff('pickup.read', [], 'ALL'), 'pickup_request')).toHaveLength(3);
    expect(await ids(staff('pickup.read', []), 'pickup_request')).toEqual([]);
    for (const key of ['hub.read', 'pricing.read', 'fleet.custody.read']) {
      expect(await ids(staff(key), 'pickup_request'), key).toEqual([requestA]);
    }
    for (const key of ['staff.read', 'vendor.read', 'settings.reason.read']) {
      expect(await ids(staff(key), 'pickup_request'), key).toEqual([]);
    }
  });

  it('shows a vendor its own organisation’s requests under a pickup or pricing key, never another’s and never by hub', async () => {
    expect(
      (await ids(vendorOf(vendor1.organizationId, 'pickup.read'), 'pickup_request')).toSorted(),
    ).toEqual([requestA, requestB].toSorted());
    expect(await ids(vendorOf(vendor2.organizationId, 'pickup.read'), 'pickup_request')).toEqual([
      requestOfVendor2,
    ]);
    expect(
      await ids(vendorOf(vendor1.organizationId, 'pricing.read'), 'pickup_request'),
    ).toHaveLength(2);
    expect(await ids(vendorOf(vendor1.organizationId, 'vendor.read'), 'pickup_request')).toEqual(
      [],
    );
  });

  it('shows a rider, a SYSTEM context and a context with no key nothing', async () => {
    expect(
      await ids({ ...riderContext(RIDER_1), authorizationKey: 'pickup.read' }, 'pickup_request'),
    ).toEqual([]);
    for (const capability of ['authentication', 'configuration', 'rate_limit'] as const) {
      expect(await ids(systemContext(capability), 'pickup_request'), capability).toEqual([]);
    }
    expect(await ids(staffContext([HUB_A, HUB_B]), 'pickup_request')).toEqual([]);
  });
});

describe('who creates a pickup request', () => {
  const insert = (hub: string, vendorOrg: string, extra = ''): string =>
    `insert into pickup_request (id, code, vendor_organization_id, sender_name, responsible_hub_id, pickup_intent, state, declared_package_count,
       resolved_pickup_location, primary_phone, scheduled_service_date, default_payer_intent, created_by${extra === '' ? '' : ', state'})
     values (gen_random_uuid(), '${pickupCode()}', '${vendorOrg}', 'Fixture Sender', '${hub}', 'OWN_PACKAGES', 'PENDING', 3,
       '{"address":"x"}', '+233200000009', '2026-11-04', 'RECIPIENT_PAYS', '${ARRANGER}'${extra})`;

  // Break caught: staff creating in a hub the grant does not reach, or under the key of an operation that makes no request. The operations
  // that make one are the booking and the clone of a replacement (0045: the cancellations and the failure's resolution; 0050: the
  // reschedule of a late booking, which runs under the confirmation's key); a read, a waiver and an approval make none.
  it('lets staff create only under the key of an operation that makes a request, and only in a hub of the grant', async () => {
    for (const key of ['pickup.request.create', 'pickup.request.confirm']) {
      expect(await stateOf(staff(key), insert(HUB_A, vendor1.organizationId)), key).toBeUndefined();
      expect(await stateOf(staff(key), insert(HUB_B, vendor2.organizationId)), key).toBe('42501');
    }
    for (const key of [
      'pickup.read',
      'pickup.cancellation_charge.waive',
      'pickup.exception.approve',
    ]) {
      expect(await stateOf(staff(key), insert(HUB_A, vendor1.organizationId)), key).toBe('42501');
    }
  });

  // Break caught: a vendor creating for another organisation, or creating a request that is not PENDING.
  it('lets a vendor create only for its own organisation, under pickup.request.create, as PENDING', async () => {
    expect(
      await stateOf(
        vendorOf(vendor1.organizationId, 'pickup.request.create'),
        insert(HUB_A, vendor1.organizationId),
      ),
    ).toBeUndefined();
    expect(
      await stateOf(
        vendorOf(vendor1.organizationId, 'pickup.request.create'),
        insert(HUB_B, vendor2.organizationId),
      ),
    ).toBe('42501');
    expect(
      await stateOf(
        vendorOf(vendor1.organizationId, 'pickup.read'),
        insert(HUB_A, vendor1.organizationId),
      ),
    ).toBe('42501');
  });

  it('lets nobody else create: a rider, a SYSTEM context, a recipient-less context', async () => {
    const statement = insert(HUB_A, vendor1.organizationId);
    expect(
      await stateOf(
        { ...riderContext(RIDER_1), authorizationKey: 'pickup.request.create' },
        statement,
      ),
    ).toBe('42501');
    expect(await stateOf(systemContext('authentication'), statement)).toBe('42501');
    expect(await stateOf(systemContext('configuration'), statement)).toBe('42501');
  });
});

describe('who changes a pickup request', () => {
  let pending: string;
  let confirmed: string;
  beforeAll(async () => {
    pending = (await insertPickupRequest(admin, pickupRequestRow(vendor1.organizationId, HUB_A)))
      .id;
    confirmed = (
      await insertPickupRequest(
        admin,
        pickupRequestRow(vendor1.organizationId, HUB_A, { state: 'CONFIRMED' }),
      )
    ).id;
  });

  const touch = (id: string): string =>
    `update pickup_request set secondary_phone = '+233200000008' where id = '${id}'`;

  // Break caught: staff changing a request of another hub, or under a key that does not change requests.
  it('lets staff change a request only of a hub of the grant and only under the key of an operation that does', async () => {
    expect(await changed(staff('pickup.request.confirm'), touch(pending))).toBe(1);
    expect(await changed(staff('pickup.request.confirm'), touch(requestB))).toBe(0);
    expect(await stateOf(staff('pickup.read'), touch(pending))).toBeUndefined();
    expect(await changed(staff('pickup.read'), touch(pending))).toBe(0);
    expect(await changed(staff('pickup.exception.approve'), touch(pending))).toBe(1);
  });

  // Break caught: a vendor cancelling a confirmed request (AC-SLICE-001-05), another vendor's, or changing anything but by cancelling.
  it('lets a vendor change its own PENDING request under pickup.request.cancel and nothing else', async () => {
    const own = vendorOf(vendor1.organizationId, 'pickup.request.cancel');
    expect(await changed(own, touch(pending))).toBe(1);
    expect(await changed(own, touch(confirmed))).toBe(0);
    expect(
      await changed(vendorOf(vendor2.organizationId, 'pickup.request.cancel'), touch(pending)),
    ).toBe(0);
    expect(await changed(vendorOf(vendor1.organizationId, 'pickup.read'), touch(pending))).toBe(0);
  });

  it('lets nobody delete one', async () => {
    expect(
      await stateOf(
        staff('pickup.request.cancel', [], 'ALL'),
        `delete from pickup_request where id = '${pending}'`,
      ),
    ).toBe('42501');
    expect(
      await stateOf(
        vendorOf(vendor1.organizationId, 'pickup.request.cancel'),
        `delete from pickup_request where id = '${pending}'`,
      ),
    ).toBe('42501');
  });
});

describe('the guard of a pickup request (it binds every login, the administrator included)', () => {
  const fresh = async (overrides: Parameters<typeof pickupRequestRow>[2] = {}): Promise<string> =>
    (await insertPickupRequest(admin, pickupRequestRow(vendor1.organizationId, HUB_A, overrides)))
      .id;

  // Break caught: the identity of a request, its sender, its hub or its place in the chain changed after the fact.
  it.each([
    ['its code', `code = '${pickupCode()}'`],
    ['its hub', `responsible_hub_id = '${HUB_B}'`],
    ['its sender', `vendor_organization_id = '${vendor2.organizationId}'`],
    ['its package count', 'declared_package_count = 9'],
    ['its attempt number', 'attempt_number = 2'],
    ['its intent', `pickup_intent = 'COLLECT_FOR_VENDOR'`],
  ])('refuses a change of %s', async (_label, assignment) => {
    const id = await fresh();
    expect(await adminState(`update pickup_request set ${assignment} where id = $1`, [id])).toBe(
      '23514',
    );
  });

  // Break caught: a state the machine does not allow (DECLINED is not built; a cancelled request is not confirmed again).
  it('allows PENDING to CONFIRMED, PENDING to CANCELLED and CONFIRMED to CANCELLED, and no other move', async () => {
    const toConfirmed = `state = 'CONFIRMED', confirmed_at = now(), confirmed_by = '${ARRANGER}'`;
    const toCancelled = `state = 'CANCELLED', cancelled_at = now(), cancelled_by = '${ARRANGER}'`;
    expect(
      await adminState(`update pickup_request set ${toConfirmed} where id = $1`, [await fresh()]),
    ).toBeUndefined();
    expect(
      await adminState(`update pickup_request set ${toCancelled} where id = $1`, [await fresh()]),
    ).toBeUndefined();
    expect(
      await adminState(`update pickup_request set ${toCancelled} where id = $1`, [
        await fresh({ state: 'CONFIRMED' }),
      ]),
    ).toBeUndefined();
    expect(
      await adminState(`update pickup_request set state = 'DECLINED' where id = $1`, [
        await fresh(),
      ]),
    ).toBe('23514');
    expect(
      await adminState(`update pickup_request set state = 'PENDING' where id = $1`, [
        await fresh({ state: 'CONFIRMED' }),
      ]),
    ).toBe('23514');
    expect(
      await adminState(`update pickup_request set ${toConfirmed} where id = $1`, [
        await fresh({ state: 'CANCELLED' }),
      ]),
    ).toBe('23514');
  });

  // Break caught: a cancelled request edited, or a charge waived that was never applied.
  it('freezes a cancelled request but for the waiver of its applied charge', async () => {
    const SNAPSHOT =
      '{"amount_minor":2000,"setting_key":"cancellation_charge_amount","effective_version":"1"}';
    // A cancelled request whose charge was applied, arranged as the table holds it (an insert is not guarded; an update is).
    const applied = async (): Promise<string> => {
      const id = await fresh({ state: 'CANCELLED' });
      await admin.query('ALTER TABLE pickup_request DISABLE TRIGGER pickup_request_guard');
      try {
        await admin.query(
          `update pickup_request set cancellation_charge_outcome = 'APPLIED', cancellation_charge_snapshot = $2::jsonb where id = $1`,
          [id, SNAPSHOT],
        );
      } finally {
        await admin.query('ALTER TABLE pickup_request ENABLE TRIGGER pickup_request_guard');
      }
      return id;
    };
    const cancelled = await fresh({ state: 'CANCELLED' });
    expect(
      await adminState(
        `update pickup_request set secondary_phone = '+233200000001' where id = $1`,
        [cancelled],
      ),
    ).toBe('23514');
    // No charge applied: nothing to waive.
    expect(
      await adminState(
        `update pickup_request set cancellation_charge_outcome = 'WAIVED', cancellation_charge_waived_by = '${ARRANGER}' where id = $1`,
        [cancelled],
      ),
    ).toBe('23514');
    // An applied charge is waived in full, with the actor and the note, and the snapshot stays readable.
    const id = await applied();
    expect(
      await adminState(
        `update pickup_request set cancellation_charge_outcome = 'WAIVED', cancellation_charge_waived_by = '${ARRANGER}',
            cancellation_charge_waiver_note = 'Goodwill' where id = $1`,
        [id],
      ),
    ).toBeUndefined();
    // The waiver changes nothing but the waiver: a waiver that also edits the request is refused.
    const second = await applied();
    expect(
      await adminState(
        `update pickup_request set cancellation_charge_outcome = 'WAIVED', cancellation_charge_waived_by = '${ARRANGER}',
            secondary_phone = '+233200000002' where id = $1`,
        [second],
      ),
    ).toBe('23514');
    // And a waived charge is not waived again, nor applied again.
    await admin.query('ALTER TABLE pickup_request DISABLE TRIGGER pickup_request_guard');
    await admin.query(
      `update pickup_request set cancellation_charge_outcome = 'WAIVED', cancellation_charge_waived_by = '${ARRANGER}' where id = $1`,
      [second],
    );
    await admin.query('ALTER TABLE pickup_request ENABLE TRIGGER pickup_request_guard');
    expect(
      await adminState(
        `update pickup_request set cancellation_charge_outcome = 'APPLIED', cancellation_charge_waived_by = null where id = $1`,
        [second],
      ),
    ).toBe('23514');
    const row = await admin.query<{ snapshot: unknown }>(
      `select cancellation_charge_snapshot as snapshot from pickup_request where id = $1`,
      [id],
    );
    expect(row.rows[0]?.snapshot).toEqual(JSON.parse(SNAPSHOT));
  });

  it('moves the version of the record when anything about it changes, and only then', async () => {
    const id = await fresh();
    const read = async (): Promise<number> =>
      Number(
        (
          await admin.query<{ version: number }>(
            `select version from pickup_request where id = $1`,
            [id],
          )
        ).rows[0]?.version,
      );
    expect(await read()).toBe(1);
    await admin.query(`update pickup_request set secondary_phone = '+233200000007' where id = $1`, [
      id,
    ]);
    expect(await read()).toBe(2);
    await admin.query(`update pickup_request set secondary_phone = '+233200000007' where id = $1`, [
      id,
    ]);
    expect(await read()).toBe(2);
    await admin.query(`update pickup_request set version = 99 where id = $1`, [id]);
    expect(await read()).toBe(2);
  });
});

describe('the constraints of a pickup request', () => {
  const values = (overrides: Record<string, string>): string => {
    const base: Record<string, string> = {
      id: `'${crypto.randomUUID()}'`,
      code: `'${pickupCode()}'`,
      vendor_organization_id: `'${vendor1.organizationId}'`,
      ad_hoc_sender_id: 'null',
      sender_name: `'Fixture Sender'`,
      responsible_hub_id: `'${HUB_A}'`,
      pickup_intent: `'OWN_PACKAGES'`,
      state: `'PENDING'`,
      declared_package_count: '3',
      resolved_pickup_location: `'{"address":"x"}'`,
      primary_phone: `'+233200000009'`,
      scheduled_service_date: `'2026-11-04'`,
      default_payer_intent: `'RECIPIENT_PAYS'`,
      created_by: `'${ARRANGER}'`,
      ...overrides,
    };
    return `insert into pickup_request (${Object.keys(base).join(', ')}) values (${Object.values(base).join(', ')})`;
  };
  const refused = async (overrides: Record<string, string>): Promise<string | undefined> =>
    adminState(values(overrides));

  it('accepts a well-formed request', async () => {
    expect(await refused({})).toBeUndefined();
  });

  // Break caught: each invariant of domain-model section 6.2 that the table holds, refused by name.
  it.each([
    ['a code that is not an operational code', { code: `'ACC-PR-0O1I1L'` }],
    ['a request with no sender', { vendor_organization_id: 'null' }],
    ['a request with two senders', { ad_hoc_sender_id: `'${crypto.randomUUID()}'` }],
    [
      'one package CONFIRMED with no exception',
      {
        declared_package_count: '1',
        state: `'CONFIRMED'`,
        confirmed_at: 'now()',
        confirmed_by: `'${ARRANGER}'`,
      },
    ],
    ['no package', { declared_package_count: '0' }],
    ['a collection with no collection point', { pickup_intent: `'COLLECT_FOR_VENDOR'` }],
    ['a SPLIT with no basis', { default_payer_intent: `'SPLIT'` }],
    ['a basis with no SPLIT', { split_basis: `'FIXED_AMOUNT'`, split_sender_amount_minor: '100' }],
    ['a cap acknowledgement with no snapshot', { liability_cap_acknowledged_at: 'now()' }],
    [
      'a charge outcome on a request that is not cancelled',
      { cancellation_charge_outcome: `'NOT_APPLIED'` },
    ],
    ['an intent that does not exist', { pickup_intent: `'SOMETHING'` }],
    ['an attempt number of zero', { attempt_number: '0' }],
  ])('refuses %s', async (_label, overrides) => {
    expect(await refused(overrides)).toMatch(/^23/);
  });

  it('accepts a one-package request while it is PENDING, waiting for its exception', async () => {
    expect(await refused({ declared_package_count: '1' })).toBeUndefined();
  });

  it('holds the chain to a line: a request is replaced at most once', async () => {
    const source = (
      await insertPickupRequest(admin, pickupRequestRow(vendor1.organizationId, HUB_A))
    ).id;
    expect(
      await refused({ replaces_request_id: `'${source}'`, attempt_number: '2' }),
    ).toBeUndefined();
    await admin.query('BEGIN');
    await admin
      .query(
        values({
          replaces_request_id: `'${source}'`,
          attempt_number: '2',
          code: `'${pickupCode()}'`,
        }),
      )
      .catch(() => undefined);
    await admin.query('ROLLBACK');
  });
});

describe('the saved locations, the ad-hoc sender and the standing', () => {
  it('shows a location to staff under a pickup or vendor key, to a vendor its own only, and to nobody else', async () => {
    const own = vendorOf(vendor1.organizationId, 'vendor.pickup_location.manage');
    expect(await ids(own, 'vendor_pickup_location')).toHaveLength(1);
    expect(
      await ids(staff('vendor.pickup_location.manage'), 'vendor_pickup_location'),
    ).toHaveLength(2);
    expect(await ids(staff('pickup.request.create'), 'vendor_pickup_location')).toHaveLength(2);
    expect(await ids(staff('staff.read'), 'vendor_pickup_location')).toEqual([]);
    expect(
      await ids(
        { ...riderContext(RIDER_1), authorizationKey: 'pickup.read' },
        'vendor_pickup_location',
      ),
    ).toEqual([]);
  });

  it('lets nobody write a location or a standing through the runtime: the rows come from fixtures', async () => {
    const statement = `insert into vendor_pickup_location (id, vendor_organization_id, label, location, created_by)
       values (gen_random_uuid(), '${vendor1.organizationId}', 'x', '{"address":"x"}', '${ARRANGER}')`;
    expect(await stateOf(staff('vendor.pickup_location.manage', [], 'ALL'), statement)).toBe(
      '42501',
    );
    expect(
      await stateOf(vendorOf(vendor1.organizationId, 'vendor.pickup_location.manage'), statement),
    ).toBe('42501');
  });

  // Break caught: two defaults at once, a default that is not active, a location with no address.
  it('keeps exactly one default among a vendor’s active locations, and an address on each', async () => {
    const org = vendor1.organizationId;
    expect(
      await adminState(
        `insert into vendor_pickup_location (id, vendor_organization_id, label, location, is_default, created_by)
       values (gen_random_uuid(), $1, 'Second default', '{"address":"y"}', true, $2)`,
        [org, ARRANGER],
      ),
    ).toBe('23505');
    expect(
      await adminState(
        `insert into vendor_pickup_location (id, vendor_organization_id, label, location, is_default, active, created_by)
       values (gen_random_uuid(), $1, 'Retired default', '{"address":"y"}', true, false, $2)`,
        [org, ARRANGER],
      ),
    ).toBe('23514');
    expect(
      await adminState(
        `insert into vendor_pickup_location (id, vendor_organization_id, label, location, created_by)
       values (gen_random_uuid(), $1, 'No address', '{"landmark":"y"}', $2)`,
        [org, ARRANGER],
      ),
    ).toBe('23514');
  });

  it('shows an ad-hoc sender to staff under a pickup or vendor key and to nobody else, and creates one only under pickup.request.create', async () => {
    expect(await ids(staff('vendor.read'), 'ad_hoc_sender')).toHaveLength(1);
    expect(await ids(staff('staff.read'), 'ad_hoc_sender')).toEqual([]);
    expect(await ids(vendorOf(vendor1.organizationId, 'pickup.read'), 'ad_hoc_sender')).toEqual([]);
    const insert = `insert into ad_hoc_sender (id, name, phone, phone_as_entered, created_by)
       values (gen_random_uuid(), 'Kofi', '+233242222222', '024 222 2222', '${ARRANGER}')`;
    expect(await stateOf(staff('pickup.request.create'), insert)).toBeUndefined();
    expect(
      await stateOf(staff('vendor.read'), insert.replace('+233242222222', '+233243333333')),
    ).toBe('42501');
    expect(
      await stateOf(
        vendorOf(vendor1.organizationId, 'pickup.request.create'),
        insert.replace('+233242222222', '+233244444444'),
      ),
    ).toBe('42501');
  });

  // Break caught: the phone identity not unique, or a phone that is not E.164.
  it('holds a phone identity to one sender and to the E.164 form', async () => {
    expect(
      await adminState(
        `insert into ad_hoc_sender (id, name, phone, phone_as_entered, created_by) values (gen_random_uuid(), 'Dup', '+233241111111', 'x', $1)`,
        [ARRANGER],
      ),
    ).toBe('23505');
    expect(
      await adminState(
        `insert into ad_hoc_sender (id, name, phone, phone_as_entered, created_by) values (gen_random_uuid(), 'Bad', '0241111112', 'x', $1)`,
        [ARRANGER],
      ),
    ).toBe('23514');
  });

  it('reads a vendor’s standing for staff and for that vendor only, and defaults to GOOD', async () => {
    await admin.query(
      `insert into vendor_financial_standing (vendor_organization_id) values ($1)`,
      [vendor1.organizationId],
    );
    const rows = async (context: SecurityContext): Promise<string[]> =>
      inContext(context, async (tx) => {
        const result = await tx.execute(
          sql.raw('select vendor_organization_id, financial_status from vendor_financial_standing'),
        );
        return (result.rows as { financial_status: string }[]).map((row) => row.financial_status);
      });
    expect(await rows(vendorOf(vendor1.organizationId, 'pickup.request.create'))).toEqual(['GOOD']);
    expect(await rows(vendorOf(vendor2.organizationId, 'pickup.request.create'))).toEqual([]);
    expect(await rows(staff('pickup.request.confirm'))).toEqual(['GOOD']);
    expect(
      await adminState(
        `update vendor_financial_standing set financial_status = 'LATE' where vendor_organization_id = $1`,
        [vendor1.organizationId],
      ),
    ).toBe('23514');
  });
});

describe('the vendor organisation, for a booking', () => {
  // Break caught: a booking unable to name its vendor (staff under a pickup key reading no organisation), or the master readable under a key
  // of another domain, or a vendor reading another vendor's record.
  it('is read by staff under a pickup key, by a vendor for its own record only, and by no one under another key', async () => {
    const both = [vendor1.organizationId, vendor2.organizationId].toSorted();
    expect((await ids(staff('pickup.request.create'), 'vendor_organization')).toSorted()).toEqual(
      both,
    );
    expect((await ids(staff('pickup.read'), 'vendor_organization')).toSorted()).toEqual(both);
    expect(await ids(staff('staff.read'), 'vendor_organization')).toEqual([]);
    expect(
      await ids(vendorOf(vendor1.organizationId, 'pickup.read'), 'vendor_organization'),
    ).toEqual([vendor1.organizationId]);
    expect(
      await ids(
        { ...riderContext(RIDER_1), authorizationKey: 'pickup.read' },
        'vendor_organization',
      ),
    ).toEqual([]);
  });
});

describe('the hub, for the configuration capability', () => {
  // Break caught: a hub unreadable to the capability that needs its name for an operational code, or readable to a capability that
  // has no business with it (the authentication capability already reads it, to place a staff member; that is not new).
  it('is read by the configuration capability (and by authentication, as before) and by no other SYSTEM context', async () => {
    expect((await ids(systemContext('configuration'), 'hub')).toSorted()).toEqual(
      [HUB_A, HUB_B].toSorted(),
    );
    for (const capability of ['rate_limit'] as const) {
      expect(await ids(systemContext(capability), 'hub'), capability).toEqual([]);
    }
  });
});

describe('the vendor organisation, for the saved locations (migration 0049)', () => {
  // Break caught: the key that manages a vendor's locations unable to see the organisation it manages (the existence rule would then
  // answer every Ops member "not found"), seeing every hub's, or the probe policy letting a staff member read what it may not.
  it('shows staff under the manage key the organisations of the hubs of the grant only', async () => {
    const manage = 'vendor.pickup_location.manage';
    expect(await ids(staff(manage, [HUB_A]), 'vendor_organization')).toEqual([
      vendor1.organizationId,
    ]);
    expect(await ids(staff(manage, [HUB_B]), 'vendor_organization')).toEqual([
      vendor2.organizationId,
    ]);
    expect((await ids(staff(manage, [], 'ALL'), 'vendor_organization')).toSorted()).toEqual(
      [vendor1.organizationId, vendor2.organizationId].toSorted(),
    );
    expect(await ids(staff(manage, []), 'vendor_organization')).toEqual([]);
    expect(await ids(staff('staff.read', [HUB_A]), 'vendor_organization')).toEqual([]);
  });

  // The probe's behaviour (one record of another hub readable by id, so that `HUB_SCOPE_VIOLATION` is told from `NOT_FOUND`) is set through its
  // own mechanism (scope-probe.ts), not through the context, and is proved through the real routes (`pickup-lookups-routes`); here the
  // policy that serves it is shown to exist, beside the manage key's, and to be for reads only.
  it('has the scope probe’s policy for reads only, beside the manage key’s', async () => {
    const policies = await admin.query<{ policyname: string; cmd: string }>(
      `select policyname, cmd from pg_policies where tablename = 'vendor_organization' order by policyname`,
    );
    expect(policies.rows.map((row) => row.policyname)).toEqual(
      expect.arrayContaining([
        'vendor_organization_probe',
        'vendor_organization_location_manage_read',
      ]),
    );
    expect(policies.rows.find((row) => row.policyname === 'vendor_organization_probe')?.cmd).toBe(
      'SELECT',
    );
  });
});
