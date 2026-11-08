import { normaliseNewCredential } from '../../../src/platform/auth/credentials/credential-rule.js';
import { HASHER, type Hasher } from '../../../src/platform/auth/ports/hasher.port.js';
import { TestClient, type TestResponse } from '../../../src/test-support/test-client.js';
import { insertStaff, staffRow, type StaffRow } from './identities.js';
import { OPS } from './staff-routes.js';
import { startVendorRoutes, VENDOR, type VendorRoutes } from './vendor-routes.js';

/**
 * The application and its database for a route test of credential recovery (S0.50 onward): the vendor routes kit (the real application as
 * the runtime composes it, vendors with secrets and browsers, staff personas), with staff members who hold a password the application's own
 * hasher made, a browser of each surface, and a read of the application's own metrics registry, which counts the excluded requests.
 */
export const PASSWORD = 'a long staff password';
export const REQUEST = '/api/v1/auth/recovery/request';
export const COMPLETE = '/api/v1/auth/recovery/complete';

export interface ArrangedStaff {
  readonly row: StaffRow;
  readonly password: string;
}

export interface RecoveryRoutes extends VendorRoutes {
  /** An `ACTIVE` Ops Staff member with a password the application can verify; a row arranged otherwise by `overrides`. */
  staffMember(overrides?: Partial<StaffRow>, password?: string): Promise<ArrangedStaff>;
  /** A browser on the Ops origin with no session. */
  opsBrowser(): TestClient;
  /** A browser on the origin of the principal type's surface, with no session. */
  surfaceOf(type: 'STAFF' | 'VENDOR'): TestClient;
  /** `requestCredentialRecovery` from the surface's browser, with the body given (extra fields included). */
  requestRecovery(
    type: 'STAFF' | 'VENDOR',
    identifier: string,
    extra?: Record<string, unknown>,
  ): Promise<TestResponse>;
  /** The count of `credential_recovery_requests_excluded_total` for an outcome, from the application's registry. */
  excluded(outcome: 'UNKNOWN_OR_INELIGIBLE' | 'RATE_LIMITED' | 'REJECTED'): number;
  /** The recovery requests of a principal, oldest first, with their message's state. */
  requestsOf(principalId: string): Promise<
    {
      id: string;
      state: string;
      channel: string;
      initiated_by: string | null;
      job: string | null;
    }[]
  >;
}

export async function startRecoveryRoutes(): Promise<RecoveryRoutes> {
  const routes = await startVendorRoutes();
  const { kit, admin } = routes;
  const hasher = kit.app.app.get<Hasher>(HASHER, { strict: false });
  const { metrics } = routes;

  const client = (origin: string): TestClient =>
    new TestClient({ baseUrl: kit.app.baseUrl, origin, now: () => kit.clock.now() });

  return {
    ...routes,
    async staffMember(overrides = {}, password = PASSWORD) {
      const checked = normaliseNewCredential(password);
      if (!checked.ok) throw new Error('the arranged password is not one a staff member could set');
      const row = await insertStaff(
        admin,
        staffRow({
          credentialHash: await hasher.hash('STAFF_PASSWORD', checked.credential),
          ...overrides,
        }),
      );
      return { row, password };
    },
    opsBrowser: () => client(OPS),
    surfaceOf: (type) => client(type === 'STAFF' ? OPS : VENDOR),
    requestRecovery: (type, identifier, extra = {}) =>
      client(type === 'STAFF' ? OPS : VENDOR).post(REQUEST, {
        principal_type: type,
        identifier,
        ...extra,
      }),
    excluded: (outcome) =>
      metrics
        .snapshot()
        .counters.filter(
          (counter) =>
            counter.name === 'credential_recovery_requests_excluded_total' &&
            counter.labels.outcome === outcome,
        )
        .reduce((sum, counter) => sum + counter.value, 0),
    requestsOf: (principalId) =>
      routes.rows(
        `select r.id, r.state, r.channel, r.initiated_by, j.state as job
           from recovery_request r
           left join credential_delivery_job j on j.redemption_record_type = 'RECOVERY_REQUEST' and j.redemption_record_id = r.id
          where r.principal_id = $1 order by r.issued_at, r.id`,
        [principalId],
      ),
  };
}
