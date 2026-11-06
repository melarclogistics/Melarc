import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fileContractSource } from '../../src/platform/contract/contract-source.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { IMPLEMENTED_OPERATIONS } from '../../src/tools/contract/implemented-scope.js';
import { BUNDLE_IDS, GRANTS } from '../../src/tools/seed/bundles.js';
import { activateFactor, factorRow, insertFactor } from './support/credentials.js';
import { arrangedFixedSession } from './support/http-sessions.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { insertRider, insertRiderDevice, riderRow } from './support/riders.js';
import {
  API,
  HUB_A,
  HUB_B,
  OPS,
  startStaffRoutes,
  type Actor,
  type StaffRoutes,
} from './support/staff-routes.js';
import { insertDevice, insertVendor, vendorRow } from './support/vendors.js';

/**
 * The negative-access sweep of the slice (S0.66; engineering-standards.md section 3.1, "negative-access tests at every surface"; SLICE-000
 * section 7 item 3), over **every operation the slice builds**, read from the contract so that an operation added later joins it:
 *
 * - **API, the caller with no session**: every operation that needs a session refuses one that presents none, `401 SESSION_INVALID`.
 * - **API, the principal type that is not served**: a Vendor and a Rider are refused every operation keyed to a staff permission and every
 *   `self` operation of another surface, and a staff session every `self` operation of the Vendor PWA, `403 PERMISSION_DENIED`; an Ops
 *   Staff session is refused every operation keyed to a permission its bundle does not hold.
 * - **API, the existence rule**: for every operation addressed by an identifier, a Vendor's and a Rider's answer for another party's record
 *   and for a record that does not exist are the same answer: status, `Error.code`, message, body and every header, with only the
 *   response's own request id and `Date` set aside, and the request id the body names is the one its header carries.
 * - **Query**: a Vendor or Rider context that forges a staff hub scope at the database (`hub_scope_mode = ALL`, every hub) or loses its
 *   organisation still reads its own identity rows and no other (`GBT-C6`, `GBT-C7`, `GBT-C8` and `GBT-D10`, on the identity tables).
 *
 * The other surfaces of the standard are not this slice's: it has no export and no file an operation serves (the custody bundles are an
 * operator's commands, MIGRATION_AND_SEEDING.md section 3.2), and its notifications go to the principal's own registered channel
 * (credential-recovery.md, the anonymity of a request: covered by `recovery-request-routes.db.test.ts`).
 */

interface Operation {
  readonly id: string;
  readonly method: string;
  /** The contract's path template, below `/api/v1`. */
  readonly path: string;
  /** `none` (a pre-session operation), `self`, or the key it needs. */
  readonly permission: string;
  /** The path parameter that names a record, for an operation addressed by one. */
  readonly parameter: string | undefined;
  /** The security schemes it takes (its own, or the contract's default): a browser's cookie session, a rider's bearer one. */
  readonly schemes: ReadonlySet<string>;
}

const OPERATIONS: readonly Operation[] = (() => {
  const contract = fileContractSource.load();
  const schemesOf = (security: unknown): Set<string> =>
    new Set(
      (Array.isArray(security) ? security : []).flatMap((requirement: unknown) =>
        typeof requirement === 'object' && requirement !== null ? Object.keys(requirement) : [],
      ),
    );
  const implemented = new Set<string>(IMPLEMENTED_OPERATIONS);
  const found: Operation[] = [];
  for (const [path, item] of Object.entries(
    contract.paths as Record<string, Record<string, unknown>>,
  )) {
    for (const [method, value] of Object.entries(item)) {
      const operation = value as {
        operationId?: unknown;
        'x-permission'?: unknown;
        security?: unknown;
      } | null;
      if (typeof operation?.operationId !== 'string' || !implemented.has(operation.operationId))
        continue;
      found.push({
        id: operation.operationId,
        method: method.toUpperCase(),
        path,
        permission: String(operation['x-permission']),
        parameter: /\{(\w+)\}/.exec(path)?.[1],
        schemes: schemesOf(operation.security ?? contract.security),
      });
    }
  }
  return found.toSorted((a, b) => (a.id < b.id ? -1 : 1));
})();

/** The `self` operations, and the principal types each serves (its declaration's surfaces). A new one fails the sweep until it is named. */
const SELF_SERVES: Readonly<Record<string, readonly ('STAFF' | 'VENDOR' | 'RIDER')[]>> = {
  getCurrentSession: ['STAFF', 'VENDOR', 'RIDER'],
  signOut: ['STAFF', 'VENDOR', 'RIDER'],
  listTrustedBrowsers: ['STAFF'],
  revokeTrustedBrowser: ['STAFF'],
  // Task C1: the count of the work waiting in each queue the session may read; a session of the Ops Portal and no other.
  getQueueSummary: ['STAFF'],
  // Task C2: the lookup of a record by its code, a name or a phone number typed in full; a session of the Ops Portal and no other.
  lookupRecords: ['STAFF'],
  requestAdditionalDeviceGrant: ['VENDOR'],
  listVendorDevices: ['VENDOR'],
  revokeVendorDevice: ['VENDOR'],
};

/** The keys a bundle holds, as the seed grants them. */
const keysOf = (bundleId: string): Set<string> =>
  new Set(
    GRANTS.filter((grant) => grant.bundleId === bundleId).map((grant) => grant.permissionKey),
  );
