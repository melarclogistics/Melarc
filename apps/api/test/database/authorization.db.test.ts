import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Module, Req } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import type { BundleSnapshot } from '../../src/platform/auth/ports/session-store.port.js';
import { OPERATION_RUNNER } from '../../src/platform/authorization/authorization-providers.js';
import { authorizationOf } from '../../src/platform/authorization/authorized-request.js';
import type { OperationRunner } from '../../src/platform/authorization/operation-runner.js';
import type { RecordEntities } from '../../src/platform/authorization/record-scope.js';
import { API_RUNTIME_ROLE, loadConfig } from '../../src/platform/config/load-config.js';
import { transactionOf } from '../../src/platform/database/transaction-handle.js';
import { currentRequestContext } from '../../src/platform/logging/request-context.js';
import { RequiresPermission, Self } from '../../src/platform/routes/access-declaration.js';
import { validEnv } from '../../src/test-support/config-env.js';
import { EVERY_SURFACE, OPS_ONLY, VENDOR_ONLY } from '../../src/test-support/route-options.js';
import { startTestApp, type TestApp } from '../../src/test-support/test-app.js';
import { sameShape, traceStatements } from '../../src/test-support/work-shape.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { insertSessionRow, sessionRow } from './support/identities.js';
import { observe, type Observer } from './support/observe.js';
import { assemble, staffPersona, type Machinery, type StaffPersona } from './support/personas.js';
import { applyContextFixture, applyFixture, VENDOR_1, VENDOR_2 } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import {
  clientFor,
  createTestDatabase,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/**
 * Authorization over real HTTP and a real database (S0.26; permission-enforcement.md section 5; SECURITY_DESIGN.md sections 4, 14.1a
 * and 14.4b; `AC-SLICE-000-26`, `-29`, `-30`, `-44`, `-114`; `GBT-B4` to `GBT-B6`, `GBT-GS1` to `GBT-GS12`): the surface gate, the
 * permission from the session's snapshot, the tier, the scope of the grant that authorizes the operation and the existence rule,
 * with the sessions the real issue protocol made from the real seeded bundles.
 */
let database: TestDatabase;
let built: BuiltService;
let admin: pg.Client;
let observer: Observer;
let machinery: Machinery;
let app: TestApp;

const ACCRA = HUBS[0]?.id ?? '';
const ELSEWHERE = '99999999-9999-4999-8999-999999999999';
const RECORD_IN_ACCRA = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5a1';
const RECORD_ELSEWHERE = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5b1';
const NO_SUCH_RECORD = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5ff';

const ENTITIES: RecordEntities = {
  hub_record: { schema: 'rls_fixture', table: 'hub_records', hubScoped: true },
  ownership_record: { schema: 'rls_fixture', table: 'ownership_records', hubScoped: true },
};

/**
 * A hub-scoped table that a staff member also sees only for the rows they own: the hub is one restriction and the owner another, so
 * a miss can be explained by either (the review of 12 October 2026, F02). The probe policy is the template of section 14.4b.
 */
const OWNERSHIP_SQL = `
CREATE TABLE rls_fixture.ownership_records (
  id uuid PRIMARY KEY,
  responsible_hub_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  body text NOT NULL
);
ALTER TABLE rls_fixture.ownership_records OWNER TO melarc_owner;
ALTER TABLE rls_fixture.ownership_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_fixture.ownership_records FORCE ROW LEVEL SECURITY;
CREATE POLICY ownership_records_scope ON rls_fixture.ownership_records
  USING (
    CASE melarc.principal_type()
      WHEN 'STAFF' THEN (melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids()))
        AND owner_id = melarc.current_principal_id()
      ELSE false
    END
  );
CREATE POLICY ownership_records_probe ON rls_fixture.ownership_records FOR SELECT
  USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
GRANT SELECT ON rls_fixture.ownership_records TO melarc_api_runtime;
`;
const OWN_IN_ACCRA = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5c1';
const OTHERS_IN_ACCRA = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5c2';
const OWN_ELSEWHERE = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5c3';
const OTHERS_ELSEWHERE = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5c4';

interface Observed {
  readonly authorization_key: string | null;
  readonly hub_scope_mode: string | null;
  readonly authorized_hub_ids: string | null;
  readonly principal_type: string | null;
}

@Controller('authz')
class AuthzController {
  constructor(@Inject(OPERATION_RUNNER) private readonly runner: OperationRunner) {}

  /** What the database sees of the transaction the operation runs in: the structural half of `GBT-GS7` and `GBT-GS8`. */
  private async seen(request: Request): Promise<Observed> {
    const authorized = authorizationOf(request);
    if (authorized === undefined) throw new Error('no authorization decision was held');
    return this.runner.read(
      authorized,
      currentRequestContext()?.requestId ?? randomUUID(),
      async (handle) => {
        const result = await transactionOf(handle).execute(sql`
          select current_setting('melarc.authorization_key', true) as authorization_key,
                 current_setting('melarc.hub_scope_mode', true) as hub_scope_mode,
                 current_setting('melarc.authorized_hub_ids', true) as authorized_hub_ids,
                 current_setting('melarc.principal_type', true) as principal_type`);
        return result.rows[0] as unknown as Observed;
      },
    );
  }

  @Get('staff-read')
  @RequiresPermission('staff.read', OPS_ONLY)
  staffRead(@Req() request: Request): Promise<Observed> {
    return this.seen(request);
  }

  @Get('vendor-read')
  @RequiresPermission('vendor.read', OPS_ONLY)
  vendorRead(@Req() request: Request): Promise<Observed> {
    return this.seen(request);
  }

  @Get('dispatch-read')
  @RequiresPermission('dispatch.read', EVERY_SURFACE)
  dispatchRead(@Req() request: Request): Promise<Observed> {
    return this.seen(request);
  }

  @Get('self')
  @Self(EVERY_SURFACE)
  self(@Req() request: Request): Promise<Observed> {
    return this.seen(request);
  }

  @Get('vendor-self')
  @Self(VENDOR_ONLY)
  vendorSelf(): { served: true } {
    return { served: true };
  }

  /** The operation states the tier it needs, and the guard decides it at step 6, before the scope and the validation. */
  @Get('needs-p')
  @RequiresPermission('staff.session.revoke', { ...OPS_ONLY, tier: { minimum: 'P' } })
  needsP(): { served: true } {
    return { served: true };
  }

  @Get('staff-records/:id')
  @RequiresPermission('staff.read', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'hub_record', param: 'id' },
  })
  staffRecord(@Req() request: Request): Promise<{ served: true }> {
    return this.served(request);
  }

  @Get('vendor-records/:id')
  @RequiresPermission('vendor.read', {
    surfaces: ['OPS_PORTAL', 'VENDOR_PWA'],
    activity: 'qualifying',
    record: { entity: 'hub_record', param: 'id' },
  })
  vendorRecord(@Req() request: Request): Promise<{ served: true }> {
    return this.served(request);
  }

  @Get('dispatch-records/:id')
  @RequiresPermission('dispatch.read', {
    surfaces: ['OPS_PORTAL', 'RIDER_ANDROID'],
    activity: 'qualifying',
    record: { entity: 'hub_record', param: 'id' },
  })
  dispatchRecord(@Req() request: Request): Promise<{ served: true }> {
    return this.served(request);
  }

  /** A record that a staff member sees only if its hub is in the grant's scope and they own it. The grant is scoped to the caller's hubs. */
  @Get('ownership-records/:id')
  @RequiresPermission('staff.read', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'ownership_record', param: 'id' },
  })
  ownershipRecord(@Req() request: Request): Promise<{ served: true }> {
    return this.served(request);
  }

  /** The same record under a grant scoped to every hub, so that the hub can never be what hides it. */
  @Get('all-ownership-records/:id')
  @RequiresPermission('vendor.read', {
    surfaces: ['OPS_PORTAL', 'VENDOR_PWA'],
    activity: 'qualifying',
    record: { entity: 'ownership_record', param: 'id' },
  })
  allOwnershipRecord(@Req() request: Request): Promise<{ served: true }> {
    return this.served(request);
  }

  private async served(request: Request): Promise<{ served: true }> {
    await this.seen(request);
    return { served: true };
  }
}

