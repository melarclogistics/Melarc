import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fileContractSource } from '../../src/platform/contract/contract-source.js';
import { IMPLEMENTED_OPERATIONS } from '../../src/tools/contract/implemented-scope.js';
import { BUNDLE_IDS, GRANTS } from '../../src/tools/seed/bundles.js';
import { arrangedFixedSession } from './support/http-sessions.js';
import { insertRider, insertRiderDevice, riderRow } from './support/riders.js';
import {
  API,
  HUB_A,
  OPS,
  startStaffRoutes,
  type Actor,
  type StaffRoutes,
} from './support/staff-routes.js';
import { insertDevice, insertVendor, vendorRow } from './support/vendors.js';

/**
 * The refusal order and the status rule run together over every operation the slice builds (S0.67; `AC-SLICE-000-130` and
 * `AC-SLICE-000-131`; permission-enforcement.md section 5.1; errors-and-enums.md section 4), read from the contract. Each operation's own
 * tests hold its order on its own records (the scope before the body, the replay before the state, the version before the state, the
 * maker-checker last, and `registerRiderDevice`'s sealed replay); this sweep holds the clauses that are the same for all of them:
 *
 * - **A malformed body tells nothing about the schema to a caller who may not proceed**: with no session it is `401 SESSION_INVALID`, and
 *   from a principal the operation does not serve or whose bundle lacks the key it is the authorization refusal, never `400`.
 * - **CSRF and Origin come before the permission**: a staff browser's unsafe request with no synchronizer token is
 *   `403 CSRF_VALIDATION_FAILED` on every operation that takes a browser session, whether or not the staff member may use it.
 * - **A browser credential mutation needs an approved `Origin`, and a native Rider request needs none**: each pre-session operation of a
 *   browser refuses a missing, `null` or unapproved `Origin` with `CSRF_VALIDATION_FAILED`, and no Rider operation refuses a request for
 *   having no `Origin`.
 * - **`SESSION_SUPERSEDED` (`AC-SLICE-000-131`)**: a Vendor session that a newer sign-in displaced is answered `401 SESSION_SUPERSEDED`
 *   by every operation that authenticates a Vendor, and no operation declares the code.
 *
 * The rate limit's place before everything is proved on the guard chain (`guard-chain.test.ts`, `refusal-order.db.test.ts`): no single
 * bound is reachable on every operation here without exhausting a shared bucket.
 */

interface Operation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly permission: string;
  readonly schemes: ReadonlySet<string>;
  readonly declares: readonly string[];
  readonly hasBody: boolean;
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
      const operation = value as Record<string, unknown> | null;
      const id = operation?.operationId;
      if (typeof id !== 'string' || !implemented.has(id)) continue;
      found.push({
        id,
        method: method.toUpperCase(),
        path,
        permission: String(operation?.['x-permission']),
        schemes: schemesOf(operation?.security ?? contract.security),
        declares: Array.isArray(operation?.['x-error-codes'])
          ? (operation['x-error-codes'] as string[])
          : [],
        hasBody: operation?.requestBody !== undefined,
      });
    }
  }
  return found.toSorted((a, b) => (a.id < b.id ? -1 : 1));
})();

const SAFE = new Set(['GET', 'HEAD']);
const VENDOR_ORIGIN = 'http://127.0.0.1:5174';
/** The `self` operations whose surface is not the Ops Portal's: the Vendor PWA's own (S0.49). */
const VENDOR_SELF = new Set([
  'requestAdditionalDeviceGrant',
  'listVendorDevices',
  'revokeVendorDevice',
]);
/**
 * The operations of the pickup domain that the Vendor app serves (S1.13, S1.17): a vendor is not refused them before the body, which they
 * judge for its own organisation (`createPickupRequest`) or its own request (`cancelPickupRequest`). The sweep's clause for a vendor is about
 * the operations it does not serve, and these two were never in it; the list was missing until the sweep was run again (2 November 2026).
 */
const VENDOR_SERVED = new Set([
  'createPickupRequest',
  'cancelPickupRequest',
  // S1.27 and S1.29: the vendor enters the code its rider shows, and disputes the collection of its own pickup.
  'verifyHandshake',
  'disputeCollection',
]);
/**
 * The operations whose key a rider's bundle holds and whose security takes its session, and that the Rider app is nonetheless not served: the key
 * `pickup.collection.confirm` is a vendor's too, and `disputeCollection` is the Vendor app's alone (S1.29), so a rider is refused it by its surface.
 */
