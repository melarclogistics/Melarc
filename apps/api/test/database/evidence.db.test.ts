import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { guardReasonIn, serverErrorIn } from '../../src/platform/database/database-failures.js';
import { createScopeProbe } from '../../src/platform/database/scope-probe.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { SETTINGS } from '../../src/tools/seed/settings.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { HUB_A, HUB_B } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.11 (migration `0080`; domain-model.md section 3.6; state-machines.md section 17; the security matrix's Family M): what the database holds for **every**
 * writer of the evidence record, and who reads it.
 *
 * - **Declaration**: the rider under the key of the act it evidences (`pickup.failure.report`), for a stop it has arrived at on a run in progress that is assigned to it.
 *   The hub and the vendor organisation are DERIVED from the stop whatever the writer gives (GBT-M9); the instants are the database's; the record is PENDING_UPLOAD.
 * - **Reading**: the capturing rider; the staff of the stop's hub under `pickup.read`; nobody else (a staff set of another hub, another key, a vendor).
 * - **Completion**: PENDING_UPLOAD to STORED before the window ends, with a signature that names the declared type; to EXPIRED after it; then final; nothing deletes.
 * - **Family M** (GBT-M3, M5 to M8): the constraints of owner-aware scope, and the read that does not turn a vendor-owned object into a hub-wide one.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const FAILURE = 'pickup.failure.report';
const CORRELATION = 'evidence';

const rider = (riderId: string, key: string = FAILURE): SecurityContext => ({
  principalType: 'RIDER',
  principalId: riderId,
  sessionId: randomUUID(),
  surface: 'RIDER_ANDROID',
  riderId,
  authorizationKey: key,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: CORRELATION,
});
const staff = (key: string, hubs: readonly string[] | 'ALL' = 'ALL'): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  sessionId: randomUUID(),
  surface: 'OPS_PORTAL',
  authorizationKey: key,
  hubScopeMode: hubs === 'ALL' ? 'ALL' : 'SET',
  authorizedHubIds: hubs === 'ALL' ? [] : [...hubs],
  correlationId: CORRELATION,
});
const vendor = (): SecurityContext => ({
  principalType: 'VENDOR',
  principalId: vendorA.row.accountId,
  sessionId: randomUUID(),
  surface: 'VENDOR_PWA',
  authorizationKey: FAILURE,
  vendorOrganizationId: vendorA.row.organizationId,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: CORRELATION,
});

interface Result {
  readonly rows?: Record<string, unknown>[];
  readonly code?: string;
  readonly reason?: string;
}

async function attempt(context: SecurityContext, text: string): Promise<Result> {
  try {
    const rows = await routes.built.service.transactionWithContext(context, async (tx) => {
      return (await tx.execute(sql.raw(text))).rows;
    });
    return { rows };
  } catch (error) {
    const reason = guardReasonIn(error);
    return {
      code: serverErrorIn(error)?.code ?? 'other',
      ...(reason === undefined ? {} : { reason }),
    };
  }
}

/** The guard (a BEFORE trigger, 23514), a column privilege or the policy's check (42501) and a constraint (23514) each refuse. */
const REFUSED = ['42501', '23514'] as const;
const refused = (result: Result): void => {
  expect(result.code, JSON.stringify(result)).toBeDefined();
  expect(REFUSED).toContain(result.code);
};
const reached = (result: Result): Record<string, unknown> => {
  expect(result.code, JSON.stringify(result)).toBeUndefined();
  expect(result.rows?.length, JSON.stringify(result)).toBe(1);
  return result.rows?.[0] ?? {};
};
const hidden = (result: Result): void => {
  expect(result.code, JSON.stringify(result)).toBeUndefined();
  expect(result.rows, JSON.stringify(result)).toEqual([]);
};

const run = (over: Partial<Parameters<typeof arrangeRun>[2]> = {}): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 2,
    stopStates: ['ARRIVED', 'PENDING'],
    ...over,
  });
const stopOf = (arranged: ArrangedRun, index = 0): string => {
  const stop = arranged.stops[index];
  if (stop === undefined) throw new Error('stop');
  return stop.id;
};