@Module({ controllers: [AuthzController] })
class AuthzModule {}

@Module({})
class Root {}

beforeAll(async () => {
  database = await createTestDatabase();
  await applyFixture(database);
  await applyContextFixture(database);
  await withClient(database.urlFor(MIGRATION_ROLE), (client) => client.query(OWNERSHIP_SQL));
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 2 });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  observer = await observe(database);
  machinery = assemble(built);
  await admin.query(
    `insert into rls_fixture.hub_records (id, responsible_hub_id, vendor_organization_id, body)
     values ($1, $2, $3, 'record in Accra'), ($4, $5, $6, 'record elsewhere')`,
    [RECORD_IN_ACCRA, ACCRA, VENDOR_1, RECORD_ELSEWHERE, ELSEWHERE, VENDOR_2],
  );
  const loaded = loadConfig(
    validEnv({ DATABASE_URL: database.urlFor(API_RUNTIME_ROLE), DATABASE_POOL_MAX: '3' }),
  );
  if (!loaded.ok) throw new Error('the configuration was refused');
  app = await startTestApp({
    config: loaded.config,
    rootModule: (options) => {
      Module({
        imports: [
          AppModule.register({
            ...options,
            compiledFixedPolicy: { VENDOR: 1, RIDER: 1 },
            recordEntities: ENTITIES,
            vendorOrganization: () => Promise.resolve(VENDOR_1),
          }),
          AuthzModule,
        ],
      })(Root);
      return Root;
    },
    allowUnsoundRoutes: true,
  });
});