const OPS_STAFF_KEYS = keysOf(BUNDLE_IDS.opsStaff);
/**
 * A Vendor and a Rider are served the operations whose key their fixed bundle holds **and** whose security takes their kind of session
 * (SLICE-001 gave the Vendor the keys of its own requests and locations, and the Rider the read of the stops it is assigned): the sweep
 * refuses them every other keyed operation, and reads that set from the seed so that a key granted later joins it.
 */
const SERVED_BY_BUNDLE = {
  VENDOR: { keys: keysOf(BUNDLE_IDS.vendor), scheme: 'browserSession' },
  RIDER: { keys: keysOf(BUNDLE_IDS.rider), scheme: 'riderSession' },
} as const;
const isServedByBundle = (type: 'VENDOR' | 'RIDER', operation: Operation): boolean =>
  SERVED_BY_BUNDLE[type].keys.has(operation.permission) &&
  operation.schemes.has(SERVED_BY_BUNDLE[type].scheme);

const VENDOR_ORIGIN = 'http://127.0.0.1:5174';
const SAFE = new Set(['GET', 'HEAD']);

let routes: StaffRoutes;
let opsStaff: Actor;
let vendor: TestClient;
let vendorCsrf: string | undefined;
let rider: TestClient;
/** Gives the vendor and the rider new sessions of the same principals: see where it is made. */
let refreshSessions: () => Promise<void>;
/** The officer, whose records are "theirs" to a Vendor or a Rider, and who may read them. */
let officer: Actor;
/** A Senior Ops of the first hub, who reads the riders there (`dispatch.read`, at their hub: the Platform Admin of the sweep reads every hub since task P1). */
let hubOps: Actor;
/** Another party's record of each kind an operation is addressed by: a staff member, a rider, a vendor account, a vendor's browser. */
let theirs: Readonly<Record<string, string>>;

beforeAll(async () => {
  routes = await startStaffRoutes();
  opsStaff = await routes.opsStaff();
  officer = await routes.platformAdmin();
  hubOps = await routes.seniorOps(HUB_A);

  const vendorA = await insertVendor(routes.admin, vendorRow({ hubId: HUB_A }));
  const deviceA = await insertDevice(routes.admin, vendorA.accountId);
  const vendorB = await insertVendor(routes.admin, vendorRow({ hubId: HUB_B }));
  const deviceB = await insertDevice(routes.admin, vendorB.accountId);
  const riderA = await insertRider(routes.admin, riderRow({ hubId: HUB_A }));
  const riderDeviceA = await insertRiderDevice(routes.admin, riderA.id);
  const riderB = await insertRider(routes.admin, riderRow({ hubId: HUB_A }));
  // A third vendor of the first hub, with a request: "another party's" pickup request and saved locations, which the officer of that hub
  // may read (the control of the existence rule) and a Vendor or a Rider may not.
  const vendorC = await insertVendor(routes.admin, vendorRow({ hubId: HUB_A }));
  const requestC = await insertPickupRequest(
    routes.admin,
    pickupRequestRow(vendorC.organizationId, HUB_A),
  );
  // Another rider's run, dispatched to it: "another party's" manifest, which the officer of that hub may read and neither a Vendor nor the
  // other Rider may (S1.20; `GBT-C9`, `GBT-D1`).
  const manifestB = await insertManifest(
    routes.admin,
    manifestRow(HUB_A, { state: 'DISPATCHED', assignedRiderId: riderB.id }),
  );
  // A stop of that run: "another party's" stop, which the rider of the sweep is told `NOT_ASSIGNED_RIDER` for when it acts on it, as for one
  // that does not exist (S1.22; `arriveAtPickupStop`; `GBT-D2`, `GBT-D3`).
  const stopB = await insertStop(routes.admin, stopRow(manifestB, requestC.id, 1));
  // A run in progress and a custody handover opened on it by another party: "another party's" handover, which the officer of that hub may read and
  // neither a Vendor nor an unrelated Rider may (S1.24; `getRunCustodyHandover`).
  const riderD = await insertRider(routes.admin, riderRow({ hubId: HUB_A }));
  const manifestD = await insertManifest(
    routes.admin,
    manifestRow(HUB_A, { state: 'IN_PROGRESS', assignedRiderId: riderB.id }),
  );
  const handoverD = await routes.admin.query<{ id: string }>(
    `insert into run_custody_handover (id, manifest_id, responsible_hub_id, from_rider_id, to_rider_id, initiation_note, initiated_by)
     values (gen_random_uuid(), $1, $2, $3, $4, 'Fixture handover', '5eed0000-0000-4000-8000-0000000000e1') returning id`,
    [manifestD.id, HUB_A, riderB.id, riderD.id],
  );

  const vendorSession = await arrangedFixedSession(routes.kit, routes.admin, 'VENDOR', {
    principalId: vendorA.accountId,
    registeredDeviceId: deviceA.id,
  });
  vendor = new TestClient({ baseUrl: routes.kit.app.baseUrl, origin: VENDOR_ORIGIN });
  vendor.seed('melarc_vendor_device', deviceA.credential.token);
  vendor.seed('melarc_session', vendorSession.token);
  vendorCsrf = vendorSession.csrf;
  const riderSession = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER', {
    principalId: riderA.id,
    registeredDeviceId: riderDeviceA.id,
  });
  rider = new TestClient({ baseUrl: routes.kit.app.baseUrl }).bearer(riderSession.token);
  // A session is allowed 120 requests a minute, and a refusal by the limiter is a code-less 500. The sweeps ask four times for each operation the
  // application has, so a describe that asks for all of them takes sessions of its own (of the same principals), and the sweep does not depend on how
  // many operations there are.
  refreshSessions = async (): Promise<void> => {
    // One live session for each vendor or rider (the table's unique index): the ones in use end, as a sign-out ends them.
    await routes.admin.query(
      `update session set terminated_at = clock_timestamp(), termination_reason = 'SIGNED_OUT'
        where principal_id = any($1::uuid[]) and terminated_at is null`,
      [[vendorA.accountId, riderA.id]],
    );
    const fresh = await arrangedFixedSession(routes.kit, routes.admin, 'VENDOR', {
      principalId: vendorA.accountId,
      registeredDeviceId: deviceA.id,
    });
    vendor = new TestClient({ baseUrl: routes.kit.app.baseUrl, origin: VENDOR_ORIGIN });
    vendor.seed('melarc_vendor_device', deviceA.credential.token);
    vendor.seed('melarc_session', fresh.token);
    vendorCsrf = fresh.csrf;
    const freshRider = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER', {
      principalId: riderA.id,
      registeredDeviceId: riderDeviceA.id,
    });
    rider = new TestClient({ baseUrl: routes.kit.app.baseUrl }).bearer(freshRider.token);
  };

  // A trusted browser of the officer: a real one, of the kind `revokeTrustedBrowser` is addressed by (a session id is not one).
  const factor = await insertFactor(routes.admin, factorRow(officer.identity.id));
  await activateFactor(routes.admin, factor.id);
  const trusted = await routes.admin.query<{ id: string }>(
    `insert into trusted_browser (id, staff_identity_id, token_hash, factor_id, credential_generation, label, created_at, expires_at)
     values (gen_random_uuid(), $1, sha256(gen_random_uuid()::text::bytea), $2, 1, 'Firefox on Linux', now(), now() + interval '7 days')
     returning id`,
    [officer.identity.id, factor.id],
  );

  theirs = {
    // A staff record (the officer's), a rider who is not this rider, a vendor account and a browser of another vendor, a session, and a
    // trusted browser of the officer.
    staff: officer.identity.id,
    rider: riderB.id,
    vendor: vendorB.accountId,
    device: deviceB.id,
    session: officer.sessionId,
    trustedBrowser: trusted.rows[0]?.id ?? '',
    pickupRequest: requestC.id,
    pickupManifest: manifestB.id,
    pickupStop: stopB.id,
    runCustodyHandover: handoverD.rows[0]?.id ?? '',
    vendorOrganization: vendorC.organizationId,
  };
});