type Column = Record<string, string>;
/** The SQL text of a declaration by `riderId` for `stopId`; `over` replaces a column by its SQL literal. */
function declaration(riderId: string, stopId: string, over: Column = {}): string {
  const values: Column = {
    id: `'${randomUUID()}'`,
    owner_type: `'PICKUP_STOP'`,
    owner_id: `'${stopId}'`,
    purpose: `'COLLECTION_PROOF'`,
    captured_at: `now() - interval '1 minute'`,
    captured_by_actor: `'${riderId}'`,
    captured_by_principal_type: `'RIDER'`,
    storage_ref: `'ev/${randomBytes(16).toString('hex')}'`,
    access_rule: `'SUBJECT_READERS'`,
    retention_policy: `'PICKUP_STOP_EVIDENCE'`,
    content_type: `'image/jpeg'`,
    byte_size: '1000',
    checksum_sha256: `'${'a'.repeat(64)}'`,
    upload_ttl_seconds: '900',
    upload_expires_at: 'now()',
    ...over,
  };
  const names = Object.keys(values);
  return `insert into evidence (${names.join(', ')}) values (${names.map((name) => values[name]).join(', ')})
    returning id, state, responsible_hub_id, vendor_organization_id, created_at, upload_expires_at, uploaded_at, version, extract(epoch from (upload_expires_at - created_at)) as window_seconds`;
}

/** A record declared by the rider, as the application would. */
async function declared(arranged: ArrangedRun, over: Column = {}): Promise<{ id: string }> {
  const row = reached(
    await attempt(rider(arranged.rider.id), declaration(arranged.rider.id, stopOf(arranged), over)),
  );
  return { id: String(row.id) };
}

/** The window of a record moved into the past, as a test of expiry needs: the guard is switched off for the one statement that does it. */
async function aged(id: string): Promise<void> {
  await routes.admin.query('alter table evidence disable trigger evidence_guard');
  try {
    await routes.admin.query(
      `update evidence set created_at = now() - interval '2 hours', upload_expires_at = now() - interval '1 hour' where id = $1`,
      [id],
    );
  } finally {
    await routes.admin.query('alter table evidence enable trigger evidence_guard');
  }
}

describe('the rider declares evidence for a stop it has arrived at', () => {
  it('derives the hub and the vendor organisation from the stop and takes the instants from the database', async () => {
    const arranged = await run();
    const row = reached(
      await attempt(rider(arranged.rider.id), declaration(arranged.rider.id, stopOf(arranged))),
    );
    expect(row.state).toBe('PENDING_UPLOAD');
    expect(row.responsible_hub_id).toBe(HUB_A);
    expect(row.vendor_organization_id).toBe(vendorA.row.organizationId);
    expect(row.version).toBe(1);
    expect(row.uploaded_at).toBeNull();
    // The window is the lifetime granted, counted from the database's own creation instant, to the second.
    expect(Number(row.window_seconds)).toBe(900);
    const age = Date.now() - new Date(String(row.created_at)).getTime();
    expect(age).toBeGreaterThanOrEqual(-1000);
    expect(age).toBeLessThan(60_000);
  });

  it('does not take the scope, the creation instant or the window from the writer (GBT-M9)', async () => {
    const arranged = await run();
    const row = reached(
      await attempt(
        rider(arranged.rider.id),
        declaration(arranged.rider.id, stopOf(arranged), {
          responsible_hub_id: `'${HUB_B}'`,
          vendor_organization_id: `'${randomUUID()}'`,
          created_at: `now() - interval '5 days'`,
          upload_expires_at: `now() + interval '30 days'`,
          version: '7',
        }),
      ),
    );
    expect(row.responsible_hub_id).toBe(HUB_A);
    expect(row.vendor_organization_id).toBe(vendorA.row.organizationId);
    expect(row.version).toBe(1);
    expect(Number(row.window_seconds)).toBe(900);
    expect(Date.now() - new Date(String(row.created_at)).getTime()).toBeLessThan(60_000);
  });

  it('is refused for a stop that has not been arrived at, a run not in progress, or work that is not the rider’s', async () => {
    const arranged = await run();
    const own = rider(arranged.rider.id);
    // The second stop is still PENDING.
    refused(await attempt(own, declaration(arranged.rider.id, stopOf(arranged, 1))));
    // A run that was dispatched and not started.
    const dispatched = await run({ state: 'DISPATCHED', stopStates: ['PENDING', 'PENDING'] });
    refused(
      await attempt(
        rider(dispatched.rider.id),
        declaration(dispatched.rider.id, stopOf(dispatched)),
      ),
    );
    // Another rider's stop, declared by a rider that gives its own identifier as the capturer.
    const other = await run();
    refused(await attempt(own, declaration(arranged.rider.id, stopOf(other))));
    // A stop that does not exist.
    refused(await attempt(own, declaration(arranged.rider.id, randomUUID())));
  });

  it('is refused when the writer is not the rider under the key of the act, or says something else of the record', async () => {
    const arranged = await run();
    const id = arranged.rider.id;
    const stop = stopOf(arranged);
    // Another key, another principal.
    refused(await attempt(rider(id, 'pickup.run.execute'), declaration(id, stop)));
    refused(await attempt(staff(FAILURE), declaration(id, stop)));
    refused(await attempt(vendor(), declaration(id, stop)));
    // The capturer is somebody else; the owner or the purpose is not the one this key writes; the record is not pending.
    refused(await attempt(rider(id), declaration(randomUUID(), stop)));
    refused(await attempt(rider(id), declaration(id, stop, { purpose: `'CONDITION'` })));
    refused(await attempt(rider(id), declaration(id, stop, { owner_type: `'ORDER'` })));
    refused(await attempt(rider(id), declaration(id, stop, { state: `'STORED'` })));
    // A capture in the future.
    const future = await attempt(
      rider(id),
      declaration(id, stop, { captured_at: `now() + interval '1 hour'` }),
    );
    refused(future);
    expect(future.reason).toBe('VALIDATION_FAILED');
  });
});

