import { createRequire } from 'node:module';

import { Controller, Get, Module } from '@nestjs/common';
import type { Router as ExpressRouter } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { AccessFixtureModule, FixtureModule } from '../../test-support/fixtures.js';
import { appWith, startTestApp, type TestApp } from '../../test-support/test-app.js';
import { RequiresPermission } from './access-declaration.js';
import { assertRoutesAreSound, inspectRoutes } from './route-inventory.js';

// The router class of the Express that the platform adapter runs on: the application does not depend on it directly.
const { Router } = createRequire(
  createRequire(import.meta.url).resolve('@nestjs/platform-express'),
)('express') as { Router: () => ExpressRouter };

let running: TestApp | undefined;

async function start(options?: Parameters<typeof startTestApp>[0]): Promise<TestApp> {
  running = await startTestApp(options);
  return running;
}

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

/** The credential setup operations and the staff sign-in are pages of the Ops Portal, limited in the recovery and the staff sign-in buckets. */
const OPS_BROWSER = { kind: 'browser', surfaces: ['OPS_PORTAL'] };
/** The vendor's setup, its additional browser's enrolment and its sign-in are pages of the Vendor PWA. */
const VENDOR_BROWSER = { kind: 'browser', surfaces: ['VENDOR_PWA'] };
/** The rider's enrolment, challenge and sign-in are operations of the native Rider app: no `Origin`, no cookie. */
const RIDER_NATIVE = { kind: 'native' };

