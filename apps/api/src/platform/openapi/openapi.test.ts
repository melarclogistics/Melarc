import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Controller, Get, Module } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, type OpenAPIObject } from '@nestjs/swagger';
import { afterEach, describe, expect, it } from 'vitest';

import { loadContract } from '../../test-support/contract.js';
import { FixtureModule } from '../../test-support/fixtures.js';
import { appWith, startTestApp, type TestApp } from '../../test-support/test-app.js';
import { TechnicalEndpoint } from '../routes/access-declaration.js';
import { inspectRoutes } from '../routes/route-inventory.js';
import { buildOpenApiDocument } from './build-openapi-document.js';
import { diffRoutes, listDocumentedRoutes } from './document-routes.js';
import { writeGeneratedArtifacts } from './generate-artifacts.js';

/** A route a developer hides from the generated description, to dodge drift detection. */
@Controller('fixture-hidden')
@TechnicalEndpoint()
@ApiExcludeController()
class HiddenFixtureController {
  @Get('secret-route')
  hidden(): { ok: boolean } {
    return { ok: true };
  }
}

/** A documented route, described the way slices will describe theirs. */
@Controller('fixture-documented')
@TechnicalEndpoint()
class DocumentedFixtureController {
  @Get('items/:itemId')
  @ApiOperation({ operationId: 'getFixtureItem', summary: 'Read one fixture item' })
  item(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [HiddenFixtureController, DocumentedFixtureController] })
class OpenApiFixtureModule {}

let running: TestApp | undefined;
const scratch: string[] = [];

async function start(options?: Parameters<typeof startTestApp>[0]): Promise<TestApp> {
  running = await startTestApp(options);
  return running;
}