afterAll(async () => {
  await routes.stop();
});

/** Which kind of record a path parameter names. */
function kindOf(operation: Operation): string {
  if (operation.parameter === 'riderId') return 'rider';
  if (operation.path.startsWith('/ops/vendors/')) return 'vendor';
  if (operation.path.startsWith('/auth/vendor/devices/')) return 'device';
  if (operation.path.startsWith('/auth/staff/trusted-browsers/')) return 'trustedBrowser';
  if (operation.path.startsWith('/auth/sessions/')) return 'session';
  if (operation.path.startsWith('/pickup-requests/')) return 'pickupRequest';
  if (operation.path.startsWith('/pickup-manifests/')) return 'pickupManifest';
  if (operation.path.startsWith('/pickup-stops/')) return 'pickupStop';
  if (operation.path.startsWith('/run-custody-handovers/')) return 'runCustodyHandover';
  if (operation.path.startsWith('/vendor-organizations/')) return 'vendorOrganization';
  return 'staff';
}

function pathOf(operation: Operation, id: string = randomUUID()): string {
  return `${API}${operation.path.replace(/\{\w+\}/, id)}`;
}

/** Sends the operation as the client would, with an empty body and the headers a command carries, which no refusal here reaches. */
function send(
  client: TestClient,
  operation: Operation,
  path: string,
  options: { readonly csrf?: string; readonly origin?: string; readonly ifMatch?: string } = {},
): Promise<TestResponse> {
  if (SAFE.has(operation.method)) return client.request(operation.method, path);
  const { ifMatch, ...rest } = options;
  return client.request(operation.method, path, {
    body: {},
    headers: { 'Idempotency-Key': randomUUID(), 'If-Match': ifMatch ?? '"0"' },
    ...rest,
  });
}

/** A staff browser's request: the session's own synchronizer token rides with the client, and the Ops origin is named. */
const asStaff = (operation: Operation, path: string) =>
  send(opsStaff.client, operation, path, { origin: OPS });
/**
 * A Vendor's request. On an operation the Vendor is served that takes a version (`revokeVendorDevice`), it sends the version it has just
 * read, as the Vendor PWA does, so that the request reaches the lookup of the record and not a stale-version refusal before it.
 */
const asVendor = async (operation: Operation, path: string) => {
  const ifMatch =
    operation.id === 'revokeVendorDevice'
      ? ((await vendor.get(`${API}/auth/vendor/devices`)).header('etag') ?? undefined)
      : undefined;
  return send(vendor, operation, path, {
    ...(vendorCsrf === undefined ? {} : { csrf: vendorCsrf }),
    ...(ifMatch === undefined ? {} : { ifMatch }),
  });
};
const asRider = (operation: Operation, path: string) => send(rider, operation, path);