const RIDER_REFUSED_BY_SURFACE = new Set(['disputeCollection']);
/**
 * The `owner` operations (S1.11, `x-permission: owner`) that a rider is served: no key names them, the key is that of the act the record is about (the use case asks for it), and the
 * surface is the Rider app's. A rider is refused the operation that is the staff's (`createEvidenceRetrievalAuthorization`) by its surface.
 */
const RIDER_OWNER_OPERATIONS = new Set(['createEvidence', 'completeEvidenceUpload']);
/** The pre-session operations of the Rider app, a native client: the challenge, the sign-in and the device's enrolment. */
const isRiderNative = (operation: Operation): boolean => operation.path.startsWith('/auth/rider/');
const OPS_STAFF_KEYS = new Set(
  GRANTS.filter((grant) => grant.bundleId === BUNDLE_IDS.opsStaff).map(
    (grant) => grant.permissionKey,
  ),
);
const MALFORMED = '{"broken": ';

let routes: StaffRoutes;
let opsStaff: Actor;
let vendorCookie: string;
let vendorCsrf: string;
let riderToken: string;
let displacedCookie: string;
let displacedCsrf: string;

beforeAll(async () => {
  routes = await startStaffRoutes();
  opsStaff = await routes.opsStaff();
  const vendor = await insertVendor(routes.admin, vendorRow({ hubId: HUB_A }));
  const device = await insertDevice(routes.admin, vendor.accountId);
  const live = await arrangedFixedSession(routes.kit, routes.admin, 'VENDOR', {
    principalId: vendor.accountId,
    registeredDeviceId: device.id,
  });
  vendorCookie = `melarc_vendor_device=${device.credential.token}; melarc_session=${live.token}; melarc_csrf=${live.csrf ?? ''}`;
  vendorCsrf = live.csrf ?? '';
  const rider = await insertRider(routes.admin, riderRow({ hubId: HUB_A }));
  const riderDevice = await insertRiderDevice(routes.admin, rider.id);
  riderToken = (
    await arrangedFixedSession(routes.kit, routes.admin, 'RIDER', {
      principalId: rider.id,
      registeredDeviceId: riderDevice.id,
    })
  ).token;

  // A Vendor session a newer sign-in displaced: a colleague's on another browser of the same account (vendor-authentication.md).
  const colleague = await insertVendor(routes.admin, vendorRow({ hubId: HUB_A }));
  const browserA = await insertDevice(routes.admin, colleague.accountId);
  const displaced = await arrangedFixedSession(routes.kit, routes.admin, 'VENDOR', {
    principalId: colleague.accountId,
    registeredDeviceId: browserA.id,
  });
  await routes.admin.query(
    `update session set terminated_at = clock_timestamp(), termination_reason = 'SUPERSEDED_BY_NEW_LOGIN' where id = $1`,
    [displaced.row.id],
  );
  displacedCookie = `melarc_vendor_device=${browserA.credential.token}; melarc_session=${displaced.token}; melarc_csrf=${displaced.csrf ?? ''}`;
  displacedCsrf = displaced.csrf ?? '';
});

afterAll(async () => {
  await routes.stop();
});

interface Sent {
  readonly cookie?: string;
  readonly bearer?: string;
  readonly csrf?: string;
  /** `undefined`: none sent; text: that `Origin`, `'null'` included. */
  readonly origin?: string;
  readonly body?: string;
}

/** The operation, sent raw: the headers given and no other, and a body exactly as written. */
async function send(operation: Operation, sent: Sent): Promise<[number, string | undefined]> {
  const unsafe = !SAFE.has(operation.method);
  const headers: Record<string, string> = {};
  if (sent.cookie !== undefined) headers.cookie = sent.cookie;
  if (sent.bearer !== undefined) headers.authorization = `Bearer ${sent.bearer}`;
  if (sent.csrf !== undefined) headers['x-csrf-token'] = sent.csrf;
  if (sent.origin !== undefined) headers.origin = sent.origin;
  if (unsafe) {
    headers['content-type'] = 'application/json';
    headers['idempotency-key'] = randomUUID();
    headers['if-match'] = '"0"';
  }
  const path = `${API}${operation.path.replace(/\{\w+\}/, randomUUID())}`;
  const response = await fetch(`${routes.kit.app.baseUrl}${path}`, {
    method: operation.method,
    headers,
    ...(unsafe ? { body: sent.body ?? '{}' } : {}),
  });
  const text = await response.text();
  const code = text === '' ? undefined : (JSON.parse(text) as { code?: string }).code;
  return [response.status, code];
}