describe('the real application', () => {
  // Break caught: a business route appearing by accident, whether through a new controller or a raw
  // registration. Adding a route must change this list on purpose, in the same commit.
  it('answers exactly the two technical probes, the three credential setup operations, the two staff sign-in steps, the two operations on the caller’s own session, the four reads of S0.35, the three operations of S0.36, the three of S0.37, the four of the trusted browser (staff-authentication.md §5.8), the four of S0.47, the vendor sign-in of S0.48, the four of S0.49, the recovery request of S0.50, its completion (S0.51a), the two administrator recoveries (S0.51b), the two reads of the rider roster (S0.53a), the three acts on a rider’s device (S0.53b, S0.53c, S0.58), the completion of its enrolment (S0.57) and the rider’s sign-in with its challenge (S0.59), and declares nothing else', async () => {
    const { app } = await start();
    const inspection = inspectRoutes(app);

    expect(inspection.live).toEqual([
      { method: 'DELETE', path: '/api/v1/auth/session' },
      { method: 'DELETE', path: '/api/v1/auth/staff/trusted-browsers/:id' },
      { method: 'GET', path: '/api/v1/ad-hoc-senders' },
      { method: 'GET', path: '/api/v1/auth/session' },
      { method: 'GET', path: '/api/v1/auth/sessions' },
      { method: 'GET', path: '/api/v1/auth/staff/trusted-browsers' },
      { method: 'GET', path: '/api/v1/auth/vendor/devices' },
      { method: 'GET', path: '/api/v1/notifications' },
      { method: 'GET', path: '/api/v1/ops/queue-summary' },
      { method: 'GET', path: '/api/v1/ops/riders' },
      { method: 'GET', path: '/api/v1/ops/riders/:riderId' },
      { method: 'GET', path: '/api/v1/ops/staff/:id/trusted-browsers' },
      { method: 'GET', path: '/api/v1/ops/vendors' },
      { method: 'GET', path: '/api/v1/ops/vendors/:id' },
      { method: 'GET', path: '/api/v1/pickup-manifests' },
      { method: 'GET', path: '/api/v1/pickup-manifests/:id' },
      { method: 'GET', path: '/api/v1/pickup-requests' },
      { method: 'GET', path: '/api/v1/pickup-requests/:id' },
      { method: 'GET', path: '/api/v1/pickup-stops/:id' },
      { method: 'GET', path: '/api/v1/reason-definitions' },
      { method: 'GET', path: '/api/v1/run-custody-handovers' },
      { method: 'GET', path: '/api/v1/run-custody-handovers/:id' },
      { method: 'GET', path: '/api/v1/staff-identities' },
      { method: 'GET', path: '/api/v1/staff-identities/:id' },
      { method: 'GET', path: '/api/v1/staff-role-bundles/assignable' },
      { method: 'GET', path: '/api/v1/vendor-organizations/:id/pickup-locations' },
      { method: 'GET', path: '/livez' },
      { method: 'GET', path: '/readyz' },
      { method: 'POST', path: '/api/v1/auth/recovery/complete' },
      { method: 'POST', path: '/api/v1/auth/recovery/request' },
      { method: 'POST', path: '/api/v1/auth/rider/device/enrol' },
      { method: 'POST', path: '/api/v1/auth/rider/sign-in' },
      { method: 'POST', path: '/api/v1/auth/rider/sign-in/challenge' },
      { method: 'POST', path: '/api/v1/auth/sessions/:id/revoke' },
      { method: 'POST', path: '/api/v1/auth/staff/setup/credential' },
      { method: 'POST', path: '/api/v1/auth/staff/setup/mfa' },
      { method: 'POST', path: '/api/v1/auth/staff/setup/mfa/begin' },
      { method: 'POST', path: '/api/v1/auth/staff/sign-in' },
      { method: 'POST', path: '/api/v1/auth/staff/sign-in/mfa' },
      { method: 'POST', path: '/api/v1/auth/vendor/device/enrol' },
      { method: 'POST', path: '/api/v1/auth/vendor/device/grant' },
      { method: 'POST', path: '/api/v1/auth/vendor/devices/:id/revoke' },
      { method: 'POST', path: '/api/v1/auth/vendor/setup/credential' },
      { method: 'POST', path: '/api/v1/auth/vendor/sign-in' },
      { method: 'POST', path: '/api/v1/ops/riders/:riderId/device/register' },
      { method: 'POST', path: '/api/v1/ops/riders/:riderId/device/reregister' },
      { method: 'POST', path: '/api/v1/ops/riders/:riderId/device/revoke' },
      { method: 'POST', path: '/api/v1/ops/staff/:id/credential/recover' },
      { method: 'POST', path: '/api/v1/ops/staff/:id/credential/setup/reissue' },
      { method: 'POST', path: '/api/v1/ops/staff/:id/mfa/reset' },
      { method: 'POST', path: '/api/v1/ops/staff/:id/trusted-browsers/revoke' },
      { method: 'POST', path: '/api/v1/ops/vendors/:id/credential/recover' },
      { method: 'POST', path: '/api/v1/ops/vendors/:id/credential/setup/reissue' },
      { method: 'POST', path: '/api/v1/pickup-manifests' },
      { method: 'POST', path: '/api/v1/pickup-manifests/:id/assign-rider' },
      { method: 'POST', path: '/api/v1/pickup-manifests/:id/cancel' },
      { method: 'POST', path: '/api/v1/pickup-manifests/:id/custody-handover' },
      { method: 'POST', path: '/api/v1/pickup-manifests/:id/custody-handover/accept' },
      { method: 'POST', path: '/api/v1/pickup-manifests/:id/custody-handover/fail' },
      { method: 'POST', path: '/api/v1/pickup-manifests/:id/dispatch' },
      { method: 'POST', path: '/api/v1/pickup-manifests/:id/start' },
      { method: 'POST', path: '/api/v1/pickup-requests' },
      { method: 'POST', path: '/api/v1/pickup-requests/:id/attempt-extension' },
      { method: 'POST', path: '/api/v1/pickup-requests/:id/cancel' },
      { method: 'POST', path: '/api/v1/pickup-requests/:id/cancellation-charge/waiver' },
      { method: 'POST', path: '/api/v1/pickup-requests/:id/confirm' },
      { method: 'POST', path: '/api/v1/pickup-requests/:id/cutoff-exception' },
      { method: 'POST', path: '/api/v1/pickup-requests/:id/escalate' },
      { method: 'POST', path: '/api/v1/pickup-requests/:id/one-package-exception' },
      { method: 'POST', path: '/api/v1/pickup-requests/:id/one-package-exception/approve' },
      { method: 'POST', path: '/api/v1/pickup-stops/:id/arrive' },
      { method: 'POST', path: '/api/v1/pickup-stops/:id/collect' },
      { method: 'POST', path: '/api/v1/pickup-stops/:id/dispute' },
      { method: 'POST', path: '/api/v1/pickup-stops/:id/fail' },
      { method: 'POST', path: '/api/v1/pickup-stops/:id/handshake' },
      { method: 'POST', path: '/api/v1/pickup-stops/:id/handshake/ops-override' },
      { method: 'POST', path: '/api/v1/pickup-stops/:id/handshake/resolve' },
      { method: 'POST', path: '/api/v1/pickup-stops/:id/handshake/sms-fallback' },
      { method: 'POST', path: '/api/v1/pickup-stops/:id/handshake/verify' },
      { method: 'POST', path: '/api/v1/pickup-stops/:id/skip' },
      { method: 'POST', path: '/api/v1/staff-identities' },
      { method: 'POST', path: '/api/v1/staff-identities/:id/approve' },
      { method: 'PUT', path: '/api/v1/pickup-manifests/:id/stops' },
    ]);
    expect(inspection.declared).toEqual([
      {
        method: 'DELETE',
        path: '/api/v1/auth/session',
        access: 'self',
        authenticated: {
          surfaces: ['OPS_PORTAL', 'VENDOR_PWA', 'RIDER_ANDROID'],
          activity: 'qualifying',
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'DELETE',
        path: '/api/v1/auth/staff/trusted-browsers/:id',
        access: 'self',
        authenticated: { surfaces: ['OPS_PORTAL'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE']),
      },
      {
        method: 'GET',
        path: '/api/v1/ad-hoc-senders',
        access: 'permission',
        permission: 'vendor.read',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
        },
        credentialModes: new Set(['COOKIE']),
      },
      {
        method: 'GET',
        path: '/api/v1/auth/session',
        access: 'self',
        authenticated: {
          surfaces: ['OPS_PORTAL', 'VENDOR_PWA', 'RIDER_ANDROID'],
          activity: 'background',
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'GET',
        path: '/api/v1/auth/sessions',
        access: 'permission',
        permission: 'staff.read',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          // The tier of the principal's type, decided from the query before it is validated (F03 of 23 October 2026).
          tier: {
            byQuery: { param: 'principal_type', tiers: { STAFF: 'P', VENDOR: 'P', RIDER: 'S' } },
          },
        },
        credentialModes: new Set(['COOKIE']),
      },
      {
        method: 'GET',
        path: '/api/v1/auth/staff/trusted-browsers',
        access: 'self',
        authenticated: { surfaces: ['OPS_PORTAL'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE']),
      },
      // S0.49: the vendor's own browsers, from a session of the Vendor PWA.
      {
        method: 'GET',
        path: '/api/v1/auth/vendor/devices',
        access: 'self',
        authenticated: { surfaces: ['VENDOR_PWA'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE']),
      },
      // S1.12e: the Ops message log, `notification.read` at the hubs of the grant, on the browser surface alone.
      {
        method: 'GET',
        path: '/api/v1/notifications',
        access: 'permission',
        permission: 'notification.read',
        authenticated: { surfaces: ['OPS_PORTAL'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE']),
      },
      // Task C1: the count of the work waiting in each queue the session may read. A `self` operation of the Ops Portal, `background` like the
      // read of the session: the page asks for it on its own and it never extends the idle lifetime. Each entry is gated by the key of its list.
      {
        method: 'GET',
        path: '/api/v1/ops/queue-summary',
        access: 'self',
        authenticated: { surfaces: ['OPS_PORTAL'], activity: 'background' },
        credentialModes: new Set(['COOKIE']),
      },
      // S0.53a: the two reads of the rider roster, `dispatch.read` at the hubs of the grant, on the browser surface alone: the Rider bundle holds
      // the key as well, and a rider's bearer credential is not one these operations take.
      {
        method: 'GET',
        path: '/api/v1/ops/riders',
        access: 'permission',
        permission: 'dispatch.read',
        authenticated: { surfaces: ['OPS_PORTAL'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE']),
      },
      {
        method: 'GET',
        path: '/api/v1/ops/riders/:riderId',
        access: 'permission',
        permission: 'dispatch.read',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'rider_identity', param: 'riderId' },
        },
        credentialModes: new Set(['COOKIE']),
      },
      {
        method: 'GET',
        path: '/api/v1/ops/staff/:id/trusted-browsers',
        access: 'permission',
        permission: 'staff.session.revoke',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'staff_identity', param: 'id' },
          tier: { minimum: 'P' },
        },
        credentialModes: new Set(['COOKIE']),
      },
      // S0.47: the two vendor reads, scoped through the organisation's responsible hub.
      {
        method: 'GET',
        path: '/api/v1/ops/vendors',
        access: 'permission',
        permission: 'vendor.read',
        authenticated: { surfaces: ['OPS_PORTAL'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE']),
      },
      {
        method: 'GET',
        path: '/api/v1/ops/vendors/:id',
        access: 'permission',
        permission: 'vendor.read',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'vendor_account', param: 'id' },
        },
        credentialModes: new Set(['COOKIE']),
      },
      // S1.20: the reads of a manifest. A Rider holds the key for the runs assigned to it and reads one from its dispatch, so the Rider app is
      // served; a Vendor is not (a manifest is never vendor-visible).
      {
        method: 'GET',
        path: '/api/v1/pickup-manifests',
        access: 'permission',
        permission: 'pickup.read',
        authenticated: {
          surfaces: ['OPS_PORTAL', 'RIDER_ANDROID'],
          activity: 'qualifying',
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'GET',
        path: '/api/v1/pickup-manifests/:id',
        access: 'permission',
        permission: 'pickup.read',
        authenticated: {
          surfaces: ['OPS_PORTAL', 'RIDER_ANDROID'],
          activity: 'qualifying',
          record: { entity: 'pickup_manifest', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'GET',
        path: '/api/v1/pickup-requests',
        access: 'permission',
        permission: 'pickup.read',
        authenticated: {
          surfaces: ['OPS_PORTAL', 'VENDOR_PWA', 'RIDER_ANDROID'],
          activity: 'qualifying',
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'GET',
        path: '/api/v1/pickup-requests/:id',
        access: 'permission',
        permission: 'pickup.read',
        authenticated: {
          surfaces: ['OPS_PORTAL', 'VENDOR_PWA', 'RIDER_ANDROID'],
          activity: 'qualifying',
          record: { entity: 'pickup_request', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S1.22: the read of one stop, the source of its `ETag`. Served like the manifest read, to staff by the hubs of the grant and to a rider by
      // assignment from dispatch, with the stop as the record the scope probe is asked about; a Vendor is not served (OB-S1-23).
      {
        method: 'GET',
        path: '/api/v1/pickup-stops/:id',
        access: 'permission',
        permission: 'pickup.read',
        authenticated: {
          surfaces: ['OPS_PORTAL', 'RIDER_ANDROID'],
          activity: 'qualifying',
          record: { entity: 'pickup_stop', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'GET',
        path: '/api/v1/reason-definitions',
        access: 'permission',
        permission: 'settings.reason.read',
        authenticated: { surfaces: ['OPS_PORTAL', 'RIDER_ANDROID'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S1.24: the custody handovers an actor is a party to, and one of them with its ETag. Staff by the hubs of the grant, a rider as a party.
      {
        method: 'GET',
        path: '/api/v1/run-custody-handovers',
        access: 'permission',
        permission: 'fleet.custody.read',
        authenticated: { surfaces: ['OPS_PORTAL', 'RIDER_ANDROID'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'GET',
        path: '/api/v1/run-custody-handovers/:id',
        access: 'permission',
        permission: 'fleet.custody.read',
        authenticated: {
          surfaces: ['OPS_PORTAL', 'RIDER_ANDROID'],
          activity: 'qualifying',
          record: { entity: 'run_custody_handover', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'GET',
        path: '/api/v1/staff-identities',
        access: 'permission',
        permission: 'staff.read',
        authenticated: { surfaces: ['OPS_PORTAL'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE']),
      },
      {
        method: 'GET',
        path: '/api/v1/staff-identities/:id',
        access: 'permission',
        permission: 'staff.read',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'staff_identity', param: 'id' },
        },
        credentialModes: new Set(['COOKIE']),
      },
      {
        method: 'GET',
        path: '/api/v1/staff-role-bundles/assignable',
        access: 'permission',
        permission: 'permission.assignable_bundle.read',
        authenticated: { surfaces: ['OPS_PORTAL'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE']),
      },
      {
        method: 'GET',
        path: '/api/v1/vendor-organizations/:id/pickup-locations',
        access: 'permission',
        permission: 'vendor.pickup_location.manage',
        authenticated: {
          surfaces: ['OPS_PORTAL', 'VENDOR_PWA'],
          activity: 'qualifying',
          record: { entity: 'vendor_organization', param: 'id' },
        },
        credentialModes: new Set(['COOKIE']),
      },
      { method: 'GET', path: '/livez', access: 'technical' },
      { method: 'GET', path: '/readyz', access: 'technical' },
      // S0.51a: the completion of a recovery link, a page of both surfaces, limited per token in the recovery bucket.
      {
        method: 'POST',
        path: '/api/v1/auth/recovery/complete',
        access: 'anonymous',
        bucket: 'rate_limit_recovery',
        client: { kind: 'browser', surfaces: ['OPS_PORTAL', 'VENDOR_PWA'] },
      },
      // S0.50: a self-service recovery request, a page of both surfaces, limited per principal type and identifier in the recovery bucket.
      {
        method: 'POST',
        path: '/api/v1/auth/recovery/request',
        access: 'anonymous',
        bucket: 'rate_limit_recovery',
        client: { kind: 'browser', surfaces: ['OPS_PORTAL', 'VENDOR_PWA'] },
      },
      // S0.57: the handset completes the binding with the grant of the QR code, an operation of the native Rider app limited per token in the
      // recovery bucket. It issues no session.
      {
        method: 'POST',
        path: '/api/v1/auth/rider/device/enrol',
        access: 'anonymous',
        bucket: 'rate_limit_recovery',
        client: RIDER_NATIVE,
      },
      // S0.59: the rider's sign-in and the challenge it answers draw on one bucket, keyed on the canonical number whether or not it is a rider's.
      {
        method: 'POST',
        path: '/api/v1/auth/rider/sign-in',
        access: 'anonymous',
        bucket: 'rate_limit_rider_challenge',
        client: RIDER_NATIVE,
      },
      {
        method: 'POST',
        path: '/api/v1/auth/rider/sign-in/challenge',
        access: 'anonymous',
        bucket: 'rate_limit_rider_challenge',
        client: RIDER_NATIVE,
      },
      {
        method: 'POST',
        path: '/api/v1/auth/sessions/:id/revoke',
        access: 'permission',
        permission: 'staff.session.revoke',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'session', param: 'id' },
          tier: { rule: 'session_principal' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/auth/staff/setup/credential',
        access: 'anonymous',
        bucket: 'rate_limit_recovery',
        client: OPS_BROWSER,
      },
      {
        method: 'POST',
        path: '/api/v1/auth/staff/setup/mfa',
        access: 'anonymous',
        bucket: 'rate_limit_recovery',
        client: OPS_BROWSER,
      },
      {
        method: 'POST',
        path: '/api/v1/auth/staff/setup/mfa/begin',
        access: 'anonymous',
        bucket: 'rate_limit_recovery',
        client: OPS_BROWSER,
      },
      {
        method: 'POST',
        path: '/api/v1/auth/staff/sign-in',
        access: 'anonymous',
        bucket: 'rate_limit_staff_signin',
        client: OPS_BROWSER,
      },
      {
        method: 'POST',
        path: '/api/v1/auth/staff/sign-in/mfa',
        access: 'anonymous',
        bucket: 'rate_limit_privileged_mfa',
        client: OPS_BROWSER,
      },
      // S0.49: an additional browser redeems its grant, a page of the Vendor PWA, limited in the recovery bucket; a signed-in browser asks
      // for that grant, and ends another of the account's browsers.
      {
        method: 'POST',
        path: '/api/v1/auth/vendor/device/enrol',
        access: 'anonymous',
        bucket: 'rate_limit_recovery',
        client: VENDOR_BROWSER,
      },
      {
        method: 'POST',
        path: '/api/v1/auth/vendor/device/grant',
        access: 'self',
        authenticated: { surfaces: ['VENDOR_PWA'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE']),
      },
      {
        method: 'POST',
        path: '/api/v1/auth/vendor/devices/:id/revoke',
        access: 'self',
        authenticated: {
          surfaces: ['VENDOR_PWA'],
          activity: 'qualifying',
          record: { entity: 'registered_device', param: 'id' },
        },
        // The contract's default security (no override): the surface keeps a Rider's bearer out.
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S0.47: the vendor's own setup, a page of the Vendor PWA, limited in the recovery bucket.
      {
        method: 'POST',
        path: '/api/v1/auth/vendor/setup/credential',
        access: 'anonymous',
        bucket: 'rate_limit_recovery',
        client: VENDOR_BROWSER,
      },
      // S0.48: the vendor sign-in, limited per account identifier and browser in its own bucket.
      {
        method: 'POST',
        path: '/api/v1/auth/vendor/sign-in',
        access: 'anonymous',
        bucket: 'rate_limit_vendor_signin',
        client: VENDOR_BROWSER,
      },
      // S0.53b, S0.53c: the in-person start of a rider's device binding. The first registration is `staff.device.register` (Senior Ops, or a
      // Platform Admin whose grant reaches the rider's hub) and the replacement `staff.device.reregister` (the actor's own hub, for both tiers).
      {
        method: 'POST',
        path: '/api/v1/ops/riders/:riderId/device/register',
        access: 'permission',
        permission: 'staff.device.register',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'rider_identity', param: 'riderId' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/ops/riders/:riderId/device/reregister',
        access: 'permission',
        permission: 'staff.device.reregister',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'rider_identity', param: 'riderId' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S0.58: the report of a lost or stolen device, `staff.device.revoke` (Ops Staff, Senior Ops or a Platform Admin at the rider's own hub).
      {
        method: 'POST',
        path: '/api/v1/ops/riders/:riderId/device/revoke',
        access: 'permission',
        permission: 'staff.device.revoke',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'rider_identity', param: 'riderId' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S0.51b: the administrator's recovery of a staff member's password, Platform Admin at every hub.
      {
        method: 'POST',
        path: '/api/v1/ops/staff/:id/credential/recover',
        access: 'permission',
        permission: 'staff.credential.recover',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'staff_identity', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/ops/staff/:id/credential/setup/reissue',
        access: 'permission',
        permission: 'staff.identity.approve',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'staff_identity', param: 'id' },
          tier: { rule: 'staff_identity_bundle' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/ops/staff/:id/mfa/reset',
        access: 'permission',
        permission: 'staff.mfa.reset',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'staff_identity', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/ops/staff/:id/trusted-browsers/revoke',
        access: 'permission',
        permission: 'staff.session.revoke',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'staff_identity', param: 'id' },
          tier: { minimum: 'P' },
        },
        // A browser session with its token, like the read beside it (the audit of 26 October 2026, decision 5): a Rider's bearer is no credential.
        credentialModes: new Set(['COOKIE']),
      },
      // S0.51b: the administrator's recovery of a vendor account's shared secret, Platform Admin at every hub.
      {
        method: 'POST',
        path: '/api/v1/ops/vendors/:id/credential/recover',
        access: 'permission',
        permission: 'vendor.credential.recover',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'vendor_account', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S0.47: the re-issue of a vendor's setup grant, the approval authority at the vendor's own hub.
      {
        method: 'POST',
        path: '/api/v1/ops/vendors/:id/credential/setup/reissue',
        access: 'permission',
        permission: 'vendor.organization.approve',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'vendor_account', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S1.20: the creation of a manifest, Ops alone (a manifest groups the stops of many vendors and no vendor builds one).
      {
        method: 'POST',
        path: '/api/v1/pickup-manifests',
        access: 'permission',
        permission: 'pickup.manifest.create',
        authenticated: { surfaces: ['OPS_PORTAL'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S1.21: the planning of a manifest before it goes out, Ops alone. The assignment of a rider has a key of its own.
      {
        method: 'POST',
        path: '/api/v1/pickup-manifests/:id/assign-rider',
        access: 'permission',
        permission: 'pickup.manifest.assign',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_manifest', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-manifests/:id/cancel',
        access: 'permission',
        permission: 'pickup.manifest.create',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_manifest', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S1.24: the three acts on the custody of a run. Opening and failing are Ops's; accepting is the receiving rider's or, for the hub, Ops's, and
      // its record scope is asked of the staff caller alone (the rider is answered NOT_ASSIGNED_RIDER by the operation).
      {
        method: 'POST',
        path: '/api/v1/pickup-manifests/:id/custody-handover',
        access: 'permission',
        permission: 'fleet.custody.initiate',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_manifest', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-manifests/:id/custody-handover/accept',
        access: 'permission',
        permission: 'fleet.custody.accept',
        authenticated: {
          surfaces: ['OPS_PORTAL', 'RIDER_ANDROID'],
          activity: 'qualifying',
          record: { entity: 'pickup_manifest', param: 'id', surfaces: ['OPS_PORTAL'] },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-manifests/:id/custody-handover/fail',
        access: 'permission',
        permission: 'fleet.custody.initiate',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_manifest', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-manifests/:id/dispatch',
        access: 'permission',
        permission: 'pickup.manifest.dispatch',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_manifest', param: 'id' },
          // R76: the dispatch texts the rider and the vendors, so the sub-ceiling of the provider-initiating operations applies.
          providerInitiating: true,
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S1.22: the rider starts the run it was given. It declares **no record scope**: a rider who is not the run's rider is told
      // `NOT_ASSIGNED_RIDER` by the use case, the same for a colleague's run and an id that matches nothing, where a record scope would
      // answer a rider `NOT_FOUND` at the guard (errors-and-enums.md: a rider who acts on unassigned work is told so; one who looks it up is not).
      {
        method: 'POST',
        path: '/api/v1/pickup-manifests/:id/start',
        access: 'permission',
        permission: 'pickup.run.execute',
        authenticated: { surfaces: ['RIDER_ANDROID'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-requests',
        access: 'permission',
        permission: 'pickup.request.create',
        authenticated: {
          surfaces: ['OPS_PORTAL', 'VENDOR_PWA'],
          activity: 'qualifying',
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-requests/:id/attempt-extension',
        access: 'permission',
        permission: 'pickup.attempt.extend',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_request', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-requests/:id/cancel',
        access: 'permission',
        permission: 'pickup.request.cancel',
        authenticated: {
          surfaces: ['OPS_PORTAL', 'VENDOR_PWA'],
          activity: 'qualifying',
          record: { entity: 'pickup_request', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-requests/:id/cancellation-charge/waiver',
        access: 'permission',
        permission: 'pickup.cancellation_charge.waive',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_request', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-requests/:id/confirm',
        access: 'permission',
        permission: 'pickup.request.confirm',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_request', param: 'id' },
          providerInitiating: true,
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-requests/:id/cutoff-exception',
        access: 'permission',
        permission: 'pickup.request.confirm',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_request', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-requests/:id/escalate',
        access: 'permission',
        permission: 'pickup.failure.resolve',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_request', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-requests/:id/one-package-exception',
        access: 'permission',
        permission: 'pickup.exception.request',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_request', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-requests/:id/one-package-exception/approve',
        access: 'permission',
        permission: 'pickup.exception.approve',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_request', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S1.22: the rider arrives at a stop of the run it started; no record scope, for the reason given at `startRun`.
      {
        method: 'POST',
        path: '/api/v1/pickup-stops/:id/arrive',
        access: 'permission',
        permission: 'pickup.run.execute',
        authenticated: { surfaces: ['RIDER_ANDROID'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S1.26: the rider records what it counted at the door; the Rider app alone, and no record scope, for the reason given at `startRun`.
      {
        method: 'POST',
        path: '/api/v1/pickup-stops/:id/collect',
        access: 'permission',
        permission: 'pickup.collection.confirm',
        authenticated: { surfaces: ['RIDER_ANDROID'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S1.29: the vendor disputes the collection of its own pickup; the Vendor app alone, and no record scope (the operation answers a stop that is not the vendor's as one that does not exist).
      {
        method: 'POST',
        path: '/api/v1/pickup-stops/:id/dispute',
        access: 'permission',
        permission: 'pickup.collection.confirm',
        authenticated: { surfaces: ['VENDOR_PWA'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S1.28: the rider reports that a stop failed; the Rider app alone, and no record scope, for the reason given at `startRun`.
      {
        method: 'POST',
        path: '/api/v1/pickup-stops/:id/fail',
        access: 'permission',
        permission: 'pickup.failure.report',
        authenticated: { surfaces: ['RIDER_ANDROID'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S1.27: the collection handshake. The rider asks for the code of a stop it counted, enters the code of a sender, asks for the SMS fallback; the
      // vendor enters the code its rider shows. Ops overrides and resolves, with the stop found or refused by the record-scope guard. In the order of the paths.
      {
        method: 'POST',
        path: '/api/v1/pickup-stops/:id/handshake',
        access: 'permission',
        permission: 'pickup.collection.confirm',
        authenticated: {
          surfaces: ['RIDER_ANDROID'],
          activity: 'qualifying',
          providerInitiating: true,
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-stops/:id/handshake/ops-override',
        access: 'permission',
        permission: 'pickup.handshake.override',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_stop', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-stops/:id/handshake/resolve',
        access: 'permission',
        permission: 'pickup.handshake.resolve',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_stop', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-stops/:id/handshake/sms-fallback',
        access: 'permission',
        permission: 'pickup.collection.confirm',
        authenticated: {
          surfaces: ['RIDER_ANDROID'],
          activity: 'qualifying',
          providerInitiating: true,
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/pickup-stops/:id/handshake/verify',
        access: 'permission',
        permission: 'pickup.collection.confirm',
        authenticated: { surfaces: ['VENDOR_PWA', 'RIDER_ANDROID'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      // S1.23: Ops skips a stop. The Ops Portal alone (no rider bundle holds the key), the stop found or refused by the record-scope guard.
      {
        method: 'POST',
        path: '/api/v1/pickup-stops/:id/skip',
        access: 'permission',
        permission: 'pickup.stop.skip',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_stop', param: 'id' },
          providerInitiating: true,
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/staff-identities',
        access: 'permission',
        permission: 'staff.identity.create',
        authenticated: { surfaces: ['OPS_PORTAL'], activity: 'qualifying' },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'POST',
        path: '/api/v1/staff-identities/:id/approve',
        access: 'permission',
        permission: 'staff.identity.approve',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'staff_identity', param: 'id' },
          tier: { rule: 'staff_identity_bundle' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
      {
        method: 'PUT',
        path: '/api/v1/pickup-manifests/:id/stops',
        access: 'permission',
        permission: 'pickup.manifest.create',
        authenticated: {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'pickup_manifest', param: 'id' },
        },
        credentialModes: new Set(['COOKIE', 'BEARER']),
      },
    ]);
    expect(inspection.undeclared).toEqual([]);
    expect(inspection.outsideNest).toEqual([]);
    expect(inspection.missingFromRouter).toEqual([]);
    expect(() => {
      assertRoutesAreSound(app);
    }).not.toThrow();
  });
});

describe('inspectRoutes', () => {
  // Break caught: the two enumerations drifting apart, for instance a prefix applied by one and not the
  // other, or path parameters rendered differently.
  it('finds the same routes from the router and from the decorators, parameters included', async () => {
    const { app } = await start({ rootModule: appWith(FixtureModule) });
    const inspection = inspectRoutes(app);

    expect(inspection.live.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /api/v1/fixture/budget',
      'GET /api/v1/fixture/budget-after-pause',
      'GET /api/v1/fixture/budget-then-wait',
      'GET /api/v1/fixture/cooperative',
      'GET /api/v1/fixture/fail/:kind',
      'GET /api/v1/fixture/fails-after-answering',
      'GET /api/v1/fixture/orders/:id',
      'GET /api/v1/fixture/slow/:label',
      'GET /api/v1/fixture/throw-secret',
      'GET /api/v1/fixture/whoami',
      'GET /livez',
      'GET /readyz',
      'POST /api/v1/fixture/body/:label',
      'POST /api/v1/fixture/budget',
      'POST /api/v1/fixture/guarded',
    ]);
    expect(inspection.outsideNest).toEqual([]);
    expect(inspection.missingFromRouter).toEqual([]);
  });

  // Break caught (task C1): a tier, or a named record, added to a list that a queue count follows. `getQueueSummary` counts in the context
  // of the list's key and the grant's scope, and applies neither a tier nor a record scope; the count would then differ from the list. Whoever
  // adds one here must add it to the count (and its test) in the same change, and this test is what tells them.
  it('declares no tier and no record on the lists that a queue count follows', async () => {
    const { app } = await start();
    const followed = [
      '/api/v1/pickup-requests',
      '/api/v1/pickup-manifests',
      '/api/v1/staff-identities',
    ];

    const lists = inspectRoutes(app).declared.filter(
      (route) => route.method === 'GET' && followed.includes(route.path),
    );

    expect(lists.map((route) => route.path).toSorted()).toEqual([...followed].toSorted());
    for (const route of lists) {
      expect(route.authenticated?.tier, route.path).toBeUndefined();
      expect(route.authenticated?.record, route.path).toBeUndefined();
    }
  });

  // Break caught: a controller route with no access declaration going unnoticed until a request is refused.
  it('names the controller routes that declare no access', async () => {
    const { app } = await start({
      rootModule: appWith(AccessFixtureModule),
      allowUnsoundRoutes: true,
    });

    expect(inspectRoutes(app).undeclared).toEqual([
      { method: 'GET', path: '/api/v1/fixture-partial/undeclared' },
      { method: 'GET', path: '/api/v1/fixture-undeclared/ping' },
    ]);
  });

  // Break caught: a route registered straight on the HTTP server. It never passes through a guard, so
  // the deny-by-default rule cannot see it; only comparing the router with Nest's controllers can.
  it('names a route registered outside Nest', async () => {
    const { app } = await start();
    const express = app.getHttpAdapter().getInstance() as {
      get: (path: string, handler: () => void) => void;
    };
    express.get('/raw-debug', () => undefined);

    expect(inspectRoutes(app).outsideNest).toEqual([{ method: 'GET', path: '/raw-debug' }]);
  });

  // Break caught: a router mounted by hand being mistaken for Nest's own fallthrough. Nest's is an `_all` route on
  // `*path` and both halves of that must hold: a route that is only one of them is somebody's route and is named,
  // with a path that can never equal a declared one.
  it.each([
    ['a mounted route for every method on another path', 'all', '/hidden-all'],
    ['a mounted route on *path for one method only', 'get', '*path'],
  ])('names %s', async (_label, method, path) => {
    const { app } = await start();
    const express = app.getHttpAdapter().getInstance() as {
      use: (mount: string, router: unknown) => void;
    };
    const mounted = Router();
    mounted[method as 'all' | 'get'](path, () => undefined);
    express.use('/mounted', mounted);

    const named = inspectRoutes(app).outsideNest.map((route) => `${route.method} ${route.path}`);
    expect(named).toEqual([`${method === 'all' ? 'ALL' : 'GET'} (mounted router) ${path}`]);
  });

  // Break caught: a route that a controller declares but the router does not answer going unreported by the
  // inspection itself, which is what the assertion below relies on.
  it('names a declared route that the router does not answer', async () => {
    const { app } = await start();
    const express = app.getHttpAdapter().getInstance() as {
      router: { stack: { route?: { path: string } }[] };
    };
    express.router.stack = express.router.stack.filter((layer) => layer.route?.path !== '/livez');

    expect(inspectRoutes(app).missingFromRouter).toEqual([{ method: 'GET', path: '/livez' }]);
  });
});

describe('assertRoutesAreSound', () => {
  // Break caught: starting an API that carries an undeclared or foreign route.
  it('refuses an application with an undeclared route, naming it', async () => {
    const { app } = await start({
      rootModule: appWith(AccessFixtureModule),
      allowUnsoundRoutes: true,
    });
    expect(() => {
      assertRoutesAreSound(app);
    }).toThrow(/GET \/api\/v1\/fixture-undeclared\/ping/);
  });

  it('refuses an application with a route registered outside Nest, naming it', async () => {
    const { app } = await start();
    const express = app.getHttpAdapter().getInstance() as {
      get: (path: string, handler: () => void) => void;
    };
    express.get('/raw-debug', () => undefined);
    expect(() => {
      assertRoutesAreSound(app);
    }).toThrow(/GET \/raw-debug/);
  });

  // Break caught: the assertion passing an application that declares a route the router does not serve, which a
  // client would meet as a 404 on an operation the documents promise.
  it('refuses an application that declares a route the router does not answer, naming it', async () => {
    const { app } = await start();
    const express = app.getHttpAdapter().getInstance() as {
      router: { stack: { route?: { path: string } }[] };
    };
    express.router.stack = express.router.stack.filter((layer) => layer.route?.path !== '/readyz');

    expect(() => {
      assertRoutesAreSound(app);
    }).toThrow(/declared but not served: GET \/readyz/);
  });
});

describe('a route that names what the application does not have (S0.26; the review of 12 October 2026, F01)', () => {
  @Controller('ghost')
  class GhostController {
    @Get(':id')
    @RequiresPermission('staff.read', {
      surfaces: ['OPS_PORTAL'],
      activity: 'qualifying',
      record: { entity: 'ghost_record', param: 'id' },
      tier: { rule: 'ghost_rule' },
    })
    read(): string {
      return 'x';
    }
  }
  @Module({ controllers: [GhostController] })
  class GhostModule {}

  // Break caught: a record entity or a tier rule that does not exist accepted at start, so that the first request meets a lookup that
  // cannot be made (and a tier that is never asked is a tier never enforced).
  it('is incoherent, and stops the application at start, naming the entity and the rule', async () => {
    const { app } = await start({ rootModule: appWith(GhostModule), allowUnsoundRoutes: true });

    expect(inspectRoutes(app).incoherent.map(({ reason }) => reason)).toEqual([
      expect.stringContaining('record entity ghost_record'),
      expect.stringContaining('tier rule ghost_rule'),
    ]);
    expect(() => {
      assertRoutesAreSound(app);
    }).toThrow(/ghost_rule/);
  });
});