const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  (response.json() as { code?: string } | null)?.code,
];

/**
 * What a principal type is refused with by an operation that does not serve it: the surface gate's `403 PERMISSION_DENIED` where the
 * operation takes the caller's kind of credential, and, where it takes none of that kind (a Rider's bearer to a browser-only operation),
 * the `401 SESSION_INVALID` of a request with no usable session, which tells nothing about the operation (S0.25; `authentication.guard.ts`).
 */
const refusalFor = (operation: Operation, scheme: 'browserSession' | 'riderSession') =>
  operation.schemes.has(scheme) ? [403, 'PERMISSION_DENIED'] : [401, 'SESSION_INVALID'];

const authenticated = OPERATIONS.filter((operation) => operation.permission !== 'none');
const keyed = OPERATIONS.filter(
  (operation) => operation.permission !== 'none' && operation.permission !== 'self',
);
const selfOperations = OPERATIONS.filter((operation) => operation.permission === 'self');
const addressed = OPERATIONS.filter(
  (operation) => operation.parameter !== undefined && operation.permission !== 'none',
);

describe('the sweep reads the slice’s operations from the contract (S0.66)', () => {
  it('finds all of them, and knows whom each self operation serves', () => {
    expect(OPERATIONS.map((operation) => operation.id).toSorted()).toEqual(
      [...IMPLEMENTED_OPERATIONS].toSorted(),
    );
    expect(selfOperations.map((operation) => operation.id).toSorted()).toEqual(
      Object.keys(SELF_SERVES).toSorted(),
    );
    expect(addressed.length).toBeGreaterThan(10);
  });
});

describe('a caller who presents no session (API surface)', () => {
  // Break caught: an operation that needs a session served to a caller who has none.
  it.each(
    authenticated
      .filter((operation) => operation.id !== 'vendorSignIn')
      .map((operation) => [operation.id, operation]),
  )('%s refuses it, 401 SESSION_INVALID', async (_id, operation) => {
    const response = await send(routes.kit.client.fork(), operation, pathOf(operation), {
      origin: OPS,
    });
    expect(outcome(response)).toEqual([401, 'SESSION_INVALID']);
  });
});

describe('a principal type the operation does not serve (API surface)', () => {
  const unservedTo = (type: 'STAFF' | 'VENDOR' | 'RIDER') =>
    [
      ...keyed.filter((operation) => type !== 'STAFF' && !isServedByBundle(type, operation)),
      ...selfOperations.filter((operation) => !(SELF_SERVES[operation.id] ?? []).includes(type)),
    ].map((operation) => [operation.id, operation] as const);

  // Break caught: a Vendor reaching a staff operation, or a staff operation's own screen, through the surface gate.
  it.each(unservedTo('VENDOR'))('%s refuses a Vendor', async (_id, operation) => {
    expect(outcome(await asVendor(operation, pathOf(operation)))).toEqual(
      refusalFor(operation, 'browserSession'),
    );
  });

  it.each(unservedTo('RIDER'))('%s refuses a Rider', async (_id, operation) => {
    expect(outcome(await asRider(operation, pathOf(operation)))).toEqual(
      refusalFor(operation, 'riderSession'),
    );
  });

  it.each(unservedTo('STAFF'))('%s refuses a staff session', async (_id, operation) => {
    expect(outcome(await asStaff(operation, pathOf(operation)))).toEqual(
      refusalFor(operation, 'browserSession'),
    );
  });

  // Break caught: a staff operation that checks a role instead of the key its declaration names.
  it.each(
    keyed
      .filter((operation) => !OPS_STAFF_KEYS.has(operation.permission))
      .map((operation) => [operation.id, operation]),
  )(
    '%s refuses an Ops Staff session, whose bundle does not hold its key',
    async (_id, operation) => {
      expect(outcome(await asStaff(operation, pathOf(operation)))).toEqual([
        403,
        'PERMISSION_DENIED',
      ]);
    },
  );
});

/** What two answers must share: everything but the response's own request id and its date. */
function comparable(response: TestResponse): unknown {
  const body = response.json() as Record<string, unknown> | null;
  const headers = Object.fromEntries(
    response
      .headerEntries()
      .filter(([name]) => name !== 'date' && name !== 'x-request-id')
      .toSorted(),
  );
  const { request_id: requestId, ...rest } = body ?? {};
  expect(requestId, 'the body names the request id its header carries').toBe(
    response.header('x-request-id'),
  );
  return { status: response.status, body: rest, headers };
}

/** The table each kind of record the sweep asks about lives in. */
const TABLE_OF: Readonly<Record<string, string>> = {
  staff: 'staff_identity',
  rider: 'rider_identity',
  vendor: 'vendor_account',
  device: 'registered_device',
  session: 'session',
  trustedBrowser: 'trusted_browser',
  pickupRequest: 'pickup_request',
  pickupManifest: 'pickup_manifest',
  pickupStop: 'pickup_stop',
  runCustodyHandover: 'run_custody_handover',
  vendorOrganization: 'vendor_organization',
};