/** The keys the Rider's fixed bundle holds, as the seed grants them. */
const RIDER_KEYS = new Set(
  GRANTS.filter((grant) => grant.bundleId === BUNDLE_IDS.rider).map((grant) => grant.permissionKey),
);

/**
 * The operations with a body that a rider is served, **named here and not derived from the seed alone**: the sweep below expects a served rider to be
 * told its body is not valid and every other rider request to be refused before the body, so a staff-only key added to the rider's bundle by mistake
 * would otherwise move an operation into the served set and be expected to pass. A new one is a decision, and is added to this list with it.
 */
const SERVED_TO_A_RIDER_WITH_A_BODY = [
  'acceptRunCustodyHandover',
  'createEvidence',
  'recordCollection',
  'reportPickupFailure',
  'requestSmsHandshakeFallback',
  'verifyHandshake',
] as const;

/** Whether the Rider app is served the operation: its key is in the rider's fixed bundle (or it is an owner operation of a rider's act) and its security takes the rider's session. */
const servedToRider = (operation: Operation): boolean =>
  (RIDER_KEYS.has(operation.permission) || RIDER_OWNER_OPERATIONS.has(operation.id)) &&
  operation.schemes.has('riderSession') &&
  !RIDER_REFUSED_BY_SURFACE.has(operation.id);

const withBody = OPERATIONS.filter(
  (operation) => operation.hasBody && operation.permission !== 'none',
);
const unsafeBrowser = OPERATIONS.filter(
  (operation) =>
    !SAFE.has(operation.method) &&
    operation.permission !== 'none' &&
    operation.schemes.has('browserSession'),
);
const preSessionBrowser = OPERATIONS.filter(
  (operation) => operation.permission === 'none' && !isRiderNative(operation),
);
const riderNative = OPERATIONS.filter(
  (operation) => operation.permission === 'none' && isRiderNative(operation),
);
const vendorAuthenticated = OPERATIONS.filter(
  (operation) =>
    operation.permission === 'self' &&
    operation.schemes.has('browserSession') &&
    (VENDOR_SELF.has(operation.id) || operation.path === '/auth/session'),
);

describe('the sweep covers the slice (AC-SLICE-000-130)', () => {
  it('reads every operation, and finds the families each clause is about', () => {
    expect(OPERATIONS).toHaveLength(IMPLEMENTED_OPERATIONS.length);
    expect(withBody.length).toBeGreaterThan(10);
    expect(preSessionBrowser.length).toBeGreaterThan(5);
    expect(riderNative.map((operation) => operation.id).toSorted()).toEqual([
      'completeRiderDeviceEnrolment',
      'requestRiderSignInChallenge',
      'riderSignIn',
    ]);
    expect(vendorAuthenticated.map((operation) => operation.id).toSorted()).toEqual([
      'getCurrentSession',
      'listVendorDevices',
      'requestAdditionalDeviceGrant',
      'revokeVendorDevice',
      'signOut',
    ]);
  });
});

