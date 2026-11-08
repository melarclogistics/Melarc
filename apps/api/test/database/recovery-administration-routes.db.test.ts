import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { activateFactor, factorRow, insertFactor } from './support/credentials.js';
import { COMPLETE, startRecoveryRoutes, type RecoveryRoutes } from './support/recovery-routes.js';
import { API, codeOf, HUB_A, OPS, versionOf, type Actor } from './support/staff-routes.js';
import { SOME_SECRET_HASH } from './support/vendors.js';

/**
 * S0.51b, `recoverStaffCredential` and `recoverVendorCredential`, against the real application and a real PostgreSQL (`AC-SLICE-000-105`,
 * the vendor clause of `-23`, the administrator clauses of `-121`). A Platform Admin reads the record for its `ETag` and starts the
 * recovery through HTTP from the Ops origin; the link reaches the principal's registered channel, which the test reads as the principal
 * would, and the principal completes it themselves.
 */
let routes: RecoveryRoutes;
let admin: Actor;

beforeAll(async () => {
  routes = await startRecoveryRoutes();
  admin = await routes.platformAdmin();
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

const rows = <T extends object>(text: string, values: unknown[] = []) =>
  routes.rows<T>(text, values);
const REASON = { reason_code: 'CREDENTIAL_RECOVERY_ASSISTANCE' };
const STAFF_RECOVER = (id: string) => `${API}/ops/staff/${id}/credential/recover`;
const VENDOR_RECOVER = (id: string) => `${API}/ops/vendors/${id}/credential/recover`;

async function vendorVersion(reader: Actor, id: string): Promise<string> {
  const response = await reader.client.get(`${API}/ops/vendors/${id}`);
  expect(response.status).toBe(200);
  const etag = response.header('etag');
  if (etag === null) throw new Error('the read carries no ETag');
  return etag;
}

async function recoverStaff(
  actor: Actor,
  id: string,
  body: object = REASON,
  etag?: string,
): Promise<TestResponse> {
  return actor.client.post(STAFF_RECOVER(id), body, {
    origin: OPS,
    headers: { 'If-Match': etag ?? (await versionOf(admin, id)) },
  });
}

async function recoverVendor(
  actor: Actor,
  id: string,
  body: object = REASON,
  etag?: string,
): Promise<TestResponse> {
  return actor.client.post(VENDOR_RECOVER(id), body, {
    origin: OPS,
    headers: { 'If-Match': etag ?? (await vendorVersion(admin, id)) },
  });
}

const eventsFor = (principalId: string) =>
  rows<{
    object_id: string;
    resulting_state: string;
    actor_id: string;
    enhanced: boolean;
    reason_code: string | null;
  }>(
    `select object_id, resulting_state, actor_id, enhanced, reason_code from audit_event
      where event_code = 'auth.recovery.requested' and related_ids ->> 'principal_id' = $1 order by recorded_at, id`,
    [principalId],
  );

describe('a Platform Admin starts a staff member’s recovery (AC-SLICE-000-105)', () => {
  // Break caught: the token or a credential returned to the administrator, a link sent anywhere but the work email, the password changed
  // or a session made by the administrator's act, or the second factor touched when the staff member completes.
  it('queues the link to the work email, returns no token, and the staff member completes it themselves', async () => {
    const target = await routes.staffMember({
      roleBundleId: BUNDLE_IDS.seniorOps,
      primaryHubId: HUB_A,
    });
    const factor = await insertFactor(routes.admin, factorRow(target.row.id));
    await activateFactor(routes.admin, factor.id);
    const before = await rows(`select * from mfa_factor where staff_identity_id = $1`, [
      target.row.id,
    ]);

    const answer = await recoverStaff(admin, target.row.id);

    expect(answer.status).toBe(200);
    const request = answer.json() as Record<string, unknown>;
    expect(request).toMatchObject({
      principal_type: 'STAFF',
      channel: 'EMAIL',
      state: 'PENDING',
      initiated_by: admin.identity.id,
      consumed_at: null,
      coalesced: false,
    });
    const message = await routes.deliveredFor(routes.admin, String(request.id));
    expect(message?.destination).toBe(target.row.workEmail);
    expect(answer.text).not.toContain(message?.token ?? 'no token');
    expect(
      await rows(`select credential_generation from staff_identity where id = $1`, [target.row.id]),
    ).toEqual([{ credential_generation: '1' }]);
    expect(await rows(`select id from session where principal_id = $1`, [target.row.id])).toEqual(
      [],
    );
    expect(await eventsFor(target.row.id)).toEqual([
      {
        object_id: request.id,
        resulting_state: 'ISSUED',
        actor_id: admin.identity.id,
        enhanced: true,
        reason_code: 'CREDENTIAL_RECOVERY_ASSISTANCE',
      },
    ]);

    // The staff member completes it from the link, on the Ops Portal.
    const completed = await routes
      .opsBrowser()
      .post(COMPLETE, { token: message?.token, new_credential: 'a brand new staff password' });
    expect(completed.status).toBe(204);
    expect(
      await rows(`select * from mfa_factor where staff_identity_id = $1`, [target.row.id]),
    ).toEqual(before);
    expect(
      await rows(`select credential_generation from staff_identity where id = $1`, [target.row.id]),
    ).toEqual([{ credential_generation: '2' }]);
  });

  // Break caught: a reason left out or of another operation, a stale version, or a Senior Ops session reaching the operation.
  it('refuses an empty or foreign reason, a stale version and a caller without the key', async () => {
    const target = await routes.staffMember();
    const empty = await recoverStaff(admin, target.row.id, { reason_code: '' });
    const foreign = await recoverStaff(admin, target.row.id, {
      reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE',
    });
    const unknown = await recoverStaff(admin, target.row.id, { reason_code: 'NO_SUCH_REASON' });
    const stale = await recoverStaff(admin, target.row.id, REASON, '"stale"');
    const senior = await recoverStaff(
      await routes.actor(BUNDLE_IDS.seniorOps, HUB_A),
      target.row.id,
    );
    expect([empty.status, codeOf(empty)]).toEqual([422, 'REASON_REQUIRED']);
    expect([foreign.status, codeOf(foreign)]).toEqual([422, 'REASON_NOT_ACTIVE']);
    expect([unknown.status, codeOf(unknown)]).toEqual([422, 'REASON_NOT_ACTIVE']);
    expect([stale.status, codeOf(stale)]).toEqual([409, 'STATE_CONFLICT']);
    expect([senior.status, codeOf(senior)]).toEqual([403, 'PERMISSION_DENIED']);
    expect(await routes.requestsOf(target.row.id)).toEqual([]);
  });

  // Break caught: a link issued to a terminal, pending or password-less identity by an administrator, or that refusal writing anything.
  it('refuses an identity that is not eligible with STATE_CONFLICT, before anything is written', async () => {
    for (const overrides of [
      { status: 'PENDING_APPROVAL', approvedBy: null },
      { status: 'REJECTED', credentialHash: null, credentialEstablishedAt: null },
      { status: 'OFFBOARDED' },
      { credentialHash: null, credentialEstablishedAt: null },
    ]) {
      const target = await routes.staffMember(overrides);
      const answer = await recoverStaff(admin, target.row.id);
      expect([answer.status, codeOf(answer)], JSON.stringify(overrides)).toEqual([
        409,
        'STATE_CONFLICT',
      ]);
      expect(await routes.requestsOf(target.row.id)).toEqual([]);
      expect(await eventsFor(target.row.id)).toEqual([]);
    }
    const suspended = await routes.staffMember({ status: 'SUSPENDED' });
    expect((await recoverStaff(admin, suspended.row.id)).status).toBe(200);
  });

  // Break caught: an administrator's request inside the guard issuing a second link, or claiming a delivery it did not make.
  it('coalesces onto the live link inside the guard, returning its metadata and claiming no message', async () => {
    const target = await routes.staffMember();
    expect((await routes.requestRecovery('STAFF', target.row.workEmail)).status).toBe(202);
    const [live] = await routes.requestsOf(target.row.id);

    const answer = await recoverStaff(admin, target.row.id);

    expect(answer.status).toBe(200);
    expect(answer.json()).toMatchObject({ id: live?.id, coalesced: true, initiated_by: null });
    expect(await routes.requestsOf(target.row.id)).toHaveLength(1);
    expect(
      (await eventsFor(target.row.id)).map((event) => [event.resulting_state, event.enhanced]),
    ).toEqual([
      ['ISSUED', false],
      ['COALESCED', true],
    ]);
  });
});

describe('a Platform Admin starts a vendor’s recovery (AC-SLICE-000-23, -121)', () => {
  // Break caught: the link sent anywhere but the delivery channel or without the account identifier, a Senior Ops session reaching the
  // operation, or a completion that does not rotate the browsers.
  it('queues the link to the delivery channel with the identifier, and the vendor completes it, rotating the browsers', async () => {
    const vendor = await routes.vendor();
    const answer = await recoverVendor(admin, vendor.row.accountId);

    expect(answer.status).toBe(200);
    const request = answer.json() as Record<string, unknown>;
    expect(request).toMatchObject({
      principal_type: 'VENDOR',
      channel: 'EMAIL',
      state: 'PENDING',
      initiated_by: admin.identity.id,
    });
    const message = await routes.deliveredFor(routes.admin, String(request.id));
    expect([message?.destination, message?.accountIdentifier]).toEqual([
      vendor.row.recoveryEmail,
      vendor.row.accountIdentifier,
    ]);

    const completed = await routes
      .browser()
      .post(COMPLETE, { token: message?.token, new_credential: 'a brand new shared secret' });
    expect(completed.status).toBe(204);
    expect(completed.setCookies.map((cookie) => cookie.name)).toEqual(['melarc_vendor_device']);
    expect(
      (
        await rows<{ status: string }>(
          `select status from registered_device where principal_id = $1 order by registered_at`,
          [vendor.row.accountId],
        )
      ).map((device) => device.status),
    ).toEqual(['REVOKED', 'ACTIVE']);

    const senior = await recoverVendor(
      await routes.actor(BUNDLE_IDS.seniorOps, HUB_A),
      vendor.row.accountId,
    );
    expect([senior.status, codeOf(senior)]).toEqual([403, 'PERMISSION_DENIED']);
  });

  // Break caught: a recovery started for an account with no secret, or of a rejected or terminated organisation, or a suspended account
  // refused although it is eligible.
  it('refuses an account with no secret or of a terminal organisation, and reaches a suspended one', async () => {
    for (const overrides of [
      { secretHash: null },
      { secretHash: SOME_SECRET_HASH, organizationStatus: 'REJECTED' },
      { secretHash: SOME_SECRET_HASH, organizationStatus: 'TERMINATED' },
    ]) {
      const vendor = await routes.vendor(overrides);
      const answer = await recoverVendor(admin, vendor.row.accountId);
      expect([answer.status, codeOf(answer)], JSON.stringify(overrides)).toEqual([
        409,
        'STATE_CONFLICT',
      ]);
      expect(await routes.requestsOf(vendor.row.accountId)).toEqual([]);
    }
    const suspended = await routes.vendor({
      accountStatus: 'SUSPENDED',
      organizationStatus: 'SUSPENDED',
    });
    expect((await recoverVendor(admin, suspended.row.accountId)).status).toBe(200);
  });

  it('refuses an account with no deliverable channel with CREDENTIAL_DELIVERY_FAILED, and writes nothing', async () => {
    const vendor = await routes.vendor({ deliveryChannel: null });
    const answer = await recoverVendor(admin, vendor.row.accountId);
    expect([answer.status, codeOf(answer)]).toEqual([422, 'CREDENTIAL_DELIVERY_FAILED']);
    expect(await routes.requestsOf(vendor.row.accountId)).toEqual([]);
  });

  it('coalesces at the cap of two live links, and issues nothing', async () => {
    const vendor = await routes.vendor();
    expect((await recoverVendor(admin, vendor.row.accountId)).status).toBe(200);
    const age = async (id: string | undefined) => {
      await routes.admin.query('begin');
      await routes.admin.query('set local session_replication_role = replica');
      await routes.admin.query(
        `update recovery_request set issued_at = issued_at - interval '61 seconds', expires_at = expires_at - interval '61 seconds'
          where id = $1`,
        [id],
      );
      await routes.admin.query('commit');
    };
    await age((await routes.requestsOf(vendor.row.accountId))[0]?.id);
    const second = await recoverVendor(admin, vendor.row.accountId);
    expect(second.json()).toMatchObject({ coalesced: false });
    // Both are past the guard, and there are two: the cap alone coalesces the third onto the newest.
    await age((second.json() as { id: string }).id);
    const third = await recoverVendor(admin, vendor.row.accountId);
    expect(third.json()).toMatchObject({
      id: (second.json() as { id: string }).id,
      coalesced: true,
    });
    expect(await routes.requestsOf(vendor.row.accountId)).toHaveLength(2);
  });
});