describe('the existence rule is asked about records that are real (the control of the rule below)', () => {
  // Break caught: a sweep that compares two refusals of a record that does not exist (an id of the wrong kind, a table the lookup never
  // reads), which are alike for every caller and prove nothing.
  it.each(Object.entries(TABLE_OF))('the %s it asks about is a row of %s', async (kind, table) => {
    const found = await routes.rows<{ count: number }>(
      `select count(*)::int as count from ${table} where id = $1`,
      [theirs[kind]],
    );
    expect(found[0]?.count).toBe(1);
  });

  // Break caught: an operation asked about a record of the wrong kind (a session id for a trusted browser), whose "existing" record is as
  // missing as the one it is compared with. A new addressed operation fails here until its kind is named.
  it('asks about the kind of record each operation is addressed by', () => {
    expect(
      Object.fromEntries(addressed.map((operation) => [operation.id, kindOf(operation)])),
    ).toEqual({
      approveOnePackageException: 'pickupRequest',
      acceptRunCustodyHandover: 'pickupManifest',
      approveStaffIdentity: 'staff',
      arriveAtPickupStop: 'pickupStop',
      assignRider: 'pickupManifest',
      authoriseHandshakeOverride: 'pickupStop',
      cancelPickupManifest: 'pickupManifest',
      cancelPickupRequest: 'pickupRequest',
      confirmPickupRequest: 'pickupRequest',
      dispatchManifest: 'pickupManifest',
      disputeCollection: 'pickupStop',
      escalatePickupRequest: 'pickupRequest',
      extendPickupAttempts: 'pickupRequest',
      failRunCustodyHandover: 'pickupManifest',
      getPickupManifest: 'pickupManifest',
      getPickupRequest: 'pickupRequest',
      getPickupStop: 'pickupStop',
      getRider: 'rider',
      getRunCustodyHandover: 'runCustodyHandover',
      initiateRunCustodyHandover: 'pickupManifest',
      getStaffIdentity: 'staff',
      getVendorAccount: 'vendor',
      initiateHandshake: 'pickupStop',
      listStaffTrustedBrowsers: 'staff',
      listVendorPickupLocations: 'vendorOrganization',
      recoverStaffCredential: 'staff',
      recordCollection: 'pickupStop',
      recoverVendorCredential: 'vendor',
      registerRiderDevice: 'rider',
      reportPickupFailure: 'pickupStop',
      reissueStaffCredentialSetup: 'staff',
      reissueVendorCredentialSetup: 'vendor',
      requestOnePackageException: 'pickupRequest',
      requestSmsHandshakeFallback: 'pickupStop',
      reregisterRiderDevice: 'rider',
      resetStaffMfa: 'staff',
      resolveCutoffException: 'pickupRequest',
      resolveHandshake: 'pickupStop',
      revokeRiderDevice: 'rider',
      revokeSession: 'session',
      revokeStaffTrustedBrowsers: 'staff',
      revokeTrustedBrowser: 'trustedBrowser',
      revokeVendorDevice: 'device',
      setManifestStopOrder: 'pickupManifest',
      skipPickupStop: 'pickupStop',
      startRun: 'pickupManifest',
      verifyHandshake: 'pickupStop',
      waiveCancellationCharge: 'pickupRequest',
    });
  });

  // Break caught: a lookup that finds nothing for anyone (a route that answers 404 to every identifier), so that "a missing record looks
  // like another party's" is true of every record.
  it.each(
    addressed
      .filter((operation) => SAFE.has(operation.method))
      .map((operation) => [operation.id, operation]),
  )(
    '%s: a caller who may read the record finds it, and is told a missing one is missing',
    async (_id, operation) => {
      // The officer of the first hub reads what a hub holds (the Platform Admin of the sweep has no primary hub, and since task P1 its grants reach every hub: this case wants a reader of one).
      const reader =
        operation.id === 'getRider' ||
        [
          'pickupRequest',
          'pickupManifest',
          'pickupStop',
          'runCustodyHandover',
          'vendorOrganization',
        ].includes(kindOf(operation))
          ? hubOps
          : officer;
      const found = await reader.client.get(pathOf(operation, theirs[kindOf(operation)] ?? ''));
      const missing = await reader.client.get(pathOf(operation));
      expect([found.status, missing.status]).toEqual([200, 404]);
    },
  );
});

describe('the existence rule (a Vendor’s or Rider’s refusal tells nothing of whether the record exists)', () => {
  beforeAll(async () => {
    await refreshSessions();
  });

  // Break caught: an operation that answers another party's record differently from a missing one (a status, a code, a message, a field
  // or a header), which would let a Vendor or a Rider enumerate records by trying identifiers (errors-and-enums.md section 4).
  it.each(addressed.map((operation) => [operation.id, operation]))(
    '%s answers both alike',
    async (_id, operation) => {
      const existing = theirs[kindOf(operation)] ?? '';
      for (const ask of [asVendor, asRider]) {
        const real = await ask(operation, pathOf(operation, existing));
        const missing = await ask(operation, pathOf(operation));
        expect(real.status).toBeGreaterThanOrEqual(400);
        expect(comparable(real)).toEqual(comparable(missing));
      }
    },
  );
});