describe('a malformed body tells nothing to a caller who may not proceed (AC-SLICE-000-130)', () => {
  // Break caught: a body parsed and refused before the caller was authenticated, which describes the schema to anyone.
  it.each(withBody.map((operation) => [operation.id, operation]))(
    '%s: with no session, 401',
    async (_id, operation) => {
      expect(await send(operation, { origin: OPS, body: MALFORMED })).toEqual([
        401,
        'SESSION_INVALID',
      ]);
    },
  );

  // Break caught: a body refused before the permission, which tells a caller who may not use the operation what it takes.
  it.each(
    withBody
      .filter(
        (operation) => operation.permission !== 'self' && !OPS_STAFF_KEYS.has(operation.permission),
      )
      .map((operation) => [operation.id, operation]),
  )('%s: from a staff member without its key, 403', async (_id, operation) => {
    expect(
      await send(operation, {
        cookie: `melarc_session=${opsStaff.token}; melarc_csrf=${opsStaff.csrf ?? ''}`,
        csrf: opsStaff.csrf ?? '',
        origin: OPS,
        body: MALFORMED,
      }),
    ).toEqual([403, 'PERMISSION_DENIED']);
  });

  it.each(
    withBody
      .filter(
        (operation) =>
          !VENDOR_SELF.has(operation.id) &&
          !VENDOR_SERVED.has(operation.id) &&
          operation.path !== '/auth/session',
      )
      .map((operation) => [operation.id, operation]),
  )('%s: from a Vendor it does not serve, refused before the body', async (_id, operation) => {
    const [status, code] = await send(operation, {
      cookie: vendorCookie,
      csrf: vendorCsrf,
      origin: VENDOR_ORIGIN,
      body: MALFORMED,
    });
    expect([status, code]).toEqual(
      operation.schemes.has('browserSession')
        ? [403, 'PERMISSION_DENIED']
        : [401, 'SESSION_INVALID'],
    );
  });

  // Break caught: the rider's bundle gaining a key (or an operation gaining one the bundle holds) that this sweep would then expect to be served.
  it('serves a rider exactly the operations with a body that are named above', () => {
    const served = withBody
      .filter((operation) => servedToRider(operation))
      .map((operation) => operation.id)
      .toSorted();
    expect(served).toEqual([...SERVED_TO_A_RIDER_WITH_A_BODY].toSorted());
  });

  it.each(withBody.map((operation) => [operation.id, operation]))(
    '%s: from a Rider it does not serve, refused before the body',
    async (_id, operation) => {
      const [status, code] = await send(operation, { bearer: riderToken, body: MALFORMED });
      // A rider is served an operation whose key its fixed bundle holds and whose security takes its session (S1.24: the acceptance of a custody
      // handover is the first with a body): authorised, it is then told its body is not valid. Any other operation is refused before the body.
      const served = servedToRider(operation);
      expect([status, code]).toEqual(
        served
          ? [400, 'VALIDATION_FAILED']
          : operation.schemes.has('riderSession')
            ? [403, 'PERMISSION_DENIED']
            : [401, 'SESSION_INVALID'],
      );
    },
  );
});

describe('CSRF and Origin come before the permission (AC-SLICE-000-130)', () => {
  // Break caught: the permission judged before the synchronizer token, so that a forged request learns whether its target may act.
  it.each(unsafeBrowser.map((operation) => [operation.id, operation]))(
    '%s: a staff browser’s unsafe request with no synchronizer token is 403 CSRF_VALIDATION_FAILED',
    async (_id, operation) => {
      expect(
        await send(operation, {
          cookie: `melarc_session=${opsStaff.token}; melarc_csrf=${opsStaff.csrf ?? ''}`,
          origin: OPS,
        }),
      ).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    },
  );

  // Break caught: a browser credential mutation (a sign-in, a setup, a recovery) accepted from any page, or from none.
  it.each(preSessionBrowser.map((operation) => [operation.id, operation]))(
    '%s: refuses a missing, null or unapproved Origin',
    async (_id, operation) => {
      for (const origin of [undefined, 'null', 'https://attacker.example']) {
        expect(
          await send(operation, origin === undefined ? {} : { origin }),
          String(origin),
        ).toEqual([403, 'CSRF_VALIDATION_FAILED']);
      }
    },
  );

  // Break caught: a native Rider request refused for the Origin a browser sends and a handset never does.
  it.each(riderNative.map((operation) => [operation.id, operation]))(
    '%s: refuses no native request for having no Origin',
    async (_id, operation) => {
      const [, code] = await send(operation, {});
      expect(code).not.toBe('CSRF_VALIDATION_FAILED');
    },
  );
});

describe('a displaced Vendor session (AC-SLICE-000-131)', () => {
  it('is a code no operation declares', () => {
    expect(
      OPERATIONS.filter((operation) => operation.declares.includes('SESSION_SUPERSEDED')),
    ).toEqual([]);
  });

  // Break caught: a displaced session answered as an invalid one, which leaves the vendor not knowing a colleague signed in.
  it.each(vendorAuthenticated.map((operation) => [operation.id, operation]))(
    '%s answers it 401 SESSION_SUPERSEDED',
    async (_id, operation) => {
      expect(
        await send(operation, {
          cookie: displacedCookie,
          csrf: displacedCsrf,
          origin: VENDOR_ORIGIN,
        }),
      ).toEqual([401, 'SESSION_SUPERSEDED']);
    },
  );
});
