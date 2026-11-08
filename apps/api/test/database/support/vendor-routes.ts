import type pg from 'pg';

import { SystemClock } from '../../../src/platform/auth/clock/system.clock.adapter.js';
import { normaliseNewCredential } from '../../../src/platform/auth/credentials/credential-rule.js';
import { HASHER, type Hasher } from '../../../src/platform/auth/ports/hasher.port.js';
import { BoundedMetrics } from '../../../src/platform/metrics/bounded.metrics.adapter.js';
import { TestClient, type TestResponse } from '../../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../../src/tools/seed/bundles.js';
import { deliveredReader, deliveryKeyEnv, type DeliveredReader } from './delivered.js';
import { presenting } from './http-sessions.js';
import type { StaffRow } from './identities.js';
import { startIntegrationKit, type IntegrationKit } from './integration.js';
import { assemble, staffPersona, type Machinery } from './personas.js';
import { seedReferenceData } from './seeded.js';
import { buildService, type BuiltService } from './service.js';
import { HUB_A, HUB_B, type Actor } from './staff-routes.js';
import { clientFor, createTestDatabase, type TestDatabase } from './test-database.js';
import {
  deviceCredential,
  insertDevice,
  insertVendor,
  vendorRow,
  type DeviceRow,
  type VendorRow,
} from './vendors.js';

/**
 * The application, its database, staff personas and vendors for a route test of the vendor's own operations (S0.48 onward): the real
 * application as the runtime composes it (the build's own fixed-policy revision, and the vendor domain's directory answering whose
 * organisation a vendor session acts for: nothing is substituted), over a disposable database with a second hub, with key material the
 * test also holds so that it can open a queued message. A vendor is arranged as the administrator, with a secret hashed by the application's
 * own hasher and browsers registered with credentials the test holds; a browser is a client of its own, on the Vendor origin, holding its
 * device cookie as the browser that was registered would.
 */
export const VENDOR = 'http://127.0.0.1:5174';
export const SECRET = 'the shared secret of the team';

export interface ArrangedVendor {
  readonly row: VendorRow;
  readonly secret: string;
  readonly device: DeviceRow;
}

export interface VendorRoutes {
  readonly database: TestDatabase;
  readonly kit: IntegrationKit;
  readonly built: BuiltService;
  readonly machinery: Machinery;
  readonly admin: pg.Client;
  readonly deliveredFor: DeliveredReader;
  /** The application's metrics registry. */
  readonly metrics: BoundedMetrics;
  /** An `ACTIVE` vendor of an `ACTIVE` organisation at the seeded hub, with a secret and one registered browser. */
  vendor(overrides?: Partial<VendorRow>, secret?: string): Promise<ArrangedVendor>;
  /** Another browser registered to the same account. */
  anotherDevice(arranged: ArrangedVendor, overrides?: Partial<DeviceRow>): Promise<DeviceRow>;
  /** A browser on the Vendor origin, holding the device credential given (none: a browser that was never registered). */
  browser(device?: string): TestClient;
  signIn(client: TestClient, accountIdentifier: string, secret: string): Promise<TestResponse>;
  actor(bundle: string, hub?: string | null, overrides?: Partial<StaffRow>): Promise<Actor>;
  platformAdmin(): Promise<Actor>;
  rows<T extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T[]>;
  stop(): Promise<void>;
}

export async function startVendorRoutes(): Promise<VendorRoutes> {
  const keys = deliveryKeyEnv();
  const database = await createTestDatabase();
  await seedReferenceData(database);
  const admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(`insert into hub (id, name) values ($1, 'Kumasi')`, [HUB_B]);
  const built = buildService(database, { poolMax: 2 });
  const machinery = assemble(built);
  // A registry the test can read, bound to the port as the private metrics endpoint will bind one (S0.68).
  const metrics = new BoundedMetrics({ policy: 'throw', clock: new SystemClock() });
  const kit = await startIntegrationKit(database, { poolMax: 4, env: keys.keysOnly, metrics });
  const hasher = kit.app.app.get<Hasher>(HASHER, { strict: false });

  async function vendor(
    overrides: Partial<VendorRow> = {},
    secret = SECRET,
  ): Promise<ArrangedVendor> {
    const checked = normaliseNewCredential(secret);
    if (!checked.ok) throw new Error('the arranged secret is not one a vendor could set');
    const row = await insertVendor(
      admin,
      vendorRow({
        hubId: HUB_A,
        secretHash: await hasher.hash('VENDOR_SECRET', checked.credential),
        ...overrides,
      }),
    );
    const device = await insertDevice(admin, row.accountId);
    return { row, secret, device };
  }

  async function actor(
    bundle: string,
    hub: string | null = HUB_A,
    overrides: Partial<StaffRow> = {},
  ): Promise<Actor> {
    const persona = await staffPersona(machinery, admin, {
      roleBundleId: bundle,
      primaryHubId: hub,
      ...overrides,
    });
    return {
      client: presenting(kit, persona.issued.token, persona.issued.csrfToken ?? undefined),
      identity: persona.identity,
      token: persona.issued.token,
      csrf: persona.issued.csrfToken ?? undefined,
      sessionId: persona.issued.session.id,
    };
  }

  return {
    database,
    kit,
    built,
    machinery,
    admin,
    deliveredFor: deliveredReader(keys.env),
    metrics,
    vendor,
    anotherDevice: (arranged, overrides = {}) =>
      insertDevice(admin, arranged.row.accountId, { credential: deviceCredential(), ...overrides }),
    browser(device) {
      const client = new TestClient({
        baseUrl: kit.app.baseUrl,
        origin: VENDOR,
        now: () => kit.clock.now(),
      });
      if (device !== undefined) client.seed('melarc_vendor_device', device);
      return client;
    },
    signIn: (client, accountIdentifier, secret) =>
      client.post('/api/v1/auth/vendor/sign-in', { account_identifier: accountIdentifier, secret }),
    actor,
    platformAdmin: () => actor(BUNDLE_IDS.platformAdmin, null),
    rows: (text, values = []) => kit.observe.rows(text, values),
    async stop() {
      await kit.stop();
      await built.close();
      await admin.end();
      await database.drop();
    },
  };
}

export { HUB_A, HUB_B };
