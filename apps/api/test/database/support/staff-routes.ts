import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { expect } from 'vitest';

import type { AttestationVerifier } from '../../../src/platform/auth/ports/attestation-verifier.port.js';
import type { Metrics } from '../../../src/platform/auth/ports/metrics.port.js';
import type { TestClient, TestResponse } from '../../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../../src/tools/seed/bundles.js';
import { HUBS } from '../../../src/tools/seed/hubs.js';
import { deliveredReader, deliveryKeyEnv, type DeliveredReader } from './delivered.js';
import { presenting } from './http-sessions.js';
import type { StaffRow } from './identities.js';
import { startIntegrationKit, type IntegrationKit } from './integration.js';
import { assemble, staffPersona, type Machinery } from './personas.js';
import { seedReferenceData } from './seeded.js';
import { buildService, type BuiltService } from './service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './test-database.js';

/**
 * The application, its database and the people of the staff operations of S0.36 and S0.37, for a route test: a disposable database with
 * the reference data seeded and a second hub, the real application started over it (the runtime composition, with key material the test
 * also holds so that it can open the message a person would be sent), and the staff members of the seeded bundles, each holding a session
 * the real issue protocol made. Every request goes through HTTP with the cookie, the synchronizer token and the Ops origin a browser
 * would send; what the application did is read from a second connection and never from its own.
 */
export const HUB_A = HUBS[0]?.id ?? '';
export const HUB_B = 'b0b0b0b0-0000-4000-8000-00000000000b';
export const OPS = 'http://127.0.0.1:5173';
export const API = '/api/v1';

export interface Actor {
  readonly client: TestClient;
  readonly identity: StaffRow;
  /** The session credential by value, for a request that must present it without the synchronizer token. */
  readonly token: string;
  /** The synchronizer token the session was issued with (every staff session has one). */
  readonly csrf: string | undefined;
  readonly sessionId: string;
}

export interface StaffRoutes {
  readonly database: TestDatabase;
  readonly kit: IntegrationKit;
  readonly built: BuiltService;
  readonly machinery: Machinery;
  readonly admin: pg.Client;
  readonly deliveredFor: DeliveredReader;
  actor(bundle: string, hub?: string | null, overrides?: Partial<StaffRow>): Promise<Actor>;
  opsStaff(hub?: string | null): Promise<Actor>;
  seniorOps(hub?: string | null): Promise<Actor>;
  platformAdmin(): Promise<Actor>;
  rows<T extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T[]>;
  stop(): Promise<void>;
}

/**
 * `env` replaces settings of the application's environment for a test that has a reason to (a race test lengthens the database's lock wait
 * so that its own synchronisation, and not a bound, decides when the wait ends); no test of the timeouts uses it.
 */
export async function startStaffRoutes(
  options: {
    readonly env?: Readonly<Record<string, string>>;
    /** The attestation verifier the application is given (S0.57), for a test that counts its calls or controls its verdicts. */
    readonly attestationVerifier?: AttestationVerifier;
    /** A metrics registry bound to the port, for a test that reads what an operation counted. */
    readonly metrics?: Metrics;
  } = {},
): Promise<StaffRoutes> {
  const keys = deliveryKeyEnv();
  const database = await createTestDatabase();
  await seedReferenceData(database);
  const admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(`insert into hub (id, name) values ($1, 'Kumasi')`, [HUB_B]);
  const built = buildService(database, { poolMax: 2 });
  const machinery = assemble(built);
  const kit = await startIntegrationKit(database, {
    poolMax: 4,
    env: { ...keys.keysOnly, ...options.env },
    ...(options.attestationVerifier === undefined
      ? {}
      : { attestationVerifier: options.attestationVerifier }),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    compiledFixedPolicy: { VENDOR: 1, RIDER: 1 },
    vendorOrganization: () => Promise.resolve('0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'),
  });

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
    actor,
    opsStaff: (hub) => actor(BUNDLE_IDS.opsStaff, hub),
    seniorOps: (hub) => actor(BUNDLE_IDS.seniorOps, hub),
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

export const codeOf = (response: TestResponse): string | undefined =>
  (response.json() as { code?: string }).code;
export const outcomeOf = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];

/** The version a reader sees of a staff identity: the ETag a staff-targeted mutation takes back in `If-Match`. */
export async function versionOf(reader: Actor, id: string): Promise<string> {
  const response = await reader.client.get(`${API}/staff-identities/${id}`);
  expect(response.status).toBe(200);
  const etag = response.header('etag');
  if (etag === null) throw new Error('the read carries no ETag');
  return etag;
}

export const uuid = (): string => randomUUID();