afterAll(async () => {
  await app.stop();
  await admin.end();
  await observer.close();
  await built.close();
  await database.drop();
});

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Answer> {
  const response = await fetch(`${app.baseUrl}/api/v1/authz/${path}`, { headers });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The refusal's shape without the request id, which differs from request to request. */
const shape = (answer: Answer): unknown => {
  const rest: Record<string, unknown> = { ...answer.body };
  delete rest.request_id;
  return { status: answer.status, ...rest };
};

const staffAs = (
  roleBundleId: string,
  primaryHubId: string | null = ACCRA,
): Promise<StaffPersona> => staffPersona(machinery, admin, { roleBundleId, primaryHubId });

/** A Vendor or Rider session row (their directories are not built): the real bundle's snapshot unless a test gives its own. */
async function sessionOf(
  principalType: 'VENDOR' | 'RIDER',
  snapshot: BundleSnapshot,
): Promise<{ cookie?: string; authorization?: string }> {
  const issued = machinery.tokens.issue();
  const csrf = machinery.tokens.issue();
  await insertSessionRow(
    admin,
    sessionRow({
      principalType,
      principalId: randomUUID(),
      registeredDeviceId: randomUUID(),
      policyRevision: 1,
      bundleId: principalType === 'RIDER' ? BUNDLE_IDS.rider : BUNDLE_IDS.vendor,
      snapshot,
      tokenHash: Buffer.from(issued.hash),
      csrfTokenHash: principalType === 'RIDER' ? null : Buffer.from(csrf.hash),
    }),
  );
  return principalType === 'RIDER'
    ? { authorization: `Bearer ${issued.token}` }
    : { cookie: `melarc_session=${issued.token}; melarc_csrf=${csrf.token}` };
}

const VENDOR_SNAPSHOT = (grants: BundleSnapshot['grants'] = []): BundleSnapshot => ({
  format: 1,
  name: 'Vendor',
  audience: 'VENDOR',
  privileged: false,
  grants,
});
const RIDER_SNAPSHOT: BundleSnapshot = {
  format: 1,
  name: 'Rider',
  audience: 'RIDER',
  privileged: false,
  grants: [
    { permission: 'dispatch.read', hubScope: 'none', ownershipScope: 'assigned', tier: null },
  ],
};

describe('the surface gate and the permission gate are independent (AC-SLICE-000-26, -29, -44)', () => {
  // Break caught (AC-SLICE-000-26): the two gates collapsed into one, so that a session that is refused at one passes the other, or
  // the refusal tells which gate it was.
  it('refuses a vendor session that holds the key on an Ops-only operation, and a staff session that lacks it, with one answer', async () => {
    const vendorHoldingTheKey = await sessionOf(
      'VENDOR',
      VENDOR_SNAPSHOT([
        { permission: 'vendor.read', hubScope: 'all', ownershipScope: 'any', tier: null },
      ]),
    );
    const opsStaffLackingTheKey = await staffAs(BUNDLE_IDS.opsStaff);
    // Ops Staff holds vendor.read (own). Take a key it lacks.
    const lacking = await get('staff-read', { cookie: opsStaffLackingTheKey.cookie });
    const surface = await get('vendor-read', vendorHoldingTheKey);

    expect(surface.status).toBe(403);
    expect(surface.body.code).toBe('PERMISSION_DENIED');
    expect(lacking.status).toBe(403);
    expect(lacking.body.code).toBe('PERMISSION_DENIED');
    expect(shape(surface)).toEqual(shape(lacking));
  });

  it('serves the same operation to a staff session that holds the key', async () => {
    const senior = await staffAs(BUNDLE_IDS.seniorOps);

    const answer = await get('staff-read', { cookie: senior.cookie });

    expect(answer.status).toBe(200);
  });

  // Break caught (AC-SLICE-000-44): a missing session answered 403, or an authorization failure answered 401.
  it('answers 401 SESSION_INVALID to a caller with no session and 403 PERMISSION_DENIED to one who may not', async () => {
    const none = await get('staff-read');
    const lacking = await get('staff-read', {
      cookie: (await staffAs(BUNDLE_IDS.opsStaff)).cookie,
    });

    expect(none.status).toBe(401);
    expect(none.body.code).toBe('SESSION_INVALID');
    expect(lacking.status).toBe(403);
    expect(lacking.body.code).toBe('PERMISSION_DENIED');
  });

  // Break caught (AC-SLICE-000-29): an authentication code, a withdrawn code or an MFA code from the authorization layer.
  it('answers only authorization codes, never an authentication code, MFA_REQUIRED or OWNERSHIP_VIOLATION', async () => {
    const lacking = await staffAs(BUNDLE_IDS.opsStaff);
    const codes = new Set<unknown>();
    for (const path of [
      'staff-read',
      'vendor-self',
      'needs-p',
      `staff-records/${RECORD_ELSEWHERE}`,
    ]) {
      codes.add((await get(path, { cookie: lacking.cookie })).body.code);
    }

    for (const code of codes) {
      expect([
        'PERMISSION_DENIED',
        'INSUFFICIENT_AUTHORITY',
        'HUB_SCOPE_VIOLATION',
        'NOT_FOUND',
      ]).toContain(code);
    }
    expect(codes.has('MFA_REQUIRED')).toBe(false);
    expect(codes.has('OWNERSHIP_VIOLATION')).toBe(false);
  });

  // Break caught: a route that states no surfaces served by a principal of one of them, or a self route served to a surface it
  // does not name.
  it('refuses a self operation to a surface it does not serve, and serves it to one it does', async () => {
    const staff = await staffAs(BUNDLE_IDS.opsStaff);
    const vendor = await sessionOf('VENDOR', VENDOR_SNAPSHOT());

    expect((await get('vendor-self', { cookie: staff.cookie })).status).toBe(403);
    expect((await get('vendor-self', vendor)).status).toBe(200);
    expect((await get('self', { cookie: staff.cookie })).status).toBe(200);
    expect((await get('self', vendor)).status).toBe(200);
    expect((await get('self', await sessionOf('RIDER', RIDER_SNAPSHOT))).status).toBe(200);
  });
});

describe('authority is the snapshot the session was issued with, never a role or a bundle’s name', () => {
  // Break caught (permission-enforcement.md section 5.4): the bundle resolved at request time, or the name of a bundle read as
  // authority. A session whose snapshot differs from the live bundle is judged by the snapshot, and a name that looks privileged
  // grants nothing.
  it('serves by the stored snapshot even where the live bundle does not hold the key', async () => {
    const stored = await sessionOf(
      'VENDOR',
      VENDOR_SNAPSHOT([
        { permission: 'vendor.read', hubScope: 'all', ownershipScope: 'any', tier: null },
      ]),
    );
    // The live Vendor bundle holds no key at all; the snapshot says otherwise, and the surface is the Ops Portal's, so the gate
    // refuses. The same snapshot on an operation that serves vendors is served from the snapshot:
    const answer = await get(`vendor-records/${RECORD_IN_ACCRA}`, stored);

    expect(answer.status).toBe(200);
  });

  it('refuses a key the snapshot lacks even where the name of the bundle is the name of a privileged one', async () => {
    const impostor = await sessionOf('VENDOR', {
      ...VENDOR_SNAPSHOT(),
      name: 'Platform Admin',
      privileged: true,
    });

    expect((await get(`vendor-records/${RECORD_IN_ACCRA}`, impostor)).status).toBe(403);
  });
});

describe('the tier is the grant’s, compared with what the target needs (AC-SLICE-000-114)', () => {
  // Break caught: PERMISSION_DENIED for a held key at too low a tier, or INSUFFICIENT_AUTHORITY for a key not held at all.
  it('refuses a Senior Ops, who holds the key at tier S, with INSUFFICIENT_AUTHORITY where a P is needed, and serves a Platform Admin', async () => {
    const senior = await staffAs(BUNDLE_IDS.seniorOps);
    const admin_ = await staffAs(BUNDLE_IDS.platformAdmin);
    const opsStaff = await staffAs(BUNDLE_IDS.opsStaff);

    const tooLow = await get('needs-p', { cookie: senior.cookie });
    const enough = await get('needs-p', { cookie: admin_.cookie });
    const notHeld = await get('needs-p', { cookie: opsStaff.cookie });

    expect(tooLow.status).toBe(403);
    expect(tooLow.body.code).toBe('INSUFFICIENT_AUTHORITY');
    expect(enough.status).toBe(200);
    expect(notHeld.status).toBe(403);
    expect(notHeld.body.code).toBe('PERMISSION_DENIED');
    expect(tooLow.body.code).not.toBe(notHeld.body.code);
  });
});

describe('the scope of the grant that authorizes this operation (SECURITY_DESIGN.md section 14.1a; GBT-GS7, GBT-GS8)', () => {
  const hubs = (observed: Observed): string[] =>
    (observed.authorized_hub_ids ?? '').split(',').filter((id) => id !== '');

  // Break caught (GBT-GS7, GBT-GS8): the key or the mode of the context taken from anywhere but the grant being exercised.
  it('opens the transaction with the key of the operation, mode SET and the session’s hubs, for a grant scoped own', async () => {
    const senior = await staffAs(BUNDLE_IDS.seniorOps);

    const answer = await get('staff-read', { cookie: senior.cookie });

    expect(answer.body).toMatchObject({
      authorization_key: 'staff.read',
      hub_scope_mode: 'SET',
      principal_type: 'STAFF',
    });
    expect(hubs(answer.body as unknown as Observed)).toEqual([ACCRA]);
  });

  // Break caught (GBT-GS1, GBT-GS3): the all-hub authority of one grant widening another, or lost for the grant that carries it.
  // A Platform Admin holds staff.read at own and vendor.read at all hubs: each operation runs under its own grant's scope.
  it('runs two operations of one session under two scopes: own for the grant scoped own, ALL for the grant scoped all', async () => {
    const platformAdmin = await staffAs(BUNDLE_IDS.platformAdmin);

    const own = await get('staff-read', { cookie: platformAdmin.cookie });
    const all = await get('vendor-read', { cookie: platformAdmin.cookie });

    expect(own.body).toMatchObject({ authorization_key: 'staff.read', hub_scope_mode: 'SET' });
    expect(hubs(own.body as unknown as Observed)).toEqual([ACCRA]);
    expect(all.body).toMatchObject({ authorization_key: 'vendor.read', hub_scope_mode: 'ALL' });
    expect(hubs(all.body as unknown as Observed)).toEqual([]);
  });

  // Break caught (GBT-B4): a hub scope mode taken from the request.
  it('ignores a hub scope mode the client asks for', async () => {
    const senior = await staffAs(BUNDLE_IDS.seniorOps);

    const answer = await get('staff-read?hub_scope_mode=ALL', {
      cookie: senior.cookie,
      'x-hub-scope-mode': 'ALL',
      'x-hub-id': ELSEWHERE,
    });

    expect(answer.body).toMatchObject({ hub_scope_mode: 'SET' });
    expect(hubs(answer.body as unknown as Observed)).toEqual([ACCRA]);
  });

  // Break caught (GBT-B5): an empty hub set read as all hubs.
  it('gives a staff member with no hub an empty set and the mode SET, never all', async () => {
    const homeless = await staffAs(BUNDLE_IDS.seniorOps, null);

    const answer = await get('staff-read', { cookie: homeless.cookie });

    expect(answer.body).toMatchObject({ hub_scope_mode: 'SET' });
    expect(hubs(answer.body as unknown as Observed)).toEqual([]);
  });

  // Break caught (GBT-B6): authority read from the name of a bundle or a role: the Ops Staff snapshot is Ops Staff whatever it is
  // called, and the mode comes from its grants.
  it('does not read a mode from the name of the bundle', async () => {
    const renamed = await sessionOf('VENDOR', {
      ...VENDOR_SNAPSHOT([
        { permission: 'vendor.read', hubScope: 'own', ownershipScope: 'any', tier: null },
      ]),
      name: 'Platform Admin',
    });

    const answer = await get(`vendor-records/${RECORD_IN_ACCRA}`, renamed);

    expect(answer.status).toBe(200);
  });

  // Break caught: a self operation given a key, a mode or hubs it never had.
  it('opens a self operation with no authorization key and no hub', async () => {
    const staff = await staffAs(BUNDLE_IDS.seniorOps);

    const answer = await get('self', { cookie: staff.cookie });

    expect(answer.body).toMatchObject({ principal_type: 'STAFF' });
    expect([null, '']).toContain(answer.body.authorization_key);
    expect(hubs(answer.body as unknown as Observed)).toEqual([]);
  });

  // Break caught (GBT-GS3): a Finance holder, whose grant is all-hub with no tier, refused or narrowed.
  it('serves a holder with no tier the all-hub grant they hold', async () => {
    const finance = await staffAs(BUNDLE_IDS.finance, null);

    const answer = await get('vendor-read', { cookie: finance.cookie });

    expect(answer.body).toMatchObject({ authorization_key: 'vendor.read', hub_scope_mode: 'ALL' });
  });
});

describe('a record named by the path: found, outside the hubs, or not there (AC-SLICE-000-30; section 14.4b)', () => {
  // Break caught (GBT-GS1, GBT-GS2): an operation that rests on a hub-limited grant reaching a record in another hub because an
  // all-hub grant is held beside it.
  it('tells a staff member that a record in another hub is outside their hubs, and a Platform Admin that holds a key scoped all hubs', async () => {
    const platformAdmin = await staffAs(BUNDLE_IDS.platformAdmin);
    const senior = await staffAs(BUNDLE_IDS.seniorOps);

    const outside = await get(`staff-records/${RECORD_ELSEWHERE}`, { cookie: senior.cookie });
    const ownGrantOfAdmin = await get(`staff-records/${RECORD_ELSEWHERE}`, {
      cookie: platformAdmin.cookie,
    });
    const allGrantOfAdmin = await get(`vendor-records/${RECORD_ELSEWHERE}`, {
      cookie: platformAdmin.cookie,
    });
    const inside = await get(`staff-records/${RECORD_IN_ACCRA}`, { cookie: senior.cookie });

    expect(outside.status).toBe(403);
    expect(outside.body.code).toBe('HUB_SCOPE_VIOLATION');
    expect(ownGrantOfAdmin.status).toBe(403);
    expect(ownGrantOfAdmin.body.code).toBe('HUB_SCOPE_VIOLATION');
    expect(allGrantOfAdmin.status).toBe(200);
    expect(inside.status).toBe(200);
  });

  // Break caught: the existence of a record told apart from the scope of the caller: a record that is not there is NOT_FOUND.
  it('answers NOT_FOUND for a record that does not exist, to staff', async () => {
    const senior = await staffAs(BUNDLE_IDS.seniorOps);

    const answer = await get(`staff-records/${NO_SUCH_RECORD}`, { cookie: senior.cookie });

    expect(answer.status).toBe(404);
    expect(answer.body.code).toBe('NOT_FOUND');
  });

  // Break caught: the informative answer given to a Vendor or a Rider: a record that exists and is not theirs, and one that does not
  // exist, must be the same response, status, code and body shape.
  it('answers a Vendor and a Rider NOT_FOUND for a record that exists and is not theirs, as for one that does not exist', async () => {
    const vendor = await sessionOf(
      'VENDOR',
      VENDOR_SNAPSHOT([
        { permission: 'vendor.read', hubScope: 'none', ownershipScope: 'own', tier: null },
      ]),
    );
    const rider = await sessionOf('RIDER', RIDER_SNAPSHOT);

    const vendorsOwn = await get(`vendor-records/${RECORD_IN_ACCRA}`, vendor);
    const othersRecord = await get(`vendor-records/${RECORD_ELSEWHERE}`, vendor);
    const missing = await get(`vendor-records/${NO_SUCH_RECORD}`, vendor);
    const riderExisting = await get(`dispatch-records/${RECORD_IN_ACCRA}`, rider);
    const riderMissing = await get(`dispatch-records/${NO_SUCH_RECORD}`, rider);

    expect(vendorsOwn.status).toBe(200);
    expect(shape(othersRecord)).toEqual(shape(missing));
    expect(othersRecord.status).toBe(404);
    expect(shape(riderExisting)).toEqual(shape(riderMissing));
    expect(riderExisting.status).toBe(404);
  });

  // Break caught: the probe taken by a Vendor or a Rider, or by a staff member whose record was found. The statements the runtime
  // login sent are read from the driver: the probe is the one statement that names `responsible_hub_id` of the entity.
  it('takes the probe for a staff member whose read found nothing, and never for a vendor, a rider or a read that found the record', async () => {
    const senior = await staffAs(BUNDLE_IDS.seniorOps);
    const vendor = await sessionOf(
      'VENDOR',
      VENDOR_SNAPSHOT([
        { permission: 'vendor.read', hubScope: 'none', ownershipScope: 'own', tier: null },
      ]),
    );
    const rider = await sessionOf('RIDER', RIDER_SNAPSHOT);
    const probed = (statements: readonly string[]): number =>
      statements.filter((statement) => statement.includes('responsible_hub_id')).length;

    const staffMiss = await traceStatements(API_RUNTIME_ROLE, () =>
      get(`staff-records/${RECORD_ELSEWHERE}`, { cookie: senior.cookie }),
    );
    const staffHit = await traceStatements(API_RUNTIME_ROLE, () =>
      get(`staff-records/${RECORD_IN_ACCRA}`, { cookie: senior.cookie }),
    );
    const staffNothing = await traceStatements(API_RUNTIME_ROLE, () =>
      get(`staff-records/${NO_SUCH_RECORD}`, { cookie: senior.cookie }),
    );
    const vendorMiss = await traceStatements(API_RUNTIME_ROLE, () =>
      get(`vendor-records/${RECORD_ELSEWHERE}`, vendor),
    );
    const riderMiss = await traceStatements(API_RUNTIME_ROLE, () =>
      get(`dispatch-records/${RECORD_IN_ACCRA}`, rider),
    );

    expect(staffMiss.result.status).toBe(403);
    expect(probed(staffMiss.statements)).toBe(1);
    expect(staffHit.result.status).toBe(200);
    expect(probed(staffHit.statements)).toBe(0);
    expect(staffNothing.result.status).toBe(404);
    expect(probed(staffNothing.statements)).toBe(1);
    expect(vendorMiss.result.body.code).toBe('NOT_FOUND');
    expect(probed(vendorMiss.statements)).toBe(0);
    expect(riderMiss.result.body.code).toBe('NOT_FOUND');
    expect(probed(riderMiss.statements)).toBe(0);
  });

  // Break caught (section 14.4b, "only staff ever take the extra step"): the work of the two answers differing, so that timing or
  // the statements a Vendor makes tell the record exists. The same statements, in the same shape, for a missing record and one that
  // is not theirs.
  it('does the same work for a vendor whether the record exists or not', async () => {
    const vendor = await sessionOf(
      'VENDOR',
      VENDOR_SNAPSHOT([
        { permission: 'vendor.read', hubScope: 'none', ownershipScope: 'own', tier: null },
      ]),
    );

    const exists = await traceStatements(API_RUNTIME_ROLE, () =>
      get(`vendor-records/${RECORD_ELSEWHERE}`, vendor),
    );
    const missing = await traceStatements(API_RUNTIME_ROLE, () =>
      get(`vendor-records/${NO_SUCH_RECORD}`, vendor),
    );

    expect(sameShape(exists.statements, missing.statements)).toBe(true);
  });

  // Break caught (AC-SLICE-000-130): an id that cannot name a record answered NOT_FOUND by the scope step, taking the validation
  // step's answer from it.
  it('does not look up an id that is not a UUID, so that the validation step answers it', async () => {
    const senior = await staffAs(BUNDLE_IDS.seniorOps);

    const answer = await get('staff-records/not-an-id', { cookie: senior.cookie });

    expect(answer.status).toBe(200);
  });

  // Break caught: the record found by a context wider than the operation's: the lookup runs under the grant's own scope, so the
  // fixture's vendor-scoped rows are not visible to a staff member of no hub.
  it('looks under the scope of the grant: a staff member with no hub finds nothing of a hub-scoped record', async () => {
    const homeless = await staffAs(BUNDLE_IDS.seniorOps, null);

    const answer = await get(`staff-records/${RECORD_IN_ACCRA}`, { cookie: homeless.cookie });

    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe('HUB_SCOPE_VIOLATION');
  });

  describe('a miss that the hub does not explain (the review of 12 October 2026, F02)', () => {
    const insertOwned = (id: string, hub: string, owner: string): Promise<unknown> =>
      admin.query(
        `insert into rls_fixture.ownership_records (id, responsible_hub_id, owner_id, body)
         values ($1, $2, $3, 'owned') on conflict (id) do update set responsible_hub_id = $2, owner_id = $3`,
        [id, hub, owner],
      );

    // Break caught: HUB_SCOPE_VIOLATION told for every miss of a record that exists. A record in the caller's own hub that is hidden by
    // another restriction (here its owner) is not outside their hubs, and saying so is false and discloses more than the hub axis may.
    it('tells HUB_SCOPE_VIOLATION only for a record in a hub outside the scope, and NOT_FOUND for one that another restriction hides', async () => {
      const senior = await staffAs(BUNDLE_IDS.seniorOps);
      const me = senior.identity.id;
      await insertOwned(OWN_IN_ACCRA, ACCRA, me);
      await insertOwned(OTHERS_IN_ACCRA, ACCRA, randomUUID());
      await insertOwned(OWN_ELSEWHERE, ELSEWHERE, me);
      await insertOwned(OTHERS_ELSEWHERE, ELSEWHERE, randomUUID());
      const read = (id: string) => get(`ownership-records/${id}`, { cookie: senior.cookie });

      const visible = await read(OWN_IN_ACCRA);
      const mineInAnotherHub = await read(OWN_ELSEWHERE);
      const othersInAnotherHub = await read(OTHERS_ELSEWHERE);
      const hiddenByOwner = await read(OTHERS_IN_ACCRA);
      const absent = await read(NO_SUCH_RECORD);

      expect(visible.status).toBe(200);
      expect([mineInAnotherHub.status, mineInAnotherHub.body.code]).toEqual([
        403,
        'HUB_SCOPE_VIOLATION',
      ]);
      expect([othersInAnotherHub.status, othersInAnotherHub.body.code]).toEqual([
        403,
        'HUB_SCOPE_VIOLATION',
      ]);
      expect([hiddenByOwner.status, hiddenByOwner.body.code]).toEqual([404, 'NOT_FOUND']);
      expect([absent.status, absent.body.code]).toEqual([404, 'NOT_FOUND']);
      // The one hidden by its owner says nothing of why: the same shape as a record that is not there.
      expect(shape(hiddenByOwner)).toEqual(shape(absent));
    });

    // Break caught: an all-hub caller told that a record is outside their hubs: with every hub in scope the hub cannot be the reason.
    it('never tells a caller whose key is scoped to every hub that a record is outside their hubs', async () => {
      const platformAdmin = await staffAs(BUNDLE_IDS.platformAdmin);
      await insertOwned(OTHERS_IN_ACCRA, ACCRA, randomUUID());
      await insertOwned(OTHERS_ELSEWHERE, ELSEWHERE, randomUUID());
      await insertOwned(OWN_ELSEWHERE, ELSEWHERE, platformAdmin.identity.id);
      const read = (id: string) =>
        get(`all-ownership-records/${id}`, { cookie: platformAdmin.cookie });

      const hiddenInAccra = await read(OTHERS_IN_ACCRA);
      const hiddenElsewhere = await read(OTHERS_ELSEWHERE);
      const absent = await read(NO_SUCH_RECORD);
      const mine = await read(OWN_ELSEWHERE);

      expect([hiddenInAccra.status, hiddenInAccra.body.code]).toEqual([404, 'NOT_FOUND']);
      expect([hiddenElsewhere.status, hiddenElsewhere.body.code]).toEqual([404, 'NOT_FOUND']);
      expect([absent.status, absent.body.code]).toEqual([404, 'NOT_FOUND']);
      // Visible to them: their own record in another hub, which the all-hub grant reaches.
      expect(mine.status).toBe(200);
    });

    // Break caught: the Vendor answer changing with the new classification: a Vendor is answered NOT_FOUND by the same path for a
    // record that exists and for one that does not, with no probe.
    it('leaves the Vendor answer as it was: the same NOT_FOUND for a record that exists and one that does not, and no probe', async () => {
      const vendor = await sessionOf(
        'VENDOR',
        VENDOR_SNAPSHOT([
          { permission: 'vendor.read', hubScope: 'none', ownershipScope: 'own', tier: null },
        ]),
      );
      await insertOwned(OTHERS_IN_ACCRA, ACCRA, randomUUID());
      const probed = (statements: readonly string[]): number =>
        statements.filter((statement) => statement.includes('responsible_hub_id')).length;

      const exists = await traceStatements(API_RUNTIME_ROLE, () =>
        get(`all-ownership-records/${OTHERS_IN_ACCRA}`, vendor),
      );
      const missing = await traceStatements(API_RUNTIME_ROLE, () =>
        get(`all-ownership-records/${NO_SUCH_RECORD}`, vendor),
      );

      expect(shape(exists.result)).toEqual(shape(missing.result));
      expect(exists.result.status).toBe(404);
      expect(probed(exists.statements)).toBe(0);
      expect(probed(missing.statements)).toBe(0);
    });
  });
});