describe('a Vendor or Rider context that forges a staff scope at the database (query surface; matrix GBT-C4 to GBT-C8, GBT-L10, GBT-D10)', () => {
  const visible = async (
    context: SecurityContext,
    forge: string | undefined,
    table: string,
    ids: readonly string[],
  ) =>
    routes.built.service.transactionWithContext(context, async (tx) => {
      if (forge !== undefined) await tx.execute(sql.raw(forge));
      const result = await tx.execute(
        sql`select id from ${sql.identifier(table)} where id = any(${`{${ids.join(',')}}`}::uuid[]) order by id`,
      );
      return (result.rows as { id: string }[]).map((row) => row.id);
    });
  const FORGED_SCOPE = `select set_config('melarc.hub_scope_mode', 'ALL', true), set_config('melarc.authorized_hub_ids', '${HUB_A},${HUB_B}', true)`;

  // Break caught: a policy whose Vendor or Rider branch falls through to the staff branch when a hub scope is present.
  it('reads its own account, browsers and rider record and no other, whatever scope it forges', async () => {
    const a = await insertVendor(routes.admin, vendorRow({ hubId: HUB_A }));
    const b = await insertVendor(routes.admin, vendorRow({ hubId: HUB_A }));
    // Another hub's vendor too: the same refusal whether the other is in the hub (GBT-C4, GBT-L10) or in another (GBT-C5).
    const c = await insertVendor(routes.admin, vendorRow({ hubId: HUB_B }));
    const devices = [
      await insertDevice(routes.admin, a.accountId),
      await insertDevice(routes.admin, b.accountId),
    ];
    const vendorA: SecurityContext = {
      principalType: 'VENDOR',
      principalId: a.accountId,
      sessionId: randomUUID(),
      surface: 'VENDOR_PWA',
      vendorOrganizationId: a.organizationId,
      correlationId: 'negative-access-sweep',
    };
    for (const forge of [undefined, FORGED_SCOPE]) {
      expect(
        await visible(vendorA, forge, 'vendor_account', [a.accountId, b.accountId, c.accountId]),
      ).toEqual([a.accountId]);
      expect(
        await visible(
          vendorA,
          forge,
          'registered_device',
          devices.map((device) => device.id),
        ),
      ).toEqual([devices[0]?.id]);
    }
    // An organisation lost from the context reads nothing: the read is refused, or finds no row (C8).
    const lost = await visible(
      vendorA,
      `select set_config('melarc.vendor_organization_id', '', true)`,
      'vendor_account',
      [a.accountId, b.accountId],
    ).then(
      (found) => ({ found }),
      (error: unknown) => ({ refused: serverErrorIn(error)?.code }),
    );
    expect([{ found: [] }, { refused: '22P02' }]).toContainEqual(lost);

    const riderA = await insertRider(routes.admin, riderRow({ hubId: HUB_A }));
    const riderB = await insertRider(routes.admin, riderRow({ hubId: HUB_A }));
    const riderContext: SecurityContext = {
      principalType: 'RIDER',
      principalId: riderA.id,
      sessionId: randomUUID(),
      surface: 'RIDER_ANDROID',
      riderId: riderA.id,
      correlationId: 'negative-access-sweep',
    };
    for (const forge of [undefined, FORGED_SCOPE]) {
      expect(await visible(riderContext, forge, 'rider_identity', [riderA.id, riderB.id])).toEqual([
        riderA.id,
      ]);
    }
  });

  // Break caught: a policy of the manifest or of its stop whose Vendor or Rider branch falls through to the staff branch under a forged scope
  // (GBT-C9, GBT-D1, GBT-D3, GBT-D9, GBT-D10, GBT-D11), or that shows a rider a run it is not assigned, a run assigned to it that has not been
  // dispatched, or the stop of a run it cannot read (the stop inherits the manifest's assignment, never the hub).
  it('reads of the manifests and stops only the dispatched runs assigned to the rider, and a Vendor none, whatever scope it forges', async () => {
    const owner = await insertVendor(routes.admin, vendorRow({ hubId: HUB_A }));
    const riderA = await insertRider(routes.admin, riderRow({ hubId: HUB_A }));
    const riderB = await insertRider(routes.admin, riderRow({ hubId: HUB_A }));
    const dispatchedToA = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { state: 'DISPATCHED', assignedRiderId: riderA.id }),
    );
    const dispatchedToB = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { state: 'DISPATCHED', assignedRiderId: riderB.id }),
    );
    const draftForA = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { assignedRiderId: riderA.id }),
    );
    const cancelledForA = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { state: 'CANCELLED', assignedRiderId: riderA.id }),
    );
    const cancelledAfterDispatch = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, {
        state: 'CANCELLED',
        assignedRiderId: riderA.id,
        dispatchedBeforeCancel: true,
      }),
    );
    const nobodys = await insertManifest(routes.admin, manifestRow(HUB_A));
    const manifests = [
      dispatchedToA,
      dispatchedToB,
      draftForA,
      cancelledForA,
      cancelledAfterDispatch,
      nobodys,
    ];
    const stopIds: Record<string, string> = {};
    for (const [at, manifest] of manifests.entries()) {
      const request = await insertPickupRequest(
        routes.admin,
        pickupRequestRow(owner.organizationId, HUB_A, { state: 'CONFIRMED' }),
      );
      const stop = await insertStop(routes.admin, stopRow(manifest, request.id, at + 1));
      stopIds[manifest.id] = stop.id;
    }

    const riderContext: SecurityContext = {
      principalType: 'RIDER',
      principalId: riderA.id,
      sessionId: randomUUID(),
      surface: 'RIDER_ANDROID',
      riderId: riderA.id,
      authorizationKey: 'pickup.read',
      correlationId: 'negative-access-sweep',
    };
    const vendorContext: SecurityContext = {
      principalType: 'VENDOR',
      principalId: owner.accountId,
      sessionId: randomUUID(),
      surface: 'VENDOR_PWA',
      vendorOrganizationId: owner.organizationId,
      authorizationKey: 'pickup.read',
      correlationId: 'negative-access-sweep',
    };
    const allIds = manifests.map((manifest) => manifest.id);
    const allStops = Object.values(stopIds);
    // Rider A reads its dispatched run, and the run it was assigned that was cancelled after it was dispatched: nothing else.
    const expected = [dispatchedToA.id, cancelledAfterDispatch.id].toSorted();
    const expectedStops = expected.map((manifestId) => stopIds[manifestId] ?? '').toSorted();
    for (const forge of [undefined, FORGED_SCOPE]) {
      expect(await visible(riderContext, forge, 'pickup_manifest', allIds)).toEqual(expected);
      expect(await visible(riderContext, forge, 'pickup_stop', allStops)).toEqual(expectedStops);
      expect(await visible(vendorContext, forge, 'pickup_manifest', allIds)).toEqual([]);
      expect(await visible(vendorContext, forge, 'pickup_stop', allStops)).toEqual([]);
    }
    // A rider with no key of the pickup domain in its context reads no run at all.
    const keyless: SecurityContext = { ...riderContext, authorizationKey: 'dispatch.read' };
    expect(await visible(keyless, undefined, 'pickup_manifest', allIds)).toEqual([]);
    expect(await visible(keyless, undefined, 'pickup_stop', allStops)).toEqual([]);

    // GBT-D2: a rider who writes to another rider's run, or makes one, is refused. The runtime login holds no DELETE, UPDATE on six columns
    // of a manifest (`state`, `assigned_rider_id`, `assigned_at`, the planning of S1.21, migration 0060; `dispatched_at`, the dispatch, 0063;
    // `started_at`, the rider's start, 0065; `completed_at`, the system's completion of a run, 0066) and on seven of a stop (`state`, `resolved_at`, `skip_snapshot`, the cancellation of a request,
    // migration 0059; `sequence`, `released_at`, the planning; `pickup_summary`, the dispatch; `arrived_at`, the rider's arrival, 0065). So it
    // is the grant that refuses every other column and every delete (and the policy of the insert that refuses a run made by a rider): the
    // denial is not a WITH CHECK, and this says so. A change of a granted column is allowed by the grant to any principal and is refused by
    // the policy, which admits it to the keys of the act alone (staff for the planning, the dispatch and the cancelling; the rider for its
    // own run, under the key that works one): the statement is not an error, it finds no row.
    const refusedAs = (context: SecurityContext, text: string): Promise<string | undefined> =>
      routes.built.service
        .transactionWithContext(context, async (tx) => {
          await tx.execute(sql.raw(text));
        })
        .then(
          () => undefined,
          (error: unknown) => serverErrorIn(error)?.code,
        );
    const stopOfB = stopIds[dispatchedToB.id] ?? '';
    for (const text of [
      `update pickup_manifest set assigned_at = null, code = 'ACC-MF-ZZZZZZ' where id = '${dispatchedToB.id}'`,
      `update pickup_manifest set service_date = '2026-12-31' where id = '${dispatchedToB.id}'`,
      `update pickup_stop set version = 9 where id = '${stopOfB}'`,
      `update pickup_stop set carryover_snapshot = '{"reason_code":"X"}'::jsonb where id = '${stopOfB}'`,
      `delete from pickup_stop where pickup_manifest_id = '${dispatchedToB.id}'`,
      `delete from pickup_manifest where id = '${dispatchedToB.id}'`,
      `insert into pickup_manifest (id, code, responsible_hub_id, service_date, created_by)
       values ('${randomUUID()}', 'ACC-MF-ZZZZZZ', '${HUB_A}', '2026-11-03', '${riderA.id}')`,
    ]) {
      expect(await refusedAs(riderContext, text), text).toBe('42501');
    }
    const changed = (context: SecurityContext, forge: string | undefined, text: string) =>
      routes.built.service.transactionWithContext(context, async (tx) => {
        if (forge !== undefined) await tx.execute(sql.raw(forge));
        return (await tx.execute(sql.raw(text))).rows;
      });
    for (const forge of [undefined, FORGED_SCOPE]) {
      for (const context of [riderContext, vendorContext]) {
        for (const text of [
          `update pickup_stop set state = 'SKIPPED', resolved_at = now() where id = '${stopOfB}' returning id`,
          `update pickup_stop set sequence = 9 where id = '${stopOfB}' returning id`,
          `update pickup_stop set released_at = now() where id = '${stopOfB}' returning id`,
          `update pickup_manifest set state = 'CANCELLED' where id = '${dispatchedToB.id}' returning id`,
          `update pickup_manifest set assigned_rider_id = '${riderA.id}' where id = '${dispatchedToB.id}' returning id`,
          // The two columns the rider's acts write (S1.22), which the grant now allows: the policy finds no row of another rider's run.
          `update pickup_manifest set state = 'IN_PROGRESS', started_at = now() where id = '${dispatchedToB.id}' returning id`,
          // The moment of a completion (S1.23, the system's act under an officer's key): granted, and the policy finds no row for a rider or a vendor.
          `update pickup_manifest set state = 'COMPLETED', completed_at = now() where id = '${dispatchedToB.id}' returning id`,
          `update pickup_manifest set completed_at = now() where id = '${dispatchedToB.id}' returning id`,
          `update pickup_stop set arrived_at = now() where id = '${stopOfB}' returning id`,
          `update pickup_stop set state = 'ARRIVED', arrived_at = now() where id = '${stopOfB}' returning id`,
        ]) {
          expect(
            await changed(context, forge, text),
            `${context.principalType} ${forge === undefined ? 'as it is' : 'with a forged scope'}: ${text}`,
          ).toEqual([]);
        }
      }
    }
    // The same with the key that works a run (the rider's own act, S1.22): a rider A that holds it still reaches nothing of rider B's run
    // or stop, with its scope as it is or forged (GBT-D2, GBT-D3, GBT-D10): the assignment is the boundary, not the key.
    const acting: SecurityContext = { ...riderContext, authorizationKey: 'pickup.run.execute' };
    for (const forge of [undefined, FORGED_SCOPE]) {
      for (const text of [
        `update pickup_manifest set state = 'IN_PROGRESS', started_at = now() where id = '${dispatchedToB.id}' returning id`,
        `update pickup_stop set state = 'ARRIVED', arrived_at = now() where id = '${stopOfB}' returning id`,
      ]) {
        expect(
          await changed(acting, forge, text),
          `an acting rider ${forge === undefined ? 'as it is' : 'with a forged scope'}: ${text}`,
        ).toEqual([]);
      }
    }
    // Nothing of the other rider's run changed.
    const [stillThere] = await routes.rows<{ state: string; stops: number; stop: string }>(
      `select m.state, (select count(*)::int from pickup_stop s where s.pickup_manifest_id = m.id) as stops,
              (select s.state from pickup_stop s where s.pickup_manifest_id = m.id) as stop
         from pickup_manifest m where m.id = $1`,
      [dispatchedToB.id],
    );
    expect(stillThere).toEqual({ state: 'DISPATCHED', stops: 1, stop: 'PENDING' });

    // The policy of the stop, on its own. The stop's rider arm asks for a manifest that is assigned to the rider and dispatched, and reads
    // `pickup_manifest` under the manifest's policy, which already hides the same runs: weakening the stop's own conditions would pass
    // every check above. The policies of a table are added together, so open the manifest's wide for this disposable database, show
    // that it is open (the control: without it this proves nothing), and ask again. The stop must still refuse the stop of a run that
    // is not dispatched, of another rider's run, and any vendor: the guard that keeps a stop from a rider before dispatch (OB-S1-21) must
    // not depend on the manifest's policy staying as it is.
    await routes.admin.query(
      `create policy zz_open_for_test on pickup_manifest for select using (true)`,
    );
    try {
      const everyRun = allIds.toSorted();
      expect(await visible(riderContext, undefined, 'pickup_manifest', allIds)).toEqual(everyRun);
      expect(await visible(vendorContext, undefined, 'pickup_manifest', allIds)).toEqual(everyRun);
      expect(await visible(riderContext, undefined, 'pickup_stop', allStops)).toEqual(
        expectedStops,
      );
      expect(await visible(vendorContext, undefined, 'pickup_stop', allStops)).toEqual([]);
    } finally {
      await routes.admin.query(`drop policy zz_open_for_test on pickup_manifest`);
    }
  });
});