describe('who reads a record', () => {
  it('the rider that captured it, and the staff of its hub under pickup.read, and nobody else (GBT-M4, GBT-M5)', async () => {
    const arranged = await run();
    const { id } = await declared(arranged);
    const read = `select id from evidence where id = '${id}'`;
    reached(await attempt(rider(arranged.rider.id), read));
    reached(await attempt(staff('pickup.read'), read));
    reached(await attempt(staff('pickup.read', [HUB_A]), read));
    // A staff set of another hub (GBT-M5), a staff key that is not the read of the subject, a vendor and another rider find nothing.
    hidden(await attempt(staff('pickup.read', [HUB_B]), read));
    hidden(await attempt(staff('pickup.manifest.create'), read));
    hidden(await attempt(vendor(), read));
    const another = await run();
    hidden(await attempt(rider(another.rider.id), read));
    hidden(await attempt(rider(arranged.rider.id, 'pickup.run.execute'), read));
  });

  it('lets a staff member of another hub learn that the record exists in a hub that is not theirs, by the probe, and nothing else', async () => {
    const arranged = await run();
    const { id } = await declared(arranged);
    const probe = createScopeProbe({ evidence: { schema: 'public', table: 'evidence' } });
    const hub = await routes.built.service.transactionWithContext(
      staff('pickup.read', [HUB_B]),
      (tx) => probe(tx, 'evidence', id),
    );
    expect(hub).toBe(HUB_A);
    const none = await routes.built.service.transactionWithContext(
      staff('pickup.read', [HUB_B]),
      (tx) => probe(tx, 'evidence', randomUUID()),
    );
    expect(none).toBeUndefined();
    // A rider is not told: the probe is for staff.
    const asRider = await routes.built.service.transactionWithContext(
      rider(arranged.rider.id),
      (tx) => probe(tx, 'evidence', id),
    );
    expect(asRider).toBeUndefined();
  });
});