afterEach(async () => {
  await running?.stop();
  running = undefined;
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('listDocumentedRoutes', () => {
  // Break caught: a conversion that leaves OpenAPI path templates or the server prefix unrestored, so
  // the description could never be compared with the live router.
  it('restores the server prefix, writes parameters as :name and ignores non-operation keys', () => {
    const document = {
      openapi: '3.0.0',
      info: { title: 't', version: 'v' },
      servers: [{ url: '/api/v1' }],
      paths: {
        '/orders/{orderId}/lines/{lineId}': {
          get: {},
          put: {},
          parameters: [],
          summary: 'not an operation',
        },
        '/orders': { post: {} },
      },
    } as unknown as OpenAPIObject;

    expect(listDocumentedRoutes(document)).toEqual([
      { method: 'GET', path: '/api/v1/orders/:orderId/lines/:lineId' },
      { method: 'POST', path: '/api/v1/orders' },
      { method: 'PUT', path: '/api/v1/orders/:orderId/lines/:lineId' },
    ]);
  });
});

describe('diffRoutes', () => {
  const probe = { method: 'GET', path: '/livez' };
  const ghost = { method: 'GET', path: '/api/v1/ghosts/:ghostId' };
  const hidden = { method: 'POST', path: '/api/v1/hidden' };

  // Break caught: a route the description documents and the router does not serve going unreported. The
  // application test below asserts an empty `documentedButNotLive`, which an implementation that never
  // reports anything also satisfies, so this one feeds the function a documented route nobody serves.
  it('reports a documented route that is not live, and nothing else', () => {
    const diff = diffRoutes([probe], [probe, ghost]);

    expect(diff.documentedButNotLive).toEqual([ghost]);
    expect(diff.liveButNotDocumented).toEqual([]);
  });

  // Break caught: the reverse: a live route the description leaves out going unreported, which is how a
  // route hidden with an exclusion decorator would escape.
  it('reports a live route that is not documented, and nothing else', () => {
    const diff = diffRoutes([probe, hidden], [probe]);

    expect(diff.liveButNotDocumented).toEqual([hidden]);
    expect(diff.documentedButNotLive).toEqual([]);
  });

  // Break caught: a route known by its path alone. The same path under another method is another route, so
  // a documented POST does not make a live GET documented, and the reverse.
  it('tells the two directions apart when the method is the only difference', () => {
    const live = { method: 'GET', path: '/api/v1/things' };
    const documented = { method: 'POST', path: '/api/v1/things' };

    expect(diffRoutes([live], [documented])).toEqual({
      liveButNotDocumented: [live],
      documentedButNotLive: [documented],
    });
  });

  it('reports nothing when the two agree, whatever the order', () => {
    expect(diffRoutes([probe, hidden], [hidden, probe])).toEqual({
      liveButNotDocumented: [],
      documentedButNotLive: [],
    });
  });

  it('reports every route that is on one side only, in the order given', () => {
    const second = { method: 'DELETE', path: '/api/v1/ghosts/:ghostId' };

    expect(diffRoutes([], [ghost, second]).documentedButNotLive).toEqual([ghost, second]);
    expect(diffRoutes([ghost, second], []).liveButNotDocumented).toEqual([ghost, second]);
  });
});

describe('the generated description of the real application', () => {
  // Break caught: a business route documented that does not exist, or the technical probes leaking into
  // a description that is compared with the product contract.
  it('documents the three credential setup operations, the two staff sign-in steps, the two operations on the caller’s own session, the four reads of S0.35, the three operations of S0.36, the three of S0.37, the four of the trusted browser (staff-authentication.md §5.8), the four of S0.47 (the vendor reads, the re-issue and the vendor’s setup), the vendor sign-in of S0.48, the four of S0.49 (the vendor’s own browsers), the recovery request of S0.50, its completion (S0.51a), the two administrator recoveries (S0.51b), the two reads of the rider roster (S0.53a), the three acts on a rider’s device (S0.53b, S0.53c, S0.58), the completion of its enrolment (S0.57) and the rider’s challenge and sign-in (S0.59), and nothing else', async () => {
    const { app } = await start();
    const document = buildOpenApiDocument(app);

    expect(
      Object.entries(document.paths).map(([path, item]) => [
        path,
        Object.keys(item),
        (Object.values(item) as { operationId?: string }[]).map(
          (operation) => operation.operationId,
        ),
      ]),
    ).toEqual([
      ['/auth/staff/setup/credential', ['post'], ['completeStaffCredentialSetup']],
      ['/auth/staff/setup/mfa', ['post'], ['completeMfaEnrolment']],
      ['/auth/staff/setup/mfa/begin', ['post'], ['beginMfaReenrolment']],
      // S0.47: the vendor's own setup, beside the staff's.
      ['/auth/vendor/setup/credential', ['post'], ['completeVendorCredentialSetup']],
      // S0.48: the vendor sign-in; S0.49: the vendor's own browsers, registered in the same platform module.
      ['/auth/vendor/sign-in', ['post'], ['vendorSignIn']],
      ['/auth/vendor/device/grant', ['post'], ['requestAdditionalDeviceGrant']],
      ['/auth/vendor/device/enrol', ['post'], ['completeAdditionalDeviceEnrolment']],
      ['/auth/vendor/devices', ['get'], ['listVendorDevices']],
      ['/auth/vendor/devices/{id}/revoke', ['post'], ['revokeVendorDevice']],
      // S0.57: the handset completes a rider's device binding; S0.59: the rider's challenge and sign-in, native operations of the Rider app.
      ['/auth/rider/device/enrol', ['post'], ['completeRiderDeviceEnrolment']],
      ['/auth/rider/sign-in/challenge', ['post'], ['requestRiderSignInChallenge']],
      ['/auth/rider/sign-in', ['post'], ['riderSignIn']],
      ['/auth/staff/sign-in', ['post'], ['staffSignIn']],
      ['/auth/staff/sign-in/mfa', ['post'], ['completeStaffMfaSignIn']],
      ['/auth/session', ['get', 'delete'], ['getCurrentSession', 'signOut']],
      // The trusted browser (staff-authentication.md §5.8): a person's own, listed and removed.
      ['/auth/staff/trusted-browsers', ['get'], ['listTrustedBrowsers']],
      ['/auth/staff/trusted-browsers/{id}', ['delete'], ['revokeTrustedBrowser']],
      // S0.50: the self-service recovery request.
      ['/auth/recovery/request', ['post'], ['requestCredentialRecovery']],
      ['/auth/recovery/complete', ['post'], ['completeCredentialRecovery']],
      // Task C1: the count of the work waiting in each queue the session may read.
      ['/ops/queue-summary', ['get'], ['getQueueSummary']],
      // Task C2: the lookup of a record by its code, a name or a phone number typed in full (a POST that changes nothing, since 6 November 2026).
      ['/ops/lookup', ['post'], ['lookupRecords']],
      // S0.53a: the rider roster, the first routes of the `dispatch` module.
      ['/ops/riders', ['get'], ['listRiders']],
      ['/ops/riders/{riderId}', ['get'], ['getRider']],
      // S1.24: the custody of a run's parcels moving to another rider or to the hub (the `fleet` domain).
      ['/pickup-manifests/{id}/custody-handover', ['post'], ['initiateRunCustodyHandover']],
      ['/pickup-manifests/{id}/custody-handover/accept', ['post'], ['acceptRunCustodyHandover']],
      ['/pickup-manifests/{id}/custody-handover/fail', ['post'], ['failRunCustodyHandover']],
      ['/run-custody-handovers', ['get'], ['listRunCustodyHandovers']],
      ['/run-custody-handovers/{id}', ['get'], ['getRunCustodyHandover']],
      // S1.12e: the Ops message log.
      ['/notifications', ['get'], ['listNotifications']],
      // The domain modules (S0.35): the bundles a maker may name, the reason catalogue and the staff reads.
      ['/staff-role-bundles/assignable', ['get'], ['listAssignableStaffRoleBundles']],
      // S1.13 and S1.14: the pickup domain's booking and its reads, and the lookup of a returning walk-in.
      ['/pickup-requests', ['get', 'post'], ['listPickupRequests', 'createPickupRequest']],
      ['/pickup-requests/{id}', ['get'], ['getPickupRequest']],
      // S1.20: the manifest, built from confirmed requests, listed, and read with its stops.
      ['/pickup-manifests', ['post', 'get'], ['createPickupManifest', 'listPickupManifests']],
      ['/pickup-manifests/{id}', ['get'], ['getPickupManifest']],
      // S1.21: ordering, assigning a rider to, sending out and cancelling a manifest that has not started.
      ['/pickup-manifests/{id}/stops', ['put'], ['setManifestStopOrder']],
      ['/pickup-manifests/{id}/assign-rider', ['post'], ['assignRider']],
      ['/pickup-manifests/{id}/cancel', ['post'], ['cancelPickupManifest']],
      ['/pickup-manifests/{id}/dispatch', ['post'], ['dispatchManifest']],
      // S1.22: the rider's two acts on a run, the first operations of the pickup domain that only a rider performs.
      ['/pickup-manifests/{id}/start', ['post'], ['startRun']],
      ['/pickup-stops/{id}', ['get'], ['getPickupStop']],
      ['/pickup-stops/{id}/arrive', ['post'], ['arriveAtPickupStop']],
      ['/pickup-stops/{id}/skip', ['post'], ['skipPickupStop']],
      // S1.28: the rider's report that a stop failed.
      ['/pickup-stops/{id}/fail', ['post'], ['reportPickupFailure']],
      // S1.26: the rider's count at the door.
      ['/pickup-stops/{id}/collect', ['post'], ['recordCollection']],
      // S1.27: the collection handshake, the two-party proof that closes a counted stop.
      ['/pickup-stops/{id}/handshake', ['post'], ['initiateHandshake']],
      ['/pickup-stops/{id}/handshake/verify', ['post'], ['verifyHandshake']],
      ['/pickup-stops/{id}/handshake/sms-fallback', ['post'], ['requestSmsHandshakeFallback']],
      ['/pickup-stops/{id}/handshake/ops-override', ['post'], ['authoriseHandshakeOverride']],
      ['/pickup-stops/{id}/handshake/resolve', ['post'], ['resolveHandshake']],
      // S1.29: the vendor's dispute of a collection.
      ['/pickup-stops/{id}/dispute', ['post'], ['disputeCollection']],
      // D-A3 (OB-S1-70): the Ops work lists of the collection and the failure.
      ['/collection-disputes', ['get'], ['listCollectionDisputes']],
      ['/handshakes-for-ops', ['get'], ['listHandshakesForOps']],
      ['/collection-shortfalls', ['get'], ['listCollectionShortfalls']],
      ['/pickup-failures', ['get'], ['listPickupFailures']],
      // S1.15: the confirmation of a pending request, and the decision on a booking that was confirmed past the cutoff.
      ['/pickup-requests/{id}/confirm', ['post'], ['confirmPickupRequest']],
      ['/pickup-requests/{id}/cutoff-exception', ['post'], ['resolveCutoffException']],
      // S1.16: the one-package exception, asked for and decided.
      ['/pickup-requests/{id}/one-package-exception', ['post'], ['requestOnePackageException']],
      [
        '/pickup-requests/{id}/one-package-exception/approve',
        ['post'],
        ['approveOnePackageException'],
      ],
      // S1.17: the cancellation, and the waiver of its charge.
      ['/pickup-requests/{id}/cancel', ['post'], ['cancelPickupRequest']],
      ['/pickup-requests/{id}/cancellation-charge/waiver', ['post'], ['waiveCancellationCharge']],
      // S1.18: the force-extension of the attempt cap, and the escalation.
      ['/pickup-requests/{id}/attempt-extension', ['post'], ['extendPickupAttempts']],
      ['/pickup-requests/{id}/escalate', ['post'], ['escalatePickupRequest']],
      ['/ad-hoc-senders', ['get'], ['findAdHocSender']],
      ['/reason-definitions', ['get'], ['listReasonDefinitions']],
      // S0.36: the maker creates the profile, the checker approves it, and a credential setup is re-issued.
      ['/staff-identities', ['get', 'post'], ['listStaffIdentities', 'createStaffIdentity']],
      ['/staff-identities/{id}', ['get'], ['getStaffIdentity']],
      ['/staff-identities/{id}/approve', ['post'], ['approveStaffIdentity']],
      ['/ops/staff/{id}/credential/setup/reissue', ['post'], ['reissueStaffCredentialSetup']],
      // S0.51b: the administrator's recovery of a staff member's password, beside the re-issue.
      ['/ops/staff/{id}/credential/recover', ['post'], ['recoverStaffCredential']],
      // S0.37: the sessions of a principal, ending one, and the reset of a staff member's second factor.
      ['/auth/sessions', ['get'], ['listSessions']],
      ['/auth/sessions/{id}/revoke', ['post'], ['revokeSession']],
      ['/ops/staff/{id}/mfa/reset', ['post'], ['resetStaffMfa']],
      // The trusted browser, for a Platform Admin: another person's, listed and all removed.
      ['/ops/staff/{id}/trusted-browsers', ['get'], ['listStaffTrustedBrowsers']],
      ['/ops/staff/{id}/trusted-browsers/revoke', ['post'], ['revokeStaffTrustedBrowsers']],
      // S0.53b, S0.53c, S0.58: the in-person start of a rider's device binding and the report of its loss, `staff.device.*` and so the staff domain's.
      ['/ops/riders/{riderId}/device/register', ['post'], ['registerRiderDevice']],
      ['/ops/riders/{riderId}/device/reregister', ['post'], ['reregisterRiderDevice']],
      ['/ops/riders/{riderId}/device/revoke', ['post'], ['revokeRiderDevice']],
      // S0.47: the vendor domain's reads and re-issue.
      ['/ops/vendors', ['get'], ['listVendorAccounts']],
      ['/ops/vendors/{id}', ['get'], ['getVendorAccount']],
      ['/ops/vendors/{id}/credential/setup/reissue', ['post'], ['reissueVendorCredentialSetup']],
      ['/ops/vendors/{id}/credential/recover', ['post'], ['recoverVendorCredential']],
      // S1.14: a vendor organisation's saved pickup locations.
      ['/vendor-organizations/{id}/pickup-locations', ['get'], ['listVendorPickupLocations']],
    ]);
    expect(document.servers).toEqual([{ url: '/api/v1' }]);
    expect(document.info.title).toContain('derived from the implementation');
  });

  // Break caught: a description in a different OpenAPI dialect from the contract's, so the semantic
  // comparison (B0.6) would silently compare 3.0 constructs with 3.1 ones.
  it('declares the same OpenAPI version as the contract', async () => {
    const { app } = await start();
    expect(buildOpenApiDocument(app).openapi).toBe(loadContract().openapi);
  });
});

describe('the generated description against the live router', () => {
  // Break caught: a registered route missing from the generated description, or a documented route that
  // is not registered. "The generated API description reflects actual registered routes."
  it('documents exactly the live routes that are not technical probes', async () => {
    const { app } = await start({ rootModule: appWith(FixtureModule, OpenApiFixtureModule) });
    const document = buildOpenApiDocument(app);
    const diff = diffRoutes(inspectRoutes(app).live, listDocumentedRoutes(document));

    expect(diff.documentedButNotLive).toEqual([]);
    expect(diff.liveButNotDocumented).toEqual([
      { method: 'GET', path: '/api/v1/fixture-hidden/secret-route' },
      { method: 'GET', path: '/livez' },
      { method: 'GET', path: '/readyz' },
    ]);
    expect(Object.keys(document.paths)).toContain('/fixture-documented/items/{itemId}');
  });

  // Break caught: a business route hidden from the description with an "exclude" decorator. It surfaces
  // here as live but undocumented, so a test that pins the technical set (the two probes) fails on it.
  it('surfaces a route hidden from the description', async () => {
    const { app } = await start({ rootModule: appWith(OpenApiFixtureModule) });
    const { liveButNotDocumented } = diffRoutes(
      inspectRoutes(app).live,
      listDocumentedRoutes(buildOpenApiDocument(app)),
    );
    const technicalProbes = ['GET /livez', 'GET /readyz'];

    const unexplained = liveButNotDocumented
      .map((route) => `${route.method} ${route.path}`)
      .filter((entry) => !technicalProbes.includes(entry));
    expect(unexplained).toEqual(['GET /api/v1/fixture-hidden/secret-route']);
  });
});

describe('writeGeneratedArtifacts', () => {
  // Break caught: artifacts that are not what the running application produced, for instance a copy of the
  // canonical contract presented as generated output (engineering-standards.md §4).
  it('writes the description and the route inventory derived from the application', async () => {
    const { app } = await start({ rootModule: appWith(OpenApiFixtureModule) });
    const outDir = mkdtempSync(join(tmpdir(), 'melarc-openapi-'));
    scratch.push(outDir);

    await writeGeneratedArtifacts(app, outDir);

    const document = JSON.parse(
      readFileSync(join(outDir, 'openapi.generated.json'), 'utf8'),
    ) as OpenAPIObject;
    const inventory = JSON.parse(
      readFileSync(join(outDir, 'route-inventory.generated.json'), 'utf8'),
    ) as { live: unknown[]; declared: unknown[] };

    expect(Object.keys(document.paths)).toEqual(['/fixture-documented/items/{itemId}']);
    expect(document.info.title).toContain('derived from the implementation');
    expect(inventory.live).toEqual(inspectRoutes(app).live);
    expect(inventory.declared).toEqual(inspectRoutes(app).declared);
  });
});