describe('the comparison the existence rule is judged by', () => {
  // Break caught: a comparison that sets aside more than the request id and the date, so that a difference that tells a Vendor or a
  // Rider the record exists (a status, a code, a message, a body field, a header) passes unseen.
  it('sees a difference in the status, the code, the message, a field or a header, and nothing in the request id or the date', () => {
    const answer = (
      status: number,
      body: Record<string, unknown>,
      headers: Record<string, string> = {},
      requestId = 'request-1',
    ) =>
      new TestResponse(
        status,
        new Headers({
          'content-type': 'application/json',
          'x-request-id': requestId,
          date: 'now',
          ...headers,
        }),
        JSON.stringify({ ...body, request_id: requestId }),
      );
    const base = answer(404, { code: 'NOT_FOUND', message: 'Resource not found' });
    expect(
      comparable(
        answer(
          404,
          { code: 'NOT_FOUND', message: 'Resource not found' },
          { date: 'later' },
          'request-2',
        ),
      ),
    ).toEqual(comparable(base));
    for (const other of [
      answer(403, { code: 'NOT_FOUND', message: 'Resource not found' }),
      answer(404, { code: 'PERMISSION_DENIED', message: 'Resource not found' }),
      answer(404, { code: 'NOT_FOUND', message: 'Resource not yours' }),
      answer(404, { code: 'NOT_FOUND', message: 'Resource not found', details: {} }),
      answer(
        404,
        { code: 'NOT_FOUND', message: 'Resource not found' },
        { 'cache-control': 'max-age=60' },
      ),
    ]) {
      expect(comparable(other)).not.toEqual(comparable(base));
    }
    // A body that names another request than its header is a defect of its own, and is not set aside.
    const mismatched = new TestResponse(
      404,
      new Headers({ 'content-type': 'application/json', 'x-request-id': 'request-1' }),
      JSON.stringify({ code: 'NOT_FOUND', message: 'Resource not found', request_id: 'another' }),
    );
    expect(() => comparable(mismatched)).toThrow();
  });
});