describe('completion, expiry and finality', () => {
  const store = (id: string, signature = 'JPEG'): string =>
    `update evidence set state = 'STORED', validated_signature = '${signature}' where id = '${id}'
       returning id, state, uploaded_at, version, validated_signature`;

  it('stores a record before its window ends, with the database’s instant and the next version', async () => {
    const arranged = await run();
    const { id } = await declared(arranged);
    const row = reached(await attempt(rider(arranged.rider.id), store(id)));
    expect(row.state).toBe('STORED');
    expect(row.version).toBe(2);
    expect(row.validated_signature).toBe('JPEG');
    expect(Date.now() - new Date(String(row.uploaded_at)).getTime()).toBeLessThan(60_000);
  });

  it('does not store a record whose window has passed, and says why (EVIDENCE_UPLOAD_EXPIRED)', async () => {
    const arranged = await run();
    const { id } = await declared(arranged);
    await aged(id);
    const late = await attempt(rider(arranged.rider.id), store(id));
    refused(late);
    expect(late.reason).toBe('EVIDENCE_UPLOAD_EXPIRED');
  });

  it('does not store a record on a signature that is not the declared type’s', async () => {
    const arranged = await run();
    const { id } = await declared(arranged);
    refused(await attempt(rider(arranged.rider.id), store(id, 'PNG')));
    refused(await attempt(rider(arranged.rider.id), store(id, 'EXE')));
    // Storing with no signature at all.
    refused(
      await attempt(
        rider(arranged.rider.id),
        `update evidence set state = 'STORED' where id = '${id}' returning id`,
      ),
    );
  });

  it('lets only the capturing rider under the key store it', async () => {
    const arranged = await run();
    const { id } = await declared(arranged);
    const another = await run();
    for (const context of [
      rider(another.rider.id),
      rider(arranged.rider.id, 'pickup.run.execute'),
      staff('pickup.read'),
      vendor(),
    ]) {
      const result = await attempt(context, store(id));
      // The statement either finds no row to change or is refused: the record is still pending.
      if (result.code === undefined) expect(result.rows).toEqual([]);
      else refused(result);
    }
    const still = await routes.admin.query<{ state: string }>(
      `select state from evidence where id = $1`,
      [id],
    );
    expect(still.rows[0]?.state).toBe('PENDING_UPLOAD');
  });

  it('is final once stored or expired, for every writer', async () => {
    const arranged = await run();
    const { id } = await declared(arranged);
    reached(await attempt(rider(arranged.rider.id), store(id)));
    for (const statement of [
      `update evidence set state = 'EXPIRED' where id = '${id}'`,
      `update evidence set state = 'PENDING_UPLOAD', uploaded_at = null, validated_signature = null where id = '${id}'`,
      `update evidence set version = version where id = '${id}'`,
    ]) {
      await expect(routes.admin.query(statement)).rejects.toMatchObject({ code: '23514' });
    }
    // An abandoned capture: expiry is allowed once the window has passed, and then it is final too.
    const second = await declared(arranged);
    await expect(
      routes.admin.query(`update evidence set state = 'EXPIRED' where id = $1`, [second.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await aged(second.id);
    await routes.admin.query(`update evidence set state = 'EXPIRED' where id = $1`, [second.id]);
    await expect(
      routes.admin.query(
        `update evidence set state = 'STORED', validated_signature = 'JPEG' where id = $1`,
        [second.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps what was declared and who it is about, for every writer', async () => {
    const arranged = await run();
    const { id } = await declared(arranged);
    for (const change of [
      `byte_size = 5`,
      `content_type = 'image/png'`,
      `checksum_sha256 = '${'b'.repeat(64)}'`,
      `owner_id = '${randomUUID()}'`,
      `responsible_hub_id = '${HUB_B}'`,
      `vendor_organization_id = null`,
      `storage_ref = 'ev/${'c'.repeat(32)}'`,
      `captured_by_actor = '${randomUUID()}'`,
      `upload_expires_at = now() + interval '1 day'`,
    ]) {
      await expect(
        routes.admin.query(`update evidence set ${change} where id = $1`, [id]),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('is never deleted: the login holds no privilege, and the guard refuses the owner’s statement too', async () => {
    const arranged = await run();
    const { id } = await declared(arranged);
    refused(await attempt(rider(arranged.rider.id), `delete from evidence where id = '${id}'`));
    await expect(
      routes.admin.query(`delete from evidence where id = $1`, [id]),
    ).rejects.toMatchObject({
      code: '23514',
    });
  });
});

describe('Family M: evidence is owner-aware, and no hub is invented for a vendor’s object', () => {
  const insert = async (over: Column): Promise<void> => {
    const arranged = await run();
    const text = declaration(arranged.rider.id, stopOf(arranged), {
      responsible_hub_id: `'${HUB_A}'`,
      vendor_organization_id: 'null',
      ...over,
    }).replace(/\s+returning[\s\S]*$/, '');
    await routes.admin.query(text);
  };

  it('accepts a vendor-owned record with no hub, and a hub-owned record with one', async () => {
    await insert({
      owner_type: `'VENDOR_ORGANIZATION'`,
      owner_id: `'${vendorA.row.organizationId}'`,
      purpose: `'COMPLIANCE_DOCUMENT'`,
      responsible_hub_id: 'null',
      vendor_organization_id: `'${vendorA.row.organizationId}'`,
    });
    await insert({});
  });

  it('rejects a vendor-organisation owner that carries a hub (GBT-M6)', async () => {
    await expect(
      insert({
        owner_type: `'VENDOR_ORGANIZATION'`,
        owner_id: `'${vendorA.row.organizationId}'`,
        purpose: `'COMPLIANCE_DOCUMENT'`,
        vendor_organization_id: `'${vendorA.row.organizationId}'`,
        responsible_hub_id: `'${HUB_A}'`,
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a vendor owner id that does not match the vendor organisation (GBT-M7)', async () => {
    await expect(
      insert({
        owner_type: `'VENDOR_ORGANIZATION'`,
        owner_id: `'${vendorA.row.organizationId}'`,
        purpose: `'COMPLIANCE_DOCUMENT'`,
        responsible_hub_id: 'null',
        vendor_organization_id: `'${randomUUID()}'`,
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert({
        owner_type: `'VENDOR_ORGANIZATION'`,
        owner_id: `'${vendorA.row.organizationId}'`,
        purpose: `'COMPLIANCE_DOCUMENT'`,
        responsible_hub_id: 'null',
        vendor_organization_id: 'null',
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a hub-scoped owner with no hub (GBT-M8), and a vendor-neutral owner that names a vendor', async () => {
    await expect(insert({ responsible_hub_id: 'null' })).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert({
        owner_type: `'MOTORCYCLE'`,
        purpose: `'MAINTENANCE'`,
        vendor_organization_id: `'${vendorA.row.organizationId}'`,
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('does not turn a vendor-owned object into a hub-wide one: staff of a hub with the subject’s key do not read it (GBT-M3), and the other vendor does not (GBT-M2)', async () => {
    const id = randomUUID();
    await routes.admin.query(
      `insert into evidence (id, owner_type, owner_id, purpose, captured_at, captured_by_actor, captured_by_principal_type, storage_ref, access_rule, retention_policy, content_type, byte_size, checksum_sha256, upload_ttl_seconds, upload_expires_at, responsible_hub_id, vendor_organization_id)
       values ($1, 'VENDOR_ORGANIZATION', $2, 'COMPLIANCE_DOCUMENT', now() - interval '1 minute', $3, 'VENDOR', $4, 'SUBJECT_READERS', 'PICKUP_STOP_EVIDENCE', 'application/pdf', 100, $5, 900, now(), null, $2)`,
      [
        id,
        vendorA.row.organizationId,
        vendorA.row.accountId,
        `ev/${randomBytes(16).toString('hex')}`,
        'd'.repeat(64),
      ],
    );
    const read = `select id from evidence where id = '${id}'`;
    hidden(await attempt(staff('pickup.read', [HUB_A]), read));
    hidden(await attempt(staff('pickup.read'), read));
    const other = await routes.vendor();
    hidden(
      await attempt(
        {
          ...vendor(),
          principalId: other.row.accountId,
          vendorOrganizationId: other.row.organizationId,
        },
        read,
      ),
    );
  });
});

describe('the settings the rider’s key reads', () => {
  it('seeds the four evidence settings, with the development values of OB-S1-05', async () => {
    const rows = await routes.admin.query<{ key: string; value: unknown }>(
      `select key, value from setting where key like 'evidence\\_%' order by key`,
    );
    const byKey = Object.fromEntries(rows.rows.map((row) => [row.key, row.value]));
    expect(byKey).toMatchObject({
      evidence_retrieval_authorization_ttl_minutes: 5,
      evidence_upload_authorization_ttl_minutes: 15,
      evidence_upload_max_bytes: 10_485_760,
      evidence_upload_allowed_mime_types: ['image/jpeg', 'image/png', 'application/pdf'],
    });
  });

  it('gives a database seeded before them exactly the rows a new seed writes (migration 0080 against the seed)', async () => {
    const file = resolve(import.meta.dirname, '../../migrations/0080_evidence_store.sql');
    const data = readFileSync(file, 'utf8')
      .replaceAll('\r\n', '\n')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .find((statement) => statement.includes('DO $evidence_settings$'));
    if (data === undefined) throw new Error('the data statement of 0080 was not found');
    const keys = ['evidence_upload_max_bytes', 'evidence_upload_allowed_mime_types'];
    const columns = `key, scope, value_type, value, unit, description`;
    await routes.admin.query('begin');
    try {
      await routes.admin.query(`delete from setting where key = any($1)`, [keys]);
      await routes.admin.query(data);
      const given = await routes.admin.query(
        `select ${columns} from setting where key = any($1) order by key`,
        [keys],
      );
      const seeded = SETTINGS.filter((setting) => keys.includes(setting.key))
        .map((setting) => ({
          key: setting.key,
          scope: setting.scope,
          value_type: setting.valueType,
          value: setting.value,
          unit: setting.unit,
          description: setting.description,
        }))
        .toSorted((a, b) => (a.key < b.key ? -1 : 1));
      expect(given.rows).toEqual(seeded);
    } finally {
      await routes.admin.query('rollback');
    }
  });

  it('shows the rider’s key the three it needs and no other platform setting', async () => {
    const arranged = await run();
    const keys = await attempt(
      rider(arranged.rider.id),
      `select key from setting where key like 'evidence\\_%' or key = 'sms_enabled' order by key`,
    );
    expect(keys.rows?.map((row) => row.key)).toEqual([
      'evidence_upload_allowed_mime_types',
      'evidence_upload_authorization_ttl_minutes',
      'evidence_upload_max_bytes',
    ]);
    hidden(
      await attempt(
        rider(arranged.rider.id, 'pickup.run.execute'),
        `select key from setting where key like 'evidence\\_%'`,
      ),
    );
  });
});
